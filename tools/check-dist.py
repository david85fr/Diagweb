#!/usr/bin/env python3
"""Diagweb — contrôles sur les livrables de dist/.

Deux vérifications, faites en local comme en intégration continue :

1. **dist/ est à jour** — les fichiers commités correspondent bien aux sources
   de web/. La comparaison neutralise le tag de version : il identifie le
   commit des sources, il diffère donc légitimement du commit courant (cycle
   à deux commits, voir CLAUDE.md).
2. **Page autonome** — aucune ressource externe (CDN, webfont, image
   distante) : la page publiée est servie sous CSP stricte et le contrôleur
   embarqué doit pouvoir la servir hors ligne (contrainte n° 2 de CLAUDE.md).

Usage : python3 tools/check-dist.py
Sortie : code de retour non nul et explication en cas d'écart.
"""
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# Ressources chargées depuis l'extérieur : interdites dans un livrable autonome.
EXTERNAL = [
    (re.compile(r'<(?:script|img|iframe|source)[^>]+src\s*=\s*["\']https?://', re.I),
     "ressource chargée depuis un site externe"),
    (re.compile(r'<link[^>]+href\s*=\s*["\']https?://', re.I),
     "feuille de style ou police externe"),
    (re.compile(r'url\(\s*["\']?https?://', re.I),
     "ressource CSS distante"),
    (re.compile(r'@import\s+(?:url\()?["\']?(?!data:)', re.I),
     "@import CSS (tout doit être incorporé)"),
    (re.compile(r'<link[^>]+rel\s*=\s*["\']stylesheet', re.I),
     "feuille de style non incorporée"),
    (re.compile(r'<script[^>]+src\s*=', re.I),
     "script non incorporé"),
]


def norm(html: str) -> str:
    """Neutralise le tag de version, qui dépend du commit."""
    return re.sub(r'(<span id="buildTag"[^>]*>)[^<]*(</span>)',
                  r"\1VERSION\2", html)


def committed(path: str) -> str | None:
    """Contenu du fichier tel qu'il est dans le commit courant."""
    try:
        return subprocess.check_output(["git", "show", f"HEAD:{path}"],
                                       cwd=ROOT, text=True)
    except subprocess.CalledProcessError:
        return None


def main() -> int:
    problems = []

    # 1. Reconstruction dans un dossier temporaire, puis comparaison.
    with tempfile.TemporaryDirectory() as tmp:
        art = pathlib.Path(tmp) / "artifact.html"
        subprocess.run([sys.executable, str(ROOT / "tools" / "build.py"),
                        "--artifact-out", str(art)],
                       cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        rebuilt = {
            "dist/index.html": (DIST / "index.html").read_text(encoding="utf-8"),
            "dist/artifact.html": art.read_text(encoding="utf-8"),
        }

    for path, fresh in rebuilt.items():
        old = committed(path)
        if old is None:
            problems.append(f"{path} : absent du dépôt (le livrable doit être commité)")
        elif norm(old) != norm(fresh):
            problems.append(
                f"{path} : ne correspond plus aux sources de web/ — "
                "relancer « python3 tools/build.py » et commiter dist/")

    # 2. Autonomie de la page (les deux livrables).
    for name, html in rebuilt.items():
        for pattern, why in EXTERNAL:
            m = pattern.search(html)
            if m:
                extract = html[max(0, m.start() - 20):m.end() + 60].replace("\n", " ")
                problems.append(f"{name} : {why} — …{extract}…")

    if problems:
        print("Contrôle des livrables : échec")
        for p in problems:
            print("  ✗ " + p)
        return 1

    print("Contrôle des livrables : dist/ à jour, aucune ressource externe")
    return 0


if __name__ == "__main__":
    sys.exit(main())
