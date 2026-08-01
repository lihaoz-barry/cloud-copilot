'use strict';

/**
 * The scheduler — everything that runs without you pressing a button.
 *
 * Three timers feed one serial worker per repo:
 *
 *   issueScan    every N minutes  → queue a create-pr for each labelled issue
 *   syncScan     daily at syncAt  → queue a sync-scan per repo
 *   dailyReport  daily at reportAt→ write the summary, optionally email it
 *
 * The daily timers are written as "has the time passed AND haven't we run
 * today?" rather than as one-shot timeouts. That gives catch-up for free: if
 * the Mac was asleep at 03:00, the first check after it wakes still runs the
 * sweep, instead of silently skipping a day.
 *
 * Every task runs inside the repo's dedicated worktree. Note what is NOT here:
 * no lock acquisition, no yielding to interactive actions, no fairness logic.
 * The worker's only exclusive resource is a directory nobody else uses, which
 * is the entire reason this design is simpler than sharing the main checkout.
 */

const queue = require('./queue');
const config = require('./queueConfig');
const worktree = require('./worktree');
const syncTasks = require('./syncTasks');
const jobs = require('./jobs');
const gh = require('./gh');
const store = require('./store');

const SUPERVISOR_TICK_MS = 3000;
const CLOCK_TICK_MS = 60 * 1000; // how often the daily timers check the clock
const IDLE_SLEEP_MS = 3000;
const HEARTBEAT_MS = 15000;

/** @type {{reposRoot:string, copilotBin:string, startWorkJob:Function, resolveModel:Function}|null} */
let deps = null;
let running = false;
const workers = new Map(); // repo name → { stop: boolean }
let supervisorTimer = null;
let clockTimer = null;
let lastScanAtMs = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[scheduler]', ...a);

function activeRepos() {
  if (!deps) return [];
  return gh
    .listRepos(deps.reposRoot)
    .filter((r) => r.github && r.ownerRepo && config.repoActive(r.name));
}

function repoByName(name) {
  if (!deps) return null;
  return gh.listRepos(deps.reposRoot).find((r) => r.name === name) || null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Queue a create-pr task for every open issue that carries one of the repo's
 * labels and has no PR yet. Returns the number of tasks added.
 */
async function scanRepoIssues(repo) {
  const { labels } = config.repoSettings(repo.name);
  const wanted = new Set(labels.map((l) => l.toLowerCase()));
  let added = 0;

  const { issues } = await gh.listIssues(repo.ownerRepo, { force: true });
  const { prs } = await gh.listAllPrs(repo.ownerRepo, { force: true });

  for (const issue of issues || []) {
    const issueLabels = (issue.labels || []).map((l) => (l.name || '').toLowerCase());
    if (!issueLabels.some((l) => wanted.has(l))) continue;
    if (store.isDismissed(repo.name, issue.number)) continue;
    if (gh.matchPrsForIssue(prs, issue.number).length) continue;

    const task = queue.enqueue({
      repo: repo.name,
      type: 'create-pr',
      issueNumber: issue.number,
      title: `#${issue.number} ${issue.title}`,
      jobKey: `${repo.name}#${issue.number}:work`,
    });
    if (task) added++;
  }

  queue.setScanned(repo.name);
  return added;
}

async function issueScan({ reason = 'timer' } = {}) {
  const repos = activeRepos();
  let total = 0;
  for (const repo of repos) {
    try {
      total += await scanRepoIssues(repo);
    } catch (err) {
      // gh being logged out or rate-limited must not clear the queue or burn a
      // cooldown — just note it and try again next round.
      log(`issue scan failed for ${repo.name}: ${err.message}`);
    }
  }
  lastScanAtMs = Date.now();
  if (total) log(`issue scan (${reason}) queued ${total} task(s)`);
  return total;
}

/** Queue one sync-scan per repo; each spawns its own per-branch tasks later. */
function queueSyncScans() {
  let added = 0;
  for (const repo of activeRepos()) {
    const t = queue.enqueue({
      repo: repo.name,
      type: 'sync-scan',
      title: 'Check PR branches against main',
    });
    if (t) added++;
  }
  queue.setSyncScanDate();
  log(`daily sync sweep queued for ${added} repo(s)`);
  return added;
}

// ---------------------------------------------------------------------------
// Task execution
// ---------------------------------------------------------------------------

/** Await a job, killing it if it outstays the configured timeout. */
async function awaitJob(job, key, timeoutMs, onTimeout) {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (onTimeout) onTimeout();
    jobs.cancelJob(key);
  }, timeoutMs);
  if (timer.unref) timer.unref();
  await job.finished;
  clearTimeout(timer);
  return { timedOut };
}

/** Keep the panel's elapsed-time display honest across restarts. */
function startHeartbeat(taskId) {
  const t = setInterval(() => queue.heartbeat(taskId), HEARTBEAT_MS);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

async function runCreatePr(repo, task) {
  const lines = [];
  const push = (s) => {
    if (s) lines.push(s);
  };

  // Preconditions are rechecked HERE, not just at enqueue time: minutes or
  // hours may have passed, and the world moves.
  const { labels } = config.repoSettings(repo.name);
  const wanted = new Set(labels.map((l) => l.toLowerCase()));
  const { issues } = await gh.listIssues(repo.ownerRepo, { force: true });
  const issue = (issues || []).find((i) => i.number === task.issueNumber);
  if (!issue) {
    return { status: 'skipped', error: 'issue is no longer open', log: lines.join('\n') };
  }
  const issueLabels = (issue.labels || []).map((l) => (l.name || '').toLowerCase());
  if (!issueLabels.some((l) => wanted.has(l))) {
    return { status: 'skipped', error: 'label was removed', log: lines.join('\n') };
  }
  const { prs } = await gh.listAllPrs(repo.ownerRepo, { force: true });
  if (gh.matchPrsForIssue(prs, task.issueNumber).length) {
    return { status: 'skipped', error: 'a PR already exists for this issue', log: lines.join('\n') };
  }

  const wt = worktree.ensure(repo, { log: push });
  worktree.reset(repo, { log: push });
  const branch = `cc/issue-${task.issueNumber}`;
  worktree.prepareBranch(repo, branch, { log: push });

  queue.update(task.id, { worktreePath: wt.path, port: wt.port, branch });

  try {
    const job = deps.startWorkJob(repo, task.issueNumber, {
      cwd: wt.path,
      branch,
      port: wt.port,
    });
    const timeoutMs = (config.get().taskTimeoutMinutes || 60) * 60 * 1000;
    const { timedOut } = await awaitJob(job, task.jobKey, timeoutMs, () =>
      push(`timed out after ${config.get().taskTimeoutMinutes} minutes — aborting`),
    );

    const record = store.getRecord(repo.name, task.issueNumber);
    const work = record.work || {};
    if (timedOut) {
      return { status: 'failed', error: 'timed out', log: lines.join('\n') };
    }
    if (work.status === 'success' && work.prNumber) {
      push(`opened PR #${work.prNumber}`);
      return {
        status: 'success',
        log: lines.join('\n'),
        extra: { prNumber: work.prNumber, prUrl: work.prUrl },
      };
    }
    if (work.status === 'aborted') {
      return { status: 'cancelled', error: 'aborted', log: lines.join('\n') };
    }
    return {
      status: 'failed',
      error: `no pull request was opened (exit ${work.exitCode})`,
      log: lines.join('\n'),
    };
  } finally {
    // Hand the branch back so a later Deploy can check it out on the main tree.
    worktree.release(repo, { log: push });
  }
}

async function runSyncScanTask(repo, task) {
  const lines = [];
  const push = (s) => s && lines.push(s);

  worktree.ensure(repo, { log: push });
  const result = await syncTasks.runSyncScan(repo, { gh, log: push });

  for (const b of result.behind) {
    const child = queue.enqueue({
      repo: repo.name,
      type: 'sync-branch',
      branch: b.branch,
      prNumber: b.prNumber,
      title: `sync ${b.branch} (PR #${b.prNumber})`,
      source: 'spawned',
      parentTaskId: task.id,
    });
    if (child) queue.addSpawned(task.id, child.id);
  }

  return { status: 'success', log: lines.join('\n') };
}

function runSyncBranchTask(repo, task) {
  const lines = [];
  const push = (s) => s && lines.push(s);

  worktree.ensure(repo, { log: push });
  const { outcome, message } = syncTasks.runSyncBranch(repo, task.branch, { log: push });
  push(message);

  if (outcome === 'conflict') {
    const child = queue.enqueue({
      repo: repo.name,
      type: 'sync-conflict',
      branch: task.branch,
      prNumber: task.prNumber,
      title: `resolve conflicts on ${task.branch}`,
      source: 'spawned',
      parentTaskId: task.id,
    });
    if (child) queue.addSpawned(task.id, child.id);
    // The scan-and-hand-off did its job; the conflict is now someone else's
    // task, so this one is a success rather than a failure.
    return { status: 'success', log: lines.join('\n') };
  }
  if (outcome === 'merged' || outcome === 'uptodate') {
    return { status: outcome === 'merged' ? 'success' : 'skipped', error: outcome === 'uptodate' ? message : null, log: lines.join('\n') };
  }
  return { status: 'failed', error: message, log: lines.join('\n') };
}

async function runSyncConflictTask(repo, task) {
  const lines = [];
  const push = (s) => s && lines.push(s);

  const wt = worktree.ensure(repo, { log: push });
  worktree.reset(repo, { log: push });

  try {
    worktree.checkoutExisting(repo, task.branch, { log: push });
    const defaultBranch = worktree.defaultBranchOf(repo.path);
    const prompt = syncTasks.conflictPrompt({
      ownerRepo: repo.ownerRepo,
      branch: task.branch,
      defaultBranch,
      prNumber: task.prNumber,
    });

    const key = `${repo.name}#sync:${task.branch}`;
    queue.update(task.id, { jobKey: key, worktreePath: wt.path });

    const job = jobs.startJob(key, {
      bin: deps.copilotBin,
      args: ['-p', prompt, '--allow-all', '--model', deps.resolveModel()],
      cwd: wt.path,
      env: wt.port ? { PORT: String(wt.port) } : undefined,
      meta: { action: 'sync-conflict', branch: task.branch, worktree: true },
    });

    const timeoutMs = (config.get().taskTimeoutMinutes || 60) * 60 * 1000;
    const { timedOut } = await awaitJob(job, key, timeoutMs);
    if (timedOut) return { status: 'failed', error: 'timed out', log: lines.join('\n') };

    // The agent's own account of success is not enough — ask git.
    const synced = syncTasks.verifySynced(repo, task.branch);
    push(synced ? 'verified: branch is no longer behind' : 'verification failed: still behind');
    return synced
      ? { status: 'success', log: lines.join('\n') }
      : {
          status: 'failed',
          error: 'Copilot finished but the branch is still behind main',
          log: lines.join('\n'),
        };
  } finally {
    worktree.release(repo, { log: push });
  }
}

/** Run one task end to end and record the outcome. Exported for tests. */
async function runTask(task) {
  const repo = repoByName(task.repo);
  if (!repo) {
    queue.finish(task.id, 'skipped', { error: 'repo is no longer available' });
    return;
  }

  queue.markRunning(task.id);
  const stopHeartbeat = startHeartbeat(task.id);

  let outcome;
  try {
    if (task.type === 'create-pr') outcome = await runCreatePr(repo, task);
    else if (task.type === 'sync-scan') outcome = await runSyncScanTask(repo, task);
    else if (task.type === 'sync-branch') outcome = runSyncBranchTask(repo, task);
    else if (task.type === 'sync-conflict') outcome = await runSyncConflictTask(repo, task);
    else outcome = { status: 'failed', error: `unknown task type "${task.type}"` };
  } catch (err) {
    outcome = { status: 'failed', error: err.message, log: err.stack };
  } finally {
    stopHeartbeat();
  }

  queue.finish(task.id, outcome.status, {
    error: outcome.error,
    log: outcome.log,
    extra: outcome.extra,
  });
  return outcome;
}

// ---------------------------------------------------------------------------
// Worker loops
// ---------------------------------------------------------------------------

async function workerLoop(repoName, handle) {
  while (running && !handle.stop) {
    if (!config.repoActive(repoName)) {
      await sleep(IDLE_SLEEP_MS);
      continue;
    }
    const task = queue.nextQueued(repoName);
    if (!task) {
      await sleep(IDLE_SLEEP_MS);
      continue;
    }
    try {
      await runTask(task);
    } catch (err) {
      log(`task ${task.id} crashed the worker loop: ${err.message}`);
      try {
        queue.finish(task.id, 'failed', { error: err.message });
      } catch {
        /* the queue file itself is unhappy; the next tick will retry */
      }
    }
  }
  workers.delete(repoName);
}

/** Make sure every active repo has a worker; drop workers for repos that went away. */
function superviseWorkers() {
  const names = new Set(activeRepos().map((r) => r.name));
  for (const name of names) {
    if (!workers.has(name)) {
      const handle = { stop: false };
      workers.set(name, handle);
      workerLoop(name, handle).catch((err) => log(`worker ${name} died: ${err.message}`));
    }
  }
  for (const [name, handle] of workers) {
    if (!names.has(name)) handle.stop = true;
  }
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

function minutesSinceMidnight(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * True when today's scheduled moment has passed and we haven't run it today.
 * Deliberately not a one-shot timeout: this survives sleep/restart and catches
 * up rather than skipping the day.
 */
function isDue(hhmm, lastRunDate) {
  const target = config.parseTimeOfDay(hhmm);
  if (target === null) return false;
  if (lastRunDate === queue.localDateKey()) return false;
  return minutesSinceMidnight() >= target;
}

async function clockTick() {
  if (!running) return;
  const cfg = config.get();
  if (!cfg.enabled) return;

  try {
    if (isDue(cfg.syncAt, queue.get().lastSyncScanDate)) queueSyncScans();
  } catch (err) {
    log(`sync sweep scheduling failed: ${err.message}`);
  }

  try {
    if (isDue(cfg.reportAt, queue.get().lastReportDate)) {
      const report = require('./report');
      await report.generateAndDeliver({ reposRoot: deps.reposRoot });
      queue.setReportDate();
    }
  } catch (err) {
    log(`daily report failed: ${err.message}`);
  }

  const intervalMs = Math.max(1, cfg.scanIntervalMinutes || 30) * 60 * 1000;
  if (Date.now() - lastScanAtMs >= intervalMs) {
    await issueScan({ reason: 'timer' });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * @param {object} d
 *   reposRoot    where to look for repos
 *   copilotBin   resolved copilot executable
 *   startWorkJob (repo, n, {cwd, branch, port}) => Job — server.js owns the
 *                prompt and the state.json bookkeeping; we only choose where
 *                it runs
 *   resolveModel () => model id
 */
/**
 * Install the collaborators the scheduler can't require itself (they live in
 * server.js). Called by start(); also called directly by tests, which want
 * runTask() without any of the timers.
 */
function setDeps(d) {
  deps = d;
}

function start(d) {
  setDeps(d);
  if (running) return;
  running = true;

  const rec = queue.reconcile();
  if (rec.loadError) log(rec.loadError);
  if (rec.requeued || rec.failed) {
    log(`reconciled interrupted tasks: ${rec.requeued} re-queued, ${rec.failed} failed`);
  }

  try {
    worktree.pruneAll(gh.listRepos(deps.reposRoot));
  } catch (err) {
    log(`worktree prune failed: ${err.message}`);
  }

  supervisorTimer = setInterval(superviseWorkers, SUPERVISOR_TICK_MS);
  if (supervisorTimer.unref) supervisorTimer.unref();
  superviseWorkers();

  clockTimer = setInterval(() => clockTick().catch(() => {}), CLOCK_TICK_MS);
  if (clockTimer.unref) clockTimer.unref();

  // First discovery pass shortly after boot, once the server is settled.
  const kick = setTimeout(() => issueScan({ reason: 'startup' }).catch(() => {}), 10000);
  if (kick.unref) kick.unref();

  log('started');
}

function stop() {
  running = false;
  if (supervisorTimer) clearInterval(supervisorTimer);
  if (clockTimer) clearInterval(clockTimer);
  supervisorTimer = null;
  clockTimer = null;
  for (const handle of workers.values()) handle.stop = true;
}

module.exports = {
  start,
  stop,
  setDeps,
  isDue,
  issueScan,
  scanRepoIssues,
  queueSyncScans,
  runTask,
  activeRepos,
  minutesSinceMidnight,
};
