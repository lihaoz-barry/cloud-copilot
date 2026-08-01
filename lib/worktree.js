'use strict';

/**
 * Git worktree manager — the isolation layer the scheduler runs inside.
 *
 * The whole point: a queued run must never touch the checkout you work in.
 * Each repo gets ONE long-lived worktree that is reused across tasks, reset
 * between them, and kept OUTSIDE `REPOS_ROOT`.
 *
 * Two constraints drive nearly every decision here:
 *
 *   1. A worktree's `.git` is a FILE, and lib/gh.js treats "`.git` exists" as
 *      "this is a repo". Putting worktrees under REPOS_ROOT would make phantom
 *      repos appear on the homepage — hence the default `~/.cloud-copilot/…`.
 *
 *   2. Git refuses to check out the same branch in two worktrees at once. If a
 *      task ended while still ON `cc/issue-96`, your later "Deploy" would fail
 *      with "already checked out at …". Every task therefore ends with
 *      `release()`, which detaches HEAD and hands the branch name back.
 *
 * Reset uses `git clean -df`, NOT `-xdf`: ignored files (node_modules, Pods,
 * .env) must survive, or bootstrap would have to run before every single task.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const queue = require('./queue');
const config = require('./queueConfig');

const GIT_TIMEOUT_MS = 120000;

function git(cwd, args, { timeout = GIT_TIMEOUT_MS, allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (allowFail) return null;
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

/** Where this repo's worktree lives. */
function pathFor(repoName) {
  return path.join(config.worktreeRoot(), repoName);
}

/**
 * Compare two paths the way git does — by their resolved real path.
 *
 * Needed because `git worktree list` reports the fully-resolved path, while we
 * hold the configured one. On macOS those differ constantly: /var, /tmp and
 * the home directory are all symlinks (/var/folders/... → /private/var/...),
 * so a naive string compare would decide an existing worktree isn't registered
 * and then try to re-add it.
 */
function samePath(a, b) {
  const norm = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return norm(a) === norm(b);
}

/** The `worktree` block from the repo's own .cloud-copilot.json, with defaults. */
function settingsFor(repoPath) {
  let raw = {};
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(repoPath, '.cloud-copilot.json'), 'utf8'),
    );
    if (parsed && typeof parsed.worktree === 'object') raw = parsed.worktree;
  } catch {
    /* no config, or unreadable — every field below is optional anyway */
  }
  return {
    bootstrap: typeof raw.bootstrap === 'string' ? raw.bootstrap : '',
    refresh: typeof raw.refresh === 'string' ? raw.refresh : '',
    port: Number.isInteger(raw.port) ? raw.port : null,
    copyFiles: Array.isArray(raw.copyFiles) ? raw.copyFiles : [],
    lockfiles: Array.isArray(raw.lockfiles)
      ? raw.lockfiles
      : ['package-lock.json', 'Podfile.lock', 'yarn.lock', 'pnpm-lock.yaml'],
  };
}

/** The repo's default branch, e.g. `main` — mirrors server.js's own probe. */
function defaultBranchOf(repoPath) {
  const ref = git(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
    allowFail: true,
  });
  if (ref) return ref.replace('refs/remotes/origin/', '');
  for (const candidate of ['main', 'master']) {
    if (git(repoPath, ['rev-parse', '--verify', `origin/${candidate}`], { allowFail: true })) {
      return candidate;
    }
  }
  return 'main';
}

/** Fingerprint of the dependency manifests, so we know when to re-bootstrap. */
function lockfileHash(dir, lockfiles) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha1');
  let found = false;
  for (const f of lockfiles) {
    const p = path.join(dir, f);
    try {
      h.update(f).update(fs.readFileSync(p));
      found = true;
    } catch {
      /* not present in this repo */
    }
  }
  return found ? h.digest('hex') : null;
}

/** Run a bootstrap/refresh command inside the worktree. */
function runSetupCommand(command, cwd, port, log) {
  if (!command) return;
  log(`$ ${command}`);
  try {
    const out = execSync(command, {
      cwd,
      encoding: 'utf8',
      timeout: 20 * 60 * 1000,
      env: { ...process.env, ...(port ? { PORT: String(port) } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    log(out.trim().slice(-2000));
  } catch (err) {
    // A failed bootstrap is worth reporting but must not abort the task: the
    // agent may not need dependencies at all (e.g. a docs-only change).
    log(`[bootstrap warning] ${(err.stderr || err.message || '').toString().trim().slice(-2000)}`);
  }
}

/** Copy gitignored-but-needed files (.env and friends) in from the main repo. */
function copyFiles(repoPath, wtPath, files, log) {
  for (const rel of files) {
    const from = path.join(repoPath, rel);
    const to = path.join(wtPath, rel);
    try {
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      log(`copied ${rel}`);
    } catch (err) {
      log(`[copy warning] ${rel}: ${err.message}`);
    }
  }
}

/**
 * Make sure this repo has a usable worktree, creating and bootstrapping it on
 * first use. Returns { path, port, created }.
 */
function ensure(repo, { log = () => {} } = {}) {
  const wtPath = pathFor(repo.name);
  const settings = settingsFor(repo.path);

  // Drop registrations whose directory has been deleted by hand, otherwise
  // `worktree add` refuses with "already registered".
  git(repo.path, ['worktree', 'prune'], { allowFail: true });

  const registered = (git(repo.path, ['worktree', 'list', '--porcelain'], { allowFail: true }) || '')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => samePath(line.slice('worktree '.length), wtPath));

  let created = false;
  if (!registered || !fs.existsSync(wtPath)) {
    if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    git(repo.path, ['fetch', 'origin', '--prune'], { allowFail: true });
    const base = `origin/${defaultBranchOf(repo.path)}`;
    log(`creating worktree at ${wtPath} (detached at ${base})`);
    git(repo.path, ['worktree', 'add', '--detach', wtPath, base]);
    created = true;
  }

  const info = queue.worktreeInfo(repo.name) || {};
  const hash = lockfileHash(wtPath, settings.lockfiles);

  if (created || !info.bootstrappedAt) {
    copyFiles(repo.path, wtPath, settings.copyFiles, log);
    runSetupCommand(settings.bootstrap, wtPath, settings.port, log);
    queue.setWorktreeInfo(repo.name, {
      path: wtPath,
      createdAt: info.createdAt || new Date().toISOString(),
      bootstrappedAt: new Date().toISOString(),
      lockfileHash: hash,
      port: settings.port,
    });
  } else if (hash && hash !== info.lockfileHash) {
    // Dependencies moved since we last set up — refresh rather than rebuild.
    log('dependency lockfile changed — running refresh');
    copyFiles(repo.path, wtPath, settings.copyFiles, log);
    runSetupCommand(settings.refresh || settings.bootstrap, wtPath, settings.port, log);
    queue.setWorktreeInfo(repo.name, { lockfileHash: hash, bootstrappedAt: new Date().toISOString() });
  }

  return { path: wtPath, port: settings.port, created };
}

/**
 * Put the worktree back into a known-clean state before a task runs.
 *
 * `clean -df` (no -x) deliberately keeps ignored files so node_modules / Pods
 * survive between tasks — otherwise every task would pay full bootstrap cost.
 * Also aborts any merge/rebase a previous crashed task may have left behind.
 */
function reset(repo, { log = () => {} } = {}) {
  const wtPath = pathFor(repo.name);
  git(wtPath, ['merge', '--abort'], { allowFail: true });
  git(wtPath, ['rebase', '--abort'], { allowFail: true });
  git(wtPath, ['reset', '--hard'], { allowFail: true });
  git(wtPath, ['clean', '-df'], { allowFail: true });
  git(wtPath, ['fetch', 'origin', '--prune'], { allowFail: true });
  log('worktree reset to a clean state');
  return wtPath;
}

/**
 * Put the worktree on a fresh branch cut from the default branch, ready for an
 * agent to implement an issue on.
 */
function prepareBranch(repo, branch, { log = () => {} } = {}) {
  const wtPath = pathFor(repo.name);
  const base = `origin/${defaultBranchOf(repo.path)}`;
  git(wtPath, ['checkout', '-B', branch, base]);
  log(`worktree on ${branch} (from ${base})`);
  return branch;
}

/** Check out an existing remote branch (the sync tasks' entry point). */
function checkoutExisting(repo, branch, { log = () => {} } = {}) {
  const wtPath = pathFor(repo.name);
  git(wtPath, ['checkout', '-B', branch, `origin/${branch}`]);
  log(`worktree on ${branch} (tracking origin/${branch})`);
  return wtPath;
}

/**
 * Hand the branch name back to the rest of the world.
 *
 * Git allows a branch to be checked out in exactly one worktree. Without this,
 * a later Deploy — which does `git checkout <prBranch>` on the MAIN tree —
 * fails with "already checked out at …". Detaching costs nothing and removes a
 * whole class of confusing failures.
 */
function release(repo, { log = () => {} } = {}) {
  const wtPath = pathFor(repo.name);
  if (!fs.existsSync(wtPath)) return;
  const base = `origin/${defaultBranchOf(repo.path)}`;
  const ok = git(wtPath, ['checkout', '--detach', base], { allowFail: true });
  if (ok === null) git(wtPath, ['checkout', '--detach'], { allowFail: true });
  log('worktree detached — branch ownership released');
}

/** Is the worktree free of uncommitted changes? */
function isClean(repo) {
  const wtPath = pathFor(repo.name);
  const out = git(wtPath, ['status', '--porcelain'], { allowFail: true });
  return out === '';
}

/** Current HEAD branch, or null when detached. */
function currentBranch(repo) {
  const out = git(pathFor(repo.name), ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowFail: true,
  });
  return out || null;
}

function exists(repoName) {
  return fs.existsSync(pathFor(repoName));
}

/** Disk usage in bytes, for the panel. `du` is cheap enough here. */
function diskUsage(repoName) {
  const wtPath = pathFor(repoName);
  if (!fs.existsSync(wtPath)) return 0;
  try {
    const out = execFileSync('du', ['-sk', wtPath], { encoding: 'utf8', timeout: 30000 });
    return Number(out.split(/\s+/)[0]) * 1024;
  } catch {
    return 0;
  }
}

/** Remove the worktree entirely; the next task recreates and re-bootstraps it. */
function remove(repo) {
  const wtPath = pathFor(repo.name);
  git(repo.path, ['worktree', 'remove', '--force', wtPath], { allowFail: true });
  if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
  git(repo.path, ['worktree', 'prune'], { allowFail: true });
  queue.forgetWorktree(repo.name);
  return true;
}

/** Boot-time tidy: clear registrations whose directories are gone. */
function pruneAll(repos) {
  for (const r of repos) git(r.path, ['worktree', 'prune'], { allowFail: true });
}

module.exports = {
  git,
  pathFor,
  settingsFor,
  defaultBranchOf,
  lockfileHash,
  ensure,
  reset,
  prepareBranch,
  checkoutExisting,
  release,
  isClean,
  currentBranch,
  exists,
  diskUsage,
  remove,
  pruneAll,
};
