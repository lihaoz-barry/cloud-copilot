#!/usr/bin/env node
'use strict';

/**
 * The two-phase self-deploy of cloud-copilot.
 *
 * Phase 1 always restarts the dashboard (:8787). Phase 2 restarts
 * cloud-scheduler (:8788) — but only when the server decided that this change
 * touches scheduler code (see lib/selfDeploy.js); the decision is handed over
 * as JSON in CC_SELF_DEPLOY_PLAN, never assembled here out of shell strings.
 *
 * Why a separate process at all: both phases replace processes that would
 * otherwise be running this code. The deploy itself is a supervised, detached
 * session, so it outlives the dashboard *and* the scheduler it restarts and can
 * still report the truth about both.
 *
 * The scheduler restart is the delicate half. Running Copilot sessions must not
 * be interrupted: they are detached, they write their own logs, and the new
 * supervisor re-adopts them from data/sessions/index.json. scripts/
 * restart-scheduler.sh keeps that safe (SIGTERM to the scheduler pid only,
 * identified by the port it holds and verified by its command line). What this
 * script adds is proof: it counts running sessions before, and fails the deploy
 * if the replacement does not come back with at least as many.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { RESULT_MARKER } = require('../lib/selfDeploy');

const ROOT = path.resolve(__dirname, '..');
const SCHEDULER_PORT = Number(process.env.CC_SUPERVISOR_PORT || process.env.SCHEDULER_PORT || 8788);
const SCHEDULER_HOST = process.env.CC_SUPERVISOR_HOST || '127.0.0.1';
const SCHEDULER_LOG = path.join(ROOT, 'scheduler.log');
// Overridable so the test suite does not have to wait out a real restart.
const HEALTH_TIMEOUT_MS = Number(process.env.CC_SELF_DEPLOY_HEALTH_TIMEOUT_MS || 30000);
const ADOPT_TIMEOUT_MS = Number(process.env.CC_SELF_DEPLOY_ADOPT_TIMEOUT_MS || 15000);
const POLL_MS = Number(process.env.CC_SELF_DEPLOY_POLL_MS || 500);

/**
 * Write synchronously: the verdict below has to be on disk before process.exit,
 * and `process.stdout.write` only guarantees that when stdout happens to be a
 * file. Under the supervisor it is one, but a plain pipe would drop the last
 * line — the one line that decides whether the deploy succeeded.
 */
function writeLine(fd, line) {
  try {
    fs.writeSync(fd, `${line}\n`);
  } catch {
    (fd === 1 ? process.stdout : process.stderr).write(`${line}\n`);
  }
}

function log(line) {
  writeLine(1, line);
}

function fail(line) {
  writeLine(2, line);
}

/**
 * Report the verdict and leave.
 *
 * The exit code is the truth only while the supervisor that spawned this
 * process is still alive — and phase 2 deliberately replaces it. The marker on
 * the transcript is what survives, so it is written last and always, including
 * on the paths that exit non-zero. See lib/selfDeploy.js.
 */
function done(ok, reason) {
  if (reason) (ok ? log : fail)(reason);
  log(`${RESULT_MARKER} ${ok ? 'success' : 'failed'}`);
  process.exit(ok ? 0 : 1);
}

function readPlan() {
  const raw = process.env.CC_SELF_DEPLOY_PLAN;
  if (!raw) {
    fail('CC_SELF_DEPLOY_PLAN is missing — refusing to guess what to deploy');
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`CC_SELF_DEPLOY_PLAN is not valid JSON: ${err.message}`);
    return process.exit(2);
  }
}

function run(command) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', (err) => {
      fail(`failed to run "${command}": ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code == null ? 1 : code));
  });
}

function getJson(urlPath, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: SCHEDULER_HOST, port: SCHEDULER_PORT, path: urlPath, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
  });
}

const health = (timeoutMs) => getJson('/api/health', timeoutMs);

/** Every session the supervisor knows about, running or not. */
async function listSessions({ all = false } = {}) {
  const out = await getJson(`/api/sessions${all ? '?all=1' : ''}`);
  return out && Array.isArray(out.sessions) ? out.sessions : null;
}

/**
 * Is that pid still there? EPERM means "yes, and not ours to signal", which is
 * still alive.
 */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(totalMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + totalMs;
  for (;;) {
    const h = await health();
    if (h && h.ok) return h;
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

/**
 * Did the replacement supervisor pick every running session back up?
 *
 * Deliberately not a head count. Sessions finish on their own schedule, and a
 * Copilot run that simply completed during the restart window would make
 * "fewer than before" true without anything being wrong. So each session is
 * checked by identity: it is fine if the new supervisor lists it as running, and
 * equally fine if its pid is gone (it ended, and the supervisor recorded that).
 * What is not fine is a process that is still alive with nobody watching it —
 * that is the lost session this whole phase exists to rule out.
 *
 * Adoption is a startup step, so give it a moment rather than failing a deploy
 * on a race with it.
 *
 * @param {Array<{id:string,pid:number,key?:string}>} before sessions running before the restart
 * @returns {Promise<{ok:boolean, adopted:number, ended:number, lost:Array, error:string|null}>}
 */
async function waitForAdoption(before, totalMs = ADOPT_TIMEOUT_MS) {
  const deadline = Date.now() + totalMs;
  let last = { ok: false, adopted: 0, ended: 0, lost: [], error: 'the supervisor did not list its sessions' };
  for (;;) {
    const now = await listSessions({ all: true });
    if (now) {
      const byId = new Map(now.map((s) => [s.id, s]));
      const lost = [];
      let adopted = 0;
      let ended = 0;
      for (const s of before) {
        const found = byId.get(s.id);
        if (found && found.status === 'running') adopted += 1;
        else if (!pidAlive(s.pid)) ended += 1;
        else lost.push(s);
      }
      last = { ok: lost.length === 0, adopted, ended, lost, error: null };
      if (last.ok) return last;
    }
    if (Date.now() >= deadline) return last;
    await sleep(POLL_MS);
  }
}

function tailSchedulerLog(lines = 30) {
  try {
    const text = fs.readFileSync(SCHEDULER_LOG, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch (err) {
    return `(could not read ${SCHEDULER_LOG}: ${err.message})`;
  }
}

function dumpSchedulerLog() {
  fail(`--- last 30 lines of ${SCHEDULER_LOG} ---`);
  fail(tailSchedulerLog());
  fail('--- end of scheduler.log ---');
}

async function main() {
  const plan = readPlan();
  const dashboardCommand = plan.dashboardCommand;
  if (typeof dashboardCommand !== 'string' || !dashboardCommand.trim()) {
    done(false, 'the plan has no dashboardCommand');
  }

  log('=== Phase 1/2: dashboard ===');
  if (plan.decisionLine) log(plan.decisionLine);
  if (plan.base && plan.head) log(`comparing deployed ${plan.base.slice(0, 8)}..${plan.head.slice(0, 8)}`);
  log(`$ ${dashboardCommand}`);
  const dashCode = await run(dashboardCommand);
  if (dashCode !== 0) {
    done(false, `dashboard restart failed (exit ${dashCode}) — deploy failed`);
  }
  log('dashboard restarted');

  if (!plan.restartScheduler) {
    log('=== Phase 2/2: cloud-scheduler — skipped (no scheduler changes) ===');
    done(true, 'deploy succeeded');
  }

  log('=== Phase 2/2: cloud-scheduler ===');
  if (plan.matched && plan.matched.length) log(`scheduler files changed: ${plan.matched.join(', ')}`);

  // Who is running right now, by identity — the list the replacement supervisor
  // has to account for. An unreachable scheduler has nothing to lose.
  const before = (await listSessions()) || [];
  if (!(await health())) {
    log(`cloud-scheduler is not answering on :${SCHEDULER_PORT} before the restart — starting it`);
  } else {
    log(
      `${before.length} running Copilot session(s) before the restart — they are detached and keep ` +
        'running; the new supervisor re-adopts them from data/sessions/index.json, so work already ' +
        'in flight is unaffected',
    );
  }

  const schedulerCommand = plan.schedulerCommand || 'npm run cc:restart-scheduler';
  log(`$ ${schedulerCommand}`);
  const schedCode = await run(schedulerCommand);
  if (schedCode !== 0) {
    fail(`cloud-scheduler restart failed (exit ${schedCode}) — deploy failed`);
    dumpSchedulerLog();
    done(false);
  }

  const after = await waitForHealth();
  if (!after) {
    fail(`cloud-scheduler did not answer on :${SCHEDULER_PORT} within ${Math.round(HEALTH_TIMEOUT_MS / 1000)}s — deploy failed`);
    dumpSchedulerLog();
    done(false);
  }

  const adoption = await waitForAdoption(before);
  if (!adoption.ok) {
    const detail = adoption.error
      ? adoption.error
      : `${adoption.lost.length} still-running session(s) were not picked up: ` +
        adoption.lost.map((s) => `${s.id}${s.key ? ` (${s.key})` : ''} pid ${s.pid}`).join(', ');
    fail(`cloud-scheduler is up (pid ${after.pid}) but ${detail} — deploy failed`);
    dumpSchedulerLog();
    done(false);
  }

  log(
    `cloud-scheduler up on :${SCHEDULER_PORT} (pid ${after.pid}), ` +
      `${adoption.adopted} running session(s) adopted` +
      (adoption.ended ? `, ${adoption.ended} finished during the restart` : ''),
  );
  done(true, 'deploy succeeded');
}

main().catch((err) => {
  done(false, `self-deploy crashed: ${err && err.stack ? err.stack : err}`);
});
