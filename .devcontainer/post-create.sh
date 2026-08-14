#!/usr/bin/env bash
# Diagweb — préparation du Codespace.
#
# L'application web n'a aucune dépendance : elle s'ouvre telle quelle. Ce qui
# est installé ici sert au SERVEUR DE DIAGNOSTIC et à ses liens réseau, dont
# les tests de bout en bout étaient impossibles dans un Codespace neuf (ni
# meson, ni Net-SNMP, ni open62541).
#
# Règle de conduite : ce qui touche à l'application est bloquant, ce qui
# demande le réseau ne l'est pas. Un miroir apt indisponible doit laisser un
# Codespace utilisable pour le front-end, pas un conteneur à moitié construit.
set -euo pipefail

O62="$HOME/.local/open62541"
export PKG_CONFIG_PATH="$O62/lib/pkgconfig:$O62/lib64/pkgconfig:${PKG_CONFIG_PATH:-}"
SERVEUR_PRET=0
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

echo "→ Vérification de l'outillage"
python3 --version
node --version

echo
echo "→ Vérification de la syntaxe des sources"
for f in web/js/*.js; do node --check "$f"; done
echo "   OK"

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
# L'ancienne version posait les deux niveaux d'un seul apt : un miroir
# indisponible emportait le compilateur avec le reste, et le défaut ne se
# révélait qu'au premier « share.sh --server ». Ils sont maintenant séparés, et
# l'outillage indispensable a un repli qui ne passe pas par apt.
echo
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
  SERVEUR_PRET=1
else
  for outil in g++ meson ninja; do
    command -v "$outil" > /dev/null || MANQUE="$MANQUE $outil"
  done
  echo "   ⚠ manque :$MANQUE — le serveur de diagnostic ne pourra pas être compilé."
fi

echo
echo "→ Dépendances optionnelles des pilotes et des tests"
if apt_poser libsnmp-dev snmpd socat tcpdump can-utils iproute2; then
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
# open62541 n'est pas empaqueté par Ubuntu. Construit une fois et conservé dans
# $HOME : un prebuild Codespaces le paie à la création de l'image, pas à chaque
# session. Absent, meson repli le pilote OPC UA sur « déclaré » sans rien casser.
if [ "$SERVEUR_PRET" = 1 ] &&
   [ ! -e "$O62/lib/pkgconfig/open62541.pc" ] &&
   [ ! -e "$O62/lib64/pkgconfig/open62541.pc" ]
then
  echo
  echo "→ Construction d'open62541 v1.5.6 (pilote OPC UA) — une seule fois"
  tmp=$(mktemp -d)
  if git clone --depth 1 --branch v1.5.6 -q \
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
fi

# ------------------------------------------------------------------ serveur
if [ "$SERVEUR_PRET" = 1 ]; then
  echo
  echo "→ Compilation du serveur de diagnostic"
  if (meson setup build > /dev/null 2>&1 || meson setup --reconfigure build > /dev/null) &&
     meson compile -C build > /dev/null
  then
    echo "   OK — ./build/diagweb-server"
  else
    echo "   ⚠ échec — relancer à la main : meson setup build && meson compile -C build"
  fi
fi

# Un manque sur l'outillage indispensable se dit ici, en clair et tout de
# suite : le découvrir au premier « share.sh --server » coûtait une séance de
# dépannage pour une ligne de commande.
if [ "$SERVEUR_PRET" != 1 ]; then
  echo
  echo "════════════════════════════════════════════════════════════════"
  echo " ⚠ OUTILLAGE INCOMPLET —$MANQUE"
  echo
  echo " L'interface web fonctionne (elle n'a aucune dépendance), mais le"
  echo " serveur de diagnostic ne peut pas être compilé. Pour rattraper :"
  echo
  echo "   sudo apt-get update"
  echo "   sudo apt-get install -y build-essential meson ninja-build pkg-config"
  echo "   bash .devcontainer/post-create.sh      # rejouable sans risque"
  echo "════════════════════════════════════════════════════════════════"
fi

echo
echo "────────────────────────────────────────────────────────────────"
echo " Diagweb — Codespace prêt. Aperçu lancé sur le port 8080 :"
echo
python3 tools/serve.py --url | sed 's/^/   /'
echo
cat <<'TXT'
 (adresses aussi listées par : python3 tools/serve.py --url)

 Rendre l'aperçu accessible à un autre appareil :
   bash tools/share.sh

 Commandes utiles :
   bash tools/share.sh               aperçu public + adresse
   bash tools/share.sh --server      serveur de diagnostic C++ (flux réel)
   python3 tools/serve.py            relancer l'aperçu (port 8080)
   python3 tools/serve.py --url      réafficher les adresses
   python3 tools/build.py            assembler dist/
   node --check web/js/*.js          vérifier la syntaxe
   bash tools/setup-tests.sh         installer Chromium (une fois)
   node tests/ui.mjs                 tests d'interface

 Liens réseau (serveur de diagnostic) :
   bash tools/check.sh serveur       compilation + tests des 13 pilotes
   ./build/diagweb-decode-test       décodeurs seuls, hors ligne

 GOOSE, Sampled Values, LLDP et la capture demandent CAP_NET_RAW ; les
 protocoles CAN demandent une interface vcan (CAP_NET_ADMIN). Voir
 docs/PROTOCOLES.md § « Éprouver les liens en conteneur ».
────────────────────────────────────────────────────────────────

TXT
