// claude.ai's conversation response -> your questions, in order, and the
// diagrams in Claude's answers. Shared by the content script (its own API
// request) and page-bridge.ts (the response claude.ai's page receives).
// Pure: no DOM, no chrome.* APIs.
//
// The API is not public. Only the fields below are relied on.
import type { ApiQuestion, Diagram, DiagramKind } from '../core/types';

interface ApiContent {
  type?: string;
  text?: unknown;
  name?: unknown;
  input?: unknown;
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
function visibleBranch(data: unknown): ApiMessage[] | null {
  if (!data || typeof data !== 'object') return null;
  const conv = data as ApiConversation;
  const messages = conv.chat_messages;
  if (!Array.isArray(messages)) return null;
  const byId = new Map<string, ApiMessage>(
    (messages as (ApiMessage | null)[]).filter((m): m is ApiMessage => !!m && !!m.uuid).map((m) => [m.uuid!, m])
  );
  const leaf = conv.current_leaf_message_uuid ? byId.get(conv.current_leaf_message_uuid) : undefined;
  if (!leaf) return (messages as ApiMessage[]).toSorted((a, b) => (a.index || 0) - (b.index || 0));
  const branch: ApiMessage[] = [];
  const seen = new Set<string | undefined>();
  for (let m: ApiMessage | undefined = leaf; m && !seen.has(m.uuid); m = byId.get(m.parent_message_uuid ?? '')) {
    seen.add(m.uuid);
    branch.push(m);
  }
  return branch.toReversed();
}

export function parseConversation(data: unknown): ApiQuestion[] | null {
  const branch = visibleBranch(data);
  if (!branch) return null;
  // pos = 1-based position in the branch, which is what the page shows as
  // "Message <pos> of <n>" (aria-posinset) on the rendered turn.
  return branch
    .map((m, i) => ({ m, pos: i + 1 }))
    .filter(({ m }) => m.sender === 'human')
    .map(({ m, pos }) => ({ text: messageText(m), pos }));
}

// ---------------------------------------------------------------------------
// Diagrams: tool calls in Claude's answers that draw something.
// ---------------------------------------------------------------------------

const ARTIFACT_KINDS: Record<string, DiagramKind> = {
  'image/svg+xml': 'svg',
  'application/vnd.ant.mermaid': 'mermaid',
  'text/html': 'html',
  'application/vnd.ant.react': 'react',
};
const FILE_KINDS: Record<string, DiagramKind> = { svg: 'svg', mmd: 'mermaid', mermaid: 'mermaid' };
const UNTITLED: Record<DiagramKind, string> = {
  svg: 'Drawing',
  mermaid: 'Mermaid chart',
  html: 'HTML page',
  react: 'React component',
};

type Input = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// An artifact: created once, then possibly updated (a find-and-replace on
// its last version) or rewritten, by id. Updates may leave out the type and
// title, which carry over.
function artifact(input: Input, prev: Diagram | undefined): Omit<Diagram, 'question'> | null {
  let source = str(input.content);
  if (input.command === 'update') {
    if (!prev) return null;
    const from = str(input.old_str);
    source = from ? prev.source.replace(from, () => str(input.new_str)) : prev.source;
  }
  const kind = ARTIFACT_KINDS[str(input.type)] ?? prev?.kind;
  if (!kind || !source.trim()) return null;
  return { kind, title: str(input.title) || prev?.title || UNTITLED[kind], source };
}

// A file Claude wrote (SVG or Mermaid only: its other files are not drawings).
function file(input: Input): Omit<Diagram, 'question'> | null {
  const path = str(input.path);
  const kind = FILE_KINDS[path.split('.').pop()?.toLowerCase() ?? ''];
  const source = str(input.file_text) || str(input.content);
  if (!kind || !source.trim()) return null;
  return { kind, title: path.split('/').pop() || UNTITLED[kind], source };
}

// Any other tool that drew an SVG inline (possibly wrapped in some HTML):
// its first complete <svg> element. Not tools that edit files or run code,
// whose SVG is file content or a script, not something shown in the chat.
const NOT_DRAWING = /bash|repl|str_replace|edit|file/i;
function drawing(input: Input, name: string): Omit<Diagram, 'question'> | null {
  if (NOT_DRAWING.test(name) || 'path' in input) return null;
  for (const value of Object.values(input)) {
    const text = str(value);
    const start = text.search(/<svg[\s>]/);
    const end = start < 0 ? -1 : text.indexOf('</svg>', start);
    if (end < 0) continue;
    return { kind: 'svg', title: str(input.title) || UNTITLED.svg, source: text.slice(start, end + 6) };
  }
  return null;
}

/**
 * Claude's diagrams on the visible branch, in chat order. An artifact
 * changed later in the chat is listed once, where its last version is.
 */
export function parseDiagrams(data: unknown): Diagram[] | null {
  const branch = visibleBranch(data);
  if (!branch) return null;
  const diagrams: Diagram[] = [];
  const artifacts = new Map<string, Diagram>();
  let question = -1;
  for (const m of branch) {
    if (!m) continue;
    if (m.sender === 'human') question++;
    if (m.sender !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const c of m.content as (ApiContent | null)[]) {
      if (!c || c.type !== 'tool_use' || !c.input || typeof c.input !== 'object') continue;
      const input = c.input as Input;
      const id = c.name === 'artifacts' ? str(input.id) : '';
      const prev = id ? artifacts.get(id) : undefined;
      const found =
        c.name === 'artifacts'
          ? artifact(input, prev)
          : c.name === 'create_file'
            ? file(input)
            : drawing(input, str(c.name));
      if (!found) continue;
      const diagram = { ...found, question: Math.max(question, 0) };
      if (prev) diagrams.splice(diagrams.indexOf(prev), 1);
      if (id) artifacts.set(id, diagram);
      diagrams.push(diagram);
    }
  }
  return diagrams;
}
