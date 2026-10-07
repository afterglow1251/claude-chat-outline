// Where questions come from besides the DOM:
//  - claude.ai's own conversation API (same origin, your existing session),
//    which knows every message, including ones the page has not rendered;
//  - a per-conversation cache in chrome.storage.local, so a chat you have
//    seen before is listed in full the moment you open it again.
// Nothing here talks to any server other than claude.ai itself.
(() => {
  'use strict';

  const LOG = '[Claude Outline]';
  const CACHE_PREFIX = 'outline-cache:';
  const CACHE_MAX_CHATS = 200;
  const CACHE_MAX_AGE_MS = 90 * 24 * 3600 * 1000;
  const CACHE_FULL_MAX = 400; // characters kept per question (tooltip text)
  const API_TIMEOUT_MS = 10000;

  const warned = new Set();
  function warnOnce(key, err) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(LOG, key, err);
  }

  function conversationId(pathname) {
    const m = /\/chat\/([\w-]{8,})\/?$/.exec(pathname || '');
    return m ? m[1] : null;
  }

  // ---------------------------------------------------------------------------
  // chrome.storage.local, promisified and never throwing (the extension can
  // be reloaded under a live tab, which invalidates chrome.* APIs).
  // ---------------------------------------------------------------------------

  function storageGet(keys) {
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

  function storageSet(values) {
    try {
      chrome.storage.local.set(values);
    } catch (err) {
      warnOnce('storage set', err);
    }
  }

  function storageRemove(keys) {
    try {
      if (keys.length) chrome.storage.local.remove(keys);
    } catch (err) {
      warnOnce('storage remove', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Cache
  // ---------------------------------------------------------------------------

  function createCache(convId) {
    const key = CACHE_PREFIX + convId;
    let lastJson = '';
    return {
      // -> { items: [full], complete } or null
      async load() {
        const record = (await storageGet({ [key]: null }))[key];
        if (!record || !Array.isArray(record.items)) return null;
        const items = record.items.filter((t) => typeof t === 'string');
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

  // Keeps the cache bounded: the most recent chats, none older than 90 days.
  async function pruneCache() {
    const all = await storageGet(null);
    const now = Date.now();
    const records = Object.keys(all)
      .filter((k) => k.startsWith(CACHE_PREFIX))
      .map((k) => ({ k, t: (all[k] && all[k].t) || 0 }))
      .sort((a, b) => b.t - a.t);
    storageRemove(records.filter((r, i) => i >= CACHE_MAX_CHATS || now - r.t > CACHE_MAX_AGE_MS).map((r) => r.k));
  }

  // ---------------------------------------------------------------------------
  // claude.ai API
  // ---------------------------------------------------------------------------

  function readCookie(name) {
    try {
      const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(document.cookie);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (_) {
      return null;
    }
  }

  async function getJson(url) {
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

  let orgCache = null;
  async function organizations() {
    if (orgCache) return orgCache;
    const ids = [];
    const fromCookie = readCookie('lastActiveOrg');
    if (fromCookie) ids.push(fromCookie);
    try {
      const orgs = await getJson('/api/organizations');
      if (Array.isArray(orgs)) for (const o of orgs) if (o && o.uuid && !ids.includes(o.uuid)) ids.push(o.uuid);
    } catch (err) {
      if (!ids.length) throw err;
    }
    orgCache = ids;
    return ids;
  }

  function messageText(m) {
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
      if (text.trim()) return text;
    }
    return typeof m.text === 'string' ? m.text : '';
  }

  // The conversation is a tree (edits and retries create branches). The
  // visible branch is the path from the current leaf up to the root.
  function parseConversation(data) {
    const messages = data && data.chat_messages;
    if (!Array.isArray(messages)) return null;
    const byId = new Map(messages.filter((m) => m && m.uuid).map((m) => [m.uuid, m]));
    let branch = [];
    const leaf = data.current_leaf_message_uuid && byId.get(data.current_leaf_message_uuid);
    if (leaf) {
      const seen = new Set();
      for (let m = leaf; m && !seen.has(m.uuid); m = byId.get(m.parent_message_uuid)) {
        seen.add(m.uuid);
        branch.push(m);
      }
      branch.reverse();
    } else {
      branch = messages.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
    }
    return branch.filter((m) => m.sender === 'human').map(messageText);
  }

  // -> [full text of each question, in order], or null if unavailable.
  async function fetchQuestions(convId) {
    let lastErr = null;
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

  globalThis.ClaudeOutlineSources = Object.freeze({
    conversationId,
    createCache,
    pruneCache,
    fetchQuestions,
    parseConversation,
  });
})();
