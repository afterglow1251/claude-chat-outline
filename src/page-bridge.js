// Runs in the PAGE's JavaScript world ("world": "MAIN" in manifest.json).
//
// Why this file exists: content scripts run in an isolated world with their
// own JS wrappers around DOM objects. Patching history.pushState there does
// NOT intercept claude.ai's router, and globals defined there are invisible
// in the DevTools console. So the two things that must live in the page's
// world are done here, and everything is relayed back via DOM events (which
// both worlds can see). No data from the page is read here.
(() => {
  'use strict';
  if (window.__claudeOutlineBridge) return;
  window.__claudeOutlineBridge = true;

  const LOCATION_EVENT = 'claude-outline:locationchange';
  const DEBUG_EVENT = 'claude-outline:debug';

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    if (typeof original !== 'function') continue;
    history[method] = function (...args) {
      const result = original.apply(this, args);
      try {
        window.dispatchEvent(new Event(LOCATION_EVENT));
      } catch (_) {
        // Never let our notification break the app's navigation.
      }
      return result;
    };
  }

  window.__claudeOutline = Object.freeze({
    debug() {
      document.dispatchEvent(new CustomEvent(DEBUG_EVENT));
      return 'Claude Outline: report logged above.';
    },
  });
})();
