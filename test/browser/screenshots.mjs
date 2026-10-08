// Render the README screenshots from the demo chat (test/browser/fixture.html?demo=1).
//
// Usage: python3 test/browser/serve.py 8765 &   then   node test/browser/screenshots.mjs
// (CHROME=/path/to/chrome to override). Writes docs/screenshot-light.png and
// docs/screenshot-dark.png and docs/social-preview.png. Drives headless Chrome over the DevTools
// protocol with Node's built-in WebSocket, so there are no dependencies.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const PORT = 9333;
const SHOTS = { 'screenshot-light.png': '', 'screenshot-dark.png': '&dark=1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'co-shot-'))}`, 'about:blank',
], { stdio: 'ignore' });

try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    await sleep(200);
    targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg.result);
    if (msg.method === 'Runtime.exceptionThrown') console.error('page error:', msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      pending.set(++id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 2, mobile: false });
  mkdirSync(join(ROOT, 'docs'), { recursive: true });
  for (const [name, extra] of Object.entries(SHOTS)) {
    await send('Page.navigate', { url: `${BASE}/chat/aaaaaaaa-0000-4000-8000-000000000001?demo=1${extra}` });
    await sleep(2500); // outline renders, demo scrolls to question 7
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(ROOT, 'docs', name), Buffer.from(data, 'base64'));
    console.log('wrote docs/' + name);
  }
  // Social preview card, 1280x640 (upload in GitHub: Settings > Social preview).
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/test/browser/social-card.html` });
  await sleep(1500);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(ROOT, 'docs', 'social-preview.png'), Buffer.from(data, 'base64'));
  console.log('wrote docs/social-preview.png');
  ws.close();
} finally {
  chrome.kill();
}
