'use strict';

/**
 * Tests for the worktree pool (issue #64).
 *
 * These run against real git repositories in a temp dir, because everything
 * worth testing here — concurrency limits, "never two agents in one checkout",
 * and "never delete unpushed work" — is about what git actually does.
 *
 * Run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Read at require() time by the pool, so they must be set before it is loaded.
process.env.CC_MAX_WORKTREES_PER_REPO = '2';
process.env.CC_MAX_WORKTREES_GLOBAL = '3';
process.env.CC_WORKTREE_ACQUIRE_TIMEOUT_MS = '400';
process.env.CC_PORT_RANGE_START = '8420';
process.env.CC_PORT_RANGE_END = '8440';

const worktreePool = require('../lib/worktreePool');

let tmpRoot;

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A clone with an `origin` bare remote holding `main` and `feature`. */
function makeRepo(name) {
  const remote = path.join(tmpRoot, `${name}.git`);
  const workdir = path.join(tmpRoot, name);
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '--quiet', '-b', 'main', workdir]);
  git(workdir, ['config', 'user.email', 'test@example.com']);
  git(workdir, ['config', 'user.name', 'Test']);
  git(workdir, ['remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(workdir, 'README.md'), '# test\n');
  git(workdir, ['add', '.']);
  git(workdir, ['commit', '--quiet', '-m', 'initial']);
  git(workdir, ['push', '--quiet', 'origin', 'main']);
  git(workdir, ['checkout', '--quiet', '-b', 'feature']);
  fs.writeFileSync(path.join(workdir, 'feature.txt'), 'work\n');
  git(workdir, ['add', '.']);
  git(workdir, ['commit', '--quiet', '-m', 'feature']);
  git(workdir, ['push', '--quiet', 'origin', 'feature']);
  git(workdir, ['checkout', '--quiet', 'main']);
  git(workdir, ['fetch', '--quiet', 'origin']);
  return { name, path: workdir, ownerRepo: `test/${name}` };
}

/**
 * The pool deliberately `unref()`s its queue timers so a parked run can never
 * keep the process alive on its own; a test that waits for one therefore has to
 * hold the event loop open itself.
 */
function keepAlive() {
  const t = setInterval(() => {}, 50);
  return () => clearInterval(t);
}

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-worktree-pool-'));
});

test.after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('a lease is an isolated checkout with its own port and data dir', async () => {
  const repo = makeRepo('solo');
  const lease = await worktreePool.acquire(repo, { key: 'k1', action: 'work', issueNumber: 7, baseRef: 'main' });
  try {
    assert.ok(lease.path.startsWith(path.join(repo.path, worktreePool.WORKTREES_DIRNAME)));
    assert.ok(fs.existsSync(path.join(lease.path, 'README.md')));
    assert.strictEqual(lease.detached, true, 'Create PR starts detached on the base ref');
    assert.strictEqual(lease.env.CC_WORKTREE, lease.path);
    assert.strictEqual(lease.env.CC_DATA_DIR, path.join(lease.path, '.cc-data'));
    assert.strictEqual(lease.env.PORT, String(lease.port));
    assert.strictEqual(lease.env.CC_TEST_PORT, String(lease.port));
    assert.strictEqual(worktreePool.list().length, 1);
  } finally {
    lease.release();
  }
  assert.strictEqual(worktreePool.list().length, 0);
});

test('simultaneous acquires cannot exceed the per-repo limit', async () => {
  const repo = makeRepo('crowd');
  // The limit is 2. Four runs starting in the same tick used to slip through
  // together, because the capacity check and the lease registration were on
  // opposite sides of an await.
  const stop = keepAlive();
  const results = await Promise.allSettled(
    [1, 2, 3, 4].map((n) =>
      worktreePool.acquire(repo, { key: `k${n}`, action: 'work', issueNumber: n, baseRef: 'main' }),
    ),
  );
  stop();
  const leased = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  try {
    assert.strictEqual(leased.length, 2, 'exactly the per-repo limit got through');
    assert.strictEqual(worktreePool.list().length, 2);
    assert.strictEqual(new Set(leased.map((l) => l.path)).size, 2, 'each got its own checkout');
    assert.strictEqual(new Set(leased.map((l) => l.port)).size, 2, 'each got its own port');
    for (const r of results.filter((x) => x.status === 'rejected')) {
      assert.match(r.reason.message, /Timed out waiting for a free worktree slot/);
    }
  } finally {
    for (const l of leased) l.release();
  }
});

test('a release wakes a run that was waiting for a slot', async () => {
  const repo = makeRepo('queue');
  const first = await worktreePool.acquire(repo, { key: 'q1', action: 'work', issueNumber: 1, baseRef: 'main' });
  const second = await worktreePool.acquire(repo, { key: 'q2', action: 'work', issueNumber: 2, baseRef: 'main' });
  const queued = worktreePool.acquire(repo, { key: 'q3', action: 'work', issueNumber: 3, baseRef: 'main' });
  second.release();
  const third = await queued;
  try {
    assert.ok(third.path);
    assert.strictEqual(worktreePool.list().length, 2);
  } finally {
    first.release();
    third.release();
  }
});

test('two runs are never handed the same branch checkout', async () => {
  const repo = makeRepo('branchy');
  const first = await worktreePool.acquire(repo, {
    key: 'b1',
    action: 'review',
    prNumber: 5,
    branch: 'feature',
    baseRef: 'main',
  });
  try {
    assert.strictEqual(first.detached, false);
    assert.strictEqual(git(first.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature');
    await assert.rejects(
      () =>
        worktreePool.acquire(repo, {
          key: 'b2',
          action: 'chat',
          prNumber: 5,
          branch: 'feature',
          baseRef: 'main',
        }),
      /already checked out by a running review task/,
    );
    // The refused run must not have consumed a slot.
    assert.strictEqual(worktreePool.list().length, 1);
  } finally {
    first.release();
  }
});

test('release removes a clean checkout but keeps one holding unpushed work', async () => {
  const repo = makeRepo('cleanup');
  const clean = await worktreePool.acquire(repo, { key: 'c1', action: 'work', issueNumber: 1, baseRef: 'main' });
  const cleanPath = clean.path;
  const cleanResult = clean.release({ fallbackRef: 'origin/main' });
  assert.strictEqual(cleanResult[0].status, 'released');
  assert.strictEqual(fs.existsSync(cleanPath), false);

  const dirty = await worktreePool.acquire(repo, { key: 'c2', action: 'work', issueNumber: 2, baseRef: 'main' });
  const dirtyPath = dirty.path;
  fs.writeFileSync(path.join(dirtyPath, 'notes.txt'), 'work in progress\n');
  git(dirtyPath, ['add', '.']);
  git(dirtyPath, ['commit', '--quiet', '-m', 'unpushed work']);
  const keptResult = dirty.release({ fallbackRef: 'origin/main' });
  try {
    assert.strictEqual(keptResult[0].status, 'kept');
    assert.ok(fs.existsSync(dirtyPath), 'work that only exists here is never deleted');
    // The slot and the port are freed even when the directory stays.
    assert.strictEqual(worktreePool.list().length, 0);
  } finally {
    execFileSync('git', ['-C', repo.path, 'worktree', 'remove', '--force', dirtyPath], { stdio: 'ignore' });
  }
});

test('the startup sweep removes orphans but keeps unpushed work', async () => {
  const repo = makeRepo('orphans');
  const live = await worktreePool.acquire(repo, { key: 'o1', action: 'work', issueNumber: 1, baseRef: 'main' });

  // Exactly what a crashed run leaves behind: directories under .worktrees/
  // that no lease owns any more.
  const root = path.join(repo.path, worktreePool.WORKTREES_DIRNAME);
  const orphanPath = path.join(root, 'work-2-deadbe');
  const keptPath = path.join(root, 'work-3-c0ffee');
  git(repo.path, ['worktree', 'add', '--detach', orphanPath, 'origin/main']);
  git(repo.path, ['worktree', 'add', '--detach', keptPath, 'origin/main']);
  fs.writeFileSync(path.join(keptPath, 'wip.txt'), 'unfinished\n');

  const removed = worktreePool.sweepOrphans([repo]);
  try {
    assert.ok(removed.some((r) => r.path === orphanPath), 'the clean leftover was removed');
    assert.strictEqual(fs.existsSync(orphanPath), false);
    assert.strictEqual(fs.existsSync(keptPath), true, 'a dirty leftover is never swept');
    assert.strictEqual(
      removed.some((r) => r.path === live.path),
      false,
      'a live lease is never swept',
    );
    assert.ok(fs.existsSync(live.path));
  } finally {
    live.release();
    execFileSync('git', ['-C', repo.path, 'worktree', 'remove', '--force', keptPath], { stdio: 'ignore' });
  }
});
