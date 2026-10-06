// Automated checks against test/fixture.html. Loaded by ?selftest=1.
// Results go to the console, a <pre id="results">, and document.title
// ("SELFTEST PASS" / "SELFTEST FAIL") so a headless browser can read them.
(async () => {
  'use strict';

  const results = [];
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
  const host = () => document.getElementById('claude-outline-host');
  const root = () => host().shadowRoot;
  const items = () => Array.from(root().querySelectorAll('.list button'));
  const labels = () => items().map((b) => b.querySelector('.label').textContent);
  const current = () => items().findIndex((b) => b.getAttribute('aria-current') === 'true');
  const statusText = () => root().querySelector('.status-text').textContent;
  const scroller = () => document.getElementById('scroller');
  const userArticles = () =>
    Array.from(document.querySelectorAll('article')).filter((a) => /^You said:/.test(a.querySelector('h2').textContent));
  const visible = () => host() && host().style.display !== 'none';
  const key = (target, init) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, ...init }));

  try {
    localStorage.removeItem('co-store');
    check(await waitFor(visible), 'panel is shown on a /chat/<id> URL');

    if (variant === 'broken') {
      check(await waitFor(() => /Couldn't find your messages/.test(statusText())), 'broken selectors show explicit error state', statusText());
      check(items().length === 0, 'no bullets when selectors fail');
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
    const anchor = Array.from(document.querySelectorAll('article')).find((a) => a.getBoundingClientRect().bottom > scroller().getBoundingClientRect().top);
    const anchorTop = anchor.getBoundingClientRect().top;
    loadBtn.click();
    check(await waitFor(() => root().querySelector('.status.loading') && !root().querySelector('.status button').hidden, 500), 'spinner + Cancel visible while loading');
    check(await waitFor(() => !root().querySelector('.status.loading'), 10000), 'load-all finishes');
    const total = fixture.CHATS['aaaaaaaa-0000-4000-8000-000000000001'].questions.length;
    check(items().length === total, 'all questions loaded', `${items().length} of ${total}`);
    check(!document.querySelector('[role=feed] > button'), '"Load earlier messages" button gone');
    check(Math.abs(anchor.getBoundingClientRect().top - anchorTop) <= 2, 'scroll position preserved after load-all', `moved ${(anchor.getBoundingClientRect().top - anchorTop).toFixed(1)}px`);
    check(/All earlier messages loaded/.test(statusText()), 'completion notice', statusText());

    // ---- route changes ----------------------------------------------------
    fixture.navigate('/chat/bbbbbbbb-0000-4000-8000-000000000002');
    check(await waitFor(() => labels()[0] && labels()[0].startsWith('Beta')), 'SPA navigation to chat B rebuilds outline', labels()[0]);
    check(statusText() === '', 'previous chat notice cleared on navigation', statusText());

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
    check(new RegExp('Strategy in use: ' + (variant === 'heading' ? 'article' : '\\[data-testid')).test(logged) && typeof ret === 'string', '__claudeOutline.debug() reports matched strategy', logged);
  } catch (err) {
    log(false, 'selftest crashed', String(err && err.stack));
  } finally {
    const failed = results.filter((r) => !r.ok).length;
    document.title = failed ? `SELFTEST FAIL (${failed}/${results.length})` : `SELFTEST PASS (${results.length})`;
    pre.dataset.done = '1';
  }
})();
