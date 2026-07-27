'use strict';

/**
 * Per-issue git worktrees for concurrent "Create PR" runs.
 *
 * A repo's single working tree used to be a hard mutex: every action ran with
 * `cwd: repo.path`, so two concurrent `git checkout`s would trample each other.
 * Create PR doesn't actually need the shared tree though — it only needs the
 * object store and the remote, and `git worktree` shares both. Giving each
 * Create PR job its own working directory makes them concurrent by
 * construction, and git's own "a branch can only be checked out in one
 * worktree" rule is a hard guarantee against cross-talk.
 *
 * Layout: `<REPOS_ROOT>/<repoName>-worktrees/issue-<n>` — a sibling container
 * directory next to each repo. Same volume as the main repo, short paths, and
 * obvious ownership when you `ls` the repos root. It also matches the
 * hand-rolled convention that already existed on the host machine, so
 * pre-existing worktrees are adopted rather than duplicated.
 */

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const WORKTREES_SUFFIX = '-worktrees';
const ISSUE_DIR_RE = /^issue-(\d+)$/;

function git(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          return reject(err);
        }
        resolve(stdout);
      },
    );
  });
}

function gitSync(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Container directory holding every worktree of `repo`. */
function containerDir(repo) {
  return path.join(path.dirname(repo.path), `${path.basename(repo.path)}${WORKTREES_SUFFIX}`);
}

/** Absolute path of the worktree dedicated to one issue. */
function worktreePath(repo, issueNumber) {
  return path.join(containerDir(repo), `issue-${Number(issueNumber)}`);
}

/** True for directory names that are worktree containers, never repos. */
function isWorktreeContainerName(name) {
  return typeof name === 'string' && name.endsWith(WORKTREES_SUFFIX);
}

/**
 * The repo's default branch, as seen from `origin`. Falls back to main/master
 * when `origin/HEAD` isn't set locally (a fresh clone usually has it; a repo
 * cloned with `--single-branch` may not).
 */
function defaultBranch(repoPath) {
  try {
    const ref = gitSync(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).trim();
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch {
    /* origin/HEAD not set */
  }
  for (const candidate of ['main', 'master']) {
    try {
      gitSync(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`]);
      return candidate;
    } catch {
      /* try next */
    }
  }
  try {
    return gitSync(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'main';
  } catch {
    return 'main';
  }
}

/**
 * Worktrees registered with the main repo, excluding the main working tree.
 * Returns [{ path, head, branch, detached }].
 */
function listWorktrees(repo) {
  let out;
  try {
    out = gitSync(repo.path, ['worktree', 'list', '--porcelain']);
  } catch {
    return [];
  }
  const entries = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), head: null, branch: null, detached: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim();
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    } else if (line.trim() === 'detached') {
      cur.detached = true;
    }
  }
  if (cur) entries.push(cur);
  const main = realpath(repo.path);
  return entries.filter((e) => e.path && realpath(e.path) !== main);
}

/** Resolve symlinks (macOS /var → /private/var) so path comparisons hold. */
function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** `git rev-parse --git-common-dir` as an absolute, symlink-resolved path. */
function gitCommonDir(dir) {
  // Note: rev-parse happily returns a RELATIVE path (".git"), so it must be
  // resolved against the directory it was run in, never against process.cwd().
  const out = gitSync(dir, ['rev-parse', '--git-common-dir']).trim();
  return realpath(path.isAbsolute(out) ? out : path.join(dir, out));
}

/**
 * Is `dir` a live worktree of `repo`? Checks git's own bookkeeping (a directory
 * that merely *looks* like a worktree, or whose administrative files were
 * pruned away, must not be reused).
 */
function isValidWorktree(repo, dir) {
  if (!fs.existsSync(dir)) return false;
  const target = realpath(dir);
  if (!listWorktrees(repo).some((w) => realpath(w.path) === target)) return false;
  try {
    // A worktree's `.git` is a file pointing into the main repo's
    // .git/worktrees/<name>; a matching common dir proves the link is intact.
    return gitCommonDir(dir) === gitCommonDir(repo.path);
  } catch {
    return false;
  }
}

async function prune(repo) {
  try {
    await git(repo.path, ['worktree', 'prune']);
  } catch {
    /* best effort */
  }
}

/** Remove one issue's worktree (and its directory), then prune bookkeeping. */
async function removeWorktree(repo, issueNumber) {
  const dir = worktreePath(repo, issueNumber);
  let removed = false;
  try {
    await git(repo.path, ['worktree', 'remove', '--force', dir]);
    removed = true;
  } catch {
    /* not registered (or already gone) — fall through to rm */
  }
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed = true;
    } catch {
      /* leave it; prune below keeps git's bookkeeping honest */
    }
  }
  await prune(repo);
  return removed;
}

/**
 * Ensure an up-to-date, dedicated worktree for `issueNumber`.
 *
 * Created **detached** at `origin/<defaultBranch>` so it never occupies a named
 * branch — the agent running inside it does its own `git checkout -b`.
 *
 * @param {object} repo   { name, path }
 * @param {number} issueNumber
 * @param {object} [opts] { reuse: boolean } — reuse an existing directory as-is
 *                        instead of recreating it from a fresh default branch.
 * @returns {Promise<{ path: string, created: boolean, base: string }>}
 */
async function ensureWorktree(repo, issueNumber, { reuse = false } = {}) {
  const dir = worktreePath(repo, issueNumber);
  fs.mkdirSync(containerDir(repo), { recursive: true });

  await prune(repo);

  if (fs.existsSync(dir)) {
    if (reuse && isValidWorktree(repo, dir)) {
      return { path: dir, created: false, base: null };
    }
    // Otherwise start clean: a leftover tree from a previous run would
    // otherwise leak its stale edits into this one.
    await removeWorktree(repo, issueNumber);
  }

  // Base the new tree on the freshest default branch.
  try {
    await git(repo.path, ['fetch', 'origin', '--prune']);
  } catch {
    /* offline / no remote — fall back to whatever refs we already have */
  }
  const branch = defaultBranch(repo.path);
  let base = `origin/${branch}`;
  try {
    gitSync(repo.path, ['rev-parse', '--verify', '--quiet', base]);
  } catch {
    base = branch; // no remote-tracking ref; use the local branch
  }

  await git(repo.path, ['worktree', 'add', '--detach', dir, base]);
  return { path: dir, created: true, base };
}

/**
 * Optional per-repo warm-up for a freshly created worktree — it has no
 * gitignored build artifacts (`node_modules`, `Pods`, …). Declared in the
 * repo's `.cloud-copilot.json`:
 *
 *   { "worktree": { "setup": "npm ci" } }
 *
 * Runs once, after creation and before the agent starts. No config = no-op.
 */
function setupCommand(repoPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repoPath, '.cloud-copilot.json'), 'utf8'));
    const cmd = raw && raw.worktree && raw.worktree.setup;
    return typeof cmd === 'string' && cmd.trim() ? cmd.trim() : null;
  } catch {
    return null;
  }
}

function runSetup(repoPath, worktreeDir, { timeout = 10 * 60 * 1000 } = {}) {
  const cmd = setupCommand(repoPath);
  if (!cmd) return Promise.resolve({ ran: false });
  return new Promise((resolve) => {
    execFile(
      process.env.SHELL || '/bin/bash',
      ['-lc', cmd],
      { cwd: worktreeDir, timeout, maxBuffer: 10 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        resolve({ ran: true, cmd, ok: !err, stdout: stdout || '', stderr: (stderr || '') + (err ? `\n${err.message}` : '') });
      },
    );
  });
}

/**
 * Startup sweep. Adopts hand-created worktrees (they're indistinguishable from
 * ours by design) and only removes what git itself considers dead:
 *
 *  - `git worktree prune` on every repo
 *  - orphan directories under `<repo>-worktrees/` that git has no bookkeeping
 *    for (e.g. the main repo's .git was re-created, or `prune` already ran)
 *
 * A *valid* worktree is never deleted here — that's the job of
 * `removeWorktree()` on PR merge/close — so a live hand-made worktree survives
 * a restart untouched.
 *
 * @param {Array<{name:string,path:string}>} repos
 * @returns {Promise<{ pruned: string[], kept: string[] }>}
 */
async function gcWorktrees(repos) {
  const pruned = [];
  const kept = [];
  for (const repo of repos || []) {
    const container = containerDir(repo);
    if (!fs.existsSync(container)) continue;
    await prune(repo);
    let entries = [];
    try {
      entries = fs.readdirSync(container, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || !ISSUE_DIR_RE.test(e.name)) continue;
      const dir = path.join(container, e.name);
      if (isValidWorktree(repo, dir)) {
        kept.push(dir);
        continue;
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        pruned.push(dir);
      } catch {
        /* ignore — nothing else we can do */
      }
    }
    await prune(repo);
    // Drop the container entirely once it's empty, so `ls` stays clean.
    try {
      if (fs.readdirSync(container).length === 0) fs.rmdirSync(container);
    } catch {
      /* ignore */
    }
  }
  return { pruned, kept };
}

module.exports = {
  WORKTREES_SUFFIX,
  containerDir,
  worktreePath,
  isWorktreeContainerName,
  defaultBranch,
  listWorktrees,
  isValidWorktree,
  ensureWorktree,
  removeWorktree,
  gcWorktrees,
  setupCommand,
  runSetup,
};
