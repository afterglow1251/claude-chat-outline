// The outline panel: a Shadow DOM UI with rendering, collapse/resize,
// theming, keyboard handling and persisted settings. It knows nothing about
// Claude's DOM except for the theme hints on <html> and the optional "push"
// padding on <body>.
(() => {
  'use strict';

  const S = globalThis.ClaudeOutlineSelectors;
  const HOST_ID = 'claude-outline-host';
  const WIDTH_MIN = 200;
  const WIDTH_MAX = 520;
  const RIGHT_GAP = 8; // panel distance from the right edge (matches panel.css)
  const STORAGE_DEFAULTS = Object.freeze({ collapsed: false, width: 300, layout: 'overlay' });

  // Shown while the list may be missing questions.
  const HINT_LOAD_EARLIER = 'Earlier messages are not loaded. Press ↑ to list every question.';
  const HINT_SCROLL = 'Scroll through the chat once, or press ↑, to list every question.';

  const STATUS_TEXT = {
    'no-feed': 'Waiting for messages…',
    empty: 'No questions yet.',
    'selectors-broken':
      "Couldn't find your messages — selectors may be outdated. Run __claudeOutline.debug() in the console for details.",
  };

  const LOAD_RESULT_TEXT = {
    done: () => 'All questions loaded.',
    cancelled: () => 'Stopped loading.',
    limit: () => 'Stopped after 50 loads (safety limit). Click again to continue.',
    timeout: () => 'Stopped after 30 seconds (safety limit). Click again to continue.',
    stalled: () => 'Claude stopped loading earlier messages. Try again.',
    error: () => 'Loading failed.',
  };

  const ICONS = {
    collapse: 'M9 6l6 6-6 6',
    expand: 'M15 6l-6 6 6 6',
    loadAll: 'M12 20V8M7 13l5-5 5 5M5 4h14',
    push: 'M4 5h16v14H4zM14 5v14',
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  // Built with createElement rather than innerHTML so a Trusted Types policy
  // on the page can never break the panel.
  function h(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') el.textContent = value;
      else if (key === 'className') el.className = value;
      else el.setAttribute(key, value);
    }
    for (const child of children) el.append(child);
    return el;
  }

  function icon(path) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', path);
    svg.append(p);
    return svg;
  }

  const clampWidth = (w) => Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(Number(w) || STORAGE_DEFAULTS.width)));

  // chrome.* throws "Extension context invalidated" in an orphaned content
  // script after the extension is reloaded, so every call is guarded.
  function storageGet() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_DEFAULTS, (values) =>
          resolve(chrome.runtime.lastError ? { ...STORAGE_DEFAULTS } : values)
        );
      } catch (_) {
        resolve({ ...STORAGE_DEFAULTS });
      }
    });
  }

  function storageSet(patch) {
    try {
      chrome.storage.local.set(patch);
    } catch (_) {
      // Settings just won't persist; the panel keeps working.
    }
  }

  // The CSS is read from the extension package (a local read, not a network
  // request) and adopted as a constructed stylesheet, which page CSP cannot block.
  async function loadStyles(shadow) {
    const url = chrome.runtime.getURL('src/panel.css');
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(await (await fetch(url)).text());
      shadow.adoptedStyleSheets = [sheet];
    } catch (_) {
      shadow.prepend(h('link', { rel: 'stylesheet', href: url }));
    }
  }

  // Parses "rgb(r, g, b)" / "rgba(r, g, b, a)"; null if transparent.
  function backgroundLuminance(el) {
    const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
    if (!m || (m.length === 4 && Number(m[3]) === 0)) return null;
    const [r, g, b] = m.map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  // Claude marks dark mode on <html>. Absence of the `dark` class alone is
  // not proof of light mode, and the OS preference can disagree with Claude's
  // own theme setting, so before falling back to prefers-color-scheme we look
  // at what the page actually paints.
  function detectTheme() {
    const html = document.documentElement;
    if (html.classList.contains('dark')) return 'dark';
    if (html.classList.contains('light')) return 'light';
    const mode = html.getAttribute('data-mode') || html.getAttribute('data-theme');
    if (mode === 'dark' || mode === 'light') return mode;
    const scheme = getComputedStyle(html).colorScheme;
    if (scheme === 'dark' || scheme === 'light') return scheme;
    const lum = backgroundLuminance(document.body) ?? backgroundLuminance(html);
    if (lum !== null) return lum < 0.5 ? 'dark' : 'light';
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------

  function create({ onSelect, onLoadAll, onCancelLoad }) {
    const state = {
      ...STORAGE_DEFAULTS,
      ready: false, // styles + settings loaded
      visible: false, // on a conversation page
      count: '0',
      status: 'no-feed',
      canLoadEarlier: false,
      incomplete: false,
      loading: null, // { clicks, scan } while "Load all" runs
      notice: '', // result of the last "Load all"
      active: -1,
      roving: 0, // the one list button with tabindex=0
      returnFocus: null,
    };
    const cleanups = [];
    const listen = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => target.removeEventListener(type, fn, opts));
    };

    // Host: zero-size and fixed, so it never covers or intercepts anything.
    // Only the visible panel / tab inside it receive pointer events.
    const host = h('div', { id: HOST_ID });
    host.style.cssText =
      'all: initial; position: fixed; top: 0; right: 0; width: 0; height: 0; z-index: 2147483000; display: none;';
    const shadow = host.attachShadow({ mode: 'open' });

    const count = h('span', { className: 'count', 'aria-label': '0 questions' }, ['0']);
    const loadBtn = h('button', { type: 'button', className: 'icon-btn', 'aria-label': 'Load all questions', title: 'Load all questions (loads earlier messages and scans the whole chat)' }, [icon(ICONS.loadAll)]);
    const pushBtn = h('button', { type: 'button', className: 'icon-btn', 'aria-label': 'Push chat content aside', 'aria-pressed': 'false', title: 'Push chat content aside instead of overlaying it' }, [icon(ICONS.push)]);
    const collapseBtn = h('button', { type: 'button', className: 'icon-btn', 'aria-label': 'Collapse outline', 'aria-expanded': 'true', title: 'Collapse (Esc)' }, [icon(ICONS.collapse)]);
    const statusText = h('span', { className: 'status-text' });
    const cancelBtn = h('button', { type: 'button', className: 'link-btn', hidden: '' }, ['Cancel']);
    const status = h('div', { className: 'status', role: 'status', 'aria-live': 'polite', hidden: '' }, [statusText, cancelBtn]);
    const list = h('ol', { className: 'list' });
    const resizer = h('div', { className: 'resizer', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize outline', tabindex: '0', 'aria-valuemin': String(WIDTH_MIN), 'aria-valuemax': String(WIDTH_MAX) });
    const panel = h('div', { className: 'panel' }, [
      resizer,
      h('nav', { 'aria-label': 'Chat outline' }, [
        h('div', { className: 'header' }, [
          h('h2', { className: 'title' }, ['Questions ', count]),
          loadBtn,
          pushBtn,
          collapseBtn,
        ]),
        status,
        list,
      ]),
    ]);
    const tabCount = h('span', { className: 'tab-count' });
    const tab = h('button', { type: 'button', className: 'tab', 'aria-label': 'Expand chat outline', 'aria-expanded': 'false', title: 'Show outline (Cmd/Ctrl+Shift+O)' }, [icon(ICONS.expand), h('span', { className: 'tab-label' }, ['Outline']), tabCount]);
    shadow.append(panel, tab);
    panel.style.setProperty('--co-top', `${S.layout.panelTop}px`);
    tab.style.setProperty('--co-top', `${S.layout.panelTop}px`);

    // ----- layout -----------------------------------------------------------

    let savedBodyPadding = null;
    function applyPush() {
      const want = state.ready && state.visible && !state.collapsed && state.layout === 'push';
      if (want) {
        if (savedBodyPadding === null) savedBodyPadding = document.body.style.paddingRight;
        document.body.style.paddingRight = `${state.width + RIGHT_GAP * 2}px`;
      } else if (savedBodyPadding !== null) {
        document.body.style.paddingRight = savedBodyPadding;
        if (!document.body.getAttribute('style')) document.body.removeAttribute('style');
        savedBodyPadding = null;
      }
    }

    function apply() {
      host.style.display = state.ready && state.visible ? 'block' : 'none';
      panel.hidden = state.collapsed;
      tab.hidden = !state.collapsed;
      collapseBtn.setAttribute('aria-expanded', String(!state.collapsed));
      pushBtn.setAttribute('aria-pressed', String(state.layout === 'push'));
      panel.style.setProperty('--co-width', `${state.width}px`);
      resizer.setAttribute('aria-valuenow', String(state.width));
      applyPush();
    }

    function setCollapsed(collapsed, focusAfter) {
      state.collapsed = collapsed;
      storageSet({ collapsed });
      apply();
      if (!focusAfter) return;
      if (collapsed) {
        const back = state.returnFocus;
        state.returnFocus = null;
        if (back && back !== host && back.isConnected && back.focus) back.focus();
        else tab.focus();
      } else {
        focusItem(state.roving) || collapseBtn.focus();
      }
    }

    function setWidth(width, persist) {
      state.width = clampWidth(width);
      apply();
      if (persist) storageSet({ width: state.width });
    }

    // ----- rendering --------------------------------------------------------

    function buttons() {
      return list.querySelectorAll('button');
    }

    function focusItem(index) {
      const all = buttons();
      if (!all.length) return false;
      const i = Math.min(all.length - 1, Math.max(0, index));
      setRoving(i);
      all[i].focus();
      return true;
    }

    function setRoving(index) {
      const all = buttons();
      if (all[state.roving]) all[state.roving].tabIndex = -1;
      state.roving = index;
      if (all[index]) all[index].tabIndex = 0;
    }

    function newItem(index) {
      const button = h('button', { type: 'button', 'data-index': String(index), tabindex: '-1' }, [
        h('span', { className: 'num', 'aria-hidden': 'true' }, [`${index + 1}.`]),
        h('span', { className: 'label' }),
      ]);
      return h('li', {}, [button]);
    }

    // Patch the list in place: only changed labels are touched, so nothing
    // flickers while Claude streams and the list is rebuilt every second.
    function renderItems(items) {
      const lis = list.children;
      items.forEach((item, i) => {
        if (!lis[i]) list.append(newItem(i));
        const button = lis[i].firstChild;
        const label = button.lastChild;
        if (label.textContent !== item.label) label.textContent = item.label;
        const title = item.full || item.label;
        if (button.title !== title) button.title = title;
      });
      while (lis.length > items.length) list.lastChild.remove();
      const roving = Math.min(state.roving, Math.max(0, items.length - 1));
      state.roving = roving;
      Array.from(buttons()).forEach((b, i) => (b.tabIndex = i === roving ? 0 : -1));
    }

    function renderStatus() {
      let text = '';
      let kind = '';
      if (state.loading && state.loading.scan != null) text = `Scanning the chat… ${state.loading.scan}%`;
      else if (state.loading) text = `Loading earlier messages… (${state.loading.clicks})`;
      else if (state.status !== 'ok') text = STATUS_TEXT[state.status] || '';
      else if (state.notice) text = state.notice;
      else if (state.incomplete) text = state.canLoadEarlier ? HINT_LOAD_EARLIER : HINT_SCROLL;
      if (!state.loading && state.status === 'selectors-broken') kind = 'error';
      status.hidden = !text;
      status.dataset.kind = kind;
      status.classList.toggle('loading', !!state.loading);
      if (statusText.textContent !== text) statusText.textContent = text;
      cancelBtn.hidden = !state.loading;
      loadBtn.disabled = !!state.loading || !(state.canLoadEarlier || state.incomplete);
    }

    function render(result) {
      state.status = result.status;
      state.canLoadEarlier = !!result.canLoadEarlier;
      state.incomplete = !!result.incomplete;
      renderItems(result.items);
      const n = result.items.length;
      const more = state.incomplete ? '+' : '';
      count.textContent = tabCount.textContent = `${n}${more}`;
      count.setAttribute('aria-label', more ? `${n} questions listed, more not loaded yet` : `${n} questions`);
      renderStatus();
    }

    function setActive(index) {
      const all = buttons();
      const previous = all[state.active];
      if (previous) previous.removeAttribute('aria-current');
      state.active = index;
      const button = all[index];
      if (!button) return;
      button.setAttribute('aria-current', 'true');
      // Keep keyboard entry point on the current item unless the user is
      // already moving around inside the list.
      if (!list.contains(shadow.activeElement)) setRoving(index);
      keepInView(button);
    }

    // Same as scrollIntoView({block: "nearest"}) but limited to the list, so
    // it can never scroll Claude's page as a side effect.
    function keepInView(el) {
      const box = list.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.top < box.top) list.scrollTop -= box.top - r.top;
      else if (r.bottom > box.bottom) list.scrollTop += r.bottom - box.bottom;
    }

    function setLoadState({ running, clicks, scan, reason }) {
      state.loading = running ? { clicks, scan } : null;
      if (!running) state.notice = (LOAD_RESULT_TEXT[reason] || LOAD_RESULT_TEXT.error)(clicks);
      renderStatus();
    }

    // ----- events -----------------------------------------------------------

    listen(list, 'click', (e) => {
      const button = e.target.closest('button[data-index]');
      if (!button) return;
      const index = Number(button.dataset.index);
      setRoving(index);
      onSelect(index);
    });

    listen(list, 'keydown', (e) => {
      const index = Array.from(buttons()).indexOf(shadow.activeElement);
      const last = buttons().length - 1;
      const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: last }[e.key];
      if (next === undefined || index < 0) return;
      e.preventDefault();
      e.stopPropagation();
      focusItem(next);
    });

    listen(loadBtn, 'click', () => {
      state.notice = '';
      onLoadAll();
    });
    listen(cancelBtn, 'click', () => onCancelLoad());
    listen(pushBtn, 'click', () => {
      state.layout = state.layout === 'push' ? 'overlay' : 'push';
      storageSet({ layout: state.layout });
      apply();
    });
    listen(collapseBtn, 'click', () => setCollapsed(true, true));
    listen(tab, 'click', () => setCollapsed(false, false));

    // Esc inside the panel collapses it. Propagation is stopped so Claude's
    // own global Esc handling doesn't also fire.
    listen(shadow, 'keydown', (e) => {
      if (e.key !== 'Escape' || state.collapsed) return;
      e.preventDefault();
      e.stopPropagation();
      setCollapsed(true, true);
    });

    // Capture phase on window so we see the shortcut before Claude's handlers.
    listen(
      window,
      'keydown',
      (e) => {
        if (!state.visible || !state.ready) return;
        if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.code !== 'KeyO') return;
        e.preventDefault();
        e.stopPropagation();
        if (state.collapsed) {
          state.returnFocus = document.activeElement;
          setCollapsed(false, true);
        } else {
          setCollapsed(true, shadow.activeElement !== null);
        }
      },
      true
    );

    // Drag-to-resize from the left edge (pointer capture keeps the drag alive
    // when the pointer leaves the thin handle).
    let dragging = false;
    listen(resizer, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      resizer.setPointerCapture(e.pointerId);
      panel.classList.add('resizing');
    });
    listen(resizer, 'pointermove', (e) => {
      if (dragging) setWidth(window.innerWidth - RIGHT_GAP - e.clientX, false);
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('resizing');
      storageSet({ width: state.width });
    };
    listen(resizer, 'pointerup', endDrag);
    listen(resizer, 'pointercancel', endDrag);
    listen(resizer, 'keydown', (e) => {
      const step = { ArrowLeft: 16, ArrowRight: -16 }[e.key];
      if (!step) return;
      e.preventDefault();
      e.stopPropagation();
      setWidth(state.width + step, true);
    });

    // ----- theme ------------------------------------------------------------

    const applyTheme = () => host.setAttribute('data-theme', safeTheme());
    const safeTheme = () => {
      try {
        return detectTheme();
      } catch (_) {
        return 'light';
      }
    };
    // Re-check once shortly after a change: if Claude animates its
    // background, the first read can still see the old color.
    let themeTimer = 0;
    const themeObserver = new MutationObserver(() => {
      applyTheme();
      clearTimeout(themeTimer);
      themeTimer = setTimeout(applyTheme, 400);
    });
    cleanups.push(() => clearTimeout(themeTimer));
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-mode', 'data-theme'],
    });
    const media = matchMedia('(prefers-color-scheme: dark)');
    listen(media, 'change', applyTheme);
    applyTheme();

    // ----- lifecycle --------------------------------------------------------

    document.body.append(host);
    Promise.all([loadStyles(shadow), storageGet()]).then(([, saved]) => {
      if (!host.isConnected) return;
      state.collapsed = !!saved.collapsed;
      state.width = clampWidth(saved.width);
      state.layout = saved.layout === 'push' ? 'push' : 'overlay';
      state.ready = true;
      apply();
    });

    return {
      host,
      shadow,
      render,
      setActive,
      setLoadState,
      setVisible(visible) {
        state.visible = visible;
        apply();
      },
      // Clear per-conversation state on route change.
      reset() {
        state.loading = null;
        state.notice = '';
        state.active = -1;
        state.roving = 0;
        render({ status: 'no-feed', items: [], canLoadEarlier: false, incomplete: false });
      },
      destroy() {
        cleanups.forEach((fn) => fn());
        themeObserver.disconnect();
        state.visible = false;
        applyPush();
        host.remove();
      },
    };
  }

  globalThis.ClaudeOutlinePanel = Object.freeze({ HOST_ID, create });
})();
