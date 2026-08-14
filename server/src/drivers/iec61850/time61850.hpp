// Diagweb — horodatages d'IEC 61850, ramenés en secondes UTC.
//
// Deux formats cohabitent dans la norme, et ils n'ont ni la même origine ni la
// même résolution :
//
//   UtcTime     8 octets — secondes depuis 1970 (4), fraction en 1/2²⁴ de
//               seconde (3), puis un octet de qualité. Utilisé par le champ
//               `t` d'un GOOSE, par `refrTm` d'un flux Sampled Values et par
//               les attributs horodatés lus en MMS.
//   BinaryTime  6 octets — millisecondes depuis minuit (4) et jours depuis le
//               1er janvier 1984 (2). Utilisé par `TimeOfEntry` d'un rapport.
//
// Les deux rendent 0 quand la valeur est absente ou marquée invalide : c'est
// le signal convenu pour « pas d'horodatage à la source ».
#pragma once

#include <cstdint>
#include <cstddef>

namespace diagweb {

/** Jours entre le 1ᵉʳ janvier 1970 et le 1ᵉʳ janvier 1984. */
inline constexpr int64_t kJours1970a1984 = 5113;

/** UtcTime (8 octets) → secondes UTC ; 0 si absent ou invalide. */
inline double utc_time_61850(const uint8_t* b, size_t n) {
  if (n < 8) return 0;
  // Octet de qualité : le bit 7 signale une horloge non synchronisée, et le
  // bit 6 une valeur carrément invalide. On refuse la seconde, pas la
  // première — un IED non synchronisé date quand même correctement à son
  // échelle, et l'écart sera rattrapé par la garde du réceptacle.
  if (b[7] & 0x40) return 0;
  const uint32_t sec = (static_cast<uint32_t>(b[0]) << 24) | (static_cast<uint32_t>(b[1]) << 16) |
                       (static_cast<uint32_t>(b[2]) << 8) | static_cast<uint32_t>(b[3]);
  if (sec == 0) return 0;
  const uint32_t frac = (static_cast<uint32_t>(b[4]) << 16) |
                        (static_cast<uint32_t>(b[5]) << 8) | static_cast<uint32_t>(b[6]);
  return static_cast<double>(sec) + static_cast<double>(frac) / 16777216.0;
}

/** BinaryTime (6 octets) → secondes UTC ; 0 si absent. */
inline double binary_time_61850(const uint8_t* b, size_t n) {
  if (n < 6) return 0;
  const uint32_t ms = (static_cast<uint32_t>(b[0]) << 24) | (static_cast<uint32_t>(b[1]) << 16) |
                      (static_cast<uint32_t>(b[2]) << 8) | static_cast<uint32_t>(b[3]);
  const uint32_t jours = (static_cast<uint32_t>(b[4]) << 8) | static_cast<uint32_t>(b[5]);
  if (jours == 0 && ms == 0) return 0;
  return static_cast<double>((static_cast<int64_t>(jours) + kJours1970a1984) * 86400) +
         static_cast<double>(ms) / 1000.0;
}

}  // namespace diagweb
