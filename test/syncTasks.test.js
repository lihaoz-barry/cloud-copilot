'use strict';

const helpers = require('./helpers');
const sandboxDir = helpers.sandbox('cc-sync-');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

fs.writeFileSync(
  process.env.CC_QUEUE_CONFIG,
  JSON.stringify({ worktreeRoot: path.join(sandboxDir, 'worktrees') }),
);

const worktree = require('../lib/worktree');
const sync = require('../lib/syncTasks');
const { git } = helpers;

/**
 * A repo with a REAL push target, so the merge path can be verified end to end
 * (a GitHub-looking URL would fail on push). ownerRepo is filled in by hand
 * because nothing under test parses it.
 */
function makeRepoWithRemote(name) {
  const root = path.join(sandboxDir, name);
  const bare = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(root, { recursive: true });
  git(sandboxDir, ['init', '-q', '--bare', '-b', 'main', bare]);

  fs.mkdirSync(work, { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'user.email', 't@e.c']);
  git(work, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(work, 'base.txt'), 'base\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', 'initial']);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  return { name, path: work, bare, ownerRepo: 'test-owner/test-repo', github: true };
}

/** Create a branch on origin that is one commit behind main. */
function pushBranch(repo, branch, file, contents) {
  git(repo.path, ['checkout', '-q', '-b', branch, 'origin/main']);
  helpers.commitFile(repo.path, file, contents, `work on ${branch}`);
  git(repo.path, ['push', '-q', '-u', 'origin', branch]);
  git(repo.path, ['checkout', '-q', 'main']);
}

/** Advance origin/main by one commit. */
function advanceMain(repo, file, contents) {
  git(repo.path, ['checkout', '-q', 'main']);
  helpers.commitFile(repo.path, file, contents, 'main moves on');
  git(repo.path, ['push', '-q', 'origin', 'main']);
}

test('A4.1/A4.2 behindCount reports the gap, and 0 when up to date', () => {
  const repo = makeRepoWithRemote('behind');
  pushBranch(repo, 'feat-a', 'a.txt', 'a\n');
  assert.equal(sync.behindCount(repo.path, 'feat-a', 'main'), 0, 'freshly cut → not behind');

  advanceMain(repo, 'main.txt', 'moved\n');
  git(repo.path, ['fetch', '-q', 'origin', '--prune']);
  assert.equal(sync.behindCount(repo.path, 'feat-a', 'main'), 1);
});

test('A4.3 a clean merge is committed and pushed', () => {
  const repo = makeRepoWithRemote('mergeable');
  pushBranch(repo, 'feat-b', 'b.txt', 'b\n');
  advanceMain(repo, 'unrelated.txt', 'moved\n');
  worktree.ensure(repo);

  const res = sync.runSyncBranch(repo, 'feat-b');
  assert.equal(res.outcome, 'merged', res.message);

  git(repo.path, ['fetch', '-q', 'origin', '--prune']);
  assert.equal(sync.behindCount(repo.path, 'feat-b', 'main'), 0, 'the push actually landed');
});

test('A4.4/A4.5 a conflict is aborted and leaves a CLEAN worktree', () => {
  const repo = makeRepoWithRemote('conflicting');
  pushBranch(repo, 'feat-c', 'clash.txt', 'ours\n');
  advanceMain(repo, 'clash.txt', 'theirs\n');
  worktree.ensure(repo);

  const res = sync.runSyncBranch(repo, 'feat-c');
  assert.equal(res.outcome, 'conflict', res.message);

  // The whole point: the next task in the serial queue shares this worktree.
  assert.ok(worktree.isClean(repo), 'a conflicted tree must never be handed on');
  assert.equal(
    worktree.git(worktree.pathFor(repo.name), ['ls-files', '-u'], { allowFail: true }),
    '',
  );
  assert.equal(worktree.currentBranch(repo), null, 'the branch is released too');
});

test('A4.2b an already-current branch is skipped without touching anything', () => {
  const repo = makeRepoWithRemote('current');
  pushBranch(repo, 'feat-d', 'd.txt', 'd\n');
  worktree.ensure(repo);

  const res = sync.runSyncBranch(repo, 'feat-d');
  assert.equal(res.outcome, 'uptodate');
});

test('A4.6/A4.7 verifySynced trusts git, not the agent', () => {
  const repo = makeRepoWithRemote('verify');
  pushBranch(repo, 'feat-e', 'e.txt', 'e\n');
  assert.equal(sync.verifySynced(repo, 'feat-e'), true);

  advanceMain(repo, 'later.txt', 'later\n');
  assert.equal(
    sync.verifySynced(repo, 'feat-e'),
    false,
    'an agent claiming success cannot make a behind branch current',
  );
});

test('A4 sync-scan lists exactly the branches that are behind', async () => {
  const repo = makeRepoWithRemote('scan');
  pushBranch(repo, 'feat-x', 'x.txt', 'x\n');
  pushBranch(repo, 'feat-y', 'y.txt', 'y\n');
  advanceMain(repo, 'moved.txt', 'moved\n');
  // feat-z is cut AFTER main moved, so it is current.
  pushBranch(repo, 'feat-z', 'z.txt', 'z\n');
  worktree.ensure(repo);

  const fakeGh = {
    listAllPrs: async () => ({
      prs: [
        { number: 1, headRefName: 'feat-x', title: 'x' },
        { number: 2, headRefName: 'feat-y', title: 'y' },
        { number: 3, headRefName: 'feat-z', title: 'z' },
      ],
    }),
  };

  const result = await sync.runSyncScan(repo, { gh: fakeGh });
  assert.equal(result.checked, 3);
  assert.deepEqual(
    result.behind.map((b) => b.branch).sort(),
    ['feat-x', 'feat-y'],
    'only branches actually behind main are queued',
  );
});

test('the conflict prompt names the branch and forbids branch/PR side effects', () => {
  const p = sync.conflictPrompt({
    ownerRepo: 'o/r',
    branch: 'feat-q',
    defaultBranch: 'main',
    prNumber: 7,
  });
  assert.match(p, /feat-q/);
  assert.match(p, /origin\/main/);
  assert.match(p, /#7/);
  assert.match(p, /do not create any new branch/i);
  assert.match(p, /SYNC_OK/);
});
