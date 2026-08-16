#!/usr/bin/env bash
# Diagweb — mêmes vérifications que l'intégration continue, en local.
#
# La référence reste .github/workflows/ci.yml ; ce script en est le miroir,
# pour ne pas découvrir un échec seulement après la poussée.
#
#   bash tools/check.sh            tout
#   bash tools/check.sh serveur    serveur C++ uniquement
#   bash tools/check.sh interface  interface web uniquement
#   bash tools/check.sh paquet     paquet .deb uniquement (long : recompile)
#
# Prérequis serveur   : meson + ninja (+ open62541 et Net-SNMP si présents).
# Prérequis interface : bash tools/setup-tests.sh (Playwright + Chromium).
set -uo pipefail

cd "$(dirname "$0")/.."
CIBLE="${1:-tout}"
case "$CIBLE" in
  tout|serveur|interface|paquet) ;;
  *) echo "cible inconnue : $CIBLE (tout | serveur | interface | paquet)" >&2
     exit 2 ;;
esac
ECHECS=0
PORT="${DIAGWEB_PORT:-8080}"
BUILD="${DIAGWEB_BUILD:-build}"

titre() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Le paquet contient-il ce qu'il annonce ? Un .deb qui s'ouvre mais où le
# binaire ou le service manque s'installerait sans bruit et ne servirait rien.
verifier_paquet() {
  local p
  # Le paquet doit dater de la construction qui vient d'avoir lieu : sans cette
  # borne, une construction en échec laissait examiner celui de la fois d'avant
  # et la vérification s'affichait en vert.
  p=$(find dist/packages -name '*.deb' -newermt "@${DEBUT_PAQUET:-0}" 2> /dev/null |
      head -1)
  [ -n "$p" ] || { echo "aucun paquet neuf dans dist/packages/"; return 1; }
  dpkg-deb --info "$p" > /dev/null || return 1
  local liste; liste=$(dpkg-deb --contents "$p")
  for f in usr/bin/diagweb-server usr/lib/systemd/system/diagweb.service \
           etc/default/diagweb usr/share/diagweb/web/index.html \
           usr/share/diagweb/dist/index.html; do
    echo "$liste" | grep -q " ./$f\$" || { echo "absent du paquet : $f"; return 1; }
  done
  echo "$p"
}

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
  # Les .mjs de l'outillage et des tests n'étaient vérifiés nulle part : une
  # faute de frappe n'apparaissait qu'à l'exécution, et jamais du tout pour
  # ceux que la CI ne joue pas (tools/bench.mjs, tests/interop.mjs).
  for f in tools/*.mjs tests/*.mjs; do node --check "$f" || return 1; done
}

syntaxe_outillage() {
  local f
  python3 -m py_compile tools/*.py || return 1
  # .devcontainer aussi : une faute de frappe y casse tous les Codespaces neufs,
  # et le défaut ne se voit qu'à la création suivante. packaging/ de même : son
  # script arm64 ne s'exécute que dans un conteneur émulé, en intégration
  # continue — nulle part où découvrir une coquille plus tôt.
  for f in tools/*.sh .devcontainer/*.sh packaging/*.sh; do bash -n "$f" || return 1; done
}

entetes_generes() {
  python3 tools/gen-all.py > /dev/null &&
  git diff --quiet -- server/src/catalog.generated.hpp server/src/protocols.generated.hpp
}

configurer() {
  [ -d "$BUILD" ] && meson setup "$BUILD" --reconfigure || meson setup "$BUILD"
}

# --------------------------------------------------------------- serveur
if [ "$CIBLE" = tout ] || [ "$CIBLE" = serveur ]; then
  titre "Serveur de diagnostic (C++23, Meson)"
  etape "configuration" configurer
  etape "compilation (avertissements = erreurs)" meson compile -C "$BUILD"
  # meson test enchaîne le décodage et le simulateur d'équipements, puis les
  # vérifications qui demandent le serveur en fonctionnement (liens réseau —
  # simulateur compris —, forçage, journalisation).
  etape "tests du serveur (décodage, simulateur, liens réseau, forçage, journalisation, page servie)" \
    meson test -C "$BUILD" --suite serveur --print-errorlogs
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

# ------------------------------------------------------------------- paquet
# Hors du parcours par défaut : la construction du paquet recompile tout dans
# son propre dossier, et l'intégration continue s'en charge à chaque poussée.
# Ici pour l'éprouver avant de toucher au conditionnement lui-même.
if [ "$CIBLE" = paquet ]; then
  titre "Paquet d'installation (.deb)"
  DEBUT_PAQUET=$(date +%s)
  etape "construction du paquet pour cette machine" bash tools/package-deb.sh
  etape "paquet lisible par dpkg et complet" verifier_paquet
fi

printf '\n'
if [ "$ECHECS" -eq 0 ]; then
  printf '\033[32mToutes les vérifications sont passées.\033[0m\n'
else
  printf '\033[31m%d vérification(s) en échec.\033[0m Relancer la commande fautive pour le détail.\n' "$ECHECS"
fi
exit $((ECHECS > 0))
