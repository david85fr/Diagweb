// Diagweb — socle SocketCAN commun aux pilotes CAN brut, J1939 et CANopen.
//
// Les trois protocoles partagent exactement le même transport (une interface
// CAN du contrôleur, ouverte en écoute) et ne diffèrent que par deux choses :
// les filtres à poser dans le noyau, et la façon de reconnaître puis décoder
// une trame. Cette classe tient le transport ; chaque protocole n'écrit que
// sa part, dans son propre dossier.
//
// L'interface doit exister et être active (`ip link set can0 up type can
// bitrate 250000`) : le serveur ne configure pas le débit du bus.
#pragma once

#include <cstring>
#include <string>
#include <vector>

#include "../../protocol.hpp"
#include "net.hpp"

#if defined(__linux__) && __has_include(<linux/can.h>) && __has_include(<linux/can/raw.h>) && \
    __has_include(<linux/can/error.h>)
#define DIAGWEB_HAS_SOCKETCAN 1
#include <linux/can.h>
#include <linux/can/error.h>
#include <linux/can/raw.h>
#include <net/if.h>
#include <sys/ioctl.h>
// Les noyaux récents remplacent can_dlc par une union { len ; can_dlc } : les
// deux champs occupent le même octet. On lit `len`, valable dans les deux cas —
// ces contrôles figent l'hypothèse de disposition.
static_assert(sizeof(struct can_frame) == 16, "disposition inattendue de can_frame");
static_assert(sizeof(struct canfd_frame) == 72, "disposition inattendue de canfd_frame");
#else
#define DIAGWEB_HAS_SOCKETCAN 0
#endif

namespace diagweb {

/**
 * Filtre exprimé sans type noyau, pour que chaque pilote puisse décrire ce
 * qu'il veut recevoir même là où SocketCAN n'existe pas (compilation sur poste
 * de développement). La traduction en `can_filter` a lieu dans `open()`.
 */
struct CanFilter {
  uint32_t id = 0;     // identifiant attendu, sans indicateur de format
  uint32_t mask = 0;   // bits significatifs de l'identifiant
  bool ext = false;    // n'accepter que les trames à identifiant 29 bits
};

/** Transport CAN : ouverture, filtres, réception, erreurs de bus. */
class CanDriverBase : public IProtocolDriver {
 public:
  CanDriverBase(const LinkConfig& link, IPointSink& sink) : link_(link), sink_(sink) {}
  ~CanDriverBase() override { close(); }

  bool implemented() const override { return DIAGWEB_HAS_SOCKETCAN != 0; }

  bool open(std::string& err) override {
#if DIAGWEB_HAS_SOCKETCAN
    close();
    const std::string iface = link_.str("iface", "can0");
    fd_ = ::socket(PF_CAN, SOCK_RAW, CAN_RAW);
    if (fd_ < 0) { err = "socket CAN impossible : " + std::string(std::strerror(errno)); return false; }

    ifreq ifr{};
    std::snprintf(ifr.ifr_name, IFNAMSIZ, "%s", iface.c_str());
    if (::ioctl(fd_, SIOCGIFINDEX, &ifr) < 0) {
      err = "interface « " + iface + " » introuvable";
      close();
      return false;
    }
    sockaddr_can addr{};
    addr.can_family = AF_CAN;
    addr.can_ifindex = ifr.ifr_ifindex;
    if (::bind(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof addr) < 0) {
      err = "interface « " + iface + " » non disponible (est-elle active ?)";
      close();
      return false;
    }
    if (link_.flag("fd", false)) {
      int on = 1;
      ::setsockopt(fd_, SOL_CAN_RAW, CAN_RAW_FD_FRAMES, &on, sizeof on);
    }
    // Filtres noyau : sans eux, chaque trame du bus réveille le processus —
    // à 500 kbit/s cela fait des milliers de réveils par seconde sur un
    // contrôleur qui exécute aussi le temps réel.
    const std::vector<CanFilter> wanted = filters();
    if (!wanted.empty() && wanted.size() <= 64) {
      std::vector<can_filter> kf;
      kf.reserve(wanted.size());
      for (const CanFilter& f : wanted) {
        can_filter c{};
        c.can_id = f.id | (f.ext ? CAN_EFF_FLAG : 0u);
        c.can_mask = f.mask | CAN_EFF_FLAG;   // le format fait partie du filtre
        kf.push_back(c);
      }
      ::setsockopt(fd_, SOL_CAN_RAW, CAN_RAW_FILTER, kf.data(),
                   static_cast<socklen_t>(kf.size() * sizeof(can_filter)));
    }
    // Trames d'erreur : indispensables pour détecter un bus-off avant d'avoir
    // dégradé l'interface à force de réémissions (cas d'un nœud SDO absent).
    const can_err_mask_t errmask = CAN_ERR_TX_TIMEOUT | CAN_ERR_BUSOFF | CAN_ERR_CRTL;
    ::setsockopt(fd_, SOL_CAN_RAW, CAN_RAW_ERR_FILTER, &errmask, sizeof errmask);
    return opened(err);
#else
    err = "SocketCAN indisponible sur cette plate-forme";
    return false;
#endif
  }

  void close() override {
#if DIAGWEB_HAS_SOCKETCAN
    if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
#endif
  }

  bool service(std::string& err) override {
#if DIAGWEB_HAS_SOCKETCAN
    if (fd_ < 0) { err = "lien fermé"; return false; }
    pollfd p{fd_, POLLIN, 0};
    const int r = ::poll(&p, 1, 50);
    if (r < 0) { err = "poll : interface perdue"; return false; }
    if (r > 0 && (p.revents & POLLIN)) {
      canfd_frame f{};
      const ssize_t n = ::read(fd_, &f, sizeof f);
      if (n < static_cast<ssize_t>(sizeof(can_frame))) return true;   // trame partielle : ignorée
      if (f.can_id & CAN_ERR_FLAG) {
        if (f.can_id & CAN_ERR_BUSOFF) {
          err = "bus-off : interface CAN sortie du bus (câblage, débit ou nœud absent)";
          return false;                       // socket refaite après temporisation
        }
        return true;                          // erreur passagère : signalée par le noyau
      }
      const bool ext = (f.can_id & CAN_EFF_FLAG) != 0;
      on_frame(f.can_id & (ext ? CAN_EFF_MASK : CAN_SFF_MASK), ext, f.data, f.len);
    }
    return tick(err);
#else
    (void)err;
    return false;
#endif
  }

 protected:
  /** Ce que ce protocole veut recevoir. Appelé une fois par ouverture. */
  virtual std::vector<CanFilter> filters() const = 0;

  /** Une trame de données reçue, identifiant déjà démasqué. */
  virtual void on_frame(uint32_t id, bool ext, const uint8_t* data, size_t len) = 0;

  /** Fin d'ouverture propre au protocole (remise à zéro d'un état). */
  virtual bool opened(std::string& err) { (void)err; return true; }

  /** Travail périodique du protocole (seul CANopen en a : la requête SDO). */
  virtual bool tick(std::string& err) { (void)err; return true; }

  /** Émission d'une trame de 8 octets — le seul cas est la requête SDO. */
  bool send_frame(uint32_t id, const uint8_t* data, size_t len) {
#if DIAGWEB_HAS_SOCKETCAN
    if (fd_ < 0 || len > 8) return false;
    can_frame f{};
    f.can_id = static_cast<canid_t>(id);
    f.can_dlc = static_cast<uint8_t>(len);
    std::memcpy(f.data, data, len);
    return ::write(fd_, &f, sizeof f) == static_cast<ssize_t>(sizeof f);
#else
    (void)id; (void)data; (void)len;
    return false;
#endif
  }

  /** Décodage puis publication d'un champ de bits d'une trame. */
  void publish_signal(size_t idx, const PointConfig& p, const uint8_t* d, size_t len) {
    sink_.publish(idx, extract_signal(d, len,
                                      static_cast<int>(p.num("startBit", 0)),
                                      static_cast<int>(p.num("bitLen", 16)),
                                      p.str("order", "intel") == "motorola",
                                      p.flag("signed", false),
                                      p.num("gain", 1), p.num("offset", 0)));
  }

  /** Identifiant hexadécimal d'une configuration ; 0 si la saisie est fautive. */
  static uint32_t parse_hex(const std::string& s) {
    if (s.empty()) return 0;
    try {
      return static_cast<uint32_t>(std::stoul(s, nullptr, s.compare(0, 2, "0x") == 0 ||
                                                          s.compare(0, 2, "0X") == 0 ? 16 : 0));
    } catch (...) {
      return 0;
    }
  }

  LinkConfig link_;
  IPointSink& sink_;
  int fd_ = -1;
};

}  // namespace diagweb
