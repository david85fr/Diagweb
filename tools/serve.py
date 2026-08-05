#!/usr/bin/env python3
"""Diagweb — serveur d'aperçu pour le développement (bibliothèque standard).

Sert la racine du dépôt : la page de développement est /web/index.html et le
livrable autonome /dist/index.html. Les réponses sont explicitement non
mises en cache, sinon un téléphone garde une version périmée entre deux
itérations.

Usage : python3 tools/serve.py [--port 8080] [--dir .]
"""
import argparse
import functools
import http.server
import os
import pathlib
import socketserver

ROOT = pathlib.Path(__file__).resolve().parent.parent


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
        super().do_GET()

    def log_message(self, fmt, *args):
        # Journal compact : méthode + chemin + code
        print("  %s" % (fmt % args))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    ap.add_argument("--dir", default=str(ROOT))
    args = ap.parse_args()

    handler = functools.partial(Handler, directory=args.dir)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", args.port), handler) as httpd:
        print("Diagweb — aperçu sur le port %d" % args.port)
        print("  développement : http://localhost:%d/web/index.html" % args.port)
        print("  livrable      : http://localhost:%d/dist/index.html" % args.port)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nArrêt.")


if __name__ == "__main__":
    main()
