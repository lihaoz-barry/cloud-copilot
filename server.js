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
const { execSync, execFileSync, spawn } = require('child_process');
const express = require('express');

const store = require('./lib/store');
const gh = require('./lib/gh');
const repoConfig = require('./lib/repoConfig');
const { runCopilotSSE, writeSseHead } = require('./lib/runner');
const jobs = require('./lib/jobs');
const notifier = require('./lib/notifier');
const changelogLib = require('./lib/changelog');
const { UPLOADS_DIR, saveUploadedImages, cleanupOldUploads } = require('./lib/attachments');
const { cleanupAfterMerge } = require('./lib/mergeCleanup');
const worktrees = require('./lib/worktrees');

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

// Actions that check out a branch on a repo's single shared working tree —
// Create PR, Deploy, Chat (even "plan" mode checks out the PR's branch), and
// Merge (when its automatic Copilot recovery is needed) —
// must be mutually exclusive per repo, or concurrent runs collide on the same
// checkout.
const WORKING_TREE_ACTION_RE = /^(\d+):(work|deploy|chat|merge|restart)(?::(\d+))?$/;

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
  restart: 'a Restart main',
};

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
  res.json({ root: REPOS_ROOT, repos });
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
  // Via git() (which pipes stdout/stderr) rather than stdio:'ignore': on
  // failure execFileSync only carries git's real message ("Your local changes
  // to the following files would be overwritten by checkout: …") on
  // `err.stderr`, and 'ignore' throws that away, leaving callers with a bare
  // "Command failed: git checkout <branch>". See checkoutFailureMessage().
  git(repoPath, ['fetch', 'origin', branch], 30000);
  const released = worktrees.releaseBranchWorktree(repoPath, branch, { fetch: false });
  if (released.status === 'kept') {
    // The worktree carries local work — deploy it where it lives rather than
    // deleting it or failing the job.
    return released.path;
  }
  git(repoPath, ['checkout', branch], 15000);
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
      error: `Blocked: ${describeBusyKey(repo.name, busyKey)}. Only one working-tree action per repo at a time.`,
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
  const builds = store
    .listAllBuilds()
    .map((b) => {
      const repo = resolveRepo(b.repo);
      return { ...b, ownerRepo: repo?.ownerRepo || null, _repo: repo };
    })
    // Only ever show builds shipped through the ios-testflight deploy path —
    // repos configured for a "shell" deploy (e.g. a restart script) aren't
    // TestFlight builds and would otherwise pollute this page.
    .filter((b) => !b._repo || repoConfig.loadDeployConfig(b._repo.path).type === 'ios-testflight')
    .map(({ _repo, ...b }) => b);
  res.json({ builds });
});

/**
 * Pull a repo's issues + PRs (through the L2 cache unless `force`) and fold the
 * discovered PRs into the store. Shared by the issues endpoint and the hourly
 * background refresher so both keep the store in exactly the same shape.
 */
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
        headCommit: head
          ? { sha: head.sha, abbrev: head.abbrev, committedDate: head.committedDate, headline: head.headline, url: head.url }
          : undefined,
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
    activeWorkIssues: busyIssue != null ? [busyIssue] : [],
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
        headCommit: head
          ? { sha: head.sha, abbrev: head.abbrev, committedDate: head.committedDate, headline: head.headline, url: head.url }
          : undefined,
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

  // Repo-level lock: only one working-tree action (Create PR, Deploy, Chat)
  // may run per repo at a time, otherwise concurrent runs collide on the same
  // checkout.
  const busyKey = findOtherRepoBusyKey(repo.name, key);
  if (busyKey) {
    const msg = `Blocked: ${describeBusyKey(repo.name, busyKey)}. Only one working-tree action per repo at a time.`;
    return sendSseBlocked(res, { action: 'work', status: 'blocked', message: msg });
  }

  const mode = ['default', 'granular', 'allow-all'].includes(req.body?.mode)
    ? req.body.mode
    : 'allow-all'; // implementing an issue needs to edit files, run git & gh

  const prompt =
    `Work on GitHub issue #${n} in this repository (${repo.ownerRepo}). ` +
    `Create a new branch, implement the change end-to-end until it is complete, ` +
    `commit, push, and open a pull request that closes #${n}. ` +
    `When finished, print the pull request URL on its own line.`;
  const args = ['-p', prompt, ...approvalFlags(mode), ...modelFlags()];

  store.updateRecord(repo.name, n, (r) => {
    r.work.status = 'working';
    r.work.startedAt = new Date().toISOString();
    r.work.conversation = '';
    r.work.prUrl = null;
    r.work.prNumber = null;
  });

  const job = jobs.startJob(key, {
    bin: COPILOT_BIN,
    args,
    cwd: repo.path,
    meta: {
      action: 'work',
      repo: repo.name,
      issueNumber: n,
      subject: cachedIssueTitle(repo, n) || `issue #${n}`,
      sequence: nextCreatePrSequence(repo.name),
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
      // in the stored transcript too. The agent may have implemented the issue
      // inside a linked worktree it created (and even left locked); once the
      // branch is pushed that directory only stands between Deploy and its
      // branch. Removing it here — while this job still holds the repo lock —
      // means Deploy never has to fight for the checkout. Anything holding
      // uncommitted or unpushed work is left alone.
      let headBranch = null;
      if (prNumber) {
        try {
          const prInfo = await gh.getPr(repo.ownerRepo, prNumber);
          headBranch = (prInfo && prInfo.headRefName) || null;
        } catch {
          /* branch stays null — the sweep below still covers it */
        }
      }
      const cleanup = worktrees.cleanupAfterRun(repo.path, headBranch, { skipPaths: [j.cwd] });
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
        });
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
  });

  jobs.subscribe(job, res);
});

// Abort a running PR creation for an issue.
app.post('/api/repos/:name/issues/:n/work/cancel', (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const cancelled = jobs.cancelJob(`${repo.name}#${n}:work`);
  res.json({ cancelled });
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

// ---------------------------------------------------------------------------
// Deploy preflight: salvage a dirty working tree.
//
// Every action shares ONE clone per repo, so `git checkout <pr-branch>` aborts
// with "Your local changes would be overwritten by checkout" whenever anything
// is uncommitted — which used to fail the deploy outright. Instead, run a
// Copilot session (the `salvage-local-changes` skill) as phase 1 of the deploy
// job: it summarizes the changes, opens an issue, puts them on a branch cut
// from the latest default branch as a PR (resolving conflicts), and leaves the
// tree clean. Phase 2 then checks out the target branch and deploys as usual.
//
// Deliberately NOT an auto-stash: stashes are invisible in the UI and get
// forgotten. An issue + PR is the durable, reviewable form of the same rescue.
// ---------------------------------------------------------------------------

// A one-line-per-file digest of the dirty tree, for the prompt and the log.
function dirtySummary(repoPath) {
  try {
    return git(repoPath, ['status', '--porcelain']);
  } catch {
    return '';
  }
}

// Phase-1 spec when the tree is dirty, or null when it is already clean.
function salvagePhaseSpec(repo, prNumber) {
  if (!isDirty(repo.path)) return null;
  const base = defaultBranchOf(repo.path);
  const prompt =
    `This repository (${repo.ownerRepo}) has uncommitted local changes that are blocking ` +
    `checkout of the branch for PR #${prNumber}, which is about to be deployed. ` +
    `Use the salvage-local-changes skill to rescue that work: summarize the working-tree ` +
    `changes, open a GitHub issue describing them, cut a branch from the latest ` +
    `origin/${base}, carry the changes over (resolving any conflicts — never discard a ` +
    `stashed hunk), commit, push, and open a pull request that closes the issue. ` +
    `Do NOT merge that pull request, and do NOT touch the branch for PR #${prNumber}. ` +
    `The changes must not be lost: never run git reset --hard, git checkout -- ., or git clean. ` +
    `Leave the working tree completely clean — \`git status --porcelain\` must print nothing when ` +
    `you finish, because the deploy checks out another branch immediately afterwards. ` +
    `Print the issue URL and the pull request URL each on its own line.`;
  return {
    bin: COPILOT_BIN,
    args: ['-p', prompt, '--allow-all', ...modelFlags()],
    cwd: repo.path,
    phase: 'salvage',
  };
}

// Whether the salvaged commit actually exists on the remote. A clean tree only
// proves the changes left the working tree — they could be sitting in a local
// commit that never got pushed (gh/network failure mid-salvage), which the
// deploy's checkout would then bury on an unreferenced branch. `HEAD` is
// reachable from some origin/* ref exactly when the work is durable.
function headIsPushed(repoPath) {
  try {
    const remotes = git(repoPath, ['branch', '-r', '--contains', 'HEAD'], 15000);
    return remotes.length > 0;
  } catch {
    return false;
  }
}

// The PR the salvage session says it opened: its URL printed in the transcript
// (step 13 of the skill), ignoring the deploy's own PR. Returns a number or null.
function salvagePrNumberFromTranscript(conversation, ownerRepo, deployPrNumber) {
  const escaped = String(ownerRepo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`github\\.com/${escaped}/pull/(\\d+)`, 'gi');
  for (const m of String(conversation || '').matchAll(re)) {
    const num = Number(m[1]);
    if (num && num !== deployPrNumber) return num;
  }
  return null;
}

// Confirms the salvage really produced a reviewable pull request on GitHub.
// Trusting the transcript alone is not enough: an agent can print a URL it
// never created, and `gh` failures leave a clean tree with nothing durable
// behind. Returns the verified PR, or throws.
async function verifySalvagePr(repo, job, deployPrNumber) {
  const claimed = salvagePrNumberFromTranscript(job.conversation, repo.ownerRepo, deployPrNumber);
  if (claimed) {
    const pr = await gh.getPr(repo.ownerRepo, claimed);
    if (pr && pr.number) return pr;
  }
  // No URL printed (or it doesn't resolve) — fall back to asking GitHub for a
  // PR on the branch the salvage session left checked out.
  const branch = gh.gitBranch(repo.path);
  const onHead = branch ? await gh.listPrsForHead(repo.ownerRepo, branch) : [];
  if (onHead.length) return onHead[0];
  throw new Error(
    `Salvage preflight finished with a clean tree but no pull request could be verified` +
      (claimed ? ` (PR #${claimed} was reported but ${repo.ownerRepo} does not have it)` : '') +
      `. Deploy aborted: the local changes may only exist as a local commit on ` +
      `"${branch || 'the current branch'}". Check that branch before deploying again.`,
  );
}

// Guards the transition from the salvage phase into the deploy phase. Throws
// (which jobs.js surfaces on the stream and turns into a failed deploy) rather
// than deploying from a tree whose local work was not safely captured.
async function assertSalvaged(exitCode, repo, job, deployPrNumber) {
  if (exitCode !== 0) {
    throw new Error(
      `Salvage preflight exited ${exitCode} — the local changes were NOT committed. ` +
        `Deploy aborted so nothing is lost; the working tree is untouched.`,
    );
  }
  if (isDirty(repo.path)) {
    throw new Error(
      `Salvage preflight finished but the working tree is still dirty:\n${dirtySummary(repo.path)}\n` +
        `Deploy aborted rather than checking out over uncommitted work.`,
    );
  }
  if (!headIsPushed(repo.path)) {
    throw new Error(
      `Salvage preflight left commits that exist only locally on ` +
        `"${gh.gitBranch(repo.path) || 'HEAD'}" — nothing was pushed to origin. ` +
        `Deploy aborted: checking out another branch now would hide that work.`,
    );
  }
  const pr = await verifySalvagePr(repo, job, deployPrNumber);
  jobs.note(job, `\n[preflight] local changes salvaged into ${pr.url || `PR #${pr.number}`}\n`);
}

// Opening lines of a salvaged deploy's log, so the user sees WHY an extra
// Copilot session is running before that session prints anything of its own.
function salvageBanner(repo, prNumber) {
  return (
    `\n[preflight] ${repo.name} has uncommitted local changes, which would block ` +
    `checking out the branch for PR #${prNumber}:\n${dirtySummary(repo.path)}\n` +
    `[preflight] salvaging them into an issue + PR (salvage-local-changes skill) before deploying…\n\n`
  );
}

// git's own stderr is the useful part ("Your local changes to the following
// files would be overwritten by checkout"), and execFileSync buries it on the
// error object. Surface it instead of a bare "Command failed: git checkout".
function checkoutFailureMessage(branch, err) {
  const detail = (err.stderr || err.stdout || err.message || '').toString().trim();
  return `Failed to check out branch "${branch}":\n${detail}`;
}

// Terminal state for a deploy that never got past its preflight. The salvage
// phase's exit code says nothing about the deploy, so mark it failed (or
// aborted) explicitly rather than letting the usual success heuristics run.
function failedPreflight(repo, n, prNumber, j) {
  const status = j.cancelled ? 'aborted' : 'failed';
  store.updateDeploy(repo.name, n, prNumber, (d) => {
    d.status = status;
    d.exitCode = j.exitCode;
    d.conversation = j.conversation;
    d.sessionId = j.sessionId || d.sessionId;
    d.finishedAt = new Date().toISOString();
  });
  return { action: 'deploy', prNumber, status, sessionId: j.sessionId };
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
    // Assigned by prepareDeployPhase(), which runs either immediately (clean
    // tree) or after the salvage phase — and is read back in onDone.
    let buildNumber, version, changelog, workCwd;

    // Checks out the PR branch — releasing a linked worktree that still holds
    // it when that can be done without losing work, otherwise deploying from
    // inside that worktree — and builds the deploy phase spec. Throws with
    // git's own stderr on failure.
    const prepareDeployPhase = async () => {
      // Argument-array form — branch names come from GitHub and are never
      // interpreted by a shell. git's own stderr is preserved on failure; the
      // rest of this function fails with its own (already specific) message.
      try {
        workCwd = checkoutBranchCwd(repo.path, pr.headRefName);
      } catch (err) {
        throw new Error(checkoutFailureMessage(pr.headRefName, err));
      }
      buildNumber = Number(git(workCwd, ['rev-list', '--count', 'HEAD'], 15000));
      version = repoConfig.readMarketingVersion(workCwd); // null if not found — fastlane then uses its own default

      const versionArg = version ? ` version:${version}` : '';
      // "What to Test" text testers see in TestFlight — one short Chinese
      // sentence derived from the PR title, so builds are self-describing
      // instead of shipping the raw (often English, prefixed, issue-tagged)
      // title. Best-effort translation with a deterministic fallback; see
      // lib/changelog.js. Awaited before the deploy phase starts so the pinned
      // text is in the prompt.
      changelog = await changelogLib.resolveChangelog({
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
      return {
        bin: COPILOT_BIN,
        args: ['-p', prompt, '--allow-all', ...modelFlags()],
        cwd: workCwd,
        phase: 'deploy',
      };
    };

    // Dirty tree? Salvage it first (phase 1), then deploy (phase 2). Clean tree?
    // Check out and deploy right away, exactly as before.
    const salvage = salvagePhaseSpec(repo, prNumber);
    let reachedDeploy = false;
    let firstPhase;
    if (!salvage) {
      try {
        firstPhase = await prepareDeployPhase();
        reachedDeploy = true;
      } catch (err) {
        const message = err.message;
        store.updateDeploy(repo.name, n, prNumber, (d) => {
          d.status = 'failed';
          d.finishedAt = new Date().toISOString();
          d.conversation = message;
        });
        return sendSseBlocked(res, { action: 'deploy', prNumber, status: 'failed', message });
      }
    }

    const job = jobs.startJob(key, {
      ...(salvage || firstPhase),
      meta: {
        action: 'deploy',
        prNumber,
        repo: repo.name,
        issueNumber: n,
        subject: pr.title || `PR #${prNumber}`,
        phase: salvage ? 'salvage' : 'deploy',
      },
      nextPhase: salvage
        ? async (j, code) => {
            await assertSalvaged(code, repo, j, prNumber);
            jobs.note(j, `\n[preflight] working tree clean — checking out ${pr.headRefName} and deploying…\n`);
            const spec = await prepareDeployPhase();
            reachedDeploy = true;
            return spec;
          }
        : undefined,
      onSession: (id) =>
        store.updateDeploy(repo.name, n, prNumber, (d) => {
          d.sessionId = id;
        }),
      onDone: async (j) => {
        // Never reached the deploy phase — the salvage preflight failed, or the
        // checkout after it did. Report that, not a bogus deploy verdict.
        if (!reachedDeploy) return failedPreflight(repo, n, prNumber, j);
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

    if (salvage) jobs.note(job, salvageBanner(repo, prNumber));
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

    // Argument-array form (never a shell string) so the branch name — which
    // comes from GitHub and could in principle contain shell metacharacters —
    // is never interpreted by a shell. Releases a linked worktree still holding
    // the branch when that loses no work, otherwise deploys from inside it.
    // Throws with git's stderr on failure; sets the directory to deploy from.
    let workCwd;
    const checkout = () => {
      try {
        workCwd = checkoutBranchCwd(repo.path, pr.headRefName);
      } catch (err) {
        throw new Error(checkoutFailureMessage(pr.headRefName, err));
      }
    };

    // The deploy command itself is trusted repo-local config (from
    // `.cloud-copilot.json`, authored by whoever owns the repo under
    // REPOS_ROOT) — not attacker-controlled input, so a shell string is fine
    // here (same trust boundary as REPOS_ROOT itself).
    const deployPhaseSpec = () => ({ bin: 'bash', args: ['-lc', command], cwd: workCwd, phase: 'deploy' });

    // Dirty tree? Salvage it into an issue + PR first (phase 1), then check out
    // and deploy (phase 2). Clean tree? Check out and deploy immediately.
    const salvage = salvagePhaseSpec(repo, prNumber);
    let reachedDeploy = false;
    let firstPhase;
    if (!salvage) {
      try {
        checkout();
        firstPhase = deployPhaseSpec();
        reachedDeploy = true;
      } catch (err) {
        const message = err.message;
        store.updateDeploy(repo.name, n, prNumber, (d) => {
          d.status = 'failed';
          d.finishedAt = new Date().toISOString();
          d.conversation = message;
        });
        return sendSseBlocked(res, { action: 'deploy', prNumber, status: 'failed', message });
      }
    }

    const job = jobs.startJob(key, {
      ...(salvage || firstPhase),
      meta: {
        action: 'deploy',
        prNumber,
        repo: repo.name,
        issueNumber: n,
        subject: pr.title || `PR #${prNumber}`,
        phase: salvage ? 'salvage' : 'deploy',
      },
      nextPhase: salvage
        ? async (j, code) => {
            await assertSalvaged(code, repo, j, prNumber);
            jobs.note(j, `\n[preflight] working tree clean — checking out ${pr.headRefName} and deploying…\n`);
            checkout();
            reachedDeploy = true;
            return deployPhaseSpec();
          }
        : undefined,
      onDone: async (j) => {
        if (!reachedDeploy) return failedPreflight(repo, n, prNumber, j);
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

    if (salvage) jobs.note(job, salvageBanner(repo, prNumber));
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
    const msg = `Blocked: ${describeBusyKey(repo.name, busyKey)}. Only one working-tree action per repo at a time.`;
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
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: 'invalid PR number' });
  }
  const cancelled = jobs.cancelJob(`${repo.name}#${n}:deploy:${prNumber}`);
  res.json({ cancelled });
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
    const message = `Blocked: ${describeBusyKey(repo.name, busyKey)}. Only one working-tree action per repo at a time.`;
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
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: 'invalid PR number' });
  }
  const cancelled = jobs.cancelJob(`${repo.name}#${n}:merge:${prNumber}`);
  res.json({ cancelled });
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

  // Repo-level lock: even a "plan" turn checks out the PR's branch on the
  // same shared working tree as Create PR/Deploy, so it must be mutually
  // exclusive with them too.
  const busyKey = findOtherRepoBusyKey(repo.name, key);
  if (busyKey) {
    const msg = `Blocked: ${describeBusyKey(repo.name, busyKey)}. Only one working-tree action per repo at a time.`;
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
  let workCwd;
  try {
    workCwd = checkoutBranchCwd(repo.path, prInfo.headRefName);
  } catch (err) {
    const message2 = `Failed to check out branch "${prInfo.headRefName}": ${err.message}`;
    return sendSseBlocked(res, { action: 'chat', prNumber, mode, status: 'failed', message: message2 });
  }

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
      `(do not open a new PR, do not force-push). Confirm what you committed and pushed.`;
    args.push('-p', prompt, '--allow-all', ...modelFlags(model));
  }

  const job = jobs.startJob(key, {
    bin: COPILOT_BIN,
    args,
    cwd: workCwd,
    meta: {
      action: 'chat',
      prNumber,
      mode,
      model,
      repo: repo.name,
      issueNumber: n,
      chatTitle: store.titleFromMessage(message),
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
      store.appendChatMessage(repo.name, n, prNumber, { role: 'assistant', text: j.conversation, mode, model });
      // New commits landed — the old Deploy/Merge no longer reflect this code.
      if (mode === 'apply' && status === 'success') {
        store.resetForNewCommits(repo.name, n, prNumber);
      }
      return { action: 'chat', prNumber, mode, status, sessionId: j.sessionId, model };
    },
  });

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
  // Recover any admin turn that was still in-flight when the previous
  // process died (e.g. a chat turn triggered its own restart mid-reply) so
  // it shows up as an "interrupted" turn instead of silently vanishing.
  const recovered = store.reconcileInterruptedAdminTurns();
  if (recovered.length) {
    console.log(`Recovered ${recovered.length} interrupted admin turn(s): ${recovered.map((r) => r.turnId).join(', ')}`);
  }
});
