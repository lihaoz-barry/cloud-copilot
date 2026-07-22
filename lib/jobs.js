'use strict';

/**
 * Job manager — decouples long-running copilot runs from the (fragile) mobile
 * HTTP connection.
 *
 * A "job" is one `copilot -p ...` invocation for a given repo/issue/action. The
 * child process is owned by the job, NOT by the HTTP response that started it.
 * Browsers (SSE subscribers) can come and go — closing a browser tab or a phone
 * locking its screen only *unsubscribes*; the job keeps running server-side and
 * persists its result. Phones can reconnect and replay the transcript.
 *
 * This fixes the "job dies the moment the phone connection drops" bug.
 */

const { spawn } = require('child_process');

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');
const RESUME_RE = /--resume=([0-9a-fA-F-]{8,})/;

const HEARTBEAT_MS = 15000; // keep idle mobile/proxy connections alive
const RETAIN_MS = 15 * 60 * 1000; // keep finished jobs subscribable for 15 min

/** @type {Map<string, Job>} */
const jobs = new Map();

class Job {
  constructor(key, { bin, args, cwd, meta }) {
    this.key = key;
    this.bin = bin;
    this.args = args;
    this.cwd = cwd;
    this.meta = meta || {};
    this.conversation = '';
    this.sessionId = null;
    this.status = 'running'; // running | done
    this.exitCode = null;
    this.result = null; // action-specific payload broadcast at the end
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    /** @type {Set<import('http').ServerResponse>} */
    this.subscribers = new Set();
    this.child = null;
    this._heartbeat = null;
    this._reapTimer = null;
  }

  _writeTo(res, event, data) {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* subscriber gone; will be cleaned up on its own close */
    }
  }

  broadcast(event, data) {
    for (const res of this.subscribers) this._writeTo(res, event, data);
  }

  _startHeartbeat() {
    this._heartbeat = setInterval(() => {
      for (const res of this.subscribers) {
        if (!res.writableEnded) {
          try {
            res.write(`: ping ${Date.now()}\n\n`);
          } catch {
            /* ignore */
          }
        }
      }
    }, HEARTBEAT_MS);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }
}

/**
 * Start a new job. Throws if a running job already exists for this key.
 * @param {string} key
 * @param {object} opts { bin, args, cwd, meta, onSession, onDone }
 *   onSession(id): called once when a --resume id appears
 *   onDone(job): async; compute success + persist; return a result payload object
 * @returns {Job}
 */
function startJob(key, { bin, args, cwd, meta, onSession, onDone }) {
  const existing = jobs.get(key);
  if (existing && existing.status === 'running') {
    throw new Error('job already running');
  }

  const job = new Job(key, { bin, args, cwd, meta });
  jobs.set(key, job);
  job._startHeartbeat();

  let child;
  try {
    child = spawn(bin, args, { cwd, env: process.env });
  } catch (err) {
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    job.conversation += `\n[spawn error] ${err.message}\n`;
    job.broadcast('error', { message: `Failed to spawn "${bin}": ${err.message}` });
    job.broadcast('done', { exitCode: null });
    scheduleReap(job);
    return job;
  }
  job.child = child;

  const onChunk = (streamName) => (buf) => {
    const text = stripAnsi(buf.toString('utf8'));
    job.conversation += text;
    if (!job.sessionId) {
      const m = text.match(RESUME_RE);
      if (m) {
        job.sessionId = m[1];
        if (onSession) onSession(job.sessionId);
        job.broadcast('session', { sessionId: job.sessionId });
      }
    }
    job.broadcast('chunk', { stream: streamName, text });
  };

  child.stdout.on('data', onChunk('stdout'));
  child.stderr.on('data', onChunk('stderr'));

  child.on('error', (err) => {
    job.conversation += `\n[process error] ${err.message}\n`;
    job.broadcast('error', { message: err.message });
  });

  child.on('close', async (code) => {
    job.exitCode = code;
    let payload = { exitCode: code };
    try {
      if (onDone) {
        const extra = await onDone(job);
        if (extra) payload = { ...extra, exitCode: code };
      }
    } catch (err) {
      payload = { ...payload, error: err.message };
    }
    job.result = payload;
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    if (job._heartbeat) clearInterval(job._heartbeat);
    job.broadcast('result', payload);
    job.broadcast('done', { exitCode: code });
    // Close all attached streams so clients' readers complete cleanly.
    for (const res of job.subscribers) {
      if (!res.writableEnded) {
        try { res.end(); } catch { /* ignore */ }
      }
    }
    job.subscribers.clear();
    scheduleReap(job);
  });

  return job;
}

// Remove a finished job from memory after a retention window.
function scheduleReap(job) {
  job._reapTimer = setTimeout(() => {
    if (jobs.get(job.key) === job) jobs.delete(job.key);
  }, RETAIN_MS);
  if (job._reapTimer.unref) job._reapTimer.unref();
}

/**
 * Attach an SSE response to a job: replay history, then stream live updates.
 * If the job is already finished, replay everything + the final result/done.
 * Closing the response only unsubscribes — it NEVER kills the child.
 */
function subscribe(job, res) {
  // Replay so a reconnecting phone sees the full picture.
  job._writeTo(res, 'meta', {
    bin: job.bin,
    args: job.args,
    cwd: job.cwd,
    ...job.meta,
    replay: true,
    status: job.status,
  });
  if (job.conversation) {
    job._writeTo(res, 'chunk', { stream: 'stdout', text: job.conversation });
  }
  if (job.sessionId) job._writeTo(res, 'session', { sessionId: job.sessionId });

  if (job.status === 'done') {
    if (job.result) job._writeTo(res, 'result', job.result);
    job._writeTo(res, 'done', { exitCode: job.exitCode });
    // Fully replayed — close the stream so the client's reader completes.
    if (!res.writableEnded) res.end();
    return false;
  }

  job.subscribers.add(res);
  res.on('close', () => {
    job.subscribers.delete(res);
    // NOTE: intentionally NOT killing job.child here — the job outlives the
    // browser connection. This is the core fix.
  });
  return true;
}

function getJob(key) {
  return jobs.get(key);
}

/** Keys of all currently-running jobs. */
function runningKeys() {
  const out = [];
  for (const [k, j] of jobs) if (j.status === 'running') out.push(k);
  return out;
}

/** Explicit cancel (only way to kill a running job). */
function cancelJob(key) {
  const job = jobs.get(key);
  if (job && job.child && job.status === 'running' && !job.child.killed) {
    job.child.kill('SIGTERM');
    return true;
  }
  return false;
}

module.exports = { startJob, subscribe, getJob, runningKeys, cancelJob };
