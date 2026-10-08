// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------
import * as S from '../core/selectors';
import { safe } from '../core/util';
import { q } from './extract';

function docScroller(): Element {
  return document.scrollingElement || document.documentElement;
}

export function isDocScroller(el: Element): boolean {
  return el === document.scrollingElement || el === document.documentElement || el === document.body;
}

// Claude scrolls an inner element, not the window. Walk up from the feed
// to the first ancestor that is both scrollable and actually overflowing.
export function findScrollContainer(from: Element): Element {
  return safe(
    'scroll container',
    () => {
      for (let el: Element | null = from; el && !isDocScroller(el); el = el.parentElement) {
        const overflowY = getComputedStyle(el).overflowY;
        const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
        if (scrollable && el.scrollHeight > el.clientHeight) return el;
      }
      return docScroller();
    },
    docScroller()
  );
}

export function scrollElementOf(container: Element): Element {
  return isDocScroller(container) ? docScroller() : container;
}

export function containerTop(container: Element): number {
  return isDocScroller(container) ? 0 : container.getBoundingClientRect().top;
}

export function containerHeight(container: Element): number {
  return isDocScroller(container) ? window.innerHeight : container.clientHeight;
}

export function scrollContainerBy(container: Element, top: number, behavior: ScrollBehavior) {
  if (isDocScroller(container)) window.scrollBy({ top, behavior });
  else container.scrollBy({ top, behavior });
}

export function scrollContainerTo(container: Element, top: number) {
  if (isDocScroller(container)) window.scrollTo({ top, behavior: 'instant' });
  else container.scrollTo({ top, behavior: 'instant' });
}

export /** Scrolls the target to the top of the chat; false if it was there already. */
// Always instant: the highlight shows where you landed, and a smooth
// scroll only makes you wait while claude.ai renders everything passed.
function scrollToElement(container: Element, target: HTMLElement): boolean {
  const delta = target.getBoundingClientRect().top - containerTop(container) - S.layout.scrollOffset;
  if (Math.abs(delta) < 1) return false;
  scrollContainerBy(container, delta, 'instant');
  return true;
}

// "transparent", rgba(…, 0) or color(srgb … / 0): claude.ai uses the latter
// notation for its translucent bubble backgrounds.
const isTransparent = (color: string) =>
  color === 'transparent' || /^rgba\(.*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color);

// The visible box of a question: its bubble, i.e. the closest element
// around the text that paints its own background. Falls back to the text
// block, then to the whole turn.
export function messageBox(turn: HTMLElement): HTMLElement {
  const body = q.one(turn, S.userMessageBody);
  const stop = turn.parentElement;
  for (let el: HTMLElement | null = body; el && el !== stop; el = el.parentElement) {
    if (!isTransparent(getComputedStyle(el).backgroundColor)) return el;
  }
  return body || turn;
}

// ---------------------------------------------------------------------------
// Waiting for the page
// ---------------------------------------------------------------------------

export function countTurns(feed: HTMLElement | null): number {
  if (!feed) return 0;
  const turns = q.all(feed, S.turn).length;
  // If the turn selector ever breaks, any growth of the feed still counts.
  return turns > 0 ? turns : feed.getElementsByTagName('*').length;
}

/** The ones among `turns` that are inside the scroller's visible area. */
export function onScreen<T extends { turn: HTMLElement }>(turns: T[], container: Element): T[] {
  const top = isDocScroller(container) ? 0 : container.getBoundingClientRect().top;
  const bottom = top + containerHeight(container);
  return turns.filter(({ turn }) => {
    const r = turn.getBoundingClientRect();
    return r.bottom > top && r.top < bottom;
  });
}

/** The rendered turns that carry a position, in conversation order. */
export function renderedPositions(feed: HTMLElement): { turn: HTMLElement; pos: number }[] {
  return q
    .all(feed, S.turn)
    .map((turn) => ({ turn, pos: safe('position', () => S.turnPosition(turn), null) }))
    .filter((r): r is { turn: HTMLElement; pos: number } => r.pos != null)
    .toSorted((a, b) => a.pos - b.pos);
}

export function feedHeight(feed: HTMLElement | null): number {
  return feed ? feed.getBoundingClientRect().height : 0;
}

// The next animation frame, or FRAME_FALLBACK_MS if none comes: frames
// do not run in a background tab, and a jump must not hang until the tab
// is looked at again.
export const FRAME_FALLBACK_MS = 50;
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      resolve();
    };
    const frame = requestAnimationFrame(finish);
    const timer = setTimeout(finish, FRAME_FALLBACK_MS);
  });
}

// Resolves true as soon as predicate() holds (checked on DOM mutations,
// not on a timer), or false on timeout / abort.
export function waitForDom(predicate: () => boolean, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (safe('wait', predicate, false)) return resolve(true);
    let done = false;
    const finish = (value: boolean) => {
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
export function settle(feed: HTMLElement | null, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      mo.disconnect();
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      nextFrame().then(resolve);
    };
    const mo = new MutationObserver(finish);
    if (feed && feed.isConnected) mo.observe(feed, { childList: true, subtree: true });
    const timer = setTimeout(finish, timeoutMs);
    signal.addEventListener('abort', finish);
  });
}

// Resolves when a scroll of the container ends, or after timeoutMs if none
// starts (the target was already in place).
export function scrollEnded(container: Element, timeoutMs: number): Promise<void> {
  const target: EventTarget = isDocScroller(container) ? window : container;
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      target.removeEventListener('scrollend', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    target.addEventListener('scrollend', finish);
  });
}
