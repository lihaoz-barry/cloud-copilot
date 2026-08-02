'use strict';

/**
 * Thin HTTP client for the cloud-scheduler supervisor on :8788.
 *
 * The dashboard used to spawn Copilot CLI processes itself, which is why
 * restarting it produced tasks stuck at "Deploying…" with an empty log and a
 * Stop button that returned 404: the child survived, its bookkeeping did not.
 * Now the dashboard asks the supervisor to start the process and streams the
 * log back, so the only thing a dashboard restart loses is a socket.
 *
 * Everything here is loopback-only and deliberately dependency-free — the
 * supervisor must be reachable before express is even listening, and must stay
 * reachable when the dashboard is mid-restart.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const HOST = process.env.CC_SUPERVISOR_HOST || '127.0.0.1';
const PORT = Number(process.env.CC_SUPERVISOR_PORT || process.env.SCHEDULER_PORT || 8788);
const BASE = `http://${HOST}:${PORT}`;

function request(method, pathname, body, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: HOST, port: PORT, path: pathname, method, headers, timeout }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = buf ? JSON.parse(buf) : null;
        } catch {
          /* a non-JSON body is reported through the status below */
        }
        if (res.statusCode >= 400) {
          const err = new Error((json && json.error) || `HTTP ${res.statusCode} from ${pathname}`);
          err.statusCode = res.statusCode;
          err.body = json;
          return reject(err);
        }
        resolve(json);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`supervisor timed out on ${pathname}`)));
    req.on('error', reject);
    req.end(payload);
  });
}

async function health() {
  return request('GET', '/api/health', undefined, { timeout: 2000 });
}

async function isUp() {
  try {
    await health();
    return true;
  } catch {
    return false;
  }
}

const spawnSession = (payload) => request('POST', '/api/sessions', payload, { timeout: 20000 });
const listSessions = ({ all = false } = {}) =>
  request('GET', `/api/sessions${all ? '?all=1' : ''}`, undefined, { timeout: 5000 });
const abortSession = (id) => request('POST', `/api/sessions/${encodeURIComponent(id)}/abort`);
const abortByKey = (key) => request('POST', '/api/sessions/abort-by-key', { key });

/**
 * Follow a session's log as Server-Sent Events.
 *
 * Reconnects on its own: the supervisor replays the log from the start on every
 * connection, so a dropped socket costs nothing but a moment — and the caller
 * is told to reset its transcript rather than concatenating a duplicate.
 *
 * @param {string} id
 * @param {object} handlers { onMeta, onChunk, onSession, onLive, onExit, onReplayStart }
 * @returns {() => void} stop following
 */
function streamSession(id, handlers = {}) {
  let closed = false;
  let req = null;
  let retryTimer = null;
  let attempts = 0;

  const connect = () => {
    if (closed) return;
    if (handlers.onReplayStart) handlers.onReplayStart();
    let buffer = '';
    req = http.request(
      {
        host: HOST,
        port: PORT,
        path: `/api/sessions/${encodeURIComponent(id)}/stream`,
        method: 'GET',
        headers: { accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return retry();
        }
        attempts = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          const frames = buffer.split('\n\n');
          buffer = frames.pop();
          for (const frame of frames) {
            const ev = /^event: (.+)$/m.exec(frame);
            const dt = /^data: (.+)$/m.exec(frame);
            if (!ev || !dt) continue;
            let data;
            try {
              data = JSON.parse(dt[1]);
            } catch {
              continue;
            }
            if (ev[1] === 'chunk' && handlers.onChunk) handlers.onChunk(data);
            else if (ev[1] === 'session' && handlers.onSession) handlers.onSession(data);
            else if (ev[1] === 'meta' && handlers.onMeta) handlers.onMeta(data);
            else if (ev[1] === 'live' && handlers.onLive) handlers.onLive(data);
            else if (ev[1] === 'exit') {
              closed = true;
              if (handlers.onExit) handlers.onExit(data);
            }
          }
        });
        res.on('end', () => {
          if (!closed) retry();
        });
        res.on('error', () => {
          if (!closed) retry();
        });
      },
    );
    req.on('error', () => {
      if (!closed) retry();
    });
    req.end();
  };

  const retry = () => {
    if (closed) return;
    attempts += 1;
    const delay = Math.min(500 * 2 ** Math.min(attempts, 5), 10000);
    retryTimer = setTimeout(connect, delay);
    if (retryTimer.unref) retryTimer.unref();
  };

  connect();
  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (req) {
      try {
        req.destroy();
      } catch {
        /* already gone */
      }
    }
  };
}

/**
 * Make sure a supervisor is running, starting one if not.
 *
 * Detached and unref'd on purpose: the process this launches has to outlive the
 * one launching it, since the whole point is that a dashboard restart does not
 * disturb the work. Started at most once per dashboard boot; if the port is
 * held by something that is not a supervisor, this fails loudly instead of
 * fighting it.
 */
async function ensureRunning({ root = path.join(__dirname, '..'), logFile } = {}) {
  if (await isUp()) return { started: false, reason: 'already running' };

  const script = path.join(root, 'scheduler-server.js');
  if (!fs.existsSync(script)) return { started: false, reason: `missing ${script}` };
  const out = fs.openSync(logFile || path.join(root, 'scheduler.log'), 'a');
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: process.env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.closeSync(out);

  // Give it a moment to bind; a supervisor that never answers is worth knowing
  // about at boot rather than at the first Create PR.
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
    // eslint-disable-next-line no-await-in-loop
    if (await isUp()) return { started: true, pid: child.pid };
  }
  return { started: false, reason: 'the supervisor did not answer within 10s', pid: child.pid };
}

module.exports = {
  BASE,
  HOST,
  PORT,
  getJson: (pathname, opts) => request('GET', pathname, undefined, opts),
  postJson: (pathname, body, opts) => request('POST', pathname, body || {}, opts),
  health,
  isUp,
  spawnSession,
  listSessions,
  abortSession,
  abortByKey,
  streamSession,
  ensureRunning,
};
