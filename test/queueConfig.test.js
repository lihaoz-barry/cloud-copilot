'use strict';

require('./helpers').sandbox('cc-cfg-');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const config = require('../lib/queueConfig');

function writeConfig(obj) {
  fs.mkdirSync(require('path').dirname(config.CONFIG_FILE), { recursive: true });
  fs.writeFileSync(config.CONFIG_FILE, typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function clearConfig() {
  try {
    fs.unlinkSync(config.CONFIG_FILE);
  } catch {
    /* already gone */
  }
}

test('A2.1 a missing config file yields defaults', () => {
  clearConfig();
  const c = config.get();
  assert.equal(c.enabled, true);
  assert.equal(c.scanIntervalMinutes, 30);
  assert.equal(c.syncAt, '03:00');
  assert.equal(c.reportAt, '08:00');
  assert.deepEqual(c.defaultLabels, ['committed']);
});

test('A2.2 a corrupt config file falls back to defaults instead of throwing', () => {
  writeConfig('{{{not json');
  const c = config.get();
  assert.equal(c.enabled, true);
  assert.deepEqual(c.defaultLabels, ['committed']);
});

test('A2.3 a repo that is not listed is enabled with the default labels', () => {
  writeConfig({ repos: {} });
  const s = config.repoSettings('never-seen');
  assert.equal(s.enabled, true, 'absent means enabled — you should not have to opt every repo in');
  assert.equal(s.paused, false);
  assert.deepEqual(s.labels, ['committed']);
});

test('A2.4 an explicitly disabled repo is inactive', () => {
  writeConfig({ repos: { off: { enabled: false } } });
  assert.equal(config.repoActive('off'), false);
  assert.equal(config.repoActive('other'), true);
});

test('A2.4b a paused repo is inactive but still enabled', () => {
  writeConfig({ repos: { p: { paused: true } } });
  assert.equal(config.repoActive('p'), false);
  assert.equal(config.repoSettings('p').enabled, true);
});

test('A2.5 the master switch overrides every repo', () => {
  writeConfig({ enabled: false, repos: { a: { enabled: true } } });
  assert.equal(config.repoActive('a'), false);
});

test('A2.6 saving with an empty token keeps the stored one', () => {
  writeConfig({ email: { enabled: true, token: 'secret-abc', from: 'a@b.c', to: 'd@e.f' } });
  config.update({ email: { enabled: true, token: '', from: 'new@b.c', to: 'd@e.f' } });

  const c = config.get();
  assert.equal(c.email.token, 'secret-abc', 'the UI never sees the token, so blank means "unchanged"');
  assert.equal(c.email.from, 'new@b.c');
});

test('A2.6b a non-empty token replaces the stored one', () => {
  writeConfig({ email: { token: 'old' } });
  config.update({ email: { token: 'new' } });
  assert.equal(config.get().email.token, 'new');
});

test('A2.7 redacted() never leaks the token', () => {
  writeConfig({ email: { token: 'super-secret' } });
  const r = config.redacted();
  assert.equal(r.email.token, '••••••••');
  assert.equal(r.email.hasToken, true);
  assert.ok(!JSON.stringify(r).includes('super-secret'));
});

test('A2.8 an external edit is picked up on the next read', () => {
  writeConfig({ scanIntervalMinutes: 30 });
  assert.equal(config.get().scanIntervalMinutes, 30);
  writeConfig({ scanIntervalMinutes: 5 });
  assert.equal(config.get().scanIntervalMinutes, 5, 'mtime change must invalidate the cache');
});

test('A2.9 parseTimeOfDay accepts HH:MM and rejects the rest', () => {
  assert.equal(config.parseTimeOfDay('03:00'), 180);
  assert.equal(config.parseTimeOfDay('8:05'), 485);
  assert.equal(config.parseTimeOfDay('23:59'), 1439);
  assert.equal(config.parseTimeOfDay('25:00'), null);
  assert.equal(config.parseTimeOfDay('8:5'), null);
  assert.equal(config.parseTimeOfDay(''), null);
  assert.equal(config.parseTimeOfDay(undefined), null);
});

test('setRepo merges rather than replacing', () => {
  writeConfig({ repos: { r: { enabled: true, labels: ['a'] } } });
  config.setRepo('r', { paused: true });
  const s = config.repoSettings('r');
  assert.equal(s.paused, true);
  assert.deepEqual(s.labels, ['a'], 'labels survive a paused toggle');
});

test('worktreeRoot expands ~', () => {
  writeConfig({ worktreeRoot: '~/.cloud-copilot/worktrees' });
  const root = config.worktreeRoot();
  assert.ok(root.startsWith(require('os').homedir()));
  assert.ok(!root.includes('~'));
});
