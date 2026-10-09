// Diagram previews, for the Diagrams view and the Starred overview.
//
// An SVG artifact is an <img>, so nothing in it runs. Visuals, HTML and
// Mermaid are drawn live in a sandboxed extension page (see src/preview/),
// as claude.ai draws them in its own frames, which the extension can't look
// into. Only previews near the visible part of their list run, so a chat
// full of animations costs nothing while you don't look at them. React
// artifacts have none.
import { h } from '../core/dom';
import type { Diagram, DiagramKind } from '../core/types';
import type { PreviewMessage } from '../preview/preview';

const SVG_NS = 'http://www.w3.org/2000/svg';
// Live previews are laid out at the width of claude.ai's chat column, which
// visuals are drawn for, then scaled down to the panel.
const RENDER_WIDTH = 680;
const RENDER_MAX_HEIGHT = 2000;
const HEIGHT_GUESS = 400; // until the preview reports its own
// Started well before they scroll in, so they are usually ready by then,
// and dropped only once far out of view, so scrolling back doesn't
// reload them. While their list (or the panel) is hidden they are kept:
// Chrome doesn't draw a frame that isn't shown.
const START_MARGIN = '600px 0px';
const STOP_MARGIN = '1500px 0px';
// Shown by then even if it never says it is complete (a page whose own
// scripts break the report): better a drawing than a shimmer forever.
const READY_FALLBACK_MS = 2500;

// As reported, so a remount (or the same diagram in another list) doesn't
// jump. The store keeps a diagram's object as long as it is unchanged.
const heights = new WeakMap<Diagram, number>();

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

export interface Previews {
  /** A diagram's preview, to be placed in its row; null for a React artifact. */
  of(d: Diagram): HTMLElement | null;
  /** Stops and forgets one preview (its row is gone). */
  drop(box: HTMLElement): void;
  /** Stops and forgets them all (before a redraw). */
  release(): void;
  destroy(): void;
}

/** Previews in the list scrolled by `scroller`, drawn in the panel's theme. */
export function createPreviews(scroller: HTMLElement, theme: () => 'light' | 'dark'): Previews {
  const live = new Map<Element, Diagram>(); // live box -> its diagram
  const urls = new Map<Element, string>(); // thumbnail box -> its blob: URL
  const frames = new Map<MessageEventSource, HTMLElement>(); // mounted preview -> its box

  // The SVG as an image file: no script in it runs and nothing it links to
  // loads. A blob: URL, which claude.ai's page allows for images (it shows
  // your attachments that way). Dropped if it doesn't draw.
  function thumbnail(source: string): HTMLElement {
    // The <svg> tag itself, not whatever comes first (an <?xml?> line, a comment).
    const open = /<svg\b[^>]*>/.exec(source)?.[0] ?? '';
    const markup = /\sxmlns\s*=/.test(open) ? source : source.replace(/<svg\b/, `<svg xmlns="${SVG_NS}"`);
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    const img = h('img', { className: 'thumb', src: url, alt: '', decoding: 'async', loading: 'lazy' });
    const box = h('div', { className: 'thumb-box', 'aria-hidden': 'true' }, [img]);
    urls.set(box, url);
    img.addEventListener('load', () => box.toggleAttribute('data-ready', true));
    img.addEventListener('error', () => box.remove());
    return box;
  }

  // The panel's width changes the scale of every preview at once.
  function updateScale() {
    const box = scroller.querySelector<HTMLElement>('.live-box');
    if (box && box.clientWidth) scroller.style.setProperty('--co-scale', String(box.clientWidth / RENDER_WIDTH));
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
  resize.observe(scroller);

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

  function drop(box: HTMLElement) {
    if (live.has(box)) {
      starter.unobserve(box);
      stopper.unobserve(box);
      unmount(box);
      live.delete(box);
    }
    const url = urls.get(box);
    if (url) URL.revokeObjectURL(url);
    urls.delete(box);
  }

  function release() {
    for (const box of [...live.keys(), ...urls.keys()]) drop(box as HTMLElement);
  }

  return {
    of(d) {
      if (d.kind === 'svg') return thumbnail(d.source);
      if (!isLive(d.kind)) return null;
      const box = h('div', { className: 'live-box', 'aria-hidden': 'true' });
      setHeight(box, heights.get(d) ?? svgHeight(d) ?? HEIGHT_GUESS);
      live.set(box, d);
      starter.observe(box);
      stopper.observe(box);
      return box;
    },
    drop,
    release,
    destroy() {
      release();
      starter.disconnect();
      stopper.disconnect();
      resize.disconnect();
      window.removeEventListener('message', onMessage);
    },
  };
}
