/**
 * Linked-worktree housekeeping.
 *
 * Agent sessions like to implement an issue inside a `git worktree` they create
 * themselves (e.g. under `.claude/worktrees/`) — and sometimes leave it behind,
 * locked, holding the PR's branch. Git then refuses to check that branch out
 * anywhere else ("already used by worktree"), which is exactly what a later
 * Deploy needs to do.
 *
 * So instead of only unlocking at Deploy time, cloud-copilot removes those
 * directories as soon as an action that could have created one finishes.
 * The single rule everything here obeys: **never delete work**. A worktree is
 * removable only when it is clean AND every commit it holds already exists on
 * the remote (or, after a merge, on the base branch). Anything unprovable —
 * detached HEAD, missing remote-tracking ref, git error — counts as unsafe and
 * the directory stays.
 *
 * Every git call uses argument-array form; branch names come from GitHub and
 * must never reach a shell.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// Same-directory test that survives symlinked paths — on macOS git reports
// `/private/var/...` where the caller holds `/var/...`, and a plain
// `path.resolve` comparison would then mistake the MAIN working tree for a
// linked one (or fail to protect a directory named in `skipPaths`).
function canonical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function git(repoPath, args, timeout = 20000) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

function isDirty(repoPath) {
  try {
    return git(repoPath, ['status', '--porcelain']).length > 0;
  } catch {
    return false;
  }
}

// Every *linked* worktree of the repo (the main working tree and bare entries
// are excluded), as `{ path, branch }`. `branch` is null for detached HEADs,
// which we can never prove safe to delete.
function listLinkedWorktrees(repoPath) {
  let out;
  try {
    out = git(repoPath, ['worktree', 'list', '--porcelain'], 15000);
  } catch {
    return [];
  }
  const entries = [];
  let current = null;
  const flush = () => {
    if (current && !current.bare && canonical(current.path) !== canonical(repoPath)) {
      entries.push({ path: current.path, branch: current.branch });
    }
    current = null;
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length).trim(), branch: null, bare: false };
    } else if (!current) continue;
    else if (line === 'bare') current.bare = true;
    else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      if (ref.startsWith('refs/heads/')) current.branch = ref.slice('refs/heads/'.length);
    }
  }
  flush();
  return entries;
}

// The linked worktree holding `branch`, or null when the branch is free.
function worktreePathForBranch(repoPath, branch) {
  const hit = listLinkedWorktrees(repoPath).find((w) => w.branch === branch);
  return hit ? hit.path : null;
}

// Why a worktree may (not) be removed. `fallbackRef` covers the just-merged
// case, where GitHub already deleted origin/<branch> but every commit the
// worktree holds now lives on the base branch.
function worktreeDisposability(worktreePath, branch, { fallbackRef = null } = {}) {
  if (!branch) return { disposable: false, reason: 'detached HEAD' };
  if (isDirty(worktreePath)) return { disposable: false, reason: 'uncommitted changes' };
  const containedBy = (ref) => git(worktreePath, ['log', '--oneline', `${ref}..HEAD`], 15000).length === 0;
  try {
    if (!containedBy(`origin/${branch}`)) return { disposable: false, reason: 'unpushed commits' };
    return { disposable: true, reason: 'clean and fully pushed' };
  } catch {
    /* no origin/<branch> — it may have been deleted after a merge */
  }
  if (fallbackRef) {
    try {
      if (containedBy(fallbackRef)) {
        return { disposable: true, reason: `clean and already contained in ${fallbackRef}` };
      }
      return { disposable: false, reason: `commits missing from ${fallbackRef}` };
    } catch {
      /* fall through to the unprovable case */
    }
  }
  return { disposable: false, reason: `no origin/${branch} to compare against` };
}

// Unlocks (locked worktrees refuse removal) and removes the worktree, then
// prunes the stale administrative entry. Throws when git refuses.
function releaseWorktree(repoPath, worktreePath) {
  try {
    git(repoPath, ['worktree', 'unlock', worktreePath], 15000);
  } catch {
    /* not locked — nothing to unlock */
  }
  git(repoPath, ['worktree', 'remove', worktreePath], 30000);
  try {
    git(repoPath, ['worktree', 'prune'], 15000);
  } catch {
    /* best effort */
  }
}

// Best-effort `git fetch origin <branch>` so origin/<branch> is current before
// we judge whether a worktree still holds unpushed work. Right after Create PR
// the ref may not exist locally at all, which would make the worktree look
// unsafe and defeat the whole cleanup.
function fetchBranch(repoPath, branch) {
  try {
    execFileSync('git', ['fetch', 'origin', branch], { cwd: repoPath, stdio: 'ignore', timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

// Frees `branch` from whatever linked worktree holds it, when that can be done
// without losing work. Never throws — returns
// `{ status: 'none' | 'released' | 'kept', path, branch, reason }`.
function releaseBranchWorktree(repoPath, branch, { fetch = true, fallbackRef = null } = {}) {
  const worktreePath = worktreePathForBranch(repoPath, branch);
  if (!worktreePath) return { status: 'none', path: null, branch, reason: 'no worktree holds this branch' };
  if (fetch) fetchBranch(repoPath, branch);
  const { disposable, reason } = worktreeDisposability(worktreePath, branch, { fallbackRef });
  if (!disposable) return { status: 'kept', path: worktreePath, branch, reason };
  try {
    releaseWorktree(repoPath, worktreePath);
    return { status: 'released', path: worktreePath, branch, reason };
  } catch (err) {
    return { status: 'kept', path: worktreePath, branch, reason: `git refused: ${err.message}` };
  }
}

// Proactive housekeeping: remove every linked worktree that cannot lose work,
// so a later Deploy never has to fight for a branch in the first place.
// `skipPaths` protects directories a job is currently running in. Never throws.
function sweepDisposableWorktrees(repoPath, { skipPaths = [], fallbackRef = null } = {}) {
  const skip = new Set(skipPaths.filter(Boolean).map((p) => canonical(p)));
  const results = [];
  for (const wt of listLinkedWorktrees(repoPath)) {
    if (skip.has(canonical(wt.path))) {
      results.push({ status: 'kept', path: wt.path, branch: wt.branch, reason: 'in use by this run' });
      continue;
    }
    if (wt.branch) fetchBranch(repoPath, wt.branch);
    const { disposable, reason } = worktreeDisposability(wt.path, wt.branch, { fallbackRef });
    if (!disposable) {
      results.push({ status: 'kept', path: wt.path, branch: wt.branch, reason });
      continue;
    }
    try {
      releaseWorktree(repoPath, wt.path);
      results.push({ status: 'released', path: wt.path, branch: wt.branch, reason });
    } catch (err) {
      results.push({ status: 'kept', path: wt.path, branch: wt.branch, reason: `git refused: ${err.message}` });
    }
  }
  try {
    git(repoPath, ['worktree', 'prune'], 15000);
  } catch {
    /* best effort */
  }
  return results;
}

// Removes worktrees left behind by an action that just finished, so the next
// Deploy finds its branch free. Targets `branch` first (the PR's own branch,
// the one Deploy will want), then sweeps the rest. Never throws.
function cleanupAfterRun(repoPath, branch, { skipPaths = [], fallbackRef = null } = {}) {
  const results = [];
  try {
    const skip = new Set(skipPaths.filter(Boolean).map((p) => canonical(p)));
    if (branch) {
      const held = worktreePathForBranch(repoPath, branch);
      if (held && !skip.has(canonical(held))) {
        results.push(releaseBranchWorktree(repoPath, branch, { fallbackRef }));
      }
    }
    const swept = sweepDisposableWorktrees(repoPath, { skipPaths, fallbackRef });
    const seen = new Set(results.map((r) => canonical(r.path)));
    for (const r of swept) if (!seen.has(canonical(r.path))) results.push(r);
  } catch {
    /* housekeeping must never affect the job's own outcome */
  }
  return results;
}

// One human-readable line per worktree we touched, appended to the run's
// transcript so the UI shows what was cleaned up — and what deliberately was not.
function formatCleanup(results) {
  if (!results || !results.length) return '';
  return results
    .map(
      (r) =>
        `[worktree] ${r.status === 'released' ? 'released' : 'kept'} ${r.path}` +
        `${r.branch ? ` (${r.branch})` : ''} — ${r.reason}`,
    )
    .join('\n');
}

module.exports = {
  listLinkedWorktrees,
  worktreePathForBranch,
  worktreeDisposability,
  releaseWorktree,
  releaseBranchWorktree,
  sweepDisposableWorktrees,
  cleanupAfterRun,
  formatCleanup,
};
