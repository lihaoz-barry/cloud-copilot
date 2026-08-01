'use strict';

/**
 * Keeping open PR branches up to date with the default branch.
 *
 * Split across three task types on purpose:
 *
 *   sync-scan      read-only. Which open PR branches are behind origin/main?
 *                  Spawns one sync-branch task per branch that is.
 *   sync-branch    pure git. checkout → merge → push. No agent, no tokens.
 *   sync-conflict  only when git couldn't do it alone. Copilot resolves.
 *
 * The critical rule is in `runSyncBranch`: on conflict we `merge --abort` and
 * hand the branch to a *separate* task rather than resolving in place. The
 * queue is serial and shares one worktree per repo — leaving a conflicted tree
 * behind would poison every task after it. Redoing the merge later costs
 * seconds; a wedged worktree costs the whole queue.
 */

const worktree = require('./worktree');

/** How many commits `origin/main` is ahead of this branch. 0 = up to date. */
function behindCount(repoPath, branch, defaultBranch) {
  const out = worktree.git(
    repoPath,
    ['rev-list', '--count', `origin/${branch}..origin/${defaultBranch}`],
    { allowFail: true },
  );
  const n = Number(out);
  return Number.isFinite(n) ? n : 0;
}

/** True when the last merge left unresolved paths in the index. */
function hasConflict(wtPath) {
  const out = worktree.git(wtPath, ['ls-files', '-u'], { allowFail: true });
  return Boolean(out);
}

/**
 * sync-scan — read-only survey. Returns
 * { defaultBranch, checked, behind: [{ prNumber, branch, title, behindBy }], log }
 */
async function runSyncScan(repo, { gh, log = () => {} }) {
  worktree.git(repo.path, ['fetch', 'origin', '--prune'], { allowFail: true });
  const defaultBranch = worktree.defaultBranchOf(repo.path);

  const { prs } = await gh.listAllPrs(repo.ownerRepo, { force: true });
  const behind = [];
  for (const pr of prs || []) {
    if (!pr.headRefName) continue;
    const by = behindCount(repo.path, pr.headRefName, defaultBranch);
    if (by > 0) {
      behind.push({ prNumber: pr.number, branch: pr.headRefName, title: pr.title, behindBy: by });
    }
  }

  const lines = [
    `checked ${prs ? prs.length : 0} open PR(s) against origin/${defaultBranch}`,
    ...behind.map((b) => `  behind by ${b.behindBy}: #${b.prNumber} ${b.branch}`),
    behind.length ? '' : '  all branches up to date',
  ];
  lines.filter(Boolean).forEach(log);

  return { defaultBranch, checked: prs ? prs.length : 0, behind, log: lines.join('\n') };
}

/**
 * sync-branch — try to bring one branch up to date with pure git.
 *
 * Returns { outcome, message } where outcome is:
 *   'merged'    merged and pushed
 *   'uptodate'  nothing to do (someone got there first)
 *   'conflict'  aborted cleanly; caller should spawn a sync-conflict task
 *   'dirty'     worktree wasn't clean; skipped without touching anything
 */
function runSyncBranch(repo, branch, { log = () => {} } = {}) {
  const wtPath = worktree.reset(repo, { log });
  const defaultBranch = worktree.defaultBranchOf(repo.path);

  try {
    if (!worktree.isClean(repo)) {
      return { outcome: 'dirty', message: 'worktree was not clean after reset; skipped' };
    }

    if (behindCount(repo.path, branch, defaultBranch) === 0) {
      return { outcome: 'uptodate', message: `${branch} is already up to date` };
    }

    worktree.checkoutExisting(repo, branch, { log });

    const merged = worktree.git(wtPath, ['merge', `origin/${defaultBranch}`, '--no-edit'], {
      allowFail: true,
    });

    if (merged === null) {
      const conflicted = hasConflict(wtPath);
      // Restore a clean tree BEFORE returning — the next task shares it.
      worktree.git(wtPath, ['merge', '--abort'], { allowFail: true });
      worktree.git(wtPath, ['reset', '--hard'], { allowFail: true });
      if (conflicted) {
        log(`merge conflicted — aborted, handing ${branch} to a Copilot task`);
        return { outcome: 'conflict', message: `merge conflicted; spawned a resolve task` };
      }
      return { outcome: 'dirty', message: `git merge failed on ${branch} (no conflict reported)` };
    }

    log(merged.split('\n').slice(0, 5).join('\n'));
    worktree.git(wtPath, ['push', 'origin', `HEAD:${branch}`]);
    return { outcome: 'merged', message: `${branch} merged with ${defaultBranch} and pushed` };
  } finally {
    // Always give the branch name back, even on the failure paths — see the
    // note in worktree.release().
    worktree.release(repo, { log });
  }
}

/** The prompt handed to Copilot when git alone couldn't merge. */
function conflictPrompt({ ownerRepo, branch, defaultBranch, prNumber }) {
  return (
    `You are in a dedicated git worktree for ${ownerRepo}, checked out on branch \`${branch}\`` +
    `${prNumber ? ` (pull request #${prNumber})` : ''}. ` +
    `Merge \`origin/${defaultBranch}\` into this branch. There are conflicts: resolve every one ` +
    `of them, preserving the intent of BOTH sides — do not discard either side's functionality ` +
    `just to make the merge apply. Then commit the merge and push the branch to origin. ` +
    `Do not open, close, or merge any pull request, and do not create any new branch. ` +
    `When you are done, print SYNC_OK on its own line.`
  );
}

/**
 * Did the conflict task actually work? We do not take the agent's word for it —
 * git is the referee.
 */
function verifySynced(repo, branch) {
  worktree.git(repo.path, ['fetch', 'origin', '--prune'], { allowFail: true });
  const defaultBranch = worktree.defaultBranchOf(repo.path);
  return behindCount(repo.path, branch, defaultBranch) === 0;
}

module.exports = {
  behindCount,
  hasConflict,
  runSyncScan,
  runSyncBranch,
  conflictPrompt,
  verifySynced,
};
