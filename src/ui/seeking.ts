// The "Loading earlier messages…" pill shown over the chat while a jump
// waits for claude.ai to load the question's part of the history.
//
// Drawn in the extension's shadow root (like the highlight), centred over
// the top of the chat's scrolling area and following it every frame. It
// only appears if the wait lasts: a quick jump shows nothing.
import { h } from '../core/dom';

const SHOW_AFTER_MS = 300;
const TOP_GAP_PX = 12;

export interface SeekingPill {
  /** Shows the pill over `clip` (the chat's scroller; null: the viewport). */
  show(clip: Element | null): void;
  hide(): void;
}

export function createSeekingPill(layer: HTMLElement): SeekingPill {
  const pill = h('div', { className: 'seeking', role: 'status', 'aria-live': 'polite' }, [
    h('span', { className: 'seeking-spin' }),
    h('span', {}, ['Loading earlier messages…']),
  ]);
  pill.hidden = true;
  layer.append(pill);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;

  function hide() {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    timer = undefined;
    frame = 0;
    pill.classList.remove('in');
    pill.hidden = true;
  }

  function show(clip: Element | null) {
    hide();
    timer = setTimeout(() => {
      pill.hidden = false;
      const place = () => {
        frame = requestAnimationFrame(place);
        const r = clip && clip.isConnected ? clip.getBoundingClientRect() : null;
        const left = r ? r.left + r.width / 2 : window.innerWidth / 2;
        const top = (r ? Math.max(0, r.top) : 0) + TOP_GAP_PX;
        pill.style.left = `${left}px`;
        pill.style.top = `${top}px`;
      };
      place();
      // Next frame, so the entrance transition runs from the hidden state.
      requestAnimationFrame(() => pill.classList.add('in'));
    }, SHOW_AFTER_MS);
  }

  return { show, hide };
}
