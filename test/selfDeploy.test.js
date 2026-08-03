'use strict';

/**
 * Tests for the self-deploy decision (issue #71).
 *
 * The question this module answers — "does this deploy also have to restart
 * cloud-scheduler?" — is exactly the kind that used to be answered by a human
 * remembering to run a second script. These cover the four cases that matter:
 * nothing changed, dashboard-only, scheduler-only, and both.
 *
 * Run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const selfDeploy = require('../lib/selfDeploy');

const APP_ROOT = '/srv/cloud-copilot';
const SELF = { type: 'shell', command: 'npm run cc:restart', selfDeploy: true };

const planFor = (files, deploy = SELF, repoPath = APP_ROOT) =>
  selfDeploy.planShellDeploy({ repoPath, appRoot: APP_ROOT, deploy, files });

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

test('no changed files means no scheduler restart', () => {
  const plan = planFor([]);
  assert.equal(plan.selfDeploy, true);
  assert.equal(plan.restartScheduler, false);
  assert.deepEqual(plan.matched, []);
  assert.match(plan.decisionLine, /no scheduler changes/);
});

test('dashboard-only changes never restart the scheduler', () => {
  const plan = planFor(['public/index.html', 'server.js', 'lib/store.js', 'README.md']);
  assert.equal(plan.restartScheduler, false);
  assert.deepEqual(plan.matched, []);
  assert.match(plan.decisionLine, /dashboard only/);
});

test('scheduler-only changes restart the scheduler and name the files', () => {
  const plan = planFor(['lib/supervisor.js']);
  assert.equal(plan.restartScheduler, true);
  assert.deepEqual(plan.matched, ['lib/supervisor.js']);
  assert.match(plan.decisionLine, /scheduler code changed \(lib\/supervisor\.js\)/);
  assert.match(plan.decisionLine, /restart cloud-scheduler after the dashboard/);
});

test('changes on both sides restart the scheduler and list only the scheduler files', () => {
  const plan = planFor([
    'public/index.html',
    'server.js',
    'lib/supervisor.js',
    'scheduler-server.js',
    'lib/store.js',
  ]);
  assert.equal(plan.restartScheduler, true);
  assert.deepEqual(plan.matched, ['lib/supervisor.js', 'scheduler-server.js']);
});

test('paths are normalised so ./ and leading slashes still match', () => {
  assert.deepEqual(selfDeploy.schedulerChanges(['./lib/supervisor.js', '/scheduler-server.js']), [
    'lib/supervisor.js',
    'scheduler-server.js',
  ]);
});

test('a configured directory matches everything beneath it, but not a prefix twin', () => {
  const patterns = ['lib/scheduler'];
  assert.deepEqual(selfDeploy.schedulerChanges(['lib/scheduler/queue.js'], patterns), [
    'lib/scheduler/queue.js',
  ]);
  assert.deepEqual(selfDeploy.schedulerChanges(['lib/schedulerCore.js'], patterns), []);
});

test('a * wildcard matches within one path segment only', () => {
  const patterns = ['lib/supervisor*.js'];
  assert.deepEqual(
    selfDeploy.schedulerChanges(['lib/supervisor.js', 'lib/supervisorClient.js'], patterns),
    ['lib/supervisor.js', 'lib/supervisorClient.js'],
  );
  assert.deepEqual(selfDeploy.schedulerChanges(['lib/nested/supervisor.js'], patterns), []);
});

test('custom paths replace the defaults', () => {
  const deploy = { ...SELF, scheduler: { command: 'make restart-sched', paths: ['worker.js'] } };
  const scheduler = planFor(['worker.js'], deploy);
  assert.equal(scheduler.restartScheduler, true);
  assert.equal(scheduler.schedulerCommand, 'make restart-sched');
  assert.equal(planFor(['lib/supervisor.js'], deploy).restartScheduler, false);
});

// ---------------------------------------------------------------------------
// Who is self-deploying
// ---------------------------------------------------------------------------

test('a repo that is not this process\u2019s app root behaves exactly as before', () => {
  const plan = selfDeploy.planShellDeploy({
    repoPath: '/srv/repos/other-app',
    appRoot: APP_ROOT,
    deploy: { type: 'shell', command: 'make deploy' },
    files: ['lib/supervisor.js', 'scheduler-server.js'],
  });
  assert.equal(plan.selfDeploy, false);
  assert.equal(plan.restartScheduler, false);
  assert.equal(plan.schedulerCommand, null);
  assert.equal(plan.decisionLine, '');
});

test('the app root self-deploys without any explicit flag', () => {
  assert.equal(selfDeploy.isSelfDeploy(`${APP_ROOT}/`, { type: 'shell' }, APP_ROOT), true);
  assert.equal(selfDeploy.isSelfDeploy('/srv/repos/x', { type: 'shell' }, APP_ROOT), false);
});

test('an explicit selfDeploy flag wins over the path check', () => {
  assert.equal(selfDeploy.isSelfDeploy('/srv/repos/x', { selfDeploy: true }, APP_ROOT), true);
  assert.equal(selfDeploy.isSelfDeploy(APP_ROOT, { selfDeploy: false }, APP_ROOT), false);
});

test('the default scheduler command is used when none is configured', () => {
  assert.equal(planFor(['lib/supervisor.js']).schedulerCommand, 'npm run cc:restart-scheduler');
});

test('a diff we could not read restarts the scheduler rather than assuming nothing changed', () => {
  const plan = selfDeploy.planShellDeploy({
    repoPath: APP_ROOT,
    appRoot: APP_ROOT,
    deploy: SELF,
    files: [],
    diffError: 'fatal: bad object',
  });
  assert.equal(plan.restartScheduler, true);
  assert.match(plan.decisionLine, /could not diff/);
});

test('a deploy whose base commit is unknown restarts the scheduler', () => {
  // BOOT_CODE.head can be null (a checkout without git metadata, a boot that
  // could not read HEAD). "We don't know what changed" must never be reduced to
  // "nothing changed", which would leave a stale scheduler running.
  const diff = selfDeploy.changedFiles('/srv/cloud-copilot', null, 'abc1234');
  assert.deepEqual(diff.files, []);
  assert.ok(diff.error, 'a missing base commit is an error, not an empty diff');
  const plan = selfDeploy.planShellDeploy({
    repoPath: APP_ROOT,
    appRoot: APP_ROOT,
    deploy: SELF,
    files: diff.files,
    diffError: diff.error,
  });
  assert.equal(plan.restartScheduler, true);
});

test('a deploy whose head commit is unknown restarts the scheduler', () => {
  const diff = selfDeploy.changedFiles('/srv/cloud-copilot', 'abc1234', null);
  assert.ok(diff.error);
  assert.equal(
    selfDeploy.planShellDeploy({
      repoPath: APP_ROOT,
      appRoot: APP_ROOT,
      deploy: SELF,
      files: [],
      diffError: diff.error,
    }).restartScheduler,
    true,
  );
});

// ---------------------------------------------------------------------------
// The verdict on the transcript — the only result a two-phase deploy has
// ---------------------------------------------------------------------------

test('the transcript verdict is read back, and absent when never printed', () => {
  assert.equal(selfDeploy.resultFromTranscript(`x\n${selfDeploy.RESULT_MARKER} success\n`), 'success');
  assert.equal(selfDeploy.resultFromTranscript(`x\n${selfDeploy.RESULT_MARKER} failed\n`), 'failed');
  assert.equal(selfDeploy.resultFromTranscript('dashboard restarted\ndeploy succeeded\n'), null);
  assert.equal(selfDeploy.resultFromTranscript(''), null);
  assert.equal(selfDeploy.resultFromTranscript(undefined), null);
});

test('a replayed transcript is judged by its last verdict', () => {
  // A supervisor restart makes the dashboard reconnect and replay the log from
  // the beginning, so the same lines legitimately appear more than once.
  const t = `${selfDeploy.RESULT_MARKER} success\n${selfDeploy.RESULT_MARKER} success\n`;
  assert.equal(selfDeploy.resultFromTranscript(t), 'success');
  assert.equal(
    selfDeploy.resultFromTranscript(`${selfDeploy.RESULT_MARKER} success\n${selfDeploy.RESULT_MARKER} failed\n`),
    'failed',
  );
});

// ---------------------------------------------------------------------------
// The diff itself, against a real git repo
// ---------------------------------------------------------------------------

test('changedFiles reports what a real commit touched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-selfdeploy-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'server.js'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');

    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'supervisor.js'), 'two\n');
    git('add', '-A');
    git('commit', '-qm', 'scheduler change');
    const head = git('rev-parse', 'HEAD');

    const diff = selfDeploy.changedFiles(dir, base, head);
    assert.equal(diff.error, null);
    assert.deepEqual(diff.files, ['lib/supervisor.js']);
    assert.equal(selfDeploy.planShellDeploy({
      repoPath: dir,
      appRoot: dir,
      deploy: SELF,
      files: diff.files,
    }).restartScheduler, true);

    // Same commit on both sides: nothing to deploy, nothing to restart.
    assert.deepEqual(selfDeploy.changedFiles(dir, head, head).files, []);
    // A revision that does not exist is an error, not an empty diff.
    assert.ok(selfDeploy.changedFiles(dir, 'deadbeef', head).error);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
