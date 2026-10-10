// The list of questions inside the panel: filter field, the ☆ button (it
// opens the Starred overview), the list itself, and keyboard navigation.
// Every row is a button with data-index = the question's index in the
// session's list.
import { h, icon } from '../core/dom';
import type { ListItem } from '../core/types';
import { ICON_STAR } from './list-tools';
import type { StarSet } from './star-set';

/** A question's star survives reloads and edits elsewhere: kept by its matching key. */
export const questionStarKey = (item: ListItem, index: number) => item.key || `#${index}`;
// Switching chats goes from one list straight to the other, with no fade
// and no blank between: the previous chat's rows stay (inert) until this
// one's list arrives, at once when it is known already. Only if it takes
// longer than this are they cleared, so another chat's questions never
// linger.
const SWAP_WAIT_MS = 400;
const ROW_IN_MS = 220;

function fade(el: Element, from: number, to: number, duration: number, fill: FillMode = 'none'): Animation {
  return el.animate([{ opacity: from }, { opacity: to }], { duration, easing: 'ease-out', fill });
}

const UNREACHABLE_NOTE = "Claude hasn't loaded this message, so it can't be shown. What you asked:";
const PLACE_TEXT = 'Where you left off';

const ICON_SEARCH = 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM20 20l-3.6-3.6';

export interface QuestionList {
  /** Filter row + scrolling list, to be placed in the panel. */
  readonly element: HTMLElement;
  render(items: readonly ListItem[]): void;
  setActive(index: number): void;
  /**
   * Shows the question's full text under its row, with a note that Claude
   * has not loaded the message. Clicking the row again folds it.
   */
  expand(index: number): void;
  /** Another conversation: clears the filter. */
  setConversation(convId: string | null): void;
  /** Puts the "where you left off" bookmark on the question with this key, or takes it away. */
  markPlace(key: string | null): void;
  /** Focuses the keyboard entry point; false if the list is empty. */
  focus(): boolean;
  /**
   * Scrolls the list to centre the active question; for when the list
   * becomes visible again (it can't follow the chat while hidden).
   */
  revealActive(): void;
}

export interface QuestionListOptions {
  onSelect(index: number): void;
  /** The questions' stars, shared with the Starred overview. */
  stars: StarSet;
  /** The ☆ button: open the Starred overview. */
  onStarred(): void;
}

export function createQuestionList({ onSelect, stars, onStarred }: QuestionListOptions): QuestionList {
  let items: readonly ListItem[] = [];
  let query = '';
  let active = -1;
  let inView = -1; // the active item the list was last scrolled to
  let swapping = false; // the rows on screen are the previous chat's (see SWAP_WAIT_MS)
  let swapTimer: ReturnType<typeof setTimeout> | undefined;

  const input = h('input', {
    type: 'search',
    className: 'search-input',
    placeholder: 'Filter questions…',
    'aria-label': 'Filter questions',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const matchCount = h('span', { className: 'search-count', 'aria-live': 'polite' });
  const filterBtn = h(
    'button',
    {
      type: 'button',
      className: 'icon-btn star-filter',
      'aria-pressed': 'false',
      'aria-label': 'Show everything starred',
      title: 'Everything starred: questions, diagrams and code',
    },
    [icon(ICON_STAR)]
  );
  const searchRow = h('div', { className: 'search' }, [
    h('div', { className: 'search-box' }, [icon(ICON_SEARCH), input, matchCount]),
    filterBtn,
  ]);
  const list = h('ol', { className: 'list', 'aria-label': 'All questions' });
  const empty = h('p', { className: 'empty', hidden: '' }, ['No questions match.']);
  const scroller = h('div', { className: 'scroll' }, [list, empty]);
  const element = h('div', { className: 'questions' }, [searchRow, scroller]);

  // ----- what is shown ------------------------------------------------------

  const starKey = (index: number) => questionStarKey(items[index], index);
  const isStarred = (index: number) => stars.has(starKey(index));
  const matches = (index: number) => {
    if (!query) return true;
    const item = items[index];
    return (item.full || item.label).toLowerCase().includes(query);
  };
  const isShown = (index: number) => matches(index);

  function row(index: number): HTMLLIElement {
    const item = h('button', { type: 'button', className: 'item', 'data-index': String(index), tabindex: '-1' }, [
      h('span', { className: 'num', 'aria-hidden': 'true' }, [`${index + 1}.`]),
      h('span', { className: 'label' }),
    ]);
    const star = h(
      'button',
      {
        type: 'button',
        className: 'star',
        'data-star': String(index),
        tabindex: '-1',
        'aria-pressed': 'false',
        'aria-label': `Star question ${index + 1}`,
      },
      [icon(ICON_STAR)]
    );
    return h('li', {}, [item, star]);
  }

  // The full text of a question claude.ai cannot show, under its row.
  let expanded = -1;
  // The question you left off at last time (see place.ts), by key.
  let placeKey: string | null = null;
  function markPlace(key: string | null) {
    placeKey = key;
    renderAll();
  }

  // A small ribbon over the row's left edge; it drops in once when it is put there.
  function patchPlace(li: Element, index: number) {
    const here = !!placeKey && items[index].key === placeKey;
    const ribbon = li.querySelector('.place');
    const button = li.querySelector('.item')!;
    if (!here) {
      ribbon?.remove();
      button.removeAttribute('aria-description');
      return;
    }
    if (ribbon) return;
    li.append(
      h('span', { className: 'place', title: PLACE_TEXT, 'aria-hidden': 'true' }, [
        h('span', { className: 'place-ribbon' }),
      ])
    );
    button.setAttribute('aria-description', PLACE_TEXT);
  }

  function expand(index: number) {
    expanded = index;
    renderAll();
  }
  function collapse() {
    if (expanded === -1) return;
    expanded = -1;
    renderAll();
  }
  function patchDetail(li: Element, index: number) {
    let detail = li.querySelector('.detail');
    if (expanded !== index) {
      detail?.remove();
      return;
    }
    const text = items[index].full || items[index].label;
    if (!detail) {
      detail = h('div', { className: 'detail', role: 'note' }, [
        h('p', { className: 'detail-note' }, [UNREACHABLE_NOTE]),
        h('p', { className: 'detail-text' }),
      ]);
      li.append(detail);
    }
    const p = detail.querySelector('.detail-text')!;
    if (p.textContent !== text) p.textContent = text;
    li.setAttribute('data-expanded', '');
  }

  function patchRow(li: Element, index: number) {
    const item = items[index];
    const button = li.querySelector<HTMLButtonElement>('.item')!;
    const label = button.querySelector('.label')!;
    if (label.textContent !== item.label) label.textContent = item.label;
    const title = item.full || item.label;
    if (button.title !== title) button.title = title;
    li.querySelector('.star')!.setAttribute('aria-pressed', String(isStarred(index)));
    if (expanded !== index) li.removeAttribute('data-expanded');
    patchDetail(li, index);
    patchPlace(li, index);
  }

  // Patched in place: only what changed is touched, so nothing flickers
  // while Claude streams and the list is rebuilt every second.
  function renderList() {
    const lis = list.children;
    // Rows added to a list already on screen (a question you just sent)
    // fade in; a whole list arriving is just there.
    const growing = lis.length > 0;
    items.forEach((_, i) => {
      if (!lis[i]) {
        const li = row(i);
        list.append(li);
        if (growing) fade(li, 0, 1, ROW_IN_MS);
      }
      patchRow(lis[i], i);
      (lis[i] as HTMLElement).hidden = !isShown(i);
    });
    while (lis.length > items.length) list.lastElementChild!.remove();
  }

  function renderMeta() {
    const shown = items.filter((_, i) => isShown(i)).length;
    empty.hidden = !items.length || shown > 0;
    matchCount.textContent = query ? `${shown} / ${items.length}` : '';
  }

  function renderAll() {
    renderList();
    renderMeta();
    markActive();
    updateRoving();
  }

  // ----- active item ----------------------------------------------------------

  function markActive() {
    for (const b of scroller.querySelectorAll('[aria-current]')) b.removeAttribute('aria-current');
    for (const b of scroller.querySelectorAll(`.item[data-index="${active}"]`)) b.setAttribute('aria-current', 'true');
  }

  function setActive(index: number) {
    active = index;
    markActive();
    const inList = list.children[index]?.querySelector('.item');
    // The same item is reported again after every rebuild (claude.ai loads
    // turns all along a jump through a long chat): bring it into view once,
    // not each time, or it fights the user scrolling the list meanwhile.
    if (index !== inView && inList && isVisible(inList)) {
      keepInView(inList);
      inView = index;
    }
    if (!element.contains(getRootFocus())) updateRoving();
  }

  // The new chat's rows in place of the previous chat's.
  function swapIn() {
    swapping = false;
    clearTimeout(swapTimer);
    list.inert = false;
    list.replaceChildren();
    renderAll();
    // claude.ai opens a chat at its end, and so does the list, until the
    // question being read is known (setActive brings it into view).
    scroller.scrollTop = scroller.scrollHeight;
  }

  // Same as scrollIntoView({ block: 'nearest' }) but limited to the list, so
  // it can never scroll Claude's page as a side effect.
  // The whole row (it carries the highlight), clear of the list's padding;
  // the last row scrolls the list to its very end.
  function keepInView(el: Element) {
    const row = el.closest('li') || el;
    if (row === list.lastElementChild) {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    const pad = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
    const box = scroller.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < box.top + pad) scroller.scrollTop -= box.top + pad - r.top;
    else if (r.bottom > box.bottom - pad) scroller.scrollTop += r.bottom - (box.bottom - pad);
  }

  // ----- keyboard -------------------------------------------------------------

  const isVisible = (el: Element) => el.getClientRects().length > 0;
  const visibleItems = () => Array.from(scroller.querySelectorAll<HTMLButtonElement>('.item')).filter(isVisible);
  const getRootFocus = () => (element.getRootNode() as ShadowRoot | Document).activeElement;

  // One row is reachable with Tab (roving tabindex): the active question if
  // it is shown, else the first shown one.
  function updateRoving() {
    const shown = visibleItems();
    const target = shown.find((b) => b.dataset.index === String(active)) || shown[0];
    for (const b of scroller.querySelectorAll<HTMLButtonElement>('.item')) b.tabIndex = b === target ? 0 : -1;
  }

  function focusRow(button: HTMLButtonElement) {
    for (const b of scroller.querySelectorAll<HTMLButtonElement>('.item')) b.tabIndex = -1;
    button.tabIndex = 0;
    button.focus();
    keepInView(button);
  }

  // Redrawn through the set's subscription (it may change in the overview too).
  const toggleStar = (index: number) => stars.toggle(starKey(index));
  stars.subscribe(() => renderAll());

  // After a question is picked the focus stays on it (so the arrows keep
  // working), but its focus ring is hidden until the keyboard moves again.
  const setPicked = (picked: boolean) => scroller.toggleAttribute('data-picked', picked);

  scroller.addEventListener('click', (e) => {
    const target = e.target as Element;
    const star = target.closest<HTMLButtonElement>('.star');
    if (star) return toggleStar(Number(star.dataset.star));
    const item = target.closest<HTMLButtonElement>('.item');
    if (!item) return;
    const index = Number(item.dataset.index);
    focusRow(item);
    setPicked(true);
    if (expanded === index) return collapse();
    collapse();
    onSelect(index);
  });

  scroller.addEventListener('keydown', (e) => {
    const current = (getRootFocus() as Element | null)?.closest<HTMLButtonElement>('.item');
    if (!current) return;
    if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleStar(Number(current.dataset.index));
      return;
    }
    const shown = visibleItems();
    const i = shown.indexOf(current);
    // Cmd+↑/↓ (Ctrl off the Mac): the first or last question.
    const far = e.metaKey || e.ctrlKey;
    const next = { ArrowDown: far ? shown.length - 1 : i + 1, ArrowUp: far ? 0 : i - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    setPicked(false);
    if (next < 0) input.focus();
    else if (shown[Math.min(next, shown.length - 1)]) focusRow(shown[Math.min(next, shown.length - 1)]);
  });

  input.addEventListener('input', () => {
    query = input.value.trim().toLowerCase();
    scroller.scrollTop = 0;
    renderAll();
  });

  input.addEventListener('keydown', (e) => {
    const shown = visibleItems();
    if (e.key === 'ArrowDown' && shown.length) {
      e.preventDefault();
      e.stopPropagation();
      focusRow(shown[0]);
    } else if (e.key === 'Enter' && shown.length) {
      e.preventDefault();
      shown[0].click();
    } else if (e.key === 'Escape' && input.value) {
      // Esc clears the filter.
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      input.dispatchEvent(new Event('input'));
    }
  });

  filterBtn.addEventListener('click', () => onStarred());

  return {
    element,
    render(next) {
      const arriving = !items.length && next.length > 0;
      items = next;
      if (swapping) {
        if (next.length) swapIn(); // the previous chat's rows stay until there is something
        return;
      }
      renderAll();
      if (arriving) scroller.scrollTop = scroller.scrollHeight; // as in swapIn()
    },
    setActive,
    expand,
    markPlace,
    setConversation() {
      placeKey = null;
      query = '';
      input.value = '';
      active = -1;
      inView = -1;
      expanded = -1;
      items = [];
      clearTimeout(swapTimer);
      if (!list.children.length) {
        // Nothing of another chat on screen.
        swapping = false;
        list.inert = false;
        renderAll();
        return;
      }
      swapping = true;
      list.inert = true; // the rows are another chat's: no clicks on them
      swapTimer = setTimeout(swapIn, SWAP_WAIT_MS);
    },
    focus() {
      // The rows were hidden while the panel was collapsed, so the Tab stop
      // may be stale: put it on the active question first. No scroll on
      // focus: the list is already where it should be (revealActive).
      updateRoving();
      const target = scroller.querySelector<HTMLButtonElement>('.item[tabindex="0"]') || visibleItems()[0];
      if (!target) return false;
      target.focus({ preventScroll: true });
      // Opened with the shortcut: the row is marked already; the ring
      // comes back once the arrows move.
      setPicked(true);
      return true;
    },
    revealActive() {
      const el = list.children[active]?.querySelector('.item');
      if (!el || !isVisible(el)) return;
      const row = el.closest('li') || el;
      if (row === list.lastElementChild) scroller.scrollTop = scroller.scrollHeight;
      else {
        const box = scroller.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        scroller.scrollTop += r.top + r.height / 2 - (box.top + box.height / 2);
      }
      inView = active;
    },
  };
}
