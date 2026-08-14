// Diagweb — voisinage LLDP (IEEE 802.1AB).
//
// Ce que cela apporte : brancher un contrôleur dans une armoire et savoir
// immédiatement CE QU'IL Y A EN FACE de chaque port — quel équipement, quel
// port, quelle adresse d'administration — sans plan de câblage à jour et sans
// interroger le commutateur. C'est la première question d'un architecte réseau
// devant une installation qu'il ne connaît pas.
//
// Lecture seule et passive : Diagweb n'ÉMET aucune trame LLDP. Il ne se
// déclare donc pas au voisinage, et ne modifie pas ce que voient les autres.
//
// Une seule socket AF_PACKET liée à l'EtherType 0x88CC suffit pour toutes les
// interfaces : l'adresse de réception porte l'indice de celle qui a reçu la
// trame. Elle demande la capacité CAP_NET_RAW ; sans elle, la page le dit au
// lieu d'afficher un tableau vide qu'on prendrait pour « aucun voisin ».
//
// Péremption : une annonce LLDP est répétée périodiquement (30 s en général) et
// porte son propre TTL. Un voisin débranché cesse simplement d'émettre : sans
// péremption, il resterait affiché indéfiniment. Le délai est réglable, dix
// minutes par défaut.
#pragma once

#include <linux/if_ether.h>
#include <linux/if_packet.h>
#include <net/if.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <arpa/inet.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "json.hpp"

namespace diagweb {

/** EtherType de LLDP. */
inline constexpr uint16_t kEthLldp = 0x88CC;

struct LldpNeighbor {
  std::string iface;            // interface du contrôleur qui l'a reçu
  std::string chassis;          // identifiant du châssis (souvent une MAC)
  std::string chassis_kind;
  std::string port;             // identifiant du port distant
  std::string port_kind;
  std::string port_desc;
  std::string sys_name;
  std::string sys_desc;
  std::string mgmt_ip;          // adresse d'administration annoncée
  std::string caps;             // capacités activées (pont, routeur, station…)
  std::string vlan;             // VLAN natif, si annoncé (802.1)
  std::string src_mac;          // source de la trame
  int ttl = 0;                  // TTL annoncé, en secondes
  double first_seen = 0;
  double last_seen = 0;
  long long frames = 0;
};

/** Décodage d'un identifiant de châssis ou de port, sous-type compris. */
inline std::string lldp_id(const uint8_t* v, size_t n, bool chassis, std::string& kind) {
  if (n < 2) { kind = "?"; return {}; }
  const uint8_t sub = v[0];
  const uint8_t* d = v + 1;
  const size_t len = n - 1;
  auto mac = [&] {
    char t[18];
    if (len < 6) return std::string();
    std::snprintf(t, sizeof t, "%02x:%02x:%02x:%02x:%02x:%02x",
                  d[0], d[1], d[2], d[3], d[4], d[5]);
    return std::string(t);
  };
  auto ip = [&] {
    // Sous-type « adresse réseau » : 1er octet = famille IANA (1 = IPv4).
    if (len >= 5 && d[0] == 1) {
      char t[INET_ADDRSTRLEN] = {0};
      in_addr a{};
      std::memcpy(&a, d + 1, 4);
      ::inet_ntop(AF_INET, &a, t, sizeof t);
      return std::string(t);
    }
    return std::string();
  };
  if (chassis) {
    switch (sub) {
      case 4: kind = "MAC"; return mac();
      case 5: kind = "adresse réseau"; return ip();
      case 6: kind = "nom d’interface"; break;
      case 7: kind = "local"; break;
      default: kind = "châssis"; break;
    }
  } else {
    switch (sub) {
      case 3: kind = "MAC"; return mac();
      case 4: kind = "adresse réseau"; return ip();
      case 5: kind = "nom d’interface"; break;
      case 7: kind = "local"; break;
      default: kind = "port"; break;
    }
  }
  return std::string(reinterpret_cast<const char*>(d), len);
}

/**
 * Capacités système (bitmap 802.1AB), rendues en clair. Le bit 0 est
 * « autre » : décaler la table d'un rang ferait passer un pont pour un point
 * d'accès, ce qui n'aide personne dans une armoire.
 */
inline std::string lldp_caps(uint16_t bits) {
  static const char* noms[] = {"autre", "répéteur", "pont", "point d’accès",
                               "routeur", "téléphone", "câble DOCSIS", "station",
                               "C-VLAN", "S-VLAN", "TPMR"};
  std::string out;
  for (int i = 0; i < 11; ++i) {
    if (bits & (1u << i)) {
      if (!out.empty()) out += ", ";
      out += noms[i];
    }
  }
  return out;
}

/**
 * Trame Ethernet complète → voisin LLDP. `false` si ce n'est pas du LLDP ou si
 * la trame est incohérente : toute longueur douteuse arrête le décodage, une
 * trame malformée ne doit jamais faire lire hors du tampon.
 */
inline bool lldp_decode(const char* iface, const uint8_t* d, size_t n, LldpNeighbor& v) {
  if (n < 14) return false;
  size_t i = 12;
  uint16_t eth = static_cast<uint16_t>((d[i] << 8) | d[i + 1]);
  i += 2;
  if (eth == 0x8100) {                          // étiquette VLAN
    if (n < 18) return false;
    eth = static_cast<uint16_t>((d[i + 2] << 8) | d[i + 3]);
    i += 4;
  }
  if (eth != kEthLldp) return false;

  v = LldpNeighbor{};
  v.iface = iface;
  char mac[18];
  std::snprintf(mac, sizeof mac, "%02x:%02x:%02x:%02x:%02x:%02x",
                d[6], d[7], d[8], d[9], d[10], d[11]);
  v.src_mac = mac;

  while (i + 2 <= n) {
    const uint16_t entete = static_cast<uint16_t>((d[i] << 8) | d[i + 1]);
    const uint8_t type = static_cast<uint8_t>(entete >> 9);
    const size_t len = entete & 0x1FF;
    i += 2;
    if (type == 0) break;                       // fin de LLDPDU
    if (i + len > n) break;                     // trame tronquée
    const uint8_t* val = d + i;
    switch (type) {
      case 1: v.chassis = lldp_id(val, len, true, v.chassis_kind); break;
      case 2: v.port = lldp_id(val, len, false, v.port_kind); break;
      case 3: if (len >= 2) v.ttl = (val[0] << 8) | val[1]; break;
      case 4: v.port_desc.assign(reinterpret_cast<const char*>(val), len); break;
      case 5: v.sys_name.assign(reinterpret_cast<const char*>(val), len); break;
      case 6: v.sys_desc.assign(reinterpret_cast<const char*>(val), len); break;
      case 7:
        if (len >= 4) {
          v.caps = lldp_caps(static_cast<uint16_t>((val[2] << 8) | val[3]));
        }
        break;
      case 8:
        // Adresse d'administration : longueur, sous-type (1 = IPv4), adresse.
        if (len >= 6 && val[0] >= 5 && val[1] == 1) {
          char t[INET_ADDRSTRLEN] = {0};
          in_addr a{};
          std::memcpy(&a, val + 2, 4);
          ::inet_ntop(AF_INET, &a, t, sizeof t);
          v.mgmt_ip = t;
        }
        break;
      case 127:
        // Extensions constructeur : seul le VLAN natif 802.1 est décodé,
        // c'est celui qu'on cherche en armoire.
        if (len >= 6 && val[0] == 0x00 && val[1] == 0x80 && val[2] == 0xC2 && val[3] == 1) {
          v.vlan = std::to_string((val[4] << 8) | val[5]);
        }
        break;
      default: break;
    }
    i += len;
  }
  return !(v.chassis.empty() && v.port.empty());
}

/**
 * Collecteur LLDP : une socket, un fil d'exécution, une table de voisins.
 * Le fil ne fait que recevoir et ranger ; la péremption est appliquée à la
 * lecture, ce qui évite un second fil pour un balayage périodique.
 */
class LldpCollector {
 public:
  explicit LldpCollector(double (*horloge)()) : now_(horloge) {}
  ~LldpCollector() { stop(); }

  /** Ouvre la socket et démarre l'écoute. Retourne le motif en cas d'échec. */
  std::string start() {
    if (fd_ >= 0) return {};
    fd_ = ::socket(AF_PACKET, SOCK_RAW | SOCK_NONBLOCK, htons(kEthLldp));
    if (fd_ < 0) {
      erreur_ = (errno == EPERM || errno == EACCES)
                    ? "capacité CAP_NET_RAW absente : le service ne peut pas "
                      "écouter les trames LLDP"
                    : std::string("socket AF_PACKET impossible : ") + std::strerror(errno);
      return erreur_;
    }
    erreur_.clear();
    stop_ = false;
    fil_ = std::thread([this] { boucle(); });
    return {};
  }

  void stop() {
    stop_ = true;
    if (fil_.joinable()) fil_.join();
    if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
  }

  bool actif() const { return fd_ >= 0; }
  const std::string& erreur() const { return erreur_; }

  void set_timeout(double s) { timeout_ = std::clamp(s, 30.0, 24 * 3600.0); }
  double timeout() const { return timeout_; }

  /** Voisins encore valides, les plus récents d'abord. */
  std::vector<LldpNeighbor> voisins() const {
    std::lock_guard<std::mutex> v(mx_);
    const double t = now_();
    std::vector<LldpNeighbor> out;
    for (const auto& [cle, n] : table_) {
      if (t - n.last_seen <= timeout_) out.push_back(n);
    }
    std::sort(out.begin(), out.end(), [](const LldpNeighbor& a, const LldpNeighbor& b) {
      return a.iface != b.iface ? a.iface < b.iface : a.last_seen > b.last_seen;
    });
    return out;
  }

  /** Purge les voisins périmés (appelée par la boucle de service). */
  void perimer() {
    std::lock_guard<std::mutex> v(mx_);
    const double t = now_();
    for (auto it = table_.begin(); it != table_.end();) {
      it = (t - it->second.last_seen > timeout_) ? table_.erase(it) : std::next(it);
    }
  }

 private:
  void boucle() {
    std::vector<uint8_t> buf(2048);
    while (!stop_) {
      sockaddr_ll de{};
      socklen_t len = sizeof de;
      const ssize_t n = ::recvfrom(fd_, buf.data(), buf.size(), 0,
                                   reinterpret_cast<sockaddr*>(&de), &len);
      if (n <= 0) {
        pollfd p{fd_, POLLIN, 0};
        ::poll(&p, 1, 250);
        continue;
      }
      char nom[IF_NAMESIZE] = {0};
      if (!::if_indextoname(static_cast<unsigned>(de.sll_ifindex), nom)) continue;
      decoder(nom, buf.data(), static_cast<size_t>(n));
    }
  }

  /** Range une trame reçue dans la table des voisins. */
  void decoder(const char* iface, const uint8_t* d, size_t n) {
    LldpNeighbor v;
    if (!lldp_decode(iface, d, n, v)) return;
    const std::string cle = v.iface + '|' + v.chassis + '|' + v.port;
    std::lock_guard<std::mutex> g(mx_);
    const double t = now_();
    auto it = table_.find(cle);
    if (it == table_.end()) {
      v.first_seen = t;
      v.last_seen = t;
      v.frames = 1;
      table_.emplace(cle, std::move(v));
    } else {
      const double premier = it->second.first_seen;
      const long long compte = it->second.frames + 1;
      v.first_seen = premier;
      v.last_seen = t;
      v.frames = compte;
      it->second = std::move(v);
    }
  }

  double (*now_)();
  int fd_ = -1;
  std::string erreur_;
  std::atomic<bool> stop_{true};
  std::thread fil_;
  mutable std::mutex mx_;
  std::map<std::string, LldpNeighbor> table_;
  double timeout_ = 600;        // dix minutes, réglable
};

inline std::string lldp_json(const std::vector<LldpNeighbor>& l, double maintenant) {
  std::ostringstream o;
  o << '[';
  bool first = true;
  for (const LldpNeighbor& n : l) {
    if (!first) o << ',';
    first = false;
    o << "{\"iface\":\"" << jesc(n.iface) << "\",\"chassis\":\"" << jesc(n.chassis)
      << "\",\"chassisKind\":\"" << jesc(n.chassis_kind)
      << "\",\"port\":\"" << jesc(n.port) << "\",\"portKind\":\"" << jesc(n.port_kind)
      << "\",\"portDesc\":\"" << jesc(n.port_desc) << "\",\"sysName\":\"" << jesc(n.sys_name)
      << "\",\"sysDesc\":\"" << jesc(n.sys_desc) << "\",\"mgmtIp\":\"" << jesc(n.mgmt_ip)
      << "\",\"caps\":\"" << jesc(n.caps) << "\",\"vlan\":\"" << jesc(n.vlan)
      << "\",\"srcMac\":\"" << jesc(n.src_mac) << "\",\"ttl\":" << n.ttl
      << ",\"frames\":" << n.frames
      << ",\"ageS\":" << jnum(maintenant - n.last_seen, 1)
      << ",\"seenS\":" << jnum(maintenant - n.first_seen, 1) << '}';
  }
  o << ']';
  return o.str();
}

}  // namespace diagweb
