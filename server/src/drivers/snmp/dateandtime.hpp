// Diagweb — SNMP : décodage des dates portées par les MIB.
//
// SNMP ne transporte AUCUNE date : ni le GetRequest ni le GetResponse n'en
// portent. Ce sont les MIB qui en exposent, dans un objet voisin de la mesure —
// d'où l'« OID d'horodatage » compagnon des points. Deux formes se rencontrent :
//
//   DateAndTime (RFC 2579) — date absolue sur 8 ou 11 octets, la seule
//     réellement fiable, décodée ici ;
//   TimeTicks — centièmes de seconde depuis le démarrage de l'agent, qui ne
//     devient absolu qu'en le rapportant au sysUpTime lu dans le MÊME échange
//     (voir les pilotes).
//
// Ce fichier ne dépend que de la bibliothèque standard : il sert aussi bien au
// pilote appuyé sur Net-SNMP qu'à l'implémentation interne, et se teste sans
// aucune des deux (tests/decode.cpp).
#pragma once

#include <cstddef>
#include <ctime>

namespace diagweb {

/**
 * DateAndTime (RFC 2579) → secondes UTC ; 0 si la forme n'est pas celle
 * attendue. Huit octets pour une heure locale sans fuseau, onze avec le
 * décalage explicite — seul ce second cas est vraiment sans ambiguïté, mais on
 * accepte le premier en le prenant pour de l'UTC, faute de mieux.
 *
 *   0-1 année (gros-boutiste)   4 heure      7 dixièmes de seconde
 *   2   mois                    5 minute     8 « + » ou « − » par rapport à UTC
 *   3   jour                    6 seconde    9-10 heures et minutes de décalage
 */
inline double date_and_time_utc(const unsigned char* b, size_t n) {
  if (n != 8 && n != 11) return 0;
  std::tm tm{};
  tm.tm_year = ((b[0] << 8) | b[1]) - 1900;
  tm.tm_mon = b[2] - 1;
  tm.tm_mday = b[3];
  tm.tm_hour = b[4];
  tm.tm_min = b[5];
  tm.tm_sec = b[6];
  if (tm.tm_mon < 0 || tm.tm_mon > 11 || tm.tm_mday < 1 || tm.tm_mday > 31) return 0;
  if (tm.tm_hour > 23 || tm.tm_min > 59 || tm.tm_sec > 60) return 0;
  const time_t base = ::timegm(&tm);
  if (base <= 0) return 0;
  double t = static_cast<double>(base) + (b[7] % 10) / 10.0;
  if (n == 11) {                                   // décalage par rapport à UTC
    if (b[8] != '+' && b[8] != '-') return 0;
    if (b[9] > 13 || b[10] > 59) return 0;
    const int signe = (b[8] == '-') ? 1 : -1;      // « + » = en avance sur UTC
    t += signe * (b[9] * 3600 + b[10] * 60);
  }
  return t;
}

/**
 * TimeTicks (centièmes de seconde depuis le démarrage de l'agent) → secondes
 * UTC, en le rapportant au sysUpTime lu dans le même échange et à l'horloge du
 * serveur au moment de la réception. Approximatif par construction : la latence
 * du réseau s'y ajoute, et l'écart d'horloge entre agent et serveur disparaît
 * justement parce qu'on ne se sert que d'une DIFFÉRENCE de ticks. 0 si le
 * sysUpTime manque ou si la date obtenue serait dans le futur.
 */
inline double time_ticks_utc(double ticks, double sys_up_time_ticks, double maintenant) {
  if (sys_up_time_ticks <= 0 || ticks < 0 || ticks > sys_up_time_ticks) return 0;
  return maintenant - (sys_up_time_ticks - ticks) / 100.0;
}

}  // namespace diagweb
