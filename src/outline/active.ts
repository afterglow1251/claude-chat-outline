// ---------------------------------------------------------------------------
// Active-item tracking
// ---------------------------------------------------------------------------
import * as S from '../core/selectors';
import type { Entry, RenderedItem } from '../core/types';
import { safe } from '../core/util';
import { keyOf } from './extract';
import { containerTop, FRAME_FALLBACK_MS, isDocScroller, scrollElementOf } from './scroll';

// Whether a rendered question found at the entry's position is clearly NOT
// the entry's: its text is that of another question in the list. A text
// that only differs from the entry's (rendered differently from how it is
// stored: a code block, markdown) is no conflict.
export function textConflicts(entry: Entry, item: RenderedItem, list: readonly Entry[]): boolean {
  const key = keyOf(item.full);
  if (!key || !entry.key || key === entry.key) return false;
  return list.some((e) => e !== entry && e.key === key);
}

export function mounted(entry: Entry | undefined): entry is Entry & { node: HTMLElement } {
  return !!(entry && entry.node && entry.node.isConnected);
}

export interface ActiveTracker {
  container: Element;
  setTargets(next: Entry[]): void;
  /** Report this item as active until unpin(), whatever is on screen. */
  pin(index: number): void;
  unpin(): void;
  destroy(): void;
}

// The active item is the last question whose top is at or above the
// "line" (scroller top + scrollOffset). Rendered questions decide it: the
// rendered turns usually cover the viewport, so if the first rendered
// question is below the line but on screen, the one before it (unmounted,
// above) is the active one. With no rendered question on screen (deep
// inside a very long answer, or fast scrolling while claude.ai has dropped
// the turns around the reader) the marked one stays; remembered offsets
// only place the first mark.
export function createActiveTracker(
  container: Element,
  getFeed: () => HTMLElement | null,
  onActive: (index: number) => void
): ActiveTracker {
  const isDoc = isDocScroller(container);
  const scrollEl = scrollElementOf(container);
  let targets: Entry[] = [];
  let current: number | undefined;
  let pinned: number | null = null;
  let lastEntry: Entry | undefined;
  let frame = 0;
  let fallback: ReturnType<typeof setTimeout> | undefined;

  function compute() {
    if (pinned !== null) return emit(pinned);
    if (!targets.length) return emit(-1);
    const line = containerTop(container) + S.layout.scrollOffset + 2;
    const tops = new Map<number, number>();
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
    const bottom = isDoc ? window.innerHeight : container.getBoundingClientRect().bottom;
    // Scrolling fast through a long chat, claude.ai drops every turn but
    // the last for a moment; then what is rendered no longer covers the
    // viewport, and the turn before it is not where the reader is.
    const covered = firstMounted !== -1 && tops.get(firstMounted)! < bottom;
    let active: number;
    if (lastAbove !== -1) active = lastAbove;
    else if (covered) active = Math.max(0, firstMounted - 1);
    else {
      // No question on screen. Once one has been marked, keep it: offsets
      // seen before claude.ai loaded or dropped turns above are stale, and
      // while it remounts turns (fast scrolling) any guess flickers.
      const held = heldIndex();
      if (held !== -1) return emit(held);
      // First paint deep inside a long answer: go by where questions were
      // last seen. With nothing seen yet (a chat still loading) nothing is
      // marked, rather than a guess that jumps once the chat appears.
      const feed = getFeed();
      const feedTop = feed ? feed.getBoundingClientRect().top : 0;
      active = -1;
      targets.forEach((t, i) => {
        if (t.offset != null && feedTop + t.offset <= line) active = i;
      });
      if (active === -1 && targets.some((t) => t.offset != null)) active = 0;
    }
    // At the very bottom, a question followed by a short answer can never
    // reach the line, so clicking it would never mark it active. There,
    // prefer the last question that is actually visible.
    if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2) {
      for (let i = lastMounted; i > active; i--) {
        if (tops.has(i) && tops.get(i)! < bottom) {
          active = i;
          break;
        }
      }
    }
    emit(active);
  }

  // The last marked question, found again in the current list (indexes
  // shift when questions are added, and the list is rebuilt often).
  function heldIndex(): number {
    if (!lastEntry) return -1;
    const same = targets.indexOf(lastEntry);
    if (same !== -1) return same;
    return lastEntry.key ? targets.findIndex((t) => t.key === lastEntry!.key) : -1;
  }

  function emit(index: number) {
    if (index >= 0) lastEntry = targets[index];
    if (index === current) return;
    current = index;
    onActive(index);
  }

  // On the next frame; on a timer in a background tab (no frames there).
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(run);
    if (document.hidden) fallback = setTimeout(run, FRAME_FALLBACK_MS);
  }
  function run() {
    cancelAnimationFrame(frame);
    clearTimeout(fallback);
    frame = 0;
    safe('active tracking', compute);
  }

  const scrollTarget: EventTarget = isDoc ? window : container;
  scrollTarget.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);

  return {
    container,
    setTargets(next) {
      targets = next;
      current = undefined; // indexes shift when questions are added
      schedule();
    },
    pin(index) {
      pinned = index;
      emit(index);
    },
    unpin() {
      if (pinned === null) return;
      pinned = null;
      schedule();
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(fallback);
      scrollTarget.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    },
  };
}
