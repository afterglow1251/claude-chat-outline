// Entry point of the content script: wires the outline core to the panel
// and handles the page lifecycle (SPA route changes, bfcache, teardown).
import { DEBUG_EVENT } from './core/events';
import { isConversationPath } from './outline/extract';
import { createSession, debugReport, renderedTurns, watchLocation, type Session } from './outline/outline';
import { createPanel, HOST_ID, type Panel } from './ui/panel';
import { conversationId, pruneCache } from './data/sources';

let panel: Panel | null = null;
let session: Session | null = null;
let routes: { stop(): void } | null = null;
let sessionKey: string | null = null; // which conversation the session belongs to

function boot() {
  panel = createPanel({
    onSelect: (index) => session?.scrollTo(index),
    onLoadAll: () => session?.loadAll(),
    onCancelLoad: () => session?.cancelLoad(),
  });
  routes = watchLocation(onRouteChange);
  document.addEventListener(DEBUG_EVENT, debugReport);
  onRouteChange();
}

// Full reset when the conversation changes: the old conversation's nodes,
// observers and in-flight "load all" must not leak into the next one.
// A URL change that keeps the same conversation (query string, hash,
// replaceState) keeps the session and everything it knows.
function onRouteChange() {
  if (!panel) return;
  const isChat = isConversationPath(location.pathname);
  const convId = isChat ? conversationId(location.pathname) : null;
  const key = isChat ? convId || location.pathname : null;
  if (session && key === sessionKey) return;
  // Leaving a chat: what is rendered now belongs to it, not to the next one.
  const leftover = session ? renderedTurns() : undefined;
  session?.stop();
  session = null;
  sessionKey = key;
  panel.reset();
  panel.setConversation(convId);
  panel.setVisible(isChat);
  if (!isChat) return;
  session = createSession(panel, convId, leftover);
  session.start();
}

function teardown() {
  session?.stop();
  routes?.stop();
  panel?.destroy();
  document.removeEventListener(DEBUG_EVENT, debugReport);
  session = routes = panel = null;
  sessionKey = null;
}

// Idempotent injection: if a host already exists (script injected twice),
// the first instance owns the page.
if (!document.getElementById(HOST_ID)) {
  // pagehide (rather than beforeunload) fires for every unload and does not
  // disable the back/forward cache. If the page comes back from that cache,
  // start again from scratch.
  window.addEventListener('pagehide', teardown);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && !panel) boot();
  });
  boot();
  pruneCache();
}
