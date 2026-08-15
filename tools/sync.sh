#!/usr/bin/env bash
# Diagweb — remettre le Codespace à niveau après un commit poussé sur main.
#
#   bash tools/sync.sh                récupère, recompile et relance si besoin
#   bash tools/sync.sh --watch [N]    boucle toutes les N secondes (60 par défaut)
#   bash tools/sync.sh --no-restart   ne touche pas au serveur en fonctionnement
#   bash tools/sync.sh --force        relance même si un enregistrement est en cours
#
# Pourquoi un script et pas un simple « git pull »
# -----------------------------------------------
# Un commit peut toucher trois choses qui ne se rattrapent pas de la même
# façon, et le savoir se perd vite :
#
#   server/, meson.build   → il faut RECOMPILER, sinon le binaire en mémoire
#                            reste l'ancien et on croit tester le nouveau ;
#   web/, dist/            → rien à compiler, mais l'onglet ouvert sert encore
#                            l'ancienne page : il faut le RECHARGER ;
#   .devcontainer/         → seul un « Rebuild Container » les applique.
#
# Ce qui n'est PAS automatique, et volontairement
# ----------------------------------------------
# Le mode par défaut ne tourne qu'à la demande. Une récupération automatique
# permanente déciderait à ta place d'écraser un travail local ou d'interrompre
# le serveur au mauvais moment ; --watch existe pour qui veut ce comportement,
# en le sachant.
#
# Et surtout : un redémarrage COUPE une campagne de journalisation autonome ou
# une capture en cours — précisément les mesures longues qu'on lance parce
# qu'on ne peut pas rester devant. Le script les détecte et refuse, sauf
# --force. Perdre une capture d'un défaut rare pour appliquer un commit serait
# un mauvais marché.
set -uo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"
BOUCLE=0
INTERVALLE=60
RELANCER=1
FORCER=0

while [ $# -gt 0 ]; do
  case "$1" in
    --watch)      BOUCLE=1
                  case "${2:-}" in [0-9]*) INTERVALLE=$2; shift ;; esac ;;
    --no-restart) RELANCER=0 ;;
    --force)      FORCER=1 ;;
    *) echo "option inconnue : $1" >&2
       echo "usage : bash tools/sync.sh [--watch [N]] [--no-restart] [--force]" >&2
       exit 2 ;;
  esac
  shift
done

# Interrogation du serveur : python3 est déjà exigé par meson, curl ne l'est pas.
api() {
  python3 - "$PORT" "$1" <<'PY' 2>/dev/null
import sys, urllib.request
try:
    with urllib.request.urlopen(
            "http://127.0.0.1:%s%s" % (sys.argv[1], sys.argv[2]), timeout=2) as r:
        sys.stdout.write(r.read().decode("utf-8", "replace"))
except Exception:
    sys.exit(1)
PY
}

# Un enregistrement long est-il en cours ? Campagne de journalisation autonome
# (/api/datalog rend la liste des campagnes ACTIVES) ou capture de trames
# (un run porte l'état « en cours »).
#
# Le JSON passe par l'ENVIRONNEMENT, pas par interpolation dans le source
# Python : la citation du shell n'est pas celle de Python, et un nom de
# campagne contenant une apostrophe suffirait à casser le script — ou pire, à
# lui faire exécuter autre chose.
enregistrement_en_cours() {
  local dl cap
  dl=$(api /api/datalog) || return 1
  cap=$(api /api/capture) || cap=''
  DIAGWEB_DL="$dl" DIAGWEB_CAP="$cap" python3 - <<'PY'
import json, os, sys

def charge(txt):
    try:
        return json.loads(txt) if txt.strip() else None
    except Exception:
        return None

campagnes = charge(os.environ.get('DIAGWEB_DL', '')) or []
capture = charge(os.environ.get('DIAGWEB_CAP', '')) or {}

noms = [c.get('name', '?') for c in campagnes if isinstance(c, dict)]
runs = [r.get('iface', '?') for r in (capture.get('runs') or [])
        if isinstance(r, dict) and r.get('state') == 'en cours']

quoi = []
if noms:
    quoi.append('journalisation : ' + ', '.join(noms))
if runs:
    quoi.append('capture : ' + ', '.join(runs))
if quoi:
    print(' · '.join(quoi))
    sys.exit(0)
sys.exit(1)
PY
}

une_passe() {
  local avant apres fichiers recompiler=0 relancer=0

  # Un arbre modifié n'est pas à nous : on ne l'écrase jamais en silence.
  if [ -n "$(git status --porcelain)" ]; then
    echo "⚠ Modifications locales non commitées — rien n'est récupéré."
    git status --short | sed 's/^/    /'
    return 1
  fi

  git fetch -q origin main 2>/dev/null || { echo "⚠ « git fetch » a échoué (réseau ?)"; return 1; }

  avant=$(git rev-parse HEAD)
  apres=$(git rev-parse origin/main)
  [ "$avant" = "$apres" ] && { echo "Déjà à jour ($(git rev-parse --short HEAD))."; return 0; }

  # Des commits locaux non poussés interdisent l'avance rapide : on préfère le
  # dire plutôt que de fabriquer une fusion que personne n'a demandée.
  if ! git merge-base --is-ancestor "$avant" "$apres"; then
    echo "⚠ Historique divergent : des commits locaux ne sont pas sur origin/main."
    echo "  Les pousser, ou « git rebase origin/main » à la main."
    return 1
  fi

  echo "→ $(git rev-list --count "$avant".."$apres") commit(s) à appliquer :"
  git log --format='    %h %s' "$avant".."$apres" | head -12

  git merge --ff-only -q "$apres" || { echo "⚠ avance rapide impossible"; return 1; }

  fichiers=$(git diff --name-only "$avant" "$apres")
  grep -qE '^(server/|meson\.build|meson_options\.txt|simulator/|tests/.*\.cpp)' <<< "$fichiers" && recompiler=1
  grep -q '^\.devcontainer/' <<< "$fichiers" &&
    echo "  ⚠ .devcontainer modifié — seul « Codespaces: Rebuild Container » l'applique."
  grep -qE '^(web/|dist/)' <<< "$fichiers" &&
    echo "  ↻ interface modifiée — recharger l'onglet du navigateur."

  if [ "$recompiler" = 1 ]; then
    echo "→ Recompilation du serveur de diagnostic"
    if [ ! -d build ]; then meson setup build > /dev/null 2>&1; fi
    if meson compile -C build 2>&1 | tail -3 | sed 's/^/    /'; then
      relancer=1
    else
      echo "  ⚠ compilation en échec — le serveur en place n'est pas touché."
      return 1
    fi
  fi

  if [ "$relancer" = 1 ] && [ "$RELANCER" = 1 ]; then
    if api /api/health > /dev/null; then
      local occupe
      if occupe=$(enregistrement_en_cours) && [ "$FORCER" = 0 ]; then
        echo "  ⚠ Enregistrement en cours ($occupe) — serveur NON relancé."
        echo "    Le binaire est à jour mais le processus reste l'ancien."
        echo "    Relancer quand la mesure est finie : bash tools/share.sh --server --local --restart"
      else
        echo "→ Relance du serveur (binaire à jour)"
        bash tools/share.sh --server --local --restart 2>&1 | head -2 | sed 's/^/    /'
      fi
    else
      echo "  (aucun serveur en fonctionnement — rien à relancer)"
    fi
  elif [ "$relancer" = 1 ]; then
    echo "  (--no-restart : le serveur en place reste l'ancien binaire)"
  fi

  echo "✓ À jour : $(git rev-parse --short HEAD)"
  return 0
}

if [ "$BOUCLE" = 0 ]; then
  une_passe
  exit $?
fi

echo "Surveillance de origin/main toutes les ${INTERVALLE} s — Ctrl-C pour arrêter."
trap 'echo; echo "Surveillance arrêtée."; exit 0' INT TERM
while true; do
  une_passe
  sleep "$INTERVALLE"
done
