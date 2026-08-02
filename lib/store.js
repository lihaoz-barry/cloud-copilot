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

const DATA_DIR = process.env.CC_DATA_DIR || path.join(__dirname, '..', 'data');
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
    recoveryAttempted: false,
    conflictResolved: false,
    recoveryMessage: null,
    cleanup: null, // post-merge cleanup summary (issue + superseded PRs closed)
  };
}

function blankChat() {
  return {
    sessionId: null, // resumed across turns; distinct from work.sessionId once first used
    messages: [], // [{ role: 'user'|'assistant', text, mode: 'plan'|'apply', at }]
  };
}

/**
 * "Update this PR with the latest base branch" — a Copilot session that merges
 * base → PR head (never the other way round) and pushes the result. Same shape
 * as the other action sub-records so the job manager, abort path and orphan
 * reconciler treat it exactly like Deploy/Merge.
 */
function blankUpdate() {
  return {
    status: 'idle', // idle | updating | success | failed | aborted
    sessionId: null,
    conversation: '',
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    baseRefName: null,
    message: null, // human-readable outcome ("merged main, 0 behind")
  };
}

/**
 * "Review this PR and improve it" — the third stage the scheduler drives for a
 * committed issue (issue #64). One Copilot session reviews the PR's current
 * head commit and applies the improvements it finds in the same run.
 * `reviewedSha` records which commit was reviewed, so the same code is never
 * reviewed twice while new commits make the PR eligible again.
 */
function blankReview() {
  return {
    status: 'idle', // idle | reviewing | success | failed | aborted
    sessionId: null,
    conversation: '',
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    reviewedSha: null, // head commit this review ran against
    lastReviewedSha: null, // last head commit a review COMPLETED against
    message: null,
  };
}

function blankPr(prNumber, prUrl = null, extra = {}) {
  return {
    prNumber: Number(prNumber),
    prUrl: prUrl || null,
    title: null,
    createdAt: null,
    source: 'work', // work | gh
    // OPEN | MERGED | CLOSED, straight from GitHub. null on records written
    // before this field existed — treated as visible, so an upgrade never
    // makes rows silently disappear before the next sync fills it in.
    state: null,
    headRefName: null,
    // The branch this PR targets. Kept alongside the head so the local
    // three-minute sync sweep can compare the two without asking GitHub.
    baseRefName: null,
    headCommit: null, // { sha, abbrev, committedDate, headline, url }
    // How this PR's branch relates to its base branch, collected per repo from
    // GitHub (see gh.listPrSync). null until the first sync — rendered as
    // "unknown", never as "clean".
    sync: null,
    ...extra,
    deploy: blankDeploy(),
    merge: blankMerge(),
    update: blankUpdate(),
    review: blankReview(),
    deployHistory: [], // archived past `deploy` snapshots, oldest first
    chat: blankChat(),
  };
}

function blankRecord(repo, issueNumber) {
  return { repo, issueNumber, work: blankWork(), auto: blankAuto(), prs: {} };
}

/**
 * Per-issue bookkeeping for the automatic scheduler (issue #64). Only issues
 * labelled `committed` on GitHub are driven, but the retry budget has to
 * survive a restart, so it lives on the record rather than in memory.
 */
function blankAuto() {
  return {
    attempts: 0, // consecutive failures of the current stage
    lastAction: null, // work | update | review
    lastError: null,
    lastRunAt: null,
    nextAttemptAt: null, // epoch ms; the scheduler skips the issue until then
    needsAttention: false, // retry budget exhausted — a human has to look
  };
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
  // v9 (#64): scheduler bookkeeping.
  if (!r.auto) {
    r.auto = blankAuto();
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
    if (pr.merge.recoveryAttempted === undefined) {
      pr.merge.recoveryAttempted = false;
      pr.merge.conflictResolved = false;
      pr.merge.recoveryMessage = null;
      changed = true;
    }
    // v6: backfill the post-merge cleanup summary.
    if (pr.merge && pr.merge.cleanup === undefined) {
      pr.merge.cleanup = null;
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
    // v7 (#58): base-branch sync status + the "update from base" action.
    if (pr.sync === undefined) {
      pr.sync = null;
      changed = true;
    }
    if (!pr.update) {
      pr.update = blankUpdate();
      changed = true;
    }
    // v9 (#64): the scheduler's review-and-improve pass.
    if (!pr.review) {
      pr.review = blankReview();
      changed = true;
    }
    // v8 (#58): the base branch, so the local sync sweep knows what to compare
    // against even before the next GitHub read.
    if (pr.baseRefName === undefined) {
      pr.baseRefName = (pr.sync && pr.sync.baseRefName) || null;
      changed = true;
    }
    // Drop sync objects written by an earlier, differently-shaped experiment:
    // without `state` they can only ever render as an unexplainable "?".
    if (pr.sync && typeof pr.sync.state !== 'string') {
      pr.sync = null;
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
 * Non-terminal statuses per action. A record sitting in one of these while no
 * job is actually running is an orphan: the process died with the server (or
 * was killed outside the job manager), so nothing will ever write its terminal
 * state. The row would otherwise stay "working"/"Deploying…" forever AND keep
 * the repo looking busy, with an Abort button that has nothing left to kill.
 */
const LIVE_STATUS = {
  work: 'working',
  deploy: 'deploying',
  merge: 'merging',
};

const ABORT_NOTE = (what) =>
  `\n[${what} was interrupted — the process is no longer running, so cloud-copilot marked it aborted]\n`;

/**
 * Force one stuck action into `aborted`, but ONLY if it is still sitting in its
 * live status. Returns true when something was actually changed, so callers can
 * tell "there was nothing to reconcile" from "I just unstuck a phantom".
 *
 * `action` is 'work' | 'deploy' | 'merge'; `prNumber` is required for the
 * latter two.
 */
function forceAbort(repo, issueNumber, action, prNumber = null) {
  const live = LIVE_STATUS[action];
  if (!live) return false;
  let changed = false;
  updateRecord(repo, issueNumber, (r) => {
    const target =
      action === 'work' ? r.work : r.prs[Number(prNumber)] && r.prs[Number(prNumber)][action];
    if (!target || target.status !== live) return;
    target.status = 'aborted';
    target.finishedAt = new Date().toISOString();
    target.conversation = (target.conversation || '') + ABORT_NOTE(action === 'work' ? 'PR creation' : action);
    changed = true;
    if (action !== 'work') {
      const pr = r.prs[Number(prNumber)];
      pr[action].durationMs = durationOf(pr[action]);
    }
  });
  return changed;
}

/**
 * Sweep every stored record for actions left in a live status with no process
 * behind them. Called once at startup — a restart kills every child, so any
 * survivor of the previous process is by definition an orphan — and given the
 * keys still running so a live job is never touched.
 *
 * Returns the list of reconciled descriptors, for the startup log.
 */
function reconcileOrphanedJobs(isRunning = () => false) {
  const state = load();
  const fixed = [];
  for (const rec of Object.values(state.issues || {})) {
    if (!rec || !rec.repo || rec.issueNumber == null) continue;
    const { repo, issueNumber } = rec;
    if (rec.work && rec.work.status === LIVE_STATUS.work && !isRunning(`${repo}#${issueNumber}:work`)) {
      if (forceAbort(repo, issueNumber, 'work')) fixed.push(`${repo}#${issueNumber}:work`);
    }
    for (const pr of Object.values(rec.prs || {})) {
      for (const action of ['deploy', 'merge']) {
        const sub = pr[action];
        if (!sub || sub.status !== LIVE_STATUS[action]) continue;
        const k = `${repo}#${issueNumber}:${action}:${pr.prNumber}`;
        if (isRunning(k)) continue;
        if (forceAbort(repo, issueNumber, action, pr.prNumber)) fixed.push(k);
      }
    }
  }
  return fixed;
}

/**
 * Refresh the GitHub state (OPEN/MERGED/CLOSED) of every PR already tracked for
 * this issue, from a { prNumber -> state } map covering the whole repo.
 *
 * This deliberately does NOT go through the issue's body-match scan. A PR that
 * cloud-copilot created itself (`source: 'work'`) is tracked regardless of
 * whether its body still names the issue, so matching alone would leave such a
 * PR's state frozen at whatever it was when created — and a long-closed PR
 * would keep its Deploy/Merge buttons forever. Returns the numbers whose state
 * is now CLOSED, ready to hand to `pruneClosedPrs`.
 */
function refreshPrStates(repo, issueNumber, stateByNumber) {
  const closed = [];
  updateRecord(repo, issueNumber, (r) => {
    for (const k of Object.keys(r.prs)) {
      const pr = r.prs[k];
      const next = stateByNumber[String(pr.prNumber)] || stateByNumber[Number(pr.prNumber)];
      if (!next) continue;
      pr.state = next;
      if (next === 'CLOSED') closed.push(Number(pr.prNumber));
    }
  });
  return closed;
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
    if (pr.state != null) existing.state = pr.state;
    // Branch + tip commit, so a row can say which code it is actually about
    // without the client making its own GitHub calls.
    if (pr.headRefName != null) existing.headRefName = pr.headRefName;
    if (pr.baseRefName != null) existing.baseRefName = pr.baseRefName;
    if (pr.headCommit !== undefined) existing.headCommit = pr.headCommit;
    // Base-branch sync status. `undefined` means "this caller didn't collect
    // it" and leaves the previous value alone; an explicit null clears it.
    if (pr.sync !== undefined) existing.sync = pr.sync;
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
 * Patch a specific PR's "update from base" sub-record and recompute duration.
 * `patch` is (update, pr) => void.
 */
function updateBranchUpdate(repo, issueNumber, prNumber, patch) {
  return updateRecord(repo, issueNumber, (r) => {
    const n = Number(prNumber);
    if (!r.prs[n]) r.prs[n] = blankPr(n);
    if (!r.prs[n].update) r.prs[n].update = blankUpdate();
    patch(r.prs[n].update, r.prs[n]);
    r.prs[n].update.durationMs = durationOf(r.prs[n].update);
  });
}

/**
 * Patch a specific PR's "review and improve" sub-record and recompute duration.
 * `patch` is (review, pr) => void.
 */
function updateReview(repo, issueNumber, prNumber, patch) {
  return updateRecord(repo, issueNumber, (r) => {
    const n = Number(prNumber);
    if (!r.prs[n]) r.prs[n] = blankPr(n);
    if (!r.prs[n].review) r.prs[n].review = blankReview();
    patch(r.prs[n].review, r.prs[n]);
    r.prs[n].review.durationMs = durationOf(r.prs[n].review);
  });
}

/** Patch an issue's scheduler bookkeeping. `patch` is (auto, record) => void. */
function updateAuto(repo, issueNumber, patch) {
  return updateRecord(repo, issueNumber, (r) => {
    if (!r.auto) r.auto = blankAuto();
    patch(r.auto, r);
  });
}

/**
 * Store the freshly collected base-branch sync status of one PR. Kept separate
 * from upsertPr so a targeted refresh (right after an update run pushed new
 * commits) doesn't have to re-supply the rest of the PR's metadata.
 */
function setPrSync(repo, issueNumber, prNumber, sync) {
  return updateRecord(repo, issueNumber, (r) => {
    const n = Number(prNumber);
    if (!r.prs[n]) return;
    r.prs[n].sync = sync || null;
  });
}

/**
 * Every PR of a repo the three-minute sync sweep should compare: open (or
 * not-yet-classified) rows that have both refs. Reads the whole state once, so
 * a sweep costs one file read no matter how many issues a repo has.
 * @returns {Array<{ issueNumber, prNumber, headRefName, baseRefName, state }>}
 */
function listPrsForSync(repo) {
  const state = load();
  const out = [];
  for (const k of Object.keys(state.issues)) {
    const raw = state.issues[k];
    if (!raw || raw.repo !== repo) continue;
    const { record } = migrate(raw, raw.repo, raw.issueNumber);
    for (const pr of Object.values(record.prs || {})) {
      // MERGED/CLOSED branches are usually deleted on the remote, so comparing
      // them would only produce noise (and a badge nobody sees).
      if (pr.state === 'MERGED' || pr.state === 'CLOSED') continue;
      if (!pr.headRefName) continue;
      // A null base is fine: the sweep falls back to the repo's default
      // branch, which is what a PR opened before this field existed targets.
      const baseRefName = pr.baseRefName || (pr.sync && pr.sync.baseRefName) || null;
      out.push({
        issueNumber: record.issueNumber,
        prNumber: pr.prNumber,
        headRefName: pr.headRefName,
        baseRefName,
        state: pr.state || null,
      });
    }
  }
  return out;
}

/**
 * Every stored record of a repo, in one read.
 *
 * Exists for the startup reconciler, which has to ask each action of each issue
 * "does the process you claim to be waiting on still exist?" — a question that
 * needs the whole file rather than a known list of issue numbers, since a row
 * left mid-action is exactly the one nobody is currently looking at.
 * @returns {Array<object>} migrated records
 */
function listRecords(repo) {
  const state = load();
  const out = [];
  for (const k of Object.keys(state.issues)) {
    const raw = state.issues[k];
    if (!raw || raw.repo !== repo) continue;
    out.push(migrate(raw, raw.repo, raw.issueNumber).record);
  }
  return out;
}

/**
 * { [prNumber]: sync } for a whole repo — what the badge poller reads every
 * three minutes. Pure state.json, never `gh` and never git.
 */
function getRepoSync(repo) {
  const state = load();
  const out = {};
  for (const k of Object.keys(state.issues)) {
    const raw = state.issues[k];
    if (!raw || raw.repo !== repo) continue;
    const { record } = migrate(raw, raw.repo, raw.issueNumber);
    for (const pr of Object.values(record.prs || {})) {
      // Only the current shape: a legacy object without `state` would render
      // as a permanent "?" nobody can explain.
      if (pr.sync && typeof pr.sync.state === 'string') out[String(pr.prNumber)] = pr.sync;
    }
  }
  return out;
}

/**
 * Write a whole sweep's results in one pass — one read and one write for the
 * entire repo instead of a load/save cycle per PR. PRs absent from `syncByPr`
 * keep whatever they had: "we couldn't compare this one" must never be
 * mistaken for "this one is fine". Returns how many rows actually changed.
 */
function setRepoSync(repo, syncByPr) {
  const state = load();
  let changed = 0;
  for (const k of Object.keys(state.issues)) {
    const raw = state.issues[k];
    if (!raw || raw.repo !== repo) continue;
    const { record } = migrate(raw, raw.repo, raw.issueNumber);
    let touched = false;
    for (const pr of Object.values(record.prs || {})) {
      const next = syncByPr[String(pr.prNumber)];
      if (!next) continue;
      const prev = pr.sync;
      pr.sync = next;
      touched = true;
      // `at` moves every sweep; only a real change is worth reporting so the
      // caller can stay quiet when nothing moved.
      if (
        !prev ||
        prev.state !== next.state ||
        prev.behindBy !== next.behindBy ||
        prev.aheadBy !== next.aheadBy
      ) changed += 1;
    }
    if (touched) state.issues[k] = record;
  }
  save(state);
  return changed;
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

// A PR that GitHub reports as CLOSED was closed WITHOUT being merged: its
// branch is usually deleted, so every pipeline action on it (Deploy, Merge,
// chat) is guaranteed to fail on `git fetch`/`git checkout`. Such rows are
// dead weight in the local pipeline, so they are hidden by default. MERGED is
// deliberately NOT hidden — that is the pipeline's successful end state and
// the row is the record of it. `state: null` (records written before the field
// existed, or a PR we have not synced yet) stays visible: never make a row
// vanish on a guess.
function isClosedUnmerged(pr) {
  return pr && pr.state === 'CLOSED';
}

function prsArray(record, { includeClosed = false } = {}) {
  const all = Object.values(record.prs || {});
  const visible = includeClosed ? all : all.filter((p) => !isClosedUnmerged(p));
  return visible.sort((a, b) => b.prNumber - a.prNumber);
}

/**
 * Forget locally-tracked PRs that GitHub reports as CLOSED (not merged).
 *
 * Only records with NO local footprint are deleted — never-deployed,
 * never-merged, never-chatted, no archived deploy history. A closed PR that
 * WAS deployed keeps its record (it just stops being listed), because
 * `listAllBuilds()` reads those archived attempts for the TestFlight overview
 * and dropping them would silently rewrite build history.
 *
 * `closedPrNumbers` comes from the same `gh pr list` scan that refreshes the
 * issue, so this only ever acts on state GitHub actually confirmed.
 */
function pruneClosedPrs(repo, issueNumber, closedPrNumbers) {
  const closed = new Set((closedPrNumbers || []).map(Number));
  if (!closed.size) return getRecord(repo, issueNumber);
  return updateRecord(repo, issueNumber, (r) => {
    for (const k of Object.keys(r.prs)) {
      const pr = r.prs[k];
      if (!closed.has(Number(pr.prNumber))) continue;
      const hasHistory =
        (pr.deployHistory && pr.deployHistory.length > 0) ||
        (pr.deploy && pr.deploy.status !== 'idle') ||
        (pr.merge && pr.merge.status !== 'idle') ||
        (pr.chat && pr.chat.messages && pr.chat.messages.length > 0);
      if (!hasHistory) delete r.prs[k];
      else pr.state = 'CLOSED'; // keep the record for builds history, but hidden
    }
  });
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
        state: p.state || null,
        headRefName: p.headRefName || null,
        headCommit: p.headCommit || null,
        sync: p.sync || null,
        update: {
          status: (p.update && p.update.status) || 'idle',
          startedAt: (p.update && p.update.startedAt) || null,
          finishedAt: (p.update && p.update.finishedAt) || null,
          durationMs: (p.update && p.update.durationMs) != null ? p.update.durationMs : null,
          hasConversation: Boolean(p.update && p.update.conversation),
          message: (p.update && p.update.message) || null,
        },
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
          recoveryAttempted: p.merge.recoveryAttempted,
          conflictResolved: p.merge.conflictResolved,
          recoveryMessage: p.merge.recoveryMessage,
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
          merge:
            d === pr.deploy
              ? {
                  status: pr.merge.status,
                  forced: pr.merge.forced,
                  conflictResolved: pr.merge.conflictResolved,
                  recoveryMessage: pr.merge.recoveryMessage,
                }
              : null,
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

/**
 * Automatic-scheduler settings (issue #64).
 *
 * Persisted rather than kept in memory so a restart resumes exactly the
 * automation the user switched on — otherwise every crash would silently stop
 * driving committed issues, which is the one failure mode nobody would notice.
 *
 * Shape: { enabled: boolean, repos: { "<repo>": boolean } }. A repo with no
 * entry inherits `enabled`, so switching automation on globally is enough for
 * the common single-repo case.
 */
function getSchedulerSettings() {
  const state = load();
  const s = (state.settings && state.settings.scheduler) || {};
  return {
    enabled: Boolean(s.enabled),
    repos: s.repos && typeof s.repos === 'object' ? { ...s.repos } : {},
  };
}

function setSchedulerEnabled(enabled) {
  const state = load();
  if (!state.settings.scheduler) state.settings.scheduler = { enabled: false, repos: {} };
  state.settings.scheduler.enabled = Boolean(enabled);
  save(state);
  return getSchedulerSettings();
}

/** `enabled: null` clears the override so the repo follows the global switch. */
function setRepoSchedulerEnabled(repo, enabled) {
  const state = load();
  if (!state.settings.scheduler) state.settings.scheduler = { enabled: false, repos: {} };
  if (!state.settings.scheduler.repos) state.settings.scheduler.repos = {};
  if (enabled === null || enabled === undefined) delete state.settings.scheduler.repos[repo];
  else state.settings.scheduler.repos[repo] = Boolean(enabled);
  save(state);
  return getSchedulerSettings();
}

/** Is the scheduler allowed to act on this repo right now? */
function isSchedulerEnabledFor(repo) {
  const s = getSchedulerSettings();
  if (!s.enabled) return false;
  return Object.prototype.hasOwnProperty.call(s.repos, repo) ? Boolean(s.repos[repo]) : true;
}

module.exports = {
  DEFAULT_MODEL,
  AVAILABLE_MODELS,
  getModel,
  setModel,
  getRecord,
  updateRecord,
  forceAbort,
  reconcileOrphanedJobs,
  upsertPr,
  pruneStaleGhPrs,
  refreshPrStates,
  pruneClosedPrs,
  updateDeploy,
  updateMerge,
  updateBranchUpdate,
  updateReview,
  updateAuto,
  getSchedulerSettings,
  setSchedulerEnabled,
  setRepoSchedulerEnabled,
  isSchedulerEnabledFor,
  setPrSync,
  listPrsForSync,
  listRecords,
  getRepoSync,
  setRepoSync,
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
  titleFromMessage,
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
