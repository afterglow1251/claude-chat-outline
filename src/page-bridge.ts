// Runs in the PAGE's JavaScript world ("world": "MAIN" in manifest.json).
//
// Why this file exists: content scripts run in an isolated world with their
// own JS wrappers around DOM objects. Patching history.pushState there does
// NOT intercept claude.ai's router, and globals defined there are invisible
// in the DevTools console. So the two things that must live in the page's
// world are done here, and everything is relayed back via DOM events (which
// both worlds can see). No data from the page is read here.
import { DEBUG_EVENT, LOCATION_EVENT } from './events';

declare global {
  interface Window {
    __claudeOutlineBridge?: boolean;
    __claudeOutline?: { debug(): string };
  }
}

if (!window.__claudeOutlineBridge) {
  window.__claudeOutlineBridge = true;

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    if (typeof original !== 'function') continue;
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      try {
        window.dispatchEvent(new Event(LOCATION_EVENT));
      } catch {
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
}
