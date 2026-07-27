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
const { UPLOADS_DIR, saveUploadedImages, cleanupOldUploads } = require('./lib/attachments');

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
// Create PR, Deploy, and Chat (even "plan" mode checks out the PR's branch) —
// must be mutually exclusive per repo, or concurrent runs collide on the same
// checkout. Merge is excluded: it only calls `gh pr merge` via the API, no
// local checkout involved.
const WORKING_TREE_ACTION_RE = /^(\d+):(work|deploy|chat|restart)(?::(\d+))?$/;

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

// The AI model to use for every Copilot CLI invocation, configurable from the
// homepage dropdown (persisted via store.setModel) and defaulting to
// store.DEFAULT_MODEL otherwise.
function modelFlags() {
  return ['--model', store.getModel()];
}

// ---------------------------------------------------------------------------
// Repo + issue listing
// ---------------------------------------------------------------------------

app.get('/api/repos', (req, res) => {
  const repos = gh.listRepos(REPOS_ROOT).map((r) => ({
    name: r.name,
    branch: r.branch,
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
// "Self" repo — the cloud-copilot checkout that is serving this very app.
//
// The settings panel surfaces its current branch and a "Restart main" button,
// used to periodically verify that whatever is on `main` still works. Only the
// self repo gets that button; restarting is meaningless for any other repo.
// ---------------------------------------------------------------------------

const SERVER_STARTED_AT = new Date().toISOString();
const SELF_DIR = (() => {
  try {
    return fs.realpathSync(__dirname);
  } catch {
    return __dirname;
  }
})();

// The repo under REPOS_ROOT whose working tree IS this app's directory, or
// null when cloud-copilot is running from outside the authorized root.
function findSelfRepo() {
  return (
    gh.listRepos(REPOS_ROOT).find((r) => {
      try {
        return fs.realpathSync(r.path) === SELF_DIR;
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

app.get('/api/repos/:name/issues', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found under REPOS_ROOT' });
  if (!repo.github) return res.status(400).json({ error: 'repo has no github.com remote' });

  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const { issues, cached, at } = await gh.listIssues(repo.ownerRepo, { force });
    const dismissed = store.getDismissedNumbers(repo.name);
    const visible = issues.filter((i) => !dismissed.has(i.number));

    // Auto-discover PRs referencing any of these issues — one `gh pr list`
    // call for the whole repo, matched in-process — so the pipeline is
    // populated on every expand without needing the manual "↻ PRs" click.
    const { prs: allPrs } = await gh.listAllPrs(repo.ownerRepo, { force });
    for (const issue of visible) {
      const matched = gh.matchPrsForIssue(allPrs, issue.number);
      for (const p of matched) {
        store.upsertPr(repo.name, issue.number, {
          prNumber: p.number,
          prUrl: p.url,
          title: p.title,
          createdAt: p.createdAt,
          source: 'gh',
        });
      }
      // Drop previously auto-discovered PRs that no longer match (e.g. the
      // match heuristic got stricter, or a PR body was edited) — never
      // touches PRs cloud-copilot itself created for this issue.
      store.pruneStaleGhPrs(repo.name, issue.number, matched.map((p) => p.number));
    }

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
    res.json({ repo: repo.name, ownerRepo: repo.ownerRepo, cached, at, issues: merged, activeWorkIssues });
  } catch (err) {
    res.status(500).json({ error: err.message, stderr: (err.stderr || '').toString() });
  }
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
    for (const p of prs) {
      store.upsertPr(repo.name, n, {
        prNumber: p.number,
        prUrl: p.url,
        title: p.title,
        createdAt: p.createdAt,
        source: 'gh',
      });
    }
    const record = store.getRecord(repo.name, n);
    res.json({ prs: store.prsArray(record) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss/hide an issue from the dashboard. Cancels any in-flight jobs tied to
// it (work + every PR's deploy), then clears its tracked state and remembers
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
  }

  store.dismissIssue(repo.name, n);
  res.json({ ok: true, cancelledJobs });
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

  writeSseHead(res);
  store.appendPreIssueChatMessage(repo.name, id, { role: 'user', text: message });

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
  args.push('-p', prompt, ...approvalFlags('default'), ...modelFlags());

  const job = jobs.startJob(key, {
    bin: COPILOT_BIN,
    args,
    cwd: repo.path,
    meta: { action: 'preissue-chat', id },
    onSession: (sid) => store.setPreIssueSession(repo.name, id, sid),
    onDone: async (j) => {
      const status = j.cancelled ? 'aborted' : j.exitCode === 0 ? 'success' : 'failed';
      store.appendPreIssueChatMessage(repo.name, id, { role: 'assistant', text: j.conversation });
      const draft = extractDraft(j.conversation);
      if (draft) store.setPreIssueDraft(repo.name, id, draft);
      return { action: 'preissue-chat', id, status, sessionId: j.sessionId, draft };
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
    meta: { action: 'work' },
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

      store.updateRecord(repo.name, n, (r) => {
        r.work.status = status;
        r.work.exitCode = j.exitCode;
        r.work.conversation = j.conversation;
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
        });
      }

      return {
        action: 'work',
        status,
        prUrl,
        prNumber,
        sessionId: j.sessionId,
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

// Builds the "What to Test" text TestFlight testers see, from the PR title
// (falling back to a generic version/build string). Strips characters that
// could break out of the single-quoted shell argument the agent is told to
// pass to `fastlane beta` — the PR title comes from GitHub and is never
// trusted as shell-safe.
function buildChangelog(pr, issueNumber, version, buildNumber) {
  const raw = (pr && pr.title) || '';
  const cleaned = raw.replace(/['"`$\\]/g, '').replace(/\s+/g, ' ').trim();
  const suffix = issueNumber ? ` (closes #${issueNumber})` : '';
  const text = cleaned ? `${cleaned}${suffix}` : `v${version || '1.0'} (build ${buildNumber})`;
  return text.slice(0, 500); // TestFlight "What to Test" is short; keep it well under Apple's limit
}

function runIosTestflightDeploy({ res, repo, n, prNumber, key }) {
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

    // Build number / version are computed HERE, deterministically, from the
    // exact commit being shipped — never inferred afterward from the agent's
    // free-form report. build = commit count (same source `fastlane beta`
    // itself defaults to); version = the Xcode project's own MARKETING_VERSION.
    let buildNumber, version;
    try {
      // Argument-array form — branch names come from GitHub and are never
      // interpreted by a shell.
      execFileSync('git', ['fetch', 'origin', pr.headRefName], { cwd: repo.path, stdio: 'ignore', timeout: 30000 });
      execFileSync('git', ['checkout', pr.headRefName], { cwd: repo.path, stdio: 'ignore', timeout: 15000 });
      buildNumber = Number(
        execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo.path, encoding: 'utf8', timeout: 15000 }).trim(),
      );
      version = repoConfig.readMarketingVersion(repo.path); // null if not found — fastlane then uses its own default
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
    // "What to Test" text testers see in TestFlight — derived from the PR
    // title so builds are self-describing instead of shipping with no notes.
    const changelog = buildChangelog(pr, n, version, buildNumber);
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
      cwd: repo.path,
      meta: { action: 'deploy', prNumber },
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

    // Argument-array form (never a shell string) so the branch name — which
    // comes from GitHub and could in principle contain shell metacharacters —
    // is never interpreted by a shell.
    try {
      execFileSync('git', ['fetch', 'origin', pr.headRefName], {
        cwd: repo.path,
        stdio: 'ignore',
        timeout: 30000,
      });
      execFileSync('git', ['checkout', pr.headRefName], { cwd: repo.path, stdio: 'ignore', timeout: 15000 });
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
      cwd: repo.path,
      meta: { action: 'deploy', prNumber },
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
// Action: Merge a specific PR (gh pr merge --merge --delete-branch)
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

  store.updateMerge(repo.name, n, prNumber, (m) => {
    m.status = 'merging';
    m.forced = force;
    m.startedAt = new Date().toISOString();
    m.finishedAt = null;
    m.conversation = '';
  });

  const baseRefName = await gh.getPr(repo.ownerRepo, prNumber).then((pr) => pr?.baseRefName || null);

  const job = jobs.startJob(key, {
    bin: gh.GH_BIN,
    args: ['pr', 'merge', String(prNumber), '--repo', repo.ownerRepo, '--merge', '--delete-branch'],
    cwd: repo.path,
    meta: { action: 'merge', prNumber },
    onDone: async (j) => {
      const success = j.exitCode === 0;
      const status = j.cancelled ? 'aborted' : success ? 'success' : 'failed';
      store.updateMerge(repo.name, n, prNumber, (m) => {
        m.status = status;
        m.exitCode = j.exitCode;
        m.conversation = j.conversation;
        m.finishedAt = new Date().toISOString();
      });
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
      return { action: 'merge', prNumber, status };
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
  try {
    execFileSync('git', ['fetch', 'origin', prInfo.headRefName], { cwd: repo.path, stdio: 'ignore', timeout: 30000 });
    execFileSync('git', ['checkout', prInfo.headRefName], { cwd: repo.path, stdio: 'ignore', timeout: 15000 });
  } catch (err) {
    const message2 = `Failed to check out branch "${prInfo.headRefName}": ${err.message}`;
    return sendSseBlocked(res, { action: 'chat', prNumber, mode, status: 'failed', message: message2 });
  }

  // Attached screenshots/mockups (if any) — saved to disk so they can be
  // passed to the CLI via --attachment and redisplayed from history later.
  const savedImages = saveUploadedImages(req.body?.images);
  const imageRefs = savedImages.map((img) => ({ url: img.url, name: img.name }));

  store.appendChatMessage(repo.name, n, prNumber, { role: 'user', text: message, mode, images: imageRefs });

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
    args.push('-p', prompt, ...approvalFlags('default'), ...modelFlags());
  } else {
    // Implement the plan from the resumed conversation, on the SAME branch.
    const prompt =
      `Implement the plan from our conversation for this request: ${message}\n\n` +
      `Commit and push the changes to the EXISTING branch for PR #${prNumber} ` +
      `(do not open a new PR, do not force-push). Confirm what you committed and pushed.`;
    args.push('-p', prompt, '--allow-all', ...modelFlags());
  }

  const job = jobs.startJob(key, {
    bin: COPILOT_BIN,
    args,
    cwd: repo.path,
    meta: { action: 'chat', prNumber, mode },
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
      store.appendChatMessage(repo.name, n, prNumber, { role: 'assistant', text: j.conversation, mode });
      // New commits landed — the old Deploy/Merge no longer reflect this code.
      if (mode === 'apply' && status === 'success') {
        store.resetForNewCommits(repo.name, n, prNumber);
      }
      return { action: 'chat', prNumber, mode, status, sessionId: j.sessionId };
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
  args.push('-p', message, ...approvalFlags(mode), ...modelFlags());

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
  });

  const job = jobs.startJob(key, {
    bin: COPILOT_BIN,
    args,
    cwd,
    meta: { action: 'admin', turnId, repo: repoName || null },
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
        });
      }
      // Turn completed normally — the buffered copy is no longer needed.
      store.finishAdminTurn(turnId);
      return {
        action: 'admin',
        turnId,
        status: j.cancelled ? 'aborted' : j.exitCode === 0 ? 'success' : 'failed',
        sessionId: sid,
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

app.listen(PORT, HOST, () => {
  console.log(`cloud-copilot running at http://${HOST}:${PORT}`);
  console.log(`Authorized repos root: ${REPOS_ROOT}`);
  console.log(`Copilot binary: ${COPILOT_BIN}`);
  // Recover any admin turn that was still in-flight when the previous
  // process died (e.g. a chat turn triggered its own restart mid-reply) so
  // it shows up as an "interrupted" turn instead of silently vanishing.
  const recovered = store.reconcileInterruptedAdminTurns();
  if (recovered.length) {
    console.log(`Recovered ${recovered.length} interrupted admin turn(s): ${recovered.map((r) => r.turnId).join(', ')}`);
  }
});
