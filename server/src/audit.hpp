// Diagweb — audit des communications du processus avec l'extérieur.
//
// À quoi cela sert : un architecte réseau ou un auditeur sécurité doit pouvoir
// répondre, sans lire le code ni brancher un analyseur, à trois questions —
// qu'est-ce qui entre, qu'est-ce qui sort, et qui peut écrire quoi.
//
// DEUX VUES, ET C'EST VOULU.
//
//   OBSERVÉ  — les sockets que le processus a RÉELLEMENT ouvertes, lues dans
//              /proc : on part de /proc/self/fd (les descripteurs qui nous
//              appartiennent), on en tire les numéros d'inœud, et on ne garde
//              dans /proc/self/net/{tcp,tcp6,udp,udp6,packet} que ces
//              inœuds-là. Le résultat ne dépend d'aucune déclaration : c'est
//              l'état du noyau. Une socket ouverte par mégarde apparaîtrait
//              ici, et c'est exactement ce qu'un audit doit voir.
//
//   DÉCLARÉ  — ce que la configuration prévoit : chaque lien réseau, son
//              protocole, sa cible, son sens, sa sécurité. Une socket peut
//              être fermée à l'instant du relevé (lien en défaut, période
//              longue) sans que le lien cesse d'exister.
//
// Un écart entre les deux vues est une information, pas un défaut du rapport.
#pragma once

#include <charconv>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include <arpa/inet.h>
#include <netinet/in.h>

#include "json.hpp"
#include "netif.hpp"

namespace diagweb {
namespace audit {

namespace fs = std::filesystem;

struct Socket {
  std::string proto;      // tcp, tcp6, udp, udp6, paquet (AF_PACKET)
  std::string local;      // adresse:port, ou l'interface pour AF_PACKET
  std::string remote;     // vide si en écoute
  std::string state;      // ecoute, etabli, …
  std::string iface;      // AF_PACKET : interface écoutée
  unsigned long inode = 0;
};

/** Inœuds des sockets détenues par CE processus (via /proc/self/fd). */
inline std::set<unsigned long> own_socket_inodes() {
  std::set<unsigned long> out;
  std::error_code ec;
  for (const auto& e : fs::directory_iterator("/proc/self/fd", ec)) {
    const fs::path cible = fs::read_symlink(e.path(), ec);
    if (ec) { ec.clear(); continue; }
    const std::string s = cible.string();          // « socket:[12345] »
    if (s.rfind("socket:[", 0) != 0 || s.back() != ']') continue;
    const std::string num = s.substr(8, s.size() - 9);
    unsigned long v = 0;
    const auto* d = num.data();
    if (std::from_chars(d, d + num.size(), v).ec == std::errc()) out.insert(v);
  }
  return out;
}

/** « 0100007F:1F90 » → « 127.0.0.1:8080 » (hexadécimal, ordre du noyau). */
inline std::string decode_endpoint(const std::string& champ, bool v6) {
  const size_t sep = champ.find(':');
  if (sep == std::string::npos) return champ;
  const std::string hex = champ.substr(0, sep);
  const std::string hport = champ.substr(sep + 1);
  unsigned port = 0;
  std::from_chars(hport.data(), hport.data() + hport.size(), port, 16);

  auto quartet = [&](size_t i) -> unsigned {
    unsigned v = 0;
    std::from_chars(hex.data() + i, hex.data() + i + 8, v, 16);
    return v;
  };
  char texte[INET6_ADDRSTRLEN] = {0};
  if (!v6 && hex.size() == 8) {
    in_addr a{};
    a.s_addr = htonl(quartet(0));
    // Le noyau écrit l'adresse en hôte-boutiste : après htonl, l'octet de
    // poids fort du texte hexadécimal se retrouve à sa place… inversée. Un
    // byteswap final remet l'adresse dans l'ordre attendu.
    a.s_addr = __builtin_bswap32(a.s_addr);
    ::inet_ntop(AF_INET, &a, texte, sizeof texte);
  } else if (v6 && hex.size() == 32) {
    in6_addr a{};
    for (int m = 0; m < 4; ++m) {
      const unsigned v = quartet(static_cast<size_t>(m) * 8);
      a.s6_addr32[m] = __builtin_bswap32(htonl(v));
    }
    ::inet_ntop(AF_INET6, &a, texte, sizeof texte);
  } else {
    return champ;
  }
  return std::string(texte) + ':' + std::to_string(port);
}

inline const char* tcp_state(unsigned st) {
  switch (st) {
    case 0x01: return "établi";
    case 0x02: return "connexion en cours";
    case 0x03: return "connexion reçue";
    case 0x06: return "attente de fermeture";
    case 0x07: return "fermée";
    case 0x0A: return "en écoute";
    default:   return "autre";
  }
}

/** Une table /proc/self/net/{tcp,udp,…}, filtrée sur nos propres inœuds. */
inline void read_table(const char* fichier, const char* proto, bool v6,
                       const std::set<unsigned long>& miens,
                       std::vector<Socket>& out) {
  std::ifstream f(std::string("/proc/self/net/") + fichier);
  if (!f) return;
  std::string ligne;
  std::getline(f, ligne);                       // en-tête
  while (std::getline(f, ligne)) {
    std::istringstream ls(ligne);
    std::string sl, local, distant, st, queues, tr, retr, uid, timeout, inode;
    ls >> sl >> local >> distant >> st >> queues >> tr >> retr >> uid >> timeout >> inode;
    if (inode.empty()) continue;
    unsigned long ino = 0;
    std::from_chars(inode.data(), inode.data() + inode.size(), ino);
    if (!miens.count(ino)) continue;
    unsigned code = 0;
    std::from_chars(st.data(), st.data() + st.size(), code, 16);
    Socket s;
    s.proto = proto;
    s.local = decode_endpoint(local, v6);
    s.remote = decode_endpoint(distant, v6);
    s.state = (std::string(proto).rfind("udp", 0) == 0)
                  ? (s.remote.ends_with(":0") ? "ouverte" : "connectée")
                  : tcp_state(code);
    if (s.remote.ends_with(":0")) s.remote.clear();
    s.inode = ino;
    out.push_back(std::move(s));
  }
}

/** Sockets de niveau 2 (AF_PACKET) : GOOSE, Sampled Values, LLDP, capture. */
inline void read_packet(const std::set<unsigned long>& miens, std::vector<Socket>& out) {
  std::ifstream f("/proc/self/net/packet");
  if (!f) return;
  const auto ifs = netif::list();
  std::string ligne;
  std::getline(f, ligne);
  while (std::getline(f, ligne)) {
    std::istringstream ls(ligne);
    std::string sk, refcnt, type, proto, iface, r, rmem, user, inode;
    ls >> sk >> refcnt >> type >> proto >> iface >> r >> rmem >> user >> inode;
    if (inode.empty()) continue;
    unsigned long ino = 0;
    std::from_chars(inode.data(), inode.data() + inode.size(), ino);
    if (!miens.count(ino)) continue;
    unsigned idx = 0, eth = 0;
    std::from_chars(iface.data(), iface.data() + iface.size(), idx);
    std::from_chars(proto.data(), proto.data() + proto.size(), eth, 16);
    Socket s;
    s.proto = "paquet";
    s.inode = ino;
    s.iface = "(toutes)";
    if (idx) {
      char nom[IF_NAMESIZE] = {0};
      if (::if_indextoname(idx, nom)) s.iface = nom;
    }
    std::ostringstream l;
    l << s.iface << " · EtherType 0x" << std::hex << eth;
    s.local = l.str();
    s.state = "à l'écoute";
    out.push_back(std::move(s));
  }
}

/** Toutes les sockets du processus, telles que le noyau les voit. */
inline std::vector<Socket> sockets() {
  const auto miens = own_socket_inodes();
  std::vector<Socket> out;
  read_table("tcp", "tcp", false, miens, out);
  read_table("tcp6", "tcp6", true, miens, out);
  read_table("udp", "udp", false, miens, out);
  read_table("udp6", "udp6", true, miens, out);
  read_packet(miens, out);
  return out;
}

/**
 * Sens d'une socket. « Entrante » = nous écoutons, ou nous avons ACCEPTÉ une
 * connexion sur un port où nous écoutons ; « sortante » = nous avons composé.
 * Le port local est le seul discriminant fiable : une connexion acceptée a un
 * pair renseigné exactement comme une connexion sortante.
 */
inline std::string port_of(const std::string& endpoint) {
  const size_t c = endpoint.rfind(':');
  return c == std::string::npos ? std::string() : endpoint.substr(c + 1);
}

inline std::string direction_of(const Socket& s, const std::set<std::string>& ecoutes) {
  if (s.proto == "paquet") return "entrante";
  if (s.remote.empty()) return "entrante";
  return ecoutes.count(port_of(s.local)) ? "entrante" : "sortante";
}

inline std::string sockets_json(const std::vector<Socket>& l) {
  // Ports sur lesquels nous écoutons : ils désignent les connexions acceptées.
  std::set<std::string> ecoutes;
  for (const Socket& s : l) {
    if (s.remote.empty() && s.proto != "paquet") ecoutes.insert(port_of(s.local));
  }
  std::ostringstream o;
  o << '[';
  bool first = true;
  for (const Socket& s : l) {
    if (!first) o << ',';
    first = false;
    o << "{\"proto\":\"" << jesc(s.proto) << "\",\"local\":\"" << jesc(s.local)
      << "\",\"remote\":\"" << jesc(s.remote) << "\",\"state\":\"" << jesc(s.state)
      << "\",\"iface\":\"" << jesc(s.iface) << "\",\"inode\":" << s.inode
      << ",\"direction\":\"" << direction_of(s, ecoutes) << "\"}";
  }
  o << ']';
  return o.str();
}

}  // namespace audit
}  // namespace diagweb
