'use strict';

/**
 * Tests for the scheduler's decision function (issue #64).
 *
 * `decide()` is where the automation earns or loses its trust: it is what picks
 * "open a PR" over "review", and a mistake there means either a duplicate PR or
 * an issue that silently never moves again. Every call it makes to the
 * dashboard is injected through `init({ api })`, so these run with stub
 * dependencies and one throwaway git repository for the head-sha lookup.
 *
 * Run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The scheduler persists its settings on init; point that at a scratch dir
// before requiring it so a test run never touches the real data/.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sched-data-'));
process.env.CC_DATA_DIR = dataDir;

// eslint-disable-next-line import/order
const scheduler = require('../lib/schedulerCore');

let repoPath;
let headSha;

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test.before(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-scheduler-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', repoPath]);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoPath, 'a.txt'), 'hello\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '--quiet', '-m', 'initial']);
  headSha = git(repoPath, ['rev-parse', 'HEAD']);
  // The scheduler reads the branch tip from the remote-tracking ref, which is
  // what a push from any worktree updates.
  git(repoPath, ['update-ref', 'refs/remotes/origin/feature', headSha]);
});

test.after(() => {
  for (const dir of [repoPath, dataDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const repo = () => ({ name: 'demo', path: repoPath, ownerRepo: 'acme/demo' });

/**
 * Wire the scheduler up with stub dashboard calls; returns what was recorded.
 *
 * `afterRefresh` stands in for what the dashboard writes into the record when
 * it re-reads GitHub — that endpoint upserts what it finds, so the scheduler
 * only ever re-reads rather than merging anything itself.
 */
function withApi({ afterRefresh = null, refreshFails = false } = {}) {
  const calls = { refresh: 0 };
  scheduler.init({
    api: {
      refreshPrs: async () => {
        calls.refresh += 1;
        if (refreshFails) throw new Error('gh is unreachable');
        return {};
      },
      getRecord: async () => afterRefresh || { prs: {} },
    },
  });
  return calls;
}

const prRecord = (pr) => ({ prs: { [String(pr.prNumber)]: pr } });

test('an issue with no PR anywhere gets one created', async () => {
  const calls = withApi();
  const task = await scheduler.decide(repo(), { number: 12 }, { prs: {} });
  assert.deepStrictEqual(task, { action: 'work' });
  assert.strictEqual(calls.refresh, 1, 'GitHub is re-checked before creating anything');
});

test('a merged PR cannot be adopted, so it never stalls the issue', async () => {
  const merged = prRecord({ prNumber: 3, state: 'MERGED', headRefName: 'old' });
  const calls = withApi({ afterRefresh: merged });
  const task = await scheduler.decide(repo(), { number: 12 }, { prs: {} });
  assert.deepStrictEqual(task, { action: 'work' }, 'a merged PR must not stall the issue');
  assert.strictEqual(calls.refresh, 1);
});

test('a PR opened by hand is adopted instead of duplicated', async () => {
  const adopted = prRecord({
    prNumber: 9,
    state: 'OPEN',
    headRefName: 'feature',
    sync: null,
    review: { lastReviewedSha: null },
  });
  const calls = withApi({ afterRefresh: adopted });
  const task = await scheduler.decide(repo(), { number: 12 }, { prs: {} });
  assert.strictEqual(task, null, 'nothing is started this sweep — the PR is only recorded');
  assert.strictEqual(calls.refresh, 1);
});

test('GitHub being unreachable never produces a second PR', async () => {
  const calls = withApi({ refreshFails: true });
  const task = await scheduler.decide(repo(), { number: 12 }, { prs: {} });
  assert.strictEqual(task, null, 'an unverifiable "no PR yet" must not be acted on');
  assert.strictEqual(calls.refresh, 1);
});

test('a PR behind its base is updated before anything else', async () => {
  const record = prRecord({
    prNumber: 9,
    state: 'OPEN',
    headRefName: 'feature',
    sync: { state: 'behind', behindBy: 4 },
    review: { lastReviewedSha: null },
  });
  const calls = withApi();
  assert.deepStrictEqual(await scheduler.decide(repo(), { number: 12 }, record), {
    action: 'update',
    prNumber: 9,
  });
  assert.strictEqual(calls.refresh, 0, 'a decidable record costs no GitHub calls');
});

test('a conflicting PR is updated even when the behind count says zero', async () => {
  const record = prRecord({
    prNumber: 9,
    state: 'OPEN',
    headRefName: 'feature',
    sync: { state: 'conflict', behindBy: 0 },
    review: { lastReviewedSha: headSha },
  });
  withApi();
  assert.deepStrictEqual(await scheduler.decide(repo(), { number: 12 }, record), {
    action: 'update',
    prNumber: 9,
  });
});

test('an up-to-date PR is reviewed once per head commit', async () => {
  const clean = { state: 'clean', behindBy: 0 };
  const unreviewed = prRecord({
    prNumber: 9,
    state: 'OPEN',
    headRefName: 'feature',
    sync: clean,
    review: { lastReviewedSha: null },
  });
  withApi();
  assert.deepStrictEqual(await scheduler.decide(repo(), { number: 12 }, unreviewed), {
    action: 'review',
    prNumber: 9,
  });

  const reviewed = prRecord({
    prNumber: 9,
    state: 'OPEN',
    headRefName: 'feature',
    sync: clean,
    review: { lastReviewedSha: headSha },
  });
  const calls = withApi();
  assert.strictEqual(
    await scheduler.decide(repo(), { number: 12 }, reviewed),
    null,
    'the same commit is never reviewed twice',
  );
  assert.strictEqual(calls.refresh, 0);
});

test('a PR with no comparison yet is compared before being acted on', async () => {
  const record = prRecord({
    prNumber: 9,
    state: 'OPEN',
    headRefName: 'feature',
    sync: null,
    review: { lastReviewedSha: null },
  });
  // The refresh writes a real comparison into the record, as the real sweep
  // would; without it this PR would be reviewed against a diff about to change.
  const synced = prRecord({
    prNumber: 9,
    state: 'OPEN',
    headRefName: 'feature',
    sync: { state: 'behind', behindBy: 1 },
    review: { lastReviewedSha: null },
  });
  const calls = withApi({ afterRefresh: synced });
  const task = await scheduler.decide(repo(), { number: 12 }, record);
  assert.strictEqual(calls.refresh, 1, 'it asks rather than guessing');
  assert.deepStrictEqual(task, { action: 'update', prNumber: 9 });
});

test("merged and closed PRs are not treated as the issue's open PR", async () => {
  const record = {
    prs: {
      8: { prNumber: 8, state: 'MERGED', headRefName: 'old' },
      9: { prNumber: 9, state: 'CLOSED', headRefName: 'older' },
    },
  };
  const calls = withApi({ afterRefresh: record });
  assert.deepStrictEqual(await scheduler.decide(repo(), { number: 12 }, record), { action: 'work' });
  assert.strictEqual(calls.refresh, 1);
});
