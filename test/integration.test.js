'use strict';

/**
 * End-to-end-ish coverage of a create-pr task, using a fake `copilot` binary.
 *
 * Everything except the agent itself is real: real git, real worktrees, the
 * real job manager (spawn, process group, SSE plumbing), the real queue file.
 * The fake binary just prints a PR URL and exits — so this exercises the whole
 * path without spending tokens or hitting GitHub.
 */

const helpers = require('./helpers');
const sandboxDir = helpers.sandbox('cc-int-');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const reposRoot = path.join(sandboxDir, 'repos');
fs.mkdirSync(reposRoot, { recursive: true });

fs.writeFileSync(
  process.env.CC_QUEUE_CONFIG,
  JSON.stringify({
    worktreeRoot: path.join(sandboxDir, 'worktrees'),
    taskTimeoutMinutes: 1,
    repos: {},
  }),
);

const queue = require('../lib/queue');
const jobs = require('../lib/jobs');
const gh = require('../lib/gh');
const store = require('../lib/store');
const worktree = require('../lib/worktree');
const scheduler = require('../lib/scheduler');

const repo = helpers.makeRepo(reposRoot, 'demo');
fs.writeFileSync(
  path.join(repo.path, '.cloud-copilot.json'),
  JSON.stringify({ worktree: { port: 9321 } }),
);
helpers.git(repo.path, ['add', '-A']);
helpers.git(repo.path, ['-c', 'user.email=t@e.c', '-c', 'user.name=t', 'commit', '-qm', 'cfg']);
helpers.git(repo.path, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

// --- stub the GitHub reads -------------------------------------------------
// The scheduler re-checks preconditions against `gh` right before it runs a
// task; these stubs stand in for the CLI.
let openIssues = [{ number: 7, title: 'do the thing', labels: [{ name: 'committed' }] }];
let openPrs = [];
gh.listIssues = async () => ({ issues: openIssues, cached: false, at: Date.now() });
gh.listAllPrs = async () => ({ prs: openPrs, cached: false, at: Date.now() });
store.isDismissed = () => false;

// --- a startWorkJob that mirrors server.js's bookkeeping --------------------
let lastSpawn = null;
function makeStartWorkJob(fakeBin, { prNumber = 123, succeed = true } = {}) {
  return (r, n, { cwd, branch, port } = {}) => {
    lastSpawn = { cwd, branch, port };
    const key = `${r.name}#${n}:work`;
    store.updateRecord(r.name, n, (rec) => {
      rec.work.status = 'working';
      rec.work.startedAt = new Date().toISOString();
    });
    return jobs.startJob(key, {
      bin: fakeBin,
      args: ['-p', 'implement'],
      cwd,
      env: port ? { PORT: String(port) } : undefined,
      meta: { action: 'work', worktree: Boolean(cwd && cwd !== r.path), branch },
      onDone: async (j) => {
        const ok = succeed && /\/pull\/(\d+)/.test(j.conversation);
        store.updateRecord(r.name, n, (rec) => {
          rec.work.status = j.cancelled ? 'aborted' : ok ? 'success' : 'failed';
          rec.work.exitCode = j.exitCode;
          rec.work.conversation = j.conversation;
          rec.work.prNumber = ok ? prNumber : null;
          rec.work.prUrl = ok ? `https://github.com/${r.ownerRepo}/pull/${prNumber}` : null;
          rec.work.finishedAt = new Date().toISOString();
        });
        return { action: 'work', status: ok ? 'success' : 'failed' };
      },
    });
  };
}

function enqueueCreatePr(n = 7) {
  return queue.enqueue(
    {
      repo: repo.name,
      type: 'create-pr',
      issueNumber: n,
      title: `#${n} do the thing`,
      jobKey: `${repo.name}#${n}:work`,
    },
    { force: true },
  );
}

test('B1/B2/B7 a create-pr task runs in the worktree, on its branch, with its port', async () => {
  const bin = helpers.fakeCopilot(sandboxDir, {
    stdout: 'Opened https://github.com/test-owner/test-repo/pull/123',
    echoPort: true,
  });
  scheduler.setDeps({
    reposRoot,
    copilotBin: bin,
    startWorkJob: makeStartWorkJob(bin),
    resolveModel: () => 'test-model',
  });

  const task = enqueueCreatePr(7);
  await scheduler.runTask(task);

  const done = queue.getTask(task.id);
  assert.equal(done.status, 'success', done.error || '');
  assert.equal(done.prNumber, 123);

  // B7: the port reached both the prompt caller and the child's environment.
  assert.equal(lastSpawn.port, 9321);
  assert.equal(lastSpawn.branch, 'cc/issue-7');
  assert.equal(lastSpawn.cwd, worktree.pathFor('demo'));

  const transcript = store.getRecord('demo', 7).work.conversation;
  assert.match(transcript, /PORT=9321/, 'PORT is exported to the agent process');
  assert.match(transcript, /cwd=/);
});

test('B10/A3.8 after the task, the MAIN tree can check out the branch it created', () => {
  // The branch must not still be owned by the worktree, or a later Deploy —
  // which does `git checkout <prBranch>` on the main checkout — would fail.
  assert.equal(worktree.currentBranch(repo), null, 'the worktree detached on the way out');
  helpers.git(repo.path, ['checkout', '-q', 'cc/issue-7']);
  assert.equal(helpers.git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'cc/issue-7');
  helpers.git(repo.path, ['checkout', '-q', 'main']);
});

test('B8/B9 a queued run does NOT hold the main-tree lock', () => {
  // server.js filters jobs whose meta.worktree is set out of the working-tree
  // lock. Re-implemented here against the same data so the contract is pinned.
  const job = jobs.getJob('demo#7:work');
  assert.ok(job, 'the job is still retained');
  assert.equal(job.meta.worktree, true, 'a queued run is marked as living in a worktree');

  const heldByMainTree = jobs
    .runningKeys()
    .filter((k) => !(jobs.getJob(k) && jobs.getJob(k).meta && jobs.getJob(k).meta.worktree));
  assert.deepEqual(heldByMainTree, [], 'nothing the queue did blocks Deploy/Merge/Chat');
});

test('B3 no PR opened → failed, and the issue enters cooldown', async () => {
  const bin = helpers.fakeCopilot(sandboxDir, { stdout: 'I could not do it', exitCode: 1 });
  scheduler.setDeps({
    reposRoot,
    copilotBin: bin,
    startWorkJob: makeStartWorkJob(bin, { succeed: false }),
    resolveModel: () => 'test-model',
  });
  openIssues = [{ number: 8, title: 'doomed', labels: [{ name: 'committed' }] }];

  const task = enqueueCreatePr(8);
  await scheduler.runTask(task);

  const done = queue.getTask(task.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /no pull request/i);
  assert.ok(
    queue.isCoolingDown({ repo: 'demo', type: 'create-pr', issueNumber: 8 }),
    'a failed issue must not be picked up again by the next scan',
  );
});

test('preconditions are re-checked at run time: a pulled label means skipped', async () => {
  const bin = helpers.fakeCopilot(sandboxDir, { stdout: 'should never run' });
  scheduler.setDeps({
    reposRoot,
    copilotBin: bin,
    startWorkJob: makeStartWorkJob(bin),
    resolveModel: () => 'test-model',
  });
  openIssues = [{ number: 9, title: 'label pulled', labels: [{ name: 'wontfix' }] }];

  const task = enqueueCreatePr(9);
  await scheduler.runTask(task);

  const done = queue.getTask(task.id);
  assert.equal(done.status, 'skipped');
  assert.match(done.error, /label was removed/);
  assert.equal(
    queue.isCoolingDown({ repo: 'demo', type: 'create-pr', issueNumber: 9 }),
    false,
    'skipping is not failing',
  );
});

test('an issue that gained a PR in the meantime is skipped', async () => {
  const bin = helpers.fakeCopilot(sandboxDir, { stdout: 'should never run' });
  scheduler.setDeps({
    reposRoot,
    copilotBin: bin,
    startWorkJob: makeStartWorkJob(bin),
    resolveModel: () => 'test-model',
  });
  openIssues = [{ number: 10, title: 'already handled', labels: [{ name: 'committed' }] }];
  openPrs = [{ number: 55, headRefName: 'x', title: 'fix', body: 'Closes #10' }];

  const task = enqueueCreatePr(10);
  await scheduler.runTask(task);

  assert.equal(queue.getTask(task.id).status, 'skipped');
  assert.match(queue.getTask(task.id).error, /PR already exists/);
  openPrs = [];
});

test('B4 cancelling a running task kills it and records it as cancelled', async () => {
  const bin = helpers.fakeCopilot(sandboxDir, { stdout: 'slow', sleepSeconds: 30 });
  scheduler.setDeps({
    reposRoot,
    copilotBin: bin,
    startWorkJob: makeStartWorkJob(bin, { succeed: false }),
    resolveModel: () => 'test-model',
  });
  openIssues = [{ number: 11, title: 'long one', labels: [{ name: 'committed' }] }];

  const task = enqueueCreatePr(11);
  const running = scheduler.runTask(task);

  // Wait for the child to actually exist, then abort it the way the UI does.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(queue.getTask(task.id).status, 'running');
  assert.equal(jobs.cancelJob('demo#11:work'), true);

  await running;
  assert.equal(queue.getTask(task.id).status, 'cancelled');
});

test('B6 a task interrupted by a restart is re-run exactly once', () => {
  // Simulates: process died mid-task, queue.json survives, server boots again.
  const task = enqueueCreatePr(12);
  queue.markRunning(task.id);

  queue._reset(); // as if a fresh process re-read the file
  const first = queue.reconcile();
  assert.equal(first.requeued, 1);
  assert.equal(queue.getTask(task.id).status, 'queued');
  assert.equal(queue.getTask(task.id).attempt, 2);

  queue.markRunning(task.id);
  queue._reset();
  const second = queue.reconcile();
  assert.equal(second.failed, 1, 'a second interruption is not retried again');
  assert.equal(queue.getTask(task.id).status, 'failed');
});

test('scanRepoIssues queues only labelled issues without a PR', async () => {
  queue._reset();
  openIssues = [
    { number: 20, title: 'wanted', labels: [{ name: 'committed' }] },
    { number: 21, title: 'unlabelled', labels: [] },
    { number: 22, title: 'other label', labels: [{ name: 'bug' }] },
    { number: 23, title: 'has a PR', labels: [{ name: 'committed' }] },
  ];
  openPrs = [{ number: 90, headRefName: 'b', title: 't', body: 'Fixes #23' }];

  const added = await scheduler.scanRepoIssues(repo);
  assert.equal(added, 1);
  const queued = queue.tasksForRepo('demo').filter((t) => t.status === 'queued');
  assert.deepEqual(queued.map((t) => t.issueNumber), [20]);

  // A second scan must not duplicate it.
  assert.equal(await scheduler.scanRepoIssues(repo), 0);
  openPrs = [];
});
