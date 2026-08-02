'use strict';

/**
 * Tests for project-type detection, per-type test commands and the deploy
 * config that shares the same probe (issue #70).
 *
 * The type is not cosmetic: it decides which verification commands a Create PR
 * run is told to use and whether the iOS-only `commit and deploy` tag exists at
 * all. Getting `unknown` wrong is the expensive direction — cloud-copilot must
 * never invent a command for a repo it doesn't understand.
 *
 * Run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoConfig = require('../lib/repoConfig');

function makeRepo(files = {}, dirs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-repoconfig-'));
  for (const d of dirs) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  repoConfig.clearCache();
  return dir;
}

test('an Xcode project is detected as iOS', () => {
  const dir = makeRepo({}, ['DietExpert.xcodeproj']);
  const d = repoConfig.detectProjectType(dir);
  assert.equal(d.type, 'ios');
  assert.equal(d.source, 'auto');
});

test('an Xcode workspace is detected as iOS', () => {
  const dir = makeRepo({}, ['App.xcworkspace']);
  assert.equal(repoConfig.detectProjectType(dir).type, 'ios');
});

test('Package.swift alone is detected as iOS', () => {
  const dir = makeRepo({ 'Package.swift': '// swift-tools-version:5.9' });
  assert.equal(repoConfig.detectProjectType(dir).type, 'ios');
});

test('package.json alone is detected as Web', () => {
  const dir = makeRepo({ 'package.json': '{"name":"x"}' });
  const d = repoConfig.detectProjectType(dir);
  assert.equal(d.type, 'web');
  assert.equal(d.reason, 'package.json');
});

test('an Xcode project wins over a package.json', () => {
  const dir = makeRepo({ 'package.json': '{"name":"x"}' }, ['App.xcodeproj']);
  assert.equal(repoConfig.detectProjectType(dir).type, 'ios');
});

test('a repo with no known marker stays unknown', () => {
  const dir = makeRepo({ 'README.md': '# hi' });
  assert.equal(repoConfig.detectProjectType(dir).type, 'unknown');
});

test('an explicit projectType in .cloud-copilot.json beats the disk layout', () => {
  const dir = makeRepo(
    { '.cloud-copilot.json': JSON.stringify({ projectType: 'web' }) },
    ['App.xcodeproj'],
  );
  const d = repoConfig.detectProjectType(dir);
  assert.equal(d.type, 'web');
  assert.equal(d.source, 'config');
});

test('a bogus projectType is ignored rather than trusted', () => {
  const dir = makeRepo({ '.cloud-copilot.json': JSON.stringify({ projectType: 'android' }) });
  assert.equal(repoConfig.detectProjectType(dir).type, 'unknown');
});

test('a manual override beats detection and reports what it overrode', () => {
  const dir = makeRepo({ 'package.json': '{}' });
  const r = repoConfig.resolveProjectType(dir, 'ios');
  assert.equal(r.type, 'ios');
  assert.equal(r.source, 'override');
  assert.equal(r.overridden, true);
  assert.equal(r.detected, 'web');
});

test('an invalid override is ignored, leaving detection in charge', () => {
  const dir = makeRepo({ 'package.json': '{}' });
  const r = repoConfig.resolveProjectType(dir, 'android');
  assert.equal(r.type, 'web');
  assert.equal(r.overridden, false);
});

test('isProjectType only accepts ios and web', () => {
  assert.equal(repoConfig.isProjectType('ios'), true);
  assert.equal(repoConfig.isProjectType('web'), true);
  assert.equal(repoConfig.isProjectType('unknown'), false);
  assert.equal(repoConfig.isProjectType(null), false);
  assert.equal(repoConfig.isProjectType(''), false);
});

test('a Web repo is verified with npm test', () => {
  const dir = makeRepo({ 'package.json': '{}' });
  const t = repoConfig.loadTestConfig(dir);
  assert.equal(t.type, 'web');
  assert.deepEqual(t.commands, ['npm test']);
  assert.equal(t.source, 'auto');
});

test('an iOS repo is verified with xcodebuild against its own project', () => {
  const dir = makeRepo({}, ['DietExpert.xcodeproj']);
  const t = repoConfig.loadTestConfig(dir);
  assert.equal(t.type, 'ios');
  assert.equal(t.commands.length, 2);
  assert.match(t.commands[0], /^xcodebuild build -project "DietExpert\.xcodeproj" -scheme "DietExpert"/);
  assert.match(t.commands[1], /^xcodebuild test -project "DietExpert\.xcodeproj" -scheme "DietExpert"/);
  assert.match(t.commands[1], /iOS Simulator/);
});

test('an iOS workspace is preferred over its project file', () => {
  const dir = makeRepo({}, ['App.xcworkspace', 'App.xcodeproj']);
  const t = repoConfig.loadTestConfig(dir);
  assert.match(t.command, /-workspace "App\.xcworkspace"/);
});

test('an unknown project gets no test command at all', () => {
  const dir = makeRepo({ 'README.md': '# hi' });
  const t = repoConfig.loadTestConfig(dir);
  assert.equal(t.type, 'unknown');
  assert.equal(t.command, null);
  assert.deepEqual(t.commands, []);
});

test('an explicit test.command overrides the per-type default', () => {
  const dir = makeRepo({
    'package.json': '{}',
    '.cloud-copilot.json': JSON.stringify({ test: { command: 'npm run ci' } }),
  });
  const t = repoConfig.loadTestConfig(dir);
  assert.deepEqual(t.commands, ['npm run ci']);
  assert.equal(t.source, 'config');
});

test('a non-string test.command is refused instead of executed', () => {
  const dir = makeRepo({
    'package.json': '{}',
    '.cloud-copilot.json': JSON.stringify({ test: { command: 42 } }),
  });
  const t = repoConfig.loadTestConfig(dir);
  assert.equal(t.command, null);
  assert.match(t.error, /test\.command/);
});

test('an overridden type also switches which test commands are used', () => {
  const dir = makeRepo({ 'package.json': '{}' }, ['App.xcodeproj']);
  const web = repoConfig.loadTestConfig(dir, { projectType: 'web' });
  assert.deepEqual(web.commands, ['npm test']);
});

test('deploy config still auto-detects ios-testflight from an Xcode project', () => {
  const dir = makeRepo({}, ['App.xcodeproj']);
  assert.equal(repoConfig.loadDeployConfig(dir).type, 'ios-testflight');
});

test('deploy config honours an explicit shell deploy', () => {
  const dir = makeRepo({
    '.cloud-copilot.json': JSON.stringify({ deploy: { type: 'shell', command: 'npm run cc:restart' } }),
  });
  const d = repoConfig.loadDeployConfig(dir);
  assert.equal(d.type, 'shell');
  assert.equal(d.command, 'npm run cc:restart');
});

test('a broken config file is reported, not guessed around', () => {
  const dir = makeRepo({ '.cloud-copilot.json': '{ not json' });
  const d = repoConfig.loadDeployConfig(dir);
  assert.equal(d.type, null);
  assert.match(d.error, /Invalid \.cloud-copilot\.json/);
});

test('a repo that does not exist is unknown rather than a crash', () => {
  repoConfig.clearCache();
  const missing = path.join(os.tmpdir(), 'cc-repoconfig-does-not-exist');
  assert.equal(repoConfig.detectProjectType(missing).type, 'unknown');
  assert.equal(repoConfig.loadDeployConfig(missing).type, null);
});

test('the probe is cached, so a page of repos costs one read each', () => {
  const dir = makeRepo({ 'package.json': '{}' });
  assert.equal(repoConfig.detectProjectType(dir).type, 'web');
  // Same path, no clearCache: the new marker must NOT be picked up yet.
  fs.mkdirSync(path.join(dir, 'App.xcodeproj'));
  assert.equal(repoConfig.detectProjectType(dir).type, 'web');
  repoConfig.clearCache(dir);
  assert.equal(repoConfig.detectProjectType(dir).type, 'ios');
});
