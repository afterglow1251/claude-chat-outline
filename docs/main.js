// Page behaviour: links, reveal on scroll, small touches. The demo player
// lives in demo.js.

const REPO = 'https://github.com/afterglow1251/claude-chat-outline';
const DOWNLOAD = `${REPO}/releases/latest/download/claude-chat-outline.zip`;

document.documentElement.classList.add('js');

for (const a of document.querySelectorAll('[data-repo]')) a.href = REPO;
for (const a of document.querySelectorAll('[data-download]')) a.href = DOWNLOAD;

// Ctrl instead of Cmd off the Mac.
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
if (!isMac) {
  for (const k of document.querySelectorAll('[data-mod]')) k.textContent = 'Ctrl';
  for (const k of document.querySelectorAll('[data-mod-text]')) k.textContent = 'Ctrl';
}

// Reveal blocks as they scroll into view, once.
const revealer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      revealer.unobserve(e.target);
    }
  },
  { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
);
for (const el of document.querySelectorAll('.reveal')) revealer.observe(el);

// Click to copy chrome://extensions (links to it can't be opened from a page).
for (const el of document.querySelectorAll('[data-copy]')) {
  el.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.dataset.copy);
      const text = el.textContent;
      el.classList.add('copied');
      el.textContent = 'Copied';
      setTimeout(() => {
        el.classList.remove('copied');
        el.textContent = text;
      }, 1200);
    } catch {
      /* clipboard blocked: the text is still there to select */
    }
  });
}

// "What's on the page" vs "What Chat Outline lists": 232 questions as 64
// cells. claude.ai keeps roughly the latest few dozen on the page.
const compare = document.querySelector('[data-compare]');
if (compare) {
  const CELLS = 64;
  const TOTAL = 232;
  const ON_PAGE = 40; // illustrative: the latest few dozen
  const pageLit = Math.round((ON_PAGE / TOTAL) * CELLS);
  const fill = (name) => {
    const box = compare.querySelector(`[data-bars="${name}"]`);
    for (let i = 0; i < CELLS; i++) box.appendChild(document.createElement('i'));
    return [...box.children];
  };
  const page = fill('page');
  const ours = fill('ours');
  const oursCount = compare.querySelector('[data-count="ours"]');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const play = () => {
    const start = performance.now();
    const DUR = reduced ? 0 : 1600;
    const step = (now) => {
      const p = DUR ? Math.min(1, (now - start) / DUR) : 1;
      const e = 1 - Math.pow(1 - p, 3);
      // The page fills from the end (the latest messages), ours from the top.
      const litPage = Math.round(e * pageLit);
      page.forEach((c, i) => c.classList.toggle('lit', i >= CELLS - litPage));
      const litOurs = Math.round(e * CELLS);
      ours.forEach((c, i) => c.classList.toggle('lit', i < litOurs));
      oursCount.textContent = Math.round(e * TOTAL);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  new IntersectionObserver(
    (entries, obs) => {
      if (!entries[0].isIntersecting) return;
      obs.disconnect();
      play();
    },
    { threshold: 0.4 }
  ).observe(compare);
}
