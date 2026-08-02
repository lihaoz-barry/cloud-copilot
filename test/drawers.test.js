'use strict';

/**
 * Regression tests for issue #21 — the mobile 🔔 Alerts / ⏩ Depth drawers were
 * painted under the floating top nav pill.
 *
 * public/index.html is a single self-contained page with no build step and no
 * DOM test harness in this repo, so these assertions read the shipped markup
 * and stylesheet directly. They are deliberately about the contract the issue
 * asks for (stacking order, safe-area insets, three ways to dismiss, a11y
 * wiring) rather than exact pixel values.
 *
 * Run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

/** Body of the last rule whose selector list matches `selector` exactly. */
function ruleBody(selector) {
  const re = new RegExp(`(?:^|[};]|\\*/)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  let body = null;
  let m;
  while ((m = re.exec(css)) !== null) body = m[1];
  assert.ok(body !== null, `no CSS rule found for selector \`${selector}\``);
  return body;
}

function zIndex(selector) {
  const m = /z-index:\s*(-?\d+)/.exec(ruleBody(selector));
  assert.ok(m, `\`${selector}\` has no z-index`);
  return Number(m[1]);
}

test('drawers and their scrim stack above the floating navbar', () => {
  const navbar = zIndex('.navbar');
  for (const sel of ['.settings-drawer', '.depth-drawer', '.depth-scrim']) {
    assert.ok(
      zIndex(sel) > navbar,
      `${sel} z-index (${zIndex(sel)}) must be above .navbar (${navbar})`,
    );
  }
  // The scrim must stay behind the drawer it dims, or taps hit the scrim.
  assert.ok(zIndex('.depth-scrim') < zIndex('.settings-drawer'));
  assert.ok(zIndex('.depth-scrim') < zIndex('.depth-drawer'));
});

test('drawer chrome respects the iOS status-bar and home-indicator insets', () => {
  assert.match(ruleBody('.drawer-head'), /env\(safe-area-inset-top/);
  assert.match(ruleBody('.drawer-body'), /env\(safe-area-inset-bottom/);
  // Sticky head + scrollable body: long content can't push the title off screen.
  assert.match(ruleBody('.drawer-head'), /position:\s*sticky/);
  assert.match(ruleBody('.drawer-body'), /overflow-y:\s*auto/);
  assert.match(ruleBody('.settings-drawer, .depth-drawer'), /flex-direction:\s*column/);
});

test('drawers are sized against the dynamic viewport and keep their scroll to themselves', () => {
  for (const sel of ['.settings-drawer', '.depth-drawer']) {
    const body = ruleBody(sel);
    // A plain `height: 100%` on a fixed element resolves against the *large*
    // viewport, so on iOS Safari the home-indicator padding added above — and
    // the drawer's last button — end up under the collapsing URL bar.
    assert.match(body, /height:\s*100dvh/, `${sel} must be sized in dvh`);
    assert.match(body, /height:\s*100%/, `${sel} must keep a % fallback for browsers without dvh`);
    assert.ok(body.indexOf('100%') < body.indexOf('100dvh'), `${sel}: the % fallback must come first`);
  }
  // Scrolling past the end of the drawer must not chain into the page behind
  // the scrim, which reads as the drawer being broken.
  assert.match(ruleBody('.drawer-body'), /overscroll-behavior:\s*contain/);
});

test('closed drawers are hidden from pointer, focus and assistive tech', () => {
  for (const sel of ['.settings-drawer', '.depth-drawer']) {
    assert.match(ruleBody(sel), /visibility:\s*hidden/, `${sel} must be visibility:hidden while closed`);
    assert.match(ruleBody(`${sel}.show`), /visibility:\s*visible/);
  }
});

test('both drawers are dialogs with a visible close button', () => {
  for (const [drawerId, closeId] of [['notifyDrawer', 'notifyClose'], ['depthDrawer', 'depthClose']]) {
    const tag = new RegExp(`<div id="${drawerId}"[^>]*>`).exec(html);
    assert.ok(tag, `#${drawerId} not found`);
    assert.match(tag[0], /role="dialog"/);
    assert.match(tag[0], /aria-modal="true"/);
    assert.match(tag[0], /aria-hidden="true"/, `#${drawerId} must start hidden`);
    assert.match(html, new RegExp(`id="${closeId}"[^>]*aria-label=`), `#${closeId} needs an accessible name`);
    assert.match(html, new RegExp(`${closeId}[\\s\\S]{0,200}?addEventListener\\('click'`), `#${closeId} is not wired up`);
  }
});

test('scrim tap and Esc still dismiss the drawers', () => {
  assert.match(html, /depthScrim\.addEventListener\('click', closeDepthDrawer\)/);
  assert.match(html, /notifyScrim\.addEventListener\('click', closeNotifyDrawer\)/);
  const esc = /if \(e\.key !== 'Escape'\) return;[\s\S]{0,300}?\}\);/.exec(html);
  assert.ok(esc, 'no Escape handler for the drawers');
  assert.match(esc[0], /closeNotifyDrawer\(\)/);
  assert.match(esc[0], /closeDepthDrawer\(\)/);
});

test('opening one drawer closes the other', () => {
  const openDepth = /function openDepthDrawer\(\)[\s\S]*?\n\}/.exec(html)[0];
  const openNotify = /function openNotifyDrawer\(\)[\s\S]*?\n\}/.exec(html)[0];
  assert.match(openDepth, /closeNotifyDrawer\(\)/);
  assert.match(openNotify, /closeDepthDrawer\(\)/);
});

test('sub-headings inside the scrolling body keep the compact drawer sizing', () => {
  // The notify drawer ships a second <h3> ("📲 Phone push"). Before the
  // head/body split it was styled by `.settings-drawer h3`; with no body rule
  // it falls back to the UA's 1.17em / 1em-margin heading and looks broken.
  assert.match(ruleBody('.drawer-body h3'), /font-size:\s*1rem/);
  const bodies = html.match(/<div class="drawer-body">[\s\S]*?\n  <\/div>/g) || [];
  const bodyH3s = bodies.reduce((n, b) => n + (b.match(/<h3/g) || []).length, 0);
  assert.ok(bodyH3s > 0, 'expected at least one <h3> inside a .drawer-body');
});

test('Tab is trapped inside the open drawer, as aria-modal promises', () => {
  const helper = /function drawerFocusables\(drawer\)[\s\S]*?\n\}/.exec(html);
  assert.ok(helper, 'no drawerFocusables() helper');
  // A radio group is a single tab stop; counting every radio puts `last` on an
  // unreachable element and Tab escapes the drawer. The ⏩ Depth drawer is all
  // radios, so this is not a theoretical case.
  assert.match(helper[0], /radio/);
  assert.match(helper[0], /checked/);

  const handler = /if \(e\.key !== 'Tab'\) return;[\s\S]*?\n\}\);/.exec(html);
  assert.ok(handler, 'no Tab handler for the drawers');
  assert.match(handler[0], /openDrawerEl\(\)/);
  assert.match(handler[0], /e\.preventDefault\(\)/);
  assert.match(handler[0], /shiftKey/, 'Shift+Tab must wrap backwards too');
});

test('closing a drawer never strands focus on a hidden element', () => {
  for (const [fn, fab, scrim] of [
    ['closeNotifyDrawer', 'notifyFab', 'notifyScrim'],
    ['closeDepthDrawer', 'depthFab', 'depthScrim'],
  ]) {
    const src = new RegExp(`function ${fn}\\(\\)[\\s\\S]*?\\n\\}`).exec(html);
    assert.ok(src, `no ${fn}()`);
    assert.match(src[0], new RegExp(`${fab}\\.focus\\(`), `${fn} must return focus to #${fab}`);
    // A scrim tap blurs the focused control before the click handler runs, so
    // document.activeElement is <body> — that must still count as "inside".
    assert.match(src[0], /document\.body/, `${fn} must handle a blurred (body) focus`);
    assert.match(src[0], new RegExp(scrim), `${fn} must handle focus sitting on the scrim`);
  }
  // Moving focus must not scroll the page behind the drawer.
  const focusCalls = html.match(/\b(?:notifyFab|depthFab|notifyCloseBtn|depthCloseBtn)\.focus\([^)]*\)/g) || [];
  assert.ok(focusCalls.length >= 4, 'expected focus() calls on both FABs and both ✕ buttons');
  for (const call of focusCalls) assert.match(call, /preventScroll:\s*true/, `${call} should preventScroll`);
});
