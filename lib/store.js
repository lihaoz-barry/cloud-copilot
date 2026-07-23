'use strict';

/**
 * Tiny JSON-file state store — the single source of truth for the lifecycle of
 * every long-running action (Create PR + per-PR Deploy).
 *
 * We deliberately avoid a native SQLite dependency so the demo stays
 * `npm install express`-only. State is small (a handful of issues), so a single
 * JSON file that is rewritten atomically is more than enough.
 *
 * Shape (v2):
 *   {
 *     issues: {
 *       "repo#123": {
 *         repo, issueNumber,
 *         work:  { status, sessionId, prNumber, prUrl, conversation,
 *                  exitCode, startedAt, finishedAt, durationMs },
 *         prs: {
 *           "456": {
 *             prNumber, prUrl, title, createdAt, source,
 *             deploy: { status, sessionId, conversation, exitCode,
 *                       startedAt, finishedAt, durationMs }
 *           }
 *         }
 *       }
 *     }
 *   }
 *
 * Every timed sub-record (work + each PR's deploy) carries startedAt /
 * finishedAt / durationMs so the frontend can render timing from cache alone
 * and survive reconnects.
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
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!state.dismissed) state.dismissed = {};
    return state;
  } catch {
    return { issues: {}, dismissed: {} };
  }
}

function save(state) {
  ensureDir();
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE); // atomic on same filesystem
}

const key = (repo, issueNumber) => `${repo}#${issueNumber}`;

function durationOf(x) {
  if (x && x.startedAt && x.finishedAt) {
    const d = new Date(x.finishedAt) - new Date(x.startedAt);
    return Number.isFinite(d) && d >= 0 ? d : null;
  }
  return null;
}

function blankWork() {
  return {
    status: 'idle', // idle | working | success | failed
    sessionId: null,
    prNumber: null,
    prUrl: null,
    conversation: '',
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  };
}

function blankDeploy() {
  return {
    status: 'idle', // idle | deploying | success | failed
    sessionId: null,
    conversation: '',
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  };
}

function blankPr(prNumber, prUrl = null, extra = {}) {
  return {
    prNumber: Number(prNumber),
    prUrl: prUrl || null,
    title: null,
    createdAt: null,
    source: 'work', // work | gh
    ...extra,
    deploy: blankDeploy(),
  };
}

function blankRecord(repo, issueNumber) {
  return { repo, issueNumber, work: blankWork(), prs: {} };
}

/**
 * Migrate an old-shape record (single top-level `deploy`, no `prs`) to the v2
 * shape in place. Idempotent: once the legacy `deploy` field is removed it will
 * not run again. Returns { record, changed }.
 */
function migrate(r, repo, issueNumber) {
  if (!r) return { record: blankRecord(repo, issueNumber), changed: false };
  let changed = false;

  if (!r.work) {
    r.work = blankWork();
    changed = true;
  }
  if (r.work.durationMs === undefined) {
    r.work.durationMs = durationOf(r.work);
    changed = true;
  }
  if (!r.prs) {
    r.prs = {};
    changed = true;
  }

  // Fold a legacy top-level deploy into the work PR's entry.
  if (r.deploy) {
    const pn = r.work && r.work.prNumber;
    if (pn) {
      if (!r.prs[pn]) r.prs[pn] = blankPr(pn, r.work.prUrl);
      if (r.deploy.status && r.deploy.status !== 'idle') {
        r.prs[pn].deploy = {
          ...blankDeploy(),
          ...r.deploy,
          durationMs: durationOf(r.deploy),
        };
      }
    }
    delete r.deploy;
    changed = true;
  }

  // Ensure the work PR is always represented in the prs map.
  if (r.work && r.work.prNumber && !r.prs[r.work.prNumber]) {
    r.prs[r.work.prNumber] = blankPr(r.work.prNumber, r.work.prUrl);
    changed = true;
  }

  return { record: r, changed };
}

function getRecord(repo, issueNumber) {
  const state = load();
  const raw = state.issues[key(repo, issueNumber)];
  const { record, changed } = migrate(raw, repo, issueNumber);
  if (changed && raw) {
    // Persist the cleaned-up shape so legacy fields don't linger.
    state.issues[key(repo, issueNumber)] = record;
    save(state);
  }
  return record;
}

/**
 * Merge a partial update into an issue record and persist.
 * `patch` is a function (record) => void that mutates the record in place.
 */
function updateRecord(repo, issueNumber, patch) {
  const state = load();
  const k = key(repo, issueNumber);
  const { record } = migrate(state.issues[k], repo, issueNumber);
  patch(record);
  record.work.durationMs = durationOf(record.work);
  state.issues[k] = record;
  save(state);
  return record;
}

/**
 * Insert or update PR metadata (never touches the deploy sub-record).
 */
function upsertPr(repo, issueNumber, pr) {
  return updateRecord(repo, issueNumber, (r) => {
    const n = Number(pr.prNumber);
    if (!n) return;
    const existing = r.prs[n] || blankPr(n, pr.prUrl);
    existing.prNumber = n;
    if (pr.prUrl) existing.prUrl = pr.prUrl;
    if (pr.title != null) existing.title = pr.title;
    if (pr.createdAt != null) existing.createdAt = pr.createdAt;
    if (pr.source) existing.source = pr.source;
    r.prs[n] = existing;
  });
}

/**
 * Patch a specific PR's deploy sub-record and recompute its duration.
 * `patch` is (deploy, pr) => void.
 */
function updateDeploy(repo, issueNumber, prNumber, patch) {
  return updateRecord(repo, issueNumber, (r) => {
    const n = Number(prNumber);
    if (!r.prs[n]) r.prs[n] = blankPr(n);
    patch(r.prs[n].deploy, r.prs[n]);
    r.prs[n].deploy.durationMs = durationOf(r.prs[n].deploy);
  });
}

function prsArray(record) {
  return Object.values(record.prs || {}).sort((a, b) => b.prNumber - a.prNumber);
}

// Return a light-weight status map for a list of issue numbers in one read.
function getStatuses(repo, issueNumbers) {
  const state = load();
  const out = {};
  for (const n of issueNumbers) {
    const raw = state.issues[key(repo, n)];
    const { record } = migrate(raw, repo, n);
    out[n] = {
      work: {
        status: record.work.status,
        prNumber: record.work.prNumber,
        prUrl: record.work.prUrl,
        startedAt: record.work.startedAt,
        finishedAt: record.work.finishedAt,
        durationMs: record.work.durationMs,
        hasConversation: Boolean(record.work.conversation),
      },
      prs: prsArray(record).map((p) => ({
        prNumber: p.prNumber,
        prUrl: p.prUrl,
        title: p.title,
        createdAt: p.createdAt,
        deploy: {
          status: p.deploy.status,
          startedAt: p.deploy.startedAt,
          finishedAt: p.deploy.finishedAt,
          durationMs: p.deploy.durationMs,
          hasConversation: Boolean(p.deploy.conversation),
        },
      })),
    };
  }
  return out;
}

/**
 * Dismiss/hide an issue from the dashboard (local-only; never touches GitHub).
 * Clears any tracked work/PR/deploy state for the issue and remembers the
 * dismissal so it doesn't reappear on the next `gh issue list` refresh/poll.
 */
function dismissIssue(repo, issueNumber) {
  const state = load();
  const k = key(repo, issueNumber);
  delete state.issues[k];
  state.dismissed[k] = { at: new Date().toISOString() };
  save(state);
}

/** Un-dismiss a previously hidden issue so it reappears on next refresh. */
function undismissIssue(repo, issueNumber) {
  const state = load();
  const k = key(repo, issueNumber);
  if (state.dismissed[k]) {
    delete state.dismissed[k];
    save(state);
    return true;
  }
  return false;
}

function isDismissed(repo, issueNumber) {
  const state = load();
  return Boolean(state.dismissed[key(repo, issueNumber)]);
}

/** Set of dismissed issue numbers (as Numbers) for a given repo. */
function getDismissedNumbers(repo) {
  const state = load();
  const prefix = `${repo}#`;
  const out = new Set();
  for (const k of Object.keys(state.dismissed)) {
    if (k.startsWith(prefix)) {
      const n = Number(k.slice(prefix.length));
      if (Number.isInteger(n)) out.add(n);
    }
  }
  return out;
}

module.exports = {
  getRecord,
  updateRecord,
  upsertPr,
  updateDeploy,
  getStatuses,
  prsArray,
  dismissIssue,
  undismissIssue,
  isDismissed,
  getDismissedNumbers,
};
