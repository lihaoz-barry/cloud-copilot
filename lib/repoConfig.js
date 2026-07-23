'use strict';

/**
 * Per-repo deploy configuration.
 *
 * Each business repo can declare how its own "Deploy" stage works by placing a
 * `.cloud-copilot.json` at its root:
 *
 *   { "deploy": { "type": "ios-testflight" } }
 *   { "deploy": { "type": "shell", "command": "npm run cc:restart" } }
 *
 * If no config file is present, an Xcode project at the repo root is treated as
 * an implicit `ios-testflight` config (matches today's ios-diet-expert-only
 * behavior). Otherwise deploy is left unconfigured — cloud-copilot never guesses
 * an arbitrary shell command for a repo that hasn't opted in.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILENAME = '.cloud-copilot.json';
const VALID_TYPES = new Set(['ios-testflight', 'shell']);

function findXcodeProject(repoPath) {
  let entries;
  try {
    entries = fs.readdirSync(repoPath);
  } catch {
    return null;
  }
  return entries.find((e) => e.endsWith('.xcodeproj')) || null;
}

function hasXcodeProject(repoPath) {
  let entries;
  try {
    entries = fs.readdirSync(repoPath);
  } catch {
    return false;
  }
  return entries.some((e) => e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'));
}

/**
 * Read the app's marketing version (`MARKETING_VERSION`) straight from the
 * Xcode project file — the same value Xcode itself uses — rather than ever
 * guessing it from free-form deploy output. Returns null if there's no
 * .xcodeproj or the setting isn't present.
 */
function readMarketingVersion(repoPath) {
  const proj = findXcodeProject(repoPath);
  if (!proj) return null;
  try {
    const text = fs.readFileSync(path.join(repoPath, proj, 'project.pbxproj'), 'utf8');
    const m = text.match(/MARKETING_VERSION\s*=\s*([\d.]+);/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} repoPath absolute path to the repo's working directory
 * @returns {{ type: string|null, command?: string, raw: object|null }}
 */
function loadDeployConfig(repoPath) {
  const configPath = path.join(repoPath, CONFIG_FILENAME);
  let raw = null;
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      return { type: null, raw: null, error: `Invalid ${CONFIG_FILENAME}: ${err.message}` };
    }
  }

  const deploy = raw && raw.deploy;
  if (deploy && VALID_TYPES.has(deploy.type)) {
    if (deploy.type === 'shell' && typeof deploy.command !== 'string') {
      return {
        type: null,
        raw,
        error: `${CONFIG_FILENAME}: deploy.type "shell" requires a "command" string`,
      };
    }
    return { type: deploy.type, command: deploy.command, raw };
  }
  if (deploy && deploy.type) {
    return { type: null, raw, error: `${CONFIG_FILENAME}: unknown deploy.type "${deploy.type}"` };
  }

  // No usable config file — fall back to auto-detection.
  if (hasXcodeProject(repoPath)) {
    return { type: 'ios-testflight', raw };
  }
  return { type: null, raw };
}

module.exports = { loadDeployConfig, readMarketingVersion, CONFIG_FILENAME };
