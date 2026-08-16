#!/usr/bin/env bash
# Diagweb — rend l'aperçu accessible depuis n'importe quel navigateur.
# Démarre le serveur si besoin, passe le port en « public », affiche l'URL.
#
#   bash tools/share.sh              aperçu statique (Python, simulation navigateur)
#   bash tools/share.sh --server     serveur de diagnostic C++ (flux WebSocket)
#   bash tools/share.sh --local      démarre sans toucher à la visibilité du port
#   bash tools/share.sh --no-restart laisse tranquille un serveur déjà debout
#   bash tools/share.sh --help       aide détaillée
#
# La RELANCE EST LE DÉFAUT : « --server » arrête ce qui tourne et repart, pour
# qu'on sache toujours quel binaire est en mémoire. L'exception s'écrit
# --no-restart, et post-attach.sh est seul à s'en servir : il rejoue ce script
# à chaque attachement au Codespace, où relancer d'office couperait une
# campagne de journalisation ou une capture à chaque reconnexion.
#
# --local existe pour ce même démarrage automatique : publier un port est une
# décision, pas un effet de bord d'un attachement. Le port reste privé —
# accessible en étant connecté au même compte GitHub — et « share.sh » sans
# cette option le publie quand tu le décides.
set -uo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8080}"
aide() {
  cat <<'TXT'
Diagweb — démarre une page servie, et affiche l'adresse pour l'ouvrir.

  bash tools/share.sh                aperçu statique, port publié
  bash tools/share.sh --server       serveur de diagnostic, port publié
  bash tools/share.sh --server --local   idem, port laissé privé
  bash tools/share.sh --help         cette aide

Ce script n'est PAS un serveur : c'est un lanceur. Il démarre l'un des deux
programmes du dépôt et s'occupe de la plomberie — compiler si besoin, arrêter
ce qui tourne, libérer le port, publier le port, afficher l'URL.

« --server » ARRÊTE ET RELANCE, toujours : après une recompilation comme après
un doute, on sait quel binaire répond. Pour ne pas toucher un serveur déjà
debout — un enregistrement peut être en cours —, voir --no-restart.

Les deux programmes, et ce qui les sépare :

  aperçu statique      tools/serve.py, en Python. Il ne sait que SERVIR DES
  (par défaut)         FICHIERS : la page tourne alors sur sa simulation
                       navigateur. Pour travailler le CSS, la mise en page,
                       les traductions.

  serveur de           build/diagweb-server, en C++. Il sert les mêmes fichiers
  diagnostic           ET le flux WebSocket, l'API REST, les pilotes réseau, le
  (--server)           forçage, la journalisation. Pour tout ce qui touche aux
                       vraies données.

Comment savoir lequel répond : la barre d'état en bas de page l'affiche, et
« curl -s localhost:8080/api/health » renvoie "role":"diag-server" — l'aperçu
Python, lui, ne sert aucune API.

Options :

  --server    lance le serveur de diagnostic au lieu de l'aperçu
  --local     ne touche PAS à la visibilité du port. Il reste privé, donc
              accessible en étant connecté au même compte GitHub. Publier un
              port expose le serveur à quiconque a l'adresse : c'est une
              décision, pas un effet de bord. (Attention au nom : « local » ne
              veut pas dire boucle locale — le serveur écoute sur toutes les
              interfaces et le transfert de port Codespaces reste actif.)
  --no-restart  ne touche pas à un serveur déjà en fonctionnement. Réservé au
              démarrage automatique du Codespace (post-attach.sh), rejoué à
              chaque attachement : y relancer d'office couperait une campagne
              de journalisation ou une capture à chaque reconnexion.
  --restart   accepté, sans effet : c'est devenu le comportement par défaut.

Variable d'environnement :

  PORT        port à utiliser (défaut 8080) — ex. PORT=8081 bash tools/share.sh

Voir aussi : bash tools/sync.sh --help (remise à niveau après un commit).
Journaux   : /tmp/diagweb-server.log · /tmp/diagweb-serve.log
TXT
}


# Simulateur d'équipements : le port que la fenêtre « Liens réseau » pré-remplit
# pour Modbus TCP (voir web/js/protocols.js). Il n'est jamais publié — c'est le
# serveur de diagnostic, sur la MÊME machine, qui s'y connecte.
SIM_PORT="${SIM_PORT:-5020}"
MODE="apercu"
PARTAGE=1
RELANCE=1        # relance par défaut : voir --no-restart
for arg in "$@"; do
  case "$arg" in
    -h|--help) aide; exit 0 ;;
    --server)  MODE="serveur" ;;
    --local)   PARTAGE=0 ;;
    # La relance est le DÉFAUT : « share.sh --server » arrête ce qui tourne et
    # repart, pour qu'on sache toujours quel binaire est en mémoire. --restart
    # reste accepté et ne fait rien de plus — il décrivait ce comportement
    # avant qu'il devienne la règle.
    --restart) RELANCE=1 ;;
    # L'exception, et elle a une raison précise : post-attach.sh rejoue ce
    # script à CHAQUE attachement au Codespace. Y relancer d'office couperait
    # une campagne de journalisation ou une capture à chaque reconnexion.
    --no-restart) RELANCE=0 ;;
    *) echo "option inconnue : $arg" >&2
       echo >&2
       aide >&2
       exit 2 ;;
  esac
done

# Le serveur de diagnostic répond-il déjà sur ce port — et non un aperçu
# statique ? C'est la seule question qui distingue « rien à faire » de « il
# faut démarrer », et /api/health y répond sans ambiguïté : l'aperçu Python
# ne sert aucune API.
serveur_deja_la() {
  python3 - "$PORT" <<'PY' 2>/dev/null
import json, sys, urllib.request

try:
    url = "http://127.0.0.1:%s/api/health" % sys.argv[1]
    with urllib.request.urlopen(url, timeout=1.5) as r:
        sys.exit(0 if json.load(r).get("role") == "diag-server" else 1)
except Exception:
    sys.exit(1)
PY
}

listening() { port_ouvert "$PORT"; }

port_ouvert() {
  python3 - "$1" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket()
s.settimeout(0.5)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PY
}

# Simulateur d'équipements : sans lui, l'adresse pré-remplie d'un lien Modbus
# neuf ne mène à rien, et l'utilisateur cherche la panne du côté du pilote.
# Démarré en local, jamais publié, et laissé tranquille s'il tourne déjà.
demarrer_simulateur() {
  [ -x build/diagweb-simulator ] || return 0
  if port_ouvert "$SIM_PORT"; then
    # --restart vient d'une recompilation : le simulateur qui tourne est alors
    # l'ANCIEN binaire, et le laisser en place ferait éprouver du code périmé.
    if [ "$RELANCE" = 0 ]; then
      echo "→ Simulateur d'équipements déjà en fonctionnement (port $SIM_PORT) — inchangé"
      return 0
    fi
    for pid in $(port_owners "$SIM_PORT"); do kill "$pid" 2> /dev/null; done
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      port_ouvert "$SIM_PORT" || break
      sleep 0.2
    done
  fi
  nohup ./build/diagweb-simulator --port "$SIM_PORT" --bind 127.0.0.1 --quiet \
    > /tmp/diagweb-simulator.log 2>&1 &
  sleep 0.6
  if port_ouvert "$SIM_PORT"; then
    echo "→ Simulateur d'équipements sur 127.0.0.1:$SIM_PORT (registres en dent de scie 1 → 10)"
  else
    echo "→ Simulateur d'équipements : démarrage impossible"
    sed 's/^/     /' /tmp/diagweb-simulator.log
  fi
}

# Processus qui écoutent sur $PORT, trouvés par /proc — sans outil externe.
#
# « ss » (iproute2) ferait l'affaire, mais n'est pas garanti présent : son
# absence rendait liberer_port() muette, et le symptôme était trompeur. Le
# serveur échouait à se lier, l'aperçu Python répondait toujours, listening()
# le voyait — share.sh annonçait donc un démarrage réussi tout en continuant
# de servir la simulation. Le noyau, lui, est toujours là.
port_owners() {
  python3 - "${1:-$PORT}" <<'PY' 2>/dev/null
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
  # 0. Capacité de capture. Posée ici plutôt qu'à la seule création du
  #    conteneur, parce que c'est ici qu'elle est REJOUÉE : ce script est
  #    appelé à chaque attachement (postAttachCommand) et à chaque
  #    synchronisation automatique (tools/sync.sh). Un Codespace déjà ouvert
  #    récupère donc la capacité tout seul, sans rien avoir à taper, et un
  #    conteneur né d'une image de prebuild qui n'aurait pas gardé l'attribut
  #    étendu la retrouve au démarrage suivant.
  #
  #    Silencieux quand elle est déjà là, sans effet ailleurs qu'en conteneur
  #    de développement — sur le contrôleur, c'est l'unité systemd qui donne
  #    CAP_NET_RAW au service (docs/PROTOCOLES.md).
  [ -f .devcontainer/cap-tcpdump.sh ] && bash .devcontainer/cap-tcpdump.sh

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
  # 2. Ne rien casser s'il tourne déjà. postAttachCommand rejoue ce script à
  #    CHAQUE attachement : redémarrer couperait une capture ou une campagne de
  #    journalisation en cours, et déconnecterait les navigateurs ouverts.
  if serveur_deja_la && [ "$RELANCE" = 0 ]; then
    echo "→ Serveur de diagnostic déjà en fonctionnement (port $PORT) — inchangé"
  else
    # Un aperçu Python occupe peut-être le port : il est démarré en repli quand
    # le serveur n'a pas pu être compilé.
    liberer_port || exit 1
    echo "→ Démarrage du serveur de diagnostic (port $PORT)"
    # --sim-links : sans configuration existante, le serveur pose des liens vers
    # les serveurs de test de cette machine (deux points par protocole). Une
    # configuration déjà écrite n'est jamais touchée.
    nohup ./build/diagweb-server --port "$PORT" --root . --data-dir .diag-data --sim-links \
      > /tmp/diagweb-server.log 2>&1 &
    sleep 1.2
    if ! serveur_deja_la; then
      echo "   Échec du démarrage :"
      sed 's/^/     /' /tmp/diagweb-server.log
      exit 1
    fi
  fi
  # 3. L'équipement d'en face, pour que le lien pré-rempli ait quelqu'un à qui
  #    parler. Son absence ne fait pas échouer le démarrage du serveur.
  demarrer_simulateur
elif ! listening; then
  echo "→ Démarrage de l'aperçu statique (port $PORT)"
  nohup python3 tools/serve.py --port "$PORT" > /tmp/diagweb-serve.log 2>&1 &
  sleep 1
fi

# 3. Publier un port est une décision : --local s'arrête ici
if [ "$PARTAGE" = 0 ]; then
  echo
  echo "Port $PORT laissé privé — accessible connecté au même compte GitHub :"
  python3 tools/serve.py --port "$PORT" --url | sed 's/^/   /'
  if [ "$MODE" = serveur ]; then
    echo
    echo "   Flux temps réel WebSocket actif (barre d'état : « Serveur de"
    echo "   diagnostic »). Ajouter ?src=sim pour comparer avec la simulation."
    echo "   Pour l'ouvrir à un autre appareil : bash tools/share.sh --server"
  else
    echo "   Pour l'ouvrir à un autre appareil : bash tools/share.sh"
  fi
  exit 0
fi

# 4. Hors Codespace : rien à transférer
if [ -z "${CODESPACE_NAME:-}" ]; then
  echo
  echo "Pas dans un Codespace — accès local ($MODE) :"
  python3 tools/serve.py --port "$PORT" --url | sed 's/^/   /'
  exit 0
fi

# 5. Port en visibilité publique (peut être refusé par la politique de l'organisation)
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
