'use strict';

/**
 * Action queue — one triggered action session at a time, persisted to disk.
 *
 * Create PR / Deploy / Merge each spawn a long-running `copilot`/fastlane/`gh`
 * session that owns the machine (and, for the first two, a repo's single shared
 * working tree). Historically a second click while one was running was simply
 * rejected with a "Blocked: ..." message. Instead of rejecting, we now put the
 * request in a FIFO queue and run it as soon as the current one finishes.
 *
 * Design notes
 * - **Global, single-slot.** Exactly one queued action runs at a time across
 *   every repo. That is deliberately stricter than the old per-repo
 *   working-tree lock (which stays in place as a safety net) — these sessions
 *   are heavy and the machine only has one Xcode/fastlane/keychain anyway.
 * - **File-persisted**, following the `lib/store.js` pattern: a single JSON
 *   file under `data/`, rewritten atomically. The queue therefore survives a
 *   server restart.
 * - **Restart-safe.** Job state lives in memory (`lib/jobs.js`), so after a
 *   restart nothing is running. On boot we drop entries that were mid-flight
 *   (their child process died with the old process — re-running them blindly
 *   could duplicate a PR) and resume the queue from the front.
 * - The queue never owns *how* a task runs: `init({ runner })` supplies a
 *   callback that turns a persisted entry back into a real job. That keeps all
 *   the copilot/gh specifics in server.js and makes this module testable.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');

const TICK_MS = 1000; // how often we re-check whether the running task is done

/** @type {Array<object>} FIFO — index 0 is the front of the line. */
let entries = [];

let runner = null; // async (entry) => job | null
let isRunning = null; // (key) => boolean
let canStart = null; // optional (entry) => boolean — external readiness gate
let onEvent = null; // optional (type, entry) => void, for logging
let ticker = null;
let chain = Promise.resolve();
let started = false;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Runtime-only fields (the live job handle) never hit disk.
function persistable(e) {
  const { job, ...rest } = e;
  return rest;
}

function save() {
  ensureDir();
  const tmp = `${QUEUE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: entries.map(persistable) }, null, 2));
  fs.renameSync(tmp, QUEUE_FILE); // atomic on the same filesystem
}

function load() {
  ensureDir();
  try {
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Entry helpers
// ---------------------------------------------------------------------------

const ACTION_LABEL = { work: 'Create PR', deploy: 'Deploy', merge: 'Merge' };

function describe(spec) {
  const action = ACTION_LABEL[spec.action] || spec.action;
  const target = spec.prNumber ? `PR #${spec.prNumber}` : `issue #${spec.issueNumber}`;
  return `${action} · ${spec.repo} ${target}`;
}

/** Public view of an entry: no live job handle, plus its 1-based position. */
function publicEntry(e, i) {
  return {
    id: e.id,
    key: e.key,
    repo: e.repo,
    issueNumber: e.issueNumber,
    action: e.action,
    prNumber: e.prNumber ?? null,
    label: e.label,
    status: e.status,
    position: i + 1,
    enqueuedAt: e.enqueuedAt,
    startedAt: e.startedAt || null,
    error: e.error || null,
  };
}

function emit(type, entry) {
  if (onEvent) {
    try {
      onEvent(type, entry);
    } catch {
      /* logging must never break the queue */
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const runningEntry = () => entries.find((e) => e.status === 'running') || null;

// Serialize pumps: only one may be launching a task at any moment, otherwise
// two concurrent submits could both grab the free slot.
function pump() {
  chain = chain.then(_pump, _pump);
  return chain;
}

async function _pump() {
  const current = runningEntry();
  if (current) {
    // Still occupied? Nothing to do. `isRunning` is the authority — it reflects
    // the actual child process, so a job that died (or a server that restarted)
    // never wedges the queue.
    if (isRunning && isRunning(current.key)) return;
    entries = entries.filter((e) => e !== current);
    save();
    emit('finished', current);
  }

  const next = entries.find((e) => e.status === 'waiting');
  if (!next) return;

  // External gate: something outside the queue (a PR/PreIssue chat turn) may
  // still hold this repo's working tree. Stay put and retry on the next tick
  // rather than starting a run that would collide with it.
  if (canStart && !canStart(next)) return;

  next.status = 'running';
  next.startedAt = new Date().toISOString();
  save();
  emit('started', next);

  try {
    next.job = (await runner(next)) || null;
  } catch (err) {
    // The launcher itself failed (bad repo, unresolvable branch, ...). It is
    // responsible for recording that failure; the queue just moves on.
    next.error = err && err.message;
    entries = entries.filter((e) => e !== next);
    save();
    emit('failed-to-start', next);
    return _pump();
  }

  // If the task finished (or never really started) synchronously, the next tick
  // notices via isRunning() and advances the queue.
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (runningEntry() || entries.length) pump();
  }, TICK_MS);
  if (ticker.unref) ticker.unref();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 *   runner(entry) -> Promise<job|null>   actually start the task
 *   isRunning(key) -> boolean            is that task's job still alive?
 *   canStart(entry) -> boolean           optional readiness gate (e.g. the
 *                                        repo's working tree is free)
 *   onEvent(type, entry)                 optional hook for logging
 */
function init(opts) {
  runner = opts.runner;
  isRunning = opts.isRunning;
  canStart = opts.canStart || null;
  onEvent = opts.onEvent || null;

  // Resume across restarts: entries that were mid-flight lost their child
  // process when the old server exited, so they can't be attached to and must
  // not be silently re-run (that could open a second PR). Drop them, keep the
  // waiting ones, and start executing from the front again.
  const loaded = load();
  const stale = loaded.filter((e) => e.status === 'running');
  entries = loaded.filter((e) => e.status === 'waiting');
  for (const e of stale) emit('dropped-on-restart', e);
  if (stale.length) save();

  started = true;
  startTicker();
  pump();
  return { resumed: entries.length, dropped: stale.length };
}

/**
 * Enqueue a task, starting it immediately when the queue is idle.
 * Re-submitting a key that is already queued/running returns the existing
 * entry instead of duplicating it.
 *
 * @returns {Promise<{entry, started: boolean, job: object|null, position: number}>}
 *   `started === true` means the task is running now and `job` is its handle.
 */
async function submit(spec) {
  if (!started) throw new Error('queue not initialised');

  const existing = entries.find((e) => e.key === spec.key);
  if (existing) {
    return {
      entry: publicEntry(existing, entries.indexOf(existing)),
      started: existing.status === 'running',
      job: existing.job || null,
      position: entries.indexOf(existing) + 1,
    };
  }

  const entry = {
    id: `q_${crypto.randomBytes(6).toString('hex')}`,
    key: spec.key,
    repo: spec.repo,
    issueNumber: spec.issueNumber,
    action: spec.action,
    prNumber: spec.prNumber ?? null,
    params: spec.params || {},
    label: spec.label || describe(spec),
    status: 'waiting',
    enqueuedAt: new Date().toISOString(),
    startedAt: null,
    job: null,
  };
  entries.push(entry);
  save();
  emit('queued', entry);

  await pump();

  const idx = entries.indexOf(entry);
  return {
    entry: publicEntry(entry, idx),
    started: entry.status === 'running',
    job: entry.job || null,
    position: idx + 1,
  };
}

/** Everything currently queued: the running task first, then waiting ones. */
function list() {
  return entries.map(publicEntry);
}

/** The queue entry for a given job key, or null. */
function find(key) {
  const i = entries.findIndex((e) => e.key === key);
  return i === -1 ? null : publicEntry(entries[i], i);
}

/**
 * Cancel a *waiting* entry. A running one must be aborted through its own
 * action-specific cancel endpoint (which kills the actual child process).
 */
function cancel(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return { cancelled: false, reason: 'not found' };
  if (e.status === 'running') return { cancelled: false, reason: 'already running' };
  entries = entries.filter((x) => x !== e);
  save();
  emit('cancelled', e);
  return { cancelled: true, entry: publicEntry(e, 0) };
}

/** Drop every waiting entry for an issue (used when an issue is deleted). */
function removeIssue(repo, issueNumber) {
  const doomed = entries.filter(
    (e) => e.repo === repo && e.issueNumber === issueNumber && e.status === 'waiting',
  );
  if (!doomed.length) return 0;
  entries = entries.filter((e) => !doomed.includes(e));
  save();
  for (const e of doomed) emit('cancelled', e);
  return doomed.length;
}

/** Test hook: wipe in-memory + on-disk state. */
function _reset() {
  entries = [];
  started = false;
  canStart = null;
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
  try {
    fs.unlinkSync(QUEUE_FILE);
  } catch {
    /* nothing to remove */
  }
}

module.exports = { init, submit, list, find, cancel, removeIssue, describe, QUEUE_FILE, _reset };
