'use strict';

/**
 * Tests for the persisted project-type override (issue #70).
 *
 * The override has to live on the server: it is what the long-press writes, and
 * losing it on a browser change would silently hand the repo back to
 * auto-detection — which is exactly what the user just disagreed with.
 *
 * Run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ptype-data-'));
process.env.CC_DATA_DIR = dataDir;

// eslint-disable-next-line import/order
const store = require('../lib/store');

function reset() {
  fs.rmSync(path.join(dataDir, 'state.json'), { force: true });
}

test('a repo with no override follows auto-detection', () => {
  reset();
  assert.equal(store.getProjectTypeOverride('demo'), null);
});

test('an override round-trips through the state file', () => {
  reset();
  store.setProjectTypeOverride('demo', 'ios');
  assert.equal(store.getProjectTypeOverride('demo'), 'ios');
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(raw.settings.projectTypes.demo, 'ios');
});

test('overrides are per repo', () => {
  reset();
  store.setProjectTypeOverride('demo', 'ios');
  store.setProjectTypeOverride('other', 'web');
  assert.equal(store.getProjectTypeOverride('demo'), 'ios');
  assert.equal(store.getProjectTypeOverride('other'), 'web');
  assert.deepEqual(store.getProjectTypeOverrides(), { demo: 'ios', other: 'web' });
});

test('null clears the override back to auto', () => {
  reset();
  store.setProjectTypeOverride('demo', 'web');
  assert.equal(store.setProjectTypeOverride('demo', null), null);
  assert.equal(store.getProjectTypeOverride('demo'), null);
});

test('an unknown type is refused rather than stored', () => {
  reset();
  assert.throws(() => store.setProjectTypeOverride('demo', 'android'), /unknown project type/);
  assert.throws(() => store.setProjectTypeOverride('demo', 'unknown'), /unknown project type/);
  assert.equal(store.getProjectTypeOverride('demo'), null);
});

test('an empty repo name is refused', () => {
  reset();
  assert.throws(() => store.setProjectTypeOverride('', 'ios'), /non-empty/);
});

test('a junk value already in the state file is ignored', () => {
  reset();
  store.setProjectTypeOverride('demo', 'ios');
  const file = path.join(dataDir, 'state.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.settings.projectTypes.demo = 'android';
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(store.getProjectTypeOverride('demo'), null);
});
