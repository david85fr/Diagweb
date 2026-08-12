#!/usr/bin/env python3
"""Diagweb — serveur d'aperçu pour le développement (bibliothèque standard).

Sert la racine du dépôt : la page de développement est /web/index.html et le
livrable autonome /dist/index.html. Les réponses sont explicitement non
mises en cache, sinon un téléphone garde une version périmée entre deux
itérations.

Usage : python3 tools/serve.py [--port 8080] [--dir .]
        python3 tools/serve.py --url     (affiche l'adresse d'aperçu et sort)
"""
import argparse
import functools
import http.server
import os
import pathlib
import socketserver

ROOT = pathlib.Path(__file__).resolve().parent.parent


def preview_base(port):
    """Adresse d'aperçu : URL transférée dans un Codespace, sinon locale."""
    name = os.environ.get("CODESPACE_NAME")
    domain = os.environ.get("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN", "app.github.dev")
    if name:
        return "https://%s-%d.%s" % (name, port, domain)
    return "http://localhost:%d" % port


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        # Raccourci : « / » ouvre la page de développement
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/web/index.html")
            self.end_headers()
            return
        # Pas d'icône de site dans le dépôt : évite un 404 dans la console
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        # Sondes de l'application (/api/health, /api/protocols…) : cet aperçu
        # n'est pas le serveur de diagnostic. Un 204 les fait retomber
        # proprement sur la simulation locale, alors qu'un 404 serait
        # journalisé comme une erreur par le navigateur.
        if self.path.startswith("/api/"):
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self):
        self.do_GET()

    def do_PUT(self):
        self.do_GET()

    def log_message(self, fmt, *args):
        # Journal compact : méthode + chemin + code
        print("  %s" % (fmt % args))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    ap.add_argument("--dir", default=str(ROOT))
    ap.add_argument("--url", action="store_true",
                    help="affiche l'adresse d'aperçu (utile sans le panneau PORTS)")
    args = ap.parse_args()

    base = preview_base(args.port)
    if args.url:
        print(base + "/web/index.html")
        print(base + "/dist/index.html")
        return

    handler = functools.partial(Handler, directory=args.dir)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", args.port), handler) as httpd:
        print("Diagweb — aperçu sur le port %d" % args.port)
        print("  développement : %s/web/index.html" % base)
        print("  livrable      : %s/dist/index.html" % base)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nArrêt.")


if __name__ == "__main__":
    main()
