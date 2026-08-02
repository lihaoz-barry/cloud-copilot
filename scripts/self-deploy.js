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

const ROOT = path.resolve(__dirname, '..');
const SCHEDULER_PORT = Number(process.env.CC_SUPERVISOR_PORT || process.env.SCHEDULER_PORT || 8788);
const SCHEDULER_HOST = process.env.CC_SUPERVISOR_HOST || '127.0.0.1';
const SCHEDULER_LOG = path.join(ROOT, 'scheduler.log');

function log(line) {
  process.stdout.write(`${line}\n`);
}

function fail(line) {
  process.stderr.write(`${line}\n`);
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

function health(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: SCHEDULER_HOST, port: SCHEDULER_PORT, path: '/api/health', timeout: timeoutMs },
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(totalMs = 30000) {
  const deadline = Date.now() + totalMs;
  for (;;) {
    const h = await health();
    if (h && h.ok) return h;
    if (Date.now() >= deadline) return null;
    await sleep(500);
  }
}

/**
 * How many running sessions the new supervisor has adopted.
 *
 * Adoption is a startup step, so a health response can arrive a beat before the
 * count settles; give it a moment rather than failing a deploy on a race.
 */
async function waitForAdoption(expected, totalMs = 15000) {
  const deadline = Date.now() + totalMs;
  let best = 0;
  for (;;) {
    const h = await health();
    const count = h && typeof h.sessions === 'number' ? h.sessions : 0;
    if (count > best) best = count;
    if (best >= expected || Date.now() >= deadline) return best;
    await sleep(500);
  }
}

function tailSchedulerLog(lines = 30) {  try {
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
    fail('the plan has no dashboardCommand');
    process.exit(2);
  }

  log('=== Phase 1/2: dashboard ===');
  if (plan.decisionLine) log(plan.decisionLine);
  if (plan.base && plan.head) log(`comparing deployed ${plan.base.slice(0, 8)}..${plan.head.slice(0, 8)}`);
  log(`$ ${dashboardCommand}`);
  const dashCode = await run(dashboardCommand);
  if (dashCode !== 0) {
    fail(`dashboard restart failed (exit ${dashCode}) — deploy failed`);
    process.exit(dashCode);
  }
  log('dashboard restarted');

  if (!plan.restartScheduler) {
    log('=== Phase 2/2: cloud-scheduler — skipped (no scheduler changes) ===');
    log('deploy succeeded');
    return;
  }

  log('=== Phase 2/2: cloud-scheduler ===');
  if (plan.matched && plan.matched.length) log(`scheduler files changed: ${plan.matched.join(', ')}`);

  const before = await health();
  const beforeCount = before && typeof before.sessions === 'number' ? before.sessions : 0;
  if (!before) {
    log(`cloud-scheduler is not answering on :${SCHEDULER_PORT} before the restart — starting it`);
  } else {
    log(
      `${beforeCount} running Copilot session(s) before the restart — they are detached and keep ` +
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
    process.exit(schedCode);
  }

  const after = await waitForHealth(30000);
  if (!after) {
    fail(`cloud-scheduler did not answer on :${SCHEDULER_PORT} within 30s — deploy failed`);
    dumpSchedulerLog();
    process.exit(1);
  }

  const afterCount = await waitForAdoption(beforeCount, 15000);
  if (afterCount < beforeCount) {
    fail(
      `cloud-scheduler is up (pid ${after.pid}) but adopted only ${afterCount} of the ${beforeCount} ` +
        'running session(s) — deploy failed',
    );
    dumpSchedulerLog();
    process.exit(1);
  }

  log(`cloud-scheduler up on :${SCHEDULER_PORT} (pid ${after.pid}), ${afterCount} running session(s) adopted`);
  log('deploy succeeded');
}

main().catch((err) => {
  fail(`self-deploy crashed: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
