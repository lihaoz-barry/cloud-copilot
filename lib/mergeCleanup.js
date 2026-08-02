'use strict';

/**
 * Post-merge cleanup.
 *
 * GitHub only closes an issue when the merged PR body carries a `Closes #N`
 * keyword *and* the PR targets the default branch, and it never touches the
 * other PRs that were opened for the same issue. cloud-copilot happily creates
 * several PRs per issue, so after a successful merge we close the issue and every
 * sibling PR ourselves.
 *
 * Everything here is best-effort: a failure must never turn a successful merge
 * into a failed one, so errors are collected and reported, not thrown.
 */

const { execFile } = require('child_process');
const gh = require('./gh');

const CLEANUP_TIMEOUT_MS = 20000;

function isEnabled() {
  return process.env.MERGE_AUTO_CLEANUP !== '0';
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(
      gh.GH_BIN,
      args,
      { timeout: CLEANUP_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.message = `${err.message}\n${stderr || ''}`.trim();
          return reject(err);
        }
        resolve(stdout);
      },
    );
  });
}

async function viewState(kind, ownerRepo, number) {
  try {
    const out = await run([kind, 'view', String(number), '--repo', ownerRepo, '--json', 'state']);
    return JSON.parse(out).state || null;
  } catch {
    return null;
  }
}

function describe({ issueClosed, issueAlreadyClosed, closedPrs, errors }) {
  const parts = [];
  if (issueClosed) parts.push('closed the issue');
  else if (issueAlreadyClosed) parts.push('issue was already closed');
  if (closedPrs.length) {
    parts.push(`closed superseded PR ${closedPrs.map((n) => `#${n}`).join(', ')}`);
  }
  if (errors.length) parts.push(`${errors.length} cleanup step(s) failed`);
  if (!parts.length) return null;
  const text = parts.join('; ');
  return `Post-merge cleanup: ${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * Close the issue and every other still-open PR that belongs to it.
 *
 * @param {object} opts
 * @param {string} opts.ownerRepo        "owner/repo"
 * @param {number} opts.issueNumber      the issue the merged PR belongs to
 * @param {number} opts.mergedPrNumber   the PR that was just merged
 * @param {number[]} opts.prNumbers      all PR numbers known for that issue
 * @returns {Promise<object>} summary { enabled, ran, issueClosed, issueAlreadyClosed,
 *                                      closedPrs, skippedPrs, errors, message }
 */
async function cleanupAfterMerge({ ownerRepo, issueNumber, mergedPrNumber, prNumbers = [] }) {
  const summary = {
    enabled: isEnabled(),
    ran: false,
    issueClosed: false,
    issueAlreadyClosed: false,
    closedPrs: [],
    skippedPrs: [],
    errors: [],
    message: null,
  };
  if (!summary.enabled) return summary;
  if (!ownerRepo || !Number.isInteger(issueNumber) || !Number.isInteger(mergedPrNumber)) {
    return summary;
  }

  // Safety net: only clean up once GitHub really reports the PR as merged.
  const mergedState = await viewState('pr', ownerRepo, mergedPrNumber);
  if (mergedState !== 'MERGED') {
    summary.errors.push(
      `PR #${mergedPrNumber} is ${mergedState || 'unknown'} rather than MERGED — cleanup skipped`,
    );
    return summary;
  }
  summary.ran = true;

  const siblings = [...new Set(prNumbers.map(Number))].filter(
    (n) => Number.isInteger(n) && n > 0 && n !== mergedPrNumber,
  );

  for (const prNumber of siblings) {
    const state = await viewState('pr', ownerRepo, prNumber);
    if (state !== 'OPEN') {
      summary.skippedPrs.push(prNumber);
      continue;
    }
    try {
      await run([
        'pr',
        'close',
        String(prNumber),
        '--repo',
        ownerRepo,
        '--comment',
        `Superseded by #${mergedPrNumber}, which was merged for issue #${issueNumber}. Closed automatically by cloud-copilot.`,
        '--delete-branch',
      ]);
      summary.closedPrs.push(prNumber);
    } catch (error) {
      summary.errors.push(`failed to close PR #${prNumber}: ${error.message}`);
    }
  }

  const issueState = await viewState('issue', ownerRepo, issueNumber);
  if (issueState === 'OPEN') {
    try {
      await run([
        'issue',
        'close',
        String(issueNumber),
        '--repo',
        ownerRepo,
        '--comment',
        `Closed by #${mergedPrNumber} (merged via cloud-copilot).`,
      ]);
      summary.issueClosed = true;
    } catch (error) {
      summary.errors.push(`failed to close issue #${issueNumber}: ${error.message}`);
    }
  } else if (issueState) {
    summary.issueAlreadyClosed = true;
  }

  summary.message = describe(summary);

  if (summary.issueClosed || summary.closedPrs.length) {
    // Refresh the gh caches so the dashboard shows the new states right away.
    try {
      await Promise.all([
        gh.listIssues(ownerRepo, { force: true }),
        gh.listAllPrs(ownerRepo, { force: true }),
      ]);
    } catch {
      /* cache warm-up only */
    }
  }

  return summary;
}

module.exports = { cleanupAfterMerge, isEnabled };
