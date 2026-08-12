// Diagweb — pilotes CAN : trames brutes, J1939 et CANopen (SocketCAN, Linux).
//
// Écoute passive d'une interface CAN du contrôleur : le serveur n'émet rien,
// sauf en mode « lecture SDO » de CANopen où il envoie la requête d'upload
// prévue par la norme. Un point est un champ de bits extrait d'une trame,
// décrit comme dans une base de signaux (bit de départ, longueur, ordre des
// octets, signe, gain, décalage).
//
// L'interface doit exister et être active (`ip link set can0 up type can
// bitrate 250000`) : le serveur ne configure pas le débit du bus.
#pragma once

#include <string>
#include <vector>

#include "../protocol.hpp"
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

/** Mode de décodage appliqué aux trames reçues. */
enum class CanMode { Raw, J1939, CanOpen };

class CanDriver : public IProtocolDriver {
 public:
  CanDriver(const LinkConfig& link, IPointSink& sink, CanMode mode)
      : link_(link), sink_(sink), mode_(mode) {
    // Identifiants analysés une fois pour toutes : la boucle de réception ne
    // doit pas refaire une analyse de chaîne par point et par trame.
    for (const auto& p : link_.points) {
      Key k;
      k.pgn = static_cast<uint32_t>(p.num("pgn", 0));
      k.sa = static_cast<int>(p.num("sa", -1));
      k.ext = p.flag("ext", false);
      k.sdo = p.str("mode", "tpdo") == "sdo";
      k.id = parse_hex(mode_ == CanMode::CanOpen ? p.str("cobId", "0") : p.str("canId", "0"));
      k.index = parse_hex(p.str("index", "0"));
      keys_.push_back(k);
    }
  }

  ~CanDriver() override { close(); }

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
    const std::vector<can_filter> filters = build_filters();
    if (!filters.empty() && filters.size() <= 64) {
      ::setsockopt(fd_, SOL_CAN_RAW, CAN_RAW_FILTER, filters.data(),
                   static_cast<socklen_t>(filters.size() * sizeof(can_filter)));
    }
    // Trames d'erreur : indispensables pour détecter un bus-off avant d'avoir
    // dégradé l'interface à force de réémissions (cas d'un nœud SDO absent).
    const can_err_mask_t errmask = CAN_ERR_TX_TIMEOUT | CAN_ERR_BUSOFF | CAN_ERR_CRTL;
    ::setsockopt(fd_, SOL_CAN_RAW, CAN_RAW_ERR_FILTER, &errmask, sizeof errmask);
    if (mode_ == CanMode::CanOpen) sdo_pending_ = 0;
    return true;
#else
    (void)err;
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
      on_frame(f);
    }
    if (mode_ == CanMode::CanOpen && !link_.flag("listenOnly", true)) poll_sdo();
    return true;
#else
    (void)err;
    return false;
#endif
  }

 private:
#if DIAGWEB_HAS_SOCKETCAN
  void on_frame(const canfd_frame& f) {
    const bool ext = (f.can_id & CAN_EFF_FLAG) != 0;
    const uint32_t id = f.can_id & (ext ? CAN_EFF_MASK : CAN_SFF_MASK);
    const uint8_t* d = f.data;
    const size_t len = f.len;

    for (size_t i = 0; i < link_.points.size(); ++i) {
      if (!matches(i, id, ext)) continue;
      publish_signal(i, link_.points[i], d, len);
    }
    if (mode_ == CanMode::CanOpen) on_sdo_response(id, d, len);
  }

  /** Jeu de filtres noyau déduit des points configurés. */
  std::vector<can_filter> build_filters() const {
    std::vector<can_filter> f;
    const int node = static_cast<int>(link_.num("nodeId", 1));
    for (const Key& k : keys_) {
      can_filter c{};
      switch (mode_) {
        case CanMode::Raw:
          c.can_id = k.id | (k.ext ? CAN_EFF_FLAG : 0u);
          c.can_mask = (k.ext ? CAN_EFF_MASK : CAN_SFF_MASK) | CAN_EFF_FLAG;
          break;
        case CanMode::J1939: {
          // On filtre sur le PGN, jamais sur l'adresse source (elle change à
          // la re-revendication) ; en PDU1 l'octet PS est une destination.
          const bool pdu2 = ((k.pgn >> 8) & 0xFF) >= 240;
          c.can_id = (k.pgn << 8) | CAN_EFF_FLAG;
          c.can_mask = (pdu2 ? 0x03FFFF00u : 0x03FF0000u) | CAN_EFF_FLAG;
          break;
        }
        case CanMode::CanOpen:
          if (k.sdo) { c.can_id = static_cast<uint32_t>(0x580 + node); c.can_mask = CAN_SFF_MASK; }
          else { c.can_id = k.id; c.can_mask = CAN_SFF_MASK; }
          break;
      }
      f.push_back(c);
    }
    return f;
  }

  bool matches(size_t i, uint32_t id, bool ext) const {
    const Key& k = keys_[i];
    switch (mode_) {
      case CanMode::Raw:
        return k.id == id && k.ext == ext;
      case CanMode::J1939: {
        if (!ext) return false;
        if (j1939_pgn(id) != k.pgn) return false;
        const int link_sa = static_cast<int>(link_.num("sa", -1));
        const int sa = static_cast<int>(j1939_sa(id));
        if (k.sa >= 0 && sa != k.sa) return false;
        if (link_sa >= 0 && sa != link_sa) return false;
        return true;
      }
      case CanMode::CanOpen:
        return !k.sdo && k.id == id;
    }
    return false;
  }

  void publish_signal(size_t idx, const PointConfig& p, const uint8_t* d, size_t len) {
    const double v = extract_signal(d, len,
                                    static_cast<int>(p.num("startBit", 0)),
                                    static_cast<int>(p.num("bitLen", 16)),
                                    p.str("order", "intel") == "motorola",
                                    p.flag("signed", false),
                                    p.num("gain", 1), p.num("offset", 0));
    sink_.publish(idx, v);
  }

  // -------------------------------------------------------- CANopen SDO
  /** Envoie une requête d'upload pour le prochain point SDO échu. */
  void poll_sdo() {
    const double t = net::mono_s();
    if (sdo_pending_ && t - sdo_sent_ < 0.5) return;     // une transaction à la fois
    sdo_pending_ = 0;
    for (size_t i = 0; i < link_.points.size(); ++i) {
      const PointConfig& p = link_.points[i];
      if (!keys_[i].sdo) continue;
      const size_t slot = i;
      if (due_.size() <= slot) due_.resize(link_.points.size(), 0);
      if (t < due_[slot]) continue;
      due_[slot] = t + p.period_ms / 1000.0;
      const int node = static_cast<int>(link_.num("nodeId", 1));
      const uint32_t idx16 = keys_[i].index;
      const int sub = static_cast<int>(p.num("subIndex", 0));
      can_frame f{};
      f.can_id = static_cast<canid_t>(0x600 + node);
      f.can_dlc = 8;
      f.data[0] = 0x40;                                   // « initiate upload »
      f.data[1] = static_cast<uint8_t>(idx16 & 0xFF);
      f.data[2] = static_cast<uint8_t>((idx16 >> 8) & 0xFF);
      f.data[3] = static_cast<uint8_t>(sub);
      if (::write(fd_, &f, sizeof f) == static_cast<ssize_t>(sizeof f)) {
        sdo_pending_ = static_cast<int>(i) + 1;
        sdo_idx_ = idx16;
        sdo_sub_ = sub;
        sdo_sent_ = t;
      }
      return;
    }
  }

  /** Réponse SDO expédiée (0x580 + node-id) : 4 octets de données au plus. */
  void on_sdo_response(uint32_t id, const uint8_t* d, size_t len) {
    if (!sdo_pending_ || len < 8) return;
    const int node = static_cast<int>(link_.num("nodeId", 1));
    if (id != static_cast<uint32_t>(0x580 + node)) return;
    const uint32_t idx16 = static_cast<uint32_t>(d[1]) | (static_cast<uint32_t>(d[2]) << 8);
    if (idx16 != sdo_idx_ || d[3] != sdo_sub_) return;
    const size_t i = static_cast<size_t>(sdo_pending_ - 1);
    sdo_pending_ = 0;
    if ((d[0] & 0xE0) == 0x80) return;                    // abandon SDO : valeur non publiée
    if ((d[0] & 0x02) == 0) return;                       // transfert segmenté : hors périmètre
    // Le nombre d'octets non significatifs n'a de sens que si le bit « s »
    // (taille indiquée) est posé ; sinon la réponse porte 4 octets utiles.
    const int nbytes = (d[0] & 0x01) ? 4 - ((d[0] >> 2) & 0x03) : 4;
    const PointConfig& p = link_.points[i];
    const std::string type = p.str("type", "u16");
    uint32_t raw = 0;
    for (int k = 0; k < nbytes; ++k) raw |= static_cast<uint32_t>(d[4 + k]) << (8 * k);
    double v = 0;
    if (type == "f32") { float x; std::memcpy(&x, &raw, 4); v = x; }
    else if (type == "i8")  v = static_cast<int8_t>(raw & 0xFF);
    else if (type == "u8")  v = raw & 0xFF;
    else if (type == "i16") v = static_cast<int16_t>(raw & 0xFFFF);
    else if (type == "u16") v = raw & 0xFFFF;
    else if (type == "i32") v = static_cast<int32_t>(raw);
    else v = raw;
    sink_.publish(i, v * p.num("gain", 1) + p.num("offset", 0));
  }
#endif  // DIAGWEB_HAS_SOCKETCAN

  static uint32_t parse_hex(const std::string& s) {
    if (s.empty()) return 0;
    try {
      return static_cast<uint32_t>(std::stoul(s, nullptr, s.compare(0, 2, "0x") == 0 ||
                                                          s.compare(0, 2, "0X") == 0 ? 16 : 0));
    } catch (...) {
      return 0;
    }
  }

  /** Ce qu'un point cherche dans les trames, précalculé au démarrage. */
  struct Key {
    uint32_t id = 0;       // identifiant CAN (brut) ou COB-ID (CANopen)
    uint32_t pgn = 0;      // J1939
    uint32_t index = 0;    // index d'objet (SDO)
    int sa = -1;           // adresse source attendue (J1939)
    bool ext = false;      // identifiant 29 bits
    bool sdo = false;      // point lu par SDO plutôt qu'en écoute
  };

  LinkConfig link_;
  IPointSink& sink_;
  CanMode mode_;
  std::vector<Key> keys_;
  int fd_ = -1;
  int sdo_pending_ = 0;
  uint32_t sdo_idx_ = 0;
  int sdo_sub_ = 0;
  double sdo_sent_ = 0;
  std::vector<double> due_;
};

}  // namespace diagweb
