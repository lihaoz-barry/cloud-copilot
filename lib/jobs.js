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
const notifier = require('./notifier');

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');
const RESUME_RE = /--resume=([0-9a-fA-F-]{8,})/;

const HEARTBEAT_MS = 15000; // keep idle mobile/proxy connections alive
const RETAIN_MS = 15 * 60 * 1000; // keep finished jobs subscribable for 15 min
const PROGRESS_THROTTLE_MS = 1500; // min gap between durable progress flushes

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
    this.phase = (meta && meta.phase) || null; // current phase of a multi-phase job
    this.cancelled = false; // set when explicitly aborted
    this.exitCode = null;
    this.result = null; // action-specific payload broadcast at the end
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    /** @type {Set<import('http').ServerResponse>} */
    this.subscribers = new Set();
    this.child = null;
    this._heartbeat = null;
    this._reapTimer = null;
    this._lastProgressAt = 0;
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
 * @param {object} opts { bin, args, cwd, meta, onSession, onDone, onProgress, nextPhase }
 *   onSession(id): called once when a --resume id appears
 *   onDone(job): async; compute success + persist; return a result payload object
 *   onProgress(job): best-effort, throttled (~1.5s); called as chunks stream in
 *     so callers can durably buffer the in-flight transcript before completion
 *   nextPhase(job, exitCode): async; return `{ bin, args, cwd, phase }` to run a
 *     SECOND child under this same job, or null/undefined to finish now. Applies
 *     to the FIRST phase only — chain further phases by giving the returned spec
 *     its own `nextPhase`. See the multi-phase note on spawnPhase below.
 * @returns {Job}
 */
function startJob(key, { bin, args, cwd, meta, onSession, onDone, onProgress, nextPhase }) {
  const existing = jobs.get(key);
  if (existing && existing.status === 'running') {
    throw new Error('job already running');
  }

  const job = new Job(key, { bin, args, cwd, meta });
  jobs.set(key, job);
  job._startHeartbeat();

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
    // Throttled progress flush — lets callers durably buffer the transcript
    // as it streams in, instead of only at job completion. Guards against
    // losing an in-flight turn if the parent process dies before `close`
    // fires (e.g. a self-triggered restart mid-turn).
    if (onProgress) {
      const now = Date.now();
      if (now - job._lastProgressAt >= PROGRESS_THROTTLE_MS) {
        job._lastProgressAt = now;
        try {
          onProgress(job);
        } catch {
          /* best-effort persistence; never let it break the stream */
        }
      }
    }
  };

  const finish = async (code) => {
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
    // Task-aware push (issue #27) — fire-and-forget, never affects the job.
    notifier.jobFinished(job);
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
  };

  // Spawn one phase of the job and wire its streams. A job is usually a single
  // phase, but `nextPhase` lets it run several children back-to-back under ONE
  // key — e.g. Deploy runs a "salvage the dirty working tree" Copilot session
  // first, then the deploy itself. Subscribers, the transcript and the abort
  // handle all carry across phases, so the browser sees one continuous log and
  // one final `done` instead of a stream that ends mid-pipeline.
  const spawnPhase = (spec) => {
    let child;
    try {
      // detached:true puts the child in its own process group so we can later
      // signal the WHOLE tree (copilot + fastlane + xcodebuild) on abort.
      // CLOUD_COPILOT_JOB marks the child as "already accounted for" so the
      // Copilot CLI's own sessionEnd ntfy hook stays quiet — this job manager
      // sends a far more specific push of its own (see lib/notifier.js).
      child = spawn(spec.bin, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, CLOUD_COPILOT_JOB: '1' },
        detached: true,
      });
    } catch (err) {
      job.conversation += `\n[spawn error] ${err.message}\n`;
      job.broadcast('error', { message: `Failed to spawn "${spec.bin}": ${err.message}` });
      finish(null);
      return;
    }
    job.child = child;

    child.stdout.on('data', onChunk('stdout'));
    child.stderr.on('data', onChunk('stderr'));

    child.on('error', (err) => {
      job.conversation += `\n[process error] ${err.message}\n`;
      job.broadcast('error', { message: err.message });
    });

    child.on('close', async (code) => {
      // Each phase carries its OWN successor: `spec.nextPhase` is consumed by
      // the phase it was attached to, never inherited by the phase it returns.
      // (Re-running the initial callback after every phase would re-enter the
      // last one forever — a deploy that redeploys itself in a loop.) A phase
      // that returns a spec without `nextPhase` is therefore terminal.
      //
      // A cancelled job also stops here — never advance to the next phase, or
      // an abort mid-salvage would go on to deploy anyway.
      if (spec.nextPhase && !job.cancelled) {
        let next;
        try {
          next = await spec.nextPhase(job, code);
        } catch (err) {
          job.conversation += `\n[phase error] ${err.message}\n`;
          job.broadcast('error', { message: err.message });
          return finish(code);
        }
        // `nextPhase` is async and can run for a long time (fetch, checkout,
        // a changelog translation hop), so re-check: an abort that lands in
        // that window has no live child to kill and would otherwise be
        // silently overtaken by the phase it was meant to prevent.
        if (next && !job.cancelled) {
          job.phase = next.phase || null;
          job.bin = next.bin;
          job.args = next.args;
          job.cwd = next.cwd;
          job.broadcast('phase', { phase: job.phase, bin: next.bin, args: next.args, cwd: next.cwd });
          return spawnPhase(next);
        }
      }
      return finish(code);
    });
  };

  spawnPhase({ bin, args, cwd, phase: meta && meta.phase, nextPhase });

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
    phase: job.phase,
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
    job.cancelled = true;
    const pid = job.child.pid;
    // Kill the whole process group so fastlane/xcodebuild children die too.
    const killGroup = (sig) => {
      try {
        process.kill(-pid, sig);
      } catch {
        try { job.child.kill(sig); } catch { /* already gone */ }
      }
    };
    killGroup('SIGTERM');
    // Escalate to SIGKILL if it hasn't exited shortly after.
    const t = setTimeout(() => {
      if (job.status === 'running') killGroup('SIGKILL');
    }, 5000);
    if (t.unref) t.unref();
    return true;
  }
  return false;
}

/**
 * Append a server-side note to a job's transcript and stream it to subscribers.
 * Used to label the phases of a multi-phase job ("salvaging local changes…",
 * "working tree clean, deploying…") so the log reads as one narrative rather
 * than two child processes' output butted together.
 */
function note(job, text) {
  if (!job) return;
  job.conversation += text;
  job.broadcast('chunk', { stream: 'stderr', text });
}

module.exports = { startJob, subscribe, getJob, runningKeys, cancelJob, note };
