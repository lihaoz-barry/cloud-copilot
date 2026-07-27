'use strict';

/**
 * `listRepos()` must never present a `<repoName>-worktrees/` container (or
 * anything inside it) as a repo. Today that's true by construction — the scan
 * is one level deep and the container has no `.git` — but the per-issue
 * worktrees living inside it DO have a `.git`, so the moment anyone makes the
 * scan recursive the guard has to be explicit. These tests pin that.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const gh = require('../lib/gh');
const worktree = require('../lib/worktree');

function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: 30000 });
}

function makeRepo(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('listRepos skips <repo>-worktrees containers and their worktrees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-repos-'));
  try {
    const repoPath = makeRepo(root, 'demo');
    const repo = { name: 'demo', path: repoPath };

    // A real per-issue worktree, exactly as ensureWorktree() would lay it out.
    const wt = worktree.worktreePath(repo, 92);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repoPath, 'worktree', 'add', '--detach', wt, 'HEAD');
    assert.ok(fs.existsSync(path.join(wt, '.git')), 'worktree has a .git entry');

    const names = gh.listRepos(root).map((r) => r.name);
    assert.deepStrictEqual(names, ['demo']);
    assert.ok(!names.some((n) => n.endsWith('-worktrees')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listRepos skips a -worktrees directory even if it is itself a git repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-repos-'));
  try {
    makeRepo(root, 'demo');
    // Pathological case: someone turns the container itself into a clone.
    makeRepo(root, 'demo-worktrees');

    const names = gh.listRepos(root).map((r) => r.name);
    assert.deepStrictEqual(names, ['demo']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isWorktreeContainerName only matches the -worktrees suffix', () => {
  assert.ok(worktree.isWorktreeContainerName('demo-worktrees'));
  assert.ok(!worktree.isWorktreeContainerName('demo'));
  assert.ok(!worktree.isWorktreeContainerName('worktrees-demo'));
});
