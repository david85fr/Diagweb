#!/usr/bin/env python3
"""Diagweb — régénère les en-têtes C++ dérivés des sources web.

Un seul point d'entrée, appelé par `meson compile -C build generer` comme à la
main. Les fichiers produits sont commités : la CI vérifie qu'ils correspondent
à leurs sources.
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

for generateur in ("gen-catalog.mjs", "gen-protocols.mjs"):
    r = subprocess.run(["node", str(ROOT / "tools" / generateur)], cwd=ROOT)
    if r.returncode != 0:
        sys.exit(r.returncode)
