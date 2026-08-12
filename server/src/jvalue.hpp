// Diagweb — arbre JSON minimal (lecture et écriture), sans dépendance.
//
// json.hpp suffit pour les messages plats du flux temps réel ; la
// configuration des liens réseau (docs/PROTOCOLES.md) est imbriquée, d'où cet
// analyseur récursif complet : objets, tableaux, chaînes (avec échappements
// \u), nombres, booléens, null.
#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "json.hpp"

namespace diagweb {

class JValue {
 public:
  enum class Type { Null, Bool, Num, Str, Arr, Obj };

  Type type = Type::Null;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<JValue> arr;
  std::vector<std::pair<std::string, JValue>> obj;

  bool is_null() const { return type == Type::Null; }
  bool is_obj() const { return type == Type::Obj; }
  bool is_arr() const { return type == Type::Arr; }

  /** Membre d'un objet, ou nullptr. */
  const JValue* find(const std::string& key) const {
    if (type != Type::Obj) return nullptr;
    for (const auto& [k, v] : obj) {
      if (k == key) return &v;
    }
    return nullptr;
  }

  std::string str(const std::string& key, const std::string& def = {}) const {
    const JValue* v = find(key);
    return v && v->type == Type::Str ? v->s : def;
  }
  double num(const std::string& key, double def = 0) const {
    const JValue* v = find(key);
    if (!v) return def;
    if (v->type == Type::Num) return v->n;
    if (v->type == Type::Bool) return v->b ? 1 : 0;
    return def;
  }
  bool flag(const std::string& key, bool def = false) const {
    const JValue* v = find(key);
    if (!v) return def;
    if (v->type == Type::Bool) return v->b;
    if (v->type == Type::Num) return v->n != 0;
    return def;
  }
  /** Tableau nommé (vide si absent), pratique pour `links` / `points`. */
  const std::vector<JValue>& list(const std::string& key) const {
    static const std::vector<JValue> kEmpty;
    const JValue* v = find(key);
    return v && v->type == Type::Arr ? v->arr : kEmpty;
  }

  void set(const std::string& key, JValue v) {
    type = Type::Obj;
    for (auto& [k, cur] : obj) {
      if (k == key) { cur = std::move(v); return; }
    }
    obj.emplace_back(key, std::move(v));
  }

  static JValue string(std::string v) { JValue j; j.type = Type::Str; j.s = std::move(v); return j; }
  static JValue number(double v) { JValue j; j.type = Type::Num; j.n = v; return j; }
  static JValue boolean(bool v) { JValue j; j.type = Type::Bool; j.b = v; return j; }
  static JValue object() { JValue j; j.type = Type::Obj; return j; }
  static JValue array() { JValue j; j.type = Type::Arr; return j; }

  /** Sérialisation compacte (ordre d'insertion conservé). */
  std::string dump() const {
    switch (type) {
      case Type::Null: return "null";
      case Type::Bool: return b ? "true" : "false";
      case Type::Num:  return jnum(n, 6);
      case Type::Str:  return "\"" + jesc(s) + "\"";
      case Type::Arr: {
        std::string o = "[";
        for (size_t i = 0; i < arr.size(); ++i) { if (i) o += ','; o += arr[i].dump(); }
        return o + "]";
      }
      case Type::Obj: {
        std::string o = "{";
        bool first = true;
        for (const auto& [k, v] : obj) {
          if (!first) o += ',';
          first = false;
          o += "\"" + jesc(k) + "\":" + v.dump();
        }
        return o + "}";
      }
    }
    return "null";
  }
};

// ------------------------------------------------------------------ analyse
namespace jdetail {

inline void skip_ws(const std::string& s, size_t& i) {
  while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
}

/** Encode un point de code en UTF-8 (les échappements \u sont décodés). */
inline void utf8(uint32_t cp, std::string& out) {
  if (cp < 0x80) {
    out += static_cast<char>(cp);
  } else if (cp < 0x800) {
    out += static_cast<char>(0xC0 | (cp >> 6));
    out += static_cast<char>(0x80 | (cp & 0x3F));
  } else if (cp < 0x10000) {
    out += static_cast<char>(0xE0 | (cp >> 12));
    out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (cp & 0x3F));
  } else {
    out += static_cast<char>(0xF0 | (cp >> 18));
    out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
    out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (cp & 0x3F));
  }
}

inline bool hex4(const std::string& s, size_t i, uint32_t& out) {
  if (i + 4 > s.size()) return false;
  out = 0;
  for (size_t k = 0; k < 4; ++k) {
    const char c = s[i + k];
    out <<= 4;
    if (c >= '0' && c <= '9') out |= static_cast<uint32_t>(c - '0');
    else if (c >= 'a' && c <= 'f') out |= static_cast<uint32_t>(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') out |= static_cast<uint32_t>(c - 'A' + 10);
    else return false;
  }
  return true;
}

inline bool parse_string(const std::string& s, size_t& i, std::string& out) {
  if (i >= s.size() || s[i] != '"') return false;
  ++i;
  while (i < s.size()) {
    const char c = s[i];
    if (c == '"') { ++i; return true; }
    if (c == '\\') {
      if (++i >= s.size()) return false;
      switch (s[i]) {
        case '"':  out += '"';  break;
        case '\\': out += '\\'; break;
        case '/':  out += '/';  break;
        case 'b':  out += '\b'; break;
        case 'f':  out += '\f'; break;
        case 'n':  out += '\n'; break;
        case 'r':  out += '\r'; break;
        case 't':  out += '\t'; break;
        case 'u': {
          uint32_t cp = 0;
          if (!hex4(s, i + 1, cp)) return false;
          i += 4;
          if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 < s.size() && s[i + 1] == '\\' && s[i + 2] == 'u') {
            uint32_t lo = 0;
            if (hex4(s, i + 3, lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
              i += 6;
            }
          }
          utf8(cp, out);
          break;
        }
        default: return false;
      }
      ++i;
      continue;
    }
    out += c;
    ++i;
  }
  return false;
}

inline bool parse_value(const std::string& s, size_t& i, JValue& out, int depth);

inline bool parse_container(const std::string& s, size_t& i, JValue& out, int depth) {
  const bool is_obj = s[i] == '{';
  const char close = is_obj ? '}' : ']';
  out.type = is_obj ? JValue::Type::Obj : JValue::Type::Arr;
  ++i;
  skip_ws(s, i);
  if (i < s.size() && s[i] == close) { ++i; return true; }
  while (i < s.size()) {
    skip_ws(s, i);
    std::string key;
    if (is_obj) {
      if (!parse_string(s, i, key)) return false;
      skip_ws(s, i);
      if (i >= s.size() || s[i] != ':') return false;
      ++i;
    }
    JValue v;
    if (!parse_value(s, i, v, depth + 1)) return false;
    if (is_obj) out.obj.emplace_back(std::move(key), std::move(v));
    else out.arr.push_back(std::move(v));
    skip_ws(s, i);
    if (i >= s.size()) return false;
    if (s[i] == ',') { ++i; continue; }
    if (s[i] == close) { ++i; return true; }
    return false;
  }
  return false;
}

inline bool parse_value(const std::string& s, size_t& i, JValue& out, int depth) {
  if (depth > 32) return false;   // garde-fou : pas de récursion sans fin
  skip_ws(s, i);
  if (i >= s.size()) return false;
  const char c = s[i];
  if (c == '{' || c == '[') return parse_container(s, i, out, depth);
  if (c == '"') {
    out.type = JValue::Type::Str;
    return parse_string(s, i, out.s);
  }
  if (s.compare(i, 4, "true") == 0)  { out.type = JValue::Type::Bool; out.b = true;  i += 4; return true; }
  if (s.compare(i, 5, "false") == 0) { out.type = JValue::Type::Bool; out.b = false; i += 5; return true; }
  if (s.compare(i, 4, "null") == 0)  { out.type = JValue::Type::Null; i += 4; return true; }
  // Nombre
  const size_t start = i;
  if (s[i] == '-' || s[i] == '+') ++i;
  bool digits = false;
  while (i < s.size() && ((s[i] >= '0' && s[i] <= '9') || s[i] == '.' || s[i] == 'e' || s[i] == 'E' ||
                          ((s[i] == '-' || s[i] == '+') && (s[i - 1] == 'e' || s[i - 1] == 'E')))) {
    if (s[i] >= '0' && s[i] <= '9') digits = true;
    ++i;
  }
  if (!digits) return false;
  try {
    out.type = JValue::Type::Num;
    out.n = std::stod(s.substr(start, i - start));
  } catch (...) {
    return false;
  }
  return true;
}

}  // namespace jdetail

/** Analyse un document JSON complet. `ok` renseigné si fourni. */
inline JValue jparse(const std::string& text, bool* ok = nullptr) {
  JValue v;
  size_t i = 0;
  const bool good = jdetail::parse_value(text, i, v, 0);
  if (ok) *ok = good;
  if (!good) return JValue{};
  return v;
}

}  // namespace diagweb
