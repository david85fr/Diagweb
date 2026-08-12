cmake_minimum_required(VERSION 3.16)
project(diagweb_server CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_executable(diagweb-server src/main.cpp)
target_include_directories(diagweb-server PRIVATE src)
target_compile_options(diagweb-server PRIVATE -Wall -Wextra)

find_package(Threads REQUIRED)
target_link_libraries(diagweb-server PRIVATE Threads::Threads)

# Tests unitaires du décodage des protocoles réseau :
#   cmake --build build --target diagweb-decode-test && ./build/diagweb-decode-test
add_executable(diagweb-decode-test EXCLUDE_FROM_ALL ../tests/decode.cpp)
target_include_directories(diagweb-decode-test PRIVATE src)
target_compile_options(diagweb-decode-test PRIVATE -Wall -Wextra)

# Compilation croisée : passer la chaîne d'outils du contrôleur, p. ex.
#   cmake -B build -DCMAKE_TOOLCHAIN_FILE=<sdk>/toolchain.cmake
# Aucune dépendance externe : uniquement la bibliothèque standard et POSIX.
