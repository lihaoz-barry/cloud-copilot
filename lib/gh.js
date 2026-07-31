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
const ghCache = require('./ghCache');

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
 * The checked-out branch's tip commit, read straight from the local clone —
 * no API call, so it stays accurate even for branches GitHub has never seen.
 * Returns { sha, abbrev, committedDate, headline } or null.
 */
function gitHeadCommit(dir) {
  try {
    const out = require('child_process')
      .execFileSync('git', ['-C', dir, 'log', '-1', '--format=%H%x00%h%x00%cI%x00%s'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
    const [sha, abbrev, committedDate, headline] = out.split('\0');
    if (!sha) return null;
    return { sha, abbrev, committedDate, headline: headline || '' };
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
      headCommit: gitHeadCommit(dir),
      github: Boolean(ownerRepo),
    });
  }
  // GitHub repos first, then alphabetical.
  repos.sort((a, b) =>
    a.github === b.github ? a.name.localeCompare(b.name) : a.github ? -1 : 1,
  );
  return repos;
}

// Issue + PR results are cached by ghCache (L2): an in-memory copy backed by a
// JSON file, so a server restart no longer means a cold `gh` call on every
// repo. `force` bypasses it entirely — that's what the Refresh button sends.
const CACHE_TTL_MS = ghCache.TTL_MS;

async function listIssues(ownerRepo, { force = false } = {}) {
  if (!ownerRepo) throw new Error('not a GitHub repo');
  const cached = ghCache.get(ownerRepo, 'issues');
  if (!force && cached && cached.fresh) {
    return { issues: cached.data, cached: true, at: cached.at };
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
  const at = ghCache.set(ownerRepo, 'issues', issues);
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

// Whole-repo PR list — one `gh pr list` call covers every issue in the repo,
// instead of one call per issue. Cached in the same L2 store as issues.
async function listAllPrs(ownerRepo, { force = false } = {}) {
  if (!ownerRepo) throw new Error('not a GitHub repo');
  const cached = ghCache.get(ownerRepo, 'prs');
  if (!force && cached && cached.fresh) {
    return { prs: cached.data, cached: true, at: cached.at };
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
  const at = ghCache.set(ownerRepo, 'prs', prs);
  return { prs, cached: false, at };
}

// Head commit of every PR in the repo, keyed by PR number. `gh pr list --json
// commits` can't be used here: it returns every commit of every PR and blows
// past GitHub's GraphQL node limit at 100 PRs. This asks for exactly the last
// commit of each instead — one call, ~10 KB, cached in the same L2 store.
const PR_HEAD_COMMITS_QUERY = `
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(first:100,orderBy:{field:CREATED_AT,direction:DESC}){
      nodes{
        number
        headRefName
        commits(last:1){ nodes{ commit{ oid abbreviatedOid committedDate messageHeadline url } } }
      }
    }
  }
}`;

/**
 * { [prNumber]: { headRefName, sha, abbrev, committedDate, headline, url } }.
 * Purely decorative — every failure resolves to an empty map so the PR list
 * still renders without commit annotations.
 */
async function listPrHeadCommits(ownerRepo, { force = false } = {}) {
  if (!ownerRepo) return {};
  const cached = ghCache.get(ownerRepo, 'prCommits');
  // Stored as an array of entries: ghCache only persists arrays.
  if (!force && cached && cached.fresh) return Object.fromEntries(cached.data);
  const [owner, name] = ownerRepo.split('/');
  if (!owner || !name) return {};
  try {
    const out = await run(GH_BIN, [
      'api',
      'graphql',
      '-f',
      `query=${PR_HEAD_COMMITS_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
    ]);
    const nodes = JSON.parse(out)?.data?.repository?.pullRequests?.nodes || [];
    const entries = [];
    for (const n of nodes) {
      const c = n?.commits?.nodes?.[0]?.commit;
      if (!c) continue;
      entries.push([
        String(n.number),
        {
          headRefName: n.headRefName,
          sha: c.oid,
          abbrev: c.abbreviatedOid,
          committedDate: c.committedDate,
          headline: c.messageHeadline,
          url: c.url,
        },
      ]);
    }
    ghCache.set(ownerRepo, 'prCommits', entries);
    return Object.fromEntries(entries);
  } catch {
    // Fall back to whatever we last had rather than dropping the annotations.
    return cached ? Object.fromEntries(cached.data) : {};
  }
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
 * branch to check out before running the repo's configured deploy command,
 * and by the ios-testflight deploy path to build a "What to Test" changelog
 * from the PR title). Returns
 * { number, headRefName, baseRefName, url, title, state }
 * or null on failure.
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
      'number,headRefName,baseRefName,url,title,state',
    ]);
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * Create a real GitHub issue via `gh issue create`. Returns the created
 * issue's URL. Used to promote a PreIssue draft into a full issue.
 */
async function createIssue(ownerRepo, title, body) {
  if (!ownerRepo) throw new Error('not a GitHub repo');
  const out = await run(GH_BIN, [
    'issue',
    'create',
    '--repo',
    ownerRepo,
    '--title',
    title,
    '--body',
    body || '',
  ]);
  const url = out.trim().split('\n').pop().trim();
  const m = url.match(/\/issues\/(\d+)\s*$/);
  return { url, number: m ? Number(m[1]) : null };
}

module.exports = {
  GH_BIN,
  CACHE_TTL_MS,
  cache: ghCache,
  listRepos,
  listIssues,
  listAllPrs,
  listPrHeadCommits,
  gitHeadCommit,
  matchPrsForIssue,
  findPrForIssue,
  findPrsForIssue,
  getPr,
  createIssue,
  parseOwnerRepo,
  gitBranch,
};
