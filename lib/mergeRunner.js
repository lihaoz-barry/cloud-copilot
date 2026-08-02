'use strict';

const { spawn } = require('child_process');

const RESULT_PREFIX = '[cloud-copilot merge recovery] ';
const VERIFY_ATTEMPTS = Number(process.env.MERGE_VERIFY_ATTEMPTS || 60);
const VERIFY_INTERVAL_MS = Number(process.env.MERGE_VERIFY_INTERVAL_MS || 5000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(bin, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout.on('data', (buf) => {
        stdout += buf.toString('utf8');
      });
      child.stderr.on('data', (buf) => {
        stderr += buf.toString('utf8');
      });
    }
    child.on('error', (error) => resolve({ code: null, stdout, stderr, error }));
    child.on('close', (code) => resolve({ code, stdout, stderr, error: null }));
  });
}

async function getPrState(ghBin, ownerRepo, prNumber, cwd) {
  const result = await run(
    ghBin,
    [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      ownerRepo,
      '--json',
      'state,mergeable,mergeStateStatus,baseRefName,headRefName',
    ],
    { cwd, capture: true },
  );
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function waitForMerged(ghBin, ownerRepo, prNumber, cwd) {
  let state = null;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    state = await getPrState(ghBin, ownerRepo, prNumber, cwd);
    if (state && state.state === 'MERGED') return state;
    if (attempt < VERIFY_ATTEMPTS - 1) await sleep(VERIFY_INTERVAL_MS);
  }
  return state;
}

function writeResult(result) {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

function recoveryPrompt({ ownerRepo, prNumber, baseRefName, headRefName }) {
  return [
    `The initial merge attempt did not complete for PR #${prNumber} in ${ownerRepo}.`,
    'Investigate the failure and finish the merge autonomously. Do not only explain the problem.',
    `Work only in the current repository. The PR head is \`${headRefName || 'unknown'}\` and its base is \`${baseRefName || 'main'}\`.`,
    `Use \`gh pr view ${prNumber} --repo ${ownerRepo}\` to inspect the current state, fetch origin, and check out the PR branch.`,
    `If the branch conflicts with \`origin/${baseRefName || 'main'}\`, merge the base into the PR branch, resolve every conflict correctly, run relevant existing checks, commit the resolution, and push the PR branch.`,
    `Then run \`gh pr merge ${prNumber} --repo ${ownerRepo} --merge --delete-branch\`.`,
    'Handle other merge blockers you discover when they can be fixed from this repository.',
    'Verify the PR state is MERGED before finishing. Do not ask the user for confirmation.',
  ].join(' ');
}

async function main() {
  const [ghBin, copilotBin, ownerRepo, prArg, model] = process.argv.slice(2);
  const prNumber = Number(prArg);
  if (!ghBin || !copilotBin || !ownerRepo || !Number.isInteger(prNumber) || prNumber <= 0 || !model) {
    process.stderr.write('Usage: mergeRunner <gh-bin> <copilot-bin> <owner/repo> <pr-number> <model>\n');
    process.exitCode = 2;
    return;
  }

  const cwd = process.cwd();
  const mergeArgs = ['pr', 'merge', String(prNumber), '--repo', ownerRepo, '--merge', '--delete-branch'];
  const initial = await run(ghBin, mergeArgs, { cwd });
  let before;
  if (initial.code === 0) {
    before = await waitForMerged(ghBin, ownerRepo, prNumber, cwd);
    if (before && before.state === 'MERGED') {
      writeResult({
        attempted: false,
        conflictDetected: false,
        merged: true,
        baseRefName: before.baseRefName,
      });
      return;
    }
    process.stderr.write(
      `\n[merge verification] The merge command succeeded, but PR #${prNumber} did not reach MERGED state. Starting recovery.\n`,
    );
  } else {
    before = await getPrState(ghBin, ownerRepo, prNumber, cwd);
  }

  if (before && before.state === 'MERGED') {
    writeResult({
      attempted: false,
      conflictDetected: false,
      merged: true,
      baseRefName: before.baseRefName,
    });
    return;
  }

  const conflictDetected = Boolean(
    before && (before.mergeable === 'CONFLICTING' || before.mergeStateStatus === 'DIRTY'),
  );
  process.stdout.write(
    `\n[merge recovery] Merge did not complete. Starting Copilot to investigate${conflictDetected ? ' and resolve conflicts' : ''}…\n`,
  );
  writeResult({
    attempted: true,
    conflictDetected,
    merged: false,
    baseRefName: before && before.baseRefName,
  });

  const prompt = recoveryPrompt({
    ownerRepo,
    prNumber,
    baseRefName: before && before.baseRefName,
    headRefName: before && before.headRefName,
  });
  const copilot = await run(copilotBin, ['-p', prompt, '--allow-all', '--model', model], { cwd });
  const after = await waitForMerged(ghBin, ownerRepo, prNumber, cwd);
  const merged = Boolean(after && after.state === 'MERGED');
  const result = {
    attempted: true,
    conflictDetected,
    merged,
    conflictResolved: conflictDetected && merged,
    baseRefName: (after && after.baseRefName) || (before && before.baseRefName),
  };
  writeResult(result);

  if (!merged) {
    process.stderr.write(
      `\n[merge recovery] Copilot finished, but GitHub reports PR #${prNumber} is ${after?.state || 'not merged'}.\n`,
    );
    process.exitCode = copilot.code || 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[merge recovery error] ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { RESULT_PREFIX, recoveryPrompt };
