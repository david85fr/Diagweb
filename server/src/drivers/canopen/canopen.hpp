// Diagweb — pilote CANopen (SocketCAN).
//
// Deux modes par point :
//   TPDO — écoute passive d'une trame déjà émise par le nœud, décodée comme
//          un champ de bits ;
//   SDO  — lecture d'une entrée du dictionnaire d'objets, par requête
//          « initiate upload » expédiée vers 0x600+node-id, réponse attendue
//          sur 0x580+node-id.
//
// Le mode SDO est le SEUL endroit de tout Diagweb où le serveur émet vers un
// équipement ; il est désactivé par défaut (« Écoute seule »), car interroger
// un nœud absent fait réémettre le contrôleur CAN jusqu'au bus-off, ce qui
// dégrade l'interface elle-même. Les transferts segmentés sont hors périmètre :
// une réponse segmentée ne publie rien plutôt qu'une valeur tronquée.
//
// Transport et filtres : common/can_socket.hpp.
#pragma once

#include <cstring>
#include <string>
#include <vector>

#include "../common/can_socket.hpp"

namespace diagweb {

class CanOpenDriver : public CanDriverBase {
 public:
  CanOpenDriver(const LinkConfig& link, IPointSink& sink) : CanDriverBase(link, sink) {
    node_ = static_cast<int>(link_.num("nodeId", 1));
    listen_only_ = link_.flag("listenOnly", true);
    for (const auto& p : link_.points) {
      Key k;
      k.sdo = p.str("mode", "tpdo") == "sdo";
      k.id = parse_hex(p.str("cobId", "0"));
      k.index = parse_hex(p.str("index", "0"));
      k.sub = static_cast<int>(p.num("subIndex", 0));
      keys_.push_back(k);
    }
    due_.assign(link_.points.size(), 0);
  }

 protected:
  std::vector<CanFilter> filters() const override {
    std::vector<CanFilter> f;
    f.reserve(keys_.size());
    for (const Key& k : keys_) {
      CanFilter c;
      c.id = k.sdo ? static_cast<uint32_t>(0x580 + node_) : k.id;
      c.mask = 0x7FFu;
      f.push_back(c);
    }
    return f;
  }

  bool opened(std::string& err) override {
    (void)err;
    pending_ = 0;
    return true;
  }

  void on_frame(uint32_t id, bool ext, const uint8_t* d, size_t len) override {
    if (ext) return;                                   // CANopen est en 11 bits
    for (size_t i = 0; i < keys_.size(); ++i) {
      if (keys_[i].sdo || keys_[i].id != id) continue;
      publish_signal(i, link_.points[i], d, len);
    }
    on_sdo_response(id, d, len);
  }

  bool tick(std::string& err) override {
    (void)err;
    if (!listen_only_) poll_sdo();
    return true;
  }

 private:
  struct Key {
    uint32_t id = 0;      // COB-ID du TPDO écouté
    uint32_t index = 0;   // index d'objet (SDO)
    int sub = 0;          // sous-index (SDO)
    bool sdo = false;     // point lu par SDO plutôt qu'en écoute
  };

  /** Envoie une requête d'upload pour le prochain point SDO échu. */
  void poll_sdo() {
    const double t = net::mono_s();
    if (pending_ && t - sent_ < 0.5) return;           // une transaction à la fois
    pending_ = 0;
    for (size_t i = 0; i < link_.points.size(); ++i) {
      if (!keys_[i].sdo || t < due_[i]) continue;
      due_[i] = next_poll_due(t, sink_.now(), link_.points[i].period_ms / 1000.0);
      uint8_t d[8] = {0x40,                            // « initiate upload »
                      static_cast<uint8_t>(keys_[i].index & 0xFF),
                      static_cast<uint8_t>((keys_[i].index >> 8) & 0xFF),
                      static_cast<uint8_t>(keys_[i].sub), 0, 0, 0, 0};
      if (send_frame(static_cast<uint32_t>(0x600 + node_), d, sizeof d)) {
        pending_ = static_cast<int>(i) + 1;
        sent_ = t;
      }
      return;
    }
  }

  /** Réponse SDO expédiée (0x580 + node-id) : 4 octets de données au plus. */
  void on_sdo_response(uint32_t id, const uint8_t* d, size_t len) {
    if (!pending_ || len < 8) return;
    if (id != static_cast<uint32_t>(0x580 + node_)) return;
    const size_t i = static_cast<size_t>(pending_ - 1);
    const uint32_t index = static_cast<uint32_t>(d[1]) | (static_cast<uint32_t>(d[2]) << 8);
    if (index != keys_[i].index || d[3] != static_cast<uint8_t>(keys_[i].sub)) return;
    pending_ = 0;
    if ((d[0] & 0xE0) == 0x80) return;                 // abandon SDO : valeur non publiée
    if ((d[0] & 0x02) == 0) return;                    // transfert segmenté : hors périmètre
    // Le nombre d'octets non significatifs n'a de sens que si le bit « s »
    // (taille indiquée) est posé ; sinon la réponse porte 4 octets utiles.
    const int nbytes = (d[0] & 0x01) ? 4 - ((d[0] >> 2) & 0x03) : 4;
    uint32_t raw = 0;
    for (int k = 0; k < nbytes; ++k) raw |= static_cast<uint32_t>(d[4 + k]) << (8 * k);

    const PointConfig& p = link_.points[i];
    const std::string type = p.str("type", "u16");
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

  std::vector<Key> keys_;
  std::vector<double> due_;   // prochaine échéance de lecture, par point
  int node_ = 1;
  bool listen_only_ = true;
  int pending_ = 0;           // indice du point interrogé, +1 ; 0 = aucun
  double sent_ = 0;
};

}  // namespace diagweb
