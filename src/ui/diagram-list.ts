// The panel's Diagrams view: what Claude drew in this chat (SVG, Mermaid,
// HTML and React artifacts). Read from claude.ai's API each time the view
// is opened, never in the background, so the outline costs nothing more
// while you are not looking at it. An SVG gets a thumbnail, drawn as an
// <img> so nothing in it can run or load; the others are listed by name.
// Clicking one jumps to the question whose answer has it.
import { h, icon } from '../core/dom';
import type { Diagram, DiagramKind } from '../core/types';

const KIND_LABEL: Record<DiagramKind, string> = { svg: 'SVG', mermaid: 'Mermaid', html: 'HTML', react: 'React' };
const KIND_ICON: Record<DiagramKind, string> = {
  svg: 'M4 4h16v16H4zM4 16l5-5 4 4 2-2 5 5',
  mermaid: 'M4 4h6v5H4zM14 15h6v5h-6zM7 9v3.5h10V15',
  html: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  react: 'M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M3 12c0-2.5 4-4.5 9-4.5s9 2 9 4.5-4 4.5-9 4.5-9-2-9-4.5z',
};
const SVG_NS = 'http://www.w3.org/2000/svg';

const TEXT = {
  loading: 'Looking for diagrams…',
  none: 'No diagrams in this chat.',
  failed: "Couldn't read this chat's diagrams.",
};

export interface DiagramList {
  /** The scrolling list, to be placed in the panel. */
  readonly element: HTMLElement;
  /** Reads this chat's diagrams again; the list on screen stays until they arrive. */
  show(): void;
  /** Clears the list for another chat (null: off a chat page). */
  setConversation(convId: string | null): void;
  /** Focuses the first diagram; false if there is none. */
  focus(): boolean;
}

export interface DiagramListOptions {
  load(convId: string): Promise<Diagram[] | null>;
  /** A diagram was picked: the index of the question it answers. */
  onSelect(question: number): void;
  /** How many diagrams the chat has, or null while not known. */
  onCount(count: number | null): void;
}

const kindIcon = (kind: DiagramKind): HTMLElement =>
  h('span', { className: 'diagram-icon', 'aria-hidden': 'true' }, [icon(KIND_ICON[kind])]);

const same = (a: readonly Diagram[], b: readonly Diagram[]) =>
  a.length === b.length &&
  a.every(
    (d, i) => d.kind === b[i].kind && d.title === b[i].title && d.question === b[i].question && d.source === b[i].source
  );

export function createDiagramList({ load, onSelect, onCount }: DiagramListOptions): DiagramList {
  let convId: string | null = null;
  let diagrams: Diagram[] | null = null;
  let request = 0; // the latest load; older answers are dropped
  let urls: string[] = []; // thumbnails' blob URLs, released on every redraw

  const list = h('ol', { className: 'diagram-list', 'aria-label': 'Diagrams' });
  const message = h('p', { className: 'empty', hidden: '' });
  const element = h('div', { className: 'diagrams' }, [h('div', { className: 'scroll' }, [list, message])]);

  // The SVG as an image file: no script in it runs and nothing it links to
  // loads. A blob: URL, which claude.ai's page allows for images (it shows
  // your attachments that way). Falls back to the icon if it doesn't draw.
  function thumbnail(source: string): HTMLElement {
    // The <svg> tag itself, not whatever comes first (an <?xml?> line, a comment).
    const open = /<svg\b[^>]*>/.exec(source)?.[0] ?? '';
    const markup = /\sxmlns\s*=/.test(open) ? source : source.replace(/<svg\b/, `<svg xmlns="${SVG_NS}"`);
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    urls.push(url);
    const img = h('img', { className: 'thumb', src: url, alt: '', decoding: 'async', loading: 'lazy' });
    const box = h('span', { className: 'thumb-box', 'aria-hidden': 'true' }, [img]);
    img.addEventListener('error', () => {
      box.closest('.diagram')?.classList.remove('has-thumb');
      box.replaceWith(kindIcon('svg'));
    });
    return box;
  }

  function row(d: Diagram): HTMLLIElement {
    const thumb = d.kind === 'svg';
    const button = h(
      'button',
      {
        type: 'button',
        className: thumb ? 'diagram has-thumb' : 'diagram',
        'data-question': String(d.question),
        title: `${d.title}: jump to question ${d.question + 1}`,
      },
      [
        thumb ? thumbnail(d.source) : kindIcon(d.kind),
        h('span', { className: 'diagram-text' }, [
          h('span', { className: 'diagram-title' }, [d.title]),
          h('span', { className: 'diagram-meta' }, [`${KIND_LABEL[d.kind]} · question ${d.question + 1}`]),
        ]),
      ]
    );
    return h('li', {}, [button]);
  }

  function release() {
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls = [];
  }

  function say(text: string) {
    message.hidden = !text;
    message.textContent = text;
  }

  function draw(next: Diagram[] | null) {
    // The same diagrams again: nothing to redraw, so no thumbnail flickers.
    if (next && diagrams && same(next, diagrams)) return;
    diagrams = next;
    release();
    list.replaceChildren(...(next ?? []).map(row));
    say(!next ? TEXT.failed : next.length ? '' : TEXT.none);
    onCount(next ? next.length : null);
  }

  async function show() {
    if (!convId) return;
    const id = convId;
    const mine = ++request;
    if (!diagrams) say(TEXT.loading);
    let next: Diagram[] | null = null;
    try {
      next = await load(id);
    } catch {
      next = null;
    }
    if (mine !== request || convId !== id) return;
    // A failed reload keeps the list that was shown.
    if (next || !diagrams) draw(next);
  }

  list.addEventListener('click', (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>('.diagram');
    if (button) onSelect(Number(button.dataset.question));
  });

  return {
    element,
    show,
    setConversation(id) {
      convId = id;
      request++;
      diagrams = null;
      release();
      list.replaceChildren();
      say('');
      onCount(null);
    },
    focus() {
      const first = list.querySelector<HTMLButtonElement>('.diagram');
      first?.focus({ preventScroll: true });
      return !!first;
    },
  };
}
