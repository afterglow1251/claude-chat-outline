// All claude.ai DOM hooks live in this one file. If Claude changes its UI,
// this should be the only file you need to edit.
//
// Preference order for hooks: aria-label > role > data-testid > class names.
// Class names are Tailwind-generated and churn constantly, so they are last.
//
// Content scripts are classic scripts (not ES modules), so "exporting" means
// attaching a frozen object to the content-script global. That global lives in
// the extension's isolated world and is invisible to claude.ai's own scripts.
(() => {
  'use strict';

  // Text that starts the screen-reader heading inside a user turn.
  const USER_HEADING_PREFIX = /^\s*You said:\s*/;
  const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

  function userHeadingIn(article, q) {
    return q.all(article, HEADINGS).find((h) => USER_HEADING_PREFIX.test(q.text(h))) || null;
  }

  globalThis.ClaudeOutlineSelectors = Object.freeze({
    // The scrolling message list. First selector that matches wins.
    feed: [
      '[role="feed"][aria-label="Chat messages"]',
      '[role="feed"]',
    ],

    // One conversation turn (user or assistant).
    turn: 'article[aria-label^="Message"]',

    // Ordered fallback chain. The first strategy returning > 0 nodes is used.
    // Each `find(feed, q)` gets the feed element and the safe query helpers
    // (q.all / q.one / q.text never throw).
    userMessageStrategies: [
      {
        name: '[data-testid="user-message"]',
        find: (feed, q) => q.all(feed, '[data-testid="user-message"]'),
      },
      {
        name: 'article[aria-label^="Message"] with a "You said:" heading',
        find: (feed, q) =>
          q.all(feed, 'article[aria-label^="Message"]').filter((a) => userHeadingIn(a, q)),
      },
      {
        name: '.font-user-message',
        find: (feed, q) => q.all(feed, '.font-user-message'),
      },
    ],

    // Used to pull just the message body out of a whole <article> hit
    // (strategy 2), so the label doesn't include "You said:" or button text.
    userMessageBody: '[data-testid="user-message"], .font-user-message',
    userHeadingPrefix: USER_HEADING_PREFIX,
    userHeadingIn,

    // The lazy-load button at the top of long chats. Matched on text or
    // aria-label because it has no stable test id that we know of.
    loadEarlierButton: {
      selector: 'button',
      text: /^\s*Load earlier messages\s*$/i,
    },

    // Pages where the panel is shown. Project chats currently also live at
    // /chat/<id>; the /project/<id>/chat/<id> form is a defensive extra.
    conversationPaths: [
      /^\/chat\/[\w-]{8,}\/?$/,
      /^\/project\/[\w-]+\/chat\/[\w-]{8,}\/?$/,
    ],

    layout: {
      // Pixels kept between the scroller top and a message after navigating,
      // so the message isn't hidden under Claude's sticky chat header.
      scrollOffset: 80,
      // Where the panel starts vertically (roughly Claude's top bar height).
      panelTop: 56,
    },
  });
})();
