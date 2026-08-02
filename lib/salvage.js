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
 *   3. `HEAD` is contained in an `origin/*` ref OTHER than the default branch —
 *      i.e. a commit was really made from those changes AND really pushed. Both
 *      halves matter: a `gh`/network failure mid-salvage leaves an unpushed
 *      commit, while an agent that simply tidied the tree (dropped the stash,
 *      deleted the untracked file) leaves `HEAD` exactly where it was — which
 *      `origin/<default>` already contains. Counting the default branch as
 *      evidence would let "did nothing" pass as "rescued";
 *   4. a pull request that really exists on GitHub, is open, is not the one
 *      being deployed, and whose head actually *contains* the salvaged commit,
 *      carries the work.
 *
 * (3) is also what gives (4) its teeth: once `HEAD` is known to be a commit the
 * default branch does not have, "this PR contains HEAD" can only be true of a
 * PR that carries the salvaged work. Without it every PR cut from the default
 * branch trivially contains `HEAD`, and any PR URL in the transcript would do.
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
   * The subset of those refs that can serve as evidence of a salvage.
   *
   * `origin/<default>` (and the `origin/HEAD` alias line pointing at it)
   * contains `HEAD` whenever the salvage produced no commit at all, so it
   * proves only that the repo was already up to date — never that anything was
   * rescued.
   */
  const salvageRemotes = (remotes, defaultBranch) => {
    const trivial = new Set(['origin/HEAD']);
    if (defaultBranch) trivial.add(`origin/${defaultBranch}`);
    return remotes.filter((r) => !trivial.has(r));
  };

  const headSha = (repoPath) => {
    try {
      return git(repoPath, ['rev-parse', '--short', 'HEAD'], 15000).trim();
    } catch {
      return null;
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
    // Fail closed: a PR whose state gh did not report is not proof of anything.
    if (pr.state !== 'OPEN') return false;
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
    remotes,
  }) {
    const evidence = remotes || salvageRemotes(remoteBranchesContainingHead(repoPath), defaultBranch);
    const ctx = { deployPrNumber, deployBranch, defaultBranch, remotes: evidence };
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
    const containing = remoteBranchesContainingHead(repoPath);
    const evidence = salvageRemotes(containing, defaultBranch);
    if (!evidence.length) {
      if (containing.length) {
        // HEAD is on (or already merged into) the default branch, so whatever
        // was in the working tree never became a commit: the tree went clean
        // some other way — a dropped stash, a deleted untracked file, an agent
        // that gave up and tidied. Checking out now would destroy it for real.
        throw new Error(
          `Salvage preflight left no commit of its own: HEAD (${headSha(repoPath) || 'unknown'}) is ` +
            `already contained in origin/${defaultBranch}, so nothing from the working tree was ` +
            `captured — the tree went clean without the changes being committed. Deploy aborted; ` +
            `check \`git stash list\` and \`git fsck --lost-found\` before running it again.`,
        );
      }
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
      remotes: evidence,
    });
  }

  return {
    statusPorcelain,
    remoteBranchesContainingHead,
    salvageRemotes,
    prCarriesHead,
    verifySalvagePr,
    assertSalvaged,
  };
}

module.exports = { createSalvageChecks, prNumbersFromTranscript };
