// The panel's Code view: every code block Claude wrote in this chat, in
// order, from the store (store.ts) like the Diagrams view: what it knows is
// shown at once when the view is opened, and checked again with claude.ai
// then, never in the background. Each block shows its language, its first
// lines and the question it answers; clicking one jumps to it in the chat,
// its copy button copies it. Nothing in it is run: code is only ever text.
import { h, icon } from '../core/dom';
import type { CodeBlock, DiagramTarget } from '../core/types';
import * as Store from '../data/store';
import { createListTools, listKeys, markPicked, type ListTools } from './list-tools';

const PREVIEW_LINES = 6;
// Opening the view again within this time shows what was read, unasked.
const MAX_AGE_MS = 5000;
const COPIED_MS = 1500;

const ICON_COPY = 'M9 9h10v10H9zM5 15V5h10';
const ICON_COPIED = 'M5 12.5l4.5 4.5L19 7.5';

const TEXT = {
  none: 'No code in this chat.',
  noneStarred: 'No starred code.',
  noMatch: 'No code matches.',
  failed: "Couldn't read this chat's code.",
};

export interface CodeList {
  /** The scrolling list, to be placed in the panel. */
  readonly element: HTMLElement;
  /** Shows what is known and checks it again; the list on screen stays until an answer differs. */
  show(): void;
  /** Clears the list for another chat (null: off a chat page). */
  setConversation(convId: string | null): void;
  /** Focuses the first block; false if there is none. */
  focus(): boolean;
  destroy(): void;
}

export interface CodeListOptions {
  /** A block was picked: the question it answers, and how to find it in the answer. */
  onSelect(question: number, target: DiagramTarget): void;
  /** How many blocks the chat has, or null while not known. */
  onCount(count: number | null): void;
}

// The line a block is found by in the chat: its longest among the first few
// (a lone "{" or "}" would match any block), squashed like the finder's.
function findLine(code: string): string {
  const lines = code
    .split('\n')
    .slice(0, PREVIEW_LINES)
    .map((l) => l.replace(/\s+/g, ' ').trim());
  return lines.reduce((a, b) => (b.length > a.length ? b : a), '');
}

// Its first lines, without blank ones at the end of what is shown.
const preview = (code: string) => code.split('\n').slice(0, PREVIEW_LINES).join('\n').replace(/\s+$/, '');

// A block's star survives reloads: kept by its question and a fingerprint
// of its code (a block that changes is a new one).
function starKey(b: CodeBlock): string {
  let hash = 5381;
  for (let i = 0; i < b.code.length; i++) hash = ((hash << 5) + hash + b.code.charCodeAt(i)) | 0;
  return `${b.question}|${(hash >>> 0).toString(36)}`;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function row(b: CodeBlock, index: number, tools: ListTools): HTMLLIElement {
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
  return h('li', { className: 'code-row', 'data-index': String(index) }, [
    h('div', { className: 'code-head' }, [jump, tools.starButton(), copyBtn]),
    h('pre', { className: 'code-preview' }, [preview(b.code)]),
  ]);
}

export function createCodeList({ onSelect, onCount }: CodeListOptions): CodeList {
  let convId: string | null = null;
  let blocks: readonly CodeBlock[] | null = null;
  let unsubscribe: (() => void) | null = null; // following the store, once the view was opened

  const list = h('ol', { className: 'code-list', 'aria-label': 'Code' });
  const message = h('p', { className: 'empty', hidden: '' });
  const scroller = h('div', { className: 'scroll' }, [list, message]);
  const tools = createListTools({
    scope: 'code',
    what: 'code',
    onChange: applyFilter,
    onDown: () => keys.focusFirst(),
  });
  const keys = listKeys(scroller, {
    row: '.code-row',
    focusable: '.code-jump',
    onStar: (li) => tools.toggle(starKey(blocks![Number(li.dataset.index)])),
    onTop: () => tools.focusFilter(),
  });
  const element = h('div', { className: 'code' }, [tools.bar, scroller]);

  function say(text: string) {
    message.hidden = !text;
    message.textContent = text;
  }

  let picked: string | null = null; // the block last jumped to, by its star key

  // Marks the starred blocks and shows only those that match the filter
  // (by language or code) and, with "starred only" on, are starred.
  function applyFilter() {
    if (!blocks) return;
    let shown = 0;
    for (const li of list.children as HTMLCollectionOf<HTMLElement>) {
      const b = blocks[Number(li.dataset.index)];
      const key = starKey(b);
      tools.patchStar(li.querySelector('.star')!, key, `${b.language || 'code'} block`);
      markPicked(li, key === picked);
      const q = tools.query;
      const matches = !q || b.language.toLowerCase().includes(q) || b.code.toLowerCase().includes(q);
      li.hidden = !matches || (tools.only && !tools.has(key));
      if (!li.hidden) shown++;
    }
    tools.setShown(shown, blocks.length);
    say(!blocks.length ? TEXT.none : shown ? '' : tools.query ? TEXT.noMatch : TEXT.noneStarred);
  }

  function draw(next: readonly CodeBlock[] | null) {
    // The same blocks again (the store keeps an unchanged list as is).
    if (next && next === blocks) return;
    blocks = next;
    list.replaceChildren(...(next ?? []).map((b, i) => row(b, i, tools)));
    say(!next ? TEXT.failed : next.length ? '' : TEXT.none);
    applyFilter();
    onCount(next ? next.length : null);
  }

  async function show() {
    if (!convId) return;
    const id = convId;
    unsubscribe ??= Store.subscribe(id, (conversation) => {
      if (!element.hidden && conversation.code) draw(conversation.code);
    });
    const known = Store.peek(id).code;
    if (known) draw(known);
    // The answer comes through the subscription.
    await Store.refresh(id, MAX_AGE_MS);
    // Unavailable: a list already shown stays.
    if (convId === id && !blocks) draw(null);
  }

  // Which block of the answer it is, among those found by the same line.
  function target(index: number): DiagramTarget {
    const b = blocks![index];
    const line = findLine(b.code);
    const nth = blocks!.slice(0, index).filter((o) => o.question === b.question && findLine(o.code) === line).length;
    return { kind: 'code', title: line, nth };
  }

  list.addEventListener('click', (e) => {
    const el = e.target as Element;
    const star = el.closest<HTMLElement>('.star');
    if (star?.dataset.star) return tools.toggle(star.dataset.star);
    const li = el.closest<HTMLElement>('.code-row');
    const index = Number(li?.dataset.index);
    if (!li || !blocks?.[index]) return;
    const copyBtn = el.closest<HTMLButtonElement>('.code-copy');
    // The row keeps the focus, so S and the arrows go on from it, and is
    // marked as the one jumped to.
    if (!copyBtn) {
      keys.focusRow(li);
      picked = starKey(blocks[index]);
      applyFilter();
      return onSelect(blocks[index].question, target(index));
    }
    void copy(blocks[index].code).then((ok) => {
      if (!ok) return;
      copyBtn.replaceChildren(icon(ICON_COPIED));
      copyBtn.setAttribute('aria-label', 'Copied');
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.replaceChildren(icon(ICON_COPY));
        copyBtn.setAttribute('aria-label', 'Copy code');
        copyBtn.classList.remove('copied');
      }, COPIED_MS);
    });
  });

  return {
    element,
    show,
    setConversation(id) {
      convId = id;
      picked = null;
      tools.setConversation(id);
      unsubscribe?.();
      unsubscribe = null;
      blocks = null;
      list.replaceChildren();
      say('');
      onCount(null);
    },
    focus: () => keys.focusFirst(),
    destroy() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
