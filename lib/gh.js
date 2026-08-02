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
 *
 * `pushed` matters for the UI: an unpushed commit has no page on GitHub, so
 * linking to it just 404s.
 *
 * It is answered against this branch's own remote-tracking ref rather than by
 * scanning every remote branch. `git branch -r --contains` walks the history of
 * all of them, which costs ~2.9s on a repo with many branches — and because
 * this runs synchronously it stalled the whole event loop (see `listRepos`).
 * `merge-base --is-ancestor` against the one ref that matters is ~0.5s on the
 * same repo and answers the question the UI actually asks: does this commit
 * exist on the branch's page on GitHub? A branch that was never pushed has no
 * remote-tracking ref, which is exactly the "unpushed" answer we want.
 *
 * Returns { sha, abbrev, committedDate, headline, pushed } or null.
 */
function gitHeadCommit(dir) {
  const git = (args) =>
    require('child_process')
      .execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
  try {
    const out = git(['log', '-1', '--format=%H%x00%h%x00%cI%x00%s']);
    const [sha, abbrev, committedDate, headline] = out.split('\0');
    if (!sha) return null;
    let pushed = false;
    try {
      // The configured upstream if there is one, else the same name on origin.
      let upstream = null;
      try {
        upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
      } catch {
        const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
        if (branch && branch !== 'HEAD') upstream = `origin/${branch}`;
      }
      if (upstream) {
        // `--verify` first so a missing ref is a cheap failure, not a walk.
        git(['rev-parse', '--verify', '--quiet', `${upstream}^{commit}`]);
        git(['merge-base', '--is-ancestor', sha, upstream]);
        pushed = true;
      }
    } catch {
      // No remote-tracking ref, or the sha is not on it — either way the commit
      // has no page on GitHub yet, so leave `pushed` false.
    }
    return { sha, abbrev, committedDate, headline: headline || '', pushed };
  } catch {
    return null;
  }
}

/**
 * List immediate sub-directories of `root` that are git repos with a remote.
 * Returns [{ name, path, remote, ownerRepo, branch, github }].
 *
 * Every entry costs several synchronous git calls, so the whole scan is cached
 * for a couple of seconds. Callers like `resolveRepo` run once per request —
 * and in places like the TestFlight overview, once per row — which without this
 * turned a single request into dozens of full rescans and blocked the event
 * loop for a minute or more.
 */
const REPO_SCAN_TTL_MS = Number(process.env.CC_REPO_SCAN_TTL_MS || 2000);
const repoScanCache = new Map(); // root -> { at, repos }

function listRepos(root, { force = false } = {}) {
  const hit = repoScanCache.get(root);
  if (!force && hit && Date.now() - hit.at < REPO_SCAN_TTL_MS) return hit.repos;
  const repos = scanRepos(root);
  repoScanCache.set(root, { at: Date.now(), repos });
  return repos;
}

function scanRepos(root) {
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
 *
 * @param {object} opts
 *   open  only consider PRs that are still open. The scheduler needs this: a
 *         merged or closed PR is not something it can drive any further, and
 *         adopting one as the issue's current PR would stall the issue forever
 *         instead of opening the new PR it still needs.
 */
async function findPrForIssue(ownerRepo, issueNumber, { open = false } = {}) {
  try {
    const out = await run(GH_BIN, [
      'pr',
      'list',
      '--repo',
      ownerRepo,
      '--state',
      open ? 'open' : 'all',
      '--limit',
      '30',
      '--json',
      'number,title,url,body,createdAt,state,headRefName,baseRefName',
    ]);
    const prs = JSON.parse(out);
    const needle = closesIssueRegex(issueNumber);
    const match = prs
      .filter((p) => needle.test(p.body || '') || needle.test(p.title || ''))
      .filter((p) => !open || !p.state || p.state === 'OPEN')
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
    'number,title,url,body,createdAt,state,headRefName,baseRefName',
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

// ---------------------------------------------------------------------------
// PR sync status vs. its base branch (issue #58)
//
// "Is this PR still in sync with main?" is answered for the WHOLE repo in two
// `gh api graphql` calls, never one per PR:
//
//   1. every open PR's mergeable / mergeStateStatus / base / head
//   2. one aliased `ref(...).compare(headRef: ...)` field per PR, which is the
//      only way GraphQL exposes ahead/behind — the arg has to be a literal, so
//      the query is generated from the result of (1) rather than parameterised.
//
// Everything is best-effort: any failure degrades to "unknown" for the PRs it
// covers, never to an error, because the issue list renders from the same call.
// ---------------------------------------------------------------------------

const OPEN_PR_SYNC_QUERY = `
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN,first:100,orderBy:{field:CREATED_AT,direction:DESC}){
      nodes{ number baseRefName headRefName mergeable mergeStateStatus isCrossRepository }
    }
  }
}`;

// GraphQL aliases must be plain identifiers, and branch names reach the query
// as string literals — JSON.stringify is exactly GraphQL's string syntax for
// the characters git allows in a ref, and refs that would need anything else
// are dropped by isSafeRef below rather than escaped by hand.
const isSafeRef = (ref) => typeof ref === 'string' && ref.length > 0 && !/["\\\s]/.test(ref);

function compareQuery(pairs) {
  const fields = pairs.map(
    ({ alias, base, head }) =>
      `${alias}: ref(qualifiedName:${JSON.stringify(`refs/heads/${base}`)}){` +
      ` compare(headRef:${JSON.stringify(head)}){ aheadBy behindBy status } }`,
  );
  return `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){\n${fields.join('\n')}\n}}`;
}

// One PR's derived state, the single value the UI switches on. Conflicts win
// over "behind" (they need a different kind of fix), and an unresolved
// mergeable with nothing else to report stays `unknown` — never `clean`, so a
// PR is never silently claimed to be mergeable when GitHub hasn't said so.
function deriveSyncState({ mergeable, behindBy }) {
  if (mergeable === 'CONFLICTING') return 'conflict';
  if (typeof behindBy === 'number' && behindBy > 0) return 'behind';
  if (mergeable === 'MERGEABLE' && behindBy === 0) return 'clean';
  return 'unknown';
}

/**
 * { [prNumber]: { state, behindBy, aheadBy, mergeable, mergeStateStatus,
 *                 baseRefName, headRefName, compareStatus, at } } for every
 * OPEN PR of the repo. Never throws; an empty map just means no row gets a
 * badge this round.
 */
async function listPrSync(ownerRepo, { force = false } = {}) {
  if (!ownerRepo) return {};
  const cached = ghCache.get(ownerRepo, 'prSync');
  if (!force && cached && cached.fresh) return Object.fromEntries(cached.data);
  const [owner, name] = ownerRepo.split('/');
  if (!owner || !name) return {};
  const fallback = () => (cached ? Object.fromEntries(cached.data) : {});

  let nodes;
  try {
    const out = await run(GH_BIN, [
      'api',
      'graphql',
      '-f',
      `query=${OPEN_PR_SYNC_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
    ]);
    nodes = JSON.parse(out)?.data?.repository?.pullRequests?.nodes || [];
  } catch {
    return fallback();
  }

  // Ahead/behind for the PRs whose refs can be compared by name. A PR from a
  // fork lives on another repository, so `ref(...).compare()` in THIS repo
  // cannot see its head — those stay at "unknown" instead of a wrong 0.
  const comparable = nodes.filter(
    (n) => !n.isCrossRepository && isSafeRef(n.baseRefName) && isSafeRef(n.headRefName),
  );
  const compares = {};
  const CHUNK = 30; // keep each generated query comfortably small
  for (let i = 0; i < comparable.length; i += CHUNK) {
    const slice = comparable.slice(i, i + CHUNK);
    const pairs = slice.map((n) => ({
      alias: `pr${n.number}`,
      base: n.baseRefName,
      head: n.headRefName,
    }));
    try {
      const out = await run(GH_BIN, [
        'api',
        'graphql',
        '-f',
        `query=${compareQuery(pairs)}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `name=${name}`,
      ]);
      const repoData = JSON.parse(out)?.data?.repository || {};
      for (const n of slice) {
        const cmp = repoData[`pr${n.number}`] && repoData[`pr${n.number}`].compare;
        if (cmp) compares[n.number] = cmp;
      }
    } catch {
      // Leave this chunk's PRs without ahead/behind — they degrade to
      // "unknown" (or to a conflict flag, which needs no comparison).
    }
  }

  const at = Date.now();
  const entries = nodes.map((n) => {
    const cmp = compares[n.number] || {};
    const behindBy = typeof cmp.behindBy === 'number' ? cmp.behindBy : null;
    const aheadBy = typeof cmp.aheadBy === 'number' ? cmp.aheadBy : null;
    return [
      String(n.number),
      {
        state: deriveSyncState({ mergeable: n.mergeable, behindBy }),
        behindBy,
        aheadBy,
        mergeable: n.mergeable || 'UNKNOWN',
        mergeStateStatus: n.mergeStateStatus || null,
        baseRefName: n.baseRefName || null,
        headRefName: n.headRefName || null,
        crossRepository: Boolean(n.isCrossRepository),
        at,
      },
    ];
  });
  ghCache.set(ownerRepo, 'prSync', entries, at);
  return Object.fromEntries(entries);
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
      baseRefName: p.baseRefName,
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
      'number,headRefName,headRefOid,baseRefName,url,title,state,mergeable',
    ]);
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * PRs whose head is `branch`, newest first. Deliberately uncached and
 * unfiltered by state: the caller is verifying a pull request that was created
 * seconds ago, which the `prs` cache would not know about yet. `headRefOid` is
 * requested so the caller can prove the PR really carries a given commit
 * instead of trusting the branch name.
 */
async function listPrsForHead(ownerRepo, branch) {
  if (!ownerRepo || !branch) return [];
  try {
    const out = await run(GH_BIN, [
      'pr',
      'list',
      '--repo',
      ownerRepo,
      '--head',
      branch,
      '--state',
      'all',
      '--limit',
      '10',
      '--json',
      'number,url,state,headRefName,headRefOid',
    ]);
    return JSON.parse(out);
  } catch {
    return [];
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

/**
 * PERMANENTLY delete an issue on GitHub via `gh issue delete --yes`. This is
 * irreversible and requires admin permission on the repository — callers must
 * gate it behind an explicit confirmation and surface the error verbatim.
 * Also drops the cached issue list so the deletion shows up immediately.
 */
async function deleteIssue(ownerRepo, issueNumber) {
  if (!ownerRepo) throw new Error('not a GitHub repo');
  try {
    await run(GH_BIN, ['issue', 'delete', String(issueNumber), '--repo', ownerRepo, '--yes']);
  } finally {
    ghCache.invalidate(ownerRepo, 'issues');
  }
}

/**
 * The GitHub label that marks an issue as "committed" — cloud-copilot's
 * scheduler drives those issues to a finished PR on its own (issue #64).
 * GitHub is the source of truth on purpose: the flag then survives a reinstall
 * and can be flipped from github.com or from another machine.
 */
const COMMITTED_LABEL = process.env.CC_COMMITTED_LABEL || 'committed';

/**
 * Add or remove a label on an issue. The label is created on demand — `gh
 * issue edit --add-label` fails outright on a label the repo has never seen,
 * which would otherwise make the very first checkbox click an error.
 */
async function setIssueLabel(ownerRepo, issueNumber, label, on) {
  if (!ownerRepo) throw new Error('not a GitHub repo');
  if (on) {
    try {
      await run(GH_BIN, [
        'label',
        'create',
        label,
        '--repo',
        ownerRepo,
        '--color',
        '0E8A16',
        '--description',
        'cloud-copilot drives this issue to a finished PR automatically',
      ]);
    } catch {
      /* already exists — the only failure mode that matters here */
    }
  }
  try {
    await run(GH_BIN, [
      'issue',
      'edit',
      String(issueNumber),
      '--repo',
      ownerRepo,
      on ? '--add-label' : '--remove-label',
      label,
    ]);
  } catch (err) {
    // The label may or may not have changed — stop claiming we know.
    ghCache.invalidate(ownerRepo, 'issues');
    throw err;
  }
  // Patch the cached copy rather than dropping it: we know exactly what
  // changed, and an invalidation here would leave /statuses with no labels to
  // serve until the next full `gh issue list`. Falls back to invalidating when
  // the issue isn't cached at all (nothing to patch, so the cache is wrong).
  const patched = ghCache.updateIssue(ownerRepo, issueNumber, (issue) => {
    const labels = (issue.labels || []).filter((l) => (l && l.name) !== label);
    if (on) labels.push({ name: label });
    return { ...issue, labels };
  });
  if (!patched) ghCache.invalidate(ownerRepo, 'issues');
  return on;
}

/** Cached label names of one issue, or null when it isn't in the cache. */
function cachedIssueLabels(ownerRepo, issueNumber) {
  const entry = ghCache.get(ownerRepo, 'issues');
  if (!entry) return null;
  const n = Number(issueNumber);
  const issue = entry.data.find((i) => i && i.number === n);
  return issue ? (issue.labels || []).map((l) => l.name) : null;
}

module.exports = {
  GH_BIN,
  CACHE_TTL_MS,
  cache: ghCache,
  listRepos,
  listIssues,
  deleteIssue,
  setIssueLabel,
  cachedIssueLabels,
  COMMITTED_LABEL,
  listAllPrs,
  listPrHeadCommits,
  listPrSync,
  deriveSyncState,
  gitHeadCommit,
  matchPrsForIssue,
  findPrForIssue,
  findPrsForIssue,
  getPr,
  listPrsForHead,
  createIssue,
  parseOwnerRepo,
  gitBranch,
};
