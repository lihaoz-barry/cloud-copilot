'use strict';

// Notification formatting (issue #27): every job must produce a push whose
// title identifies *which* task of *which* repo finished, and whose body
// summarises what it was about.

const test = require('node:test');
const assert = require('node:assert');

const notifier = require('../lib/notifier');

// Never let the suite publish to a real ntfy topic, whatever this machine has
// configured in ~/.config/cloud-copilot/notify.env.
process.env.CLOUD_COPILOT_NOTIFY_ENV = '/nonexistent/notify.env';
process.env.NTFY_TOPIC = '';
notifier.reloadConfig();

const base = { baseUrl: 'http://mac.local:8787' };

test('Create PR: title carries repo + issue, body carries issue title and PR link', () => {
  const n = notifier.buildNotification(
    {
      action: 'work',
      status: 'success',
      repo: 'cloud-copilot',
      issueNumber: 27,
      issueTitle: 'ntfy 通知要区分具体任务',
      prNumber: 31,
      prUrl: 'https://github.com/o/r/pull/31',
    },
    base,
  );
  assert.strictEqual(n.title, 'Create PR · cloud-copilot#27');
  assert.match(n.message, /ntfy 通知要区分具体任务/);
  assert.match(n.message, /PR #31: https:\/\/github\.com\/o\/r\/pull\/31/);
  assert.deepStrictEqual(n.tags, ['white_check_mark']);
  assert.strictEqual(n.click, 'http://mac.local:8787/#/pr/cloud-copilot/27/31');
});

test('failure and abort are distinguishable from success', () => {
  const failed = notifier.buildNotification(
    { action: 'work', status: 'failed', repo: 'cloud-copilot', issueNumber: 27, error: 'gh: permission denied' },
    base,
  );
  assert.match(failed.title, /失败$/);
  assert.deepStrictEqual(failed.tags, ['x']);
  assert.strictEqual(failed.priority, 4);
  assert.match(failed.message, /permission denied/);

  const aborted = notifier.buildNotification(
    { action: 'chat', status: 'aborted', repo: 'cloud-copilot', issueNumber: 27, prNumber: 31, mode: 'plan' },
    base,
  );
  assert.match(aborted.title, /已中断$/);
  assert.deepStrictEqual(aborted.tags, ['warning']);
});

test('deploy names the repo and PR, and reports the shipped build', () => {
  const n = notifier.buildNotification(
    {
      action: 'deploy',
      status: 'success',
      repo: 'ios-diet-expert',
      issueNumber: 92,
      prNumber: 112,
      version: '1.0',
      buildNumber: 68,
    },
    base,
  );
  assert.strictEqual(n.title, 'Deploy · ios-diet-expert PR #112');
  assert.match(n.message, /build 1\.0 \(68\)/);
  assert.strictEqual(n.click, 'http://mac.local:8787/#/pr/ios-diet-expert/92/112');
});

test('admin chat is titled by the conversation and deep-links to that chat', () => {
  const n = notifier.buildNotification(
    {
      action: 'admin',
      status: 'success',
      chatTitle: '刷新页面后聊天新开了一个 tab',
      chatId: 'abc-123',
      transcript: '● Read file (view)\n  │ src/a.js\n  └ 3 lines…\n\n已经修好了，问题出在 route() 里。\n\nAI Credits 12\n',
    },
    base,
  );
  assert.strictEqual(n.title, 'Admin chat · 刷新页面后聊天新开了一个 tab');
  assert.match(n.message, /已经修好了/);
  assert.doesNotMatch(n.message, /AI Credits/);
  assert.strictEqual(n.click, 'http://mac.local:8787/#/chat/abc-123');
});

test('PR chat body shows the mode and the request it answered', () => {
  const n = notifier.buildNotification(
    {
      action: 'chat',
      status: 'success',
      repo: 'cloud-copilot',
      issueNumber: 27,
      prNumber: 31,
      mode: 'apply',
      chatTitle: '把 topic 改成可配置的',
      summary: '已提交并推送到分支。',
    },
    base,
  );
  assert.strictEqual(n.title, 'PR chat · cloud-copilot PR #31');
  assert.match(n.message, /\(apply\) 把 topic 改成可配置的/);
  assert.match(n.message, /已提交并推送到分支。/);
});

test('four jobs on one repo produce four distinct titles', () => {
  const titles = [
    { action: 'work', status: 'success', repo: 'cc', issueNumber: 27 },
    { action: 'deploy', status: 'success', repo: 'cc', issueNumber: 27, prNumber: 31 },
    { action: 'chat', status: 'success', repo: 'cc', issueNumber: 27, prNumber: 31, mode: 'plan' },
    { action: 'admin', status: 'success', chatTitle: '看一下 server 日志' },
  ].map((i) => notifier.buildNotification(i, base).title);
  assert.strictEqual(new Set(titles).size, 4, `expected distinct titles, got ${JSON.stringify(titles)}`);
});

test('missing deep-link base means no click action, not a broken URL', () => {
  const n = notifier.buildNotification({ action: 'work', status: 'success', repo: 'cc', issueNumber: 1 }, {});
  assert.strictEqual(n.click, '');
});

test('summarizeTranscript skips tool blocks, code fences and the stats footer', () => {
  const transcript = [
    '● Run tests (shell)',
    '  │ npm test',
    '  └ 12 lines…',
    '',
    '```js',
    'const x = 1;',
    '```',
    '**结论**：三个测试都通过了。',
    '要我顺便跑一下 lint 吗？',
    '',
    'Changes    +4 -1',
    'AI Credits 3 (1m 2s)',
    'Resume     copilot --resume=abc',
  ].join('\n');
  const s = notifier.summarizeTranscript(transcript);
  assert.match(s, /结论/);
  assert.doesNotMatch(s, /npm test/);
  assert.doesNotMatch(s, /const x/);
  assert.doesNotMatch(s, /Resume/);
});

test('unconfigured notifier stays silent instead of throwing', async () => {
  assert.strictEqual(notifier.loadConfig().enabled, false);
  assert.strictEqual(await notifier.notifyJobFinished({ key: 'k', action: 'work', status: 'success' }), false);
});

test('env file parsing ignores comments and strips quotes', () => {
  const cfg = notifier.parseEnvFile('# comment\nNTFY_TOPIC="my-topic"\nexport APP_BASE_URL=\'http://x:1\'\nbad-line\n');
  assert.strictEqual(cfg.NTFY_TOPIC, 'my-topic');
  assert.strictEqual(cfg.APP_BASE_URL, 'http://x:1');
});
