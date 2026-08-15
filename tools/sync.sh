#!/usr/bin/env bash
# Diagweb — resynchronisation complète du Codespace sur main.
#
#   bash tools/sync.sh                 coupe tout, synchronise, recompile, relance
#   bash tools/sync.sh --watch [N]     en boucle, toutes les N secondes (60 par défaut)
#   bash tools/sync.sh --no-relaunch   s'arrête après la recompilation
#
# Ce que fait une resynchronisation, dans cet ordre :
#
#   1. ARRÊT PROPRE des enregistrements — campagnes de journalisation et
#      captures de trames, par leur point d'entrée REST et non à coups de
#      signal : un CSV ou un pcap fermé proprement reste exploitable, tué en
#      pleine écriture il est tronqué. Couper n'oblige pas à détruire.
#   2. ARRÊT des processus : banc d'essai, simulateur d'équipements, serveur de
#      diagnostic, aperçu statique. Ce qui tournait est noté pour être remonté.
#   3. SYNCHRONISATION git (avance rapide sur origin/main).
#   4. RECOMPILATION, systématique — pas de tri par diff : quand on demande une
#      remise à niveau, on veut la certitude, pas une déduction.
#   5. RELANCE de tout ce qui tournait avant, à l'identique.
#
# Deux garde-fous restent, parce qu'ils protègent TON travail et non le confort
# du script : un arbre modifié localement n'est jamais écrasé, et un historique
# divergent n'est jamais fusionné d'office.
set -uo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"
BOUCLE=0
INTERVALLE=60
RELANCER=1

aide() {
  cat <<'TXT'
Diagweb — resynchronisation complète du Codespace sur main.

  bash tools/sync.sh                 coupe tout, synchronise, recompile, relance
  bash tools/sync.sh --watch [N]     en boucle, toutes les N secondes (60 par défaut)
  bash tools/sync.sh --no-relaunch   s'arrête après la recompilation
  bash tools/sync.sh --help          cette aide

Ce qu'une resynchronisation fait, dans cet ordre :

  1. arrête PROPREMENT les enregistrements — campagnes de journalisation et
     captures de trames, par leur point d'entrée REST et non à coups de signal :
     un CSV ou un pcap fermé proprement reste exploitable et téléchargeable,
     tué en pleine écriture il est tronqué ;
  2. arrête les processus : banc d'essai, simulateur d'équipements, serveur de
     diagnostic, aperçu statique. Ce qui tournait est noté ;
  3. synchronise git (avance rapide sur origin/main) ;
  4. RECOMPILE systématiquement — pas de tri par diff : on veut la certitude ;
  5. relance tout ce qui tournait avant, à l'identique. Ce qui ne tournait pas
     ne remonte pas.

Deux refus, qui protègent ton travail et non le confort du script :

  · un arbre modifié localement n'est jamais écrasé ;
  · un historique divergent n'est jamais fusionné d'office (pousse tes commits,
    ou « git rebase origin/main » à la main).

Variables d'environnement :

  PORT        port du serveur de diagnostic et de l'aperçu   (défaut 8080)
  PORT_SIMU   port du simulateur d'équipements               (défaut 5020)

Journaux : /tmp/diagweb-server.log · /tmp/diagweb-bench.log
           /tmp/diagweb-simulator.log · /tmp/diagweb-serve.log
TXT
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)     aide; exit 0 ;;
    --watch)       BOUCLE=1
                   case "${2:-}" in [0-9]*) INTERVALLE=$2; shift ;; esac ;;
    --no-relaunch) RELANCER=0 ;;
    *) echo "option inconnue : $1" >&2
       echo >&2
       aide >&2
       exit 2 ;;
  esac
  shift
done

# Ports fixes du banc d'essai (tools/bench.mjs) et du simulateur d'équipements.
PORTS_BANC="15020 12404 11161 11162 10102 14840"
PORT_SIMU="${PORT_SIMU:-5020}"

# --------------------------------------------------------------- utilitaires

# Requête REST. python3 est déjà exigé par meson ; curl ne l'est pas.
api() {
  DIAGWEB_M="${2:-GET}" DIAGWEB_B="${3:-}" python3 - "$PORT" "$1" <<'PY' 2>/dev/null
import os, sys, urllib.request
url = "http://127.0.0.1:%s%s" % (sys.argv[1], sys.argv[2])
corps = os.environ.get("DIAGWEB_B", "")
req = urllib.request.Request(
    url, method=os.environ.get("DIAGWEB_M", "GET"),
    data=corps.encode() if corps else None,
    headers={"Content-Type": "application/json"} if corps else {})
try:
    with urllib.request.urlopen(req, timeout=3) as r:
        sys.stdout.write(r.read().decode("utf-8", "replace"))
except Exception:
    sys.exit(1)
PY
}

# Propriétaires d'un port, par /proc — sans dépendre d'iproute2, et sans jamais
# viser un motif de ligne de commande : « pkill -f node » emporterait le shell
# qui exécute ce script, dont la ligne de commande contient ce motif.
proprietaires() {
  python3 - "$1" <<'PY' 2>/dev/null
import os, sys
port = int(sys.argv[1]); inodes = set()
for table in ("/proc/net/tcp", "/proc/net/tcp6", "/proc/net/udp", "/proc/net/udp6"):
    try:
        with open(table) as f:
            next(f, None)
            for ligne in f:
                col = ligne.split()
                if len(col) > 9 and int(col[1].rsplit(":", 1)[1], 16) == port:
                    inodes.add(col[9])
    except OSError:
        pass
if not inodes:
    sys.exit(0)
for pid in sorted(os.listdir("/proc")):
    if not pid.isdigit():
        continue
    try:
        fds = os.listdir("/proc/%s/fd" % pid)
    except OSError:
        continue
    for fd in fds:
        try:
            cible = os.readlink("/proc/%s/fd/%s" % (pid, fd))
        except OSError:
            continue
        if cible.startswith("socket:[") and cible[8:-1] in inodes:
            print(pid)
            break
PY
}

# Arrête ce qui tient un port : SIGTERM d'abord — le banc s'en sert pour fermer
# ses équipements et effacer son dossier temporaire — puis SIGKILL s'il insiste.
couper_port() {
  local pid
  for pid in $(proprietaires "$1"); do
    [ "$pid" = "$$" ] && continue
    kill "$pid" 2> /dev/null
  done
  sleep 0.5
  for pid in $(proprietaires "$1"); do
    [ "$pid" = "$$" ] && continue
    kill -9 "$pid" 2> /dev/null
  done
}

# Arrêt PROPRE des enregistrements, par l'API : les fichiers sont fermés et
# restent téléchargeables. C'est la différence entre couper et détruire.
arreter_enregistrements() {
  local etat
  etat=$(api /api/datalog) || return 0

  DIAGWEB_DL="$etat" python3 - <<'PY' | while read -r nom; do
import json, os
try:
    for c in json.loads(os.environ.get('DIAGWEB_DL', '') or '[]'):
        if isinstance(c, dict) and c.get('name'):
            print(c['name'])
except Exception:
    pass
PY
    printf '   ⏹ campagne « %s » arrêtée proprement\n' "$nom"
    api /api/datalog/stop POST "{\"name\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$nom")}" > /dev/null
  done

  etat=$(api /api/capture) || return 0
  DIAGWEB_CAP="$etat" python3 - <<'PY' | while read -r id; do
import json, os
try:
    for r in (json.loads(os.environ.get('DIAGWEB_CAP', '') or '{}').get('runs') or []):
        if isinstance(r, dict) and r.get('state') == 'en cours' and r.get('id'):
            print(r['id'])
except Exception:
    pass
PY
    printf '   ⏹ capture « %s » arrêtée proprement\n' "$id"
    api /api/capture/stop POST "{\"id\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$id")}" > /dev/null
  done
}

# --------------------------------------------------------------- une passe

une_passe() {
  local avant apres serveur=0 banc=0 simu=0 apercu=0 p

  if [ -n "$(git status --porcelain)" ]; then
    echo "⚠ Modifications locales non commitées — rien n'est touché."
    git status --short | sed 's/^/    /'
    return 1
  fi

  git fetch -q origin main 2> /dev/null ||
    { echo "⚠ « git fetch » a échoué (réseau ?)"; return 1; }

  avant=$(git rev-parse HEAD)
  apres=$(git rev-parse origin/main)

  if ! git merge-base --is-ancestor "$avant" "$apres"; then
    echo "⚠ Historique divergent : des commits locaux ne sont pas sur origin/main."
    echo "  Les pousser, ou « git rebase origin/main » à la main."
    return 1
  fi

  # En surveillance, ne RIEN faire tant qu'il n'y a pas de commit neuf.
  #
  # Appelé à la main, « sync.sh » coupe et relance même sans commit : c'est ce
  # qu'on veut quand on doute de ce que contient le binaire en mémoire. Appliqué
  # en boucle, ce même comportement redémarrerait serveur, banc et simulateur
  # toutes les N secondes — il couperait le flux temps réel du navigateur en
  # permanence, pour rien. La surveillance ne réagit donc qu'à un vrai commit.
  if [ "$BOUCLE" = 1 ] && [ "$avant" = "$apres" ]; then
    return 0
  fi

  # 1 & 2 — inventaire de ce qui tourne, puis arrêt.
  api /api/health > /dev/null && serveur=1
  for p in $PORTS_BANC; do [ -n "$(proprietaires "$p")" ] && banc=1 && break; done
  [ -n "$(proprietaires "$PORT_SIMU")" ] && simu=1
  [ "$serveur" = 0 ] && [ -n "$(proprietaires "$PORT")" ] && apercu=1

  if [ "$serveur$banc$simu$apercu" != "0000" ]; then
    echo "→ Arrêt de ce qui tourne"
    [ "$serveur" = 1 ] && arreter_enregistrements
    [ "$banc" = 1 ] && { echo "   ⏹ banc d'essai"; for p in $PORTS_BANC; do couper_port "$p"; done; }
    [ "$simu" = 1 ] && { echo "   ⏹ simulateur d'équipements"; couper_port "$PORT_SIMU"; }
    [ "$serveur" = 1 ] && echo "   ⏹ serveur de diagnostic"
    [ "$apercu" = 1 ] && echo "   ⏹ aperçu statique"
    couper_port "$PORT"
  fi

  # 3 — synchronisation.
  if [ "$avant" != "$apres" ]; then
    echo "→ $(git rev-list --count "$avant".."$apres") commit(s) à appliquer :"
    git log --format='    %h %s' "$avant".."$apres" | head -12
    git merge --ff-only -q "$apres" || { echo "⚠ avance rapide impossible"; return 1; }
    git diff --name-only "$avant" "$apres" | grep -q '^\.devcontainer/' &&
      echo "  ⚠ .devcontainer modifié — seul « Codespaces: Rebuild Container » l'applique."
  else
    echo "→ Aucun commit neuf ($(git rev-parse --short HEAD)) — remise à niveau quand même."
  fi

  # 4 — recompilation systématique.
  echo "→ Recompilation"
  [ -d build ] || meson setup build > /dev/null 2>&1
  if ! meson compile -C build 2>&1 | tail -3 | sed 's/^/    /'; then
    echo "  ⚠ compilation en échec — rien n'est relancé."
    return 1
  fi

  # 5 — relance à l'identique.
  if [ "$RELANCER" = 0 ]; then
    echo "  (--no-relaunch : rien n'est remonté)"
  elif [ "$serveur$banc$simu$apercu" = "0000" ]; then
    echo "  (rien ne tournait — rien à remonter)"
  else
    echo "→ Relance"
    if [ "$serveur" = 1 ]; then
      bash tools/share.sh --server --local > /dev/null 2>&1 &&
        echo "   ▶ serveur de diagnostic (port $PORT)" ||
        echo "   ⚠ serveur de diagnostic : échec (voir /tmp/diagweb-server.log)"
    elif [ "$apercu" = 1 ]; then
      bash tools/share.sh --local > /dev/null 2>&1 && echo "   ▶ aperçu statique (port $PORT)"
    fi
    if [ "$simu" = 1 ]; then
      nohup ./build/diagweb-simulator --port "$PORT_SIMU" > /tmp/diagweb-simulator.log 2>&1 &
      sleep 0.6; echo "   ▶ simulateur d'équipements (port $PORT_SIMU)"
    fi
    if [ "$banc" = 1 ]; then
      nohup node tools/bench.mjs > /tmp/diagweb-bench.log 2>&1 &
      # Le banc pose ses liens dans le serveur : il lui faut un serveur debout.
      sleep 6; echo "   ▶ banc d'essai (journal : /tmp/diagweb-bench.log)"
    fi
  fi

  echo "✓ À jour : $(git rev-parse --short HEAD)"
  return 0
}

if [ "$BOUCLE" = 0 ]; then
  une_passe
  exit $?
fi

# ------------------------------------------------------------ surveillance

# Une seule surveillance à la fois. post-attach.sh lance celle-ci à CHAQUE
# attachement au Codespace : sans ce verrou, ouvrir trois onglets donnerait
# trois boucles qui se disputeraient le dépôt et les ports. Le verrou est un
# fichier de PID, vérifié par kill -0 — pas un motif de ligne de commande, qui
# attraperait le shell exécutant ce script.
VERROU="${DIAGWEB_WATCH_PID:-/tmp/diagweb-watch.pid}"
if [ -f "$VERROU" ]; then
  autre=$(cat "$VERROU" 2> /dev/null)
  if [ -n "$autre" ] && [ "$autre" != "$$" ] && kill -0 "$autre" 2> /dev/null; then
    echo "Une surveillance tourne déjà (pid $autre) — rien à faire."
    exit 0
  fi
fi
echo $$ > "$VERROU"
trap 'rm -f "$VERROU"; echo; echo "Surveillance arrêtée."; exit 0' INT TERM
trap 'rm -f "$VERROU"' EXIT

echo "Surveillance de origin/main toutes les ${INTERVALLE} s (pid $$)."
echo "Rien ne bouge tant qu'aucun commit n'arrive. Ctrl-C pour arrêter."
derniere=""
while true; do
  # Horodatage seulement quand il se passe quelque chose : une boucle qui écrit
  # une ligne par minute noie le journal et rend illisible ce qui compte.
  #
  # Et une sortie IDENTIQUE à la précédente n'est pas répétée : un arbre
  # modifié localement ou un historique divergent dure des heures, et le
  # signaler toutes les minutes enterrerait le seul message qui compte — celui
  # d'un commit réellement appliqué. Le message revient si l'état change puis
  # se reproduit.
  sortie=$(une_passe 2>&1)
  if [ -n "$sortie" ] && [ "$sortie" != "$derniere" ]; then
    printf '\n──── %s ────\n%s\n' "$(date '+%F %T')" "$sortie"
  fi
  derniere="$sortie"
  sleep "$INTERVALLE"
done
