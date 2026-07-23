'use strict';

/**
 * Git / GitHub helpers.
 *
 * - enumerate git repos under a root directory
 * - parse owner/repo from the origin remote
 * - list issues / find PRs via the `gh` CLI (already authenticated on this Mac)
 *
 * All GitHub reads go through `gh`, which reuses your existing login — no MCP or
 * token wiring required.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const GH_BIN = process.env.GH_BIN || 'gh';

// Promisified execFile with a sane default timeout and larger buffer.
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: 20000, maxBuffer: 10 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          err.stdout = stdout;
          return reject(err);
        }
        resolve(stdout);
      },
    );
  });
}

// Parse "owner/repo" from a git remote URL (https or ssh, github.com only).
function parseOwnerRepo(remoteUrl) {
  if (!remoteUrl) return null;
  const cleaned = remoteUrl.trim().replace(/\.git$/, '');
  // git@github.com:owner/repo
  let m = cleaned.match(/github\.com[:/]{1,2}([^/]+)\/(.+)$/);
  if (!m) return null;
  if (!/github\.com/.test(cleaned)) return null;
  return { owner: m[1], repo: m[2], full: `${m[1]}/${m[2]}` };
}

function gitRemote(dir) {
  try {
    // synchronous is fine here (fast, local)
    const out = require('child_process')
      .execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'], // silence "No such remote" on stderr
      })
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

function gitBranch(dir) {
  try {
    return require('child_process')
      .execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        timeout: 5000,
      })
      .trim();
  } catch {
    return null;
  }
}

/**
 * List immediate sub-directories of `root` that are git repos with a remote.
 * Returns [{ name, path, remote, ownerRepo, branch, github }].
 */
function listRepos(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const repos = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const remote = gitRemote(dir);
    if (!remote) continue; // only repos with a remote
    const ownerRepo = parseOwnerRepo(remote);
    repos.push({
      name: e.name,
      path: dir,
      remote,
      ownerRepo: ownerRepo ? ownerRepo.full : null,
      branch: gitBranch(dir),
      github: Boolean(ownerRepo),
    });
  }
  // GitHub repos first, then alphabetical.
  repos.sort((a, b) =>
    a.github === b.github ? a.name.localeCompare(b.name) : a.github ? -1 : 1,
  );
  return repos;
}

// Simple in-memory issue cache: { "owner/repo": { at, issues } }.
const issueCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function listIssues(ownerRepo, { force = false } = {}) {
  if (!ownerRepo) throw new Error('not a GitHub repo');
  const cached = issueCache.get(ownerRepo);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { issues: cached.issues, cached: true, at: cached.at };
  }
  const out = await run(GH_BIN, [
    'issue',
    'list',
    '--repo',
    ownerRepo,
    '--state',
    'open',
    '--limit',
    '50',
    '--json',
    'number,title,state,updatedAt,labels,url',
  ]);
  const issues = JSON.parse(out);
  const at = Date.now();
  issueCache.set(ownerRepo, { at, issues });
  return { issues, cached: false, at };
}

// Matches GitHub's auto-close keywords ("Closes #41", "Fixes owner/repo#41",
// "Resolved #41", ...) — NOT a bare mention like "Related: #39", which shows
// up constantly in generated PR bodies that merely reference other issues for
// context without actually implementing them. A PR only "belongs to" an issue
// if it closes it.
function closesIssueRegex(issueNumber) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:[\\w.-]+/[\\w.-]+)?#${issueNumber}\\b`, 'i');
}

/**
 * Find a PR that CLOSES the given issue number (via GitHub's auto-close
 * keywords in body/title), newest first. Used as a fallback when we can't
 * parse a PR URL from the copilot session output.
 */
async function findPrForIssue(ownerRepo, issueNumber) {
  try {
    const out = await run(GH_BIN, [
      'pr',
      'list',
      '--repo',
      ownerRepo,
      '--state',
      'all',
      '--limit',
      '30',
      '--json',
      'number,title,url,body,createdAt,headRefName',
    ]);
    const prs = JSON.parse(out);
    const needle = closesIssueRegex(issueNumber);
    const match = prs
      .filter((p) => needle.test(p.body || '') || needle.test(p.title || ''))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    return match || null;
  } catch {
    return null;
  }
}

// Whole-repo PR cache: { "owner/repo": { at, prs } }. One `gh pr list` call
// covers every issue in the repo, instead of one call per issue.
const prCache = new Map();

async function listAllPrs(ownerRepo, { force = false } = {}) {
  if (!ownerRepo) throw new Error('not a GitHub repo');
  const cached = prCache.get(ownerRepo);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { prs: cached.prs, cached: true, at: cached.at };
  }
  const out = await run(GH_BIN, [
    'pr',
    'list',
    '--repo',
    ownerRepo,
    '--state',
    'all',
    '--limit',
    '100',
    '--json',
    'number,title,url,body,createdAt,state,headRefName',
  ]);
  const prs = JSON.parse(out);
  const at = Date.now();
  prCache.set(ownerRepo, { at, prs });
  return { prs, cached: false, at };
}

/** Filter a whole-repo PR list down to the ones referencing "#<issueNumber>". */
function matchPrsForIssue(prs, issueNumber) {
  const needle = closesIssueRegex(issueNumber);
  return prs
    .filter((p) => needle.test(p.body || '') || needle.test(p.title || ''))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((p) => ({
      number: p.number,
      url: p.url,
      title: p.title,
      createdAt: p.createdAt,
      state: p.state,
      headRefName: p.headRefName,
    }));
}

/**
 * Find ALL PRs that reference the given issue number, newest first. Used to
 * populate the per-issue PR list so each PR can be deployed independently.
 * `force` bypasses the whole-repo PR cache for an always-live manual refresh.
 * Returns [{ number, url, title, createdAt, state, headRefName }].
 */
async function findPrsForIssue(ownerRepo, issueNumber, { force = false } = {}) {
  try {
    const { prs } = await listAllPrs(ownerRepo, { force });
    return matchPrsForIssue(prs, issueNumber);
  } catch {
    return [];
  }
}

/**
 * Fetch a single PR's details (used by the shell-deploy path to know which
 * branch to check out before running the repo's configured deploy command).
 * Returns { number, headRefName, baseRefName, url } or null on failure.
 */
async function getPr(ownerRepo, prNumber) {
  try {
    const out = await run(GH_BIN, [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      ownerRepo,
      '--json',
      'number,headRefName,baseRefName,url',
    ]);
    return JSON.parse(out);
  } catch {
    return null;
  }
}

module.exports = {
  GH_BIN,
  listRepos,
  listIssues,
  listAllPrs,
  matchPrsForIssue,
  findPrForIssue,
  findPrsForIssue,
  getPr,
  parseOwnerRepo,
  gitBranch,
};
