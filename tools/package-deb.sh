#!/usr/bin/env bash
# Diagweb — construction du paquet d'installation .deb.
#
#   bash tools/package-deb.sh [--out <dossier>] [--version <version>]
#                             [--sans-optionnel]
#
# Le paquet est construit POUR LA MACHINE QUI EXÉCUTE CE SCRIPT : l'architecture
# est celle de dpkg (amd64 sur un PC Ubuntu, arm64 sur un Raspberry Pi OS 64
# bits, armhf sur un 32 bits), et les dépendances sont relevées sur le binaire
# réellement produit. Il n'y a pas de compilation croisée ici : construire sur
# la cible évite l'écart silencieux entre ce qui est testé et ce qui est livré.
#
# Ce qu'il installe :
#   /usr/bin/diagweb-server            le serveur de diagnostic
#   /usr/share/diagweb/web/            la page servie (sources)
#   /usr/share/diagweb/dist/           la page autonome (simulation navigateur)
#   /lib/systemd/system/diagweb.service le service, démarré à l'installation
#   /etc/default/diagweb               port et options (conservé aux mises à jour)
#   /var/lib/diagweb                   données (créé par systemd au démarrage)
#
# Voir docs/INSTALL.md. Pour tout faire d'un coup sur une machine neuve
# (dépendances comprises, puis installation) : sudo bash tools/install.sh
set -euo pipefail
# Les répertoires du paquet doivent rester lisibles par tous : sous un umask
# restrictif, dpkg-deb refuse un DEBIAN/ en 0700 et l'échec est illisible.
umask 022

cd "$(dirname "$0")/.."
RACINE=$(pwd)

# Cas prévu par docs/INSTALL.md : clone appartenant à l'utilisateur, script
# lancé sous sudo. Git refuse alors de lire le dépôt (« dubious ownership ») et
# la version retomberait sur un horodatage — silencieusement. Posé dans
# l'environnement plutôt qu'en option : tools/build.py, processus séparé, en a
# besoin lui aussi pour estampiller la page.
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0="$RACINE"
SORTIE="$RACINE/dist/packages"
VERSION=""
OPTIONNEL=oui

while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || { echo "--out attend un dossier" >&2; exit 2; }
           SORTIE=$(readlink -f "$2"); shift 2 ;;
    --version) [ $# -ge 2 ] || { echo "--version attend un numéro" >&2; exit 2; }
           VERSION=$2; shift 2 ;;
    --sans-optionnel) OPTIONNEL=non; shift ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done

manque() {
  echo "  ✗ $1 est absent — sudo apt install $2" >&2
  exit 1
}
command -v meson    > /dev/null || manque meson meson
command -v ninja    > /dev/null || manque ninja ninja-build
command -v dpkg-deb > /dev/null || manque dpkg-deb dpkg
command -v g++      > /dev/null || manque g++ build-essential
command -v python3  > /dev/null || manque python3 python3

ARCH=$(dpkg --print-architecture)

# Version : le numéro de commit et le hash court, exactement ce qu'affiche le
# tag de version de l'interface. On sait ainsi, d'un paquet installé, à quel
# état du dépôt il correspond. Hors dépôt git (archive téléchargée), l'horodatage
# fait foi.
if [ -z "$VERSION" ]; then
  if git -C "$RACINE" rev-parse --git-dir > /dev/null 2>&1 &&
     [ "$(git -C "$RACINE" rev-list --count HEAD 2>/dev/null || echo 0)" -gt 0 ]; then
    N=$(git -C "$RACINE" rev-list --count HEAD)
    H=$(git -C "$RACINE" rev-parse --short HEAD)
    VERSION="1.0.$N+g$H"
    # « local » ne se déclenche que sur des SOURCES modifiées. dist/ est exclu :
    # il est régénéré quelques lignes plus bas, et son tag de version porte
    # légitimement le commit précédent (cycle à deux commits). Sans cette
    # exclusion, tout paquet construit après le premier se croyait local — et
    # deux constructions du même commit ne portaient pas le même numéro.
    if ! git -C "$RACINE" diff --quiet HEAD -- . ':!dist' 2>/dev/null; then
      # « ~ » trie AVANT : un paquet bricolé localement ne doit jamais empêcher
      # d'installer ensuite le paquet officiel du même commit (apt refuse un
      # retour en arrière).
      VERSION="$VERSION~local$(date -u +%Y%m%d%H%M)"
    fi
  else
    VERSION="1.0.0+$(date -u +%Y%m%d%H%M)"
  fi
fi

BUILD="$RACINE/build-paquet"
STAGE=$(mktemp -d)
# mktemp donne 0700 : la racine du paquet doit être traversable par tous, sinon
# dpkg pose un / interdit aux utilisateurs ordinaires.
chmod 0755 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

echo "Diagweb — paquet $VERSION pour $ARCH"

# ------------------------------------------------------------------ compilation
# Construction dédiée, séparée de build/ : le dossier de développement peut
# porter d'autres options (tests, débogage) et on veut ici exactement ce qui
# sera livré. Les deux dépendances facultatives restent en « auto » : présentes,
# elles sont utilisées ; absentes, les pilotes correspondants s'annoncent non
# branchés — jamais de repli silencieux.
OPTS=(-Dopcua=auto -Dnetsnmp=auto)
[ "$OPTIONNEL" = non ] && OPTS=(-Dopcua=disabled -Dnetsnmp=disabled)
if [ -d "$BUILD" ]; then
  # --reconfigure : le dossier peut rester d'un appel précédent aux options
  # différentes, et un paquet « sans optionnel » qui embarquerait quand même
  # OPC UA serait un mensonge sur l'étiquette.
  meson setup "$BUILD" --prefix=/usr --buildtype=release "${OPTS[@]}" \
    --reconfigure > /dev/null
else
  meson setup "$BUILD" --prefix=/usr --buildtype=release "${OPTS[@]}" > /dev/null
fi
meson compile -C "$BUILD" diagweb-server > /dev/null
echo "  ✓ serveur compilé"

# La page autonome est régénérée : le paquet ne doit pas livrer un dist/ plus
# vieux que les sources qu'il embarque.
python3 tools/build.py > /dev/null
echo "  ✓ livrables web à jour"

# ------------------------------------------------------------------- assemblage
install -D -m 0755 "$BUILD/diagweb-server"        "$STAGE/usr/bin/diagweb-server"
install -D -m 0644 packaging/diagweb.service      "$STAGE/usr/lib/systemd/system/diagweb.service"
install -D -m 0644 packaging/default              "$STAGE/etc/default/diagweb"
install -D -m 0644 packaging/copyright            "$STAGE/usr/share/doc/diagweb/copyright"

# Journal des changements : exigé de tout paquet Debian, et il n'a de valeur ici
# que s'il dit quelque chose — les derniers commits font l'affaire.
{
  echo "diagweb ($VERSION) stable; urgency=medium"
  echo ""
  if git -C "$RACINE" log -5 --format='  * %s' 2> /dev/null; then :; else
    echo "  * construction hors dépôt git"
  fi
  echo ""
  echo " -- Diagweb <david85fr@users.noreply.github.com>  $(date -uR)"
} | gzip -9n > "$STAGE/usr/share/doc/diagweb/changelog.Debian.gz"
chmod 0644 "$STAGE/usr/share/doc/diagweb/changelog.Debian.gz"

# Les deux documents sont volumineux : Policy demande de les compresser.
gzip -9nc docs/INSTALL.md > "$STAGE/usr/share/doc/diagweb/INSTALL.md.gz"
gzip -9nc README.md       > "$STAGE/usr/share/doc/diagweb/README.md.gz"
chmod 0644 "$STAGE/usr/share/doc/diagweb/INSTALL.md.gz" \
           "$STAGE/usr/share/doc/diagweb/README.md.gz"

# Page servie (sources) et page autonome, toutes deux sous la racine du serveur :
# http://<hôte>:8080/ renvoie vers /web/index.html, et /dist/index.html reste
# consultable telle quelle, en simulation, même contrôleur muet.
mkdir -p "$STAGE/usr/share/diagweb"
cp -r web  "$STAGE/usr/share/diagweb/web"
cp -r dist "$STAGE/usr/share/diagweb/dist"
rm -rf "$STAGE/usr/share/diagweb/dist/packages"
find "$STAGE/usr/share/diagweb" -type f -exec chmod 0644 {} +
find "$STAGE/usr/share/diagweb" -type d -exec chmod 0755 {} +

# Ce que le binaire embarque réellement : lisible sur la machine installée, sans
# avoir à retrouver le dépôt ni la ligne de compilation.
OPCUA=non; NETSNMP=non
grep -q DIAGWEB_HAS_OPCUA   "$BUILD/compile_commands.json" 2>/dev/null && OPCUA=oui
grep -q DIAGWEB_HAS_NETSNMP "$BUILD/compile_commands.json" 2>/dev/null && NETSNMP=oui
cat > "$STAGE/usr/share/diagweb/BUILD-INFO" <<INFO
Diagweb $VERSION ($ARCH)
construit le $(date -u +"%Y-%m-%dT%H:%M:%SZ") sur $(. /etc/os-release && echo "$PRETTY_NAME")
pilote OPC UA (open62541) : $OPCUA
SNMP v3 (Net-SNMP)        : $NETSNMP
INFO
chmod 0644 "$STAGE/usr/share/diagweb/BUILD-INFO"

# --------------------------------------------------------------- dépendances
# Relevées sur le binaire produit plutôt que devinées : la liste change avec les
# dépendances facultatives réellement trouvées à la compilation.
DEPS="adduser"
mkdir -p "$STAGE/debian"
: > "$STAGE/debian/control"
# Premier essai SANS --ignore-missing-info : une bibliothèque sans information
# de dépendance (compilée à la main, posée dans /usr/local) doit se voir, pas
# disparaître de Depends. Un paquet aux dépendances incomplètes s'installe puis
# échoue au démarrage sur la machine cible, ce qui est bien pire qu'un
# avertissement à la construction.
if SHLIBS=$(cd "$STAGE" && dpkg-shlibdeps -O usr/bin/diagweb-server 2> "$STAGE/shlibs.err"); then
  :
elif SHLIBS=$(cd "$STAGE" && dpkg-shlibdeps -O --ignore-missing-info usr/bin/diagweb-server 2>/dev/null); then
  echo "  ! dépendances incomplètes — bibliothèque sans information de paquet :" >&2
  sed 's/^/    /' "$STAGE/shlibs.err" >&2
  echo "    Le paquet reste utilisable là où cette bibliothèque est déjà présente." >&2
else
  echo "  ! dpkg-shlibdeps indisponible — dépendances minimales déclarées" >&2
  SHLIBS="shlibs:Depends=libc6, libstdc++6"
fi
SHLIBS=${SHLIBS#shlibs:Depends=}
[ -n "$SHLIBS" ] && DEPS="$DEPS, $SHLIBS"
rm -rf "$STAGE/debian" "$STAGE/shlibs.err"

TAILLE=$(du -ks "$STAGE" | cut -f1)

mkdir -p "$STAGE/DEBIAN"
cat > "$STAGE/DEBIAN/control" <<CONTROL
Package: diagweb
Version: $VERSION
Section: utils
Priority: optional
Architecture: $ARCH
Maintainer: Diagweb <david85fr@users.noreply.github.com>
Depends: $DEPS
Recommends: tcpdump
Installed-Size: $TAILLE
Homepage: https://github.com/david85fr/Diagweb
Description: diagnostic web des variables d'un controleur embarque
 Serveur de diagnostic et interface web : valeurs numeriques en direct,
 courbes multi-echelles, journalisation, liens reseau (Modbus, IEC 61850,
 IEC 60870-5-104, CAN, J1939, CANopen, SNMP, OPC UA), audit des
 communications, capture d'interfaces et voisinage LLDP.
 .
 Le service ecoute sur le port 8080 (reglable dans /etc/default/diagweb) et
 tourne sous un compte systeme dedie. La page s'ouvre depuis un telephone
 comme depuis un poste : http://<adresse-de-la-machine>:8080/
 .
 Pilotes optionnels reellement compiles dans ce paquet :
 OPC UA $OPCUA, SNMP v3 $NETSNMP (voir /usr/share/diagweb/BUILD-INFO).
CONTROL

echo "/etc/default/diagweb" > "$STAGE/DEBIAN/conffiles"

for s in postinst prerm postrm; do
  install -m 0755 "packaging/$s" "$STAGE/DEBIAN/$s"
done

# md5sums : dpkg s'en sert pour dire quels fichiers ont été modifiés depuis
# l'installation. Les conffiles en sont exclus — les modifier est justement leur
# raison d'être, et les y laisser ferait crier « debsums » sur un fichier
# légitimement édité, noyant les vraies altérations. Liste triée : deux
# constructions du même contenu donnent le même paquet.
(cd "$STAGE" && find usr -type f -print0 |
  LC_ALL=C sort -z |
  xargs -0 md5sum > DEBIAN/md5sums)
chmod 0644 "$STAGE/DEBIAN/md5sums"

# ------------------------------------------------------------------ fabrication
mkdir -p "$SORTIE"
PAQUET="$SORTIE/diagweb_${VERSION}_${ARCH}.deb"
# --root-owner-group : tout appartient a root, sans avoir besoin de fakeroot.
dpkg-deb --root-owner-group --build "$STAGE" "$PAQUET" > /dev/null
echo "  ✓ paquet : $PAQUET ($(du -h "$PAQUET" | cut -f1))"

# Contrôle de cohérence : lisible par dpkg, et le service part-il d'un fichier
# d'unité valide ? Mieux vaut l'apprendre ici que sur la machine cible.
dpkg-deb --info "$PAQUET" > /dev/null
if command -v systemd-analyze > /dev/null; then
  # Le binaire n'est pas encore à /usr/bin sur la machine qui construit :
  # cette plainte-là n'apprend rien, la syntaxe de l'unité, si.
  systemd-analyze verify "$STAGE/usr/lib/systemd/system/diagweb.service" 2>&1 |
    grep -v -e "Unit .* not found" -e "is not executable" || true
fi

echo ""
echo "Installer :   sudo apt install $PAQUET"
echo "Desinstaller : sudo apt remove diagweb   (purge : sudo apt purge diagweb)"
