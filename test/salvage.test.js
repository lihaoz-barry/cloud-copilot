'use strict';

/**
 * Tests for the deploy preflight's verification gate (`lib/salvage.js`).
 *
 * This is the check that decides whether it is safe to run `git checkout` over
 * a working tree whose uncommitted changes were just handed to an agent — so
 * every way the salvage can *look* finished without actually being finished is
 * worth a test. git and gh are faked; the real ones are exercised by a live
 * deploy, but the decision logic must not depend on that.
 *
 * Run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSalvageChecks, prNumbersFromTranscript } = require('../lib/salvage');

const OWNER = 'acme/widget';
const SALVAGE_OID = 'a'.repeat(40);

// git double: only the handful of commands lib/salvage.js issues.
function fakeGit({ dirty = '', remotes = ['origin/salvage-7-fix'], ancestorOf = [SALVAGE_OID] } = {}) {
  const calls = [];
  const fn = (repoPath, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'status') return dirty;
    if (args[0] === 'branch') return remotes.join('\n');
    if (args[0] === 'merge-base') {
      if (!ancestorOf.includes(args[3])) throw new Error(`Command failed: git merge-base ${args[3]}`);
      return '';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  fn.calls = calls;
  return fn;
}

const openPr = (over = {}) => ({
  number: 77,
  url: `https://github.com/${OWNER}/pull/77`,
  state: 'OPEN',
  headRefName: 'salvage-7-fix',
  headRefOid: SALVAGE_OID,
  ...over,
});

function fakeGh({ prs = {}, byHead = [], branch = 'salvage-7-fix' } = {}) {
  return {
    getPr: async (_ownerRepo, number) => prs[number] || null,
    listPrsForHead: async () => byHead,
    gitBranch: () => branch,
  };
}

const args = (over = {}) => ({
  exitCode: 0,
  repoPath: '/repo',
  ownerRepo: OWNER,
  conversation: `opened https://github.com/${OWNER}/pull/77\n`,
  deployPrNumber: 18,
  deployBranch: 'feature/deploy-me',
  defaultBranch: 'main',
  ...over,
});

async function rejects(promise, re) {
  await assert.rejects(promise, (err) => {
    assert.match(err.message, re);
    return true;
  });
}

test('transcript PR numbers: deploy PR excluded, deduped, last printed first', () => {
  const transcript = [
    `looked at https://github.com/${OWNER}/pull/18`, // the deploy's own PR
    `also https://github.com/${OWNER}/pull/12`,
    `created https://github.com/${OWNER}/pull/12`, // duplicate
    `PR: https://github.com/${OWNER}/pull/77`,
    'unrelated https://github.com/other/repo/pull/99',
  ].join('\n');
  assert.deepStrictEqual(prNumbersFromTranscript(transcript, OWNER, 18), [77, 12]);
});

test('transcript PR numbers: owner/repo is matched literally, not as a regex', () => {
  const weird = 'a.c/w+dget';
  assert.deepStrictEqual(prNumbersFromTranscript('github.com/abc/wXdget/pull/5', weird, null), []);
  assert.deepStrictEqual(prNumbersFromTranscript(`github.com/${weird}/pull/5`, weird, null), [5]);
});

test('a salvage that exited non-zero never reaches the deploy', async () => {
  const checks = createSalvageChecks({ git: fakeGit(), gh: fakeGh({ prs: { 77: openPr() } }) });
  await rejects(checks.assertSalvaged(args({ exitCode: 3 })), /exited 3 .* were NOT committed/s);
});

test('a still-dirty tree is refused, with the file list', async () => {
  const checks = createSalvageChecks({
    git: fakeGit({ dirty: ' M server.js\n?? notes.txt' }),
    gh: fakeGh({ prs: { 77: openPr() } }),
  });
  await rejects(checks.assertSalvaged(args()), /still dirty:\n M server\.js\n\?\? notes\.txt/);
});

test('a commit that was never pushed is refused', async () => {
  const checks = createSalvageChecks({
    git: fakeGit({ remotes: [] }),
    gh: fakeGh({ prs: { 77: openPr() } }),
  });
  await rejects(checks.assertSalvaged(args()), /nothing was pushed to origin/);
});

test('a real open PR carrying the salvaged commit passes', async () => {
  const checks = createSalvageChecks({ git: fakeGit(), gh: fakeGh({ prs: { 77: openPr() } }) });
  const pr = await checks.assertSalvaged(args());
  assert.strictEqual(pr.number, 77);
});

test('a PR URL the agent printed but never created is refused', async () => {
  // The failure mode the review flagged: `gh` dies after the commit, the agent
  // reports a URL anyway, the tree is clean — and the deploy would bury the work.
  const checks = createSalvageChecks({ git: fakeGit(), gh: fakeGh({ prs: {}, byHead: [] }) });
  await rejects(checks.assertSalvaged(args()), /no pull request could be verified.*#77/s);
});

test('a PR that does not contain the salvaged commit is refused', async () => {
  // Resolves on GitHub, but its head is some other branch: printing the URL of
  // a PR that happens to exist must not satisfy the gate.
  const checks = createSalvageChecks({
    git: fakeGit({ ancestorOf: [] }),
    gh: fakeGh({ prs: { 77: openPr({ headRefName: 'someone-elses-branch', headRefOid: 'b'.repeat(40) }) } }),
  });
  await rejects(checks.assertSalvaged(args()), /no pull request could be verified/);
});

test('a closed or merged PR does not count as a rescue', async () => {
  const checks = createSalvageChecks({
    git: fakeGit(),
    gh: fakeGh({ prs: { 77: openPr({ state: 'MERGED' }) } }),
  });
  await rejects(checks.assertSalvaged(args()), /no pull request could be verified/);
});

test('a PR headed by the default branch is refused (no salvage branch was cut)', async () => {
  const checks = createSalvageChecks({
    git: fakeGit({ remotes: ['origin/main'] }),
    gh: fakeGh({ prs: { 77: openPr({ headRefName: 'main' }) }, branch: 'main' }),
  });
  await rejects(checks.assertSalvaged(args()), /no pull request could be verified/);
});

test("the deploy's own PR is never mistaken for the salvage's", async () => {
  const checks = createSalvageChecks({
    git: fakeGit(),
    gh: fakeGh({ prs: { 18: openPr({ number: 18, headRefName: 'feature/deploy-me' }) } }),
  });
  await rejects(
    checks.assertSalvaged(args({ conversation: `deploying https://github.com/${OWNER}/pull/18\n` })),
    /no pull request could be verified/,
  );
});

test('with no URL printed, a PR on the branch left checked out is accepted', async () => {
  const checks = createSalvageChecks({
    git: fakeGit(),
    gh: fakeGh({ prs: {}, byHead: [openPr({ number: 91 })] }),
  });
  const pr = await checks.assertSalvaged(args({ conversation: 'all done, tree is clean\n' }));
  assert.strictEqual(pr.number, 91);
});

test('branch containment falls back to the remote-tracking name when the sha is unknown', async () => {
  // `merge-base --is-ancestor` also fails when the object is not in this clone
  // (a PR opened from a fork, say), so the branch name is the backstop.
  const checks = createSalvageChecks({
    git: fakeGit({ ancestorOf: [], remotes: ['origin/salvage-7-fix', 'origin/HEAD -> origin/main'] }),
    gh: fakeGh({ prs: { 77: openPr({ headRefOid: null }) } }),
  });
  const pr = await checks.assertSalvaged(args());
  assert.strictEqual(pr.number, 77);
});

test('`origin/HEAD -> origin/main` alias lines are normalised', () => {
  const checks = createSalvageChecks({
    git: fakeGit({ remotes: ['  origin/HEAD -> origin/main', '  origin/main'] }),
    gh: fakeGh(),
  });
  assert.deepStrictEqual(checks.remoteBranchesContainingHead('/repo'), ['origin/HEAD', 'origin/main']);
});

test('git failures are treated as "not verified", never as success', async () => {
  const boom = () => {
    throw new Error('fatal: not a git repository');
  };
  const checks = createSalvageChecks({ git: boom, gh: fakeGh({ prs: { 77: openPr() } }) });
  await rejects(checks.assertSalvaged(args()), /nothing was pushed to origin/);
});
