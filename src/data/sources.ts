// The raw sources besides the DOM, with no policy of their own (the cache
// built on them is store.ts):
//  - claude.ai's own conversation API (same origin, your existing session),
//    which knows every message, including ones the page has not rendered;
//  - chrome.storage.local, for what is kept between visits.
// Nothing here talks to any server other than claude.ai itself.
import { parseCode, parseConversation, parseDiagrams } from './conversation';
import type { ApiQuestion, CodeBlock, Diagram } from '../core/types';
import { warnOnce } from '../core/util';

/** Key prefix of each conversation's stored questions (see store.ts). */
export const CACHE_PREFIX = 'outline-cache:';
const CACHE_MAX_CHATS = 200;
const CACHE_MAX_AGE_MS = 90 * 24 * 3600 * 1000;
const API_TIMEOUT_MS = 10000;

export function conversationId(pathname: string): string | null {
  const m = /\/chat\/([\w-]{8,})\/?$/.exec(pathname || '');
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// chrome.storage.local, promisified and never throwing (the extension can
// be reloaded under a live tab, which invalidates chrome.* APIs).
// ---------------------------------------------------------------------------

type StorageValues = Record<string, unknown>;

export function storageGet(keys: string | StorageValues | null): Promise<StorageValues> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (values) => {
        if (chrome.runtime && chrome.runtime.lastError) return resolve({});
        resolve(values || {});
      });
    } catch (err) {
      warnOnce('storage get', err);
      resolve({});
    }
  });
}

export function storageSet(values: StorageValues): void {
  try {
    chrome.storage.local.set(values);
  } catch (err) {
    warnOnce('storage set', err);
  }
}

function storageRemove(keys: string[]): void {
  try {
    if (keys.length) chrome.storage.local.remove(keys);
  } catch (err) {
    warnOnce('storage remove', err);
  }
}

// ---------------------------------------------------------------------------
// Starred questions, per conversation. Keyed by the question's matching key
// (see keyOf in outline.ts), so a star survives reloads and edits elsewhere
// in the chat. Not pruned: a few short strings per starred chat.
// ---------------------------------------------------------------------------

const STARS_PREFIX = 'outline-stars:';

export async function loadStars(convId: string): Promise<string[]> {
  const key = STARS_PREFIX + convId;
  const value = (await storageGet({ [key]: null }))[key];
  return Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : [];
}

export function saveStars(convId: string, keys: readonly string[]): void {
  const key = STARS_PREFIX + convId;
  if (keys.length) storageSet({ [key]: [...keys] });
  else storageRemove([key]);
}

// ---------------------------------------------------------------------------
// Where you were in each chat: the matching key of the question you were
// reading when you left (see resume.ts). Pruned with the cache.
// ---------------------------------------------------------------------------

const PLACE_PREFIX = 'outline-place:';

interface StoredPlace {
  t?: number;
  key?: unknown;
}

export async function loadPlace(convId: string): Promise<string | null> {
  const key = PLACE_PREFIX + convId;
  const place = (await storageGet({ [key]: null }))[key] as StoredPlace | null | undefined;
  return place && typeof place.key === 'string' && place.key ? place.key : null;
}

export function savePlace(convId: string, questionKey: string): void {
  storageSet({ [PLACE_PREFIX + convId]: { t: Date.now(), key: questionKey } });
}

// Keeps the cache and the places bounded: the most recent chats, none
// older than 90 days.
export async function pruneCache(): Promise<void> {
  const all = await storageGet(null);
  const now = Date.now();
  for (const prefix of [CACHE_PREFIX, PLACE_PREFIX]) {
    const records = Object.keys(all)
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ k, t: (all[k] as { t?: number } | null)?.t || 0 }))
      .toSorted((a, b) => b.t - a.t);
    storageRemove(records.filter((r, i) => i >= CACHE_MAX_CHATS || now - r.t > CACHE_MAX_AGE_MS).map((r) => r.k));
  }
}

// ---------------------------------------------------------------------------
// claude.ai API (shape: see conversation.ts)
// ---------------------------------------------------------------------------

function readCookie(name: string): string | null {
  try {
    const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(document.cookie);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('?')[0]}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let orgCache: string[] | null = null;
async function organizations(): Promise<string[]> {
  if (orgCache) return orgCache;
  const ids: string[] = [];
  const fromCookie = readCookie('lastActiveOrg');
  if (fromCookie) ids.push(fromCookie);
  try {
    const orgs = await getJson('/api/organizations');
    if (Array.isArray(orgs)) {
      for (const o of orgs as { uuid?: string }[]) if (o && o.uuid && !ids.includes(o.uuid)) ids.push(o.uuid);
    }
  } catch (err) {
    if (!ids.length) throw err;
  }
  orgCache = ids;
  return ids;
}

async function fetchConversation<T>(convId: string, parse: (data: unknown) => T | null): Promise<T | null> {
  let lastErr: unknown = null;
  for (const org of await organizations()) {
    try {
      const data = await getJson(
        `/api/organizations/${encodeURIComponent(org)}/chat_conversations/${encodeURIComponent(convId)}` +
          '?tree=True&rendering_mode=messages&render_all_tools=true'
      );
      const parsed = parse(data);
      if (parsed) return parsed;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

export interface ConversationParts {
  questions: ApiQuestion[];
  diagrams: Diagram[];
  code: CodeBlock[];
}

/** Your questions, Claude's diagrams and its code, read from one response, or null if the API is unavailable. */
export async function fetchConversationParts(convId: string): Promise<ConversationParts | null> {
  try {
    return await fetchConversation(convId, (data) => {
      const questions = parseConversation(data);
      const diagrams = parseDiagrams(data);
      const code = parseCode(data);
      return questions && diagrams && code ? { questions, diagrams, code } : null;
    });
  } catch (err) {
    warnOnce('conversation API unavailable, using the page only', err);
    return null;
  }
}
