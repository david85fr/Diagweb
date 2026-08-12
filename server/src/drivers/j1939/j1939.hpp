// Diagweb — pilote J1939 (CAN 29 bits, lecture seule).
//
// L'identifiant étendu est découpé en priorité, page de données, PGN et
// adresse source ; un point est un SPN extrait du PGN, décrit comme un champ
// de bits (voir j1939_pgn() / j1939_sa() dans protocol.hpp).
//
// PROTOCOLE DE TRANSPORT (J1939-21) — les PGN de plus de 8 octets, comme DM1,
// arrivent découpés. Le pilote les réassemble, et le mode se choisit dans la
// configuration :
//
//   « off »     mono-trame seulement ;
//   « bam »     écoute des diffusions BAM (défaut) — strictement passif : la
//               source annonce son transfert (TP.CM_BAM) puis envoie ses
//               paquets (TP.DT), sans que personne ait rien à demander ;
//   « request » BAM + requêtes périodiques (PGN 59904). C'est le seul mode où
//               le serveur émet sur le bus : il réclame le PGN, et complète le
//               dialogue point à point (RTS reçu → CTS émis → paquets →
//               accusé) quand la source répond en connexion plutôt qu'en
//               diffusion. À n'activer qu'en connaissance de cause : une
//               requête à un nœud absent fait réémettre le contrôleur CAN.
//
// Le message réassemblé est décodé exactement comme une trame : un SPN placé
// au-delà du 8ᵉ octet se déclare simplement avec un bit de départ plus grand.
//
// Transport et filtres : common/can_socket.hpp.
#pragma once

#include <algorithm>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "../common/can_socket.hpp"

namespace diagweb {

class J1939Driver : public CanDriverBase {
 public:
  J1939Driver(const LinkConfig& link, IPointSink& sink) : CanDriverBase(link, sink) {
    link_sa_ = static_cast<int>(link_.num("sa", -1));
    tp_ = link_.str("tp", "bam");
    own_sa_ = static_cast<int>(std::clamp<double>(link_.num("ownSa", 249), 0, 253));
    request_period_ = std::max(0.5, link_.num("requestPeriodS", 5));
    for (const auto& p : link_.points) {
      Key k;
      k.pgn = static_cast<uint32_t>(p.num("pgn", 0));
      k.sa = static_cast<int>(p.num("sa", -1));
      keys_.push_back(k);
      if (std::find(demandes_.begin(), demandes_.end(), k.pgn) == demandes_.end()) {
        demandes_.push_back(k.pgn);
      }
    }
  }

 protected:
  // PGN du protocole de transport (tous deux en PDU1 : l'octet PS est une
  // destination, il ne fait donc pas partie du PGN).
  static constexpr uint32_t kTpCm  = 60416;   // 0xEC00 — annonces et contrôle
  static constexpr uint32_t kTpDt  = 60160;   // 0xEB00 — paquets de données
  static constexpr uint32_t kRequest = 59904; // 0xEA00 — demande d'un PGN

  std::vector<CanFilter> filters() const override {
    std::vector<CanFilter> f;
    f.reserve(keys_.size() + 2);
    for (const Key& k : keys_) f.push_back(pgn_filter(k.pgn));
    if (tp_ != "off") {
      f.push_back(pgn_filter(kTpCm));
      f.push_back(pgn_filter(kTpDt));
    }
    return f;
  }

  void on_frame(uint32_t id, bool ext, const uint8_t* d, size_t len) override {
    if (!ext) return;
    const uint32_t pgn = j1939_pgn(id);
    const int sa = static_cast<int>(j1939_sa(id));
    if (link_sa_ >= 0 && sa != link_sa_) return;
    if (tp_ != "off") {
      if (pgn == kTpCm) { on_cm(sa, d, len); return; }
      if (pgn == kTpDt) { on_dt(sa, d, len); return; }
    }
    deliver(pgn, sa, d, len);
  }

  bool tick(std::string& err) override {
    (void)err;
    const double t = net::mono_s();

    // T1 de la norme : 750 ms sans paquet ⇒ le transfert est perdu. Sans cette
    // purge, une source coupée en cours de route immobiliserait sa session et
    // le message suivant serait ignoré.
    for (auto it = sessions_.begin(); it != sessions_.end();) {
      if (t - it->second.last_t > 0.75) {
        sink_.warn("transport J1939 : transfert incomplet abandonné (source " +
                   std::to_string(it->first) + ", PGN " + std::to_string(it->second.pgn) + ")");
        it = sessions_.erase(it);
      } else {
        ++it;
      }
    }

    if (tp_ == "request" && t >= next_request_) {
      next_request_ = t + request_period_;
      const int dest = link_sa_ >= 0 ? link_sa_ : 255;      // 255 = diffusion
      for (uint32_t pgn : demandes_) send_request(pgn, dest);
    }
    return true;
  }

 private:
  struct Key {
    uint32_t pgn = 0;  // groupe de paramètres attendu
    int sa = -1;       // adresse source attendue, −1 = indifférent
  };

  /** Un transfert multi-trames en cours, pour une adresse source donnée. */
  struct Session {
    uint32_t pgn = 0;
    uint16_t size = 0;
    uint8_t packets = 0;
    bool point_a_point = false;      // RTS/CTS plutôt que BAM
    std::vector<uint8_t> data;
    std::vector<bool> recu;
    double last_t = 0;
  };

  static CanFilter pgn_filter(uint32_t pgn) {
    // On filtre sur le PGN, jamais sur l'adresse source (elle change à la
    // re-revendication) ; en PDU1 l'octet PS est une destination et ne fait
    // pas partie du PGN, il ne doit donc pas entrer dans le masque.
    const bool pdu2 = ((pgn >> 8) & 0xFF) >= 240;
    CanFilter c;
    c.id = pgn << 8;
    c.mask = pdu2 ? 0x03FFFF00u : 0x03FF0000u;
    c.ext = true;
    return c;
  }

  /** Identifiant d'une trame PDU1 (destination explicite). */
  static uint32_t pdu1_id(uint32_t pgn, int dest, int src, uint32_t prio) {
    return (prio << 26) | (((pgn >> 16) & 0x03) << 24) | (((pgn >> 8) & 0xFF) << 16) |
           (static_cast<uint32_t>(dest & 0xFF) << 8) | static_cast<uint32_t>(src & 0xFF);
  }

  void deliver(uint32_t pgn, int sa, const uint8_t* d, size_t len) {
    for (size_t i = 0; i < keys_.size(); ++i) {
      if (keys_[i].pgn != pgn) continue;
      if (keys_[i].sa >= 0 && sa != keys_[i].sa) continue;
      publish_signal(i, link_.points[i], d, len);
    }
  }

  /** Annonce ou contrôle de transfert (TP.CM). */
  void on_cm(int sa, const uint8_t* d, size_t len) {
    if (len < 8) return;
    const uint8_t ctrl = d[0];
    const uint32_t pgn = static_cast<uint32_t>(d[5]) |
                         (static_cast<uint32_t>(d[6]) << 8) |
                         (static_cast<uint32_t>(d[7]) << 16);

    if (ctrl == 0x20 || ctrl == 0x10) {                     // BAM ou RTS
      const uint16_t size = static_cast<uint16_t>(d[1] | (d[2] << 8));
      const uint8_t packets = d[3];
      // Bornes de la norme, appliquées avant toute allocation : le contenu
      // vient du bus et un compte de paquets incohérent ne doit pas dicter la
      // taille d'un tampon.
      if (size < 9 || size > 1785 || packets == 0 || packets != (size + 6) / 7) {
        sink_.warn("transport J1939 : annonce incohérente (source " + std::to_string(sa) +
                   ", " + std::to_string(size) + " octets en " + std::to_string(packets) +
                   " paquets)");
        sessions_.erase(sa);
        return;
      }
      // Répondre à un RTS impose d'émettre un CTS : réservé au mode requête.
      if (ctrl == 0x10 && tp_ != "request") return;

      Session s;
      s.pgn = pgn;
      s.size = size;
      s.packets = packets;
      s.point_a_point = (ctrl == 0x10);
      s.data.assign(size, 0);
      s.recu.assign(packets, false);
      s.last_t = net::mono_s();
      sessions_[sa] = std::move(s);
      if (ctrl == 0x10) send_cts(sa, pgn, packets);
      return;
    }
    if (ctrl == 0xFF) sessions_.erase(sa);                  // abandon annoncé par la source
  }

  /** Paquet de données (TP.DT) : un numéro de séquence puis 7 octets. */
  void on_dt(int sa, const uint8_t* d, size_t len) {
    if (len < 8) return;
    const auto it = sessions_.find(sa);
    if (it == sessions_.end()) return;                      // paquet sans annonce
    Session& s = it->second;

    const uint8_t seq = d[0];
    if (seq == 0 || seq > s.packets) return;                // hors de la session annoncée
    const size_t off = static_cast<size_t>(seq - 1) * 7;
    const size_t n = std::min<size_t>(7, s.size - off);     // le dernier paquet est incomplet
    std::memcpy(s.data.data() + off, d + 1, n);
    s.recu[seq - 1] = true;
    s.last_t = net::mono_s();

    for (bool b : s.recu) if (!b) return;                   // transfert encore en cours
    if (s.point_a_point) send_ack(sa, s.pgn, s.size, s.packets);
    deliver(s.pgn, sa, s.data.data(), s.data.size());
    sessions_.erase(it);
  }

  /** « Prêt à recevoir » : demande tous les paquets d'un coup. */
  void send_cts(int dest, uint32_t pgn, uint8_t packets) {
    const uint8_t d[8] = {0x11, packets, 1, 0xFF, 0xFF,
                          static_cast<uint8_t>(pgn & 0xFF),
                          static_cast<uint8_t>((pgn >> 8) & 0xFF),
                          static_cast<uint8_t>((pgn >> 16) & 0xFF)};
    send_frame(pdu1_id(kTpCm, dest, own_sa_, 7), d, sizeof d, true);
  }

  /** Accusé de fin de message, attendu par la source en point à point. */
  void send_ack(int dest, uint32_t pgn, uint16_t size, uint8_t packets) {
    const uint8_t d[8] = {0x13,
                          static_cast<uint8_t>(size & 0xFF),
                          static_cast<uint8_t>((size >> 8) & 0xFF),
                          packets, 0xFF,
                          static_cast<uint8_t>(pgn & 0xFF),
                          static_cast<uint8_t>((pgn >> 8) & 0xFF),
                          static_cast<uint8_t>((pgn >> 16) & 0xFF)};
    send_frame(pdu1_id(kTpCm, dest, own_sa_, 7), d, sizeof d, true);
  }

  /** Demande d'un PGN (PGN 59904) : trois octets, poids faible d'abord. */
  void send_request(uint32_t pgn, int dest) {
    const uint8_t d[3] = {static_cast<uint8_t>(pgn & 0xFF),
                          static_cast<uint8_t>((pgn >> 8) & 0xFF),
                          static_cast<uint8_t>((pgn >> 16) & 0xFF)};
    send_frame(pdu1_id(kRequest, dest, own_sa_, 6), d, sizeof d, true);
  }

  std::vector<Key> keys_;
  std::vector<uint32_t> demandes_;    // PGN distincts, pour les requêtes
  std::map<int, Session> sessions_;   // un transfert en cours par adresse source
  std::string tp_ = "bam";
  int link_sa_ = -1;                  // filtre d'adresse source valant pour tout le lien
  int own_sa_ = 249;                  // notre adresse quand nous émettons
  double request_period_ = 5;
  double next_request_ = 0;
};

}  // namespace diagweb
