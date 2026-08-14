#!/usr/bin/env bash
# Diagweb — vérifications qui demandent le serveur en fonctionnement.
#
# Lance diagweb-server sur un port libre, attend qu'il réponde, joue
# tests/protocols.mjs puis tests/server.mjs, et l'arrête quoi qu'il arrive.
# Appelé par `meson test`, utilisable seul.
set -uo pipefail
cd "$(dirname "$0")/.."

BIN="${DIAGWEB_SERVER_BIN:-}"
if [ -z "$BIN" ]; then
  for c in build/diagweb-server server/build/diagweb-server; do
    [ -x "$c" ] && BIN="$c" && break
  done
fi
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "diagweb-server introuvable — construire d'abord (meson compile -C build)" >&2
  exit 1
fi

PORT="${DIAGWEB_PORT:-8080}"
DATA=$(mktemp -d)
# Phrases secrètes de l'agent SNMPv3 de test : jamais dans la configuration,
# toujours dans l'environnement du serveur — comme en exploitation.
export DIAGWEB_SECRET_AGENT_AUTH=motdepasseauth
export DIAGWEB_SECRET_AGENT_PRIV=motdepassepriv
SRV=""
trap 'kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; rm -rf "$DATA"' EXIT

# Le serveur est lancé deux fois sur le MÊME dossier de données : le second
# départ vérifie que les réglages persistants (quota et déclencheur de
# capture) ont bien survécu à l'arrêt.
demarrer() {
  "$BIN" --port "$PORT" --root . --data-dir "$DATA" > /tmp/diagweb-test-server.log 2>&1 &
  SRV=$!
  for _ in $(seq 1 60); do
    curl -sf "http://localhost:$PORT/api/health" > /dev/null && return 0
    sleep 0.25
  done
  echo "le serveur n'a pas démarré :" >&2
  cat /tmp/diagweb-test-server.log >&2
  return 1
}

demarrer || exit 1

ECHECS=0
node tests/protocols.mjs "http://localhost:$PORT" || ECHECS=$((ECHECS + 1))
node tests/server.mjs "http://localhost:$PORT" || ECHECS=$((ECHECS + 1))

kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; SRV=""
echo ""
echo "=== redémarrage du serveur (persistance des réglages) ==="
demarrer || exit 1
node tests/server.mjs "http://localhost:$PORT" --apres-redemarrage || ECHECS=$((ECHECS + 1))

exit $((ECHECS > 0))
