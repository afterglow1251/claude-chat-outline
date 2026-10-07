// Outline core: extraction, the question ledger, observers, scrolling,
// active tracking, load-all. Never writes to Claude's DOM, except a
// temporary inline outline on the article you jump to, fully reverted after
// FLASH_MS.
//
// claude.ai virtualizes the message list: only the turns near the viewport
// are in the DOM, and they are unmounted again as you scroll. So the outline
// is not "what is rendered" but a ledger of the conversation's questions:
// taken from claude.ai's own API when possible (complete at once), from a
// per-chat cache, and from everything rendered so far. Entries are never
// dropped because their message is not rendered right now.
(() => {
  'use strict';

  const S = globalThis.ClaudeOutlineSelectors;
  const LOG = '[Claude Outline]';

  const LABEL_MAX = 90;
  const ATTACHMENT_LABEL = '(attachment)';
  const REBUILD_DEBOUNCE_MS = 150;
  // A plain debounce never fires while Claude streams (mutations arrive every
  // few ms), so a question you just sent would not appear until the answer
  // finished. Force a rebuild at least this often.
  const REBUILD_MAX_WAIT_MS = 1000;
  const FLASH_MS = 1200;
  const LOAD_MAX_CLICKS = 50;
  const LOAD_MAX_MS = 30000;
  const LOAD_STEP_TIMEOUT_MS = 8000;
  // Scanning: scroll through the whole chat so the virtualizer renders (and
  // the ledger records) every question.
  const SCAN_MAX_MS = 60000;
  const SCAN_SETTLE_MS = 250;
  const SCAN_MAX_ROUNDS = 3;
  // Jumping to a question that is not in the DOM: scroll to where it is
  // expected, let claude.ai render it, then correct.
  const SEEK_MAX_STEPS = 40;
  const SEEK_SETTLE_MS = 300;
  // Offsets drift a little as the virtualizer re-measures turns.
  const OFFSET_SLACK = 4;
  // Questions are matched by their first KEY_LEN letters and digits.
  const KEY_LEN = 48;
  const CACHE_WAIT_MS = 500;
  const SAVE_DELAY_MS = 1000;
  const API_MIN_INTERVAL_MS = 4000;

  const LOCATION_EVENT = 'claude-outline:locationchange'; // sent by page-bridge.js
  const DEBUG_EVENT = 'claude-outline:debug'; // sent by page-bridge.js

  // ---------------------------------------------------------------------------
  // Safe DOM helpers. A broken selector must degrade to "nothing found",
  // never to an exception that breaks claude.ai.
  // ---------------------------------------------------------------------------

  const warned = new Set();
  function warnOnce(key, err) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(LOG, key, err);
  }

  function safe(label, fn, fallback) {
    try {
      return fn();
    } catch (err) {
      warnOnce(label, err);
      return fallback;
    }
  }

  const q = Object.freeze({
    one: (root, sel) => safe(sel, () => (root || document).querySelector(sel), null),
    all: (root, sel) => safe(sel, () => Array.from((root || document).querySelectorAll(sel)), []),
    text: (el) => safe('textContent', () => (el && el.textContent) || '', ''),
  });

  function isConversationPath(pathname) {
    return S.conversationPaths.some((re) => re.test(pathname));
  }

  // ---------------------------------------------------------------------------
  // Extraction
  // ---------------------------------------------------------------------------

  function findFeed() {
    for (const sel of S.feed) {
      const el = q.one(document, sel);
      if (el) return el;
    }
    return null;
  }

  function runStrategy(strategy, feed) {
    const nodes = safe(strategy.name, () => strategy.find(feed, q), []);
    return Array.isArray(nodes) ? nodes : [];
  }

  // Returns { strategy, hits: [{ turn, source }] } using the first strategy
  // with results. `turn` is the scroll target, `source` the matched node.
  function findUserMessages(feed) {
    for (const strategy of S.userMessageStrategies) {
      const nodes = runStrategy(strategy, feed);
      if (nodes.length > 0) return { strategy: strategy.name, hits: groupByTurn(nodes) };
    }
    return { strategy: null, hits: [] };
  }

  // One bullet per turn, even if a selector matches several nodes inside it.
  function groupByTurn(nodes) {
    const seen = new Set();
    const hits = [];
    for (const source of nodes) {
      const turn = safe('closest', () => source.closest('article'), null) || source;
      if (seen.has(turn)) continue;
      seen.add(turn);
      hits.push({ turn, source });
    }
    return hits;
  }

  function messageText({ turn, source }) {
    // Strategies 1 and 3 match the message body directly.
    if (source !== turn) return q.text(source);
    // Strategy 2 matches the whole article; its text would include the
    // heading and button labels, so look for the body inside it first.
    const body = q.one(turn, S.userMessageBody);
    if (body) return q.text(body);
    // The "You said: …" heading is a screen-reader heading that carries the
    // message itself. If it is empty after the prefix, the message has no
    // text (attachment only); don't fall back to the article, whose text
    // would be button labels like "Edit".
    const heading = safe('heading', () => S.userHeadingIn(turn, q), null);
    if (heading) return q.text(heading).replace(S.userHeadingPrefix, '');
    return q.text(turn);
  }

  function truncate(text) {
    return text.length <= LABEL_MAX ? text : text.slice(0, LABEL_MAX - 1).trimEnd() + '…';
  }

  function toItem(hit) {
    const full = messageText(hit).replace(/\s+/g, ' ').trim();
    return { target: hit.turn, full, label: full ? truncate(full) : ATTACHMENT_LABEL };
  }

  // status: 'no-feed' | 'empty' | 'selectors-broken' | 'ok'
  // Reports only what is in the DOM right now; the ledger adds the rest.
  function collect(feed) {
    if (!feed) return { status: 'no-feed', strategy: null, items: [] };
    const { strategy, hits } = findUserMessages(feed);
    const items = hits.map(toItem);
    let status = 'ok';
    // Only call it "broken" if the feed actually shows something. An empty
    // feed is normal for a moment right after navigation.
    if (!items.length) status = q.text(feed).trim() ? 'selectors-broken' : 'empty';
    return { status, strategy, items };
  }

  function findLoadEarlierButton() {
    const { selector, text } = S.loadEarlierButton;
    return (
      q.all(document, selector).find(
        (b) => text.test(q.text(b)) || text.test(b.getAttribute('aria-label') || '')
      ) || null
    );
  }

  // ---------------------------------------------------------------------------
  // Ledger: every question of this conversation that we know of, in order.
  //
  // An entry is { key, full, label, node, offset, pending }. `node` is the
  // rendered turn, or null while claude.ai has it unmounted. `offset` is the
  // turn's top relative to the feed's top when last seen (independent of the
  // scroll position); it is only an estimate used to jump back to it.
  //
  // Two modes:
  //  - authoritative: the list came from claude.ai's API and is complete.
  //    Rendered turns are only *attached* to entries, never added (except a
  //    question you just sent, until the API is asked again).
  //  - page only: the list is built from what has been rendered (plus the
  //    cache). It only ever grows: an entry is never removed because it is
  //    not rendered right now. The one way to rebuild it from scratch is a
  //    completed "Load all" scan.
  //
  // Rendered turns are always a contiguous run of the conversation, which is
  // what makes it possible to place them among entries that are unmounted.
  // ---------------------------------------------------------------------------

  // Matching key: letters and digits only, so markdown, whitespace and
  // punctuation differences between the API text and the rendered text
  // don't matter.
  function keyOf(full) {
    return full.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, KEY_LEN);
  }

  function makeEntry(text) {
    const full = (text || '').replace(/\s+/g, ' ').trim();
    return { key: keyOf(full), full, label: full ? truncate(full) : ATTACHMENT_LABEL, node: null, offset: null, pending: false };
  }

  // Longest common subsequence of keys, as [[i in a, j in b], ...] in order.
  // A single item is matched to the same-key candidate closest by offset.
  function alignKeys(a, b) {
    if (!a.length || !b.length) return [];
    if (a.length === 1) {
      let best = -1;
      const dist = (j) => (b[j].offset == null || a[0].offset == null ? Infinity : Math.abs(b[j].offset - a[0].offset));
      for (let j = 0; j < b.length; j++) {
        if (b[j].key === a[0].key && (best === -1 || dist(j) < dist(best))) best = j;
      }
      return best === -1 ? [] : [[0, best]];
    }
    const n = a.length;
    const m = b.length;
    if (n * m > 4e6) {
      // Too big for the table: greedy in-order matching.
      const pairs = [];
      let j = 0;
      for (let i = 0; i < n && j < m; i++) {
        let k = j;
        while (k < m && b[k].key !== a[i].key) k++;
        if (k < m) {
          pairs.push([i, k]);
          j = k + 1;
        }
      }
      return pairs;
    }
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = a[i].key === b[j].key ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      }
    }
    const pairs = [];
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (a[i].key === b[j].key && t[i * w + j] === t[(i + 1) * w + j + 1] + 1) {
        pairs.push([i, j]);
        i++;
        j++;
      } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
      else j++;
    }
    return pairs;
  }

  function createLedger() {
    let entries = [];
    let authoritative = false;
    let wantsRefresh = false;
    let mismatch = false;
    let version = 0; // bumps whenever the list of questions changes

    function changed() {
      version++;
    }

    function sightings(items, feed) {
      const feedTop = feed.getBoundingClientRect().top;
      return items.map((item) => {
        const e = makeEntry(item.full);
        e.node = item.target;
        e.offset = item.target.getBoundingClientRect().top - feedTop;
        return e;
      });
    }

    // If every turn that stayed rendered moved by the same amount, something
    // was inserted above (earlier messages loaded), so the remembered
    // positions of unmounted entries moved by that amount too.
    function inferShift(seen) {
      const byNode = new Map(entries.filter((e) => e.node).map((e) => [e.node, e]));
      let delta = null;
      for (const s of seen) {
        const e = byNode.get(s.node);
        if (!e || e.offset == null) continue;
        const d = s.offset - e.offset;
        if (delta === null) delta = d;
        else if (Math.abs(d - delta) > OFFSET_SLACK) return;
      }
      if (delta !== null && Math.abs(delta) > OFFSET_SLACK) shift(delta);
    }

    function shift(delta) {
      if (delta) for (const e of entries) if (!e.node && e.offset != null) e.offset += delta;
    }

    function absorb(items, feed) {
      if (!items.length || !feed) return;
      const seen = sightings(items, feed);
      const present = new Set(seen.map((s) => s.node));
      for (const e of entries) if (e.node && !present.has(e.node)) e.node = null;
      inferShift(seen);
      if (!authoritative) return absorbGrowing(seen, true);
      if (absorbContiguous(seen, feed)) return;
      // Rendered text that doesn't match the API's: attach what matches,
      // add nothing (the API list is the complete one).
      if (!mismatch) {
        mismatch = true;
        warnOnce('rendered questions differ from the API list', seen.map((s) => s.label));
      }
      absorbGrowing(seen, false);
    }

    // Authoritative mode: find where the rendered run sits in the list.
    function absorbContiguous(seen, feed) {
      const n = entries.length;
      const fits = (start) => {
        if (start < 0) return false;
        let overlap = 0;
        for (let i = 0; i < seen.length && start + i < n; i++) {
          if (entries[start + i].key !== seen[i].key) return false;
          overlap++;
        }
        return overlap > 0 || n === 0;
      };
      let start = null;
      const byNode = new Map();
      entries.forEach((e, j) => e.node && byNode.set(e.node, j));
      for (let i = 0; i < seen.length && start === null; i++) {
        const j = byNode.get(seen[i].node);
        if (j !== undefined) start = j - i;
      }
      if (start !== null && !fits(start)) start = null;
      if (start === null) {
        // Several places can fit when questions repeat: prefer the one whose
        // position in the list matches the position in the feed.
        const guess = (seen[0].offset / Math.max(1, feedHeight(feed))) * n;
        for (let s = 0; s <= n; s++) {
          if (fits(s) && (start === null || Math.abs(s - guess) < Math.abs(start - guess))) start = s;
        }
      }
      if (start === null) return false;
      seen.forEach((s, i) => {
        const j = start + i;
        if (j < entries.length) {
          entries[j].node = s.node;
          entries[j].offset = s.offset;
        } else {
          // A question newer than the API answer (just sent).
          s.pending = true;
          entries.push(s);
          wantsRefresh = true;
          changed();
        }
      });
      return true;
    }

    // Page-only mode: attach rendered turns to entries (by node, then by
    // text in order), and insert the ones not known yet in their place.
    function absorbGrowing(seen, insert) {
      const match = seen.map(() => -1);
      const byNode = new Map();
      entries.forEach((e, j) => e.node && byNode.set(e.node, j));
      let last = -1;
      seen.forEach((s, i) => {
        const j = byNode.get(s.node);
        if (j !== undefined && j > last) {
          match[i] = j;
          last = j;
        }
      });
      // Text-match each run of unmatched turns inside its gap.
      for (let i = 0; i < seen.length; ) {
        if (match[i] !== -1) {
          i++;
          continue;
        }
        let k = i;
        while (k < seen.length && match[k] === -1) k++;
        const lo = i > 0 ? match[i - 1] : -1;
        const hi = k < seen.length ? match[k] : entries.length;
        const candidates = [];
        for (let j = lo + 1; j < hi; j++) if (!entries[j].node) candidates.push(j);
        for (const [a, b] of alignKeys(seen.slice(i, k), candidates.map((j) => entries[j]))) match[i + a] = candidates[b];
        i = k;
      }
      seen.forEach((s, i) => {
        const e = entries[match[i]];
        if (!e) return;
        e.node = s.node;
        e.offset = s.offset;
        if (!authoritative && e.full !== s.full) {
          e.full = s.full;
          e.label = s.label;
          e.key = s.key;
          changed();
        }
      });
      if (!insert) return;
      const inserts = new Map(); // insert before entries[p]
      seen.forEach((s, i) => {
        if (match[i] !== -1) return;
        let p = null;
        for (let a = i - 1; a >= 0 && p === null; a--) if (match[a] !== -1) p = match[a] + 1;
        for (let b = i + 1; b < seen.length && p === null; b++) if (match[b] !== -1) p = match[b];
        if (p === null) {
          p = entries.findIndex((e) => e.offset != null && e.offset > s.offset);
          if (p === -1) p = entries.length;
        }
        if (!inserts.has(p)) inserts.set(p, []);
        inserts.get(p).push(s);
      });
      if (!inserts.size) return;
      const next = [];
      for (let p = 0; p <= entries.length; p++) {
        if (inserts.has(p)) next.push(...inserts.get(p));
        if (p < entries.length) next.push(entries[p]);
      }
      entries = next;
      changed();
    }

    // Replaces the list, keeping what we know about each question (its
    // rendered node and position) where the texts line up.
    function replaceWith(texts, isAuthoritative) {
      const next = texts.map(makeEntry);
      for (const [i, j] of alignKeys(entries, next)) {
        next[j].node = entries[i].node;
        next[j].offset = entries[i].offset;
      }
      const same = next.length === entries.length && next.every((e, j) => e.full === entries[j].full);
      entries = next;
      authoritative = isAuthoritative;
      mismatch = false;
      if (isAuthoritative) wantsRefresh = false;
      if (!same) changed();
    }

    return {
      absorb,
      shift,
      list: () => entries,
      // Cached questions from an earlier visit (page-only mode).
      seed: (texts) => replaceWith(texts, false),
      // The complete list from claude.ai's API.
      setAuthoritative: (texts) => replaceWith(texts, true),
      // A completed scan: the fresh list replaces everything.
      adopt(other) {
        entries = other.list().slice();
        changed();
      },
      isAuthoritative: () => authoritative,
      takeRefreshRequest() {
        const r = wantsRefresh;
        wantsRefresh = false;
        return r;
      },
      get version() {
        return version;
      },
    };
  }

  // Which parts of the feed (in feed-relative pixels) have been rendered at
  // some point, so the panel can say whether the page-only list is complete.
  function createCoverage() {
    let ranges = [];
    let height = 0;
    return {
      record(feed) {
        const turns = q.all(feed, S.turn);
        if (!turns.length) return;
        const rect = feed.getBoundingClientRect();
        height = rect.height;
        const start = turns[0].getBoundingClientRect().top - rect.top;
        const end = turns[turns.length - 1].getBoundingClientRect().bottom - rect.top;
        const merged = [];
        let cur = { start, end };
        for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
          if (r.end < cur.start - 1 || r.start > cur.end + 1) merged.push(r);
          else cur = { start: Math.min(cur.start, r.start), end: Math.max(cur.end, r.end) };
        }
        merged.push(cur);
        ranges = merged;
      },
      // True when some of the feed has never been rendered.
      incomplete() {
        if (!ranges.length) return false;
        const gap = S.layout.unscannedGap;
        return !ranges.some((r) => r.start <= gap && r.end >= height - gap);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Scrolling
  // ---------------------------------------------------------------------------

  function isDocScroller(el) {
    return el === document.scrollingElement || el === document.documentElement || el === document.body;
  }

  // Claude scrolls an inner element, not the window. Walk up from the feed
  // to the first ancestor that is both scrollable and actually overflowing.
  function findScrollContainer(from) {
    return safe(
      'scroll container',
      () => {
        for (let el = from; el && !isDocScroller(el); el = el.parentElement) {
          const overflowY = getComputedStyle(el).overflowY;
          const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
          if (scrollable && el.scrollHeight > el.clientHeight) return el;
        }
        return document.scrollingElement || document.documentElement;
      },
      document.scrollingElement || document.documentElement
    );
  }

  function scrollElementOf(container) {
    return isDocScroller(container) ? document.scrollingElement || document.documentElement : container;
  }

  function containerTop(container) {
    return isDocScroller(container) ? 0 : container.getBoundingClientRect().top;
  }

  function containerHeight(container) {
    return isDocScroller(container) ? window.innerHeight : container.clientHeight;
  }

  function scrollContainerBy(container, top, behavior) {
    if (isDocScroller(container)) window.scrollBy({ top, behavior });
    else container.scrollBy({ top, behavior });
  }

  function scrollContainerTo(container, top) {
    if (isDocScroller(container)) window.scrollTo({ top, behavior: 'instant' });
    else container.scrollTo({ top, behavior: 'instant' });
  }

  function scrollToElement(container, target) {
    const delta = target.getBoundingClientRect().top - containerTop(container) - S.layout.scrollOffset;
    scrollContainerBy(container, delta, 'smooth');
    flash(target);
  }

  // Temporary highlight via inline style, fully reverted afterwards
  // (including removing the style attribute if it didn't exist before).
  const flashing = new WeakMap();
  function flash(el) {
    const previous = flashing.get(el);
    if (previous) clearTimeout(previous.timer);
    const saved = previous
      ? previous.saved
      : {
          hadStyle: el.hasAttribute('style'),
          outline: el.style.outline,
          outlineOffset: el.style.outlineOffset,
          transition: el.style.transition,
        };
    el.style.transition = 'outline-color 300ms ease';
    el.style.outline = '2px solid rgba(217, 119, 87, 0.8)';
    el.style.outlineOffset = '4px';
    const timer = setTimeout(() => {
      flashing.delete(el);
      el.style.outline = saved.outline;
      el.style.outlineOffset = saved.outlineOffset;
      el.style.transition = saved.transition;
      if (!saved.hadStyle && !el.getAttribute('style')) el.removeAttribute('style');
    }, FLASH_MS);
    flashing.set(el, { saved, timer });
  }

  // ---------------------------------------------------------------------------
  // Active-item tracking
  // ---------------------------------------------------------------------------

  function mounted(entry) {
    return !!(entry && entry.node && entry.node.isConnected);
  }

  // The active item is the last question whose top is at or above the
  // "line" (scroller top + scrollOffset). Rendered questions decide it: the
  // rendered turns always cover the viewport, so if the first rendered
  // question is below the line, the one before it (unmounted, above) is the
  // active one. Remembered offsets are only used when no question is
  // rendered at all (deep inside a very long answer).
  function createActiveTracker(container, getFeed, onActive) {
    const isDoc = isDocScroller(container);
    const scrollEl = scrollElementOf(container);
    let targets = [];
    let current;
    let frame = 0;

    function compute() {
      frame = 0;
      if (!targets.length) return emit(-1);
      const line = containerTop(container) + S.layout.scrollOffset + 2;
      const tops = new Map();
      let firstMounted = -1;
      let lastMounted = -1;
      let lastAbove = -1;
      targets.forEach((t, i) => {
        if (!mounted(t)) return;
        const top = t.node.getBoundingClientRect().top;
        tops.set(i, top);
        if (firstMounted === -1) firstMounted = i;
        lastMounted = i;
        if (top <= line) lastAbove = i;
      });
      let active;
      if (lastAbove !== -1) active = lastAbove;
      else if (firstMounted !== -1) active = Math.max(0, firstMounted - 1);
      else {
        const feed = getFeed();
        const feedTop = feed ? feed.getBoundingClientRect().top : 0;
        active = 0;
        targets.forEach((t, i) => {
          if (t.offset != null && feedTop + t.offset <= line) active = i;
        });
      }
      // At the very bottom, a question followed by a short answer can never
      // reach the line, so clicking it would never mark it active. There,
      // prefer the last question that is actually visible.
      if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2) {
        const bottom = isDoc ? window.innerHeight : container.getBoundingClientRect().bottom;
        for (let i = lastMounted; i > active; i--) {
          if (tops.has(i) && tops.get(i) < bottom) {
            active = i;
            break;
          }
        }
      }
      emit(active);
    }

    function emit(index) {
      if (index === current) return;
      current = index;
      onActive(index);
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(() => safe('active tracking', compute));
    }

    const scrollTarget = isDoc ? window : container;
    scrollTarget.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);

    return {
      container,
      setTargets(next) {
        targets = next;
        current = undefined; // indexes shift when questions are added
        schedule();
      },
      destroy() {
        if (frame) cancelAnimationFrame(frame);
        scrollTarget.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', schedule);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Waiting for the page
  // ---------------------------------------------------------------------------

  function countTurns(feed) {
    if (!feed) return 0;
    const turns = q.all(feed, S.turn).length;
    // If the turn selector ever breaks, any growth of the feed still counts.
    return turns > 0 ? turns : feed.getElementsByTagName('*').length;
  }

  function feedHeight(feed) {
    return feed ? feed.getBoundingClientRect().height : 0;
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  // Resolves true as soon as predicate() holds (checked on DOM mutations,
  // not on a timer), or false on timeout / abort.
  function waitForDom(predicate, timeoutMs, signal) {
    return new Promise((resolve) => {
      if (safe('wait', predicate, false)) return resolve(true);
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        mo.disconnect();
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish(false);
      const mo = new MutationObserver(() => {
        if (safe('wait', predicate, false)) finish(true);
      });
      const timer = setTimeout(() => finish(safe('wait', predicate, false)), timeoutMs);
      mo.observe(document.body, { childList: true, subtree: true });
      signal.addEventListener('abort', onAbort);
    });
  }

  // Resolves one frame after the feed next changes (the virtualizer reacting
  // to a scroll), or after timeoutMs if it does not.
  function settle(feed, timeoutMs, signal) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        mo.disconnect();
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        requestAnimationFrame(() => resolve());
      };
      const mo = new MutationObserver(finish);
      if (feed && feed.isConnected) mo.observe(feed, { childList: true, subtree: true });
      const timer = setTimeout(finish, timeoutMs);
      signal.addEventListener('abort', finish);
    });
  }

  // Remember which turn is at the top of the view so the user's place can
  // be restored after earlier messages are prepended above it.
  function captureAnchor(feed) {
    if (!feed) return null;
    const container = findScrollContainer(feed);
    const top = containerTop(container);
    const turns = q.all(feed, S.turn);
    const el = turns.find((t) => t.getBoundingClientRect().bottom > top) || turns[0];
    return { el, top: el ? el.getBoundingClientRect().top : 0, feed, height: feedHeight(feed), container };
  }

  // Returns how far the anchor had moved (px), i.e. the height of what was
  // inserted above it. If the virtualizer unmounted the anchor meanwhile,
  // the growth of the feed is the best estimate.
  function restoreAnchor(anchor) {
    if (!anchor) return 0;
    const delta =
      anchor.el && anchor.el.isConnected
        ? anchor.el.getBoundingClientRect().top - anchor.top
        : feedHeight(anchor.feed.isConnected ? anchor.feed : findFeed()) - anchor.height;
    if (Math.abs(delta) > 1) scrollContainerBy(anchor.container, delta, 'instant');
    return delta;
  }

  // ---------------------------------------------------------------------------
  // "Load all questions": click "Load earlier messages" until it is gone,
  // then scan the whole chat so the virtualizer renders every question.
  // ---------------------------------------------------------------------------

  // reason: 'done' | 'cancelled' | 'limit' | 'timeout' | 'stalled'
  async function loadAllEarlier({ signal, getFeed, onProgress }) {
    const deadline = performance.now() + LOAD_MAX_MS;
    const anchor = captureAnchor(getFeed());
    let clicks = 0;
    let reason = 'done';
    let shift = 0;
    try {
      for (;;) {
        if (signal.aborted) { reason = 'cancelled'; break; }
        if (clicks >= LOAD_MAX_CLICKS) { reason = 'limit'; break; }
        const remaining = deadline - performance.now();
        if (remaining <= 0) { reason = 'timeout'; break; }
        const button = findLoadEarlierButton();
        if (!button) break;

        const before = countTurns(getFeed());
        const height = feedHeight(getFeed());
        button.click();
        clicks++;
        onProgress(clicks);

        // Progress = more turns in the feed, or a taller feed (a virtualized
        // list may keep the new turns unmounted). The button node itself is
        // not a reliable signal: React may swap it for a spinner mid-load.
        const grew = await waitForDom(
          () => countTurns(getFeed()) > before || feedHeight(getFeed()) > height + 1,
          Math.min(LOAD_STEP_TIMEOUT_MS, remaining),
          signal
        );
        if (!grew) {
          if (signal.aborted) reason = 'cancelled';
          else if (!findLoadEarlierButton()) reason = 'done';
          else reason = performance.now() >= deadline ? 'timeout' : 'stalled';
          break;
        }
        // Let React finish committing before looking for the next button.
        await nextFrame();
      }
    } finally {
      shift = restoreAnchor(anchor);
    }
    return { reason, clicks, shift };
  }

  // Scrolls from the top of the chat to the bottom one screen at a time,
  // calling absorb() after each step, then returns to where the user was.
  // reason: 'done' | 'cancelled' | 'timeout'
  async function scanAll({ signal, feed, absorb, onProgress }) {
    const container = findScrollContainer(feed);
    const scrollEl = scrollElementOf(container);
    const saved = scrollEl.scrollTop;
    const anchor = captureAnchor(feed);
    const deadline = performance.now() + SCAN_MAX_MS;
    let reason = 'done';
    try {
      let y = 0;
      for (let i = 0; i < 5000; i++) {
        if (signal.aborted) { reason = 'cancelled'; break; }
        if (performance.now() > deadline) { reason = 'timeout'; break; }
        scrollContainerTo(container, y);
        await settle(feed, SCAN_SETTLE_MS, signal);
        if (signal.aborted) { reason = 'cancelled'; break; }
        absorb();
        const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
        onProgress(max ? Math.min(100, Math.round((100 * y) / max)) : 100);
        if (y >= max - 1) break;
        y = Math.min(max, y + Math.max(200, scrollEl.clientHeight * 0.85));
      }
    } finally {
      scrollContainerTo(container, saved);
      await settle(feed, SCAN_SETTLE_MS, signal);
      absorb();
      restoreAnchor(anchor);
    }
    return { reason };
  }

  // ---------------------------------------------------------------------------
  // Session: everything that lives for one conversation.
  // view = { render(result), setActive(index), setLoadState(state) }
  // convId = the conversation id from the URL (the session lives as long as
  // that id stays the same; it is the cache key and the API key).
  // ---------------------------------------------------------------------------

  // Shared with debugReport().
  const debugState = { convId: null, source: 'none', api: 'not tried', questions: 0, rendered: 0 };

  function createSession(view, convId) {
    const Sources = globalThis.ClaudeOutlineSources;
    let stopped = false;
    let feed = null;
    let feedObserver = null;
    let bodyObserver = null;
    let tracker = null;
    let items = [];
    let debounceTimer = 0;
    let maxWaitTimer = 0;
    let acquireFrame = 0;
    let loadController = null;
    let seekController = null;
    let complete = false; // the list is known to be complete
    let apiState = 'idle'; // 'idle' | 'loading' | 'ok' | 'failed'
    let apiLast = 0;
    let apiTimer = 0;
    let saveTimer = 0;
    let savedVersion = 0;
    let scanLedger = null; // fresh list built during a page-only "Load all"
    const coverage = createCoverage();
    const ledger = createLedger();
    const cache = convId && Sources ? Sources.createCache(convId) : null;

    async function start() {
      Object.assign(debugState, { convId, source: 'page', api: 'not tried', questions: 0, rendered: 0 });
      // 1. What we remembered from an earlier visit: shown immediately.
      if (cache) {
        const record = await Promise.race([cache.load(), new Promise((r) => setTimeout(() => r(null), CACHE_WAIT_MS))]).catch(() => null);
        if (stopped) return;
        if (record && record.items.length) {
          ledger.seed(record.items);
          complete = record.complete;
          savedVersion = ledger.version;
          debugState.source = 'cache';
        }
      }
      // 2. What is rendered.
      // Claude may replace the feed node (e.g. when switching chats). This
      // observer only does an O(1) isConnected check per batch while the
      // feed is healthy, and re-queries for it once it is gone.
      bodyObserver = new MutationObserver(() => {
        if (feed && feed.isConnected) return;
        if (!acquireFrame) {
          acquireFrame = requestAnimationFrame(() => {
            acquireFrame = 0;
            acquireFeed();
          });
        }
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
      // A real scroll by the user ends any programmatic seek.
      window.addEventListener('wheel', cancelSeek, { passive: true });
      window.addEventListener('touchmove', cancelSeek, { passive: true });
      acquireFeed();
      // 3. The complete list from claude.ai's API.
      refreshFromApi();
    }

    function acquireFeed() {
      if (stopped) return;
      const next = findFeed();
      if (next !== feed) {
        if (feedObserver) feedObserver.disconnect();
        feedObserver = null;
        feed = next;
        if (feed) {
          feedObserver = new MutationObserver(scheduleRebuild);
          feedObserver.observe(feed, { childList: true, subtree: true });
        }
      }
      rebuild();
    }

    function scheduleRebuild() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushRebuild, REBUILD_DEBOUNCE_MS);
      if (!maxWaitTimer) maxWaitTimer = setTimeout(flushRebuild, REBUILD_MAX_WAIT_MS);
    }

    function flushRebuild() {
      clearTimeout(debounceTimer);
      clearTimeout(maxWaitTimer);
      debounceTimer = maxWaitTimer = 0;
      rebuild();
    }

    function rebuild() {
      if (stopped) return;
      if (feed && !feed.isConnected) return acquireFeed();
      const result = safe('rebuild', () => collect(feed), { status: 'selectors-broken', strategy: null, items: [] });
      if (feed && result.items.length) {
        safe('ledger', () => ledger.absorb(result.items, feed));
        safe('coverage', () => coverage.record(feed));
        if (scanLedger) safe('scan ledger', () => scanLedger.absorb(result.items, feed));
      }
      items = ledger.list();
      debugState.questions = items.length;
      debugState.rendered = result.items.length;
      const canLoadEarlier = !!findLoadEarlierButton();
      view.render({
        // The DOM may show nothing for a moment; what we know is still valid.
        status: items.length ? 'ok' : result.status,
        strategy: result.strategy,
        items,
        canLoadEarlier,
        incomplete: !complete && (canLoadEarlier || coverage.incomplete()),
      });
      updateTracker();
      if (ledger.takeRefreshRequest()) scheduleApiRefresh();
      scheduleSave();
    }

    function updateTracker() {
      const container = feed && items.length ? findScrollContainer(feed) : null;
      if (tracker && tracker.container !== container) {
        tracker.destroy();
        tracker = null;
      }
      if (!container) return view.setActive(-1);
      if (!tracker) tracker = createActiveTracker(container, () => feed, view.setActive);
      tracker.setTargets(items);
    }

    // ----- cache --------------------------------------------------------------

    function scheduleSave() {
      if (!cache || ledger.version === savedVersion || saveTimer) return;
      saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
    }

    function saveNow() {
      clearTimeout(saveTimer);
      saveTimer = 0;
      if (!cache || !items.length) return;
      savedVersion = ledger.version;
      // Pending questions (sent after the last API answer) are saved too; the
      // next API answer corrects the list anyway.
      cache.save(items.map((e) => e.full), complete);
    }

    // ----- API ----------------------------------------------------------------

    async function refreshFromApi() {
      if (!convId || !Sources || apiState === 'loading') return false;
      apiState = 'loading';
      debugState.api = 'loading';
      let texts = null;
      try {
        texts = await Sources.fetchQuestions(convId);
      } catch (err) {
        warnOnce('conversation API', err);
      }
      apiLast = performance.now();
      if (stopped) return false;
      // An empty answer for a chat that shows messages is not believable
      // (a brand-new chat the API has not caught up with yet).
      if (texts && (texts.length || !items.length)) {
        apiState = 'ok';
        debugState.api = `ok (${texts.length} questions)`;
        debugState.source = 'api';
        ledger.setAuthoritative(texts);
        complete = true;
        rebuild();
        saveNow();
        return true;
      }
      apiState = 'failed';
      debugState.api = texts ? 'empty answer' : 'unavailable (see warning above)';
      return false;
    }

    // A question appeared that the API answer did not have (you just sent
    // it): ask again, but not more often than every API_MIN_INTERVAL_MS.
    function scheduleApiRefresh() {
      if (apiTimer || apiState === 'failed') return;
      const wait = Math.max(0, API_MIN_INTERVAL_MS - (performance.now() - apiLast));
      apiTimer = setTimeout(() => {
        apiTimer = 0;
        refreshFromApi();
      }, wait);
    }

    // ----- jumping --------------------------------------------------------------

    function cancelSeek() {
      if (seekController) seekController.abort();
      seekController = null;
    }

    async function scrollTo(index) {
      const entry = items[index];
      if (!entry) return;
      if (!feed || !feed.isConnected) return scheduleRebuild();
      cancelSeek();
      const container = findScrollContainer(feed);
      if (mounted(entry)) return safe('scroll', () => scrollToElement(container, entry.node));

      // The question is not rendered. Jump to where it is expected, let
      // claude.ai render that part, and repeat: the rendered questions tell
      // which way (and roughly how far) it still is.
      seekController = new AbortController();
      const { signal } = seekController;
      const scrollEl = scrollElementOf(container);
      const lineOffset = () => containerTop(container) + S.layout.scrollOffset;
      let usedOffset = false;
      for (let step = 0; step < SEEK_MAX_STEPS; step++) {
        if (signal.aborted || stopped) return;
        const list = ledger.list();
        const i = list.indexOf(entry);
        if (i === -1) return;
        if (mounted(entry)) return safe('scroll', () => scrollToElement(container, entry.node));
        const rendered = [];
        list.forEach((e, j) => mounted(e) && rendered.push(j));
        const feedTop = feed.getBoundingClientRect().top;
        if (!usedOffset && entry.offset != null) {
          // Best first guess: where it was when last rendered.
          usedOffset = true;
          scrollContainerBy(container, feedTop + entry.offset - lineOffset(), 'instant');
        } else if (!rendered.length) {
          // Nothing rendered to steer by: go by its position in the list.
          scrollContainerTo(container, (i / Math.max(1, list.length)) * scrollEl.scrollHeight);
        } else {
          const first = rendered[0];
          const lastR = rendered[rendered.length - 1];
          if (i > first && i < lastR) return; // should be rendered; give up
          const spread = list[lastR].node.getBoundingClientRect().top - list[first].node.getBoundingClientRect().top;
          const perQuestion = lastR > first ? spread / (lastR - first) : scrollEl.scrollHeight / Math.max(1, list.length);
          const page = 0.9 * containerHeight(container);
          if (i < first) {
            if (scrollEl.scrollTop <= 1) {
              // Already at the top: the question is in "earlier messages".
              const button = findLoadEarlierButton();
              if (!button) return;
              const before = countTurns(feed);
              const height = feedHeight(feed);
              button.click();
              await waitForDom(() => countTurns(feed) > before || feedHeight(feed) > height + 1, LOAD_STEP_TIMEOUT_MS, signal);
              await nextFrame();
              rebuild();
              continue;
            }
            scrollContainerBy(container, -Math.max(page, 0.8 * (first - i) * perQuestion), 'instant');
          } else {
            if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2) return;
            scrollContainerBy(container, Math.max(page, 0.8 * (i - lastR) * perQuestion), 'instant');
          }
        }
        await settle(feed, SEEK_SETTLE_MS, signal);
        if (signal.aborted || stopped) return;
        rebuild();
      }
    }

    // ----- "Load all" -------------------------------------------------------------

    async function loadAll() {
      if (loadController || stopped) return;
      cancelSeek();
      loadController = new AbortController();
      const { signal } = loadController;
      view.setLoadState({ running: true, clicks: 0 });
      let outcome = { reason: 'done', clicks: 0 };
      try {
        // The API has everything, including messages the page has not loaded.
        if (!(await refreshFromApi())) outcome = await loadAllFromPage(signal);
      } catch (err) {
        warnOnce('load all', err);
        outcome = { reason: 'error', clicks: outcome.clicks };
      }
      scanLedger = null;
      loadController = null;
      if (stopped) return;
      acquireFeed();
      view.setLoadState({ running: false, ...outcome });
    }

    // Without the API: load all earlier messages, then scroll through the
    // whole chat so every question is rendered once. The fresh list replaces
    // the old one only if the scan completes.
    async function loadAllFromPage(signal) {
      let outcome = { reason: 'done', clicks: 0 };
      const getFeed = () => (feed && feed.isConnected ? feed : findFeed());
      for (let round = 0; round < SCAN_MAX_ROUNDS; round++) {
        const earlier = await loadAllEarlier({
          signal,
          getFeed,
          onProgress: (clicks) => view.setLoadState({ running: true, clicks: outcome.clicks + clicks }),
        });
        outcome = { reason: earlier.reason, clicks: outcome.clicks + earlier.clicks };
        ledger.shift(earlier.shift);
        if (stopped) return outcome;
        acquireFeed();
        if (earlier.reason !== 'done' || !feed) break;
        scanLedger = createLedger();
        const scan = await scanAll({
          signal,
          feed,
          absorb: rebuild,
          onProgress: (pct) => view.setLoadState({ running: true, clicks: outcome.clicks, scan: pct }),
        });
        if (stopped) return outcome;
        if (scan.reason !== 'done') {
          outcome.reason = scan.reason;
          break;
        }
        // The scan may have revealed another "Load earlier messages".
        if (!findLoadEarlierButton()) {
          if (scanLedger.list().length) ledger.adopt(scanLedger);
          complete = true;
          break;
        }
      }
      return outcome;
    }

    function cancelLoad() {
      if (loadController) loadController.abort();
    }

    function stop() {
      if (saveTimer) saveNow();
      stopped = true;
      cancelLoad();
      cancelSeek();
      if (bodyObserver) bodyObserver.disconnect();
      if (feedObserver) feedObserver.disconnect();
      if (tracker) tracker.destroy();
      clearTimeout(debounceTimer);
      clearTimeout(maxWaitTimer);
      clearTimeout(apiTimer);
      if (acquireFrame) cancelAnimationFrame(acquireFrame);
      window.removeEventListener('wheel', cancelSeek);
      window.removeEventListener('touchmove', cancelSeek);
      feed = tracker = bodyObserver = feedObserver = null;
      items = [];
    }

    return { start, stop, scrollTo, loadAll, cancelLoad };
  }

  // ---------------------------------------------------------------------------
  // SPA route changes -> a single deduplicated "locationchange" callback.
  // ---------------------------------------------------------------------------

  function watchLocation(onChange) {
    let href = location.href;
    const check = () => {
      if (location.href === href) return; // replaceState often keeps the URL
      href = location.href;
      onChange();
    };
    // Primary: pushState/replaceState patched in the page world (page-bridge.js).
    window.addEventListener(LOCATION_EVENT, check);
    window.addEventListener('popstate', check);
    // Backup in case the bridge didn't load: the Navigation API also reports
    // same-document navigations, and its events reach isolated worlds.
    const nav = window.navigation;
    if (nav && nav.addEventListener) nav.addEventListener('currententrychange', check);
    return {
      stop() {
        window.removeEventListener(LOCATION_EVENT, check);
        window.removeEventListener('popstate', check);
        if (nav && nav.removeEventListener) nav.removeEventListener('currententrychange', check);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Debug report for window.__claudeOutline.debug()
  // ---------------------------------------------------------------------------

  function debugReport() {
    const feed = findFeed();
    console.group(`${LOG} debug`);
    console.log('Conversation URL:', isConversationPath(location.pathname), location.pathname);
    console.log('Feed:', feed || 'NOT FOUND — tried ' + S.feed.join(' | '));
    if (feed) {
      let matched = null;
      for (const strategy of S.userMessageStrategies) {
        const count = runStrategy(strategy, feed).length;
        if (count && !matched) matched = strategy.name;
        console.log(`${count ? '✔' : '✘'} ${strategy.name}: ${count} node(s)`);
      }
      console.log('Strategy in use:', matched || 'NONE — selectors may be outdated');
      const turns = q.all(feed, S.turn);
      console.log('Turns in DOM (' + S.turn + '):', turns.length);
      console.log('Turn labels:', turns.map((t) => t.getAttribute('aria-label')));
      console.log('Scroll container:', findScrollContainer(feed));
    }
    console.log('"Load earlier messages" button:', findLoadEarlierButton());
    console.log('Outline state:', { ...debugState });
    console.groupEnd();
  }

  globalThis.ClaudeOutline = Object.freeze({
    DEBUG_EVENT,
    q,
    isConversationPath,
    findFeed,
    collect,
    findScrollContainer,
    findLoadEarlierButton,
    createLedger,
    createSession,
    keyOf,
    watchLocation,
    debugReport,
  });
})();
