'use strict';

/**
 * Worktree pool — lets several agent runs work on the same repo at once
 * (issue #64).
 *
 * Before this, every action that writes files ran in the repo's single working
 * tree, so cloud-copilot had to serialise them with a per-repo lock: one Create
 * PR at a time, and nothing else while it ran. A `git worktree` gives each run
 * its own checkout backed by the same object store, so N runs can implement N
 * issues simultaneously without ever fighting over `HEAD`.
 *
 * Each lease carries:
 *   path   an isolated checkout under <repo>/.worktrees/<slug>
 *   port   a TCP port from lib/portPool the run owns for testing (may be null)
 *   env    the environment overrides the child process needs
 *
 * Cleanup follows the one rule the existing lib/worktrees.js already enforces:
 * **never delete work**. A worktree is removed only when it is clean and every
 * commit it holds is already on the remote (or on the base ref, for a run that
 * never created a branch). Anything unprovable is kept and reported.
 *
 * All git calls use argument-array form; branch names come from GitHub and must
 * never reach a shell.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const portPool = require('./portPool');
const worktrees = require('./worktrees');

const WORKTREES_DIRNAME = '.worktrees';
const MAX_PER_REPO = Number(process.env.CC_MAX_WORKTREES_PER_REPO || 3);
const MAX_GLOBAL = Number(process.env.CC_MAX_WORKTREES_GLOBAL || 6);
const ACQUIRE_TIMEOUT_MS = Number(process.env.CC_WORKTREE_ACQUIRE_TIMEOUT_MS || 10 * 60 * 1000);

/** leaseId -> lease */
const leases = new Map();
/** FIFO of waiters parked because a concurrency limit was reached. */
const waiters = [];
/**
 * repoName -> number of slots claimed by an acquire() that has not registered
 * its lease yet.
 *
 * Creating a worktree is asynchronous (a fetch, a checkout, a port probe), so
 * without this the window between "there is room" and `leases.set(...)` is wide
 * open: N simultaneous Create PR clicks would all see the same free slot and
 * blow straight through both limits. A slot is therefore claimed synchronously,
 * before the first await, and handed over to the lease (or given back) in the
 * same tick it stops being a reservation.
 */
const reservations = new Map();

function git(cwd, args, timeout = 30000) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(cwd, args, timeout = 30000) {
  try {
    return { ok: true, out: git(cwd, args, timeout) };
  } catch (err) {
    return { ok: false, out: '', error: err };
  }
}

const slugify = (s) =>
  String(s || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'run';

// ---------------------------------------------------------------------------
// Concurrency limits
// ---------------------------------------------------------------------------

function repoLeaseCount(repoName) {
  let n = 0;
  for (const l of leases.values()) if (l.repoName === repoName) n += 1;
  return n + (reservations.get(repoName) || 0);
}

function totalCount() {
  let pending = 0;
  for (const n of reservations.values()) pending += n;
  return leases.size + pending;
}

function hasCapacity(repoName) {
  return totalCount() < MAX_GLOBAL && repoLeaseCount(repoName) < MAX_PER_REPO;
}

function reserve(repoName) {
  reservations.set(repoName, (reservations.get(repoName) || 0) + 1);
}

function unreserve(repoName) {
  const n = (reservations.get(repoName) || 0) - 1;
  if (n > 0) reservations.set(repoName, n);
  else reservations.delete(repoName);
}

/**
 * Claim a slot, or park until one frees up. Resolves with the slot already
 * claimed — the caller must eventually call `unreserve` exactly once, either
 * when its lease is registered or when it gives up.
 */
function reserveCapacity(repoName, timeoutMs) {
  if (hasCapacity(repoName)) {
    reserve(repoName);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { repoName, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      const err = new Error(`Timed out waiting for a free worktree slot in ${repoName}`);
      err.code = 'NO_CAPACITY';
      reject(err);
    }, timeoutMs);
    if (waiter.timer.unref) waiter.timer.unref();
    waiters.push(waiter);
  });
}

// Wake the first waiter a just-released slot can actually serve. Called after
// every release; a waiter whose repo is still at its own limit stays parked.
// The slot is claimed here, synchronously, so it cannot be stolen by an
// acquire() that starts before the woken waiter's microtask runs.
function pumpWaiters() {
  for (let i = 0; i < waiters.length; i += 1) {
    const w = waiters[i];
    if (!hasCapacity(w.repoName)) continue;
    waiters.splice(i, 1);
    clearTimeout(w.timer);
    reserve(w.repoName);
    w.resolve();
    return;
  }
}

// ---------------------------------------------------------------------------
// Creating the checkout
// ---------------------------------------------------------------------------

// `.worktrees/` is an implementation detail of this machine, not of the project,
// so it is excluded locally via .git/info/exclude instead of by editing a
// repo's committed .gitignore (which we have no business changing).
function ensureLocallyIgnored(repoPath) {
  try {
    const gitDir = git(repoPath, ['rev-parse', '--git-common-dir'], 10000);
    const abs = path.isAbsolute(gitDir) ? gitDir : path.join(repoPath, gitDir);
    const excludeFile = path.join(abs, 'info', 'exclude');
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
    if (!current.split('\n').some((l) => l.trim() === `${WORKTREES_DIRNAME}/`)) {
      fs.appendFileSync(
        excludeFile,
        `${current.endsWith('\n') || !current ? '' : '\n'}${WORKTREES_DIRNAME}/\n`,
      );
    }
  } catch {
    /* best effort — a visible .worktrees/ entry is untidy, never fatal */
  }
}

function fetchRef(repoPath, ref) {
  if (!ref) return;
  tryGit(repoPath, ['fetch', '--quiet', 'origin', ref], 60000);
}

/**
 * Does the local branch hold commits that are not on origin/<branch>? Such a
 * branch must never be reset, so we attach to it as-is instead.
 */
function hasUnpushedCommits(repoPath, branch) {
  const r = tryGit(repoPath, ['log', '--oneline', `origin/${branch}..${branch}`], 15000);
  if (!r.ok) return true; // unprovable ⇒ assume it matters
  return r.out.length > 0;
}

function localBranchExists(repoPath, branch) {
  return tryGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], 10000).ok;
}

/**
 * Create the checkout for a lease.
 *
 * `branch: null` (Create PR) → a detached checkout of `origin/<base>`; the
 * agent creates its own branch inside it, exactly as it would in a normal
 * clone.
 *
 * `branch: '<name>'` (Update / Review / Chat) → that branch, reset to
 * origin/<branch> when the local ref is stale, kept as-is when it carries
 * unpushed commits.
 */
function addWorktree(repoPath, dir, { branch, baseRef }) {
  if (branch) {
    fetchRef(repoPath, branch);
    const held = worktrees.worktreePathForBranch(repoPath, branch);
    if (held) return { path: held, reused: true, detached: false };
    const remoteExists = tryGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], 10000).ok;
    if (localBranchExists(repoPath, branch) && (!remoteExists || hasUnpushedCommits(repoPath, branch))) {
      git(repoPath, ['worktree', 'add', dir, branch], 120000);
    } else if (remoteExists) {
      git(repoPath, ['worktree', 'add', '-B', branch, dir, `origin/${branch}`], 120000);
    } else {
      git(repoPath, ['worktree', 'add', dir, branch], 120000);
    }
    return { path: dir, reused: false, detached: false };
  }

  const base = baseRef || 'main';
  fetchRef(repoPath, base);
  const startPoint = tryGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], 10000).ok
    ? `origin/${base}`
    : base;
  git(repoPath, ['worktree', 'add', '--detach', dir, startPoint], 120000);
  return { path: dir, reused: false, detached: true };
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

/**
 * Lease an isolated checkout (+ a test port) for one run.
 *
 * @param {object} repo    { name, path } as returned by gh.listRepos
 * @param {object} opts    { key, action, issueNumber, prNumber, branch, baseRef, port }
 * @returns {Promise<object>} lease: { id, path, port, env, reused, release() }
 */
async function acquire(repo, opts = {}) {
  const {
    key = null,
    action = 'run',
    issueNumber = null,
    prNumber = null,
    branch = null,
    baseRef = null,
    port: wantPort = true,
  } = opts;

  await reserveCapacity(repo.name, ACQUIRE_TIMEOUT_MS);
  // From here on exactly one of `leases.set` / `giveUp()` must run.
  let reserved = true;
  const giveUp = () => {
    if (!reserved) return;
    reserved = false;
    unreserve(repo.name);
    pumpWaiters();
  };

  // Two agents in one directory is the exact failure the old repo-wide lock
  // used to prevent, and a shared checkout is worse than a refused run: they
  // would overwrite each other's edits and commit each other's half-work. A
  // second run on the same branch therefore has to wait for the first (the
  // caller surfaces this as "blocked"), whatever git itself would allow.
  if (branch) {
    const busy = leaseForBranch(repo.path, branch);
    if (busy) {
      giveUp();
      const err = new Error(
        `branch "${branch}" is already checked out by a running ${busy.action} task in ${repo.name}`,
      );
      // Transient by nature: the caller should report this as "blocked" (try
      // again later), not as a failure that consumes a retry budget.
      err.code = 'BRANCH_BUSY';
      throw err;
    }
  }

  const id = `${slugify(action)}-${issueNumber || prNumber || 0}-${crypto.randomBytes(3).toString('hex')}`;
  const root = path.join(repo.path, WORKTREES_DIRNAME);
  const dir = path.join(root, id);

  ensureLocallyIgnored(repo.path);
  fs.mkdirSync(root, { recursive: true });

  let created;
  try {
    created = addWorktree(repo.path, dir, { branch, baseRef });
  } catch (err) {
    giveUp();
    throw new Error(`Could not create a worktree for ${repo.name}: ${err.message}`);
  }

  let port = null;
  try {
    port = wantPort ? await portPool.acquire(key || id) : null;
  } catch (err) {
    // The checkout exists but the lease will never be created, so nothing would
    // ever come back to clean it up: undo it here rather than leave a directory
    // (and a git worktree registration) behind for every failed acquire.
    if (!created.reused) {
      try {
        worktrees.releaseWorktree(repo.path, created.path);
      } catch {
        /* best effort — the startup sweep is the backstop */
      }
    }
    giveUp();
    throw new Error(`Could not reserve a test port for ${repo.name}: ${err.message}`);
  }

  const lease = {
    id,
    key,
    action,
    repoName: repo.name,
    repoPath: repo.path,
    issueNumber,
    prNumber,
    branch,
    baseRef,
    path: created.path,
    // A reused worktree belongs to whoever created it — releasing must not
    // remove a directory this lease did not make.
    owned: !created.reused,
    detached: created.detached,
    port,
    createdAt: Date.now(),
    released: false,
    env: {},
  };
  lease.env = envFor(lease);
  lease.release = (options) => release(lease, options);
  // Hand the reservation over to the lease in one tick: the slot is never
  // counted twice and never momentarily free.
  leases.set(id, lease);
  reserved = false;
  unreserve(repo.name);
  return lease;
}

/**
 * Environment overrides for the child process of a lease.
 *
 * `CC_DATA_DIR` matters more than it looks: cloud-copilot manages its own repo,
 * so an agent testing a change may boot a second cloud-copilot inside the
 * worktree. Without a private data dir that instance would write the very
 * `data/state.json` this server is using, corrupting live task state.
 */
function envFor(lease) {
  const env = {
    CC_WORKTREE: lease.path,
    CC_WORKTREE_ID: lease.id,
    CC_DATA_DIR: path.join(lease.path, '.cc-data'),
  };
  if (lease.port) {
    env.PORT = String(lease.port);
    env.CC_TEST_PORT = String(lease.port);
  }
  return env;
}

/**
 * Return a lease: remove its worktree when that provably loses no work, release
 * its port either way. Never throws — housekeeping must not change a job's
 * outcome.
 *
 * @returns {Array} the same result rows lib/worktrees.js produces, so
 *   `worktrees.formatCleanup` can render them into the transcript unchanged.
 */
function release(lease, { fallbackRef = null } = {}) {
  if (!lease || lease.released) return [];
  lease.released = true;
  leases.delete(lease.id);
  portPool.release(lease.port);

  const results = [];
  try {
    if (!lease.owned) {
      results.push({
        status: 'kept',
        path: lease.path,
        branch: lease.branch,
        reason: 'pre-existing worktree, not created by this run',
      });
    } else if (fs.existsSync(lease.path)) {
      const fallback = fallbackRef || (lease.baseRef ? `origin/${lease.baseRef}` : null);
      const branch = currentBranch(lease.path);
      const { disposable, reason } = disposability(lease, branch, fallback);
      if (disposable) {
        try {
          worktrees.releaseWorktree(lease.repoPath, lease.path);
          results.push({ status: 'released', path: lease.path, branch, reason });
        } catch (err) {
          results.push({ status: 'kept', path: lease.path, branch, reason: `git refused: ${err.message}` });
        }
      } else {
        results.push({ status: 'kept', path: lease.path, branch, reason });
      }
    }
  } catch (err) {
    results.push({ status: 'kept', path: lease.path, branch: lease.branch, reason: `cleanup error: ${err.message}` });
  }
  pumpWaiters();
  return results;
}

function currentBranch(worktreePath) {
  const r = tryGit(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 10000);
  return r.ok && r.out ? r.out : null;
}

/** origin's default branch (usually `main`), falling back to "main". */
function defaultBranchOf(repoPath) {
  const r = tryGit(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], 10000);
  if (r.ok && r.out) {
    const name = r.out.split('/').pop();
    if (name) return name;
  }
  return 'main';
}

/**
 * Why a lease's worktree may (not) be removed.
 *
 * On a branch this defers entirely to lib/worktrees.js. Still detached means
 * the run never created a branch — a failed or aborted Create PR — and then the
 * only safe question is whether it holds any commit at all beyond the base ref.
 */
function disposability(lease, branch, fallbackRef) {
  if (branch) {
    return worktrees.worktreeDisposability(lease.path, branch, { fallbackRef });
  }
  const dirty = tryGit(lease.path, ['status', '--porcelain'], 15000);
  if (!dirty.ok) return { disposable: false, reason: 'could not read worktree status' };
  if (dirty.out.length > 0) return { disposable: false, reason: 'uncommitted changes' };
  const ref = fallbackRef || (lease.baseRef ? `origin/${lease.baseRef}` : null);
  if (!ref) return { disposable: false, reason: 'detached HEAD with no base ref to compare against' };
  const ahead = tryGit(lease.path, ['log', '--oneline', `${ref}..HEAD`], 15000);
  if (!ahead.ok) return { disposable: false, reason: `could not compare against ${ref}` };
  if (ahead.out.length > 0) return { disposable: false, reason: `unpushed commits not contained in ${ref}` };
  return { disposable: true, reason: `never left ${ref}` };
}

/** Active leases, for the running-tasks panel. */
function list() {
  return [...leases.values()].map((l) => ({
    id: l.id,
    key: l.key,
    action: l.action,
    repo: l.repoName,
    issueNumber: l.issueNumber,
    prNumber: l.prNumber,
    branch: l.branch,
    path: l.path,
    port: l.port,
    createdAt: l.createdAt,
  }));
}

function leaseForKey(key) {
  for (const l of leases.values()) if (l.key === key) return l;
  return null;
}

/** An active lease holding this branch in this repo, if any. */
function leaseForBranch(repoPath, branch) {
  if (!branch) return null;
  for (const l of leases.values()) {
    if (l.branch === branch && path.resolve(l.repoPath) === path.resolve(repoPath)) return l;
  }
  return null;
}

/**
 * Remove worktrees this pool created that no lease owns any more — the ones a
 * crash or a restart orphaned. Only touches `<repo>/.worktrees/*`, and only
 * when removal provably loses no work, so a directory left behind on purpose
 * (unpushed commits) survives every sweep.
 *
 * `keep` covers the case leases cannot: after a dashboard restart the agent in
 * a worktree is still running under the supervisor, but its lease died with the
 * process that took it. Deleting that checkout would pull the ground out from
 * under a live session, so the caller passes the paths it has re-adopted.
 */
function sweepOrphans(repos, { keep = new Set() } = {}) {
  const alive = new Set([...leases.values()].map((l) => path.resolve(l.path)));
  for (const p of keep) alive.add(path.resolve(p));
  const removed = [];
  for (const repo of repos || []) {
    let entries;
    try {
      entries = fs.readdirSync(path.join(repo.path, WORKTREES_DIRNAME), { withFileTypes: true });
    } catch {
      continue; // no .worktrees/ in this repo
    }
    // A crashed Create PR leaves a still-detached checkout behind; without a
    // ref to compare it against nothing about it is provable, so the default
    // branch stands in as the "it never got anywhere" baseline.
    const fallbackRef = `origin/${defaultBranchOf(repo.path)}`;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(repo.path, WORKTREES_DIRNAME, e.name);
      if (alive.has(path.resolve(dir))) continue;
      const branch = currentBranch(dir);
      const { disposable, reason } = disposability(
        { path: dir, baseRef: null, repoPath: repo.path },
        branch,
        fallbackRef,
      );
      if (!disposable) continue;
      try {
        worktrees.releaseWorktree(repo.path, dir);
        removed.push({ repo: repo.name, path: dir, branch, reason });
      } catch {
        /* leave it for the next sweep */
      }
    }
    tryGit(repo.path, ['worktree', 'prune'], 15000);
  }
  return removed;
}

module.exports = {
  acquire,
  release,
  list,
  leaseForKey,
  leaseForBranch,
  sweepOrphans,
  WORKTREES_DIRNAME,
  MAX_PER_REPO,
  MAX_GLOBAL,
};
