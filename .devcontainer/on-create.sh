#!/usr/bin/env bash
# Diagweb — outillage SYSTÈME du Codespace (rien qui dépende du dépôt).
#
# Pourquoi un script à part, et pourquoi onCreateCommand :
#
# Un prebuild Codespaces exécute la préparation jusqu'à onCreateCommand et
# updateContentCommand inclus, et ne joue JAMAIS postCreateCommand. Tout ce qui
# est posé ici est donc cuit dans l'image du prebuild, quand il est activé sur
# le dépôt (Settings → Codespaces → Set up prebuilds). La construction
# d'open62541, plusieurs minutes de CMake, vivait auparavant dans
# postCreateCommand : elle était repayée à chaque création de Codespace,
# exactement ce que son commentaire prétendait éviter.
#
# Ce script ne lit ni ne compile aucune source : ce qui dépend du dépôt reste
# dans post-create.sh, qui voit le commit réellement ouvert.
#
# Règle de conduite : ce qui demande le réseau n'est pas bloquant. Un miroir
# apt indisponible doit laisser un Codespace utilisable pour le front-end (qui
# n'a aucune dépendance), pas un conteneur à moitié construit. post-create.sh
# constate ce qui manque et le dit en clair.
set -euo pipefail

O62="$HOME/.local/open62541"
MANQUE=""

# Le Codespace fournit sudo sans mot de passe ; une exécution en root (essai
# local, image dépouillée) n'a pas forcément sudo installé.
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

# Installation apt tolérante : deux tentatives, sans abattre le script.
apt_poser() {
  $SUDO apt-get install -y -qq --no-install-recommends "$@" 2> /dev/null ||
    { sleep 3
      $SUDO apt-get install -y -qq --no-install-recommends "$@" 2> /dev/null; }
}

presents() {
  local outil
  for outil in "$@"; do command -v "$outil" > /dev/null || return 1; done
}

# --------------------------------------------------------------- outillage C++
# Deux niveaux, à ne surtout pas confondre :
#
#   INDISPENSABLE  g++, meson, ninja — sans eux rien ne se compile, et
#                  « bash tools/share.sh --server » refuse de démarrer.
#   OPTIONNEL      libsnmp-dev, snmpd, socat, tcpdump, can-utils, iproute2 —
#                  leur absence ne dégrade qu'un pilote ou un test, jamais la
#                  construction. Ce sont les mêmes paquets que
#                  .github/workflows/ci.yml, pour que `bash tools/check.sh`
#                  donne ici le résultat qu'il donnera en intégration continue.
#                    libsnmp-dev + snmpd : pilote SNMPv3 (USM) et agent réel
#                    socat               : pty pour Modbus RTU sans matériel
#                    tcpdump             : capture réseau (/api/capture)
#                    can-utils, iproute2 : bus vcan, si les capacités le permettent
#
# Les poser d'un seul apt faisait qu'un miroir indisponible emportait le
# compilateur avec le reste. Ils sont séparés, et l'indispensable a un repli
# qui ne passe pas par apt.
echo "→ Outillage indispensable (compilateur, meson, ninja)"
$SUDO apt-get update -qq 2> /dev/null ||
  echo "   ⚠ « apt-get update » a échoué — tentative d'installation quand même."
apt_poser build-essential meson ninja-build pkg-config || true

# Repli sans apt : meson et ninja sont aussi publiés sur PyPI, et python3 est
# fourni par l'image. De quoi sauver un Codespace dont le miroir apt est en
# panne. g++, lui, ne peut venir que de l'image ou d'apt.
if ! presents meson ninja; then
  echo "   apt n'a pas suffi — repli par pip (meson et ninja y sont publiés)"
  pip install --quiet meson ninja 2> /dev/null ||
    pip install --quiet --user meson ninja 2> /dev/null ||
    pip install --quiet --break-system-packages meson ninja 2> /dev/null || true
  export PATH="$HOME/.local/bin:$PATH"

  # Dernier recours : un paquet que pip croit déjà posé, mais dont la commande
  # a disparu (installation partielle, ménage manuel), rend « pip install »
  # silencieusement inopérant — il faut alors forcer la réinstallation.
  presents meson ninja ||
    pip install --quiet --force-reinstall meson ninja 2> /dev/null || true
fi

if presents g++ meson ninja; then
  echo "   OK — $(g++ --version | head -1), meson $(meson --version), ninja $(ninja --version)"
else
  for outil in g++ meson ninja; do
    command -v "$outil" > /dev/null || MANQUE="$MANQUE $outil"
  done
  echo "   ⚠ manque :$MANQUE — le serveur de diagnostic ne pourra pas être compilé."
fi

echo
echo "→ Dépendances optionnelles des pilotes et des tests"
# git-lfs : ce dépôt ne s'en sert pas (ni .gitattributes, ni filtre), mais
# l'image Codespaces pose des hooks LFS par core.hookspath. Sans l'outil, tout
# « git pull » crache un avertissement alarmant au milieu de la sortie utile —
# on l'a pris pour un défaut de tools/sync.sh. Trois mégaoctets pour du silence.
if apt_poser libsnmp-dev snmpd socat tcpdump can-utils iproute2 git-lfs; then
  # snmpd est installé pour la BIBLIOTHÈQUE et comme agent de test lancé à la
  # demande ; le démon du système n'a rien à écouter en permanence ici.
  $SUDO systemctl stop snmpd 2> /dev/null || true
  $SUDO systemctl disable snmpd 2> /dev/null || true
  echo "   OK"
else
  echo "   ⚠ absentes — SNMP v3, Modbus RTU et la capture resteront en retrait,"
  echo "     le reste fonctionne. Reprendre plus tard :"
  echo "     sudo apt-get install -y libsnmp-dev snmpd socat tcpdump can-utils iproute2"
fi

# ------------------------------------------------------------------- OPC UA
# open62541 n'est pas empaqueté par Ubuntu : il faut le construire. C'est
# l'étape la plus chère de la préparation, et la première raison d'être de ce
# fichier — dans un prebuild, elle est payée une fois pour toutes.
#
# Conservé dans $HOME, qui vit dans le conteneur : un « Rebuild Container » le
# perd (seul /workspaces survit) et il sera reconstruit. Absent, meson replie
# le pilote OPC UA sur « déclaré » sans rien casser.
if [ -e "$O62/lib/pkgconfig/open62541.pc" ] ||
   [ -e "$O62/lib64/pkgconfig/open62541.pc" ]
then
  echo
  echo "→ open62541 déjà construit — rien à refaire"
elif presents cmake git; then
  echo
  echo "→ Construction d'open62541 v1.5.6 (pilote OPC UA) — une seule fois"
  tmp=$(mktemp -d)
  # advice.detachedHead : un clone sur étiquette laisse sinon dix lignes de
  # conseils dans le journal de création, qui se lisent comme une erreur.
  if git -c advice.detachedHead=false clone --depth 1 --branch v1.5.6 -q \
       https://github.com/open62541/open62541.git "$tmp/o62" &&
     cmake -S "$tmp/o62" -B "$tmp/o62/build" \
       -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$O62" \
       -DUA_NAMESPACE_ZERO=REDUCED -DUA_ENABLE_AMALGAMATION=OFF \
       -DUA_BUILD_EXAMPLES=OFF -DUA_FORCE_WERROR=OFF -DBUILD_SHARED_LIBS=OFF \
       -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=OFF \
       -DCMAKE_POSITION_INDEPENDENT_CODE=ON > /dev/null &&
     cmake --build "$tmp/o62/build" -j"$(nproc)" > /dev/null &&
     cmake --install "$tmp/o62/build" > /dev/null
  then
    echo "   OK"
  else
    # -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=OFF n'est pas cosmétique : sans lui,
    # GCC recompile le C d'open62541 à l'édition de liens, sous le -Werror de
    # Diagweb.
    echo "   ⚠ échec — le pilote OPC UA restera « déclaré » (rien d'autre ne change)."
  fi
  rm -rf "$tmp"
else
  echo
  echo "→ cmake ou git absent — open62541 non construit, pilote OPC UA « déclaré »"
fi
