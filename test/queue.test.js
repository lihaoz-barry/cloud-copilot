'use strict';

/**
 * Queue semantics: FIFO, concurrency cap, cancellation, position bookkeeping
 * and restart persistence.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { WorkQueue } = require('../lib/queue');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-queue-')), 'queue.json');
}

function makeQueue(maxConcurrent = 2) {
  const file = tmpFile();
  const started = [];
  const q = new WorkQueue({ file, maxConcurrent, start: async (item) => { started.push(item.id); } });
  return { q, started, file };
}

test('runs up to maxConcurrent and queues the rest in FIFO order', async () => {
  const { q, started } = makeQueue(2);
  const a = q.enqueue({ repo: 'r', issueNumber: 1 });
  const b = q.enqueue({ repo: 'r', issueNumber: 2 });
  const c = q.enqueue({ repo: 'r', issueNumber: 3 });
  const d = q.enqueue({ repo: 'r', issueNumber: 4 });

  await q.pump();

  assert.deepStrictEqual(started, [a.id, b.id]);
  assert.strictEqual(q.runningCount(), 2);
  assert.strictEqual(q.positionOf(c.id), 1);
  assert.strictEqual(q.positionOf(d.id), 2);
  assert.strictEqual(q.positionOf(a.id), null, 'running entries have no queue position');

  // One finishes → the head of the queue starts and everyone shuffles up.
  q.finish(a.id);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(started, [a.id, b.id, c.id]);
  assert.strictEqual(q.positionOf(d.id), 1);
});

test('enqueue is idempotent per repo+issue', () => {
  const { q } = makeQueue(2);
  const a = q.enqueue({ repo: 'r', issueNumber: 1 });
  const again = q.enqueue({ repo: 'r', issueNumber: 1 });
  assert.strictEqual(again.id, a.id);
  assert.strictEqual(q.items.length, 1);
  // A different repo with the same issue number is a different entry.
  assert.notStrictEqual(q.enqueue({ repo: 'other', issueNumber: 1 }).id, a.id);
});

test('removing a queued entry renumbers the ones behind it', async () => {
  const { q } = makeQueue(1);
  q.enqueue({ repo: 'r', issueNumber: 1 });
  const b = q.enqueue({ repo: 'r', issueNumber: 2 });
  const c = q.enqueue({ repo: 'r', issueNumber: 3 });
  await q.pump();

  assert.strictEqual(q.positionOf(c.id), 2);
  q.remove(b.id);
  assert.strictEqual(q.positionOf(c.id), 1);
});

test('a failing starter frees its slot instead of wedging the queue', async () => {
  const file = tmpFile();
  const started = [];
  const q = new WorkQueue({
    file,
    maxConcurrent: 1,
    start: async (item) => {
      started.push(item.id);
      if (item.issueNumber === 1) throw new Error('worktree exploded');
    },
  });
  q.enqueue({ repo: 'r', issueNumber: 1 });
  const b = q.enqueue({ repo: 'r', issueNumber: 2 });

  await q.pump();

  assert.strictEqual(started.length, 2, 'the second entry still got its turn');
  assert.strictEqual(q.find(b.id).status, 'running');
});

test('the queue file survives a restart, dropping entries that were running', async () => {
  const { q, file } = makeQueue(1);
  q.enqueue({ repo: 'r', issueNumber: 1, title: 'first' });
  q.enqueue({ repo: 'r', issueNumber: 2, title: 'second' });
  q.enqueue({ repo: 'r', issueNumber: 3, title: 'third' });
  await q.pump();
  assert.strictEqual(q.runningCount(), 1);

  // New process, same file.
  const restarted = new WorkQueue({ file, maxConcurrent: 1, start: async () => {} });
  const restored = restarted.load();
  const restoredIds = restored.map((i) => i.id);
  assert.deepStrictEqual(restored.map((i) => i.issueNumber), [2, 3]);
  assert.ok(restored.every((i) => i.status === 'queued'));

  // Ids keep incrementing so a restored entry can't collide with a new one.
  const fresh = restarted.enqueue({ repo: 'r', issueNumber: 9 });
  assert.ok(!restoredIds.includes(fresh.id));
});

test('snapshot lists running first, then the queue in order', async () => {
  const { q } = makeQueue(1);
  q.enqueue({ repo: 'r', issueNumber: 1, title: 'a' });
  q.enqueue({ repo: 'r', issueNumber: 2, title: 'b' });
  await q.pump();

  const snap = q.snapshot();
  assert.strictEqual(snap.maxConcurrent, 1);
  assert.strictEqual(snap.runningCount, 1);
  assert.strictEqual(snap.queuedCount, 1);
  assert.deepStrictEqual(snap.items.map((i) => i.status), ['running', 'queued']);
  assert.deepStrictEqual(snap.items.map((i) => i.position), [null, 1]);
});
