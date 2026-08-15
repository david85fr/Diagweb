// Diagweb — pilote Modbus (client/maître, lecture seule).
//
// Transports : Modbus TCP (en-tête MBAP), Modbus RTU sur liaison série
// (trame + CRC-16), et trame RTU encapsulée sur TCP (passerelles série).
// Le serveur de diagnostic est toujours maître : il n'expose aucun esclave et
// n'écrit jamais — seules les fonctions de lecture 01/02/03/04 sont utilisées.
//
// Les points d'un même lien sont regroupés en requêtes couvrant des plages
// contiguës (moins d'aller-retour, l'équipement respire).
#pragma once

#include <algorithm>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "../../protocol.hpp"
#include "../common/net.hpp"

namespace diagweb {

class ModbusDriver : public IProtocolDriver {
 public:
  ModbusDriver(const LinkConfig& link, IPointSink& sink, bool serial)
      : link_(link), sink_(sink), serial_(serial) {
    plan();
  }

  ~ModbusDriver() override { close(); }

  bool open(std::string& err) override {
    close();
    if (serial_) {
      fd_ = net::serial_open(link_.str("device", "/dev/ttyS0"),
                             static_cast<int>(link_.num("baud", 19200)),
                             link_.str("parity", "even"),
                             static_cast<int>(link_.num("stopBits", 0)), err);
    } else {
      fd_ = net::tcp_connect(link_.str("host"), static_cast<int>(link_.num("port", 502)),
                             timeout_ms(), err);
    }
    return fd_ >= 0;
  }

  void close() override {
    if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
  }

  bool service(std::string& err) override {
    if (fd_ < 0) { err = "lien fermé"; return false; }
    const double t = net::mono_s();
    const double ts = sink_.now();
    bool worked = false;
    for (auto& r : reqs_) {
      if (t < r.due || t < r.retry_at) continue;
      r.due = next_poll_due(t, ts, r.period_s);
      worked = true;
      // Une adresse refusée par l'équipement ne concerne que sa requête :
      // le lien reste ouvert et les autres points continuent d'être lus.
      const Fail f = exchange(r, err);
      if (f == Fail::Link) return false;
      if (f == Fail::Request) {
        r.retry_at = t + 10.0;
        sink_.warn("fonction " + std::to_string(r.fn) + ", adresse " +
                   std::to_string(r.start) + " : " + err + " (réessai dans 10 s)");
        err.clear();
      }
    }
    if (!worked) {
      // Rien à faire dans l'immédiat : on rend la main sans brûler de CPU.
      pollfd p{fd_, POLLIN, 0};
      ::poll(&p, 1, next_delay_ms(t));
    }
    return true;
  }

 private:
  struct Field {                 // un point à décoder dans la réponse
    size_t idx;                  // indice du point dans le lien
    int offset;                  // décalage en registres (ou en bits) dans la requête
    std::string type;
    int bit = -1;                // bit extrait d'un registre (-1 = valeur entière)
    bool little_words = false;
    double gain = 1, offset_v = 0;
  };
  struct Req {
    int fn = 3;
    int start = 0;
    int count = 1;
    double period_s = 0.2;
    double due = 0;
    double retry_at = 0;         // requête écartée jusqu'à cet instant
    std::vector<Field> fields;
  };

  /** Nature de l'échec d'une transaction. */
  enum class Fail { None, Link, Request };

  int timeout_ms() const { return std::max(50, static_cast<int>(link_.num("timeoutMs", 1000))); }

  static int regs_for(const std::string& type) {
    if (type == "int32" || type == "uint32" || type == "float32") return 2;
    if (type == "float64") return 4;
    return 1;
  }

  /** Construit les requêtes : tri par fonction et adresse, puis fusion. */
  void plan() {
    struct Item { int fn, addr, span; size_t idx; const PointConfig* p; };
    std::vector<Item> items;
    for (size_t i = 0; i < link_.points.size(); ++i) {
      const PointConfig& p = link_.points[i];
      const int fn = static_cast<int>(p.num("fn", 3));
      if (fn < 1 || fn > 4) continue;
      const std::string type = p.str("type", "uint16");
      const int span = (fn == 1 || fn == 2) ? 1 : regs_for(type);
      items.push_back({fn, static_cast<int>(p.num("reg", 0)), span, i, &p});
    }
    std::sort(items.begin(), items.end(), [](const Item& a, const Item& b) {
      return a.fn != b.fn ? a.fn < b.fn : a.addr < b.addr;
    });

    const int group_max = std::max(1, static_cast<int>(link_.num("groupMax", 32)));
    const int hard_max = 125;   // limite protocole pour les registres (2000 pour les bits)
    for (const Item& it : items) {
      Req* cur = reqs_.empty() ? nullptr : &reqs_.back();
      const bool bits = it.fn == 1 || it.fn == 2;
      const int cap = std::min(group_max, bits ? 2000 : hard_max);
      const int end = it.addr + it.span;
      if (!cur || cur->fn != it.fn || it.addr < cur->start || end - cur->start > cap) {
        reqs_.push_back(Req{});
        cur = &reqs_.back();
        cur->fn = it.fn;
        cur->start = it.addr;
        cur->count = it.span;
        cur->period_s = it.p->period_ms / 1000.0;
      } else {
        cur->count = std::max(cur->count, end - cur->start);
        cur->period_s = std::min(cur->period_s, it.p->period_ms / 1000.0);
      }
      Field f;
      f.idx = it.idx;
      f.offset = it.addr - cur->start;
      f.type = it.p->str("type", "uint16");
      f.bit = static_cast<int>(it.p->num("bit", -1));
      f.little_words = it.p->str("wordOrder", "big") == "little";
      f.gain = it.p->num("gain", 1);
      f.offset_v = it.p->num("offset", 0);
      cur->fields.push_back(f);
    }
  }

  int next_delay_ms(double t) const {
    double best = 0.05;
    for (const auto& r : reqs_) best = std::min(best, std::max(0.0, r.due - t));
    return std::max(1, static_cast<int>(best * 1000));
  }

  static uint16_t crc16(const uint8_t* d, size_t n) {
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < n; ++i) {
      crc ^= d[i];
      for (int k = 0; k < 8; ++k) crc = (crc & 1) ? static_cast<uint16_t>((crc >> 1) ^ 0xA001)
                                                  : static_cast<uint16_t>(crc >> 1);
    }
    return crc;
  }

  static const char* exception_text(uint8_t code) {
    switch (code) {
      case 1: return "fonction non gérée par l'équipement";
      case 2: return "adresse hors plage";
      case 3: return "valeur ou quantité refusée";
      case 4: return "défaut interne de l'équipement";
      case 5: return "acquittement différé";
      case 6: return "équipement occupé";
      case 11: return "passerelle : équipement cible muet";
      default: return "exception Modbus";
    }
  }

  /** Nombre d'octets de données attendus pour une requête donnée. */
  static size_t expected_bytes(const Req& r) {
    return (r.fn == 1 || r.fn == 2) ? static_cast<size_t>((r.count + 7) / 8)
                                    : static_cast<size_t>(r.count) * 2;
  }

  /** Une transaction : requête de lecture puis décodage de la réponse. */
  Fail exchange(const Req& r, std::string& err) {
    const int unit = static_cast<int>(link_.num("unitId", 1));
    uint8_t pdu[5] = {static_cast<uint8_t>(r.fn),
                      static_cast<uint8_t>(r.start >> 8), static_cast<uint8_t>(r.start & 0xFF),
                      static_cast<uint8_t>(r.count >> 8), static_cast<uint8_t>(r.count & 0xFF)};
    std::vector<uint8_t> data;   // charge utile de la réponse (sans en-tête)

    if (serial_ || rtu_over_tcp()) {
      uint8_t frame[8];
      frame[0] = static_cast<uint8_t>(unit);
      std::memcpy(frame + 1, pdu, 5);
      const uint16_t crc = crc16(frame, 6);
      frame[6] = static_cast<uint8_t>(crc & 0xFF);        // CRC : poids faible d'abord
      frame[7] = static_cast<uint8_t>(crc >> 8);
      net::drain(fd_);
      if (!net::write_all(fd_, frame, sizeof frame)) { err = "écriture impossible"; return Fail::Link; }

      uint8_t head[3];
      if (!net::read_exact(fd_, head, 3, timeout_ms())) { err = "pas de réponse (délai dépassé)"; return Fail::Link; }
      if (head[0] != static_cast<uint8_t>(unit)) { err = "réponse d'un autre esclave"; return Fail::Link; }
      if (head[1] & 0x80) {
        uint8_t tail[2];
        net::read_exact(fd_, tail, 2, timeout_ms());
        err = exception_text(head[2]);
        return Fail::Request;
      }
      if (head[1] != static_cast<uint8_t>(r.fn)) { err = "fonction inattendue en réponse"; return Fail::Link; }
      const size_t n = head[2];
      if (n != expected_bytes(r)) { err = "taille de réponse incohérente"; return Fail::Link; }
      std::vector<uint8_t> rest(n + 2);
      if (!net::read_exact(fd_, rest.data(), rest.size(), timeout_ms())) {
        err = "réponse tronquée";
        return Fail::Link;
      }
      std::vector<uint8_t> whole;
      whole.insert(whole.end(), head, head + 3);
      whole.insert(whole.end(), rest.begin(), rest.end() - 2);
      const uint16_t got = static_cast<uint16_t>(rest[rest.size() - 2] | (rest[rest.size() - 1] << 8));
      if (crc16(whole.data(), whole.size()) != got) { err = "CRC invalide"; return Fail::Link; }
      data.assign(rest.begin(), rest.end() - 2);
    } else {
      uint8_t adu[12];
      const uint16_t tid = ++tid_;
      adu[0] = static_cast<uint8_t>(tid >> 8); adu[1] = static_cast<uint8_t>(tid & 0xFF);
      adu[2] = 0; adu[3] = 0;                                  // identifiant de protocole
      adu[4] = 0; adu[5] = 6;                                  // longueur : unit + PDU
      adu[6] = static_cast<uint8_t>(unit);
      std::memcpy(adu + 7, pdu, 5);
      if (!net::write_all(fd_, adu, 12)) { err = "écriture impossible"; return Fail::Link; }

      uint8_t mbap[8];
      if (!net::read_exact(fd_, mbap, 8, timeout_ms())) { err = "pas de réponse (délai dépassé)"; return Fail::Link; }
      const uint16_t len = static_cast<uint16_t>((mbap[4] << 8) | mbap[5]);
      if (len < 2 || len > 260) { err = "en-tête MBAP incohérent"; return Fail::Link; }
      // Appariement strict : une réponse dupliquée (passerelle bavarde) ou
      // retardée décalerait sinon le flux de façon durable — et toutes les
      // valeurs suivantes seraient fausses sans qu'aucune erreur ne le dise.
      const uint16_t rtid = static_cast<uint16_t>((mbap[0] << 8) | mbap[1]);
      if (rtid != tid || mbap[2] || mbap[3] || mbap[6] != static_cast<uint8_t>(unit)) {
        err = "réponse non appariée (transaction " + std::to_string(rtid) + ")";
        return Fail::Link;
      }
      if (mbap[7] & 0x80) {
        uint8_t code = 0;
        net::read_exact(fd_, &code, 1, timeout_ms());
        err = exception_text(code);
        return Fail::Request;
      }
      if (mbap[7] != static_cast<uint8_t>(r.fn)) { err = "fonction inattendue en réponse"; return Fail::Link; }
      uint8_t nb = 0;
      if (!net::read_exact(fd_, &nb, 1, timeout_ms())) { err = "réponse tronquée"; return Fail::Link; }
      if (nb != expected_bytes(r)) { err = "taille de réponse incohérente"; return Fail::Link; }
      data.resize(nb);
      if (nb && !net::read_exact(fd_, data.data(), nb, timeout_ms())) { err = "réponse tronquée"; return Fail::Link; }
    }

    decode(r, data);
    return Fail::None;
  }

  bool rtu_over_tcp() const { return link_.str("frame", "auto") == "rtu"; }

  void decode(const Req& r, const std::vector<uint8_t>& d) {
    const bool bits = r.fn == 1 || r.fn == 2;
    for (const Field& f : r.fields) {
      double v = 0;
      if (bits) {
        const size_t byte = static_cast<size_t>(f.offset) >> 3;
        if (byte >= d.size()) continue;
        v = (d[byte] >> (f.offset & 7)) & 1;
      } else {
        const size_t off = static_cast<size_t>(f.offset) * 2;
        const int need = regs_for(f.type) * 2;
        if (off + static_cast<size_t>(need) > d.size()) continue;
        v = decode_regs(&d[off], f);
      }
      sink_.publish(f.idx, v * f.gain + f.offset_v);
    }
  }

  /** Décodage d'un ou plusieurs registres (gros-boutiste par registre). */
  static double decode_regs(const uint8_t* p, const Field& f) {
    auto reg = [&](int i) { return static_cast<uint16_t>((p[i * 2] << 8) | p[i * 2 + 1]); };
    if (f.type == "bool") return reg(0) != 0 ? 1 : 0;
    if (f.type == "int16" || f.type == "uint16") {
      const uint16_t raw = reg(0);
      if (f.bit >= 0 && f.bit < 16) return (raw >> f.bit) & 1;
      return f.type == "int16" ? static_cast<double>(static_cast<int16_t>(raw)) : raw;
    }
    if (f.type == "int32" || f.type == "uint32" || f.type == "float32") {
      const uint16_t hi = f.little_words ? reg(1) : reg(0);
      const uint16_t lo = f.little_words ? reg(0) : reg(1);
      const uint32_t raw = (static_cast<uint32_t>(hi) << 16) | lo;
      if (f.type == "float32") { float x; std::memcpy(&x, &raw, 4); return x; }
      return f.type == "int32" ? static_cast<double>(static_cast<int32_t>(raw)) : raw;
    }
    if (f.type == "float64") {
      uint64_t raw = 0;
      for (int i = 0; i < 4; ++i) {
        const uint16_t w = reg(f.little_words ? 3 - i : i);
        raw = (raw << 16) | w;
      }
      double x;
      std::memcpy(&x, &raw, 8);
      return x;
    }
    return reg(0);
  }

  LinkConfig link_;
  IPointSink& sink_;
  bool serial_ = false;
  int fd_ = -1;
  uint16_t tid_ = 0;
  std::vector<Req> reqs_;
};

}  // namespace diagweb
