'use strict';

// The job manager must hand a fully-identified job to the notifier the moment
// it reaches a terminal state, and must mark its children as cloud-copilot runs
// so the Copilot CLI's generic sessionEnd hook can stay quiet (issue #27).

const test = require('node:test');
const assert = require('node:assert');

const notifier = require('../lib/notifier');
const jobs = require('../lib/jobs');

// Never let the suite publish to a real ntfy topic, whatever this machine has
// configured in ~/.config/cloud-copilot/notify.env.
process.env.CLOUD_COPILOT_NOTIFY_ENV = '/nonexistent/notify.env';
process.env.NTFY_TOPIC = '';
notifier.reloadConfig();

function runJob(key, opts) {
  return new Promise((resolve) => {
    const job = jobs.startJob(key, opts);
    const wait = setInterval(() => {
      if (job.status === 'done') {
        clearInterval(wait);
        resolve(job);
      }
    }, 10);
  });
}

test('a finished job is announced with its full identity', async () => {
  const sent = [];
  const real = notifier.notifyJobFinished;
  notifier.notifyJobFinished = (info) => {
    sent.push(info);
    return Promise.resolve(true);
  };
  try {
    await runJob('r#7:work', {
      bin: 'bash',
      args: ['-c', 'echo done'],
      cwd: process.cwd(),
      meta: { action: 'work', repo: 'r', issueNumber: 7, issueTitle: 'Some issue' },
      onDone: async () => ({ action: 'work', status: 'success', prNumber: 9, prUrl: 'https://x/pull/9' }),
    });
  } finally {
    notifier.notifyJobFinished = real;
  }
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(
    {
      key: sent[0].key,
      action: sent[0].action,
      status: sent[0].status,
      repo: sent[0].repo,
      issueNumber: sent[0].issueNumber,
      issueTitle: sent[0].issueTitle,
      prNumber: sent[0].prNumber,
      prUrl: sent[0].prUrl,
    },
    {
      key: 'r#7:work',
      action: 'work',
      status: 'success',
      repo: 'r',
      issueNumber: 7,
      issueTitle: 'Some issue',
      prNumber: 9,
      prUrl: 'https://x/pull/9',
    },
  );
});

test('a job with no onDone result still reports success/failure', async () => {
  const sent = [];
  const real = notifier.notifyJobFinished;
  notifier.notifyJobFinished = (info) => { sent.push(info); return Promise.resolve(true); };
  try {
    await runJob('r#8:merge', {
      bin: 'bash',
      args: ['-c', 'exit 3'],
      cwd: process.cwd(),
      meta: { action: 'merge', repo: 'r', issueNumber: 8, prNumber: 12 },
    });
  } finally {
    notifier.notifyJobFinished = real;
  }
  assert.strictEqual(sent[0].status, 'failed');
  assert.strictEqual(sent[0].prNumber, 12);
});

test('children are marked as cloud-copilot jobs (mutes the CLI sessionEnd hook)', async () => {
  const job = await runJob('r#9:work', {
    bin: 'bash',
    args: ['-c', 'echo "flag=$CLOUD_COPILOT_JOB"'],
    cwd: process.cwd(),
    meta: { action: 'work', repo: 'r', issueNumber: 9 },
  });
  assert.match(job.conversation, /flag=1/);
});
