'use strict';

/**
 * Pure helpers that turn the store's per-PR deploy records into the flat
 * "every build we ever shipped" list rendered by the TestFlight page.
 *
 * Kept free of `fs` (and of the store's singleton state file) so the flattening
 * rules — which attempts count as builds, how they are identified, how a
 * failure reason is extracted — are unit-testable on plain objects.
 *
 * Every deploy attempt is its own entry: a PR that was deployed three times
 * yields three builds, even when two of them carry the same version string,
 * because the store archives each attempt into `deployHistory` before starting
 * the next one. Nothing here ever collapses or de-duplicates them.
 *
 * `deploy.branch`/`deploy.commit` are pinned when the deploy starts; `commit`
 * is `{ sha, abbrev, committedDate, headline, url }`.
 */

// A deploy that was never run has nothing to show on a builds page.
const isRealAttempt = (d) => Boolean(d) && d.status && d.status !== 'idle';

const MAX_REASON_LEN = 240;

// Lines that usually carry the actual cause of a failed/aborted deploy.
const ERROR_LINE = /(error|failed|failure|denied|not found|missing|invalid|timed out|cancell?ed|abort)/i;

/**
 * Best-effort one-line "why did this build fail" note taken from the deploy
 * transcript. Never throws and always returns either a trimmed string or null —
 * a build with an unparsable transcript must still render.
 */
function summarizeFailure(text, { maxLen = MAX_REASON_LEN } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    // Drop markdown noise and bare separators so the pick is a real sentence.
    .filter((l) => l && !/^[-*_=#>`|\s]+$/.test(l));
  if (!lines.length) return null;
  // Prefer the LAST error-ish line: deploy logs end with the fatal one.
  let pick = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (ERROR_LINE.test(lines[i])) {
      pick = lines[i];
      break;
    }
  }
  if (!pick) pick = lines[lines.length - 1];
  pick = pick.replace(/^[-*#>\s]+/, '').trim();
  if (!pick) return null;
  return pick.length > maxLen ? `${pick.slice(0, maxLen - 1)}…` : pick;
}

/** Stable, collision-free identity for one deploy attempt. */
function attemptId(repo, issueNumber, prNumber, index) {
  return `${repo}#${issueNumber}/pr${prNumber}/deploy${index}`;
}

function durationOf(d) {
  if (d && Number.isFinite(d.durationMs)) return d.durationMs;
  if (d && d.startedAt && d.finishedAt) {
    const ms = new Date(d.finishedAt) - new Date(d.startedAt);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  }
  return null;
}

/** Millisecond timestamp used for ordering; 0 when a record carries no dates. */
function buildTime(b) {
  const t = new Date(b.finishedAt || b.startedAt || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Newest first, ties broken by PR then attempt so the order is deterministic. */
function sortBuilds(builds) {
  return builds.sort(
    (a, b) =>
      buildTime(b) - buildTime(a) ||
      (b.prNumber || 0) - (a.prNumber || 0) ||
      (b.attemptIndex || 0) - (a.attemptIndex || 0),
  );
}

/**
 * Flatten every deploy attempt of one PR (archived history first, then the
 * live `deploy`) into build entries. Missing/legacy fields fall back to what
 * the PR itself knows (branch, commit) so old records still render.
 */
function buildsForPr(record, pr) {
  const attempts = [...(pr.deployHistory || []), pr.deploy].filter(isRealAttempt);
  const out = [];
  attempts.forEach((d, i) => {
    const current = d === pr.deploy;
    const failed = d.status === 'failed' || d.status === 'aborted';
    out.push({
      id: attemptId(record.repo, record.issueNumber, pr.prNumber, i),
      attemptIndex: i,
      attemptCount: attempts.length,
      repo: record.repo,
      issueNumber: record.issueNumber,
      prNumber: pr.prNumber,
      prUrl: pr.prUrl || null,
      prState: pr.state || null,
      title: pr.title || null,
      // Which code this build actually shipped. `deploy.branch`/`deploy.commit`
      // are pinned when the deploy starts; older attempts predate those fields
      // and fall back to the PR's current head (best-effort, may have moved).
      branch: d.branch || pr.headRefName || null,
      commit: d.commit || pr.headCommit || null,
      commitIsCurrentHead: !d.commit && Boolean(pr.headCommit),
      buildNumber: d.buildNumber ?? null,
      version: d.version ?? null,
      changelog: d.changelog ?? null,
      deployStatus: d.status,
      startedAt: d.startedAt || null,
      finishedAt: d.finishedAt || null,
      durationMs: durationOf(d),
      exitCode: d.exitCode ?? null,
      failureReason: failed ? summarizeFailure(d.conversation) : null,
      // The live attempt is the one the PR's Merge button acts on; earlier
      // attempts are kept as history and marked as superseded.
      current,
      superseded: !current,
      merge: current
        ? {
            status: pr.merge ? pr.merge.status : 'idle',
            forced: pr.merge ? pr.merge.forced : false,
            conflictResolved: pr.merge ? pr.merge.conflictResolved : false,
            recoveryMessage: pr.merge ? pr.merge.recoveryMessage : null,
          }
        : null,
    });
  });
  return out;
}

/**
 * Flatten an array of issue records into every build they contain.
 *
 * Per-record and per-PR failures are isolated: one corrupt entry is reported in
 * `errors` and skipped, and the remaining history is still returned — the page
 * must never go blank because a single row could not be read.
 */
function flattenBuilds(records) {
  const builds = [];
  const errors = [];
  for (const record of records || []) {
    if (!record || !record.prs) continue;
    for (const pr of Object.values(record.prs)) {
      try {
        if (!pr || pr.prNumber == null) continue;
        builds.push(...buildsForPr(record, pr));
      } catch (err) {
        errors.push({
          repo: record.repo || null,
          issueNumber: record.issueNumber ?? null,
          prNumber: pr && pr.prNumber != null ? pr.prNumber : null,
          message: err.message,
        });
      }
    }
  }
  return { builds: sortBuilds(builds), errors };
}

/**
 * Attach per-repo info to a flat build list and drop the builds that don't
 * belong on the TestFlight page.
 *
 * `resolveRepo(name)` and `deployTypeOf(repo)` are injected so this stays free
 * of the server's repo scanning. Both are called at most ONCE per repo name:
 * the history is unbounded (one row per deploy attempt ever), so resolving the
 * repo and re-reading its `.cloud-copilot.json` per row would mean hundreds of
 * identical fs reads — and hundreds of identical error rows — per refresh.
 *
 * A repo that can't be resolved on this machine keeps its builds: history must
 * not vanish because a checkout was moved or deleted. A repo whose deploy type
 * can't be determined keeps its builds too (dropping them would silently hide a
 * whole app's history behind, say, one typo in `.cloud-copilot.json`) and is
 * reported once in `errors` — resolving the repo and reading its config are
 * tracked separately, so a broken config never makes a repo that IS configured
 * here look like one that isn't.
 */
function annotateBuilds(builds, { resolveRepo, deployTypeOf }) {
  const out = [];
  const errors = [];
  const cache = new Map();
  const report = (name, message) => errors.push({ repo: name || null, issueNumber: null, prNumber: null, message });
  const infoFor = (name) => {
    if (cache.has(name)) return cache.get(name);
    let repo = null;
    let type = null;
    let typeUnknown = false;
    try {
      repo = resolveRepo(name) || null;
    } catch (err) {
      report(name, err.message);
    }
    if (repo) {
      try {
        type = deployTypeOf(repo);
      } catch (err) {
        typeUnknown = true;
        report(name, err.message);
      }
    }
    const info = { repo, type, typeUnknown };
    cache.set(name, info);
    return info;
  };
  for (const b of builds || []) {
    const info = infoFor(b.repo);
    // Repos configured for a "shell" deploy (e.g. a restart script) aren't
    // TestFlight builds and would otherwise pollute this page. Only filter on a
    // deploy type we actually managed to read.
    if (info.repo && !info.typeUnknown && info.type !== 'ios-testflight') continue;
    out.push({ ...b, ownerRepo: (info.repo && info.repo.ownerRepo) || null, repoKnown: Boolean(info.repo) });
  }
  return { builds: out, errors };
}

module.exports = {
  annotateBuilds,
  buildsForPr,
  flattenBuilds,
  sortBuilds,
  summarizeFailure,
  attemptId,
  buildTime,
};
