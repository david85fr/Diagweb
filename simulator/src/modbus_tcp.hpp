// Diagweb device simulator — Modbus TCP front-end (server side, MBAP).
//
// The mirror image of server/src/drivers/modbus/modbus.hpp: that one asks,
// this one answers. Writing both sides is what makes the pair worth having —
// the driver is checked against an implementation that was written from the
// specification, not against a recording of its own requests.
//
// Everything here is pure byte handling: a request goes in, a response comes
// out, no socket in sight. That is what lets tests/simulator.cpp exercise the
// exception paths, the framing and the limits without opening anything.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "bench.hpp"

namespace diagweb {
namespace sim {
namespace modbus {

// Function codes served. Writes only reach cells no signal drives (see below).
enum : uint8_t {
  kReadCoils = 1,
  kReadDiscrete = 2,
  kReadHolding = 3,
  kReadInput = 4,
  kWriteCoil = 5,
  kWriteRegister = 6,
  kWriteCoils = 15,
  kWriteRegisters = 16,
};

// Exception codes of the specification.
enum : uint8_t {
  kIllegalFunction = 1,
  kIllegalAddress = 2,
  kIllegalValue = 3,
  kDeviceFailure = 4,
  kGatewayNoResponse = 11,
};

struct Stats {
  uint64_t requests = 0;      // requests answered
  uint64_t exceptions = 0;    // among them, answered by an exception
  uint64_t dropped = 0;       // frames that were not Modbus at all
};

inline std::vector<uint8_t> exception(uint8_t fn, uint8_t code) {
  return {static_cast<uint8_t>(fn | 0x80), code};
}

inline uint16_t be16(const uint8_t* p) { return static_cast<uint16_t>((p[0] << 8) | p[1]); }

inline void push_be16(std::vector<uint8_t>& v, uint16_t x) {
  v.push_back(static_cast<uint8_t>(x >> 8));
  v.push_back(static_cast<uint8_t>(x & 0xFF));
}

/**
 * Executes one PDU against one device and returns the response PDU.
 *
 * A write aimed at a cell a signal drives is refused (illegal data address)
 * rather than accepted and undone 50 ms later by the next tick: a master that
 * writes and reads back must never see its own value vanish without a word.
 */
inline std::vector<uint8_t> execute(Device& d, const uint8_t* pdu, size_t n, Stats& st) {
  if (n < 1) return {};
  const uint8_t fn = pdu[0];

  switch (fn) {
    case kReadCoils:
    case kReadDiscrete: {
      if (n < 5) return exception(fn, kIllegalValue);
      const Area area = fn == kReadCoils ? Area::Coils : Area::Discrete;
      const int addr = be16(pdu + 1), count = be16(pdu + 3);
      if (count < 1 || count > 2000) return exception(fn, kIllegalValue);
      if (static_cast<size_t>(addr) + static_cast<size_t>(count) > d.area_size(area)) {
        return exception(fn, kIllegalAddress);
      }
      const size_t nb = static_cast<size_t>((count + 7) / 8);
      std::vector<uint8_t> r{fn, static_cast<uint8_t>(nb)};
      r.resize(2 + nb, 0);
      for (int i = 0; i < count; ++i) {
        if (d.bit_at(area, addr + i)) r[2 + static_cast<size_t>(i) / 8] |= 1 << (i % 8);
      }
      return r;
    }

    case kReadHolding:
    case kReadInput: {
      if (n < 5) return exception(fn, kIllegalValue);
      const Area area = fn == kReadHolding ? Area::Holding : Area::Input;
      const int addr = be16(pdu + 1), count = be16(pdu + 3);
      if (count < 1 || count > 125) return exception(fn, kIllegalValue);
      if (static_cast<size_t>(addr) + static_cast<size_t>(count) > d.area_size(area)) {
        return exception(fn, kIllegalAddress);
      }
      std::vector<uint8_t> r{fn, static_cast<uint8_t>(count * 2)};
      for (int i = 0; i < count; ++i) push_be16(r, d.reg_at(area, addr + i));
      return r;
    }

    case kWriteCoil: {
      if (n < 5) return exception(fn, kIllegalValue);
      const int addr = be16(pdu + 1);
      const uint16_t value = be16(pdu + 3);
      if (value != 0 && value != 0xFF00) return exception(fn, kIllegalValue);
      if (static_cast<size_t>(addr) >= d.coils.size() || d.coil_is_driven(addr)) {
        return exception(fn, kIllegalAddress);
      }
      d.write_coil(addr, value == 0xFF00);
      return {pdu, pdu + 5};                      // the specification echoes the request
    }

    case kWriteRegister: {
      if (n < 5) return exception(fn, kIllegalValue);
      const int addr = be16(pdu + 1);
      if (static_cast<size_t>(addr) >= d.holding.size() || d.holding_is_driven(addr)) {
        return exception(fn, kIllegalAddress);
      }
      d.write_reg(addr, be16(pdu + 3));
      return {pdu, pdu + 5};
    }

    case kWriteCoils: {
      if (n < 6) return exception(fn, kIllegalValue);
      const int addr = be16(pdu + 1), count = be16(pdu + 3);
      const size_t nb = pdu[5];
      if (count < 1 || count > 1968 || nb != static_cast<size_t>((count + 7) / 8) ||
          n < 6 + nb) {
        return exception(fn, kIllegalValue);
      }
      if (static_cast<size_t>(addr) + static_cast<size_t>(count) > d.coils.size()) {
        return exception(fn, kIllegalAddress);
      }
      for (int i = 0; i < count; ++i) {
        if (d.coil_is_driven(addr + i)) return exception(fn, kIllegalAddress);
      }
      for (int i = 0; i < count; ++i) {
        d.write_coil(addr + i, (pdu[6 + static_cast<size_t>(i) / 8] >> (i % 8)) & 1);
      }
      std::vector<uint8_t> r{fn};
      push_be16(r, static_cast<uint16_t>(addr));
      push_be16(r, static_cast<uint16_t>(count));
      return r;
    }

    case kWriteRegisters: {
      if (n < 6) return exception(fn, kIllegalValue);
      const int addr = be16(pdu + 1), count = be16(pdu + 3);
      const size_t nb = pdu[5];
      if (count < 1 || count > 123 || nb != static_cast<size_t>(count) * 2 || n < 6 + nb) {
        return exception(fn, kIllegalValue);
      }
      if (static_cast<size_t>(addr) + static_cast<size_t>(count) > d.holding.size()) {
        return exception(fn, kIllegalAddress);
      }
      for (int i = 0; i < count; ++i) {
        if (d.holding_is_driven(addr + i)) return exception(fn, kIllegalAddress);
      }
      for (int i = 0; i < count; ++i) {
        d.write_reg(addr + i, be16(pdu + 6 + static_cast<size_t>(i) * 2));
      }
      std::vector<uint8_t> r{fn};
      push_be16(r, static_cast<uint16_t>(addr));
      push_be16(r, static_cast<uint16_t>(count));
      return r;
    }

    default:
      (void)st;
      return exception(fn, kIllegalFunction);
  }
}

/** Same, with the unit identifier resolved against the bench. */
inline std::vector<uint8_t> execute(Bench& bench, int unit, const uint8_t* pdu, size_t n,
                                    Stats& st) {
  if (n < 1) return {};
  ++st.requests;
  Device* d = bench.by_unit(unit);
  // No such unit: 0x0B is what a gateway answers for a device that stays
  // silent, and it is the honest answer here too — the alternative, letting
  // another device answer, would publish somebody else's registers.
  std::vector<uint8_t> r = d ? execute(*d, pdu, n, st) : exception(pdu[0], kGatewayNoResponse);
  if (!r.empty() && (r[0] & 0x80)) ++st.exceptions;
  return r;
}

/**
 * Consumes every complete MBAP frame held in `in` and appends the responses to
 * `out`. Returns false when the stream cannot be trusted any more (a protocol
 * identifier that is not Modbus, an impossible length): the caller closes,
 * because resynchronising a byte stream by guesswork is how a server starts
 * answering the wrong questions.
 */
inline bool pump(Bench& bench, std::string& in, std::string& out, Stats& st) {
  while (in.size() >= 7) {
    const uint8_t* p = reinterpret_cast<const uint8_t*>(in.data());
    const uint16_t tid = be16(p);
    const uint16_t pid = be16(p + 2);
    const uint16_t len = be16(p + 4);
    if (pid != 0) { ++st.dropped; return false; }
    if (len < 2 || len > 254) { ++st.dropped; return false; }   // unit + PDU (253 max)
    if (in.size() < static_cast<size_t>(6) + len) break;        // frame still incomplete

    const int unit = p[6];
    const std::vector<uint8_t> r = execute(bench, unit, p + 7, static_cast<size_t>(len) - 1, st);
    in.erase(0, static_cast<size_t>(6) + len);
    if (r.empty()) continue;

    const uint16_t back = static_cast<uint16_t>(r.size() + 1);   // unité + PDU
    const uint8_t head[7] = {static_cast<uint8_t>(tid >> 8), static_cast<uint8_t>(tid & 0xFF),
                             0, 0,
                             static_cast<uint8_t>(back >> 8), static_cast<uint8_t>(back & 0xFF),
                             static_cast<uint8_t>(unit)};
    out.append(reinterpret_cast<const char*>(head), sizeof head);
    out.append(reinterpret_cast<const char*>(r.data()), r.size());
  }
  return true;
}

}  // namespace modbus
}  // namespace sim
}  // namespace diagweb
