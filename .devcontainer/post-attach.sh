#!/usr/bin/env bash
# Diagweb — à chaque attachement au Codespace.
#
# Démarre le SERVEUR DE DIAGNOSTIC (flux WebSocket réel, pilotes réseau actifs)
# et non l'aperçu statique, qui laisserait la page sur sa simulation navigateur.
#
# Ce que « réel » recouvre exactement, pour ne pas se tromper d'attente :
#
#   PILOTES RÉSEAU   réels. Sans --sim-protocols, les liens configurés sont
#                    ouverts pour de bon vers les équipements. Aucun lien
#                    configuré = rien à ouvrir, et le serveur annonce
#                    « 0 configure(s) » : c'est la fenêtre « Liens réseau »
#                    (☰) qui les crée, et --data-dir les conserve.
#   VARIABLES INTERNES  encore simulées, et cela ne dépend pas d'une option :
#                    server/src/main.cpp construit un SimSource tant que le
#                    binding vers le controller n'existe pas (phase 2, voir
#                    docs/PROJET.md « Architecture cible »). Il n'y a pas de
#                    controller à lire dans un Codespace.
#
# Rejoué à chaque attachement, donc idempotent : share.sh laisse un serveur
# déjà en fonctionnement tranquille plutôt que de le redémarrer — un
# redémarrage couperait une capture ou une campagne de journalisation.
#
# --local : le port n'est pas publié. Publier est une décision, pas un effet de
# bord d'un attachement ; « bash tools/share.sh --server » le fait au moment
# choisi.
set -uo pipefail

cd "$(dirname "$0")/.."

# --no-restart : ce script est rejoué à CHAQUE attachement. La relance est le
# défaut de share.sh, mais l'appliquer ici couperait une campagne de
# journalisation ou une capture à chaque reconnexion d'onglet.
demarre_surveillance() {
  # Surveillance de main : c'est elle qui rend la mise à jour automatique.
  # Dès qu'un commit arrive sur origin/main, tools/sync.sh coupe proprement les
  # enregistrements, arrête banc, simulateur et serveur, récupère, recompile et
  # relance tout — sans qu'on ait rien à taper. Ouvrir la page suffit alors à
  # voir la dernière version.
  #
  # setsid : la boucle doit survivre à la fermeture du terminal et au
  # détachement de l'onglet, pas seulement au SIGHUP. Elle se verrouille
  # elle-même par fichier de PID, donc la relancer à chaque attachement est
  # sans effet si elle tourne déjà.
  #
  # DIAGWEB_NO_WATCH=1 dans l'environnement du Codespace la désactive.
  [ -n "${DIAGWEB_NO_WATCH:-}" ] && { echo "→ Surveillance de main désactivée (DIAGWEB_NO_WATCH)"; return 0; }
  setsid nohup bash tools/sync.sh --watch 60 >> /tmp/diagweb-watch.log 2>&1 &
  sleep 0.5
  echo "→ Surveillance de main active (journal : /tmp/diagweb-watch.log)"
}

if bash tools/share.sh --server --local --no-restart; then
  demarre_surveillance
  exit 0
fi

# Le serveur n'a pas pu démarrer (outillage absent, compilation en échec). On
# se replie sur l'aperçu, mais en le DISANT : un repli muet reproduirait
# exactement le piège que share.sh corrige — croire lire le serveur en
# regardant la simulation.
echo
echo "════════════════════════════════════════════════════════════════"
echo " ⚠ Serveur de diagnostic indisponible — repli sur l'aperçu statique."
echo "   La page affichera la SIMULATION NAVIGATEUR, pas le flux serveur."
echo "   (barre d'état en bas : « Simulation » au lieu de « Serveur de"
echo "   diagnostic »)"
echo
echo "   Rattraper :  bash .devcontainer/on-create.sh"
echo "   Puis     :  bash tools/share.sh --server --local"
echo "════════════════════════════════════════════════════════════════"
bash tools/share.sh --local
