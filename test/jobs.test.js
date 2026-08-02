'use strict';

/**
 * Tests for the job manager's multi-phase machinery (`nextPhase`), which the
 * deploy preflight relies on: phase 1 salvages a dirty working tree, phase 2
 * deploys, and the browser must see ONE continuous log with ONE final `done`.
 *
 * Real child processes (`node -e ...`) rather than stubs — spawn semantics
 * (exit codes, close ordering, ENOENT) are exactly what is under test here.
 *
 * Run with `npm test`.
 */

// Keep the ntfy push out of the tests entirely.
process.env.NTFY_ENABLED = '0';
process.env.NTFY_TOPIC = '';

const test = require('node:test');
const assert = require('node:assert');

const jobs = require('../lib/jobs');

let keySeq = 0;
const uniqueKey = (name) => `test-job-${name}-${++keySeq}`;

// Minimal stand-in for an SSE response: records every event the job writes.
function fakeRes() {
  const events = [];
  let buf = '';
  return {
    events,
    writableEnded: false,
    write(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const evt = /^event: (.+)$/m.exec(frame);
        const data = /^data: (.*)$/m.exec(frame);
        if (evt) events.push({ event: evt[1], data: data ? JSON.parse(data[1]) : null });
      }
      return true;
    },
    on() {},
    end() {
      this.writableEnded = true;
    },
  };
}

const nodePhase = (script, exitCode = 0) => ({
  bin: process.execPath,
  args: ['-e', `process.stdout.write(${JSON.stringify(script)}); process.exit(${exitCode});`],
  cwd: process.cwd(),
});

function waitDone(job, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (job.status === 'done') return resolve(job);
      if (Date.now() - started > timeoutMs) return reject(new Error('job did not finish'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

test('runs both phases back-to-back under one job, one done, one result', async () => {
  const res = fakeRes();
  let doneCalls = 0;
  const job = jobs.startJob(uniqueKey('two-phase'), {
    ...nodePhase('PHASE-ONE'),
    meta: { action: 'deploy', phase: 'salvage' },
    nextPhase: async (j, code) => {
      assert.strictEqual(code, 0);
      assert.ok(j.conversation.includes('PHASE-ONE'), 'phase 1 output is on the job before phase 2 starts');
      return { ...nodePhase('PHASE-TWO'), phase: 'deploy' };
    },
    onDone: async () => {
      doneCalls += 1;
      return { action: 'deploy', status: 'success' };
    },
  });
  jobs.subscribe(job, res);
  await waitDone(job);

  assert.ok(
    job.conversation.indexOf('PHASE-ONE') < job.conversation.indexOf('PHASE-TWO'),
    'phases stream into one transcript in order',
  );
  assert.strictEqual(count(job.conversation, 'PHASE-TWO'), 1, 'the terminal phase runs exactly once');
  assert.strictEqual(doneCalls, 1, 'onDone fires once, after the LAST phase');
  assert.strictEqual(count(res.events.map((e) => e.event).join(','), 'done'), 1);
  assert.strictEqual(job.phase, 'deploy');
  assert.strictEqual(job.exitCode, 0);
  assert.strictEqual(job.result.status, 'success');

  const phaseEvt = res.events.find((e) => e.event === 'phase');
  assert.ok(phaseEvt, 'subscribers are told about the phase switch');
  assert.strictEqual(phaseEvt.data.phase, 'deploy');
});

test('a returned spec does not inherit nextPhase (no infinite re-entry)', async () => {
  let calls = 0;
  const job = jobs.startJob(uniqueKey('no-inherit'), {
    ...nodePhase('P1'),
    nextPhase: async () => {
      calls += 1;
      return { ...nodePhase('P2'), phase: 'deploy' };
    },
  });
  await waitDone(job);
  assert.strictEqual(calls, 1, 'nextPhase is consumed by the phase it was attached to');
  assert.strictEqual(count(job.conversation, 'P2'), 1);
});

test('nextPhase returning null finishes the job after the first phase', async () => {
  const job = jobs.startJob(uniqueKey('null-next'), {
    ...nodePhase('ONLY'),
    nextPhase: async () => null,
  });
  await waitDone(job);
  assert.ok(job.conversation.includes('ONLY'));
  assert.strictEqual(job.exitCode, 0);
});

test('a nextPhase that throws ends the job and surfaces the reason', async () => {
  const res = fakeRes();
  let sawSecondPhase = false;
  const job = jobs.startJob(uniqueKey('guard-throws'), {
    ...nodePhase('SALVAGE-FAILED', 3),
    nextPhase: async (j, code) => {
      // Exactly the deploy preflight's guard: refuse to advance on failure.
      if (code !== 0) throw new Error(`Salvage preflight exited ${code}`);
      sawSecondPhase = true;
      return nodePhase('DEPLOY');
    },
    onDone: async () => ({ action: 'deploy', status: 'failed' }),
  });
  jobs.subscribe(job, res);
  await waitDone(job);

  assert.strictEqual(sawSecondPhase, false);
  assert.ok(!job.conversation.includes('DEPLOY'), 'the guarded phase never ran');
  assert.ok(job.conversation.includes('[phase error] Salvage preflight exited 3'));
  assert.strictEqual(job.exitCode, 3);
  assert.strictEqual(job.result.status, 'failed');
  const err = res.events.find((e) => e.event === 'error');
  assert.match(err.data.message, /Salvage preflight exited 3/);
  assert.strictEqual(count(res.events.map((e) => e.event).join(','), 'done'), 1);
});

test('cancelling during phase 1 never advances to phase 2', async () => {
  const key = uniqueKey('cancel-phase1');
  let advanced = false;
  const job = jobs.startJob(key, {
    bin: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    cwd: process.cwd(),
    nextPhase: async () => {
      advanced = true;
      return nodePhase('DEPLOY');
    },
  });
  setTimeout(() => jobs.cancelJob(key), 150);
  await waitDone(job);
  assert.strictEqual(advanced, false, 'an abort mid-salvage must not roll on into the deploy');
  assert.strictEqual(job.cancelled, true);
});

test('cancelling WHILE nextPhase is awaiting still never advances', async () => {
  // Regression guard: nextPhase does real work (fetch, checkout, a changelog
  // hop) between phases. During that window there is no live child to kill, so
  // the cancel flag is the only thing standing between an abort and a deploy.
  const key = uniqueKey('cancel-between');
  const job = jobs.startJob(key, {
    ...nodePhase('P1'),
    nextPhase: async () => {
      jobs.cancelJob(key);
      await new Promise((r) => setTimeout(r, 50));
      return { ...nodePhase('DEPLOY-SHOULD-NOT-RUN'), phase: 'deploy' };
    },
  });
  await waitDone(job);
  assert.ok(!job.conversation.includes('DEPLOY-SHOULD-NOT-RUN'), 'cancel during the gap wins');
  assert.strictEqual(job.status, 'done');
});

test('single-phase jobs behave exactly as before', async () => {
  const res = fakeRes();
  const job = jobs.startJob(uniqueKey('single'), {
    ...nodePhase('SOLO', 2),
    meta: { action: 'deploy' },
    onDone: async (j) => ({ action: 'deploy', status: j.exitCode === 0 ? 'success' : 'failed' }),
  });
  jobs.subscribe(job, res);
  await waitDone(job);
  assert.strictEqual(job.exitCode, 2);
  assert.strictEqual(job.phase, null);
  assert.strictEqual(job.result.status, 'failed');
  assert.strictEqual(count(res.events.map((e) => e.event).join(','), 'done'), 1);
});

test('a phase that cannot be spawned finishes the job instead of hanging', async () => {
  const res = fakeRes();
  const job = jobs.startJob(uniqueKey('enoent'), {
    bin: '/nonexistent/definitely-not-a-binary',
    args: [],
    cwd: process.cwd(),
    onDone: async () => ({ action: 'deploy', status: 'failed' }),
  });
  jobs.subscribe(job, res);
  await waitDone(job);
  assert.strictEqual(job.status, 'done');
  assert.ok(res.events.some((e) => e.event === 'error'));
  assert.strictEqual(count(res.events.map((e) => e.event).join(','), 'done'), 1);
});

test('note() lands in the transcript and on the stream', async () => {
  const res = fakeRes();
  const job = jobs.startJob(uniqueKey('note'), { ...nodePhase('X') });
  jobs.subscribe(job, res);
  jobs.note(job, '[preflight] hello\n');
  await waitDone(job);
  assert.ok(job.conversation.includes('[preflight] hello'));
  assert.ok(res.events.some((e) => e.event === 'chunk' && e.data.text.includes('[preflight] hello')));
});
