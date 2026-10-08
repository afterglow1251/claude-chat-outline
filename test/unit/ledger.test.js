// Unit test for the question ledger (src/outline/ledger.ts) in Node: simulates a
// virtualized feed where only turns near the viewport are "mounted", with
// fresh node objects on every mount (like React). Run: node test/unit/ledger.test.js
'use strict';
const path = require('path');
const assert = require('assert');

// Minimal DOM-free environment for the content scripts.
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
globalThis.console.warn = (...a) => { throw new Error('warn: ' + a.join(' ')); };
// Bundle src/outline/ledger.ts (and what it imports) for Node on the fly.
const { outputFiles } = require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, '..', '..', 'src', 'outline', 'ledger.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  write: false,
});
const mod = { exports: {} };
new Function('module', 'exports', outputFiles[0].text)(mod, mod.exports);
const { createLedger } = mod.exports;

const VIEW = 800;

// A conversation: turns with heights; user turns carry text.
function conversation(prefix, questions, loaded) {
  const turns = questions.flatMap((text, i) => [
    { role: 'user', text, height: 120 },
    { role: 'assistant', text: 'a', height: 200 + (i % 5) * 150 },
  ]);
  turns.forEach((t, i) => (t.n = i + 1));
  return { turns, start: turns.length - loaded, numbered: true };
}

// With chat.estimate, a turn that was never rendered counts as 300px (like
// tanstack/react-virtual), so positions shift as turns get measured.
function layout(chat) {
  let y = 16;
  const shown = chat.turns.slice(chat.start);
  for (const t of shown) { t.top = y; y += (chat.estimate && !t.measured ? 300 : t.height) + 24; }
  return { shown, height: y + 16 };
}

// What is in the DOM for a given scrollTop (feed starts at container top).
const view = { scrollTop: 0 }; // shared, so node rects follow later scrolls
function mount(chat, scrollTop) {
  const { shown, height } = layout(chat);
  scrollTop = Math.max(0, Math.min(scrollTop, height - VIEW)); // like a real scroller
  view.scrollTop = scrollTop;
  const feed = { getBoundingClientRect: () => ({ top: -view.scrollTop, height }) };
  for (const t of shown) {
    const near = t.top + t.height >= scrollTop - VIEW && t.top <= scrollTop + 2 * VIEW;
    if (near && !t.node) {
      t.measured = true;
      const turn = t;
      t.node = {
        isConnected: true,
        getBoundingClientRect: () => ({ top: turn.top - view.scrollTop }),
        getAttribute: () => (chat.numbered ? `Message ${turn.n} of ${chat.turns.length}` : 'Message'),
      };
    } else if (!near && t.node) {
      t.node.isConnected = false;
      t.node = null;
    }
  }
  const items = shown.filter((t) => t.role === 'user' && t.node).map((t) => ({ target: t.node, full: t.text, label: t.text || '(attachment)' }));
  return { feed, items, height, max: Math.max(0, height - VIEW) };
}

function labels(ledger) { return ledger.list().map((e) => e.label); }

function scenario(name, numbered, { estimate = false, api = false } = {}) {
  const questions = Array.from({ length: 9 }, (_, i) => (i === 3 ? '' : i === 5 || i === 8 ? 'continue' : `question ${i + 1}`));
  const chat = conversation('A', questions, 12);
  chat.numbered = numbered;
  chat.estimate = estimate;
  const ledger = createLedger();
  if (api) ledger.setAuthoritative(questions);
  const see = (scrollTop) => { const m = mount(chat, scrollTop); ledger.absorb(m.items, m.feed); return m; };
  const expectedLoaded = questions.slice(3).map((t) => t || '(attachment)');
  const expectedAll = questions.map((t) => t || '(attachment)');

  // Open at the bottom, scroll up in half screens, then down.
  let m = see(1e9);
  const bottom = m.max;
  let prev = labels(ledger);
  const subseq = (a, b) => { let i = 0; for (const x of b) if (x === a[i]) i++; return i === a.length; };
  for (let y = bottom; y >= 0; y -= VIEW / 2) { see(Math.max(0, y)); const now = labels(ledger); assert(subseq(prev, now), `${name}: lost items scrolling up at ${y}: ${prev} -> ${now}`); prev = now; }
  see(0);
  for (let y = 0; y <= bottom; y += VIEW / 2) { see(y); const now = labels(ledger); assert(subseq(prev, now), `${name}: lost items scrolling down at ${y}`); prev = now; }
  assert.deepStrictEqual(labels(ledger), api ? expectedAll : expectedLoaded, `${name}: after one pass`);

  // Far jump to the middle, then to the top, then bottom (scrollbar drags).
  see(bottom / 2); see(0); see(bottom);
  assert.deepStrictEqual(labels(ledger), api ? expectedAll : expectedLoaded, `${name}: after far jumps`);

  // "Load earlier messages": 3 turns at a time are prepended while we are
  // mid-chat, with a rebuild in between and no explicit shift (as when the
  // user clicks Claude's own button): the shift must be inferred.
  see(bottom / 2);
  chat.start = 3;
  see(bottom / 2);
  chat.start = 0;
  see(bottom / 2);
  // Scan from top to bottom like scanAll().
  const max2 = layout(chat).height - VIEW;
  for (let y = 0; y <= max2; y += VIEW * 0.85) see(y);
  see(max2);
  assert.deepStrictEqual(labels(ledger), expectedAll, `${name}: after load earlier + scan`);

  // A new question is appended at the end while at the bottom.
  chat.turns.push({ role: 'user', text: 'new question', height: 120, n: chat.turns.length + 1 }, { role: 'assistant', text: 'a', height: 100, n: chat.turns.length + 2 });
  see(1e9);
  assert.deepStrictEqual(labels(ledger), [...expectedAll, 'new question'], `${name}: appended`);

  // Another pass up and down keeps it all.
  const max3 = layout(chat).height - VIEW;
  for (let y = max3; y >= 0; y -= VIEW / 2) see(Math.max(0, y));
  for (let y = 0; y <= max3; y += VIEW / 2) see(y);
  assert.deepStrictEqual(labels(ledger), [...expectedAll, 'new question'], `${name}: second pass`);
  console.log('PASS', name);
}

scenario('page only, numbered labels', true);
scenario('page only, unnumbered labels', false);
scenario('page only, estimated heights', false, { estimate: true });
scenario('API list', false, { api: true });
scenario('API list, estimated heights', false, { api: true, estimate: true });

// Cached list from an earlier visit + the bottom of the chat rendered.
{
  const questions = ['alpha', 'beta', 'continue', 'gamma', 'continue', 'delta'];
  const chat = conversation('C', questions, 12);
  chat.numbered = false;
  const ledger = createLedger();
  ledger.seed(questions);
  const m = mount(chat, 1e9);
  ledger.absorb(m.items, m.feed);
  assert.deepStrictEqual(labels(ledger), questions, 'cache: rendered turns attach, nothing duplicated or lost');
  assert(ledger.list().slice(-1)[0].node, 'cache: last question attached to its node');
  console.log('PASS cache seed + page');
}

// API list with positions, but the page numbers its turns differently
// (claude.ai's numbering does not follow the API's): no rendered turn may
// be attached to another question just because the numbers line up.
{
  const texts = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const ledger = createLedger();
  ledger.setAuthoritative(texts.map((text, i) => ({ text, pos: 2 * i + 1 })));
  // The page shows beta, gamma and delta; two of them carry the API's
  // number, but delta is numbered 9 (the page counts messages the API does
  // not): by number alone it would be taken for epsilon.
  const node = (name) => ({ isConnected: true, name, getBoundingClientRect: () => ({ top: 0 }) });
  const feed = { getBoundingClientRect: () => ({ top: 0 }) };
  const items = [
    { target: node('beta'), full: 'beta', label: 'beta', pos: 3 },
    { target: node('gamma'), full: 'gamma', label: 'gamma', pos: 5 },
    { target: node('delta'), full: 'delta', label: 'delta', pos: 9 },
  ];
  ledger.absorb(items, feed);
  const attached = ledger.list().map((e) => (e.node ? e.node.name : null));
  assert.deepStrictEqual(attached, [null, 'beta', 'gamma', 'delta', null], 'mismatched numbering: each turn attached to its own text');
  assert.deepStrictEqual(labels(ledger), texts, 'mismatched numbering: nothing added');
  console.log('PASS API list, page numbering differs');
}
