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

bash tools/share.sh --server --local && exit 0

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
