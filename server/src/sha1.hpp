// Diagweb — SHA-1 et base64 (poignée de main WebSocket).
// Implémentation locale : le serveur ne dépend d'aucune bibliothèque tierce,
// contrainte du déploiement sur contrôleur embarqué.
#pragma once

#include <cstdint>
#include <cstring>
#include <string>

namespace diagweb {

inline std::string sha1(const std::string& in) {
  uint32_t h[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u};
  std::string msg = in;
  const uint64_t bits = static_cast<uint64_t>(in.size()) * 8;
  msg.push_back(static_cast<char>(0x80));
  while (msg.size() % 64 != 56) msg.push_back('\0');
  for (int i = 7; i >= 0; --i) msg.push_back(static_cast<char>((bits >> (i * 8)) & 0xFF));

  auto rol = [](uint32_t v, int n) { return (v << n) | (v >> (32 - n)); };
  for (size_t off = 0; off < msg.size(); off += 64) {
    uint32_t w[80];
    for (int i = 0; i < 16; ++i) {
      const unsigned char* p = reinterpret_cast<const unsigned char*>(msg.data() + off + i * 4);
      w[i] = (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3];
    }
    for (int i = 16; i < 80; ++i) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (int i = 0; i < 80; ++i) {
      uint32_t f, k;
      if (i < 20)      { f = (b & c) | (~b & d);             k = 0x5A827999u; }
      else if (i < 40) { f = b ^ c ^ d;                      k = 0x6ED9EBA1u; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d);    k = 0x8F1BBCDCu; }
      else             { f = b ^ c ^ d;                      k = 0xCA62C1D6u; }
      const uint32_t tmp = rol(a, 5) + f + e + k + w[i];
      e = d; d = c; c = rol(b, 30); b = a; a = tmp;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
  }

  std::string out(20, '\0');
  for (int i = 0; i < 5; ++i) {
    out[i * 4 + 0] = static_cast<char>((h[i] >> 24) & 0xFF);
    out[i * 4 + 1] = static_cast<char>((h[i] >> 16) & 0xFF);
    out[i * 4 + 2] = static_cast<char>((h[i] >> 8) & 0xFF);
    out[i * 4 + 3] = static_cast<char>(h[i] & 0xFF);
  }
  return out;
}

inline std::string base64(const std::string& in) {
  static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((in.size() + 2) / 3) * 4);
  size_t i = 0;
  while (i + 2 < in.size()) {
    const uint32_t v = (uint8_t(in[i]) << 16) | (uint8_t(in[i + 1]) << 8) | uint8_t(in[i + 2]);
    out += T[(v >> 18) & 63]; out += T[(v >> 12) & 63];
    out += T[(v >> 6) & 63];  out += T[v & 63];
    i += 3;
  }
  if (i + 1 == in.size()) {
    const uint32_t v = uint8_t(in[i]) << 16;
    out += T[(v >> 18) & 63]; out += T[(v >> 12) & 63]; out += "==";
  } else if (i + 2 == in.size()) {
    const uint32_t v = (uint8_t(in[i]) << 16) | (uint8_t(in[i + 1]) << 8);
    out += T[(v >> 18) & 63]; out += T[(v >> 12) & 63]; out += T[(v >> 6) & 63]; out += '=';
  }
  return out;
}

}  // namespace diagweb
