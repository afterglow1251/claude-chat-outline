// Where questions come from besides the DOM:
//  - claude.ai's own conversation API (same origin, your existing session),
//    which knows every message, including ones the page has not rendered;
//  - a per-conversation cache in chrome.storage.local, so a chat you have
//    seen before is listed in full the moment you open it again.
// Nothing here talks to any server other than claude.ai itself.
import { parseConversation } from './conversation';
import type { ApiQuestion } from '../core/types';
import { warnOnce } from '../core/util';

const CACHE_PREFIX = 'outline-cache:';
const CACHE_MAX_CHATS = 200;
const CACHE_MAX_AGE_MS = 90 * 24 * 3600 * 1000;
const CACHE_FULL_MAX = 400; // characters kept per question (tooltip text)
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

function storageGet(keys: string | StorageValues | null): Promise<StorageValues> {
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

function storageSet(values: StorageValues): void {
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
// Cache
// ---------------------------------------------------------------------------

export interface CacheRecord {
  items: string[];
  complete: boolean;
}

interface StoredRecord {
  t?: number;
  items?: unknown;
  complete?: unknown;
}

export interface Cache {
  load(): Promise<CacheRecord | null>;
  save(fulls: string[], complete: boolean): void;
}

export function createCache(convId: string): Cache {
  const key = CACHE_PREFIX + convId;
  let lastJson = '';
  return {
    async load() {
      const record = (await storageGet({ [key]: null }))[key] as StoredRecord | null | undefined;
      if (!record || !Array.isArray(record.items)) return null;
      const items = record.items.filter((t): t is string => typeof t === 'string');
      lastJson = JSON.stringify({ items, complete: !!record.complete });
      return { items, complete: !!record.complete };
    },
    save(fulls, complete) {
      const items = fulls.map((t) => t.slice(0, CACHE_FULL_MAX));
      const json = JSON.stringify({ items, complete: !!complete });
      if (json === lastJson) return;
      lastJson = json;
      storageSet({ [key]: { t: Date.now(), items, complete: !!complete } });
    },
  };
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
      .map((k) => ({ k, t: (all[k] as StoredRecord | null)?.t || 0 }))
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

/** Each question in order, or null if the API is unavailable. */
export async function fetchQuestions(convId: string): Promise<ApiQuestion[] | null> {
  let lastErr: unknown = null;
  for (const org of await organizations()) {
    try {
      const data = await getJson(
        `/api/organizations/${encodeURIComponent(org)}/chat_conversations/${encodeURIComponent(convId)}` +
          '?tree=True&rendering_mode=messages&render_all_tools=true'
      );
      const questions = parseConversation(data);
      if (questions) return questions;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) warnOnce('conversation API unavailable, using the page only', lastErr);
  return null;
}
