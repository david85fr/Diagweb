#!/usr/bin/env bash
# Diagweb — préparation LIÉE AU DÉPÔT (syntaxe, compilation, adresses).
#
# L'outillage système est posé par on-create.sh, joué par onCreateCommand pour
# être cuit dans le prebuild. Ne reste ici que ce qui a besoin du code : la
# vérification de syntaxe et la compilation du serveur de diagnostic, qui
# doivent refléter le commit réellement ouvert — donc jamais une image figée.
#
# L'application web, elle, n'a aucune dépendance : elle s'ouvre telle quelle.
# Tout ce qui est construit ici sert au SERVEUR DE DIAGNOSTIC.
set -euo pipefail

O62="$HOME/.local/open62541"
export PKG_CONFIG_PATH="$O62/lib/pkgconfig:$O62/lib64/pkgconfig:${PKG_CONFIG_PATH:-}"
MANQUE=""

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

# ------------------------------------------------------------------ serveur
# L'état de l'outillage est constaté, pas transmis : on-create.sh a pu être
# joué dans un prebuild, dans un autre conteneur, ou pas du tout. Une variable
# passée de l'un à l'autre mentirait ; « la commande est-elle là ? » ne ment
# jamais.
for outil in g++ meson ninja; do
  command -v "$outil" > /dev/null || MANQUE="$MANQUE $outil"
done

if [ -z "$MANQUE" ]; then
  echo
  echo "→ Compilation du serveur de diagnostic"
  if (meson setup build > /dev/null 2>&1 || meson setup --reconfigure build > /dev/null) &&
     meson compile -C build > /dev/null
  then
    echo "   OK — ./build/diagweb-server"
  else
    echo "   ⚠ échec — relancer à la main : meson setup build && meson compile -C build"
  fi
else
  # Un manque sur l'outillage indispensable se dit ici, en clair et tout de
  # suite : le découvrir au premier « share.sh --server » coûtait une séance de
  # dépannage pour une ligne de commande.
  echo
  echo "════════════════════════════════════════════════════════════════"
  echo " ⚠ OUTILLAGE INCOMPLET —$MANQUE"
  echo
  echo " L'interface web fonctionne (elle n'a aucune dépendance), mais le"
  echo " serveur de diagnostic ne peut pas être compilé. Pour rattraper :"
  echo
  echo "   bash .devcontainer/on-create.sh       # rejouable sans risque"
  echo
  echo " Si cela ne suffit pas, le miroir apt est probablement en panne :"
  echo "   sudo apt-get update"
  echo "   sudo apt-get install -y build-essential meson ninja-build pkg-config"
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
