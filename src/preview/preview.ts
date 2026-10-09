// One diagram, drawn live in a sandboxed page inside the panel (see
// diagram-list.ts). The panel sends the diagram's code; this page replaces
// itself with it, so Claude's own scripts run as they do in the chat:
// a canvas animates, a chart loads its library. The sandbox (manifest.json)
// gives it no access to claude.ai, the extension or anything stored.
//
// It tells the panel how tall the drawing is, and nothing else.
import WIDGET_CSS from './widget.css';

export interface PreviewMessage {
  kind: 'widget' | 'html' | 'mermaid';
  source: string;
  theme: 'light' | 'dark';
}

const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';

// Reports the drawing's height whenever it changes, and gives the
// visualizer's widgets the sendPrompt() they call on click (a no-op here).
const REPORTER = `<script>
window.sendPrompt = function () {};
(function () {
  var last = 0;
  function report() {
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h && h !== last) { last = h; parent.postMessage({ coPreviewHeight: h }, '*'); }
  }
  addEventListener('DOMContentLoaded', function () {
    new ResizeObserver(report).observe(document.documentElement);
    report();
  });
  addEventListener('load', report);
})();
</script>`;

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function page({ kind, source, theme }: PreviewMessage): string {
  if (kind === 'html') {
    // A whole page of its own: only the reporter goes in.
    return /<head[^>]*>/i.test(source) ? source.replace(/<head[^>]*>/i, (m) => m + REPORTER) : REPORTER + source;
  }
  const head = `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${WIDGET_CSS}</style>${REPORTER}`;
  if (kind === 'mermaid') {
    return (
      `${head}<style>body { padding: 16px; } .mermaid { display: flex; justify-content: center; margin: 0; }</style></head>` +
      `<body><pre class="mermaid">${escapeHtml(source)}</pre><script src="${MERMAID}"></script>` +
      `<script>mermaid.initialize({ startOnLoad: false, theme: '${theme === 'dark' ? 'dark' : 'neutral'}' }); mermaid.run();</script></body></html>`
    );
  }
  return `${head}</head><body>${source}</body></html>`;
}

function isMessage(data: unknown): data is PreviewMessage {
  if (!data || typeof data !== 'object') return false;
  const { kind, source, theme } = data as Record<string, unknown>;
  return (
    (kind === 'widget' || kind === 'html' || kind === 'mermaid') &&
    typeof source === 'string' &&
    (theme === 'light' || theme === 'dark')
  );
}

addEventListener('message', (e) => {
  if (e.source !== parent || !isMessage(e.data)) return;
  document.open();
  document.write(page(e.data));
  document.close();
});
