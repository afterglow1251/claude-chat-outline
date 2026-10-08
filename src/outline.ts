// Outline core: extraction, the question ledger, observers, scrolling,
// active tracking, load-all. Never writes to Claude's DOM; the highlight on
// the question you jump to is drawn by the panel (see highlight.ts).
//
// claude.ai virtualizes the message list: only the turns near the viewport
// are in the DOM, and they are unmounted again as you scroll. So the outline
// is not "what is rendered" but a ledger of the conversation's questions:
// taken from claude.ai's own API when possible (complete at once), from a
// per-chat cache, and from everything rendered so far. Entries are never
// dropped because their message is not rendered right now.
import * as S from './selectors';
import * as Sources from './sources';
import { HOST_ID, LOCATION_EVENT } from './events';
import { watchConversations } from './intercept';
import type { ApiQuestion, Entry, LoadReason, LoadState, Query, RenderedItem, Status, Strategy, View } from './types';
import { LOG, safe, warnOnce } from './util';

const LABEL_MAX = 90;
const ATTACHMENT_LABEL = '(attachment)';
const REBUILD_DEBOUNCE_MS = 150;
// A plain debounce never fires while Claude streams (mutations arrive every
// few ms), so a question you just sent would not appear until the answer
// finished. Force a rebuild at least this often.
const REBUILD_MAX_WAIT_MS = 1000;
const LOAD_MAX_CLICKS = 50;
const LOAD_MAX_MS = 30000;
const LOAD_STEP_TIMEOUT_MS = 8000;
// How long the button's click gets to add messages before we conclude it
// did not load any (on current claude.ai it only scrolls to the first one).
const LOAD_CLICK_TIMEOUT_MS = 2500;
// How long to wait for the user to scroll up (which is what makes
// claude.ai fetch earlier messages) before giving up on the jump.
const USER_LOAD_WAIT_MS = 60000;
// Attempts to get the scroller to its very top before concluding that the
// page holds it there (claude.ai re-adjusts the scroll while it measures
// turns, which can undo a scroll to 0 several times in a row).
const TOP_ATTEMPTS = 12;
// While waiting for the user's scroll, the page is nudged back to the top
// this often: claude.ai fetches earlier messages only when at the top.
const TOP_NUDGE_MS = 700;
// Scanning: scroll through the whole chat so the virtualizer renders (and
// the ledger records) every question.
const SCAN_MAX_MS = 60000;
const SCAN_SETTLE_MS = 250;
const SCAN_MAX_ROUNDS = 3;
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
// Offsets drift a little as the virtualizer re-measures turns.
const OFFSET_SLACK = 4;
// Questions are matched by their first KEY_LEN letters and digits.
const KEY_LEN = 48;
const CACHE_WAIT_MS = 500;
const SAVE_DELAY_MS = 1000;
const API_MIN_INTERVAL_MS = 4000;

// ---------------------------------------------------------------------------
// Safe DOM helpers. A broken selector must degrade to "nothing found",
// never to an exception that breaks claude.ai.
// ---------------------------------------------------------------------------

export const q: Query = Object.freeze({
  one: (root: ParentNode | null, sel: string) =>
    safe(sel, () => (root || document).querySelector<HTMLElement>(sel), null),
  all: (root: ParentNode | null, sel: string) =>
    safe(sel, () => Array.from((root || document).querySelectorAll<HTMLElement>(sel)), [] as HTMLElement[]),
  text: (el: Node | null | undefined) => safe('textContent', () => (el && el.textContent) || '', ''),
});

export function isConversationPath(pathname: string): boolean {
  return S.conversationPaths.some((re) => re.test(pathname));
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export function findFeed(): HTMLElement | null {
  for (const sel of S.feed) {
    const el = q.one(document, sel);
    if (el) return el;
  }
  return null;
}

function runStrategy(strategy: Strategy, feed: HTMLElement): HTMLElement[] {
  const nodes = safe(strategy.name, () => strategy.find(feed, q), []);
  return Array.isArray(nodes) ? nodes : [];
}

/** `turn` is the scroll target, `source` the matched node. */
interface Hit {
  turn: HTMLElement;
  source: HTMLElement;
}

// Uses the first strategy with results.
function findUserMessages(feed: HTMLElement): { strategy: string | null; hits: Hit[] } {
  for (const strategy of S.userMessageStrategies) {
    const nodes = runStrategy(strategy, feed);
    if (nodes.length > 0) return { strategy: strategy.name, hits: groupByTurn(nodes) };
  }
  return { strategy: null, hits: [] };
}

// One bullet per turn, even if a selector matches several nodes inside it.
function groupByTurn(nodes: HTMLElement[]): Hit[] {
  const seen = new Set<HTMLElement>();
  const hits: Hit[] = [];
  for (const source of nodes) {
    const turn = safe('closest', () => source.closest<HTMLElement>(S.turn), null) || source;
    if (seen.has(turn)) continue;
    seen.add(turn);
    hits.push({ turn, source });
  }
  return hits;
}

// innerText keeps the line break between blocks (a code block and the
// paragraph after it); textContent would glue them together.
function blockText(el: HTMLElement): string {
  return safe('innerText', () => el.innerText, '') || q.text(el);
}

function messageText({ turn, source }: Hit): string {
  // Strategies 1 and 3 match the message body directly.
  if (source !== turn) return blockText(source);
  // Strategy 2 matches the whole turn; its text would include the
  // heading and button labels, so look for the body inside it first.
  const body = q.one(turn, S.userMessageBody);
  if (body) return blockText(body);
  // The "You said: …" heading is a screen-reader heading that carries the
  // message itself. If it is empty after the prefix, the message has no
  // text (attachment only); don't fall back to the article, whose text
  // would be button labels like "Edit".
  const heading = safe('heading', () => S.userHeadingIn(turn, q), null);
  if (heading) return q.text(heading).replace(S.userHeadingPrefix, '');
  return q.text(turn);
}

function truncate(text: string): string {
  return text.length <= LABEL_MAX ? text : text.slice(0, LABEL_MAX - 1).trimEnd() + '…';
}

// Code fences ("```python" and the closing "```" lines) are in the stored
// message but not in the rendered one; drop them so both read the same.
function plainText(text: string | null | undefined): string {
  return (text || '')
    .replace(/^[ \t]*```[^\n`]*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toItem(hit: Hit): RenderedItem {
  const full = plainText(messageText(hit));
  const pos = hit.turn !== hit.source ? safe('position', () => S.turnPosition(hit.turn), null) : null;
  return { target: hit.turn, full, pos, label: full ? truncate(full) : ATTACHMENT_LABEL };
}

export interface Collected {
  status: Status;
  strategy: string | null;
  items: RenderedItem[];
}

// Reports only what is in the DOM right now; the ledger adds the rest.
export function collect(feed: HTMLElement | null): Collected {
  if (!feed) return { status: 'no-feed', strategy: null, items: [] };
  const { strategy, hits } = findUserMessages(feed);
  const items = hits.map(toItem);
  let status: Status = 'ok';
  // Only call it "broken" if the feed actually shows something. An empty
  // feed is normal for a moment right after navigation.
  if (!items.length) status = q.text(feed).trim() ? 'selectors-broken' : 'empty';
  return { status, strategy, items };
}

export function findLoadEarlierButton(): HTMLElement | null {
  const { selector, text } = S.loadEarlierButton;
  return (
    q.all(document, selector).find((b) => text.test(q.text(b)) || text.test(b.getAttribute('aria-label') || '')) || null
  );
}

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

// Matching key: letters and digits only, so markdown, whitespace and
// punctuation differences between the API text and the rendered text
// don't matter.
export function keyOf(full: string): string {
  return full
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, KEY_LEN);
}

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
function alignKeys(a: readonly Keyed[], b: readonly Keyed[]): [number, number][] {
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
function createCoverage() {
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

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

function docScroller(): Element {
  return document.scrollingElement || document.documentElement;
}

function isDocScroller(el: Element): boolean {
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

function scrollElementOf(container: Element): Element {
  return isDocScroller(container) ? docScroller() : container;
}

function containerTop(container: Element): number {
  return isDocScroller(container) ? 0 : container.getBoundingClientRect().top;
}

function containerHeight(container: Element): number {
  return isDocScroller(container) ? window.innerHeight : container.clientHeight;
}

function scrollContainerBy(container: Element, top: number, behavior: ScrollBehavior) {
  if (isDocScroller(container)) window.scrollBy({ top, behavior });
  else container.scrollBy({ top, behavior });
}

function scrollContainerTo(container: Element, top: number) {
  if (isDocScroller(container)) window.scrollTo({ top, behavior: 'instant' });
  else container.scrollTo({ top, behavior: 'instant' });
}

/** Scrolls the target to the top of the chat; false if it was there already. */
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
function messageBox(turn: HTMLElement): HTMLElement {
  const body = q.one(turn, S.userMessageBody);
  const stop = turn.parentElement;
  for (let el: HTMLElement | null = body; el && el !== stop; el = el.parentElement) {
    if (!isTransparent(getComputedStyle(el).backgroundColor)) return el;
  }
  return body || turn;
}

// ---------------------------------------------------------------------------
// Active-item tracking
// ---------------------------------------------------------------------------

// Whether a rendered question found at the entry's position is clearly NOT
// the entry's: its text is that of another question in the list. A text
// that only differs from the entry's (rendered differently from how it is
// stored: a code block, markdown) is no conflict.
function textConflicts(entry: Entry, item: RenderedItem, list: readonly Entry[]): boolean {
  const key = keyOf(item.full);
  if (!key || !entry.key || key === entry.key) return false;
  return list.some((e) => e !== entry && e.key === key);
}

function mounted(entry: Entry | undefined): entry is Entry & { node: HTMLElement } {
  return !!(entry && entry.node && entry.node.isConnected);
}

interface ActiveTracker {
  container: Element;
  setTargets(next: Entry[]): void;
  /** Report this item as active until unpin(), whatever is on screen. */
  pin(index: number): void;
  unpin(): void;
  destroy(): void;
}

// The active item is the last question whose top is at or above the
// "line" (scroller top + scrollOffset). Rendered questions decide it: the
// rendered turns always cover the viewport, so if the first rendered
// question is below the line, the one before it (unmounted, above) is the
// active one. Remembered offsets are only used when no question is
// rendered at all (deep inside a very long answer).
function createActiveTracker(
  container: Element,
  getFeed: () => HTMLElement | null,
  onActive: (index: number) => void
): ActiveTracker {
  const isDoc = isDocScroller(container);
  const scrollEl = scrollElementOf(container);
  let targets: Entry[] = [];
  let current: number | undefined;
  let pinned: number | null = null;
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
    let active: number;
    if (lastAbove !== -1) active = lastAbove;
    else if (firstMounted !== -1) active = Math.max(0, firstMounted - 1);
    else {
      // No question rendered: go by where they were last seen. With nothing
      // seen yet (a chat that is still loading) nothing is marked, rather
      // than a guess that jumps once the chat appears.
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
      const bottom = isDoc ? window.innerHeight : container.getBoundingClientRect().bottom;
      for (let i = lastMounted; i > active; i--) {
        if (tops.has(i) && tops.get(i)! < bottom) {
          active = i;
          break;
        }
      }
    }
    emit(active);
  }

  function emit(index: number) {
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

// ---------------------------------------------------------------------------
// Waiting for the page
// ---------------------------------------------------------------------------

function countTurns(feed: HTMLElement | null): number {
  if (!feed) return 0;
  const turns = q.all(feed, S.turn).length;
  // If the turn selector ever breaks, any growth of the feed still counts.
  return turns > 0 ? turns : feed.getElementsByTagName('*').length;
}

/** The ones among `turns` that are inside the scroller's visible area. */
function onScreen<T extends { turn: HTMLElement }>(turns: T[], container: Element): T[] {
  const top = isDocScroller(container) ? 0 : container.getBoundingClientRect().top;
  const bottom = top + containerHeight(container);
  return turns.filter(({ turn }) => {
    const r = turn.getBoundingClientRect();
    return r.bottom > top && r.top < bottom;
  });
}

/** The rendered turns that carry a position, in conversation order. */
function renderedPositions(feed: HTMLElement): { turn: HTMLElement; pos: number }[] {
  return q
    .all(feed, S.turn)
    .map((turn) => ({ turn, pos: safe('position', () => S.turnPosition(turn), null) }))
    .filter((r): r is { turn: HTMLElement; pos: number } => r.pos != null)
    .toSorted((a, b) => a.pos - b.pos);
}

function feedHeight(feed: HTMLElement | null): number {
  return feed ? feed.getBoundingClientRect().height : 0;
}

// The next animation frame, or FRAME_FALLBACK_MS if none comes: frames
// do not run in a background tab, and a jump must not hang until the tab
// is looked at again.
const FRAME_FALLBACK_MS = 50;
function nextFrame(): Promise<void> {
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
function waitForDom(predicate: () => boolean, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
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
function settle(feed: HTMLElement | null, timeoutMs: number, signal: AbortSignal): Promise<void> {
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
function scrollEnded(container: Element, timeoutMs: number): Promise<void> {
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

// ---------------------------------------------------------------------------
// "Load all questions": click "Load earlier messages" until it is gone,
// then scan the whole chat so the virtualizer renders every question.
// ---------------------------------------------------------------------------

async function loadAllEarlier({
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

async function scanAll({
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

// ---------------------------------------------------------------------------
// Session: everything that lives for one conversation. convId is the
// conversation id from the URL (the session lives as long as that id stays
// the same; it is the cache key and the API key).
// ---------------------------------------------------------------------------

// Shared with debugReport().
// Diagnostics for jumps; off unless `localStorage['claude-outline-debug']` is set.
function seekLog<T>(msg: string, data: T): T {
  try {
    if (localStorage.getItem('claude-outline-debug'))
      console.debug(LOG, 'seek:', msg, data == null ? '' : JSON.stringify(data));
  } catch {
    /* storage blocked */
  }
  return data;
}

const debugState = {
  convId: null as string | null,
  source: 'none' as 'none' | 'page' | 'cache' | 'api' | 'claude.ai response',
  api: 'not tried',
  questions: 0,
  rendered: 0,
};

export interface Session {
  start(): Promise<void>;
  stop(): void;
  scrollTo(index: number): Promise<void>;
  loadAll(): Promise<void>;
  cancelLoad(): void;
}

type Outcome = { reason: LoadReason; clicks: number };

/** The turns rendered right now (on a route change: the previous chat's). */
export function renderedTurns(): Set<Element> {
  return new Set(q.all(findFeed(), S.turn));
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
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let acquireFrame = 0;
  let loadController: AbortController | null = null;
  let seekController: AbortController | null = null;
  let seekingUp = false; // the running jump goes up: scrolling up helps it, never cancels it
  let complete = false; // the list is known to be complete
  let apiState: 'idle' | 'loading' | 'ok' | 'failed' = 'idle';
  let apiLast = 0;
  let apiTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let savedVersion = 0;
  let scanLedger: Ledger | null = null; // fresh list built during a page-only "Load all"
  let unwatchConversations: (() => void) | null = null;
  const coverage = createCoverage();
  const ledger = createLedger();
  const cache = convId ? Sources.createCache(convId) : null;

  async function start() {
    Object.assign(debugState, { convId, source: 'page', api: 'not tried', questions: 0, rendered: 0 });
    // 0. The conversation claude.ai itself loads (relayed by page-bridge.ts):
    // complete, and needs no request of our own. May arrive at any time,
    // including right now if the page loaded it before we started.
    unwatchConversations = watchConversations((payload) => {
      if (payload.convId === convId && !stopped) applyQuestions(payload.questions, 'claude.ai response');
    });
    // 1. What we remembered from an earlier visit: shown immediately.
    if (cache) {
      const record = await Promise.race([
        cache.load(),
        new Promise<null>((r) => setTimeout(() => r(null), CACHE_WAIT_MS)),
      ]).catch(() => null);
      if (stopped) return;
      if (record && record.items.length && !ledger.isAuthoritative()) {
        ledger.seed(record.items);
        complete = record.complete;
        savedVersion = ledger.version;
        debugState.source = 'cache';
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
    for (const type of USER_SCROLL_EVENTS) window.addEventListener(type, onUserScroll, { passive: true });
    acquireFeed();
    // 3. Our own request to claude.ai's API, unless claude.ai's response
    // already gave us the list.
    if (!ledger.isAuthoritative()) refreshFromApi();
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
      if (scanLedger) {
        const scan = scanLedger;
        safe('scan ledger', () => scan.absorb(result.items, f));
      }
    }
    items = ledger.list();
    debugState.questions = items.length;
    debugState.rendered = result.items.length;
    const canLoadEarlier = !!findLoadEarlierButton();
    view.render({
      // The DOM may show nothing for a moment; what we know is still valid.
      status: items.length ? 'ok' : result.status,
      strategy: result.strategy,
      items,
      canLoadEarlier,
      incomplete: !complete && (canLoadEarlier || coverage.incomplete()),
      // Final: from the API (the cache's "complete" is last visit's guess),
      // or when the API failed and the page-only list is all there is.
      settled: ledger.isAuthoritative() || apiState === 'failed',
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
    if (!container) return view.setActive(-1);
    if (!tracker) tracker = createActiveTracker(container, () => feed, view.setActive);
    tracker.setTargets(items);
  }

  // ----- cache --------------------------------------------------------------

  function scheduleSave() {
    if (!cache || ledger.version === savedVersion || saveTimer) return;
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!cache || !items.length) return;
    savedVersion = ledger.version;
    // Pending questions (sent after the last API answer) are saved too; the
    // next API answer corrects the list anyway.
    cache.save(
      items.map((e) => e.full),
      complete
    );
  }

  // ----- API ----------------------------------------------------------------

  async function refreshFromApi(): Promise<boolean> {
    if (!convId || apiState === 'loading') return false;
    apiState = 'loading';
    debugState.api = 'loading';
    let texts: ApiQuestion[] | null = null;
    try {
      texts = await Sources.fetchQuestions(convId);
    } catch (err) {
      warnOnce('conversation API', err);
    }
    apiLast = performance.now();
    if (stopped) return false;
    if (texts && applyQuestions(texts, 'api')) {
      apiState = 'ok';
      debugState.api = `ok (${texts.length} questions)`;
      return true;
    }
    apiState = 'failed';
    debugState.api = texts ? 'empty answer' : 'unavailable (see warning above)';
    rebuild(); // the page-only list is final now (see RenderResult.settled)
    return false;
  }

  // The complete list of questions, from the API or claude.ai's response.
  function applyQuestions(texts: readonly ApiQuestion[], source: 'api' | 'claude.ai response'): boolean {
    // An empty answer for a chat that shows messages is not believable
    // (a brand-new chat the API has not caught up with yet).
    if (!texts.length && items.length) return false;
    debugState.source = source;
    ledger.setAuthoritative(texts);
    complete = true;
    rebuild();
    saveNow();
    return true;
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

  // ----- jumping --------------------------------------------------------------

  function isScrollUp(e: Event): boolean {
    if (e instanceof WheelEvent) return e.deltaY <= 0;
    if (e instanceof KeyboardEvent) return e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home';
    return e.type === 'touchmove';
  }

  function cancelSeek() {
    if (seekController) seekController.abort();
    seekController = null;
    seekingUp = false;
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
    tracker?.unpin();
  }

  // The clicked item is marked active at once and stays so while the page
  // scrolls to it, instead of the highlight running through every question
  // passed on the way. Scroll tracking takes over once the scroll is done.
  async function scrollTo(index: number): Promise<void> {
    const entry = items[index];
    if (!entry) return;
    if (!feed || !feed.isConnected) return scheduleRebuild();
    const theFeed = feed;
    cancelSeek();
    const container = findScrollContainer(theFeed);
    tracker?.pin(index);
    const controller = new AbortController();
    seekController = controller;
    // Which way the jump goes: up unless the target is at or below a
    // rendered question. Going up may need earlier messages loaded on the
    // way, which only the user's scroll-ups make claude.ai do.
    const firstMounted = items.findIndex((e) => mounted(e));
    seekingUp = !mounted(entry) && (firstMounted === -1 || index < firstMounted);
    seekLog('jump', { index, pos: entry.pos, label: entry.label.slice(0, 30), up: seekingUp });
    const landing = await seek(entry, theFeed, container, controller.signal);
    seekLog('landing', { found: !!landing, aborted: controller.signal.aborted });
    if (landing) await settleOn(entry, container, landing.scrolled, controller.signal);
    // A newer click owns the pin now; a user scroll has released it already.
    if (seekController !== controller) return;
    seekController = null;
    seekingUp = false; // the wheel may still be turning: no longer a cancel, but no longer ours either
    if (landing) {
      // The highlight asks for the message on every frame: claude.ai may
      // re-create it while it is shown.
      const box = () => {
        const turn = turnOf(entry);
        return turn ? safe('message box', () => messageBox(turn), turn) : null;
      };
      safe('highlight', () => view.highlight(box, isDocScroller(container) ? null : container));
    } else if (!stopped) {
      // The question is in the list (from the API) but claude.ai does not
      // show it: the page loads a chat's history only so far back, and
      // offers no way to load the rest. The panel shows its text instead.
      safe('unreachable', () => view.unreachable(index));
    }
    tracker?.unpin();
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
    if (!feed) return null;
    const rendered = collect(feed).items;
    if (entry.key) {
      const byText = rendered.filter((r) => keyOf(r.full) === entry.key);
      if (byText.length === 1) return byText[0].target;
    }
    const pos = entry.pos != null ? ledger.pagePosition(entry.pos) : null;
    if (pos == null) return null;
    const hit = rendered.find((r) => r.pos === pos);
    if (hit) return textConflicts(entry, hit, items) ? null : hit.target;
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
      if (signal.aborted || stopped) return;
      await nextFrame();
      if (signal.aborted || stopped) return;
      rebuild();
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
      await settle(feed, SETTLE_WAIT_MS, signal);
    }
  }

  // Identifies the first loaded message: the text of the first rendered
  // turn at page position 1 (null while it is not rendered). Changes when
  // earlier messages are loaded, even if the count of loaded ones does not.
  function firstLoadedKey(theFeed: HTMLElement): string | null {
    const top = renderedPositions(theFeed)[0];
    if (!top || top.pos !== 1) return null;
    return keyOf(plainText(blockText(top.turn))) || `${top.turn.getAttribute('aria-label')}`;
  }

  // Scrolls the chat to its top, trying repeatedly and in different ways:
  // claude.ai moves the scroll itself while it measures turns passed on
  // the way, so one scroll to 0 may not stick. True once at the top; false
  // if the page keeps holding the scroller below it.
  async function reachTop(container: Element, theFeed: HTMLElement, signal: AbortSignal): Promise<boolean> {
    const scrollEl = scrollElementOf(container);
    for (let attempt = 0; attempt < TOP_ATTEMPTS; attempt++) {
      if (signal.aborted || stopped) return false;
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
      rebuild();
      seekLog('reach top', { attempt, before: Math.round(before), after: Math.round(scrollEl.scrollTop) });
    }
    return scrollEl.scrollTop <= 1;
  }

  // How many messages the page has loaded (aria-setsize), or null.
  function loadedCount(theFeed: HTMLElement): number | null {
    const first = renderedPositions(theFeed)[0];
    return first ? safe('set size', () => S.turnSetSize(first.turn), null) : null;
  }

  // At the top of what is loaded, with the question further up. claude.ai
  // fetches earlier messages only on a real scroll up by the user (a wheel
  // or trackpad move at the top): programmatic scrolling, synthetic events
  // and its hidden "Load earlier messages" button (which only scrolls to
  // the first loaded message) do not make it fetch. So: try the button
  // (older builds loaded on it), then ask the user to scroll up and wait
  // until more messages are loaded. True once there are more.
  async function loadEarlierOrAskUser(theFeed: HTMLElement, container: Element, signal: AbortSignal): Promise<boolean> {
    // Earlier messages arrived when the page says it has more loaded
    // (aria-setsize), when turns were added or the feed grew taller, or
    // when the first loaded message is another one: claude.ai keeps a
    // window of messages and may drop later ones as earlier ones load, so
    // the count can stay the same while the window moves up.
    const before = loadedCount(theFeed);
    const turns = countTurns(theFeed);
    const height = feedHeight(theFeed);
    const first = firstLoadedKey(theFeed);
    const grown = () =>
      (loadedCount(theFeed) ?? before) !== before ||
      countTurns(theFeed) > turns ||
      feedHeight(theFeed) > height + 1 ||
      (first !== null && firstLoadedKey(theFeed) !== first);
    const button = findLoadEarlierButton();
    seekLog('load earlier', { before, button: !!button });
    let nudge: ReturnType<typeof setInterval> | undefined;
    try {
      if (button) {
        button.click();
        await waitForDom(grown, LOAD_CLICK_TIMEOUT_MS, signal);
        if (signal.aborted || stopped) return false;
        if (grown()) {
          await nextFrame();
          rebuild();
          return true;
        }
      }
      // Keep the page at the top while waiting: claude.ai fetches only
      // there, and it may move the scroll by itself meanwhile.
      const scrollEl = scrollElementOf(container);
      nudge = setInterval(() => {
        if (scrollEl.scrollTop > 1) scrollContainerTo(container, 0);
      }, TOP_NUDGE_MS);
      const grew = await waitForDom(grown, USER_LOAD_WAIT_MS, signal);
      seekLog('waited for user scroll', {
        grew,
        aborted: signal.aborted,
        now: loadedCount(theFeed),
        turns: countTurns(theFeed),
        first: firstLoadedKey(theFeed)?.slice(0, 20),
      });
      if (!grew || signal.aborted || stopped) return false;
      // Let claude.ai lay the new messages out before measuring them.
      await settle(theFeed, SEEK_SETTLE_MS, signal);
      rebuild();
      return true;
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
  // The scroll position that puts the turn at page position `want` on the
  // line, extrapolated from the turns on screen (their tops and positions).
  function estimateScroll(
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
      if (signal.aborted || stopped) return null;
      const f = feed && feed.isConnected ? feed : theFeed;
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
        // claude.ai loads earlier messages (see loadEarlierOrAskUser).
        // "At the top" also when a scroll to 0 did not move: claude.ai
        // holds the scroller a little below 0 while its sizer settles.
        // Get to the top first (it may take several tries); at the top,
        // or if the page will not let us there, load earlier messages.
        if (top > 1 && (await reachTop(container, f, signal))) {
          next = null;
          continue;
        }
        if (!(await loadEarlierOrAskUser(f, container, signal))) return seekLog('byPos: load failed/aborted', null);
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
          if (!(await loadEarlierOrAskUser(f, container, signal))) return seekLog('byPos: load failed/aborted', null);
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
      rebuild();
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
      if (signal.aborted || stopped) return null;
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
          if (signal.aborted || stopped) return null;
          rebuild();
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
            if (!(await loadEarlierOrAskUser(theFeed, container, signal))) return null;
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
      if (signal.aborted || stopped) return null;
      rebuild();
    }
    return null;
  }

  // ----- "Load all" -------------------------------------------------------------

  async function loadAll() {
    if (loadController || stopped) return;
    cancelSeek();
    loadController = new AbortController();
    const { signal } = loadController;
    view.setLoadState({ running: true, clicks: 0 });
    let outcome: Outcome = { reason: 'done', clicks: 0 };
    try {
      // The API has everything, including messages the page has not loaded.
      if (!(await refreshFromApi())) outcome = await loadAllFromPage(signal);
    } catch (err) {
      warnOnce('load all', err);
      outcome = { reason: 'error', clicks: outcome.clicks };
    }
    scanLedger = null;
    loadController = null;
    if (stopped) return;
    acquireFeed();
    const done: LoadState = { running: false, ...outcome };
    view.setLoadState(done);
  }

  // Without the API: load all earlier messages, then scroll through the
  // whole chat so every question is rendered once. The fresh list replaces
  // the old one only if the scan completes.
  async function loadAllFromPage(signal: AbortSignal): Promise<Outcome> {
    let outcome: Outcome = { reason: 'done', clicks: 0 };
    const getFeed = () => (feed && feed.isConnected ? feed : findFeed());
    for (let round = 0; round < SCAN_MAX_ROUNDS; round++) {
      const earlier = await loadAllEarlier({
        signal,
        getFeed,
        onProgress: (clicks) => view.setLoadState({ running: true, clicks: outcome.clicks + clicks }),
      });
      outcome = { reason: earlier.reason, clicks: outcome.clicks + earlier.clicks };
      ledger.shift(earlier.shift);
      if (stopped) return outcome;
      acquireFeed();
      if (earlier.reason !== 'done' || !feed) break;
      const fresh = createLedger();
      scanLedger = fresh;
      const scan = await scanAll({
        signal,
        feed,
        absorb: rebuild,
        onProgress: (pct) => view.setLoadState({ running: true, clicks: outcome.clicks, scan: pct }),
      });
      if (stopped) return outcome;
      if (scan.reason !== 'done') {
        outcome.reason = scan.reason;
        break;
      }
      // The scan may have revealed another "Load earlier messages".
      if (!findLoadEarlierButton()) {
        if (fresh.list().length) ledger.adopt(fresh);
        complete = true;
        break;
      }
    }
    return outcome;
  }

  function cancelLoad() {
    if (loadController) loadController.abort();
  }

  function stop() {
    if (saveTimer) saveNow();
    stopped = true;
    cancelLoad();
    cancelSeek();
    unwatchConversations?.();
    unwatchConversations = null;
    if (bodyObserver) bodyObserver.disconnect();
    if (feedObserver) feedObserver.disconnect();
    if (tracker) tracker.destroy();
    clearTimeout(debounceTimer);
    clearTimeout(maxWaitTimer);
    clearTimeout(apiTimer);
    if (acquireFrame) clearTimeout(acquireFrame);
    for (const type of USER_SCROLL_EVENTS) window.removeEventListener(type, onUserScroll);
    feed = null;
    tracker = null;
    bodyObserver = null;
    feedObserver = null;
    items = [];
  }

  return { start, stop, scrollTo, loadAll, cancelLoad };
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
