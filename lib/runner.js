'use strict';

/**
 * Copilot CLI runner with SSE streaming.
 *
 * Spawns the local `copilot` binary, streams stdout/stderr to the browser as
 * Server-Sent Events, captures the full conversation transcript and the
 * `--resume=<id>` session id, and resolves with a summary when the process
 * exits. Shared by the "Create PR" (work) and "Deploy" actions.
 */

const { spawn } = require('child_process');

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

const RESUME_RE = /--resume=([0-9a-fA-F-]{8,})/;

/**
 * @param {object} opts
 * @param {import('http').ServerResponse} opts.res  SSE response (headers already written)
 * @param {string} opts.bin      copilot binary path
 * @param {string[]} opts.args   CLI args (prompt already included)
 * @param {string} opts.cwd      working directory (the repo)
 * @param {(id:string)=>void} [opts.onSession]  called when a session id is captured
 * @returns {Promise<{exitCode:number|null, conversation:string, sessionId:string|null}>}
 */
function runCopilotSSE({ res, bin, args, cwd, onSession }) {
  return new Promise((resolve) => {
    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let conversation = '';
    let sessionId = null;

    send('meta', { bin, args, cwd });

    let child;
    try {
      // CLOUD_COPILOT_JOB silences the Copilot CLI's generic sessionEnd ntfy
      // hook — cloud-copilot pushes its own, task-aware notification (#27).
      child = spawn(bin, args, { cwd, env: { ...process.env, CLOUD_COPILOT_JOB: '1' } });
    } catch (err) {
      send('error', { message: `Failed to spawn "${bin}": ${err.message}` });
      res.end();
      return resolve({ exitCode: null, conversation, sessionId });
    }

    const captureSession = (text) => {
      if (sessionId) return;
      const m = text.match(RESUME_RE);
      if (m) {
        sessionId = m[1];
        send('session', { sessionId });
        if (onSession) onSession(sessionId);
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString('utf8'));
      conversation += text;
      send('chunk', { stream: 'stdout', text });
    });

    child.stderr.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString('utf8'));
      conversation += text;
      captureSession(text);
      send('chunk', { stream: 'stderr', text });
    });

    child.on('error', (err) => {
      const message =
        err.code === 'ENOENT'
          ? `Could not find the Copilot CLI executable "${bin}".`
          : err.message;
      send('error', { message });
      conversation += `\n[spawn error] ${message}\n`;
      res.end();
      resolve({ exitCode: null, conversation, sessionId });
    });

    child.on('close', (code) => {
      // Note: caller sends its own 'done' (after computing success), so we only resolve.
      resolve({ exitCode: code, conversation, sessionId });
    });

    // Kill the child if the browser disconnects. Listen on the RESPONSE stream
    // (res 'close'), not the request — see server.js note.
    res.on('close', () => {
      if (child && !child.killed) child.kill('SIGTERM');
    });
  });
}

function writeSseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Prime the stream with a ~2KB comment. Mobile Safari (and some proxies) hold
  // a fetch/ReadableStream body in an internal buffer and don't surface bytes to
  // JS until that buffer fills or the connection closes. Small replies (e.g. a
  // one-line Admin Terminal answer) otherwise never appear until you refresh,
  // while a big Create-PR log fills the buffer on its own and streams fine.
  // Pushing 2KB up front gets past that threshold so every subsequent small
  // event is delivered immediately. (SSE comment lines start with ':'.)
  res.write(`:${' '.repeat(2048)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

module.exports = { runCopilotSSE, writeSseHead, stripAnsi };
