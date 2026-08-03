'use strict';

/**
 * Tests for scripts/self-deploy.js — the half of issue #71 that actually
 * restarts things.
 *
 * The runner is hard to trust by reading: it replaces the dashboard, then
 * replaces the supervisor that owns it, and has to report the truth about both
 * afterwards. These tests drive it against a fake cloud-scheduler so every
 * outcome is exercised without touching a real process:
 *
 *   - no scheduler changes            → phase 2 skipped, deploy succeeds
 *   - the dashboard restart fails     → deploy fails, phase 2 never runs
 *   - the scheduler restart fails     → deploy fails
 *   - the scheduler never comes back  → deploy fails
 *   - a running session is not adopted→ deploy fails (the case the phase exists for)
 *   - a session that simply finished  → deploy still succeeds (not a shortfall)
 *
 * The verdict is asserted on the transcript marker, not only on the exit code,
 * because in production the exit code is lost: the supervisor that could have
 * reported it is the one being restarted.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { RESULT_MARKER } = require('../lib/selfDeploy');

const RUNNER = path.join(__dirname, '..', 'scripts', 'self-deploy.js');

/**
 * A stand-in for cloud-scheduler.
 *
 * `sessions(all)` models the restart honestly rather than with a timer: the
 * runner asks for the running sessions *before* (`/api/sessions`) and for
 * everything on record *after* (`/api/sessions?all=1`), so the flag is exactly
 * the before/after boundary.
 */
async function fakeScheduler(state) {
  const server = http.createServer((req, res) => {
    const [url, query = ''] = req.url.split('?');
    const body =
      url === '/api/health'
        ? state.health
        : url === '/api/sessions'
          ? { sessions: state.sessions(query.includes('all=1')) }
          : null;
    if (!body) {
      res.writeHead(404).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

function runRunner(plan, { port, extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        CC_SELF_DEPLOY_PLAN: JSON.stringify(plan),
        CC_SUPERVISOR_HOST: '127.0.0.1',
        CC_SUPERVISOR_PORT: String(port || 0),
        CC_SELF_DEPLOY_HEALTH_TIMEOUT_MS: '1500',
        CC_SELF_DEPLOY_ADOPT_TIMEOUT_MS: '1500',
        CC_SELF_DEPLOY_POLL_MS: '100',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      out += c;
    });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const succeeded = (out) => out.includes(`${RESULT_MARKER} success`);
const failed = (out) => out.includes(`${RESULT_MARKER} failed`);

const HEALTH = { ok: true, service: 'cloud-scheduler', pid: 4242, sessions: 0 };

/** A pid nothing can plausibly be using — high, and never spawned by this run. */
const DEAD_PID = 2 ** 22 - 1;

test('no scheduler changes: the dashboard restarts and phase 2 is skipped', async () => {
  const { server, port } = await fakeScheduler({ health: HEALTH, sessions: () => [] });
  try {
    const { code, out } = await runRunner(
      { dashboardCommand: 'echo dashboard-restarted', restartScheduler: false, decisionLine: 'no scheduler changes → dashboard only' },
      { port },
    );
    assert.equal(code, 0);
    assert.ok(succeeded(out), out);
    assert.match(out, /no scheduler changes/);
    assert.match(out, /skipped/);
  } finally {
    server.close();
  }
});

test('a failed dashboard restart fails the deploy before phase 2', async () => {
  const { server, port } = await fakeScheduler({ health: HEALTH, sessions: () => [] });
  try {
    const { code, out } = await runRunner(
      { dashboardCommand: 'exit 7', restartScheduler: true, schedulerCommand: 'echo SHOULD-NOT-RUN' },
      { port },
    );
    assert.notEqual(code, 0);
    assert.ok(failed(out), out);
    assert.doesNotMatch(out, /SHOULD-NOT-RUN/);
  } finally {
    server.close();
  }
});

test('a scheduler restart that keeps its sessions succeeds', async () => {
  // A pid that is definitely alive and definitely ours: this test process.
  const running = [{ id: 's1', key: 'repo#1:work', pid: process.pid, status: 'running' }];
  const { server, port } = await fakeScheduler({ health: HEALTH, sessions: () => running });
  try {
    const { code, out } = await runRunner(
      {
        dashboardCommand: 'true',
        restartScheduler: true,
        matched: ['lib/supervisor.js'],
        schedulerCommand: 'echo restarting-scheduler',
      },
      { port },
    );
    assert.equal(code, 0);
    assert.ok(succeeded(out), out);
    assert.match(out, /1 running session\(s\) adopted/);
    assert.match(out, /lib\/supervisor\.js/);
  } finally {
    server.close();
  }
});

test('a session that simply finished during the restart is not an adoption failure', async () => {
  // Counting would call this a shortfall (1 before, 0 after) and fail a deploy
  // that did nothing wrong: the session ended by itself, and the replacement
  // supervisor recorded exactly that.
  const dead = { id: 's1', key: 'repo#1:work', pid: DEAD_PID, status: 'running' };
  const { server, port } = await fakeScheduler({ health: HEALTH, sessions: (all) => (all ? [] : [dead]) });
  try {
    const { code, out } = await runRunner(
      { dashboardCommand: 'true', restartScheduler: true, schedulerCommand: 'true' },
      { port },
    );
    // Counting says 1 → 0 and would fail; what makes this pass is that the pid
    // is gone, so the session ended rather than got lost.
    assert.equal(code, 0, out);
    assert.ok(succeeded(out), out);
    assert.match(out, /finished during the restart/);
  } finally {
    server.close();
  }
});

test('a still-running session the new supervisor never picked up fails the deploy', async () => {
  // The case this whole phase exists for: the process is alive, and nothing is
  // watching it any more. Silence here is how a session gets lost.
  const alive = { id: 's1', key: 'repo#1:work', pid: process.pid, status: 'running' };
  const { server, port } = await fakeScheduler({ health: HEALTH, sessions: (all) => (all ? [] : [alive]) });
  try {
    const { code, out } = await runRunner(
      { dashboardCommand: 'true', restartScheduler: true, schedulerCommand: 'true' },
      { port },
    );
    assert.notEqual(code, 0);
    assert.ok(failed(out), out);
    assert.match(out, /were not picked up/);
    assert.match(out, /s1 \(repo#1:work\)/);
  } finally {
    server.close();
  }
});

test('a session listed as exited but still alive is treated as lost', async () => {
  // "On record" is not "adopted": init() only re-adopts what it finds running.
  const alive = { id: 's1', key: 'repo#1:work', pid: process.pid, status: 'running' };
  const { server, port } = await fakeScheduler({
    health: HEALTH,
    sessions: (all) => (all ? [{ ...alive, status: 'exited' }] : [alive]),
  });
  try {
    const { code, out } = await runRunner(
      { dashboardCommand: 'true', restartScheduler: true, schedulerCommand: 'true' },
      { port },
    );
    assert.notEqual(code, 0);
    assert.ok(failed(out), out);
  } finally {
    server.close();
  }
});

test('a scheduler restart command that fails, fails the deploy', async () => {
  const { server, port } = await fakeScheduler({ health: HEALTH, sessions: () => [] });
  try {
    const { code, out } = await runRunner(
      { dashboardCommand: 'true', restartScheduler: true, schedulerCommand: 'exit 3' },
      { port },
    );
    assert.notEqual(code, 0);
    assert.ok(failed(out), out);
    assert.match(out, /restart failed \(exit 3\)/);
  } finally {
    server.close();
  }
});

test('a scheduler that never answers again fails the deploy', async () => {
  const { server, port } = await fakeScheduler({ health: HEALTH, sessions: () => [] });
  server.close();
  const { code, out } = await runRunner(
    { dashboardCommand: 'true', restartScheduler: true, schedulerCommand: 'true' },
    { port },
  );
  assert.notEqual(code, 0);
  assert.ok(failed(out), out);
  assert.match(out, /did not answer/);
});

test('a missing plan refuses to guess', async () => {
  const { code, out } = await runRunner(null, { port: 1, extraEnv: { CC_SELF_DEPLOY_PLAN: '' } });
  assert.notEqual(code, 0);
  assert.match(out, /CC_SELF_DEPLOY_PLAN is missing/);
});
