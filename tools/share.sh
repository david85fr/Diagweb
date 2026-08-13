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

if [ "$MODE" = "serveur" ]; then
  # 1. Compilation du serveur de diagnostic si nécessaire
  if [ ! -x server/build/diagweb-server ]; then
    echo "→ Compilation du serveur de diagnostic"
    if ! command -v meson > /dev/null || ! command -v g++ > /dev/null; then
      echo "   meson ou g++ absent. Installez-les :"
      echo "     sudo apt-get update && sudo apt-get install -y build-essential meson ninja-build"
      echo "   (ou reconstruisez le Codespace : image C++ configurée dans .devcontainer/)"
      exit 1
    fi
    meson setup build > /dev/null || exit 1
    meson compile -C build > /dev/null || exit 1
  fi
  # 2. Un aperçu Python occupe peut-être déjà le port
  pkill -f "tools/serve.py --port $PORT" 2>/dev/null
  pkill -f "diagweb-server --port $PORT" 2>/dev/null
  sleep 0.5
  echo "→ Démarrage du serveur de diagnostic (port $PORT)"
  nohup ./server/build/diagweb-server --port "$PORT" --root . --data-dir .diag-data \
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
