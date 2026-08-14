// Diagweb — IEC 61850 : aiguillage des quatre mécanismes de la norme.
//
// La norme couvre quatre façons très différentes de récupérer une donnée, et
// elles ne se valent pas du tout en coût d'implémentation :
//
//   GOOSE (8-1)   Ethernet 0x88B8, BER, aucune session       → implémenté
//   SV (9-2)      Ethernet 0x88BA, BER, aucune session       → implémenté
//   MMS lecture   ISO 8073/8327/8823 + ACSE + MMS sur TCP    → implémenté
//   Rapports      MMS + BRCB/URCB (bufférisés ou non)        → implémenté
//
// GOOSE et Sampled Values sont des trames diffusées : rien à établir, rien à
// négocier, juste à écouter et décoder. C'est ce qui les rend écrivables ici.
//
// MMS demande au contraire une pile ISO complète — ISO-on-TCP (RFC 1006),
// COTP, session, présentation, ACSE, puis MMS en ASN.1 BER — soit un volume de
// code comparable à tout le reste du serveur, et non validable sans IED réel.
// Les rapports (BRCB et URCB) roulent sur MMS : ils héritent du même blocage.
//
// Ce blocage n'est pas technique mais juridique, et il vaut d'être rappelé :
// les piles C matures (libiec61850 et consorts) sont en double licence GPLv3
// ou commerciale payante, donc écartées par la règle du projet — une
// bibliothèque doit rester gratuite en produit commercial fermé. Aucune pile
// IEC 61850 permissive en C n'existe à ce jour. Voir docs/PROTOCOLES.md.
#pragma once

#include "../common/declared.hpp"
#include "goose.hpp"
#include "mms.hpp"
#include "sv.hpp"

namespace diagweb {

/** Choisit le pilote selon le mécanisme retenu dans la configuration. */
inline DriverPtr make_iec61850_driver(const LinkConfig& link, IPointSink& sink) {
  const std::string mode = link.str("mode", "goose");
  if (mode == "goose") return std::make_unique<GooseDriver>(link, sink);
  if (mode == "sv")    return std::make_unique<SvDriver>(link, sink);
  return std::make_unique<MmsDriver>(link, sink);   // lecture MMS et rapports
}

}  // namespace diagweb
