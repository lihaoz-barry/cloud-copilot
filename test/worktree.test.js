'use strict';

/**
 * Worktree lifecycle: create → reuse → recreate → adopt → gc. Runs against a
 * real throwaway git repo so it exercises git's own bookkeeping rather than a
 * mock of it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const worktree = require('../lib/worktree');

function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: 30000 });
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wt-'));
  const dir = path.join(root, 'demo');
  fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return { root, repo: { name: 'demo', path: dir } };
}

test('ensureWorktree creates a detached worktree in the sibling container', async () => {
  const { root, repo } = makeRepo();
  try {
    const { path: dir, created } = await worktree.ensureWorktree(repo, 7);
    assert.strictEqual(created, true);
    assert.strictEqual(dir, path.join(root, 'demo-worktrees', 'issue-7'));
    assert.ok(fs.existsSync(path.join(dir, 'README.md')));
    assert.ok(worktree.isValidWorktree(repo, dir));

    const listed = worktree.listWorktrees(repo).map((w) => fs.realpathSync(w.path));
    assert.deepStrictEqual(listed, [fs.realpathSync(dir)]);
    // Detached: it must not be squatting on a named branch.
    assert.strictEqual(worktree.listWorktrees(repo)[0].branch, null);
    // The main working tree is untouched.
    assert.strictEqual(
      execFileSync('git', ['-C', repo.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      'main',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensureWorktree recreates a dirty worktree but can also reuse it', async () => {
  const { root, repo } = makeRepo();
  try {
    const first = await worktree.ensureWorktree(repo, 7);
    fs.writeFileSync(path.join(first.path, 'leftover.txt'), 'stale\n');

    const reused = await worktree.ensureWorktree(repo, 7, { reuse: true });
    assert.strictEqual(reused.created, false);
    assert.ok(fs.existsSync(path.join(first.path, 'leftover.txt')), 'reuse keeps the tree as-is');

    const fresh = await worktree.ensureWorktree(repo, 7);
    assert.strictEqual(fresh.created, true);
    assert.ok(!fs.existsSync(path.join(first.path, 'leftover.txt')), 'recreate starts clean');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two issues get independent worktrees on independent branches', async () => {
  const { root, repo } = makeRepo();
  try {
    const a = await worktree.ensureWorktree(repo, 1);
    const b = await worktree.ensureWorktree(repo, 2);
    assert.notStrictEqual(a.path, b.path);

    git(a.path, 'checkout', '-q', '-b', 'fix-1');
    git(b.path, 'checkout', '-q', '-b', 'fix-2');
    const branches = worktree
      .listWorktrees(repo)
      .map((w) => w.branch)
      .sort();
    assert.deepStrictEqual(branches, ['fix-1', 'fix-2']);

    // Edits in one tree are invisible to the other.
    fs.writeFileSync(path.join(a.path, 'only-a.txt'), 'a\n');
    assert.ok(!fs.existsSync(path.join(b.path, 'only-a.txt')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removeWorktree leaves no directory and no bookkeeping', async () => {
  const { root, repo } = makeRepo();
  try {
    const { path: dir } = await worktree.ensureWorktree(repo, 7);
    assert.strictEqual(await worktree.removeWorktree(repo, 7), true);
    assert.ok(!fs.existsSync(dir));
    assert.deepStrictEqual(worktree.listWorktrees(repo), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gcWorktrees adopts valid worktrees and only removes orphans', async () => {
  const { root, repo } = makeRepo();
  try {
    const live = await worktree.ensureWorktree(repo, 92);
    // An orphan: looks like a worktree directory, but git knows nothing of it.
    const orphan = path.join(root, 'demo-worktrees', 'issue-404');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'junk.txt'), 'x\n');

    const { pruned, kept } = await worktree.gcWorktrees([repo]);
    assert.deepStrictEqual(kept, [live.path], 'the real worktree is adopted, not deleted');
    assert.deepStrictEqual(pruned, [orphan]);
    assert.ok(fs.existsSync(live.path));
    assert.ok(!fs.existsSync(orphan));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setupCommand reads .cloud-copilot.json worktree.setup', () => {
  const { root, repo } = makeRepo();
  try {
    assert.strictEqual(worktree.setupCommand(repo.path), null);
    fs.writeFileSync(
      path.join(repo.path, '.cloud-copilot.json'),
      JSON.stringify({ worktree: { setup: 'npm ci' } }),
    );
    assert.strictEqual(worktree.setupCommand(repo.path), 'npm ci');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
