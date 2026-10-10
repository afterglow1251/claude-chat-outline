// The panel's Code view: every code block Claude wrote in this chat, in
// order, from the store (store.ts) like the Diagrams view: what it knows is
// shown at once when the view is opened, and checked again with claude.ai
// then, never in the background. Each block shows its language, its first
// lines and the question it answers; clicking one jumps to it in the chat,
// its copy button copies it. Nothing in it is run: code is only ever text.
import { h, icon } from '../core/dom';
import type { CodeBlock, DiagramTarget } from '../core/types';
import * as Store from '../data/store';
import { createListTools, holdRows, listKeys, listScroll, markCurrent, patchStar, starButton } from './list-tools';
import type { StarSet } from './star-set';

const PREVIEW_LINES = 6;
// Opening the view again within this time shows what was read, unasked.
const MAX_AGE_MS = 5000;
const COPIED_MS = 1500;

const ICON_COPY = 'M9 9h10v10H9zM5 15V5h10';
const ICON_COPIED = 'M5 12.5l4.5 4.5L19 7.5';

const TEXT = {
  none: 'No code in this chat.',
  noMatch: 'No code matches.',
  failed: "Couldn't read this chat's code.",
};

// The line a block is found by in the chat: its longest among the first few
// (a lone "{" or "}" would match any block), squashed like the finder's.
function findLine(code: string): string {
  const lines = code
    .split('\n')
    .slice(0, PREVIEW_LINES)
    .map((l) => l.replace(/\s+/g, ' ').trim());
  return lines.reduce((a, b) => (b.length > a.length ? b : a), '');
}

/** Which block of its answer it is, among those found by the same line: what a jump looks for. */
export function codeTarget(blocks: readonly CodeBlock[], index: number): DiagramTarget {
  const b = blocks[index];
  const line = findLine(b.code);
  const nth = blocks.slice(0, index).filter((o) => o.question === b.question && findLine(o.code) === line).length;
  return { kind: 'code', title: line, nth };
}

/** A block's star survives reloads: kept by its question and a fingerprint of its code (a changed block is a new one). */
export function codeStarKey(b: CodeBlock): string {
  let hash = 5381;
  for (let i = 0; i < b.code.length; i++) hash = ((hash << 5) + hash + b.code.charCodeAt(i)) | 0;
  return `${b.question}|${(hash >>> 0).toString(36)}`;
}

/** Whether the filter's text is in the block's language or code. */
export const codeMatches = (b: CodeBlock, query: string) =>
  !query || b.language.toLowerCase().includes(query) || b.code.toLowerCase().includes(query);

// Its first lines, without blank ones at the end of what is shown.
const preview = (code: string) => code.split('\n').slice(0, PREVIEW_LINES).join('\n').replace(/\s+$/, '');

/** A block's row content: language, question, copy and star, then its first lines. */
export function codeRow(b: CodeBlock): HTMLElement[] {
  const lines = b.code.split('\n').length;
  const more = lines > PREVIEW_LINES ? ` · ${lines} lines` : '';
  const copyBtn = h(
    'button',
    { type: 'button', className: 'code-copy', 'aria-label': 'Copy code', title: 'Copy code' },
    [icon(ICON_COPY)]
  );
  const jump = h('button', { type: 'button', className: 'code-jump', title: 'Jump to it in the chat' }, [
    h('span', { className: 'code-lang' }, [b.language || 'Code']),
    h('span', { className: 'code-meta' }, [`Question ${b.question + 1}${more}`]),
  ]);
  return [
    h('div', { className: 'code-head' }, [jump, copyBtn, starButton()]),
    h('pre', { className: 'code-preview' }, [preview(b.code)]),
  ];
}

/** Copies the block's code; its copy button shows a tick for a moment. */
export async function copyCode(button: HTMLElement, code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
  } catch {
    return;
  }
  button.replaceChildren(icon(ICON_COPIED));
  button.setAttribute('aria-label', 'Copied');
  button.classList.add('copied');
  setTimeout(() => {
    button.replaceChildren(icon(ICON_COPY));
    button.setAttribute('aria-label', 'Copy code');
    button.classList.remove('copied');
  }, COPIED_MS);
}

export interface CodeList {
  /** The scrolling list, to be placed in the panel. */
  readonly element: HTMLElement;
  /** Shows what is known and checks it again; the list on screen stays until an answer differs. */
  show(): void;
  /** Clears the list for another chat (null: off a chat page). */
  setConversation(convId: string | null): void;
  /** Focuses the first block; false if there is none. */
  focus(): boolean;
  /** The question being read (-1: none): its blocks are marked, and kept in view while shown. */
  setActive(question: number): void;
  destroy(): void;
}

export interface CodeListOptions {
  /** A block was picked: the question it answers, and how to find it in the answer. */
  onSelect(question: number, target: DiagramTarget): void;
  /** How many blocks the chat has, or null while not known. */
  onCount(count: number | null): void;
  /** The code's stars, shared with the Starred overview. */
  stars: StarSet;
  /** The ☆ button: open the Starred overview. */
  onStarred(): void;
}

export function createCodeList({ onSelect, onCount, stars, onStarred }: CodeListOptions): CodeList {
  let convId: string | null = null;
  let blocks: readonly CodeBlock[] | null = null;
  let unsubscribe: (() => void) | null = null; // following the store, once the view was opened
  let active = -1; // the question being read: its blocks are marked
  let picked = -1; // the one clicked, marked alone while its answer is read
  let revealPending = false; // opened, not yet scrolled to where it opens

  const list = h('ol', { className: 'code-list', 'aria-label': 'Code' });
  const message = h('p', { className: 'empty', hidden: '' });
  const scroller = h('div', { className: 'scroll' }, [list, message]);
  const scrolling = listScroll(scroller, list);
  const tools = createListTools({ what: 'code', onChange: applyFilter, onDown: () => keys.focusFirst(), onStarred });
  const keys = listKeys(scroller, {
    row: '.code-row',
    focusable: '.code-jump',
    onStar: (li) => stars.toggle(codeStarKey(blocks![Number(li.dataset.index)])),
    onTop: () => tools.focusFilter(),
  });
  const element = h('div', { className: 'code' }, [tools.bar, scroller]);
  const unwatchStars = stars.subscribe(() => applyFilter());
  const held = holdRows(list, () => {
    list.replaceChildren();
    say('');
    onCount(null);
  });

  function say(text: string) {
    message.hidden = !text;
    message.textContent = text;
  }

  function reveal() {
    revealPending = false;
    scrolling.reveal();
  }

  // Marks the starred blocks and those in the answer being read, and shows
  // only those that match the filter (by language or code).
  function applyFilter() {
    if (!blocks) return;
    let shown = 0;
    for (const li of list.children as HTMLCollectionOf<HTMLElement>) {
      const b = blocks[Number(li.dataset.index)];
      patchStar(li.querySelector('.star')!, stars, codeStarKey(b), `${b.language || 'code'} block`);
      markCurrent(li, b.question === active && (picked === -1 || picked === Number(li.dataset.index)));
      li.hidden = !codeMatches(b, tools.query);
      if (!li.hidden) shown++;
    }
    tools.setShown(shown, blocks.length);
    say(!blocks.length ? TEXT.none : shown ? '' : TEXT.noMatch);
  }

  function draw(next: readonly CodeBlock[] | null) {
    // The same blocks again (the store keeps an unchanged list as is).
    if (next && next === blocks) return;
    held.release();
    blocks = next;
    list.replaceChildren(
      ...(next ?? []).map((b, i) => h('li', { className: 'code-row', 'data-index': String(i) }, codeRow(b)))
    );
    say(!next ? TEXT.failed : next.length ? '' : TEXT.none);
    applyFilter();
    if (revealPending && next) reveal();
    onCount(next ? next.length : null);
  }

  async function show() {
    if (!convId) return;
    const id = convId;
    unsubscribe ??= Store.subscribe(id, (conversation) => {
      if (!element.hidden && conversation.code) draw(conversation.code);
    });
    // Opened: at the blocks of the answer being read, else at the end, once there is a list.
    revealPending = true;
    const known = Store.peek(id).code;
    if (known) draw(known);
    if (revealPending && blocks) reveal();
    // The answer comes through the subscription.
    await Store.refresh(id, MAX_AGE_MS);
    // Unavailable: a list already shown stays.
    if (convId === id && !blocks) draw(null);
  }

  list.addEventListener('click', (e) => {
    const el = e.target as Element;
    const star = el.closest<HTMLElement>('.star');
    if (star?.dataset.star) return stars.toggle(star.dataset.star);
    const li = el.closest<HTMLElement>('.code-row');
    const index = Number(li?.dataset.index);
    if (!li || !blocks?.[index]) return;
    const copyBtn = el.closest<HTMLElement>('.code-copy');
    if (copyBtn) return void copyCode(copyBtn, blocks[index].code);
    // The row keeps the focus, so S and the arrows go on from it. The
    // jump makes its question the one being read, which marks it.
    keys.focusRow(li);
    picked = index;
    applyFilter();
    onSelect(blocks[index].question, codeTarget(blocks, index));
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
      blocks = null;
      held.hold();
    },
    focus: () => keys.focusFirst(),
    setActive(question) {
      if (question === active) return;
      active = question;
      if (!blocks) return; // marked when the list is drawn
      // Reading on: the answer's blocks again. Not when the jump to the
      // picked one just landed in its own answer.
      if (picked !== -1 && blocks?.[picked]?.question !== question) picked = -1;
      applyFilter();
      if (!element.hidden) scrolling.follow();
    },
    destroy() {
      unsubscribe?.();
      unsubscribe = null;
      unwatchStars();
      scrolling.stop();
    },
  };
}
