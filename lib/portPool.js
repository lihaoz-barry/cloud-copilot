'use strict';

/**
 * TCP port pool for concurrent agent runs (issue #64).
 *
 * Once several Create PR runs execute at the same time, each one may want to
 * boot the app it is editing to test it. They cannot all use the repo's default
 * port, so every run leases a port for its lifetime and the prompt tells the
 * agent which one to use.
 *
 * Two things can steal a port and both are checked, in this order:
 *   1. another lease from this pool  — cheap in-memory set
 *   2. an unrelated process on the box — probed by actually binding the port
 *
 * Binding is the only honest test: `lsof` output is racy and platform-specific,
 * whereas a successful `listen()` on 0.0.0.0 proves the port is free right now.
 * The probe socket is closed immediately, so there is a tiny window where a
 * third party could win the port; the lease set makes that window irrelevant
 * between our own runs, which is the case that actually happens in practice.
 */

const net = require('net');

const RANGE_START = Number(process.env.CC_PORT_RANGE_START || 8000);
const RANGE_END = Number(process.env.CC_PORT_RANGE_END || 8888);

/** port -> { port, owner, at } */
const leases = new Map();

/** Ports the control plane itself uses and must never hand out. */
function reservedPorts() {
  const own = Number(process.env.PORT || 8787);
  return new Set([own]);
}

function probeFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const done = (free) => {
      server.removeAllListeners();
      try {
        server.close();
      } catch {
        /* already closed */
      }
      resolve(free);
    };
    server.once('error', () => done(false));
    server.once('listening', () => done(true));
    try {
      server.listen({ port, host: '0.0.0.0', exclusive: true });
    } catch {
      done(false);
    }
  });
}

/**
 * Lease a free port. Returns null when the whole range is taken — callers must
 * treat that as "run without a dedicated port" rather than as a failure, since
 * plenty of runs never start a server at all.
 *
 * @param {string} owner  free-form label (the job key) for diagnostics
 */
async function acquire(owner) {
  const reserved = reservedPorts();
  for (let port = RANGE_START; port <= RANGE_END; port += 1) {
    if (leases.has(port) || reserved.has(port)) continue;
    // Reserve optimistically before awaiting the probe, so two concurrent
    // acquires can never both settle on the same candidate.
    leases.set(port, { port, owner, at: Date.now() });
    // eslint-disable-next-line no-await-in-loop
    if (await probeFree(port)) return port;
    leases.delete(port);
  }
  return null;
}

function release(port) {
  if (port == null) return false;
  return leases.delete(Number(port));
}

/** Every currently leased port, for the running-tasks panel. */
function list() {
  return [...leases.values()];
}

module.exports = { acquire, release, list, RANGE_START, RANGE_END };
