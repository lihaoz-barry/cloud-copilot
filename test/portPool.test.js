'use strict';

/**
 * Tests for the per-run TCP port pool (issue #64).
 *
 * The whole point of this module is that two runs never get the same port, so
 * that is what these check: concurrent acquires, the reserved control-plane
 * port, and giving ports back.
 *
 * Run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

// A narrow range keeps the tests fast and makes exhaustion observable.
process.env.CC_PORT_RANGE_START = process.env.CC_PORT_RANGE_START || '8400';
process.env.CC_PORT_RANGE_END = process.env.CC_PORT_RANGE_END || '8410';

const portPool = require('../lib/portPool');

test('concurrent acquires never hand out the same port', async () => {
  const ports = await Promise.all([
    portPool.acquire('a'),
    portPool.acquire('b'),
    portPool.acquire('c'),
    portPool.acquire('d'),
  ]);
  const real = ports.filter((p) => p != null);
  assert.strictEqual(real.length, ports.length, 'the range is wide enough for four runs');
  assert.strictEqual(new Set(real).size, real.length, 'every run got its own port');
  for (const p of real) {
    assert.ok(p >= portPool.RANGE_START && p <= portPool.RANGE_END);
    portPool.release(p);
  }
  assert.strictEqual(portPool.list().length, 0);
});

test('a released port becomes available again', async () => {
  const first = await portPool.acquire('one');
  assert.ok(first);
  assert.strictEqual(portPool.list().length, 1);
  assert.strictEqual(portPool.release(first), true);
  assert.strictEqual(portPool.release(first), false, 'releasing twice is a no-op');
  const second = await portPool.acquire('two');
  assert.strictEqual(second, first, 'the pool reuses the lowest free port');
  portPool.release(second);
});

test('release(null) is safe and reports nothing was freed', () => {
  assert.strictEqual(portPool.release(null), false);
  assert.strictEqual(portPool.release(undefined), false);
});

test('a port held by an unrelated process is skipped', async () => {
  const blocked = portPool.RANGE_START;
  const squatter = net.createServer();
  await new Promise((resolve, reject) => {
    squatter.once('error', reject);
    squatter.listen({ port: blocked, host: '0.0.0.0' }, resolve);
  });
  try {
    const got = await portPool.acquire('probe');
    assert.ok(got);
    assert.notStrictEqual(got, blocked, 'the bind probe noticed the squatter');
    portPool.release(got);
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
});

test('the pool never leases the port this server itself listens on', async () => {
  const previous = process.env.PORT;
  process.env.PORT = String(portPool.RANGE_START);
  try {
    const got = await portPool.acquire('self');
    assert.notStrictEqual(got, portPool.RANGE_START);
    portPool.release(got);
  } finally {
    if (previous === undefined) delete process.env.PORT;
    else process.env.PORT = previous;
  }
});
