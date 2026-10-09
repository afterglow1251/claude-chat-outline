// Stars for the Diagrams and Code views, as the questions have: a star on
// each row (shown on hover, orange once starred) and a "starred only"
// button in a slim bar on top. Saved per chat (see sources.ts), on this
// machine only.
import { h, icon } from '../core/dom';
import { loadStars, saveStars, type StarScope } from '../data/sources';

export const ICON_STAR = 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z';

export interface Stars {
  /** The bar with the "starred only" button, to be placed above the list. */
  readonly bar: HTMLElement;
  /** Only starred items are shown. */
  readonly only: boolean;
  has(key: string): boolean;
  /** The star button for a row; its key and label are set with `patch`. */
  button(): HTMLButtonElement;
  /** Shows the button's state for the item with this key. */
  patch(button: HTMLElement, key: string, label: string): void;
  toggle(key: string): void;
  /** Loads this chat's stars and turns the filter off. */
  setConversation(convId: string | null): void;
}

/** `onChange`: the stars or the filter changed; the list redraws what is shown. */
export function createStars(scope: StarScope, what: string, onChange: () => void): Stars {
  let convId: string | null = null;
  let keys = new Set<string>();
  let only = false;

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
  const bar = h('div', { className: 'star-bar' }, [filter]);

  function render() {
    filter.setAttribute('aria-pressed', String(only));
    filter.classList.toggle('has-stars', keys.size > 0);
    onChange();
  }

  filter.addEventListener('click', () => {
    only = !only;
    render();
  });

  return {
    bar,
    get only() {
      return only;
    },
    has: (key) => keys.has(key),
    button: () =>
      h('button', { type: 'button', className: 'star', tabindex: '-1', 'aria-pressed': 'false' }, [icon(ICON_STAR)]),
    patch(button, key, label) {
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
    setConversation(id) {
      convId = id;
      keys = new Set();
      only = false;
      render();
      if (!id) return;
      void loadStars(id, scope).then((loaded) => {
        if (convId !== id) return;
        keys = new Set(loaded);
        render();
      });
    },
  };
}
