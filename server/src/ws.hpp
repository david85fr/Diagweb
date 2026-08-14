// Diagweb — WebSocket (RFC 6455) : poignée de main et trames, minimal.
// Seul le nécessaire au flux de diagnostic : trames texte, ping/pong, close.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "sha1.hpp"

namespace diagweb {

inline constexpr const char* kWsGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Valeur de l'en-tête Sec-WebSocket-Accept pour une clé donnée. */
inline std::string ws_accept(const std::string& key) {
  return base64(sha1(key + kWsGuid));
}

enum class Op : uint8_t { Cont = 0x0, Text = 0x1, Bin = 0x2, Close = 0x8, Ping = 0x9, Pong = 0xA };

struct Frame {
  Op op = Op::Text;
  std::string payload;
  bool fin = true;
};

/** Encode une trame serveur → client (jamais masquée). */
inline std::string ws_encode(Op op, const std::string& payload) {
  std::string out;
  out.push_back(static_cast<char>(0x80 | static_cast<uint8_t>(op)));
  const size_t n = payload.size();
  if (n < 126) {
    out.push_back(static_cast<char>(n));
  } else if (n <= 0xFFFF) {
    out.push_back(126);
    out.push_back(static_cast<char>((n >> 8) & 0xFF));
    out.push_back(static_cast<char>(n & 0xFF));
  } else {
    out.push_back(127);
    for (int i = 7; i >= 0; --i) out.push_back(static_cast<char>((n >> (i * 8)) & 0xFF));
  }
  out += payload;
  return out;
}

/**
 * Extrait une trame complète du tampon de réception.
 * @return true si une trame a été consommée (retirée de `buf`).
 */
inline bool ws_decode(std::string& buf, Frame& out) {
  if (buf.size() < 2) return false;
  const uint8_t b0 = static_cast<uint8_t>(buf[0]);
  const uint8_t b1 = static_cast<uint8_t>(buf[1]);
  const bool masked = (b1 & 0x80) != 0;
  uint64_t len = b1 & 0x7F;
  size_t pos = 2;

  if (len == 126) {
    if (buf.size() < pos + 2) return false;
    len = (uint8_t(buf[pos]) << 8) | uint8_t(buf[pos + 1]);
    pos += 2;
  } else if (len == 127) {
    if (buf.size() < pos + 8) return false;
    len = 0;
    for (int i = 0; i < 8; ++i) len = (len << 8) | uint8_t(buf[pos + i]);
    pos += 8;
  }
  // Garde-fou : une trame de diagnostic reste petite
  if (len > (16u << 20)) { buf.clear(); return false; }

  uint8_t mask[4] = {0, 0, 0, 0};
  if (masked) {
    if (buf.size() < pos + 4) return false;
    for (int i = 0; i < 4; ++i) mask[i] = static_cast<uint8_t>(buf[pos + i]);
    pos += 4;
  }
  if (buf.size() < pos + len) return false;

  out.fin = (b0 & 0x80) != 0;
  out.op = static_cast<Op>(b0 & 0x0F);
  out.payload.assign(buf, pos, static_cast<size_t>(len));
  if (masked) {
    for (size_t i = 0; i < out.payload.size(); ++i) {
      out.payload[i] = static_cast<char>(uint8_t(out.payload[i]) ^ mask[i % 4]);
    }
  }
  buf.erase(0, pos + static_cast<size_t>(len));
  return true;
}

}  // namespace diagweb
