# Claude Chat Outline

A Chrome extension (Manifest V3) that adds a panel on the right side of claude.ai chats
listing **your own questions** in order. Click a question to jump to it. The question
currently in view is highlighted as you scroll.

No build step, no dependencies, no network requests, no analytics. The only permission is
`storage` (used to remember whether the panel is collapsed, its width and the layout mode).

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `claude-chat-outline` folder.
4. Open (or reload) any `https://claude.ai/chat/…` conversation.

After editing any file, click the reload icon on the extension card and **reload the
claude.ai tab**. The old content script stays attached to an open tab until you do.

Requires Chrome 114+ (uses `world: "MAIN"` content scripts and the `scrollend` event).

## Using it

| Action | How |
| --- | --- |
| Jump to a question | Click it, or Tab into the list and press Enter |
| Move between questions | ↑ / ↓ / Home / End |
| Show / hide the panel | **Cmd+Shift+O** (Mac) / **Ctrl+Shift+O** (Windows/Linux), or the › button / the "Outline" tab |
| Collapse while focused | Esc |
| Resize | Drag the panel's left edge, or focus it and press ← / → (200–520 px) |
| Push mode | The ◫ button in the header reserves space on the right instead of overlaying the chat |

**About the shortcut:** Chrome uses the same keys for its Bookmark Manager. The extension
intercepts the key press first, which works in testing. If the Bookmark Manager opens
instead on your machine, change the `e.code !== 'KeyO'` check in `src/panel.js`.

### "Load all questions" and long chats

For long conversations claude.ai only renders the most recent turns and shows a
**"Load earlier messages"** button at the top. Questions that aren't loaded can't appear in
the outline. When there are more to load, the header count shows a **+** (for example
`12+`).

The **Load all** button (↑ arrow in the header) clicks "Load earlier messages" repeatedly
until it disappears, then rebuilds the outline and returns you to where you were reading.
It never runs on its own. It stops after 50 clicks or 30 seconds, whichever comes first
(click again to continue), and you can **Cancel** at any time.

## Files

```
manifest.json
src/selectors.js    every claude.ai DOM hook + fallback chains (edit this when Claude's UI changes)
src/outline.js      extraction, observers, scrolling, active tracking, load-all, route changes
src/panel.js        Shadow DOM panel: rendering, collapse/resize, theme, keyboard, storage
src/panel.css       panel styles (loaded into the shadow root only)
src/main.js         wiring + page lifecycle
src/page-bridge.js  tiny script in the page's JS world (see below)
icons/              placeholder icons
test/               fixture page + automated self-test
```

Why `page-bridge.js`: content scripts run in an isolated JavaScript world. Patching
`history.pushState` from there doesn't see claude.ai's own navigations, and globals defined
there aren't visible in the DevTools console. The bridge runs in the page's world, patches
`pushState`/`replaceState`, defines `window.__claudeOutline.debug()`, and relays both to
the content script as DOM events. It reads no page data.

## If Claude changes their UI, fix it here

All selectors live in **`src/selectors.js`**:

- `feed`: the message list container (currently `[role="feed"][aria-label="Chat messages"]`).
- `userMessageStrategies`: ordered fallbacks for finding *your* messages. The first one
  that returns anything wins.
- `userMessageBody`, `userHeadingPrefix`: used to get clean label text.
- `loadEarlierButton`: the text of the lazy-load button.
- `conversationPaths`: which URLs show the panel.
- `layout.scrollOffset` / `layout.panelTop`: sticky-header height adjustments.

**Step 1: see what's failing.** On a chat page, open DevTools → Console and run:

```js
__claudeOutline.debug()
```

It logs whether the feed was found, how many nodes each strategy matched, the scroll
container, and the "Load earlier messages" button.

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

`test/fixture.html` reproduces the DOM structure described above: a scrollable ancestor, a
`role="feed"` list, `Message N of M` articles with `You said:` / `Claude responded:`
headings, and a "Load earlier messages" button that adds 3 turns per click. It loads the
content scripts directly, with a small stand-in for `chrome.storage`.

```sh
python3 test/serve.py          # serves this folder on http://localhost:8765
```

- Manual play: http://localhost:8765/chat/aaaaaaaa-0000-4000-8000-000000000001
  (top-bar buttons simulate navigation, streaming, feed replacement and dark mode).
- Self-test: add `?selftest=1`. Results appear bottom-left and in the tab title.
- Variants: `&variant=heading` (only the "You said:" heading, which exercises fallback
  strategy 2) and `&variant=broken` (no hooks, which exercises the error state).

### Manual checklist on claude.ai

- [ ] **Short chat** (2–3 questions): every question listed in order, click jumps and
      flashes the message, active item follows scrolling.
- [ ] **Long chat (100+ messages):** count shows `N+`. **Load all** shows a spinner and
      progress, finishes with "All earlier messages loaded.", your reading position is
      unchanged, and every question is listed. Try **Cancel** mid-way.
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

- **Push mode** sets `padding-right` on `<body>` (and restores the original value). If
  claude.ai sizes its layout with `100vw` or `position: fixed`, the padding won't move the
  content, and overlay mode is what you get.
- In overlay mode the panel can cover Claude's artifact/side panel when that is open.
  Collapse the outline in that case.
- `panel.css` is listed in `web_accessible_resources` for claude.ai only, so the content
  script can read it into the Shadow DOM. A side effect is that claude.ai could tell the
  extension is installed.
