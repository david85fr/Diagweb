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

echo "→ Vérification de l'outillage"
python3 --version
node --version

echo
echo "→ Vérification de la syntaxe des sources"
for f in web/js/*.js; do node --check "$f"; done
echo "   OK"

# --------------------------------------------------------------- outillage C++
# Les mêmes paquets que .github/workflows/ci.yml, pour que `bash tools/check.sh`
# donne ici le résultat qu'il donnera en intégration continue.
#   meson/ninja/pkg-config : construction (l'image fournit déjà GCC et cmake)
#   libsnmp-dev + snmpd    : pilote SNMPv3 (USM) et agent réel pour l'éprouver
#   socat                  : paire de pty pour Modbus RTU sans matériel
#   tcpdump                : capture réseau (/api/capture)
#   can-utils, iproute2    : bus vcan, si les capacités le permettent
echo
echo "→ Outillage du serveur de diagnostic"
if sudo apt-get update -qq &&
   sudo apt-get install -y -qq --no-install-recommends \
     meson ninja-build pkg-config libsnmp-dev snmpd socat tcpdump can-utils iproute2
then
  # snmpd est installé pour la BIBLIOTHÈQUE et comme agent de test lancé à la
  # demande ; le démon du système n'a rien à écouter en permanence ici.
  sudo systemctl stop snmpd 2> /dev/null || true
  sudo systemctl disable snmpd 2> /dev/null || true
  echo "   OK"
  SERVEUR_PRET=1
else
  echo "   ⚠ installation impossible — le front-end reste utilisable."
  echo "     Reprendre plus tard : sudo apt-get install -y meson ninja-build libsnmp-dev snmpd"
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
