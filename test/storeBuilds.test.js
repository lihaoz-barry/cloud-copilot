'use strict';

// End-to-end coverage for the store side of the TestFlight build history:
// migration of legacy records, archiving of past attempts, and the shape
// `listAllBuilds()` hands to the API. Runs against a throwaway data dir so it
// never touches the real state file.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-store-test-'));
process.env.CC_DATA_DIR = DATA_DIR;

const store = require('../lib/store');

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

function writeState(issues) {
  fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify({ issues }, null, 2));
}

test('listAllBuilds returns { builds, errors } and migrates legacy records', () => {
  // A record written before `branch`/`commit`/`deployHistory` existed.
  writeState({
    'app#5': {
      repo: 'app',
      issueNumber: 5,
      work: { status: 'success', prNumber: 9, prUrl: 'https://gh/pr/9' },
      prs: {
        9: {
          prNumber: 9,
          prUrl: 'https://gh/pr/9',
          headRefName: 'feat-legacy',
          deploy: {
            status: 'success',
            version: '1.2',
            buildNumber: 30,
            startedAt: '2024-05-01T00:00:00.000Z',
            finishedAt: '2024-05-01T00:05:00.000Z',
          },
        },
      },
    },
  });
  const { builds, errors } = store.listAllBuilds();
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(builds.length, 1);
  assert.strictEqual(builds[0].buildNumber, 30);
  assert.strictEqual(builds[0].branch, 'feat-legacy'); // falls back to the PR head
  assert.strictEqual(builds[0].commit, null);
  assert.strictEqual(builds[0].current, true);
  assert.strictEqual(builds[0].durationMs, 300000);
});

test('a new deploy archives the previous attempt instead of overwriting it', () => {
  writeState({});
  store.updateDeploy('app', 1, 2, (d) => {
    d.status = 'success';
    d.version = '1.0';
    d.buildNumber = 10;
    d.startedAt = '2024-06-01T00:00:00.000Z';
    d.finishedAt = '2024-06-01T00:10:00.000Z';
  });
  store.startNewDeploy('app', 1, 2);
  store.updateDeploy('app', 1, 2, (d) => {
    d.status = 'success';
    d.version = '1.0'; // SAME version, different build — both must survive
    d.buildNumber = 11;
    d.finishedAt = '2024-06-02T00:00:00.000Z';
  });

  const { builds } = store.listAllBuilds();
  assert.deepStrictEqual(
    builds.map((b) => b.buildNumber),
    [11, 10],
  );
  assert.strictEqual(builds[0].current, true);
  assert.strictEqual(builds[1].superseded, true);
  assert.notStrictEqual(builds[0].id, builds[1].id);
});

test('an interrupted deploy is archived as aborted, not silently dropped', () => {
  writeState({});
  // Server died mid-deploy: status stayed `deploying`, no finishedAt.
  store.updateDeploy('app', 3, 4, (d) => {
    d.status = 'deploying';
    d.startedAt = '2024-07-01T00:00:00.000Z';
    d.conversation = 'fastlane started';
  });
  store.startNewDeploy('app', 3, 4);
  store.updateDeploy('app', 3, 4, (d) => {
    d.status = 'success';
    d.buildNumber = 77;
    d.finishedAt = '2024-07-02T00:00:00.000Z';
  });

  const { builds } = store.listAllBuilds();
  assert.strictEqual(builds.length, 2, 'the interrupted attempt must stay in history');
  const interrupted = builds.find((b) => b.superseded);
  assert.strictEqual(interrupted.deployStatus, 'aborted');
  assert.ok(interrupted.finishedAt, 'archived attempt gets a finish time so it can be sorted');
  assert.match(interrupted.failureReason, /interrupted/i);
});

test('a deploy that never started is not archived as a phantom build', () => {
  writeState({});
  store.startNewDeploy('app', 8, 9); // nothing ran before this one
  const { builds } = store.listAllBuilds();
  assert.strictEqual(builds.length, 1);
  assert.strictEqual(builds[0].deployStatus, 'deploying');
});

test('resetForNewCommits keeps the previous build in history', () => {
  writeState({});
  store.updateDeploy('app', 6, 7, (d) => {
    d.status = 'success';
    d.buildNumber = 55;
    d.startedAt = '2024-08-01T00:00:00.000Z';
    d.finishedAt = '2024-08-01T00:03:00.000Z';
  });
  store.resetForNewCommits('app', 6, 7);
  const { builds } = store.listAllBuilds();
  assert.strictEqual(builds.length, 1);
  assert.strictEqual(builds[0].buildNumber, 55);
  assert.strictEqual(builds[0].current, false);
});

test('a null issue record is skipped instead of blowing up the whole history', () => {
  writeState({
    'app#10': null,
    'app#11': {
      repo: 'app',
      issueNumber: 11,
      prs: {
        12: {
          prNumber: 12,
          deploy: { status: 'success', buildNumber: 4, finishedAt: '2024-09-01T00:00:00.000Z' },
        },
      },
    },
  });
  const { builds, errors } = store.listAllBuilds();
  assert.strictEqual(builds.length, 1);
  assert.strictEqual(builds[0].buildNumber, 4);
  assert.deepStrictEqual(errors, []);
});

test('a corrupt issue record is reported in errors while the rest still lists', () => {
  writeState({
    'app#20': { repo: 'app', issueNumber: 20, prs: 'not-an-object' },
    'app#21': {
      repo: 'app',
      issueNumber: 21,
      prs: {
        22: {
          prNumber: 22,
          deploy: { status: 'success', buildNumber: 8, finishedAt: '2024-10-01T00:00:00.000Z' },
        },
      },
    },
  });
  const { builds, errors } = store.listAllBuilds();
  assert.deepStrictEqual(
    builds.map((b) => b.buildNumber),
    [8],
    'the readable history must survive',
  );
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].issueNumber, 20);
});

test('migrating a record that already pinned a commit does not wipe it', () => {
  writeState({
    'app#30': {
      repo: 'app',
      issueNumber: 30,
      prs: {
        31: {
          prNumber: 31,
          // Half-written record: `commit` present, `branch` never added.
          deploy: {
            status: 'success',
            buildNumber: 12,
            finishedAt: '2024-11-01T00:00:00.000Z',
            commit: { sha: 'deadbeef', abbrev: 'deadbee' },
          },
        },
      },
    },
  });
  const { builds } = store.listAllBuilds();
  assert.strictEqual(builds[0].commit.abbrev, 'deadbee');
  assert.strictEqual(builds[0].branch, null);
});
