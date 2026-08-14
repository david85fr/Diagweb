#!/usr/bin/env python3
"""Diagweb — assemblage des livrables à partir de web/.

Produit :
  dist/index.html    page autonome (CSS/JS incorporés) — servable telle quelle
                     depuis le contrôleur embarqué ou ouvrable en local ;
  dist/artifact.html même contenu sans <!DOCTYPE>/<html>/<head>/<body>, pour
                     publication comme Artifact (le conteneur ajoute le squelette).

Usage : python3 tools/build.py [--index-out CHEMIN] [--artifact-out CHEMIN]

Les deux options servent aux vérifications (tools/check-dist.py) : elles
permettent de reconstruire ailleurs que dans dist/, sans toucher au dépôt.
"""
import argparse
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DIST = ROOT / "dist"


def git_version() -> str:
    """« hash court · #n » du HEAD courant (identifie le commit des sources)."""
    try:
        h = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()
        n = subprocess.check_output(
            ["git", "rev-list", "--count", "HEAD"], cwd=ROOT, text=True).strip()
        return f"{h} · #{n}"
    except Exception:
        return "dev"


def stamp_version(html: str) -> str:
    return re.sub(
        r'(<span id="buildTag"[^>]*>)[^<]*(</span>)',
        lambda m: m.group(1) + git_version() + m.group(2),
        html,
    )


def inline_assets(html: str) -> str:
    def css(m):
        path = WEB / m.group(1)
        return "<style>\n" + path.read_text(encoding="utf-8") + "\n</style>"

    def js(m):
        path = WEB / m.group(1)
        return "<script>\n" + path.read_text(encoding="utf-8") + "\n</script>"

    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', css, html)
    html = re.sub(r'<script src="([^"]+)"></script>', js, html)
    return html


def body_only(html: str) -> str:
    """Extrait <style> du head + contenu du body (pour l'Artifact)."""
    styles = "\n".join(re.findall(r"<style>.*?</style>", html, re.S))
    m = re.search(r"<body>(.*)</body>", html, re.S)
    if not m:
        sys.exit("build: <body> introuvable")
    return styles + "\n" + m.group(1).strip() + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index-out", default=str(DIST / "index.html"))
    ap.add_argument("--artifact-out", default=str(DIST / "artifact.html"))
    args = ap.parse_args()

    src = (WEB / "index.html").read_text(encoding="utf-8")
    full = stamp_version(inline_assets(src))

    index = pathlib.Path(args.index_out)
    index.parent.mkdir(parents=True, exist_ok=True)
    index.write_text(full, encoding="utf-8")
    out = pathlib.Path(args.artifact_out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(body_only(full), encoding="utf-8")
    print(f"build: {index} ({len(full)} o) et {out} générés")


if __name__ == "__main__":
    main()
