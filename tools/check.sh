#!/usr/bin/env bash
# Diagweb — mêmes vérifications que l'intégration continue, en local.
#
# La référence reste .github/workflows/ci.yml ; ce script en est le miroir,
# pour ne pas découvrir un échec seulement après la poussée.
#
#   bash tools/check.sh            tout
#   bash tools/check.sh serveur    serveur C++ uniquement
#   bash tools/check.sh interface  interface web uniquement
#
# Prérequis interface : bash tools/setup-tests.sh (Playwright + Chromium).
set -uo pipefail

cd "$(dirname "$0")/.."
CIBLE="${1:-tout}"
ECHECS=0
PORT="${DIAGWEB_PORT:-8080}"

titre() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Sortie masquée tant que tout va bien ; affichée en entier en cas d'échec.
etape() {
  local nom="$1"; shift
  local trace; trace=$(mktemp)
  if "$@" > "$trace" 2>&1; then
    printf '  \033[32m✓\033[0m %s\n' "$nom"
  else
    printf '  \033[31m✗\033[0m %s\n' "$nom"
    sed 's/^/      /' "$trace"
    ECHECS=$((ECHECS + 1))
  fi
  rm -f "$trace"
}

attendre() {   # attendre <url>
  for _ in $(seq 1 60); do
    curl -sf "$1" > /dev/null && return 0
    sleep 0.25
  done
  return 1
}

syntaxe_js() {
  local f
  for f in web/js/*.js; do node --check "$f" || return 1; done
}

syntaxe_outillage() {
  local f
  python3 -m py_compile tools/*.py || return 1
  for f in tools/*.sh; do bash -n "$f" || return 1; done
}

entetes_generes() {
  node tools/gen-catalog.mjs > /dev/null &&
  node tools/gen-protocols.mjs > /dev/null &&
  git diff --quiet -- server/src/catalog.generated.hpp server/src/protocols.generated.hpp
}

# --------------------------------------------------------------- serveur
if [ "$CIBLE" = tout ] || [ "$CIBLE" = serveur ]; then
  titre "Serveur de diagnostic (C++20)"
  etape "compilation (avertissements = erreurs)" bash -c '
    cmake -B server/build -S server -DCMAKE_BUILD_TYPE=Release \
          -DCMAKE_CXX_FLAGS="-Wall -Wextra -Werror" &&
    cmake --build server/build -j --target diagweb-server diagweb-decode-test \
                                          diagweb-opcua-test-server'
  etape "décodage des protocoles" ./server/build/diagweb-decode-test

  if [ -x server/build/diagweb-server ]; then
    DATA=$(mktemp -d)
    # Phrases secrètes de l'agent SNMPv3 de test : jamais dans la
    # configuration, toujours dans l'environnement du serveur — c'est
    # exactement ce que le pilote exige en exploitation.
    export DIAGWEB_SECRET_AGENT_AUTH=motdepasseauth
    export DIAGWEB_SECRET_AGENT_PRIV=motdepassepriv
    ./server/build/diagweb-server --port "$PORT" --root . --data-dir "$DATA" > /tmp/diagweb-ci.log 2>&1 &
    SRV=$!
    if attendre "http://localhost:$PORT/api/health"; then
      etape "liens réseau de bout en bout" node tests/protocols.mjs "http://localhost:$PORT"
      etape "forçage et journalisation autonome" node tests/server.mjs "http://localhost:$PORT"
    else
      printf '  \033[31m✗\033[0m le serveur n’a pas démarré (voir /tmp/diagweb-ci.log)\n'
      ECHECS=$((ECHECS + 1))
    fi
    kill "$SRV" 2> /dev/null
    wait "$SRV" 2> /dev/null
    rm -rf "$DATA"
  fi
fi

# ------------------------------------------------------------- interface
if [ "$CIBLE" = tout ] || [ "$CIBLE" = interface ]; then
  titre "Interface web"
  etape "syntaxe des sources JavaScript" syntaxe_js
  etape "syntaxe de l'outillage (Python et shell)" syntaxe_outillage
  etape "en-têtes générés à jour" entetes_generes
  etape "un dossier de pilote par protocole" node tools/check-drivers.mjs
  etape "livrables à jour et page autonome" python3 tools/check-dist.py
  etape "tests d'interface" node tests/ui.mjs

  python3 tools/serve.py --port "$PORT" > /dev/null 2>&1 &
  APERCU=$!
  if attendre "http://localhost:$PORT/web/index.html"; then
    etape "déplacement de widgets" node tests/dnd.mjs "http://localhost:$PORT/web/index.html"
  else
    printf '  \033[31m✗\033[0m serveur d’aperçu indisponible\n'
    ECHECS=$((ECHECS + 1))
  fi
  kill "$APERCU" 2> /dev/null
  wait "$APERCU" 2> /dev/null
fi

printf '\n'
if [ "$ECHECS" -eq 0 ]; then
  printf '\033[32mToutes les vérifications sont passées.\033[0m\n'
else
  printf '\033[31m%d vérification(s) en échec.\033[0m Relancer la commande fautive pour le détail.\n' "$ECHECS"
fi
exit $((ECHECS > 0))
