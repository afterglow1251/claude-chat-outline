// Content-script side of the conversation relay (see page-bridge.ts).
// Any script on the page can dispatch these events, so the payload is
// treated as untrusted input: parsed defensively, checked field by field,
// and only ever rendered as text.
import {
  CONVERSATION_EVENT,
  CONVERSATION_REQUEST_EVENT,
  PAYLOAD_MAX_QUESTIONS,
  PAYLOAD_TEXT_MAX,
  type ConversationPayload,
} from '../core/events';

// JSON overhead per question is small; this bounds the string before parsing.
const PAYLOAD_MAX_CHARS = PAYLOAD_MAX_QUESTIONS * (PAYLOAD_TEXT_MAX + 64);
const CONV_ID = /^[\w-]{8,}$/;

export function readPayload(detail: unknown): ConversationPayload | null {
  if (typeof detail !== 'string' || detail.length > PAYLOAD_MAX_CHARS) return null;
  let data: unknown;
  try {
    data = JSON.parse(detail);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { convId, questions } = data as Record<string, unknown>;
  if (typeof convId !== 'string' || !CONV_ID.test(convId)) return null;
  if (!Array.isArray(questions) || questions.length > PAYLOAD_MAX_QUESTIONS) return null;
  const valid: ConversationPayload['questions'] = [];
  for (const q of questions as unknown[]) {
    if (!q || typeof q !== 'object') return null;
    const { text, pos } = q as Record<string, unknown>;
    if (typeof text !== 'string' || !Number.isInteger(pos) || (pos as number) < 1) return null;
    valid.push({ text: text.slice(0, PAYLOAD_TEXT_MAX), pos: pos as number });
  }
  return { convId, questions: valid };
}

/** Calls onPayload for every conversation claude.ai loads, starting with the last one loaded before this call. */
export function watchConversations(onPayload: (payload: ConversationPayload) => void): () => void {
  const listener = (e: Event) => {
    const payload = readPayload((e as CustomEvent).detail);
    if (payload) onPayload(payload);
  };
  document.addEventListener(CONVERSATION_EVENT, listener);
  document.dispatchEvent(new CustomEvent(CONVERSATION_REQUEST_EVENT));
  return () => document.removeEventListener(CONVERSATION_EVENT, listener);
}
