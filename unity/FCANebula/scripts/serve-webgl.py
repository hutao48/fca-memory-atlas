#!/usr/bin/env python3
"""FCA Nebula WebGL — local static server for Electron iframe / acceptance.

Serves artifacts/unity/FCANebulaWebGL with the MIME types Unity's WebGL loader needs
(application/wasm), no-cache headers and permissive CORS (the player fetches the FCA
Runtime API cross-origin; the Runtime already sends CORS headers, this just keeps the
static assets unblocked for iframe/tooling access).

Usage:
  python unity/FCANebula/scripts/serve-webgl.py --port 18080
  python unity/FCANebula/scripts/serve-webgl.py --root artifacts/unity/FCANebulaWebGL --port 18080 --bind 127.0.0.1
"""

import argparse
import http.server
import mimetypes
import os
import socketserver
import sys


def configure_mime_types():
    mimetypes.add_type("application/wasm", ".wasm")
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("application/octet-stream", ".data")
    mimetypes.add_type("application/json", ".json")
    mimetypes.add_type("image/png", ".png")
    mimetypes.add_type("image/x-icon", ".ico")
    mimetypes.add_type("application/octet-stream", ".mem")
    mimetypes.add_type("application/octet-stream", ".symbols.json")


class FcaWebGLHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".data": "application/octet-stream",
        ".js": "application/javascript",
        ".json": "application/json",
        ".html": "text/html; charset=utf-8",
        ".css": "text/css",
        ".png": "image/png",
        ".ico": "image/x-icon",
    }

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization,Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,OPTIONS")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        # SECURITY: never log the request query string. The iframe URL carries the FCA bearer
        # token (?token=...), so only the path is written to the server log.
        try:
            line = fmt % args
        except Exception:
            line = str(fmt)
        if "?" in line:
            line = line.split("?", 1)[0]
        sys.stderr.write("[webgl-server] %s - %s\n" % (self.address_string(), line))


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    default_root = os.path.normpath(os.path.join(script_dir, "..", "..", "..", "artifacts", "unity", "FCANebulaWebGL"))
    parser = argparse.ArgumentParser(description="FCA Nebula WebGL static server")
    parser.add_argument("--root", default=default_root, help="directory with index.html (default: artifacts/unity/FCANebulaWebGL)")
    parser.add_argument("--port", type=int, default=18080)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    if not os.path.isfile(os.path.join(root, "index.html")):
        print("[webgl-server] ERROR: index.html not found in %s" % root, file=sys.stderr)
        return 2
    configure_mime_types()
    handler = lambda *a, **kw: FcaWebGLHandler(*a, directory=root, **kw)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((args.bind, args.port), handler) as httpd:
        print("[webgl-server] serving %s at http://%s:%d/index.html" % (root, args.bind, args.port), flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
