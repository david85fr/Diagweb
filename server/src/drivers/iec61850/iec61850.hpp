// Diagweb — IEC 61850 (MMS) : pilote DÉCLARÉ, lecture non implémentée.
//
// Ce qui manque est une pile ISO complète sous MMS : ISO 8073 (COTP) sur TCP
// port 102, ISO 8327 (session), ISO 8823 (présentation) et l'encodage ACSE,
// puis MMS lui-même. Rien de tout cela ne s'improvise en quelques centaines de
// lignes, et le projet s'interdit toute dépendance externe au runtime : le
// travail est donc identifié, pas bâclé.
//
// En attendant, la configuration (adresse de l'IED, mode d'interrogation,
// références d'objet et contraintes fonctionnelles) se saisit et se conserve
// intégralement, ce qui permet de préparer un déploiement. Le lien s'affiche
// « non branché » et aucune valeur n'est publiée.
//
// Services visés à l'implémentation : Initiate/Conclude, Read (interrogation
// cyclique) et Report (BRCB/URCB) — en lecture seule, sans Write ni Control.
#pragma once

#include "../common/declared.hpp"

namespace diagweb {

/** Pilote IEC 61850 déclaré : motif affiché dans l'état du lien. */
inline DriverPtr make_iec61850_driver() {
  return std::make_unique<DeclaredDriver>(
      "pile ISO/MMS non implémentée — configuration conservée (voir docs/PROTOCOLES.md)");
}

}  // namespace diagweb
