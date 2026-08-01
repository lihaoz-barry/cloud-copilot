'use strict';

require('./helpers').sandbox('cc-report-');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const queue = require('../lib/queue');
const config = require('../lib/queueConfig');
const report = require('../lib/report');
const mailer = require('../lib/mailer');

function fresh() {
  try {
    fs.unlinkSync(queue.QUEUE_FILE);
  } catch {
    /* first run */
  }
  queue._reset();
}

function finished(repo, fields, status, agoMs = 60000) {
  const t = queue.enqueue({ repo, type: 'create-pr', ...fields }, { force: true });
  queue.markRunning(t.id);
  queue.finish(t.id, status, { error: status === 'failed' ? 'no PR opened' : null });
  queue.update(t.id, {
    finishedAt: new Date(Date.now() - agoMs).toISOString(),
    durationMs: 5 * 60 * 1000,
  });
  return t;
}

test('A5.1 counts, grouping and total time', () => {
  fresh();
  finished('repo-a', { issueNumber: 1, title: '#1 one' }, 'success');
  finished('repo-a', { issueNumber: 2, title: '#2 two' }, 'failed');
  finished('repo-b', { issueNumber: 3, title: '#3 three' }, 'skipped');

  const r = report.build();
  assert.equal(r.total, 3);
  assert.equal(r.counts.success, 1);
  assert.equal(r.counts.failed, 1);
  assert.equal(r.counts.skipped, 1);
  assert.equal(r.totalMs, 15 * 60 * 1000);
  assert.deepEqual(Object.keys(r.byRepo).sort(), ['repo-a', 'repo-b']);
});

test('A5.1b tasks outside the window are excluded', () => {
  fresh();
  finished('repo-a', { issueNumber: 1 }, 'success', 60000);
  finished('repo-a', { issueNumber: 2 }, 'success', 72 * 3600 * 1000);
  assert.equal(report.build().total, 1);
});

test('A5.2 an empty day still produces a readable report', () => {
  fresh();
  const r = report.build();
  assert.equal(r.total, 0);
  const md = report.renderMarkdown(r);
  assert.match(md, /没有任务执行/);
  assert.doesNotThrow(() => report.write(r));
});

test('A5.3 failures get their own call-out', () => {
  fresh();
  finished('repo-a', { issueNumber: 9, title: '#9 broken' }, 'failed');
  const r = report.build();
  assert.equal(r.needsAttention.length, 1);
  assert.match(report.renderMarkdown(r), /需要你看一下/);
  assert.match(report.renderMarkdown(r), /#9 broken/);
});

test('A5.4 reports past the retention window are pruned', () => {
  fresh();
  fs.mkdirSync(report.REPORTS_DIR, { recursive: true });
  const old = '2020-01-01';
  fs.writeFileSync(path.join(report.REPORTS_DIR, `${old}.json`), '{}');
  fs.writeFileSync(path.join(report.REPORTS_DIR, `${old}.md`), '# old');
  const today = queue.localDateKey();
  report.write(report.build({ date: today }));

  const removed = report.pruneOld(30);
  assert.equal(removed, 2);
  assert.ok(report.list().includes(today), "today's report survives");
  assert.ok(!report.list().includes(old));
});

test('write/read round-trips both the JSON and the markdown', () => {
  fresh();
  finished('repo-a', { issueNumber: 5, title: '#5 five' }, 'success');
  const r = report.build();
  report.write(r);

  const back = report.read(r.date);
  assert.equal(back.total, 1);
  assert.match(back.markdown, /#5 five/);
});

test('A5.5 with no email configured, delivery is skipped and the report still lands', async () => {
  fresh();
  config.save({ ...config.DEFAULTS, email: { ...config.DEFAULTS.email, enabled: false } });

  const { report: r, mail } = await report.generateAndDeliver();
  assert.equal(mail.ok, false);
  assert.ok(mail.skipped);
  assert.ok(report.list().includes(r.date), 'the report is on disk regardless');
});

test('A5.6 a failing provider is reported but never throws', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  config.save({
    ...config.DEFAULTS,
    email: { enabled: true, provider: 'resend', token: 't', from: 'a@b.c', to: 'd@e.f' },
  });

  try {
    const res = await mailer.send({ subject: 's', text: 't' });
    assert.equal(res.ok, false);
    assert.match(res.error, /401/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('mailer refuses unknown providers rather than guessing', async () => {
  config.save({
    ...config.DEFAULTS,
    email: { enabled: true, provider: 'smtp', token: 't', from: 'a@b.c', to: 'd@e.f' },
  });
  const res = await mailer.send({ subject: 's', text: 't' });
  assert.equal(res.ok, false);
  assert.match(res.skipped, /unsupported provider/);
});

test('mailer posts to Resend with the bearer token', async () => {
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => '{"id":"abc"}' };
  };
  config.save({
    ...config.DEFAULTS,
    email: { enabled: true, provider: 'resend', token: 'tok', from: 'a@b.c', to: 'd@e.f' },
  });

  try {
    const res = await mailer.send({ subject: 'hello', text: 'body' });
    assert.equal(res.ok, true);
    assert.equal(res.id, 'abc');
    assert.equal(captured.url, mailer.RESEND_ENDPOINT);
    assert.equal(captured.opts.headers.Authorization, 'Bearer tok');
    const body = JSON.parse(captured.opts.body);
    assert.deepEqual(body.to, ['d@e.f']);
    assert.equal(body.subject, 'hello');
  } finally {
    global.fetch = originalFetch;
  }
});

test('formatDuration stays readable', () => {
  assert.equal(report.formatDuration(0), '—');
  assert.equal(report.formatDuration(9 * 60000), '9m');
  assert.equal(report.formatDuration(134 * 60000), '2h14m');
});
