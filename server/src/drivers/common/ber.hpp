// Diagweb — encodage/décodage BER (ASN.1), partagé par SNMP et IEC 61850.
//
// Deux protocoles très différents s'appuient dessus : SNMP encode ses PDU en
// BER, et les messages GOOSE et Sampled Values d'IEC 61850 aussi. Seules les
// étiquettes changent.
//
// Tout ce qui est lu ici vient du réseau : chaque lecture est bornée par la
// fin du tampon et refuse silencieusement ce qui déborde, plutôt que de faire
// confiance aux longueurs annoncées par l'équipement.
#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace diagweb {
namespace ber {

// -------------------------------------------------------------- étiquettes
enum Tag : uint8_t {
  kInteger   = 0x02,
  kOctetStr  = 0x04,
  kNull      = 0x05,
  kOid       = 0x06,
  kSequence  = 0x30,
  // Types applicatifs SNMP
  kIpAddress = 0x40,
  kCounter32 = 0x41,
  kGauge32   = 0x42,
  kTimeTicks = 0x43,
  kOpaque    = 0x44,
  kCounter64 = 0x46,
  // Exceptions de variable (SNMPv2c) : la variable n'a pas de valeur
  kNoSuchObject   = 0x80,
  kNoSuchInstance = 0x81,
  kEndOfMibView   = 0x82,
};

/**
 * Flottant IEC 61850 : un octet donnant la largeur de l'exposant, puis la
 * valeur IEEE-754 en gros-boutiste (4 octets pour un FLOAT32, 8 pour un
 * FLOAT64). Refuse tout ce qui ne correspond pas exactement.
 */
inline bool read_float(const uint8_t* b, size_t n, double& out) {
  if (n == 5 && b[0] == 8) {
    uint32_t raw = (static_cast<uint32_t>(b[1]) << 24) | (static_cast<uint32_t>(b[2]) << 16) |
                   (static_cast<uint32_t>(b[3]) << 8) | static_cast<uint32_t>(b[4]);
    float f;
    std::memcpy(&f, &raw, 4);
    out = f;
    return true;
  }
  if (n == 9 && b[0] == 11) {
    uint64_t raw = 0;
    for (int i = 1; i <= 8; ++i) raw = (raw << 8) | b[i];
    double d;
    std::memcpy(&d, &raw, 8);
    out = d;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- lecture
/** Curseur borné sur un tampon reçu. */
struct Cursor {
  const uint8_t* p = nullptr;
  const uint8_t* end = nullptr;

  Cursor() = default;
  Cursor(const uint8_t* d, size_t n) : p(d), end(d + n) {}
  bool done() const { return p >= end; }
  size_t left() const { return p < end ? static_cast<size_t>(end - p) : 0; }
};

/**
 * Lit une étiquette et sa longueur, et positionne `body` sur le contenu.
 * Le curseur avance après le contenu. false = trame tronquée ou incohérente.
 */
inline bool read_tlv(Cursor& c, uint8_t& tag, const uint8_t*& body, size_t& len) {
  if (c.left() < 2) return false;
  tag = *c.p++;
  const uint8_t first = *c.p++;
  if (first < 0x80) {
    len = first;
  } else {
    const size_t n = first & 0x7F;
    // Une longueur sur plus de 4 octets dépasserait de toute façon nos tampons.
    if (n == 0 || n > 4 || c.left() < n) return false;
    len = 0;
    for (size_t i = 0; i < n; ++i) len = (len << 8) | *c.p++;
  }
  if (len > c.left()) return false;
  body = c.p;
  c.p += len;
  return true;
}

/** Entre dans un constructeur (SEQUENCE, PDU) : `inner` couvre son contenu. */
inline bool read_into(Cursor& c, uint8_t& tag, Cursor& inner) {
  const uint8_t* body = nullptr;
  size_t len = 0;
  if (!read_tlv(c, tag, body, len)) return false;
  inner = Cursor(body, len);
  return true;
}

/** Entier signé en complément à deux (INTEGER). */
inline bool read_int(const uint8_t* b, size_t n, int64_t& v) {
  if (n == 0 || n > 8) return false;
  v = (b[0] & 0x80) ? -1 : 0;                 // extension de signe
  for (size_t i = 0; i < n; ++i) v = (v << 8) | b[i];
  return true;
}

/**
 * Entier non signé (Counter32, Gauge32, TimeTicks, Counter64). Un agent peut
 * préfixer un octet nul pour lever l'ambiguïté de signe : 9 octets sont donc
 * légitimes pour un Counter64.
 */
inline bool read_uint(const uint8_t* b, size_t n, uint64_t& v) {
  if (n == 0) return false;
  if (n == 9 && b[0] == 0) { ++b; --n; }
  if (n > 8) return false;
  v = 0;
  for (size_t i = 0; i < n; ++i) v = (v << 8) | b[i];
  return true;
}

/** Identifiant d'objet, rendu en notation pointée (« 1.3.6.1.2.1.1.3.0 »). */
inline bool read_oid(const uint8_t* b, size_t n, std::string& out) {
  if (n == 0) return false;
  // Les deux premiers arcs sont combinés dans le premier octet : 40 × a + b.
  out = std::to_string(b[0] / 40) + "." + std::to_string(b[0] % 40);
  uint64_t arc = 0;
  int bytes = 0;
  for (size_t i = 1; i < n; ++i) {
    if (++bytes > 9) return false;            // arc non représentable
    arc = (arc << 7) | (b[i] & 0x7F);
    if (!(b[i] & 0x80)) {
      out += "." + std::to_string(arc);
      arc = 0;
      bytes = 0;
    }
  }
  return bytes == 0;                          // pas de continuation en suspens
}

// --------------------------------------------------------------- écriture
inline void put_len(std::vector<uint8_t>& out, size_t len) {
  if (len < 0x80) {
    out.push_back(static_cast<uint8_t>(len));
    return;
  }
  uint8_t buf[4];
  int n = 0;
  for (size_t v = len; v; v >>= 8) buf[n++] = static_cast<uint8_t>(v & 0xFF);
  out.push_back(static_cast<uint8_t>(0x80 | n));
  for (int i = n - 1; i >= 0; --i) out.push_back(buf[i]);
}

/** Enveloppe un contenu déjà encodé dans une étiquette. */
inline std::vector<uint8_t> wrap(uint8_t tag, const std::vector<uint8_t>& body) {
  std::vector<uint8_t> out;
  out.reserve(body.size() + 6);
  out.push_back(tag);
  put_len(out, body.size());
  out.insert(out.end(), body.begin(), body.end());
  return out;
}

inline std::vector<uint8_t> put_int(int64_t v) {
  uint8_t buf[8];
  int n = 0;
  // Encodage minimal signé : on retire les octets de tête redondants.
  do {
    buf[n++] = static_cast<uint8_t>(v & 0xFF);
    v >>= 8;
  } while (!((v == 0 && !(buf[n - 1] & 0x80)) || (v == -1 && (buf[n - 1] & 0x80))) && n < 8);
  std::vector<uint8_t> body;
  for (int i = n - 1; i >= 0; --i) body.push_back(buf[i]);
  return wrap(kInteger, body);
}

/** Corps d'un entier non signé, sans étiquette (pour un type applicatif). */
inline std::vector<uint8_t> put_uint_body(uint64_t v) {
  uint8_t buf[8];
  int n = 0;
  do { buf[n++] = static_cast<uint8_t>(v & 0xFF); v >>= 8; } while (v && n < 8);
  std::vector<uint8_t> out;
  for (int i = n - 1; i >= 0; --i) out.push_back(buf[i]);
  return out;
}

inline std::vector<uint8_t> put_str(uint8_t tag, const std::string& s) {
  return wrap(tag, std::vector<uint8_t>(s.begin(), s.end()));
}

inline std::vector<uint8_t> put_null() { return {kNull, 0}; }

/** « 1.3.6.1.2.1… » → OID encodé ; vide si la notation est fautive. */
inline std::vector<uint8_t> put_oid(const std::string& dotted) {
  std::vector<uint64_t> arcs;
  uint64_t cur = 0;
  bool digit = false;
  for (size_t i = 0; i <= dotted.size(); ++i) {
    const char ch = i < dotted.size() ? dotted[i] : '.';
    if (ch >= '0' && ch <= '9') {
      if (cur > (1ull << 60)) return {};       // borne : entrée de configuration
      cur = cur * 10 + static_cast<uint64_t>(ch - '0');
      digit = true;
    } else if (ch == '.') {
      if (!digit) return {};
      arcs.push_back(cur);
      cur = 0;
      digit = false;
    } else {
      return {};
    }
  }
  if (arcs.size() < 2 || arcs[0] > 6 || arcs[1] >= 40) return {};

  std::vector<uint8_t> body;
  body.push_back(static_cast<uint8_t>(arcs[0] * 40 + arcs[1]));
  for (size_t i = 2; i < arcs.size(); ++i) {
    uint8_t tmp[10];
    int n = 0;
    uint64_t v = arcs[i];
    do { tmp[n++] = static_cast<uint8_t>(v & 0x7F); v >>= 7; } while (v);
    for (int k = n - 1; k >= 0; --k) {
      body.push_back(static_cast<uint8_t>(tmp[k] | (k ? 0x80 : 0x00)));
    }
  }
  return wrap(kOid, body);
}

/** Concatène des éléments encodés. */
inline std::vector<uint8_t> cat(std::initializer_list<std::vector<uint8_t>> parts) {
  std::vector<uint8_t> out;
  for (const auto& p : parts) out.insert(out.end(), p.begin(), p.end());
  return out;
}

}  // namespace ber
}  // namespace diagweb
