// Diagweb — abonné Sampled Values (IEC 61850-9-2), écoute passive.
//
// Les valeurs échantillonnées d'un TC ou TP numérique arrivent en trames
// Ethernet d'EtherType 0x88BA, à 4 000 ou 4 800 trames par seconde. Après le
// même en-tête que GOOSE, le contenu est un savPdu BER contenant une ou
// plusieurs ASDU ; chaque ASDU porte un bloc `seqData` de valeurs brutes.
//
// Convention 9-2LE, la plus répandue : `seqData` contient 8 voies de 8 octets
// — quatre courants (IA, IB, IC, IN) puis quatre tensions (UA, UB, UC, UN) —
// chaque voie étant un entier signé 32 bits gros-boutiste suivi de sa qualité
// sur 32 bits. Un point désigne donc une ASDU et une VOIE.
//
// CADENCE : à 4 000 trames par seconde, publier chaque échantillon saturerait
// l'historique en quelques secondes. La décimation de LinkSink s'en charge en
// aval (période du point), mais on évite ici le travail inutile en ne décodant
// que les ASDU réellement demandées.
#pragma once

#include <cstring>
#include <string>
#include <vector>

#include "../common/ber.hpp"
#include "../common/l2_socket.hpp"

namespace diagweb {

/** EtherType normalisé des Sampled Values. */
inline constexpr uint16_t kSvEtherType = 0x88BA;

/** Une ASDU extraite d'un savPdu. */
struct SvAsdu {
  std::string sv_id;
  uint32_t smp_cnt = 0;
  uint32_t conf_rev = 0;
  uint8_t smp_synch = 0;
  const uint8_t* data = nullptr;      // seqData, non copié
  size_t data_len = 0;
};

/**
 * Décode une trame Sampled Values (en-tête Ethernet déjà écarté) et remplit
 * `out` avec les ASDU trouvées. Toute longueur est bornée par la trame reçue.
 */
inline bool decode_sv(const uint8_t* d, size_t n, std::vector<SvAsdu>& out) {
  out.clear();
  if (n < 8) return false;
  const uint16_t longueur = static_cast<uint16_t>((d[2] << 8) | d[3]);
  if (longueur < 8 || longueur > n) return false;

  ber::Cursor c(d + 8, static_cast<size_t>(longueur) - 8), pdu;
  uint8_t tag = 0;
  if (!ber::read_into(c, tag, pdu) || tag != 0x60) return false;      // savPdu

  ber::Cursor seq;
  bool trouve = false;
  while (!pdu.done()) {
    ber::Cursor tmp;
    if (!ber::read_into(pdu, tag, tmp)) return false;
    if (tag == 0xA2) { seq = tmp; trouve = true; break; }             // seqASDU
  }
  if (!trouve) return false;

  while (!seq.done()) {
    ber::Cursor asdu;
    if (!ber::read_into(seq, tag, asdu) || tag != 0x30) break;
    SvAsdu a;
    while (!asdu.done()) {
      const uint8_t* body = nullptr;
      size_t len = 0;
      if (!ber::read_tlv(asdu, tag, body, len)) break;
      int64_t i = 0;
      switch (tag) {
        case 0x80: a.sv_id.assign(reinterpret_cast<const char*>(body), len); break;
        case 0x82: if (ber::read_int(body, len, i)) a.smp_cnt = static_cast<uint32_t>(i); break;
        case 0x83: if (ber::read_int(body, len, i)) a.conf_rev = static_cast<uint32_t>(i); break;
        case 0x85: a.smp_synch = len ? body[len - 1] : 0; break;
        case 0x87: a.data = body; a.data_len = len; break;            // seqData
        default: break;
      }
    }
    if (a.data) out.push_back(a);
  }
  return !out.empty();
}

/**
 * Valeur brute d'une voie dans un bloc seqData : entier signé 32 bits
 * gros-boutiste, chaque voie occupant 8 octets (valeur puis qualité).
 */
inline bool sv_channel(const uint8_t* data, size_t len, uint32_t voie, double& out) {
  const size_t off = static_cast<size_t>(voie) * 8;
  if (off + 4 > len) return false;
  const uint32_t raw = (static_cast<uint32_t>(data[off]) << 24) |
                       (static_cast<uint32_t>(data[off + 1]) << 16) |
                       (static_cast<uint32_t>(data[off + 2]) << 8) |
                       static_cast<uint32_t>(data[off + 3]);
  out = static_cast<double>(static_cast<int32_t>(raw));
  return true;
}

/** Qualité d'une voie (les 32 bits qui suivent la valeur). */
inline bool sv_quality(const uint8_t* data, size_t len, uint32_t voie, uint32_t& out) {
  const size_t off = static_cast<size_t>(voie) * 8 + 4;
  if (off + 4 > len) return false;
  out = (static_cast<uint32_t>(data[off]) << 24) | (static_cast<uint32_t>(data[off + 1]) << 16) |
        (static_cast<uint32_t>(data[off + 2]) << 8) | static_cast<uint32_t>(data[off + 3]);
  return true;
}

// ------------------------------------------------------------------ pilote
class SvDriver : public L2DriverBase {
 public:
  SvDriver(const LinkConfig& link, IPointSink& sink)
      : L2DriverBase(link, sink, kSvEtherType) {
    appid_attendu_ = static_cast<int>(link_.num("appId", -1));
    svid_attendu_ = link_.str("svId");
    for (const auto& p : link_.points) {
      Point pt;
      pt.champ = p.str("field", "channel");
      pt.asdu = static_cast<uint32_t>(p.num("asdu", 0));
      pt.voie = static_cast<uint32_t>(p.num("channel", 0));
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
    if (!decode_sv(f.data, f.len, asdus_)) return;

    for (size_t i = 0; i < points_.size(); ++i) {
      const Point& p = points_[i];
      if (p.asdu >= asdus_.size()) continue;
      const SvAsdu& a = asdus_[p.asdu];
      if (!svid_attendu_.empty() && a.sv_id != svid_attendu_) continue;

      double v = 0;
      if (p.champ == "smpCnt") {
        v = a.smp_cnt;
      } else if (p.champ == "smpSynch") {
        v = a.smp_synch;
      } else {
        if (!sv_channel(a.data, a.data_len, p.voie, v)) continue;
        // Bit « invalid » de la qualité : aucun échantillon plutôt qu'une
        // mesure fausse, comme le bit IV en IEC-104.
        uint32_t q = 0;
        if (sv_quality(a.data, a.data_len, p.voie, q) && (q & 0x00000003u) != 0) continue;
      }
      sink_.publish(i, v * p.gain + p.offset);
    }
  }

 private:
  struct Point {
    std::string champ;      // « channel », « smpCnt » ou « smpSynch »
    uint32_t asdu = 0;
    uint32_t voie = 0;
    double gain = 1, offset = 0;
  };
  std::vector<Point> points_;
  std::vector<SvAsdu> asdus_;    // réutilisé d'une trame à l'autre : 4 000/s
  std::string svid_attendu_;
  int appid_attendu_ = -1;
};

}  // namespace diagweb
