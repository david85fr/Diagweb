// Diagweb — socle Ethernet de niveau 2, pour GOOSE et Sampled Values.
//
// GOOSE et SV ne passent pas par IP : ce sont des trames Ethernet brutes,
// diffusées sur un réseau de poste, avec leur propre EtherType. Il faut donc
// une socket AF_PACKET, un filtre de protocole posé dans le noyau, et la prise
// en compte de l'étiquette VLAN qu'un commutateur de poste ajoute presque
// toujours (priorité 4, réseau dédié).
//
// PRIVILÈGE REQUIS : ouvrir une socket AF_PACKET demande CAP_NET_RAW. Sur le
// contrôleur, cela se donne à l'unité systemd du serveur de diagnostic
// (AmbientCapabilities=CAP_NET_RAW) plutôt qu'en le lançant en root.
//
// Écoute strictement passive : rien n'est jamais émis par ce socle.
#pragma once

#include <cstring>
#include <string>
#include <vector>

#include "../../protocol.hpp"
#include "net.hpp"

#if defined(__linux__) && __has_include(<linux/if_packet.h>) && __has_include(<net/ethernet.h>)
#define DIAGWEB_HAS_AF_PACKET 1
#include <linux/if_packet.h>
#include <net/ethernet.h>
#include <net/if.h>
#include <sys/ioctl.h>
#else
#define DIAGWEB_HAS_AF_PACKET 0
#endif

namespace diagweb {

/** Trame reçue, en-tête Ethernet déjà écarté. */
struct L2Frame {
  uint8_t dst[6] = {0};
  uint8_t src[6] = {0};
  uint16_t vlan_id = 0;      // 0 = trame sans étiquette
  const uint8_t* data = nullptr;
  size_t len = 0;
};

/** Réception de trames Ethernet d'un EtherType donné, sur une interface. */
class L2DriverBase : public IProtocolDriver {
 public:
  L2DriverBase(const LinkConfig& link, IPointSink& sink, uint16_t ethertype)
      : link_(link), sink_(sink), ethertype_(ethertype) {}
  ~L2DriverBase() override { close(); }

  bool implemented() const override { return DIAGWEB_HAS_AF_PACKET != 0; }

  bool open(std::string& err) override {
#if DIAGWEB_HAS_AF_PACKET
    close();
    const std::string iface = link_.str("iface", "eth0");
    // Le filtre d'EtherType est posé dès la création : le noyau écarte tout
    // le reste sans réveiller le processus. Sur un réseau de poste chargé de
    // Sampled Values, c'est la différence entre un serveur qui respire et un
    // serveur qui passe son temps en interruptions.
    fd_ = ::socket(AF_PACKET, SOCK_RAW, htons(ethertype_));
    if (fd_ < 0) {
      err = std::string("socket AF_PACKET impossible : ") + std::strerror(errno) +
            " (la capacité CAP_NET_RAW est-elle accordée au service ?)";
      return false;
    }

    ifreq ifr{};
    std::snprintf(ifr.ifr_name, IFNAMSIZ, "%s", iface.c_str());
    if (::ioctl(fd_, SIOCGIFINDEX, &ifr) < 0) {
      err = "interface « " + iface + " » introuvable";
      close();
      return false;
    }
    sockaddr_ll addr{};
    addr.sll_family = AF_PACKET;
    addr.sll_protocol = htons(ethertype_);
    addr.sll_ifindex = ifr.ifr_ifindex;
    if (::bind(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof addr) < 0) {
      err = "interface « " + iface + " » non disponible (est-elle active ?)";
      close();
      return false;
    }
    if (link_.flag("promisc", false)) {
      packet_mreq mr{};
      mr.mr_ifindex = ifr.ifr_ifindex;
      mr.mr_type = PACKET_MR_PROMISC;
      ::setsockopt(fd_, SOL_PACKET, PACKET_ADD_MEMBERSHIP, &mr, sizeof mr);
    }
    return opened(err);
#else
    (void)err;
    err = "AF_PACKET indisponible sur cette plate-forme";
    return false;
#endif
  }

  void close() override {
#if DIAGWEB_HAS_AF_PACKET
    if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
#endif
  }

  bool service(std::string& err) override {
#if DIAGWEB_HAS_AF_PACKET
    if (fd_ < 0) { err = "lien fermé"; return false; }
    pollfd p{fd_, POLLIN, 0};
    const int r = ::poll(&p, 1, 50);
    if (r < 0) { err = "poll : interface perdue"; return false; }
    if (r > 0 && (p.revents & POLLIN)) {
      uint8_t buf[2048];
      const ssize_t n = ::recv(fd_, buf, sizeof buf, 0);
      if (n > 0) {
        L2Frame f;
        if (parse_ethernet(buf, static_cast<size_t>(n), ethertype_, f)) on_l2(f);
      }
    }
    return tick(err);
#else
    (void)err;
    return false;
#endif
  }

  /**
   * Découpe l'en-tête Ethernet et saute l'étiquette VLAN éventuelle.
   * Exposé — et sans dépendance au noyau — pour être testable directement.
   */
  static bool parse_ethernet(const uint8_t* d, size_t n, uint16_t attendu, L2Frame& out) {
    if (n < 14) return false;
    std::memcpy(out.dst, d, 6);
    std::memcpy(out.src, d + 6, 6);
    size_t off = 12;
    uint16_t type = static_cast<uint16_t>((d[off] << 8) | d[off + 1]);
    off += 2;
    if (type == 0x8100 || type == 0x88A8) {          // étiquette VLAN (ou Q-in-Q)
      if (n < off + 4) return false;
      out.vlan_id = static_cast<uint16_t>(((d[off] << 8) | d[off + 1]) & 0x0FFF);
      type = static_cast<uint16_t>((d[off + 2] << 8) | d[off + 3]);
      off += 4;
    }
    if (type != attendu) return false;
    out.data = d + off;
    out.len = n - off;
    return true;
  }

 protected:
  /** Une trame de l'EtherType attendu, en-tête Ethernet écarté. */
  virtual void on_l2(const L2Frame& f) = 0;
  virtual bool opened(std::string& err) { (void)err; return true; }
  virtual bool tick(std::string& err) { (void)err; return true; }

  /** Adresse MAC « aa:bb:cc:dd:ee:ff » → 6 octets ; false si la forme est fautive. */
  static bool parse_mac(const std::string& s, uint8_t out[6]) {
    int v[6] = {0};
    if (std::sscanf(s.c_str(), "%x:%x:%x:%x:%x:%x", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) != 6) {
      return false;
    }
    for (int i = 0; i < 6; ++i) {
      if (v[i] < 0 || v[i] > 255) return false;
      out[i] = static_cast<uint8_t>(v[i]);
    }
    return true;
  }

  LinkConfig link_;
  IPointSink& sink_;
  uint16_t ethertype_;
  int fd_ = -1;
};

}  // namespace diagweb
