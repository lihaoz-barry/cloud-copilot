'use strict';

/**
 * Task-queue configuration — `data/queue-config.json`.
 *
 * Separate from `.cloud-copilot.json` (which is per-repo, git-tracked, and
 * describes how to *deploy* that repo). This one is machine-local, edited from
 * the Settings panel, and holds an email token — `data/` is gitignored, so the
 * token never gets committed.
 *
 * Repos default to ENABLED: a repo absent from `repos` is scanned using
 * `defaultLabels`. Only repos you've explicitly toggled get an entry.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
// Overridable so tests get an isolated file.
const CONFIG_FILE = process.env.CC_QUEUE_CONFIG || path.join(DATA_DIR, 'queue-config.json');

const DEFAULTS = {
  version: 1,
  enabled: true, // master switch for the whole scheduler
  scanIntervalMinutes: 30, // how often to look for newly-labelled issues
  syncAt: '03:00', // daily "is every PR branch up to date with main?" sweep
  reportAt: '08:00', // daily summary
  reportRetentionDays: 30,
  defaultLabels: ['committed'], // an issue needs ANY one of these to be queued
  taskTimeoutMinutes: 60, // kill a Copilot run that has hung
  worktreeRoot: '~/.cloud-copilot/worktrees',
  email: { enabled: false, provider: 'resend', token: '', from: '', to: '' },
  repos: {}, // { "<repo>": { enabled, labels, paused } } — overrides only
};

const REPO_DEFAULTS = { enabled: true, labels: null, paused: false };

let cached = null;
let cachedMtimeMs = 0;

function ensureDir() {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      ...DEFAULTS,
      ...parsed,
      email: { ...DEFAULTS.email, ...(parsed.email || {}) },
      repos: parsed.repos && typeof parsed.repos === 'object' ? parsed.repos : {},
    };
  } catch {
    // Missing or corrupt → defaults. A broken config must not stop the queue.
    return { ...DEFAULTS, email: { ...DEFAULTS.email }, repos: {} };
  }
}

/** Config, re-read whenever the file changes underneath us (hand edits count). */
function get() {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(CONFIG_FILE).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (!cached || mtimeMs !== cachedMtimeMs) {
    cached = readFile();
    cachedMtimeMs = mtimeMs;
  }
  return cached;
}

function save(cfg) {
  ensureDir();
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
  cached = cfg;
  try {
    cachedMtimeMs = fs.statSync(CONFIG_FILE).mtimeMs;
  } catch {
    cachedMtimeMs = 0;
  }
  return cfg;
}

/** Effective settings for one repo, with the absent-means-enabled default. */
function repoSettings(name) {
  const cfg = get();
  const o = cfg.repos[name] || {};
  return {
    enabled: o.enabled ?? REPO_DEFAULTS.enabled,
    paused: o.paused ?? REPO_DEFAULTS.paused,
    labels: Array.isArray(o.labels) && o.labels.length ? o.labels : cfg.defaultLabels,
  };
}

/** Should this repo's worker pick up work right now? */
function repoActive(name) {
  if (!get().enabled) return false;
  const r = repoSettings(name);
  return r.enabled && !r.paused;
}

function setRepo(name, patch) {
  const cfg = get();
  return save({
    ...cfg,
    repos: { ...cfg.repos, [name]: { ...(cfg.repos[name] || {}), ...patch } },
  });
}

/**
 * Merge a partial update from the Settings panel. An empty-string token means
 * "leave the stored one alone" — the UI never sees the real value, so it can't
 * echo it back.
 */
function update(patch) {
  const cfg = get();
  const next = { ...cfg, ...patch, version: DEFAULTS.version };
  if (patch.email) {
    next.email = { ...cfg.email, ...patch.email };
    if (!patch.email.token) next.email.token = cfg.email.token;
  }
  if (patch.repos) next.repos = { ...cfg.repos, ...patch.repos };
  return save(next);
}

/** Config safe to hand to the browser — the token itself is never sent out. */
function redacted() {
  const cfg = get();
  return {
    ...cfg,
    email: {
      ...cfg.email,
      token: cfg.email.token ? '••••••••' : '',
      hasToken: Boolean(cfg.email.token),
    },
  };
}

/** Absolute worktree root, with `~` expanded. */
function worktreeRoot() {
  const raw = get().worktreeRoot || DEFAULTS.worktreeRoot;
  return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : path.resolve(raw);
}

/** "HH:MM" → minutes since local midnight, or null if malformed. */
function parseTimeOfDay(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

module.exports = {
  CONFIG_FILE,
  DEFAULTS,
  get,
  save,
  update,
  setRepo,
  repoSettings,
  repoActive,
  redacted,
  worktreeRoot,
  parseTimeOfDay,
};
