#!/usr/bin/env python3
"""Минимальный статический сервер для эмуляции чёрной дыры (только стандартная библиотека).

По умолчанию слушает 127.0.0.1:8080 — доступ через SSH-туннель:
    ssh -L 8080:localhost:8080 <user>@<server>   →   http://localhost:8080
Публичный доступ: python3 serve.py --host 0.0.0.0
"""
import argparse
import functools
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
ALLOWED_TOP = {"index.html", "js", "shaders", ""}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".frag": "text/plain; charset=utf-8",
        ".vert": "text/plain; charset=utf-8",
    }

    def _allowed(self):
        # Отдаём только файлы приложения (не serve.py, тесты и т.п.)
        top = self.path.split("?", 1)[0].lstrip("/").split("/", 1)[0]
        if top in ALLOWED_TOP:
            return True
        self.send_error(404)
        return False

    def do_GET(self):
        if self._allowed():
            super().do_GET()

    def do_HEAD(self):
        if self._allowed():
            super().do_HEAD()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # без логов — файл не растёт


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    a = ap.parse_args()
    handler = functools.partial(Handler, directory=ROOT)
    srv = ThreadingHTTPServer((a.host, a.port), handler)
    print(f"Сервер: http://{a.host}:{a.port}/", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
