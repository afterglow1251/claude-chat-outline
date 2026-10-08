// DOM events between page-bridge.ts (page world) and the content script
// (isolated world). Both worlds see DOM events on the same document, and
// nothing else; the events never leave the tab.
export const LOCATION_EVENT = 'claude-outline:locationchange';
export const DEBUG_EVENT = 'claude-outline:debug';
/** page -> content: the questions of a conversation claude.ai just loaded (detail: JSON string). */
export const CONVERSATION_EVENT = 'claude-outline:conversation';
/** content -> page: send the last conversation again (the content script starts later than the page). */
export const CONVERSATION_REQUEST_EVENT = 'claude-outline:conversation-request';

/** What CONVERSATION_EVENT carries. Questions only: no answers, no ids, nothing else from the response. */
export interface ConversationPayload {
  convId: string;
  questions: { text: string; pos: number }[];
}

/** Limits on what is relayed, so a huge chat (or a bogus event) stays cheap. */
export const PAYLOAD_MAX_QUESTIONS = 5000;
export const PAYLOAD_TEXT_MAX = 2000;

/** id of the panel's host element (the one node the extension adds to the page). */
export const HOST_ID = 'claude-outline-host';
