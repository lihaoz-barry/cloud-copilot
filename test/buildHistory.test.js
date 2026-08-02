'use strict';

const test = require('node:test');
const assert = require('node:assert');

const buildHistory = require('../lib/buildHistory');

function deploy(extra = {}) {
  return {
    status: 'success',
    conversation: '',
    exitCode: 0,
    startedAt: '2024-01-01T00:00:00.000Z',
    finishedAt: '2024-01-01T00:10:00.000Z',
    buildNumber: 1,
    version: '1.0',
    changelog: null,
    branch: null,
    commit: null,
    ...extra,
  };
}

function record(prs) {
  return { repo: 'app', issueNumber: 7, prs };
}

test('every deploy attempt becomes its own build, newest first', () => {
  const rec = record({
    10: {
      prNumber: 10,
      prUrl: 'https://gh/pr/10',
      title: 'PR ten',
      merge: { status: 'idle', forced: false, conflictResolved: false, recoveryMessage: null },
      deployHistory: [
        deploy({ buildNumber: 1, finishedAt: '2024-01-01T01:00:00.000Z' }),
        deploy({ buildNumber: 2, finishedAt: '2024-01-01T02:00:00.000Z' }),
      ],
      deploy: deploy({ buildNumber: 3, finishedAt: '2024-01-01T03:00:00.000Z' }),
    },
  });
  const { builds, errors } = buildHistory.flattenBuilds([rec]);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(builds.length, 3);
  assert.deepStrictEqual(
    builds.map((b) => b.buildNumber),
    [3, 2, 1],
  );
  assert.strictEqual(builds[0].current, true);
  assert.strictEqual(builds[1].superseded, true);
  assert.strictEqual(new Set(builds.map((b) => b.id)).size, 3);
});

test('several builds of the SAME version stay distinct records', () => {
  const rec = record({
    11: {
      prNumber: 11,
      merge: { status: 'idle' },
      deployHistory: [deploy({ version: '2.0', buildNumber: 41, finishedAt: '2024-02-01T00:00:00.000Z' })],
      deploy: deploy({ version: '2.0', buildNumber: 42, finishedAt: '2024-02-02T00:00:00.000Z' }),
    },
  });
  const { builds } = buildHistory.flattenBuilds([rec]);
  assert.strictEqual(builds.length, 2);
  assert.deepStrictEqual(
    builds.map((b) => `${b.version}/${b.buildNumber}`),
    ['2.0/42', '2.0/41'],
  );
  assert.notStrictEqual(builds[0].id, builds[1].id);
});

test('idle deploys are not builds', () => {
  const rec = record({ 12: { prNumber: 12, merge: { status: 'idle' }, deployHistory: [], deploy: deploy({ status: 'idle' }) } });
  assert.deepStrictEqual(buildHistory.flattenBuilds([rec]).builds, []);
});

test('failed builds carry a short failure reason, successful ones do not', () => {
  const rec = record({
    13: {
      prNumber: 13,
      merge: { status: 'idle' },
      deployHistory: [],
      deploy: deploy({
        status: 'failed',
        exitCode: 1,
        conversation: 'Running fastlane\nStep ok\nERROR: code signing failed for target App\n---\n',
      }),
    },
  });
  const { builds } = buildHistory.flattenBuilds([rec]);
  assert.match(builds[0].failureReason, /code signing failed/);
  assert.strictEqual(builds[0].exitCode, 1);

  const ok = record({ 14: { prNumber: 14, merge: { status: 'idle' }, deployHistory: [], deploy: deploy() } });
  assert.strictEqual(buildHistory.flattenBuilds([ok]).builds[0].failureReason, null);
});

test('branch/commit fall back to the PR head for legacy attempts', () => {
  const rec = record({
    15: {
      prNumber: 15,
      headRefName: 'feat-x',
      headCommit: { sha: 'abc123def', abbrev: 'abc123d', url: 'https://gh/c/abc123def' },
      merge: { status: 'idle' },
      deployHistory: [deploy({ finishedAt: '2024-03-01T00:00:00.000Z' })],
      deploy: deploy({
        branch: 'feat-x',
        commit: { sha: 'ffff000', abbrev: 'ffff000' },
        finishedAt: '2024-03-02T00:00:00.000Z',
      }),
    },
  });
  const { builds } = buildHistory.flattenBuilds([rec]);
  assert.strictEqual(builds[0].commit.abbrev, 'ffff000');
  assert.strictEqual(builds[0].commitIsCurrentHead, false);
  assert.strictEqual(builds[1].branch, 'feat-x');
  assert.strictEqual(builds[1].commit.abbrev, 'abc123d');
  assert.strictEqual(builds[1].commitIsCurrentHead, true);
});

test('one broken PR entry does not lose the rest of the history', () => {
  const broken = {
    prNumber: 20,
    merge: { status: 'idle' },
    deployHistory: [],
    get deploy() {
      throw new Error('corrupt deploy record');
    },
  };
  const rec = record({
    20: broken,
    21: { prNumber: 21, merge: { status: 'idle' }, deployHistory: [], deploy: deploy({ buildNumber: 99 }) },
  });
  const { builds, errors } = buildHistory.flattenBuilds([rec]);
  assert.strictEqual(builds.length, 1);
  assert.strictEqual(builds[0].buildNumber, 99);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /corrupt deploy record/);
});

test('builds without timestamps still render and sort last', () => {
  const rec = record({
    22: { prNumber: 22, merge: { status: 'idle' }, deployHistory: [], deploy: deploy({ startedAt: null, finishedAt: null, buildNumber: 5 }) },
    23: { prNumber: 23, merge: { status: 'idle' }, deployHistory: [], deploy: deploy({ buildNumber: 6 }) },
  });
  const { builds } = buildHistory.flattenBuilds([rec]);
  assert.deepStrictEqual(
    builds.map((b) => b.buildNumber),
    [6, 5],
  );
});

test('summarizeFailure tolerates junk input', () => {
  assert.strictEqual(buildHistory.summarizeFailure(null), null);
  assert.strictEqual(buildHistory.summarizeFailure('   '), null);
  assert.strictEqual(buildHistory.summarizeFailure('----\n****'), null);
  assert.strictEqual(buildHistory.summarizeFailure('all good\nlast line'), 'last line');
  const long = `error: ${'x'.repeat(500)}`;
  assert.ok(buildHistory.summarizeFailure(long).length <= 240);
});
