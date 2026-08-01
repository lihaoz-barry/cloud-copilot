'use strict';

const helpers = require('./helpers');
const sandboxDir = helpers.sandbox('cc-wt-');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Point worktrees at the sandbox before anything reads the config.
fs.writeFileSync(
  process.env.CC_QUEUE_CONFIG,
  JSON.stringify({ worktreeRoot: path.join(sandboxDir, 'worktrees') }),
);

const worktree = require('../lib/worktree');
const queue = require('../lib/queue');

const reposRoot = path.join(sandboxDir, 'repos');
fs.mkdirSync(reposRoot, { recursive: true });
const repo = helpers.makeRepo(reposRoot, 'demo');

test('A3.1 the first ensure() creates a detached worktree', () => {
  const wt = worktree.ensure(repo);
  assert.ok(fs.existsSync(wt.path));
  assert.equal(worktree.currentBranch(repo), null, 'a fresh worktree owns no branch');
  assert.equal(wt.created, true);
});

test('A3.2 a second ensure() reuses it without re-bootstrapping', () => {
  const before = queue.worktreeInfo('demo').bootstrappedAt;
  const wt = worktree.ensure(repo);
  assert.equal(wt.created, false);
  assert.equal(queue.worktreeInfo('demo').bootstrappedAt, before);
});

test('A3.3 reset() reverts changes to tracked files', () => {
  const wt = worktree.pathFor('demo');
  fs.writeFileSync(path.join(wt, 'README.md'), 'vandalised');
  worktree.reset(repo);
  assert.equal(fs.readFileSync(path.join(wt, 'README.md'), 'utf8'), '# test\n');
});

test('A3.4 reset() KEEPS ignored files (node_modules must survive)', () => {
  const wt = worktree.pathFor('demo');
  fs.writeFileSync(path.join(wt, '.gitignore'), 'node_modules/\n');
  helpers.git(wt, ['add', '-A']);
  helpers.git(wt, ['-c', 'user.email=t@e.c', '-c', 'user.name=t', 'commit', '-qm', 'ignore']);

  fs.mkdirSync(path.join(wt, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'node_modules', 'pkg', 'index.js'), '// installed');

  worktree.reset(repo);
  assert.ok(
    fs.existsSync(path.join(wt, 'node_modules', 'pkg', 'index.js')),
    'clean -df (not -xdf) is what makes bootstrap a one-time cost',
  );
});

test('A3.5 reset() removes untracked files that are NOT ignored', () => {
  const wt = worktree.pathFor('demo');
  fs.writeFileSync(path.join(wt, 'stray.txt'), 'left over from a previous task');
  worktree.reset(repo);
  assert.equal(fs.existsSync(path.join(wt, 'stray.txt')), false);
});

test('A3.6 prepareBranch() puts the worktree on a fresh branch off the default', () => {
  worktree.prepareBranch(repo, 'cc/issue-42');
  assert.equal(worktree.currentBranch(repo), 'cc/issue-42');
});

test('A3.7 release() detaches HEAD again', () => {
  worktree.release(repo);
  assert.equal(worktree.currentBranch(repo), null);
});

test('A3.8 after release() the MAIN tree can check out that branch', () => {
  // This is the regression that motivated release(): git allows a branch in
  // exactly one worktree, so a task that ended while still on cc/issue-42
  // would make a later Deploy fail with "already checked out at ...".
  worktree.prepareBranch(repo, 'cc/issue-99');
  assert.throws(
    () => helpers.git(repo.path, ['checkout', 'cc/issue-99']),
    /already (checked out|used by worktree)/i,
    'sanity: git really does refuse while the worktree holds it',
  );

  worktree.release(repo);
  helpers.git(repo.path, ['checkout', '-q', 'cc/issue-99']);
  assert.equal(helpers.git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'cc/issue-99');
  helpers.git(repo.path, ['checkout', '-q', 'main']);
});

test('A3.9 a hand-deleted worktree directory is rebuilt', () => {
  fs.rmSync(worktree.pathFor('demo'), { recursive: true, force: true });
  const wt = worktree.ensure(repo);
  assert.equal(wt.created, true);
  assert.ok(fs.existsSync(wt.path));
});

test('A3.10 a changed lockfile triggers refresh, an unchanged one does not', () => {
  const marker = path.join(sandboxDir, 'refresh-count');
  fs.writeFileSync(marker, '');
  fs.writeFileSync(
    path.join(repo.path, '.cloud-copilot.json'),
    JSON.stringify({
      worktree: { bootstrap: `echo b >> ${marker}`, refresh: `echo r >> ${marker}`, port: 9999 },
    }),
  );
  helpers.git(repo.path, ['add', '-A']);
  helpers.git(repo.path, ['-c', 'user.email=t@e.c', '-c', 'user.name=t', 'commit', '-qm', 'cfg']);
  helpers.git(repo.path, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  worktree.remove(repo);
  worktree.ensure(repo); // creates + bootstraps
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'b');

  worktree.ensure(repo); // no lockfile change → nothing
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'b');

  fs.writeFileSync(path.join(worktree.pathFor('demo'), 'package-lock.json'), '{"v":1}');
  worktree.ensure(repo); // lockfile appeared → refresh
  assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), ['b', 'r']);
});

test('A3.10b the port comes from .cloud-copilot.json', () => {
  assert.equal(worktree.settingsFor(repo.path).port, 9999);
  assert.equal(worktree.ensure(repo).port, 9999);
});

test('A3.11 reset() cleans up a worktree left mid-conflict', () => {
  const wt = worktree.pathFor('demo');
  worktree.reset(repo);
  worktree.prepareBranch(repo, 'cc/conflict');
  helpers.commitFile(wt, 'clash.txt', 'ours\n', 'ours');

  // Build a genuinely conflicting commit on main, then attempt the merge.
  helpers.git(repo.path, ['checkout', '-q', 'main']);
  helpers.commitFile(repo.path, 'clash.txt', 'theirs\n', 'theirs');
  helpers.git(repo.path, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  const merged = worktree.git(wt, ['merge', 'origin/main', '--no-edit'], { allowFail: true });
  assert.equal(merged, null, 'sanity: the merge really did conflict');
  assert.notEqual(worktree.git(wt, ['ls-files', '-u'], { allowFail: true }), '');

  worktree.reset(repo);
  assert.ok(worktree.isClean(repo), 'the next task must never inherit a conflicted tree');
  assert.equal(worktree.git(wt, ['ls-files', '-u'], { allowFail: true }), '');
  worktree.release(repo);
});

test('remove() unregisters the worktree and forgets its bookkeeping', () => {
  worktree.remove(repo);
  assert.equal(worktree.exists('demo'), false);
  assert.equal(queue.worktreeInfo('demo'), null);
});

test('the worktree lives outside REPOS_ROOT', () => {
  // lib/gh.js treats "a directory with a .git entry" as a repo, and a
  // worktree's .git is a FILE — so a worktree under REPOS_ROOT would show up as
  // a phantom repo on the homepage.
  assert.ok(!worktree.pathFor('demo').startsWith(reposRoot));
});
