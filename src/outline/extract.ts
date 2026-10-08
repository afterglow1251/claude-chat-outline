// Reading the conversation from the DOM: the feed, the user's messages in
// it, and their text. Safe DOM helpers, so a broken selector degrades to
// "nothing found".
import * as S from '../core/selectors';
import type { Query, RenderedItem, Status, Strategy } from '../core/types';
import { safe } from '../core/util';

const LABEL_MAX = 90;
export const ATTACHMENT_LABEL = '(attachment)';
// Questions are matched by their first KEY_LEN letters and digits.
const KEY_LEN = 48;

// ---------------------------------------------------------------------------
// Safe DOM helpers. A broken selector must degrade to "nothing found",
// never to an exception that breaks claude.ai.
// ---------------------------------------------------------------------------

export const q: Query = Object.freeze({
  one: (root: ParentNode | null, sel: string) =>
    safe(sel, () => (root || document).querySelector<HTMLElement>(sel), null),
  all: (root: ParentNode | null, sel: string) =>
    safe(sel, () => Array.from((root || document).querySelectorAll<HTMLElement>(sel)), [] as HTMLElement[]),
  text: (el: Node | null | undefined) => safe('textContent', () => (el && el.textContent) || '', ''),
});

export function isConversationPath(pathname: string): boolean {
  return S.conversationPaths.some((re) => re.test(pathname));
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export function findFeed(): HTMLElement | null {
  for (const sel of S.feed) {
    const el = q.one(document, sel);
    if (el) return el;
  }
  return null;
}

export function runStrategy(strategy: Strategy, feed: HTMLElement): HTMLElement[] {
  const nodes = safe(strategy.name, () => strategy.find(feed, q), []);
  return Array.isArray(nodes) ? nodes : [];
}

/** `turn` is the scroll target, `source` the matched node. */
interface Hit {
  turn: HTMLElement;
  source: HTMLElement;
}

// Uses the first strategy with results.
function findUserMessages(feed: HTMLElement): { strategy: string | null; hits: Hit[] } {
  for (const strategy of S.userMessageStrategies) {
    const nodes = runStrategy(strategy, feed);
    if (nodes.length > 0) return { strategy: strategy.name, hits: groupByTurn(nodes) };
  }
  return { strategy: null, hits: [] };
}

// One bullet per turn, even if a selector matches several nodes inside it.
function groupByTurn(nodes: HTMLElement[]): Hit[] {
  const seen = new Set<HTMLElement>();
  const hits: Hit[] = [];
  for (const source of nodes) {
    const turn = safe('closest', () => source.closest<HTMLElement>(S.turn), null) || source;
    if (seen.has(turn)) continue;
    seen.add(turn);
    hits.push({ turn, source });
  }
  return hits;
}

// innerText keeps the line break between blocks (a code block and the
// paragraph after it); textContent would glue them together.
export function blockText(el: HTMLElement): string {
  return safe('innerText', () => el.innerText, '') || q.text(el);
}

function messageText({ turn, source }: Hit): string {
  // Strategies 1 and 3 match the message body directly.
  if (source !== turn) return blockText(source);
  // Strategy 2 matches the whole turn; its text would include the
  // heading and button labels, so look for the body inside it first.
  const body = q.one(turn, S.userMessageBody);
  if (body) return blockText(body);
  // The "You said: …" heading is a screen-reader heading that carries the
  // message itself. If it is empty after the prefix, the message has no
  // text (attachment only); don't fall back to the article, whose text
  // would be button labels like "Edit".
  const heading = safe('heading', () => S.userHeadingIn(turn, q), null);
  if (heading) return q.text(heading).replace(S.userHeadingPrefix, '');
  return q.text(turn);
}

export function truncate(text: string): string {
  return text.length <= LABEL_MAX ? text : text.slice(0, LABEL_MAX - 1).trimEnd() + '…';
}

// Code fences ("```python" and the closing "```" lines) are in the stored
// message but not in the rendered one; drop them so both read the same.
export function plainText(text: string | null | undefined): string {
  return (text || '')
    .replace(/^[ \t]*```[^\n`]*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toItem(hit: Hit): RenderedItem {
  const full = plainText(messageText(hit));
  const pos = hit.turn !== hit.source ? safe('position', () => S.turnPosition(hit.turn), null) : null;
  return { target: hit.turn, full, pos, label: full ? truncate(full) : ATTACHMENT_LABEL };
}

export interface Collected {
  status: Status;
  strategy: string | null;
  items: RenderedItem[];
}

// Reports only what is in the DOM right now; the ledger adds the rest.
export function collect(feed: HTMLElement | null): Collected {
  if (!feed) return { status: 'no-feed', strategy: null, items: [] };
  const { strategy, hits } = findUserMessages(feed);
  const items = hits.map(toItem);
  let status: Status = 'ok';
  // Only call it "broken" if the feed actually shows something. An empty
  // feed is normal for a moment right after navigation.
  if (!items.length) status = q.text(feed).trim() ? 'selectors-broken' : 'empty';
  return { status, strategy, items };
}

export function findLoadEarlierButton(): HTMLElement | null {
  const { selector, text } = S.loadEarlierButton;
  return (
    q.all(document, selector).find((b) => text.test(q.text(b)) || text.test(b.getAttribute('aria-label') || '')) || null
  );
}

// Matching key: letters and digits only, so markdown, whitespace and
// punctuation differences between the API text and the rendered text
// don't matter.
export function keyOf(full: string): string {
  return full
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, KEY_LEN);
}
