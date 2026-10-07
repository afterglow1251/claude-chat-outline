// Automated checks against test/fixture.html. Loaded by ?selftest=1.
// Results go to the console, a <pre id="results">, and document.title
// ("SELFTEST PASS" / "SELFTEST FAIL") so a headless browser can read them.
(async () => {
  'use strict';

  const results = [];
  // Extension warnings (collected by the fixture from page load on) are part
  // of the report: the extension swallows exceptions on purpose.
  const warnings = window.consoleWarnings || [];
  const pre = document.createElement('pre');
  pre.id = 'results';
  document.body.append(pre);
  const log = (ok, name, detail = '') => {
    results.push({ ok, name, detail });
    pre.textContent += `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}\n`;
    console[ok ? 'log' : 'error'](ok ? 'PASS' : 'FAIL', name, detail);
  };
  const check = (cond, name, detail) => log(!!cond, name, cond ? '' : detail);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout = 3000) {
    const end = performance.now() + timeout;
    while (performance.now() < end) {
      try { if (fn()) return true; } catch (_) {}
      await sleep(16);
    }
    return false;
  }

  const variant = new URLSearchParams(location.search).get('variant') || 'testid';
  const VIRTUAL = new URLSearchParams(location.search).has('virtual');
  const API = new URLSearchParams(location.search).has('api');
  const host = () => document.getElementById('claude-outline-host');
  const root = () => host().shadowRoot;
  const items = () => Array.from(root().querySelectorAll('.list button'));
  const labels = () => items().map((b) => b.querySelector('.label').textContent);
  const current = () => items().findIndex((b) => b.getAttribute('aria-current') === 'true');
  const statusText = () => root().querySelector('.status-text').textContent;
  const scroller = () => document.getElementById('scroller');
  const turnEls = () => Array.from(document.querySelectorAll('article, [role="article"]'));
  const userArticles = () => turnEls().filter((a) => /^You said:/.test(a.querySelector('h2').textContent));
  const visible = () => host() && host().style.display !== 'none';
  const key = (target, init) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, ...init }));
  const countText = () => root().querySelector('.count').textContent;
  const toLabel = (t) => {
    const full = t.replace(/^[ \t]*```[^\n`]*$/gm, ' ').replace(/\s+/g, ' ').trim();
    return full ? (full.length <= 90 ? full : full.slice(0, 89).trimEnd() + '…') : '(attachment)';
  };
  const isSubsequence = (small, big) => {
    let i = 0;
    for (const x of big) if (x === small[i]) i++;
    return i === small.length;
  };
  // Scrolls the chat in steps and reports whether the outline ever lost or
  // reordered an item along the way.
  async function scrollThrough(from, to) {
    let prev = labels();
    let bad = '';
    const step = scroller().clientHeight * 0.5;
    for (let y = from; from < to ? y <= to : y >= to; y += from < to ? step : -step) {
      scroller().scrollTop = y;
      await sleep(250);
      const now = labels();
      if (!isSubsequence(prev, now)) bad = `at ${y}: [${prev.join(' | ')}] -> [${now.join(' | ')}]`;
      prev = now;
    }
    scroller().scrollTop = to;
    await sleep(300);
    return bad;
  }

  try {
    localStorage.removeItem('co-store');
    check(await waitFor(visible), 'panel is shown on a /chat/<id> URL');

    if (variant === 'broken') {
      check(await waitFor(() => /Couldn't find your messages/.test(statusText())), 'broken selectors show explicit error state', statusText());
      check(items().length === 0, 'no bullets when selectors fail');
      return;
    }

    if (API) {
      // ---- API: every question at once, never changing ------------------
      const chat = fixture.CHATS['aaaaaaaa-0000-4000-8000-000000000001'];
      const all = () => chat.questions.map(toLabel);
      check(await waitFor(() => labels().join('|') === all().join('|'), 3000), 'all questions listed at once, including ones not loaded in the page', labels().join(' | '));
      check(!labels().includes('An old version of the first question'), 'abandoned branch not listed');
      check(!/\+$/.test(countText()), 'count has no "+" (list is complete)', countText());
      check(document.querySelector('[role=feed] > button'), '"Load earlier messages" still in the page (not needed for the list)');
      const snapshot = labels().join('|');
      let changedAt = '';
      const watch = setInterval(() => { if (!changedAt && labels().join('|') !== snapshot) changedAt = labels().join(' | '); }, 20);
      await scrollThrough(scroller().scrollTop, 0);
      await scrollThrough(0, scroller().scrollHeight);
      clearInterval(watch);
      check(!changedAt, 'list never changes while scrolling up and down', changedAt);

      if (new URLSearchParams(location.search).has('cds')) {
        // A question with a code block: stored with a ``` fence, rendered
        // without it. It must still navigate (it used not to).
        const codeIdx = labels().findIndex((l) => l.startsWith('mu, sigma'));
        check(codeIdx !== -1, 'code-block question listed without the ``` fence', labels().join(' | '));
        const findCode = () => userArticles().find((a) => /what is mu and what is sigma/.test(a.querySelector('h2').textContent));
        scroller().scrollTop = scroller().scrollHeight;
        await sleep(300);
        items()[codeIdx].click();
        check(await waitFor(() => { const a = findCode(); return a && a.style.outline !== '' && Math.abs(a.getBoundingClientRect().top - scroller().getBoundingClientRect().top - 80) <= 3; }, 8000), 'clicking the code-block question navigates to it');
        check(await waitFor(() => current() === codeIdx, 2000), 'code-block question becomes active', `current=${current()}`);
        // and when it is already on screen
        scroller().scrollTop += 300;
        await sleep(300);
        items()[codeIdx].click();
        check(await waitFor(() => { const a = findCode(); return a && Math.abs(a.getBoundingClientRect().top - scroller().getBoundingClientRect().top - 80) <= 3; }, 3000), 'clicking it again while rendered navigates too');
      }

      // jump to the first question, which needs "Load earlier messages"

      const firstText = chat.questions[0];
      const findFirst = () => userArticles().find((a) => a.querySelector('h2').textContent.replace(/\s+/g, ' ').includes(firstText.replace(/\s+/g, ' ').slice(0, 25)));
      check(!findFirst(), 'first question not in the page yet');
      items()[0].click();
      check(await waitFor(() => findFirst() && findFirst().style.outline !== '', 15000), 'clicking it loads earlier messages, renders and flashes it');
      check(await waitFor(() => current() === 0, 3000), 'it becomes the active item', `current=${current()}`);
      check(labels().join('|') === snapshot, 'list unchanged by the jump');

      // a new question appears right away and survives the API refresh
      scroller().scrollTop = scroller().scrollHeight;
      await sleep(300);
      const callsBefore = window.apiCalls;
      const streamDone = fixture.stream('API streamed question');
      check(await waitFor(() => labels()[labels().length - 1] === 'API streamed question', 2000), 'question you just sent is listed immediately');
      await streamDone;
      check(await waitFor(() => window.apiCalls > callsBefore, 6000), 'API asked again after a new question');
      await sleep(300);
      check(labels().join('|') === all().join('|'), 'list matches the API after the refresh', labels().join(' | '));

      // URL changes inside the same chat keep everything
      const callsNow = window.apiCalls;
      history.replaceState({}, '', location.pathname + location.search + '#same-chat');
      await sleep(300);
      check(window.apiCalls === callsNow && labels().join('|') === all().join('|'), 'URL change within the same chat keeps the session');

      fixture.navigate('/chat/bbbbbbbb-0000-4000-8000-000000000002');
      const allB = fixture.CHATS['bbbbbbbb-0000-4000-8000-000000000002'].questions.map(toLabel);
      check(await waitFor(() => labels().join('|') === allB.join('|'), 3000), 'other chat: its complete list', labels().join(' | '));
      return;
    }

    if (VIRTUAL) {
      // ---- virtualized feed: the outline must be stable while scrolling --
      const chat = fixture.CHATS['aaaaaaaa-0000-4000-8000-000000000001'];
      const total = chat.questions.length;
      const loadedQuestions = chat.questions.slice(total - chat.shownTurns / 2);
      await waitFor(() => items().length > 0);
      check(document.querySelector('[role=feed] .placeholder'), 'fixture really unmounts far-away turns');
      check(items().length >= userArticles().length, 'outline lists at least the mounted questions');
      check(/\+$/.test(countText()), 'count shows "+" while parts of the chat were never rendered', countText());
      let up = await scrollThrough(scroller().scrollTop, 0);
      check(!up, 'scrolling up only adds items (nothing removed or reordered)', up);
      let down = await scrollThrough(0, scroller().scrollHeight);
      check(!down, 'scrolling down keeps every item (nothing removed or reordered)', down);
      check(labels().join('|') === loadedQuestions.map(toLabel).join('|'), 'after one pass every loaded question is listed, in order', labels().join(' | '));
      check(/\+$/.test(countText()), 'count keeps "+" while "Load earlier messages" exists', countText());

      // ---- nothing seen is ever lost ------------------------------------------
      const seenAll = labels().join('|');
      fixture.replaceFeed();
      await sleep(400);
      check(labels().join('|') === seenAll, 'feed node replaced: list unchanged', labels().join(' | '));
      history.replaceState({}, '', location.pathname + location.search + '#same-chat');
      await sleep(300);
      check(labels().join('|') === seenAll, 'URL change within the same chat: list unchanged', labels().join(' | '));
      await sleep(1200); // let the cache save
      fixture.navigate('/chat/bbbbbbbb-0000-4000-8000-000000000002');
      await waitFor(() => labels()[0] && labels()[0].startsWith('Beta'));
      fixture.navigate('/chat/aaaaaaaa-0000-4000-8000-000000000001');
      check(await waitFor(() => labels().join('|') === seenAll, 1500), 'coming back to the chat: every question seen before is listed at once (cache)', labels().join(' | '));
      check(userArticles().length < seenAll.split('|').length, 'even though only some are rendered');
      let lost = await scrollThrough(scroller().scrollTop, 0);
      check(!lost && labels().join('|') === seenAll, 'cached list stays stable while scrolling', lost || labels().join(' | '));
      scroller().scrollTop = scroller().scrollHeight;
      await sleep(300);

      // ---- jump to a question that is not in the DOM -----------------------
      scroller().scrollTop = scroller().scrollHeight;
      await sleep(300);
      const jumpTo = 1; // the very first turn cannot reach the 80px line
      const jumpFull = items()[jumpTo].title;
      const findTarget = () => userArticles().find((a) => a.querySelector('h2').textContent.replace(/\s+/g, ' ').includes(jumpFull.slice(0, 30)));
      check(!findTarget(), 'the question is unmounted while at the bottom');
      const stillThere = labels().length;
      items()[jumpTo].click();
      check(await waitFor(() => findTarget() && findTarget().style.outline !== '', 5000), 'target is rendered and flashes');
      check(await waitFor(() => { const a = findTarget(); return a && Math.abs(a.getBoundingClientRect().top - scroller().getBoundingClientRect().top - 80) <= 3; }, 3000), 'clicking an unmounted question scrolls to it (80px offset)');
      check(await waitFor(() => current() === jumpTo, 2000), 'it becomes the active item', `current=${current()}`);
      check(labels().length === stillThere, 'jumping did not change the list', `${labels().length} vs ${stillThere}`);

      // ---- active item follows scrolling across unmounted regions ---------
      // (re-pinned to the bottom: estimated heights can move the page)
      check(await waitFor(() => { scroller().scrollTop = scroller().scrollHeight; return current() === labels().length - 1; }, 3000), 'bottom -> last question active', `current=${current()}`);

      // ---- load all = load earlier + scan the whole chat --------------------
      scroller().scrollTop = scroller().scrollHeight / 2;
      await sleep(300);
      const anchorLabel = userArticles().find((a) => a.getBoundingClientRect().bottom > scroller().getBoundingClientRect().top);
      const anchorText = anchorLabel.querySelector('h2').textContent;
      const anchorTop = anchorLabel.getBoundingClientRect().top;
      const loadBtn = root().querySelector('.header .icon-btn[aria-label="Load all questions"]');
      check(!loadBtn.disabled, 'Load all enabled');
      loadBtn.click();
      check(await waitFor(() => root().querySelector('.status.loading'), 500), 'spinner while loading');
      check(await waitFor(() => !root().querySelector('.status.loading'), 20000), 'load-all finishes');
      check(labels().join('|') === chat.questions.map(toLabel).join('|'), 'load all lists every question of the chat, in order', labels().join(' | '));
      check(!/\+$/.test(countText()), 'count has no "+" after load all', countText());
      check(/All questions loaded/.test(statusText()), 'completion notice', statusText());
      const anchorNow = userArticles().find((a) => a.querySelector('h2').textContent === anchorText);
      check(anchorNow && Math.abs(anchorNow.getBoundingClientRect().top - anchorTop) <= 2, 'reading position preserved after load all', anchorNow ? `moved ${(anchorNow.getBoundingClientRect().top - anchorTop).toFixed(1)}px` : 'anchor not rendered');
      const after = await scrollThrough(scroller().scrollTop, 0);
      check(!after && labels().length === total, 'list stays complete and stable after load all', after || labels().length);

      // ---- new question while streaming -------------------------------------
      scroller().scrollTop = scroller().scrollHeight;
      await sleep(300);
      const streamDone = fixture.stream('Virtual streamed question');
      check(await waitFor(() => labels()[labels().length - 1] === 'Virtual streamed question' && labels().length === total + 1, 2000), 'new question appended at the end');
      await streamDone;

      // ---- another chat starts from scratch --------------------------------
      fixture.navigate('/chat/bbbbbbbb-0000-4000-8000-000000000002');
      check(await waitFor(() => labels().length && labels().every((l) => l.startsWith('Beta') || l === '(attachment)')), 'navigation drops the previous chat\'s questions', labels().join(' | '));
      check(labels().length < fixture.CHATS['bbbbbbbb-0000-4000-8000-000000000002'].questions.length, 'chat B starts with only what is rendered');
      return;
    }

    // ---- extraction ------------------------------------------------------
    await waitFor(() => items().length > 0);
    const strategy = ClaudeOutline.collect(ClaudeOutline.findFeed()).strategy;
    const expectedStrategy = variant === 'heading' ? /You said/ : /data-testid/;
    check(expectedStrategy.test(strategy), `strategy for variant "${variant}"`, strategy);
    check(items().length === userArticles().length, 'one bullet per visible user message', `${items().length} vs ${userArticles().length}`);
    const ls = labels();
    const long = ls.find((l) => l.includes('very long question'));
    check(long && long.endsWith('…') && long.length <= 90, 'long labels truncated to ~90 chars with ellipsis', long);
    check(items().find((b) => b.title.includes('very long question')).title.length > 90, 'full text kept in title tooltip');
    check(ls.includes('(attachment)'), 'attachment-only message gets placeholder', ls.join(' | '));
    check(ls.some((l) => /how do I handle case #\d\?$/.test(l)), 'whitespace collapsed', ls.join(' | '));
    check(!ls.some((l) => /You said|Edit/.test(l)), 'labels exclude heading/button text', ls.join(' | '));
    check(root().querySelector('nav[aria-label="Chat outline"] ol > li > button'), 'semantic nav > ol > li > button');

    // ---- click to navigate ----------------------------------------------
    const idx = 1;
    const target = userArticles()[idx];
    const hadStyle = target.hasAttribute('style');
    items()[idx].click();
    check(await waitFor(() => target.style.outline !== ''), 'target article flashes');
    await sleep(900);
    const offset = target.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
    check(Math.abs(offset - 80) <= 3, 'clicked message scrolled to scroller top + 80px offset', `offset=${offset.toFixed(1)}`);
    check(await waitFor(() => current() === idx), 'clicked bullet becomes active (aria-current)', `current=${current()}`);
    check(await waitFor(() => target.style.outline === '' && target.hasAttribute('style') === hadStyle, 2000), 'flash fully reverted (style attribute restored)');
    check(window.scrollY === 0, 'window itself never scrolled');

    // ---- active tracking on manual scroll --------------------------------
    const t3 = userArticles()[3];
    scroller().scrollTop += t3.getBoundingClientRect().top - scroller().getBoundingClientRect().top - 40;
    check(await waitFor(() => current() === 3), 'active bullet follows manual scroll', `current=${current()}`);
    scroller().scrollTop = 0;
    check(await waitFor(() => current() === 0), 'scroll to top -> first bullet active', `current=${current()}`);

    // ---- keyboard ---------------------------------------------------------
    items()[0].focus();
    key(items()[0], { key: 'ArrowDown' });
    check(root().activeElement === items()[1], 'ArrowDown moves focus to next bullet');
    key(items()[1], { key: 'End' });
    check(root().activeElement === items()[items().length - 1], 'End moves focus to last bullet');
    check(items().filter((b) => b.tabIndex === 0).length === 1, 'roving tabindex: exactly one tabbable bullet');

    // ---- streaming updates without flicker --------------------------------
    const before = items().length;
    const firstLi = root().querySelector('.list li');
    let removed = 0;
    const mo = new MutationObserver((recs) => recs.forEach((r) => (removed += r.removedNodes.length)));
    mo.observe(root().querySelector('.list'), { childList: true });
    const streamDone = fixture.stream('Brand new streamed question');
    check(await waitFor(() => items().length === before + 1, 2000), 'new question appears while the answer is still streaming');
    await streamDone;
    await sleep(300);
    mo.disconnect();
    check(removed === 0 && root().querySelector('.list li') === firstLi, 'list patched in place (no <li> removed/recreated)', `removed=${removed}`);
    check(labels()[labels().length - 1] === 'Brand new streamed question', 'streamed question label correct');

    // ---- feed node replaced ----------------------------------------------
    fixture.replaceFeed();
    await sleep(100);
    fixture.stream('After feed replacement');
    check(await waitFor(() => labels().includes('After feed replacement'), 2500), 'outline re-attaches when feed node is replaced');
    await sleep(3100);

    // ---- load all ---------------------------------------------------------
    const loadBtn = root().querySelector('.header .icon-btn[aria-label="Load all questions"]');
    check(!loadBtn.disabled && /\+$/.test(root().querySelector('.count').textContent), 'count shows "+" and Load all enabled while earlier messages exist');
    scroller().scrollTop = scroller().scrollHeight / 2;
    await sleep(100);
    const anchor = turnEls().find((a) => a.getBoundingClientRect().bottom > scroller().getBoundingClientRect().top);
    const anchorTop = anchor.getBoundingClientRect().top;
    loadBtn.click();
    check(await waitFor(() => root().querySelector('.status.loading') && !root().querySelector('.status button').hidden, 500), 'spinner + Cancel visible while loading');
    check(await waitFor(() => !root().querySelector('.status.loading'), 10000), 'load-all finishes');
    const total = fixture.CHATS['aaaaaaaa-0000-4000-8000-000000000001'].questions.length;
    check(items().length === total, 'all questions loaded', `${items().length} of ${total}`);
    check(!document.querySelector('[role=feed] > button'), '"Load earlier messages" button gone');
    check(Math.abs(anchor.getBoundingClientRect().top - anchorTop) <= 2, 'scroll position preserved after load-all', `moved ${(anchor.getBoundingClientRect().top - anchorTop).toFixed(1)}px`);
    check(/All questions loaded/.test(statusText()), 'completion notice', statusText());

    // ---- route changes ----------------------------------------------------
    fixture.navigate('/chat/bbbbbbbb-0000-4000-8000-000000000002');
    check(await waitFor(() => labels()[0] && labels()[0].startsWith('Beta')), 'SPA navigation to chat B rebuilds outline', labels()[0]);
    check(!/All questions loaded|Stopped/.test(statusText()), 'previous chat notice cleared on navigation', statusText());

    // cancel during load-all
    root().querySelector('.header .icon-btn[aria-label="Load all questions"]').click();
    await waitFor(() => root().querySelector('.status.loading'));
    root().querySelector('.status button').click();
    check(await waitFor(() => /Stopped loading/.test(statusText()), 3000), 'Cancel stops load-all', statusText());

    fixture.navigate('/new');
    check(await waitFor(() => !visible()), 'panel hidden on /new');
    history.back(); // popstate -> chat B
    check(await waitFor(() => visible() && labels()[0] && labels()[0].startsWith('Beta'), 3000), 'popstate back to chat shows panel again');

    // ---- collapse / persistence / shortcut / Esc ---------------------------
    root().querySelector('.header .icon-btn[aria-label="Collapse outline"]').click();
    check(root().querySelector('.panel').hidden && !root().querySelector('.tab').hidden, 'collapse -> thin tab');
    check(JSON.parse(localStorage.getItem('co-store')).collapsed === true, 'collapsed persisted to storage');
    const tabRect = root().querySelector('.tab').getBoundingClientRect();
    check(tabRect.width <= 32 && host().getBoundingClientRect().width === 0, 'collapsed: only a small tab, zero-size host (no click-swallowing overlay)');
    key(document.body, { key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true });
    check(!root().querySelector('.panel').hidden, 'Ctrl+Shift+O expands');
    check(root().activeElement && root().activeElement.closest('.list'), 'expanding via shortcut moves focus into the list');
    key(root().activeElement, { key: 'Escape' });
    check(root().querySelector('.panel').hidden, 'Esc collapses when focused');
    root().querySelector('.tab').click();

    // ---- resize -----------------------------------------------------------
    const resizer = root().querySelector('.resizer');
    for (let i = 0; i < 40; i++) key(resizer, { key: 'ArrowLeft' });
    check(root().querySelector('.panel').getBoundingClientRect().width === 520, 'width clamped to 520');
    for (let i = 0; i < 40; i++) key(resizer, { key: 'ArrowRight' });
    check(root().querySelector('.panel').getBoundingClientRect().width === 200, 'width clamped to 200');
    check(JSON.parse(localStorage.getItem('co-store')).width === 200, 'width persisted');

    // ---- push mode --------------------------------------------------------
    const pushBtn = root().querySelector('.header .icon-btn[aria-pressed]');
    pushBtn.click();
    check(document.body.style.paddingRight === '216px', 'push mode reserves space on <body>', document.body.style.paddingRight);
    pushBtn.click();
    check(!document.body.hasAttribute('style'), 'overlay mode restores <body> untouched');

    // ---- theme --------------------------------------------------------------
    document.documentElement.classList.add('dark');
    check(await waitFor(() => host().getAttribute('data-theme') === 'dark'), 'follows html.dark');
    document.documentElement.classList.remove('dark');
    check(await waitFor(() => host().getAttribute('data-theme') === 'light'), 'follows removal of html.dark');

    // ---- idempotent injection ----------------------------------------------
    const again = document.createElement('script');
    again.src = '/src/main.js?again';
    document.body.append(again);
    await new Promise((r) => (again.onload = r));
    check(document.querySelectorAll('#claude-outline-host').length === 1, 'second injection bails (one host)');

    // ---- debug helper -------------------------------------------------------
    let logged = '';
    const orig = console.log;
    console.log = (...a) => { logged += a.join(' ') + '\n'; };
    const ret = window.__claudeOutline.debug();
    console.log = orig;
    check(new RegExp('Strategy in use: ' + (variant === 'heading' ? 'turn with' : '\\[data-testid')).test(logged) && typeof ret === 'string', '__claudeOutline.debug() reports matched strategy', logged);
  } catch (err) {
    log(false, 'selftest crashed', String(err && err.stack));
  } finally {
    const failed = results.filter((r) => !r.ok).length;
    document.title = failed ? `SELFTEST FAIL (${failed}/${results.length})` : `SELFTEST PASS (${results.length})`;
    pre.dataset.done = '1';
    // For test/run.py (headless): hand the results to the fixture server.
    const extensionWarnings = warnings.filter((w) => w.includes('[Claude Outline]'));
    const report = document.title + '\n' + pre.textContent + (extensionWarnings.length ? '\nExtension warnings:\n' + extensionWarnings.join('\n') : '');
    fetch('/selftest' + location.search, { method: 'POST', body: report }).catch(() => {});
  }
})();
