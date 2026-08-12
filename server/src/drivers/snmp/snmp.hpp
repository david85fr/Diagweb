// Diagweb — pilote SNMP (gestionnaire, lecture seule).
//
// Interrogation cyclique d'un agent SNMP par GetRequest sur UDP/161. Un point
// est un OID ; sa valeur est décodée selon le type applicatif renvoyé par
// l'agent (Integer32, Counter32, Gauge32, TimeTicks, Counter64, chaîne
// interprétée en nombre), puis mise à l'échelle.
//
// Versions :
//   v1   — RFC 1157, communauté en clair, pas de type Counter64 ;
//   v2c  — RFC 1901/3416, communauté en clair, exceptions par variable
//          (noSuchObject, noSuchInstance) et Counter64 ;
//   v3   — RFC 3414 (USM) : DÉCLARÉ, pas encore implémenté. Un lien configuré
//          en v3 s'annonce « non branché » et ne publie aucune valeur, plutôt
//          que de retomber en silence sur une version non chiffrée — ce qui
//          serait le pire des comportements pour un protocole choisi
//          précisément pour sa sécurité.
//
// Aucune écriture : SetRequest n'est pas implémenté, et ne le sera pas.
#pragma once

#include <algorithm>
#include <map>
#include <string>
#include <vector>

#include "../../protocol.hpp"
#include "../common/net.hpp"
#include "ber.hpp"

namespace diagweb {

class SnmpDriver : public IProtocolDriver {
 public:
  SnmpDriver(const LinkConfig& link, IPointSink& sink) : link_(link), sink_(sink) {
    version_ = link_.str("version", "v2c");
    for (size_t i = 0; i < link_.points.size(); ++i) {
      const PointConfig& p = link_.points[i];
      Point pt;
      pt.oid = normalize_oid(p.str("oid"));
      pt.period_s = p.period_ms / 1000.0;
      pt.gain = p.num("gain", 1);
      pt.offset = p.num("offset", 0);
      if (!pt.oid.empty()) by_oid_[pt.oid].push_back(i);
      points_.push_back(pt);
    }
  }

  ~SnmpDriver() override { close(); }

  /** SNMPv3 (USM) n'est pas écrit : le lien s'affiche « non branché ». */
  bool implemented() const override { return version_ != "v3"; }

  bool open(std::string& err) override {
    close();
    if (!implemented()) {
      err = "SNMPv3 (USM) non implémenté — configuration conservée "
            "(voir docs/PROTOCOLES.md)";
      return false;
    }
    if (link_.str("community").empty()) {
      err = "communauté non renseignée";
      return false;
    }
    fd_ = net::udp_connect(link_.str("host"), static_cast<int>(link_.num("port", 161)), err);
    return fd_ >= 0;
  }

  void close() override {
    if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
  }

  bool service(std::string& err) override {
    if (fd_ < 0) { err = "lien fermé"; return false; }
    const double t = net::mono_s();

    std::vector<size_t> lot;                       // points échus, en un envoi
    const size_t max_vars = static_cast<size_t>(
        std::clamp<double>(link_.num("maxVars", 16), 1, 64));
    for (size_t i = 0; i < points_.size() && lot.size() < max_vars; ++i) {
      if (points_[i].oid.empty() || t < points_[i].due) continue;
      points_[i].due = t + points_[i].period_s;
      lot.push_back(i);
    }
    if (lot.empty()) {
      pollfd p{fd_, POLLIN, 0};
      ::poll(&p, 1, next_delay_ms(t));             // rien à faire : on patiente
      return true;
    }
    return exchange(lot, err);
  }

 private:
  struct Point {
    std::string oid;
    double period_s = 1;
    double due = 0;
    double gain = 1, offset = 0;
  };

  int timeout_ms() const {
    return static_cast<int>(std::clamp<double>(link_.num("timeoutMs", 1500), 100, 30000));
  }

  int next_delay_ms(double t) const {
    double best = 0.05;
    for (const Point& p : points_) {
      if (!p.oid.empty()) best = std::min(best, std::max(0.0, p.due - t));
    }
    return std::max(1, static_cast<int>(best * 1000));
  }

  /** Retire un « . » de tête et refuse ce qui n'est pas une notation pointée. */
  static std::string normalize_oid(const std::string& raw) {
    std::string s = raw;
    while (!s.empty() && (s.front() == ' ' || s.front() == '.')) s.erase(s.begin());
    while (!s.empty() && s.back() == ' ') s.pop_back();
    return ber::put_oid(s).empty() ? std::string() : s;
  }

  /** Une transaction : GetRequest groupé, puis décodage de la réponse. */
  bool exchange(const std::vector<size_t>& lot, std::string& err) {
    std::vector<uint8_t> binds;
    for (size_t i : lot) {
      const std::vector<uint8_t> vb =
          ber::wrap(ber::kSequence, ber::cat({ber::put_oid(points_[i].oid), ber::put_null()}));
      binds.insert(binds.end(), vb.begin(), vb.end());
    }
    const int32_t rid = ++req_id_;
    const std::vector<uint8_t> pdu = ber::wrap(
        0xA0,                                       // GetRequest
        ber::cat({ber::put_int(rid), ber::put_int(0), ber::put_int(0),
                  ber::wrap(ber::kSequence, binds)}));
    const std::vector<uint8_t> msg = ber::wrap(
        ber::kSequence,
        ber::cat({ber::put_int(version_ == "v1" ? 0 : 1),
                  ber::put_str(ber::kOctetStr, link_.str("community")),
                  pdu}));

    if (::send(fd_, msg.data(), msg.size(), 0) != static_cast<ssize_t>(msg.size())) {
      err = "envoi impossible";
      return false;
    }

    // Un datagramme égaré ou en retard ne doit pas décaler le flux : on jette
    // ce qui ne porte pas l'identifiant demandé et on continue d'attendre.
    const double until = net::mono_s() + timeout_ms() / 1000.0;
    for (;;) {
      const int left = static_cast<int>((until - net::mono_s()) * 1000);
      if (left <= 0) {
        if (++misses_ >= 3) { err = "agent muet (délai dépassé)"; return false; }
        return true;                              // tolérance : UDP perd
      }
      uint8_t buf[8192];
      const ssize_t n = net::recv_datagram(fd_, buf, sizeof buf, left);
      if (n <= 0) continue;
      if (decode(buf, static_cast<size_t>(n), rid, err)) { misses_ = 0; return true; }
      if (!err.empty()) return true;              // erreur signalée, lien gardé
    }
  }

  /** Réponse SNMP : en-tête, PDU, puis chaque variable liée. */
  bool decode(const uint8_t* d, size_t n, int32_t want_rid, std::string& err) {
    err.clear();
    ber::Cursor top(d, n), msg;
    uint8_t tag = 0;
    if (!ber::read_into(top, tag, msg) || tag != ber::kSequence) return false;

    const uint8_t* body = nullptr;
    size_t len = 0;
    int64_t version = 0;
    if (!ber::read_tlv(msg, tag, body, len) || tag != ber::kInteger) return false;
    if (!ber::read_int(body, len, version)) return false;
    if (!ber::read_tlv(msg, tag, body, len) || tag != ber::kOctetStr) return false;

    ber::Cursor pdu;
    if (!ber::read_into(msg, tag, pdu) || tag != 0xA2) return false;   // GetResponse

    int64_t rid = 0, status = 0, index = 0;
    if (!ber::read_tlv(pdu, tag, body, len) || !ber::read_int(body, len, rid)) return false;
    if (rid != want_rid) return false;                                 // réponse d'un autre échange
    if (!ber::read_tlv(pdu, tag, body, len) || !ber::read_int(body, len, status)) return false;
    if (!ber::read_tlv(pdu, tag, body, len) || !ber::read_int(body, len, index)) return false;
    if (status != 0) {
      err = std::string("erreur SNMP : ") + status_text(status) +
            " (variable " + std::to_string(index) + ")";
      sink_.warn(err);
      return true;
    }

    ber::Cursor binds;
    if (!ber::read_into(pdu, tag, binds) || tag != ber::kSequence) return false;
    while (!binds.done()) {
      ber::Cursor vb;
      if (!ber::read_into(binds, tag, vb) || tag != ber::kSequence) break;
      if (!ber::read_tlv(vb, tag, body, len) || tag != ber::kOid) break;
      std::string oid;
      if (!ber::read_oid(body, len, oid)) break;
      uint8_t vtag = 0;
      const uint8_t* vbody = nullptr;
      size_t vlen = 0;
      if (!ber::read_tlv(vb, vtag, vbody, vlen)) break;
      publish(oid, vtag, vbody, vlen);
    }
    return true;
  }

  void publish(const std::string& oid, uint8_t tag, const uint8_t* b, size_t n) {
    const auto it = by_oid_.find(oid);
    if (it == by_oid_.end()) return;

    double v = 0;
    if (!value_of(tag, b, n, v)) {
      // noSuchObject / noSuchInstance / type non numérique : aucune valeur
      // publiée, un trou franc dans la courbe et un motif dans l'état du lien.
      sink_.warn("OID " + oid + " : " + reason(tag));
      return;
    }
    for (size_t i : it->second) sink_.publish(i, v * points_[i].gain + points_[i].offset);
  }

  /** Types applicatifs SNMP → grandeur. false = pas de valeur exploitable. */
  static bool value_of(uint8_t tag, const uint8_t* b, size_t n, double& out) {
    int64_t s = 0;
    uint64_t u = 0;
    switch (tag) {
      case ber::kInteger:
        if (!ber::read_int(b, n, s)) return false;
        out = static_cast<double>(s);
        return true;
      case ber::kCounter32:
      case ber::kGauge32:
      case ber::kTimeTicks:
      case ber::kCounter64:
        if (!ber::read_uint(b, n, u)) return false;
        out = static_cast<double>(u);
        return true;
      case ber::kOctetStr: {
        // Certains agents publient une mesure sous forme de chaîne ; on
        // l'accepte si elle est entièrement numérique, jamais autrement.
        std::string s2(reinterpret_cast<const char*>(b), n);
        size_t pos = 0;
        double parsed = 0;
        try {
          parsed = std::stod(s2, &pos);
        } catch (...) {
          return false;
        }
        while (pos < s2.size() && (s2[pos] == ' ' || s2[pos] == '\r' || s2[pos] == '\n')) ++pos;
        if (pos != s2.size()) return false;
        out = parsed;
        return true;
      }
      default:
        return false;
    }
  }

  static const char* reason(uint8_t tag) {
    switch (tag) {
      case ber::kNoSuchObject:   return "OID inconnu de l'agent (noSuchObject)";
      case ber::kNoSuchInstance: return "instance absente — un scalaire s'écrit avec « .0 »";
      case ber::kEndOfMibView:   return "fin de la vue MIB";
      case ber::kNull:           return "valeur vide";
      default:                   return "type non numérique, valeur non publiée";
    }
  }

  static const char* status_text(int64_t s) {
    switch (s) {
      case 1: return "réponse trop grande (tooBig) — réduire le groupement";
      case 2: return "nom d'objet inconnu (noSuchName)";
      case 3: return "valeur incorrecte (badValue)";
      case 4: return "objet en lecture seule (readOnly)";
      case 5: return "erreur générale (genErr)";
      case 6: return "accès refusé (noAccess)";
      default: return "code inattendu";
    }
  }

  LinkConfig link_;
  IPointSink& sink_;
  std::string version_;
  std::vector<Point> points_;
  std::map<std::string, std::vector<size_t>> by_oid_;
  int fd_ = -1;
  int32_t req_id_ = 0;
  int misses_ = 0;              // délais consécutifs avant de déclarer le lien perdu
};

}  // namespace diagweb
