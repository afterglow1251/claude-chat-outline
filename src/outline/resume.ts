// Where you were in each chat. claude.ai opens a chat at its end; if you
// were reading further up when you left, the view offers to take you back.
//
// The place is the question you were reading (its matching key, so it
// survives edits elsewhere in the chat). While the offer is up, the place
// is kept as it was: opening a chat and leaving again must not lose it.
// Once you move (scroll, jump, send a message) the offer goes, and from
// then on the question you read is the place.
import * as Sources from '../data/sources';
import type { Entry, View } from '../core/types';

const SAVE_DELAY_MS = 1000;

export interface Resume {
  /**
   * The question being read is `active` (-1: none); `settled`: the list is
   * the conversation's full one.
   */
  update(items: readonly Entry[], active: number, settled: boolean, clip: Element | null): void;
  /** The offer was taken or dismissed: the place follows the reader now. */
  done(): void;
  stop(): void;
}

export function createResume(convId: string, view: View): Resume {
  // loading: the saved place is not read yet; deciding: waiting for the
  // full list; offered: the offer is up; tracking: saving where you are.
  let phase: 'loading' | 'deciding' | 'offered' | 'tracking' = 'loading';
  let saved: string | null = null;
  let openedAt = ''; // the question being read when the offer went up
  let last: { items: readonly Entry[]; active: number; settled: boolean; clip: Element | null } | null = null;
  let pending: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  Sources.loadPlace(convId).then((key) => {
    if (stopped) return;
    saved = key;
    phase = 'deciding';
    if (last) update(last.items, last.active, last.settled, last.clip);
  });

  function update(items: readonly Entry[], active: number, settled: boolean, clip: Element | null) {
    last = { items, active, settled, clip };
    if (stopped || phase === 'loading') return;
    const here = items[active];
    if (phase === 'deciding') {
      if (!settled || !here) return;
      const at = saved ? items.findIndex((e) => e.key === saved) : -1;
      // Only a place above where the chat opened is worth going back to.
      if (at === -1 || at >= active) return done();
      phase = 'offered';
      openedAt = here.key;
    }
    if (phase === 'offered') {
      const at = items.findIndex((e) => e.key === saved);
      if (at === -1 || (here && here.key !== openedAt)) return done();
      view.offerResume({ index: at, label: items[at].label }, clip);
      return;
    }
    if (here && here.key) schedule(here.key);
  }

  function done() {
    if (phase === 'offered') view.offerResume(null);
    phase = 'tracking';
    const here = last && last.items[last.active];
    if (here && here.key) schedule(here.key);
  }

  function schedule(key: string) {
    if (key === (pending ?? saved)) return;
    pending = key;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY_MS);
  }

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (pending === null) return;
    saved = pending;
    pending = null;
    Sources.savePlace(convId, saved);
  }

  return {
    update,
    done() {
      if (phase === 'offered') done();
    },
    stop() {
      flush();
      if (phase === 'offered') view.offerResume(null);
      stopped = true;
    },
  };
}
