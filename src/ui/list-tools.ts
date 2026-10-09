// The bar on top of the Diagrams and Code views, as the questions have: a
// filter field and a "starred only" button; and the stars on their rows
// (shown on hover, orange once starred), saved per chat (see sources.ts),
// on this machine only. Also the keys in those lists: ↑/↓ between rows
// (↑ from the first goes back to the filter) and S to star the row.
import { h, icon } from '../core/dom';
import { loadStars, saveStars, type StarScope } from '../data/sources';

export const ICON_STAR = 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z';
const ICON_SEARCH = 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM20 20l-3.6-3.6';

export interface ListTools {
  /** The filter field and the "starred only" button, to be placed above the list. */
  readonly bar: HTMLElement;
  /** Only starred items are shown. */
  readonly only: boolean;
  /** What the filter field holds, lowercased; '' for none. */
  readonly query: string;
  has(key: string): boolean;
  /** A star button for a row; its key and label are set with `patchStar`. */
  starButton(): HTMLButtonElement;
  patchStar(button: HTMLElement, key: string, label: string): void;
  toggle(key: string): void;
  /** How many items are shown of how many: "n / total" in the field while filtering. */
  setShown(shown: number, total: number): void;
  /** Loads this chat's stars, clears the filter and turns "starred only" off. */
  setConversation(convId: string | null): void;
  focusFilter(): void;
}

export interface ListToolsOptions {
  scope: StarScope;
  /** "diagrams", "code": for the labels. */
  what: string;
  /** The stars, the filter or "starred only" changed: show what matches. */
  onChange(): void;
  /** ↓ in the filter field: into the list. */
  onDown(): void;
}

export function createListTools({ scope, what, onChange, onDown }: ListToolsOptions): ListTools {
  let convId: string | null = null;
  let keys = new Set<string>();
  let only = false;
  let query = '';

  const input = h('input', {
    type: 'search',
    className: 'search-input',
    placeholder: `Filter ${what}…`,
    'aria-label': `Filter ${what}`,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const count = h('span', { className: 'search-count', 'aria-live': 'polite' });
  const filter = h(
    'button',
    {
      type: 'button',
      className: 'icon-btn star-filter',
      'aria-pressed': 'false',
      'aria-label': `Show starred ${what} only`,
      title: 'Starred only',
    },
    [icon(ICON_STAR)]
  );
  const bar = h('div', { className: 'search' }, [
    h('div', { className: 'search-box' }, [icon(ICON_SEARCH), input, count]),
    filter,
  ]);

  function render() {
    filter.setAttribute('aria-pressed', String(only));
    filter.classList.toggle('has-stars', keys.size > 0);
    onChange();
  }

  filter.addEventListener('click', () => {
    only = !only;
    render();
  });
  input.addEventListener('input', () => {
    query = input.value.trim().toLowerCase();
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      onDown();
    } else if (e.key === 'Escape' && input.value) {
      // Esc clears the filter.
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      input.dispatchEvent(new Event('input'));
    }
  });

  return {
    bar,
    get only() {
      return only;
    },
    get query() {
      return query;
    },
    has: (key) => keys.has(key),
    starButton: () =>
      h('button', { type: 'button', className: 'star', tabindex: '-1', 'aria-pressed': 'false' }, [icon(ICON_STAR)]),
    patchStar(button, key, label) {
      button.dataset.star = key;
      button.setAttribute('aria-pressed', String(keys.has(key)));
      button.setAttribute('aria-label', `Star ${label}`);
    },
    toggle(key) {
      if (keys.has(key)) keys.delete(key);
      else keys.add(key);
      if (convId) saveStars(convId, [...keys], scope);
      render();
    },
    setShown(shown, total) {
      count.textContent = query || only ? `${shown} / ${total}` : '';
    },
    setConversation(id) {
      convId = id;
      keys = new Set();
      only = false;
      query = '';
      input.value = '';
      render();
      if (!id) return;
      void loadStars(id, scope).then((loaded) => {
        if (convId !== id) return;
        keys = new Set(loaded);
        render();
      });
    },
    focusFilter: () => input.focus(),
  };
}

/**
 * Where a list opens: at the rows of the answer being read if it has any,
 * else at its end (the latest). At the end, it stays there while rows still
 * settle to their size (live previews), until you scroll it yourself. As
 * you read on, `follow` keeps the answer's rows in view.
 */
export function listScroll(scroller: HTMLElement, list: HTMLElement) {
  let stick = false;
  const toEnd = () => {
    scroller.scrollTop = scroller.scrollHeight;
  };
  for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const) {
    scroller.addEventListener(type, () => (stick = false), { passive: true });
  }
  const resize = new ResizeObserver(() => stick && toEnd());
  const current = () => list.querySelector<HTMLElement>(':scope > [aria-current="true"]:not([hidden])');
  resize.observe(list);
  return {
    reveal() {
      const row = current();
      stick = !row;
      if (!row) return toEnd();
      const box = scroller.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      scroller.scrollTop += r.top + r.height / 2 - (box.top + box.height / 2);
    },
    follow() {
      const row = current();
      if (!row) return;
      stick = false;
      // Just enough to have it in view, as the question list does.
      const box = scroller.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.top < box.top) scroller.scrollTop -= box.top - r.top;
      else if (r.bottom > box.bottom) scroller.scrollTop += Math.min(r.bottom - box.bottom, r.top - box.top);
    },
    stop: () => resize.disconnect(),
  };
}

/** Marks a row in the answer being read, as the question being read is marked. */
export function markCurrent(row: HTMLElement, on: boolean): void {
  if (on) row.setAttribute('aria-current', 'true');
  else row.removeAttribute('aria-current');
}

export interface ListKeys {
  /** Focuses the first row shown; false if there is none. */
  focusFirst(): boolean;
  /** Focuses this row (it was clicked), so the keys go on from it. */
  focusRow(row: HTMLElement): void;
}

/**
 * ↑/↓ between the rows shown, S to star the one with the focus. `focusable`:
 * the element in a row that takes the focus; `onStar`: star that row.
 */
export function listKeys(
  scroller: HTMLElement,
  { row, focusable, onStar, onTop }: { row: string; focusable: string; onStar(row: HTMLElement): void; onTop(): void }
): ListKeys {
  const shown = () =>
    [...scroller.querySelectorAll<HTMLElement>(focusable)].filter((el) => el.getClientRects().length > 0);
  const focused = () =>
    ((scroller.getRootNode() as ShadowRoot | Document).activeElement as Element | null)?.closest<HTMLElement>(row);

  scroller.addEventListener('keydown', (e) => {
    const current = focused();
    if (!current || !scroller.contains(current)) return;
    if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      onStar(current);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    // Moving with the keys: the focus ring is back.
    scroller.removeAttribute('data-picked');
    const all = shown();
    const i = all.findIndex((el) => current.contains(el));
    const far = e.metaKey || e.ctrlKey;
    const next = e.key === 'ArrowDown' ? (far ? all.length - 1 : i + 1) : far ? 0 : i - 1;
    if (next < 0) onTop();
    else all[Math.min(next, all.length - 1)]?.focus();
  });

  return {
    focusFirst() {
      scroller.removeAttribute('data-picked');
      const first = shown()[0];
      first?.focus();
      return !!first;
    },
    focusRow(r) {
      r.querySelector<HTMLElement>(focusable)?.focus({ preventScroll: true });
      // Clicked: the focus stays (for S and the arrows), its ring doesn't
      // show until the arrows move it, as in the question list.
      scroller.setAttribute('data-picked', '');
    },
  };
}
