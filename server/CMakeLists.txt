cmake_minimum_required(VERSION 3.16)
project(diagweb_server CXX C)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Pilote OPC UA. C'est la SEULE dépendance externe du serveur : open62541,
# sous licence MPL-2.0, qui autorise explicitement la combinaison avec du
# logiciel propriétaire (voir docs/PROTOCOLES.md § Bibliothèques externes).
# À OFF, le serveur se compile hors ligne et sans aucune dépendance ; le
# pilote OPC UA redevient alors « déclaré » et ne publie rien.
option(DIAGWEB_WITH_OPCUA "Pilote OPC UA (open62541, MPL-2.0)" ON)
set(DIAGWEB_OPCUA_TAG "v1.5.6" CACHE STRING "Version d'open62541 utilisée")
# Chiffrement OPC UA (politiques Basic256Sha256 et suivantes) : ajoute une
# dépendance à OpenSSL, qui doit alors exister dans le SDK du contrôleur. À
# OFF, un lien réglé en « Signature » ou « Signature et chiffrement » REFUSE
# de s'ouvrir, avec le motif — jamais de repli silencieux en clair.
option(DIAGWEB_OPCUA_ENCRYPTION "Chiffrement OPC UA via OpenSSL" OFF)

add_executable(diagweb-server src/main.cpp)
target_include_directories(diagweb-server PRIVATE src)
target_compile_options(diagweb-server PRIVATE -Wall -Wextra)

find_package(Threads REQUIRED)
target_link_libraries(diagweb-server PRIVATE Threads::Threads)

if(DIAGWEB_WITH_OPCUA)
  # Une copie déjà installée sur le système (ou fournie par le SDK du
  # contrôleur) est préférée : la compilation croisée d'un produit embarqué
  # ne doit pas dépendre d'un accès réseau au moment du build.
  find_package(open62541 QUIET)
  if(NOT open62541_FOUND)
    include(FetchContent)
    set(UA_NAMESPACE_ZERO REDUCED CACHE STRING "" FORCE)
    set(UA_ENABLE_AMALGAMATION OFF CACHE BOOL "" FORCE)
    set(UA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    if(DIAGWEB_OPCUA_ENCRYPTION)
      set(UA_ENABLE_ENCRYPTION OPENSSL CACHE STRING "" FORCE)
    endif()
    set(UA_FORCE_WERROR OFF CACHE BOOL "" FORCE)
    # open62541 active l'optimisation inter-procédurale en Release ; à
    # l'édition de liens, GCC recompile alors son code C avec NOS options —
    # dont -Werror — et un avertissement dans du code tiers casserait notre
    # build. On la désactive : le gain ne vaut pas ce couplage.
    set(CMAKE_INTERPROCEDURAL_OPTIMIZATION OFF CACHE BOOL "" FORCE)
    set(BUILD_SHARED_LIBS OFF)
    FetchContent_Declare(open62541
      GIT_REPOSITORY https://github.com/open62541/open62541.git
      GIT_TAG ${DIAGWEB_OPCUA_TAG}
      GIT_SHALLOW TRUE)
    FetchContent_MakeAvailable(open62541)
  endif()
  # En-têtes tiers vus comme « système » : nos -Wall -Wextra -Werror portent
  # sur le code de Diagweb, pas sur celui d'une bibliothèque que nous
  # n'écrivons pas et dont nous ne choisissons pas le style.
  if(TARGET open62541)
    get_target_property(_o62_includes open62541 INTERFACE_INCLUDE_DIRECTORIES)
    if(_o62_includes)
      set_target_properties(open62541 PROPERTIES
        INTERFACE_SYSTEM_INCLUDE_DIRECTORIES "${_o62_includes}")
    endif()
  endif()
  target_compile_definitions(diagweb-server PRIVATE DIAGWEB_HAS_OPCUA=1)
  target_link_libraries(diagweb-server PRIVATE open62541::open62541)

  # Serveur OPC UA de test : expose quelques nœuds de types variés, pour que
  # tests/protocols.mjs vérifie la chaîne complète sans matériel.
  add_executable(diagweb-opcua-test-server EXCLUDE_FROM_ALL ../tests/opcua_server.c)
  target_link_libraries(diagweb-opcua-test-server PRIVATE open62541::open62541)
endif()

# Tests unitaires du décodage des protocoles réseau :
#   cmake --build build --target diagweb-decode-test && ./build/diagweb-decode-test
add_executable(diagweb-decode-test EXCLUDE_FROM_ALL ../tests/decode.cpp)
target_include_directories(diagweb-decode-test PRIVATE src)
target_compile_options(diagweb-decode-test PRIVATE -Wall -Wextra)

# Compilation croisée : passer la chaîne d'outils du contrôleur, p. ex.
#   cmake -B build -DCMAKE_TOOLCHAIN_FILE=<sdk>/toolchain.cmake
# Hors OPC UA, aucune dépendance : bibliothèque standard et POSIX seulement.
