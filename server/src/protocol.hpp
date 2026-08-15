// Diagweb — cadre des pilotes de protocoles réseau du serveur de diagnostic.
//
// Le serveur ne lit pas seulement les variables internes du controller : il
// ouvre aussi ses propres liens vers des équipements tiers (Modbus,
// IEC 60870-5-104, CAN/J1939/CANopen…) et publie leurs points comme des
// variables ordinaires, adressées « @lien.point ».
//
// Vocabulaire (voir docs/PROTOCOLES.md) :
//   lien  = une connexion (protocole + paramètres) ;
//   point = une variable lue sur ce lien.
//
// La description des protocoles (champs, libellés) vit dans
// web/js/protocols.js et est générée dans protocols.generated.hpp : ce
// fichier-ci ne connaît que le modèle générique et le contrat des pilotes.
#pragma once

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "jvalue.hpp"
#include "source.hpp"

namespace diagweb {

// ---------------------------------------------------------------- modèle
struct PointConfig {
  std::string id;
  std::string label;
  std::string unit;
  Kind kind = Kind::Float;
  int period_ms = 200;
  JValue params;                      // paramètres d'adressage du protocole

  std::string str(const std::string& k, const std::string& d = {}) const { return params.str(k, d); }
  double num(const std::string& k, double d = 0) const { return params.num(k, d); }
  bool flag(const std::string& k, bool d = false) const { return params.flag(k, d); }
};

struct LinkConfig {
  std::string id;
  std::string label;
  std::string protocol;
  bool enabled = true;
  JValue params;
  std::vector<PointConfig> points;

  std::string str(const std::string& k, const std::string& d = {}) const { return params.str(k, d); }
  double num(const std::string& k, double d = 0) const { return params.num(k, d); }
  bool flag(const std::string& k, bool d = false) const { return params.flag(k, d); }
};

/** Horloge murale en secondes depuis l'époque Unix (horodatages source). */
inline double utc_now() {
  return static_cast<double>(std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::system_clock::now().time_since_epoch()).count()) / 1e6;
}

/**
 * Prochaine échéance de polling, calée sur la GRILLE de la période : les
 * multiples de `period_s` dans l'horloge de la source (secondes depuis le
 * démarrage du serveur — donc des secondes entières quand la période divise
 * la seconde). Toutes les variables interrogées à la même période tombent
 * ainsi au même instant, et le journal trié par horodatage les range sur une
 * seule ligne au lieu de deux.
 *
 * Les pilotes cadencent souvent sur leur propre horloge (net::mono_s()) :
 * `t_pilote` est l'instant courant dans cette horloge-là, `t_source` le même
 * instant lu sur la source (sink.now()), et l'échéance rendue est exprimée
 * dans l'horloge du pilote.
 */
inline double next_poll_due(double t_pilote, double t_source, double period_s) {
  if (period_s <= 0) return t_pilote;
  return t_pilote + ((std::floor(t_source / period_s) + 1.0) * period_s - t_source);
}

/** Où un pilote dépose ses valeurs (une entrée par point du lien). */
class IPointSink {
 public:
  virtual ~IPointSink() = default;

  /**
   * Nouvelle valeur pour le point d'indice `idx` (unité physique).
   *
   * `t_source` est l'horodatage produit par l'ÉQUIPEMENT, en secondes UTC
   * depuis l'époque Unix ; 0 signifie « le protocole n'en fournit pas ». Le
   * réceptacle décide s'il l'utilise : c'est un réglage par point, car faire
   * confiance à l'horloge d'un équipement de terrain n'est pas anodin.
   */
  virtual void publish(size_t idx, double value, double t_source) = 0;

  /** Raccourci pour les protocoles sans horodatage à la source. */
  void publish(size_t idx, double value) { publish(idx, value, 0.0); }
  /** Horloge de la source, en secondes depuis le démarrage du serveur. */
  virtual double now() const = 0;
  /**
   * Anomalie non fatale : le lien reste ouvert, mais une partie des points ne
   * remonte pas (adresse refusée par l'équipement, réponse incohérente…). Le
   * motif est affiché dans l'état du lien plutôt que d'être passé sous silence.
   */
  virtual void warn(const std::string& msg) { (void)msg; }
};

/**
 * Pilote d'un lien. Le gestionnaire lui consacre un fil d'exécution :
 *   open() ; puis service() en boucle jusqu'à l'arrêt ou une erreur ; close().
 * `service()` doit rendre la main régulièrement (au plus ~100 ms) pour que
 * l'arrêt reste réactif ; il bloque sur poll() le reste du temps.
 */
class IProtocolDriver {
 public:
  virtual ~IProtocolDriver() = default;
  virtual bool open(std::string& err) = 0;
  virtual bool service(std::string& err) = 0;
  virtual void close() = 0;
  /** false = pilote déclaré mais lecture non implémentée (IEC 61850). */
  virtual bool implemented() const { return true; }
};

using DriverPtr = std::unique_ptr<IProtocolDriver>;

// ------------------------------------------------------- décodage binaire
/** Champ de bits, convention Intel (petit-boutiste, bit 0 = poids faible). */
inline uint64_t bits_intel(const uint8_t* d, size_t n, int start, int len) {
  uint64_t v = 0;
  for (int i = 0; i < len; ++i) {
    const int bit = start + i;
    const size_t byte = static_cast<size_t>(bit) >> 3;
    if (byte >= n) break;
    if ((d[byte] >> (bit & 7)) & 1) v |= (1ull << i);
  }
  return v;
}

/**
 * Champ de bits, convention Motorola (gros-boutiste) : `start` est la
 * position du bit de poids fort ; on descend dans l'octet puis on passe au
 * bit 7 de l'octet suivant (parcours « en dents de scie » des bases CAN).
 */
inline uint64_t bits_motorola(const uint8_t* d, size_t n, int start, int len) {
  uint64_t v = 0;
  int bit = start;
  for (int i = 0; i < len; ++i) {
    const size_t byte = static_cast<size_t>(bit) >> 3;
    if (byte >= n) break;
    v = (v << 1) | ((d[byte] >> (bit & 7)) & 1);
    if ((bit & 7) == 0) bit += 15; else bit -= 1;
    if (bit < 0) break;
  }
  return v;
}

/**
 * PGN d'un identifiant J1939 (29 bits) : priorité (3 bits), page de données,
 * format PDU (PF) et spécifique PDU (PS), puis l'adresse source sur l'octet de
 * poids faible. En PDU1 (PF < 240) l'octet PS porte l'adresse de destination
 * et ne fait pas partie du PGN ; en PDU2 (PF ≥ 240) il en fait partie.
 */
inline uint32_t j1939_pgn(uint32_t can_id) {
  const uint32_t pf = (can_id >> 16) & 0xFF;
  const uint32_t dp = (can_id >> 24) & 0x03;
  const uint32_t ps = (can_id >> 8) & 0xFF;
  return pf < 240 ? ((dp << 16) | (pf << 8)) : ((dp << 16) | (pf << 8) | ps);
}

/** Adresse source d'un identifiant J1939. */
inline uint32_t j1939_sa(uint32_t can_id) { return can_id & 0xFF; }

/** Interprète `len` bits bruts en complément à deux si `is_signed`. */
inline double from_raw(uint64_t raw, int len, bool is_signed) {
  if (!is_signed || len <= 0 || len >= 64) return static_cast<double>(raw);
  const uint64_t sign = 1ull << (len - 1);
  if (raw & sign) {
    const uint64_t mask = (len == 64) ? ~0ull : ((1ull << len) - 1);
    return static_cast<double>(static_cast<int64_t>(raw | ~mask));
  }
  return static_cast<double>(raw);
}

/** Extraction complète d'un signal de trame (CAN, J1939, TPDO CANopen). */
inline double extract_signal(const uint8_t* d, size_t n, int start, int len,
                             bool motorola, bool is_signed, double gain, double offset) {
  if (len <= 0 || len > 64) return 0;
  const uint64_t raw = motorola ? bits_motorola(d, n, start, len) : bits_intel(d, n, start, len);
  return from_raw(raw, len, is_signed) * gain + offset;
}

// ------------------------------------------------- lecture de la config
inline Kind kind_from(const std::string& s) {
  if (s == "bit") return Kind::Bit;
  if (s == "word") return Kind::Word;
  return Kind::Float;
}

/** Identifiant de lien ou de point : une lettre puis [A-Za-z0-9_-], ≤ 24. */
inline bool valid_id(const std::string& s) {
  if (s.empty() || s.size() > 24) return false;
  if (!std::isalpha(static_cast<unsigned char>(s[0]))) return false;
  for (char c : s) {
    if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_' && c != '-') return false;
  }
  return true;
}

/** Adresse Diagweb d'un point réseau. */
inline std::string net_addr(const std::string& link, const std::string& point) {
  return "@" + link + "." + point;
}

/** Analyse « @lien.point » ; false si la forme n'est pas respectée. */
inline bool split_net_addr(const std::string& addr, std::string& link, std::string& point) {
  if (addr.size() < 4 || addr[0] != '@') return false;
  const size_t dot = addr.find('.', 1);
  if (dot == std::string::npos) return false;
  link = addr.substr(1, dot - 1);
  point = addr.substr(dot + 1);
  return valid_id(link) && valid_id(point);
}

/** Configuration complète des liens, telle qu'échangée avec le navigateur. */
struct ProtocolConfig {
  int version = 1;
  std::vector<LinkConfig> links;

  /** Lit le JSON reçu de l'interface ; ignore silencieusement l'invalide. */
  static ProtocolConfig from_json(const JValue& j) {
    ProtocolConfig cfg;
    cfg.version = static_cast<int>(j.num("version", 1));
    for (const JValue& l : j.list("links")) {
      LinkConfig link;
      link.id = l.str("id");
      link.protocol = l.str("protocol");
      if (!valid_id(link.id) || link.protocol.empty()) continue;
      bool dup = false;
      for (const auto& x : cfg.links) if (x.id == link.id) dup = true;
      if (dup) continue;
      link.label = l.str("label", link.id);
      link.enabled = l.flag("enabled", true);
      if (const JValue* p = l.find("params")) link.params = *p;
      for (const JValue& p : l.list("points")) {
        PointConfig pt;
        pt.id = p.str("id");
        if (!valid_id(pt.id)) continue;
        bool dup_p = false;
        for (const auto& x : link.points) if (x.id == pt.id) dup_p = true;
        if (dup_p) continue;
        pt.label = p.str("label", pt.id);
        pt.unit = p.str("unit");
        pt.kind = kind_from(p.str("kind", "float"));
        pt.period_ms = static_cast<int>(p.num("periodMs", 200));
        if (pt.period_ms < 10) pt.period_ms = 10;
        if (pt.period_ms > 60000) pt.period_ms = 60000;
        if (const JValue* pp = p.find("params")) pt.params = *pp;
        link.points.push_back(std::move(pt));
      }
      cfg.links.push_back(std::move(link));
    }
    return cfg;
  }

  JValue to_json() const {
    JValue root = JValue::object();
    root.set("version", JValue::number(version));
    JValue arr = JValue::array();
    for (const auto& l : links) {
      JValue jl = JValue::object();
      jl.set("id", JValue::string(l.id));
      jl.set("label", JValue::string(l.label));
      jl.set("protocol", JValue::string(l.protocol));
      jl.set("enabled", JValue::boolean(l.enabled));
      jl.set("params", l.params);
      JValue jpts = JValue::array();
      for (const auto& p : l.points) {
        JValue jp = JValue::object();
        jp.set("id", JValue::string(p.id));
        jp.set("label", JValue::string(p.label));
        jp.set("unit", JValue::string(p.unit));
        jp.set("kind", JValue::string(kind_name(p.kind)));
        jp.set("periodMs", JValue::number(p.period_ms));
        jp.set("params", p.params);
        jpts.arr.push_back(std::move(jp));
      }
      jl.set("points", std::move(jpts));
      arr.arr.push_back(std::move(jl));
    }
    root.set("links", std::move(arr));
    return root;
  }
};

}  // namespace diagweb
