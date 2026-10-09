// Finding a diagram from the panel's Diagrams view, or a code block from
// its Code view, in the chat, so a jump can land on it rather than on the
// question above it. Only read, never changed: the highlight is drawn by
// the panel.
//
// It is looked for after the question's message and before the next
// question's. claude.ai shows a visual in a frame titled
// "visualize: <its title>"; a code block is a <pre> holding the given line;
// anything else (an artifact's card) is found by its title text.
import * as S from '../core/selectors';
import type { DiagramFinder, DiagramTarget } from '../core/types';
import { safe } from '../core/util';
import { findFeed, q, runStrategy } from './extract';
import { seekLog } from './seek';

const CLICKABLE = 'button, a, [role="button"]';

const follows = (a: Node, b: Node) => !!(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);

function userMessages(feed: HTMLElement): HTMLElement[] {
  for (const strategy of S.userMessageStrategies) {
    const nodes = runStrategy(strategy, feed);
    if (nodes.length) return nodes;
  }
  return [];
}

// The frame's title without its tool's name: "visualize: Coffee flow" -> "coffee flow".
const frameTitle = (frame: Element) =>
  (frame.getAttribute('title') || '')
    .replace(/^[^:]*:\s*/, '')
    .trim()
    .toLowerCase();

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

// Shown as part of the answer: not inside its thinking or anything folded
// away, drawn with a size, not transparent, and not clipped away by an
// ancestor (a collapsed block is often a container of height 0 with
// overflow hidden: what is inside keeps its own size). A jump to a hidden
// copy would land the highlight on nothing visible, then jump once claude.ai
// re-rendered and the real one was found.
const CLIPS = /hidden|clip/;
function shownInAnswer(el: HTMLElement, feed: HTMLElement): boolean {
  if (el.closest(S.notAnswer)) return false;
  const r = el.getBoundingClientRect();
  if (r.height < 1 || r.width < 1) return false;
  for (let a: HTMLElement | null = el; a && a !== feed; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    // Scrollable ancestors (the chat itself) are not clipping: what is out
    // of their view can be scrolled to. Hidden ones are.
    if (a !== el && (CLIPS.test(cs.overflowY) || CLIPS.test(cs.overflowX))) {
      const b = a.getBoundingClientRect();
      if (b.height < 1 || r.bottom <= b.top + 0.5 || r.top >= b.bottom - 0.5) return false;
    }
  }
  return true;
}

// A code block's card: claude.ai draws the code (<pre>) inside a card with
// a header (the language, a copy button). The jump lands on and highlights
// the card, not the code alone, which left a frame inside a frame. The
// card is the highest ancestor not much taller than the code (a header's
// worth), so a wrapper around the whole answer is never taken.
const CARD_EXTRA_PX = 80;
function codeCard(pre: HTMLElement, feed: HTMLElement): HTMLElement {
  const h = pre.getBoundingClientRect().height;
  let card = pre;
  for (let a = pre.parentElement; a && a !== feed && !a.matches(S.turn); a = a.parentElement) {
    const ah = a.getBoundingClientRect().height;
    if (ah > h + CARD_EXTRA_PX) break;
    card = a;
  }
  return card;
}

function candidates(feed: HTMLElement, target: DiagramTarget): HTMLElement[] {
  const shown = matching(feed, target).filter((el) => shownInAnswer(el, feed));
  return target.kind === 'code' ? shown.map((pre) => codeCard(pre, feed)) : shown;
}

function matching(feed: HTMLElement, target: DiagramTarget): HTMLElement[] {
  if (target.kind === 'code') {
    const line = squash(target.title);
    return q.all(feed, 'pre').filter((pre) => squash(pre.textContent || '').includes(line));
  }
  const title = target.title.trim().toLowerCase();
  if (target.kind === 'widget') return q.all(feed, 'iframe[title]').filter((f) => frameTitle(f) === title);
  const found: HTMLElement[] = [];
  const walker = document.createTreeWalker(feed, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || (n.textContent || '').trim().toLowerCase() !== title) continue;
    const el = parent.closest<HTMLElement>(CLICKABLE) || parent;
    if (!found.includes(el)) found.push(el);
  }
  return found;
}

export function diagramFinder(target: DiagramTarget): DiagramFinder {
  let last: HTMLElement | null = null; // kept while claude.ai keeps it rendered
  return (questionTurn) => {
    if (last && last.isConnected) return last;
    if (!questionTurn) return null;
    last = safe(
      'find diagram',
      () => {
        const feed = findFeed();
        if (!feed) return null;
        const users = userMessages(feed);
        const start = users.find((u) => questionTurn.contains(u)) || questionTurn;
        const end = users.find((u) => follows(u, start) && !start.contains(u)) || null;
        const inAnswer = candidates(feed, target).filter(
          (el) => follows(el, start) && !start.contains(el) && (!end || follows(end, el))
        );
        const el = inAnswer[Math.min(target.nth, inAnswer.length - 1)] || null;
        if (el) {
          const r = el.getBoundingClientRect();
          seekLog('diagram found', {
            of: inAnswer.length,
            tag: el.tagName,
            top: Math.round(r.top),
            h: Math.round(r.height),
          });
        }
        return el;
      },
      null
    );
    return last;
  };
}
