// The outline panel: a Shadow DOM UI with rendering, collapse/resize,
// theming, keyboard handling and persisted settings. It knows nothing about
// Claude's DOM except for the theme hints on <html> and the optional "push"
// padding on <body>.
import * as S from './selectors';
import type { LoadReason, LoadState, RenderResult, Status, View } from './types';

export const HOST_ID = 'claude-outline-host';
const WIDTH_MIN = 200;
const WIDTH_MAX = 520;
const NOTICE_MS = 4000;
const RIGHT_GAP = 8; // panel distance from the right edge (matches panel.css)

type Layout = 'overlay' | 'push';
interface Settings {
  collapsed: boolean;
  width: number;
  layout: Layout;
}
const DEFAULTS: Readonly<Settings> = Object.freeze({ collapsed: false, width: 300, layout: 'overlay' });

// Shown while the list may be missing questions.
const HINT_LOAD_EARLIER = 'Earlier messages are not loaded. Press ↑ to list every question.';
const HINT_SCROLL = 'Scroll through the chat once, or press ↑, to list every question.';

const STATUS_TEXT: Record<Exclude<Status, 'ok'>, string> = {
  'no-feed': 'Waiting for messages…',
  empty: 'No questions yet.',
  'selectors-broken':
    "Couldn't find your messages — selectors may be outdated. Run __claudeOutline.debug() in the console for details.",
};

const LOAD_RESULT_TEXT: Record<LoadReason, string> = {
  done: 'All questions loaded.',
  cancelled: 'Stopped loading.',
  limit: 'Stopped after 50 loads (safety limit). Click again to continue.',
  timeout: 'Stopped after 30 seconds (safety limit). Click again to continue.',
  stalled: 'Claude stopped loading earlier messages. Try again.',
  error: 'Loading failed.',
};

const ICONS = {
  collapse: 'M9 6l6 6-6 6',
  expand: 'M15 6l-6 6 6 6',
  loadAll: 'M12 20V8M7 13l5-5 5 5M5 4h14',
  push: 'M4 5h16v14H4zM14 5v14',
} as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Built with createElement rather than innerHTML so a Trusted Types policy
// on the page can never break the panel.
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') el.textContent = value;
    else if (key === 'className') el.className = value;
    else el.setAttribute(key, value);
  }
  for (const child of children) el.append(child);
  return el;
}

function icon(path: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

const clampWidth = (w: unknown) => Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(Number(w) || DEFAULTS.width)));

// Stored values come from an older version or a hand edit just as well, so
// each one is checked rather than trusted.
function parseSettings(raw: Record<string, unknown>): Settings {
  return {
    collapsed: !!raw.collapsed,
    width: clampWidth(raw.width),
    layout: raw.layout === 'push' ? 'push' : 'overlay',
  };
}

// chrome.* throws "Extension context invalidated" in an orphaned content
// script after the extension is reloaded, so every call is guarded.
function storageGet(): Promise<Settings> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ ...DEFAULTS }, (values) =>
        resolve(chrome.runtime.lastError ? { ...DEFAULTS } : parseSettings(values))
      );
    } catch {
      resolve({ ...DEFAULTS });
    }
  });
}

function storageSet(patch: Partial<Settings>): void {
  try {
    chrome.storage.local.set(patch);
  } catch {
    // Settings just won't persist; the panel keeps working.
  }
}

// The CSS is read from the extension package (a local read, not a network
// request) and adopted as a constructed stylesheet, which page CSP cannot block.
async function loadStyles(shadow: ShadowRoot): Promise<void> {
  const url = chrome.runtime.getURL('panel.css');
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(await (await fetch(url)).text());
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    shadow.prepend(h('link', { rel: 'stylesheet', href: url }));
  }
}

// Parses "rgb(r, g, b)" / "rgba(r, g, b, a)"; null if transparent.
function backgroundLuminance(el: Element): number | null {
  const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
  if (!m || (m.length === 4 && Number(m[3]) === 0)) return null;
  const [r, g, b] = m.map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

type Theme = 'dark' | 'light';
const isTheme = (v: string | null): v is Theme => v === 'dark' || v === 'light';

// Claude marks dark mode on <html>. Absence of the `dark` class alone is
// not proof of light mode, and the OS preference can disagree with Claude's
// own theme setting, so before falling back to prefers-color-scheme we look
// at what the page actually paints.
function detectTheme(): Theme {
  const html = document.documentElement;
  if (html.classList.contains('dark')) return 'dark';
  if (html.classList.contains('light')) return 'light';
  const mode = html.getAttribute('data-mode') || html.getAttribute('data-theme');
  if (isTheme(mode)) return mode;
  const scheme = getComputedStyle(html).colorScheme;
  if (isTheme(scheme)) return scheme;
  const lum = backgroundLuminance(document.body) ?? backgroundLuminance(html);
  if (lum !== null) return lum < 0.5 ? 'dark' : 'light';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface PanelCallbacks {
  onSelect(index: number): void;
  onLoadAll(): void;
  onCancelLoad(): void;
}

export interface Panel extends View {
  host: HTMLElement;
  shadow: ShadowRoot;
  setVisible(visible: boolean): void;
  /** Clear per-conversation state on route change. */
  reset(): void;
  destroy(): void;
}

export function createPanel({ onSelect, onLoadAll, onCancelLoad }: PanelCallbacks): Panel {
  const state = {
    ...DEFAULTS,
    ready: false, // styles + settings loaded
    visible: false, // on a conversation page
    status: 'no-feed' as Status,
    canLoadEarlier: false,
    incomplete: false,
    loading: null as { clicks: number; scan?: number } | null, // while "Load all" runs
    notice: '', // result of the last "Load all"
    active: -1,
    roving: 0, // the one list button with tabindex=0
    returnFocus: null as Element | null,
  };
  const cleanups: (() => void)[] = [];
  const listen = <E extends Event>(
    target: EventTarget,
    type: string,
    fn: (e: E) => void,
    opts?: boolean | AddEventListenerOptions
  ) => {
    const handler = fn as EventListener;
    target.addEventListener(type, handler, opts);
    cleanups.push(() => target.removeEventListener(type, handler, opts));
  };

  // Host: zero-size and fixed, so it never covers or intercepts anything.
  // Only the visible panel / tab inside it receive pointer events.
  const host = h('div', { id: HOST_ID });
  host.style.cssText =
    'all: initial; position: fixed; top: 0; right: 0; width: 0; height: 0; z-index: 2147483000; display: none;';
  const shadow = host.attachShadow({ mode: 'open' });

  const count = h('span', { className: 'count', 'aria-label': '0 questions' }, ['0']);
  const loadBtn = h(
    'button',
    {
      type: 'button',
      className: 'icon-btn',
      'aria-label': 'Load all questions',
      title: 'Load all questions (loads earlier messages and scans the whole chat)',
    },
    [icon(ICONS.loadAll)]
  );
  const pushBtn = h(
    'button',
    {
      type: 'button',
      className: 'icon-btn',
      'aria-label': 'Push chat content aside',
      'aria-pressed': 'false',
      title: 'Push chat content aside instead of overlaying it',
    },
    [icon(ICONS.push)]
  );
  const collapseBtn = h(
    'button',
    {
      type: 'button',
      className: 'icon-btn',
      'aria-label': 'Collapse outline',
      'aria-expanded': 'true',
      title: 'Collapse (Esc)',
    },
    [icon(ICONS.collapse)]
  );
  const statusText = h('span', { className: 'status-text' });
  const cancelBtn = h('button', { type: 'button', className: 'link-btn', hidden: '' }, ['Cancel']);
  const status = h('div', { className: 'status', role: 'status', 'aria-live': 'polite', hidden: '' }, [
    statusText,
    cancelBtn,
  ]);
  const list = h('ol', { className: 'list' });
  const resizer = h('div', {
    className: 'resizer',
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': 'Resize outline',
    tabindex: '0',
    'aria-valuemin': String(WIDTH_MIN),
    'aria-valuemax': String(WIDTH_MAX),
  });
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
  const tab = h(
    'button',
    {
      type: 'button',
      className: 'tab',
      'aria-label': 'Expand chat outline',
      'aria-expanded': 'false',
      title: 'Show outline (Cmd/Ctrl+Shift+O)',
    },
    [icon(ICONS.expand), h('span', { className: 'tab-label' }, ['Outline']), tabCount]
  );
  shadow.append(panel, tab);
  panel.style.setProperty('--co-top', `${S.layout.panelTop}px`);
  tab.style.setProperty('--co-top', `${S.layout.panelTop}px`);

  // ----- layout -----------------------------------------------------------

  let savedBodyPadding: string | null = null;
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

  function setCollapsed(collapsed: boolean, focusAfter: boolean) {
    state.collapsed = collapsed;
    storageSet({ collapsed });
    apply();
    if (!focusAfter) return;
    if (collapsed) {
      const back = state.returnFocus;
      state.returnFocus = null;
      if (back instanceof HTMLElement && back !== host && back.isConnected) back.focus();
      else tab.focus();
    } else {
      if (!focusItem(state.roving)) collapseBtn.focus();
    }
  }

  function setWidth(width: number, persist: boolean) {
    state.width = clampWidth(width);
    apply();
    if (persist) storageSet({ width: state.width });
  }

  // ----- rendering --------------------------------------------------------

  function buttons(): NodeListOf<HTMLButtonElement> {
    return list.querySelectorAll('button');
  }

  function focusItem(index: number): boolean {
    const all = buttons();
    if (!all.length) return false;
    const i = Math.min(all.length - 1, Math.max(0, index));
    setRoving(i);
    all[i].focus();
    return true;
  }

  function setRoving(index: number) {
    const all = buttons();
    if (all[state.roving]) all[state.roving].tabIndex = -1;
    state.roving = index;
    if (all[index]) all[index].tabIndex = 0;
  }

  function newItem(index: number): HTMLLIElement {
    const button = h('button', { type: 'button', 'data-index': String(index), tabindex: '-1' }, [
      h('span', { className: 'num', 'aria-hidden': 'true' }, [`${index + 1}.`]),
      h('span', { className: 'label' }),
    ]);
    return h('li', {}, [button]);
  }

  // Patch the list in place: only changed labels are touched, so nothing
  // flickers while Claude streams and the list is rebuilt every second.
  function renderItems(items: RenderResult['items']) {
    const lis = list.children;
    items.forEach((item, i) => {
      if (!lis[i]) list.append(newItem(i));
      const button = lis[i].firstElementChild as HTMLButtonElement;
      const label = button.lastElementChild!;
      if (label.textContent !== item.label) label.textContent = item.label;
      const title = item.full || item.label;
      if (button.title !== title) button.title = title;
    });
    while (lis.length > items.length) list.lastElementChild!.remove();
    const roving = Math.min(state.roving, Math.max(0, items.length - 1));
    state.roving = roving;
    buttons().forEach((b, i) => (b.tabIndex = i === roving ? 0 : -1));
  }

  function renderStatus() {
    let text = '';
    if (state.loading && state.loading.scan != null) text = `Scanning the chat… ${state.loading.scan}%`;
    else if (state.loading) text = `Loading earlier messages… (${state.loading.clicks})`;
    else if (state.status !== 'ok') text = STATUS_TEXT[state.status];
    else if (state.notice) text = state.notice;
    else if (state.incomplete) text = state.canLoadEarlier ? HINT_LOAD_EARLIER : HINT_SCROLL;
    status.hidden = !text;
    status.dataset.kind = !state.loading && state.status === 'selectors-broken' ? 'error' : '';
    status.classList.toggle('loading', !!state.loading);
    if (statusText.textContent !== text) statusText.textContent = text;
    cancelBtn.hidden = !state.loading;
    // Nothing to load once the list is complete (always so with the API).
    loadBtn.hidden = !state.loading && !state.incomplete;
    loadBtn.disabled = !!state.loading;
  }

  function render(result: RenderResult) {
    state.status = result.status;
    state.canLoadEarlier = result.canLoadEarlier;
    state.incomplete = result.incomplete;
    renderItems(result.items);
    const n = result.items.length;
    const more = state.incomplete ? '+' : '';
    count.textContent = tabCount.textContent = `${n}${more}`;
    count.setAttribute('aria-label', more ? `${n} questions listed, more not loaded yet` : `${n} questions`);
    renderStatus();
  }

  function setActive(index: number) {
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
  function keepInView(el: Element) {
    const box = list.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < box.top) list.scrollTop -= box.top - r.top;
    else if (r.bottom > box.bottom) list.scrollTop += r.bottom - box.bottom;
  }

  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  cleanups.push(() => clearTimeout(noticeTimer));
  function setLoadState(load: LoadState) {
    state.loading = load.running ? { clicks: load.clicks ?? 0, scan: load.scan } : null;
    clearTimeout(noticeTimer);
    if (!load.running) {
      const reason = load.reason ?? 'error';
      state.notice = LOAD_RESULT_TEXT[reason];
      // Success needs no action, so it goes away; the others say what to do.
      if (reason === 'done') {
        noticeTimer = setTimeout(() => {
          state.notice = '';
          renderStatus();
        }, NOTICE_MS);
      }
    }
    renderStatus();
  }

  // ----- events -----------------------------------------------------------

  listen<MouseEvent>(list, 'click', (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>('button[data-index]');
    if (!button) return;
    const index = Number(button.dataset.index);
    setRoving(index);
    button.blur();
    onSelect(index);
  });

  listen<KeyboardEvent>(list, 'keydown', (e) => {
    const all = Array.from(buttons());
    const index = all.indexOf(shadow.activeElement as HTMLButtonElement);
    const moves: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: all.length - 1 };
    const next = moves[e.key];
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
  listen<KeyboardEvent>(shadow, 'keydown', (e) => {
    if (e.key !== 'Escape' || state.collapsed) return;
    e.preventDefault();
    e.stopPropagation();
    setCollapsed(true, true);
  });

  // Capture phase on window so we see the shortcut before Claude's handlers.
  listen<KeyboardEvent>(
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
  listen<PointerEvent>(resizer, 'pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    resizer.setPointerCapture(e.pointerId);
    panel.classList.add('resizing');
  });
  listen<PointerEvent>(resizer, 'pointermove', (e) => {
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
  listen<KeyboardEvent>(resizer, 'keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? 16 : e.key === 'ArrowRight' ? -16 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    setWidth(state.width + step, true);
  });

  // ----- theme ------------------------------------------------------------

  const safeTheme = (): Theme => {
    try {
      return detectTheme();
    } catch {
      return 'light';
    }
  };
  const applyTheme = () => host.setAttribute('data-theme', safeTheme());
  // Re-check once shortly after a change: if Claude animates its
  // background, the first read can still see the old color.
  let themeTimer: ReturnType<typeof setTimeout> | undefined;
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
  listen(matchMedia('(prefers-color-scheme: dark)'), 'change', applyTheme);
  applyTheme();

  // ----- lifecycle --------------------------------------------------------

  document.body.append(host);
  Promise.all([loadStyles(shadow), storageGet()]).then(([, saved]) => {
    if (!host.isConnected) return;
    Object.assign(state, saved);
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
    reset() {
      clearTimeout(noticeTimer);
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
