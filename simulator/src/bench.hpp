// Diagweb device simulator — the bench: simulated devices and their signals.
//
// One data model, several protocol front-ends. A signal is an animated
// engineering value (a pressure, a speed, a state); how it is exposed — a
// Modbus register today, an SNMP OID or an OPC UA node later — is declared
// next to it and never changes the way the value is produced. Keeping that
// separation is the whole point of this file: adding a protocol must not
// touch the signals, and adding a signal must not touch the protocols.
//
// The motion laws are those of the diagnostic server's simulated source
// (sim_source.hpp), themselves mirrored from web/js/sim.js: the same signal
// families are seen everywhere, which makes a curve recognisable whatever
// produced it.
#pragma once

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <optional>
#include <string>
#include <vector>

#include "jvalue.hpp"
#include "sim_source.hpp"

namespace diagweb {
namespace sim {

// ------------------------------------------------------------------- motion
/**
 * Law of motion of a signal: the generators shared with the diagnostic
 * server, plus three laws that only make sense for a device image — a
 * constant, a ramp (an energy meter index climbs, it does not oscillate) and
 * a sawtooth. The sawtooth is the test signal: it sweeps a known interval at
 * a known pace, so a glance at the curve tells whether the whole chain — the
 * device, the driver, the WebSocket, the plot — is alive and honest.
 */
class Motion {
 public:
  Motion() = default;

  static Motion parse(const JValue& j, Kind kind, const std::string& seed,
                      std::vector<std::string>& warnings) {
    Motion m;
    const std::string kind_name = j.str("kind", "const");
    const double period = std::max(0.001, j.num("periodS", 10));

    if (kind_name == "const") {
      m.value_ = j.num("value", 0);
      return m;
    }
    if (kind_name == "ramp") {
      m.law_ = Law::Ramp;
      m.value_ = j.num("base", 0);
      m.rate_ = j.num("rate", 1);
      m.modulo_ = std::max(0.0, j.num("modulo", 0));
      return m;
    }
    if (kind_name == "saw") {
      m.law_ = Law::Saw;
      m.value_ = j.num("min", 0);
      m.rate_ = j.num("max", 1) - m.value_;      // amplitude of the sweep
      m.modulo_ = period;
      return m;
    }

    m.law_ = Law::Gen;
    SimSpec spec;
    if (kind_name == "sine") {
      spec = sine(j.num("base", 0), j.num("amp", 1), period, j.num("noise", 0));
    } else if (kind_name == "walk") {
      spec = walk(j.num("base", 0), j.num("step", 1), j.num("min", 0), j.num("max", 100),
                  j.num("drift", 0));
    } else if (kind_name == "steps") {
      std::vector<double> values;
      for (const JValue& v : j.list("values")) {
        if (v.type == JValue::Type::Num) values.push_back(v.n);
      }
      if (values.empty()) values.push_back(0);
      spec = steps(std::move(values), period, j.num("noise", 0));
    } else if (kind_name == "square") {
      spec = square(period, std::clamp(j.num("duty", 0.5), 0.01, 0.99));
    } else if (kind_name == "bits") {
      spec = bitchain(std::max(0.1, j.num("offS", 10)), std::max(0.1, j.num("onS", 10)));
    } else if (kind_name == "counter") {
      spec = counter(j.num("rate", 1));
    } else if (kind_name == "jitter") {
      spec = jitter(j.num("base", 0), j.num("noise", 1), j.num("spikeP", 0),
                    j.num("spikeAmp", 0));
    } else {
      warnings.push_back("loi « " + kind_name + " » inconnue (" + seed +
                         ") : valeur figée à 0");
      m.law_ = Law::Const;
      return m;
    }
    m.gen_.emplace(spec, kind, seed);
    return m;
  }

  double operator()(double t) {
    switch (law_) {
      case Law::Const: return value_;
      case Law::Ramp: {
        const double v = value_ + rate_ * t;
        return modulo_ > 0 ? std::fmod(std::fmod(v, modulo_) + modulo_, modulo_) : v;
      }
      case Law::Saw: {
        // min at t = 0, max reached just before the period elapses, then back.
        const double phase = std::fmod(std::fmod(t, modulo_) + modulo_, modulo_) / modulo_;
        return value_ + rate_ * phase;
      }
      case Law::Gen: return gen_ ? (*gen_)(t) : 0;
    }
    return 0;
  }

 private:
  enum class Law { Const, Ramp, Saw, Gen };
  Law law_ = Law::Const;
  double value_ = 0, rate_ = 0, modulo_ = 0;
  std::optional<Generator> gen_;
};

// ------------------------------------------------------------ Modbus mapping
enum class Area { Coils, Discrete, Holding, Input };

inline const char* area_name(Area a) {
  switch (a) {
    case Area::Coils: return "bobines";
    case Area::Discrete: return "entrées TOR";
    case Area::Holding: return "registres de maintien";
    default: return "registres d'entrée";
  }
}

/** Read function code an area answers to (01, 02, 03, 04). */
inline int area_fn(Area a) {
  switch (a) {
    case Area::Coils: return 1;
    case Area::Discrete: return 2;
    case Area::Holding: return 3;
    default: return 4;
  }
}

inline bool area_is_bit(Area a) { return a == Area::Coils || a == Area::Discrete; }

/** Registers spanned by a value type — same table as the Modbus driver. */
inline int regs_for(const std::string& type) {
  if (type == "int32" || type == "uint32" || type == "float32") return 2;
  if (type == "float64") return 4;
  return 1;
}

/**
 * How a signal shows up on the wire. `gain` and `offset` are the ones the
 * master will apply (`value = raw × gain + offset`): the configuration is
 * therefore written in engineering units, and the register holds the raw
 * value — exactly the reading a real device would give.
 */
struct ModbusPoint {
  bool exposed = false;
  Area area = Area::Holding;
  int addr = 0;
  std::string type = "uint16";
  bool little_words = false;
  double gain = 1, offset = 0;

  int span() const { return area_is_bit(area) ? 1 : regs_for(type); }
};

/** Raw image of an engineering value, before it is split into registers. */
inline uint64_t raw_of(const std::string& type, double x) {
  if (type == "float32") {
    const float f = static_cast<float>(x);
    uint32_t r = 0;
    std::memcpy(&r, &f, 4);
    return r;
  }
  if (type == "float64") {
    const double d = x;
    uint64_t r = 0;
    std::memcpy(&r, &d, 8);
    return r;
  }
  const double v = std::isfinite(x) ? std::round(x) : 0;
  if (type == "int16") {
    return static_cast<uint16_t>(static_cast<int16_t>(std::clamp(v, -32768.0, 32767.0)));
  }
  if (type == "int32") {
    return static_cast<uint32_t>(
        static_cast<int32_t>(std::clamp(v, -2147483648.0, 2147483647.0)));
  }
  if (type == "uint32") {
    return static_cast<uint32_t>(std::clamp(v, 0.0, 4294967295.0));
  }
  return static_cast<uint16_t>(std::clamp(v, 0.0, 65535.0));
}

/** Splits a raw value into registers, most significant word first by default. */
inline void encode_regs(const ModbusPoint& m, double value, uint16_t* out) {
  const double x = m.gain != 0 ? (value - m.offset) / m.gain : 0;
  const uint64_t raw = raw_of(m.type, x);
  const int n = regs_for(m.type);
  for (int i = 0; i < n; ++i) {
    const uint16_t w = static_cast<uint16_t>((raw >> (16 * (n - 1 - i))) & 0xFFFF);
    out[m.little_words ? n - 1 - i : i] = w;
  }
}

/**
 * The other way round: registers back to an engineering value. Same rules as
 * the driver, and used to display what the image really holds — including a
 * free cell a master has just written, which no generator would know about.
 */
inline double decode_regs(const ModbusPoint& m, const uint16_t* words) {
  const int n = regs_for(m.type);
  uint64_t raw = 0;
  for (int i = 0; i < n; ++i) {
    raw = (raw << 16) | words[m.little_words ? n - 1 - i : i];
  }
  double x = 0;
  if (m.type == "float32") {
    const uint32_t r = static_cast<uint32_t>(raw);
    float f = 0;
    std::memcpy(&f, &r, 4);
    x = f;
  } else if (m.type == "float64") {
    double d = 0;
    std::memcpy(&d, &raw, 8);
    x = d;
  } else if (m.type == "int16") {
    x = static_cast<int16_t>(static_cast<uint16_t>(raw));
  } else if (m.type == "int32") {
    x = static_cast<int32_t>(static_cast<uint32_t>(raw));
  } else {
    x = static_cast<double>(raw);
  }
  return x * m.gain + m.offset;
}

// ------------------------------------------------------------------- signals
struct Signal {
  std::string id, label, unit;
  Motion motion;
  double value = 0;         // last value produced (engineering units)
  ModbusPoint modbus;
};

/**
 * A simulated device. Its four Modbus areas are plain images, written by
 * tick() and by nobody else: the protocol front-ends only read them, which is
 * the point — Diagweb never writes to an equipment, so neither can anything
 * reach these cells from the outside.
 */
struct Device {
  std::string id, label;
  int unit_id = 1;
  std::vector<Signal> signals;

  std::vector<uint8_t> coils, discrete;        // one byte per address (0 or 1)
  std::vector<uint16_t> holding, input;

  size_t area_size(Area a) const {
    switch (a) {
      case Area::Coils: return coils.size();
      case Area::Discrete: return discrete.size();
      case Area::Holding: return holding.size();
      default: return input.size();
    }
  }

  /** What the image really holds for a point, in engineering units. */
  double value_of(const ModbusPoint& m) const {
    if (!m.exposed) return 0;
    if (area_is_bit(m.area)) return (bit_at(m.area, m.addr) ? 1.0 : 0.0) * m.gain + m.offset;
    uint16_t words[4] = {0, 0, 0, 0};
    for (int i = 0; i < m.span(); ++i) words[i] = reg_at(m.area, m.addr + i);
    return decode_regs(m, words);
  }

  bool bit_at(Area a, int addr) const {
    const std::vector<uint8_t>& v = a == Area::Coils ? coils : discrete;
    return addr >= 0 && static_cast<size_t>(addr) < v.size() && v[static_cast<size_t>(addr)];
  }
  uint16_t reg_at(Area a, int addr) const {
    const std::vector<uint16_t>& v = a == Area::Holding ? holding : input;
    return addr >= 0 && static_cast<size_t>(addr) < v.size() ? v[static_cast<size_t>(addr)] : 0;
  }

  /** Writes one signal into the register image. */
  void apply(const Signal& s) {
    const ModbusPoint& m = s.modbus;
    if (!m.exposed) return;
    if (area_is_bit(m.area)) {
      const double x = m.gain != 0 ? (s.value - m.offset) / m.gain : 0;
      const uint8_t bit = x >= 0.5 ? 1 : 0;
      std::vector<uint8_t>& v = m.area == Area::Coils ? coils : discrete;
      if (static_cast<size_t>(m.addr) < v.size()) v[static_cast<size_t>(m.addr)] = bit;
      return;
    }
    uint16_t words[4] = {0, 0, 0, 0};
    encode_regs(m, s.value, words);
    std::vector<uint16_t>& v = m.area == Area::Holding ? holding : input;
    for (int i = 0; i < m.span(); ++i) {
      const size_t at = static_cast<size_t>(m.addr + i);
      if (at < v.size()) v[at] = words[i];
    }
  }
};

// --------------------------------------------------------------------- bench
/**
 * The whole set of simulated devices. The tick thread writes it, the protocol
 * front-ends only read it — they are handed a `const Bench&`, so read-only is
 * checked by the compiler rather than promised in a comment. Callers still
 * take a lock around both: a request served while an update is half written
 * would publish an inconsistent 32-bit value.
 */
class Bench {
 public:
  std::vector<Device> devices;

  /**
   * Device answering a unit identifier. A TCP-native device usually answers
   * whatever unit it is asked for; here units 0 and 255 (the values masters
   * use when they have nothing better) fall back to the first device, and an
   * unknown unit is refused rather than silently answered by the wrong one.
   */
  const Device* by_unit(int unit) const {
    for (const Device& d : devices) {
      if (d.unit_id == unit) return &d;
    }
    if ((unit == 0 || unit == 255) && !devices.empty()) return &devices.front();
    return nullptr;
  }

  void tick(double t) {
    for (Device& d : devices) {
      for (Signal& s : d.signals) {
        s.value = s.motion(t);
        d.apply(s);
      }
    }
  }

  size_t signal_count() const {
    size_t n = 0;
    for (const Device& d : devices) n += d.signals.size();
    return n;
  }

  /** Human-readable register map: what to type into a Diagweb link. */
  std::string map_text() const {
    // Columns are padded on code points, not on bytes: « °C » is two glyphs
    // and three octets, and a byte-wise printf shifts the whole table.
    auto width = [](const std::string& s) {
      size_t n = 0;
      for (unsigned char c : s) {
        if ((c & 0xC0) != 0x80) ++n;
      }
      return n;
    };
    auto left = [&](const std::string& s, size_t w) {
      return s + std::string(w > width(s) ? w - width(s) : 0, ' ');
    };
    auto right = [&](const std::string& s, size_t w) {
      return std::string(w > width(s) ? w - width(s) : 0, ' ') + s;
    };
    auto row = [&](const std::string& fn, const std::string& addr, const std::string& type,
                   const std::string& gain, const std::string& unit, const std::string& value,
                   const std::string& sig) {
      return "  " + left(fn, 4) + left(addr, 9) + left(type, 9) + right(gain, 6) + "  " +
             left(unit, 8) + right(value, 10) + "  " + sig + "\n";
    };

    std::string out;
    char num[32];
    for (const Device& d : devices) {
      out += "\n" + d.label + " — unité " + std::to_string(d.unit_id) + " (" + d.id + ")\n";
      out += row("fn", "adresse", "type", "gain", "unité", "valeur", "signal");
      for (const Signal& s : d.signals) {
        const ModbusPoint& m = s.modbus;
        if (!m.exposed) continue;
        std::snprintf(num, sizeof num, "%02d", area_fn(m.area));
        const std::string fn = num;
        std::snprintf(num, sizeof num, "%g", m.gain);
        const std::string gain = num;
        std::snprintf(num, sizeof num, "%.4g", d.value_of(m));
        out += row(fn, std::to_string(m.addr), area_is_bit(m.area) ? "bit" : m.type, gain,
                   s.unit, num, s.id + (s.label.empty() ? "" : " — " + s.label));
      }
    }
    return out;
  }

  static Bench from_json(const JValue& root, std::vector<std::string>& warnings);
};

// --------------------------------------------------------------- reading JSON
namespace detail {

inline bool parse_area(const std::string& name, Area& out) {
  if (name == "coils" || name == "bobines") out = Area::Coils;
  else if (name == "discrete" || name == "tor") out = Area::Discrete;
  else if (name == "holding" || name == "maintien") out = Area::Holding;
  else if (name == "input" || name == "entree") out = Area::Input;
  else return false;
  return true;
}

inline bool known_type(const std::string& t) {
  return t == "bool" || t == "int16" || t == "uint16" || t == "int32" || t == "uint32" ||
         t == "float32" || t == "float64";
}

/** Identifier rule of the project: a letter, then letters/digits/-/_, ≤ 24. */
inline bool valid_id(const std::string& s) {
  if (s.empty() || s.size() > 24) return false;
  if (!std::isalpha(static_cast<unsigned char>(s[0]))) return false;
  for (char c : s) {
    if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_' && c != '-') return false;
  }
  return true;
}

inline size_t area_span(const Device& d, Area a) {
  size_t end = 0;
  for (const Signal& s : d.signals) {
    if (!s.modbus.exposed || s.modbus.area != a) continue;
    end = std::max(end, static_cast<size_t>(s.modbus.addr + s.modbus.span()));
  }
  return end;
}

}  // namespace detail

inline Bench Bench::from_json(const JValue& root, std::vector<std::string>& warnings) {
  Bench bench;
  const std::vector<JValue>& devices = root.list("devices");
  if (devices.empty()) warnings.push_back("aucun équipement dans la configuration");

  for (const JValue& jd : devices) {
    Device d;
    d.id = jd.str("id");
    d.label = jd.str("label", d.id);
    if (!detail::valid_id(d.id)) {
      warnings.push_back("équipement à l'identifiant invalide, ignoré : « " + d.id + " »");
      continue;
    }
    const JValue* jm = jd.find("modbus");
    d.unit_id = jm ? static_cast<int>(jm->num("unitId", 1)) : 1;
    if (d.unit_id < 0 || d.unit_id > 255) {
      warnings.push_back(d.id + " : identifiant d'unité hors plage, ramené à 1");
      d.unit_id = 1;
    }
    bool duplicate = false;
    for (const Device& other : bench.devices) {
      if (other.unit_id == d.unit_id) duplicate = true;
    }
    if (duplicate) {
      warnings.push_back(d.id + " : unité " + std::to_string(d.unit_id) +
                         " déjà prise, équipement ignoré");
      continue;
    }

    for (const JValue& js : jd.list("signals")) {
      Signal s;
      s.id = js.str("id");
      s.label = js.str("label");
      s.unit = js.str("unit");
      if (!detail::valid_id(s.id)) {
        warnings.push_back(d.id + " : signal à l'identifiant invalide, ignoré : « " + s.id + " »");
        continue;
      }
      bool twice = false;
      for (const Signal& other : d.signals) {
        if (other.id == s.id) twice = true;
      }
      if (twice) {
        warnings.push_back(d.id + " : signal « " + s.id + " » déclaré deux fois, ignoré");
        continue;
      }

      const JValue* jp = js.find("modbus");
      if (jp && jp->is_obj()) {
        ModbusPoint& m = s.modbus;
        if (!detail::parse_area(jp->str("area", "holding"), m.area)) {
          warnings.push_back(d.id + "." + s.id + " : zone Modbus inconnue « " +
                             jp->str("area") + " », signal non exposé");
        } else {
          m.addr = static_cast<int>(jp->num("addr", -1));
          m.type = jp->str("type", area_is_bit(m.area) ? "bool" : "uint16");
          m.little_words = jp->str("wordOrder", "big") == "little";
          m.gain = jp->num("gain", 1);
          m.offset = jp->num("offset", 0);
          if (m.addr < 0 || m.addr > 65535) {
            warnings.push_back(d.id + "." + s.id + " : adresse Modbus hors plage, non exposé");
          } else if (!detail::known_type(m.type)) {
            warnings.push_back(d.id + "." + s.id + " : type « " + m.type +
                               " » inconnu, non exposé");
          } else if (m.addr + m.span() > 65536) {
            warnings.push_back(d.id + "." + s.id + " : déborde la fin de la zone, non exposé");
          } else {
            m.exposed = true;
          }
        }
      }

      // No law of motion: a constant, which many real registers are — a serial
      // number, a frozen setpoint, a configuration word. It is spelled
      // `"gen": {"kind": "const", "value": …}`, and defaults to zero.
      const JValue* jg = js.find("gen");
      if (jg && jg->is_obj()) {
        const Kind kind = area_is_bit(s.modbus.area) && s.modbus.exposed ? Kind::Bit : Kind::Float;
        s.motion = Motion::parse(*jg, kind, d.id + "." + s.id, warnings);
      }
      s.value = s.motion(0);
      d.signals.push_back(std::move(s));
    }

    // Area sizes: what the configuration asks for, never less than what the
    // signals need. A read past the end answers exception 02, as a real device
    // would — that is worth keeping, so nothing is rounded up silently.
    auto sized = [&](Area a, const char* key) {
      const size_t want = jm ? static_cast<size_t>(std::max(0.0, jm->num(key, 0))) : 0;
      return std::min<size_t>(65536, std::max(want, detail::area_span(d, a)));
    };
    d.coils.assign(sized(Area::Coils, "coils"), 0);
    d.discrete.assign(sized(Area::Discrete, "discrete"), 0);
    d.holding.assign(sized(Area::Holding, "holding"), 0);
    d.input.assign(sized(Area::Input, "input"), 0);

    for (const Signal& s : d.signals) d.apply(s);   // initial image, before any tick
    bench.devices.push_back(std::move(d));
  }
  return bench;
}

/**
 * Built-in bench, used when no configuration file is given. It is also what
 * `--print-config` writes out, so there is a single source of truth: edit a
 * copy of this text rather than a second file kept in sync by hand.
 *
 * Every register sweeps a SAWTOOTH from 1 to 10 over ten seconds, and that is
 * deliberate: the first question asked of a new link is « does anything come
 * through, and is it the right thing? ». A signal whose bounds and pace are
 * known answers it at a glance — a value outside 1…10, a flat line or a curve
 * with the wrong period says where to look. Integer registers climb in ten
 * visible steps, floating-point ones climb smoothly: the type shows up in the
 * shape of the curve, without reading a single configuration field.
 *
 * The bits keep laws of their own — a sawtooth has no meaning on a coil.
 */
inline const char* default_config() {
  return R"JSON({
  "version": 1,
  "devices": [
    {
      "id": "banc",
      "label": "Groupe hydraulique",
      "modbus": { "unitId": 1, "coils": 16, "discrete": 16, "holding": 100, "input": 32 },
      "signals": [
        { "id": "pression", "label": "Pression circuit A", "unit": "bar",
          "gen": { "kind": "saw", "min": 1, "max": 10, "periodS": 10 },
          "modbus": { "area": "holding", "addr": 40, "type": "uint16" } },
        { "id": "temperature", "label": "Température d'huile", "unit": "°C",
          "gen": { "kind": "saw", "min": 1, "max": 10, "periodS": 10 },
          "modbus": { "area": "holding", "addr": 41, "type": "int16" } },
        { "id": "debit", "label": "Débit refoulement", "unit": "m3/h",
          "gen": { "kind": "saw", "min": 1, "max": 10, "periodS": 10 },
          "modbus": { "area": "holding", "addr": 10, "type": "float32" } },
        { "id": "energie", "label": "Énergie consommée", "unit": "kWh",
          "gen": { "kind": "saw", "min": 1, "max": 10, "periodS": 10 },
          "modbus": { "area": "holding", "addr": 20, "type": "uint32" } },
        { "id": "consigne", "label": "Consigne de pression", "unit": "bar",
          "gen": { "kind": "saw", "min": 1, "max": 10, "periodS": 10 },
          "modbus": { "area": "holding", "addr": 50, "type": "uint16" } },
        { "id": "vitesse", "label": "Vitesse pompe", "unit": "tr/min",
          "gen": { "kind": "saw", "min": 1, "max": 10, "periodS": 10 },
          "modbus": { "area": "input", "addr": 0, "type": "uint16" } },
        { "id": "couple", "label": "Couple moteur", "unit": "N.m",
          "gen": { "kind": "saw", "min": 1, "max": 10, "periodS": 10 },
          "modbus": { "area": "input", "addr": 1, "type": "int16" } },
        { "id": "cycles", "label": "Compteur de cycles", "unit": "",
          "gen": { "kind": "saw", "min": 1, "max": 10, "periodS": 10 },
          "modbus": { "area": "input", "addr": 2, "type": "uint16" } },
        { "id": "pompe", "label": "Pompe en marche",
          "gen": { "kind": "bits", "onS": 12, "offS": 8 },
          "modbus": { "area": "coils", "addr": 0 } },
        { "id": "vanne", "label": "Vanne de by-pass",
          "gen": { "kind": "square", "periodS": 17, "duty": 0.4 },
          "modbus": { "area": "coils", "addr": 1 } },
        { "id": "automatique", "label": "Mode automatique",
          "gen": { "kind": "const", "value": 1 },
          "modbus": { "area": "coils", "addr": 2 } },
        { "id": "defaut", "label": "Défaut général",
          "gen": { "kind": "bits", "onS": 3, "offS": 60 },
          "modbus": { "area": "discrete", "addr": 0 } },
        { "id": "presence", "label": "Présence secteur",
          "gen": { "kind": "const", "value": 1 },
          "modbus": { "area": "discrete", "addr": 1 } },
        { "id": "finCourse", "label": "Fin de course vérin",
          "gen": { "kind": "square", "periodS": 9, "duty": 0.5 },
          "modbus": { "area": "discrete", "addr": 2 } }
      ]
    },
    {
      "id": "compteur",
      "label": "Compteur d'énergie",
      "modbus": { "unitId": 2, "input": 8 },
      "signals": [
        { "id": "tension", "label": "Tension composée", "unit": "V",
          "gen": { "kind": "saw", "min": 1, "max": 10, "periodS": 10 },
          "modbus": { "area": "input", "addr": 0, "type": "float32" } },
        { "id": "courant", "label": "Courant de ligne", "unit": "A",
          "gen": { "kind": "saw", "min": 1, "max": 10, "periodS": 10 },
          "modbus": { "area": "input", "addr": 2, "type": "float32" } },
        { "id": "index", "label": "Index d'énergie", "unit": "Wh",
          "gen": { "kind": "saw", "min": 1, "max": 10, "periodS": 10 },
          "modbus": { "area": "input", "addr": 4, "type": "uint32" } }
      ]
    }
  ]
}
)JSON";
}

}  // namespace sim
}  // namespace diagweb
