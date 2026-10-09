// Where you left off in each chat, shown as a quiet marker in the question
// list rather than an offer over the chat (see resume.ts, turned off): if
// the question you were reading last time is above where claude.ai opens
// the chat, its row carries a bookmark for the whole visit. Nothing pops up;
// you go back by clicking it, like any other question.
//
// The place is the question you chose to go to (a jump from the panel,
// saved at once: in a long chat the jump itself can take many seconds), or
// one you stayed on for DWELL_MS while scrolling, not one passed through.
// Saved by its matching key, so it survives edits elsewhere in the chat.
import * as Sources from '../data/sources';
import type { Entry, View } from '../core/types';

const DWELL_MS = 5000;

export interface Place {
  /** The question being read is `active` (-1: none); `settled`: the list is the conversation's full one. */
  update(items: readonly Entry[], active: number, settled: boolean): void;
  /** A jump to this question started: it is the place now. */
  chose(entry: Entry | undefined): void;
  stop(): void;
}

export function createPlace(convId: string, view: View): Place {
  let saved: string | null | undefined; // undefined: not read yet
  let decided = false; // the marker for this visit is set (or not wanted)
  let reading: string | null = null; // the question the dwell timer runs for
  let dwellTimer: ReturnType<typeof setTimeout> | undefined;
  let last: { items: readonly Entry[]; active: number; settled: boolean } | null = null;
  let stopped = false;

  Sources.loadPlace(convId).then((key) => {
    if (stopped) return;
    saved = key;
    if (last) update(last.items, last.active, last.settled);
  });

  function update(items: readonly Entry[], active: number, settled: boolean) {
    last = { items, active, settled };
    if (stopped) return;
    const here = items[active];
    // Once per visit, with the full list and the question the chat opened at.
    if (!decided && saved !== undefined && settled && here) {
      decided = true;
      const at = saved ? items.findIndex((e) => e.key === saved) : -1;
      if (at !== -1 && at < active) view.markPlace(saved!);
    }
    const key = here?.key || null;
    if (key === reading) return;
    reading = key;
    clearTimeout(dwellTimer);
    if (key && key !== saved) dwellTimer = setTimeout(() => save(key), DWELL_MS);
  }

  function save(key: string) {
    if (stopped) return;
    saved = key;
    Sources.savePlace(convId, key);
  }

  return {
    update,
    chose(entry) {
      const key = entry?.key;
      if (!key || stopped) return;
      clearTimeout(dwellTimer);
      reading = key;
      if (key !== saved) save(key);
    },
    stop() {
      stopped = true;
      clearTimeout(dwellTimer);
      view.markPlace(null);
    },
  };
}
