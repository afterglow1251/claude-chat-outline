// The stars of one kind (questions, diagrams or code) in the open chat.
// One set per kind, shared by its view and the Starred overview, so a star
// set or cleared in one shows in the other at once. Saved per chat (see
// sources.ts), on this machine only.
import { loadStars, saveStars, type StarScope } from '../data/sources';

export interface StarSet {
  has(key: string): boolean;
  toggle(key: string): void;
  readonly size: number;
  /** Calls `fn` on every change (stars loaded or toggled); returns the undo. */
  subscribe(fn: () => void): () => void;
  /** Loads another chat's stars (none off a chat page). */
  setConversation(convId: string | null): void;
}

export function createStarSet(scope: StarScope): StarSet {
  let convId: string | null = null;
  let keys = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());

  return {
    has: (key) => keys.has(key),
    get size() {
      return keys.size;
    },
    toggle(key) {
      if (keys.has(key)) keys.delete(key);
      else keys.add(key);
      if (convId) saveStars(convId, [...keys], scope);
      notify();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    setConversation(id) {
      convId = id;
      keys = new Set();
      notify();
      if (!id) return;
      void loadStars(id, scope).then((loaded) => {
        if (convId !== id) return;
        keys = new Set(loaded);
        notify();
      });
    },
  };
}
