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

  let panel = null;
  let session = null;
  let routes = null;

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

  // Full reset on every navigation: the old conversation's nodes, observers
  // and in-flight "load all" must not leak into the next one.
  function onRouteChange() {
    if (session) session.stop();
    session = null;
    panel.reset();
    const isChat = core.isConversationPath(location.pathname);
    panel.setVisible(isChat);
    if (!isChat) return;
    session = core.createSession(panel);
    session.start();
  }

  function teardown() {
    if (session) session.stop();
    if (routes) routes.stop();
    if (panel) panel.destroy();
    document.removeEventListener(core.DEBUG_EVENT, core.debugReport);
    session = routes = panel = null;
  }

  // pagehide (rather than beforeunload) fires for every unload and does not
  // disable the back/forward cache. If the page comes back from that cache,
  // start again from scratch.
  window.addEventListener('pagehide', teardown);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && !panel) boot();
  });

  boot();
})();
