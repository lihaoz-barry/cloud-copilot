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
const { execSync, execFileSync } = require('child_process');
const express = require('express');

const store = require('./lib/store');
const gh = require('./lib/gh');
const repoConfig = require('./lib/repoConfig');
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

// Actions that check out a branch on a repo's single shared working tree —
// Create PR, Deploy, and Chat (even "plan" mode checks out the PR's branch) —
// must be mutually exclusive per repo, or concurrent runs collide on the same
// checkout. Merge is excluded: it only calls `gh pr merge` via the API, no
// local checkout involved.
const WORKING_TREE_ACTION_RE = /^(\d+):(work|deploy|chat)(?::(\d+))?$/;

// First OTHER running job (excluding `excludeKey`) that touches this repo's
// shared working tree, or null. Used to block a second such action from
// starting concurrently.
function findOtherRepoBusyKey(repoName, excludeKey) {
  const prefix = `${repoName}#`;
  for (const k of jobs.runningKeys()) {
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

const BUSY_ACTION_LABEL = { work: 'a Create PR run', deploy: 'a Deploy', chat: 'a chat turn' };

// Human-readable description of what's holding a repo's working-tree lock,
// for the "blocked" message shown when a second action tries to start.
function describeBusyKey(repoName, busyKey) {
  const m = busyKey.slice(repoName.length + 1).match(WORKING_TREE_ACTION_RE);
  if (!m) return `something else is already running in ${repoName}`;
  const [, issueNum, action, prNum] = m;
  const label = BUSY_ACTION_LABEL[action] || action;
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

    // Auto-discover PRs referencing any of these issues — one `gh pr list`
    // call for the whole repo, matched in-process — so the pipeline is
    // populated on every expand without needing the manual "↻ PRs" click.
    const { prs: allPrs } = await gh.listAllPrs(repo.ownerRepo, { force });
    for (const issue of issues) {
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
    const prompt =
      `The branch for PR #${prNumber} is already checked out. Deploy the current ` +
      `${repo.name} app to TestFlight using the testflight-deploy skill, running ` +
      `\`fastlane beta build:${buildNumber}${versionArg}\` (do not change the build/version ` +
      `numbers — they're already pinned). When finished, clearly state whether the ` +
      `build succeeded and whether the upload to TestFlight succeeded. Note: Xcode's ` +
      `export step can silently reassign the build number, so grep the fastlane log for ` +
      `its own "finished processing the build" line and quote that line verbatim (exact ` +
      `numbers, no paraphrasing) — that's the number Apple actually assigned, which may ` +
      `differ from what was requested.`;
    // Deploy must reach files outside the repo (/tmp, ~/Library, keychain) and the
    // network, so grant full path + URL + tool access.
    const args = ['-p', prompt, '--allow-all'];

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
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'message is required' });
  const key = `${repo.name}#${n}:chat:${prNumber}`;

  const existing = jobs.getJob(key);
  if (existing && existing.status === 'running') {
    writeSseHead(res);
    jobs.subscribe(existing, res);
    return;
  }

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

  store.appendChatMessage(repo.name, n, prNumber, { role: 'user', text: message, mode });

  const args = [];
  if (resumeId) args.push(`--resume=${resumeId}`);
  if (mode === 'plan') {
    // Read-only: propose a plan, do not touch files. Enforced via approval
    // flags (default = file edits denied), not just the prompt wording.
    const prompt =
      `The branch for PR #${prNumber} is already checked out. Do NOT modify any files. ` +
      `Read the relevant code and propose a concrete plan for the following request, ` +
      `ending with a clear plan summary: ${message}`;
    args.push('-p', prompt, ...approvalFlags('default'));
  } else {
    // Implement the plan from the resumed conversation, on the SAME branch.
    const prompt =
      `Implement the plan from our conversation for this request: ${message}\n\n` +
      `Commit and push the changes to the EXISTING branch for PR #${prNumber} ` +
      `(do not open a new PR, do not force-push). Confirm what you committed and pushed.`;
    args.push('-p', prompt, '--allow-all');
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
