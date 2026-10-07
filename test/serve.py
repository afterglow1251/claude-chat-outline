"""Serve the extension folder for the fixture.

Every /chat/<id> and /new path returns test/fixture.html, so SPA navigation and
reloads behave like claude.ai. The self-test POSTs its results to /selftest,
which test/run.py reads. Usage: python3 test/serve.py [port]
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
RESULTS = {}  # query string -> text posted by test/selftest.js


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/chat/") or path.startswith("/project/") or path == "/new":
            self.path = "/test/fixture.html"
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/selftest":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        RESULTS[self.path.split("?", 1)[1] if "?" in self.path else ""] = body.decode("utf-8", "replace")
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"Fixture: http://localhost:{PORT}/chat/aaaaaaaa-0000-4000-8000-000000000001")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
