// Diagweb — socle des pilotes « déclarés ».
//
// Un protocole déclaré est un protocole dont l'interface sait saisir toute la
// configuration, et dont le serveur conserve cette configuration, mais dont la
// lecture n'est pas encore écrite. Il ne publie JAMAIS de valeur : mieux vaut
// une absence franche, signalée « non branché » dans l'état du lien, qu'une
// valeur inventée qui passerait pour une mesure.
#pragma once

#include <string>
#include <utility>

#include "../../protocol.hpp"

namespace diagweb {

class DeclaredDriver : public IProtocolDriver {
 public:
  explicit DeclaredDriver(std::string why) : why_(std::move(why)) {}
  bool implemented() const override { return false; }
  bool open(std::string& err) override { err = why_; return false; }
  bool service(std::string& err) override { err = why_; return false; }
  void close() override {}

 private:
  std::string why_;
};

}  // namespace diagweb
