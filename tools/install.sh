#!/usr/bin/env bash
# Diagweb — installation en une commande, depuis un clone du dépôt.
#
#   sudo bash tools/install.sh
#
# Prévu pour une machine neuve : Raspberry Pi OS (64 ou 32 bits) ou Ubuntu, et
# plus généralement toute Debian récente. Le script installe ce qu'il faut pour
# compiler, construit le paquet .deb POUR CETTE MACHINE, l'installe, démarre le
# service et affiche l'adresse à ouvrir.
#
# Options :
#   --sans-apt        ne rien installer avec apt (dépendances déjà présentes)
#   --sans-optionnel  se passer d'OPC UA et de SNMP v3 (paquet plus léger,
#                     les deux pilotes s'annoncent alors « non branché »)
#   --paquet-seul     construire le .deb sans l'installer
set -euo pipefail

cd "$(dirname "$0")/.."
RACINE=$(pwd)
APT=oui
OPTIONNEL=oui
INSTALLER=oui

while [ $# -gt 0 ]; do
  case "$1" in
    --sans-apt) APT=non; shift ;;
    --sans-optionnel) OPTIONNEL=non; shift ;;
    --paquet-seul) INSTALLER=non; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done

# Les privilèges ne sont exigés que par ce qui en a besoin : construire un
# paquet n'en demande aucun, et le faire en root laisserait build-paquet/ et
# dist/packages/ appartenant à root dans le clone de l'utilisateur.
if { [ "$INSTALLER" = oui ] || [ "$APT" = oui ]; } && [ "$(id -u)" -ne 0 ]; then
  echo "Installer le service demande les droits d'administration :" >&2
  echo "  sudo bash tools/install.sh" >&2
  echo "(construire le paquet seul n'en demande pas : bash tools/install.sh --paquet-seul --sans-apt)" >&2
  exit 1
fi

echo "Diagweb — installation depuis $RACINE"
. /etc/os-release 2>/dev/null || true
echo "  système : ${PRETTY_NAME:-inconnu} ($(dpkg --print-architecture 2>/dev/null || uname -m))"

# --------------------------------------------------------------- dépendances
# Le nécessaire pour compiler, puis deux facultatives. GCC 13 au moins est
# requis (C++23) : Raspberry Pi OS « trixie » (Debian 13) et Ubuntu 24.04 le
# fournissent ; Debian 12 « bookworm » s'arrête à GCC 12 et ne suffit pas.
if [ "$APT" = oui ]; then
  echo "  installation des outils de compilation…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || {
    echo "  ✗ « apt-get update » a échoué (réseau ou dépôts injoignables)." >&2
    echo "    Si les outils de compilation sont déjà installés : --sans-apt" >&2
    exit 1
  }
  apt-get install -y -qq --no-install-recommends \
    build-essential meson ninja-build pkg-config python3 git tcpdump || {
    echo "  ✗ installation des outils de compilation impossible." >&2
    echo "    Distribution trop ancienne, ou dépôts incomplets. Voir docs/INSTALL.md." >&2
    exit 1
  }
  if [ "$OPTIONNEL" = oui ]; then
    # Net-SNMP donne SNMP v3 (USM). open62541 n'est pas empaqueté par toutes les
    # distributions : absent, le pilote OPC UA s'annonce non branché, et
    # l'installation continue — ce n'est pas une erreur.
    apt-get install -y -qq --no-install-recommends libsnmp-dev || true
    apt-get install -y -qq --no-install-recommends libopen62541-dev || true
  fi
fi

if ! command -v g++ > /dev/null; then
  echo "  ✗ aucun compilateur C++ : relancez sans --sans-apt" >&2
  exit 1
fi

# GCC 13 minimum : le dire ici plutôt que de laisser meson échouer sur une
# erreur de compilation illisible cent lignes plus loin.
GCCV=$(g++ -dumpversion | cut -d. -f1)
if [ "${GCCV:-0}" -lt 13 ]; then
  echo "  ✗ g++ $GCCV : le serveur demande C++23, donc GCC 13 ou plus récent." >&2
  echo "    Raspberry Pi OS « trixie » (Debian 13) ou Ubuntu 24.04 conviennent ;" >&2
  echo "    Debian 12 « bookworm » s'arrête à GCC 12." >&2
  exit 1
fi

# ------------------------------------------------------------------ le paquet
ARGS=()
[ "$OPTIONNEL" = non ] && ARGS=(--sans-optionnel)
bash tools/package-deb.sh "${ARGS[@]+"${ARGS[@]}"}"
PAQUET=$(ls -t "$RACINE"/dist/packages/*.deb | head -1)

if [ "$INSTALLER" = non ]; then
  echo ""
  echo "Paquet construit : $PAQUET"
  exit 0
fi

# ---------------------------------------------------------------- installation
echo "  installation du paquet…"
# apt plutôt que dpkg : il tire les dépendances manquantes tout seul.
# --reinstall et --allow-downgrades : reconstruire deux fois le même commit
# donne le même numéro de version, et revenir en arrière dans l'historique en
# donne un plus petit — sans ces options, apt ne ferait rien en le disant à
# peine, et l'utilisateur croirait avoir installé son nouveau binaire.
apt-get install -y -qq --reinstall --allow-downgrades "$PAQUET"

echo ""
if [ -d /run/systemd/system ]; then
  systemctl --no-pager --lines=0 status diagweb.service || true
else
  echo "  systemd absent : le service n'a pas été démarré. Lancement manuel :"
  echo "    /usr/bin/diagweb-server --root /usr/share/diagweb --data-dir /var/lib/diagweb"
fi

# Ni l'un ni l'autre ne doit faire sortir le script : ce sont des agréments
# d'affichage, et l'installation, elle, est faite. (`set -e` avec `pipefail`
# transformerait l'absence de `hostname` en sortie silencieuse, juste avant les
# seules lignes que l'utilisateur attend.)
PORT=8080
[ -r /etc/default/diagweb ] && PORT=$(. /etc/default/diagweb; echo "${DIAGWEB_PORT:-8080}")
IP=$(hostname -I 2>/dev/null | awk '{print $1}') || IP=""
[ -n "$IP" ] || IP="<adresse-de-la-machine>"
echo ""
echo "Diagweb est installé."
echo "  page          : http://${IP}:${PORT}/"
echo "  réglages      : /etc/default/diagweb   (puis sudo systemctl restart diagweb)"
echo "  journal       : journalctl -u diagweb -f"
echo "  désinstaller  : sudo apt remove diagweb   (purge : sudo apt purge diagweb)"
