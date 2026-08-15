#!/usr/bin/env bash
# Diagweb — donner à tcpdump la capacité d'ouvrir une interface en capture.
#
# POURQUOI. La page « Capture d'interfaces réseau » lance tcpdump, et ouvrir
# une interface demande CAP_NET_RAW. Dans un Codespace, le serveur de
# diagnostic tourne sous l'utilisateur du conteneur (« vscode »), pas sous
# root : il n'a pas cette capacité. Et il ne pourrait pas la transmettre même
# s'il l'avait — un exec jette les capacités du processus, sauf si elles sont
# AMBIANTES (AmbientCapabilities= d'une unité systemd, la voie retenue sur le
# contrôleur) ou portées par le binaire lui-même. C'est cette seconde voie qui
# vaut ici. Sans elle, chaque capture échoue sur :
#
#   tcpdump: eth0: You don't have permission to perform this capture...
#   (socket: Operation not permitted)
#
# CE QU'ON POSE, ET RIEN DE PLUS. cap_net_raw seule. Ubuntu ne pose AUCUNE
# capacité fichier sur tcpdump ; en ajouter une qui sorte du jeu limite du
# conteneur — cap_net_admin, par exemple — ferait échouer l'exec lui-même,
# avant toute socket et y compris sous sudo, sans un mot d'explication.
# CAP_NET_RAW, elle, fait partie du jeu par défaut de tout conteneur.
#
# Rejouable sans risque : idempotent, et jamais bloquant. Un Codespace sans
# setcap ou sans droit de le faire reste parfaitement utilisable — c'est la
# seule page capture qui le dira, désormais en clair.
set -uo pipefail

BIN=$(command -v tcpdump 2> /dev/null) || BIN=""
[ -z "$BIN" ] && exit 0                       # pas de tcpdump : rien à faire

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

# Déjà en place (image de prebuild, script rejoué) : ne rien réécrire.
if command -v getcap > /dev/null 2>&1 && $SUDO getcap "$BIN" 2> /dev/null | grep -q cap_net_raw; then
  echo "   capture : cap_net_raw déjà posée sur $BIN"
  exit 0
fi

if ! command -v setcap > /dev/null 2>&1; then
  $SUDO apt-get install -y -qq --no-install-recommends libcap2-bin 2> /dev/null || true
fi

if command -v setcap > /dev/null 2>&1 && $SUDO setcap cap_net_raw+ep "$BIN" 2> /dev/null; then
  echo "   capture : cap_net_raw posée sur $BIN"
else
  echo "   ⚠ capture : cap_net_raw non posée sur $BIN — la page « Capture"
  echo "     d'interfaces réseau » refusera de démarrer, en le disant. Rattraper :"
  echo "     sudo setcap cap_net_raw+ep $BIN"
fi
exit 0
