'use strict';

/**
 * Self-deploy: deciding whether a deploy also has to restart cloud-scheduler.
 *
 * cloud-copilot deploys itself, but it is two processes, not one:
 *
 *   dashboard        :8787  node server.js            scripts/restart.sh
 *   cloud-scheduler  :8788  node scheduler-server.js  scripts/restart-scheduler.sh
 *
 * The configured deploy command only restarts the dashboard, so a change that
 * lands on the scheduler side used to "deploy" successfully while the old
 * scheduler kept running until somebody remembered to restart it by hand.
 *
 * Restarting the scheduler on every deploy is not the answer either: it holds
 * the pid and process group of every running Copilot session, and during a
 * restart there is a window in which nothing watches for their exit. So it is
 * done deliberately — only when the change actually touches scheduler code.
 *
 * This module owns that decision (pure functions, easy to test); the execution
 * of the two phases lives in scripts/self-deploy.js, which survives both
 * restarts because it runs as a supervised session rather than inside either
 * process being replaced.
 */

const path = require('path');
const { execFileSync } = require('child_process');

/**
 * The files that decide whether the *running scheduler* is stale. These are
 * the modules `node scheduler-server.js` freezes at require() time; editing
 * them on disk changes nothing until the process is replaced.
 */
const DEFAULT_SCHEDULER_PATHS = [
  'scheduler-server.js',
  'lib/schedulerCore.js',
  'lib/supervisor.js',
  'lib/supervisorClient.js',
  'lib/worktreePool.js',
  'lib/portPool.js',
  'scripts/restart-scheduler.sh',
];

const DEFAULT_SCHEDULER_COMMAND = 'npm run cc:restart-scheduler';

/**
 * The last line scripts/self-deploy.js prints, and the only trustworthy record
 * of how a two-phase deploy ended.
 *
 * Phase 2 replaces the supervisor that owns the deploy session itself. The new
 * supervisor adopts the session by pid, so it can observe its death but never
 * its exit status (lib/supervisor.js: "observed deaths have no exit code") —
 * `exitCode` arrives as null and a deploy judged by `exitCode === 0` alone
 * would report every successful scheduler restart as a failure. So the runner
 * states its own verdict on the transcript, which is on disk before it exits.
 */
const RESULT_MARKER = '::cloud-copilot-self-deploy::';

/**
 * The verdict a self-deploy transcript carries, if any.
 * The last marker wins: a stream may be replayed from the start after the
 * supervisor is replaced, so the same line can legitimately appear twice.
 *
 * @param {string} text the job transcript
 * @returns {'success'|'failed'|null} null when the runner never reported
 */
function resultFromTranscript(text) {
  if (typeof text !== 'string' || !text) return null;
  let verdict = null;
  const re = new RegExp(`${RESULT_MARKER}\\s*(success|failed)\\b`, 'g');
  for (const m of text.matchAll(re)) verdict = m[1];
  return verdict;
}

/** Strip "./" and leading slashes so config and `git diff` output compare equal. */
function normalizePath(p) {
  return String(p == null ? '' : p)
    .trim()
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/**
 * Does one changed file match one configured pattern?
 *
 * Three shapes, all of them things a human would plausibly write:
 *   "lib/supervisor.js"  exact file
 *   "lib"                a directory — anything beneath it
 *   "lib/*.js"           a `*` wildcard that does not cross a "/"
 */
function matchesPattern(file, pattern) {
  const f = normalizePath(file);
  const p = normalizePath(pattern);
  if (!f || !p) return false;
  if (p.includes('*')) {
    const re = new RegExp(
      `^${p
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*')}$`,
    );
    return re.test(f);
  }
  return f === p || f.startsWith(`${p}/`);
}

/**
 * The changed files that touch scheduler code.
 * @param {string[]} files  paths from `git diff --name-only`
 * @param {string[]} [patterns]
 * @returns {string[]} unique, sorted matches (empty means "dashboard only")
 */
function schedulerChanges(files, patterns = DEFAULT_SCHEDULER_PATHS) {
  const list = Array.isArray(files) ? files : [];
  const pats = Array.isArray(patterns) && patterns.length ? patterns : DEFAULT_SCHEDULER_PATHS;
  const matched = new Set();
  for (const file of list) {
    const f = normalizePath(file);
    if (!f) continue;
    if (pats.some((p) => matchesPattern(f, p))) matched.add(f);
  }
  return [...matched].sort();
}

function samePath(a, b) {
  if (!a || !b) return false;
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return false;
  }
}

/**
 * Is this deploy cloud-copilot deploying itself?
 *
 * Never by repo name — a fork that renames the directory would silently lose
 * the behaviour. Either the repo's working directory *is* the app root of the
 * process running the deploy, or `.cloud-copilot.json` says so explicitly
 * (which also lets a repo opt out with `"selfDeploy": false`).
 */
function isSelfDeploy(repoPath, deploy, appRoot) {
  if (deploy && typeof deploy.selfDeploy === 'boolean') return deploy.selfDeploy;
  return samePath(repoPath, appRoot);
}

/**
 * `git diff --name-only base..head`, best-effort.
 *
 * Not knowing one of the two revisions is an *error*, never an empty diff:
 * "we could not tell what changed" and "nothing changed" lead to opposite
 * decisions in planShellDeploy, and only one of them is safe.
 */
function changedFiles(repoPath, base, head) {
  if (!base) return { files: [], error: 'unknown deployed commit' };
  if (!head) return { files: [], error: 'unknown head commit' };
  if (base === head) return { files: [], error: null };
  try {
    const out = execFileSync('git', ['-C', repoPath, 'diff', '--name-only', `${base}..${head}`], {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { files: out.split('\n').map((s) => s.trim()).filter(Boolean), error: null };
  } catch (err) {
    return { files: [], error: err.message };
  }
}

/**
 * Decide what a shell deploy has to do.
 *
 * @param {object} opts
 *   repoPath      the repo's working directory
 *   appRoot       this process's application root
 *   deploy        the `deploy` block of .cloud-copilot.json (may be undefined)
 *   files         changed files for this deploy (from `changedFiles`)
 *   diffError     why the diff could not be computed, if it could not
 * @returns {{selfDeploy:boolean, restartScheduler:boolean, matched:string[],
 *            schedulerCommand:string|null, paths:string[], decisionLine:string}}
 */
function planShellDeploy({ repoPath, appRoot, deploy, files = [], diffError = null } = {}) {
  const selfDeploy = isSelfDeploy(repoPath, deploy, appRoot);
  const scheduler = (deploy && deploy.scheduler) || null;
  const paths =
    scheduler && Array.isArray(scheduler.paths) && scheduler.paths.length
      ? scheduler.paths
      : DEFAULT_SCHEDULER_PATHS;
  const schedulerCommand =
    scheduler && typeof scheduler.command === 'string' && scheduler.command.trim()
      ? scheduler.command.trim()
      : DEFAULT_SCHEDULER_COMMAND;

  if (!selfDeploy) {
    return {
      selfDeploy: false,
      restartScheduler: false,
      matched: [],
      schedulerCommand: null,
      paths,
      decisionLine: '',
    };
  }

  const matched = schedulerChanges(files, paths);

  // An unreadable diff is not evidence of "nothing changed". Restarting the
  // scheduler is the safe side of this coin: sessions are re-adopted, whereas a
  // skipped restart silently keeps stale code running.
  if (diffError) {
    return {
      selfDeploy: true,
      restartScheduler: true,
      matched,
      schedulerCommand,
      paths,
      decisionLine: `could not diff the deployed commit (${diffError}) → restarting cloud-scheduler to be safe`,
    };
  }

  if (!matched.length) {
    return {
      selfDeploy: true,
      restartScheduler: false,
      matched,
      schedulerCommand,
      paths,
      decisionLine: 'no scheduler changes → dashboard only',
    };
  }

  return {
    selfDeploy: true,
    restartScheduler: true,
    matched,
    schedulerCommand,
    paths,
    decisionLine: `scheduler code changed (${matched.join(', ')}) → will restart cloud-scheduler after the dashboard`,
  };
}

module.exports = {
  DEFAULT_SCHEDULER_PATHS,
  DEFAULT_SCHEDULER_COMMAND,
  RESULT_MARKER,
  resultFromTranscript,
  normalizePath,
  matchesPattern,
  schedulerChanges,
  isSelfDeploy,
  changedFiles,
  planShellDeploy,
};
