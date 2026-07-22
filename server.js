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
const { execSync } = require('child_process');
const express = require('express');

const store = require('./lib/store');
const gh = require('./lib/gh');
const { runCopilotSSE, writeSseHead } = require('./lib/runner');
const jobs = require('./lib/jobs');

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
app.use(express.json());
app.use(express.static('public'));

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

app.get('/api/repos/:name/issues', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found under REPOS_ROOT' });
  if (!repo.github) return res.status(400).json({ error: 'repo has no github.com remote' });

  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const { issues, cached, at } = await gh.listIssues(repo.ownerRepo, { force });
    const numbers = issues.map((i) => i.number);
    const statuses = store.getStatuses(repo.name, numbers);
    const merged = issues.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      updatedAt: i.updatedAt,
      url: i.url,
      labels: (i.labels || []).map((l) => l.name),
      status: statuses[i.number],
    }));
    // Which issues currently have a PR-creation job running (repo-level lock).
    const prefix = `${repo.name}#`;
    const activeWorkIssues = jobs
      .runningKeys()
      .filter((k) => k.startsWith(prefix) && k.endsWith(':work'))
      .map((k) => Number(k.slice(prefix.length, -':work'.length)))
      .filter((n) => Number.isInteger(n));
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
  };
  for (const pr of Object.values(record.prs || {})) {
    record.live.deploy[pr.prNumber] = Boolean(
      jobs.getJob(`${repo.name}#${n}:deploy:${pr.prNumber}`)?.status === 'running',
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
    const prs = await gh.findPrsForIssue(repo.ownerRepo, n);
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

  // Repo-level lock: only one PR-creation may run per repo at a time, otherwise
  // concurrent copilot runs collide on the same working tree.
  const prefix = `${repo.name}#`;
  const otherWork = jobs
    .runningKeys()
    .filter((k) => k.startsWith(prefix) && k.endsWith(':work') && k !== key);
  if (otherWork.length) {
    const busyIssue = otherWork[0].slice(prefix.length, -':work'.length);
    const msg =
      `Blocked: a PR creation is already running for issue #${busyIssue} in ` +
      `${repo.name}. Only one PR creation per repo at a time.`;
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ message: msg })}\n\n`);
    res.write(`event: result\n`);
    res.write(`data: ${JSON.stringify({ action: 'work', status: 'blocked', message: msg })}\n\n`);
    res.write(`event: done\n`);
    res.write(`data: ${JSON.stringify({ exitCode: null })}\n\n`);
    res.end();
    return;
  }

  const mode = ['default', 'granular', 'allow-all'].includes(req.body?.mode)
    ? req.body.mode
    : 'allow-all'; // implementing an issue needs to edit files, run git & gh

  const prompt =
    `Work on GitHub issue #${n} in this repository (${repo.ownerRepo}). ` +
    `Create a new branch, implement the change end-to-end until it is complete, ` +
    `commit, push, and open a pull request that closes #${n}. ` +
    `When finished, print the pull request URL on its own line.`;
  const args = ['-p', prompt, ...approvalFlags(mode)];

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
// Action: Deploy a specific PR (ship to TestFlight via the testflight-deploy skill)
// ---------------------------------------------------------------------------

app.post('/api/repos/:name/issues/:n/deploy/:pr', async (req, res) => {
  const repo = resolveRepo(req.params.name);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  const n = Number(req.params.n);
  const prNumber = Number(req.params.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: 'invalid PR number' });
  }
  const key = `${repo.name}#${n}:deploy:${prNumber}`;

  writeSseHead(res);

  const existing = jobs.getJob(key);
  if (existing && existing.status === 'running') {
    jobs.subscribe(existing, res);
    return;
  }

  // Deploy the PR's branch; the testflight-deploy skill knows the rest.
  const prompt =
    `Check out the branch for PR #${prNumber}, then deploy the current ` +
    `ios-diet-expert app to TestFlight using the testflight-deploy skill. ` +
    `Build and upload via fastlane. When finished, clearly state whether the ` +
    `build succeeded and whether the upload to TestFlight succeeded.`;
  // Deploy must reach files outside the repo (/tmp, ~/Library, keychain) and the
  // network, so grant full path + URL + tool access.
  const args = ['-p', prompt, '--allow-all'];

  store.updateDeploy(repo.name, n, prNumber, (d) => {
    d.status = 'deploying';
    d.startedAt = new Date().toISOString();
    d.finishedAt = null;
    d.conversation = '';
  });

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
      const success =
        /successfully uploaded|finished successfully|uploaded to testflight|build \d+ .*uploaded/i.test(
          j.conversation,
        );
      const status = j.cancelled ? 'aborted' : success ? 'success' : 'failed';
      store.updateDeploy(repo.name, n, prNumber, (d) => {
        d.status = status;
        d.exitCode = j.exitCode;
        d.conversation = j.conversation;
        d.sessionId = j.sessionId || d.sessionId;
        d.finishedAt = new Date().toISOString();
      });
      return {
        action: 'deploy',
        prNumber,
        status,
        sessionId: j.sessionId,
      };
    },
  });

  jobs.subscribe(job, res);
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
  args.push('-p', prompt, ...approvalFlags(mode));

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

app.listen(PORT, HOST, () => {
  console.log(`cloud-copilot running at http://${HOST}:${PORT}`);
  console.log(`Authorized repos root: ${REPOS_ROOT}`);
  console.log(`Copilot binary: ${COPILOT_BIN}`);
});
