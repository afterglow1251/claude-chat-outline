// Runs in the PAGE's JavaScript world ("world": "MAIN" in manifest.json).
//
// Why this file exists: content scripts run in an isolated world. Patching
// history.pushState or fetch there does not see claude.ai's own calls, and
// globals defined there are invisible in the DevTools console. So the things
// that must live in the page's world are done here, and relayed to the
// content script with DOM events (which both worlds see):
//  - navigations (pushState / replaceState);
//  - the conversation claude.ai loads when you open a chat: a copy of that
//    response is read, your questions are taken from it, and only those
//    (text + position) are passed on. Nothing is sent anywhere, no request
//    is made, and claude.ai's own response is left untouched;
//  - window.__claudeOutline.debug().
import { parseConversation } from './conversation';
import {
  CONVERSATION_EVENT,
  CONVERSATION_REQUEST_EVENT,
  DEBUG_EVENT,
  LOCATION_EVENT,
  PAYLOAD_MAX_QUESTIONS,
  PAYLOAD_TEXT_MAX,
  type ConversationPayload,
} from './events';

declare global {
  interface Window {
    __claudeOutlineBridge?: boolean;
    __claudeOutline?: { debug(): string };
  }
}

// GET /api/organizations/<org>/chat_conversations/<conversation id>, on
// claude.ai itself. Other endpoints (sending a message, streaming the
// answer, listing chats) do not match.
const CONVERSATION_PATH = /^\/api\/organizations\/[^/]+\/chat_conversations\/([\w-]{8,})\/?$/;

function conversationRequest(input: RequestInfo | URL, init?: RequestInit): string | null {
  const request = input instanceof Request ? input : null;
  const method = (init?.method || request?.method || 'GET').toUpperCase();
  if (method !== 'GET') return null;
  const url = new URL(request ? request.url : String(input), location.href);
  if (url.origin !== location.origin) return null;
  return CONVERSATION_PATH.exec(url.pathname)?.[1] ?? null;
}

let lastPayload: string | null = null;

function send(detail: string) {
  document.dispatchEvent(new CustomEvent(CONVERSATION_EVENT, { detail }));
}

// The copy is taken before the page's own code can read the body (this
// callback is registered first), and read independently of it.
async function relay(convId: string, response: Response) {
  if (!response.ok) return;
  const questions = parseConversation(await response.clone().json());
  if (!questions) return;
  const payload: ConversationPayload = {
    convId,
    questions: questions
      .slice(0, PAYLOAD_MAX_QUESTIONS)
      .map((q) => ({ text: q.text.slice(0, PAYLOAD_TEXT_MAX), pos: q.pos })),
  };
  // A string crosses between the worlds as is; objects may not.
  lastPayload = JSON.stringify(payload);
  send(lastPayload);
}

if (!window.__claudeOutlineBridge) {
  window.__claudeOutlineBridge = true;

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    if (typeof original !== 'function') continue;
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      try {
        window.dispatchEvent(new Event(LOCATION_EVENT));
      } catch {
        // Never let our notification break the app's navigation.
      }
      return result;
    };
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const promise: Promise<Response> = Reflect.apply(originalFetch, this, args);
      try {
        const convId = conversationRequest(...args);
        if (convId) promise.then((res) => relay(convId, res)).catch(() => {});
      } catch {
        // Whatever goes wrong here, claude.ai gets its response as usual.
      }
      return promise;
    };
  }

  document.addEventListener(CONVERSATION_REQUEST_EVENT, () => {
    if (lastPayload) send(lastPayload);
  });

  window.__claudeOutline = Object.freeze({
    debug() {
      document.dispatchEvent(new CustomEvent(DEBUG_EVENT));
      return 'Claude Outline: report logged above.';
    },
  });
}
