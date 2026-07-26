'use strict';

/**
 * Action queue / scheduler.
 *
 * Every long-running action used to start immediately, and anything that
 * collided with a repo's shared working tree was simply *rejected* ("Blocked:
 * ... already running"). That threw away the user's intent and forced them to
 * sit and re-click. This module turns those rejections into a real queue.
 *
 * Three rules, all enforced here (no Copilot hooks involved — the server owns
 * scheduling end-to-end, which is far more predictable than hook-driven
 * sequencing):
 *
 *  1. Two lanes with independent caps:
 *       - `task` (Create PR / Deploy / Merge): 3 concurrent.
 *       - `chat` (Admin chat, PR chat, PreIssue chat): 3 concurrent, scheduled
 *         BEFORE tasks so a human typing a message never waits behind a batch
 *         of background pipelines.
 *     => at most 6 child processes overall, 3 of which are always reserved for
 *     interactive chat.
 *
 *  2. Per-repo working-tree lock: entries flagged `exclusive` take an exclusive
 *     lock on their repo, because a clone has exactly ONE checkout — two
 *     actions checking out different branches in the same repo corrupt each
 *     other. Entries for *other* repos happily skip ahead of a repo-blocked
 *     one (the queue is FIFO per repo, not head-of-line blocking globally).
 *
 *  3. Dependencies: an entry may declare `dependsOn` keys. It won't start until
 *     they finish, and if a dependency ends in anything other than success the
 *     dependent entry is cancelled outright (a Deploy queued behind a Create PR
 *     is meaningless once the PR run failed) — surfaced to the user via the
 *     entry's `onCancelled` hook, which the server turns into a notification.
 *
 * SSE waiters: callers hand us the still-open HTTP response for the action.
 * While an entry waits we send it `event: queued` updates; once it starts we
 * hand every waiter to the job manager, so from the client's point of view a
 * queued action looks exactly like a slow-starting one.
 */

const jobs = require('./jobs');

const LANE_LIMITS = { chat: 3, task: 3 };
// Scheduling order — chat first so interactive turns always win a free slot.
const LANES = ['chat', 'task'];

/** @type {Map<string, Entry>} */
const entries = new Map(); // key -> Entry (queued OR running)
const pending = { chat: [], task: [] }; // FIFO of not-yet-started entries
const runningCount = { chat: 0, task: 0 };
const repoLocks = new Map(); // repoName -> entry key holding the lock

let seq = 0;

class Entry {
  constructor(opts) {
    this.id = `q${++seq}`;
    this.key = opts.key;
    this.lane = opts.lane === 'chat' ? 'chat' : 'task';
    this.repo = opts.repo || null;
    this.exclusive = Boolean(opts.exclusive && opts.repo);
    this.meta = opts.meta || {};
    this.dependsOn = Array.isArray(opts.dependsOn) ? opts.dependsOn.filter(Boolean) : [];
    this.run = opts.run;
    this.onCancelled = opts.onCancelled || null;
    this.onSettled = opts.onSettled || null;
    this.label = opts.label || this.key;
    this.waiters = new Set();
    this.status = 'queued'; // queued | running | done | cancelled
    this.enqueuedAt = new Date().toISOString();
    this.startedAt = null;
    this.job = null;
  }
}

function writeSse(res, event, data) {
  if (!res || res.writableEnded) return;
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* waiter vanished; harmless */
  }
}

function addWaiter(entry, res) {
  if (!res) return;
  entry.waiters.add(res);
  res.on('close', () => entry.waiters.delete(res));
}

/** Position of an entry within its lane's pending list (1-based), or 0. */
function positionOf(entry) {
  const idx = pending[entry.lane].indexOf(entry);
  return idx === -1 ? 0 : idx + 1;
}

/** Why an entry can't start yet — used for the `queued` SSE payload. */
function waitReason(entry) {
  const dep = entry.dependsOn.find((k) => entries.has(k));
  if (dep) {
    const d = entries.get(dep);
    return `waiting for ${d.label} to finish`;
  }
  if (entry.exclusive && repoLocks.has(entry.repo)) {
    const holder = entries.get(repoLocks.get(entry.repo));
    return `${entry.repo} is busy with ${holder ? holder.label : 'another action'} (one working-tree action per repo)`;
  }
  if (runningCount[entry.lane] >= LANE_LIMITS[entry.lane]) {
    return `${entry.lane} slots full (${LANE_LIMITS[entry.lane]} max)`;
  }
  return 'waiting for a free slot';
}

function notifyQueued(entry, { force = true } = {}) {
  const position = positionOf(entry);
  const reason = waitReason(entry);
  // Only re-announce when something actually changed — the scheduler pumps on
  // every start/finish, and a client doesn't need "still #2, same reason"
  // repeated in its log.
  const stamp = `${position}|${reason}`;
  if (!force && entry._lastNotice === stamp) return;
  entry._lastNotice = stamp;
  const payload = {
    queueId: entry.id,
    key: entry.key,
    lane: entry.lane,
    position,
    reason,
    ...entry.meta,
  };
  for (const res of entry.waiters) writeSse(res, 'queued', payload);
}

/** Re-send positions to everything still waiting (after any queue movement). */
function broadcastPositions() {
  for (const lane of LANES) {
    for (const entry of pending[lane]) {
      if (entry.waiters.size) notifyQueued(entry, { force: false });
    }
  }
}

function canStart(entry) {
  if (runningCount[entry.lane] >= LANE_LIMITS[entry.lane]) return false;
  if (entry.dependsOn.some((k) => entries.has(k))) return false;
  if (entry.exclusive && repoLocks.has(entry.repo)) return false;
  return true;
}

let pumping = false;

/**
 * Start as many pending entries as the limits/locks allow. Chat lane first.
 * Reentrancy-guarded: `startEntry` is async and may finish (and re-pump)
 * synchronously in failure paths.
 */
function pump() {
  if (pumping) return;
  pumping = true;
  try {
    let moved = true;
    while (moved) {
      moved = false;
      for (const lane of LANES) {
        if (runningCount[lane] >= LANE_LIMITS[lane]) continue;
        // First *startable* entry, not strictly the head: an entry blocked on
        // repo A must not hold back an unrelated entry for repo B. FIFO within
        // a repo is still preserved, since we scan oldest-first.
        const idx = pending[lane].findIndex(canStart);
        if (idx === -1) continue;
        const [entry] = pending[lane].splice(idx, 1);
        startEntry(entry);
        moved = true;
      }
    }
  } finally {
    pumping = false;
  }
  broadcastPositions();
}

async function startEntry(entry) {
  entry.status = 'running';
  entry.startedAt = new Date().toISOString();
  runningCount[entry.lane] += 1;
  if (entry.exclusive) repoLocks.set(entry.repo, entry.key);

  const ctx = {
    entry,
    waiters: entry.waiters,
    /** Terminal failure before a child could even be spawned. */
    fail(payload) {
      const message = (payload && payload.message) || 'failed';
      for (const res of entry.waiters) {
        writeSse(res, 'error', { message });
        writeSse(res, 'result', { status: 'failed', ...payload });
        writeSse(res, 'done', { exitCode: null });
        if (!res.writableEnded) res.end();
      }
      entry.waiters.clear();
    },
  };

  let job = null;
  try {
    job = await entry.run(ctx);
  } catch (err) {
    ctx.fail({ message: err.message, ...entry.meta });
  }

  if (!job) {
    settle(entry, null, 'failed');
    return;
  }

  entry.job = job;
  for (const res of entry.waiters) jobs.subscribe(job, res);
  entry.waiters.clear();
  jobs.whenSettled(job, (j) => {
    const status =
      (j.result && j.result.status) || (j.cancelled ? 'aborted' : j.exitCode === 0 ? 'success' : 'failed');
    settle(entry, j, status);
  });
}

/** Release an entry's resources, resolve dependents, and re-pump. */
function settle(entry, job, status) {
  if (entry.status === 'done' || entry.status === 'cancelled') return;
  entry.status = 'done';
  runningCount[entry.lane] = Math.max(0, runningCount[entry.lane] - 1);
  if (entry.exclusive && repoLocks.get(entry.repo) === entry.key) repoLocks.delete(entry.repo);
  entries.delete(entry.key);

  if (entry.onSettled) {
    try {
      entry.onSettled(status, job);
    } catch {
      /* never let a reporting hook break the scheduler */
    }
  }

  // A queued entry that depended on this one is only meaningful if we
  // succeeded — e.g. deploying a PR that was never created makes no sense.
  if (status !== 'success') {
    for (const dep of dependentsOf(entry.key)) {
      cancel(dep.key, `cancelled because ${entry.label} ended with "${status}"`, { cause: status });
    }
  }

  pump();
}

function dependentsOf(key) {
  const out = [];
  for (const lane of LANES) {
    for (const e of pending[lane]) if (e.dependsOn.includes(key)) out.push(e);
  }
  return out;
}

/**
 * Submit an action. If a slot (and the repo lock) is free it starts right away;
 * otherwise it's queued and `res` gets `event: queued` updates until it does.
 *
 * @param {object} opts
 *   key         unique action key (same namespace as jobs.js keys)
 *   lane        'chat' | 'task'
 *   repo        repo name (for the working-tree lock / display)
 *   exclusive   true if it checks out a branch on the repo's shared worktree
 *   dependsOn   [key] — cancelled if any of them ends non-success
 *   label       human-readable description (used in queue/notification text)
 *   meta        extra fields merged into the `queued` SSE payload
 *   run(ctx)    async; spawns and returns the job (or null after ctx.fail())
 *   onCancelled(reason) called if the entry is dropped before it ever ran
 *   onSettled(status, job) called when a started entry finishes
 *   res         SSE response to attach (optional)
 * @returns {{status:'attached'|'running'|'queued', entry:Entry}}
 */
function submit(opts) {
  const existing = entries.get(opts.key);
  if (existing) {
    // Same action submitted twice (double tap / reconnect): just attach.
    if (existing.status === 'running' && existing.job) {
      if (opts.res) jobs.subscribe(existing.job, opts.res);
    } else {
      addWaiter(existing, opts.res);
      notifyQueued(existing);
    }
    return { status: 'attached', entry: existing };
  }

  const entry = new Entry(opts);
  entries.set(entry.key, entry);
  addWaiter(entry, opts.res);
  pending[entry.lane].push(entry);

  if (canStart(entry)) {
    pump();
    return { status: 'running', entry };
  }
  notifyQueued(entry);
  pump(); // may still start something else; keeps positions fresh
  return { status: entry.status === 'queued' ? 'queued' : 'running', entry };
}

/**
 * Drop a *queued* entry (running ones must be killed via jobs.cancelJob).
 * Waiters are told, dependents are cancelled transitively.
 */
function cancel(key, reason, extra = {}) {
  const entry = entries.get(key);
  if (!entry || entry.status !== 'queued') return false;
  const idx = pending[entry.lane].indexOf(entry);
  if (idx !== -1) pending[entry.lane].splice(idx, 1);
  entry.status = 'cancelled';
  entries.delete(key);

  for (const res of entry.waiters) {
    writeSse(res, 'error', { message: reason });
    writeSse(res, 'result', { status: 'cancelled', message: reason, ...entry.meta, ...extra });
    writeSse(res, 'done', { exitCode: null });
    if (!res.writableEnded) res.end();
  }
  entry.waiters.clear();

  if (entry.onCancelled) {
    try {
      entry.onCancelled(reason);
    } catch {
      /* ignore */
    }
  }

  for (const dep of dependentsOf(key)) {
    cancel(dep.key, `cancelled because ${entry.label} was cancelled`, { cause: 'cancelled' });
  }
  pump();
  return true;
}

/**
 * Attach an SSE response to an already-submitted action (duplicate tap, or a
 * client reconnecting while the action is still waiting). Returns false if the
 * key isn't in the queue at all, so the caller can fall back.
 */
function attach(key, res) {
  const entry = entries.get(key);
  if (!entry) return false;
  if (entry.status === 'running' && entry.job) {
    jobs.subscribe(entry.job, res);
    return true;
  }
  addWaiter(entry, res);
  notifyQueued(entry);
  return true;
}

/** True if this action is queued or running (i.e. still "live" to the UI). */
function has(key) {
  return entries.has(key);
}

function get(key) {
  return entries.get(key) || null;
}

/** True only while the action is still WAITING (not yet spawned). */
function isQueued(key) {
  const e = entries.get(key);
  return Boolean(e && e.status === 'queued');
}

function describe(entry) {
  return {
    id: entry.id,
    key: entry.key,
    lane: entry.lane,
    repo: entry.repo,
    label: entry.label,
    exclusive: entry.exclusive,
    dependsOn: entry.dependsOn,
    status: entry.status,
    position: positionOf(entry),
    reason: entry.status === 'queued' ? waitReason(entry) : null,
    enqueuedAt: entry.enqueuedAt,
    startedAt: entry.startedAt,
    ...entry.meta,
  };
}

/** Full picture for the UI's queue panel. */
function snapshot() {
  const running = [];
  const waiting = [];
  for (const entry of entries.values()) {
    (entry.status === 'running' ? running : waiting).push(describe(entry));
  }
  waiting.sort((a, b) => a.lane.localeCompare(b.lane) || a.position - b.position);
  return {
    limits: { ...LANE_LIMITS, total: LANE_LIMITS.chat + LANE_LIMITS.task },
    running,
    queued: waiting,
    counts: { ...runningCount },
    repoLocks: Object.fromEntries(repoLocks),
  };
}

module.exports = { submit, attach, cancel, has, get, isQueued, snapshot, LANE_LIMITS };
