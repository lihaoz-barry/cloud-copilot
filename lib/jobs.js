'use strict';

/**
 * Job manager — the dashboard's view of work that it does not own.
 *
 * A "job" is one `copilot -p ...` invocation for a given repo/issue/action.
 * Two separate things used to make a job fragile, and both are fixed here:
 *
 *   1. it died with the HTTP request that started it — fixed long ago by
 *      keeping the child in this manager instead of in the response;
 *   2. it died with THIS PROCESS's memory — the bug this rewrite removes.
 *
 * (2) was the visible one: cloud-copilot restarts itself on every self-deploy,
 * and afterwards a task that was still running showed an empty log and a Stop
 * button that answered `404 no such running job`. The child was alive the whole
 * time; nothing remembered it.
 *
 * So the process now belongs to the supervisor on :8788 (lib/supervisor.js),
 * which persists its pid, process group and transcript to disk. This module
 * keeps exactly the parts that are about *this* server — the SSE subscribers,
 * the action-specific `onDone` that writes to state.json, the push
 * notification — and treats the child itself as somebody else's.
 *
 * Everything a caller sees is unchanged: `startJob` still returns synchronously
 * and `subscribe` still replays the transcript, so server.js needs no rewrite.
 * What is new is `adoptRunning()`, which reattaches to sessions that survived a
 * restart, and a local-spawn fallback for when no supervisor is reachable — a
 * degraded dashboard is much better than a dead one.
 */

const { spawn } = require('child_process');
const notifier = require('./notifier');
const supervisorClient = require('./supervisorClient');

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');
const RESUME_RE = /--resume=([0-9a-fA-F-]{8,})/;

const HEARTBEAT_MS = 15000; // keep idle mobile/proxy connections alive
const RETAIN_MS = 15 * 60 * 1000; // keep finished jobs subscribable for 15 min
const PROGRESS_THROTTLE_MS = 1500; // min gap between durable progress flushes

/** @type {Map<string, Job>} */
const jobs = new Map();

/**
 * Builds the callbacks for a session adopted after a restart. Set by server.js,
 * the only place that knows how to persist a result.
 * @type {null | ((session: object) => object)}
 */
let adoptHandler = null;

function setAdoptHandler(fn) {
  adoptHandler = fn;
}

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
    /** Supervised session id on :8788, or null while starting / unsupervised. */
    this.sessionRef = null;
    this.pid = null;
    this.supervised = false;
    this.child = null; // only set on the local-spawn fallback
    this._detach = null; // stops following the supervised log
    this._env = {};
    this._heartbeat = null;
    this._reapTimer = null;
    this._lastProgressAt = 0;
    this._replaying = false;
    this._pending = '';
    this._callbacks = {};
    this._nextPhase = null; // successor of the phase that is running right now
    this._sessionLog = ''; // what the CURRENT session has contributed so far
    this._logBase = 0; // where the current phase starts inside `conversation`
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

// ---------------------------------------------------------------------------
// Transcript plumbing, shared by the supervised and fallback paths
// ---------------------------------------------------------------------------

function noteSessionId(job, text) {
  if (job.sessionId) return;
  const m = text.match(RESUME_RE);
  if (!m) return;
  job.sessionId = m[1];
  if (job._callbacks.onSession) job._callbacks.onSession(job.sessionId);
  job.broadcast('session', { sessionId: job.sessionId });
}

/**
 * Append new transcript text and tell everyone who is listening.
 *
 * The throttled `onProgress` flush is what lets a turn survive a crash midway:
 * without it the transcript only reached disk at completion, so a self-inflicted
 * restart during a run left the record empty.
 *
 * A supervised child that cannot be started fails in the *supervisor's*
 * process, so the only trace reaching here is the marker it writes into the
 * log. Promoting it back to an `error` event keeps the browser's contract the
 * same on both paths: a phase that never ran says so, instead of ending as a
 * silent empty log with an exit code.
 */
const SPAWN_FAILURE_RE = /\[(?:spawn|process) error\] ([^\n]+)/g;

function appendTranscript(job, text) {
  if (!text) return;
  job.conversation += text;
  noteSessionId(job, text);
  job.broadcast('chunk', { stream: 'stdout', text });
  SPAWN_FAILURE_RE.lastIndex = 0;
  let failure;
  while ((failure = SPAWN_FAILURE_RE.exec(text))) {
    job.broadcast('error', { message: failure[1] });
  }
  if (job._callbacks.onProgress) {
    const now = Date.now();
    if (now - job._lastProgressAt >= PROGRESS_THROTTLE_MS) {
      job._lastProgressAt = now;
      try {
        job._callbacks.onProgress(job);
      } catch {
        /* best-effort persistence; never let it break the stream */
      }
    }
  }
}

/**
 * Reconcile a replayed transcript against what this job already holds.
 *
 * The supervisor replays the whole log on every connection, which is right for
 * a browser and wrong for a reconnecting server — appending it verbatim would
 * duplicate the transcript. The log is append-only, so a replay that starts
 * with what we have contributes only its tail; a shorter one means the
 * supervisor trimmed an old head and our copy is the better one.
 *
 * The comparison is against `_sessionLog` — what THIS session produced — not
 * against the whole transcript, because a multi-phase job's transcript also
 * holds earlier phases and the server-side notes between them. Rebuilding from
 * `conversation` would make every replay look like a mismatch and throw the
 * previous phase away.
 */
function absorbReplay(job) {
  const replayed = job._pending;
  job._replaying = false;
  job._pending = '';
  if (replayed.length <= job._sessionLog.length) return;
  if (replayed.startsWith(job._sessionLog)) {
    const tail = replayed.slice(job._sessionLog.length);
    job._sessionLog = replayed;
    appendTranscript(job, tail);
  } else {
    // Head trimmed by the supervisor: we cannot align, so this phase's slice of
    // the transcript is replaced wholesale. Anything from earlier phases sits
    // before `_logBase` and is kept.
    job.conversation = job.conversation.slice(0, job._logBase);
    job._sessionLog = replayed;
    appendTranscript(job, replayed);
  }
}

/**
 * Finish a job: compute the caller's result, persist it, notify, close streams.
 * Idempotent, because both a stream's `exit` event and a local child's `close`
 * event can plausibly arrive.
 */
async function finishJob(job, { exitCode = null, aborted = false, note = null } = {}) {
  if (job.status === 'done') return;
  job.status = 'done';
  if (aborted) job.cancelled = true;
  job.exitCode = exitCode;
  if (note) job.conversation += `\n[${note}]\n`;

  let payload = { exitCode };
  try {
    if (job._callbacks.onDone) {
      const extra = await job._callbacks.onDone(job);
      if (extra) payload = { ...extra, exitCode };
    }
  } catch (err) {
    payload = { ...payload, error: err.message };
  }
  job.result = payload;
  job.finishedAt = new Date().toISOString();
  if (job._heartbeat) clearInterval(job._heartbeat);
  if (job._detach) {
    job._detach();
    job._detach = null;
  }
  // Task-aware push (issue #27) — fire-and-forget, never affects the job.
  notifier.jobFinished(job);
  job.broadcast('result', payload);
  job.broadcast('done', { exitCode });
  for (const res of job.subscribers) {
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
  job.subscribers.clear();
  scheduleReap(job);
}

/** Follow a supervised session's log, for as long as it runs. */
function follow(job, sessionId) {
  job.sessionRef = sessionId;
  job.supervised = true;
  job._sessionLog = '';
  job._detach = supervisorClient.streamSession(sessionId, {
    onReplayStart: () => {
      job._replaying = true;
      job._pending = '';
    },
    onMeta: (m) => {
      if (m && m.pid) job.pid = m.pid;
      if (m && m.aborted) job.cancelled = true;
    },
    onChunk: (d) => {
      const text = d && d.text ? d.text : '';
      if (job._replaying) job._pending += text;
      else {
        job._sessionLog += text;
        appendTranscript(job, text);
      }
    },
    onSession: (d) => {
      if (!d || !d.sessionId || job.sessionId) return;
      job.sessionId = d.sessionId;
      if (job._callbacks.onSession) job._callbacks.onSession(job.sessionId);
      job.broadcast('session', { sessionId: job.sessionId });
    },
    onLive: () => absorbReplay(job),
    onExit: (d) => {
      // A session that ended between connecting and now never sends `live`;
      // drain its replay before deciding the job is over.
      if (job._replaying) absorbReplay(job);
      endPhase(job, {
        exitCode: d ? d.exitCode : null,
        aborted: Boolean(d && d.aborted),
        note: d && d.note ? d.note : null,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/**
 * The environment a supervised child needs from *this* process.
 *
 * The supervisor merges its own `process.env` underneath, but it may have been
 * started from a different shell (or by launchd), so the few variables that
 * decide whether `copilot` can even resolve its interpreter are passed
 * explicitly rather than assumed to match.
 */
function inheritedEnv() {
  const out = {};
  for (const k of ['PATH', 'HOME', 'SHELL', 'LANG', 'USER', 'TMPDIR', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    if (process.env[k]) out[k] = process.env[k];
  }
  return out;
}

/** Last-resort spawn inside this process — see the module comment. */
function startLocal(job) {
  let child;
  try {
    child = spawn(job.bin, job.args, {
      cwd: job.cwd,
      env: { ...process.env, CLOUD_COPILOT_JOB: '1', ...job._env },
      detached: true,
    });
  } catch (err) {
    job.conversation += `\n[spawn error] ${err.message}\n`;
    job.broadcast('error', { message: `Failed to spawn "${job.bin}": ${err.message}` });
    finishJob(job, { exitCode: null });
    return;
  }
  job.child = child;
  job.pid = child.pid;

  const onChunk = (streamName) => (buf) => {
    const text = stripAnsi(buf.toString('utf8'));
    job.conversation += text;
    noteSessionId(job, text);
    job.broadcast('chunk', { stream: streamName, text });
    if (job._callbacks.onProgress) {
      const now = Date.now();
      if (now - job._lastProgressAt >= PROGRESS_THROTTLE_MS) {
        job._lastProgressAt = now;
        try {
          job._callbacks.onProgress(job);
        } catch {
          /* ignore */
        }
      }
    }
  };
  child.stdout.on('data', onChunk('stdout'));
  child.stderr.on('data', onChunk('stderr'));
  child.on('error', (err) => {
    job.conversation += `\n[process error] ${err.message}\n`;
    job.broadcast('error', { message: err.message });
  });
  child.on('close', (code) => endPhase(job, { exitCode: code }));
}

/**
 * Run one phase of a job: ask the supervisor for a session, fall back to a
 * local spawn if it cannot be reached.
 *
 * A job is usually a single phase, but `nextPhase` lets it run several children
 * back-to-back under ONE key — e.g. Deploy runs a "salvage the dirty working
 * tree" Copilot session first, then the deploy itself. Subscribers, the
 * transcript and the abort handle all carry across phases, so the browser sees
 * one continuous log and one final `done` instead of a stream that ends
 * mid-pipeline. Each phase is a supervised session of its own, which is what
 * keeps a multi-phase deploy restart-proof: at most one of them is running at a
 * time, so the supervisor's one-session-per-key rule is never violated.
 */
function beginPhase(job, spec) {
  job.phase = spec.phase || null;
  // `listRunning()` and the supervisor's session record both read `meta`, so the
  // phase has to be updated there too or they keep reporting phase 1 forever.
  job.meta.phase = job.phase;
  job.bin = spec.bin;
  job.args = spec.args;
  job.cwd = spec.cwd;
  job._nextPhase = spec.nextPhase || null;
  // Everything the previous phase wrote is settled history now; the replay of
  // the session starting here must never reach back past this point.
  job._logBase = job.conversation.length;
  job._sessionLog = '';
  job.child = null;
  job.sessionRef = null;
  job.pid = null;

  supervisorClient
    .spawnSession({
      key: job.key,
      bin: spec.bin,
      args: spec.args,
      cwd: spec.cwd,
      env: { ...inheritedEnv(), ...job._env },
      meta: { ...job.meta, key: job.key, phase: job.phase, startedBy: 'dashboard' },
    })
    .then((out) => {
      const session = out && out.session;
      if (!session) throw new Error('the supervisor returned no session');
      follow(job, session.id);
      // An abort raised while the supervisor was still answering found no
      // `sessionRef` and no child, so `cancelJob` could only set the flag —
      // `abortByKey` had nothing to match yet. Honour it now that the session
      // exists, or the phase the abort was meant to prevent runs to completion.
      if (job.cancelled && job.status === 'running') {
        supervisorClient.abortSession(session.id).catch(() => {
          /* the exit path still reports the job as cancelled */
        });
      }
    })
    .catch((err) => {
      // The supervisor already holds a session under this key — almost always
      // this dashboard's own previous life. Attaching is exactly right: it is
      // the same work, and starting a second one would duplicate a PR.
      if (err.statusCode === 409 && err.body && err.body.session) {
        job.conversation += '\n[attached to the session already running under this key]\n';
        follow(job, err.body.session.id);
        return;
      }
      // An abort that landed while the supervisor was answering has nothing to
      // kill yet, so it can only be honoured here. Spawning locally anyway
      // would run the very phase the abort was meant to prevent.
      if (job.cancelled || job.status === 'done') {
        job.conversation += `\n[cancelled before ${job.phase || 'the process'} could start]\n`;
        finishJob(job, { exitCode: null, aborted: true });
        return;
      }
      console.warn(
        `[jobs] the supervisor on ${supervisorClient.BASE} could not start ${job.key}: ${err.message}` +
          ' — falling back to an unsupervised local process',
      );
      job.meta.unsupervised = true;
      const warning =
        `\n[warning] cloud-scheduler (${supervisorClient.BASE}) is unreachable: ${err.message}.\n` +
        '[warning] Running unsupervised — this task will be lost if the dashboard restarts.\n';
      job.conversation += warning;
      job.broadcast('chunk', { stream: 'stderr', text: warning });
      job._logBase = job.conversation.length;
      startLocal(job);
    });
}

/**
 * A phase's child has exited: either advance to its successor or finish.
 *
 * `_nextPhase` is consumed by the phase it was attached to and never inherited
 * by the phase it returns. (Re-running the initial callback after every phase
 * would re-enter the last one forever — a deploy that redeploys itself in a
 * loop.) A phase that returns a spec without `nextPhase` is therefore terminal.
 */
async function endPhase(job, { exitCode = null, aborted = false, note = null } = {}) {
  if (job.status === 'done') return;
  const next = job._nextPhase;
  job._nextPhase = null;

  // A cancelled or aborted job stops here — never advance to the next phase, or
  // an abort mid-salvage would go on to deploy anyway.
  if (next && !aborted && !job.cancelled) {
    let spec;
    try {
      spec = await next(job, exitCode);
    } catch (err) {
      job.conversation += `\n[phase error] ${err.message}\n`;
      job.broadcast('error', { message: err.message });
      return finishJob(job, { exitCode, aborted, note });
    }
    // `nextPhase` is async and can run for a long time (fetch, checkout, a
    // changelog translation hop), so re-check: an abort that lands in that
    // window has no live child to kill and would otherwise be silently
    // overtaken by the phase it was meant to prevent.
    if (spec && !job.cancelled && job.status === 'running') {
      if (job._detach) {
        job._detach();
        job._detach = null;
      }
      job.supervised = false;
      job.broadcast('phase', {
        phase: spec.phase || null,
        bin: spec.bin,
        args: spec.args,
        cwd: spec.cwd,
      });
      return beginPhase(job, spec);
    }
  }
  return finishJob(job, { exitCode, aborted, note });
}

/**
 * Start a new job. Throws if a running job already exists for this key.
 *
 * @param {string} key
 * @param {object} opts { bin, args, cwd, meta, env, onSession, onDone, onProgress, nextPhase }
 *   onSession(id): called once when a --resume id appears
 *   onDone(job): async; compute success + persist; return a result payload
 *   onProgress(job): best-effort, throttled (~1.5s), as chunks stream in
 *   nextPhase(job, exitCode): async; return `{ bin, args, cwd, phase }` to run a
 *     SECOND child under this same job/key, or null/undefined to finish now.
 *     Applies to the FIRST phase only — chain further phases by giving the
 *     returned spec its own `nextPhase`. See beginPhase/endPhase below.
 * @returns {Job}
 */
function startJob(key, { bin, args, cwd, meta, env, onSession, onDone, onProgress, nextPhase }) {
  const existing = jobs.get(key);
  if (existing && existing.status === 'running') {
    throw new Error('job already running');
  }

  const job = new Job(key, { bin, args, cwd, meta });
  job._callbacks = { onSession, onDone, onProgress };
  job._env = env || {};
  jobs.set(key, job);
  job._startHeartbeat();

  beginPhase(job, { bin, args, cwd, phase: (meta && meta.phase) || null, nextPhase });

  return job;
}

// Remove a finished job from memory after a retention window.
function scheduleReap(job) {
  job._reapTimer = setTimeout(() => {
    if (jobs.get(job.key) === job) jobs.delete(job.key);
  }, RETAIN_MS);
  if (job._reapTimer.unref) job._reapTimer.unref();
}

// ---------------------------------------------------------------------------
// Adoption — reattaching to work that outlived the previous dashboard process
// ---------------------------------------------------------------------------

/**
 * Rebuild a job for every supervised session that is still running.
 *
 * This is what turns a dashboard restart from "the task is gone" into "the task
 * is still there": the panel lists it again, its log streams again, and Stop
 * works again — because the supervisor never stopped knowing about it.
 *
 * @returns {Promise<{adopted:number, sessions:Array, error?:string}>}
 */
async function adoptRunning() {
  let sessions;
  try {
    ({ sessions } = await supervisorClient.listSessions());
  } catch (err) {
    return { adopted: 0, sessions: [], error: err.message };
  }
  const adopted = [];
  for (const session of sessions || []) {
    const key = session.key || (session.meta && session.meta.key);
    if (!key || session.status !== 'running') continue;
    const current = jobs.get(key);
    if (current && current.status === 'running') continue;

    const job = new Job(key, {
      bin: session.bin,
      args: session.args,
      cwd: session.cwd,
      meta: { ...(session.meta || {}), adopted: true },
    });
    job.startedAt = session.startedAt || job.startedAt;
    job.sessionId = session.sessionId || null;
    job._callbacks = (adoptHandler && adoptHandler(session)) || {};
    jobs.set(key, job);
    job._startHeartbeat();
    follow(job, session.id);
    adopted.push({ key, id: session.id, action: (session.meta || {}).action || null });
  }
  return { adopted: adopted.length, sessions: adopted };
}

// ---------------------------------------------------------------------------
// Reading + stopping
// ---------------------------------------------------------------------------

/**
 * Attach an SSE response to a job: replay history, then stream live updates.
 * If the job is already finished, replay everything + the final result/done.
 * Closing the response only unsubscribes — it NEVER kills the child.
 */
function subscribe(job, res) {
  job._writeTo(res, 'meta', {
    bin: job.bin,
    args: job.args,
    cwd: job.cwd,
    ...job.meta,
    phase: job.phase,
    replay: true,
    status: job.status,
    sessionRef: job.sessionRef,
  });
  if (job.conversation) {
    job._writeTo(res, 'chunk', { stream: 'stdout', text: job.conversation });
  }
  if (job.sessionId) job._writeTo(res, 'session', { sessionId: job.sessionId });

  if (job.status === 'done') {
    if (job.result) job._writeTo(res, 'result', job.result);
    job._writeTo(res, 'done', { exitCode: job.exitCode });
    if (!res.writableEnded) res.end();
    return false;
  }

  job.subscribers.add(res);
  res.on('close', () => {
    job.subscribers.delete(res);
    // NOTE: intentionally NOT killing the process here — the job outlives the
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

/**
 * Every running job as a plain object, for the home page's running-task panel.
 * Deliberately excludes the transcript — the panel only needs to say what is
 * running, for how long, and where.
 */
function listRunning() {
  const out = [];
  for (const [k, j] of jobs) {
    if (j.status !== 'running') continue;
    out.push({
      key: k,
      startedAt: j.startedAt,
      elapsedMs: Date.now() - new Date(j.startedAt).getTime(),
      sessionId: j.sessionId,
      sessionRef: j.sessionRef,
      supervised: j.supervised,
      pid: j.pid,
      cwd: j.cwd,
      subscribers: j.subscribers.size,
      ...j.meta,
    });
  }
  out.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  return out;
}

/**
 * Explicit cancel — the only way to kill a running job.
 *
 * Returns true as soon as the stop has been *requested*, since for a supervised
 * session the kill happens in another process. The UI learns it worked from the
 * job disappearing, which is the same signal it always used.
 */
function cancelJob(key) {
  const job = jobs.get(key);
  if (!job || job.status !== 'running') {
    // No local record: the dashboard may have restarted before adopting, so ask
    // the supervisor directly rather than answering "no such job" about a
    // process that is very much alive.
    supervisorClient.abortByKey(key).catch(() => {});
    return false;
  }
  job.cancelled = true;
  if (job.sessionRef) {
    supervisorClient.abortSession(job.sessionRef).catch((err) => {
      console.warn(`[jobs] could not abort ${key} via the supervisor: ${err.message}`);
    });
    return true;
  }
  if (job.child && !job.child.killed) {
    const pid = job.child.pid;
    // Kill the whole process group so fastlane/xcodebuild children die too.
    const killGroup = (sig) => {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          job.child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    killGroup('SIGTERM');
    const t = setTimeout(() => {
      if (job.status === 'running') killGroup('SIGKILL');
    }, 5000);
    if (t.unref) t.unref();
    return true;
  }
  // Started, but the supervisor has not answered yet: ask by key so the kill
  // lands whenever the session appears.
  supervisorClient.abortByKey(key).catch(() => {});
  return true;
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
  // A note written before the phase's own session has said anything (the deploy
  // preflight's banner) is part of the settled prologue, not of the session's
  // log — otherwise a supervisor replay that has to rebuild the phase's slice
  // of the transcript would wipe it.
  if (!job._sessionLog) job._logBase = job.conversation.length;
  job.broadcast('chunk', { stream: 'stderr', text });
}

/**
 * Only what the CURRENT phase produced, i.e. `conversation` minus every earlier
 * phase and the notes between them.
 *
 * Callers that decide an outcome by *reading* the transcript must use this
 * rather than `job.conversation`: the deploy's verdict comes from matching
 * fastlane's completion lines, and a salvage session's own prose ("finished
 * successfully…") sits in the same transcript, which would mark a failed
 * upload as a shipped build. Single-phase jobs get the whole log, as before.
 */
function phaseLog(job) {
  if (!job) return '';
  return job.conversation.slice(job._logBase);
}

module.exports = {
  startJob,
  subscribe,
  getJob,
  runningKeys,
  listRunning,
  cancelJob,
  note,
  phaseLog,
  adoptRunning,
  setAdoptHandler,
};
