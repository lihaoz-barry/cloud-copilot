'use strict';

/**
 * Persistent FIFO queue for Create PR ("work") runs.
 *
 * Each work job gets its own git worktree, so several can run at once — but not
 * unboundedly: every run is a full Copilot CLI process, and a dozen of them
 * would melt the host. `MAX_CONCURRENT_WORK` (default 4) caps how many run
 * simultaneously; anything beyond that waits its turn instead of being
 * rejected.
 *
 * The queue is mirrored to `data/queue.json` (atomic write: tmp file + rename)
 * on every mutation, so a server restart doesn't lose pending work. Entries
 * that were *running* when the process died are dropped on load — their child
 * processes are gone with the old process and re-running them automatically
 * would be a surprise; queued entries resume normally.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');

const DEFAULT_MAX_CONCURRENT = 4;

class WorkQueue {
  /**
   * @param {object} opts
   *   file           path of the persisted queue file
   *   maxConcurrent  how many entries may be `running` at once
   *   start          async (item) => void — actually launches the job. Must
   *                  eventually call finish(item.id) (typically from the job's
   *                  onDone) whether it succeeds or fails.
   *   onChange       optional () => void, fired after every mutation
   */
  constructor({ file = QUEUE_FILE, maxConcurrent = DEFAULT_MAX_CONCURRENT, start = null, onChange = null } = {}) {
    this.file = file;
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || DEFAULT_MAX_CONCURRENT);
    this.start = start;
    this.onChange = onChange;
    /** @type {Array<object>} */
    this.items = [];
    /** Non-persisted SSE responses waiting on a queued entry. */
    this._waiters = new Map();
    this._seq = 0;
    this._pumping = false;
  }

  setStarter(fn) {
    this.start = fn;
  }

  // -- persistence ---------------------------------------------------------

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const items = Array.isArray(raw && raw.items) ? raw.items : [];
      // Anything mid-flight when we died is unrecoverable (its child process
      // belonged to the old process); keep only what never started.
      this.items = items
        .filter((i) => i && i.status === 'queued' && i.repo && Number.isFinite(Number(i.issueNumber)))
        .map((i) => ({
          id: String(i.id),
          repo: i.repo,
          issueNumber: Number(i.issueNumber),
          action: i.action || 'work',
          title: i.title || null,
          mode: i.mode || 'allow-all',
          enqueuedAt: i.enqueuedAt || new Date().toISOString(),
          status: 'queued',
        }));
      for (const i of this.items) {
        const m = /^q(\d+)$/.exec(i.id);
        if (m) this._seq = Math.max(this._seq, Number(m[1]));
      }
    } catch {
      this.items = [];
    }
    return this.items;
  }

  save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = {
        version: 1,
        maxConcurrent: this.maxConcurrent,
        updatedAt: new Date().toISOString(),
        items: this.items.map((i, idx) => ({ ...i, position: idx + 1 })),
      };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.file); // atomic on the same filesystem
    } catch {
      /* persistence is best-effort; never break a run over it */
    }
    if (this.onChange) {
      try {
        this.onChange();
      } catch {
        /* ignore */
      }
    }
  }

  // -- queries -------------------------------------------------------------

  find(id) {
    return this.items.find((i) => i.id === id) || null;
  }

  findTarget(repo, issueNumber, action = 'work') {
    return (
      this.items.find(
        (i) => i.repo === repo && i.issueNumber === Number(issueNumber) && i.action === action,
      ) || null
    );
  }

  runningCount() {
    return this.items.filter((i) => i.status === 'running').length;
  }

  /** Queued entries in FIFO order (position 1 = next to start). */
  queued() {
    return this.items.filter((i) => i.status === 'queued');
  }

  running() {
    return this.items.filter((i) => i.status === 'running');
  }

  /** 1-based place in line, or null when running/absent. */
  positionOf(id) {
    const idx = this.queued().findIndex((i) => i.id === id);
    return idx === -1 ? null : idx + 1;
  }

  /** Serializable view for the UI: running first, then the queue in order. */
  snapshot() {
    const running = this.running().map((i) => ({ ...i, position: null }));
    const queued = this.queued().map((i, idx) => ({ ...i, position: idx + 1 }));
    return {
      maxConcurrent: this.maxConcurrent,
      runningCount: running.length,
      queuedCount: queued.length,
      items: [...running, ...queued],
    };
  }

  // -- mutations -----------------------------------------------------------

  /**
   * Add a run to the back of the queue. Idempotent per (repo, issue, action):
   * re-posting for an entry that's already queued/running returns the existing
   * one, so a reconnecting browser never double-enqueues.
   */
  enqueue({ repo, issueNumber, action = 'work', title = null, mode = 'allow-all' }) {
    const existing = this.findTarget(repo, issueNumber, action);
    if (existing) return existing;
    const item = {
      id: `q${++this._seq}`,
      repo,
      issueNumber: Number(issueNumber),
      action,
      title,
      mode,
      enqueuedAt: new Date().toISOString(),
      status: 'queued',
    };
    this.items.push(item);
    this.save();
    return item;
  }

  /** Attach an SSE response that should be handed the job once it starts. */
  addWaiter(id, res) {
    if (!this._waiters.has(id)) this._waiters.set(id, new Set());
    const set = this._waiters.get(id);
    set.add(res);
    res.on('close', () => set.delete(res));
  }

  takeWaiters(id) {
    const set = this._waiters.get(id);
    this._waiters.delete(id);
    return set ? [...set].filter((r) => !r.writableEnded) : [];
  }

  /** Remove an entry (queued or running) without touching its child process. */
  remove(id) {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx === -1) return null;
    const [item] = this.items.splice(idx, 1);
    this.save();
    return item;
  }

  /** A run ended (success, failure or cancel) — free its slot. */
  finish(id) {
    const item = this.remove(id);
    this.pump();
    return item;
  }

  // -- scheduling ----------------------------------------------------------

  /**
   * Start queued entries until the concurrency cap is reached. Re-entrant-safe:
   * `finish()` calls it, and so does every enqueue.
   */
  async pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (this.runningCount() < this.maxConcurrent) {
        const next = this.queued()[0];
        if (!next) break;
        next.status = 'running';
        next.startedAt = new Date().toISOString();
        this.save();
        try {
          if (this.start) await this.start(next);
        } catch (err) {
          // The starter failed before the job existed, so nothing will ever
          // call finish() for it — drop it here and keep the line moving.
          next.error = err && err.message ? err.message : String(err);
          this.remove(next.id);
        }
      }
    } finally {
      this._pumping = false;
    }
  }
}

module.exports = { WorkQueue, QUEUE_FILE, DEFAULT_MAX_CONCURRENT };
