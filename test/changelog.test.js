'use strict';

/**
 * Tests for the TestFlight "What to Test" note builder. Pure functions only —
 * the translation hop shells out to the Copilot CLI and is exercised through
 * `resolveChangelog` with `copilotBin` omitted, which is the documented
 * fallback path.
 *
 * Run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  MAX_LEN,
  normalizeTitle,
  hasHan,
  isMostlyChinese,
  truncate,
  fallbackNote,
  resolveChangelog,
} = require('../lib/changelog');

test('strips the (closes #N) reference the PR title already carries', () => {
  assert.strictEqual(
    normalizeTitle('计时器实时活动 + 灵动岛显示烹饪倒计时 (closes #23)'),
    '计时器实时活动 + 灵动岛显示烹饪倒计时',
  );
  assert.strictEqual(normalizeTitle('修复崩溃 closes #7'), '修复崩溃');
  assert.strictEqual(normalizeTitle('修复崩溃 (#7)'), '修复崩溃');
});

test('strips conventional-commit prefixes', () => {
  assert.strictEqual(normalizeTitle('feat: 添加引导流程'), '添加引导流程');
  assert.strictEqual(normalizeTitle('fix(ui)!: 修复列表滚动'), '修复列表滚动');
  assert.strictEqual(normalizeTitle('docs：补充说明'), '补充说明');
  // A prefix that only appears after the issue ref is stripped still goes.
  assert.strictEqual(normalizeTitle('feat: 加入 A–Z 索引 (closes #96)'), '加入 A–Z 索引');
});

test('keeps only the Chinese half of a bilingual title', () => {
  assert.strictEqual(
    normalizeTitle('将 Cook Now 改造为可复用的做饭任务流程 / Cook Now as a reusable cooking task flow (closes #79)'),
    '将 Cook Now 改造为可复用的做饭任务流程',
  );
  // A slash inside one language is not a separator.
  assert.strictEqual(normalizeTitle('支持 iPad/iPhone 分屏'), '支持 iPad/iPhone 分屏');
});

test('drops characters that would break the single-quoted fastlane arg', () => {
  assert.strictEqual(normalizeTitle("修复 `rm -rf $HOME` 的'注入'"), '修复 rm -rf HOME 的注入');
});

test('recognises Chinese notes but not English ones', () => {
  assert.ok(isMostlyChinese('添加家庭人数与份量偏好'));
  assert.ok(isMostlyChinese('将 Cook Now 改造为做饭任务流程'));
  assert.ok(!isMostlyChinese('Add first-launch onboarding flow'));
  assert.ok(!isMostlyChinese(''));
});

test('hasHan is stateless across calls', () => {
  // Guards against the /g-regex `lastIndex` trap: a global regex reused with
  // .test() alternates true/false on the same input.
  assert.ok(hasHan('接入 Xcode Cloud 到 CI/CD'));
  assert.ok(hasHan('接入 Xcode Cloud 到 CI/CD'));
  assert.ok(!hasHan('wire Xcode Cloud build to CI/CD'));
  // A note the strict test rejects but the translation gate must accept.
  assert.ok(!isMostlyChinese('接入 Xcode Cloud 到 CI/CD'));
});

test('truncates to one line, marking the cut', () => {
  const long = '很'.repeat(MAX_LEN + 10);
  const cut = truncate(long);
  assert.strictEqual(Array.from(cut).length, MAX_LEN);
  assert.ok(cut.endsWith('…'));
  assert.strictEqual(truncate('短标题'), '短标题');
});

test('falls back to a Chinese note when there is no usable title', async () => {
  assert.strictEqual(fallbackNote('1.4', 63), 'v1.4 构建 63（暂无变更说明）');
  assert.strictEqual(
    await resolveChangelog({ pr: { title: '  ' }, version: '1.4', buildNumber: 63 }),
    'v1.4 构建 63（暂无变更说明）',
  );
  assert.strictEqual(
    await resolveChangelog({ pr: null, version: null, buildNumber: 63 }),
    '构建 63（暂无变更说明）',
  );
});

test('resolveChangelog keeps a Chinese title as-is, no CLI needed', async () => {
  assert.strictEqual(
    await resolveChangelog({
      pr: { title: 'feat: 计时器实时活动 (closes #23)' },
      version: '1.4',
      buildNumber: 63,
      copilotBin: '/nonexistent/copilot',
    }),
    '计时器实时活动',
  );
});

test('resolveChangelog falls back to the cleaned title when translation fails', async () => {
  assert.strictEqual(
    await resolveChangelog({
      pr: { title: 'feat: Add first-launch onboarding flow (closes #75)' },
      version: '1.4',
      buildNumber: 63,
      copilotBin: '/nonexistent/copilot',
    }),
    'Add first-launch onboarding flow',
  );
});
