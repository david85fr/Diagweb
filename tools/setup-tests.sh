#!/usr/bin/env bash
# Diagweb — installation de l'outillage de test (Playwright + Chromium).
# Facultatif : l'application n'a aucune dépendance, seuls les tests en ont.
# Les navigateurs sont installés dans .pw-browsers/ (ignoré par git).
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -x "$(command -v chromium)" ] && [ -n "${CHROMIUM_PATH:-}" ]; then
  echo "Chromium déjà disponible : $CHROMIUM_PATH"
fi

echo "→ Installation de Playwright (outil de test uniquement)"
npm install --no-save --no-audit --no-fund playwright

echo "→ Téléchargement de Chromium"
npx playwright install --with-deps chromium

echo
echo "Terminé. Lancer les tests :"
echo "  node tests/ui.mjs                       (sur dist/index.html)"
echo "  node tests/ui.mjs http://localhost:8080/web/index.html"
