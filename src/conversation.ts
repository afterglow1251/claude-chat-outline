// claude.ai's conversation response -> your questions, in order. Shared by
// the content script (its own API request) and page-bridge.ts (the response
// claude.ai's page receives). Pure: no DOM, no chrome.* APIs.
//
// The API is not public. Only the fields below are relied on.
import type { ApiQuestion } from './types';

interface ApiContent {
  type?: string;
  text?: unknown;
}

interface ApiMessage {
  uuid?: string;
  parent_message_uuid?: string;
  index?: number;
  sender?: string;
  text?: unknown;
  content?: unknown;
}

interface ApiConversation {
  chat_messages?: unknown;
  current_leaf_message_uuid?: string;
}

function messageText(m: ApiMessage): string {
  if (Array.isArray(m.content)) {
    const text = (m.content as (ApiContent | null)[])
      .filter((c): c is ApiContent & { text: string } => !!c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (text.trim()) return text;
  }
  return typeof m.text === 'string' ? m.text : '';
}

// The conversation is a tree (edits and retries create branches). The
// visible branch is the path from the current leaf up to the root.
export function parseConversation(data: unknown): ApiQuestion[] | null {
  if (!data || typeof data !== 'object') return null;
  const conv = data as ApiConversation;
  const messages = conv.chat_messages;
  if (!Array.isArray(messages)) return null;
  const byId = new Map<string, ApiMessage>(
    (messages as (ApiMessage | null)[]).filter((m): m is ApiMessage => !!m && !!m.uuid).map((m) => [m.uuid!, m])
  );
  let branch: ApiMessage[] = [];
  const leaf = conv.current_leaf_message_uuid ? byId.get(conv.current_leaf_message_uuid) : undefined;
  if (leaf) {
    const seen = new Set<string | undefined>();
    for (let m: ApiMessage | undefined = leaf; m && !seen.has(m.uuid); m = byId.get(m.parent_message_uuid ?? '')) {
      seen.add(m.uuid);
      branch.push(m);
    }
    branch.reverse();
  } else {
    branch = (messages as ApiMessage[]).toSorted((a, b) => (a.index || 0) - (b.index || 0));
  }
  // pos = 1-based position in the branch, which is what the page shows as
  // "Message <pos> of <n>" (aria-posinset) on the rendered turn.
  return branch
    .map((m, i) => ({ m, pos: i + 1 }))
    .filter(({ m }) => m.sender === 'human')
    .map(({ m, pos }) => ({ text: messageText(m), pos }));
}
