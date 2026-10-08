# Developing Claude Chat Outline

How the extension is built, how to fix it when claude.ai changes its page, and how to
test it. For installing and using it, see the [README](../README.md).

## How the list is built

claude.ai keeps only the messages near your viewport in the page (the list is
*virtualized*): as you scroll, messages above and below are removed from the page and
re-created later. So the outline is not built from what is on screen. It comes from three
sources, best first:

1. **claude.ai's conversation API.** When you open a chat, the extension asks claude.ai
   for that conversation, the same request claude.ai's own page makes. That gives every
   question at once, including messages behind "Load earlier messages", for the branch
   you are on. It asks again when you send a new question.
2. **A cache per chat** in the extension's local storage. A chat you have opened before is
   listed in full immediately, even if the API is unavailable. The 200 most recent chats
   are kept, none longer than 90 days.
3. **What has been rendered.** Without the API, every question that was ever rendered is
   kept. Items are never removed because their message is not on screen, and the order
   never changes.

Rendered messages are matched to the list by their position in the conversation
(`aria-posinset`, "Message 13 of 34"), so questions with code blocks or markdown, which
render differently from how they are stored, still match.

Clicking a question that is not rendered right now scrolls to where it is expected, lets
claude.ai render that part, and corrects until it lands on the message. That includes
clicking "Load earlier messages" if the question is in that part.

If the API is unavailable and part of the chat was never rendered, the header count shows
a **+** (for example `12+`). **Load all** (↑ in the header) asks the API again. If that
fails it clicks "Load earlier messages" until it disappears, then scans the chat top to
bottom and returns you to where you were reading. It stops after 50 clicks, 30 seconds of
loading or 60 seconds of scanning, and can be cancelled.

## Files

```
src/manifest.json          manifest (the build adds the version from package.json)
src/main.ts                wiring + page lifecycle
src/core/selectors.ts      every claude.ai DOM hook + fallback chains (edit this when Claude's UI changes)
src/core/                  shared types, event names, logging, DOM builders
src/data/sources.ts        claude.ai conversation API + per-chat cache
src/data/page-bridge.ts    tiny script in the page's JS world (see below)
src/data/                  conversation parsing, relay of claude.ai's own conversation response
src/outline/outline.ts     session: observers, rebuilds, jumping, load-all, route changes
src/outline/               extraction, question ledger, scrolling, jump helpers, active tracking, load-all
src/ui/panel.ts            Shadow DOM panel: rendering, collapse/resize, theme, keyboard, storage
src/ui/panel.css           panel styles (loaded into the shadow root only)
icons/                     extension icons
docs/                      landing page (GitHub Pages), screenshots, this file
tools/build.mjs            builds the extension into dist/
tools/package.sh           builds the release ZIP
test/unit/                 ledger unit test
test/browser/              fixture page, browser self-test, headless runner, screenshots
```

Why `page-bridge.js`: content scripts run in an isolated JavaScript world. Patching
`history.pushState` from there doesn't see claude.ai's own navigations, and globals defined
there aren't visible in the DevTools console. The bridge runs in the page's world, patches
`pushState`/`replaceState`, defines `window.__claudeOutline.debug()`, and relays both to
the content script as DOM events. It reads no page data.

## If Claude changes their UI, fix it here

All selectors live in **`src/core/selectors.ts`**:

- `feed`: the message list container (currently `[role="feed"][aria-label="Chat messages"]`).
- `userMessageStrategies`: ordered fallbacks for finding *your* messages. The first one
  that returns anything wins.
- `userMessageBody`, `userHeadingPrefix`: used to get clean label text.
- `turn`, `turnPosition`: one conversation turn (currently
  `div[role="article"][aria-label="Message 13 of 34"]`) and its position in the
  conversation (`aria-posinset`, or the number in the label). The position is how a
  rendered message is matched to the API's list, so questions with code blocks or
  markdown, which render differently from how they are stored, still navigate.
- `loadEarlierButton`: the text of the lazy-load button.
- `conversationPaths`: which URLs show the panel.
- `layout.scrollOffset` / `layout.panelTop`: sticky-header height adjustments.
- `layout.unscannedGap`: how much empty feed above/below the rendered turns counts as
  "not rendered yet" (drives the `+` in the count).

**Step 1: see what's failing.** On a chat page, open DevTools → Console and run:

```js
__claudeOutline.debug()
```

It logs whether the feed was found, how many nodes each strategy matched, the turn
labels, the scroll container, the "Load earlier messages" button, and the outline state:
where the list came from (`api`, `cache` or `page`), whether the API answered, and how
many questions are known versus rendered.

If the API stops working (claude.ai changes it), the warning "conversation API
unavailable" appears in the console and the outline falls back to the cache and the page.
The request is built in `fetchQuestions` in `src/data/sources.ts`.

**Step 2: discover the new hooks.** Paste this into the Console, after replacing `PHRASE`
with a few words from one of *your* messages in the open chat:

```js
(() => {
  const PHRASE = 'a few words from one of YOUR messages';
  const hooks = (n) => ['role', 'aria-label', 'data-testid']
    .map((a) => n.getAttribute(a) && `${a}="${n.getAttribute(a)}"`).filter(Boolean).join(' ');
  const classes = (n) => typeof n.className === 'string' && n.className.trim()
    ? '.' + n.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
  const matches = [...document.querySelectorAll('body *')].filter((el) =>
    el.textContent.includes(PHRASE) && ![...el.children].some((c) => c.textContent.includes(PHRASE)));
  for (const el of matches) {
    console.group('Your message is inside:', el);
    for (let n = el, depth = 0; n && n !== document.body && depth < 12; n = n.parentElement, depth++) {
      console.log(`${'  '.repeat(depth)}<${n.tagName.toLowerCase()}> ${hooks(n)} ${classes(n)}`);
    }
    console.groupEnd();
  }
  console.log('role="feed" elements:', document.querySelectorAll('[role="feed"]'));
  console.log('Headings:', [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
    .map((h) => h.textContent.trim().slice(0, 50)));
  console.log('Load-earlier-like buttons:', [...document.querySelectorAll('button')]
    .filter((b) => /earlier|older|previous|more/i.test(b.textContent + ' ' + (b.getAttribute('aria-label') || ''))));
})();
```

Pick the most stable hook from the printed ancestors, preferring `aria-label`, then
`role`, then `data-testid`, and avoiding Tailwind classes. Add it as a new entry at the
top of `userMessageStrategies` (or update `feed`). Then reload the extension and the tab.

If the panel says **"Couldn't find your messages — selectors may be outdated"**, the feed
was found but no strategy matched. Start with step 1.

## Testing

### Automated fixture

`test/browser/fixture.html` reproduces the DOM structure described above: a scrollable ancestor, a
`role="feed"` list, `Message N of M` articles with `You said:` / `Claude responded:`
headings, and a "Load earlier messages" button that adds 3 turns per click. It loads the
content scripts directly, with a small stand-in for `chrome.storage`.

```sh
python3 test/browser/run.py    # headless: every variant below, prints PASS/FAIL lines
python3 test/browser/serve.py  # serves this folder on http://localhost:8765 for manual play
node test/unit/ledger.test.js  # ledger unit test (virtualized feed simulated in Node)
```

`test/browser/run.py` needs Google Chrome (pass another binary as the first argument).

README screenshots come from a demo chat in the fixture (`?demo=1`, `&dark=1`):

```sh
python3 test/browser/serve.py 8765 &
node test/browser/screenshots.mjs  # writes docs/screenshot-*.png and docs/social-preview.png
```

- Manual play: http://localhost:8765/chat/aaaaaaaa-0000-4000-8000-000000000001
  (top-bar buttons simulate navigation, streaming, feed replacement and dark mode).
- Self-test: add `?selftest=1`. Results appear bottom-left and in the tab title.
- Variants: `&variant=heading` (only the "You said:" heading, which exercises fallback
  strategy 2), `&variant=broken` (no hooks, which exercises the error state),
  `&virtual=1` (turns far from the viewport are unmounted like on claude.ai) and
  `&nonum=1` (aria-labels without numbers), `&estimate=1` (with `virtual`: never-rendered
  turns get an estimated height, so positions shift while scrolling), `&api=1` (the
  fixture answers the conversation API with every question) and `&cds=1` (claude.ai's
  current markup: `transcript-row` > `div[role=article]` with `aria-posinset`, plus a
  question containing a code block).

### Manual checklist on claude.ai

- [ ] **Short chat** (2–3 questions): every question listed in order, click jumps and
      flashes the message, active item follows scrolling.
- [ ] **Long chat (100+ messages):** every question is listed right after opening, with
      no `+`. Scroll up and down: the list never changes. Click the very first question:
      the page goes there (loading earlier messages if needed) and the message flashes.
      `__claudeOutline.debug()` reports `source: 'api'`.
- [ ] **Cache:** open a long chat, open another one, come back: the full list is there at
      once.
- [ ] **Without the API** (DevTools → Network → block `*chat_conversations*`, reload):
      scroll up and down, items are only ever added. **Load all** shows "Scanning the
      chat… NN%", finishes with "All questions loaded.", your reading position is
      unchanged and every question is listed. Try **Cancel** mid-way.
- [ ] **Mid-stream:** send a question. It appears in the outline within ~1s while Claude is
      still answering, and the list doesn't flicker.
- [ ] **Switch conversations without reloading** (sidebar click, then browser Back): the
      outline switches to the right chat each time with no leftover items.
- [ ] **Collapsed state survives reload:** collapse, reload, still collapsed. Width and
      push/overlay mode also persist.
- [ ] **Dark / light:** switch Claude's appearance setting. The panel follows without a
      reload. Also try with the OS theme set the opposite way.
- [ ] **Non-chat pages** (`/new`, `/projects`, `/recents`, settings): the panel is fully
      hidden and nothing on the page is blocked.
- [ ] **Shortcut:** Cmd/Ctrl+Shift+O toggles the panel and does not open the Bookmark
      Manager. Esc collapses it while it's focused.
- [ ] **Push mode:** the chat content actually shifts left. If it doesn't, see the note
      in "Known limitations".
- [ ] **Console:** no errors from the extension while doing all of the above.

## Known limitations

- The conversation API is not a public API. If claude.ai changes it, the outline falls
  back to the cache and the page. Then questions never rendered can't be listed until you
  scroll past them or press **Load all**.
- Without the API, an edited question can leave its old text in the list until you press
  **Load all**, which rebuilds the list from a full scan.
- Jumping to a question claude.ai has not rendered takes a few quick hops while claude.ai
  renders the parts in between.

- **Push mode** sets `padding-right` on `<body>` (and restores the original value). If
  claude.ai sizes its layout with `100vw` or `position: fixed`, the padding won't move the
  content, and overlay mode is what you get.
- In overlay mode the panel can cover Claude's artifact/side panel when that is open.
  Collapse the outline in that case.
- `panel.css` is listed in `web_accessible_resources` for claude.ai only, so the content
  script can read it into the Shadow DOM. A side effect is that claude.ai could tell the
  extension is installed.

## Releasing

1. Bump `version` in `manifest.json`.
2. `tools/package.sh` builds `dist/claude-chat-outline.zip` (only the files the extension
   needs, inside a `claude-chat-outline/` folder).
3. `gh release create vX.Y.Z dist/claude-chat-outline.zip --title "vX.Y.Z" --notes "…"`.
   The README's download link always points at the latest release's
   `claude-chat-outline.zip`.
