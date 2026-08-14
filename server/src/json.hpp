// Diagweb — utilitaires JSON minimalistes (émission + lecture de champs).
// Le protocole du serveur de diagnostic est volontairement simple : des
// objets plats. Pas de dépendance externe, pas d'analyseur généraliste.
#pragma once

#include <cmath>
#include <cstdio>
#include <string>

namespace diagweb {

/** Échappe une chaîne pour l'insérer entre guillemets JSON. */
inline std::string jesc(const std::string& s) {
  std::string o;
  o.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"':  o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n";  break;
      case '\r': o += "\\r";  break;
      case '\t': o += "\\t";  break;
      default:
        if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += static_cast<char>(c);
    }
  }
  return o;
}

/** Nombre au format JSON, précision compacte (les NaN deviennent null). */
inline std::string jnum(double v, int decimals = 6) {
  if (!std::isfinite(v)) return "null";
  char buf[48];
  std::snprintf(buf, sizeof buf, "%.*f", decimals, v);
  std::string s(buf);
  if (s.find('.') != std::string::npos) {
    while (!s.empty() && s.back() == '0') s.pop_back();
    if (!s.empty() && s.back() == '.') s.pop_back();
  }
  return s.empty() ? "0" : s;
}

/** Valeur d'un champ chaîne : {"c":"sub",...} → jstr(msg, "c") == "sub". */
inline std::string jstr(const std::string& src, const std::string& key) {
  const std::string pat = "\"" + key + "\"";
  size_t p = src.find(pat);
  if (p == std::string::npos) return {};
  p = src.find(':', p + pat.size());
  if (p == std::string::npos) return {};
  ++p;
  while (p < src.size() && (src[p] == ' ' || src[p] == '\t')) ++p;
  if (p >= src.size() || src[p] != '"') return {};
  ++p;
  std::string out;
  while (p < src.size() && src[p] != '"') {
    if (src[p] == '\\' && p + 1 < src.size()) {
      ++p;
      switch (src[p]) {
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        default: out += src[p];
      }
    } else {
      out += src[p];
    }
    ++p;
  }
  return out;
}

/** Valeur d'un champ numérique, `def` si absent ou illisible. */
inline double jnumber(const std::string& src, const std::string& key, double def) {
  const std::string pat = "\"" + key + "\"";
  size_t p = src.find(pat);
  if (p == std::string::npos) return def;
  p = src.find(':', p + pat.size());
  if (p == std::string::npos) return def;
  try {
    return std::stod(src.substr(p + 1));
  } catch (...) {
    return def;
  }
}

}  // namespace diagweb
