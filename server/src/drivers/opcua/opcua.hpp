// Diagweb — OPC UA (IEC 62541) : pilote DÉCLARÉ, lecture non implémentée.
//
// Ce qui manque est une pile OPC UA binaire complète : transport UA-TCP
// (Hello/Acknowledge, découpage en morceaux), SecureConversation (OpenSecure-
// Channel, jetons renouvelés), encodage binaire des types intégrés et des
// structures, puis les services CreateSession / ActivateSession, Read,
// CreateSubscription et CreateMonitoredItems / Publish. Le projet s'interdit
// toute dépendance externe au runtime : la pile devra donc être écrite, ce qui
// est un chantier à part entière.
//
// En attendant, la configuration se saisit et se conserve intégralement
// (point de terminaison, politique et mode de sécurité, mode de lecture,
// NodeId des points), ce qui permet de préparer un déploiement et de valider
// l'arborescence des NodeId avec l'exploitant. Le lien s'affiche « non
// branché » et aucune valeur n'est publiée.
//
// Deux partis pris fixés dès maintenant, pour ne pas avoir à les reprendre :
//
//   Lecture seule — comme tous les autres liens réseau. Les services d'écriture
//   (Write) et d'appel de méthode (Call) ne seront pas implémentés, même une
//   fois la pile disponible : un outil de diagnostic n'écrit pas dans un
//   serveur de supervision.
//
//   Aucun secret dans la configuration — `protocols.json` est lisible par tout
//   poste connecté au serveur de diagnostic et s'exporte en clair depuis
//   l'interface. Le nom d'utilisateur y figure, jamais le mot de passe ni la
//   clé privée du certificat client : ceux-ci viendront du magasin de secrets
//   du contrôleur, désigné par la configuration mais jamais recopié dedans.
#pragma once

#include "../common/declared.hpp"

namespace diagweb {

/** Pilote OPC UA déclaré : motif affiché dans l'état du lien. */
inline DriverPtr make_opcua_driver() {
  return std::make_unique<DeclaredDriver>(
      "pile OPC UA non implémentée — configuration conservée (voir docs/PROTOCOLES.md)");
}

}  // namespace diagweb
