# Diagweb — construction du serveur de diagnostic et des outils de test.
#
#   meson setup build && meson compile -C build && meson test -C build
#
# Le générateur par défaut de Meson est Ninja ; rien à préciser.
#
# Cible : Linux. Le contrôleur est un Linux embarqué moderne (systemd), et le
# serveur s'appuie sans détour sur ce qu'il offre — /proc, /sys, AF_PACKET,
# SocketCAN. Aucune concession de portabilité vers d'autres systèmes : elle
# coûterait des abstractions pour un bénéfice nul.
project('diagweb', ['cpp', 'c'],
  version: '1.0',
  default_options: [
    'cpp_std=c++23',
    'c_std=c11',
    'warning_level=2',        # -Wall -Wextra
    'werror=true',            # un avertissement est un défaut
    'buildtype=release',
  ],
  meson_version: '>=1.0')

cxx = meson.get_compiler('cpp')
if not cxx.has_argument('-std=c++23')
  error('un compilateur C++23 est nécessaire (GCC 13 ou plus récent)')
endif

threads = dependency('threads')
src_inc = include_directories('server/src')
sim_inc = include_directories('simulator/src')

deps = [threads]
defs = []

# ---------------------------------------------------------------- OPC UA
# open62541 (MPL-2.0). Cherché sur le système : la compilation croisée d'un
# produit embarqué ne doit pas dépendre d'un accès réseau au moment du build.
# Absent, le pilote OPC UA redevient « déclaré » et ne publie rien.
opcua = dependency('open62541', required: get_option('opcua'), include_type: 'system')
opcua_chiffre = false
if opcua.found()
  deps += opcua
  defs += '-DDIAGWEB_HAS_OPCUA=1'

  # Le chiffrement n'est pas une capacité de Diagweb : il vient d'open62541,
  # qui définit UA_ENABLE_ENCRYPTION quand il a été compilé avec une pile TLS.
  # C'est ce symbole que lit le pilote (drivers/opcua/opcua.hpp), et lui seul.
  # L'option ne sert donc qu'à EXIGER la capacité et à échouer à la
  # configuration si elle manque — plutôt que de laisser découvrir à
  # l'exécution qu'un lien chiffré refuse de s'ouvrir.
  opcua_chiffre = cxx.has_header_symbol('open62541/config.h',
                                        'UA_ENABLE_ENCRYPTION',
                                        dependencies: opcua)
  if get_option('opcua_encryption') and not opcua_chiffre
    error('-Dopcua_encryption=true, mais open62541 est compilé sans pile TLS ' +
          '(UA_ENABLE_ENCRYPTION absent). Reconstruire open62541 avec ' +
          '-DUA_ENABLE_ENCRYPTION_OPENSSL=ON, ou retirer cette option.')
  endif
endif

# ----------------------------------------------------------------- SNMP v3
# Net-SNMP (BSD). Absent, v1 et v2c restent servies par l'implémentation
# interne et v3 s'annonce « non branché » : jamais de repli en clair.
netsnmp = dependency('netsnmp', required: get_option('netsnmp'), include_type: 'system')
if netsnmp.found()
  deps += netsnmp
  defs += '-DDIAGWEB_HAS_NETSNMP=1'
endif

# ------------------------------------------------------------------ serveur
diagweb_server = executable('diagweb-server',
  'server/src/main.cpp',
  include_directories: src_inc,
  dependencies: deps,
  cpp_args: defs,
  install: true)

# --------------------------------------------------- simulateur d'équipements
# Second exécutable : le banc d'équipements virtuels (docs/SIMULATEUR.md).
# Il n'est pas installé — c'est un outil de mise au point et de démonstration,
# pas un composant du produit embarqué.
diagweb_simulator = executable('diagweb-simulator',
  'simulator/src/main.cpp',
  include_directories: [src_inc, sim_inc],
  dependencies: [threads])

# ------------------------------------------------------------------- tests
decode_test = executable('diagweb-decode-test',
  'tests/decode.cpp',
  include_directories: src_inc,
  build_by_default: false)

test('decodage des protocoles', decode_test, suite: 'serveur', timeout: 120)

simulator_test = executable('diagweb-simulator-test',
  'tests/simulator.cpp',
  include_directories: [src_inc, sim_inc],
  build_by_default: false)

test('simulateur d equipements', simulator_test, suite: 'serveur', timeout: 120)

node = find_program('node', required: false)
python3 = find_program('python3')

# Serveur OPC UA de test : sans lui, les vérifications OPC UA de bout en bout
# échouent en le disant — jamais en silence.
if opcua.found()
  executable('diagweb-opcua-test-server',
    'tests/opcua_server.c',
    dependencies: [opcua])
endif

if node.found()
  # Ces trois-là ont besoin du serveur en fonctionnement : un script le lance,
  # attend qu'il réponde, joue les vérifications, puis l'arrête.
  # Port distinct de celui de l'aperçu (tools/serve.py) : les deux doivent
  # pouvoir tourner en même temps sur le poste du développeur.
  # `depends` : le script reçoit le CHEMIN des exécutables, pas les cibles —
  # sans cette dépendance, un `meson test` seul éprouverait le binaire du tour
  # précédent et laisserait passer la modification qu'on vient d'écrire.
  test('liens reseau et fonctions serveur',
    find_program('tools/run-server-tests.sh'),
    depends: [diagweb_server, diagweb_simulator],
    suite: 'serveur', timeout: 600, workdir: meson.project_source_root(),
    env: {'DIAGWEB_PORT': '8099',
          'DIAGWEB_SERVER_BIN': meson.project_build_root() / 'diagweb-server',
          'DIAGWEB_SIMULATOR_BIN': meson.project_build_root() / 'diagweb-simulator',
          'DIAGWEB_OPCUA_TEST_SERVER': meson.project_build_root() / 'diagweb-opcua-test-server'})

  # Interface : demande Playwright et Chromium (bash tools/setup-tests.sh).
  test('interface web', node,
    args: [meson.project_source_root() / 'tests/ui.mjs'],
    suite: 'interface', timeout: 600, workdir: meson.project_source_root())
endif

# ------------------------------------------------------------- assemblage web
# `meson compile -C build livrables` régénère dist/ (page autonome + Artifact).
# (« dist » est un nom réservé par Meson pour ses archives de distribution.)
run_target('livrables',
  command: [python3, meson.project_source_root() / 'tools/build.py'])

# En-têtes générés depuis les sources web (catalogue, protocoles).
run_target('generer',
  command: [python3, meson.project_source_root() / 'tools/gen-all.py'])

summary({
  'OPC UA (open62541)': opcua.found(),
  'SNMP v3 (Net-SNMP)': netsnmp.found(),
  'chiffrement OPC UA': opcua_chiffre,
  'tests Node': node.found(),
}, section: 'Diagweb', bool_yn: true)
