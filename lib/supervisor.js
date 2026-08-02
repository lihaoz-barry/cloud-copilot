'use strict';

/**
 * Session supervisor — the part of cloud-copilot that owns processes.
 *
 * Every `copilot -p ...` invocation used to be spawned by, and remembered only
 * inside, the dashboard server on :8787. That coupling produced the bug this
 * module exists to remove: restarting the dashboard (which cloud-copilot does
 * to itself on every self-deploy) threw away the in-memory job table while the
 * detached children kept running. The browser then showed a task stuck at
 * "Deploying…" with an empty log, and its Stop button answered
 * `404 no such running job` — the process was alive, but nothing owned it any
 * more.
 *
 * So the supervisor keeps its truth in two places that both survive a restart:
 *
 *   data/sessions/index.json   one record per session, rewritten atomically
 *   data/sessions/<id>.log     the child's own stdout/stderr
 *
 * The log file is the child's actual file descriptor, not a copy: sessions are
 * spawned with `stdio: ['ignore', fd, fd]`, so the transcript keeps being
 * written by the child itself even while no supervisor is running. Live viewers
 * are served by tailing that file. A pipe would have been simpler but is
 * exactly wrong here — when the reader dies the writer gets EPIPE, i.e. killing
 * the supervisor would kill the work it is supposed to outlive.
 *
 * `detached: true` puts each child in its own process group, which is what
 * makes abort both simple and complete: one `kill(-pgid)` takes down copilot
 * and everything it started (fastlane, xcodebuild, node, git). Because the pgid
 * is persisted, abort works after a supervisor restart too — no handle needed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DATA_DIR = process.env.CC_DATA_DIR || path.join(__dirname, '..', 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const INDEX_FILE = path.join(SESSIONS_DIR, 'index.json');

// How often the tailer looks for new bytes / dead pids. Fast enough that a log
// feels live, slow enough that a dozen sessions cost nothing.
const TICK_MS = Number(process.env.CC_SUPERVISOR_TICK_MS || 400);
// Finished sessions stay listed (and their logs on disk) this long, so a task
// that ended while the dashboard was down can still be read afterwards.
const RETAIN_MS = Number(process.env.CC_SUPERVISOR_RETAIN_MS || 7 * 24 * 60 * 60 * 1000);
// Bytes of a log replayed to a new subscriber. A long deploy can produce
// megabytes; sending all of it to a phone is not a kindness.
const REPLAY_TAIL_BYTES = Number(process.env.CC_SUPERVISOR_REPLAY_BYTES || 512 * 1024);
const SIGKILL_AFTER_MS = 5000;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');
const RESUME_RE = /--resume=([0-9a-fA-F-]{8,})/;

/** id -> session record (the persisted shape plus runtime-only fields). */
const sessions = new Map();
/** id -> Set<ServerResponse> of live log subscribers. */
const subscribers = new Map();
/** Listeners for lifecycle events, used by the scheduler in the same process. */
const listeners = new Set();

let tickTimer = null;
let saveTimer = null;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function ensureDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

/** The persisted subset of a session — everything an unrelated process needs. */
function persistable(s) {
  return {
    id: s.id,
    key: s.key,
    bin: s.bin,
    args: s.args,
    cwd: s.cwd,
    meta: s.meta,
    pid: s.pid,
    pgid: s.pgid,
    status: s.status,
    exitCode: s.exitCode,
    signal: s.signal,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    copilotSessionId: s.copilotSessionId,
    logFile: s.logFile,
    aborted: s.aborted,
    note: s.note,
  };
}

function saveNow() {
  saveTimer = null;
  try {
    ensureDirs();
    const payload = { version: 1, savedAt: new Date().toISOString(), sessions: [] };
    for (const s of sessions.values()) payload.sessions.push(persistable(s));
    const tmp = `${INDEX_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, INDEX_FILE);
  } catch (err) {
    console.error('[supervisor] could not persist the session index:', err.message);
  }
}

/**
 * Persist soon.
 *
 * Coalesced because status changes arrive in bursts (spawn, session id, exit),
 * but never longer than a tick — a crash must not be able to lose the pgid of a
 * process that is still running, since that is the only handle abort has.
 */
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 200);
  if (saveTimer.unref) saveTimer.unref();
}

function loadIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return Array.isArray(raw.sessions) ? raw.sessions : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/** Is this pid still around? Signal 0 asks without delivering anything. */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return err.code === 'EPERM';
  }
}

function logSize(s) {
  try {
    return fs.statSync(s.logFile).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(type, session) {
  for (const fn of listeners) {
    try {
      fn(type, publicView(session));
    } catch {
      /* a listener must never break the supervisor */
    }
  }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

function writeSse(res, event, data) {
  if (res.writableEnded) return;
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* subscriber vanished; its close handler cleans up */
  }
}

function broadcast(id, event, data) {
  const set = subscribers.get(id);
  if (!set) return;
  for (const res of set) writeSse(res, event, data);
}

function closeSubscribers(id) {
  const set = subscribers.get(id);
  if (!set) return;
  for (const res of set) {
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
  subscribers.delete(id);
}

/**
 * Read the bytes appended to a session's log since `offset`.
 *
 * Reading a fixed window rather than "everything new" bounds the work when a
 * session produces a burst; the remainder is picked up on the next tick.
 */
function readFrom(file, offset, max = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { text: '', offset };
    const len = Math.min(size - offset, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    return { text: buf.toString('utf8'), offset: offset + len };
  } catch {
    return { text: '', offset };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** The tail of a log, as text, for replay and for the log endpoint. */
function readTail(file, maxBytes) {
  try {
    const size = fs.statSync(file).size;
    const start = maxBytes && size > maxBytes ? size - maxBytes : 0;
    const { text } = readFrom(file, start, size - start);
    return { text: stripAnsi(text), truncated: start > 0, size };
  } catch {
    return { text: '', truncated: false, size: 0 };
  }
}

// ---------------------------------------------------------------------------
// The tick: new bytes, new session ids, dead processes
// ---------------------------------------------------------------------------

function pumpSession(s) {
  const size = logSize(s);
  if (size > s.offset) {
    const { text, offset } = readFrom(s.logFile, s.offset);
    s.offset = offset;
    const clean = stripAnsi(text);
    if (!s.copilotSessionId) {
      const m = clean.match(RESUME_RE);
      if (m) {
        s.copilotSessionId = m[1];
        broadcast(s.id, 'session', { sessionId: s.copilotSessionId });
        emit('session', s);
        save();
      }
    }
    if (clean) broadcast(s.id, 'chunk', { stream: 'stdout', text: clean });
  }
  return size;
}

/**
 * Finish a session.
 *
 * Draining the log one last time before announcing the exit is what makes the
 * final result trustworthy: the child's last words are already on disk when it
 * dies, and a consumer that computes success from the transcript (Create PR
 * looks for the printed PR URL) must see them.
 */
function finish(s, { exitCode = null, signal = null, note = null } = {}) {
  if (s.status !== 'running') return;
  pumpSession(s);
  s.exitCode = exitCode;
  s.signal = signal;
  s.status = s.aborted ? 'aborted' : 'exited';
  s.finishedAt = new Date().toISOString();
  if (note) s.note = note;
  save();
  broadcast(s.id, 'exit', {
    status: s.status,
    exitCode: s.exitCode,
    signal: s.signal,
    aborted: Boolean(s.aborted),
    note: s.note || null,
  });
  closeSubscribers(s.id);
  emit('exit', s);
  console.log(
    `[supervisor] ${s.id} ${s.key || ''} ended: ${s.status}` +
      `${s.exitCode === null ? '' : ` (exit ${s.exitCode})`}`,
  );
}

function tick() {
  for (const s of sessions.values()) {
    if (s.status !== 'running') continue;
    pumpSession(s);
    // Sessions we spawned report their own exit through the child handle. The
    // ones we adopted after a restart have no handle, so their death has to be
    // observed instead of awaited — and observed deaths have no exit code.
    if (!s.child && !pidAlive(s.pid)) {
      finish(s, {
        note: s.aborted
          ? 'aborted'
          : 'exit code unknown — the supervisor was restarted while this ran',
      });
    }
  }
  prune();
}

function startTicking() {
  if (tickTimer) return;
  tickTimer = setInterval(tick, TICK_MS);
  if (tickTimer.unref) tickTimer.unref();
}

/** Forget sessions that ended long ago, and delete their logs with them. */
function prune() {
  const cutoff = Date.now() - RETAIN_MS;
  let changed = false;
  for (const [id, s] of sessions) {
    if (s.status === 'running') continue;
    const ended = s.finishedAt ? new Date(s.finishedAt).getTime() : 0;
    if (ended && ended > cutoff) continue;
    if (!ended) continue;
    sessions.delete(id);
    changed = true;
    try {
      fs.unlinkSync(s.logFile);
    } catch {
      /* already gone */
    }
  }
  if (changed) save();
}

// ---------------------------------------------------------------------------
// Adoption — what makes a supervisor restart survivable
// ---------------------------------------------------------------------------

function init() {
  ensureDirs();
  let adopted = 0;
  let lost = 0;
  for (const raw of loadIndex()) {
    const s = {
      ...raw,
      child: null,
      offset: 0,
      adopted: raw.status === 'running',
    };
    if (!s.logFile) s.logFile = path.join(SESSIONS_DIR, `${s.id}.log`);
    s.offset = logSize(s);
    if (s.status === 'running') {
      if (pidAlive(s.pid)) {
        adopted += 1;
      } else {
        s.status = s.aborted ? 'aborted' : 'exited';
        s.exitCode = null;
        s.finishedAt = s.finishedAt || new Date().toISOString();
        s.note = 'ended while no supervisor was running';
        lost += 1;
      }
    }
    sessions.set(s.id, s);
  }
  save();
  startTicking();
  console.log(
    `[supervisor] ready — ${sessions.size} session(s) on record, ` +
      `${adopted} still running, ${lost} ended while we were away`,
  );
  return { adopted, lost, total: sessions.size };
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

function newId() {
  return `s${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function runningByKey(key) {
  if (!key) return null;
  for (const s of sessions.values()) {
    if (s.key === key && s.status === 'running') return s;
  }
  return null;
}

/**
 * Start a supervised session.
 *
 * @param {object} opts
 *   key   logical identity ("<repo>#<issue>:<action>[:<pr>]"). At most one
 *         running session may hold a key, which is what stops a duplicate
 *         Create PR when a phone retries a request it never saw answered.
 *   bin, args, cwd, env, meta
 * @returns {object} the public view of the new session
 */
function spawnSession({ key = null, bin, args = [], cwd, env = {}, meta = {} }) {
  if (!bin) throw new Error('bin is required');
  const clash = runningByKey(key);
  if (clash) {
    const err = new Error(`a session with key "${key}" is already running`);
    err.code = 'EKEYBUSY';
    err.session = publicView(clash);
    throw err;
  }

  ensureDirs();
  const id = newId();
  const logFile = path.join(SESSIONS_DIR, `${id}.log`);
  // 'a' rather than 'w': if this id ever collided, appending loses nothing.
  const fd = fs.openSync(logFile, 'a');

  const s = {
    id,
    key,
    bin,
    args,
    cwd: cwd || process.cwd(),
    meta,
    pid: null,
    pgid: null,
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    copilotSessionId: null,
    logFile,
    aborted: false,
    note: null,
    child: null,
    offset: 0,
  };

  let child;
  try {
    child = spawn(bin, args, {
      cwd: s.cwd,
      env: { ...process.env, CLOUD_COPILOT_JOB: '1', ...env },
      // The child writes the transcript itself, so it neither needs nor
      // notices a reader. See the module comment.
      stdio: ['ignore', fd, fd],
      detached: true,
    });
  } catch (err) {
    fs.closeSync(fd);
    s.status = 'exited';
    s.exitCode = null;
    s.finishedAt = new Date().toISOString();
    s.note = `could not start: ${err.message}`;
    fs.appendFileSync(logFile, `\n[spawn error] ${err.message}\n`);
    sessions.set(id, s);
    save();
    emit('exit', s);
    return publicView(s);
  }
  // The fd now belongs to the child; this process has no more use for it.
  fs.closeSync(fd);

  s.child = child;
  s.pid = child.pid;
  s.pgid = child.pid; // detached ⇒ the child leads its own group
  sessions.set(id, s);
  save();
  startTicking();

  child.on('error', (err) => {
    try {
      fs.appendFileSync(logFile, `\n[process error] ${err.message}\n`);
    } catch {
      /* ignore */
    }
  });
  child.on('close', (code, signal) => {
    finish(s, { exitCode: code, signal });
  });

  console.log(`[supervisor] ${id} started: ${key || meta.action || bin} (pid ${s.pid})`);
  emit('start', s);
  return publicView(s);
}

// ---------------------------------------------------------------------------
// Aborting
// ---------------------------------------------------------------------------

/**
 * Stop a session and everything it started.
 *
 * Signals the process GROUP, because the thing worth killing is rarely the
 * copilot process itself — it is the xcodebuild or npm test underneath it. The
 * group id comes from the record, so this works identically for a session this
 * supervisor spawned and one it adopted.
 */
function abort(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'no such session' };
  if (s.status !== 'running') return { ok: false, error: `session already ${s.status}` };

  s.aborted = true;
  s.abortRequestedAt = new Date().toISOString();
  save();

  const target = s.pgid || s.pid;
  const signalGroup = (sig) => {
    try {
      process.kill(-target, sig);
      return true;
    } catch {
      try {
        process.kill(s.pid, sig);
        return true;
      } catch {
        return false;
      }
    }
  };

  const delivered = signalGroup('SIGTERM');
  const t = setTimeout(() => {
    const cur = sessions.get(id);
    if (!cur || cur.status !== 'running') return;
    signalGroup('SIGKILL');
    // An adopted session has no `close` event to wait for; give SIGKILL a beat
    // and then settle the record ourselves so the UI cannot hang on it.
    const t2 = setTimeout(() => {
      const c = sessions.get(id);
      if (c && c.status === 'running' && !pidAlive(c.pid)) {
        finish(c, { signal: 'SIGKILL', note: 'aborted' });
      }
    }, 1000);
    if (t2.unref) t2.unref();
  }, SIGKILL_AFTER_MS);
  if (t.unref) t.unref();

  if (!delivered && !pidAlive(s.pid)) {
    finish(s, { note: 'the process was already gone when abort was requested' });
    return { ok: true, alreadyGone: true, session: publicView(s) };
  }
  console.log(`[supervisor] ${id} abort requested (pgid ${target})`);
  return { ok: true, session: publicView(sessions.get(id)) };
}

function abortByKey(key) {
  const s = runningByKey(key);
  if (!s) return { ok: false, error: 'no running session with that key' };
  return abort(s.id);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function publicView(s) {
  if (!s) return null;
  return {
    id: s.id,
    key: s.key,
    status: s.status,
    pid: s.pid,
    pgid: s.pgid,
    bin: s.bin,
    args: s.args,
    cwd: s.cwd,
    meta: s.meta || {},
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    elapsedMs:
      (s.finishedAt ? new Date(s.finishedAt).getTime() : Date.now()) -
      new Date(s.startedAt).getTime(),
    exitCode: s.exitCode,
    signal: s.signal,
    aborted: Boolean(s.aborted),
    adopted: Boolean(s.adopted),
    note: s.note || null,
    sessionId: s.copilotSessionId || null,
    logBytes: logSize(s),
    subscribers: (subscribers.get(s.id) || new Set()).size,
    alive: s.status === 'running' ? pidAlive(s.pid) : false,
  };
}

function list({ all = false } = {}) {
  const out = [];
  for (const s of sessions.values()) {
    if (!all && s.status !== 'running') continue;
    out.push(publicView(s));
  }
  out.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  return out;
}

function get(id) {
  return publicView(sessions.get(id));
}

function getByKey(key) {
  return publicView(runningByKey(key));
}

function log(id, { tailBytes = REPLAY_TAIL_BYTES } = {}) {
  const s = sessions.get(id);
  if (!s) return null;
  return readTail(s.logFile, tailBytes);
}

/**
 * Attach an SSE response to a session: replay the log, then stream live.
 *
 * A finished session is replayed in full and the stream is closed immediately,
 * so a client's reader always completes instead of hanging on a task that ended
 * before it connected.
 */
function subscribe(id, res, { tailBytes = REPLAY_TAIL_BYTES } = {}) {
  const s = sessions.get(id);
  if (!s) return false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Mobile Safari buffers small SSE bodies until ~2KB has arrived.
  res.write(`:${' '.repeat(2048)}\n\n`);

  writeSse(res, 'meta', { ...publicView(s), replay: true });
  const { text, truncated } = readTail(s.logFile, tailBytes);
  if (truncated) {
    writeSse(res, 'chunk', {
      stream: 'stdout',
      text: `[… earlier output trimmed; the full log is on disk at ${s.logFile}]\n`,
    });
  }
  if (text) writeSse(res, 'chunk', { stream: 'stdout', text });
  if (s.copilotSessionId) writeSse(res, 'session', { sessionId: s.copilotSessionId });

  if (s.status !== 'running') {
    writeSse(res, 'exit', {
      status: s.status,
      exitCode: s.exitCode,
      signal: s.signal,
      aborted: Boolean(s.aborted),
      note: s.note || null,
    });
    res.end();
    return true;
  }

  // Everything after this marker is new output. Machine consumers reconnect
  // after a dropped socket and would otherwise have no way to tell the replayed
  // transcript from live bytes, and would append the log to itself.
  writeSse(res, 'live', { at: Date.now() });

  // Subscribing must never rewind the shared tailer: a second viewer would
  // otherwise make the first one see the whole log again. New subscribers get
  // history from the replay above and live bytes from the next tick onwards.
  if (!subscribers.has(id)) subscribers.set(id, new Set());
  subscribers.get(id).add(res);
  const ping = setInterval(() => {
    if (res.writableEnded) return;
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      /* ignore */
    }
  }, 15000);
  if (ping.unref) ping.unref();
  res.on('close', () => {
    clearInterval(ping);
    const set = subscribers.get(id);
    if (set) {
      set.delete(res);
      if (!set.size) subscribers.delete(id);
    }
  });
  return true;
}

/** Pids of every running session, for per-task CPU accounting. */
function runningPids() {
  const out = [];
  for (const s of sessions.values()) {
    if (s.status === 'running' && s.pid) out.push({ id: s.id, pid: s.pid, pgid: s.pgid || s.pid });
  }
  return out;
}

module.exports = {
  init,
  spawnSession,
  abort,
  abortByKey,
  list,
  get,
  getByKey,
  log,
  subscribe,
  runningPids,
  onEvent,
  saveNow,
  SESSIONS_DIR,
};
