'use strict';

/**
 * Durable task queue — the backlog the scheduler works through unattended.
 *
 * Deliberately a SEPARATE file from state.json. state.json holds every action's
 * full transcript and is already ~600KB; the queue rewrites itself on every
 * status transition (many times a minute), and re-serialising 600KB each time
 * would be silly. Tasks here carry a one-line summary, never a transcript — the
 * transcript lives in state.json under the task's jobKey.
 *
 * Shape (v1):
 *   {
 *     version, tasks[], history[], counters{}, cooldown{}, worktrees{},
 *     lastSyncScanDate, lastReportDate
 *   }
 *
 * Statuses:
 *   queued | running | success | failed | interrupted | cancelled | skipped
 *   - failed       a real failure. Enters cooldown; never auto-requeued.
 *   - interrupted  the server died mid-run. Auto-requeued once (attempt 2).
 *   - skipped      preconditions no longer hold (label pulled, PR already open,
 *                  branch no longer behind). Not a failure, no cooldown.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
// Overridable so tests get an isolated file instead of scribbling on real state.
const QUEUE_FILE = process.env.CC_QUEUE_FILE || path.join(DATA_DIR, 'queue.json');
const VERSION = 1;

const HISTORY_LIMIT = 500;
// How long a finished task stays in `tasks` (and so in the panel) before being
// swept into `history`.
const TERMINAL_RETAIN_MS = 24 * 60 * 60 * 1000;
// One automatic re-run after a crash — never more.
const MAX_ATTEMPTS = 2;

const TASK_TYPES = ['create-pr', 'sync-scan', 'sync-branch', 'sync-conflict'];
const TERMINAL_STATUSES = new Set(['success', 'failed', 'cancelled', 'skipped']);

function ensureDir() {
  const dir = path.dirname(QUEUE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function blankState() {
  return {
    version: VERSION,
    tasks: [],
    history: [],
    counters: {},
    cooldown: {},
    worktrees: {},
    lastSyncScanDate: null,
    lastReportDate: null,
  };
}

/**
 * In-memory source of truth. Unlike store.js (which re-reads the file on every
 * call) the queue keeps state resident: it is the only writer, and worker loops
 * touch it far too often for a read-modify-write per operation to be sane.
 */
let state = null;

function loadFromDisk() {
  ensureDir();
  if (!fs.existsSync(QUEUE_FILE)) return blankState();
  try {
    const parsed = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    const s = { ...blankState(), ...parsed };
    if (!Array.isArray(s.tasks)) s.tasks = [];
    if (!Array.isArray(s.history)) s.history = [];
    for (const k of ['counters', 'cooldown', 'worktrees']) {
      if (!s[k] || typeof s[k] !== 'object') s[k] = {};
    }
    return s;
  } catch (err) {
    // A corrupt queue must never stop the server from booting. Keep the bad
    // file for forensics and start clean — the next scan refills the queue.
    try {
      fs.renameSync(QUEUE_FILE, `${QUEUE_FILE}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
    const s = blankState();
    s.loadError = `queue.json was unreadable (${err.message}); started from an empty queue`;
    return s;
  }
}

function get() {
  if (!state) state = loadFromDisk();
  return state;
}

function save() {
  ensureDir();
  const tmp = `${QUEUE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(get(), null, 2));
  fs.renameSync(tmp, QUEUE_FILE); // atomic on the same filesystem
}

/** Tests only — drop the resident copy so the next get() re-reads from disk. */
function _reset() {
  state = null;
}

function newId() {
  return `t_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

const nowIso = () => new Date().toISOString();

/** Local (not UTC) calendar day — the schedule means "03:00 my time". */
function localDateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Identity of the *work*, not of the task row. Used both to dedupe enqueues and
 * to key the cooldown table, so a failed attempt and a would-be re-enqueue of
 * the same work agree on what "the same" means.
 */
function dedupeKeyFor({ repo, type, issueNumber, branch }) {
  if (type === 'create-pr') return `${repo}#${issueNumber}:create-pr`;
  if (type === 'sync-scan') return `${repo}:sync-scan`;
  return `${repo}@${branch}:${type}`;
}

function counters(repo) {
  const s = get();
  if (!s.counters[repo]) s.counters[repo] = { totalDone: 0, totalFailed: 0, lastScanAt: null };
  return s.counters[repo];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const listTasks = () => get().tasks;
const getTask = (id) => get().tasks.find((t) => t.id === id) || null;
const tasksForRepo = (repo) => get().tasks.filter((t) => t.repo === repo);

/** Is this work already queued or running? Terminal rows don't block a re-add. */
function hasPending(fields) {
  const key = dedupeKeyFor(fields);
  return get().tasks.some(
    (t) => t.dedupeKey === key && (t.status === 'queued' || t.status === 'running'),
  );
}

const isCoolingDown = (fields) => Boolean(get().cooldown[dedupeKeyFor(fields)]);

/**
 * The next task this repo's worker should run: lowest priority number first,
 * then oldest. "Move to top" sets a priority below every other task's.
 */
function nextQueued(repo) {
  const queued = get().tasks.filter((t) => t.repo === repo && t.status === 'queued');
  if (!queued.length) return null;
  queued.sort(
    (a, b) => a.priority - b.priority || new Date(a.enqueuedAt) - new Date(b.enqueuedAt),
  );
  return queued[0];
}

const runningTask = (repo) =>
  get().tasks.find((t) => t.repo === repo && t.status === 'running') || null;

/** Counts for the FAB badge — cheap enough to poll often. */
function summary() {
  let queued = 0;
  let running = 0;
  let failed = 0;
  for (const t of get().tasks) {
    if (t.status === 'queued') queued++;
    else if (t.status === 'running') running++;
    else if (t.status === 'failed' || t.status === 'interrupted') failed++;
  }
  return { queued, running, failed, pending: queued + running };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Add a task. Returns the task, or null when identical work is already
 * queued/running or is in cooldown — unless `force`, which the manual
 * "add"/"retry" buttons pass.
 */
function enqueue(fields, { force = false } = {}) {
  const { repo, type } = fields;
  if (!repo) throw new Error('enqueue: repo required');
  if (!TASK_TYPES.includes(type)) throw new Error(`enqueue: unknown type "${type}"`);

  const dedupeKey = dedupeKeyFor(fields);
  if (force) delete get().cooldown[dedupeKey];
  else if (hasPending(fields) || isCoolingDown(fields)) return null;

  const task = {
    id: newId(),
    repo,
    type,
    status: 'queued',
    priority: fields.priority ?? 0,
    issueNumber: fields.issueNumber ?? null,
    prNumber: fields.prNumber ?? null,
    branch: fields.branch ?? null,
    title: fields.title ?? null,
    jobKey: fields.jobKey ?? null,
    worktreePath: fields.worktreePath ?? null,
    port: fields.port ?? null,
    prUrl: null,
    dedupeKey,
    source: fields.source || 'scan', // scan | manual | spawned
    parentTaskId: fields.parentTaskId ?? null,
    enqueuedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    heartbeatAt: null,
    attempt: 1,
    error: null,
    log: null,
    spawnedTaskIds: [],
  };

  get().tasks.push(task);
  save();
  return task;
}

function update(id, patch) {
  const t = getTask(id);
  if (!t) return null;
  if (typeof patch === 'function') patch(t);
  else Object.assign(t, patch);
  save();
  return t;
}

function markRunning(id, extra = {}) {
  const t = getTask(id);
  if (!t) return null;
  t.status = 'running';
  t.startedAt = nowIso();
  t.heartbeatAt = t.startedAt;
  t.error = null;
  Object.assign(t, extra);
  save();
  return t;
}

/** Refresh the liveness stamp so a restarted panel shows real elapsed time. */
function heartbeat(id) {
  const t = getTask(id);
  if (!t || t.status !== 'running') return;
  t.heartbeatAt = nowIso();
  save();
}

/**
 * Terminal transition: success | failed | cancelled | skipped.
 * Failures enter cooldown so the scanner never re-adds the same doomed work.
 */
function finish(id, status, { error = null, log = null, extra = null } = {}) {
  const t = getTask(id);
  if (!t) return null;
  t.status = status;
  t.finishedAt = nowIso();
  t.durationMs = t.startedAt ? new Date(t.finishedAt) - new Date(t.startedAt) : null;
  if (error) t.error = String(error).slice(0, 500);
  if (log) t.log = String(log).slice(0, 4000);
  if (extra) Object.assign(t, extra);

  const c = counters(t.repo);
  if (status === 'success') c.totalDone++;
  if (status === 'failed') {
    c.totalFailed++;
    get().cooldown[t.dedupeKey] = { failedAt: t.finishedAt, reason: t.error || status };
  }
  save();
  return t;
}

function addSpawned(parentId, childId) {
  const t = getTask(parentId);
  if (!t) return;
  t.spawnedTaskIds.push(childId);
  save();
}

function remove(id) {
  const s = get();
  const i = s.tasks.findIndex((t) => t.id === id);
  if (i === -1) return false;
  s.tasks.splice(i, 1);
  save();
  return true;
}

function moveToTop(id) {
  const t = getTask(id);
  if (!t || t.status !== 'queued') return false;
  t.priority = Math.min(0, ...get().tasks.map((x) => x.priority)) - 1;
  save();
  return true;
}

/** Clear cooldown and put the work back at the head of the queue (↻ Retry). */
function retry(id) {
  const t = getTask(id);
  if (!t) return null;
  delete get().cooldown[t.dedupeKey];
  const fresh = enqueue(
    {
      repo: t.repo,
      type: t.type,
      issueNumber: t.issueNumber,
      prNumber: t.prNumber,
      branch: t.branch,
      title: t.title,
      source: 'manual',
      priority: -1,
    },
    { force: true },
  );
  remove(t.id);
  return fresh;
}

function clearCooldown(fields) {
  delete get().cooldown[dedupeKeyFor(fields)];
  save();
}

function setScanned(repo) {
  counters(repo).lastScanAt = nowIso();
  save();
}

function setSyncScanDate(date = localDateKey()) {
  get().lastSyncScanDate = date;
  save();
}

function setReportDate(date = localDateKey()) {
  get().lastReportDate = date;
  save();
}

/** Bookkeeping for lib/worktree.js — creation time, bootstrap, lockfile hash. */
function worktreeInfo(repo) {
  return get().worktrees[repo] || null;
}

function setWorktreeInfo(repo, patch) {
  const s = get();
  s.worktrees[repo] = { ...(s.worktrees[repo] || {}), ...patch };
  save();
  return s.worktrees[repo];
}

function forgetWorktree(repo) {
  delete get().worktrees[repo];
  save();
}

// ---------------------------------------------------------------------------
// Boot-time reconciliation
// ---------------------------------------------------------------------------

/**
 * Called once on server start. Anything still marked `running` was killed with
 * the previous process (jobs are children of this process — nothing survives a
 * restart). Re-run it once; a task interrupted twice is treated as failed
 * rather than looping forever through a crash it may well be causing.
 */
function reconcile() {
  const s = get();
  let requeued = 0;
  let failed = 0;

  for (const t of s.tasks) {
    if (t.status !== 'running') continue;
    if (t.attempt < MAX_ATTEMPTS) {
      t.attempt++;
      t.status = 'queued';
      t.priority = -1; // it was already at the head; keep it there
      t.startedAt = null;
      t.heartbeatAt = null;
      t.error = 'interrupted by a server restart — re-running once';
      requeued++;
    } else {
      t.status = 'failed';
      t.finishedAt = nowIso();
      t.error = 'interrupted twice by a server restart';
      counters(t.repo).totalFailed++;
      s.cooldown[t.dedupeKey] = { failedAt: t.finishedAt, reason: t.error };
      failed++;
    }
  }

  sweep();
  save();
  return { requeued, failed, loadError: s.loadError || null };
}

/** Move long-finished tasks out of the active list into capped history. */
function sweep() {
  const s = get();
  const cutoff = Date.now() - TERMINAL_RETAIN_MS;
  const keep = [];
  for (const t of s.tasks) {
    const done = TERMINAL_STATUSES.has(t.status);
    const old = t.finishedAt && new Date(t.finishedAt).getTime() < cutoff;
    if (done && old) s.history.unshift(t);
    else keep.push(t);
  }
  s.tasks = keep;
  if (s.history.length > HISTORY_LIMIT) s.history.length = HISTORY_LIMIT;
}

/** Every task that finished within the window — the daily report's raw input. */
function finishedSince(sinceIso) {
  const since = new Date(sinceIso).getTime();
  return [...get().tasks, ...get().history]
    .filter((t) => t.finishedAt && new Date(t.finishedAt).getTime() >= since)
    .sort((a, b) => new Date(a.finishedAt) - new Date(b.finishedAt));
}

module.exports = {
  QUEUE_FILE,
  MAX_ATTEMPTS,
  TASK_TYPES,
  TERMINAL_STATUSES,
  localDateKey,
  dedupeKeyFor,
  get,
  save,
  _reset,
  listTasks,
  getTask,
  tasksForRepo,
  hasPending,
  isCoolingDown,
  nextQueued,
  runningTask,
  summary,
  enqueue,
  update,
  markRunning,
  heartbeat,
  finish,
  addSpawned,
  remove,
  moveToTop,
  retry,
  clearCooldown,
  setScanned,
  setSyncScanDate,
  setReportDate,
  worktreeInfo,
  setWorktreeInfo,
  forgetWorktree,
  reconcile,
  sweep,
  finishedSince,
};
