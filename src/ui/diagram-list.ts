// The panel's Diagrams view: what Claude drew in this chat (its inline
// visuals, and SVG, Mermaid, HTML and React artifacts). Read from claude.ai's
// API each time the view is opened, never in the background. Clicking one
// jumps to the question whose answer has it.
//
// Previews: an SVG artifact is an <img>, so nothing in it runs. Visuals,
// HTML and Mermaid are drawn live in a sandboxed extension page (see
// src/preview/), as claude.ai draws them in its own frames, which the
// extension can't look into. Only rows on screen in the open view have one,
// so a chat full of animations costs nothing while you don't look at them.
// React artifacts are listed by name.
import { h, icon } from '../core/dom';
import type { Diagram, DiagramKind, DiagramTarget } from '../core/types';
import type { PreviewMessage } from '../preview/preview';

const KIND_LABEL: Record<DiagramKind, string> = {
  svg: 'SVG',
  mermaid: 'Mermaid',
  html: 'HTML',
  react: 'React',
  widget: 'Visual',
};
const REACT_ICON = 'M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M3 12c0-2.5 4-4.5 9-4.5s9 2 9 4.5-4 4.5-9 4.5-9-2-9-4.5z';
const SVG_NS = 'http://www.w3.org/2000/svg';

// Live previews are laid out at the width of claude.ai's chat column, which
// visuals are drawn for, then scaled down to the panel.
const RENDER_WIDTH = 680;
const RENDER_MAX_HEIGHT = 2000;
const HEIGHT_GUESS = 400; // until the preview reports its own
const MOUNT_MARGIN = '200px 0px'; // started a little before they scroll in
// Shown by then even if it never says how tall it is (a page whose own
// scripts break the report): better a drawing in a guessed box than none.
const READY_FALLBACK_MS = 1500;
// Diagrams this tab has already received, by conversation (most recent
// last): shown at once on coming back, while they are asked for again.
const KNOWN_MAX_CHATS = 20;
const known = new Map<string, Diagram[]>();

const TEXT = {
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
  destroy(): void;
}

export interface DiagramListOptions {
  load(convId: string): Promise<Diagram[] | null>;
  /** A diagram was picked: the question it answers, and which diagram of the answer. */
  onSelect(question: number, target: DiagramTarget): void;
  /** How many diagrams the chat has, or null while not known. */
  onCount(count: number | null): void;
  /** The panel's theme, which live previews are drawn in. */
  theme(): 'light' | 'dark';
}

const same = (a: readonly Diagram[], b: readonly Diagram[]) =>
  a.length === b.length &&
  a.every(
    (d, i) => d.kind === b[i].kind && d.title === b[i].title && d.question === b[i].question && d.source === b[i].source
  );

const setHeight = (box: HTMLElement, height: number) => box.style.setProperty('--h', `${height}px`);

// A visual that is one SVG filling the width: its height is known before it
// is drawn, from its viewBox, so its box has its final size from the start.
function svgHeight(d: Diagram): number | null {
  if (d.kind !== 'widget' || !d.source.trimStart().startsWith('<svg')) return null;
  const open = /<svg\b[^>]*>/.exec(d.source)?.[0] ?? '';
  const width = /\swidth\s*=\s*["']([^"']*)["']/.exec(open)?.[1];
  const box = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(open);
  if (!box || (width && width !== '100%')) return null;
  const ratio = Number(box[2]) / Number(box[1]);
  return Number.isFinite(ratio) && ratio > 0 ? Math.round(RENDER_WIDTH * ratio) : null;
}

const isLive = (kind: DiagramKind): kind is PreviewMessage['kind'] =>
  kind === 'widget' || kind === 'html' || kind === 'mermaid';

export function createDiagramList({ load, onSelect, onCount, theme }: DiagramListOptions): DiagramList {
  let convId: string | null = null;
  let diagrams: Diagram[] | null = null;
  let request = 0; // the latest load; older answers are dropped
  let urls: string[] = []; // thumbnails' blob URLs, released on every redraw
  const live = new Map<Element, Diagram>(); // preview box -> its diagram
  const frames = new Map<MessageEventSource, HTMLElement>(); // mounted preview -> its box
  const heights = new WeakMap<Diagram, number>(); // as reported, so a remount doesn't jump

  const list = h('ol', { className: 'diagram-list', 'aria-label': 'Diagrams' });
  const message = h('p', { className: 'empty', hidden: '' });
  const scroller = h('div', { className: 'scroll' }, [list, message]);
  const element = h('div', { className: 'diagrams' }, [scroller]);

  // ----- previews -----------------------------------------------------------

  // The SVG as an image file: no script in it runs and nothing it links to
  // loads. A blob: URL, which claude.ai's page allows for images (it shows
  // your attachments that way). Dropped if it doesn't draw.
  function thumbnail(source: string): HTMLElement {
    // The <svg> tag itself, not whatever comes first (an <?xml?> line, a comment).
    const open = /<svg\b[^>]*>/.exec(source)?.[0] ?? '';
    const markup = /\sxmlns\s*=/.test(open) ? source : source.replace(/<svg\b/, `<svg xmlns="${SVG_NS}"`);
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    urls.push(url);
    const img = h('img', { className: 'thumb', src: url, alt: '', decoding: 'async', loading: 'lazy' });
    const box = h('div', { className: 'thumb-box', 'aria-hidden': 'true' }, [img]);
    img.addEventListener('load', () => box.toggleAttribute('data-ready', true));
    img.addEventListener('error', () => box.remove());
    return box;
  }

  // The panel's width changes the scale of every preview at once.
  function updateScale() {
    const box = list.querySelector<HTMLElement>('.live-box');
    if (box && box.clientWidth) list.style.setProperty('--co-scale', String(box.clientWidth / RENDER_WIDTH));
  }

  function mount(box: HTMLElement) {
    const diagram = live.get(box);
    if (!diagram || box.firstChild || !isLive(diagram.kind)) return;
    let src: string;
    try {
      src = chrome.runtime.getURL('preview.html');
    } catch {
      return; // the extension was reloaded under this page
    }
    const frame = h('iframe', { src, sandbox: 'allow-scripts', tabindex: '-1', 'aria-hidden': 'true' });
    const msg: PreviewMessage = { kind: diagram.kind, source: diagram.source, theme: theme() };
    frame.addEventListener(
      'load',
      () => {
        frame.contentWindow?.postMessage(msg, '*');
        setTimeout(() => frame.isConnected && box.toggleAttribute('data-ready', true), READY_FALLBACK_MS);
      },
      { once: true }
    );
    box.append(frame);
    if (frame.contentWindow) frames.set(frame.contentWindow, box);
    updateScale();
  }

  function unmount(box: HTMLElement) {
    const frame = box.querySelector('iframe');
    if (!frame) return;
    if (frame.contentWindow) frames.delete(frame.contentWindow);
    frame.remove();
    box.removeAttribute('data-ready');
  }

  // Started and stopped as rows come and go, and all stopped while the
  // view (or the panel) is hidden: nothing is on screen then.
  const visibility = new IntersectionObserver(
    (entries) => {
      for (const e of entries) (e.isIntersecting ? mount : unmount)(e.target as HTMLElement);
    },
    { root: scroller, rootMargin: MOUNT_MARGIN }
  );
  const resize = new ResizeObserver(updateScale);
  resize.observe(list);

  // A preview's height, the one thing it may tell the panel.
  function onMessage(e: MessageEvent) {
    const box = e.source ? frames.get(e.source) : undefined;
    if (!box || !e.data || typeof e.data !== 'object') return;
    const height = Number((e.data as { coPreviewHeight?: unknown }).coPreviewHeight);
    const diagram = live.get(box);
    if (!diagram || !Number.isFinite(height) || height <= 0) return;
    const clamped = Math.min(Math.round(height), RENDER_MAX_HEIGHT);
    heights.set(diagram, clamped);
    setHeight(box, clamped);
    // Drawn: the shimmer gives way to the drawing.
    box.toggleAttribute('data-ready', true);
  }
  window.addEventListener('message', onMessage);

  // ----- rows ---------------------------------------------------------------

  function row(d: Diagram, index: number): HTMLLIElement {
    let preview: HTMLElement | null = null;
    if (d.kind === 'svg') preview = thumbnail(d.source);
    else if (isLive(d.kind)) {
      preview = h('div', { className: 'live-box', 'aria-hidden': 'true' });
      setHeight(preview, heights.get(d) ?? svgHeight(d) ?? HEIGHT_GUESS);
      live.set(preview, d);
      visibility.observe(preview);
    }
    const button = h('button', { type: 'button', className: 'diagram', title: `${d.title}: jump to it` }, [
      ...(d.kind === 'react'
        ? [h('span', { className: 'diagram-icon', 'aria-hidden': 'true' }, [icon(REACT_ICON)])]
        : []),
      h('span', { className: 'diagram-text' }, [
        h('span', { className: 'diagram-title' }, [d.title]),
        h('span', { className: 'diagram-meta' }, [`${KIND_LABEL[d.kind]} · question ${d.question + 1}`]),
      ]),
    ]);
    return h('li', { className: 'diagram-row', 'data-index': String(index) }, [...(preview ? [preview] : []), button]);
  }

  function release() {
    visibility.disconnect();
    for (const box of live.keys()) unmount(box as HTMLElement);
    live.clear();
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls = [];
  }

  function say(text: string) {
    message.hidden = !text;
    message.textContent = text;
  }

  function draw(next: Diagram[] | null) {
    // The same diagrams again: nothing to redraw, so no preview restarts.
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
    const remembered = known.get(id);
    if (remembered && !diagrams) draw(remembered);
    let next: Diagram[] | null = null;
    try {
      next = await load(id);
    } catch {
      next = null;
    }
    if (mine !== request || convId !== id) return;
    // A failed reload keeps the list that was shown.
    if (next || !diagrams) draw(next);
    // The list shown (the remembered objects when nothing changed: the
    // previews' heights are kept by object).
    if (next && diagrams) {
      known.delete(id);
      known.set(id, diagrams);
      if (known.size > KNOWN_MAX_CHATS) known.delete(known.keys().next().value!);
    }
  }

  // Which of the answer's diagrams with this title it is (they can repeat).
  function target(index: number): DiagramTarget {
    const d = diagrams![index];
    const nth = diagrams!.slice(0, index).filter((o) => o.question === d.question && o.title === d.title).length;
    return { kind: d.kind, title: d.title, nth };
  }

  list.addEventListener('click', (e) => {
    const li = (e.target as Element).closest<HTMLElement>('.diagram-row');
    const index = Number(li?.dataset.index);
    if (li && diagrams?.[index]) onSelect(diagrams[index].question, target(index));
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
    destroy() {
      release();
      resize.disconnect();
      window.removeEventListener('message', onMessage);
    },
  };
}
