// Diagweb — pilote IEC 60870-5-104 (client / maître, lecture seule).
//
// Le serveur de diagnostic se connecte à la station contrôlée, active le
// transfert de données (STARTDT), lance une interrogation générale pour partir
// d'un état connu, puis reçoit les données spontanées. Aucune commande n'est
// jamais émise vers le procédé : seules les ASDU de surveillance sont lues.
//
// APCI : 0x68, longueur, 4 octets de contrôle (formats I / S / U).
// ASDU : type, VSQ (SQ + nombre), cause de transmission (2 octets, avec
//        l'adresse d'origine), adresse commune (2 octets), puis les objets
//        d'information (IOA sur 3 octets, poids faible d'abord).
#pragma once

#include <algorithm>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

#include "../../protocol.hpp"
#include "../common/net.hpp"

namespace diagweb {

class Iec104Driver : public IProtocolDriver {
 public:
  Iec104Driver(const LinkConfig& link, IPointSink& sink) : link_(link), sink_(sink) {
    for (size_t i = 0; i < link_.points.size(); ++i) {
      const int ioa = static_cast<int>(link_.points[i].num("ioa", 0));
      by_ioa_[ioa].push_back(i);
    }
  }

  ~Iec104Driver() override { close(); }

  bool open(std::string& err) override {
    close();
    fd_ = net::tcp_connect(link_.str("host"), static_cast<int>(link_.num("port", 2404)), 4000, err);
    if (fd_ < 0) return false;
    tx_ = rx_ = 0;
    unacked_ = 0;
    rxbuf_.clear();
    if (!send_u(0x07, err)) return false;            // STARTDT act
    const double until = net::mono_s() + t1();
    while (net::mono_s() < until) {
      if (!pump(err)) return false;
      if (started_) break;
    }
    if (!started_) { err = "la station n'a pas confirmé STARTDT (délai t1)"; return false; }
    if (link_.flag("gi", true)) send_gi(err);
    const double t = net::mono_s();
    last_gi_ = last_rx_ = t;
    first_unacked_ = 0;
    test_sent_ = 0;
    return true;
  }

  void close() override {
    if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
    started_ = false;
  }

  bool service(std::string& err) override {
    if (fd_ < 0) { err = "lien fermé"; return false; }
    if (!pump(err)) return false;
    const double t = net::mono_s();

    // t2 : acquitter les trames reçues sans attendre d'en avoir w.
    if (first_unacked_ > 0 && t - first_unacked_ >= t2()) {
      if (!send_s(err)) return false;
      first_unacked_ = 0;
    }
    // t3 : liaison silencieuse → test de liaison ; t1 : sans réponse, on coupe.
    if (test_sent_ > 0) {
      if (t - test_sent_ >= t1()) {
        err = "station muette après un test de liaison (délai t1)";
        return false;
      }
    } else if (t - last_rx_ >= t3()) {
      if (!send_u(0x43, err)) return false;          // TESTFR act
      test_sent_ = t;
    }

    const double gi_period = link_.num("giPeriodS", 0);
    if (gi_period > 0 && t - last_gi_ >= gi_period) {
      last_gi_ = t;
      if (!send_gi(err)) return false;
    }
    return true;
  }

 private:
  double t1() const { return std::max(1.0, link_.num("t1", 15)); }
  double t2() const { return std::max(1.0, link_.num("t2", 10)); }
  double t3() const { return std::max(1.0, link_.num("t3", 20)); }

  // ---------------------------------------------------------------- APCI
  bool send_apdu(const uint8_t* ctrl, const uint8_t* asdu, size_t n, std::string& err) {
    std::vector<uint8_t> f;
    f.push_back(0x68);
    f.push_back(static_cast<uint8_t>(4 + n));
    f.insert(f.end(), ctrl, ctrl + 4);
    if (n) f.insert(f.end(), asdu, asdu + n);
    if (!net::write_all(fd_, f.data(), f.size())) { err = "écriture impossible"; return false; }
    return true;
  }

  bool send_u(uint8_t code, std::string& err) {
    const uint8_t ctrl[4] = {code, 0, 0, 0};
    return send_apdu(ctrl, nullptr, 0, err);
  }

  bool send_s(std::string& err) {
    const uint8_t ctrl[4] = {0x01, 0,
                             static_cast<uint8_t>((rx_ << 1) & 0xFF),
                             static_cast<uint8_t>((rx_ >> 7) & 0xFF)};
    unacked_ = 0;
    return send_apdu(ctrl, nullptr, 0, err);
  }

  bool send_i(const std::vector<uint8_t>& asdu, std::string& err) {
    const uint8_t ctrl[4] = {static_cast<uint8_t>((tx_ << 1) & 0xFF),
                             static_cast<uint8_t>((tx_ >> 7) & 0xFF),
                             static_cast<uint8_t>((rx_ << 1) & 0xFF),
                             static_cast<uint8_t>((rx_ >> 7) & 0xFF)};
    tx_ = (tx_ + 1) & 0x7FFF;
    return send_apdu(ctrl, asdu.data(), asdu.size(), err);
  }

  /** Interrogation générale (C_IC_NA_1, QOI = 20 « station »). */
  bool send_gi(std::string& err) {
    const int ca = static_cast<int>(link_.num("asdu", 1));
    const int orig = static_cast<int>(link_.num("originator", 0));
    std::vector<uint8_t> a = {
      100,                                   // C_IC_NA_1
      1,                                     // VSQ : un objet
      6, static_cast<uint8_t>(orig),         // cause : activation
      static_cast<uint8_t>(ca & 0xFF), static_cast<uint8_t>((ca >> 8) & 0xFF),
      0, 0, 0,                               // IOA = 0
      20,                                    // QOI : interrogation de station
    };
    return send_i(a, err);
  }

  // ----------------------------------------------------------- réception
  bool pump(std::string& err) {
    pollfd p{fd_, POLLIN, 0};
    const int r = ::poll(&p, 1, 50);
    if (r < 0) { err = "poll : liaison perdue"; return false; }
    if (r > 0) {
      if (p.revents & (POLLHUP | POLLERR)) { err = "liaison fermée par la station"; return false; }
      uint8_t buf[4096];
      const ssize_t k = ::read(fd_, buf, sizeof buf);
      if (k <= 0) { err = "liaison fermée par la station"; return false; }
      rxbuf_.insert(rxbuf_.end(), buf, buf + k);
      last_rx_ = net::mono_s();
      test_sent_ = 0;                                  // toute réception vaut vie
      if (rxbuf_.size() > (1u << 20)) { err = "flux incohérent (tampon saturé)"; return false; }
    }

    // Découpage des APDU : 0x68, longueur, contenu. Une faute de trame n'est
    // pas rattrapable à l'aveugle : la norme demande de fermer la liaison.
    while (rxbuf_.size() >= 2) {
      if (rxbuf_[0] != 0x68) { err = "faute de trame (octet de départ absent)"; return false; }
      const size_t len = rxbuf_[1];
      if (len < 4 || len > 253) { err = "longueur d'APDU invalide"; return false; }
      if (rxbuf_.size() < len + 2) break;
      const uint8_t* ctrl = &rxbuf_[2];
      if ((ctrl[0] & 0x01) == 0) {                       // format I : données
        const int ssn = ((ctrl[1] << 7) | (ctrl[0] >> 1)) & 0x7FFF;
        if (ssn != rx_) { err = "numéro de séquence inattendu (trame perdue)"; return false; }
        rx_ = (ssn + 1) & 0x7FFF;
        if (len > 4) on_asdu(&rxbuf_[6], len - 4);
        if (first_unacked_ == 0) first_unacked_ = net::mono_s();
        if (++unacked_ >= static_cast<int>(link_.num("w", 8))) {
          if (!send_s(err)) return false;
          first_unacked_ = 0;
        }
      } else if ((ctrl[0] & 0x03) == 0x01) {             // format S : acquittement
        /* rien à faire : nous n'émettons quasiment pas de données */
      } else {                                           // format U
        if (ctrl[0] & 0x08) started_ = true;             // STARTDT con
        if (ctrl[0] & 0x40) { if (!send_u(0x83, err)) return false; }   // TESTFR act → con
        if (ctrl[0] & 0x80) test_sent_ = 0;              // TESTFR con : liaison vivante
      }
      rxbuf_.erase(rxbuf_.begin(), rxbuf_.begin() + static_cast<long>(len) + 2);
    }
    return true;
  }

  static double normalized(const uint8_t* p) {
    return static_cast<double>(static_cast<int16_t>(p[0] | (p[1] << 8))) / 32768.0;
  }
  static double scaled(const uint8_t* p) {
    return static_cast<double>(static_cast<int16_t>(p[0] | (p[1] << 8)));
  }
  static double short_float(const uint8_t* p) {
    uint32_t raw = static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
                   (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
    float f;
    std::memcpy(&f, &raw, 4);
    return f;
  }

  /** Taille et décodage d'un objet, selon le type d'ASDU. */
  struct TypeInfo { int size; int kind; };   // kind : 0 inconnu, 1 bit, 2 valeur
  static TypeInfo type_info(int t) {
    switch (t) {
      case 1:  return {1, 1};     // M_SP_NA_1  : SIQ
      case 3:  return {1, 1};     // M_DP_NA_1  : DIQ
      case 5:  return {2, 2};     // M_ST_NA_1  : VTI + QDS
      case 7:  return {5, 2};     // M_BO_NA_1  : bitstring 32 + QDS
      case 9:  return {3, 2};     // M_ME_NA_1  : normalisée + QDS
      case 11: return {3, 2};     // M_ME_NB_1  : échelonnée + QDS
      case 13: return {5, 2};     // M_ME_NC_1  : flottante + QDS
      case 15: return {5, 2};     // M_IT_NA_1  : compteur
      case 21: return {2, 2};     // M_ME_ND_1  : normalisée sans qualité
      case 30: return {8, 1};     // M_SP_TB_1  : SIQ + CP56
      case 31: return {8, 1};     // M_DP_TB_1  : DIQ + CP56
      case 32: return {9, 2};     // M_ST_TB_1
      case 34: return {10, 2};    // M_ME_TD_1  : normalisée + QDS + CP56
      case 35: return {10, 2};    // M_ME_TE_1  : échelonnée + QDS + CP56
      case 36: return {12, 2};    // M_ME_TF_1  : flottante + QDS + CP56
      case 37: return {12, 2};    // M_IT_TB_1  : compteur + CP56
      default: return {0, 0};
    }
  }

  static double value_of(int t, const uint8_t* p, bool& invalid) {
    invalid = false;
    switch (t) {
      case 1: case 30:
        invalid = (p[0] & 0x80) != 0;                    // bit IV
        return p[0] & 0x01;
      case 3: case 31:
        invalid = (p[0] & 0x80) != 0;
        return (p[0] & 0x03) == 2 ? 1 : 0;               // DPI : 1 = ouvert, 2 = fermé
      case 5: case 32:
        return static_cast<double>(static_cast<int8_t>((p[0] & 0x3F) |
               ((p[0] & 0x40) ? 0xC0 : 0)));             // VTI : 7 bits signés
      case 7:
        return static_cast<double>(static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
               (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24));
      case 9: case 34: case 21:
        invalid = (t != 21) && (p[2] & 0x80) != 0;
        return normalized(p);
      case 11: case 35:
        invalid = (p[2] & 0x80) != 0;
        return scaled(p);
      case 13: case 36:
        invalid = (p[4] & 0x80) != 0;
        return short_float(p);
      case 15: case 37:
        return static_cast<double>(static_cast<int32_t>(
            static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
            (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24)));
      default:
        return 0;
    }
  }

  void on_asdu(const uint8_t* a, size_t n) {
    if (n < 6) return;
    const int type = a[0];
    const int count = a[1] & 0x7F;
    const bool sq = (a[1] & 0x80) != 0;
    const int ca = a[4] | (a[5] << 8);
    if (ca != static_cast<int>(link_.num("asdu", 1))) return;

    if (type == 70) {                                    // M_EI_NA_1 : station redémarrée
      std::string err;
      if (link_.flag("gi", true)) send_gi(err);
      return;
    }

    const TypeInfo ti = type_info(type);
    if (!ti.size) return;                                // type non géré (commandes, fichiers…)

    size_t off = 6;
    int ioa = 0;
    for (int i = 0; i < count; ++i) {
      if (sq) {
        if (i == 0) {
          if (off + 3 > n) return;
          ioa = a[off] | (a[off + 1] << 8) | (a[off + 2] << 16);
          off += 3;
        } else {
          ++ioa;
        }
      } else {
        if (off + 3 > n) return;
        ioa = a[off] | (a[off + 1] << 8) | (a[off + 2] << 16);
        off += 3;
      }
      if (off + static_cast<size_t>(ti.size) > n) return;
      bool invalid = false;
      const double v = value_of(type, a + off, invalid);
      off += static_cast<size_t>(ti.size);
      if (invalid) continue;                             // qualité IV : valeur non publiée
      auto it = by_ioa_.find(ioa);
      if (it == by_ioa_.end()) continue;
      for (size_t idx : it->second) {
        const PointConfig& p = link_.points[idx];
        sink_.publish(idx, v * p.num("gain", 1) + p.num("offset", 0));
      }
    }
  }

  LinkConfig link_;
  IPointSink& sink_;
  int fd_ = -1;
  bool started_ = false;
  int tx_ = 0, rx_ = 0, unacked_ = 0;
  double last_gi_ = 0, last_rx_ = 0, first_unacked_ = 0, test_sent_ = 0;
  std::vector<uint8_t> rxbuf_;
  std::unordered_map<int, std::vector<size_t>> by_ioa_;
};

}  // namespace diagweb
