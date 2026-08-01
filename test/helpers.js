'use strict';

/**
 * Shared scaffolding for the queue tests.
 *
 * Every test file points CC_QUEUE_FILE / CC_QUEUE_CONFIG / CC_REPORTS_DIR at a
 * throwaway directory BEFORE requiring any lib module, so nothing here can ever
 * touch the real data/ directory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function tmpDir(prefix = 'cc-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Point the whole library at a fresh sandbox. Call before requiring libs. */
function sandbox(prefix) {
  const dir = tmpDir(prefix);
  process.env.CC_QUEUE_FILE = path.join(dir, 'queue.json');
  process.env.CC_QUEUE_CONFIG = path.join(dir, 'queue-config.json');
  process.env.CC_REPORTS_DIR = path.join(dir, 'reports');
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * A git repo that looks enough like a GitHub clone for lib/gh.js to accept it.
 *
 * The remote URL is a real-looking GitHub URL (so `parseOwnerRepo` succeeds and
 * the repo is considered a GitHub repo) but is never contacted: the code paths
 * under test either tolerate a failed fetch or read refs we create by hand.
 * `refs/remotes/origin/<default>` is written directly so `origin/main` resolves
 * offline.
 */
function makeRepo(root, name, { defaultBranch = 'main', ownerRepo = 'test-owner/test-repo' } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', defaultBranch]);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'cc test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'initial']);
  git(dir, ['remote', 'add', 'origin', `https://github.com/${ownerRepo}.git`]);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['update-ref', `refs/remotes/origin/${defaultBranch}`, sha]);
  git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${defaultBranch}`]);
  return { name, path: dir, ownerRepo, github: true, defaultBranch };
}

/** Commit a file on the current branch and return the new sha. */
function commitFile(dir, file, contents, message = 'change') {
  fs.writeFileSync(path.join(dir, file), contents);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/**
 * A stand-in for the `copilot` binary. Prints whatever you give it and exits
 * with the code you choose — so the tests exercise the real job/spawn/stream
 * plumbing without spending a single token.
 */
function fakeCopilot(dir, { stdout = '', exitCode = 0, sleepSeconds = 0, echoPort = false } = {}) {
  const p = path.join(dir, 'fake-copilot.sh');
  fs.writeFileSync(
    p,
    [
      '#!/bin/sh',
      echoPort ? 'echo "PORT=$PORT"' : '',
      'echo "cwd=$(pwd)"',
      sleepSeconds ? `sleep ${sleepSeconds}` : '',
      stdout ? `cat <<'EOF'\n${stdout}\nEOF` : '',
      `exit ${exitCode}`,
      '',
    ].join('\n'),
  );
  fs.chmodSync(p, 0o755);
  return p;
}

module.exports = { tmpDir, sandbox, git, makeRepo, commitFile, fakeCopilot };
