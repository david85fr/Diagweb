#!/usr/bin/env bash
# Diagweb — rend l'aperçu accessible depuis n'importe quel navigateur.
# Démarre le serveur si besoin, passe le port en « public », affiche l'URL.
set -uo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8080}"

# 1. Serveur d'aperçu en écoute ?
if ! python3 - "$PORT" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket()
s.settimeout(0.5)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PY
then
  echo "→ Démarrage du serveur d'aperçu (port $PORT)"
  nohup python3 tools/serve.py --port "$PORT" > /tmp/diagweb-serve.log 2>&1 &
  sleep 1
fi

# 2. Hors Codespace : rien à transférer
if [ -z "${CODESPACE_NAME:-}" ]; then
  echo
  echo "Pas dans un Codespace — aperçu local :"
  python3 tools/serve.py --port "$PORT" --url | sed 's/^/   /'
  exit 0
fi

# 3. Port en visibilité publique (peut être refusé par la politique de l'organisation)
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
echo " Aperçu Diagweb ($VISIBILITE)"
echo
python3 tools/serve.py --port "$PORT" --url | sed 's/^/   /'
echo
echo " Pour revenir en privé :"
echo "   gh codespace ports visibility $PORT:private -c \$CODESPACE_NAME"
echo "────────────────────────────────────────────────────────────────"
