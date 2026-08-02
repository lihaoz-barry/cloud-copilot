'use strict';

/**
 * The committed-issue scheduler, as a client of the dashboard rather than a
 * part of it.
 *
 * An issue labelled `committed` is a promise: cloud-copilot keeps driving it
 * forward on its own until its PR is finished. Every sweep asks one question
 * per committed issue — "what is the single most useful thing to do for this
 * issue right now?" — and does exactly that:
 *
 *   1. work    no open PR yet            → implement the issue and open one
 *   2. update  PR is behind its base     → merge the base in and verify
 *   3. review  everything else is clean  → review the PR's head commit and
 *              apply the improvements found, once per commit
 *
 * The order is deliberate. Stages 1 and 2 are reactive — something changed and
 * the PR is now wrong — while stage 3 is discretionary polish, so nothing gets
 * reviewed while another issue still has no PR at all.
 *
 * WHY IT LIVES OUTSIDE THE DASHBOARD
 * ----------------------------------
 * This used to run inside the :8787 process, which meant the dashboard's own
 * restart (something cloud-copilot does to itself on every self-deploy) tore
 * down the automation with it. Here it only *talks* to :8787 over HTTP, exactly
 * as a browser does — so a dashboard restart is, to this loop, one failed fetch
 * followed by a successful one. It keeps its own settings and retry budget in
 * data/scheduler.json for the same reason, and because two processes writing
 * data/state.json would quietly lose each other's updates.
 *
 * It still re-implements none of the actions: each is triggered by POSTing to
 * the dashboard's endpoint and reading the SSE `result` event, which is what
 * keeps automatic and manual runs literally the same code path.
 *
 * Safety properties that matter more than throughput:
 *   - humans win: a repo with a manually started job is skipped this sweep;
 *   - never a duplicate PR: before creating one it re-checks GitHub, so a
 *     restart mid-run cannot produce a second PR for the same issue;
 *   - at most MAX_CONCURRENT agent runs at once, machine-wide;
 *   - failures back off exponentially and give up after MAX_ATTEMPTS, leaving
 *     `needsAttention` set rather than retrying forever.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const DATA_DIR = process.env.CC_DATA_DIR || path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'scheduler.json');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'state.json');

const INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 10 * 60 * 1000);
const FIRST_DELAY_MS = Number(process.env.SCHEDULER_FIRST_DELAY_MS || 30 * 1000);
const MAX_ATTEMPTS = Number(process.env.SCHEDULER_MAX_ATTEMPTS || 3);
const BACKOFF_BASE_MS = Number(process.env.SCHEDULER_BACKOFF_BASE_MS || 10 * 60 * 1000);
// A single agent run can legitimately take a long time; this only guards
// against a run that never emits a result at all.
const RUN_TIMEOUT_MS = Number(process.env.SCHEDULER_RUN_TIMEOUT_MS || 60 * 60 * 1000);
// How many agent runs this machine will drive at once. Three is the point where
// a laptop still stays usable; lower it if the metrics panel says otherwise.
const MAX_CONCURRENT = Math.max(1, Number(process.env.SCHEDULER_MAX_CONCURRENT || 3));
const COMMITTED_LABEL = process.env.CC_COMMITTED_LABEL || 'committed';

let dashboard = { host: '127.0.0.1', port: 8787 };
let settings = null;
let timer = null;
let running = false;
let nextRunAt = null;
let lastRunAt = null;
let lastSummary = null;
let lastError = null;
let reposRoot = null;
/** Tasks this scheduler has dispatched and is still waiting on. */
const inFlight = new Map();

// ---------------------------------------------------------------------------
// Settings + retry budget (data/scheduler.json)
// ---------------------------------------------------------------------------

function blank() {
  return { version: 1, enabled: false, repos: {}, auto: {} };
}

/**
 * Load settings, migrating the dashboard's copy on first run.
 *
 * Without the migration, moving the scheduler out of :8787 would silently
 * switch off automation that the user had switched on — the one failure mode
 * nobody would notice until a week of committed issues had gone undriven.
 */
function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return {
      version: 1,
      enabled: Boolean(raw.enabled),
      repos: raw.repos && typeof raw.repos === 'object' ? raw.repos : {},
      auto: raw.auto && typeof raw.auto === 'object' ? raw.auto : {},
    };
  } catch {
    /* fall through to migration */
  }
  const s = blank();
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf8'));
    const old = legacy && legacy.settings && legacy.settings.scheduler;
    if (old) {
      s.enabled = Boolean(old.enabled);
      s.repos = old.repos && typeof old.repos === 'object' ? { ...old.repos } : {};
      console.log(`[scheduler] migrated settings from state.json (enabled=${s.enabled})`);
    }
  } catch {
    /* no legacy state — a fresh install */
  }
  return s;
}

function saveSettings() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (err) {
    console.error('[scheduler] could not persist settings:', err.message);
  }
}

const autoKey = (repo, n) => `${repo}#${n}`;

function autoOf(repo, n) {
  const k = autoKey(repo, n);
  if (!settings.auto[k]) {
    settings.auto[k] = {
      attempts: 0,
      lastError: null,
      lastAction: null,
      lastRunAt: null,
      nextAttemptAt: null,
      needsAttention: false,
    };
  }
  return settings.auto[k];
}

function clearAuto(repo, n) {
  const k = autoKey(repo, n);
  if (settings.auto[k]) {
    delete settings.auto[k];
    saveSettings();
  }
}

function getSettings() {
  return { enabled: settings.enabled, repos: { ...settings.repos }, auto: { ...settings.auto } };
}

function enabledFor(repoName) {
  if (!settings.enabled) return false;
  return Object.prototype.hasOwnProperty.call(settings.repos, repoName)
    ? Boolean(settings.repos[repoName])
    : true;
}

function setEnabled(enabled) {
  settings.enabled = Boolean(enabled);
  saveSettings();
  return getSettings();
}

/** `enabled: null` clears the override so the repo follows the global switch. */
function setRepoEnabled(repo, enabled) {
  if (enabled === null || enabled === undefined) delete settings.repos[repo];
  else settings.repos[repo] = Boolean(enabled);
  saveSettings();
  return getSettings();
}

/** Clear one issue's retry budget — the "try it again now" escape hatch. */
function resetIssue(repo, n) {
  clearAuto(repo, n);
  return true;
}

// ---------------------------------------------------------------------------
// Talking to the dashboard
// ---------------------------------------------------------------------------

function request(method, pathname, body, { timeout = 60000, sse = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (sse) headers.accept = 'text/event-stream';
    const req = http.request(
      { host: dashboard.host, port: dashboard.port, path: pathname, method, headers, timeout },
      (res) => {
        let buffer = '';
        let result = null;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          if (!sse) return;
          // Parse complete SSE frames; keep the trailing partial one.
          const frames = buffer.split('\n\n');
          buffer = frames.pop();
          for (const frame of frames) {
            const event = /^event: (.+)$/m.exec(frame);
            const data = /^data: (.+)$/m.exec(frame);
            if (!event || !data || event[1] !== 'result') continue;
            try {
              result = JSON.parse(data[1]);
            } catch {
              /* ignore a malformed frame */
            }
          }
        });
        res.on('end', () => {
          if (sse) return resolve(result);
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode} from ${pathname}: ${buffer.slice(0, 200)}`));
          }
          try {
            resolve(buffer ? JSON.parse(buffer) : null);
          } catch (err) {
            reject(new Error(`bad JSON from ${pathname}: ${err.message}`));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`timed out after ${Math.round(timeout / 1000)}s`));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const enc = (s) => encodeURIComponent(String(s));

/**
 * Everything this loop needs from the dashboard, in one place.
 *
 * Named rather than inlined so the decision logic can be tested without a
 * server: `decide()` is where a mistake costs a duplicate PR or an issue that
 * silently never moves again, and it should be possible to prove it right
 * without standing up HTTP.
 */
const httpApi = {
  getRepos: () => request('GET', '/api/repos', undefined, { timeout: 15000 }),
  getIssues: (repoName) =>
    request('GET', `/api/repos/${enc(repoName)}/issues`, undefined, { timeout: 120000 }),
  getRecord: (repoName, n) => request('GET', `/api/repos/${enc(repoName)}/issues/${n}/record`),
  // Forces a fresh look at GitHub AND writes what it finds into the record, so
  // the caller re-reads rather than merging anything itself.
  refreshPrs: (repoName, n) =>
    request('GET', `/api/repos/${enc(repoName)}/issues/${n}/prs`, undefined, { timeout: 120000 }),
  getJobs: () => request('GET', '/api/jobs', undefined, { timeout: 10000 }),
  postAction: (pathname) =>
    request('POST', pathname, { auto: true }, { timeout: RUN_TIMEOUT_MS, sse: true }),
};

let api = httpApi;

/**
 * Trigger one action and wait for its `result` event.
 *
 * The dashboard owns the run, so losing this connection loses only the
 * outcome, not the work — the next sweep re-derives the state from GitHub.
 */
async function postAction(pathname) {
  try {
    const result = await api.postAction(pathname);
    return result || { status: 'failed', message: 'the run ended without a result event' };
  } catch (err) {
    return { status: 'failed', message: err.message };
  }
}

// ---------------------------------------------------------------------------
// Deciding what an issue needs
// ---------------------------------------------------------------------------

function openPrsOf(record) {
  return Object.values(record.prs || {})
    .filter((pr) => pr.state !== 'MERGED' && pr.state !== 'CLOSED')
    .sort((a, b) => b.prNumber - a.prNumber);
}

/**
 * The branch's current tip according to local git.
 *
 * Deliberately not the store's `headCommit`: that is refreshed hourly, so right
 * after a review pushed its improvements it still holds the OLD sha while
 * `lastReviewedSha` already holds the new one — and the mismatch would schedule
 * another review immediately, then again, forever. `origin/<branch>` is updated
 * by the push itself, so it is both free and correct.
 */
function headShaOf(repoPath, branch) {
  if (!branch || !repoPath) return null;
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', `origin/${branch}`], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
  } catch {
    return null;
  }
}

async function getRecord(repoName, n) {
  return api.getRecord(repoName, n);
}

/**
 * What this record says the issue needs, using only what it already holds.
 *
 * Split out from `decide` because it is the whole judgement and none of the
 * I/O: given a record, the answer is deterministic, which is what makes the
 * automation testable.
 */
function decideFromRecord(repo, record) {
  const open = openPrsOf(record);
  if (!open.length) return { action: 'work' };

  const pr = open[0];
  const sync = pr.sync;
  if (sync && typeof sync.behindBy === 'number' && sync.behindBy > 0) {
    return { action: 'update', prNumber: pr.prNumber };
  }
  // A conflicting PR is behind in spirit even when the count says otherwise.
  if (sync && sync.state === 'conflict') {
    return { action: 'update', prNumber: pr.prNumber };
  }
  if (!sync) return null; // unknowable from here; the caller refreshes and retries

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
 * The one action this issue needs, or null when it is up to date.
 *
 * Two situations are worth spending a GitHub round-trip on, and both are cases
 * where acting on the local record would be actively harmful:
 *
 *   - "no PR yet" — opening a second PR for an issue that already has one is
 *     the single most expensive mistake this loop could make;
 *   - "PR with no base comparison yet" — almost always the PR this loop just
 *     created, where falling through to `review` would spend a whole agent run
 *     reviewing a diff that the base merge is about to rewrite.
 *
 * Both refresh through the dashboard, which writes what GitHub says into the
 * record, so the retry below reads facts rather than merging them here.
 */
async function decide(repo, issue, record) {
  const first = decideFromRecord(repo, record);
  // Anything but "open a PR" is already backed by a PR this record knows about,
  // so it can be acted on as-is.
  if (first && first.action !== 'work') return first;
  // `null` with a compared PR means genuinely up to date — nothing to refresh.
  const open = openPrsOf(record);
  if (first === null && open.length && open[0].sync) return null;

  try {
    await api.refreshPrs(repo.name, issue.number);
  } catch {
    // GitHub is unreachable. Trusting a stale "no PR" would risk a duplicate,
    // so nothing that could duplicate anything is allowed to stand.
    return null;
  }

  let fresh;
  try {
    fresh = await getRecord(repo.name, issue.number);
  } catch {
    return null;
  }
  const second = decideFromRecord(repo, fresh);
  // A PR that turned up during the refresh is only recorded this sweep; the
  // next one acts on it with real sync data rather than guessing now.
  if (first && first.action === 'work' && second && second.action !== 'work') return null;
  return second;
}

const PRIORITY = { work: 0, update: 1, review: 2 };

function isCommitted(issue) {
  return (issue.labels || []).some((l) => (typeof l === 'string' ? l : l && l.name) === COMMITTED_LABEL);
}

function endpointFor(repo, task) {
  const base = `/api/repos/${enc(repo.name)}/issues/${task.issueNumber}`;
  if (task.action === 'work') return `${base}/work`;
  return `${base}/prs/${task.prNumber}/${task.action}`;
}

function noteOutcome(repo, task, result) {
  const a = autoOf(repo.name, task.issueNumber);
  a.lastAction = task.action;
  a.lastRunAt = new Date().toISOString();
  const ok = result && result.status === 'success';
  if (ok) {
    a.attempts = 0;
    a.lastError = null;
    a.nextAttemptAt = null;
    a.needsAttention = false;
  } else if (result && result.status === 'blocked') {
    // "blocked" means something else is holding the repo, not that the task is
    // broken — retry next sweep without spending the budget.
    a.lastError = result.message || 'blocked';
  } else {
    a.attempts = (a.attempts || 0) + 1;
    a.lastError =
      (result && (result.message || result.error)) || `the run ended as ${result && result.status}`;
    if (a.attempts >= MAX_ATTEMPTS) {
      a.needsAttention = true;
      a.nextAttemptAt = null;
    } else {
      a.nextAttemptAt = Date.now() + BACKOFF_BASE_MS * 2 ** (a.attempts - 1);
    }
  }
  saveSettings();
}

// ---------------------------------------------------------------------------
// One sweep
// ---------------------------------------------------------------------------

/** Repos with a job a human started — those are left alone this sweep. */
async function busyRepos() {
  try {
    const data = await api.getJobs();
    const busy = new Set();
    for (const j of data.jobs || []) if (!j.auto) busy.add(j.repo);
    return { busy, runningAuto: (data.jobs || []).filter((j) => j.auto).length };
  } catch {
    return { busy: new Set(), runningAuto: 0 };
  }
}

async function planForRepo(repo, committedSeen) {
  let issues;
  try {
    ({ issues } = await api.getIssues(repo.name));
  } catch (err) {
    return { error: err.message, tasks: [] };
  }
  const tasks = [];
  for (const issue of issues || []) {
    if (!isCommitted(issue)) continue;
    committedSeen.add(autoKey(repo.name, issue.number));
    const a = settings.auto[autoKey(repo.name, issue.number)];
    if (a && a.needsAttention) continue;
    if (a && a.nextAttemptAt && Date.now() < a.nextAttemptAt) continue;
    let record;
    try {
      // eslint-disable-next-line no-await-in-loop
      record = await getRecord(repo.name, issue.number);
    } catch {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const task = await decide(repo, issue, record);
    if (task) tasks.push({ ...task, repo, issueNumber: issue.number, title: issue.title });
  }
  return { error: null, tasks };
}

/**
 * Run `tasks` with at most MAX_CONCURRENT in flight.
 *
 * Concurrency, not parallelism-for-its-own-sake: each run gets its own git
 * worktree and test port from the dashboard, so three agents genuinely can
 * work at once — but every one of them is a full model session plus whatever
 * build it starts, and beyond three this machine stops being usable for the
 * person sitting at it.
 */
async function runTasks(tasks, busy) {
  let index = 0;
  let done = 0;
  const failures = [];

  async function worker() {
    for (;;) {
      const i = index;
      index += 1;
      if (i >= tasks.length) return;
      const task = tasks[i];
      // Re-check between tasks: a person may have started something while an
      // earlier task of this sweep was running.
      if (busy.has(task.repo.name)) continue;
      const label = `${task.repo.name}#${task.issueNumber}: ${task.action}`;
      console.log(`[scheduler] ${label}`);
      const flightKey = `${task.repo.name}#${task.issueNumber}:${task.action}`;
      inFlight.set(flightKey, { ...task, repo: task.repo.name, startedAt: Date.now() });
      // eslint-disable-next-line no-await-in-loop
      const result = await postAction(endpointFor(task.repo, task));
      inFlight.delete(flightKey);
      noteOutcome(task.repo, task, result);
      done += 1;
      if (!result || result.status !== 'success') {
        failures.push({ task: label, status: (result && result.status) || 'failed', message: (result && result.message) || null });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, tasks.length) }, worker));
  return { done, failures };
}

async function sweep() {
  if (running) return { skipped: 'a sweep is already running' };
  if (!settings.enabled) return { skipped: 'the scheduler is off' };
  running = true;
  lastRunAt = new Date().toISOString();
  lastError = null;
  try {
    const { repos, root } = await api.getRepos();
    reposRoot = root || reposRoot;
    const eligible = (repos || [])
      .filter((r) => r.github && enabledFor(r.name))
      .map((r) => ({ ...r, path: path.join(reposRoot || '', r.name) }));
    const { busy } = await busyRepos();

    const committedSeen = new Set();
    const all = [];
    const errors = [];
    for (const repo of eligible) {
      if (busy.has(repo.name)) {
        errors.push({ repo: repo.name, skipped: 'a manual task is running' });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const { error, tasks } = await planForRepo(repo, committedSeen);
      if (error) errors.push({ repo: repo.name, skipped: `could not list issues: ${error}` });
      else all.push(...tasks);
    }

    // An issue that stopped being committed should not keep a retry budget it
    // can never spend; dropping it means re-committing later starts clean.
    for (const k of Object.keys(settings.auto)) {
      const repoName = k.slice(0, k.lastIndexOf('#'));
      if (!eligible.some((r) => r.name === repoName)) continue;
      if (!committedSeen.has(k)) delete settings.auto[k];
    }
    saveSettings();

    all.sort((a, b) => PRIORITY[a.action] - PRIORITY[b.action] || a.issueNumber - b.issueNumber);
    const { done, failures } = await runTasks(all, busy);
    lastSummary = {
      at: new Date().toISOString(),
      planned: all.length,
      done,
      concurrency: MAX_CONCURRENT,
      failures,
      skipped: errors,
    };
  } catch (err) {
    lastError = err.message;
    lastSummary = { at: new Date().toISOString(), error: err.message };
  } finally {
    running = false;
  }
  return lastSummary;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function schedule(delayMs) {
  if (timer) clearTimeout(timer);
  nextRunAt = Date.now() + delayMs;
  timer = setTimeout(async () => {
    await sweep();
    schedule(INTERVAL_MS);
  }, delayMs);
  if (timer.unref) timer.unref();
}

/**
 * @param {object} opts
 *   host, port  where the dashboard lives
 *   api         override the dashboard calls (tests only)
 */
function init({ host = '127.0.0.1', port = 8787, api: apiOverride = null } = {}) {
  dashboard = { host, port };
  api = apiOverride ? { ...httpApi, ...apiOverride } : httpApi;
  settings = loadSettings();
  saveSettings();
  return getSettings();
}

function start() {
  schedule(FIRST_DELAY_MS);
}

/** Bring the next sweep forward (the panel's "run now"). */
function runSoon() {
  schedule(1000);
}

function status() {
  return {
    enabled: settings ? settings.enabled : false,
    repos: settings ? settings.repos : {},
    auto: settings ? settings.auto : {},
    running,
    intervalMs: INTERVAL_MS,
    maxConcurrent: MAX_CONCURRENT,
    nextRunAt,
    lastRunAt,
    lastSummary,
    lastError,
    dashboard: `http://${dashboard.host}:${dashboard.port}`,
    inFlight: [...inFlight.values()],
  };
}

module.exports = {
  init,
  start,
  sweep,
  runSoon,
  status,
  getSettings,
  setEnabled,
  setRepoEnabled,
  resetIssue,
  enabledFor,
  // Exported for the unit tests: `decide` is where every "what should happen to
  // this issue now?" mistake would show up, and it is pure apart from `api`.
  decide,
  decideFromRecord,
  INTERVAL_MS,
  MAX_ATTEMPTS,
  MAX_CONCURRENT,
  SETTINGS_FILE,
};
