'use strict';

/**
 * cloud-copilot backend
 *
 * A small control plane for driving the local GitHub Copilot CLI from a phone
 * over your LAN/VPN. It can:
 *   - list the git repos under an authorized root (REPOS_ROOT)
 *   - list each repo's GitHub issues via `gh` (cached, refreshable)
 *   - "Create PR": run `copilot -p` in the repo to implement an issue and open a PR
 *   - "Deploy": run the testflight-deploy skill via copilot to ship to TestFlight
 *   - track per-issue status (idle/working/success/failed) so the UI can colour
 *     each action yellow/green/red and surface the PR link or the full transcript
 *
 * Everything streams back over Server-Sent Events. Bind to localhost by default;
 * expose to your phone via LAN (HOST=0.0.0.0) behind your own VPN, or a tunnel.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execSync, execFileSync, spawn } = require('child_process');
const express = require('express');

const store = require('./lib/store');
const gh = require('./lib/gh');
const prSync = require('./lib/prSync');
const repoConfig = require('./lib/repoConfig');
const { runCopilotSSE, writeSseHead } = require('./lib/runner');
const jobs = require('./lib/jobs');
const notifier = require('./lib/notifier');
const changelogLib = require('./lib/changelog');
const { UPLOADS_DIR, saveUploadedImages, cleanupOldUploads } = require('./lib/attachments');
const { cleanupAfterMerge } = require('./lib/mergeCleanup');
const worktrees = require('./lib/worktrees');
const worktreePool = require('./lib/worktreePool');
const portPool = require('./lib/portPool');
const supervisorClient = require('./lib/supervisorClient');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const REPOS_ROOT = process.env.REPOS_ROOT || path.join(os.homedir(), 'repos');

// ---------------------------------------------------------------------------
// Locate the Copilot CLI binary without requiring COPILOT_BIN / PATH fiddling.
// ---------------------------------------------------------------------------
function resolveCopilotBin() {
  const isExecutable = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (process.env.COPILOT_BIN) return process.env.COPILOT_BIN;
  try {
    const found = execSync('command -v copilot', {
      shell: process.env.SHELL || '/bin/bash',
      encoding: 'utf8',
    }).trim();
    if (found && isExecutable(found)) return found;
  } catch {
    /* not on PATH */
  }
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    const versions = fs
      .readdirSync(nvmDir)
      .filter((v) => v.startsWith('v'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const candidate = path.join(nvmDir, v, 'bin', 'copilot');
      if (isExecutable(candidate)) return candidate;
    }
  } catch {
    /* no nvm */
  }
  // fnm, by its stable installation path rather than the per-shell symlink farm
  // under ~/.local/state/fnm_multishells/<pid>_<ts>/. That path is what `which`
  // reports, and it disappears when the shell that made it exits — which is
  // exactly what the supervisor on :8788 would be left holding after a restart.
  const fnmDir = path.join(os.homedir(), '.local', 'share', 'fnm', 'node-versions');
  try {
    const versions = fs
      .readdirSync(fnmDir)
      .filter((v) => v.startsWith('v'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const candidate = path.join(fnmDir, v, 'installation', 'bin', 'copilot');
      if (isExecutable(candidate)) return candidate;
    }
  } catch {
    /* no fnm */
  }
  for (const p of [
    '/opt/homebrew/bin/copilot',
    '/usr/local/bin/copilot',
    path.join(os.homedir(), '.local', 'bin', 'copilot'),
  ]) {
    if (isExecutable(p)) return p;
  }
  return 'copilot';
}

const COPILOT_BIN = resolveCopilotBin();

const app = express();
// Raised from the default 100kb so multiple base64-encoded image attachments
// (phone photos/screenshots) fit in a chat turn's JSON body. Sized for up to
// MAX_IMAGES_PER_TURN (4) images at MAX_IMAGE_BYTES (8MB) each: 4 * 8MB raw
// becomes ~43MB once base64-encoded, plus JSON/text overhead, so 40mb gives
// enough headroom to avoid tripping a 413 on a full-size multi-image turn.
app.use(express.json({ limit: '40mb' }));
// Turn body-parser's bare 413 (PayloadTooLargeError) and JSON parse errors
// into a friendly JSON response instead of a bodyless/plain-text failure.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({
      error: 'Attachment(s) too large. Please use smaller/fewer images and try again.',
    });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed request body.' });
  }
  next(err);
});
app.use(express.static('public'));
// Serve saved chat-attachment images back to the browser so past
// conversations still show what was attached when their transcript reloads.
app.use('/uploads', express.static(UPLOADS_DIR));

// Sweep uploaded chat images past their retention window so disk usage from
// attachments doesn't grow unbounded; run at startup and periodically.
cleanupOldUploads();
setInterval(cleanupOldUploads, 6 * 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Resolve a repo by name, but only if it lives directly under REPOS_ROOT
// (prevents path traversal / touching arbitrary directories).
function resolveRepo(name) {
  if (!name || name.includes('/') || name.includes('..')) return null;
  const repos = gh.listRepos(REPOS_ROOT);
  return repos.find((r) => r.name === name) || null;
}

// Actions that run in the repo's ONE shared working tree, and must therefore
// stay mutually exclusive per repo.
//
// Since issue #64 that is only Deploy, Merge and Restart main: Deploy drives
// fastlane / Xcode / the login keychain, none of which are safe to run twice at
// once; Merge's recovery agent checks out the PR branch in the main tree; and
// Restart main relaunches this very process. Everything else (Create PR,
// Update, Review, Chat) now runs in its own worktree from lib/worktreePool and
// is free to run concurrently.
const WORKING_TREE_ACTION_RE = /^(\d+):(deploy|merge|restart)(?::(\d+))?$/;

// Working-tree locks held by actions that are NOT backed by a `jobs` child
// process — currently just "Restart main", which runs a few short git commands
// in-process and then relaunches the server. Held keys use the same
// `<repo>#<n>:<action>` shape so findOtherRepoBusyKey/describeBusyKey treat
// them exactly like a running job.
const manualLocks = new Set();

// Every key currently holding a working-tree lock, from both sources.
function heldWorkingTreeKeys() {
  return [...jobs.runningKeys(), ...manualLocks];
}

// First OTHER running job (excluding `excludeKey`) that touches this repo's
// shared working tree, or null. Used to block a second such action from
// starting concurrently.
function findOtherRepoBusyKey(repoName, excludeKey) {
  const prefix = `${repoName}#`;
  for (const k of heldWorkingTreeKeys()) {
    if (!k.startsWith(prefix) || k === excludeKey) continue;
    if (WORKING_TREE_ACTION_RE.test(k.slice(prefix.length))) return k;
  }
  return null;
}

// The issue number behind a repo's current working-tree-touching job, if any
// — used by the issues list so the client can grey out other issues/PRs.
function repoBusyIssueNumber(repoName) {
  const k = findOtherRepoBusyKey(repoName, null);
  if (!k) return null;
  const m = k.slice(repoName.length + 1).match(WORKING_TREE_ACTION_RE);
  return m ? Number(m[1]) : null;
}

const BUSY_ACTION_LABEL = {
  work: 'a Create PR run',
  deploy: 'a Deploy',
  chat: 'a chat turn',
  merge: 'a Merge',
  update: 'a branch update from the base branch',
  review: 'a review-and-improve run',
  restart: 'a Restart main',
};

// ---------------------------------------------------------------------------
// Worktree leases (issue #64)
//
// Every action that writes files now runs in its own `git worktree` with its
// own test port, so several of them can run on one repo at the same time. The
// two helpers below are the whole contract:
//
//   leaseWorktree()  acquire a checkout + port, or explain why not
//   releaseLease()   give both back, turning the outcome into transcript lines
//
// `releaseLease` never throws: cleanup must not be able to change a job's
// result. It returns the same rows lib/worktrees.js produces, so the existing
// `worktrees.formatCleanup` renders them unchanged.
// ---------------------------------------------------------------------------

async function leaseWorktree(repo, opts) {
  return worktreePool.acquire(repo, opts);
}

/**
 * How to report a lease that could not be taken.
 *
 * "Every slot is busy" and "another task already holds this branch" are states
 * of the machine, not defects of the run: the same request will work in a few
 * minutes. They are therefore `blocked`, which the scheduler retries next sweep
 * instead of counting against the issue's retry budget (three `failed` runs
 * flag it for a human).
 */
function leaseFailureStatus(err) {
  return err && (err.code === 'BRANCH_BUSY' || err.code === 'NO_CAPACITY') ? 'blocked' : 'failed';
}

function releaseLease(lease, { fallbackRef = null } = {}) {
  if (!lease) return [];
  try {
    return lease.release({ fallbackRef });
  } catch {
    return [];
  }
}

/**
 * Start a job that owns a worktree lease, and make sure the lease is given back
 * when the job never actually starts.
 *
 * Both ways that can happen are silent otherwise:
 *   - `startJob` throws ("job already running") when two requests for the same
 *     key race past the earlier check — there is an `await` between them, so
 *     two taps on one button are enough;
 *   - a spawn failure returns a job that is already `done` and never calls
 *     `onDone`, which is where every lease is normally released.
 * Either way the worktree and its port would be held until the process exits.
 *
 * @returns {import('./lib/jobs').Job|null} null when the job never started, in
 *   which case `onFail` has already answered the request.
 */
function startLeasedJob(lease, key, options, { fallbackRef = null, onFail = null } = {}) {
  let job;
  try {
    job = jobs.startJob(key, options);
  } catch (err) {
    releaseLease(lease, { fallbackRef });
    if (onFail) onFail(err);
    return null;
  }
  if (job.status !== 'running') releaseLease(lease, { fallbackRef });
  return job;
}

// One sentence appended to every prompt that runs inside a lease, so the agent
// knows which port it may bind. Without this each concurrent run would reach
// for the project's default port and the second one would fail to boot.
function portNote(lease) {
  if (!lease || !lease.port) return '';
  return (
    ` You are running in an isolated git worktree; several agents work on this ` +
    `repository at the same time. If you need to start the app or a test server, ` +
    `use port ${lease.port} (also available as $PORT and $CC_TEST_PORT) and never ` +
    `the project's default port, which is already in use.`
  );
}

// Human-readable description of what's holding a repo's working-tree lock,
// for the "blocked" message shown when a second action tries to start.
function describeBusyKey(repoName, busyKey) {
  const m = busyKey.slice(repoName.length + 1).match(WORKING_TREE_ACTION_RE);
  if (!m) return `something else is already running in ${repoName}`;
  const [, issueNum, action, prNum] = m;
  const label = BUSY_ACTION_LABEL[action] || action;
  // Restart main isn't tied to an issue — don't invent a "#0" for it.
  if (action === 'restart') return `${label} is already running in ${repoName}`;
  const prSuffix = prNum ? ` (PR #${prNum})` : '';
  return `${label}${prSuffix} is already running for issue #${issueNum} in ${repoName}`;
}

/**
 * Abort one action, whether or not a live process is still behind it.
 *
 * Killing the job manager's child is only half the story: if the server was
 * restarted (or the process died some other way) while the action was running,
 * nothing is left to kill, yet the STORED record is still sitting at
 * "working"/"deploying"/"merging". Before this, cancel would return
 * `{cancelled:false}` and change nothing — the row stayed stuck forever and the
 * Abort button visibly did nothing.
 *
 * So: kill the job if there is one, and in every case force the stored record
 * out of its live status. `cancelled` says a process was actually signalled,
 * `reconciled` says a phantom record was cleaned up; the client only needs
 * `aborted` (either of the two) to know the row will now settle.
 */
function abortAction(repoName, issueNumber, action, prNumber = null) {
  const key = prNumber == null
    ? `${repoName}#${issueNumber}:${action}`
    : `${repoName}#${issueNumber}:${action}:${prNumber}`;
  const cancelled = jobs.cancelJob(key);
  // A live job writes its own terminal state from the `close` handler, so only
  // touch the record when there was nothing left to kill. `cancelJob` also
  // asks the supervisor to stop anything running under this key that this
  // process never adopted; that answers false, and settling the record is
  // exactly right — no local job means no `close` handler to write it.
  const reconciled = cancelled ? false : store.forceAbort(repoName, issueNumber, action, prNumber);
  return { cancelled, reconciled, aborted: cancelled || reconciled };
}

/** Shared guard for the cancel routes: `<n>` reaches the store now. */
function badIssueNumber(res, n) {
  if (Number.isInteger(n) && n > 0) return false;
  res.status(400).json({ error: 'invalid issue number' });
  return true;
}

// ---------------------------------------------------------------------------
// Context for task-aware push notifications (issue #27). A push has to say
// *which* task of *which* repo finished, so every job's `meta` carries the
// repo/issue/PR identity plus a human subject line. These lookups are all
// cache-only (no `gh` calls) — a missing title just means a shorter push.
// ---------------------------------------------------------------------------

function cachedGhTitle(ownerRepo, kind, number) {
  try {
    const entry = gh.cache.get(ownerRepo, kind);
    const hit = entry && entry.data.find((x) => x.number === number);
    return (hit && hit.title) || null;
  } catch {
    return null;
  }
}

const cachedIssueTitle = (repo, n) => (repo.ownerRepo ? cachedGhTitle(repo.ownerRepo, 'issues', n) : null);
const cachedPrTitle = (repo, prNumber) =>
  repo.ownerRepo ? cachedGhTitle(repo.ownerRepo, 'prs', prNumber) : null;

// How many Create PR runs this repo has started since the server came up —
// lets a push say "本 repo 第 2 个 Create PR" when several are queued up on the
// same repo, which is otherwise the hardest case to tell apart on a phone.
const createPrRuns = new Map();
function nextCreatePrSequence(repoName) {
  const n = (createPrRuns.get(repoName) || 0) + 1;
  createPrRuns.set(repoName, n);
  return n;
}

// Map a UI mode to copilot approval flags.
// `--allow-all` = --allow-all-tools --allow-all-paths --allow-all-urls, which is
// required for autonomous runs that touch files outside the repo working dir
// (e.g. fastlane writing to /tmp, ~/Library, the keychain) since -p can't prompt.
function approvalFlags(mode) {
  switch (mode) {
    case 'allow-all':
      return ['--allow-all'];
    case 'granular':
      return ['--allow-tool', 'shell(git)'];
    default:
      return [];
  }
}

// The AI model to use for a Copilot CLI invocation. Chats may override it per
// turn (the in-chat model dropdown sends `model`); anything else falls back to
// the global homepage setting (persisted via store.setModel), which itself
// defaults to store.DEFAULT_MODEL. Unknown/absent overrides are ignored rather
// than rejected so a stale client can never block a turn from running.
function resolveModel(override) {
  const m = typeof override === 'string' ? override.trim() : '';
  if (m && store.AVAILABLE_MODELS.includes(m)) return m;
  return store.getModel();
}

function modelFlags(override) {
  return ['--model', resolveModel(override)];
}

// ---------------------------------------------------------------------------
// Repo + issue listing
// ---------------------------------------------------------------------------

app.get('/api/repos', (req, res) => {
  const repos = gh.listRepos(REPOS_ROOT).map((r) => ({
    name: r.name,
    branch: r.branch,
    // Tip commit of the local checkout, so the repo header can say which code
    // this machine would actually deploy right now.
    headCommit: r.headCommit,
    ownerRepo: r.ownerRepo,
    github: r.github,
  }));
  res.json({ root: REPOS_ROOT, repos, committedLabel: gh.COMMITTED_LABEL });
});

// ---------------------------------------------------------------------------
// Model selection — which AI model the Copilot CLI uses for every action
// (Create PR, Deploy, chats, admin terminal). Configurable from the homepage
// dropdown; persisted in data/state.json and applied via modelFlags() above.
// ---------------------------------------------------------------------------
app.get('/api/settings/model', (req, res) => {
  res.json({ model: store.getModel(), models: store.AVAILABLE_MODELS, default: store.DEFAULT_MODEL });
});

app.post('/api/settings/model', (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!model) return res.status(400).json({ error: 'model is required' });
  if (!store.AVAILABLE_MODELS.includes(model)) {
    return res.status(400).json({ error: `unknown model "${model}"` });
  }
  res.json({ model: store.setModel(model) });
});

// ---------------------------------------------------------------------------
// Phone pushes (ntfy) — status + a "send a test push" button, so the machine's
// notify.env can be verified from the settings panel without waiting for a real
// job to finish. The topic is never returned in full (it IS the credential).
// ---------------------------------------------------------------------------
app.get('/api/settings/ntfy', (req, res) => {
  res.json(notifier.status());
});

app.post('/api/settings/ntfy/test', async (req, res) => {
  const result = await notifier.sendTest();
  if (result.skipped) {
    return res.status(400).json({
      error: `No ntfy topic configured. Create ${notifier.status().configFile} (see setup/notify.env.example).`,
    });
  }
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// "Self" repo — the cloud-copilot checkout that is serving this very app.
//
// The settings panel surfaces its current branch and a "Restart main" button,
// used to periodically verify that whatever is on `main` still works. Only the
// self repo gets that button; restarting is meaningless for any other repo.
// ---------------------------------------------------------------------------

const SERVER_STARTED_AT = new Date().toISOString();
// Identify this app's directory by (device, inode) rather than by path string:
// on macOS `realpathSync` does NOT normalise case, so "/Users/me/repos/x" and
// "/Users/me/Repos/x" are the same directory but different strings.
const SELF_DIR_ID = (() => {
  try {
    const s = fs.statSync(__dirname);
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
})();

// The repo under REPOS_ROOT whose working tree IS this app's directory, or
// null when cloud-copilot is running from outside the authorized root.
function findSelfRepo() {
  if (!SELF_DIR_ID) return null;
  return (
    gh.listRepos(REPOS_ROOT).find((r) => {
      try {
        const s = fs.statSync(r.path);
        return `${s.dev}:${s.ino}` === SELF_DIR_ID;
      } catch {
        return false;
      }
    }) || null
  );
}

// Argument-array git (never a shell string) against a specific repo.
function git(repoPath, args, timeout = 20000) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

/**
 * The sha `origin/<branch>` points at in this clone.
 *
 * Every worktree of the repo shares this object store, so a push from any of
 * them updates the ref this reads — which makes it both free and authoritative
 * right after a run, unlike GitHub's API.
 */
function branchHeadSha(repoPath, branch, { fetch = false } = {}) {
  if (!branch) return null;
  if (fetch) {
    try {
      execFileSync('git', ['-C', repoPath, 'fetch', '--quiet', 'origin', branch], {
        timeout: 60000,
        stdio: 'ignore',
      });
    } catch {
      /* the remote-tracking ref may still be current from the push itself */
    }
  }
  try {
    return git(repoPath, ['rev-parse', `origin/${branch}`], 15000) || null;
  } catch {
    return null;
  }
}

function isDirty(repoPath) {
  try {
    return git(repoPath, ['status', '--porcelain']).length > 0;
  } catch {
    return false;
  }
}

// Makes `branch` the HEAD of the returned working directory. Normally that is
// the repo itself: when a linked worktree holds the branch we release it first
// so the action runs locally in the main tree, and only fall back to running
// inside the worktree when it still holds uncommitted or unpushed work. Throws
// on failure. Argument-array form (never a shell string) so branch names, which
// come from GitHub, are never interpreted by a shell.
function checkoutBranchCwd(repoPath, branch) {
  execFileSync('git', ['fetch', 'origin', branch], { cwd: repoPath, stdio: 'ignore', timeout: 30000 });
  const released = worktrees.releaseBranchWorktree(repoPath, branch, { fetch: false });
  if (released.status === 'kept') {
    // The worktree carries local work — deploy it where it lives rather than
    // deleting it or failing the job.
    return released.path;
  }
  execFileSync('git', ['checkout', branch], { cwd: repoPath, stdio: 'ignore', timeout: 15000 });
  return repoPath;
}

// origin's default branch (usually `main`), falling back to "main".
function defaultBranchOf(repoPath) {
  try {
    const ref = git(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    const name = ref.split('/').pop();
    if (name) return name;
  } catch {
    /* origin/HEAD not set locally */
  }
  return 'main';
}

// Cheap liveness probe the client polls while the server restarts itself.
// `startedAt`/`pid` let it tell "still the old process" from "back up".
app.get('/api/health', (req, res) => {
  res.json({ ok: true, pid: process.pid, startedAt: SERVER_STARTED_AT });
});

// ---------------------------------------------------------------------------
// Which code is this process actually running?
//
// public/ is served from disk and re-read on every request, while server.js and
// lib/ are baked into the process at require() time. A deploy that swaps the
// files but fails to replace the process therefore leaves the browser running
// the NEW dashboard against the OLD API — and every endpoint the new UI learned
// about answers 404. That reads like a dozen unrelated bugs (a checkbox that
// won't stay checked, a toggle that 404s, a panel that never updates) and it
// takes hours to trace back to one stale pid.
//
// So the process records what it loaded at boot and the client compares it
// against what is on disk right now.
// ---------------------------------------------------------------------------

function selfHeadSha() {
  try {
    return execFileSync('git', ['-C', __dirname, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The files whose contents this process froze at require() time.
 *
 * public/ is deliberately excluded: it is re-read from disk on every request,
 * so editing the dashboard does NOT make the running server stale, and warning
 * about it would train the user to ignore the warning that matters.
 */
function serverCodeFiles() {
  const files = [path.join(__dirname, 'server.js')];
  try {
    const libDir = path.join(__dirname, 'lib');
    for (const f of fs.readdirSync(libDir).sort()) {
      if (f.endsWith('.js')) files.push(path.join(libDir, f));
    }
  } catch {
    /* no lib/ — server.js alone is answer enough */
  }
  return files;
}

/**
 * Hash of that code's actual contents.
 *
 * Contents rather than the commit sha, because the sha answers a subtly
 * different question: committing the very code this process is already running
 * moves HEAD without changing a byte of behaviour, and a "restart me" banner
 * that fires on every commit is a banner nobody reads by the second day. This
 * fires on exactly the two things that do matter — a checkout that swapped the
 * files, and an edit in place.
 */
function serverCodeFingerprint() {
  const hash = crypto.createHash('sha1');
  for (const file of serverCodeFiles()) {
    try {
      hash.update(path.basename(file));
      hash.update(fs.readFileSync(file));
    } catch {
      hash.update(`<unreadable:${path.basename(file)}>`);
    }
  }
  return hash.digest('hex');
}

const BOOT_CODE = {
  head: selfHeadSha(),
  branch: gh.gitBranch(__dirname),
  fingerprint: serverCodeFingerprint(),
};

app.get('/api/version', (req, res) => {
  const head = selfHeadSha();
  const fingerprint = serverCodeFingerprint();
  const reasons = [];
  if (fingerprint !== BOOT_CODE.fingerprint) {
    reasons.push(
      BOOT_CODE.head && head && head !== BOOT_CODE.head
        ? `the checkout moved to ${head.slice(0, 7)}, but this process is running the code from ${BOOT_CODE.head.slice(0, 7)}`
        : 'server.js or lib/ changed on disk after this process started',
    );
  }
  res.json({
    pid: process.pid,
    startedAt: SERVER_STARTED_AT,
    boot: { head: BOOT_CODE.head, branch: BOOT_CODE.branch },
    disk: { head, branch: gh.gitBranch(__dirname) },
    stale: reasons.length > 0,
    reasons,
    // The dashboard renders the committed checkbox against this rather than a
    // hardcoded string, so CC_COMMITTED_LABEL cannot desync the two halves.
    committedLabel: gh.COMMITTED_LABEL,
  });
});

app.get('/api/settings/self', (req, res) => {
  const repo = findSelfRepo();
  if (!repo) return res.json({ repo: null, pid: process.pid, startedAt: SERVER_STARTED_AT });
  const busyKey = findOtherRepoBusyKey(repo.name, null);
  res.json({
    repo: repo.name,
    ownerRepo: repo.ownerRepo,
    branch: gh.gitBranch(repo.path),
    defaultBranch: defaultBranchOf(repo.path),
    dirty: isDirty(repo.path),
    busy: busyKey ? describeBusyKey(repo.name, busyKey) : null,
    pid: process.pid,
    startedAt: SERVER_STARTED_AT,
  });
});

// Relaunch cloud-copilot *detached* from this process.
//
// The obvious approach — letting the restart script `pkill -f 'node server.js'`
// — is unreliable when it is spawned by the very process it must kill, and it
// would also take down unrelated node servers. Instead we hand a detached
// shell a simple contract: wait for OUR pid to disappear, then `npm start`.
// This process then exits on its own, so the handover is deterministic.
function spawnSelfRestart(repoPath) {
  // `pid` is a number, so this shell string carries no injectable input.
  const script =
    `for i in $(seq 1 100); do kill -0 ${process.pid} 2>/dev/null || break; sleep 0.3; done; ` +
    `exec npm start > server.log 2>&1`;
  const child = spawn('/bin/bash', ['-lc', script], {
    cwd: repoPath,
    env: process.env,
    detached: true, // own session/process group — survives our own death
    stdio: 'ignore',
  });
  child.unref();
}

app.post('/api/settings/self/restart-main', (req, res) => {
  const repo = findSelfRepo();
  if (!repo) {
    return res.status(404).json({
      error: 'cloud-copilot is not running from a repo under REPOS_ROOT, so it cannot restart itself.',
    });
  }

  const key = `${repo.name}#0:restart`;
  if (manualLocks.has(key)) {
    return res.status(409).json({ error: 'A Restart main is already in progress.' });
  }
  // Same per-repo working-tree lock as Create PR / Deploy / Chat — this action
  // checks out a branch, so it must be mutually exclusive with all of them.
  const busyKey = findOtherRepoBusyKey(repo.name, key);
  if (busyKey) {
    return res.status(409).json({
      error: `Blocked: ${describeBusyKey(repo.name, busyKey)}. Deploy, Merge and Restart main share this repo's working tree and cannot overlap.`,
    });
  }

  manualLocks.add(key);
  const release = () => manualLocks.delete(key);

  const branch = defaultBranchOf(repo.path);
  const steps = [];
  let stashed = null;

  try {
    // Never silently discard local work: park it in a stash whose message
    // says exactly where it came from, so it can be recovered with
    // `git stash list` / `git stash pop`.
    if (isDirty(repo.path)) {
      stashed = `cloud-copilot restart-main ${new Date().toISOString()}`;
      git(repo.path, ['stash', 'push', '--include-untracked', '-m', stashed], 60000);
      steps.push(`Stashed uncommitted changes as "${stashed}"`);
    }
    git(repo.path, ['checkout', branch], 60000);
    steps.push(`Checked out ${branch}`);
    git(repo.path, ['pull', '--ff-only'], 180000);
    steps.push(`Pulled latest ${branch}`);
  } catch (err) {
    release();
    const detail = (err.stderr || err.stdout || err.message || '').toString().trim();
    return res.status(500).json({
      error: `Restart main failed before restarting: ${detail || err.message}`,
      steps,
      stashed,
      branch: gh.gitBranch(repo.path),
    });
  }

  let head = null;
  try {
    head = git(repo.path, ['rev-parse', '--short', 'HEAD']);
  } catch {
    /* non-fatal */
  }

  // Safety net: this process is about to be killed, so the lock normally dies
  // with it — but if the relaunch somehow never kills us, don't wedge the repo.
  const guard = setTimeout(release, 120000);
  if (guard.unref) guard.unref();

  // Flush the result FIRST; only then pull the rug out from under ourselves.
  res.json({
    ok: true,
    repo: repo.name,
    branch,
    head,
    stashed,
    steps: [...steps, 'Restarting server…'],
    pid: process.pid,
    startedAt: SERVER_STARTED_AT,
  });
  res.on('finish', () => {
    // Only now that the client has the result do we hand over: spawn the
    // detached relauncher, then exit so it can bind the port.
    setTimeout(() => {
      try {
        spawnSelfRestart(repo.path);
      } catch (err) {
        release();
        console.error('[restart-main] failed to spawn relauncher:', err.message);
        return;
      }
      setTimeout(() => process.exit(0), 500);
    }, 300);
  });
});

// ---------------------------------------------------------------------------
// TestFlight overview — every build ever shipped via the ios-testflight
// deploy path (current + archived deploy attempts), across all repos/issues,
// flattened for a single cross-repo page: version/build, the PR (and its
// title as the "What to Test" note), and whether it's been merged yet.
// ---------------------------------------------------------------------------
app.get('/api/testflight/builds', (req, res) => {
  // Resolve each repo once, not once per build: the scan behind `resolveRepo`
  // is synchronous, so doing it per row blocked the event loop for the whole
  // page's worth of builds.
  const repoByName = new Map();
  const repoFor = (name) => {
    if (!repoByName.has(name)) repoByName.set(name, resolveRepo(name));
    return repoByName.get(name);
  };
  // Likewise cache the deploy config per repo rather than re-reading it per row.
  const deployTypeByPath = new Map();
  const deployType = (repoPath) => {
    if (!deployTypeByPath.has(repoPath)) {
      deployTypeByPath.set(repoPath, repoConfig.loadDeployConfig(repoPath).type);
    }
    return deployTypeByPath.get(repoPath);
  };
  const builds = store
    .listAllBuilds()
    .map((b) => {
      const repo = repoFor(b.repo);
      return { ...b, ownerRepo: repo?.ownerRepo || null, _repo: repo };
    })
    // Only ever show builds shipped through the ios-testflight deploy path —
    // repos configured for a "shell" deploy (e.g. a restart script) aren't
    // TestFlight builds and would otherwise pollute this page.
    .filter((b) => !b._repo || deployType(b._repo.path) === 'ios-testflight')
    .map(({ _repo, ...b }) => b);
  res.json({ builds });
});

/**
 * Pull a repo's issues + PRs (through the L2 cache unless `force`) and fold the
 * discovered PRs into the store. Shared by the issues endpoint and the hourly
 * background refresher so both keep the store in exactly the same shape.
 */
// GitHub's `mergeable` is computed lazily, so a PR it hasn't finished thinking
// about comes back as "unknown". The local three-minute sweep usually knows the
// real answer already, so an unknown from GitHub is discarded (undefined =
// "leave the stored value alone") instead of blanking a good badge.
function usableGhSync(sync) {
  if (!sync) return undefined;
  return sync.state === 'unknown' ? undefined : { ...sync, source: 'github' };
}

async function syncRepoFromGitHub(repo, { force = false } = {}) {
  const { issues, cached, at } = await gh.listIssues(repo.ownerRepo, { force });
  const dismissed = store.getDismissedNumbers(repo.name);
  const visible = issues.filter((i) => !dismissed.has(i.number));

  // Auto-discover PRs referencing any of these issues — one `gh pr list`
  // call for the whole repo, matched in-process — so the pipeline is
  // populated on every expand without needing the manual "↻ PRs" click.
  const { prs: allPrs } = await gh.listAllPrs(repo.ownerRepo, { force });
  // Best-effort branch + tip-commit annotations; an empty map just means the
  // rows render without them.
  const headCommits = await gh.listPrHeadCommits(repo.ownerRepo, { force });
  // How far each open PR has drifted from its base branch (issue #58). The
  // three-minute local sweep is the primary source; this GitHub read only
  // covers what git on this disk cannot answer — chiefly PRs from forks. An
  // UNKNOWN from GitHub is therefore dropped rather than allowed to overwrite
  // a definite local answer with a "?".
  const syncByPr = await gh.listPrSync(repo.ownerRepo, { force });
  // Whole-repo PR state, so a PR cloud-copilot created itself (which the
  // per-issue body match may not find) still learns it was closed.
  const stateByNumber = {};
  for (const p of allPrs) stateByNumber[String(p.number)] = p.state;

  for (const issue of visible) {
    const matched = gh.matchPrsForIssue(allPrs, issue.number);
    for (const p of matched) {
      const head = headCommits[String(p.number)] || null;
      store.upsertPr(repo.name, issue.number, {
        prNumber: p.number,
        prUrl: p.url,
        title: p.title,
        createdAt: p.createdAt,
        source: 'gh',
        state: p.state,
        headRefName: p.headRefName || (head && head.headRefName) || null,
        baseRefName: p.baseRefName || null,
        headCommit: head
          ? { sha: head.sha, abbrev: head.abbrev, committedDate: head.committedDate, headline: head.headline, url: head.url }
          : undefined,
        sync: usableGhSync(syncByPr[String(p.number)]),
      });
    }
    // Drop previously auto-discovered PRs that no longer match (e.g. the
    // match heuristic got stricter, or a PR body was edited) — never
    // touches PRs cloud-copilot itself created for this issue.
    store.pruneStaleGhPrs(repo.name, issue.number, matched.map((p) => p.number));
    // Forget PRs GitHub closed without merging: their branch is gone, so every
    // pipeline action on them would fail. Records carrying local history are
    // kept (just hidden) so the builds overview keeps its data.
    store.pruneClosedPrs(repo.name, issue.number, store.refreshPrStates(repo.name, issue.number, stateByNumber));
  }
  return { visible, cached, at };
}

app.get('/api/repos/:name/issues', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found under REPOS_ROOT' });
  if (!repo.github) return res.status(400).json({ error: 'repo has no github.com remote' });

  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const { visible, cached, at } = await syncRepoFromGitHub(repo, { force });

    const numbers = visible.map((i) => i.number);
    const statuses = store.getStatuses(repo.name, numbers);
    const merged = visible.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      updatedAt: i.updatedAt,
      url: i.url,
      labels: (i.labels || []).map((l) => l.name),
      status: statuses[i.number],
    }));
    // Which issue currently holds this repo's working-tree lock (Create PR,
    // Deploy, or Chat) — kept as an array for backward compatibility with the
    // existing `activeWorkIssues[0]` client contract.
    const busyIssue = repoBusyIssueNumber(repo.name);
    const activeWorkIssues = busyIssue != null ? [busyIssue] : [];
    res.json({
      repo: repo.name,
      ownerRepo: repo.ownerRepo,
      cached,
      at,
      // Cache telemetry the client's sync pill renders from: when this repo's
      // L2 entry was last filled, how long entries stay fresh, and when the
      // hourly background refresh will next touch it.
      serverAt: gh.cache.syncedAt(repo.ownerRepo) ?? at,
      ttlMs: gh.CACHE_TTL_MS,
      nextSyncAt: nextBackgroundSyncAt(),
      issues: merged,
      activeWorkIssues,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stderr: (err.stderr || '').toString() });
  }
});

// Just the live half of the issues list: per-issue action statuses plus which
// issue holds the working-tree lock. Deliberately does NOT touch `gh` or the
// L2 cache — it only reads state.json and the in-memory job table, so the
// client can call it as often as it likes.
//
// Exists because the browser's L1 cache stores the whole /issues payload for
// 15 minutes, which is right for GitHub metadata and wrong for this: a job
// started from another machine (or another tab) is invisible to a cached
// render, so the card stays "idle" and never reconnects (issue #52). The
// client renders from L1 for speed, then patches the result with this.
app.get('/api/repos/:name/statuses', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found under REPOS_ROOT' });
  const numbers = String(req.query.n || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const busyIssue = repoBusyIssueNumber(repo.name);
  res.json({
    repo: repo.name,
    statuses: numbers.length ? store.getStatuses(repo.name, numbers) : {},
    labels: numbers.length ? cachedLabels(repo, numbers) : {},
    activeWorkIssues: busyIssue != null ? [busyIssue] : [],
  });
});

/**
 * Label names of the given issues, straight out of the L2 cache.
 *
 * Reading the cache in memory is not a `gh` call, so this keeps the promise
 * /statuses makes above. It exists because the browser's L1 copy is up to 15
 * minutes old and L2 is up to 15 minutes old on top of that: without this, a
 * `committed` label added on github.com (or from another device, or by the
 * scheduler) could take half an hour to show up on the checkbox. Issues that
 * aren't in the cache are simply absent — the client must then keep whatever
 * it already has rather than assume "no labels".
 */
function cachedLabels(repo, numbers) {
  if (!repo.ownerRepo) return {};
  const entry = gh.cache.get(repo.ownerRepo, 'issues');
  if (!entry) return {};
  const want = new Set(numbers);
  const out = {};
  for (const issue of entry.data) {
    if (want.has(issue.number)) out[issue.number] = (issue.labels || []).map((l) => l.name);
  }
  return out;
}

// Just the base-branch sync badges of one repo (issue #58). The client polls
// this every three minutes to repaint badges in place — it reads state.json
// only, so it costs nothing and never talks to GitHub or git itself. `at`
// tells the client when the sweep that produced this data ran.
app.get('/api/repos/:name/prsync', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found under REPOS_ROOT' });
  res.json({
    repo: repo.name,
    sync: store.getRepoSync(repo.name),
    intervalMs: PR_SYNC_INTERVAL_MS,
    nextSweepAt: nextPrSyncAt(),
  });
});

// Full stored record for one issue (conversation, PR link, etc.).
app.get('/api/repos/:name/issues/:n/record', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const record = store.getRecord(repo.name, n);
  // Annotate with whether a live job is still running (survives browser drop).
  record.live = {
    work: Boolean(jobs.getJob(`${repo.name}#${n}:work`)?.status === 'running'),
    deploy: {},
    merge: {},
    chat: {},
    update: {},
  };
  for (const pr of Object.values(record.prs || {})) {
    record.live.deploy[pr.prNumber] = Boolean(
      jobs.getJob(`${repo.name}#${n}:deploy:${pr.prNumber}`)?.status === 'running',
    );
    record.live.merge[pr.prNumber] = Boolean(
      jobs.getJob(`${repo.name}#${n}:merge:${pr.prNumber}`)?.status === 'running',
    );
    record.live.chat[pr.prNumber] = Boolean(
      jobs.getJob(`${repo.name}#${n}:chat:${pr.prNumber}`)?.status === 'running',
    );
    record.live.update[pr.prNumber] = Boolean(
      jobs.getJob(`${repo.name}#${n}:update:${pr.prNumber}`)?.status === 'running',
    );
  }
  res.json(record);
});

// Refresh the PR list for an issue from GitHub and merge into the store.
app.get('/api/repos/:name/issues/:n/prs', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  if (!repo.github) return res.status(400).json({ error: 'repo has no github.com remote' });
  const n = Number(req.params.n);
  try {
    // Manual refresh always bypasses the whole-repo PR cache — unlike the
    // automatic discovery on repo expand, this is an explicit "check again now".
    const prs = await gh.findPrsForIssue(repo.ownerRepo, n, { force: true });
    const headCommits = await gh.listPrHeadCommits(repo.ownerRepo, { force: true });
    const { prs: allPrs } = await gh.listAllPrs(repo.ownerRepo, { force: true });
    // Manual refresh re-collects the base-branch sync status too, so the ⇣N /
    // ⚠ badges are as live as the rest of the row.
    const syncByPr = await gh.listPrSync(repo.ownerRepo, { force: true });
    for (const p of prs) {
      const head = headCommits[String(p.number)] || null;
      store.upsertPr(repo.name, n, {
        prNumber: p.number,
        prUrl: p.url,
        title: p.title,
        createdAt: p.createdAt,
        source: 'gh',
        state: p.state,
        headRefName: p.headRefName || (head && head.headRefName) || null,
        baseRefName: p.baseRefName || null,
        headCommit: head
          ? { sha: head.sha, abbrev: head.abbrev, committedDate: head.committedDate, headline: head.headline, url: head.url }
          : undefined,
        sync: usableGhSync(syncByPr[String(p.number)]),
      });
    }
    // An explicit "check again now" is also the user's manual way to sweep
    // closed PRs out of this issue's pipeline — including ones cloud-copilot
    // created itself, which the body-match scan above may not return.
    const stateByNumber = {};
    for (const p of allPrs) stateByNumber[String(p.number)] = p.state;
    store.pruneClosedPrs(repo.name, n, store.refreshPrStates(repo.name, n, stateByNumber));
    const record = store.getRecord(repo.name, n);
    res.json({ prs: store.prsArray(record) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss/hide an issue from the dashboard. Cancels any in-flight jobs tied to
// it (work + every PR's deploy/merge), then clears its tracked state and remembers
// the dismissal so it doesn't reappear on the next issue-list refresh/poll.
// This never touches the issue on GitHub itself.
app.post('/api/repos/:name/issues/:n/hide', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'invalid issue number' });

  const record = store.getRecord(repo.name, n);
  const cancelledJobs = [];
  if (jobs.cancelJob(`${repo.name}#${n}:work`)) cancelledJobs.push('work');
  for (const pr of Object.values(record.prs || {})) {
    if (jobs.cancelJob(`${repo.name}#${n}:deploy:${pr.prNumber}`)) cancelledJobs.push(`deploy:${pr.prNumber}`);
    if (jobs.cancelJob(`${repo.name}#${n}:merge:${pr.prNumber}`)) cancelledJobs.push(`merge:${pr.prNumber}`);
    if (jobs.cancelJob(`${repo.name}#${n}:update:${pr.prNumber}`)) cancelledJobs.push(`update:${pr.prNumber}`);
    if (jobs.cancelJob(`${repo.name}#${n}:review:${pr.prNumber}`)) cancelledJobs.push(`review:${pr.prNumber}`);
    if (jobs.cancelJob(`${repo.name}#${n}:chat:${pr.prNumber}`)) cancelledJobs.push(`chat:${pr.prNumber}`);
  }

  store.dismissIssue(repo.name, n);
  res.json({ ok: true, cancelledJobs });
});

// PERMANENTLY delete an issue on GitHub. Unlike /hide above, this really does
// destroy the issue upstream (`gh issue delete --yes`) and cannot be undone.
// Order matters: cancel in-flight jobs first, then delete on GitHub, and only
// clear local state once GitHub confirmed the deletion — if `gh` fails (most
// commonly: no admin permission) the issue stays fully intact locally.
app.delete('/api/repos/:name/issues/:n', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  if (!repo.github) return res.status(400).json({ error: 'repo has no github.com remote' });
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'invalid issue number' });

  const record = store.getRecord(repo.name, n);
  const cancelledJobs = [];
  if (jobs.cancelJob(`${repo.name}#${n}:work`)) cancelledJobs.push('work');
  for (const pr of Object.values(record.prs || {})) {
    if (jobs.cancelJob(`${repo.name}#${n}:deploy:${pr.prNumber}`)) cancelledJobs.push(`deploy:${pr.prNumber}`);
    if (jobs.cancelJob(`${repo.name}#${n}:update:${pr.prNumber}`)) cancelledJobs.push(`update:${pr.prNumber}`);
    if (jobs.cancelJob(`${repo.name}#${n}:review:${pr.prNumber}`)) cancelledJobs.push(`review:${pr.prNumber}`);
    if (jobs.cancelJob(`${repo.name}#${n}:chat:${pr.prNumber}`)) cancelledJobs.push(`chat:${pr.prNumber}`);
  }

  try {
    await gh.deleteIssue(repo.ownerRepo, n);
  } catch (err) {
    const detail = String(err.stderr || err.message || '').trim();
    return res.status(502).json({
      error: `gh issue delete failed: ${detail || 'unknown error'}`,
      cancelledJobs,
    });
  }

  store.dismissIssue(repo.name, n);
  res.json({ ok: true, deleted: true, cancelledJobs });
});

// ---------------------------------------------------------------------------
// PreIssues — lightweight "idea sticky notes" that iterate (via a Copilot CLI
// chat) into a full issue draft, then get created as a real GitHub issue.
// ---------------------------------------------------------------------------

const PREISSUE_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

// Pull the last fenced ```json {...} ``` block out of a chat transcript and
// parse it as the current issue draft { title, body }. Copilot is prompted to
// always end its reply with one, so the frontend can show a live draft
// preview without any extra structured-output plumbing.
function extractDraft(text) {
  const matches = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1][1];
  try {
    const parsed = JSON.parse(last);
    if (parsed && typeof parsed.title === 'string') {
      return { title: parsed.title, body: typeof parsed.body === 'string' ? parsed.body : '' };
    }
  } catch {
    /* not valid JSON — no draft update this turn */
  }
  return null;
}

app.get('/api/repos/:name/preissues', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  // Annotate each PreIssue with whether its chat job is still running
  // server-side — lets the client re-attach after a reload/nav-away instead
  // of appearing "stuck" with no way to reconnect.
  const preIssues = store.listPreIssues(repo.name).map((pre) => ({
    ...pre,
    live: Boolean(jobs.getJob(`${repo.name}:preissue:${pre.id}`)?.status === 'running'),
  }));
  res.json({ preIssues });
});

app.post('/api/repos/:name/preissues', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'text is required' });
  const pre = store.createPreIssue(repo.name, text);
  res.json({ preIssue: pre });
});

app.delete('/api/repos/:name/preissues/:id', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const { id } = req.params;
  if (!PREISSUE_ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
  jobs.cancelJob(`${repo.name}:preissue:${id}`);
  const deleted = store.deletePreIssue(repo.name, id);
  if (!deleted) return res.status(404).json({ error: 'preissue not found' });
  res.json({ ok: true });
});

// Conversational iteration: chat with the local Copilot CLI (read-only, no
// working-tree checkout needed) to expand a PreIssue's short text into a full
// issue draft. Streams over SSE, resuming the same session turn to turn.
app.post('/api/repos/:name/preissues/:id/chat', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const { id } = req.params;
  if (!PREISSUE_ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });

  const pre = store.getPreIssue(repo.name, id);
  if (!pre) return res.status(404).json({ error: 'preissue not found' });

  const key = `${repo.name}:preissue:${id}`;

  // Reconnect: if a job is already running (e.g. the client navigated away
  // and back), just re-attach — no new message required. Checking this
  // BEFORE validating `message` is what lets a plain reconnect succeed.
  const existing = jobs.getJob(key);
  if (existing && existing.status === 'running') {
    writeSseHead(res);
    jobs.subscribe(existing, res);
    return;
  }

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'message is required' });

  // Per-turn model override from the chat's own model dropdown; falls back to
  // the global setting when absent/unknown.
  const model = resolveModel(req.body?.model);

  writeSseHead(res);
  store.appendPreIssueChatMessage(repo.name, id, { role: 'user', text: message, model });

  const resumeId = pre.chat && pre.chat.sessionId;
  const args = [];
  if (resumeId) args.push(`--resume=${resumeId}`);
  const draftHint = pre.draft
    ? `The current draft is:\n\`\`\`json\n${JSON.stringify(pre.draft)}\n\`\`\`\n`
    : '';
  const prompt =
    `You are helping turn a quick idea into a well-formed GitHub issue for this repo. ` +
    `Do NOT modify any files — this is a read-only conversation; you may look at the ` +
    `codebase for context if useful. The original idea was: "${pre.text}". ${draftHint}` +
    `The user just said: ${message}\n\n` +
    `Reply conversationally, then ALWAYS end your reply with the current best draft as a ` +
    `fenced json block of the exact shape {"title": "...", "body": "..."} (a short, clear ` +
    `title and a body with motivation + concrete acceptance criteria).`;
  args.push('-p', prompt, ...approvalFlags('default'), ...modelFlags(model));

  const job = jobs.startJob(key, {
    bin: COPILOT_BIN,
    args,
    cwd: repo.path,
    meta: {
      action: 'preissue-chat',
      id,
      model,
      repo: repo.name,
      chatTitle: store.titleFromMessage(pre.text),
      subject: store.titleFromMessage(message),
    },
    onSession: (sid) => store.setPreIssueSession(repo.name, id, sid),
    onDone: async (j) => {
      const status = j.cancelled ? 'aborted' : j.exitCode === 0 ? 'success' : 'failed';
      store.appendPreIssueChatMessage(repo.name, id, { role: 'assistant', text: j.conversation, model });
      const draft = extractDraft(j.conversation);
      if (draft) store.setPreIssueDraft(repo.name, id, draft);
      return { action: 'preissue-chat', id, status, sessionId: j.sessionId, draft, model };
    },
  });

  jobs.subscribe(job, res);
});

app.post('/api/repos/:name/preissues/:id/chat/cancel', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const { id } = req.params;
  const cancelled = jobs.cancelJob(`${repo.name}:preissue:${id}`);
  res.json({ cancelled });
});

// One-click promotion: create a real GitHub issue from the current draft.
app.post('/api/repos/:name/preissues/:id/create-issue', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  if (!repo.github) return res.status(400).json({ error: 'repo has no github.com remote' });
  const { id } = req.params;
  if (!PREISSUE_ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });

  const pre = store.getPreIssue(repo.name, id);
  if (!pre) return res.status(404).json({ error: 'preissue not found' });
  if (pre.status === 'converted') {
    return res.status(409).json({ error: 'already converted', issueNumber: pre.issueNumber, issueUrl: pre.issueUrl });
  }
  const draft = pre.draft;
  if (!draft || !draft.title) {
    return res.status(400).json({ error: 'no draft yet — chat with it first to build a title/body' });
  }

  try {
    const { url, number } = await gh.createIssue(repo.ownerRepo, draft.title, draft.body || '');
    store.markPreIssueConverted(repo.name, id, { issueNumber: number, issueUrl: url });
    res.json({ ok: true, issueNumber: number, issueUrl: url });
  } catch (err) {
    res.status(500).json({ error: err.message, stderr: (err.stderr || '').toString() });
  }
});

// ---------------------------------------------------------------------------
// Action: Create PR (implement the issue end-to-end and open a PR)
// ---------------------------------------------------------------------------

app.post('/api/repos/:name/issues/:n/work', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const key = `${repo.name}#${n}:work`;

  writeSseHead(res);

  // Reconnect: if a job for this issue is already running, just attach to it.
  const existing = jobs.getJob(key);
  if (existing && existing.status === 'running') {
    jobs.subscribe(existing, res);
    return;
  }

  // Create PR no longer takes a repo-wide lock: it gets its own worktree and
  // its own test port, so several issues can be implemented at once.
  const mode = ['default', 'granular', 'allow-all'].includes(req.body?.mode)
    ? req.body.mode
    : 'allow-all'; // implementing an issue needs to edit files, run git & gh

  const baseRef = defaultBranchOf(repo.path);
  let lease;
  try {
    lease = await leaseWorktree(repo, {
      key,
      action: 'work',
      issueNumber: n,
      baseRef,
    });
  } catch (err) {
    return sendSseBlocked(res, {
      action: 'work',
      status: leaseFailureStatus(err),
      message: `Could not start: ${err.message}`,
    });
  }

  const prompt =
    `Work on GitHub issue #${n} in this repository (${repo.ownerRepo}). ` +
    `Create a new branch, implement the change end-to-end until it is complete, ` +
    `commit, push, and open a pull request that closes #${n}. ` +
    `When finished, print the pull request URL on its own line.` +
    portNote(lease);
  const args = ['-p', prompt, ...approvalFlags(mode), ...modelFlags()];

  store.updateRecord(repo.name, n, (r) => {
    r.work.status = 'working';
    r.work.startedAt = new Date().toISOString();
    r.work.conversation = '';
    r.work.prUrl = null;
    r.work.prNumber = null;
  });

  const job = startLeasedJob(lease, key, {
    bin: COPILOT_BIN,
    args,
    cwd: lease.path,
    env: lease.env,
    meta: {
      action: 'work',
      repo: repo.name,
      issueNumber: n,
      subject: cachedIssueTitle(repo, n) || `issue #${n}`,
      sequence: nextCreatePrSequence(repo.name),
      auto: Boolean(req.body?.auto),
      worktree: lease.path,
      port: lease.port,
    },
    onSession: (id) =>
      store.updateRecord(repo.name, n, (r) => {
        r.work.sessionId = id;
      }),
    onDone: async (j) => {
      // Detect the PR: first from THIS run's transcript, then via gh fallback.
      let prUrl = null;
      let prNumber = null;
      let fromTranscript = false;
      if (repo.ownerRepo) {
        const re = new RegExp(
          `https://github\\.com/${repo.ownerRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/(\\d+)`,
        );
        const m = j.conversation.match(re);
        if (m) {
          prUrl = m[0];
          prNumber = Number(m[1]);
          fromTranscript = true;
        }
      }
      if (!prUrl) {
        const found = await gh.findPrForIssue(repo.ownerRepo, n);
        if (found) {
          prUrl = found.url;
          prNumber = found.number;
        }
      }

      // A PR URL printed by THIS run is proof of success even if the process was
      // later killed (exitCode null) after finishing. Only require exitCode===0
      // for the weaker gh-fallback signal (avoids matching a stale PR).
      const success = fromTranscript ? Boolean(prUrl) : j.exitCode === 0 && Boolean(prUrl);
      const status = j.cancelled ? 'aborted' : success ? 'success' : 'failed';

      // Housekeeping BEFORE the record is written, so the cleanup notes end up
      // in the stored transcript too. The run owns a private worktree; once its
      // branch is pushed that directory is pure leftover, and releasing it here
      // also frees the run's test port for the next job. Anything holding
      // uncommitted or unpushed work is kept and says why.
      let headBranch = null;
      let baseBranch = null;
      if (prNumber) {
        try {
          const prInfo = await gh.getPr(repo.ownerRepo, prNumber);
          headBranch = (prInfo && prInfo.headRefName) || null;
          baseBranch = (prInfo && prInfo.baseRefName) || null;
        } catch {
          /* branch stays null — the release below still covers it */
        }
      }
      const cleanup = releaseLease(lease, { fallbackRef: `origin/${baseBranch || baseRef}` });
      const cleanupText = worktrees.formatCleanup(cleanup);
      const conversation = cleanupText ? `${j.conversation}\n${cleanupText}\n` : j.conversation;

      store.updateRecord(repo.name, n, (r) => {
        r.work.status = status;
        r.work.exitCode = j.exitCode;
        r.work.conversation = conversation;
        r.work.prUrl = prUrl;
        r.work.prNumber = prNumber;
        r.work.sessionId = j.sessionId || r.work.sessionId;
        r.work.finishedAt = new Date().toISOString();
      });

      // Register the freshly created PR so it gets its own deploy button.
      if (prNumber) {
        store.upsertPr(repo.name, n, {
          prNumber,
          prUrl,
          createdAt: new Date().toISOString(),
          source: 'work',
          state: 'OPEN',
          headRefName: headBranch || undefined,
          baseRefName: baseBranch || undefined,
        });
        // Compare it against its base right away: waiting for the next
        // three-minute sweep would leave the brand-new row showing "?" — the
        // exact moment the badge is least believable.
        sweepRepoSyncSoon(repo);
      }

      return {
        action: 'work',
        status,
        prUrl,
        prNumber,
        sessionId: j.sessionId,
        worktreeCleanup: cleanup,
      };
    },
  }, {
    fallbackRef: `origin/${baseRef}`,
    onFail: (err) =>
      sendSseBlocked(res, {
        action: 'work',
        status: 'failed',
        message: `Could not start: ${err.message}`,
      }),
  });
  if (!job) return;

  jobs.subscribe(job, res);
});

// Abort a running PR creation for an issue.
app.post('/api/repos/:name/issues/:n/work/cancel', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  if (badIssueNumber(res, n)) return;
  res.json(abortAction(repo.name, n, 'work'));
});

// ---------------------------------------------------------------------------
// Action: Deploy a specific PR — dispatched per-repo (ios-testflight | shell)
// ---------------------------------------------------------------------------

function sendSseBlocked(res, payload) {
  res.write(`event: error\n`);
  res.write(`data: ${JSON.stringify({ message: payload.message })}\n\n`);
  res.write(`event: result\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.write(`event: done\n`);
  res.write(`data: ${JSON.stringify({ exitCode: null })}\n\n`);
  res.end();
}

// A PR closed without being merged has, in practice, no branch left: GitHub
// deletes it, so the very first `git fetch origin <branch>` of any pipeline
// action dies with an opaque "Command failed". Detect it up front and say so
// in words, and record the state so the row also disappears from the pipeline.
// Returns a message when the action must be refused, or null to proceed.
function refuseIfPrClosed(repo, n, prNumber, pr) {
  if (!pr || pr.state !== 'CLOSED') return null;
  store.upsertPr(repo.name, n, { prNumber, state: 'CLOSED' });
  return (
    `Blocked: PR #${prNumber} is closed without having been merged, so its branch ` +
    `("${pr.headRefName || 'unknown'}") no longer exists on GitHub. There is nothing to run against. ` +
    `Reopen the PR, or start a new one for this issue.`
  );
}

function runIosTestflightDeploy({ res, repo, n, prNumber, key }) {
  gh.getPr(repo.ownerRepo, prNumber).then(async (pr) => {
    if (!pr || !pr.headRefName) {
      const message = `Could not resolve the branch for PR #${prNumber} via gh.`;
      store.updateDeploy(repo.name, n, prNumber, (d) => {
        d.status = 'failed';
        d.finishedAt = new Date().toISOString();
        d.conversation = message;
      });
      return sendSseBlocked(res, { action: 'deploy', prNumber, status: 'failed', message });
    }

    const closed = refuseIfPrClosed(repo, n, prNumber, pr);
    if (closed) return sendSseBlocked(res, { action: 'deploy', prNumber, status: 'blocked', message: closed });

    // Build number / version are computed HERE, deterministically, from the
    // exact commit being shipped — never inferred afterward from the agent's
    // free-form report. build = commit count (same source `fastlane beta`
    // itself defaults to); version = the Xcode project's own MARKETING_VERSION.
    let buildNumber, version, workCwd;
    try {
      workCwd = checkoutBranchCwd(repo.path, pr.headRefName);
      buildNumber = Number(
        execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: workCwd, encoding: 'utf8', timeout: 15000 }).trim(),
      );
      version = repoConfig.readMarketingVersion(workCwd); // null if not found — fastlane then uses its own default
    } catch (err) {
      const message = `Failed to check out branch "${pr.headRefName}" / compute build number: ${err.message}`;
      store.updateDeploy(repo.name, n, prNumber, (d) => {
        d.status = 'failed';
        d.finishedAt = new Date().toISOString();
        d.conversation = message;
      });
      return sendSseBlocked(res, { action: 'deploy', prNumber, status: 'failed', message });
    }

    const versionArg = version ? ` version:${version}` : '';
    // "What to Test" text testers see in TestFlight — one short Chinese
    // sentence derived from the PR title, so builds are self-describing
    // instead of shipping the raw (often English, prefixed, issue-tagged)
    // title. Best-effort translation with a deterministic fallback; see
    // lib/changelog.js. Awaited before the deploy job starts so the pinned
    // text is in the prompt.
    const changelog = await changelogLib.resolveChangelog({
      pr,
      version,
      buildNumber,
      copilotBin: COPILOT_BIN,
    });
    const prompt =
      `The branch for PR #${prNumber} is already checked out. Deploy the current ` +
      `${repo.name} app to TestFlight using the testflight-deploy skill, running ` +
      `\`fastlane beta build:${buildNumber}${versionArg} changelog:'${changelog}'\` (do not ` +
      `change the build/version numbers or the changelog text — they're already pinned; ` +
      `the changelog becomes testers' "What to Test" note in TestFlight, so it must be passed ` +
      `through exactly as given). When finished, clearly state whether the build succeeded and ` +
      `whether the upload to TestFlight succeeded. Note: Xcode's export step can silently ` +
      `reassign the build number, so grep the fastlane log for its own "finished processing ` +
      `the build" line and quote that line verbatim (exact numbers, no paraphrasing) — that's ` +
      `the number Apple actually assigned, which may differ from what was requested.`;
    // Deploy must reach files outside the repo (/tmp, ~/Library, keychain) and the
    // network, so grant full path + URL + tool access.
    const args = ['-p', prompt, '--allow-all', ...modelFlags()];

    const job = jobs.startJob(key, {
      bin: COPILOT_BIN,
      args,
      cwd: workCwd,
      meta: {
        action: 'deploy',
        prNumber,
        repo: repo.name,
        issueNumber: n,
        subject: pr.title || `PR #${prNumber}`,
      },
      onSession: (id) =>
        store.updateDeploy(repo.name, n, prNumber, (d) => {
          d.sessionId = id;
        }),
      onDone: async (j) => {
        // Success markers emitted by fastlane / the skill's final report.
        // "finished processing the build" is fastlane's own real completion
        // line (confirmed against a live deploy) — the earlier patterns alone
        // missed it and mis-marked a genuinely successful upload as failed.
        const success =
          /successfully uploaded|finished successfully|finished processing the build|uploaded to testflight|build \d+ .*uploaded/i.test(
            j.conversation,
          );
        const status = j.cancelled ? 'aborted' : success ? 'success' : 'failed';
        // Xcode's export step can silently bump the build number past what we
        // asked fastlane to use (confirmed: pinned 63, Apple actually got 68).
        // When fastlane's own completion line ("...build 1.0 - 68 for...") is
        // present, trust THAT over our own precomputed input — it's the number
        // Apple actually has, not just what we requested.
        const confirmed = success
          ? (() => {
              // Tolerate markdown emphasis (**68**) around the numbers — this
              // matches the agent's own summary line, not fastlane's raw log
              // (which Copilot CLI collapses in the stored transcript).
              const m = j.conversation.match(
                /finished processing the build\s+\**([\d.]+)\**\s*-\s*\**(\d+)\**\s*for/i,
              );
              return m ? { version: m[1], buildNumber: Number(m[2]) } : null;
            })()
          : null;
        const finalBuildNumber = confirmed ? confirmed.buildNumber : buildNumber;
        const finalVersion = confirmed ? confirmed.version : version;
        store.updateDeploy(repo.name, n, prNumber, (d) => {
          d.status = status;
          d.exitCode = j.exitCode;
          d.conversation = j.conversation;
          d.sessionId = j.sessionId || d.sessionId;
          d.finishedAt = new Date().toISOString();
          if (success) {
            d.buildNumber = finalBuildNumber;
            d.version = finalVersion;
            d.changelog = changelog;
          }
        });
        return {
          action: 'deploy',
          prNumber,
          status,
          sessionId: j.sessionId,
          buildNumber: success ? finalBuildNumber : null,
          version: success ? finalVersion : null,
        };
      },
    });

    jobs.subscribe(job, res);
  });
}

function runShellDeploy({ res, repo, n, prNumber, key, command }) {
  gh.getPr(repo.ownerRepo, prNumber).then((pr) => {
    if (!pr || !pr.headRefName) {
      const message = `Could not resolve the branch for PR #${prNumber} via gh.`;
      store.updateDeploy(repo.name, n, prNumber, (d) => {
        d.status = 'failed';
        d.finishedAt = new Date().toISOString();
        d.conversation = message;
      });
      return sendSseBlocked(res, { action: 'deploy', prNumber, status: 'failed', message });
    }

    const closed = refuseIfPrClosed(repo, n, prNumber, pr);
    if (closed) return sendSseBlocked(res, { action: 'deploy', prNumber, status: 'blocked', message: closed });

    let workCwd;
    try {
      workCwd = checkoutBranchCwd(repo.path, pr.headRefName);
    } catch (err) {
      const message = `Failed to check out branch "${pr.headRefName}": ${err.message}`;
      store.updateDeploy(repo.name, n, prNumber, (d) => {
        d.status = 'failed';
        d.finishedAt = new Date().toISOString();
        d.conversation = message;
      });
      return sendSseBlocked(res, { action: 'deploy', prNumber, status: 'failed', message });
    }

    // The deploy command itself is trusted repo-local config (from
    // `.cloud-copilot.json`, authored by whoever owns the repo under
    // REPOS_ROOT) — not attacker-controlled input, so a shell string is fine
    // here (same trust boundary as REPOS_ROOT itself).
    const job = jobs.startJob(key, {
      bin: 'bash',
      args: ['-lc', command],
      cwd: workCwd,
      meta: {
        action: 'deploy',
        prNumber,
        repo: repo.name,
        issueNumber: n,
        subject: pr.title || `PR #${prNumber}`,
      },
      onDone: async (j) => {
        const success = j.exitCode === 0;
        const status = j.cancelled ? 'aborted' : success ? 'success' : 'failed';
        store.updateDeploy(repo.name, n, prNumber, (d) => {
          d.status = status;
          d.exitCode = j.exitCode;
          d.conversation = j.conversation;
          d.finishedAt = new Date().toISOString();
        });
        return { action: 'deploy', prNumber, status };
      },
    });

    jobs.subscribe(job, res);
  });
}

app.post('/api/repos/:name/issues/:n/deploy/:pr', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const prNumber = Number(req.params.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: 'invalid PR number' });
  }
  const key = `${repo.name}#${n}:deploy:${prNumber}`;

  const existing = jobs.getJob(key);
  if (existing && existing.status === 'running') {
    writeSseHead(res);
    jobs.subscribe(existing, res);
    return;
  }

  const deployConfig = repoConfig.loadDeployConfig(repo.path);
  if (!deployConfig.type) {
    return res.status(400).json({
      error:
        deployConfig.error ||
        `Deploy not configured for ${repo.name}. Add a .cloud-copilot.json at the repo root (see README).`,
    });
  }

  writeSseHead(res);

  // Repo-level lock: Deploy checks out a branch on the same shared working
  // tree as Create PR/Chat, so it must be mutually exclusive with them too.
  const busyKey = findOtherRepoBusyKey(repo.name, key);
  if (busyKey) {
    const msg = `Blocked: ${describeBusyKey(repo.name, busyKey)}. Deploy, Merge and Restart main share this repo's working tree and cannot overlap.`;
    return sendSseBlocked(res, { action: 'deploy', prNumber, status: 'blocked', message: msg });
  }

  // Archives the previous terminal deploy (if any) into deployHistory before
  // resetting `deploy` to a fresh in-progress state.
  store.startNewDeploy(repo.name, n, prNumber);

  if (deployConfig.type === 'shell') {
    runShellDeploy({ res, repo, n, prNumber, key, command: deployConfig.command });
  } else {
    runIosTestflightDeploy({ res, repo, n, prNumber, key });
  }
});

// Abort a running deploy for a specific PR.
app.post('/api/repos/:name/issues/:n/deploy/:pr/cancel', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const prNumber = Number(req.params.pr);
  if (badIssueNumber(res, n)) return;
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: 'invalid PR number' });
  }
  res.json(abortAction(repo.name, n, 'deploy', prNumber));
});

// ---------------------------------------------------------------------------
// Action: Merge a specific PR. A failed gh merge automatically starts Copilot
// to investigate, resolve branch conflicts, push, and retry the merge.
// ---------------------------------------------------------------------------

app.post('/api/repos/:name/issues/:n/merge/:pr', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const prNumber = Number(req.params.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: 'invalid PR number' });
  }
  const key = `${repo.name}#${n}:merge:${prNumber}`;
  const force = Boolean(req.body?.force);

  writeSseHead(res);

  const existing = jobs.getJob(key);
  if (existing && existing.status === 'running') {
    jobs.subscribe(existing, res);
    return;
  }

  if (!force) {
    const record = store.getRecord(repo.name, n);
    const pr = record.prs[prNumber];
    const deployStatus = pr && pr.deploy && pr.deploy.status;
    if (deployStatus !== 'success') {
      const message =
        `Blocked: Deploy for PR #${prNumber} has not succeeded (status: ${deployStatus || 'idle'}). ` +
        `Merge requires a successful Deploy, or force-merge to skip.`;
      return sendSseBlocked(res, { action: 'merge', prNumber, status: 'blocked', message });
    }
  }

  const busyKey = findOtherRepoBusyKey(repo.name, key);
  if (busyKey) {
    const message = `Blocked: ${describeBusyKey(repo.name, busyKey)}. Deploy, Merge and Restart main share this repo's working tree and cannot overlap.`;
    return sendSseBlocked(res, { action: 'merge', prNumber, status: 'blocked', message });
  }

  store.updateMerge(repo.name, n, prNumber, (m) => {
    m.status = 'merging';
    m.forced = force;
    m.startedAt = new Date().toISOString();
    m.finishedAt = null;
    m.conversation = '';
    m.sessionId = null;
    m.recoveryAttempted = false;
    m.conflictResolved = false;
    m.recoveryMessage = null;
  });

  const job = jobs.startJob(key, {
    bin: process.execPath,
    args: [
      path.join(__dirname, 'lib', 'mergeRunner.js'),
      gh.GH_BIN,
      COPILOT_BIN,
      repo.ownerRepo,
      String(prNumber),
      resolveModel(),
    ],
    cwd: repo.path,
    meta: {
      action: 'merge',
      prNumber,
      repo: repo.name,
      issueNumber: n,
      subject: cachedPrTitle(repo, prNumber) || `PR #${prNumber}`,
    },
    onSession: (id) =>
      store.updateMerge(repo.name, n, prNumber, (m) => {
        m.sessionId = id;
      }),
    onProgress: (j) =>
      store.updateMerge(repo.name, n, prNumber, (m) => {
        m.conversation = j.conversation;
        if (j.sessionId) m.sessionId = j.sessionId;
      }),
    onDone: async (j) => {
      const mergedAfterCancellation = j.cancelled
        ? await gh.getPr(repo.ownerRepo, prNumber).then((pr) => pr?.state === 'MERGED')
        : false;
      const success = j.exitCode === 0 || mergedAfterCancellation;
      const status = success ? 'success' : j.cancelled ? 'aborted' : 'failed';
      const markerMatches = [
        ...j.conversation.matchAll(/\[cloud-copilot merge recovery\] (\{[^\n]+\})/g),
      ];
      let recovery = {};
      if (markerMatches.length) {
        try {
          recovery = JSON.parse(markerMatches.at(-1)[1]);
        } catch {
          recovery = {};
        }
      }
      const recoveryAttempted = Boolean(recovery.attempted);
      const conflictResolved = Boolean(
        success && (recovery.conflictResolved || (mergedAfterCancellation && recovery.conflictDetected)),
      );
      const baseRefName =
        typeof recovery.baseRefName === 'string' && recovery.baseRefName ? recovery.baseRefName : null;
      const recoveryMessage = conflictResolved
        ? 'Merged after Copilot resolved conflicts'
        : recoveryAttempted && success
          ? 'Merged after Copilot recovery'
          : recoveryAttempted
            ? 'Copilot recovery did not complete the merge'
            : null;
      store.updateMerge(repo.name, n, prNumber, (m) => {
        m.status = status;
        m.exitCode = j.exitCode;
        m.conversation = j.conversation;
        m.sessionId = j.sessionId;
        m.recoveryAttempted = recoveryAttempted;
        m.conflictResolved = conflictResolved;
        m.recoveryMessage = recoveryMessage;
        m.finishedAt = new Date().toISOString();
      });
      let issueCleanup = null;
      if (success) {
        // GitHub only auto-closes the issue when the PR body carries `Closes #N`
        // and targets the default branch, and it never closes the other PRs
        // opened for the same issue — do both ourselves. Best-effort: a cleanup
        // failure must not flip an already successful merge to 'failed'.
        try {
          const record = store.getRecord(repo.name, n);
          issueCleanup = await cleanupAfterMerge({
            ownerRepo: repo.ownerRepo,
            issueNumber: n,
            mergedPrNumber: prNumber,
            prNumbers: Object.keys(record.prs || {}).map(Number),
          });
        } catch (error) {
          issueCleanup = { errors: [error.message], message: `Post-merge cleanup failed: ${error.message}` };
        }
        store.updateMerge(repo.name, n, prNumber, (m) => {
          m.cleanup = issueCleanup;
        });
      }
      if (success && baseRefName) {
        // Best-effort: bring the local clone back to the base branch, like the
        // manual `git checkout main && git pull` done after a manual merge.
        try {
          execFileSync('git', ['checkout', baseRefName], { cwd: repo.path, stdio: 'ignore', timeout: 15000 });
          execFileSync('git', ['pull', 'origin', baseRefName], {
            cwd: repo.path,
            stdio: 'ignore',
            timeout: 30000,
          });
        } catch {
          /* best-effort only — merge itself already succeeded */
        }
      }
      // A merged PR's worktree is dead weight, and GitHub usually deleted its
      // remote branch — so origin/<base> is what proves its commits are safe.
      let worktreeCleanup = [];
      if (success) {
        const base = baseRefName || defaultBranchOf(repo.path);
        let mergedBranch = null;
        try {
          const prInfo = await gh.getPr(repo.ownerRepo, prNumber);
          mergedBranch = (prInfo && prInfo.headRefName) || null;
        } catch {
          /* the sweep below still covers it */
        }
        worktreeCleanup = worktrees.cleanupAfterRun(repo.path, mergedBranch, {
          skipPaths: [j.cwd],
          fallbackRef: `origin/${base}`,
        });
        const cleanupText = worktrees.formatCleanup(worktreeCleanup);
        if (cleanupText) {
          store.updateMerge(repo.name, n, prNumber, (m) => {
            m.conversation = `${m.conversation}\n${cleanupText}\n`;
          });
        }
        // A merge moves the base branch, so every other open PR just fell
        // behind by at least one commit. Recompare them now instead of letting
        // the whole board lie for up to three minutes.
        sweepRepoSyncSoon(repo);
      }
      return {
        action: 'merge',
        prNumber,
        status,
        recoveryAttempted,
        conflictResolved,
        recoveryMessage,
        cleanup: issueCleanup,
        cleanupMessage: (issueCleanup && issueCleanup.message) || null,
        worktreeCleanup,
      };
    },
  });

  jobs.subscribe(job, res);
});

// Abort a running merge for a specific PR.
app.post('/api/repos/:name/issues/:n/merge/:pr/cancel', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const prNumber = Number(req.params.pr);
  if (badIssueNumber(res, n)) return;
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: 'invalid PR number' });
  }
  res.json(abortAction(repo.name, n, 'merge', prNumber));
});

// ---------------------------------------------------------------------------
// Action: Update a PR with the latest base branch (issue #58)
//
// Direction matters: this merges base → PR head. It NEVER merges the PR into
// main — that is what the Merge action is for, and confusing the two would ship
// unreviewed work. The actual merge (and any conflict resolution) is done by a
// Copilot session running in the PR's own working tree, so a conflicted branch
// is fixed here instead of sending the user to a terminal.
// ---------------------------------------------------------------------------

// How many commits `origin/<base>` has that `origin/<head>` does not. This is
// the authoritative answer right after a push — GitHub's own `mergeable` field
// is computed asynchronously and lags by seconds. Returns null when it cannot
// be determined (missing ref, git error), which callers treat as "unknown".
function behindCount(repoPath, base, head) {
  try {
    execFileSync('git', ['fetch', 'origin', base, head], {
      cwd: repoPath,
      stdio: 'ignore',
      timeout: 60000,
    });
  } catch {
    /* fall through — the refs may still be present from an earlier fetch */
  }
  try {
    const out = git(repoPath, ['rev-list', '--count', `origin/${head}..origin/${base}`], 30000);
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function updatePrompt({ ownerRepo, prNumber, baseRefName, headRefName, conflicting }) {
  return [
    `Update the branch of pull request #${prNumber} in ${ownerRepo} so that it contains the latest \`${baseRefName}\`.`,
    `The ONLY allowed direction is \`${baseRefName}\` → \`${headRefName}\`.`,
    `Do NOT merge the pull request into \`${baseRefName}\`, do not run \`gh pr merge\`, and do not open a new pull request.`,
    `The branch \`${headRefName}\` is already checked out in this working directory.`,
    `Steps: run \`git fetch origin\`, then \`git merge origin/${baseRefName}\`.`,
    conflicting
      ? 'GitHub reports this branch as CONFLICTING, so expect conflicts: resolve every one of them correctly, preserving the intent of BOTH sides — never discard the base branch\'s changes and never throw away this PR\'s own work.'
      : 'If conflicts appear, resolve every one of them correctly, preserving the intent of both sides.',
    'After resolving, verify the result builds/passes whatever existing checks are relevant to the changed files, commit the merge, and push `' +
      headRefName +
      '` to origin. Never force-push.',
    `Finally verify with \`git rev-list --count origin/${headRefName}..origin/${baseRefName}\` that it prints 0.`,
    'If you truly cannot resolve the conflicts, run `git merge --abort` so the working tree is left clean, and explain precisely what blocked you.',
    'Do not ask the user for confirmation — work autonomously.',
  ].join(' ');
}

app.post('/api/repos/:name/issues/:n/prs/:pr/update', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const prNumber = Number(req.params.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: 'invalid PR number' });
  }
  const key = `${repo.name}#${n}:update:${prNumber}`;

  writeSseHead(res);

  // Reconnect to an already-running update instead of starting a second one.
  const existing = jobs.getJob(key);
  if (existing && existing.status === 'running') {
    jobs.subscribe(existing, res);
    return;
  }

  const busyKey = findOtherRepoBusyKey(repo.name, key);
  if (busyKey) {
    const message = `Blocked: ${describeBusyKey(repo.name, busyKey)}.`;
    return sendSseBlocked(res, { action: 'update', prNumber, status: 'blocked', message });
  }

  const prInfo = await gh.getPr(repo.ownerRepo, prNumber);
  if (!prInfo || !prInfo.headRefName) {
    const message = `Could not resolve the branch for PR #${prNumber} via gh.`;
    return sendSseBlocked(res, { action: 'update', prNumber, status: 'failed', message });
  }
  const closed = refuseIfPrClosed(repo, n, prNumber, prInfo);
  if (closed) {
    return sendSseBlocked(res, { action: 'update', prNumber, status: 'blocked', message: closed });
  }
  if (prInfo.state === 'MERGED') {
    // Persist it: otherwise a stale local record keeps the scheduler coming
    // back to this PR every sweep only to be blocked here again.
    store.upsertPr(repo.name, n, { prNumber, state: 'MERGED' });
    const message = `Blocked: PR #${prNumber} is already merged — there is nothing to update.`;
    return sendSseBlocked(res, { action: 'update', prNumber, status: 'blocked', message });
  }
  const baseRefName = prInfo.baseRefName || defaultBranchOf(repo.path);
  const headRefName = prInfo.headRefName;

  // The PR's branch in a worktree of its own, so this can run while other
  // issues are being implemented in parallel.
  let lease;
  try {
    lease = await leaseWorktree(repo, {
      key,
      action: 'update',
      issueNumber: n,
      prNumber,
      branch: headRefName,
      baseRef: baseRefName,
    });
  } catch (err) {
    const message = `Failed to check out branch "${headRefName}": ${err.message}`;
    return sendSseBlocked(res, { action: 'update', prNumber, status: leaseFailureStatus(err), message });
  }
  const workCwd = lease.path;

  const storedSync = (store.getRecord(repo.name, n).prs[prNumber] || {}).sync || null;
  const conflicting =
    (storedSync && storedSync.state === 'conflict') ||
    (prInfo.mergeable && prInfo.mergeable === 'CONFLICTING');

  store.updateBranchUpdate(repo.name, n, prNumber, (u) => {
    u.status = 'updating';
    u.startedAt = new Date().toISOString();
    u.finishedAt = null;
    u.conversation = '';
    u.sessionId = null;
    u.exitCode = null;
    u.baseRefName = baseRefName;
    u.message = null;
  });

  const job = startLeasedJob(lease, key, {
    bin: COPILOT_BIN,
    args: [
      '-p',
      updatePrompt({ ownerRepo: repo.ownerRepo, prNumber, baseRefName, headRefName, conflicting }) +
        portNote(lease),
      '--allow-all',
      ...modelFlags(),
    ],
    cwd: workCwd,
    env: lease.env,
    meta: {
      action: 'update',
      prNumber,
      repo: repo.name,
      issueNumber: n,
      subject: cachedPrTitle(repo, prNumber) || `PR #${prNumber}`,
      auto: Boolean(req.body?.auto),
      worktree: lease.path,
      port: lease.port,
    },
    onSession: (id) =>
      store.updateBranchUpdate(repo.name, n, prNumber, (u) => {
        u.sessionId = id;
      }),
    onProgress: (j) =>
      store.updateBranchUpdate(repo.name, n, prNumber, (u) => {
        u.conversation = j.conversation;
        if (j.sessionId) u.sessionId = j.sessionId;
      }),
    onDone: async (j) => {
      // Trust git, not the transcript: the branch is only updated if the
      // pushed head really contains the pushed base.
      const behind = j.cancelled ? null : behindCount(repo.path, baseRefName, headRefName);
      const success = !j.cancelled && j.exitCode === 0 && behind === 0;
      const status = success
        ? 'success'
        : j.cancelled
          ? 'aborted'
          : 'failed';
      const message = success
        ? `Merged origin/${baseRefName} into ${headRefName} and pushed — 0 commits behind.`
        : j.cancelled
          ? 'Update aborted.'
          : behind == null
            ? `Could not verify ${headRefName} against origin/${baseRefName}.`
            : `${headRefName} is still ${behind} commit(s) behind origin/${baseRefName}.`;

      // Recompare the branch locally so the badge tells the truth immediately.
      // git is authoritative here and answers now; GitHub recomputes
      // `mergeable` asynchronously and would leave the badge stale for
      // minutes after a run that just fixed everything.
      let sync = null;
      try {
        sync = await prSync.computePrSync(repo.path, {
          prNumber,
          baseRefName,
          headRefName,
          crossRepository: false,
        });
        if (sync) store.setPrSync(repo.name, n, prNumber, sync);
      } catch {
        /* keep the previous value */
      }

      store.updateBranchUpdate(repo.name, n, prNumber, (u) => {
        u.status = status;
        u.exitCode = j.exitCode;
        u.conversation = j.conversation;
        u.sessionId = j.sessionId;
        u.finishedAt = new Date().toISOString();
        u.message = message;
      });

      // New commits on the branch mean the previous Deploy/Merge no longer
      // describe this code — same rule an "apply" chat turn follows.
      if (success && behind === 0) store.resetForNewCommits(repo.name, n, prNumber);

      // Leave no half-open worktree behind, whatever happened.
      const cleanup = releaseLease(lease, { fallbackRef: `origin/${baseRefName}` });
      const cleanupText = worktrees.formatCleanup(cleanup);
      if (cleanupText) {
        store.updateBranchUpdate(repo.name, n, prNumber, (u) => {
          u.conversation = `${u.conversation}\n${cleanupText}\n`;
        });
      }

      return {
        action: 'update',
        prNumber,
        status,
        message,
        behindBy: behind,
        baseRefName,
        sync,
        worktreeCleanup: cleanup,
      };
    },
  }, {
    fallbackRef: `origin/${baseRefName}`,
    onFail: (err) =>
      sendSseBlocked(res, {
        action: 'update',
        prNumber,
        status: 'failed',
        message: `Could not start the update: ${err.message}`,
      }),
  });
  if (!job) return;

  jobs.subscribe(job, res);
});

// Abort a running base-branch update for a specific PR.
app.post('/api/repos/:name/issues/:n/prs/:pr/update/cancel', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const prNumber = Number(req.params.pr);
  if (badIssueNumber(res, n)) return;
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: 'invalid PR number' });
  }
  res.json(abortAction(repo.name, n, 'update', prNumber));
});

// ---------------------------------------------------------------------------
// Action: Review a PR and improve it in the same run (issue #64)
//
// The last stage the scheduler drives for a committed issue. Once a PR exists
// and is in sync with its base, there is nothing left to react to — the only
// way it keeps getting better is a deliberate critique of the diff followed by
// acting on it. Both halves happen in one Copilot session on purpose: a review
// that only leaves comments needs a human to come back, which is exactly the
// loop this feature exists to remove.
//
// Eligibility is per head commit: `review.lastReviewedSha` records the commit a
// completed review ran against, so the same code is never reviewed twice, and
// any new commit makes the PR eligible again.
// ---------------------------------------------------------------------------

function reviewPrompt({ ownerRepo, prNumber, baseRefName, headRefName }) {
  return [
    `Review pull request #${prNumber} in ${ownerRepo} thoroughly, then improve it — in this single run.`,
    `Its branch \`${headRefName}\` is already checked out here; its base is \`${baseRefName}\`.`,
    `Start by reading the full diff: \`git fetch origin\` then \`git diff origin/${baseRefName}...HEAD\`, plus \`gh pr view ${prNumber} --repo ${ownerRepo}\` for the issue it closes and any existing review comments.`,
    'Judge it as a demanding reviewer would: correctness bugs, unhandled failure modes, race conditions, security problems, missing or wrong tests, dead or duplicated code, and whether it actually satisfies the issue it claims to close.',
    'Then FIX what you found. Apply the improvements yourself — do not merely list them.',
    'Ignore pure style/formatting preferences and do not restructure code that is already correct; the goal is a better PR, not a different one.',
    'Run whatever build/lint/test commands already exist for the changed files and make sure they pass.',
    `Commit your improvements and push them to \`${headRefName}\`. Never force-push, never open a new pull request, and never merge anything.`,
    `Finally, post one PR comment with \`gh pr comment ${prNumber} --repo ${ownerRepo} --body ...\` summarising what you reviewed, what you changed, and anything you deliberately left alone.`,
    'If the review finds nothing worth changing, say so explicitly and post that as the comment instead of inventing work.',
    'Work autonomously — do not ask for confirmation.',
  ].join(' ');
}

app.post('/api/repos/:name/issues/:n/prs/:pr/review', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const prNumber = Number(req.params.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: 'invalid PR number' });
  }
  const key = `${repo.name}#${n}:review:${prNumber}`;

  writeSseHead(res);

  const existing = jobs.getJob(key);
  if (existing && existing.status === 'running') {
    jobs.subscribe(existing, res);
    return;
  }

  const busyKey = findOtherRepoBusyKey(repo.name, key);
  if (busyKey) {
    const message = `Blocked: ${describeBusyKey(repo.name, busyKey)}.`;
    return sendSseBlocked(res, { action: 'review', prNumber, status: 'blocked', message });
  }

  const prInfo = await gh.getPr(repo.ownerRepo, prNumber);
  if (!prInfo || !prInfo.headRefName) {
    const message = `Could not resolve the branch for PR #${prNumber} via gh.`;
    return sendSseBlocked(res, { action: 'review', prNumber, status: 'failed', message });
  }
  const closed = refuseIfPrClosed(repo, n, prNumber, prInfo);
  if (closed) {
    return sendSseBlocked(res, { action: 'review', prNumber, status: 'blocked', message: closed });
  }
  if (prInfo.state === 'MERGED') {
    // Remember it: a stale local record would otherwise send the scheduler back
    // here on every single sweep, blocked in exactly the same way.
    store.upsertPr(repo.name, n, { prNumber, state: 'MERGED' });
    const message = `Blocked: PR #${prNumber} is already merged — there is nothing left to review.`;
    return sendSseBlocked(res, { action: 'review', prNumber, status: 'blocked', message });
  }

  const baseRefName = prInfo.baseRefName || defaultBranchOf(repo.path);
  const headRefName = prInfo.headRefName;
  const headSha = prInfo.headRefOid || branchHeadSha(repo.path, prInfo.headRefName);

  let lease;
  try {
    lease = await leaseWorktree(repo, {
      key,
      action: 'review',
      issueNumber: n,
      prNumber,
      branch: headRefName,
      baseRef: baseRefName,
    });
  } catch (err) {
    const message = `Failed to check out branch "${headRefName}": ${err.message}`;
    return sendSseBlocked(res, { action: 'review', prNumber, status: leaseFailureStatus(err), message });
  }

  store.updateReview(repo.name, n, prNumber, (rv) => {
    rv.status = 'reviewing';
    rv.startedAt = new Date().toISOString();
    rv.finishedAt = null;
    rv.conversation = '';
    rv.sessionId = null;
    rv.exitCode = null;
    rv.reviewedSha = headSha;
    rv.message = null;
  });

  const job = startLeasedJob(lease, key, {
    bin: COPILOT_BIN,
    args: [
      '-p',
      reviewPrompt({ ownerRepo: repo.ownerRepo, prNumber, baseRefName, headRefName }) + portNote(lease),
      '--allow-all',
      ...modelFlags(),
    ],
    cwd: lease.path,
    env: lease.env,
    meta: {
      action: 'review',
      prNumber,
      repo: repo.name,
      issueNumber: n,
      subject: cachedPrTitle(repo, prNumber) || `PR #${prNumber}`,
      auto: Boolean(req.body?.auto),
      worktree: lease.path,
      port: lease.port,
    },
    onSession: (id) =>
      store.updateReview(repo.name, n, prNumber, (rv) => {
        rv.sessionId = id;
      }),
    onProgress: (j) =>
      store.updateReview(repo.name, n, prNumber, (rv) => {
        rv.conversation = j.conversation;
        if (j.sessionId) rv.sessionId = j.sessionId;
      }),
    onDone: async (j) => {
      const status = j.cancelled ? 'aborted' : j.exitCode === 0 ? 'success' : 'failed';
      // Whether the review changed anything is decided by git, not by the
      // transcript: a review that pushed commits moved the head SHA.
      //
      // Local git first, and `gh` only as a fallback, because the scheduler
      // decides "has this commit been reviewed?" by comparing
      // `lastReviewedSha` against local `origin/<branch>`. Recording a sha from
      // a different source is what makes the two disagree — and a `gh` call
      // that fails or omits `headRefOid` would store the stale (or a null) sha
      // and hand the same PR back to the very next sweep, forever.
      let newHeadSha = branchHeadSha(repo.path, headRefName, { fetch: true });
      if (!newHeadSha) {
        try {
          const after = await gh.getPr(repo.ownerRepo, prNumber);
          if (after && after.headRefOid) newHeadSha = after.headRefOid;
        } catch {
          /* keep the pre-run SHA */
        }
      }
      if (!newHeadSha) newHeadSha = headSha;
      const improved = Boolean(headSha && newHeadSha && newHeadSha !== headSha);
      const message =
        status === 'success'
          ? improved
            ? 'Reviewed and pushed improvements.'
            : 'Reviewed — nothing worth changing.'
          : status === 'aborted'
            ? 'Review aborted.'
            : 'Review did not finish cleanly.';

      const cleanup = releaseLease(lease, { fallbackRef: `origin/${baseRefName}` });
      const cleanupText = worktrees.formatCleanup(cleanup);

      store.updateReview(repo.name, n, prNumber, (rv) => {
        rv.status = status;
        rv.exitCode = j.exitCode;
        rv.conversation = cleanupText ? `${j.conversation}\n${cleanupText}\n` : j.conversation;
        rv.sessionId = j.sessionId || rv.sessionId;
        rv.finishedAt = new Date().toISOString();
        rv.message = message;
        // Only a COMPLETED review marks a commit as reviewed. Recording the
        // post-run head means improvements the review itself pushed are not
        // immediately treated as "new, unreviewed work" — otherwise every
        // review would schedule another one, forever.
        if (status === 'success') rv.lastReviewedSha = newHeadSha;
      });

      if (improved) {
        store.resetForNewCommits(repo.name, n, prNumber);
        sweepRepoSyncSoon(repo);
      }

      return {
        action: 'review',
        prNumber,
        status,
        message,
        improved,
        headSha: newHeadSha,
        worktreeCleanup: cleanup,
      };
    },
  }, {
    fallbackRef: `origin/${baseRefName}`,
    onFail: (err) =>
      sendSseBlocked(res, {
        action: 'review',
        prNumber,
        status: 'failed',
        message: `Could not start the review: ${err.message}`,
      }),
  });
  if (!job) return;

  jobs.subscribe(job, res);
});

app.post('/api/repos/:name/issues/:n/prs/:pr/review/cancel', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const prNumber = Number(req.params.pr);
  if (badIssueNumber(res, n)) return;
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: 'invalid PR number' });
  }
  res.json(abortAction(repo.name, n, 'review', prNumber));
});

// ---------------------------------------------------------------------------
// Action: Chat with a PR — plan → apply iteration on its existing branch
// ---------------------------------------------------------------------------

app.post('/api/repos/:name/issues/:n/prs/:pr/chat', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const prNumber = Number(req.params.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: 'invalid PR number' });
  }
  const mode = req.body?.mode === 'apply' ? 'apply' : 'plan';
  const key = `${repo.name}#${n}:chat:${prNumber}`;

  // Reconnect: if a job is already running (e.g. the client navigated away
  // and back), just re-attach — no new message required.
  const existing = jobs.getJob(key);
  if (existing && existing.status === 'running') {
    writeSseHead(res);
    jobs.subscribe(existing, res);
    return;
  }

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'message is required' });

  // Per-turn model override from the chat's own model dropdown; falls back to
  // the global setting when absent/unknown.
  const model = resolveModel(req.body?.model);

  writeSseHead(res);

  // Chat used to take the repo-wide lock because even a "plan" turn checked out
  // the PR's branch in the shared working tree. It now gets its own worktree,
  // so it only has to stay clear of the actions that still use the main tree.
  const busyKey = findOtherRepoBusyKey(repo.name, key);
  if (busyKey) {
    const msg = `Blocked: ${describeBusyKey(repo.name, busyKey)}.`;
    return sendSseBlocked(res, { action: 'chat', prNumber, mode, status: 'blocked', message: msg });
  }

  const record = store.getRecord(repo.name, n);
  const pr = record.prs[prNumber];
  // Resume the PR-specific chat session once one exists (later turns); the
  // very first turn resumes the original Create-PR session instead, so the
  // conversation starts with full context of what was already built.
  const resumeId = (pr && pr.chat && pr.chat.sessionId) || record.work.sessionId || null;

  const prInfo = await gh.getPr(repo.ownerRepo, prNumber);
  if (!prInfo || !prInfo.headRefName) {
    const message2 = `Could not resolve the branch for PR #${prNumber} via gh.`;
    return sendSseBlocked(res, { action: 'chat', prNumber, mode, status: 'failed', message: message2 });
  }
  const closed = refuseIfPrClosed(repo, n, prNumber, prInfo);
  if (closed) {
    return sendSseBlocked(res, { action: 'chat', prNumber, mode, status: 'blocked', message: closed });
  }
  let lease;
  try {
    lease = await leaseWorktree(repo, {
      key,
      action: 'chat',
      issueNumber: n,
      prNumber,
      branch: prInfo.headRefName,
      baseRef: prInfo.baseRefName || defaultBranchOf(repo.path),
    });
  } catch (err) {
    const message2 = `Failed to check out branch "${prInfo.headRefName}": ${err.message}`;
    return sendSseBlocked(res, {
      action: 'chat',
      prNumber,
      mode,
      status: leaseFailureStatus(err),
      message: message2,
    });
  }
  const workCwd = lease.path;

  // Attached screenshots/mockups (if any) — saved to disk so they can be
  // passed to the CLI via --attachment and redisplayed from history later.
  const savedImages = saveUploadedImages(req.body?.images);
  const imageRefs = savedImages.map((img) => ({ url: img.url, name: img.name }));

  store.appendChatMessage(repo.name, n, prNumber, { role: 'user', text: message, mode, images: imageRefs, model });

  const args = [];
  if (resumeId) args.push(`--resume=${resumeId}`);
  for (const img of savedImages) args.push('--attachment', img.path);
  if (mode === 'plan') {
    // Read-only: propose a plan, do not touch files. Enforced via approval
    // flags (default = file edits denied), not just the prompt wording.
    const prompt =
      `The branch for PR #${prNumber} is already checked out. Do NOT modify any files. ` +
      `Read the relevant code and propose a concrete plan for the following request, ` +
      `ending with a clear plan summary: ${message}`;
    args.push('-p', prompt, ...approvalFlags('default'), ...modelFlags(model));
  } else {
    // Implement the plan from the resumed conversation, on the SAME branch.
    const prompt =
      `Implement the plan from our conversation for this request: ${message}\n\n` +
      `Commit and push the changes to the EXISTING branch for PR #${prNumber} ` +
      `(do not open a new PR, do not force-push). Confirm what you committed and pushed.` +
      portNote(lease);
    args.push('-p', prompt, '--allow-all', ...modelFlags(model));
  }

  const job = startLeasedJob(lease, key, {
    bin: COPILOT_BIN,
    args,
    cwd: workCwd,
    env: lease.env,
    meta: {
      action: 'chat',
      prNumber,
      mode,
      model,
      repo: repo.name,
      issueNumber: n,
      chatTitle: store.titleFromMessage(message),
      subject: cachedPrTitle(repo, prNumber) || `PR #${prNumber}`,
      worktree: lease.path,
      port: lease.port,
    },
    onSession: (id) =>
      store.updateRecord(repo.name, n, (r) => {
        const pr2 = r.prs[prNumber];
        if (pr2) {
          if (!pr2.chat) pr2.chat = { sessionId: null, messages: [] };
          pr2.chat.sessionId = id;
        }
      }),
    onDone: async (j) => {
      const status = j.cancelled ? 'aborted' : j.exitCode === 0 ? 'success' : 'failed';
      const cleanup = releaseLease(lease, {
        fallbackRef: `origin/${prInfo.baseRefName || defaultBranchOf(repo.path)}`,
      });
      const cleanupText = worktrees.formatCleanup(cleanup);
      store.appendChatMessage(repo.name, n, prNumber, {
        role: 'assistant',
        text: cleanupText ? `${j.conversation}\n${cleanupText}\n` : j.conversation,
        mode,
        model,
      });
      // New commits landed — the old Deploy/Merge no longer reflect this code.
      if (mode === 'apply' && status === 'success') {
        store.resetForNewCommits(repo.name, n, prNumber);
      }
      return { action: 'chat', prNumber, mode, status, sessionId: j.sessionId, model };
    },
  }, {
    fallbackRef: `origin/${prInfo.baseRefName || defaultBranchOf(repo.path)}`,
    onFail: (err) =>
      sendSseBlocked(res, {
        action: 'chat',
        prNumber,
        mode,
        status: 'failed',
        message: `Could not start this chat turn: ${err.message}`,
      }),
  });
  if (!job) return;

  jobs.subscribe(job, res);
});

// Abort a running chat turn for a specific PR.
app.post('/api/repos/:name/issues/:n/prs/:pr/chat/cancel', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const prNumber = Number(req.params.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: 'invalid PR number' });
  }
  const cancelled = jobs.cancelJob(`${repo.name}#${n}:chat:${prNumber}`);
  res.json({ cancelled });
});

// ---------------------------------------------------------------------------
// Running tasks (issue #64)
//
// With several agents running at once, "what is this machine doing right now?"
// stops being obvious from the issue list alone. This is the panel's whole data
// source: one cheap in-memory read, no `gh` and no git, so the client can poll
// it every few seconds.
//
// Since the supervisor moved to :8788 this also reports sessions this process
// does not (yet) have a job for — the ones that outlived a restart. Without
// that, a Stop button on a live task would keep answering 404, which is exactly
// the bug the split was meant to end.
// ---------------------------------------------------------------------------

/**
 * The scheduler's state, or a stand-in explaining why it is unknown.
 *
 * The switch and its "run now" button live on the dashboard but the loop lives
 * on :8788, so an unreachable scheduler must be visibly unreachable — a panel
 * that quietly renders "off" would invite someone to turn on automation that is
 * already on.
 *
 * One missed poll is not "unreachable", though. This process blocks its own
 * event loop for seconds at a time (every `gh` and `git` call is synchronous),
 * and treating that as the scheduler being down would make the switch flicker
 * and disable itself at random. So the last good answer stands in, marked
 * stale, until the failures have lasted long enough to mean something.
 */
let lastSchedulerState = null;
let schedulerUnreachableSince = null;
const SCHEDULER_GRACE_MS = 20000;

async function schedulerState() {
  try {
    lastSchedulerState = await supervisorClient.getJson('/api/scheduler', { timeout: 8000 });
    schedulerUnreachableSince = null;
    return lastSchedulerState;
  } catch (err) {
    if (!schedulerUnreachableSince) schedulerUnreachableSince = Date.now();
    const outage = Date.now() - schedulerUnreachableSince;
    if (lastSchedulerState && outage < SCHEDULER_GRACE_MS) {
      return { ...lastSchedulerState, stale: true };
    }
    return {
      enabled: false,
      repos: {},
      running: false,
      unreachable: true,
      error: `cloud-scheduler (${supervisorClient.BASE}) is not answering: ${err.message}`,
    };
  }
}

app.get('/api/jobs', async (req, res) => {
  const local = jobs.listRunning();
  const known = new Set(local.map((j) => j.key));
  let supervised = [];
  try {
    const { sessions } = await supervisorClient.listSessions();
    supervised = (sessions || [])
      .filter((s) => s.key && !known.has(s.key))
      .map((s) => ({
        key: s.key,
        startedAt: s.startedAt,
        elapsedMs: s.elapsedMs,
        sessionId: s.sessionId,
        sessionRef: s.id,
        supervised: true,
        detachedFromDashboard: true,
        pid: s.pid,
        cwd: s.cwd,
        subscribers: 0,
        ...(s.meta || {}),
      }));
  } catch {
    /* the panel still works from local jobs alone */
  }
  res.json({
    at: Date.now(),
    jobs: [...local, ...supervised],
    worktrees: worktreePool.list(),
    limits: { perRepo: worktreePool.MAX_PER_REPO, global: worktreePool.MAX_GLOBAL },
    scheduler: await schedulerState(),
    supervisor: { base: supervisorClient.BASE, sessions: supervised.length + local.length },
  });
});

// Stop one running task by its job key. The panel needs this because a task can
// be started from another device (or by the scheduler) and therefore has no
// action-specific cancel button on screen here.
app.post('/api/jobs/cancel', async (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key : '';
  if (!key) return res.status(400).json({ error: 'key is required' });
  const job = jobs.getJob(key);
  if (job && job.status === 'running') {
    return res.json({ cancelled: jobs.cancelJob(key) });
  }
  // No local job: the process may still be very much alive under the
  // supervisor — a restart between starting it and stopping it is the normal
  // case, not an error.
  try {
    const out = await supervisorClient.abortByKey(key);
    return res.json({ cancelled: Boolean(out && out.ok), via: 'supervisor' });
  } catch (err) {
    return res.status(404).json({ error: `no such running job (${err.message})` });
  }
});

// ---------------------------------------------------------------------------
// Committed issues + the automatic scheduler (issue #64)
//
// The scheduler itself runs in the cloud-scheduler process on :8788 so that
// restarting this one cannot stop it. These endpoints are kept as proxies: the
// browser's contract is unchanged, and the settings panel needs no idea that
// two servers are involved.
// ---------------------------------------------------------------------------

app.post('/api/repos/:name/issues/:n/committed', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  if (!repo.ownerRepo) return res.status(400).json({ error: 'repo has no github.com remote' });
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'invalid issue number' });
  const committed = Boolean(req.body?.committed);
  try {
    await gh.setIssueLabel(repo.ownerRepo, n, gh.COMMITTED_LABEL, committed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  // Committing something and watching nothing happen for up to ten minutes
  // looks exactly like a broken button, so bring the next sweep forward. A
  // sweep is a no-op while automation is off, and `runNow` only reschedules the
  // existing timer — a burst of clicks cannot start a burst of sweeps.
  let scheduled = false;
  if (committed) {
    try {
      const { enabled } = await supervisorClient.getJson(
        `/api/scheduler/enabled/${encodeURIComponent(repo.name)}`,
        { timeout: 3000 },
      );
      scheduled = Boolean(enabled);
      if (scheduled) await supervisorClient.postJson('/api/scheduler', { runNow: true });
    } catch {
      /* the scheduler's next sweep will pick it up regardless */
    }
  } else {
    // Un-committing clears the retry budget, so re-committing later starts from
    // a clean slate instead of resuming a backoff the user cannot see.
    supervisorClient
      .postJson('/api/scheduler', { reset: { repo: repo.name, issueNumber: n } })
      .catch(() => {});
  }
  res.json({
    committed,
    label: gh.COMMITTED_LABEL,
    scheduled,
    // The full label set as the server now knows it, so the client can write
    // the truth into its cache instead of guessing at a patch.
    labels: gh.cachedIssueLabels(repo.ownerRepo, n),
  });
});

app.get('/api/settings/scheduler', async (req, res) => {
  res.json(await schedulerState());
});

app.post('/api/settings/scheduler', async (req, res) => {
  try {
    res.json(await supervisorClient.postJson('/api/scheduler', req.body || {}, { timeout: 5000 }));
  } catch (err) {
    res.status(502).json({
      error: `cloud-scheduler (${supervisorClient.BASE}) is not answering: ${err.message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// Simple one-shot demo endpoint (kept from the original demo)
// ---------------------------------------------------------------------------

app.post('/api/run', (req, res) => {
  const prompt =
    typeof req.body?.prompt === 'string' && req.body.prompt.trim()
      ? req.body.prompt
      : 'Hello World';
  const mode = ['default', 'allow-all', 'granular'].includes(req.body?.mode)
    ? req.body.mode
    : 'default';
  const sessionId =
    typeof req.body?.sessionId === 'string' && /^[0-9a-fA-F-]{8,}$/.test(req.body.sessionId)
      ? req.body.sessionId
      : null;

  const args = [];
  if (sessionId) args.push(`--resume=${sessionId}`);
  args.push('-p', prompt, ...approvalFlags(mode), ...modelFlags());

  writeSseHead(res);
  runCopilotSSE({
    res,
    bin: COPILOT_BIN,
    args,
    cwd: process.env.WORKDIR || process.cwd(),
  }).then(({ exitCode, sessionId: sid }) => {
    res.write(`event: done\n`);
    res.write(`data: ${JSON.stringify({ exitCode, sessionId: sid })}\n\n`);
    res.end();
  });
});

// ---------------------------------------------------------------------------
// Admin terminal: a free-form Copilot CLI conversation rooted at REPOS_ROOT.
//
// Unlike the per-issue actions, this isn't tied to a repo/issue/PR — it's a
// plain chat session with the local Copilot CLI whose working directory is the
// authorized repos root, so it can see every repo at once. Each turn resumes
// the previous session (via --resume) so the conversation carries context.
// The chosen approval mode (bypass = --allow-all, granular, default) is applied
// per turn. Streams over SSE; killing the browser connection kills the child.
// ---------------------------------------------------------------------------
// Each turn runs as a detached job keyed by a client-supplied `turnId`, so the
// child process outlives the (fragile) mobile HTTP connection: if the phone
// drops mid-answer the job keeps running server-side and the client can
// re-subscribe (GET .../stream) to replay everything so far + resume live —
// exactly like the Create PR log. Killing the browser only unsubscribes.
const ADMIN_TURN_RE = /^[\w-]{6,64}$/;

app.post('/api/admin/chat', (req, res) => {
  const turnId = typeof req.body?.turnId === 'string' && ADMIN_TURN_RE.test(req.body.turnId)
    ? req.body.turnId
    : null;
  if (!turnId) return res.status(400).json({ error: 'turnId is required' });
  const key = `admin:${turnId}`;

  writeSseHead(res);

  // Reconnect: if this turn's job is already running (duplicate POST after a
  // flaky send), just attach to it instead of starting a second copilot.
  const existing = jobs.getJob(key);
  if (existing) {
    jobs.subscribe(existing, res);
    return;
  }

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return sendSseBlocked(res, { action: 'admin', status: 'failed', message: 'message is required' });

  // "bypass" is the UI label for --allow-all (unattended, no approval prompts).
  const rawMode = req.body?.mode === 'bypass' ? 'allow-all' : req.body?.mode;
  const mode = ['default', 'allow-all', 'granular'].includes(rawMode) ? rawMode : 'default';

  const sessionId =
    typeof req.body?.sessionId === 'string' && /^[0-9a-fA-F-]{8,}$/.test(req.body.sessionId)
      ? req.body.sessionId
      : null;

  // Optional repo scope: when set, the turn runs with cwd inside that repo
  // (still under REPOS_ROOT) instead of the shared repos root, so Copilot can
  // work on that repo directly rather than merely browsing it from the root.
  const repoName = typeof req.body?.repo === 'string' ? req.body.repo.trim() : '';
  let cwd = REPOS_ROOT;
  if (repoName) {
    const repo = resolveRepo(repoName);
    if (!repo) {
      return sendSseBlocked(res, { action: 'admin', status: 'failed', message: 'repo not found under REPOS_ROOT' });
    }
    cwd = repo.path;
  }

  const args = [];
  if (sessionId) args.push(`--resume=${sessionId}`);
  // Attached screenshots/mockups (if any) — saved to disk so they can be
  // passed to the CLI via --attachment and redisplayed from history later.
  const savedImages = saveUploadedImages(req.body?.images);
  const imageRefs = savedImages.map((img) => ({ url: img.url, name: img.name }));
  for (const img of savedImages) args.push('--attachment', img.path);
  const model = resolveModel(req.body?.model);
  args.push('-p', message, ...approvalFlags(mode), ...modelFlags(model));

  // Durably buffer this turn *before* spawning the child. If this very turn
  // asks Copilot to redeploy (which restarts this server process), the
  // `close` handler below never gets to run — without this pre-write, the
  // whole turn would vanish with no trace. See store.startAdminTurn.
  store.startAdminTurn(turnId, {
    userText: message,
    mode,
    repo: repoName || null,
    images: imageRefs,
    sessionId,
    model,
  });

  const job = jobs.startJob(key, {
    bin: COPILOT_BIN,
    args,
    cwd,
    meta: {
      action: 'admin',
      turnId,
      repo: repoName || null,
      model,
      sessionId,
      chatTitle: store.titleFromMessage(
        (sessionId && store.getAdminChat(sessionId)?.title) || message,
      ),
    },
    onSession: (sid) => store.updateAdminTurnProgress(turnId, { sessionId: sid }),
    onProgress: (j) => store.updateAdminTurnProgress(turnId, { assistantText: j.conversation, sessionId: j.sessionId }),
    onDone: async (j) => {
      // The job manager captures the --resume=<id> session id from the stream.
      const sid = j.sessionId;
      if (sid) {
        store.appendAdminTurn(sid, {
          userText: message,
          assistantText: j.conversation,
          mode,
          repo: repoName || null,
          images: imageRefs,
          model,
        });
      }
      // Turn completed normally — the buffered copy is no longer needed.
      store.finishAdminTurn(turnId);
      return {
        action: 'admin',
        turnId,
        status: j.cancelled ? 'aborted' : j.exitCode === 0 ? 'success' : 'failed',
        sessionId: sid,
        model,
      };
    },
  });

  jobs.subscribe(job, res);
});

// Re-subscribe to an in-flight (or recently finished, within the job manager's
// retention window) admin turn — replays the full transcript so far, then
// streams live to completion. Powers reconnect after a dropped connection.
app.get('/api/admin/chat/:turnId/stream', (req, res) => {
  const turnId = req.params.turnId;
  writeSseHead(res);
  if (!ADMIN_TURN_RE.test(turnId)) {
    return sendSseBlocked(res, { action: 'admin', turnId, status: 'failed', message: 'invalid turnId' });
  }
  const job = jobs.getJob(`admin:${turnId}`);
  if (!job) {
    // Job already reaped (or never existed) — tell the client it's gone so it
    // can fall back to loading the persisted transcript from history.
    res.write(`event: result\n`);
    res.write(`data: ${JSON.stringify({ action: 'admin', turnId, status: 'gone' })}\n\n`);
    res.write(`event: done\n`);
    res.write(`data: ${JSON.stringify({ exitCode: null, gone: true })}\n\n`);
    return res.end();
  }
  jobs.subscribe(job, res);
});

// Abort a running admin turn (SIGTERM the whole process group).
app.post('/api/admin/chat/:turnId/cancel', (req, res) => {
  const cancelled = jobs.cancelJob(`admin:${req.params.turnId}`);
  res.json({ cancelled });
});

// List past admin terminal conversations (title, timestamps, message count),
// newest first — powers the history menu in the Admin Terminal page.
app.get('/api/admin/chats', (req, res) => {
  res.json({ chats: store.listAdminChats() });
});

// Full transcript for one past admin conversation, so the UI can replay it
// and resume the session (via --resume=<id>) on the next message.
app.get('/api/admin/chats/:sessionId', (req, res) => {
  const chat = store.getAdminChat(req.params.sessionId);
  if (!chat) return res.status(404).json({ error: 'conversation not found' });
  res.json(chat);
});

app.delete('/api/admin/chats/:sessionId', (req, res) => {
  const existed = store.deleteAdminChat(req.params.sessionId);
  if (!existed) return res.status(404).json({ error: 'conversation not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Hourly background sync — keeps the L2 cache warm so the dashboard is never
// showing data older than an hour, even if nobody opened the page.
// ---------------------------------------------------------------------------

const BG_SYNC_INTERVAL_MS = Number(process.env.GH_SYNC_INTERVAL_MS || 60 * 60 * 1000);
// Delay the first pass so a restart doesn't fire N `gh` calls while the user is
// still loading the page they just restarted for.
const BG_SYNC_FIRST_DELAY_MS = Number(process.env.GH_SYNC_FIRST_DELAY_MS || 60 * 1000);

let nextBackgroundSync = Date.now() + BG_SYNC_FIRST_DELAY_MS;
function nextBackgroundSyncAt() {
  return nextBackgroundSync;
}

// Repos are synced one at a time, not in parallel: four concurrent `gh`
// processes on a laptop is a lot of noise for a background job nobody is
// waiting on. A repo with a running job is skipped and picked up next hour.
async function runBackgroundSync() {
  let repos;
  try {
    repos = gh.listRepos(REPOS_ROOT).filter((r) => r.github);
  } catch (err) {
    console.warn(`[gh-sync] could not enumerate repos: ${err.message}`);
    return;
  }
  let synced = 0;
  let skipped = 0;
  for (const repo of repos) {
    if (findOtherRepoBusyKey(repo.name, null)) {
      skipped += 1;
      continue;
    }
    try {
      await syncRepoFromGitHub(repo, { force: true });
      synced += 1;
    } catch (err) {
      // Leave the previous (stale) cache entry in place — stale data beats no
      // data, and the next pass will try again.
      console.warn(`[gh-sync] ${repo.name}: ${err.message}`);
    }
  }
  console.log(`[gh-sync] refreshed ${synced}/${repos.length} repo(s)${skipped ? `, skipped ${skipped} busy` : ''}`);
}

function scheduleBackgroundSync(delayMs) {
  nextBackgroundSync = Date.now() + delayMs;
  setTimeout(async () => {
    await runBackgroundSync();
    scheduleBackgroundSync(BG_SYNC_INTERVAL_MS);
  }, delayMs).unref();
}

// ---------------------------------------------------------------------------
// Three-minute base-branch sync sweep (issue #58)
//
// Deliberately separate from the hourly GitHub sync above. Asking GitHub every
// three minutes would burn the API budget, and its `mergeable` field is
// computed lazily — it answers UNKNOWN precisely when a PR is new. The clone is
// already on disk, so each sweep is one `git fetch` per repo plus two read-only
// plumbing calls per PR (see lib/prSync.js), which never touch the working
// tree and are therefore safe to run while a Copilot job holds it.
// ---------------------------------------------------------------------------

const PR_SYNC_INTERVAL_MS = Number(process.env.PR_SYNC_INTERVAL_MS || 3 * 60 * 1000);
const PR_SYNC_FIRST_DELAY_MS = Number(process.env.PR_SYNC_FIRST_DELAY_MS || 10 * 1000);

let nextPrSyncSweep = Date.now() + PR_SYNC_FIRST_DELAY_MS;
// Single-flight: a slow fetch must never let two sweeps of the same repo
// overlap, and an on-demand sweep must not race the scheduled one.
const prSyncInFlight = new Set();

function nextPrSyncAt() {
  return nextPrSyncSweep;
}

/**
 * Recompare every open PR of one repo against its base branch and persist the
 * result. Best-effort throughout: a PR git cannot answer for keeps its previous
 * value rather than being downgraded to "unknown".
 */
async function sweepRepoSync(repo) {
  if (!repo || !repo.path || prSyncInFlight.has(repo.name)) return 0;
  prSyncInFlight.add(repo.name);
  try {
    const prs = store.listPrsForSync(repo.name);
    if (!prs.length) return 0;
    // PRs tracked before the base branch was recorded target the repo's
    // default branch — the alternative is leaving them at "?" forever.
    let fallbackBase = null;
    const resolved = prs.map((pr) => {
      if (pr.baseRefName) return pr;
      if (fallbackBase === null) fallbackBase = defaultBranchOf(repo.path) || '';
      return fallbackBase ? { ...pr, baseRefName: fallbackBase } : pr;
    });
    const { synced } = await prSync.computeRepoSync(repo.path, resolved);
    if (!Object.keys(synced).length) return 0;
    return store.setRepoSync(repo.name, synced);
  } catch (err) {
    console.warn(`[pr-sync] ${repo.name}: ${err.message}`);
    return 0;
  } finally {
    prSyncInFlight.delete(repo.name);
  }
}

/** Fire-and-forget sweep, for callers that just changed a branch. */
function sweepRepoSyncSoon(repo) {
  sweepRepoSync(repo).catch(() => {});
}

async function runPrSyncSweep() {
  let repos;
  try {
    repos = gh.listRepos(REPOS_ROOT).filter((r) => r.github);
  } catch {
    return;
  }
  let changed = 0;
  for (const repo of repos) changed += await sweepRepoSync(repo);
  if (changed) console.log(`[pr-sync] ${changed} PR(s) changed sync state`);
}

function schedulePrSyncSweep(delayMs) {
  nextPrSyncSweep = Date.now() + delayMs;
  setTimeout(async () => {
    await runPrSyncSweep();
    schedulePrSyncSweep(PR_SYNC_INTERVAL_MS);
  }, delayMs).unref();
}

// ---------------------------------------------------------------------------
// Surviving our own restart (cloud-scheduler, :8788)
//
// This process is replaced constantly — it deploys itself, and the agents it
// starts edit its code. Every one of those restarts used to strand the work in
// flight: the detached children kept running, but the only record of them was
// an object in the dead process's memory, so the browser showed a task frozen
// at "Deploying…" with an empty log and a Stop button that answered 404.
//
// Now the processes belong to the supervisor on :8788, and the two functions
// below are how this process rejoins them: `adoptedCallbacksFor` supplies the
// persistence a re-attached job still owes, and `reconcileOrphanedRecords`
// settles the rows whose process really is gone, so nothing stays "working"
// forever.
// ---------------------------------------------------------------------------

/** `<repo>#<issue>:<action>[:<pr>]` → its parts, or null for other key shapes. */
function parseJobKey(key) {
  const m = /^(.+)#(\d+):([a-z]+)(?::(\d+))?$/.exec(key || '');
  if (!m) return null;
  return { repo: m[1], issueNumber: Number(m[2]), action: m[3], prNumber: m[4] ? Number(m[4]) : null };
}

// Which sub-record each action writes, and what its "still going" status is
// called. Every one of these has the same {status, conversation, exitCode,
// finishedAt} shape, which is what lets one recovery path serve them all.
const ACTION_SLOTS = {
  work: { busy: 'working', update: (p, patch) => store.updateRecord(p.repo, p.issueNumber, (r) => patch(r.work)) },
  deploy: { busy: 'deploying', update: (p, patch) => store.updateDeploy(p.repo, p.issueNumber, p.prNumber, patch) },
  merge: { busy: 'merging', update: (p, patch) => store.updateMerge(p.repo, p.issueNumber, p.prNumber, patch) },
  update: { busy: 'updating', update: (p, patch) => store.updateBranchUpdate(p.repo, p.issueNumber, p.prNumber, patch) },
  review: { busy: 'reviewing', update: (p, patch) => store.updateReview(p.repo, p.issueNumber, p.prNumber, patch) },
};

/**
 * The persistence an adopted job still owes.
 *
 * Deliberately less than the original `onDone`: the run's lease, its base
 * branch and the PR it was about to create all lived in the closure of a
 * request this process never served. What can still be done honestly is done —
 * the transcript, the exit code, the status, and for Create PR the PR itself,
 * which GitHub can be asked about. Anything richer would be invention.
 */
function adoptedCallbacksFor(session) {
  const parts = parseJobKey(session.key || (session.meta || {}).key || '');
  if (!parts || !ACTION_SLOTS[parts.action]) return {};
  const slot = ACTION_SLOTS[parts.action];
  const flush = (j, final) => {
    slot.update(parts, (s) => {
      s.conversation = j.conversation;
      if (j.sessionId) s.sessionId = j.sessionId;
      if (final) {
        s.status = final;
        s.exitCode = j.exitCode;
        s.finishedAt = new Date().toISOString();
      }
    });
  };
  return {
    onSession: () => {},
    onProgress: (j) => flush(j, null),
    onDone: async (j) => {
      const status = j.cancelled ? 'aborted' : j.exitCode === 0 ? 'success' : 'failed';
      // A Create PR that finished while we were away has a PR on GitHub and
      // nothing pointing at it; without this the issue would look untouched and
      // the scheduler would cheerfully implement it a second time.
      if (parts.action === 'work' && status === 'success') {
        try {
          const repo = resolveRepo(parts.repo);
          const found = repo && (await gh.findPrForIssue(repo.ownerRepo, parts.issueNumber));
          if (found) {
            store.updateRecord(parts.repo, parts.issueNumber, (r) => {
              r.work.prUrl = found.url;
              r.work.prNumber = found.number;
            });
            store.upsertPr(parts.repo, parts.issueNumber, {
              prNumber: found.number,
              prUrl: found.url,
              source: 'work',
              state: 'OPEN',
            });
          }
        } catch {
          /* the hourly sync will find it */
        }
      }
      flush(j, status);
      return { action: parts.action, prNumber: parts.prNumber, status, sessionId: j.sessionId, adopted: true };
    },
  };
}

/**
 * Settle every record still claiming to be busy with a process that is gone.
 *
 * A row stuck at "Deploying…" is worse than a failed one: it hides the action
 * buttons, blocks the repo, and gives the scheduler a reason to skip the issue
 * forever. `liveKeys` is the set the supervisor vouches for; anything else that
 * says it is running has, by definition, stopped.
 */
function reconcileOrphanedRecords(repos, liveKeys) {
  const settled = [];
  const note = '\n[interrupted] The dashboard restarted and this task was no longer running.\n';
  for (const repo of repos) {
    for (const record of store.listRecords(repo.name)) {
      const n = record.issueNumber;
      const check = (action, prNumber, slotValue) => {
        const slot = ACTION_SLOTS[action];
        if (!slot || !slotValue || slotValue.status !== slot.busy) return;
        const key = prNumber ? `${repo.name}#${n}:${action}:${prNumber}` : `${repo.name}#${n}:${action}`;
        if (liveKeys.has(key)) return;
        slot.update({ repo: repo.name, issueNumber: n, prNumber }, (s) => {
          // `aborted`, not `failed`: the run never reached a verdict, it was
          // cut short. The UI renders the two the same way, but "failed" reads
          // as "Copilot tried and could not do it", which is a lie here.
          s.status = 'aborted';
          s.finishedAt = new Date().toISOString();
          if (!s.conversation || !s.conversation.includes('[interrupted]')) {
            s.conversation = (s.conversation || '') + note;
          }
        });
        settled.push(key);
      };
      check('work', null, record.work);
      for (const pr of Object.values(record.prs || {})) {
        check('deploy', pr.prNumber, pr.deploy);
        check('merge', pr.prNumber, pr.merge);
        check('update', pr.prNumber, pr.update);
        check('review', pr.prNumber, pr.review);
      }
    }
  }
  return settled;
}

/**
 * Bring this process back in sync with the work that outlived it.
 *
 * Order matters: start the supervisor if it is not there, adopt what it holds,
 * and only then decide which records are orphaned — reconciling first would
 * mark a perfectly healthy running task as failed.
 *
 * `gh.listRepos` is deliberately called once and passed around: it shells out
 * to git per repo and blocks the event loop for seconds, so calling it in each
 * step made the first request after a restart look like a hung server.
 */
async function rejoinSupervisedWork() {
  const ensured = await supervisorClient.ensureRunning({ root: __dirname });
  if (ensured.started) console.log(`[supervisor] started cloud-scheduler (pid ${ensured.pid})`);
  else if (ensured.reason !== 'already running') {
    console.warn(`[supervisor] ${supervisorClient.BASE} unavailable: ${ensured.reason}`);
  }

  jobs.setAdoptHandler(adoptedCallbacksFor);
  const { adopted, sessions, error } = await jobs.adoptRunning();
  if (error) console.warn(`[supervisor] could not list sessions: ${error}`);
  if (adopted) {
    console.log(
      `[supervisor] re-attached ${adopted} running session(s): ${sessions.map((s) => s.key).join(', ')}`,
    );
  }

  let repos = [];
  try {
    repos = gh.listRepos(REPOS_ROOT);
  } catch (err) {
    console.warn(`[recovery] could not list repos: ${err.message}`);
    return;
  }

  const running = jobs.listRunning();
  const settled = reconcileOrphanedRecords(repos, new Set(running.map((j) => j.key)));
  if (settled.length) {
    console.log(`[recovery] settled ${settled.length} orphaned task(s): ${settled.join(', ')}`);
  }

  // Worktrees this pool created but no longer owns are leftovers from a crash
  // or a restart. Removing them keeps `.worktrees/` from growing without bound;
  // anything holding unpushed work is deliberately kept — and so is anything an
  // adopted session is still writing to, whose lease died with the previous
  // process even though the work did not.
  try {
    const inUse = new Set(running.map((j) => j.worktree).filter(Boolean));
    const orphans = worktreePool.sweepOrphans(repos, { keep: inUse });
    if (orphans.length) {
      console.log(`[worktrees] removed ${orphans.length} orphaned worktree(s) from a previous run`);
    }
  } catch (err) {
    console.warn(`[worktrees] startup sweep failed: ${err.message}`);
  }
}

app.listen(PORT, HOST, () => {
  console.log(`cloud-copilot running at http://${HOST}:${PORT}`);
  console.log(`Authorized repos root: ${REPOS_ROOT}`);
  console.log(`Copilot binary: ${COPILOT_BIN}`);
  const cacheInfo = gh.cache.load();
  console.log(
    cacheInfo.restored
      ? `GitHub cache: restored ${cacheInfo.repos} repo(s) from ${gh.cache.CACHE_FILE}`
      : 'GitHub cache: starting cold',
  );
  scheduleBackgroundSync(BG_SYNC_FIRST_DELAY_MS);
  schedulePrSyncSweep(PR_SYNC_FIRST_DELAY_MS);

  // The supervisor owns every running Copilot process, so rejoining it is the
  // first thing this process does — it re-attaches the live sessions, settles
  // the records whose process really is gone, and only then sweeps worktrees,
  // which must not delete a checkout an adopted session is still using.
  rejoinSupervisedWork().catch((err) => console.warn(`[supervisor] rejoin failed: ${err.message}`));

  // Create PR / Deploy / Merge / Update / Review are settled inside
  // `rejoinSupervisedWork`, deliberately not here: "no job in memory" only
  // means "orphan" once adoption has re-attached the sessions still running.

  // Recover any admin turn that was still in-flight when the previous
  // process died (e.g. a chat turn triggered its own restart mid-reply) so
  // it shows up as an "interrupted" turn instead of silently vanishing.
  const recovered = store.reconcileInterruptedAdminTurns();
  if (recovered.length) {
    console.log(`Recovered ${recovered.length} interrupted admin turn(s): ${recovered.map((r) => r.turnId).join(', ')}`);
  }
});
