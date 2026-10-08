// "Load all questions": ask the API for the full list, or else click "Load
// earlier messages" until it is gone and scan the whole chat so the
// virtualizer renders every question. The session owns the ledger; a
// loader only feeds it and reports progress to the view.
import * as S from '../core/selectors';
import type { LoadReason, LoadState, View } from '../core/types';
import { safe, warnOnce } from '../core/util';
import { findFeed, findLoadEarlierButton, q } from './extract';
import {
  containerHeight,
  containerTop,
  countTurns,
  feedHeight,
  findScrollContainer,
  nextFrame,
  scrollContainerBy,
  scrollContainerTo,
  scrollElementOf,
  settle,
  waitForDom,
} from './scroll';
import { createLedger, type Ledger } from './ledger';

const LOAD_MAX_CLICKS = 50;
const LOAD_MAX_MS = 30000;
const LOAD_STEP_TIMEOUT_MS = 8000;
// Scanning: scroll through the whole chat so the virtualizer renders (and
// the ledger records) every question.
const SCAN_MAX_ROUNDS = 3;
const SCAN_MAX_MS = 60000;
const SCAN_SETTLE_MS = 250;

interface Anchor {
  el: HTMLElement | undefined;
  /** Distance from the last loaded turn: survives earlier messages being loaded. */
  fromEnd: number | null;
  top: number;
  feed: HTMLElement;
  height: number;
  container: Element;
}

// Remember which turn is at the top of the view so the user's place can
// be restored after earlier messages are prepended above it.
function captureAnchor(feed: HTMLElement | null): Anchor | null {
  if (!feed) return null;
  const container = findScrollContainer(feed);
  const top = containerTop(container);
  const turns = q.all(feed, S.turn);
  const el = turns.find((t) => t.getBoundingClientRect().bottom > top) || turns[0];
  const fromEnd = el ? safe('position', () => S.turnFromEnd(el), null) : null;
  return { el, fromEnd, top: el ? el.getBoundingClientRect().top : 0, feed, height: feedHeight(feed), container };
}

// The anchor turn itself, or (if claude.ai re-created it) the turn now
// rendered at the same position in the conversation.
function anchorElement(anchor: Anchor): HTMLElement | null {
  if (anchor.el && anchor.el.isConnected) return anchor.el;
  if (anchor.fromEnd == null) return null;
  const feed = anchor.feed.isConnected ? anchor.feed : findFeed();
  return q.all(feed, S.turn).find((t) => safe('position', () => S.turnFromEnd(t), null) === anchor.fromEnd) || null;
}

// Returns how far the anchor had moved (px), i.e. the height of what was
// inserted above it. If the virtualizer unmounted the anchor meanwhile,
// the growth of the feed is the best estimate.
function restoreAnchor(anchor: Anchor | null): number {
  if (!anchor) return 0;
  const el = anchorElement(anchor);
  const delta = el
    ? el.getBoundingClientRect().top - anchor.top
    : feedHeight(anchor.feed.isConnected ? anchor.feed : findFeed()) - anchor.height;
  if (Math.abs(delta) > 1) scrollContainerBy(anchor.container, delta, 'instant');
  return delta;
}

export async function loadAllEarlier({
  signal,
  getFeed,
  onProgress,
}: {
  signal: AbortSignal;
  getFeed: () => HTMLElement | null;
  onProgress: (clicks: number) => void;
}): Promise<{ reason: LoadReason; clicks: number; shift: number }> {
  const deadline = performance.now() + LOAD_MAX_MS;
  const anchor = captureAnchor(getFeed());
  let clicks = 0;
  let reason: LoadReason = 'done';
  let shift = 0;
  try {
    for (;;) {
      if (signal.aborted) {
        reason = 'cancelled';
        break;
      }
      if (clicks >= LOAD_MAX_CLICKS) {
        reason = 'limit';
        break;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        reason = 'timeout';
        break;
      }
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
    const feed = getFeed();
    if (anchor && feed) shift = await returnToAnchor(anchor.container, feed, anchor, () => {});
  }
  return { reason, clicks, shift };
}

// Scrolls from the top of the chat to the bottom one screen at a time,
// calling absorb() after each step, then returns to where the user was.
// After a scan the heights above the reading position may differ (turns
// measured instead of estimated), so the old scrollTop is only a first
// guess. Find the anchor turn again (by position in the conversation if
// it was re-created), stepping toward it while it is not rendered, then
// line it up exactly. Repeats while measuring keeps moving it.
async function returnToAnchor(
  container: Element,
  feed: HTMLElement,
  anchor: Anchor | null,
  absorb: () => void
): Promise<number> {
  if (!anchor) return 0;
  const never = new AbortController().signal;
  let aligned = 0;
  let moved = 0; // total correction applied while the anchor was rendered
  for (let pass = 0; pass < 20; pass++) {
    await settle(feed, SCAN_SETTLE_MS, never);
    absorb();
    const el = anchorElement(anchor);
    if (el) {
      const delta = el.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) <= 1) {
        if (++aligned >= 2) return moved;
        continue;
      }
      aligned = 0;
      moved += delta;
      scrollContainerBy(container, delta, 'instant');
      continue;
    }
    const fromEnds = q
      .all(feed, S.turn)
      .map((t) => safe('position', () => S.turnFromEnd(t), null))
      .filter((p): p is number => p != null);
    if (anchor.fromEnd == null || !fromEnds.length) {
      return moved + restoreAnchor(anchor); // best effort: by the change in feed height
    }
    // Further from the end than everything rendered: it is above.
    const up = anchor.fromEnd > Math.max(...fromEnds);
    scrollContainerBy(container, (up ? -0.8 : 0.8) * containerHeight(container), 'instant');
  }
  return moved;
}

export async function scanAll({
  signal,
  feed,
  absorb,
  onProgress,
}: {
  signal: AbortSignal;
  feed: HTMLElement;
  absorb: () => void;
  onProgress: (pct: number) => void;
}): Promise<{ reason: 'done' | 'cancelled' | 'timeout' }> {
  const container = findScrollContainer(feed);
  const scrollEl = scrollElementOf(container);
  const saved = scrollEl.scrollTop;
  const anchor = captureAnchor(feed);
  const deadline = performance.now() + SCAN_MAX_MS;
  let reason: 'done' | 'cancelled' | 'timeout' = 'done';
  try {
    let y = 0;
    for (let i = 0; i < 5000; i++) {
      if (signal.aborted) {
        reason = 'cancelled';
        break;
      }
      if (performance.now() > deadline) {
        reason = 'timeout';
        break;
      }
      scrollContainerTo(container, y);
      await settle(feed, SCAN_SETTLE_MS, signal);
      if (signal.aborted) {
        reason = 'cancelled';
        break;
      }
      absorb();
      const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      onProgress(max ? Math.min(100, Math.round((100 * y) / max)) : 100);
      if (y >= max - 1) break;
      y = Math.min(max, y + Math.max(200, scrollEl.clientHeight * 0.85));
    }
  } finally {
    scrollContainerTo(container, saved);
    await returnToAnchor(container, feed, anchor, absorb);
  }
  return { reason };
}

type Outcome = { reason: LoadReason; clicks: number };

/** What a loader needs from its session. */
export interface LoaderContext {
  view: View;
  ledger: Ledger;
  feed(): HTMLElement | null;
  stopped(): boolean;
  /** Re-finds the feed (it may be a new node after loading) and rebuilds. */
  acquireFeed(): void;
  rebuild(): void;
  /** Asks claude.ai's API for the full list; true if it gave one. */
  refreshFromApi(): Promise<boolean>;
  cancelSeek(): void;
  /** The list is known to be complete now. */
  markComplete(): void;
}

export interface Loader {
  loadAll(): Promise<void>;
  cancel(): void;
  /** The fresh list a page-only "Load all" is building, if one runs. */
  scanLedger(): Ledger | null;
}

export function createLoader(ctx: LoaderContext): Loader {
  const { ledger, view } = ctx;
  let loadController: AbortController | null = null;
  let scanLedger: Ledger | null = null; // fresh list built during a page-only "Load all"

  async function loadAll() {
    if (loadController || ctx.stopped()) return;
    ctx.cancelSeek();
    loadController = new AbortController();
    const { signal } = loadController;
    view.setLoadState({ running: true, clicks: 0 });
    let outcome: Outcome = { reason: 'done', clicks: 0 };
    try {
      // The API has everything, including messages the page has not loaded.
      if (!(await ctx.refreshFromApi())) outcome = await loadAllFromPage(signal);
    } catch (err) {
      warnOnce('load all', err);
      outcome = { reason: 'error', clicks: outcome.clicks };
    }
    scanLedger = null;
    loadController = null;
    if (ctx.stopped()) return;
    ctx.acquireFeed();
    const done: LoadState = { running: false, ...outcome };
    view.setLoadState(done);
  }

  // Without the API: load all earlier messages, then scroll through the
  // whole chat so every question is rendered once. The fresh list replaces
  // the old one only if the scan completes.
  async function loadAllFromPage(signal: AbortSignal): Promise<Outcome> {
    let outcome: Outcome = { reason: 'done', clicks: 0 };
    const getFeed = () => {
      const feed = ctx.feed();
      return feed && feed.isConnected ? feed : findFeed();
    };
    for (let round = 0; round < SCAN_MAX_ROUNDS; round++) {
      const earlier = await loadAllEarlier({
        signal,
        getFeed,
        onProgress: (clicks) => view.setLoadState({ running: true, clicks: outcome.clicks + clicks }),
      });
      outcome = { reason: earlier.reason, clicks: outcome.clicks + earlier.clicks };
      ledger.shift(earlier.shift);
      if (ctx.stopped()) return outcome;
      ctx.acquireFeed();
      const feed = ctx.feed();
      if (earlier.reason !== 'done' || !feed) break;
      const fresh = createLedger();
      scanLedger = fresh;
      const scan = await scanAll({
        signal,
        feed,
        absorb: ctx.rebuild,
        onProgress: (pct) => view.setLoadState({ running: true, clicks: outcome.clicks, scan: pct }),
      });
      if (ctx.stopped()) return outcome;
      if (scan.reason !== 'done') {
        outcome.reason = scan.reason;
        break;
      }
      // The scan may have revealed another "Load earlier messages".
      if (!findLoadEarlierButton()) {
        if (fresh.list().length) ledger.adopt(fresh);
        ctx.markComplete();
        break;
      }
    }
    return outcome;
  }

  function cancelLoad() {
    if (loadController) loadController.abort();
  }

  return { loadAll, cancel: cancelLoad, scanLedger: () => scanLedger };
}
