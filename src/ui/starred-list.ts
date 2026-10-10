// The Starred overview: everything starred in this chat in one list, in chat
// order: questions, the diagrams (with their previews) and the code, each
// row as in its own view. Opened with the ☆ button of any view, closed with
// its own. Clicking a row jumps to it; its star unstars it (it leaves the
// list). The rows in the answer being read are marked, as everywhere.
//
// Rows are kept by key and only added or removed, never redrawn or moved:
// moving a live preview's frame would reload it.
import { h } from '../core/dom';
import type { CodeBlock, Diagram, DiagramTarget, ListItem } from '../core/types';
import * as Store from '../data/store';
import { codeMatches, codeRow, codeStarKey, codeTarget, copyCode } from './code-list';
import { diagramRow, diagramStarKey, diagramTarget } from './diagram-list';
import { createListTools, holdRows, listKeys, listScroll, markCurrent, patchStar, starButton } from './list-tools';
import { createPreviews } from './previews';
import { questionStarKey } from './question-list';
import type { StarSet } from './star-set';

// Opening the overview again within this time shows what was read, unasked.
const MAX_AGE_MS = 5000;

const TEXT = {
  none: 'Nothing starred yet. Star questions, diagrams or code to see them here together.',
  noMatch: 'Nothing starred matches.',
};

type Kind = 'question' | 'diagram' | 'code';

// The chips under the filter: everything, or one kind. Kept while you move
// between chats, like a view.
const SHOWN: readonly { kind: Kind | 'all'; label: string }[] = [
  { kind: 'all', label: 'All' },
  { kind: 'question', label: 'Questions' },
  { kind: 'diagram', label: 'Diagrams' },
  { kind: 'code', label: 'Code' },
];
let shownKind: Kind | 'all' = 'all';
// Within one question: the question, then its diagrams, then its code.
const ORDER: Record<Kind, number> = { question: 0, diagram: 1, code: 2 };

interface Entry {
  /** Kind and star key: which row it is, across redraws. */
  id: string;
  kind: Kind;
  /** Index in its own list (questions, diagrams or code). */
  index: number;
  question: number;
  starKey: string;
}

// A question's row, as in the question list.
function questionRow(item: ListItem, index: number): HTMLElement[] {
  const button = h('button', { type: 'button', className: 'item', title: item.full || item.label }, [
    h('span', { className: 'num', 'aria-hidden': 'true' }, [`${index + 1}.`]),
    h('span', { className: 'label' }, [item.label]),
  ]);
  return [button, starButton()];
}

export interface StarredStars {
  questions: StarSet;
  diagrams: StarSet;
  code: StarSet;
}

export interface StarredList {
  readonly element: HTMLElement;
  /** Shows what is known, checks diagrams and code again with claude.ai, opens at the answer being read. */
  show(): void;
  /** The chat's questions, as the Questions view lists them. */
  setQuestions(items: readonly ListItem[]): void;
  /** The question being read (-1: none): its rows are marked, and kept in view while shown. */
  setActive(question: number): void;
  setConversation(convId: string | null): void;
  focus(): boolean;
  destroy(): void;
}

export interface StarredListOptions {
  stars: StarredStars;
  /** A question was picked. */
  onSelect(index: number): void;
  /** A diagram or a code block was picked: the question it answers, and how to find it. */
  onSelectItem(question: number, target: DiagramTarget): void;
  /** How many starred things there are. */
  onCount(count: number): void;
  /** Its ☆ button: close the overview. */
  onStarred(): void;
  theme(): 'light' | 'dark';
}

export function createStarredList({
  stars,
  onSelect,
  onSelectItem,
  onCount,
  onStarred,
  theme,
}: StarredListOptions): StarredList {
  let convId: string | null = null;
  let questions: readonly ListItem[] = [];
  let diagrams: readonly Diagram[] = [];
  let blocks: readonly CodeBlock[] = [];
  let entries: Entry[] = [];
  let active = -1;
  let picked: string | null = null; // the row clicked, marked alone while its answer is read
  let unsubscribe: (() => void) | null = null; // following the store, once opened
  const rows = new Map<string, HTMLLIElement>(); // entry id -> its row

  const list = h('ol', { className: 'starred-list', 'aria-label': 'Everything starred' });
  const message = h('p', { className: 'empty', hidden: '' });
  const scroller = h('div', { className: 'scroll' }, [list, message]);
  const previews = createPreviews(scroller, theme);
  const held = holdRows(list, () => {
    previews.release();
    list.replaceChildren();
    render();
  });
  const scrolling = listScroll(scroller, list);
  const tools = createListTools({
    what: 'starred',
    starred: true,
    onChange: applyFilter,
    onDown: () => keys.focusFirst(),
    onStarred,
  });
  const keys = listKeys(scroller, {
    row: '.ov-row',
    focusable: '.item, .diagram, .code-jump',
    onStar: (li) => toggle(li),
    onTop: () => tools.focusFilter(),
  });
  const chips = SHOWN.map(({ kind, label }) =>
    h('button', { type: 'button', className: 'kind-chip', 'data-kind': kind, 'aria-pressed': 'false' }, [
      label,
      h('span', { className: 'kind-count' }),
    ])
  );
  const kinds = h('div', { className: 'kinds', role: 'group', 'aria-label': 'Show' }, chips);
  kinds.addEventListener('click', (e) => {
    const chip = (e.target as Element).closest<HTMLButtonElement>('.kind-chip');
    if (!chip || chip.disabled) return;
    shownKind = chip.dataset.kind as Kind | 'all';
    applyFilter();
    // Picked (Enter or a click): no focus ring on it until the focus moves on.
    kinds.setAttribute('data-picked', '');
  });
  kinds.addEventListener('focusout', () => kinds.removeAttribute('data-picked'));
  // The mouse doesn't focus the chips at all.
  kinds.addEventListener('mousedown', (e) => e.preventDefault());
  const element = h('div', { className: 'starred' }, [tools.bar, kinds, scroller]);
  const setOf = (kind: Kind) => ({ question: stars.questions, diagram: stars.diagrams, code: stars.code })[kind];
  const unwatch = [stars.questions, stars.diagrams, stars.code].map((set) => set.subscribe(render));

  function collect(): Entry[] {
    const all: Entry[] = [];
    questions.forEach((item, i) => {
      const key = questionStarKey(item, i);
      if (stars.questions.has(key)) all.push({ id: `q:${key}`, kind: 'question', index: i, question: i, starKey: key });
    });
    diagrams.forEach((d, i) => {
      const key = diagramStarKey(diagrams, i);
      if (stars.diagrams.has(key))
        all.push({ id: `d:${key}`, kind: 'diagram', index: i, question: d.question, starKey: key });
    });
    blocks.forEach((b, i) => {
      const key = codeStarKey(b);
      if (stars.code.has(key)) all.push({ id: `c:${key}`, kind: 'code', index: i, question: b.question, starKey: key });
    });
    return all.toSorted((a, b) => a.question - b.question || ORDER[a.kind] - ORDER[b.kind] || a.index - b.index);
  }

  function makeRow(e: Entry): HTMLLIElement {
    const parts =
      e.kind === 'question'
        ? questionRow(questions[e.index], e.index)
        : e.kind === 'diagram'
          ? diagramRow(diagrams[e.index], previews)
          : codeRow(blocks[e.index]);
    const kindClass = { question: 'q-row', diagram: 'diagram-row', code: 'code-row' }[e.kind];
    return h('li', { className: `ov-row ${kindClass}`, 'data-id': e.id }, parts);
  }

  // Adds the rows newly starred, removes those no longer starred, and keeps
  // the others where they are (in chat order, which never changes).
  function render() {
    if (held.holding()) {
      // The new chat's rows take the place of the previous chat's.
      held.release();
      previews.release();
      list.replaceChildren();
    }
    entries = collect();
    const wanted = new Set(entries.map((e) => e.id));
    for (const [id, li] of rows) {
      if (wanted.has(id)) continue;
      li.querySelectorAll<HTMLElement>('.live-box, .thumb-box').forEach((box) => previews.drop(box));
      li.remove();
      rows.delete(id);
    }
    let ref = list.firstElementChild;
    for (const e of entries) {
      let li = rows.get(e.id);
      if (!li) {
        li = makeRow(e);
        rows.set(e.id, li);
      }
      if (li === ref) ref = ref.nextElementSibling;
      else list.insertBefore(li, ref);
    }
    onCount(entries.length);
    applyFilter();
  }

  const byId = (li: Element) => entries.find((e) => e.id === (li as HTMLElement).dataset.id);

  function matches(e: Entry, q: string): boolean {
    if (!q) return true;
    if (e.kind === 'question') {
      const item = questions[e.index];
      return (item.full || item.label).toLowerCase().includes(q);
    }
    if (e.kind === 'diagram') return diagrams[e.index].title.toLowerCase().includes(q);
    return codeMatches(blocks[e.index], q);
  }

  // Marks the rows in the answer being read, and shows only those that match the filter.
  function applyFilter() {
    if (held.holding()) return; // the previous chat's rows: marked as they were
    let shown = 0;
    for (const li of list.children as HTMLCollectionOf<HTMLElement>) {
      const e = byId(li);
      if (!e) continue;
      const label =
        e.kind === 'question'
          ? `question ${e.index + 1}`
          : e.kind === 'diagram'
            ? diagrams[e.index].title
            : `${blocks[e.index].language || 'code'} block`;
      patchStar(li.querySelector('.star')!, setOf(e.kind), e.starKey, label);
      markCurrent(li, e.question === active && (picked === null || picked === e.id));
      li.hidden = (shownKind !== 'all' && e.kind !== shownKind) || !matches(e, tools.query);
      if (!li.hidden) shown++;
    }
    tools.setShown(shown, entries.length);
    renderChips();
    message.hidden = shown > 0;
    message.textContent = !entries.length ? TEXT.none : shown ? '' : TEXT.noMatch;
  }

  // Each chip with how many are starred of its kind; one with none can't be picked.
  function renderChips() {
    for (const chip of chips) {
      const kind = chip.dataset.kind as Kind | 'all';
      const n = kind === 'all' ? entries.length : entries.filter((e) => e.kind === kind).length;
      chip.querySelector('.kind-count')!.textContent = n ? String(n) : '';
      chip.disabled = kind !== 'all' && n === 0;
      chip.setAttribute('aria-pressed', String(kind === shownKind));
    }
  }

  function toggle(li: HTMLElement) {
    const e = byId(li);
    if (e) setOf(e.kind).toggle(e.starKey);
  }

  function take(conversation: Store.Conversation) {
    const nextDiagrams = conversation.diagrams ?? diagrams;
    const nextBlocks = conversation.code ?? blocks;
    if (nextDiagrams === diagrams && nextBlocks === blocks) return;
    // Rows of a list that changed are rebuilt (their index may have moved).
    for (const [id, li] of rows) {
      if ((id.startsWith('d:') && nextDiagrams !== diagrams) || (id.startsWith('c:') && nextBlocks !== blocks)) {
        li.querySelectorAll<HTMLElement>('.live-box, .thumb-box').forEach((box) => previews.drop(box));
        li.remove();
        rows.delete(id);
      }
    }
    diagrams = nextDiagrams;
    blocks = nextBlocks;
    render();
  }

  list.addEventListener('click', (ev) => {
    const el = ev.target as Element;
    const li = el.closest<HTMLElement>('.ov-row');
    const e = li && byId(li);
    if (!li || !e) return;
    if (el.closest('.star')) return toggle(li);
    const copyBtn = el.closest<HTMLElement>('.code-copy');
    if (copyBtn) return void copyCode(copyBtn, blocks[e.index].code);
    // The row keeps the focus, so S and the arrows go on from it.
    keys.focusRow(li);
    picked = e.id;
    applyFilter();
    if (e.kind === 'question') onSelect(e.index);
    else if (e.kind === 'diagram') onSelectItem(e.question, diagramTarget(diagrams, e.index));
    else onSelectItem(e.question, codeTarget(blocks, e.index));
  });

  return {
    element,
    async show() {
      if (!convId) return;
      const id = convId;
      unsubscribe ??= Store.subscribe(id, (conversation) => {
        if (!element.hidden) take(conversation);
      });
      take(Store.peek(id));
      render();
      scrolling.reveal();
      await Store.refresh(id, MAX_AGE_MS);
    },
    setQuestions(items) {
      // Handed over on every rebuild (each second while Claude streams):
      // only a list that really changed redraws.
      const same =
        items.length === questions.length &&
        items.every((it, i) => it.key === questions[i].key && it.label === questions[i].label);
      if (same) return;
      // Question rows show the label: rebuilt when the list changes.
      for (const [id, li] of rows) {
        if (!id.startsWith('q:')) continue;
        li.remove();
        rows.delete(id);
      }
      questions = items;
      render();
    },
    setActive(question) {
      if (question === active) return;
      active = question;
      // Reading on: the answer's rows again. Not when the jump to the
      // picked one just landed in its own answer.
      if (picked !== null && entries.find((e) => e.id === picked)?.question !== question) picked = null;
      applyFilter();
      if (!element.hidden) scrolling.follow();
    },
    setConversation(id) {
      convId = id;
      active = -1;
      picked = null;
      tools.clear();
      unsubscribe?.();
      unsubscribe = null;
      questions = [];
      diagrams = [];
      blocks = [];
      entries = [];
      rows.clear();
      held.hold();
    },
    focus: () => keys.focusFirst(),
    destroy() {
      unsubscribe?.();
      unwatch.forEach((stop) => stop());
      previews.destroy();
      scrolling.stop();
    },
  };
}
