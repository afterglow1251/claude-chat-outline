// ---------------------------------------------------------------------------
// Ledger: every question of this conversation that we know of, in order.
//
// `node` is the rendered turn, or null while claude.ai has it unmounted.
// `offset` is the turn's top relative to the feed's top when last seen
// (independent of the scroll position); it is only an estimate used to jump
// back to it.
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
import * as S from '../core/selectors';
import type { ApiQuestion, Entry, RenderedItem } from '../core/types';
import { warnOnce } from '../core/util';
import { ATTACHMENT_LABEL, keyOf, plainText, q, truncate } from './extract';
import { feedHeight } from './scroll';

// Offsets drift a little as the virtualizer re-measures turns.
const OFFSET_SLACK = 4;

function makeEntry(text: string | ApiQuestion): Entry {
  const pos = text && typeof text === 'object' ? text.pos || null : null;
  const full = plainText(text && typeof text === 'object' ? text.text : text);
  return {
    key: keyOf(full),
    full,
    pos,
    label: full ? truncate(full) : ATTACHMENT_LABEL,
    node: null,
    offset: null,
    pending: false,
  };
}

type Keyed = Pick<Entry, 'key' | 'offset'>;

// Longest common subsequence of keys, as [[i in a, j in b], ...] in order.
// A single item is matched to the same-key candidate closest by offset.
export function alignKeys(a: readonly Keyed[], b: readonly Keyed[]): [number, number][] {
  if (!a.length || !b.length) return [];
  if (a.length === 1) {
    let best = -1;
    const dist = (j: number) =>
      b[j].offset == null || a[0].offset == null ? Infinity : Math.abs(b[j].offset! - a[0].offset!);
    for (let j = 0; j < b.length; j++) {
      if (b[j].key === a[0].key && (best === -1 || dist(j) < dist(best))) best = j;
    }
    return best === -1 ? [] : [[0, best]];
  }
  const n = a.length;
  const m = b.length;
  if (n * m > 4e6) {
    // Too big for the table: greedy in-order matching.
    const pairs: [number, number][] = [];
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
      t[i * w + j] =
        a[i].key === b[j].key ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i].key === b[j].key && t[i * w + j] === t[(i + 1) * w + j + 1] + 1) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

export interface Ledger {
  absorb(items: RenderedItem[], feed: HTMLElement | null): void;
  shift(delta: number): void;
  list(): Entry[];
  /** Cached questions from an earlier visit (page-only mode). */
  seed(texts: readonly (string | ApiQuestion)[]): void;
  /** The complete list from claude.ai's API. */
  setAuthoritative(texts: readonly (string | ApiQuestion)[]): void;
  /** A completed scan: the fresh list replaces everything. */
  adopt(other: Ledger): void;
  isAuthoritative(): boolean;
  /**
   * The page's position ("Message N") of the question at this position in
   * the conversation, or null while that is not known. They differ while
   * earlier messages are not loaded: the page numbers only what it loaded.
   */
  pagePosition(pos: number): number | null;
  takeRefreshRequest(): boolean;
  /** Bumps whenever the list of questions changes. */
  readonly version: number;
}

/** A rendered question, as an entry attached to its node. */
type Sighting = Entry & { node: HTMLElement; offset: number };

export function createLedger(): Ledger {
  let entries: Entry[] = [];
  let authoritative = false;
  let wantsRefresh = false;
  let mismatch = false;
  let version = 0;
  // conversation position - page position, for the turns rendered now.
  let posShift: number | null = null;

  function changed() {
    version++;
  }

  function sightings(items: RenderedItem[], feed: HTMLElement): Sighting[] {
    const feedTop = feed.getBoundingClientRect().top;
    return items.map((item) => {
      const e = makeEntry(item.full);
      e.pos = item.pos || null;
      e.node = item.target;
      e.offset = item.target.getBoundingClientRect().top - feedTop;
      return e as Sighting;
    });
  }

  // If every turn that stayed rendered moved by the same amount, something
  // was inserted above (earlier messages loaded), so the remembered
  // positions of unmounted entries moved by that amount too.
  function inferShift(seen: Sighting[]) {
    const byNode = new Map(entries.filter((e) => e.node).map((e) => [e.node!, e]));
    let delta: number | null = null;
    for (const s of seen) {
      const e = byNode.get(s.node);
      if (!e || e.offset == null) continue;
      const d = s.offset - e.offset;
      if (delta === null) delta = d;
      else if (Math.abs(d - delta) > OFFSET_SLACK) return;
    }
    if (delta !== null && Math.abs(delta) > OFFSET_SLACK) shift(delta);
  }

  function shift(delta: number) {
    if (delta) for (const e of entries) if (!e.node && e.offset != null) e.offset += delta;
  }

  function absorb(items: RenderedItem[], feed: HTMLElement | null) {
    if (!items.length || !feed) return;
    const seen = sightings(items, feed);
    const present = new Set(seen.map((s) => s.node));
    for (const e of entries) if (e.node && !present.has(e.node)) e.node = null;
    inferShift(seen);
    if (!authoritative) return absorbGrowing(seen, true);
    calibrate(seen);
    for (const s of seen) s.pos = s.pos != null && posShift != null ? s.pos + posShift : null;
    if (absorbContiguous(seen, feed)) return;
    // Rendered text that doesn't match the API's: attach what matches,
    // add nothing (the API list is the complete one).
    if (!mismatch) {
      mismatch = true;
      warnOnce(
        'rendered questions differ from the API list',
        seen.map((s) => s.label)
      );
    }
    absorbGrowing(seen, false);
  }

  // The page numbers only the messages it has loaded (the last ones), so
  // its "Message N" is the conversation position minus the number of
  // messages not loaded. That difference is the same for every rendered
  // turn: find it from the rendered questions whose text matches a
  // question of the list, taking the difference most of them agree on
  // (texts can repeat). Kept as it was when no text matches this time.
  function calibrate(seen: Sighting[]) {
    const votes = new Map<number, number>();
    for (const s of seen) {
      if (s.pos == null || !s.key) continue;
      for (const e of entries) {
        if (e.pos != null && e.key === s.key) votes.set(e.pos - s.pos, (votes.get(e.pos - s.pos) ?? 0) + 1);
      }
    }
    let best: number | null = null;
    let most = 0;
    for (const [shift, count] of votes) {
      if (count > most) {
        best = shift;
        most = count;
      }
    }
    if (best !== null) posShift = best;
  }

  // Authoritative mode, exact: the turn's position (translated to the
  // conversation, see calibrate) equals the API position. The page's
  // numbering is not guaranteed to follow the API's, so the texts decide
  // whether it does here: a rendered text that is the text of ANOTHER
  // question of the list means the numbers are off, and nothing is
  // attached by them. A text that merely differs from the one at its
  // position (a code block, markdown, an attachment: rendered differently
  // from how it is stored) is fine, as long as some text agrees.
  function absorbByPosition(seen: Sighting[]): boolean {
    if (!seen.every((s) => s.pos) || !entries.length || !entries.every((e) => e.pos)) return false;
    const byPos = new Map(entries.map((e, j) => [e.pos!, j]));
    const byKey = new Map<string, number>();
    entries.forEach((e, j) => e.key && byKey.set(e.key, j));
    const maxPos = entries[entries.length - 1].pos!;
    let compared = 0;
    let agreed = 0;
    for (const s of seen) {
      const j = byPos.get(s.pos!);
      if (j === undefined) {
        if (s.pos! <= maxPos) return false; // numbering doesn't line up
        continue;
      }
      if (s.key && entries[j].key) {
        compared++;
        if (s.key === entries[j].key) agreed++;
        else if (byKey.has(s.key)) return false; // its text is another question's: numbering off
      }
    }
    if (compared && !agreed) return false;
    for (const s of seen) {
      const j = byPos.get(s.pos!);
      if (j !== undefined) {
        entries[j].node = s.node;
        entries[j].offset = s.offset;
      } else {
        // A question newer than the API answer (just sent).
        s.pending = true;
        entries.push(s);
        byPos.set(s.pos!, entries.length - 1);
        wantsRefresh = true;
        changed();
      }
    }
    return true;
  }

  // Authoritative mode: find where the rendered run sits in the list.
  function absorbContiguous(seen: Sighting[], feed: HTMLElement): boolean {
    if (absorbByPosition(seen)) return true;
    const n = entries.length;
    const fits = (start: number) => {
      if (start < 0) return false;
      let overlap = 0;
      for (let i = 0; i < seen.length && start + i < n; i++) {
        if (entries[start + i].key !== seen[i].key) return false;
        overlap++;
      }
      return overlap > 0 || n === 0;
    };
    let start: number | null = null;
    const byNode = new Map<HTMLElement, number>();
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
    const from = start;
    seen.forEach((s, i) => {
      const j = from + i;
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
  function absorbGrowing(seen: Sighting[], insert: boolean) {
    const match = seen.map(() => -1);
    const byNode = new Map<HTMLElement, number>();
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
    for (let i = 0; i < seen.length;) {
      if (match[i] !== -1) {
        i++;
        continue;
      }
      let k = i;
      while (k < seen.length && match[k] === -1) k++;
      const lo = i > 0 ? match[i - 1] : -1;
      const hi = k < seen.length ? match[k] : entries.length;
      const candidates: number[] = [];
      for (let j = lo + 1; j < hi; j++) if (!entries[j].node) candidates.push(j);
      for (const [a, b] of alignKeys(
        seen.slice(i, k),
        candidates.map((j) => entries[j])
      ))
        match[i + a] = candidates[b];
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
    const inserts = new Map<number, Entry[]>(); // insert before entries[p]
    seen.forEach((s, i) => {
      if (match[i] !== -1) return;
      let p: number | null = null;
      for (let a = i - 1; a >= 0 && p === null; a--) if (match[a] !== -1) p = match[a] + 1;
      for (let b = i + 1; b < seen.length && p === null; b++) if (match[b] !== -1) p = match[b];
      if (p === null) {
        p = entries.findIndex((e) => e.offset != null && e.offset > s.offset);
        if (p === -1) p = entries.length;
      }
      if (!inserts.has(p)) inserts.set(p, []);
      inserts.get(p)!.push(s);
    });
    if (!inserts.size) return;
    const next: Entry[] = [];
    for (let p = 0; p <= entries.length; p++) {
      if (inserts.has(p)) next.push(...inserts.get(p)!);
      if (p < entries.length) next.push(entries[p]);
    }
    entries = next;
    changed();
  }

  // Replaces the list, keeping what we know about each question (its
  // rendered node and position) where the texts line up.
  function replaceWith(texts: readonly (string | ApiQuestion)[], isAuthoritative: boolean) {
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
    seed: (texts) => replaceWith(texts, false),
    setAuthoritative: (texts) => replaceWith(texts, true),
    adopt(other) {
      entries = other.list().slice();
      changed();
    },
    isAuthoritative: () => authoritative,
    pagePosition(pos) {
      // Page-only lists keep the page's own positions.
      if (!authoritative) return pos;
      return posShift === null ? null : pos - posShift;
    },
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
export function createCoverage() {
  let ranges: { start: number; end: number }[] = [];
  let height = 0;
  return {
    record(feed: HTMLElement) {
      const turns = q.all(feed, S.turn);
      if (!turns.length) return;
      const rect = feed.getBoundingClientRect();
      height = rect.height;
      const start = turns[0].getBoundingClientRect().top - rect.top;
      const end = turns[turns.length - 1].getBoundingClientRect().bottom - rect.top;
      const merged: typeof ranges = [];
      let cur = { start, end };
      for (const r of ranges.toSorted((a, b) => a.start - b.start)) {
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
