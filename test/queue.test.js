'use strict';

// Sandbox must be installed before lib/queue is required — it reads the file
// path from the environment at module load.
require('./helpers').sandbox('cc-queue-');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const queue = require('../lib/queue');

const CREATE = (n, extra = {}) => ({
  repo: 'demo',
  type: 'create-pr',
  issueNumber: n,
  title: `#${n} thing`,
  ...extra,
});

function fresh() {
  // Wipe both the file and the resident copy between tests.
  try {
    fs.unlinkSync(queue.QUEUE_FILE);
  } catch {
    /* first run */
  }
  queue._reset();
}

test('A1.1 the same issue cannot be queued twice', () => {
  fresh();
  assert.ok(queue.enqueue(CREATE(1)));
  assert.equal(queue.enqueue(CREATE(1)), null);
});

test('A1.2 a finished task does not block re-queueing the same work', () => {
  fresh();
  const t = queue.enqueue(CREATE(1));
  queue.finish(t.id, 'skipped');
  assert.ok(queue.enqueue(CREATE(1)), 'terminal rows must not act as a lock');
});

test('A1.3 nextQueued prefers lower priority, then older', async () => {
  fresh();
  const a = queue.enqueue(CREATE(1));
  await new Promise((r) => setTimeout(r, 5));
  queue.enqueue(CREATE(2));
  assert.equal(queue.nextQueued('demo').id, a.id, 'same priority → oldest first');

  const c = queue.enqueue(CREATE(3, { priority: -5 }));
  assert.equal(queue.nextQueued('demo').id, c.id, 'lower priority wins');
});

test('A1.4 moveToTop puts a task at the head', () => {
  fresh();
  queue.enqueue(CREATE(1));
  const b = queue.enqueue(CREATE(2));
  assert.ok(queue.moveToTop(b.id));
  assert.equal(queue.nextQueued('demo').id, b.id);
});

test('A1.5 failure enters cooldown and blocks automatic re-queueing', () => {
  fresh();
  const t = queue.enqueue(CREATE(1));
  queue.finish(t.id, 'failed', { error: 'no PR opened' });

  assert.equal(queue.get().counters.demo.totalFailed, 1);
  assert.ok(queue.isCoolingDown(CREATE(1)));
  assert.equal(queue.enqueue(CREATE(1)), null, 'scan must not retry a failed issue');
  assert.ok(queue.enqueue(CREATE(1), { force: true }), 'but a manual add may');
});

test('A1.6 success bumps the done counter and does not cool down', () => {
  fresh();
  const t = queue.enqueue(CREATE(1));
  queue.finish(t.id, 'success');
  assert.equal(queue.get().counters.demo.totalDone, 1);
  assert.equal(queue.isCoolingDown(CREATE(1)), false);
});

test('A1.7 skipped is not a failure', () => {
  fresh();
  const t = queue.enqueue(CREATE(1));
  queue.finish(t.id, 'skipped', { error: 'label removed' });
  const c = queue.get().counters.demo;
  assert.equal(c.totalFailed, 0);
  assert.equal(c.totalDone, 0);
  assert.equal(queue.isCoolingDown(CREATE(1)), false);
});

test('A1.8 retry clears cooldown, re-queues at the head, drops the old row', () => {
  fresh();
  const t = queue.enqueue(CREATE(1));
  queue.finish(t.id, 'failed', { error: 'boom' });

  const again = queue.retry(t.id);
  assert.equal(again.status, 'queued');
  assert.equal(again.priority, -1);
  assert.equal(queue.isCoolingDown(CREATE(1)), false);
  assert.equal(queue.getTask(t.id), null, 'the failed row is replaced, not duplicated');
});

test('A1.9 reconcile re-runs a task interrupted once', () => {
  fresh();
  const t = queue.enqueue(CREATE(1));
  queue.markRunning(t.id);

  const res = queue.reconcile();
  assert.equal(res.requeued, 1);
  const after = queue.getTask(t.id);
  assert.equal(after.status, 'queued');
  assert.equal(after.attempt, 2);
  assert.equal(after.priority, -1, 'it was at the head; it stays at the head');
});

test('A1.10 reconcile fails a task interrupted twice', () => {
  fresh();
  const t = queue.enqueue(CREATE(1));
  queue.markRunning(t.id);
  queue.reconcile(); // attempt → 2
  queue.markRunning(t.id);

  const res = queue.reconcile();
  assert.equal(res.failed, 1);
  assert.equal(queue.getTask(t.id).status, 'failed');
  assert.ok(queue.isCoolingDown(CREATE(1)), 'a repeatedly-crashing task must stop retrying');
});

test('A1.11 sweep moves long-finished tasks into history', () => {
  fresh();
  const t = queue.enqueue(CREATE(1));
  queue.finish(t.id, 'success');
  queue.update(t.id, { finishedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString() });

  queue.sweep();
  assert.equal(queue.getTask(t.id), null);
  assert.equal(queue.get().history[0].id, t.id);
});

test('A1.12 a corrupt queue file is quarantined instead of crashing the boot', () => {
  fresh();
  fs.writeFileSync(queue.QUEUE_FILE, '{ this is not json');
  queue._reset();

  const state = queue.get();
  assert.ok(state.loadError, 'the failure is surfaced, not swallowed silently');
  assert.deepEqual(state.tasks, []);
  const quarantined = fs
    .readdirSync(require('path').dirname(queue.QUEUE_FILE))
    .filter((f) => f.includes('.corrupt-'));
  assert.equal(quarantined.length, 1, 'the bad file is kept for forensics');
});

test('A1.13 every write leaves the file as valid JSON', () => {
  fresh();
  for (let i = 0; i < 20; i++) {
    queue.enqueue(CREATE(i));
    JSON.parse(fs.readFileSync(queue.QUEUE_FILE, 'utf8')); // throws if torn
  }
});

test('A1.14 finishedSince returns the window, oldest first', () => {
  fresh();
  const a = queue.enqueue(CREATE(1));
  const b = queue.enqueue(CREATE(2));
  queue.finish(a.id, 'success');
  queue.finish(b.id, 'failed', { error: 'x' });
  queue.update(a.id, { finishedAt: new Date(Date.now() - 60000).toISOString() });
  queue.update(b.id, { finishedAt: new Date().toISOString() });

  const old = queue.enqueue(CREATE(3));
  queue.finish(old.id, 'success');
  queue.update(old.id, { finishedAt: new Date(Date.now() - 72 * 3600 * 1000).toISOString() });

  const within = queue.finishedSince(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  assert.deepEqual(
    within.map((t) => t.id),
    [a.id, b.id],
  );
});

test('dedupe keys distinguish the different task types', () => {
  assert.equal(queue.dedupeKeyFor({ repo: 'r', type: 'create-pr', issueNumber: 9 }), 'r#9:create-pr');
  assert.equal(queue.dedupeKeyFor({ repo: 'r', type: 'sync-scan' }), 'r:sync-scan');
  assert.equal(
    queue.dedupeKeyFor({ repo: 'r', type: 'sync-branch', branch: 'feat' }),
    'r@feat:sync-branch',
  );
});

test('summary counts what the badge shows', () => {
  fresh();
  const a = queue.enqueue(CREATE(1));
  queue.enqueue(CREATE(2));
  const c = queue.enqueue(CREATE(3));
  queue.markRunning(a.id);
  queue.finish(c.id, 'failed', { error: 'x' });

  const s = queue.summary();
  assert.deepEqual(s, { queued: 1, running: 1, failed: 1, pending: 2 });
});
