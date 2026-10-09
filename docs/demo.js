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
    },
    {
      q: 'SQLite or Postgres for a side project like this?',
      a: 'SQLite. One file, no server, and it handles far more traffic than a habit tracker will see. Move to Postgres when you need several app servers writing at once.',
    },
    {
      q: 'Write the schema for habits and daily check-ins',
      a: 'Two tables are enough. A check-in is one row per habit per day, so a unique index keeps double taps from counting twice.',
      code: 'create table checkins (\n  habit_id integer references habits(id),\n  day      date not null,\n  unique (habit_id, day)\n);',
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

  // ----- the timeline --------------------------------------------------------

  const mod = isMac ? '⌘' : 'Ctrl';
  // In play order. Each chapter starts where the one before it ends.
  const CHAPTERS = [
    { id: 'panel', title: 'Every question in one panel', dur: 4.5 },
    { id: 'click', title: 'Click to jump', dur: 5.9 },
    { id: 'follow', title: 'Follows as you read', dur: 4.6 },
    { id: 'search', title: 'Search your questions', dur: 7.2 },
    { id: 'star', title: 'Star the ones that matter', dur: 6 },
    { id: 'unloaded', title: "Reach what isn't loaded yet", dur: 8.0 },
    { id: 'step', title: `${mod} Shift ↑ ↓ between questions`, dur: 6.6 },
    { id: 'hide', title: `${mod} Shift O to hide`, dur: 4.4 },
    { id: 'theme', title: 'Light and dark', dur: 4.2 },
    { id: 'resume', title: 'Picks up where you left off', dur: 9.2 },
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

  // The state of the scene at time t.
  function stateAt(T) {
    const ci = chapterAt(T);
    const id = CHAPTERS[ci].id;
    const t = T - CHAPTERS[ci].start;
    const s = {
      chapter: ci,
      panel: 1, // 1 shown, 0 collapsed to the tab
      listIn: 1, // the list's entrance
      chatPos: 9.25, // question at the top of the chat, fractional
      active: 9,
      filter: '',
      focusFilter: false,
      stars: [],
      starOnly: false,
      hover: -1,
      unloadedBelow: 0, // questions before this index aren't loaded
      loading: 0,
      keys: 0,
      caps: [mod, '⇧', 'O'], // the keys shown
      resume: 0, // the "Continue where you left off" pill, 0 hidden to 1 shown
      away: false, // another chat is open (its content isn't drawn)
      side: 0, // the chat marked in the sidebar: 0 this one, 1 "Trip to Lisbon"
      dark: false,
      listUp: 0, // 0: the list follows the active row; 1: scrolled to its top
      cursor: cursorPath(0, [[0, 'rest']]),
      click: undefined,
      flash: null, // { index, at }: the jump highlight, started at chapter time `at`
    };

    if (id === 'panel') {
      s.panel = out(seg(t, 0.3, 1.1));
      s.listIn = seg(t, 0.8, 2.4);
      s.cursor = cursorPath(t, [[0, 'rest']]);
    }

    if (id === 'click') {
      // Question 3 is above what the list shows (it follows question 10):
      // scroll the list up to it first, then click it.
      s.cursor = cursorPath(t, [[0.2, 'rest'], [1.0, 'list'], [2.0, 'list'], [2.6, 'item:2']]);
      s.wheel = t > 1.0 && t < 2.0;
      s.wheelUp = true;
      s.listUp = inOut(seg(t, 1.1, 1.9));
      s.hover = t > 2.3 ? 2 : -1;
      const click = 2.85;
      s.click = clickAt(t, [click]);
      if (t >= click) {
        s.active = 2;
        s.chatPos = lerp(9.25, 2, inOut(seg(t, click + 0.05, click + 1.3)));
        s.flash = { index: 2, at: click + 1.1 };
      }
    }

    if (id === 'follow') {
      s.chatPos = lerp(2, 7.7, inOut(seg(t, 0.4, 4.2)));
      s.active = Math.floor(s.chatPos + 0.2);
      s.cursor = cursorPath(t, [[0, 'item:2'], [0.8, 'chat']]);
      s.wheel = t > 0.6 && t < 4.3;
    }

    if (id === 'step') {
      // From question 1: down, down again, back up. Each jump flashes, like a click.
      s.stars = [4, 8];
      s.cursor = cursorPath(t, [[0, 'item:0'], [0.6, 'chat']]);
      const presses = [
        [0.8, '↓', 0, 1],
        [2.4, '↓', 1, 2],
        [4.0, '↑', 2, 1],
      ];
      const shown = presses.find(([at]) => t >= at - 0.4 && t < at + 0.5);
      s.keys = shown ? 1 : 0;
      s.caps = [mod, '⇧', shown ? shown[1] : '↑'];
      s.keysDown = presses.some(([at]) => t >= at - 0.1 && t < at + 0.2);
      const done = presses.filter(([at]) => t >= at);
      const now = done[done.length - 1];
      if (now) {
        const [at, , from, to] = now;
        s.chatPos = lerp(from, to, inOut(seg(t, at + 0.05, at + 0.7)));
        s.active = to;
        s.flash = { index: to, at: at + 0.6 };
      } else {
        s.chatPos = 0;
        s.active = 0;
      }
    }

    if (id === 'search') {
      s.chatPos = 7.7;
      s.active = 7;
      const typeStart = 1.4;
      const word = 'i love claude';
      s.cursor = cursorPath(t, [[0, 'chat'], [1.0, 'filter'], [3.7, 'filter'], [4.5, 'item:4']]);
      s.click = clickAt(t, [1.1, 4.7]);
      s.focusFilter = t >= 1.1;
      s.filter = word.slice(0, Math.floor(seg(t, typeStart, typeStart + 1.8) * word.length + 0.001));
      s.hover = t > 4.2 ? 4 : -1;
      if (t >= 4.7) {
        s.active = 4;
        s.chatPos = lerp(7.7, 4, inOut(seg(t, 4.75, 5.8)));
        s.flash = { index: 4, at: 5.4 };
      }
    }

    if (id === 'star') {
      s.chatPos = 4;
      s.active = 4;
      s.cursor = cursorPath(t, [[0, 'item:4'], [1.0, 'star:4'], [1.6, 'star:4'], [2.4, 'star:8'], [3.1, 'star:8'], [3.9, 'starBtn']]);
      s.click = clickAt(t, [1.15, 2.55, 4.1]);
      s.hover = t < 1.8 ? 4 : t < 3.3 ? 8 : -1;
      s.stars = [...(t >= 1.15 ? [4] : []), ...(t >= 2.55 ? [8] : [])];
      s.starOnly = t >= 4.1;
    }

    if (id === 'unloaded') {
      // A long chat: the early questions aren't on the page.
      s.stars = [4, 8];
      s.unloadedBelow = 6;
      s.chatPos = 10.2;
      s.active = 10;
      // Star filter off: every question again, the list at the current one.
      // Question 1 is above what it shows: scroll the list up to it, then click.
      const filterOff = 0.4;
      const click = 3.15;
      const loaded = click + 1.4;
      s.starOnly = t < filterOff;
      s.cursor = cursorPath(t, [[0, 'starBtn'], [1.2, 'list'], [2.3, 'list'], [2.9, 'item:0']]);
      s.wheel = t > 1.2 && t < 2.3;
      s.wheelUp = true;
      s.listUp = inOut(seg(t, 1.3, 2.2));
      s.hover = t > 2.6 ? 0 : -1;
      s.click = clickAt(t, [filterOff, click]);
      if (t >= click) {
        s.active = 0;
        s.loading = seg(t, click, click + 0.25) * (1 - seg(t, loaded, loaded + 0.3));
        if (t >= loaded) s.unloadedBelow = 0;
        s.chatPos = lerp(10.2, 0, inOut(seg(t, loaded, loaded + 1.6)));
        if (t >= loaded) s.flash = { index: 0, at: loaded + 1.3 };
      }
    }

    if (id === 'hide') {
      s.stars = [4, 8];
      s.chatPos = 1;
      s.active = 1;
      s.cursor = cursorPath(t, [[0, 'chat']]);
      const hide = 0.9;
      const show = 2.9;
      s.keys = t >= hide - 0.4 && t < hide + 0.5 ? 1 : t >= show - 0.4 && t < show + 0.5 ? 1 : 0;
      s.keysDown = (t >= hide - 0.1 && t < hide + 0.2) || (t >= show - 0.1 && t < show + 0.2);
      s.panel = 1 - out(seg(t, hide, hide + 0.45)) + out(seg(t, show, show + 0.45));
    }

    if (id === 'resume') {
      // Read question 4, go to another chat, come back: claude.ai opens the
      // chat at its end, and the extension offers question 4 again.
      s.stars = [4, 8];
      s.dark = true;
      const leave = 2.3;
      const back = 3.8;
      const take = 5.9;
      s.cursor = cursorPath(t, [[0, 'chat'], [1.7, 'chat'], [2.1, 'side:1'], [leave + 0.6, 'side:1'], [3.6, 'side:0'], [back + 1.2, 'side:0'], [5.6, 'resume']]);
      s.click = clickAt(t, [leave, back, take]);
      s.wheel = t > 0.2 && t < 1.6;
      s.away = t >= leave && t < back;
      s.side = s.away ? 1 : 0;
      if (t < leave) {
        s.chatPos = lerp(1, 3, inOut(seg(t, 0.2, 1.5)));
        s.active = Math.floor(s.chatPos + 0.2);
      } else {
        // Opened again at the end, then back to question 4 from the offer.
        s.chatPos = lerp(N - 1.6, 3, inOut(seg(t, take + 0.05, take + 1.3)));
        s.active = t < take ? N - 1 : 3;
      }
      s.resume = out(seg(t, back + 0.5, back + 1.0)) * (1 - inOut(seg(t, take, take + 0.25)));
      s.resumeHover = t > 5.4 && t < take;
      if (t >= take) s.flash = { index: 3, at: take + 1.1 };
    }

    if (id === 'theme') {
      s.stars = [4, 8];
      s.chatPos = 1;
      s.active = 1;
      s.cursor = cursorPath(t, [[0, 'chat']]);
      s.dark = t >= 1.0;
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
                  <div class="s-answer"><p>${esc(m.a)}</p>${m.code ? `<pre>${esc(m.code)}</pre>` : ''}</div>
                </div>`
              ).join('')}
              <div class="s-tail"></div>
            </div>
            <div class="s-loader"><span class="s-spin"></span>Loading earlier messages…</div>
            <div class="s-resume"><svg viewBox="0 0 16 16"><path d="M8 13V3M4 7l4-4 4 4"/></svg><p><b>Continue where you left off</b><span>4. ${esc(CHAT[3].q)}</span></p><i>×</i></div>
            <div class="s-input">Reply</div>
          </div>
        </section>
      </div>

      <div class="s-panel">
        <div class="s-ph"><b>Questions</b><span>${N}</span>
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
      </div>
      <div class="s-tab"><svg viewBox="0 0 16 16"><path d="m10 3-5 5 5 5"/></svg><span>Outline</span><span class="s-tab-n">${N}</span></div>

      <div class="s-keys"><kbd>${isMac ? '⌘' : 'Ctrl'}</kbd><kbd>⇧</kbd><kbd>O</kbd></div>
      <div class="s-cursor"><svg viewBox="0 0 24 24"><path d="M5 3l14 8-6.2 1.5L9.6 19z"/></svg><span class="s-ripple"></span></div>
      <div class="s-wheel"></div>
    </div>`;

  const $ = (sel) => stage.querySelector(sel);
  const view = $('.s-view');
  const feed = $('.s-feed');
  const turns = [...stage.querySelectorAll('[data-turn]')];
  const rows = [...stage.querySelectorAll('[data-row]')];
  const flashes = [...stage.querySelectorAll('.s-flash')];
  const list = $('.s-list');
  const panel = $('.s-panel');
  const tab = $('.s-tab');
  const ftext = $('.s-ftext');
  const filterBox = $('.s-filter');
  const starBtn = $('.s-starbtn');
  const loader = $('.s-loader');
  const resumeEl = $('.s-resume');
  const sideItems = [...stage.querySelectorAll('.s-side-i')];
  const title = $('.s-title');
  const count = $('.s-ph span');
  const keys = $('.s-keys');
  const cursor = $('.s-cursor');
  const ripple = $('.s-ripple');
  const wheel = $('.s-wheel');
  const windowEl = $('.s-window');
  const empty = $('.s-empty');

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
    if (name === 'resume') return pointOf(resumeEl, 0.3, 0.55);
    if (name === 'starBtn') return pointOf(starBtn, 0.5, 0.55);
    const [kind, i] = name.split(':');
    if (kind === 'side') return pointOf(sideItems[+i], 0.4, 0.55);
    const row = rows[+i];
    if (kind === 'item') return pointOf(row.querySelector('.s-label'), 0.3, 0.6);
    if (kind === 'star') return pointOf(row.querySelector('.s-star'), 0.5, 0.55);
    return { x: 600, y: 400 };
  }

  // Top of each turn in the feed, measured (they differ in height).
  let tops = [];
  const measure = () => {
    tops = turns.map((el) => el.offsetTop);
  };

  // ----- render --------------------------------------------------------------

  let listScroll = 0;
  let lastShown = ''; // which rows were shown: when it changes the list jumps, it doesn't glide
  let lastT = -1;

  function render(T, smooth) {
    const s = stateAt(T);
    windowEl.dataset.theme = s.dark ? 'dark' : 'light';

    // Chat scroll: interpolate between measured tops of questions.
    if (!tops.length) measure();
    const i = Math.floor(s.chatPos);
    const f = s.chatPos - i;
    const y0 = tops[clamp(i, 0, N - 1)];
    const y1 = i + 1 < N ? tops[i + 1] : y0;
    feed.style.transform = `translateY(${-(lerp(y0, y1, f) - 24)}px)`;
    turns.forEach((el, k) => el.classList.toggle('gone', k < s.unloadedBelow));
    // The "here it is" ring, timed like the extension's: fade in, hold
    // while a light sweeps across, slow fade out; 1.8s in all.
    const local = T - CHAPTERS[s.chapter].start;
    flashes.forEach((el, k) => {
      const ms = s.flash && s.flash.index === k ? (local - s.flash.at) * 1000 : -1;
      if (ms < 0 || ms > 1800) {
        el.style.opacity = 0;
        return;
      }
      const p = ms / 1800;
      el.style.opacity = p < 0.12 ? out(p / 0.12) : p < 0.7 ? 1 : 1 - inOut((p - 0.7) / 0.3);
      const sweep = clamp((ms - 150) / 1100);
      el.firstChild.style.transform = `translateX(${lerp(-100, 100, inOut(sweep))}%)`;
    });
    loader.style.opacity = s.loading;
    // Slides down from above the view (no fade, like the extension's).
    resumeEl.style.transform = `translate(-50%, ${lerp(-80, 0, s.resume)}px)`;
    resumeEl.classList.toggle('hover', !!s.resumeHover);

    // Another chat open: the sidebar marks it, and this chat isn't drawn.
    sideItems.forEach((el, k) => el.classList.toggle('on', k === s.side));
    const name = s.away ? 'Trip to Lisbon' : 'Habit tracker app';
    if (title.textContent !== name) title.textContent = name;
    count.textContent = s.away ? '' : N;
    feed.style.visibility = s.away ? 'hidden' : '';
    list.style.visibility = s.away ? 'hidden' : '';
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
      const visible = (!q || CHAT[k].q.toLowerCase().includes(q)) && (!s.starOnly || starred);
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
    starBtn.classList.toggle('on', s.starOnly);
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

  function showCaption(ci) {
    caption.textContent = CHAPTERS[ci].title;
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
