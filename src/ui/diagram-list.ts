// The panel's Diagrams view: what Claude drew in this chat (its inline
// visuals, and SVG, Mermaid, HTML and React artifacts), from the store
// (store.ts): what it knows is shown at once when the view is opened, and
// checked again with claude.ai then, never in the background. Clicking one
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
import * as Store from '../data/store';
import { createListTools, listKeys, listScroll, markPicked } from './list-tools';

const REACT_ICON = 'M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M3 12c0-2.5 4-4.5 9-4.5s9 2 9 4.5-4 4.5-9 4.5-9-2-9-4.5z';
const SVG_NS = 'http://www.w3.org/2000/svg';

// Live previews are laid out at the width of claude.ai's chat column, which
// visuals are drawn for, then scaled down to the panel.
const RENDER_WIDTH = 680;
const RENDER_MAX_HEIGHT = 2000;
const HEIGHT_GUESS = 400; // until the preview reports its own
// Started well before they scroll in, so they are usually ready by then,
// and dropped only once far out of view, so scrolling back doesn't
// reload them. While the view or the panel is hidden they are kept:
// Chrome doesn't draw a frame that isn't shown.
const START_MARGIN = '600px 0px';
const STOP_MARGIN = '1500px 0px';
// Shown by then even if it never says it is complete (a page whose own
// scripts break the report): better a drawing than a shimmer forever.
const READY_FALLBACK_MS = 2500;

const TEXT = {
  none: 'No diagrams in this chat.',
  noneStarred: 'No starred diagrams.',
  noMatch: 'No diagrams match.',
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
  /** A diagram was picked: the question it answers, and which diagram of the answer. */
  onSelect(question: number, target: DiagramTarget): void;
  /** How many diagrams the chat has, or null while not known. */
  onCount(count: number | null): void;
  /** The panel's theme, which live previews are drawn in. */
  theme(): 'light' | 'dark';
}

// Opening the view again within this time shows what was read, unasked.
const MAX_AGE_MS = 5000;

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

export function createDiagramList({ onSelect, onCount, theme }: DiagramListOptions): DiagramList {
  let convId: string | null = null;
  let diagrams: readonly Diagram[] | null = null;
  let unsubscribe: (() => void) | null = null; // following the store, once the view was opened
  let urls: string[] = []; // thumbnails' blob URLs, released on every redraw
  const live = new Map<Element, Diagram>(); // preview box -> its diagram
  const frames = new Map<MessageEventSource, HTMLElement>(); // mounted preview -> its box
  const heights = new WeakMap<Diagram, number>(); // as reported, so a remount doesn't jump

  const list = h('ol', { className: 'diagram-list', 'aria-label': 'Diagrams' });
  const message = h('p', { className: 'empty', hidden: '' });
  const scroller = h('div', { className: 'scroll' }, [list, message]);
  const scrolling = listScroll(scroller, list);
  const tools = createListTools({
    scope: 'diagrams',
    what: 'diagrams',
    onChange: applyFilter,
    onDown: () => keys.focusFirst(),
  });
  const keys = listKeys(scroller, {
    row: '.diagram-row',
    focusable: '.diagram',
    onStar: (li) => tools.toggle(starKey(Number(li.dataset.index))),
    onTop: () => tools.focusFilter(),
  });
  const element = h('div', { className: 'diagrams' }, [tools.bar, scroller]);

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

  const shown = () => scroller.getClientRects().length > 0;
  const starter = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) mount(e.target as HTMLElement);
    },
    { root: scroller, rootMargin: START_MARGIN }
  );
  const stopper = new IntersectionObserver(
    (entries) => {
      // Hidden, everything reads as out of view: kept as it is.
      if (!shown()) return;
      for (const e of entries) if (!e.isIntersecting) unmount(e.target as HTMLElement);
    },
    { root: scroller, rootMargin: STOP_MARGIN }
  );
  const resize = new ResizeObserver(updateScale);
  resize.observe(list);

  // A preview's height and that it is complete, the only things it may
  // tell the panel. The box takes its size while it still shimmers, and
  // the drawing fades in once complete.
  function onMessage(e: MessageEvent) {
    const box = e.source ? frames.get(e.source) : undefined;
    if (!box || !e.data || typeof e.data !== 'object') return;
    const data = e.data as { coPreviewHeight?: unknown; coPreviewReady?: unknown };
    const height = Number(data.coPreviewHeight);
    const diagram = live.get(box);
    if (!diagram || !Number.isFinite(height) || height <= 0) return;
    const clamped = Math.min(Math.round(height), RENDER_MAX_HEIGHT);
    heights.set(diagram, clamped);
    setHeight(box, clamped);
    if (data.coPreviewReady === true) box.toggleAttribute('data-ready', true);
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
      starter.observe(preview);
      stopper.observe(preview);
    }
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
    return h('li', { className: 'diagram-row', 'data-index': String(index) }, [
      ...(preview ? [preview] : []),
      h('div', { className: 'diagram-line' }, [button, tools.starButton()]),
    ]);
  }

  function release() {
    starter.disconnect();
    stopper.disconnect();
    for (const box of live.keys()) unmount(box as HTMLElement);
    live.clear();
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls = [];
  }

  function say(text: string) {
    message.hidden = !text;
    message.textContent = text;
  }

  let picked: string | null = null; // the diagram last jumped to, by its star key
  let revealPending = false; // opened, not yet scrolled to where it opens
  function reveal() {
    revealPending = false;
    scrolling.reveal();
  }

  // A diagram's star survives reloads: kept by its question, kind, title
  // and place among the answer's diagrams with that title.
  function starKey(index: number): string {
    const t = target(index);
    return `${diagrams![index].question}|${t.kind}|${t.title}|${t.nth}`;
  }

  // Marks the starred rows and shows only those that match the filter
  // (by title) and, with "starred only" on, are starred.
  function applyFilter() {
    if (!diagrams) return;
    let visible = 0;
    for (const li of list.children as HTMLCollectionOf<HTMLElement>) {
      const index = Number(li.dataset.index);
      const key = starKey(index);
      tools.patchStar(li.querySelector('.star')!, key, diagrams[index].title);
      markPicked(li, key === picked);
      const matches = !tools.query || diagrams[index].title.toLowerCase().includes(tools.query);
      li.hidden = !matches || (tools.only && !tools.has(key));
      if (!li.hidden) visible++;
    }
    tools.setShown(visible, diagrams.length);
    say(!diagrams.length ? TEXT.none : visible ? '' : tools.query ? TEXT.noMatch : TEXT.noneStarred);
  }

  function draw(next: readonly Diagram[] | null) {
    // The same diagrams again (the store keeps an unchanged list as is):
    // nothing to redraw, so no preview restarts.
    if (next && next === diagrams) return;
    diagrams = next;
    release();
    list.replaceChildren(...(next ?? []).map(row));
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
    // Opened: at the end, or at the diagram picked last, once there is a list.
    revealPending = true;
    const known = Store.peek(id).diagrams;
    if (known) draw(known);
    if (revealPending && diagrams) reveal();
    // The answer comes through the subscription.
    await Store.refresh(id, MAX_AGE_MS);
    // Unavailable: a list already shown stays.
    if (convId === id && !diagrams) draw(null);
  }

  // Which of the answer's diagrams with this title it is (they can repeat).
  function target(index: number): DiagramTarget {
    const d = diagrams![index];
    const nth = diagrams!.slice(0, index).filter((o) => o.question === d.question && o.title === d.title).length;
    return { kind: d.kind, title: d.title, nth };
  }

  list.addEventListener('click', (e) => {
    const star = (e.target as Element).closest<HTMLElement>('.star');
    if (star?.dataset.star) return tools.toggle(star.dataset.star);
    const li = (e.target as Element).closest<HTMLElement>('.diagram-row');
    const index = Number(li?.dataset.index);
    if (!li || !diagrams?.[index]) return;
    // The row keeps the focus, so S and the arrows go on from it, and is
    // marked as the one jumped to.
    keys.focusRow(li);
    picked = starKey(index);
    applyFilter();
    onSelect(diagrams[index].question, target(index));
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
      diagrams = null;
      release();
      list.replaceChildren();
      say('');
      onCount(null);
    },
    focus: () => keys.focusFirst(),
    destroy() {
      unsubscribe?.();
      unsubscribe = null;
      release();
      resize.disconnect();
      scrolling.stop();
      window.removeEventListener('message', onMessage);
    },
  };
}
