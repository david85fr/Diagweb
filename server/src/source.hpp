// Diagweb — contrat de source de variables, côté serveur de diagnostic.
//
// C'est la frontière avec le cœur du contrôleur : le prototype fournit une
// implémentation simulée (SimSource) ; la version embarquée fournira une
// implémentation qui interroge le processus cœur (mapping PLC, registres de
// bus, signaux des modèles via la C API). Le reste du serveur ne connaît
// que cette interface.
#pragma once

#include <cctype>
#include <string>
#include <vector>

namespace diagweb {

enum class Kind { Bit, Word, Float };

inline const char* kind_name(Kind k) {
  switch (k) {
    case Kind::Bit:  return "bit";
    case Kind::Word: return "word";
    default:         return "float";
  }
}

struct Meta {
  std::string addr;
  std::string label;
  std::string unit;
  std::string family;   // I, Q, M, S, MB, CAPI
  Kind kind = Kind::Float;
  bool known = false;   // présent au catalogue du contrôleur
};

struct Sample {
  double t = 0;   // secondes depuis le démarrage du serveur
  double v = 0;
};

/** Résultat d'analyse d'une adresse saisie par l'opérateur. */
struct ParsedAddr {
  bool ok = false;
  std::string addr;     // forme normalisée
  std::string family;
  Kind kind = Kind::Float;
  std::string error;
};

/**
 * Grammaire des adresses — miroir de web/js/parser.js :
 *   I/Q/M/S suivis de 1 à 4 niveaux numériques  → bit
 *   MB<registre>                                → mot de bus 16 bits
 *   Modele.sous_systeme.signal                  → signal de modèle (C API)
 * Le séparateur hiérarchique est le point ; « / » est toléré et normalisé.
 */
inline ParsedAddr parse_addr(const std::string& raw) {
  ParsedAddr r;
  std::string in;
  for (char c : raw) {
    if (c == '/') in += '.';
    else if (!std::isspace(static_cast<unsigned char>(c))) in += c;
  }
  if (in.empty()) { r.error = "adresse vide"; return r; }

  // Mot de bus : MB<registre>
  if ((in[0] == 'M' || in[0] == 'm') && in.size() > 2 && (in[1] == 'B' || in[1] == 'b')) {
    std::string digits = in.substr(2);
    if (!digits.empty() && digits.find_first_not_of("0123456789") == std::string::npos) {
      const long reg = std::stol(digits);
      if (reg > 65535) { r.error = "registre hors plage (0 a 65535)"; return r; }
      r.ok = true; r.addr = "MB" + std::to_string(reg); r.family = "MB"; r.kind = Kind::Word;
      return r;
    }
  }

  // Bits PLC : I/Q/M/S + 1 a 4 niveaux numeriques
  const char f = static_cast<char>(std::toupper(static_cast<unsigned char>(in[0])));
  if (f == 'I' || f == 'Q' || f == 'M' || f == 'S') {
    const std::string rest = in.substr(1);
    bool valid = !rest.empty();
    int levels = 1, run = 0;
    for (char c : rest) {
      if (std::isdigit(static_cast<unsigned char>(c))) { ++run; }
      else if (c == '.' && run > 0) { ++levels; run = 0; }
      else { valid = false; break; }
    }
    if (valid && run > 0 && levels <= 4) {
      r.ok = true; r.addr = std::string(1, f) + rest; r.family = std::string(1, f);
      r.kind = Kind::Bit;
      return r;
    }
  }

  // Signal de modele : identifiants separes par des points (>= 2 segments)
  {
    bool valid = true, first = true;
    int segs = 1, run = 0;
    for (char c : in) {
      if (c == '.') {
        if (run == 0) { valid = false; break; }
        ++segs; run = 0; first = true;
        continue;
      }
      const bool alpha = std::isalpha(static_cast<unsigned char>(c)) || c == '_';
      const bool alnum = alpha || std::isdigit(static_cast<unsigned char>(c));
      if ((first && !alpha) || (!first && !alnum)) { valid = false; break; }
      first = false; ++run;
    }
    if (valid && run > 0 && segs >= 2) {
      r.ok = true; r.addr = in; r.family = "CAPI"; r.kind = Kind::Float;
      return r;
    }
  }

  r.error = "format non reconnu";
  return r;
}

/** Source de variables : abonnement par adresse, période propre à chacune. */
class IVariableSource {
 public:
  virtual ~IVariableSource() = default;

  /** Abonne (comptage de références). Renvoie les métadonnées, ou nullptr. */
  virtual const Meta* subscribe(const std::string& addr, int period_ms) = 0;
  virtual void unsubscribe(const std::string& addr) = 0;

  /** Échantillons postérieurs à `since_t` (au plus `max_out`, décimés). */
  virtual size_t read(const std::string& addr, double since_t,
                      std::vector<Sample>& out, size_t max_out) = 0;

  /** Horloge de la source, en secondes depuis son démarrage. */
  virtual double now() const = 0;
  virtual const char* name() const = 0;
};

}  // namespace diagweb
