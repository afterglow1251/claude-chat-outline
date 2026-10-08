// The list of questions inside the panel: filter field, starred-only toggle,
// the list itself, and keyboard navigation. Every row is a button with
// data-index = the question's index in the session's list.
import { h, icon } from '../core/dom';
import { loadStars, saveStars } from '../data/sources';
import type { ListItem } from '../core/types';

const ICON_STAR = 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z';
// Transitions are opacity only: nothing shifts, the layout is final from the
// first frame. Switching chats fades the old list out (keeping its rows
// until it is invisible) and fades the new chat's list in once known.
const FADE_OUT_MS = 120;
const FADE_IN_MS = 180;
const ROW_IN_MS = 220;
// On opening a chat the list is held invisible until it is the final one
// (from the API: a cached or page-only list changes once that arrives) and
// the active question is known, so it appears once, already scrolled to
// the right place. A long chat freezes the page for seconds while it is
// rendered, so this is only a last resort against a chat that never
// renders at all, long enough never to fire before the active question.
const REVEAL_WAIT_MS = 30000;

function fade(el: Element, from: number, to: number, duration: number, fill: FillMode = 'none'): Animation {
  return el.animate([{ opacity: from }, { opacity: to }], { duration, easing: 'ease-out', fill });
}

const UNREACHABLE_NOTE = "Claude hasn't loaded this message, so it can't be shown. What you asked:";

const ICON_SEARCH = 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM20 20l-3.6-3.6';

export interface QuestionList {
  /** Filter row + scrolling list, to be placed in the panel. */
  readonly element: HTMLElement;
  render(items: readonly ListItem[], settled: boolean): void;
  setActive(index: number): void;
  /**
   * Shows the question's full text under its row, with a note that Claude
   * has not loaded the message. Clicking the row again folds it.
   */
  expand(index: number): void;
  /** Loads this conversation's stars and clears the filter. */
  setConversation(convId: string | null): void;
  /** Focuses the keyboard entry point; false if the list is empty. */
  focus(): boolean;
  focusSearch(): void;
}

export function createQuestionList({ onSelect }: { onSelect(index: number): void }): QuestionList {
  let items: readonly ListItem[] = [];
  let query = '';
  let starredOnly = false;
  let stars = new Set<string>();
  let convId: string | null = null;
  let active = -1;
  let inView = -1; // the active item the list was last scrolled to
  let swapping = false; // the previous chat's list is fading out
  let currentFade: Animation | null = null;
  let awaitingActive = false; // list drawn but hidden until it is final and the active item is known
  let settled = false; // the list is the final one (see REVEAL_WAIT_MS)
  let activeOfFinal = false; // the active item was computed for the final list
  let revealTimer: ReturnType<typeof setTimeout> | undefined;

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
      'aria-label': 'Show starred questions only',
      title: 'Starred only',
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

  const starKey = (index: number) => items[index].key || `#${index}`;
  const isStarred = (index: number) => stars.has(starKey(index));
  const matches = (index: number) => {
    if (!query) return true;
    const item = items[index];
    return (item.full || item.label).toLowerCase().includes(query);
  };
  const isShown = (index: number) => matches(index) && (!starredOnly || isStarred(index));

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
  }

  // Patched in place: only what changed is touched, so nothing flickers
  // while Claude streams and the list is rebuilt every second.
  function renderList() {
    const lis = list.children;
    // Rows added to a list already on screen (a question you just sent)
    // fade in; a whole list arriving fades in as one (see reveal()).
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
    matchCount.textContent = query || starredOnly ? `${shown} / ${items.length}` : '';
    filterBtn.setAttribute('aria-pressed', String(starredOnly));
    filterBtn.classList.toggle('has-stars', stars.size > 0);
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
    if (settled) activeOfFinal = true;
    if (awaitingActive && settled && index >= 0) reveal();
  }

  // Shows a list held back for its active item (see REVEAL_WAIT_MS).
  function reveal() {
    if (!awaitingActive) return;
    awaitingActive = false;
    clearTimeout(revealTimer);
    list.style.opacity = '';
    if (items.length) fade(list, 0, 1, FADE_IN_MS);
  }

  // Same as scrollIntoView({ block: 'nearest' }) but limited to the list, so
  // it can never scroll Claude's page as a side effect.
  function keepInView(el: Element) {
    const box = scroller.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < box.top) scroller.scrollTop -= box.top - r.top;
    else if (r.bottom > box.bottom) scroller.scrollTop += r.bottom - box.bottom;
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

  function toggleStar(index: number) {
    const key = starKey(index);
    if (stars.has(key)) stars.delete(key);
    else stars.add(key);
    if (convId) saveStars(convId, [...stars]);
    renderAll();
  }

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
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: shown.length - 1 }[e.key];
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
      // First Esc clears the filter; the next one collapses the panel.
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      input.dispatchEvent(new Event('input'));
    }
  });

  filterBtn.addEventListener('click', () => {
    starredOnly = !starredOnly;
    scroller.scrollTop = 0;
    renderAll();
  });

  return {
    element,
    render(next, isSettled) {
      const arriving = !items.length && next.length > 0;
      items = next;
      if (isSettled && !settled) activeOfFinal = false; // recomputed for this list next frame
      settled = isSettled;
      if (swapping) return; // drawn once the old list has faded out
      renderAll();
      if (awaitingActive) {
        if (arriving) {
          // Drawn, but shown once final and the active question is known.
          list.style.opacity = '0';
          clearTimeout(revealTimer);
          revealTimer = setTimeout(reveal, REVEAL_WAIT_MS);
        }
        if (settled && activeOfFinal && active >= 0) reveal();
        return;
      }
      if (arriving) fade(list, 0, 1, FADE_IN_MS);
    },
    setActive,
    expand,
    setConversation(id) {
      convId = id;
      stars = new Set();
      query = '';
      starredOnly = false;
      input.value = '';
      active = -1;
      inView = -1;
      expanded = -1;
      clearTimeout(revealTimer);
      list.style.opacity = '';
      awaitingActive = !!id;
      settled = false;
      activeOfFinal = false;
      const visible = list.children.length > 0 && isVisible(scroller);
      items = [];
      if (!visible) {
        list.replaceChildren();
        renderAll();
      } else {
        swapping = true;
        const out = fade(scroller, 1, 0, FADE_OUT_MS, 'forwards');
        const swap = () => {
          if (out !== currentFade) return; // a newer switch took over
          swapping = false;
          list.replaceChildren();
          scroller.scrollTop = 0;
          renderAll();
          out.cancel();
          if (awaitingActive && items.length) {
            // Held until the active question is known (see render()).
            list.style.opacity = '0';
            clearTimeout(revealTimer);
            revealTimer = setTimeout(reveal, REVEAL_WAIT_MS);
          }
          fade(scroller, 0, 1, FADE_IN_MS);
        };
        currentFade = out;
        out.finished.then(swap, swap);
      }
      if (!id) return;
      loadStars(id).then((keys) => {
        if (convId !== id) return;
        stars = new Set(keys);
        renderAll();
      });
    },
    focus() {
      const target = scroller.querySelector<HTMLButtonElement>('.item[tabindex="0"]') || visibleItems()[0];
      if (!target) return false;
      target.focus();
      // Opened with the shortcut: the row is marked already; the ring
      // comes back once the arrows move.
      setPicked(true);
      return true;
    },
    focusSearch() {
      input.focus();
      input.select();
    },
  };
}
