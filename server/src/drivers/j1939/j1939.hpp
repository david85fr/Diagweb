// Diagweb — pilote J1939 (CAN 29 bits, lecture seule).
//
// Un point est un SPN : un champ de bits situé dans un PGN. L'identifiant
// 29 bits est découpé en priorité, page de données, PGN et adresse source
// (voir j1939_pgn() / j1939_sa() dans protocol.hpp).
//
// DEUX FAÇONS D'OBTENIR UN PGN, et c'est le PGN qui décide, pas le lien :
//
//   diffusé périodiquement — le calculateur l'émet de lui-même (EEC1 toutes
//     les 20 ms, par exemple). Rien à faire : on écoute.
//   sur demande — le PGN n'est émis que si on le réclame. Le point porte
//     alors l'option « demander ce PGN » et sa période de demande. C'est le
//     seul cas où le serveur émet sur le bus.
//
// TRANSPORT MULTI-TRAMES (BAM) — un PGN de plus de 8 octets est découpé par
// le protocole de transport de J1939-21. La source annonce son transfert
// (TP.CM_BAM), diffuse ses paquets (TP.DT), et le pilote les réassemble.
// C'est purement passif, et toujours actif : le message réassemblé se décode
// ensuite comme une trame ordinaire — un SPN au-delà du 8ᵉ octet se déclare
// simplement avec un bit de départ plus grand.
//
// Le dialogue point à point (RTS/CTS) n'est traité que lorsqu'au moins un
// point demande son PGN : une demande adressée à un calculateur précis peut
// légitimement recevoir sa réponse en connexion plutôt qu'en diffusion, et
// sans l'accusé attendu le transfert n'aboutirait jamais. Aucun CTS n'est
// donc émis sur un lien qui se contente d'écouter.
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
    own_sa_ = static_cast<int>(std::clamp<double>(link_.num("ownSa", 249), 0, 253));

    for (const auto& p : link_.points) {
      Key k;
      k.pgn = static_cast<uint32_t>(p.num("pgn", 0));
      k.sa = static_cast<int>(p.num("sa", -1));
      keys_.push_back(k);
      if (!p.flag("request", false)) continue;

      // Plusieurs SPN vivent souvent dans le même PGN : une seule demande les
      // sert tous, à la plus courte des périodes réclamées — même règle que
      // pour les abonnements aux variables.
      const int dest = k.sa >= 0 ? k.sa : (link_sa_ >= 0 ? link_sa_ : 255);
      const double periode = std::clamp(p.num("requestPeriodS", 1), 0.1, 3600.0);
      const auto it = std::find_if(demandes_.begin(), demandes_.end(), [&](const Demande& d) {
        return d.pgn == k.pgn && d.dest == dest;
      });
      if (it == demandes_.end()) {
        demandes_.push_back({k.pgn, dest, periode, 0});
      } else {
        it->period_s = std::min(it->period_s, periode);
      }
    }
  }

 protected:
  // PGN du protocole de transport et de la demande (tous en PDU1 : l'octet PS
  // est une destination, il ne fait donc pas partie du PGN).
  static constexpr uint32_t kTpCm    = 60416;   // 0xEC00 — annonces et contrôle
  static constexpr uint32_t kTpDt    = 60160;   // 0xEB00 — paquets de données
  static constexpr uint32_t kRequest = 59904;   // 0xEA00 — demande d'un PGN

  /** Une demande planifiée : un PGN, un destinataire, une cadence. */
  struct Demande {
    uint32_t pgn = 0;
    int dest = 255;        // 255 = diffusion à tout le réseau
    double period_s = 1;
    double due = 0;
  };

  std::vector<CanFilter> filters() const override {
    std::vector<CanFilter> f;
    f.reserve(keys_.size() + 2);
    for (const Key& k : keys_) f.push_back(pgn_filter(k.pgn));
    f.push_back(pgn_filter(kTpCm));               // BAM : toujours écouté
    f.push_back(pgn_filter(kTpDt));
    return f;
  }

  void on_frame(uint32_t id, bool ext, const uint8_t* d, size_t len) override {
    if (!ext) return;
    const uint32_t pgn = j1939_pgn(id);
    const int sa = static_cast<int>(j1939_sa(id));
    if (link_sa_ >= 0 && sa != link_sa_) return;
    if (pgn == kTpCm) { on_cm(sa, d, len); return; }
    if (pgn == kTpDt) { on_dt(sa, d, len); return; }
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

    for (Demande& d : demandes_) {
      if (t < d.due) continue;
      d.due = next_poll_due(t, sink_.now(), d.period_s);
      send_request(d.pgn, d.dest);
    }
    return true;
  }

  /** Demandes planifiées, telles que déduites des points (exposé aux tests). */
  const std::vector<Demande>& requests() const { return demandes_; }

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
      // Répondre à un RTS impose d'émettre un CTS : réservé aux liens qui
      // demandent déjà des PGN, donc qui parlent déjà sur le bus.
      if (ctrl == 0x10 && demandes_.empty()) return;

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
  std::vector<Demande> demandes_;     // PGN à réclamer, déduits des points
  std::map<int, Session> sessions_;   // un transfert en cours par adresse source
  int link_sa_ = -1;                  // filtre d'adresse source valant pour tout le lien
  int own_sa_ = 249;                  // notre adresse quand nous émettons
};

}  // namespace diagweb
