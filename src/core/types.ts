// Shapes shared between the modules.

/** Query helpers that never throw: a broken selector degrades to "nothing found". */
export interface Query {
  one(root: ParentNode | null, sel: string): HTMLElement | null;
  all(root: ParentNode | null, sel: string): HTMLElement[];
  text(el: Node | null | undefined): string;
}

/** One way of finding the user's messages inside the feed. */
export interface Strategy {
  name: string;
  find(feed: HTMLElement, q: Query): HTMLElement[];
}

/** A question as claude.ai's API returns it, with its 1-based position in the branch. */
export interface ApiQuestion {
  text: string;
  pos: number;
}

/** `widget`: drawn inline in the chat by Claude's visualizer (HTML or SVG). */
export type DiagramKind = 'svg' | 'mermaid' | 'html' | 'react' | 'widget';

/** A diagram Claude made in its answer, from claude.ai's API. */
export interface Diagram {
  kind: DiagramKind;
  title: string;
  /** SVG markup, Mermaid text, HTML or JSX, as Claude wrote it. */
  source: string;
  /** Index of the question whose answer has it. */
  question: number;
}

/** A question rendered in the page right now. */
export interface RenderedItem {
  target: HTMLElement;
  full: string;
  pos: number | null;
  label: string;
}

/** A question the ledger knows of, rendered or not. */
export interface Entry {
  key: string;
  full: string;
  pos: number | null;
  label: string;
  /** The rendered turn, or null while claude.ai has it unmounted. */
  node: HTMLElement | null;
  /** Top of the turn relative to the feed when last seen. */
  offset: number | null;
  /** Sent after the last API answer. */
  pending: boolean;
}

/** What the panel shows per question. `key` identifies it for stars. */
export type ListItem = Pick<Entry, 'key' | 'label' | 'full'>;

export type Status = 'no-feed' | 'empty' | 'selectors-broken' | 'ok';

export interface RenderResult {
  status: Status;
  strategy?: string | null;
  items: readonly ListItem[];
  canLoadEarlier: boolean;
  incomplete: boolean;
  /** The list is the conversation's full one (from the API), not a page-only or cached guess. */
  settled: boolean;
}

export type LoadReason = 'done' | 'cancelled' | 'limit' | 'timeout' | 'stalled' | 'error';

export interface LoadState {
  running: boolean;
  clicks?: number;
  scan?: number;
  reason?: LoadReason;
}

/** The question you were reading when you last left the chat. */
export interface ResumeOffer {
  index: number;
  label: string;
}

/** What a session needs from the panel. */
export interface View {
  render(result: RenderResult): void;
  setActive(index: number): void;
  setLoadState(state: LoadState): void;
  /**
   * Marks the message you jumped to. `target` is asked for the message on
   * every frame (null while it is not rendered); clipped to `clip` (the
   * chat's scroller), or the viewport if null.
   */
  highlight(target: () => Element | null, clip: Element | null): void;
  /**
   * The question is in the list but claude.ai does not show it (the page
   * loads a chat's history only so far back): show its text in the panel.
   */
  unreachable(index: number): void;
  /**
   * A jump is waiting for claude.ai to load earlier messages: say so over
   * the chat (`clip`, its scroller; null: the viewport), or stop saying so.
   */
  seeking(on: boolean, clip?: Element | null): void;
  /**
   * Offer to go back to the question you were reading when you last left
   * this chat (shown over `clip`, as `seeking`), or take the offer away.
   */
  offerResume(offer: ResumeOffer | null, clip?: Element | null): void;
}
