#!/usr/bin/env bash
# Diagweb — construction du paquet arm64 (Raspberry Pi OS) dans un conteneur.
#
# Lancé par l'intégration continue à l'intérieur d'un conteneur Debian 13
# émulé par QEMU, le dépôt monté sur /src :
#
#   docker run --rm --platform linux/arm64 -v "$PWD":/src -w /src \
#     debian:trixie bash packaging/build-arm64.sh
#
# Il est ici, dans un fichier, plutôt qu'en ligne dans le YAML : un script
# passé en argument de `bash -c` interdit la moindre apostrophe et échappe à
# toute vérification de syntaxe. Celui-ci est relu par `bash -n` comme les
# autres (tools/check.sh, § « syntaxe de l'outillage »).
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
O62=/src/.o62-arm64

apt-get update -qq
# ca-certificates : sans lui, l'image de base n'a AUCUNE autorité de
# certification et le clone HTTPS d'open62541 échoue sur la vérification du
# certificat. C'est ce qui a fait sortir le premier paquet arm64 sans le pilote
# OPC UA — l'erreur était avalée, elle ne l'est plus (voir plus bas).
apt-get install -y -qq --no-install-recommends \
  build-essential meson ninja-build pkg-config python3 git dpkg-dev cmake \
  ca-certificates libsnmp-dev

# Le dépôt est monté depuis l'hôte : git refuse d'y travailler sans cela.
git config --global --add safe.directory /src

# open62541 n'est empaqueté par aucune distribution Debian : il est construit
# une fois, puis conservé d'une exécution à l'autre par le cache. S'il manque
# et que sa construction échoue, le pilote OPC UA s'annonce simplement « non
# branché » — la fabrication du paquet, elle, continue. Un paquet sans OPC UA
# reste un paquet utile ; un échec dur ne livrerait rien du tout.
if [ ! -f "$O62/lib/pkgconfig/open62541.pc" ] &&
   [ ! -f "$O62/lib64/pkgconfig/open62541.pc" ]; then
  echo "== open62541 absent du cache : construction (longue sous émulation)"
  # Sortie d'erreur CONSERVÉE : un échec doit se lire dans le journal de
  # l'exécution, pas se deviner à la taille du paquet.
  if git clone --depth 1 --branch v1.5.6 \
       https://github.com/open62541/open62541.git /tmp/o62 > /dev/null; then
    cmake -S /tmp/o62 -B /tmp/o62/build \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$O62" \
      -DUA_NAMESPACE_ZERO=REDUCED -DUA_ENABLE_AMALGAMATION=OFF \
      -DUA_BUILD_EXAMPLES=OFF -DUA_FORCE_WERROR=OFF -DBUILD_SHARED_LIBS=OFF \
      -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=OFF \
      -DCMAKE_POSITION_INDEPENDENT_CODE=ON > /dev/null &&
    cmake --build /tmp/o62/build -j"$(nproc)" > /dev/null &&
    cmake --install /tmp/o62/build > /dev/null ||
      echo "!! open62541 non construit — le paquet arm64 sera sans OPC UA"
  else
    echo "!! open62541 non téléchargé — le paquet arm64 sera sans OPC UA"
  fi
fi

export PKG_CONFIG_PATH="$O62/lib/pkgconfig:$O62/lib64/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

# Dit noir sur blanc ce que la construction va trouver : c'est la ligne qu'on
# relit quand un paquet sort plus léger que prévu.
echo "== pilotes optionnels disponibles pour cette construction"
echo "   open62541 (OPC UA) : $(pkg-config --modversion open62541 2> /dev/null || echo ABSENT)"
echo "   net-snmp (SNMP v3) : $(pkg-config --modversion netsnmp 2> /dev/null || echo ABSENT)"

# Le dossier de construction peut rester de l'étape amd64, avec des objets
# d'une autre architecture : on repart à neuf.
rm -rf /src/build-paquet

# PKGVER est posé par l'intégration continue pour que les deux paquets d'une
# même release portent le même numéro. Absent (essai à la main), le script le
# calcule lui-même.
if [ -n "${PKGVER:-}" ]; then
  bash /src/tools/package-deb.sh --version "$PKGVER"
else
  bash /src/tools/package-deb.sh
fi
