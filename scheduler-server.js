'use strict';

/**
 * cloud-scheduler — the half of cloud-copilot that must never stop.
 *
 * The dashboard on :8787 restarts constantly: it deploys itself, it is edited
 * by the very agents it launches, and every one of those restarts used to take
 * the running work down with it. Not the processes — those were already
 * detached and kept going — but everything that *knew about* them. The result
 * was a task frozen at "Deploying…" with an empty log and a Stop button that
 * answered `404 no such running job`, because the only record of that child
 * had been an object in the dead process's memory.
 *
 * This server owns that record instead, on :8788, and it is deliberately
 * boring: it starts processes, keeps their logs, lists them, kills them, and
 * reports what the machine costs to run them. Nothing here needs the dashboard
 * to be up, so a dashboard restart is invisible to the work in flight.
 *
 * It also hosts the committed-issue scheduler (lib/schedulerCore), which is a
 * pure HTTP client of :8787 — if the dashboard is down, a sweep simply fails
 * and the next one succeeds.
 *
 * Bind to loopback by default: this API can start arbitrary processes, so it
 * has no business listening on a network.
 */

const path = require('path');
const os = require('os');
const express = require('express');

const supervisor = require('./lib/supervisor');
const metrics = require('./lib/metrics');
const scheduler = require('./lib/schedulerCore');
const notifier = require('./lib/notifier');

const HOST = process.env.SCHEDULER_HOST || '127.0.0.1';
const PORT = Number(process.env.SCHEDULER_PORT || 8788);
const DASHBOARD_HOST = process.env.CC_DASHBOARD_HOST || '127.0.0.1';
const DASHBOARD_PORT = Number(process.env.CC_DASHBOARD_PORT || process.env.PORT || 8787);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public', 'scheduler')));

const started = Date.now();

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'cloud-scheduler',
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date(started).toISOString(),
    uptimeMs: Date.now() - started,
    sessions: supervisor.list().length,
    dashboard: `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`,
  });
});

// ---------------------------------------------------------------------------
// Sessions — the supervised Copilot CLI processes
// ---------------------------------------------------------------------------

/**
 * Start a session.
 *
 * The caller (normally the dashboard's job manager) supplies the whole command
 * because only it knows which prompt, worktree and port a given action needs.
 * This server's contribution is that the result outlives the caller.
 */
app.post('/api/sessions', (req, res) => {
  const { key = null, bin, args = [], cwd, env = {}, meta = {} } = req.body || {};
  if (typeof bin !== 'string' || !bin) return res.status(400).json({ error: 'bin is required' });
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    return res.status(400).json({ error: 'args must be an array of strings' });
  }
  try {
    const session = supervisor.spawnSession({ key, bin, args, cwd, env, meta });
    res.status(201).json({ session });
  } catch (err) {
    if (err.code === 'EKEYBUSY') {
      // Not an error the caller should retry past: returning the existing
      // session lets it attach to the run it was about to duplicate.
      return res.status(409).json({ error: err.message, session: err.session });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', (req, res) => {
  const all = req.query.all === '1' || req.query.all === 'true';
  res.json({ at: Date.now(), sessions: supervisor.list({ all }) });
});

app.get('/api/sessions/by-key/:key', (req, res) => {
  const session = supervisor.getByKey(req.params.key);
  if (!session) return res.status(404).json({ error: 'no running session with that key' });
  res.json({ session });
});

app.post('/api/sessions/abort-by-key', (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key : '';
  if (!key) return res.status(400).json({ error: 'key is required' });
  const out = supervisor.abortByKey(key);
  res.status(out.ok ? 200 : 404).json(out);
});

app.get('/api/sessions/:id', (req, res) => {
  const session = supervisor.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'no such session' });
  res.json({ session });
});

app.get('/api/sessions/:id/log', (req, res) => {
  const tailBytes = Number(req.query.tail) || undefined;
  const out = supervisor.log(req.params.id, tailBytes ? { tailBytes } : {});
  if (!out) return res.status(404).json({ error: 'no such session' });
  res.type('text/plain; charset=utf-8').send(out.text);
});

app.get('/api/sessions/:id/stream', (req, res) => {
  const tailBytes = Number(req.query.tail) || undefined;
  const ok = supervisor.subscribe(req.params.id, res, tailBytes ? { tailBytes } : {});
  if (!ok) res.status(404).json({ error: 'no such session' });
});

/**
 * Abort a session.
 *
 * This is the whole point of the rewrite: it needs nothing but the persisted
 * process-group id, so it works for a session started by a dashboard that has
 * since restarted, and for one adopted by a supervisor that has restarted too.
 */
app.post('/api/sessions/:id/abort', (req, res) => {
  const out = supervisor.abort(req.params.id);
  res.status(out.ok ? 200 : 404).json(out);
});

// ---------------------------------------------------------------------------
// Machine metrics
// ---------------------------------------------------------------------------

app.get('/api/metrics', (req, res) => {
  const snap = metrics.snapshot(supervisor.runningPids());
  // Join the CPU figures back onto the sessions they belong to, so the panel
  // can say "this deploy is 140% of one core" without a second request.
  const byId = new Map(snap.sessions.map((s) => [s.id, s]));
  const sessions = supervisor.list().map((s) => ({ ...s, usage: byId.get(s.id) || null }));
  res.json({ ...snap, sessions, summary: metrics.summarize(snap) });
});

/**
 * Push the current metrics to the phone.
 *
 * A dashboard you have to be looking at cannot tell you the machine is melting
 * while you are away from it, which is the only time it matters.
 */
app.post('/api/metrics/push', async (req, res) => {
  const snap = metrics.snapshot(supervisor.runningPids());
  const summary = metrics.summarize(snap);
  try {
    const out = await notifier.publish({
      title: `${os.hostname()} · ${snap.supervised.count} session(s)`,
      message: summary,
      tags: ['bar_chart'],
      priority: 3,
    });
    res.json({ sent: Boolean(out && out.ok !== false), summary, detail: out || null });
  } catch (err) {
    res.status(500).json({ error: err.message, summary });
  }
});

app.get('/api/notify', (req, res) => {
  res.json(notifier.status());
});

// ---------------------------------------------------------------------------
// The committed-issue scheduler
// ---------------------------------------------------------------------------

function schedulerPayload() {
  return { ...scheduler.status(), supervised: supervisor.list().length };
}

app.get('/api/scheduler', (req, res) => {
  res.json(schedulerPayload());
});

app.post('/api/scheduler', (req, res) => {
  const body = req.body || {};
  if (typeof body.enabled === 'boolean') scheduler.setEnabled(body.enabled);
  if (typeof body.repo === 'string' && body.repo) {
    scheduler.setRepoEnabled(body.repo, body.repoEnabled === null ? null : Boolean(body.repoEnabled));
  }
  if (body.reset && typeof body.reset.repo === 'string') {
    scheduler.resetIssue(body.reset.repo, Number(body.reset.issueNumber));
  }
  if (body.runNow) scheduler.runSoon();
  res.json(schedulerPayload());
});

/** Is automation on for this repo? Asked by the dashboard's committed toggle. */
app.get('/api/scheduler/enabled/:repo', (req, res) => {
  res.json({ repo: req.params.repo, enabled: scheduler.enabledFor(req.params.repo) });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

supervisor.init();
scheduler.init({ host: DASHBOARD_HOST, port: DASHBOARD_PORT });

app.listen(PORT, HOST, () => {
  const s = scheduler.status();
  console.log(`cloud-scheduler running at http://${HOST}:${PORT}`);
  console.log(`Supervising ${supervisor.list().length} live session(s) in ${supervisor.SESSIONS_DIR}`);
  console.log(`Dashboard: http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
  console.log(
    s.enabled
      ? `Scheduler: ON — sweeps every ${Math.round(s.intervalMs / 60000)} min, up to ${s.maxConcurrent} run(s) at once`
      : 'Scheduler: off',
  );
  scheduler.start();
});

// A supervisor that loses its index on the way out would forget how to kill the
// processes it started, so flush it synchronously on every ordinary exit path.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    supervisor.saveNow();
    console.log(`[cloud-scheduler] ${sig} — the supervised sessions keep running`);
    process.exit(0);
  });
}
process.on('exit', () => supervisor.saveNow());
