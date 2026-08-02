'use strict';

/**
 * L2 cache: the `gh` CLI results (issue list + whole-repo PR list) persisted to
 * a JSON file so they survive a server restart.
 *
 * The three tiers the dashboard reads through:
 *
 *   L1  browser localStorage    TTL 15m   0ms     — renders instantly on expand
 *   L2  this file (+ memory)    TTL 15m   ~5ms    — survives restarts, refreshed hourly
 *   L3  `gh` CLI                 —        800ms+  — only on L2 miss or a forced refresh
 *
 * Kept separate from store.js on purpose: state.json is the source of truth for
 * job lifecycle and must never be lost, whereas this file is pure acceleration.
 * Every read/write failure here is swallowed — a broken cache must degrade to a
 * live `gh` call, never to an error.
 *
 * Shape:
 *   {
 *     "version": 1,
 *     "repos": {
 *       "owner/repo": {
 *         "issues": { "at": <epoch ms>, "data": [ ... ] },
 *         "prs":    { "at": <epoch ms>, "data": [ ... ] }
 *       }
 *     }
 *   }
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CC_DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'gh-cache.json');
const VERSION = 1;

// Shared by L1 (browser) and L2 (here) so "fresh" means the same thing on both
// sides and the UI's countdown matches what the server actually does.
const TTL_MS = Number(process.env.GH_CACHE_TTL_MS || 15 * 60 * 1000);

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function emptyState() {
  return { version: VERSION, repos: {} };
}

// In-memory mirror of the file. Loaded once at startup; every write updates
// both this and the file, so reads never touch the disk.
let state = emptyState();
let loaded = false;

/**
 * Read the cache file into memory. Called once at server startup — after this,
 * the very first request following a restart is already a cache hit instead of
 * a cold `gh` call. Returns a small summary for the startup log.
 */
function load() {
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    // A version bump means the shape changed — drop the old file rather than
    // trying to migrate a cache we can always rebuild from GitHub.
    if (!raw || raw.version !== VERSION || typeof raw.repos !== 'object') {
      state = emptyState();
      return { repos: 0, restored: false };
    }
    state = { version: VERSION, repos: raw.repos || {} };
    return { repos: Object.keys(state.repos).length, restored: true };
  } catch {
    state = emptyState();
    return { repos: 0, restored: false };
  }
}

// Atomic write (tmp + rename), same approach store.js uses. Failures are
// logged once and otherwise ignored: the in-memory copy is still correct, so
// the only cost is a cold start after the next restart.
let writeWarned = false;
function persist() {
  try {
    ensureDir();
    const tmp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, CACHE_FILE);
    writeWarned = false;
  } catch (err) {
    if (!writeWarned) {
      writeWarned = true;
      console.warn(`[gh-cache] could not persist (${err.message}) — continuing with memory only`);
    }
  }
}

/**
 * Cached entry for one repo + kind ('issues' | 'prs'), or null if absent.
 * Always returns the entry even when stale — callers decide via `fresh`,
 * so a failed refresh can still fall back to stale-but-useful data.
 */
function get(ownerRepo, kind) {
  if (!loaded) load();
  const entry = state.repos[ownerRepo] && state.repos[ownerRepo][kind];
  if (!entry || !Array.isArray(entry.data)) return null;
  return { at: entry.at, data: entry.data, fresh: Date.now() - entry.at < TTL_MS };
}

function set(ownerRepo, kind, data, at = Date.now()) {
  if (!loaded) load();
  if (!state.repos[ownerRepo]) state.repos[ownerRepo] = {};
  state.repos[ownerRepo][kind] = { at, data };
  persist();
  return at;
}

/**
 * Oldest `at` across both kinds for a repo — the timestamp the UI shows as
 * "server synced N minutes ago". Using the oldest (not newest) means the pill
 * never claims the data is fresher than its stalest half.
 */
function syncedAt(ownerRepo) {
  if (!loaded) load();
  const repo = state.repos[ownerRepo];
  if (!repo) return null;
  const times = ['issues', 'prs'].map((k) => repo[k] && repo[k].at).filter((t) => typeof t === 'number');
  return times.length ? Math.min(...times) : null;
}

/** Drop a repo's cached entry (or one kind of it) after a mutation. */
function invalidate(ownerRepo, kind = null) {
  if (!loaded) load();
  const repo = state.repos[ownerRepo];
  if (!repo) return false;
  if (kind) {
    if (!repo[kind]) return false;
    delete repo[kind];
  } else {
    delete state.repos[ownerRepo];
  }
  persist();
  return true;
}

module.exports = { TTL_MS, CACHE_FILE, load, get, set, invalidate, syncedAt };
