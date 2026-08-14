// Diagweb — pilote CAN « trames brutes » (SocketCAN, lecture seule).
//
// Écoute strictement passive : un point est un champ de bits extrait d'une
// trame d'identifiant donné, décrit comme dans une base de signaux (bit de
// départ, longueur, ordre des octets, signe, gain, décalage). Le serveur
// n'émet jamais dans ce mode.
//
// Transport et filtres : common/can_socket.hpp.
#pragma once

#include <string>
#include <vector>

#include "../common/can_socket.hpp"

namespace diagweb {

class CanRawDriver : public CanDriverBase {
 public:
  CanRawDriver(const LinkConfig& link, IPointSink& sink) : CanDriverBase(link, sink) {
    // Identifiants analysés une fois pour toutes : la boucle de réception ne
    // doit pas refaire une analyse de chaîne par point et par trame.
    for (const auto& p : link_.points) {
      Key k;
      k.id = parse_hex(p.str("canId", "0"));
      k.ext = p.flag("ext", false);
      keys_.push_back(k);
    }
  }

 protected:
  std::vector<CanFilter> filters() const override {
    std::vector<CanFilter> f;
    f.reserve(keys_.size());
    for (const Key& k : keys_) {
      CanFilter c;
      c.id = k.id;
      c.mask = k.ext ? 0x1FFFFFFFu : 0x7FFu;
      c.ext = k.ext;
      f.push_back(c);
    }
    return f;
  }

  void on_frame(uint32_t id, bool ext, const uint8_t* d, size_t len) override {
    for (size_t i = 0; i < keys_.size(); ++i) {
      if (keys_[i].id != id || keys_[i].ext != ext) continue;
      publish_signal(i, link_.points[i], d, len);
    }
  }

 private:
  struct Key {
    uint32_t id = 0;   // identifiant CAN attendu
    bool ext = false;  // identifiant 29 bits
  };
  std::vector<Key> keys_;
};

}  // namespace diagweb
