'use strict';

/**
 * Local base-branch comparison for open PRs (issue #58).
 *
 * The badge on every PR row has to answer "is this branch still current with
 * its base?" every few minutes. Asking GitHub that often is both slow and a
 * good way to meet the API rate limit, and GitHub's own `mergeable` field is
 * computed lazily — it answers UNKNOWN exactly when a PR is new, which is when
 * you most want to know. The repository is already on this disk, so the honest
 * answer is one `git fetch` plus two plumbing commands away:
 *
 *   behind/ahead   git rev-list --left-right --count origin/<base>...origin/<head>
 *   conflict?      git merge-tree --write-tree origin/<base> origin/<head>
 *
 * Both are strictly read-only with respect to the working tree and the index:
 * `merge-tree` writes only loose objects (garbage-collectable) and never
 * touches HEAD, so this can run while a Copilot job holds the working tree.
 */

const { execFile } = require('child_process');
const { deriveSyncState } = require('./gh');

const FETCH_TIMEOUT_MS = Number(process.env.PR_SYNC_FETCH_TIMEOUT_MS || 60000);
const GIT_TIMEOUT_MS = Number(process.env.PR_SYNC_GIT_TIMEOUT_MS || 20000);

// execFile that resolves with { code, stdout } instead of throwing on a
// non-zero exit — `merge-tree` uses exit code 1 to mean "conflicts", which is
// an answer, not an error.
function git(cwd, args, timeout = GIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          return resolve({
            ok: false,
            code: typeof err.code === 'number' ? err.code : null,
            stdout: stdout || '',
            stderr: stderr || err.message,
          });
        }
        resolve({ ok: true, code: 0, stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

/** Refresh remote-tracking refs once per repo per sweep. */
async function fetchRemote(repoPath) {
  const r = await git(repoPath, ['fetch', '--no-tags', '--prune', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
  return r.ok;
}

/** [behindBy, aheadBy] of `head` relative to `base`, or [null, null]. */
async function countAheadBehind(repoPath, base, head) {
  const r = await git(repoPath, [
    'rev-list',
    '--left-right',
    '--count',
    `origin/${base}...origin/${head}`,
  ]);
  if (!r.ok) return [null, null];
  const m = r.stdout.trim().split(/\s+/);
  const behind = Number(m[0]);
  const ahead = Number(m[1]);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return [null, null];
  return [behind, ahead];
}

/**
 * true = merging base into head would conflict, false = it would not,
 * null = git could not tell us (ancient git, missing ref, timeout).
 */
async function probeConflict(repoPath, base, head) {
  const r = await git(repoPath, ['merge-tree', '--write-tree', `origin/${base}`, `origin/${head}`]);
  if (r.ok) return false;
  if (r.code === 1) return true;
  return null;
}

/**
 * Compare one PR's head against its base using only local git.
 * Returns the same shape `gh.listPrSync` produces, plus `source: 'git'`, so
 * the store, the API and the badge cannot tell the two apart.
 */
async function computePrSync(repoPath, pr) {
  const base = pr.baseRefName;
  const head = pr.headRefName;
  const at = Date.now();
  const blank = {
    state: 'unknown',
    behindBy: null,
    aheadBy: null,
    mergeable: 'UNKNOWN',
    mergeStateStatus: null,
    baseRefName: base || null,
    headRefName: head || null,
    crossRepository: Boolean(pr.crossRepository),
    at,
    source: 'git',
  };
  // A fork's head branch does not exist in this clone, so there is nothing
  // local to compare — those PRs keep whatever GitHub last said.
  if (!base || !head || pr.crossRepository) return null;

  const [behindBy, aheadBy] = await countAheadBehind(repoPath, base, head);
  if (behindBy == null) return null; // ref missing locally — don't overwrite good data
  const conflict = await probeConflict(repoPath, base, head);

  const mergeable = conflict === true ? 'CONFLICTING' : conflict === false ? 'MERGEABLE' : 'UNKNOWN';
  return {
    ...blank,
    behindBy,
    aheadBy,
    mergeable,
    mergeStateStatus: conflict === true ? 'DIRTY' : conflict === false ? (behindBy > 0 ? 'BEHIND' : 'CLEAN') : null,
    state: deriveSyncState({ mergeable, behindBy }),
  };
}

/**
 * Compare every given PR of one repo. One fetch, then two cheap plumbing calls
 * per PR, run serially so a sweep over four repos never spawns a burst of git
 * processes. PRs git cannot answer for are simply absent from the result.
 *
 * @param {string} repoPath  working copy on disk
 * @param {Array}  prs       [{ prNumber, baseRefName, headRefName, crossRepository }]
 * @returns {Promise<{ synced: Object, fetched: boolean }>}
 */
async function computeRepoSync(repoPath, prs, { fetch = true } = {}) {
  const synced = {};
  const list = (prs || []).filter((p) => p && p.prNumber && p.baseRefName && p.headRefName);
  if (!list.length) return { synced, fetched: false };
  const fetched = fetch ? await fetchRemote(repoPath) : false;
  for (const pr of list) {
    try {
      const sync = await computePrSync(repoPath, pr);
      if (sync) synced[String(pr.prNumber)] = sync;
    } catch {
      /* one PR failing must not abort the sweep */
    }
  }
  return { synced, fetched };
}

module.exports = { computeRepoSync, computePrSync, countAheadBehind, probeConflict };
