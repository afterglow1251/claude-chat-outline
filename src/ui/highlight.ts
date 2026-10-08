// The "here it is" highlight on the question you jumped to.
//
// It is drawn in the extension's own shadow root, as a box laid over the
// message, so nothing is added to claude.ai's DOM (not even an animation),
// and backgrounds inside the message (code blocks, attachments) cannot
// cover it. The box follows the message while it is shown (the page may
// still settle or the user may scroll) and is clipped to the chat's
// scrolling area, so it never draws over the header or the input.
import { h } from '../core/dom';

const DURATION_MS = 1800;
const SWEEP_DELAY_MS = 150;
const SWEEP_MS = 1100;
const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
const FALLBACK_RADIUS = '12px';
// How long to wait for the message to be rendered before giving up.
const WAIT_FOR_TARGET_MS = 600;

export interface Highlighter {
  /**
   * Highlights the element `target()` returns, asked again on every frame
   * (the page may re-create it); clipped to `clip` (null: the viewport).
   * Replaces any current highlight.
   */
  show(target: () => Element | null, clip: Element | null): void;
  clear(): void;
}

export function createHighlighter(layer: HTMLElement): Highlighter {
  let stopCurrent: (() => void) | null = null;

  function show(target: () => Element | null, clip: Element | null) {
    stopCurrent?.();
    const sweep = h('div', { className: 'highlight-sweep' });
    const box = h('div', { className: 'highlight' }, [sweep]);
    box.style.visibility = 'hidden';
    layer.append(box);

    let frame = 0;
    let stopped = false;
    let started = false;
    const waitUntil = performance.now() + WAIT_FOR_TARGET_MS;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      box.remove();
      if (stopCurrent === stop) stopCurrent = null;
    };
    stopCurrent = stop;

    // The animation starts on the first frame the message is there (it may
    // be in the middle of being re-created when the highlight is asked for).
    function start(el: Element) {
      started = true;
      const radius = getComputedStyle(el).borderRadius;
      box.style.borderRadius = radius && radius !== '0px' ? radius : FALLBACK_RADIUS;
      // Quick fade in, hold while the light passes, slow fade out. Easing is
      // per segment: one easing over the whole timeline would bend the holds.
      const ring = box.animate(
        [
          { opacity: 0, easing: 'ease-out' },
          { opacity: 1, offset: 0.12 },
          { opacity: 1, offset: 0.7, easing: 'ease-in-out' },
          { opacity: 0 },
        ],
        { duration: DURATION_MS, fill: 'forwards' }
      );
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        sweep.animate([{ transform: 'translateX(-100%)' }, { transform: 'translateX(100%)' }], {
          duration: SWEEP_MS,
          delay: SWEEP_DELAY_MS,
          easing: EASE,
          fill: 'both',
        });
      }
      ring.finished.then(stop, stop);
    }

    // Every frame while shown: place the box on the message, cut to the
    // visible part of the chat. Hidden (not ended) while it is not rendered.
    const place = () => {
      frame = requestAnimationFrame(place);
      const el = target();
      const s = box.style;
      const there = !!el && el.isConnected;
      s.visibility = there ? 'visible' : 'hidden';
      if (!there) {
        if (!started && performance.now() > waitUntil) stop();
        return;
      }
      const r = el.getBoundingClientRect();
      s.left = `${r.left}px`;
      s.top = `${r.top}px`;
      s.width = `${r.width}px`;
      s.height = `${r.height}px`;
      if (clip) {
        const c = clip.getBoundingClientRect();
        const top = Math.max(0, c.top - r.top);
        const right = Math.max(0, r.right - c.right);
        const bottom = Math.max(0, r.bottom - c.bottom);
        const left = Math.max(0, c.left - r.left);
        s.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px round ${s.borderRadius || FALLBACK_RADIUS})`;
      }
      if (!started) start(el);
    };
    place();
  }

  return {
    show,
    clear: () => stopCurrent?.(),
  };
}
