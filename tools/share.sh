#!/usr/bin/env bash
# Diagweb — rend l'aperçu accessible depuis n'importe quel navigateur.
# Démarre le serveur si besoin, passe le port en « public », affiche l'URL.
#
#   bash tools/share.sh              aperçu statique (Python, simulation navigateur)
#   bash tools/share.sh --server     serveur de diagnostic C++ (flux WebSocket)
set -uo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8080}"
MODE="apercu"
[ "${1:-}" = "--server" ] && MODE="serveur"

listening() {
  python3 - "$PORT" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket()
s.settimeout(0.5)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PY
}

# Processus qui écoutent sur $PORT, trouvés par /proc — sans outil externe.
#
# « ss » (iproute2) ferait l'affaire, mais n'est pas garanti présent : son
# absence rendait liberer_port() muette, et le symptôme était trompeur. Le
# serveur échouait à se lier, l'aperçu Python répondait toujours, listening()
# le voyait — share.sh annonçait donc un démarrage réussi tout en continuant
# de servir la simulation. Le noyau, lui, est toujours là.
port_owners() {
  python3 - "$PORT" <<'PY' 2>/dev/null
import os, sys

port = int(sys.argv[1])

# Sockets en écoute (état 0A) sur ce port, tables IPv4 et IPv6.
inodes = set()
for table in ("/proc/net/tcp", "/proc/net/tcp6"):
    try:
        with open(table) as f:
            next(f, None)                        # ligne d'en-tête
            for line in f:
                col = line.split()
                if (len(col) > 9 and col[3] == "0A"
                        and int(col[1].rsplit(":", 1)[1], 16) == port):
                    inodes.add(col[9])
    except OSError:
        pass

# Propriétaires de ces sockets : un descripteur pointe « socket:[inode] ».
for pid in sorted(os.listdir("/proc")):
    if not pid.isdigit():
        continue
    try:
        fds = os.listdir(f"/proc/{pid}/fd")
    except OSError:
        continue                                 # disparu, ou pas à nous
    for fd in fds:
        try:
            cible = os.readlink(f"/proc/{pid}/fd/{fd}")
        except OSError:
            continue
        if cible.startswith("socket:[") and cible[8:-1] in inodes:
            print(pid)
            break
PY
}

# Libère le port avant de démarrer autre chose dessus.
#
# On vise le processus qui ÉCOUTE, jamais un motif de ligne de commande :
# « pkill -f tools/serve.py » attrape aussi le shell dont la commande contient
# ce texte — y compris celui qui exécute ce script. Tuer son propre terminal
# est vite arrivé, et le symptôme n'a alors plus rien à voir avec la cause.
#
# Ne rend la main que lorsque le port est réellement libre : démarrer sur un
# port encore pris était précisément le défaut décrit au-dessus.
#
# L'attente interroge port_owners, pas listening() : « quelqu'un tient-il ce
# port ? » et « ça répond ? » sont deux questions différentes. Un serveur dont
# la file d'attente est pleine, ou simplement bloqué, garde le port sans plus
# accepter de connexion — la sonde le croirait parti, et on repartirait sur le
# faux succès qu'on cherche justement à supprimer.
liberer_port() {
  local pid essai restants
  for pid in $(port_owners); do
    [ "$pid" = "$$" ] && continue
    kill "$pid" 2> /dev/null
  done
  for essai in 1 2 3 4 5 6 7 8 9 10; do
    [ -z "$(port_owners)" ] && return 0
    sleep 0.2
  done
  restants=$(port_owners | tr '\n' ' ')
  restants=${restants% }
  echo "   Le port $PORT reste occupé${restants:+ (processus $restants)}."
  echo "   L'arrêter, ou viser un autre port : PORT=8081 bash tools/share.sh --server"
  return 1
}

if [ "$MODE" = "serveur" ]; then
  # 1. Compilation du serveur de diagnostic si nécessaire
  if [ ! -x build/diagweb-server ]; then
    echo "→ Compilation du serveur de diagnostic"
    # Nommer l'outil qui manque, pas la paire : « meson ou g++ absent » laissait
    # chercher lequel des deux, alors que la réponse est immédiate.
    MANQUE=""
    for outil in g++ meson ninja; do
      command -v "$outil" > /dev/null || MANQUE="$MANQUE $outil"
    done
    if [ -n "$MANQUE" ]; then
      echo "   Outil(s) absent(s) :$MANQUE"
      echo "     sudo apt-get update && sudo apt-get install -y build-essential meson ninja-build"
      echo "   Dans un Codespace, cela veut souvent dire que .devcontainer/ n'a pas"
      echo "   été appliqué : Palette de commandes → « Codespaces: Rebuild Container »."
      exit 1
    fi
    meson setup build > /dev/null || exit 1
    meson compile -C build > /dev/null || exit 1
  fi
  # 2. Un aperçu Python occupe peut-être déjà le port : postAttachCommand le
  #    lance à l'attachement, sans argument « --port ».
  liberer_port || exit 1
  echo "→ Démarrage du serveur de diagnostic (port $PORT)"
  nohup ./build/diagweb-server --port "$PORT" --root . --data-dir .diag-data \
    > /tmp/diagweb-server.log 2>&1 &
  sleep 1.2
  if ! listening; then
    echo "   Échec du démarrage :"
    sed 's/^/     /' /tmp/diagweb-server.log
    exit 1
  fi
elif ! listening; then
  echo "→ Démarrage de l'aperçu statique (port $PORT)"
  nohup python3 tools/serve.py --port "$PORT" > /tmp/diagweb-serve.log 2>&1 &
  sleep 1
fi

# 3. Hors Codespace : rien à transférer
if [ -z "${CODESPACE_NAME:-}" ]; then
  echo
  echo "Pas dans un Codespace — accès local ($MODE) :"
  python3 tools/serve.py --port "$PORT" --url | sed 's/^/   /'
  exit 0
fi

# 4. Port en visibilité publique (peut être refusé par la politique de l'organisation)
echo "→ Passage du port $PORT en public"
if gh codespace ports visibility "$PORT:public" -c "$CODESPACE_NAME" 2>/tmp/diagweb-gh.log; then
  VISIBILITE="public — ouvrable depuis n'importe quel navigateur"
else
  echo "   (refusé : $(tr -d '\n' < /tmp/diagweb-gh.log))"
  echo "   Le port reste privé : l'adresse fonctionne quand même si vous"
  echo "   êtes connecté au même compte GitHub."
  VISIBILITE="privé — nécessite d'être connecté à GitHub"
fi

echo
echo "────────────────────────────────────────────────────────────────"
echo " Diagweb — $MODE ($VISIBILITE)"
echo
python3 tools/serve.py --port "$PORT" --url | sed 's/^/   /'
if [ "$MODE" = "serveur" ]; then
  echo
  echo "   Flux temps réel WebSocket actif (barre d'état : « Serveur de"
  echo "   diagnostic »). Ajouter ?src=sim à l'URL pour comparer avec la"
  echo "   simulation du navigateur."
fi
echo
echo " Pour revenir en privé :"
echo "   gh codespace ports visibility $PORT:private -c \$CODESPACE_NAME"
echo "────────────────────────────────────────────────────────────────"
