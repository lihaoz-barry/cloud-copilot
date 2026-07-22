'use strict';

/**
 * Tiny JSON-file state store for per-issue action status.
 *
 * We deliberately avoid a native SQLite dependency so the demo stays
 * `npm install express`-only. State is small (a handful of issues), so a single
 * JSON file that is rewritten atomically is more than enough.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { issues: {} };
  }
}

function save(state) {
  ensureDir();
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE); // atomic on same filesystem
}

const key = (repo, issueNumber) => `${repo}#${issueNumber}`;

function blankRecord(repo, issueNumber) {
  return {
    repo,
    issueNumber,
    work: {
      status: 'idle', // idle | working | success | failed
      sessionId: null,
      prNumber: null,
      prUrl: null,
      conversation: '',
      exitCode: null,
      startedAt: null,
      finishedAt: null,
    },
    deploy: {
      status: 'idle', // idle | deploying | success | failed
      sessionId: null,
      conversation: '',
      exitCode: null,
      startedAt: null,
      finishedAt: null,
    },
  };
}

function getRecord(repo, issueNumber) {
  const state = load();
  return state.issues[key(repo, issueNumber)] || blankRecord(repo, issueNumber);
}

/**
 * Merge a partial update into an issue record and persist.
 * `patch` is a function (record) => void that mutates the record in place.
 */
function updateRecord(repo, issueNumber, patch) {
  const state = load();
  const k = key(repo, issueNumber);
  const record = state.issues[k] || blankRecord(repo, issueNumber);
  patch(record);
  state.issues[k] = record;
  save(state);
  return record;
}

// Return a light-weight status map for a list of issue numbers in one read.
function getStatuses(repo, issueNumbers) {
  const state = load();
  const out = {};
  for (const n of issueNumbers) {
    const r = state.issues[key(repo, n)];
    out[n] = r
      ? {
          work: {
            status: r.work.status,
            prNumber: r.work.prNumber,
            prUrl: r.work.prUrl,
            hasConversation: Boolean(r.work.conversation),
          },
          deploy: {
            status: r.deploy.status,
            hasConversation: Boolean(r.deploy.conversation),
          },
        }
      : { work: { status: 'idle' }, deploy: { status: 'idle' } };
  }
  return out;
}

module.exports = { getRecord, updateRecord, getStatuses };
