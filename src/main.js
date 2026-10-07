// Entry point: wires the outline core to the panel and handles the page
// lifecycle (SPA route changes, bfcache, teardown).
(() => {
  'use strict';

  const core = globalThis.ClaudeOutline;
  const Panel = globalThis.ClaudeOutlinePanel;
  if (!core || !Panel) return;

  // Idempotent injection: if a host already exists (script injected twice),
  // the first instance owns the page.
  if (document.getElementById(Panel.HOST_ID)) return;

  const Sources = globalThis.ClaudeOutlineSources;

  let panel = null;
  let session = null;
  let routes = null;
  let sessionKey = null; // which conversation the session belongs to

  function boot() {
    panel = Panel.create({
      onSelect: (index) => session && session.scrollTo(index),
      onLoadAll: () => session && session.loadAll(),
      onCancelLoad: () => session && session.cancelLoad(),
    });
    routes = core.watchLocation(onRouteChange);
    document.addEventListener(core.DEBUG_EVENT, core.debugReport);
    onRouteChange();
  }

  // Full reset when the conversation changes: the old conversation's nodes,
  // observers and in-flight "load all" must not leak into the next one.
  // A URL change that keeps the same conversation (query string, hash,
  // replaceState) keeps the session and everything it knows.
  function onRouteChange() {
    const isChat = core.isConversationPath(location.pathname);
    const key = isChat ? (Sources && Sources.conversationId(location.pathname)) || location.pathname : null;
    if (session && key === sessionKey) return;
    if (session) session.stop();
    session = null;
    sessionKey = key;
    panel.reset();
    panel.setVisible(isChat);
    if (!isChat) return;
    session = core.createSession(panel, Sources ? Sources.conversationId(location.pathname) : null);
    session.start();
  }

  function teardown() {
    if (session) session.stop();
    if (routes) routes.stop();
    if (panel) panel.destroy();
    document.removeEventListener(core.DEBUG_EVENT, core.debugReport);
    session = routes = panel = sessionKey = null;
  }

  // pagehide (rather than beforeunload) fires for every unload and does not
  // disable the back/forward cache. If the page comes back from that cache,
  // start again from scratch.
  window.addEventListener('pagehide', teardown);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && !panel) boot();
  });

  boot();
  if (Sources) Sources.pruneCache();
})();
