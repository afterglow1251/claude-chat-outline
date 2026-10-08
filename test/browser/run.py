"""Run the self-test headlessly in every fixture variant.

Usage: python3 test/browser/run.py [path-to-chrome]
Starts the fixture server on a free port, opens each variant in headless
Chrome, waits for test/browser/selftest.js to POST its results, and prints them.
Exit code 1 if any variant fails.
"""
import http.server
import os
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve  # noqa: E402

CHROME = sys.argv[1] if len(sys.argv) > 1 else "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
VARIANTS = [
    "",
    "&variant=heading",
    "&variant=broken",
    "&virtual=1",
    "&virtual=1&nonum=1",
    "&virtual=1&variant=heading",
    "&virtual=1&estimate=1",
    "&virtual=1&estimate=1&nonum=1",
    "&virtual=1&api=1",
    "&virtual=1&estimate=1&api=1",
    "&virtual=1&estimate=1&api=1&cds=1",
    "&virtual=1&estimate=1&cds=1",
    "&virtual=1&estimate=1&intercept=1",
    "&virtual=1&estimate=1&intercept=1&cds=1",
    "&virtual=1&api=1&wheelload=1",
    "&virtual=1&estimate=1&api=1&cds=1&wheelload=1",
]
TIMEOUT_S = 120


def run_variant(port, profile, variant):
    query = f"selftest=1{variant}"
    url = f"http://127.0.0.1:{port}/chat/aaaaaaaa-0000-4000-8000-000000000001?{query}"
    chrome = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
         f"--user-data-dir={profile}", "--window-size=1200,800", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.time() + TIMEOUT_S
        while time.time() < deadline:
            # The page navigates during the test; the POST carries the original query.
            for key, text in serve.RESULTS.items():
                if key.startswith(query):
                    return text
            time.sleep(0.5)
        return f"TIMEOUT after {TIMEOUT_S}s (no results posted)"
    finally:
        chrome.kill()
        chrome.wait()


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    failed = 0
    for variant in VARIANTS:
        # A fresh profile per variant: the outline's cache lives in the
        # page's storage and must not leak from one variant into the next.
        with tempfile.TemporaryDirectory() as profile:
            serve.RESULTS.clear()
            text = run_variant(port, profile, variant)
            print(f"\n=== {variant or '(default)'}")
            print(text.strip())
            if "SELFTEST PASS" not in text:
                failed += 1
    server.shutdown()
    print(f"\n{len(VARIANTS) - failed}/{len(VARIANTS)} variants passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
