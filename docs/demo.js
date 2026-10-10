// The demo player: a mock claude.ai chat with the Questions panel, driven by
// a timeline. Every frame is a pure function of the time t, so the player
// can be scrubbed forward and back and always shows the right state.

(() => {
  const player = document.querySelector('[data-player]');
  if (!player) return;
  const stage = player.querySelector('[data-stage]');
  const box = player.querySelector('.stage-box');
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ----- the chat ------------------------------------------------------------

  const CHAT = [
    {
      q: 'Help me plan a habit tracker app. What should the first version include?',
      a: 'Keep it to three things: create a habit, check it off for today, and see the current streak. Reminders, stats and sharing can wait until people actually use the core loop.',
      diagram: 'flow',
    },
    {
      q: 'SQLite or Postgres for a side project like this?',
      a: 'SQLite. One file, no server, and it handles far more traffic than a habit tracker will see. Move to Postgres when you need several app servers writing at once.',
    },
    {
      q: 'Write the schema for habits and daily check-ins',
      a: 'Two tables are enough. A check-in is one row per habit per day, so a unique index keeps double taps from counting twice.',
      code: 'create table checkins (\n  habit_id integer references habits(id),\n  day      date not null,\n  unique (habit_id, day)\n);',
      diagram: 'tables',
    },
    {
      q: 'How do I calculate a streak that survives time zones?',
      a: "Store the user's day, not a timestamp. Convert to their local date when they check in, then count consecutive dates backwards from today.",
    },
    {
      q: 'I love Claude for this. Is Redis worth it just for caching the dashboard?',
      a: "Not yet. The dashboard is a handful of indexed queries per user. Add a cache when a profiler tells you to, and an in-process one will probably do.",
    },
    {
      q: 'Explain this error: relation "checkins" does not exist',
      a: 'The query ran before the migration did. Run migrations on startup, or check that the test database is created from the same schema file.',
    },
    {
      q: 'Write a FastAPI endpoint that marks a habit as done today',
      a: 'The insert ignores conflicts, so tapping twice is harmless and the endpoint stays idempotent.',
      code: '@app.post("/habits/{id}/done")\ndef done(id: int, user=Depends(current_user)):\n    db.mark_done(id, user.today())\n    return {"ok": True}',
    },
    {
      q: 'Should the frontend use one store or several?',
      a: 'One store with a slice per screen. The data is small and mostly shared: the streak shows on the list, the detail page and the widget.',
    },
    {
      q: 'Redis vs an in-memory LRU for rate limiting the API?',
      a: 'With a single server, the in-memory LRU is simpler and just as correct. Redis only earns its place once requests are spread across machines.',
    },
    {
      q: 'Make the streak counter animate when it goes up',
      a: 'Animate the number with a short spring on transform only, and skip it when the user prefers reduced motion.',
    },
    {
      q: 'Write tests for the streak calculation',
      a: 'Cover a gap of one day, a check-in just before and after midnight, a daylight saving change, and a brand new habit with no check-ins.',
    },
    {
      q: 'Summarize the decisions we made so far',
      a: 'SQLite with a check-ins table keyed by local date, a FastAPI backend, one frontend store, no Redis until it is needed, and tests around the streak edge cases.',
    },
  ];
  const N = CHAT.length;

  // The diagrams Claude drew in its answers, as small inline visuals (teal
  // and coral boxes, like claude.ai's), and how the Diagrams view lists them.
  const dgBox = (cls, x, y, w, h, lines) =>
    `<g class="${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>` +
    lines.map(([text, sub], k) => `<text class="${sub ? 'dg-ts' : 'dg-th'}" x="${x + w / 2}" y="${y + 22 + k * 20}">${text}</text>`).join('') +
    '</g>';
  const dgArrow = (x1, x2, y) => `<path class="dg-arr" d="M${x1} ${y}H${x2}M${x2 - 6} ${y - 5}L${x2} ${y}L${x2 - 6} ${y + 5}"/>`;
  const DIAGRAMS = {
    flow: {
      title: 'First version',
      svg: `<svg viewBox="0 0 520 70">${dgBox('c-teal', 4, 7, 140, 56, [['Create a habit'], ['one tap', 1]])}${dgArrow(150, 184, 35)}${dgBox('c-teal', 190, 7, 140, 56, [['Check in today'], ['once a day', 1]])}${dgArrow(336, 370, 35)}${dgBox('c-coral', 376, 7, 140, 56, [['See the streak'], ['days in a row', 1]])}</svg>`,
    },
    tables: {
      title: 'Habits and check-ins',
      svg: `<svg viewBox="0 0 520 96">${dgBox('c-teal', 70, 8, 150, 80, [['habits'], ['id', 1], ['name', 1]])}${dgArrow(226, 294, 48)}<text class="dg-ts dg-on" x="260" y="34">one to many</text>${dgBox('c-coral', 300, 8, 150, 80, [['checkins'], ['habit_id', 1], ['day', 1]])}</svg>`,
    },
  };
  const DRAWN = CHAT.map((m, i) => ({ ...m, i })).filter((m) => m.diagram);
  // The code blocks Claude wrote, with a language for the Code view.
  const CODED = CHAT.map((m, i) => ({ ...m, i })).filter((m) => m.code);
  const LANG = { 2: 'sql', 6: 'python' };
  // What the Starred overview can show, in chat order: a diagram, a
  // question, a code block, a question (whichever of them are starred).
  const STARRABLE = [
    { kind: 'diagram', i: 2, d: 1 },
    { kind: 'question', i: 4 },
    { kind: 'code', i: 6, c: 1 },
    { kind: 'question', i: 8 },
  ];

  // ----- the timeline --------------------------------------------------------

  const mod = isMac ? '⌘' : 'Ctrl';
  // In play order. Each chapter starts where the one before it ends: the
  // chat, the stars, the view and the cursor carry over, so the
  // whole demo is one take. The last one ends as the first begins (panel
  // hidden, question 10), so the loop has no seam either.
  const CHAPTERS = [
    { id: 'panel', title: 'Every question in one panel', dur: 3.4 },
    { id: 'click', title: 'Click to jump, then read on', dur: 5.6 },
    { id: 'star', title: 'Star the ones that matter', dur: 3.6 },
    { id: 'search', title: 'Search your questions', dur: 4.6 },
    { id: 'unloaded', title: "Reach what isn't loaded yet", dur: 5.2 },
    { id: 'diagrams', title: 'Every diagram, with a preview', dur: 5.4 },
    { id: 'code', title: 'Every code block, one click to copy', dur: 5.8 },
    { id: 'starred', title: 'Everything starred, in one list', dur: 4.4 },
    { id: 'hide', title: `${mod} Shift O to hide`, dur: 3.8 },
  ];
  let acc = 0;
  for (const c of CHAPTERS) {
    c.start = acc;
    acc += c.dur;
  }
  const TOTAL = acc;

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const inOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const out = (p) => 1 - Math.pow(1 - p, 3);
  const lerp = (a, b, p) => a + (b - a) * p;

  // Cursor path: [time, target] keyframes; it eases between them.
  function cursorPath(t, keys) {
    if (t <= keys[0][0]) return { from: keys[0][1], to: keys[0][1], p: 1 };
    for (let i = 1; i < keys.length; i++) {
      const [t1, to] = keys[i];
      const [t0, from] = keys[i - 1];
      if (t < t1) return { from, to, p: inOut(seg(t, t0, t1)) };
    }
    return { from: keys[keys.length - 1][1], to: keys[keys.length - 1][1], p: 1 };
  }
  const clickAt = (t, times) => times.find((c) => t >= c && t < c + 0.45);

  // The state of the scene at time t: the story so far, played chapter by
  // chapter up to t. Each chapter changes what it is about and leaves the
  // rest as the one before left it.
  function initial() {
    return {
      chapter: 0,
      panel: 0, // 1 shown, 0 collapsed to the tab
      listIn: 1, // the list's entrance
      chatPos: 9.25, // question at the top of the chat, fractional
      active: 9,
      filter: '',
      focusFilter: false,
      stars: [],
      unloadedBelow: 0, // questions before this index aren't loaded
      diagrams: false, // the panel shows the Diagrams view
      code: false, // the panel shows the Code view
      starred: false, // the Starred overview is open
      previews: 0, // the diagrams' previews: 0 shimmering to 1 drawn
      toDiagram: null, // { index, p }: the chat scrolled on to diagram `index` (p: 0 to 1)
      toCode: null, // { index, p }: the same for a code block
      dStars: [], // starred diagrams (indices in DRAWN)
      cStars: [], // starred code blocks (indices in CODED)
      cursorEnd: 'rest', // where the cursor was left
    };
  }

  // What lasts only while it happens: reset at the start of every chapter.
  function moment(s) {
    Object.assign(s, {
      hover: -1,
      dHover: -1, // the diagram row under the cursor
      cHover: -1,
      sHover: -1,
      cCopied: 0, // the copy button of code row 1 shows "copied"
      keys: 0,
      keysDown: false,
      caps: [mod, '⇧', 'O'], // the keys shown
      listUp: 0, // 0: the list follows the active row; 1: scrolled to its top
      wheel: false,
      wheelUp: false,
      loading: 0,
      click: undefined,
      flash: null, // { index, at }: the jump highlight, started at chapter time `at`
      dFlash: null,
      cFlash: null,
    });
  }

  // The cursor moves from where the last chapter left it.
  function move(s, t, keys) {
    const path = [[0, s.cursorEnd], ...keys];
    s.cursor = cursorPath(t, path);
    s.cursorEnd = path[path.length - 1][1];
  }

  // A shortcut pressed at `at`: its keys show a moment around it.
  function press(s, t, at, caps) {
    if (t >= at - 0.4 && t < at + 0.5) {
      s.keys = 1;
      s.caps = caps;
    }
    if (t >= at - 0.1 && t < at + 0.2) s.keysDown = true;
  }

  const STORY = {
    panel(s, t) {
      // ⌘⇧O: the panel slides in and the list fills.
      move(s, t, []);
      press(s, t, 0.5, [mod, '⇧', 'O']);
      s.panel = out(seg(t, 0.5, 1.0));
      s.listIn = seg(t, 0.9, 2.3);
    },

    click(s, t) {
      // Question 3 is above what the list shows (it follows question 10):
      // scroll the list up to it, click, then read on with the list
      // following, down to question 5.
      const click = 2.0;
      const read = 3.5;
      move(s, t, [[0.6, 'list'], [1.4, 'list'], [1.8, 'item:2'], [2.3, 'item:2'], [2.9, 'chat']]);
      s.wheel = (t > 0.6 && t < 1.4) || (t > read - 0.2 && t < 5.4);
      s.wheelUp = t < read;
      s.listUp = inOut(seg(t, 0.7, 1.3));
      s.hover = t > 1.6 && t < 2.6 ? 2 : -1;
      s.click = clickAt(t, [click]);
      if (t >= click) {
        s.active = 2;
        s.chatPos = lerp(9.25, 2, inOut(seg(t, click + 0.05, click + 1.0)));
        s.flash = { index: 2, at: click + 0.8 };
      }
      if (t >= read) {
        s.chatPos = lerp(2, 4, inOut(seg(t, read, 5.4)));
        s.active = Math.floor(s.chatPos + 0.2);
      }
    },

    star(s, t) {
      // Star the question being read, and one further down.
      move(s, t, [[0.6, 'star:4'], [1.0, 'star:4'], [1.5, 'star:8'], [2.1, 'star:8'], [2.8, 'list']]);
      s.click = clickAt(t, [0.75, 1.75]);
      s.hover = t > 0.3 && t < 1.3 ? 4 : t >= 1.3 && t < 2.4 ? 8 : -1;
      s.stars = [...(t >= 0.75 ? [4] : []), ...(t >= 1.75 ? [8] : [])];
    },

    search(s, t) {
      // Type a word, pick a match, Esc for the whole list again.
      const word = 'redis';
      const pick = 2.6;
      const esc = 4.0;
      move(s, t, [[0.6, 'filter'], [1.9, 'filter'], [2.4, 'item:8'], [2.8, 'item:8'], [3.3, 'chat']]);
      s.click = clickAt(t, [0.7, pick]);
      s.focusFilter = t >= 0.7 && t < esc;
      s.filter = t >= esc ? '' : word.slice(0, Math.floor(seg(t, 0.9, 1.6) * word.length + 0.001));
      s.hover = t > 2.2 && t < 3.0 ? 8 : -1;
      if (t >= pick) {
        s.active = 8;
        s.chatPos = lerp(4, 8, inOut(seg(t, pick + 0.05, pick + 1.0)));
        s.flash = { index: 8, at: pick + 0.8 };
      }
      press(s, t, esc, ['esc']);
    },

    unloaded(s, t) {
      // A long chat: the early questions aren't on the page. The list
      // has them anyway: scroll it up to question 1 and click.
      s.unloadedBelow = 6;
      const click = 1.9;
      const loaded = click + 1.0;
      move(s, t, [[0.5, 'list'], [1.3, 'list'], [1.7, 'item:0']]);
      s.wheel = t > 0.5 && t < 1.3;
      s.wheelUp = true;
      s.listUp = inOut(seg(t, 0.6, 1.2));
      s.hover = t > 1.5 ? 0 : -1;
      s.click = clickAt(t, [click]);
      if (t >= click) {
        s.active = 0;
        s.loading = seg(t, click, click + 0.2) * (1 - seg(t, loaded, loaded + 0.25));
        if (t >= loaded) s.unloadedBelow = 0;
        s.chatPos = lerp(8, 0, inOut(seg(t, loaded, loaded + 1.2)));
        if (t >= loaded) s.flash = { index: 0, at: loaded + 1.0 };
      }
    },

    diagrams(s, t) {
      // Open Diagrams, watch the previews draw, star one, jump to it.
      const open = 0.7;
      const star = 1.9;
      const pick = 2.9;
      move(s, t, [[0.5, 'vopt:1'], [1.2, 'vopt:1'], [1.7, 'dstar:1'], [2.2, 'dstar:1'], [2.7, 'drow:1']]);
      s.click = clickAt(t, [open, star, pick]);
      s.diagrams = t >= open;
      s.previews = out(seg(t, open + 0.4, open + 0.8));
      s.dHover = t > 1.4 ? 1 : -1;
      s.dStars = t >= star ? [1] : [];
      if (t >= pick) {
        s.active = 2;
        s.toDiagram = { index: 1, p: inOut(seg(t, pick + 0.05, pick + 1.0)) };
        s.dFlash = { index: 1, at: pick + 0.8 };
      }
    },

    code(s, t) {
      // Open Code, copy a block, star it, jump to it.
      const open = 0.7;
      const copy = 1.7;
      const star = 2.6;
      const pick = 3.5;
      move(s, t, [[0.5, 'vopt:2'], [1.1, 'vopt:2'], [1.5, 'ccopy:1'], [2.1, 'ccopy:1'], [2.4, 'cstar:1'], [2.9, 'cstar:1'], [3.3, 'crow:1']]);
      s.click = clickAt(t, [open, copy, star, pick]);
      if (t >= open) {
        s.diagrams = false;
        s.code = true;
      }
      s.cHover = t > 1.3 ? 1 : -1;
      s.cCopied = t >= copy && t < copy + 1.2 ? 1 : 0;
      s.cStars = t >= star ? [1] : [];
      if (t >= pick) {
        // From the diagram on to the block: underneath, the chat moves to its question.
        s.active = 6;
        s.chatPos = 6;
        s.toCode = { index: 1, p: inOut(seg(t, pick + 0.05, pick + 1.0)) };
        if (s.toCode.p >= 1) s.toDiagram = null;
        s.cFlash = { index: 1, at: pick + 0.8 };
      }
    },

    starred(s, t) {
      // ☆ opens everything starred so far; jump from it to a question.
      const open = 0.6;
      const pick = 1.8;
      move(s, t, [[0.4, 'starBtn'], [0.9, 'starBtn'], [1.6, 'srow:3']]);
      s.click = clickAt(t, [open, pick]);
      s.starred = t >= open;
      s.sHover = t > 1.3 ? 3 : -1;
      if (t >= pick) {
        // Back from the code block to question 9.
        s.active = 8;
        s.chatPos = 8;
        const p = inOut(seg(t, pick + 0.05, pick + 1.0));
        s.toCode = p < 1 ? { index: 1, p: 1 - p } : null;
        s.flash = { index: 8, at: pick + 0.8 };
      }
    },

    hide(s, t) {
      // ⌘⇧O again: the panel goes and reading goes on. Out of sight, the
      // panel goes back to how the demo began.
      const hide = 0.6;
      move(s, t, [[0.4, 'chat'], [3.4, 'rest']]);
      press(s, t, hide, [mod, '⇧', 'O']);
      s.panel = 1 - out(seg(t, hide, hide + 0.4));
      if (t >= hide + 0.5) Object.assign(s, { starred: false, code: false, diagrams: false, stars: [], dStars: [], cStars: [] });
      s.chatPos = lerp(8, 9.25, inOut(seg(t, 1.2, 3.6)));
      s.active = Math.floor(s.chatPos + 0.2);
    },
  };

  function stateAt(T) {
    const ci = chapterAt(T);
    const s = initial();
    for (let i = 0; i <= ci; i++) {
      s.chapter = i;
      moment(s);
      STORY[CHAPTERS[i].id](s, i < ci ? CHAPTERS[i].dur : T - CHAPTERS[i].start);
    }
    return s;
  }

  function chapterAt(T) {
    for (let i = CHAPTERS.length - 1; i >= 0; i--) if (T >= CHAPTERS[i].start) return i;
    return 0;
  }

  // ----- the scene -----------------------------------------------------------

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>';

  // claude.ai's sidebar and header icons, simplified.
  const svg = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    sidebar: svg('M2.5 3h11v10h-11zM6 3v10'),
    search: svg('M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.5 10.5l3 3'),
    plus: svg('M8 3v10M3 8h10'),
    projects: svg('M3 5.5h10v7.5H3zM4.5 3h7M5.5 8h5'),
    artifacts: svg('M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z'),
    more: svg('m6 4 4 4-4 4'),
    chevron: svg('m4.5 6.5 3.5 3.5 3.5-3.5'),
  };

  stage.innerHTML = `
    <div class="s-window">
      <div class="s-bar">
        <span class="s-dots"><i></i><i></i><i></i></span>
        <span class="s-url"><svg viewBox="0 0 16 16"><path d="M5 7V5a3 3 0 0 1 6 0v2M4 7h8v6H4z"/></svg>claude.ai/chat/habit-tracker</span>
      </div>
      <div class="s-app">
        <aside class="s-side">
          <div class="s-brand"><i class="s-ico">${ICON.sidebar}</i><span>Claude</span></div>
          <div class="s-search"><i class="s-ico">${ICON.search}</i>Search</div>
          <p class="s-nav"><i class="s-ico">${ICON.plus}</i>New</p>
          <p class="s-nav"><i class="s-ico">${ICON.projects}</i>Projects</p>
          <p class="s-nav"><i class="s-ico">${ICON.artifacts}</i>Artifacts</p>
          <p class="s-nav"><i class="s-ico">${ICON.more}</i>More</p>
          <p class="s-side-h">Today</p>
          <p class="s-side-i">Habit tracker app</p>
          <p class="s-side-i">Trip to Lisbon</p>
          <p class="s-side-h">Yesterday</p>
          <p class="s-side-i">Postgres indexes</p>
          <p class="s-side-i">Cover letter draft</p>
          <p class="s-side-i">Sourdough timing</p>
        </aside>
        <section class="s-main">
          <header class="s-head"><span class="s-title">Habit tracker app</span><i class="s-ico">${ICON.chevron}</i></header>
          <div class="s-view">
            <div class="s-feed">
              ${CHAT.map(
                (m, i) => `
                <div class="s-turn" data-turn="${i}">
                  <div class="s-user">${esc(m.q)}<span class="s-flash"><span></span></span></div>
                  <div class="s-answer"><p>${esc(m.a)}</p>${m.diagram ? `<div class="s-diagram">${DIAGRAMS[m.diagram].svg}<span class="s-flash"><span></span></span></div>` : ''}${m.code ? `<div class="s-code"><pre>${esc(m.code)}</pre><span class="s-flash"><span></span></span></div>` : ''}</div>
                </div>`
              ).join('')}
              <div class="s-tail"></div>
            </div>
            <div class="s-loader"><span class="s-spin"></span>Loading earlier messages…</div>
            <div class="s-input">Reply</div>
          </div>
        </section>
      </div>

      <div class="s-panel">
        <div class="s-ph"><b>Questions</b><span>${N}</span>
          <span class="s-views">${[
            'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
            'M4 4h7v7H4zM14 7.5a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M7.5 14L4 20h7zM14 14h7v7h-7z',
            'M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16',
          ]
            .map((d) => `<i class="s-vopt"><svg viewBox="0 0 24 24"><path d="${d}"/></svg></i>`)
            .join('')}</span>
          <i class="s-ic"><svg viewBox="0 0 16 16"><path d="M2.5 3h11v10h-11zM9 3v10"/></svg></i>
          <i class="s-ic"><svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"/></svg></i>
        </div>
        <div class="s-tools">
          <div class="s-filter"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg><span class="s-ftext"></span><span class="s-caret"></span><span class="s-ph-text">Filter questions…</span></div>
          <div class="s-starbtn">${STAR}</div>
        </div>
        <ol class="s-list">
          ${CHAT.map(
            (m, i) => `<li data-row="${i}"><span class="s-num">${i + 1}.</span><span class="s-label">${esc(m.q)}</span><span class="s-star">${STAR}</span></li>`
          ).join('')}
        </ol>
        <p class="s-empty">No questions match.</p>
        <ol class="s-dlist">
          ${DRAWN.map(
            (m) => `<li><div class="s-dprev"><i class="s-shimmer"></i>${DIAGRAMS[m.diagram].svg}</div><div class="s-dline"><div><b>${esc(DIAGRAMS[m.diagram].title)}</b><span>Question ${m.i + 1}</span></div><span class="s-star">${STAR}</span></div></li>`
          ).join('')}
        </ol>
        <ol class="s-clist">
          ${CODED.map(
            (m) => `<li><div class="s-chead"><b>${LANG[m.i]}</b><span>Question ${m.i + 1}</span><i class="s-copy"><svg class="i-copy" viewBox="0 0 24 24"><path d="M9 9h10v10H9zM5 15V5h10"/></svg><svg class="i-tick" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></i><span class="s-star">${STAR}</span></div><pre>${esc(m.code)}</pre></li>`
          ).join('')}
        </ol>
        <div class="s-sview">
          <div class="s-chips"><i class="on">All <b>4</b></i><i>Questions <b>2</b></i><i>Diagrams <b>1</b></i><i>Code <b>1</b></i></div>
          <ol class="s-slist">
            ${STARRABLE.map((r) => {
              if (r.kind === 'question') return `<li class="s-sq"><span class="s-num">${r.i + 1}.</span><span class="s-label">${esc(CHAT[r.i].q)}</span><span class="s-star">${STAR}</span></li>`;
              if (r.kind === 'diagram') return `<li class="s-sd"><div class="s-dprev">${DIAGRAMS[CHAT[r.i].diagram].svg}</div><div class="s-dline"><div><b>${esc(DIAGRAMS[CHAT[r.i].diagram].title)}</b><span>Question ${r.i + 1}</span></div><span class="s-star">${STAR}</span></div></li>`;
              return `<li class="s-sc"><div class="s-chead"><b>${LANG[r.i]}</b><span>Question ${r.i + 1}</span><i class="s-copy"><svg class="i-copy" viewBox="0 0 24 24"><path d="M9 9h10v10H9zM5 15V5h10"/></svg></i><span class="s-star">${STAR}</span></div><pre>${esc(CHAT[r.i].code)}</pre></li>`;
            }).join('')}
          </ol>
        </div>
      </div>
      <div class="s-tab"><svg viewBox="0 0 16 16"><path d="m10 3-5 5 5 5"/></svg><span>Outline</span></div>

      <div class="s-keys"><kbd>${isMac ? '⌘' : 'Ctrl'}</kbd><kbd>⇧</kbd><kbd>O</kbd></div>
      <div class="s-cursor"><svg viewBox="0 0 24 24"><path d="M5 3l14 8-6.2 1.5L9.6 19z"/></svg><span class="s-ripple"></span></div>
      <div class="s-wheel"></div>
    </div>`;

  const $ = (sel) => stage.querySelector(sel);
  const view = $('.s-view');
  const feed = $('.s-feed');
  const turns = [...stage.querySelectorAll('[data-turn]')];
  const rows = [...stage.querySelectorAll('[data-row]')];
  const flashes = [...stage.querySelectorAll('.s-user .s-flash')]; // the questions' own, not the diagrams'
  const list = $('.s-list');
  const panel = $('.s-panel');
  const tab = $('.s-tab');
  const ftext = $('.s-ftext');
  const filterBox = $('.s-filter');
  const starBtn = $('.s-starbtn');
  const loader = $('.s-loader');
  const sideItems = [...stage.querySelectorAll('.s-side-i')];
  const count = $('.s-ph span');
  const keys = $('.s-keys');
  const cursor = $('.s-cursor');
  const ripple = $('.s-ripple');
  const wheel = $('.s-wheel');
  const empty = $('.s-empty');
  const heading = $('.s-ph b');
  const phText = $('.s-ph-text');
  const views = $('.s-views');
  const vopts = [...stage.querySelectorAll('.s-vopt')];
  const dRows = [...stage.querySelectorAll('.s-dlist li')];
  const dShimmers = [...stage.querySelectorAll('.s-shimmer')];
  const dPreviews = dRows.map((r) => r.querySelector('svg'));
  const dInChat = [...stage.querySelectorAll('.s-diagram')];
  const dFlashes = dInChat.map((d) => d.querySelector('.s-flash'));
  const cRows = [...stage.querySelectorAll('.s-clist li')];
  const cInChat = [...stage.querySelectorAll('.s-code')];
  const cFlashes = cInChat.map((d) => d.querySelector('.s-flash'));
  const sRows = [...stage.querySelectorAll('.s-slist li')];

  // ----- layout --------------------------------------------------------------

  let scale = 1;
  const fit = () => {
    scale = box.clientWidth / 1120;
    stage.style.transform = `scale(${scale})`;
  };
  new ResizeObserver(fit).observe(box);
  fit();

  // Position of an element's point relative to the stage, unscaled.
  function pointOf(el, fx = 0.5, fy = 0.5) {
    const s = stage.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: (r.left - s.left + r.width * fx) / scale, y: (r.top - s.top + r.height * fy) / scale };
  }
  function target(name) {
    if (name === 'rest') return { x: 640, y: 560 };
    if (name === 'chat') return { x: 600, y: 380 };
    if (name === 'filter') return pointOf(filterBox, 0.35, 0.55);
    if (name === 'list') return pointOf(list, 0.5, 0.45);
    if (name === 'starBtn') return pointOf(starBtn, 0.5, 0.55);
    const [kind, i] = name.split(':');
    if (kind === 'drow') return pointOf(dRows[+i].firstChild, 0.45, 0.55);
    if (kind === 'vopt') return pointOf(vopts[+i], 0.5, 0.55);
    if (kind === 'crow') return pointOf(cRows[+i].querySelector('pre'), 0.4, 0.5);
    if (kind === 'ccopy') return pointOf(cRows[+i].querySelector('.s-copy'), 0.5, 0.5);
    if (kind === 'cstar') return pointOf(cRows[+i].querySelector('.s-star'), 0.5, 0.5);
    if (kind === 'dstar') return pointOf(dRows[+i].querySelector('.s-star'), 0.5, 0.5);
    if (kind === 'srow') return pointOf(sRows[+i].querySelector('pre, .s-dprev, .s-label'), 0.4, 0.5);
    const row = rows[+i];
    if (kind === 'item') return pointOf(row.querySelector('.s-label'), 0.3, 0.6);
    if (kind === 'star') return pointOf(row.querySelector('.s-star'), 0.5, 0.55);
    return { x: 600, y: 400 };
  }

  // Top of each turn in the feed, measured (they differ in height).
  let tops = [];
  let dTops = []; // the diagrams in the chat, from the feed's top
  let cTops = []; // the code blocks in the chat, from the feed's top
  const measure = () => {
    tops = turns.map((el) => el.offsetTop);
    dTops = dInChat.map((el) => el.offsetTop);
    cTops = cInChat.map((el) => el.offsetTop);
  };

  // ----- render --------------------------------------------------------------

  let listScroll = 0;
  let lastShown = ''; // which rows were shown: when it changes the list jumps, it doesn't glide
  let lastT = -1;

  function render(T, smooth) {
    const s = stateAt(T);

    // Chat scroll: interpolate between measured tops of questions.
    if (!tops.length) measure();
    const i = Math.floor(s.chatPos);
    const f = s.chatPos - i;
    const y0 = tops[clamp(i, 0, N - 1)];
    const y1 = i + 1 < N ? tops[i + 1] : y0;
    let scrollY = lerp(y0, y1, f) - 24;
    // Jumping to a diagram: on past its question, to the diagram itself.
    if (s.toDiagram) scrollY = lerp(scrollY, dTops[s.toDiagram.index] - 24, s.toDiagram.p);
    if (s.toCode) scrollY = lerp(scrollY, cTops[s.toCode.index] - 24, s.toCode.p);
    feed.style.transform = `translateY(${-scrollY}px)`;
    turns.forEach((el, k) => el.classList.toggle('gone', k < s.unloadedBelow));
    // The "here it is" ring, timed like the extension's: fade in, hold
    // while a light sweeps across, slow fade out; 1.8s in all.
    const local = T - CHAPTERS[s.chapter].start;
    const ring = (el, flash, k) => {
      const ms = flash && flash.index === k ? (local - flash.at) * 1000 : -1;
      if (ms < 0 || ms > 1800) {
        el.style.opacity = 0;
        return;
      }
      const p = ms / 1800;
      el.style.opacity = p < 0.12 ? out(p / 0.12) : p < 0.7 ? 1 : 1 - inOut((p - 0.7) / 0.3);
      const sweep = clamp((ms - 150) / 1100);
      el.firstChild.style.transform = `translateX(${lerp(-100, 100, inOut(sweep))}%)`;
    };
    flashes.forEach((el, k) => ring(el, s.flash, k));
    dFlashes.forEach((el, k) => ring(el, s.dFlash, k));
    cFlashes.forEach((el, k) => ring(el, s.cFlash, k));
    loader.style.opacity = s.loading;
    // The sidebar marks this chat.
    sideItems.forEach((el, k) => el.classList.toggle('on', k === 0));
    // Questions or Diagrams in the panel. Previews shimmer, then the
    // drawing fades in over the shimmer, like the extension's.
    panel.classList.toggle('dview', s.diagrams && !s.starred);
    panel.classList.toggle('cview', s.code && !s.starred);
    panel.classList.toggle('sview', s.starred);
    // The view switcher: the current view's icon in accent.
    vopts.forEach((el, k) => el.classList.toggle('on', k === (s.code ? 2 : s.diagrams ? 1 : 0)));
    const starredN = s.stars.length + s.dStars.length + s.cStars.length;
    heading.textContent = s.starred ? 'Starred' : s.code ? 'Code' : s.diagrams ? 'Diagrams' : 'Questions';
    phText.textContent = `Filter ${s.starred ? 'starred' : s.code ? 'code' : s.diagrams ? 'diagrams' : 'questions'}…`;
    count.textContent = s.starred ? starredN : s.code ? CODED.length : s.diagrams ? DRAWN.length : N;
    // The diagrams and code in the answer being read are marked like its
    // question, as in the extension.
    dRows.forEach((el, k) => {
      el.classList.toggle('starred', s.dStars.includes(k));
      el.classList.toggle('active', DRAWN[k].i === s.active);
    });
    cRows.forEach((el, k) => {
      el.classList.toggle('hover', k === s.cHover);
      el.classList.toggle('starred', s.cStars.includes(k));
      el.classList.toggle('copied', k === 1 && s.cCopied > 0);
      el.classList.toggle('active', CODED[k].i === s.active);
    });
    // The overview: the rows of what is starred, in chat order.
    sRows.forEach((el, k) => {
      const r = STARRABLE[k];
      const on = r.kind === 'question' ? s.stars.includes(r.i) : r.kind === 'diagram' ? s.dStars.includes(r.d) : s.cStars.includes(r.c);
      el.hidden = !on;
      el.classList.toggle('hover', k === s.sHover);
      el.classList.toggle('active', r.i === s.active);
    });
    starBtn.classList.toggle('on', s.starred);
    const pulse = 0.8 + 0.2 * Math.cos((local / 1.6) * 2 * Math.PI);
    dShimmers.forEach((el) => (el.style.opacity = s.previews < 1 ? pulse : 0));
    dPreviews.forEach((el) => {
      el.style.opacity = s.previews;
      el.style.transform = `translateY(${(1 - s.previews) * 4}px)`;
    });
    dRows.forEach((el, k) => el.classList.toggle('hover', k === s.dHover));
    loader.style.transform = `translate(-50%, ${lerp(-10, 0, s.loading)}px)`;

    // Panel.
    panel.style.transform = `translateX(${(1 - s.panel) * 340}px)`;
    panel.style.opacity = clamp(s.panel * 1.6);
    tab.style.opacity = clamp((1 - s.panel) * 2 - 0.6);
    tab.style.transform = `translateX(${s.panel * 40}px)`;

    const q = s.filter.toLowerCase();
    let shown = 0;
    rows.forEach((row, k) => {
      const starred = s.stars.includes(k);
      const visible = !q || CHAT[k].q.toLowerCase().includes(q);
      row.hidden = !visible;
      if (visible) shown++;
      row.classList.toggle('active', k === s.active);
      row.classList.toggle('hover', k === s.hover);
      row.classList.toggle('starred', starred);
      const enter = clamp(s.listIn * (N + 4) - k, 0, 1);
      row.style.opacity = enter;
      row.style.transform = enter < 1 ? `translateY(${(1 - enter) * 8}px)` : '';
    });
    empty.hidden = shown > 0;
    ftext.textContent = s.filter;
    filterBox.classList.toggle('focus', s.focusFilter);
    filterBox.classList.toggle('has-text', !!s.filter);

    // Keep the active row in view, like the real panel. A list that was
    // just filtered differently is redrawn there at once.
    const shownNow = rows.map((r) => (r.hidden ? 0 : 1)).join('');
    const redrawn = shownNow !== lastShown;
    lastShown = shownNow;
    const activeRow = rows[s.active];
    if (activeRow && !activeRow.hidden) {
      const follow = clamp(activeRow.offsetTop - list.clientHeight * 0.4, 0, list.scrollHeight - list.clientHeight);
      const want = lerp(follow, 0, s.listUp);
      listScroll = smooth && !redrawn ? lerp(listScroll, want, 0.18) : want;
    } else if (!smooth) listScroll = 0;
    list.scrollTop = listScroll;

    // Shortcut keys.
    keys.style.opacity = s.keys;
    keys.style.transform = `translate(-50%, ${lerp(12, 0, s.keys)}px) scale(${lerp(0.96, 1, s.keys)})`;
    keys.classList.toggle('down', !!s.keysDown);
    const caps = s.caps.join(' ');
    if (keys.dataset.caps !== caps) {
      keys.dataset.caps = caps;
      keys.innerHTML = s.caps.map((k) => `<kbd>${k}</kbd>`).join('');
    }

    // Cursor.
    const a = target(s.cursor.from);
    const b = target(s.cursor.to);
    const x = lerp(a.x, b.x, s.cursor.p);
    const y = lerp(a.y, b.y, s.cursor.p);
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    if (s.click !== undefined) {
      const p = (T - CHAPTERS[s.chapter].start - s.click) / 0.45;
      ripple.style.opacity = 1 - p;
      ripple.style.transform = `translate(-50%, -50%) scale(${0.4 + p * 1.4})`;
      cursor.classList.toggle('press', p < 0.35);
    } else {
      ripple.style.opacity = 0;
      cursor.classList.remove('press');
    }
    wheel.style.opacity = s.wheel ? 1 : 0;
    wheel.classList.toggle('up', !!s.wheelUp);
    wheel.style.transform = `translate(${x + 18}px, ${y + 16}px)`;

    return s;
  }

  // ----- player controls -----------------------------------------------------

  const range = player.querySelector('[data-range]');
  const playBtn = player.querySelector('[data-act="play"]');
  const segsBox = player.querySelector('[data-segs]');
  const caption = player.querySelector('[data-caption]');

  // One segment per chapter, as wide as the chapter is long.
  segsBox.innerHTML = CHAPTERS.map(
    (c) => `<span class="ov-seg" style="flex:${c.dur}" title="${esc(c.title)}"><i></i></span>`
  ).join('');
  const segs = [...segsBox.children];

  let t = 0;
  let playing = !reduced;
  let userPaused = reduced;
  let visible = false;
  let last = 0;
  let scrubbing = false;
  let shownChapter = -1;

  const two = (n) => String(n).padStart(2, '0');
  function showCaption(ci) {
    caption.innerHTML = `<span class="demo-num">${two(ci + 1)} / ${two(CHAPTERS.length)}</span>${esc(CHAPTERS[ci].title)}`;
  }

  function paint(smooth) {
    const s = render(t, smooth);
    if (!scrubbing) range.value = Math.round((t / TOTAL) * 1000);
    if (s.chapter !== shownChapter) {
      showCaption(s.chapter);
      shownChapter = s.chapter;
    }
    segs.forEach((seg, i) => {
      const c = CHAPTERS[i];
      seg.firstChild.style.width = `${clamp((t - c.start) / c.dur) * 100}%`;
      seg.classList.toggle('now', i === s.chapter);
    });
  }

  function setPlaying(on) {
    playing = on;
    player.classList.toggle('paused', !on);
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
  }

  function seek(to) {
    t = clamp(to, 0, TOTAL - 0.001);
    paint(false);
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (playing && visible && !scrubbing) {
      t += dt;
      if (t >= TOTAL) t = 0;
    }
    if (visible) paint(true);
    requestAnimationFrame(frame);
  }

  playBtn.addEventListener('click', () => {
    userPaused = playing;
    setPlaying(!playing);
  });
  player.querySelector('[data-act="prev"]').addEventListener('click', () => {
    const c = chapterAt(t);
    seek(t - CHAPTERS[c].start > 1 || c === 0 ? CHAPTERS[c].start : CHAPTERS[c - 1].start);
  });
  player.querySelector('[data-act="next"]').addEventListener('click', () => {
    const c = chapterAt(t);
    seek(c + 1 < CHAPTERS.length ? CHAPTERS[c + 1].start : 0);
  });

  // Space over the demo plays or pauses (and doesn't scroll the page).
  // Focused buttons, links and fields keep their own Space.
  let hovered = false;
  box.addEventListener('pointerenter', () => (hovered = true));
  box.addEventListener('pointerleave', () => (hovered = false));
  window.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || !hovered || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target;
    if (el instanceof Element && el.closest('button, a, input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    playBtn.click();
  });

  // Clicking the picture itself plays or pauses, like a video.
  stage.addEventListener('click', () => playBtn.click());
  stage.style.cursor = 'pointer';

  range.addEventListener('pointerdown', () => (scrubbing = true));
  window.addEventListener('pointerup', () => (scrubbing = false));
  range.addEventListener('input', () => seek((range.value / 1000) * TOTAL));
  range.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      playBtn.click();
    }
  });

  new IntersectionObserver(
    (entries) => {
      visible = entries[0].isIntersecting;
    },
    { threshold: 0.25 }
  ).observe(box);

  // Fonts change line heights, and so the turns' tops.
  document.fonts?.ready.then(() => {
    measure();
    paint(false);
  });
  new ResizeObserver(() => {
    measure();
    paint(false);
  }).observe(feed);

  setPlaying(playing);
  if (reduced) t = CHAPTERS[0].start + CHAPTERS[0].dur - 0.01;
  measure();
  paint(false);
  requestAnimationFrame((now) => {
    last = now;
    frame(now);
  });
})();
