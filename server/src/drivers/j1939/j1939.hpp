// Diagweb — pilote J1939 (CAN 29 bits, lecture seule).
//
// L'identifiant étendu est découpé en priorité, page de données, PGN et
// adresse source ; un point est un SPN extrait du PGN, décrit comme un champ
// de bits (voir j1939_pgn() / j1939_sa() dans protocol.hpp).
//
// Limite assumée : seuls les PGN tenant dans une trame (8 octets) sont lus.
// Le protocole de transport multi-trames (TP.BAM, TP.CM/RTS-CTS) n'est pas
// implémenté, donc un PGN long ne remonte aucune valeur — plutôt que d'en
// remonter une partielle.
//
// Transport et filtres : common/can_socket.hpp.
#pragma once

#include <string>
#include <vector>

#include "../common/can_socket.hpp"

namespace diagweb {

class J1939Driver : public CanDriverBase {
 public:
  J1939Driver(const LinkConfig& link, IPointSink& sink) : CanDriverBase(link, sink) {
    link_sa_ = static_cast<int>(link_.num("sa", -1));
    for (const auto& p : link_.points) {
      Key k;
      k.pgn = static_cast<uint32_t>(p.num("pgn", 0));
      k.sa = static_cast<int>(p.num("sa", -1));
      keys_.push_back(k);
    }
  }

 protected:
  std::vector<CanFilter> filters() const override {
    std::vector<CanFilter> f;
    f.reserve(keys_.size());
    for (const Key& k : keys_) {
      // On filtre sur le PGN, jamais sur l'adresse source (elle change à la
      // re-revendication) ; en PDU1 l'octet PS est une destination et ne fait
      // pas partie du PGN, il ne doit donc pas entrer dans le masque.
      const bool pdu2 = ((k.pgn >> 8) & 0xFF) >= 240;
      CanFilter c;
      c.id = k.pgn << 8;
      c.mask = pdu2 ? 0x03FFFF00u : 0x03FF0000u;
      c.ext = true;
      f.push_back(c);
    }
    return f;
  }

  void on_frame(uint32_t id, bool ext, const uint8_t* d, size_t len) override {
    if (!ext) return;
    const uint32_t pgn = j1939_pgn(id);
    const int sa = static_cast<int>(j1939_sa(id));
    if (link_sa_ >= 0 && sa != link_sa_) return;
    for (size_t i = 0; i < keys_.size(); ++i) {
      if (keys_[i].pgn != pgn) continue;
      if (keys_[i].sa >= 0 && sa != keys_[i].sa) continue;
      publish_signal(i, link_.points[i], d, len);
    }
  }

 private:
  struct Key {
    uint32_t pgn = 0;  // groupe de paramètres attendu
    int sa = -1;       // adresse source attendue, −1 = indifférent
  };
  std::vector<Key> keys_;
  int link_sa_ = -1;   // filtre d'adresse source valant pour tout le lien
};

}  // namespace diagweb
