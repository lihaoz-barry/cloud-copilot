'use strict';

/**
 * Verifying a salvage preflight.
 *
 * Deploy runs the `salvage-local-changes` skill as phase 1 whenever the shared
 * clone has uncommitted changes, then checks out the PR branch — which destroys
 * anything still uncommitted. So the gate between the two phases is the only
 * thing standing between "your work is a reviewable PR" and "your work is gone",
 * and it must not be satisfiable by an agent that merely *says* it worked.
 *
 * Four independent facts are required before the deploy is allowed to proceed:
 *
 *   1. the salvage child exited 0;
 *   2. `git status --porcelain` is empty — the changes left the working tree;
 *   3. `HEAD` is contained in some `origin/*` ref — they were pushed, not just
 *      committed locally (a `gh`/network failure mid-salvage leaves exactly that
 *      state, and the deploy's checkout would then bury them);
 *   4. a pull request that really exists on GitHub, is open, is not the one
 *      being deployed, and whose head actually *contains* the salvaged commit,
 *      carries the work.
 *
 * (4) is why this module takes its git and gh access as injected dependencies:
 * the check is the load-bearing part of the feature, so it is unit-tested
 * against fakes rather than only exercised by a live deploy.
 */

// PR URL as printed by `gh pr create` / the skill's final report.
function prNumbersFromTranscript(conversation, ownerRepo, excludeNumber) {
  const escaped = String(ownerRepo || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return [];
  const re = new RegExp(`github\\.com/${escaped}/pull/(\\d+)`, 'gi');
  const seen = new Set();
  for (const m of String(conversation || '').matchAll(re)) {
    const num = Number(m[1]);
    if (num && num !== excludeNumber) seen.add(num);
  }
  // Last printed first: the skill prints the PR it created as its final output,
  // while anything earlier is likely something it merely looked at.
  return [...seen].reverse();
}

function createSalvageChecks({ git, gh }) {
  const statusPorcelain = (repoPath) => {
    try {
      return git(repoPath, ['status', '--porcelain']);
    } catch {
      return '';
    }
  };

  /**
   * Remote-tracking branches containing `HEAD`, e.g. ['origin/salvage-12-x'].
   * `origin/HEAD -> origin/main` alias lines are normalised to their left side.
   */
  const remoteBranchesContainingHead = (repoPath) => {
    try {
      return git(repoPath, ['branch', '-r', '--contains', 'HEAD'], 15000)
        .split('\n')
        .map((l) => l.trim().split(' ->')[0].trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  /**
   * Does this pull request actually carry the commit the salvage left at HEAD?
   *
   * Preferred proof is the PR's own head sha as GitHub reports it: if the local
   * HEAD is an ancestor of it, the work is in the PR, whatever the branch is
   * called. `merge-base --is-ancestor` also exits non-zero when the object is
   * unknown locally, in which case fall back to matching the remote-tracking
   * branch by name.
   */
  const prCarriesHead = (repoPath, pr, remotes) => {
    if (!pr) return false;
    if (pr.headRefOid) {
      try {
        git(repoPath, ['merge-base', '--is-ancestor', 'HEAD', pr.headRefOid], 15000);
        return true;
      } catch {
        /* not an ancestor, or the sha is not in this clone */
      }
    }
    return Boolean(pr.headRefName && remotes.includes(`origin/${pr.headRefName}`));
  };

  /**
   * A PR is only accepted as the salvage's output when it is open, is not the
   * deploy's own PR, is not headed by the default branch (a "PR" on `main` is a
   * sign the salvage never cut a branch) and contains the salvaged commit.
   */
  const acceptable = (repoPath, pr, { deployPrNumber, deployBranch, defaultBranch, remotes }) => {
    if (!pr || !pr.number) return false;
    if (deployPrNumber && pr.number === deployPrNumber) return false;
    if (pr.state && pr.state !== 'OPEN') return false;
    if (pr.headRefName && (pr.headRefName === deployBranch || pr.headRefName === defaultBranch)) {
      return false;
    }
    return prCarriesHead(repoPath, pr, remotes);
  };

  /**
   * Confirms the salvage really produced a reviewable pull request on GitHub.
   * Returns the verified PR, or throws with a message that names the branch the
   * work is sitting on so it can be recovered by hand.
   */
  async function verifySalvagePr({
    repoPath,
    ownerRepo,
    conversation,
    deployPrNumber,
    deployBranch,
    defaultBranch,
  }) {
    const remotes = remoteBranchesContainingHead(repoPath);
    const ctx = { deployPrNumber, deployBranch, defaultBranch, remotes };
    const claimed = prNumbersFromTranscript(conversation, ownerRepo, deployPrNumber);
    for (const number of claimed) {
      const pr = await gh.getPr(ownerRepo, number);
      if (acceptable(repoPath, pr, ctx)) return pr;
    }
    // Nothing usable was printed — ask GitHub for a PR on the branch the
    // salvage session left checked out.
    const branch = gh.gitBranch(repoPath);
    const onHead = branch ? await gh.listPrsForHead(ownerRepo, branch) : [];
    for (const pr of onHead) {
      if (acceptable(repoPath, pr, ctx)) return pr;
    }
    throw new Error(
      `Salvage preflight finished with a clean tree but no pull request could be verified` +
        (claimed.length
          ? ` (reported PR ${claimed.map((n) => `#${n}`).join(', ')}, which ${ownerRepo} does not` +
            ` have open with the salvaged commit)`
          : '') +
        `. Deploy aborted: the local changes may only exist as a commit on ` +
        `"${branch || 'the current branch'}". Check that branch before deploying again.`,
    );
  }

  /**
   * Guards the transition from the salvage phase into the deploy phase. Throws
   * (which jobs.js surfaces on the stream and turns into a failed deploy) rather
   * than deploying from a tree whose local work was not safely captured.
   */
  async function assertSalvaged({
    exitCode,
    repoPath,
    ownerRepo,
    conversation,
    deployPrNumber,
    deployBranch,
    defaultBranch,
  }) {
    if (exitCode !== 0) {
      throw new Error(
        `Salvage preflight exited ${exitCode} — the local changes were NOT committed. ` +
          `Deploy aborted so nothing is lost; the working tree is untouched.`,
      );
    }
    const dirty = statusPorcelain(repoPath);
    if (dirty) {
      throw new Error(
        `Salvage preflight finished but the working tree is still dirty:\n${dirty}\n` +
          `Deploy aborted rather than checking out over uncommitted work.`,
      );
    }
    if (!remoteBranchesContainingHead(repoPath).length) {
      throw new Error(
        `Salvage preflight left commits that exist only locally on ` +
          `"${gh.gitBranch(repoPath) || 'HEAD'}" — nothing was pushed to origin. ` +
          `Deploy aborted: checking out another branch now would hide that work.`,
      );
    }
    return verifySalvagePr({
      repoPath,
      ownerRepo,
      conversation,
      deployPrNumber,
      deployBranch,
      defaultBranch,
    });
  }

  return {
    statusPorcelain,
    remoteBranchesContainingHead,
    prCarriesHead,
    verifySalvagePr,
    assertSalvaged,
  };
}

module.exports = { createSalvageChecks, prNumbersFromTranscript };
