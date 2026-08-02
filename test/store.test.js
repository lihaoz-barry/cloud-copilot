'use strict';

/**
 * Tests for `store.forceAbort` (issue #61).
 *
 * This is the function behind an Abort that has nothing left to kill: the
 * process died with a previous dashboard, so the only thing left to fix is the
 * stored record. Getting it wrong is expensive in both directions — too timid
 * and the row stays stuck forever, too eager and it stamps "aborted" on a run
 * that is still going.
 *
 * Run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-store-data-'));
process.env.CC_DATA_DIR = dataDir;

// eslint-disable-next-line import/order
const store = require('../lib/store');

const REPO = 'demo-repo';

function resetState() {
  fs.rmSync(path.join(dataDir, 'state.json'), { force: true });
}

function seedWork(issue, status, extra = {}) {
  store.updateRecord(REPO, issue, (r) => {
    Object.assign(r.work, { status, startedAt: new Date(Date.now() - 5000).toISOString() }, extra);
  });
}

function seedPrAction(issue, prNumber, action, status) {
  const update = action === 'deploy' ? store.updateDeploy : action === 'merge' ? store.updateMerge : store.updateBranchUpdate;
  update(REPO, issue, prNumber, (s) => {
    s.status = status;
    s.startedAt = new Date(Date.now() - 5000).toISOString();
  });
}

test.beforeEach(resetState);
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('settles a Create PR left in `working`, once', () => {
  seedWork(1, 'working');

  assert.strictEqual(store.forceAbort(REPO, 1, 'work'), true);
  const rec = store.getRecord(REPO, 1);
  assert.strictEqual(rec.work.status, 'aborted');
  assert.ok(rec.work.finishedAt, 'finishedAt is filled in');
  assert.ok(rec.work.durationMs > 0, 'durationMs is recomputed');
  assert.match(rec.work.conversation, /PR creation was interrupted/);

  // Idempotent: a second Abort must not change anything or double the note.
  assert.strictEqual(store.forceAbort(REPO, 1, 'work'), false);
  const again = store.getRecord(REPO, 1);
  assert.strictEqual(again.work.finishedAt, rec.work.finishedAt);
  assert.strictEqual(again.work.conversation, rec.work.conversation);
});

test('never touches a record that is not in the action\'s live status', () => {
  for (const status of ['idle', 'success', 'failed', 'aborted', 'blocked']) {
    resetState();
    seedWork(2, status);
    assert.strictEqual(store.forceAbort(REPO, 2, 'work'), false, `status ${status}`);
    assert.strictEqual(store.getRecord(REPO, 2).work.status, status);
  }
});

test('settles per-PR deploy, merge and update slots independently', () => {
  seedPrAction(3, 42, 'deploy', 'deploying');
  seedPrAction(3, 42, 'merge', 'merging');
  seedPrAction(3, 42, 'update', 'updating');

  assert.strictEqual(store.forceAbort(REPO, 3, 'deploy', 42), true);
  let pr = store.getRecord(REPO, 3).prs[42];
  assert.strictEqual(pr.deploy.status, 'aborted');
  assert.ok(pr.deploy.durationMs > 0);
  assert.strictEqual(pr.merge.status, 'merging', 'merge is left alone');
  assert.strictEqual(pr.update.status, 'updating', 'update is left alone');

  assert.strictEqual(store.forceAbort(REPO, 3, 'merge', 42), true);
  assert.strictEqual(store.forceAbort(REPO, 3, 'update', 42), true);
  pr = store.getRecord(REPO, 3).prs[42];
  assert.strictEqual(pr.merge.status, 'aborted');
  assert.strictEqual(pr.update.status, 'aborted');
});

test('a PR that does not exist is not invented', () => {
  seedWork(4, 'working');
  assert.strictEqual(store.forceAbort(REPO, 4, 'deploy', 999), false);
  assert.deepStrictEqual(Object.keys(store.getRecord(REPO, 4).prs), []);
});

test('unknown actions and unknown issues never write a record', () => {
  seedWork(5, 'working');
  const before = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');

  assert.strictEqual(store.forceAbort(REPO, 5, 'chat'), false, 'unknown action');
  // The cancel routes are unauthenticated: aborting an issue nobody ever ran
  // must not create a row for it.
  assert.strictEqual(store.forceAbort(REPO, 99999, 'work'), false);
  assert.strictEqual(store.forceAbort(REPO, NaN, 'work'), false);
  assert.strictEqual(store.forceAbort('no-such-repo', 5, 'work'), false);

  assert.strictEqual(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), before);
});
