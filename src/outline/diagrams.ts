// Finding a diagram from the panel's Diagrams view in the chat, so a jump
// can land on it rather than on the question above it. Only read, never
// changed: the highlight is drawn by the panel.
//
// The diagram is looked for after the question's message and before the
// next question's. claude.ai shows a visual in a frame titled
// "visualize: <its title>"; anything else (an artifact's card) is found by
// its title text.
import * as S from '../core/selectors';
import type { DiagramFinder, DiagramTarget } from '../core/types';
import { safe } from '../core/util';
import { findFeed, q, runStrategy } from './extract';

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

function candidates(feed: HTMLElement, target: DiagramTarget): HTMLElement[] {
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
        return inAnswer[Math.min(target.nth, inAnswer.length - 1)] || null;
      },
      null
    );
    return last;
  };
}
