// Diagweb — abonné GOOSE (IEC 61850-8-1), écoute passive.
//
// Un GOOSE est une trame Ethernet d'EtherType 0x88B8, diffusée par un IED sur
// le réseau de poste. Après un court en-tête (APPID, longueur, réservés), le
// contenu est encodé en BER : métadonnées du bloc de contrôle, puis le jeu de
// données lui-même. Un point Diagweb désigne une entrée de ce jeu par son
// INDICE — l'ordre du dataset, tel que le fichier SCL le fixe.
//
// Ce qui est décodé, et pourquoi c'est faisable ici : GOOSE n'a ni session, ni
// négociation, ni chiffrement. Il n'y a rien à établir, juste des trames à
// lire. C'est ce qui le sépare de MMS, resté déclaré.
//
// Deux repères de qualité du flux, publiables comme des variables :
//   stNum — incrémenté à chaque changement d'état du jeu de données ;
//   sqNum — incrémenté à chaque réémission d'un même état.
// Un stNum qui bouge signale un événement ; un sqNum figé, un IED muet.
#pragma once

#include <cstring>
#include <string>
#include <vector>

#include "../common/ber.hpp"
#include "../common/l2_socket.hpp"

namespace diagweb {

/** EtherType normalisé de GOOSE. */
inline constexpr uint16_t kGooseEtherType = 0x88B8;

/** Contenu utile d'un GOOSE, une fois l'en-tête et le BER décodés. */
struct GoosePdu {
  std::string gocb_ref;
  std::string dat_set;
  std::string go_id;
  uint32_t st_num = 0;
  uint32_t sq_num = 0;
  uint32_t conf_rev = 0;
  bool simulation = false;
  bool nds_com = false;
  uint32_t entries = 0;
  const uint8_t* all_data = nullptr;   // contenu de allData, non copié
  size_t all_data_len = 0;
};

/**
 * Décode une trame GOOSE (en-tête Ethernet déjà écarté).
 * Tout est borné par la longueur reçue : une longueur annoncée trop grande
 * fait échouer le décodage plutôt que de lire au-delà du tampon.
 */
inline bool decode_goose(const uint8_t* d, size_t n, GoosePdu& out) {
  if (n < 8) return false;
  // APPID(2) · longueur(2) · réservé1(2) · réservé2(2), puis le PDU BER.
  const uint16_t longueur = static_cast<uint16_t>((d[2] << 8) | d[3]);
  if (longueur < 8 || longueur > n) return false;
  ber::Cursor c(d + 8, static_cast<size_t>(longueur) - 8), pdu;
  uint8_t tag = 0;
  if (!ber::read_into(c, tag, pdu) || tag != 0x61) return false;   // goosePdu

  while (!pdu.done()) {
    const uint8_t* body = nullptr;
    size_t len = 0;
    if (!ber::read_tlv(pdu, tag, body, len)) return false;
    int64_t i = 0;
    switch (tag) {
      case 0x80: out.gocb_ref.assign(reinterpret_cast<const char*>(body), len); break;
      case 0x82: out.dat_set.assign(reinterpret_cast<const char*>(body), len); break;
      case 0x83: out.go_id.assign(reinterpret_cast<const char*>(body), len); break;
      case 0x85: if (ber::read_int(body, len, i)) out.st_num = static_cast<uint32_t>(i); break;
      case 0x86: if (ber::read_int(body, len, i)) out.sq_num = static_cast<uint32_t>(i); break;
      case 0x87: out.simulation = len && body[len - 1]; break;
      case 0x88: if (ber::read_int(body, len, i)) out.conf_rev = static_cast<uint32_t>(i); break;
      case 0x89: out.nds_com = len && body[len - 1]; break;
      case 0x8A: if (ber::read_int(body, len, i)) out.entries = static_cast<uint32_t>(i); break;
      case 0xAB: out.all_data = body; out.all_data_len = len; break;
      default: break;                                 // champ optionnel ignoré
    }
  }
  return out.all_data != nullptr;
}

/** Parcours récursif du jeu de données ; défini plus bas. */
inline bool goose_walk(ber::Cursor& c, uint32_t index, uint32_t& vu, double& out);

/**
 * Valeur d'une entrée du jeu de données, désignée par son indice.
 * Les types du CHOICE `Data` d'IEC 61850 sont des étiquettes contextuelles.
 * Une structure ([2]) est parcourue à plat : ses membres comptent comme des
 * entrées, ce qui correspond à la façon dont un SCL numérote un dataset
 * contenant des objets composés.
 */
inline bool goose_entry(const uint8_t* data, size_t len, uint32_t index, double& out) {
  ber::Cursor c(data, len);
  uint32_t vu = 0;
  return goose_walk(c, index, vu, out);
}

/** Parcours récursif ; `vu` compte les entrées déjà rencontrées. */
inline bool goose_walk(ber::Cursor& c, uint32_t index, uint32_t& vu, double& out) {
  while (!c.done()) {
    const uint8_t* body = nullptr;
    size_t len = 0;
    uint8_t tag = 0;
    if (!ber::read_tlv(c, tag, body, len)) return false;

    if (tag == 0xA2) {                                // structure : on descend
      ber::Cursor inner(body, len);
      if (goose_walk(inner, index, vu, out)) return true;
      continue;
    }
    if (vu++ != index) continue;

    int64_t s = 0;
    uint64_t u = 0;
    switch (tag) {
      case 0x83:                                      // booléen
        out = (len && body[len - 1]) ? 1 : 0;
        return true;
      case 0x84: {                                    // chaîne de bits (qualité, dbpos…)
        // Premier octet = nombre de bits de bourrage ; on rend la valeur
        // entière des bits utiles, poids fort en tête.
        if (len < 2) return false;
        uint64_t v = 0;
        for (size_t k = 1; k < len && k <= 8; ++k) v = (v << 8) | body[k];
        out = static_cast<double>(v >> (body[0] & 7));
        return true;
      }
      case 0x85:                                      // entier signé
        if (!ber::read_int(body, len, s)) return false;
        out = static_cast<double>(s);
        return true;
      case 0x86:                                      // entier non signé
        if (!ber::read_uint(body, len, u)) return false;
        out = static_cast<double>(u);
        return true;
      case 0x87:                                      // flottant IEEE
        return ber::read_float(body, len, out);
      default:
        return false;                                 // type non numérique : rien
    }
  }
  return false;
}

// ------------------------------------------------------------------ pilote
class GooseDriver : public L2DriverBase {
 public:
  GooseDriver(const LinkConfig& link, IPointSink& sink)
      : L2DriverBase(link, sink, kGooseEtherType) {
    appid_attendu_ = static_cast<int>(link_.num("appId", -1));
    gocb_attendu_ = link_.str("gocbRef");
    for (const auto& p : link_.points) {
      Point pt;
      pt.champ = p.str("field", "data");
      pt.index = static_cast<uint32_t>(p.num("index", 0));
      pt.gain = p.num("gain", 1);
      pt.offset = p.num("offset", 0);
      points_.push_back(pt);
    }
  }

 protected:
  void on_l2(const L2Frame& f) override {
    if (f.len < 2) return;
    const int appid = (f.data[0] << 8) | f.data[1];
    if (appid_attendu_ >= 0 && appid != appid_attendu_) return;

    GoosePdu pdu;
    if (!decode_goose(f.data, f.len, pdu)) {
      sink_.warn("trame GOOSE illisible (APPID " + std::to_string(appid) + ")");
      return;
    }
    if (!gocb_attendu_.empty() && pdu.gocb_ref != gocb_attendu_) return;

    // Un IED de test injecte des GOOSE marqués « simulation » : les publier
    // comme des mesures réelles serait exactement le piège à éviter.
    if (pdu.simulation && !link_.flag("acceptSimulated", false)) {
      sink_.warn("GOOSE marqué « simulation » ignoré (" + pdu.go_id + ")");
      return;
    }
    if (pdu.nds_com) sink_.warn("GOOSE « needs commissioning » : " + pdu.go_id);

    for (size_t i = 0; i < points_.size(); ++i) {
      double v = 0;
      if (points_[i].champ == "stNum") {
        v = pdu.st_num;
      } else if (points_[i].champ == "sqNum") {
        v = pdu.sq_num;
      } else if (!goose_entry(pdu.all_data, pdu.all_data_len, points_[i].index, v)) {
        continue;                                     // entrée absente ou non numérique
      }
      sink_.publish(i, v * points_[i].gain + points_[i].offset);
    }
  }

 private:
  struct Point {
    std::string champ;      // « data », « stNum » ou « sqNum »
    uint32_t index = 0;     // rang dans le jeu de données
    double gain = 1, offset = 0;
  };
  std::vector<Point> points_;
  std::string gocb_attendu_;
  int appid_attendu_ = -1;
};

}  // namespace diagweb
