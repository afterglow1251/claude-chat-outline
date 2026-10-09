// Outline session: everything that lives for one conversation. It owns the
// feed, the ledger and their observers, merges the store (claude.ai's list,
// cached) and the page into one list, and wires the active tracker, the
// seeker (jumps) and the loader ("Load all") to it. Also route-change
// watching and the debug report. Never writes to Claude's DOM; the
// highlight on the question you jump to is drawn by the panel (see
// highlight.ts).
//
// claude.ai virtualizes the message list: only the turns near the viewport
// are in the DOM, and they are unmounted again as you scroll. So the outline
// is not "what is rendered" but a ledger of the conversation's questions:
// taken from claude.ai when possible (complete at once; see store.ts for
// where it comes from), and from everything rendered so far. Entries are
// never dropped because their message is not rendered right now.
import * as S from '../core/selectors';
import * as Store from '../data/store';
import { LOCATION_EVENT } from '../core/events';
import type { ApiQuestion, DiagramFinder, Entry, View } from '../core/types';
import { LOG, safe } from '../core/util';
import { createActiveTracker, mounted, type ActiveTracker } from './active';
import {
  collect,
  findFeed,
  findLoadEarlierButton,
  isConversationPath,
  q,
  runStrategy,
  type Collected,
} from './extract';
import { createCoverage, createLedger } from './ledger';
import { createLoader } from './load-all';
import { createPlace } from './place';
import { createResume } from './resume';
import { containerTop, findScrollContainer, isDocScroller } from './scroll';
import { createSeeker, seekLog } from './seek';

const REBUILD_DEBOUNCE_MS = 150;
// A plain debounce never fires while Claude streams (mutations arrive every
// few ms), so a question you just sent would not appear until the answer
// finished. Force a rebuild at least this often.
const REBUILD_MAX_WAIT_MS = 1000;
const CACHE_WAIT_MS = 500;
const SAVE_DELAY_MS = 1000;
const API_MIN_INTERVAL_MS = 4000;
// Stepping up from a question scrolled further than this above the line
// goes back to that question's own start first.
const STEP_INSIDE_PX = 16;
// Where you left off in each chat: turned off, stars cover marking a
// place on purpose. Two versions are kept: an offer over the chat
// (resume.ts; came up on every reload and after every jump) and a ribbon
// in the question list (place.ts; easy to miss in a long chat). Set one
// to true to bring it back.
const RESUME_ENABLED = false;
const PLACE_ENABLED = false;

// ---------------------------------------------------------------------------
// Session: everything that lives for one conversation. convId is the
// conversation id from the URL (the session lives as long as that id stays
// the same; it is the store's key).
// ---------------------------------------------------------------------------

// Shared with debugReport().
const debugState = {
  convId: null as string | null,
  source: 'none' as 'none' | Store.Source,
  api: 'not tried',
  questions: 0,
  rendered: 0,
};

export interface Session {
  start(): Promise<void>;
  stop(): void;
  /** Jumps to a question, or on to a diagram in its answer (see Seeker.scrollTo). */
  scrollTo(index: number, diagram?: DiagramFinder): Promise<void>;
  /** Jumps to the next (1) or previous (-1) question from the one being read. */
  step(delta: 1 | -1): void;
  /** Takes the offer to go back to where you were (an index), or dismisses it (null). */
  resume(index: number | null): void;
  loadAll(): Promise<void>;
  cancelLoad(): void;
}

/** The turns rendered right now (on a route change: the previous chat's). */
export function renderedTurns(): Set<Element> {
  return new Set(q.all(findFeed(), S.turn));
}

// Whether the reader is past the question's start, inside its answer.
function scrolledInto(entry: Entry, container: Element): boolean {
  // Not rendered while it is the one being read: far above, deep in its answer.
  if (!mounted(entry)) return true;
  const line = containerTop(container) + S.layout.scrollOffset;
  return entry.node.getBoundingClientRect().top < line - STEP_INSIDE_PX;
}

// `leftover`: turns of the previous conversation still in the page when
// this one starts (claude.ai changes the URL before it re-renders). They
// are ignored until they are gone, so the old chat's questions never show
// up in this one, not even for a moment.
export function createSession(view: View, convId: string | null, leftover?: ReadonlySet<Element>): Session {
  let stopped = false;
  let stale: ReadonlySet<Element> | null = leftover && leftover.size ? leftover : null;
  let feed: HTMLElement | null = null;
  let feedObserver: MutationObserver | null = null;
  let bodyObserver: MutationObserver | null = null;
  let tracker: ActiveTracker | null = null;
  let items: Entry[] = [];
  let active = -1; // the question being read
  let settled = false; // see RenderResult.settled
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let acquireFrame = 0;
  let complete = false; // the list is known to be complete
  let apiState: 'idle' | 'loading' | 'ok' | 'failed' = 'idle';
  let apiLast = 0;
  let apiTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let savedVersion = 0;
  let unsubscribe: (() => void) | null = null;
  const coverage = createCoverage();
  const ledger = createLedger();
  const resume = convId && RESUME_ENABLED ? createResume(convId, view) : null;
  const place = convId && PLACE_ENABLED && !RESUME_ENABLED ? createPlace(convId, view) : null;
  let unlistenUserScroll: (() => void) | null = null;
  const seeker = createSeeker({
    view,
    ledger,
    feed: () => feed,
    items: () => items,
    tracker: () => tracker,
    stopped: () => stopped,
    rebuild,
    scheduleRebuild,
  });
  const loader = createLoader({
    view,
    ledger,
    feed: () => feed,
    stopped: () => stopped,
    acquireFeed,
    rebuild,
    refreshFromApi,
    cancelSeek: seeker.cancel,
    markComplete: () => {
      complete = true;
    },
  });

  async function start() {
    Object.assign(debugState, { convId, source: 'page', api: 'not tried', questions: 0, rendered: 0 });
    // 1. What the store knows, from this tab or an earlier visit: shown
    // immediately. What changes later comes through the subscription
    // (claude.ai loading the conversation itself, or a request of ours).
    if (convId) {
      unsubscribe = Store.subscribe(convId, onConversation);
      const known = await Promise.race([
        Store.open(convId),
        new Promise<null>((r) => setTimeout(() => r(null), CACHE_WAIT_MS)),
      ]).catch(() => null);
      if (stopped) return;
      const q = known?.questions;
      if (q?.fromApi) applyQuestions(q.items, known!.source ?? 'storage');
      else if (q && q.items.length && !ledger.isAuthoritative()) {
        ledger.seed(q.items);
        complete = q.complete;
        savedVersion = ledger.version;
        debugState.source = 'storage';
      }
    }
    // 2. What is rendered.
    // Claude may replace the feed node (e.g. when switching chats). This
    // observer only does an O(1) isConnected check per batch while the
    // feed is healthy, and re-queries for it once it is gone.
    bodyObserver = new MutationObserver(() => {
      if (feed && feed.isConnected) return;
      seekLog('body mutation without feed', { feed: !!feed });
      // A timer, not an animation frame: frames do not run in a background
      // tab, and the chat may well finish loading while the tab is one.
      if (!acquireFrame) {
        acquireFrame = window.setTimeout(() => {
          acquireFrame = 0;
          acquireFeed();
        }, 0);
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
    // A real scroll by the user ends any programmatic seek.
    unlistenUserScroll = seeker.listen();
    acquireFeed();
    // 3. claude.ai's list: checked behind one already shown, asked for
    // right away otherwise.
    if (!convId) return;
    if (ledger.isAuthoritative()) Store.revalidate(convId);
    else refreshFromApi();
  }

  function acquireFeed() {
    if (stopped) return;
    const next = findFeed();
    seekLog('acquireFeed', { found: !!next, same: next === feed });
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
    debounceTimer = maxWaitTimer = undefined;
    rebuild();
  }

  function rebuild(): void {
    seekLog('rebuild', { stopped, feed: !!feed, connected: !!feed?.isConnected });
    if (stopped) return;
    if (feed && !feed.isConnected) return acquireFeed();
    let result = safe('rebuild', () => collect(feed), {
      status: 'selectors-broken',
      strategy: null,
      items: [],
    } as Collected);
    if (stale) {
      const old = stale;
      if (![...old].some((t) => t.isConnected)) stale = null;
      else {
        const fresh = result.items.filter((item) => !old.has(item.target));
        // Only the old chat on screen: this one is still loading.
        result = { ...result, items: fresh, status: fresh.length ? result.status : 'no-feed' };
      }
    }
    if (feed && result.items.length) {
      const f = feed;
      safe('ledger', () => ledger.absorb(result.items, f));
      if (!stale) safe('coverage', () => coverage.record(f));
      const scan = loader.scanLedger();
      if (scan) {
        safe('scan ledger', () => scan.absorb(result.items, f));
      }
    }
    items = ledger.list();
    debugState.questions = items.length;
    debugState.rendered = result.items.length;
    const canLoadEarlier = !!findLoadEarlierButton();
    // Final: from the API (the cache's "complete" is last visit's guess),
    // or when the API failed and the page-only list is all there is.
    settled = ledger.isAuthoritative() || apiState === 'failed';
    view.render({
      // The DOM may show nothing for a moment; what we know is still valid.
      status: items.length ? 'ok' : result.status,
      strategy: result.strategy,
      items,
      canLoadEarlier,
      incomplete: !complete && (canLoadEarlier || coverage.incomplete()),
      settled,
    });
    updateTracker();
    if (ledger.takeRefreshRequest()) scheduleApiRefresh();
    scheduleSave();
  }

  function updateTracker(): void {
    const container = feed && items.length ? findScrollContainer(feed) : null;
    if (tracker && tracker.container !== container) {
      tracker.destroy();
      tracker = null;
    }
    if (!container) return onActive(-1);
    if (!tracker) tracker = createActiveTracker(container, () => feed, onActive);
    tracker.setTargets(items);
  }

  function onActive(index: number): void {
    active = index;
    view.setActive(index);
    const container = tracker?.container;
    resume?.update(items, index, settled, container && !isDocScroller(container) ? container : null);
    place?.update(items, index, settled);
  }

  // From the question being read (or the one a running jump goes to, so
  // a key held down keeps going). Up from inside a question's answer goes
  // back to that question's start first, like "previous" in a player.
  function step(delta: 1 | -1): void {
    if (!items.length) return;
    const jumping = tracker?.pinnedIndex() ?? null;
    const from = jumping ?? active;
    let to = from + delta;
    if (from < 0) to = delta > 0 ? 0 : items.length - 1;
    else if (delta < 0 && jumping === null && tracker && scrolledInto(items[from], tracker.container)) to = from;
    if (to < 0 || to >= items.length) return;
    resume?.done();
    place?.chose(items[to]);
    seeker.scrollTo(to);
  }

  // ----- page-only list ------------------------------------------------------
  // claude.ai's list is kept by the store itself. A list built from the page
  // (the API unavailable) is handed to it for the next visit.

  function scheduleSave() {
    if (!convId || ledger.isAuthoritative() || ledger.version === savedVersion || saveTimer) return;
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!convId || !items.length || ledger.isAuthoritative()) return;
    savedVersion = ledger.version;
    Store.savePageList(
      convId,
      items.map((e) => e.full),
      complete
    );
  }

  // ----- API ----------------------------------------------------------------

  async function refreshFromApi(): Promise<boolean> {
    if (!convId || apiState === 'loading') return false;
    apiState = 'loading';
    debugState.api = 'loading';
    // The answer itself comes through the subscription, before this resolves.
    const answered = await Store.refresh(convId);
    apiLast = performance.now();
    if (stopped) return false;
    if (answered && ledger.isAuthoritative()) {
      apiState = 'ok';
      debugState.api = `ok (${items.length} questions)`;
      return true;
    }
    apiState = 'failed';
    debugState.api = answered ? 'empty answer' : 'unavailable (see warning above)';
    rebuild(); // the page-only list is final now (see RenderResult.settled)
    return false;
  }

  // claude.ai answered (itself, or a request of ours).
  function onConversation(conversation: Store.Conversation) {
    const q = conversation.questions;
    if (!stopped && q?.fromApi) applyQuestions(q.items, conversation.source ?? 'api');
  }

  // claude.ai's complete list of questions.
  function applyQuestions(texts: readonly ApiQuestion[], source: Store.Source) {
    // An empty answer for a chat that shows messages is not believable
    // (a brand-new chat the API has not caught up with yet).
    if (!texts.length && items.length) return;
    debugState.source = source;
    ledger.setAuthoritative(texts);
    complete = true;
    rebuild();
  }

  // A question appeared that the API answer did not have (you just sent
  // it): ask again, but not more often than every API_MIN_INTERVAL_MS.
  function scheduleApiRefresh() {
    if (apiTimer || apiState === 'failed') return;
    const wait = Math.max(0, API_MIN_INTERVAL_MS - (performance.now() - apiLast));
    apiTimer = setTimeout(() => {
      apiTimer = undefined;
      refreshFromApi();
    }, wait);
  }

  function stop() {
    if (saveTimer) saveNow();
    resume?.stop();
    place?.stop();
    stopped = true;
    loader.cancel();
    seeker.cancel();
    unsubscribe?.();
    unsubscribe = null;
    if (bodyObserver) bodyObserver.disconnect();
    if (feedObserver) feedObserver.disconnect();
    if (tracker) tracker.destroy();
    clearTimeout(debounceTimer);
    clearTimeout(maxWaitTimer);
    clearTimeout(apiTimer);
    if (acquireFrame) clearTimeout(acquireFrame);
    unlistenUserScroll?.();
    unlistenUserScroll = null;
    feed = null;
    tracker = null;
    bodyObserver = null;
    feedObserver = null;
    items = [];
  }

  return {
    start,
    stop,
    scrollTo(index, diagram) {
      place?.chose(items[index]);
      return seeker.scrollTo(index, diagram);
    },
    step,
    resume(index) {
      resume?.done();
      if (index !== null) {
        place?.chose(items[index]);
        seeker.scrollTo(index);
      }
    },
    loadAll: loader.loadAll,
    cancelLoad: loader.cancel,
  };
}

// ---------------------------------------------------------------------------
// SPA route changes -> a single deduplicated "locationchange" callback.
// ---------------------------------------------------------------------------

/** The parts of the Navigation API used here (not in every TS DOM lib). */
interface NavigationLike {
  addEventListener?(type: string, fn: () => void): void;
  removeEventListener?(type: string, fn: () => void): void;
}

export function watchLocation(onChange: () => void): { stop(): void } {
  let href = location.href;
  const check = () => {
    if (location.href === href) return; // replaceState often keeps the URL
    href = location.href;
    onChange();
  };
  // Primary: pushState/replaceState patched in the page world (page-bridge.ts).
  window.addEventListener(LOCATION_EVENT, check);
  window.addEventListener('popstate', check);
  // Backup in case the bridge didn't load: the Navigation API also reports
  // same-document navigations, and its events reach isolated worlds.
  const nav = (window as unknown as { navigation?: NavigationLike }).navigation;
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

export function debugReport(): void {
  const feed = findFeed();
  console.group(`${LOG} debug`);
  console.log('Conversation URL:', isConversationPath(location.pathname), location.pathname);
  console.log('Feed:', feed || 'NOT FOUND — tried ' + S.feed.join(' | '));
  if (feed) {
    let matched: string | null = null;
    for (const strategy of S.userMessageStrategies) {
      const count = runStrategy(strategy, feed).length;
      if (count && !matched) matched = strategy.name;
      console.log(`${count ? '✔' : '✘'} ${strategy.name}: ${count} node(s)`);
    }
    console.log('Strategy in use:', matched || 'NONE — selectors may be outdated');
    const turns = q.all(feed, S.turn);
    console.log('Turns in DOM (' + S.turn + '):', turns.length);
    console.log(
      'Turn labels:',
      turns.map((t) => t.getAttribute('aria-label'))
    );
    console.log('Scroll container:', findScrollContainer(feed));
  }
  console.log('"Load earlier messages" button:', findLoadEarlierButton());
  console.log('Outline state:', { ...debugState });
  console.groupEnd();
}
