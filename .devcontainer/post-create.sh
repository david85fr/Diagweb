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

cat <<'TXT'

────────────────────────────────────────────────────────────────
 Diagweb — Codespace prêt

 Aperçu (déjà lancé sur le port 8080) :
   · onglet « PORTS » → ouvrir le port 8080
   · page de développement : /web/index.html
   · livrable autonome    : /dist/index.html

 Pour tester depuis un téléphone : onglet « PORTS », clic droit sur
 le port 8080 → Visibilité du port → Public, puis ouvrir l'adresse
 transférée sur le téléphone.

 Commandes utiles :
   python3 tools/serve.py            relancer l'aperçu (port 8080)
   python3 tools/build.py            assembler dist/
   node --check web/js/*.js          vérifier la syntaxe
   bash tools/setup-tests.sh         installer Chromium (une fois)
   node tests/ui.mjs                 tests d'interface
────────────────────────────────────────────────────────────────

TXT
