// Outline core: extraction, observers, scrolling, active tracking, load-all.
// Reads Claude's DOM only. The single exception is a temporary inline outline
// on the article you jump to, which is fully reverted after FLASH_MS.
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

  function scrollContainerBy(container, top, behavior) {
    if (isDocScroller(container)) window.scrollBy({ top, behavior });
    else container.scrollBy({ top, behavior });
  }

  function scrollToElement(container, target) {
    const containerTop = isDocScroller(container) ? 0 : container.getBoundingClientRect().top;
    const delta = target.getBoundingClientRect().top - containerTop - S.layout.scrollOffset;
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

  // The active item is the last user message whose top is at or above the
  // "line" (scroller top + scrollOffset). The IntersectionObserver watches a
  // band from the scroller top down to that line: an item enters or leaves
  // the band exactly when its top crosses the line or it scrolls fully off
  // the top, the only moments the answer can change. On each callback we
  // recompute from rects (cheap reads, no writes). A `scrollend` listener
  // catches very fast jumps that skip over the band between IO samples.
  function createActiveTracker(container, onActive) {
    const isDoc = isDocScroller(container);
    const scrollEl = isDoc ? document.scrollingElement || document.documentElement : container;
    let targets = [];
    let current;
    let frame = 0;
    let io = null;

    function lineY() {
      return (isDoc ? 0 : container.getBoundingClientRect().top) + S.layout.scrollOffset + 2;
    }

    function compute() {
      frame = 0;
      if (!targets.length) return emit(-1);
      const line = lineY();
      let active = 0;
      for (let i = 0; i < targets.length; i++) {
        if (targets[i].getBoundingClientRect().top <= line) active = i;
        else break;
      }
      // At the very bottom, a question followed by a short answer can never
      // reach the line, so clicking it would never mark it active. There,
      // prefer the last question that is actually visible.
      if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2) {
        const bottom = isDoc ? window.innerHeight : container.getBoundingClientRect().bottom;
        for (let i = targets.length - 1; i > active; i--) {
          if (targets[i].getBoundingClientRect().top < bottom) {
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

    // rootMargin is in pixels and depends on the scroller height, so the
    // observer is rebuilt when that height changes.
    function connect() {
      if (io) io.disconnect();
      const height = isDoc ? window.innerHeight : container.clientHeight;
      const bottomMargin = -Math.max(0, height - S.layout.scrollOffset - 2);
      io = new IntersectionObserver(schedule, {
        root: isDoc ? null : container,
        rootMargin: `0px 0px ${bottomMargin}px 0px`,
        threshold: 0,
      });
      targets.forEach((t) => io.observe(t));
    }

    function onResize() {
      connect();
      schedule();
    }

    const scrollTarget = isDoc ? window : container;
    scrollTarget.addEventListener('scrollend', schedule, { passive: true });
    let ro = null;
    if (isDoc) {
      window.addEventListener('resize', onResize);
    } else {
      ro = new ResizeObserver(onResize);
      ro.observe(container);
    }
    connect();

    return {
      container,
      setTargets(next) {
        targets = next;
        current = undefined; // indexes shift when earlier messages load
        connect();
        schedule();
      },
      destroy() {
        if (io) io.disconnect();
        if (ro) ro.disconnect();
        if (frame) cancelAnimationFrame(frame);
        scrollTarget.removeEventListener('scrollend', schedule);
        window.removeEventListener('resize', onResize);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // "Load all questions"
  // ---------------------------------------------------------------------------

  function countTurns(feed) {
    if (!feed) return 0;
    const turns = q.all(feed, S.turn).length;
    // If the turn selector ever breaks, any growth of the feed still counts.
    return turns > 0 ? turns : feed.getElementsByTagName('*').length;
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

  // Remember which turn is at the top of the view so the user's place can
  // be restored after earlier messages are prepended above it.
  function captureAnchor(feed) {
    if (!feed) return null;
    const container = findScrollContainer(feed);
    const top = isDocScroller(container) ? 0 : container.getBoundingClientRect().top;
    const turns = q.all(feed, S.turn);
    const el = turns.find((t) => t.getBoundingClientRect().bottom > top) || turns[0];
    return el ? { el, top: el.getBoundingClientRect().top } : null;
  }

  function restoreAnchor(anchor) {
    if (!anchor || !anchor.el.isConnected) return;
    const delta = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 1) scrollContainerBy(findScrollContainer(anchor.el), delta, 'instant');
  }

  // reason: 'done' | 'cancelled' | 'limit' | 'timeout' | 'stalled'
  async function loadAllEarlier({ signal, getFeed, onProgress }) {
    const deadline = performance.now() + LOAD_MAX_MS;
    const anchor = captureAnchor(getFeed());
    let clicks = 0;
    let reason = 'done';
    try {
      for (;;) {
        if (signal.aborted) { reason = 'cancelled'; break; }
        if (clicks >= LOAD_MAX_CLICKS) { reason = 'limit'; break; }
        const remaining = deadline - performance.now();
        if (remaining <= 0) { reason = 'timeout'; break; }
        const button = findLoadEarlierButton();
        if (!button) break;

        const before = countTurns(getFeed());
        button.click();
        clicks++;
        onProgress(clicks);

        // Progress = more turns in the feed. The button node itself is not a
        // reliable signal: React may swap it for a spinner mid-load.
        const grew = await waitForDom(
          () => countTurns(getFeed()) > before,
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
      restoreAnchor(anchor);
    }
    return { reason, clicks };
  }

  // ---------------------------------------------------------------------------
  // Session: everything that lives for one conversation page.
  // view = { render(result), setActive(index), setLoadState(state) }
  // ---------------------------------------------------------------------------

  function createSession(view) {
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

    function start() {
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
      acquireFeed();
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
      result.canLoadEarlier = !!findLoadEarlierButton();
      items = result.items;
      view.render(result);
      updateTracker();
    }

    function updateTracker() {
      const container = feed && items.length ? findScrollContainer(feed) : null;
      if (tracker && tracker.container !== container) {
        tracker.destroy();
        tracker = null;
      }
      if (!container) return view.setActive(-1);
      if (!tracker) tracker = createActiveTracker(container, view.setActive);
      tracker.setTargets(items.map((item) => item.target));
    }

    function scrollTo(index) {
      const item = items[index];
      if (!item || !item.target.isConnected) return scheduleRebuild();
      safe('scroll', () => scrollToElement(findScrollContainer(feed || item.target), item.target));
    }

    async function loadAll() {
      if (loadController || stopped) return;
      loadController = new AbortController();
      view.setLoadState({ running: true, clicks: 0 });
      let outcome;
      try {
        outcome = await loadAllEarlier({
          signal: loadController.signal,
          getFeed: () => (feed && feed.isConnected ? feed : findFeed()),
          onProgress: (clicks) => view.setLoadState({ running: true, clicks }),
        });
      } catch (err) {
        warnOnce('load all', err);
        outcome = { reason: 'error', clicks: 0 };
      }
      loadController = null;
      if (stopped) return;
      acquireFeed();
      view.setLoadState({ running: false, ...outcome });
    }

    function cancelLoad() {
      if (loadController) loadController.abort();
    }

    function stop() {
      stopped = true;
      cancelLoad();
      if (bodyObserver) bodyObserver.disconnect();
      if (feedObserver) feedObserver.disconnect();
      if (tracker) tracker.destroy();
      clearTimeout(debounceTimer);
      clearTimeout(maxWaitTimer);
      if (acquireFrame) cancelAnimationFrame(acquireFrame);
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
      console.log('Turns (' + S.turn + '):', q.all(feed, S.turn).length);
      console.log('Scroll container:', findScrollContainer(feed));
    }
    console.log('"Load earlier messages" button:', findLoadEarlierButton());
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
    createSession,
    watchLocation,
    debugReport,
  });
})();
