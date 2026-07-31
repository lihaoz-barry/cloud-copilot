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
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_MODEL = 'claude-opus-4.8';
// Models offered in the homepage dropdown — keep in sync with `copilot --help`.
const AVAILABLE_MODELS = [
  'claude-sonnet-5',
  'claude-sonnet-4.6',
  'claude-haiku-4.5',
  'claude-opus-5',
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-opus-4.6',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.4-mini',
  'gpt-5-mini',
  'gemini-3.1-pro-preview',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'mai-code-1-flash-picker',
];

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!state.dismissed) state.dismissed = {};
    if (!state.adminChats) state.adminChats = {};
    if (!state.preIssues) state.preIssues = {};
    if (!state.adminPending) state.adminPending = {};
    if (!state.settings) state.settings = { model: DEFAULT_MODEL };
    if (!state.settings.model) state.settings.model = DEFAULT_MODEL;
    return state;
  } catch {
    return {
      issues: {},
      dismissed: {},
      adminChats: {},
      preIssues: {},
      adminPending: {},
      settings: { model: DEFAULT_MODEL },
    };
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
    changelog: null, // "What to Test" text sent to `fastlane beta changelog:"..."`
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
    if (pr.deploy && pr.deploy.changelog === undefined) {
      pr.deploy.changelog = null;
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
function appendChatMessage(repo, issueNumber, prNumber, { role, text, mode, images, model }) {
  return updateRecord(repo, issueNumber, (r) => {
    const n = Number(prNumber);
    if (!r.prs[n]) r.prs[n] = blankPr(n);
    if (!r.prs[n].chat) r.prs[n].chat = blankChat();
    r.prs[n].chat.messages.push({
      role,
      text,
      mode,
      // Which AI model ran this turn — surfaced as a badge in the UI so
      // mixed-model conversations stay readable after the fact.
      model: model || null,
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
 * Flatten every PR's deploy attempts (current + archived history), across
 * every repo/issue tracked in the store, into one array for the TestFlight
 * overview page. Only includes attempts that actually reached a state a user
 * would care about (i.e. not a still-idle deploy that was never run). Newest
 * first, by finishedAt/startedAt.
 */
function listAllBuilds() {
  const state = load();
  const out = [];
  for (const k of Object.keys(state.issues)) {
    const raw = state.issues[k];
    const { record } = migrate(raw, raw.repo, raw.issueNumber);
    for (const pr of Object.values(record.prs)) {
      const attempts = [...(pr.deployHistory || []), pr.deploy].filter((d) => d && d.status !== 'idle');
      for (const d of attempts) {
        out.push({
          repo: record.repo,
          issueNumber: record.issueNumber,
          prNumber: pr.prNumber,
          prUrl: pr.prUrl,
          title: pr.title,
          buildNumber: d.buildNumber,
          version: d.version,
          changelog: d.changelog,
          deployStatus: d.status,
          startedAt: d.startedAt,
          finishedAt: d.finishedAt,
          current: d === pr.deploy,
          merge: d === pr.deploy ? { status: pr.merge.status, forced: pr.merge.forced } : null,
        });
      }
    }
  }
  out.sort((a, b) => new Date(b.finishedAt || b.startedAt || 0) - new Date(a.finishedAt || a.startedAt || 0));
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
function appendAdminTurn(sessionId, { userText, assistantText, mode, repo, images, model }) {
  if (!sessionId) return null;
  const state = load();
  const now = new Date().toISOString();
  const chat =
    state.adminChats[sessionId] ||
    (state.adminChats[sessionId] = {
      // `id` is the stable map key clients must use to fetch/delete this chat.
      // It's set once here and never changes, independent of `sessionId` below
      // (which can legitimately be null for chats recovered by
      // reconcileInterruptedAdminTurns before a Copilot session id existed).
      id: sessionId,
      sessionId,
      title: titleFromMessage(userText),
      createdAt: now,
      updatedAt: now,
      repo: repo || null,
      messages: [],
    });
  chat.messages.push({ role: 'user', text: userText, mode, repo, images: Array.isArray(images) ? images : [], model: model || null, at: now });
  chat.messages.push({ role: 'assistant', text: assistantText, mode, model: model || null, at: now });
  chat.updatedAt = now;
  // Keep the chat's repo scope current — a conversation is pinned to whichever
  // repo (or "all repos") its most recent turn ran in.
  chat.repo = repo || null;
  save(state);
  return chat;
}

// ---------------------------------------------------------------------------
// In-flight admin turn persistence.
//
// appendAdminTurn() above only writes a turn once the copilot child process
// exits (the job's `close` event). If the server process itself is killed
// mid-turn — e.g. a chat message tells us to redeploy, and the redeploy
// restarts this very server — that `close` handler never runs and the turn
// (user message + whatever the assistant had streamed so far) is lost with
// no trace. `adminPending` is a small durable buffer, keyed by the client's
// turnId, written as soon as the turn starts and updated as chunks arrive,
// so a crash/restart mid-turn can be recovered and surfaced instead of
// silently disappearing. Cleared once the turn finishes normally.
// ---------------------------------------------------------------------------

/** Record that a new admin turn has begun (called before the child spawns). */
function startAdminTurn(turnId, { userText, mode, repo, images, sessionId, model }) {
  if (!turnId) return;
  const state = load();
  const now = new Date().toISOString();
  state.adminPending[turnId] = {
    turnId,
    sessionId: sessionId || null,
    userText,
    mode,
    repo: repo || null,
    images: Array.isArray(images) ? images : [],
    model: model || null,
    assistantText: '',
    status: 'in_progress',
    startedAt: now,
    updatedAt: now,
  };
  save(state);
}

/** Update the buffered transcript/session id for an in-flight admin turn. */
function updateAdminTurnProgress(turnId, { assistantText, sessionId }) {
  if (!turnId) return;
  const state = load();
  const pending = state.adminPending[turnId];
  if (!pending) return;
  if (typeof assistantText === 'string') pending.assistantText = assistantText;
  if (sessionId) pending.sessionId = sessionId;
  pending.updatedAt = new Date().toISOString();
  save(state);
}

/** Drop the in-flight buffer for a turn once it has finished normally. */
function finishAdminTurn(turnId) {
  if (!turnId) return;
  const state = load();
  if (state.adminPending[turnId]) {
    delete state.adminPending[turnId];
    save(state);
  }
}

/**
 * Called once at server boot. Any `adminPending` entries still marked
 * "in_progress" belong to a turn whose owning process died before it could
 * finish (and clean itself up) — most commonly a self-triggered restart
 * (e.g. asking the assistant to redeploy, which kills this very process).
 * Fold each one into the conversation history as an "interrupted" turn (with
 * whatever partial assistant text was captured) so it's visible instead of
 * silently missing, then clear the pending buffer.
 */
function reconcileInterruptedAdminTurns() {
  const state = load();
  const pendingIds = Object.keys(state.adminPending);
  if (pendingIds.length === 0) return [];

  const recovered = [];
  for (const turnId of pendingIds) {
    const pending = state.adminPending[turnId];
    if (!pending || pending.status !== 'in_progress') {
      delete state.adminPending[turnId];
      continue;
    }
    const now = new Date().toISOString();
    // Prefer the real Copilot CLI session id if one was captured; otherwise
    // this turn never got far enough to have one, so file it under a
    // synthetic key keyed by turnId so it's still visible in history.
    const key = pending.sessionId || `interrupted:${turnId}`;
    const chat =
      state.adminChats[key] ||
      (state.adminChats[key] = {
        // Stable lookup key for the client — may differ from `sessionId`
        // below when the turn died before Copilot ever assigned one.
        id: key,
        sessionId: pending.sessionId || null,
        title: titleFromMessage(pending.userText),
        createdAt: pending.startedAt,
        updatedAt: now,
        repo: pending.repo || null,
        messages: [],
      });
    chat.messages.push({
      role: 'user',
      text: pending.userText,
      mode: pending.mode,
      repo: pending.repo,
      images: pending.images,
      model: pending.model || null,
      at: pending.startedAt,
    });
    chat.messages.push({
      role: 'assistant',
      text: pending.assistantText,
      mode: pending.mode,
      model: pending.model || null,
      status: 'interrupted',
      at: now,
    });
    chat.updatedAt = now;
    chat.repo = pending.repo || null;
    delete state.adminPending[turnId];
    recovered.push({ turnId, sessionId: pending.sessionId, key });
  }
  save(state);
  return recovered;
}

/** Lightweight index of past admin conversations, newest first. */
function listAdminChats() {
  const state = load();
  return Object.entries(state.adminChats)
    .map(([key, c]) => ({
      // `id` is the stable key clients must use for GET/DELETE — falls back
      // to the map key itself for chats persisted before `id` existed.
      // `sessionId` may be null (recovered turn with no Copilot session yet)
      // and must NOT be used as a lookup key, since several distinct chats
      // can all share sessionId === null.
      id: c.id || key,
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
function getAdminChat(id) {
  const state = load();
  return state.adminChats[id] || null;
}

function deleteAdminChat(id) {
  const state = load();
  const existed = Boolean(state.adminChats[id]);
  delete state.adminChats[id];
  if (existed) save(state);
  return existed;
}

// ---------------------------------------------------------------------------
// PreIssues — lightweight "idea sticky notes" per repo. A PreIssue starts as
// a one-line thought; a chat conversation (with the local Copilot CLI) helps
// iterate it into a full issue draft (title + body), which can then be
// created as a real GitHub issue via `gh issue create`.
//
// Shape: state.preIssues["owner/repo"] = {
//   "<id>": {
//     id, repo, text, createdAt,
//     status: 'open' | 'converted',
//     draft: { title, body } | null,
//     chat: { sessionId, messages: [{ role, text, at }] },
//     issueNumber, issueUrl, // set once converted
//   }
// }
// ---------------------------------------------------------------------------

function blankPreIssue(repo, text) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    repo,
    text,
    createdAt: now,
    status: 'open', // open | converted
    draft: null,
    chat: { sessionId: null, messages: [] },
    issueNumber: null,
    issueUrl: null,
  };
}

/** All PreIssues for a repo, newest first. */
function listPreIssues(repo) {
  const state = load();
  const byRepo = state.preIssues[repo] || {};
  return Object.values(byRepo).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getPreIssue(repo, id) {
  const state = load();
  return (state.preIssues[repo] && state.preIssues[repo][id]) || null;
}

/** Create a new PreIssue from a short piece of text. Returns the new record. */
function createPreIssue(repo, text) {
  const state = load();
  if (!state.preIssues[repo]) state.preIssues[repo] = {};
  const pre = blankPreIssue(repo, text);
  state.preIssues[repo][pre.id] = pre;
  save(state);
  return pre;
}

/** Delete a PreIssue. Returns true if it existed. */
function deletePreIssue(repo, id) {
  const state = load();
  const byRepo = state.preIssues[repo];
  if (!byRepo || !byRepo[id]) return false;
  delete byRepo[id];
  save(state);
  return true;
}

/**
 * Merge a partial update into a PreIssue and persist. `patch` is a function
 * (preIssue) => void that mutates the record in place.
 */
function updatePreIssue(repo, id, patch) {
  const state = load();
  if (!state.preIssues[repo]) state.preIssues[repo] = {};
  const byRepo = state.preIssues[repo];
  if (!byRepo[id]) return null;
  patch(byRepo[id]);
  save(state);
  return byRepo[id];
}

/** Append one turn to a PreIssue's chat log. */
function appendPreIssueChatMessage(repo, id, { role, text, model }) {
  return updatePreIssue(repo, id, (pre) => {
    if (!pre.chat) pre.chat = { sessionId: null, messages: [] };
    pre.chat.messages.push({ role, text, model: model || null, at: new Date().toISOString() });
  });
}

/** Update the running Copilot CLI session id for a PreIssue's chat. */
function setPreIssueSession(repo, id, sessionId) {
  return updatePreIssue(repo, id, (pre) => {
    if (!pre.chat) pre.chat = { sessionId: null, messages: [] };
    pre.chat.sessionId = sessionId;
  });
}

/** Replace the current issue draft (title + body) parsed out of a chat turn. */
function setPreIssueDraft(repo, id, draft) {
  return updatePreIssue(repo, id, (pre) => {
    pre.draft = draft;
  });
}

/** Mark a PreIssue as converted into a real GitHub issue. */
function markPreIssueConverted(repo, id, { issueNumber, issueUrl }) {
  return updatePreIssue(repo, id, (pre) => {
    pre.status = 'converted';
    pre.issueNumber = issueNumber;
    pre.issueUrl = issueUrl;
  });
}

/** Currently configured model, falling back to the default if unset/invalid. */
function getModel() {
  const state = load();
  const model = state.settings && state.settings.model;
  return model || DEFAULT_MODEL;
}

/** Persist the model to use for all future Copilot CLI invocations. */
function setModel(model) {
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('model must be a non-empty string');
  }
  const state = load();
  state.settings.model = model.trim();
  save(state);
  return state.settings.model;
}

module.exports = {
  DEFAULT_MODEL,
  AVAILABLE_MODELS,
  getModel,
  setModel,
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
  listAllBuilds,
  prsArray,
  dismissIssue,
  undismissIssue,
  isDismissed,
  getDismissedNumbers,
  appendAdminTurn,
  startAdminTurn,
  updateAdminTurnProgress,
  finishAdminTurn,
  reconcileInterruptedAdminTurns,
  listAdminChats,
  getAdminChat,
  deleteAdminChat,
  listPreIssues,
  getPreIssue,
  createPreIssue,
  deletePreIssue,
  updatePreIssue,
  appendPreIssueChatMessage,
  setPreIssueSession,
  setPreIssueDraft,
  markPreIssueConverted,
};
