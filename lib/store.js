'use strict';

/**
 * Tiny JSON-file state store — the single source of truth for the lifecycle of
 * every long-running action (Create PR + per-PR Deploy + per-PR Merge).
 *
 * We deliberately avoid a native SQLite dependency so the demo stays
 * `npm install express`-only. State is small (a handful of issues), so a single
 * JSON file that is rewritten atomically is more than enough.
 *
 * Shape (v4):
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
 *                       startedAt, finishedAt, durationMs,
 *                       buildNumber, version },
 *             merge:  { status, method, forced, sessionId, conversation,
 *                       exitCode, startedAt, finishedAt, durationMs },
 *             deployHistory: [ <archived deploy snapshots>, oldest first ],
 *             chat: { sessionId, messages: [{ role, text, mode, images, at }] }
 *                     // images: [{ url, name }] — attachments sent with a user turn
 *           }
 *         }
 *       }
 *     }
 *   }
 *
 * Every timed sub-record (work + each PR's deploy + each PR's merge) carries
 * startedAt / finishedAt / durationMs so the frontend can render timing from
 * cache alone and survive reconnects.
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
    if (!state.adminChats) state.adminChats = {};
    return state;
  } catch {
    return { issues: {}, dismissed: {}, adminChats: {} };
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
    buildNumber: null, // captured from an ios-testflight deploy transcript, if found
    version: null,
  };
}

function blankMerge() {
  return {
    status: 'idle', // idle | merging | success | failed
    method: 'merge', // merge | squash | rebase (only 'merge' is used today)
    forced: false, // true if merged without requiring deploy success
    sessionId: null,
    conversation: '',
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  };
}

function blankChat() {
  return {
    sessionId: null, // resumed across turns; distinct from work.sessionId once first used
    messages: [], // [{ role: 'user'|'assistant', text, mode: 'plan'|'apply', at }]
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
    merge: blankMerge(),
    deployHistory: [], // archived past `deploy` snapshots, oldest first
    chat: blankChat(),
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

  // v3: backfill `merge` sub-record + deploy build/version fields onto every
  // existing PR entry that predates them.
  for (const pr of Object.values(r.prs)) {
    if (!pr.merge) {
      pr.merge = blankMerge();
      changed = true;
    }
    if (pr.deploy && pr.deploy.buildNumber === undefined) {
      pr.deploy.buildNumber = null;
      pr.deploy.version = null;
      changed = true;
    }
    // v4: backfill deploy history + PR chat log.
    if (!pr.deployHistory) {
      pr.deployHistory = [];
      changed = true;
    }
    if (!pr.chat) {
      pr.chat = blankChat();
      changed = true;
    }
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
 * Remove auto-discovered PR entries (source: 'gh') that no longer match on a
 * fresh scan — e.g. after tightening the match heuristic, or if a PR's body
 * was edited to no longer reference this issue. Never removes `source: 'work'`
 * entries: those were created BY cloud-copilot for this exact issue, so no
 * text-matching heuristic is needed to trust them.
 */
function pruneStaleGhPrs(repo, issueNumber, validPrNumbers) {
  return updateRecord(repo, issueNumber, (r) => {
    const valid = new Set(validPrNumbers.map(Number));
    for (const k of Object.keys(r.prs)) {
      const pr = r.prs[k];
      if (pr.source === 'gh' && !valid.has(pr.prNumber)) delete r.prs[k];
    }
  });
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

/**
 * Patch a specific PR's merge sub-record and recompute its duration.
 * `patch` is (merge, pr) => void.
 */
function updateMerge(repo, issueNumber, prNumber, patch) {
  return updateRecord(repo, issueNumber, (r) => {
    const n = Number(prNumber);
    if (!r.prs[n]) r.prs[n] = blankPr(n);
    patch(r.prs[n].merge, r.prs[n]);
    r.prs[n].merge.durationMs = durationOf(r.prs[n].merge);
  });
}

/**
 * Start a fresh deploy attempt for a PR, archiving the previous one (if it
 * reached a terminal state) into `deployHistory` first — so every build
 * number/version a PR has ever shipped stays visible, not just the latest.
 */
function startNewDeploy(repo, issueNumber, prNumber) {
  return updateRecord(repo, issueNumber, (r) => {
    const n = Number(prNumber);
    if (!r.prs[n]) r.prs[n] = blankPr(n);
    const pr = r.prs[n];
    const terminal = ['success', 'failed', 'aborted'].includes(pr.deploy.status);
    if (terminal && pr.deploy.finishedAt) {
      if (!pr.deployHistory) pr.deployHistory = [];
      pr.deployHistory.push({ ...pr.deploy });
    }
    pr.deploy = blankDeploy();
    pr.deploy.status = 'deploying';
    pr.deploy.startedAt = new Date().toISOString();
  });
}

/**
 * Append one turn to a PR's chat log (the plan/apply conversation used to
 * iterate on it from the PR detail page).
 */
function appendChatMessage(repo, issueNumber, prNumber, { role, text, mode, images }) {
  return updateRecord(repo, issueNumber, (r) => {
    const n = Number(prNumber);
    if (!r.prs[n]) r.prs[n] = blankPr(n);
    if (!r.prs[n].chat) r.prs[n].chat = blankChat();
    r.prs[n].chat.messages.push({
      role,
      text,
      mode,
      images: Array.isArray(images) ? images : [],
      at: new Date().toISOString(),
    });
  });
}

/**
 * After a successful "apply" turn pushes new commits to the PR's branch, the
 * previous Deploy no longer reflects the current code and Merge would be
 * merging stale work — archive the old Deploy into history, reset Deploy to
 * idle (not "deploying" — nothing has been triggered yet), and re-lock Merge.
 */
function resetForNewCommits(repo, issueNumber, prNumber) {
  return updateRecord(repo, issueNumber, (r) => {
    const n = Number(prNumber);
    if (!r.prs[n]) r.prs[n] = blankPr(n);
    const pr = r.prs[n];
    const terminal = ['success', 'failed', 'aborted'].includes(pr.deploy.status);
    if (terminal && pr.deploy.finishedAt) {
      if (!pr.deployHistory) pr.deployHistory = [];
      pr.deployHistory.push({ ...pr.deploy });
    }
    pr.deploy = blankDeploy();
    pr.merge = blankMerge();
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
          buildNumber: p.deploy.buildNumber,
          version: p.deploy.version,
        },
        merge: {
          status: p.merge.status,
          forced: p.merge.forced,
          startedAt: p.merge.startedAt,
          finishedAt: p.merge.finishedAt,
          durationMs: p.merge.durationMs,
          hasConversation: Boolean(p.merge.conversation),
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

// ---------------------------------------------------------------------------
// Admin terminal conversation history.
//
// Unlike the per-issue/PR chats above, the admin terminal isn't scoped to any
// repo — it's a free-form Copilot CLI conversation rooted at REPOS_ROOT. The
// Copilot CLI's own `--resume=<id>` session id is the natural primary key: it
// stays stable across turns of the same conversation, and a fresh id means a
// fresh conversation. We keep a lightweight index (title, timestamps, message
// count) alongside the full transcript so the history menu can list past
// conversations without loading every transcript.
// ---------------------------------------------------------------------------

function titleFromMessage(text) {
  const line = String(text || '').trim().split('\n')[0];
  return line.length > 60 ? `${line.slice(0, 57)}...` : line || '(untitled)';
}

/**
 * Append one user+assistant turn to an admin conversation, creating it if
 * this is the first turn. `sessionId` is the Copilot CLI's own session id.
 */
function appendAdminTurn(sessionId, { userText, assistantText, mode, repo, images }) {
  if (!sessionId) return null;
  const state = load();
  const now = new Date().toISOString();
  const chat =
    state.adminChats[sessionId] ||
    (state.adminChats[sessionId] = {
      sessionId,
      title: titleFromMessage(userText),
      createdAt: now,
      updatedAt: now,
      repo: repo || null,
      messages: [],
    });
  chat.messages.push({ role: 'user', text: userText, mode, repo, images: Array.isArray(images) ? images : [], at: now });
  chat.messages.push({ role: 'assistant', text: assistantText, mode, at: now });
  chat.updatedAt = now;
  // Keep the chat's repo scope current — a conversation is pinned to whichever
  // repo (or "all repos") its most recent turn ran in.
  chat.repo = repo || null;
  save(state);
  return chat;
}

/** Lightweight index of past admin conversations, newest first. */
function listAdminChats() {
  const state = load();
  return Object.values(state.adminChats)
    .map((c) => ({
      sessionId: c.sessionId,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      repo: c.repo || null,
      messageCount: c.messages.length,
    }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

/** Full transcript for one admin conversation, or null if not found. */
function getAdminChat(sessionId) {
  const state = load();
  return state.adminChats[sessionId] || null;
}

function deleteAdminChat(sessionId) {
  const state = load();
  const existed = Boolean(state.adminChats[sessionId]);
  delete state.adminChats[sessionId];
  if (existed) save(state);
  return existed;
}

module.exports = {
  getRecord,
  updateRecord,
  upsertPr,
  pruneStaleGhPrs,
  updateDeploy,
  updateMerge,
  startNewDeploy,
  appendChatMessage,
  resetForNewCommits,
  getStatuses,
  prsArray,
  dismissIssue,
  undismissIssue,
  isDismissed,
  getDismissedNumbers,
  appendAdminTurn,
  listAdminChats,
  getAdminChat,
  deleteAdminChat,
};
