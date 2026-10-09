// Jumping to a question, including one claude.ai has not rendered (or not
// even loaded): find its turn, scroll it to the line, keep it there while
// the page re-measures, and hand the result to the view. The session owns
// the feed and the ledger; a seeker only reads them and asks for rebuilds.
import * as S from '../core/selectors';
import { HOST_ID } from '../core/events';
import type { Entry, View } from '../core/types';
import { LOG, safe } from '../core/util';
import { mounted, textConflicts, type ActiveTracker } from './active';
import { collect, findLoadEarlierButton, keyOf, q } from './extract';
import type { Ledger } from './ledger';
import {
  containerHeight,
  containerTop,
  countTurns,
  feedHeight,
  findScrollContainer,
  isDocScroller,
  messageBox,
  nextFrame,
  onScreen,
  renderedPositions,
  scrollContainerBy,
  scrollContainerTo,
  scrollElementOf,
  scrollEnded,
  scrollToElement,
  settle,
  waitForDom,
} from './scroll';

// How long the button's click gets to add messages before we conclude it
// did not load any (on current claude.ai it only scrolls to the first one).
const LOAD_CLICK_TIMEOUT_MS = 2500;
// How long to keep trying to get earlier messages loaded before giving up
// on the jump (a scroll up by the user helps meanwhile).
const USER_LOAD_WAIT_MS = 60000;
// Loading by scrolling: how long to wait at the top for a batch (claude.ai
// takes well under a second), and from how many screens down to come back
// to the top when none comes.
const LOAD_ATTEMPT_MS = 1500;
const TOP_APPROACH_SCREENS = 3;
// Attempts to get the scroller to its very top before concluding that the
// page holds it there (claude.ai re-adjusts the scroll while it measures
// turns, which can undo a scroll to 0 several times in a row).
const TOP_ATTEMPTS = 12;
// While waiting for the user's scroll, the page is nudged back to the top
// this often: earlier messages load only there.
const TOP_NUDGE_MS = 700;
// Jumping to a question that is not in the DOM: scroll to where it is
// expected, let claude.ai render it, then correct.
// Steps a jump may take within one loaded batch of messages. Each step
// waits for the page to settle, so this is a last-resort guard against a
// page that never changes, not a budget a long chat can run out of.
const SEEK_MAX_STEPS = 2000;
// Batches of earlier messages a single jump may load (32 messages each).
const SEEK_MAX_LOADS = 2000;
const SEEK_SETTLE_MS = 300;
// How long a smooth scroll to the clicked question may take before
// scroll tracking takes over again.
const SCROLL_END_WAIT_MS = 1500;
// Corrections after a jump while the target still moves, how far off it
// may be, and how long to wait for the page to react to each.
const SETTLE_PASSES = 16;
const SETTLE_SLACK_PX = 4;
const SETTLE_WAIT_MS = 150;
// Input that means the user is scrolling the chat themselves.
const USER_SCROLL_EVENTS = ['wheel', 'touchmove', 'keydown'] as const;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

// When the running (or last) jump started: log lines show the time since.
let jumpStart = 0;

// Diagnostics for jumps; off unless `localStorage['claude-outline-debug']` is set.
export function seekLog<T>(msg: string, data: T): T {
  try {
    if (localStorage.getItem('claude-outline-debug'))
      console.debug(
        LOG,
        jumpStart ? `+${Math.round(performance.now() - jumpStart)}ms` : '',
        'seek:',
        msg,
        data == null ? '' : JSON.stringify(data)
      );
  } catch {
    /* storage blocked */
  }
  return data;
}

// How many messages the page has loaded (aria-setsize), or null.
export function loadedCount(theFeed: HTMLElement): number | null {
  const first = renderedPositions(theFeed)[0];
  return first ? safe('set size', () => S.turnSetSize(first.turn), null) : null;
}

// The scroll position that puts the turn at page position `want` on the
// line, extrapolated from the turns on screen (their tops and positions).
export function estimateScroll(
  view: { turn: HTMLElement; pos: number }[],
  want: number,
  top: number,
  container: Element
): number {
  const first = view[0];
  const last = view[view.length - 1];
  const firstTop = first.turn.getBoundingClientRect().top;
  const span = last.pos - first.pos;
  const perMessage =
    span > 0 ? (last.turn.getBoundingClientRect().top - firstTop) / span : containerHeight(container) / 2;
  const targetTop = firstTop + (want - first.pos) * perMessage;
  return Math.max(0, top + targetTop - containerTop(container) - S.layout.scrollOffset);
}

function isScrollUp(e: Event): boolean {
  if (e instanceof WheelEvent) return e.deltaY <= 0;
  if (e instanceof KeyboardEvent) return e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home';
  return e.type === 'touchmove';
}

/** What a seeker needs from its session. */
export interface SeekContext {
  view: View;
  ledger: Ledger;
  /** The session's feed right now (claude.ai may replace it mid-jump). */
  feed(): HTMLElement | null;
  /** The session's current list of questions. */
  items(): Entry[];
  tracker(): ActiveTracker | null;
  stopped(): boolean;
  /** Re-read the page into the ledger and the view, now. */
  rebuild(): void;
  scheduleRebuild(): void;
}

export interface Seeker {
  /** Jumps to the question at `index` of the session's list. */
  scrollTo(index: number): Promise<void>;
  /** Ends the running jump, if any. */
  cancel(): void;
  /** Lets a real scroll by the user end the running jump; returns the undo. */
  listen(): () => void;
}

export function createSeeker(ctx: SeekContext): Seeker {
  const { ledger, view } = ctx;
  let seekController: AbortController | null = null;
  let seekingUp = false; // the running jump goes up: scrolling up helps it, never cancels it

  function cancelSeek() {
    if (seekController) seekController.abort();
    seekController = null;
    seekingUp = false;
    view.seeking(false);
  }

  function onUserScroll(e: Event) {
    const t = e.target;
    // The scroll up we asked for (to make claude.ai load earlier messages)
    // must not end the very jump that asked for it.
    // A jump up through a long chat needs the user's scroll-ups (they make
    // claude.ai load earlier messages), so those never cancel it, whenever
    // they come. Any other scroll by the user ends the jump.
    if (seekingUp && isScrollUp(e)) return;
    // Anything inside the panel (seen from here as its host element) is the
    // panel's own: scrolling its list, often with trackpad momentum still
    // running when you click a question, must not cancel that very jump.
    if (t instanceof Element && t.id === HOST_ID) return;
    if (e instanceof KeyboardEvent) {
      // Only scrolling keys, and not while typing.
      if (!SCROLL_KEYS.has(e.key)) return;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (t instanceof HTMLElement && t.isContentEditable) return;
    }
    seekLog('user scroll cancels', { type: e.type });
    cancelSeek();
    ctx.tracker()?.unpin();
  }

  // The clicked item is marked active at once and stays so while the page
  // scrolls to it, instead of the highlight running through every question
  // passed on the way. Scroll tracking takes over once the scroll is done.
  async function scrollTo(index: number): Promise<void> {
    const items = ctx.items();
    const entry = items[index];
    if (!entry) return;
    const theFeed = ctx.feed();
    if (!theFeed || !theFeed.isConnected) return ctx.scheduleRebuild();
    cancelSeek();
    const container = findScrollContainer(theFeed);
    ctx.tracker()?.pin(index);
    const controller = new AbortController();
    seekController = controller;
    // Which way the jump goes: up unless the target is at or below a
    // rendered question. Going up may need earlier messages loaded on the
    // way, which only the user's scroll-ups make claude.ai do.
    const firstMounted = items.findIndex((e) => mounted(e));
    seekingUp = !mounted(entry) && (firstMounted === -1 || index < firstMounted);
    jumpStart = performance.now();
    seekLog('jump', { index, pos: entry.pos, label: entry.label.slice(0, 30), up: seekingUp });
    // Going up to a question not on the page: claude.ai has to load earlier
    // messages first, which can take a while in a long chat.
    if (seekingUp) view.seeking(true, isDocScroller(container) ? null : container);
    const landing = await seek(entry, theFeed, container, controller.signal);
    seekLog('landing', { found: !!landing, aborted: controller.signal.aborted });
    if (landing) await settleOn(entry, container, landing.scrolled, controller.signal);
    // A newer click owns the pin now; a user scroll has released it already.
    if (seekController !== controller) return;
    seekController = null;
    view.seeking(false);
    seekingUp = false; // the wheel may still be turning: no longer a cancel, but no longer ours either
    if (landing) {
      // The highlight asks for the message on every frame: claude.ai may
      // re-create it while it is shown.
      const box = () => {
        const turn = turnOf(entry);
        return turn ? safe('message box', () => messageBox(turn), turn) : null;
      };
      safe('highlight', () => view.highlight(box, isDocScroller(container) ? null : container));
    } else if (!ctx.stopped()) {
      // The question is in the list (from the API) but claude.ai does not
      // show it: the page loads a chat's history only so far back, and
      // offers no way to load the rest. The panel shows its text instead.
      safe('unreachable', () => view.unreachable(index));
    }
    ctx.tracker()?.unpin();
  }

  // The entry's rendered turn right now: the one the ledger attached, or
  // the turn at its position in the conversation (claude.ai re-creates
  // turns as it measures them, so the node found before scrolling may be
  // gone by the time the scroll ends).
  //
  // The text decides: the page's numbering does not always follow the
  // API's, so a turn found by position is taken only if its text agrees
  // with the entry's (or one of the two has no text to compare).
  function turnOf(entry: Entry): HTMLElement | null {
    if (mounted(entry)) return entry.node;
    const feed = ctx.feed();
    if (!feed) return null;
    const rendered = collect(feed).items;
    if (entry.key) {
      const byText = rendered.filter((r) => keyOf(r.full) === entry.key);
      if (byText.length === 1) return byText[0].target;
    }
    const pos = entry.pos != null ? ledger.pagePosition(entry.pos) : null;
    if (pos == null) return null;
    const hit = rendered.find((r) => r.pos === pos);
    if (hit) return textConflicts(entry, hit, ctx.items()) ? null : hit.target;
    const turn = q.all(feed, S.turn).find((t) => safe('position', () => S.turnPosition(t), null) === pos);
    return turn && !entry.key ? turn : null;
  }

  // After the smooth scroll, make sure the target ends up where it should.
  // On a long jump claude.ai measures the turns passed on the way and moves
  // the scroll position itself to keep the view steady (going up, every
  // time). Such a move cancels a smooth scroll, so corrections are instant:
  // nothing can interrupt them. Done once the target has stayed in place
  // for two frames.
  async function settleOn(entry: Entry, container: Element, scrolled: boolean, signal: AbortSignal) {
    if (scrolled) await scrollEnded(container, SCROLL_END_WAIT_MS);
    const scrollEl = scrollElementOf(container);
    let steady = 0;
    for (let pass = 0; pass < SETTLE_PASSES; pass++) {
      if (signal.aborted || ctx.stopped()) return;
      await nextFrame();
      if (signal.aborted || ctx.stopped()) return;
      ctx.rebuild();
      const turn = turnOf(entry);
      if (!turn) return;
      const delta = turn.getBoundingClientRect().top - containerTop(container) - S.layout.scrollOffset;
      // Already as far as the page goes (a question near the very end or start).
      const atEnd = delta > 0 && scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2;
      const atStart = delta < 0 && scrollEl.scrollTop <= 0;
      if (Math.abs(delta) <= SETTLE_SLACK_PX || atEnd || atStart) {
        if (++steady >= 2) return;
        continue;
      }
      steady = 0;
      scrollContainerBy(container, delta, 'instant');
      // Let the virtualizer react to the move before measuring again.
      await settle(ctx.feed(), SETTLE_WAIT_MS, signal);
    }
  }

  // Scrolls the chat to its top, trying repeatedly and in different ways:
  // claude.ai moves the scroll itself while it measures turns passed on
  // the way, so one scroll to 0 may not stick. True once at the top; false
  // if the page keeps holding the scroller below it.
  async function reachTop(container: Element, theFeed: HTMLElement, signal: AbortSignal): Promise<boolean> {
    const scrollEl = scrollElementOf(container);
    for (let attempt = 0; attempt < TOP_ATTEMPTS; attempt++) {
      if (signal.aborted || ctx.stopped()) return false;
      if (scrollEl.scrollTop <= 1) return true;
      const before = scrollEl.scrollTop;
      if (attempt % 3 === 0) scrollContainerTo(container, 0);
      else if (attempt % 3 === 1) scrollContainerBy(container, -2 * containerHeight(container), 'instant');
      else {
        const first = q.all(theFeed, S.turn)[0];
        if (first) safe('scrollIntoView', () => first.scrollIntoView({ block: 'start' }));
        else scrollContainerTo(container, 0);
      }
      await settle(theFeed, SEEK_SETTLE_MS, signal);
      ctx.rebuild();
      seekLog('reach top', { attempt, before: Math.round(before), after: Math.round(scrollEl.scrollTop) });
    }
    return scrollEl.scrollTop <= 1;
  }

  // At the top of what is loaded, with the question further up: gets the
  // page to load the messages before. True once it has.
  //
  // `byCount`: the page numbers only the messages it has loaded (current
  // claude.ai), so a load shows as a higher count (aria-setsize), and only
  // that counts: more turns, a taller feed or another text at the top also
  // come from claude.ai merely laying out what it already has. It loads
  // when a scroll arrives at the top from further down, not while the
  // chat sits there or moves a little near it, and its hidden "Load earlier
  // messages" button only scrolls to the first loaded message. So: wait at
  // the top, and while nothing comes, go a few screens down and come back.
  //
  // Otherwise (older markup, or a page that numbers the whole conversation)
  // its "Load earlier messages" button loads, and loading shows as more
  // turns or a taller feed.
  async function loadEarlier(
    theFeed: HTMLElement,
    container: Element,
    byCount: boolean,
    signal: AbortSignal
  ): Promise<boolean> {
    const feed = () => {
      const live = ctx.feed();
      return live && live.isConnected ? live : theFeed;
    };
    const before = loadedCount(feed());
    const loaded =
      byCount && before != null
        ? await loadByScrolling(feed, before, container, signal)
        : await loadByButton(feed, container, signal);
    if (!loaded || signal.aborted || ctx.stopped()) return false;
    // Let claude.ai lay the new messages out before measuring them.
    await settle(feed(), SEEK_SETTLE_MS, signal);
    ctx.rebuild();
    return true;
  }

  async function loadByScrolling(
    feed: () => HTMLElement,
    before: number,
    container: Element,
    signal: AbortSignal
  ): Promise<boolean> {
    const grown = () => (loadedCount(feed()) ?? before) > before;
    const scrollEl = scrollElementOf(container);
    const deadline = performance.now() + USER_LOAD_WAIT_MS;
    for (let attempt = 0; performance.now() < deadline; attempt++) {
      if (signal.aborted || ctx.stopped()) return false;
      if (attempt > 0) {
        const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
        scrollContainerTo(container, Math.min(max, TOP_APPROACH_SCREENS * containerHeight(container)));
        await settle(feed(), SEEK_SETTLE_MS, signal);
        if (signal.aborted || ctx.stopped()) return false;
        scrollContainerTo(container, 0);
      }
      const grew = await waitForDom(grown, LOAD_ATTEMPT_MS, signal);
      seekLog('load earlier', { attempt, before, now: loadedCount(feed()), grew });
      if (grew) return true;
    }
    return false;
  }

  async function loadByButton(feed: () => HTMLElement, container: Element, signal: AbortSignal): Promise<boolean> {
    const before = loadedCount(feed());
    const turns = countTurns(feed());
    const height = feedHeight(feed());
    const grown = () =>
      (loadedCount(feed()) ?? before) !== before || countTurns(feed()) > turns || feedHeight(feed()) > height + 1;
    const button = findLoadEarlierButton();
    seekLog('load earlier (button)', { before, button: !!button });
    if (button) {
      button.click();
      if (await waitForDom(grown, LOAD_CLICK_TIMEOUT_MS, signal)) return true;
      if (signal.aborted || ctx.stopped()) return false;
    }
    // No button, or it did nothing: wait for the user to scroll up, keeping
    // the page at the top meanwhile (it may move the scroll by itself).
    const scrollEl = scrollElementOf(container);
    const nudge = setInterval(() => {
      if (scrollEl.scrollTop > 1) scrollContainerTo(container, 0);
    }, TOP_NUDGE_MS);
    try {
      const grew = await waitForDom(grown, USER_LOAD_WAIT_MS, signal);
      seekLog('waited for user scroll', { grew, now: loadedCount(feed()), turns: countTurns(feed()) });
      return grew;
    } finally {
      clearInterval(nudge);
    }
  }

  // Finds the turn of the question at conversation position `target` with
  // a binary search over the scroll range. Each rendered turn carries its
  // page position (aria-posinset; see Ledger.pagePosition for how that maps
  // to the conversation), so the turns on screen tell whether the target is
  // above or below: the range halves on every step, whatever the heights of
  // the messages and however often claude.ai re-measures them. Scrolling up
  // may make claude.ai load earlier messages by itself, which renumbers the
  // page: the target's page position is recomputed on every step.
  async function findByPosition(
    entry: Entry,
    theFeed: HTMLElement,
    container: Element,
    signal: AbortSignal
  ): Promise<HTMLElement | null> {
    const target = entry.pos!;
    const offset = entry.offset;
    const scrollEl = scrollElementOf(container);
    const maxScroll = () => Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    let lo = 0;
    let hi = maxScroll();
    let loaded: number | null = null; // how many messages the page has loaded
    let loads = 0; // batches of earlier messages loaded on the way
    // First step: where it was last seen, if known.
    let next: number | null =
      offset == null
        ? null
        : scrollEl.scrollTop +
          theFeed.getBoundingClientRect().top +
          offset -
          containerTop(container) -
          S.layout.scrollOffset;
    for (let step = 0; step < SEEK_MAX_STEPS; step++) {
      if (signal.aborted || ctx.stopped()) return null;
      const live = ctx.feed();
      const f = live && live.isConnected ? live : theFeed;
      const rendered = renderedPositions(f);
      // The page's number for it, recomputed every step: loading earlier
      // messages renumbers the page.
      const want = ledger.pagePosition(target);
      seekLog('byPos step', {
        step,
        want,
        loaded,
        top: Math.round(scrollEl.scrollTop),
        rendered: rendered.map((r) => r.pos).join(','),
      });
      if (want == null || !rendered.length) return seekLog('byPos: no want/rendered', null);
      // Found by number: taken only if its text agrees with the question's
      // (the page's numbering does not always follow the API's). If not,
      // the numbering is off here: give up on it and let seek() go by text.
      const found = turnOf(entry);
      if (found) return found;
      if (rendered.some((r) => r.pos === want)) return seekLog('byPos: number there but text differs', null);
      const size = safe('set size', () => S.turnSetSize(rendered[0].turn), null);
      if (size !== loaded) {
        // More messages loaded (or the first step): the page is renumbered
        // and its height changed, so the old bounds mean nothing. Restart
        // on the whole range, first at the target's share of it.
        loaded = size;
        lo = 0;
        hi = maxScroll();
        if (next == null && size && want >= 1) next = ((want - 1) / size) * hi;
      }
      const top = scrollEl.scrollTop;
      if (want < 1) {
        // Not loaded yet: it is above everything on the page. At the top,
        // claude.ai loads earlier messages (see loadEarlier).
        // "At the top" also when a scroll to 0 did not move: claude.ai
        // holds the scroller a little below 0 while its sizer settles.
        // Get to the top first (it may take several tries); at the top,
        // or if the page will not let us there, load earlier messages.
        if (top > 1 && (await reachTop(container, f, signal))) {
          next = null;
          continue;
        }
        if (!(await loadEarlier(f, container, true, signal))) return seekLog('byPos: load failed/aborted', null);
        // The step budget is per loaded batch: a far question needs
        // many loads, each followed by a fresh search of the new range.
        if (++loads > SEEK_MAX_LOADS) return null;
        step = 0;
        next = null;
        continue;
      }
      // Which way to go is decided by the turns on screen only: claude.ai
      // keeps a few far-away turns mounted too (the last one, for one), so
      // the rendered positions are not one contiguous run.
      const view = onScreen(rendered, container);
      if (!view.length) return seekLog('byPos: nothing on screen', null);
      const min = view[0].pos;
      const max = view[view.length - 1].pos;
      if (want < min) {
        // Above everything on screen. Already at the top of the page, that
        // means above everything loaded (a page that numbers the whole
        // conversation says so only this way): load earlier messages.
        if (top <= 1) {
          if (!(await loadEarlier(f, container, false, signal))) return seekLog('byPos: load failed/aborted', null);
          if (++loads > SEEK_MAX_LOADS) return null;
          step = 0;
          next = null;
          continue;
        }
        hi = Math.min(hi, top);
      } else if (want > max) {
        if (top >= maxScroll() - 1) return seekLog('byPos: at bottom', null); // nothing further down
        lo = Math.max(lo, top);
      } else return seekLog('byPos: between turns on screen', null); // yet not rendered: no such turn
      // Best guess: as far as the target is from the turns on screen, at
      // the height per message those turns show. Usually lands on it or
      // next to it, where halving the range would take several steps
      // (each one a scroll claude.ai must render: a blank screen meanwhile).
      if (next == null) next = estimateScroll(view, want, top, container);
      hi = Math.min(hi, maxScroll());
      // Re-measuring can leave the bounds crossed; start over on the whole range.
      if (lo >= hi) {
        lo = 0;
        hi = maxScroll();
      }
      const to = next != null && next >= lo && next <= hi ? next : (lo + hi) / 2;
      next = null;
      scrollContainerTo(container, to);
      await settle(f, SEEK_SETTLE_MS, signal);
      ctx.rebuild();
    }
    return null;
  }

  // Brings the entry's turn on screen: the turn, and whether a smooth scroll
  // to it has started; null if it could not be found.
  async function seek(
    entry: Entry,
    theFeed: HTMLElement,
    container: Element,
    signal: AbortSignal
  ): Promise<{ el: HTMLElement; scrolled: boolean } | null> {
    const land = (el: HTMLElement) => safe('scroll', () => ({ el, scrolled: scrollToElement(container, el) }), null);
    if (mounted(entry)) return land(entry.node);
    if (entry.pos != null && ledger.pagePosition(entry.pos) != null && renderedPositions(theFeed).length) {
      const el = await findByPosition(entry, theFeed, container, signal);
      if (el) return land(el);
    }

    // Without positions on the page (older markup): jump to where the
    // question is expected, let
    // claude.ai render that part, and repeat: the rendered questions tell
    // which way (and roughly how far) it still is.
    const scrollEl = scrollElementOf(container);
    const lineOffset = () => containerTop(container) + S.layout.scrollOffset;
    let usedOffset = false;
    let loads = 0; // batches of earlier messages loaded on the way
    for (let step = 0; step < SEEK_MAX_STEPS; step++) {
      if (signal.aborted || ctx.stopped()) return null;
      const list = ledger.list();
      const i = list.indexOf(entry);
      if (i === -1) return null;
      if (mounted(entry)) return land(entry.node);
      // Rendered but not attached (its text didn't match): find it by position.
      const byPos = turnOf(entry);
      if (byPos) return land(byPos);
      const rendered: number[] = [];
      list.forEach((e, j) => mounted(e) && rendered.push(j));
      const nodeTop = (j: number) => list[j].node!.getBoundingClientRect().top;
      const feedTop = theFeed.getBoundingClientRect().top;
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
        if (i > first && i < lastR) {
          // Between two rendered questions but not rendered itself (a long
          // answer in between keeps it off screen). Aim between its nearest
          // rendered neighbours, proportionally to its position.
          const below = rendered.find((j) => j > i)!;
          const above = rendered.filter((j) => j < i).pop()!;
          const topA = nodeTop(above);
          const topB = nodeTop(below);
          const guess = topA + ((topB - topA) * (i - above)) / (below - above);
          if (Math.abs(guess - lineOffset()) < 2) return null;
          scrollContainerBy(container, guess - lineOffset(), 'instant');
          await settle(theFeed, SEEK_SETTLE_MS, signal);
          if (signal.aborted || ctx.stopped()) return null;
          ctx.rebuild();
          continue;
        }
        const spread = nodeTop(lastR) - nodeTop(first);
        const perQuestion = lastR > first ? spread / (lastR - first) : scrollEl.scrollHeight / Math.max(1, list.length);
        const page = 0.9 * containerHeight(container);
        if (i < first) {
          if (scrollEl.scrollTop <= 1 || i === 0) {
            // At the top (or going for the very first question: straight
            // there): the question is in "earlier messages".
            if (scrollEl.scrollTop > 1 && (await reachTop(container, theFeed, signal))) continue;
            if (!(await loadEarlier(theFeed, container, false, signal))) return null;
            if (++loads > SEEK_MAX_LOADS) return null;
            step = 0;
            continue;
          }
          scrollContainerBy(container, -Math.max(page, 0.8 * (first - i) * perQuestion), 'instant');
        } else {
          if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2) return null;
          scrollContainerBy(container, Math.max(page, 0.8 * (i - lastR) * perQuestion), 'instant');
        }
      }
      await settle(theFeed, SEEK_SETTLE_MS, signal);
      if (signal.aborted || ctx.stopped()) return null;
      ctx.rebuild();
    }
    return null;
  }

  function listen(): () => void {
    for (const type of USER_SCROLL_EVENTS) window.addEventListener(type, onUserScroll, { passive: true });
    return () => {
      for (const type of USER_SCROLL_EVENTS) window.removeEventListener(type, onUserScroll);
    };
  }

  return { scrollTo, cancel: cancelSeek, listen };
}
