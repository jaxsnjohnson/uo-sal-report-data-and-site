#!/usr/bin/env python3
"""Serve the working tree with browser reloads; no dependencies or file rewrites."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DIRS = {'analysis', 'css', 'data', 'foia', 'html_reports', 'icons', 'js', 'reports'}
PUBLIC_FILES = {'index.html', 'records.html', 'records.json', 'inflation.html',
                'inflation.json', 'upper-middle-mang-report.html', 'robots.txt', 'sitemap.xml'}
revision = str(time.time_ns())


def allowed(path):
    parts = path.parts
    return (all(not part.startswith('.') and part != '__pycache__' for part in parts)
            and (not parts or parts[0] in PUBLIC_DIRS
                 or (len(parts) == 1 and parts[0] in PUBLIC_FILES)))


def snapshot():
    result = []
    for directory, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if allowed((Path(directory) / d).relative_to(ROOT))
                   and not (Path(directory) / d).is_symlink()]
        for name in files:
            path = Path(directory) / name
            if not allowed(path.relative_to(ROOT)) or path.is_symlink():
                continue
            try:
                stat = path.stat()
                result.append((str(path.relative_to(ROOT)), stat.st_mtime_ns, stat.st_size))
            except FileNotFoundError:
                pass
    return hashlib.sha256(repr(sorted(result)).encode()).hexdigest()


def watch():
    global revision
    previous = snapshot()
    while True:
        time.sleep(2)
        current = snapshot()
        if current != previous:
            previous = current
            revision = str(time.time_ns())


SCRIPT = b'''<script>
(() => {
  let previous;
  setInterval(async () => {
    try {
      const response = await fetch('/__preview_revision', {cache: 'no-store'});
      const current = (await response.json()).revision;
      if (previous && current !== previous) location.reload();
      previous = current;
    } catch (_) {}
  }, 1000);
})();
</script>'''


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Robots-Tag', 'noindex, nofollow')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(403, 'Directory listing disabled')

    def send_head(self):
        url_path = unquote(urlsplit(self.path).path)
        if url_path == '/__preview_revision':
            data = json.dumps({'revision': revision}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            return io.BytesIO(data)
        relative = Path(url_path.lstrip('/'))
        candidate = ROOT / relative
        if (not allowed(relative) or not candidate.resolve().is_relative_to(ROOT)
                or any(p.is_symlink() for p in [candidate, *candidate.parents] if p != ROOT)):
            self.send_error(404)
            return None
        if candidate.is_dir():
            candidate /= 'index.html'
        if candidate.is_symlink():
            self.send_error(404)
            return None
        if candidate.is_file() and candidate.suffix.lower() in {'.html', '.htm'}:
            if not candidate.resolve().is_relative_to(ROOT):
                self.send_error(404)
                return None
            if not url_path.endswith('/') and (ROOT / relative).is_dir():
                return super().send_head()
            data = candidate.read_bytes()
            position = data.lower().rfind(b'</body>')
            data = data[:position] + SCRIPT + data[position:] if position >= 0 else data + SCRIPT
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            return io.BytesIO(data)
        return super().send_head()

    def log_message(self, format, *args):
        if urlsplit(self.path).path != '/__preview_revision':
            super().log_message(format, *args)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8085)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    threading.Thread(target=watch, daemon=True).start()
    print(f'Preview: http://{args.host}:{args.port}', flush=True)
    server.serve_forever()
