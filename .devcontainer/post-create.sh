#!/usr/bin/env bash
# Diagweb — préparation du Codespace (aucune dépendance pour l'application
# elle-même : seuls les outils de développement sont installés ici).
set -euo pipefail

echo "→ Vérification de l'outillage"
python3 --version
node --version

echo
echo "→ Vérification de la syntaxe des sources"
for f in web/js/*.js; do node --check "$f"; done
echo "   OK"

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
   python3 tools/serve.py            relancer l'aperçu (port 8080)
   python3 tools/serve.py --url      réafficher les adresses
   python3 tools/build.py            assembler dist/
   node --check web/js/*.js          vérifier la syntaxe
   bash tools/setup-tests.sh         installer Chromium (une fois)
   node tests/ui.mjs                 tests d'interface
────────────────────────────────────────────────────────────────

TXT
