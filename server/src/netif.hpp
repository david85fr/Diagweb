// Diagweb — inventaire des interfaces réseau du contrôleur.
//
// Linux assumé, sans détour : /sys/class/net donne tout ce qui nous intéresse
// (type de lien, état, MTU, adresse matérielle) et getifaddrs les adresses IP.
// Une interface CAN se reconnaît à son type ARPHRD_CAN (280) — c'est ce qui
// sépare, pour la capture comme pour LLDP, un bus de terrain d'un réseau
// Ethernet.
#pragma once

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/types.h>

#include <algorithm>
#include <charconv>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "json.hpp"

namespace diagweb {
namespace netif {

namespace fs = std::filesystem;

/** ARPHRD_CAN : le type de lien des interfaces SocketCAN. */
inline constexpr int kArphrdCan = 280;
inline constexpr int kArphrdLoopback = 772;

struct Interface {
  std::string name;
  std::string mac;
  std::string oper;            // up, down, unknown…
  std::string kind;            // ethernet, can, boucle, autre
  int type = 0;                // ARPHRD_*
  int mtu = 0;
  bool up = false;
  std::vector<std::string> ips;
};

/** Première ligne d'un fichier de /sys, sans le saut de ligne. */
inline std::string read_line(const fs::path& p) {
  std::ifstream f(p);
  std::string s;
  if (f) std::getline(f, s);
  while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
  return s;
}

inline int read_int(const fs::path& p, int defaut = 0) {
  const std::string s = read_line(p);
  if (s.empty()) return defaut;
  int v = defaut;
  std::istringstream(s) >> v;
  return v;
}

/** Entier hexadécimal d'un fichier /sys (« 0x1003 »), 0 si illisible. */
inline unsigned long read_hex(const fs::path& p) {
  std::string s = read_line(p);
  if (s.rfind("0x", 0) == 0 || s.rfind("0X", 0) == 0) s.erase(0, 2);
  unsigned long v = 0;
  const auto* d = s.data();
  const auto res = std::from_chars(d, d + s.size(), v, 16);
  return (res.ec == std::errc() && res.ptr == d + s.size()) ? v : 0;
}

/** Adresses IP par interface (v4 et v6), lues une fois pour toutes. */
inline void fill_addresses(std::vector<Interface>& out) {
  ifaddrs* liste = nullptr;
  if (::getifaddrs(&liste) != 0) return;
  for (ifaddrs* a = liste; a; a = a->ifa_next) {
    if (!a->ifa_addr || !a->ifa_name) continue;
    char texte[INET6_ADDRSTRLEN] = {0};
    if (a->ifa_addr->sa_family == AF_INET) {
      const auto* s = reinterpret_cast<const sockaddr_in*>(a->ifa_addr);
      ::inet_ntop(AF_INET, &s->sin_addr, texte, sizeof texte);
    } else if (a->ifa_addr->sa_family == AF_INET6) {
      const auto* s = reinterpret_cast<const sockaddr_in6*>(a->ifa_addr);
      ::inet_ntop(AF_INET6, &s->sin6_addr, texte, sizeof texte);
    } else {
      continue;
    }
    const std::string nom = a->ifa_name;
    for (Interface& i : out) {
      if (i.name == nom && texte[0]) i.ips.push_back(texte);
    }
  }
  ::freeifaddrs(liste);
}

inline const char* kind_of(int type) {
  switch (type) {
    case kArphrdCan:      return "can";
    case kArphrdLoopback: return "boucle";
    case 1:               return "ethernet";      // ARPHRD_ETHER
    default:              return "autre";
  }
}

/** Toutes les interfaces du système, triées par nom. */
inline std::vector<Interface> list() {
  std::vector<Interface> out;
  std::error_code ec;
  const fs::path base = "/sys/class/net";
  if (!fs::exists(base, ec)) return out;
  for (const auto& e : fs::directory_iterator(base, ec)) {
    Interface i;
    i.name = e.path().filename().string();
    i.type = read_int(e.path() / "type");
    i.kind = kind_of(i.type);
    i.mtu = read_int(e.path() / "mtu");
    i.mac = read_line(e.path() / "address");
    i.oper = read_line(e.path() / "operstate");
    // « up » au sens du drapeau IFF_UP, distinct de l'état du lien : une
    // interface administrativement montée peut n'avoir aucun câble. Le fichier
    // contient un hexadécimal préfixé (« 0x1003 ») ; la conversion est bornée
    // et sans exception — c'est une entrée du système, pas une constante.
    i.up = (read_hex(e.path() / "flags") & IFF_UP) != 0;
    out.push_back(std::move(i));
  }
  fill_addresses(out);
  std::sort(out.begin(), out.end(),
            [](const Interface& a, const Interface& b) { return a.name < b.name; });
  return out;
}

inline std::string to_json(const std::vector<Interface>& l) {
  std::ostringstream o;
  o << '[';
  bool first = true;
  for (const Interface& i : l) {
    if (!first) o << ',';
    first = false;
    o << "{\"name\":\"" << jesc(i.name) << "\",\"kind\":\"" << jesc(i.kind)
      << "\",\"mac\":\"" << jesc(i.mac) << "\",\"oper\":\"" << jesc(i.oper)
      << "\",\"mtu\":" << i.mtu << ",\"up\":" << (i.up ? "true" : "false")
      << ",\"ips\":[";
    bool f2 = true;
    for (const std::string& ip : i.ips) {
      if (!f2) o << ',';
      f2 = false;
      o << '"' << jesc(ip) << '"';
    }
    o << "]}";
  }
  o << ']';
  return o.str();
}

}  // namespace netif
}  // namespace diagweb
