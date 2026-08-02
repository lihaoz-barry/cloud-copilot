'use strict';

/**
 * Automatic scheduler for committed issues (issue #64).
 *
 * An issue labelled `committed` on GitHub is a promise: cloud-copilot keeps
 * driving it forward on its own until its PR is finished. Every sweep asks one
 * question per committed issue — "what is the single most useful thing to do
 * for this issue right now?" — and does exactly that:
 *
 *   1. work    no open PR yet            → implement the issue and open one
 *   2. update  PR is behind its base     → merge the base in and verify
 *   3. review  everything else is clean  → review the PR's current head commit
 *              and apply the improvements found, once per commit
 *
 * The order is deliberate. Stages 1 and 2 are reactive — something in the world
 * changed and the PR is now wrong — while stage 3 is discretionary polish, so
 * no PR gets reviewed while another still has no PR at all or is broken against
 * `main`.
 *
 * **It does not re-implement any of those actions.** Each one is triggered by
 * POSTing to this server's own HTTP endpoint, exactly as the browser does, and
 * the scheduler simply waits for the SSE `result` event. That is what keeps
 * automatic and manual runs literally the same code path: persistence, worktree
 * leases, ntfy pushes and the running-task panel all work with no extra wiring,
 * and there is no second execution path to keep in sync.
 *
 * Safety properties that matter more than throughput:
 *   - humans win: a repo with a manually started job is skipped this sweep;
 *   - never a duplicate PR: before creating one it re-checks GitHub, so a
 *     restart mid-run cannot produce a second PR for the same issue;
 *   - failures back off exponentially and give up after MAX_ATTEMPTS, leaving
 *     `auto.needsAttention` set rather than retrying forever.
 */

const http = require('http');
const { execFileSync } = require('child_process');

const INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 10 * 60 * 1000);
const FIRST_DELAY_MS = Number(process.env.SCHEDULER_FIRST_DELAY_MS || 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.SCHEDULER_MAX_ATTEMPTS || 3);
const BACKOFF_BASE_MS = Number(process.env.SCHEDULER_BACKOFF_BASE_MS || 10 * 60 * 1000);
// A single agent run can legitimately take a long time; this only guards
// against a job that never emits a result at all.
const RUN_TIMEOUT_MS = Number(process.env.SCHEDULER_RUN_TIMEOUT_MS || 60 * 60 * 1000);

let deps = null;
let timer = null;
let running = false;
let nextRunAt = null;
let lastRunAt = null;
let lastSummary = null;

/**
 * @param {object} d
 *   port        this server's port, for the loopback calls
 *   gh, store   the shared modules
 *   isRepoBusy  (repoName) => boolean — a manual/working-tree job is running
 */
function init(d) {
  deps = d;
}

function status() {
  const settings = deps ? deps.store.getSchedulerSettings() : { enabled: false, repos: {} };
  return {
    enabled: settings.enabled,
    repos: settings.repos,
    running,
    intervalMs: INTERVAL_MS,
    nextRunAt,
    lastRunAt,
    lastSummary,
  };
}

// ---------------------------------------------------------------------------
// Triggering an action through this server's own API
// ---------------------------------------------------------------------------

/**
 * POST to a local endpoint and resolve with the SSE `result` payload.
 *
 * Reading the stream to the end is intentional: it makes each action awaitable,
 * which is what serialises a repo's queue. The job itself is owned by the job
 * manager, so even if this connection dies the run continues — the scheduler
 * just loses sight of the outcome until the next sweep.
 */
function postAction(pathname, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ ...body, auto: true });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: deps.port,
        path: pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          accept: 'text/event-stream',
        },
        timeout: RUN_TIMEOUT_MS,
      },
      (res) => {
        let buffer = '';
        let result = null;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          // Parse complete SSE frames; keep the trailing partial one.
          const frames = buffer.split('\n\n');
          buffer = frames.pop();
          for (const frame of frames) {
            const event = /^event: (.+)$/m.exec(frame);
            const data = /^data: (.+)$/m.exec(frame);
            if (!event || !data) continue;
            if (event[1] !== 'result') continue;
            try {
              result = JSON.parse(data[1]);
            } catch {
              /* ignore malformed frame */
            }
          }
        });
        res.on('end', () => resolve(result || { status: 'failed', message: 'no result event' }));
        res.on('error', (err) => resolve({ status: 'failed', message: err.message }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'failed', message: 'timed out waiting for the run to finish' });
    });
    req.on('error', (err) => resolve({ status: 'failed', message: err.message }));
    req.end(payload);
  });
}

const enc = (s) => encodeURIComponent(String(s));

// ---------------------------------------------------------------------------
// Deciding what an issue needs
// ---------------------------------------------------------------------------

/** The issue's open PRs, newest first, from the local record. */
function openPrsOf(record) {
  return Object.values(record.prs || {})
    .filter((pr) => pr.state !== 'MERGED' && pr.state !== 'CLOSED')
    .sort((a, b) => b.prNumber - a.prNumber);
}

/**
 * The one action this issue needs, or null when it is up to date.
 *
 * Deciding "no PR yet" is the only judgement worth double-checking against
 * GitHub: acting on a stale local record there would open a second PR for an
 * issue that already has one, which is the single most expensive mistake this
 * loop could make.
 */
async function decide(repo, issue, record) {
  const open = openPrsOf(record);
  if (!open.length) {
    const existing = await deps.gh.findPrForIssue(repo.ownerRepo, issue.number);
    if (existing) {
      // Adopt it so the panel and the next sweep both see it.
      deps.store.upsertPr(repo.name, issue.number, {
        prNumber: existing.number,
        prUrl: existing.url,
        source: 'gh',
        state: 'OPEN',
      });
      return null; // re-evaluated next sweep, with real sync data
    }
    return { action: 'work' };
  }

  const pr = open[0];
  const sync = pr.sync;
  if (sync && typeof sync.behindBy === 'number' && sync.behindBy > 0) {
    return { action: 'update', prNumber: pr.prNumber };
  }
  // A conflicting PR is behind in spirit even when the count says otherwise.
  if (sync && sync.state === 'conflict') {
    return { action: 'update', prNumber: pr.prNumber };
  }

  const headSha = headShaOf(repo.path, pr.headRefName);
  const reviewed = (pr.review && pr.review.lastReviewedSha) || null;
  // Without a resolvable head commit a review could not be recorded against
  // anything, and would therefore repeat on every single sweep.
  if (headSha && headSha !== reviewed) {
    return { action: 'review', prNumber: pr.prNumber };
  }
  return null;
}

/**
 * The branch's current tip according to local git.
 *
 * Deliberately not `pr.headCommit` from the store: that is refreshed hourly, so
 * right after a review pushed its improvements it still holds the OLD sha while
 * `lastReviewedSha` already holds the new one — and the mismatch would schedule
 * another review immediately, then again, forever. `origin/<branch>` is updated
 * by the push itself (the worktrees share this object store), so it is both
 * free and correct.
 */
function headShaOf(repoPath, branch) {
  if (!branch) return null;
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', `origin/${branch}`], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
  } catch {
    return null;
  }
}

const PRIORITY = { work: 0, update: 1, review: 2 };

// ---------------------------------------------------------------------------
// Running one sweep
// ---------------------------------------------------------------------------

function isCommitted(issue) {
  return (issue.labels || []).some(
    (l) => (typeof l === 'string' ? l : l && l.name) === deps.gh.COMMITTED_LABEL,
  );
}

function dueNow(record) {
  const at = record.auto && record.auto.nextAttemptAt;
  return !at || Date.now() >= at;
}

async function planForRepo(repo) {
  let issues;
  try {
    ({ issues } = await deps.gh.listIssues(repo.ownerRepo));
  } catch (err) {
    return { error: err.message, tasks: [] };
  }
  const tasks = [];
  for (const issue of issues) {
    if (!isCommitted(issue)) continue;
    const record = deps.store.getRecord(repo.name, issue.number);
    if (record.auto && record.auto.needsAttention) continue;
    if (!dueNow(record)) continue;
    // eslint-disable-next-line no-await-in-loop
    const task = await decide(repo, issue, record);
    if (task) tasks.push({ ...task, issueNumber: issue.number, title: issue.title });
  }
  tasks.sort((a, b) => PRIORITY[a.action] - PRIORITY[b.action] || a.issueNumber - b.issueNumber);
  return { error: null, tasks };
}

function endpointFor(repo, task) {
  const base = `/api/repos/${enc(repo.name)}/issues/${task.issueNumber}`;
  if (task.action === 'work') return `${base}/work`;
  return `${base}/prs/${task.prNumber}/${task.action}`;
}

function noteOutcome(repo, task, result) {
  const ok = result && result.status === 'success';
  deps.store.updateAuto(repo.name, task.issueNumber, (a) => {
    a.lastAction = task.action;
    a.lastRunAt = new Date().toISOString();
    if (ok) {
      a.attempts = 0;
      a.lastError = null;
      a.nextAttemptAt = null;
      a.needsAttention = false;
      return;
    }
    // "blocked" means something else is holding the repo, not that the task is
    // broken — retry it next sweep without spending the budget.
    if (result && result.status === 'blocked') {
      a.lastError = result.message || 'blocked';
      return;
    }
    a.attempts = (a.attempts || 0) + 1;
    a.lastError = (result && (result.message || result.error)) || `run ended as ${result && result.status}`;
    if (a.attempts >= MAX_ATTEMPTS) {
      a.needsAttention = true;
      a.nextAttemptAt = null;
    } else {
      a.nextAttemptAt = Date.now() + BACKOFF_BASE_MS * 2 ** (a.attempts - 1);
    }
  });
}

async function runRepo(repo) {
  if (!deps.store.isSchedulerEnabledFor(repo.name)) return { repo: repo.name, skipped: 'disabled' };
  if (deps.isRepoBusy(repo.name)) return { repo: repo.name, skipped: 'busy with a manual task' };

  const { error, tasks } = await planForRepo(repo);
  if (error) return { repo: repo.name, skipped: `could not list issues: ${error}` };
  if (!tasks.length) return { repo: repo.name, done: 0 };

  let done = 0;
  for (const task of tasks) {
    // Re-check between tasks: a person may have started something while the
    // previous task of this sweep was running.
    if (deps.isRepoBusy(repo.name)) break;
    console.log(`[scheduler] ${repo.name}#${task.issueNumber}: ${task.action}`);
    // eslint-disable-next-line no-await-in-loop
    const result = await postAction(endpointFor(repo, task), {});
    noteOutcome(repo, task, result);
    done += 1;
  }
  return { repo: repo.name, done };
}

async function sweep() {
  if (!deps || running) return;
  const settings = deps.store.getSchedulerSettings();
  if (!settings.enabled) return;
  running = true;
  lastRunAt = new Date().toISOString();
  try {
    const repos = deps.listRepos().filter((r) => r.github);
    // Repos in parallel, tasks within a repo serial: two agents on the same
    // repo would be fine now, but a serial queue keeps the machine's load
    // proportional to the number of repos rather than to the backlog.
    const results = await Promise.all(repos.map((r) => runRepo(r).catch((err) => ({ repo: r.name, error: err.message }))));
    lastSummary = results.filter((r) => r && (r.done || r.error));
  } catch (err) {
    lastSummary = [{ error: err.message }];
  } finally {
    running = false;
  }
}

function schedule(delayMs) {
  if (timer) clearTimeout(timer);
  nextRunAt = Date.now() + delayMs;
  timer = setTimeout(async () => {
    await sweep();
    schedule(INTERVAL_MS);
  }, delayMs);
  if (timer.unref) timer.unref();
}

function start() {
  schedule(FIRST_DELAY_MS);
}

/** Bring the next sweep forward (the settings panel's "run now"). */
function runSoon() {
  schedule(1000);
}

module.exports = { init, start, status, runSoon, sweep, INTERVAL_MS, MAX_ATTEMPTS };
