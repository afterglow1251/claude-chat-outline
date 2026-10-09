// The panel's Diagrams view: what Claude drew in this chat (its inline
// visuals, and SVG, Mermaid, HTML and React artifacts), from the store
// (store.ts): what it knows is shown at once when the view is opened, and
// checked again with claude.ai then, never in the background. Each has a
// preview (previews.ts) and a star; clicking one jumps to it in the chat.
import { h, icon } from '../core/dom';
import type { Diagram, DiagramTarget } from '../core/types';
import * as Store from '../data/store';
import { createListTools, listKeys, listScroll, markCurrent, patchStar, starButton } from './list-tools';
import { createPreviews, type Previews } from './previews';
import type { StarSet } from './star-set';

const REACT_ICON = 'M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M3 12c0-2.5 4-4.5 9-4.5s9 2 9 4.5-4 4.5-9 4.5-9-2-9-4.5z';

// Opening the view again within this time shows what was read, unasked.
const MAX_AGE_MS = 5000;

const TEXT = {
  none: 'No diagrams in this chat.',
  noMatch: 'No diagrams match.',
  failed: "Couldn't read this chat's diagrams.",
};

/** Which of its answer's diagrams with this title it is (they can repeat): what a jump looks for. */
export function diagramTarget(diagrams: readonly Diagram[], index: number): DiagramTarget {
  const d = diagrams[index];
  const nth = diagrams.slice(0, index).filter((o) => o.question === d.question && o.title === d.title).length;
  return { kind: d.kind, title: d.title, nth };
}

/** A diagram's star survives reloads: kept by its question, kind, title and place among same-titled ones. */
export function diagramStarKey(diagrams: readonly Diagram[], index: number): string {
  const t = diagramTarget(diagrams, index);
  return `${diagrams[index].question}|${t.kind}|${t.title}|${t.nth}`;
}

/** A diagram's row content: its preview, then its name and question beside its star. */
export function diagramRow(d: Diagram, previews: Previews): HTMLElement[] {
  const preview = previews.of(d);
  const button = h('button', { type: 'button', className: 'diagram', title: `${d.title}: jump to it` }, [
    ...(d.kind === 'react'
      ? [h('span', { className: 'diagram-icon', 'aria-hidden': 'true' }, [icon(REACT_ICON)])]
      : []),
    h('span', { className: 'diagram-text' }, [
      h('span', { className: 'diagram-title' }, [d.title]),
      // The preview shows what it is; a React artifact has none, so it says so.
      h('span', { className: 'diagram-meta' }, [
        d.kind === 'react' ? `React · question ${d.question + 1}` : `Question ${d.question + 1}`,
      ]),
    ]),
  ]);
  return [...(preview ? [preview] : []), h('div', { className: 'diagram-line' }, [button, starButton()])];
}

export interface DiagramList {
  /** The scrolling list, to be placed in the panel. */
  readonly element: HTMLElement;
  /** Reads this chat's diagrams again; the list on screen stays until they arrive. */
  show(): void;
  /** Clears the list for another chat (null: off a chat page). */
  setConversation(convId: string | null): void;
  /** Focuses the first diagram; false if there is none. */
  focus(): boolean;
  /** The question being read (-1: none): its diagrams are marked, and kept in view while shown. */
  setActive(question: number): void;
  destroy(): void;
}

export interface DiagramListOptions {
  /** A diagram was picked: the question it answers, and which diagram of the answer. */
  onSelect(question: number, target: DiagramTarget): void;
  /** How many diagrams the chat has, or null while not known. */
  onCount(count: number | null): void;
  /** The panel's theme, which live previews are drawn in. */
  theme(): 'light' | 'dark';
  /** The diagrams' stars, shared with the Starred overview. */
  stars: StarSet;
  /** The ☆ button: open the Starred overview. */
  onStarred(): void;
}

export function createDiagramList({ onSelect, onCount, theme, stars, onStarred }: DiagramListOptions): DiagramList {
  let convId: string | null = null;
  let diagrams: readonly Diagram[] | null = null;
  let unsubscribe: (() => void) | null = null; // following the store, once the view was opened
  let active = -1; // the question being read: its diagrams are marked
  let picked = -1; // the one clicked, marked alone while its answer is read
  let revealPending = false; // opened, not yet scrolled to where it opens

  const list = h('ol', { className: 'diagram-list', 'aria-label': 'Diagrams' });
  const message = h('p', { className: 'empty', hidden: '' });
  const scroller = h('div', { className: 'scroll' }, [list, message]);
  const previews = createPreviews(scroller, theme);
  const scrolling = listScroll(scroller, list);
  const tools = createListTools({
    what: 'diagrams',
    onChange: applyFilter,
    onDown: () => keys.focusFirst(),
    onStarred,
  });
  const keys = listKeys(scroller, {
    row: '.diagram-row',
    focusable: '.diagram',
    onStar: (li) => stars.toggle(diagramStarKey(diagrams!, Number(li.dataset.index))),
    onTop: () => tools.focusFilter(),
  });
  const element = h('div', { className: 'diagrams' }, [tools.bar, scroller]);
  const unwatchStars = stars.subscribe(() => applyFilter());

  function say(text: string) {
    message.hidden = !text;
    message.textContent = text;
  }

  function reveal() {
    revealPending = false;
    scrolling.reveal();
  }

  // Marks the starred rows and those in the answer being read, and shows
  // only those that match the filter (by title).
  function applyFilter() {
    if (!diagrams) return;
    let visible = 0;
    for (const li of list.children as HTMLCollectionOf<HTMLElement>) {
      const index = Number(li.dataset.index);
      const d = diagrams[index];
      patchStar(li.querySelector('.star')!, stars, diagramStarKey(diagrams, index), d.title);
      markCurrent(li, d.question === active && (picked === -1 || picked === index));
      li.hidden = !!tools.query && !d.title.toLowerCase().includes(tools.query);
      if (!li.hidden) visible++;
    }
    tools.setShown(visible, diagrams.length);
    say(!diagrams.length ? TEXT.none : visible ? '' : TEXT.noMatch);
  }

  function draw(next: readonly Diagram[] | null) {
    // The same diagrams again (the store keeps an unchanged list as is):
    // nothing to redraw, so no preview restarts.
    if (next && next === diagrams) return;
    diagrams = next;
    previews.release();
    list.replaceChildren(
      ...(next ?? []).map((d, i) =>
        h('li', { className: 'diagram-row', 'data-index': String(i) }, diagramRow(d, previews))
      )
    );
    say(!next ? TEXT.failed : next.length ? '' : TEXT.none);
    applyFilter();
    if (revealPending && next) reveal();
    onCount(next ? next.length : null);
  }

  async function show() {
    if (!convId) return;
    const id = convId;
    // While the view is hidden, changes wait for it to be shown again
    // (redrawing would restart the previews for nothing).
    unsubscribe ??= Store.subscribe(id, (conversation) => {
      if (!element.hidden && conversation.diagrams) draw(conversation.diagrams);
    });
    // Opened: at the diagrams of the answer being read, else at the end, once there is a list.
    revealPending = true;
    const known = Store.peek(id).diagrams;
    if (known) draw(known);
    if (revealPending && diagrams) reveal();
    // The answer comes through the subscription.
    await Store.refresh(id, MAX_AGE_MS);
    // Unavailable: a list already shown stays.
    if (convId === id && !diagrams) draw(null);
  }

  list.addEventListener('click', (e) => {
    const star = (e.target as Element).closest<HTMLElement>('.star');
    if (star?.dataset.star) return stars.toggle(star.dataset.star);
    const li = (e.target as Element).closest<HTMLElement>('.diagram-row');
    const index = Number(li?.dataset.index);
    if (!li || !diagrams?.[index]) return;
    // The row keeps the focus, so S and the arrows go on from it. The
    // jump makes its question the one being read, which marks it.
    keys.focusRow(li);
    picked = index;
    applyFilter();
    onSelect(diagrams[index].question, diagramTarget(diagrams, index));
  });

  return {
    element,
    show,
    setConversation(id) {
      convId = id;
      active = -1;
      picked = -1;
      tools.clear();
      unsubscribe?.();
      unsubscribe = null;
      diagrams = null;
      previews.release();
      list.replaceChildren();
      say('');
      onCount(null);
    },
    focus: () => keys.focusFirst(),
    setActive(question) {
      if (question === active) return;
      active = question;
      // Reading on: the answer's diagrams again. Not when the jump to the
      // picked one just landed in its own answer.
      if (picked !== -1 && diagrams?.[picked]?.question !== question) picked = -1;
      applyFilter();
      if (!element.hidden) scrolling.follow();
    },
    destroy() {
      unsubscribe?.();
      unsubscribe = null;
      unwatchStars();
      previews.destroy();
      scrolling.stop();
    },
  };
}
