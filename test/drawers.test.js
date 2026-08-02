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
