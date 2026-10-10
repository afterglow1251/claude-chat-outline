// One cache of what claude.ai says about each conversation: your questions,
// Claude's diagrams and its code. The session (outline.ts) and the Diagrams
// and Code views read it and hear about every change; none asks the API
// itself.
//
// Filled from, cheapest first:
//  - memory: everything this tab has received, for the most recent chats;
//  - chrome.storage.local: the questions of the chats you opened lately
//    (see pruneCache), so a chat lists them at once even after a reload;
//  - the conversation claude.ai loads itself (relayed by page-bridge.ts):
//    questions only, and no request of ours;
//  - our own request: questions and diagrams from one response, and never
//    two at once for the same chat.
// What is known is shown at once and checked again behind it. A list that
// did not change keeps its identity, so nothing that shows it redraws.
import type { ApiQuestion, CodeBlock, Diagram } from '../core/types';
import { safe } from '../core/util';
import { watchConversations } from './intercept';
import { CACHE_PREFIX, fetchConversationParts, pruneCache, storageGet, storageSet } from './sources';

// Memory: what all the chats may hold together, in characters (strings take
// two bytes each, so about 8 MB). Past it, the chats used least recently
// give up their diagrams and code first (read again when those views open),
// and their questions, so coming back stays instant, only after. A chat
// open now, or being read from claude.ai, always stays whole.
const MEMORY_BUDGET = 4_000_000;
const MEMORY_MAX_CHATS = 50;
const STORED_TEXT_MAX = 400; // characters kept per question (tooltip text)
// One chat's questions in chrome.storage: a huge chat keeps shorter texts.
const STORED_CHAT_MAX = 150_000;
const STORED_TEXT_SHORT = 80;
// The cache in chrome.storage is pruned on every page load, and after this
// many writes in a tab that stays open.
const PRUNE_EVERY_WRITES = 25;
// Opening a chat, claude.ai loads it itself, which checks a cached list for
// free. Our own request is made only if that has not come by then.
const REVALIDATE_AFTER_MS = 5000;

export type Questions =
  /** The conversation's full list, from claude.ai. */
  | { fromApi: true; items: readonly ApiQuestion[] }
  /** Built from the page on an earlier visit (the API was unavailable): complete after a "Load all". */
  | { fromApi: false; items: readonly string[]; complete: boolean };

export type Source = 'storage' | 'api' | 'claude.ai response' | 'page';

interface State {
  /** null while nothing is known. */
  questions: Questions | null;
  source: Source | null;
  /** When claude.ai last gave the questions (performance.now()); null: not since this page loaded. */
  questionsAt: number | null;
  /** Claude's diagrams; null until our own request has read them (claude.ai's response is relayed as questions only). */
  diagrams: readonly Diagram[] | null;
  /** Claude's code blocks; null until our own request has read them, like the diagrams. */
  code: readonly CodeBlock[] | null;
  /** When our own request last succeeded, or null. */
  fetchedAt: number | null;
}

export type Conversation = Readonly<State>;
type Listener = (conversation: Conversation) => void;

interface Chat extends State {
  id: string;
  stored: Promise<void> | null; // reading chrome.storage, once
  request: Promise<boolean> | null;
  revalidateTimer: ReturnType<typeof setTimeout> | undefined;
  listeners: Set<Listener>;
  storedJson: string; // what was last written, so an unchanged list is not written again
  size: number; // characters held (see MEMORY_BUDGET)
}

/** As kept in chrome.storage.local. Records written before `api` and `pos` existed are page lists. */
interface Stored {
  t?: number;
  items?: unknown;
  pos?: unknown;
  api?: unknown;
  complete?: unknown;
}

// Most recently used last.
const memory = new Map<string, Chat>();

function chat(id: string): Chat {
  let r = memory.get(id);
  if (r) memory.delete(id);
  else {
    r = {
      id,
      questions: null,
      source: null,
      questionsAt: null,
      diagrams: null,
      code: null,
      fetchedAt: null,
      stored: null,
      request: null,
      revalidateTimer: undefined,
      listeners: new Set(),
      storedJson: '',
      size: 0,
    };
  }
  memory.set(id, r);
  evict(id);
  return r;
}

function measure(r: Chat): number {
  let n = 0;
  for (const q of r.questions?.items ?? []) n += typeof q === 'string' ? q.length : q.text.length;
  for (const d of r.diagrams ?? []) n += d.source.length + d.title.length;
  for (const c of r.code ?? []) n += c.code.length;
  return n;
}

// Keeps memory within MEMORY_BUDGET and MEMORY_MAX_CHATS, least recently
// used first (see MEMORY_BUDGET). `keep`: the chat just used.
function evict(keep: string) {
  const held = (key: string, c: Chat) => key === keep || c.listeners.size > 0 || !!c.request;
  let total = 0;
  for (const c of memory.values()) total += c.size;
  for (const [key, c] of memory) {
    if (total <= MEMORY_BUDGET) break;
    if (held(key, c) || (!c.diagrams && !c.code)) continue;
    c.diagrams = null;
    c.code = null;
    c.fetchedAt = null; // so they are read again
    const size = measure(c);
    total -= c.size - size;
    c.size = size;
  }
  for (const [key, c] of memory) {
    if (memory.size <= MEMORY_MAX_CHATS && total <= MEMORY_BUDGET) break;
    if (held(key, c)) continue;
    memory.delete(key);
    total -= c.size;
  }
}

// After what the chat holds changed.
function resize(r: Chat) {
  r.size = measure(r);
  evict(r.id);
}

function notify(r: Chat) {
  for (const listener of r.listeners) safe('conversation listener', () => listener(r));
}

const sameQuestions = (a: readonly ApiQuestion[], b: readonly ApiQuestion[]) =>
  a.length === b.length && a.every((q, i) => q.text === b[i].text && q.pos === b[i].pos);

const sameDiagrams = (a: readonly Diagram[], b: readonly Diagram[]) =>
  a.length === b.length &&
  a.every(
    (d, i) => d.kind === b[i].kind && d.title === b[i].title && d.question === b[i].question && d.source === b[i].source
  );

const sameCode = (a: readonly CodeBlock[], b: readonly CodeBlock[]) =>
  a.length === b.length &&
  a.every((c, i) => c.language === b[i].language && c.question === b[i].question && c.code === b[i].code);

// ----- chrome.storage --------------------------------------------------------

function readStored(r: Chat): Promise<void> {
  const key = CACHE_PREFIX + r.id;
  r.stored ??= storageGet({ [key]: null }).then((values) => {
    const v = values[key] as Stored | null | undefined;
    // Something newer may have come meanwhile.
    if (r.questions || !v || !Array.isArray(v.items)) return;
    const texts = v.items as unknown[];
    if (!texts.every((t): t is string => typeof t === 'string')) return;
    const pos = Array.isArray(v.pos) ? (v.pos as unknown[]) : null;
    if (v.api === true && pos && pos.length === texts.length && pos.every((p) => Number.isInteger(p))) {
      r.questions = { fromApi: true, items: texts.map((text, i) => ({ text, pos: pos[i] as number })) };
    } else {
      r.questions = { fromApi: false, items: texts, complete: !!v.complete };
    }
    r.source = 'storage';
    resize(r);
    // For a reader that stopped waiting for it.
    notify(r);
  });
  return r.stored;
}

let writes = 0;

// Written once per page load even if unchanged, which marks the chat as
// recently opened (pruneCache keeps the most recent).
function writeStored(r: Chat) {
  const q = r.questions;
  if (!q) return;
  const record = (max: number) =>
    q.fromApi
      ? {
          items: q.items.map((x) => x.text.slice(0, max)),
          pos: q.items.map((x) => x.pos),
          api: true,
          complete: true,
        }
      : { items: q.items.map((t) => t.slice(0, max)), complete: q.complete };
  let value = record(STORED_TEXT_MAX);
  let json = JSON.stringify(value);
  if (json.length > STORED_CHAT_MAX) {
    value = record(STORED_TEXT_SHORT);
    json = JSON.stringify(value);
  }
  if (json === r.storedJson) return;
  r.storedJson = json;
  storageSet({ [CACHE_PREFIX + r.id]: { t: Date.now(), ...value } });
  if (++writes % PRUNE_EVERY_WRITES === 0) void pruneCache();
}

// ----- updates from claude.ai ------------------------------------------------

// False if the list is not believable: empty (a brand-new chat the API has
// not caught up with yet). Not kept, so it never hides the page's list.
function takeQuestions(r: Chat, items: ApiQuestion[], source: Source): boolean {
  if (!items.length) return false;
  const old = r.questions;
  if (!old || !old.fromApi || !sameQuestions(old.items, items)) r.questions = { fromApi: true, items };
  r.source = source;
  r.questionsAt = performance.now();
  resize(r);
  writeStored(r);
  return true;
}

/** Takes in every conversation claude.ai loads. Started once, for the life of the page. */
export function watchClaude(): () => void {
  // Starting, the page relays the last conversation it loaded again, at
  // once. Coming back from the back/forward cache, this store has kept what
  // came later: that copy is older, and not taken.
  let replay = true;
  const stop = watchConversations(({ convId, questions }) => {
    const r = chat(convId);
    if (replay && r.questionsAt != null) return;
    if (takeQuestions(r, questions, 'claude.ai response')) notify(r);
  });
  replay = false;
  return stop;
}

// ----- reading ---------------------------------------------------------------

/** What is known about the conversation, from memory or else chrome.storage. */
export async function open(convId: string): Promise<Conversation> {
  const r = chat(convId);
  if (!r.questions) await readStored(r);
  return r;
}

/** What is in memory right now. */
export function peek(convId: string): Conversation {
  return chat(convId);
}

/** Calls the listener on every change to the conversation. */
export function subscribe(convId: string, listener: Listener): () => void {
  const r = chat(convId);
  r.listeners.add(listener);
  return () => void r.listeners.delete(listener);
}

/**
 * Asks claude.ai's API for the conversation, unless our last answer is
 * younger than maxAge ms. Joins a request already under way. Listeners hear
 * about the answer before this resolves: true if it had believable
 * questions, false if the API is unavailable.
 */
export function refresh(convId: string, maxAge = 0): Promise<boolean> {
  const r = chat(convId);
  if (r.request) return r.request;
  if (r.fetchedAt != null && performance.now() - r.fetchedAt < maxAge) return Promise.resolve(true);
  r.request = fetchConversationParts(convId)
    .catch(() => null)
    .then((parts) => {
      r.request = null;
      if (!parts) return false;
      r.fetchedAt = performance.now();
      const believable = takeQuestions(r, parts.questions, 'api');
      if (!r.diagrams || !sameDiagrams(r.diagrams, parts.diagrams)) r.diagrams = parts.diagrams;
      if (!r.code || !sameCode(r.code, parts.code)) r.code = parts.code;
      resize(r);
      notify(r);
      return believable;
    });
  return r.request;
}

/**
 * Checks a list shown from the cache: asks the API only if claude.ai has
 * not sent the conversation by itself by then, and only while someone
 * still listens (the chat may have been left meanwhile).
 */
export function revalidate(convId: string): void {
  const r = chat(convId);
  const since = performance.now() - REVALIDATE_AFTER_MS;
  clearTimeout(r.revalidateTimer);
  r.revalidateTimer = setTimeout(() => {
    r.revalidateTimer = undefined;
    if (r.listeners.size && !(r.questionsAt != null && r.questionsAt >= since)) void refresh(r.id);
  }, REVALIDATE_AFTER_MS);
}

/** A list built from the page (the API unavailable), kept for the next visit. Never replaces claude.ai's. */
export function savePageList(convId: string, texts: readonly string[], complete: boolean): void {
  const r = chat(convId);
  void readStored(r).then(() => {
    if (r.questions?.fromApi) return;
    r.questions = { fromApi: false, items: texts, complete };
    r.source = 'page';
    resize(r);
    writeStored(r);
  });
}
