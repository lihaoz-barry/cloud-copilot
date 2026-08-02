'use strict';

/**
 * Per-repo configuration: what kind of project this is, how it is verified,
 * and how its "Deploy" stage works.
 *
 * Each business repo can declare all of it by placing a `.cloud-copilot.json`
 * at its root:
 *
 *   { "projectType": "ios" }
 *   { "test": { "command": "npm run ci" } }
 *   { "deploy": { "type": "ios-testflight" } }
 *   { "deploy": { "type": "shell", "command": "npm run cc:restart" } }
 *
 * If no config file is present the layout on disk decides: an Xcode project at
 * the repo root means `ios` (and an implicit `ios-testflight` deploy, matching
 * today's ios-diet-expert-only behavior), a lone `package.json` means `web`.
 * Anything else stays `unknown` — cloud-copilot never guesses an arbitrary
 * shell command for a repo that hasn't opted in, neither to deploy nor to test.
 *
 * Everything here goes through one cached filesystem probe per repo
 * (`probeRepo`), so listing repos or builds doesn't re-read the disk per row.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILENAME = '.cloud-copilot.json';
const VALID_TYPES = new Set(['ios-testflight', 'shell']);

/** Project types cloud-copilot knows how to reason about. */
const PROJECT_TYPES = ['ios', 'web'];
const UNKNOWN_PROJECT_TYPE = 'unknown';

/**
 * How long a filesystem probe stays good for. Long enough that a page full of
 * repos costs one readdir each, short enough that adding a `.cloud-copilot.json`
 * takes effect while you're still looking at the screen.
 */
const PROBE_TTL_MS = Number(process.env.CC_REPO_CONFIG_TTL_MS || 30_000);

const probeCache = new Map();

/** Drop cached probes — one repo's, or all of them. Used by tests. */
function clearCache(repoPath) {
  if (repoPath) probeCache.delete(repoPath);
  else probeCache.clear();
}

/**
 * One readdir + one config read per repo, cached.
 *
 * @returns {{ entries: string[], xcodeproj: string|null, xcworkspace: string|null,
 *             hasSwiftPackage: boolean, hasPackageJson: boolean,
 *             raw: object|null, error: string|null }}
 */
function probeRepo(repoPath) {
  const hit = probeCache.get(repoPath);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;

  let entries = [];
  try {
    entries = fs.readdirSync(repoPath);
  } catch {
    entries = [];
  }

  let raw = null;
  let error = null;
  if (entries.includes(CONFIG_FILENAME)) {
    try {
      raw = JSON.parse(fs.readFileSync(path.join(repoPath, CONFIG_FILENAME), 'utf8'));
    } catch (err) {
      error = `Invalid ${CONFIG_FILENAME}: ${err.message}`;
    }
  }

  const value = {
    entries,
    xcodeproj: entries.find((e) => e.endsWith('.xcodeproj')) || null,
    xcworkspace: entries.find((e) => e.endsWith('.xcworkspace')) || null,
    hasSwiftPackage: entries.includes('Package.swift'),
    hasPackageJson: entries.includes('package.json'),
    raw,
    error,
  };
  probeCache.set(repoPath, { at: Date.now(), value });
  return value;
}

function findXcodeProject(repoPath) {
  return probeRepo(repoPath).xcodeproj;
}

function hasXcodeProject(repoPath) {
  const p = probeRepo(repoPath);
  return Boolean(p.xcodeproj || p.xcworkspace);
}

/** Is `t` one of the project types a client is allowed to send/store? */
function isProjectType(t) {
  return typeof t === 'string' && PROJECT_TYPES.includes(t);
}

/**
 * What kind of project lives at `repoPath`, ignoring any user override.
 *
 * Order: an explicit `projectType` in `.cloud-copilot.json` wins (the repo has
 * the final say about itself), then the layout on disk, then `unknown`.
 *
 * @returns {{ type: string, source: 'config'|'auto', reason: string }}
 */
function detectProjectType(repoPath) {
  const p = probeRepo(repoPath);
  const declared = p.raw && p.raw.projectType;
  if (isProjectType(declared)) {
    return { type: declared, source: 'config', reason: `${CONFIG_FILENAME}: projectType` };
  }
  if (p.xcworkspace) return { type: 'ios', source: 'auto', reason: p.xcworkspace };
  if (p.xcodeproj) return { type: 'ios', source: 'auto', reason: p.xcodeproj };
  if (p.hasSwiftPackage) return { type: 'ios', source: 'auto', reason: 'Package.swift' };
  if (p.hasPackageJson) return { type: 'web', source: 'auto', reason: 'package.json' };
  return { type: UNKNOWN_PROJECT_TYPE, source: 'auto', reason: 'no known project marker' };
}

/**
 * The effective project type: a stored manual override beats detection, which
 * is the whole point of the (deliberately hard to trigger) long-press.
 *
 * @param {string} repoPath
 * @param {string|null} override 'ios' | 'web' | null
 */
function resolveProjectType(repoPath, override = null) {
  const detected = detectProjectType(repoPath);
  const overridden = isProjectType(override);
  return {
    type: overridden ? override : detected.type,
    source: overridden ? 'override' : detected.source,
    overridden,
    detected: detected.type,
    detectedSource: detected.source,
    reason: detected.reason,
  };
}

/**
 * The default `xcodebuild` invocation for an Xcode project, built from what is
 * actually on disk (the workspace/project name doubles as the scheme name,
 * which is the Xcode default) rather than from a guess. Returns null when
 * there is no Xcode project to point it at.
 */
function xcodebuildCommand(repoPath, action = 'test') {
  const p = probeRepo(repoPath);
  const container = p.xcworkspace || p.xcodeproj;
  if (!container) return null;
  const flag = p.xcworkspace ? '-workspace' : '-project';
  const scheme = container.replace(/\.(xcworkspace|xcodeproj)$/, '');
  return (
    `xcodebuild ${action} ${flag} "${container}" -scheme "${scheme}" ` +
    `-destination "platform=iOS Simulator,name=iPhone 16"`
  );
}

/**
 * How this repo should be verified before a PR is opened.
 *
 * `.cloud-copilot.json` → `test.command` always wins. Otherwise the project
 * type decides: iOS builds and tests through Xcode against a simulator, Web
 * goes through npm, and `unknown` gets nothing at all — running a command
 * nobody asked for in a repo we don't understand is worse than running none.
 *
 * @returns {{ type: string, command: string|null, commands: string[],
 *             source: 'config'|'auto'|null, error: string|null }}
 */
function loadTestConfig(repoPath, { projectType = null } = {}) {
  const p = probeRepo(repoPath);
  const type = isProjectType(projectType) ? projectType : resolveProjectType(repoPath).type;

  const declared = p.raw && p.raw.test;
  if (declared && typeof declared.command === 'string' && declared.command.trim()) {
    const command = declared.command.trim();
    return { type, command, commands: [command], source: 'config', error: p.error };
  }
  if (declared && declared.command !== undefined) {
    return {
      type,
      command: null,
      commands: [],
      source: null,
      error: `${CONFIG_FILENAME}: test.command must be a non-empty string`,
    };
  }

  if (type === 'ios') {
    const commands = [
      xcodebuildCommand(repoPath, 'build'),
      xcodebuildCommand(repoPath, 'test'),
    ].filter(Boolean);
    return {
      type,
      command: commands.length ? commands[commands.length - 1] : null,
      commands,
      source: commands.length ? 'auto' : null,
      error: p.error,
    };
  }
  if (type === 'web') {
    return { type, command: 'npm test', commands: ['npm test'], source: 'auto', error: p.error };
  }
  return { type, command: null, commands: [], source: null, error: p.error };
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
  const probe = probeRepo(repoPath);
  if (probe.error) return { type: null, raw: null, error: probe.error };
  const raw = probe.raw;

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

module.exports = {
  loadDeployConfig,
  loadTestConfig,
  detectProjectType,
  resolveProjectType,
  isProjectType,
  readMarketingVersion,
  clearCache,
  CONFIG_FILENAME,
  PROJECT_TYPES,
  UNKNOWN_PROJECT_TYPE,
};
