// "Continue where you left off": offered over the top of the chat when you
// open a chat you were reading further up the last time.
//
// Drawn in the extension's shadow root like the seeking pill, centred over
// the chat's scrolling area. It may stay up for a while, so it is placed
// again when the window or the chat area changes size, not on every frame.
import { h, icon } from '../core/dom';
import type { ResumeOffer } from '../core/types';

const TOP_GAP_PX = 12;
const ICON_UP = 'M12 19V5M6 11l6-6 6 6';
const ICON_CLOSE = 'M6 6l12 12M18 6L6 18';

export interface ResumePill {
  show(offer: ResumeOffer, clip: Element | null): void;
  hide(): void;
}

export function createResumePill(
  layer: HTMLElement,
  onPick: (index: number) => void,
  onDismiss: () => void
): ResumePill {
  const label = h('span', { className: 'resume-label' });
  const go = h('button', { type: 'button', className: 'resume-go' }, [
    icon(ICON_UP),
    h('span', {}, ['Continue where you left off']),
    label,
  ]);
  const close = h('button', { type: 'button', className: 'resume-close', 'aria-label': 'Dismiss', title: 'Dismiss' }, [
    icon(ICON_CLOSE),
  ]);
  const pill = h('div', { className: 'resume', role: 'region', 'aria-label': 'Continue reading' }, [go, close]);
  pill.hidden = true;
  layer.append(pill);

  let current: ResumeOffer | null = null;
  let clipEl: Element | null = null;
  let resizeObserver: ResizeObserver | null = null;

  function place() {
    const r = clipEl && clipEl.isConnected ? clipEl.getBoundingClientRect() : null;
    pill.style.left = `${r ? r.left + r.width / 2 : window.innerWidth / 2}px`;
    pill.style.top = `${(r ? Math.max(0, r.top) : 0) + TOP_GAP_PX}px`;
  }

  function hide() {
    current = null;
    clipEl = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    window.removeEventListener('resize', place);
    pill.classList.remove('in');
    pill.hidden = true;
  }

  function show(offer: ResumeOffer, clip: Element | null) {
    const fresh = !current;
    if (current && current.index === offer.index && current.label === offer.label && clipEl === clip) return;
    current = offer;
    label.textContent = offer.label;
    go.title = `Back to question ${offer.index + 1}: ${offer.label}`;
    if (clip !== clipEl || fresh) {
      clipEl = clip;
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(place);
      resizeObserver.observe(clip ?? document.documentElement);
      window.addEventListener('resize', place);
    }
    place();
    if (!fresh) return;
    pill.hidden = false;
    // Next frame, so the slide-in runs from the hidden state.
    requestAnimationFrame(() => pill.classList.add('in'));
  }

  go.addEventListener('click', () => {
    const offer = current;
    hide();
    if (offer) onPick(offer.index);
  });
  close.addEventListener('click', () => {
    hide();
    onDismiss();
  });

  return { show, hide };
}
