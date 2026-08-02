'use strict';

/**
 * Task-aware push notifications (issue #27).
 *
 * Every job that reaches a terminal state (done / failed / aborted) is turned
 * into ONE ntfy push that says *which task of which repo* finished, plus a
 * one-line summary of what it was about — instead of the old, useless
 * `[repo] session complete` the Copilot CLI `sessionEnd` hook produced (that
 * hook only ever sees `{sessionId, cwd, reason}`, so it cannot tell a Create PR
 * from a Deploy from a chat turn).
 *
 * Design notes:
 *   - Same source of truth as the in-app notifications (`public/notify.js`):
 *     the job's `meta` + the `result` payload its `onDone` returned.
 *   - Publishing uses ntfy's JSON API (POST to the server root) rather than the
 *     header-based one, because titles routinely contain non-ASCII text (chat
 *     titles are usually Chinese) and HTTP headers are latin-1 only.
 *   - Never throws, never blocks a job: 10s timeout, everything try/caught,
 *     failures are logged and dropped.
 *   - Unconfigured (no topic) => silently does nothing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEDUP_MS = 60000; // same job key pushes at most once per minute
const TIMEOUT_MS = 10000;
const SUMMARY_MAX = 140;
const TITLE_MAX = 120;

const CONFIG_FILE =
  process.env.CLOUD_COPILOT_NOTIFY_ENV ||
  path.join(os.homedir(), '.config', 'cloud-copilot', 'notify.env');

const ACTION_LABEL = {
  work: 'Create PR',
  deploy: 'Deploy',
  merge: 'Merge',
  update: '同步 base 分支',
  review: 'Review 并改进',
  chat: 'PR chat',
  admin: 'Admin chat',
  'preissue-chat': 'Issue draft',
};

// ntfy renders these as the emoji prefix of the notification title.
const STATUS_TAG = {
  success: 'white_check_mark',
  failed: 'x',
  aborted: 'warning',
  conflict: 'warning',
};

const STATUS_SUFFIX = {
  success: '',
  failed: ' 失败',
  aborted: ' 已中断',
  conflict: ' 有冲突',
};

// ---------------------------------------------------------------------------
// Config: env vars win, then ~/.config/cloud-copilot/notify.env (same place as
// deploy.env). Nothing is ever hard-coded — no topic means no pushes.
// ---------------------------------------------------------------------------

let cached = null;
let cachedMtime = 0;

/** Minimal `KEY=value` reader (no shell expansion, quotes stripped). */
function readEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadConfig() {
  let mtime = 0;
  try {
    mtime = fs.statSync(CONFIG_FILE).mtimeMs;
  } catch {
    mtime = 0;
  }
  // Re-read when the file changed so editing it doesn't need a restart.
  if (cached && mtime === cachedMtime) return cached;

  const file = readEnvFile(CONFIG_FILE);
  const pick = (key) =>
    process.env[key] !== undefined && process.env[key] !== '' ? process.env[key] : file[key];

  const topic = (pick('NTFY_TOPIC') || '').trim();
  const enabled = String(pick('NTFY_ENABLED') ?? '1') !== '0';
  cached = {
    enabled: enabled && Boolean(topic),
    topic,
    server: (pick('NTFY_SERVER') || 'https://ntfy.sh').trim().replace(/\/+$/, ''),
    token: (pick('NTFY_TOKEN') || '').trim(),
    // Base URL of this cloud-copilot instance, used for the tap-through link.
    appBaseUrl: (pick('APP_BASE_URL') || '').trim().replace(/\/+$/, ''),
    configFile: CONFIG_FILE,
  };
  cachedMtime = mtime;
  return cached;
}

/** Public, secret-free view of the current config (for the settings UI). */
function status() {
  const cfg = loadConfig();
  return {
    enabled: cfg.enabled,
    server: cfg.server,
    topic: cfg.topic ? `${cfg.topic.slice(0, 3)}…${cfg.topic.slice(-2)}` : null,
    hasToken: Boolean(cfg.token),
    appBaseUrl: cfg.appBaseUrl || null,
    configFile: cfg.configFile,
  };
}

// ---------------------------------------------------------------------------
// Transcript summarising
// ---------------------------------------------------------------------------

// Copilot CLI tool-call log decorations; never useful in a push body.
const TOOL_LINE_RE = /^\s*[●│└⎿✔✗»]/;
const FOOTER_LINE_RE = /^(Changes|AI Credits|Tokens|Resume)\b/;

function truncate(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One-line gist of a run: the last paragraph of prose the agent produced,
 * with the CLI's own `Changes / AI Credits / Tokens / Resume` footer and the
 * tool-call log lines stripped out.
 */
function summarize(conversation, max = SUMMARY_MAX) {
  const lines = String(conversation || '')
    .replace(/\r/g, '')
    .split('\n');
  // Drop the trailing footer block.
  let end = lines.length - 1;
  while (end >= 0 && (lines[end].trim() === '' || FOOTER_LINE_RE.test(lines[end].trim()))) end -= 1;
  // Collect the last contiguous run of prose lines.
  const paragraph = [];
  for (let i = end; i >= 0 && paragraph.length < 12; i -= 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      if (paragraph.length) break;
      continue;
    }
    if (TOOL_LINE_RE.test(line)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.unshift(trimmed);
  }
  const text = paragraph
    .join(' ')
    .replace(/^#+\s*/, '')
    // Drop markdown emphasis/code decoration, but never underscores — those are
    // usually part of an identifier (CLOUD_COPILOT_JOB, file_name.js).
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(text, max);
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------

function quoted(title) {
  return `「${truncate(title, 48)}」`;
}

/** Where tapping the notification should land in the web app. */
function clickUrl(cfg, meta, result) {
  if (!cfg.appBaseUrl) return null;
  const enc = encodeURIComponent;
  const repo = meta.repo;
  const issueNumber = meta.issueNumber;
  const prNumber = result.prNumber || meta.prNumber;
  if (meta.action === 'admin') {
    const id = result.sessionId || meta.sessionId;
    return id ? `${cfg.appBaseUrl}/#/admin/chat/${enc(id)}` : `${cfg.appBaseUrl}/#/admin`;
  }
  if (meta.action === 'preissue-chat' && repo && meta.id) {
    return `${cfg.appBaseUrl}/#/preissue/${enc(repo)}/${enc(meta.id)}`;
  }
  if (repo && issueNumber && prNumber) {
    return `${cfg.appBaseUrl}/#/pr/${enc(repo)}/${issueNumber}/${prNumber}`;
  }
  return `${cfg.appBaseUrl}/`;
}

/**
 * Turn a finished job into `{title, message, tags, priority, click}`.
 * Exported for tests / the settings preview.
 */
function buildNotification(job, cfg = loadConfig()) {
  const meta = job.meta || {};
  const result = job.result || {};
  const status = result.status || (job.cancelled ? 'aborted' : job.exitCode === 0 ? 'success' : 'failed');
  const action = meta.action || result.action || 'task';
  const label = ACTION_LABEL[action] || action;
  const repo = meta.repo || '';
  const issueNumber = meta.issueNumber;
  const prNumber = result.prNumber || meta.prNumber;

  // ---- title: "<action> · <where>[ · 「chat title」][ 失败]" ----------------
  // Create PR is identified by the issue it implements (the PR doesn't exist
  // yet when it starts); everything else by the PR it operates on.
  let where = repo;
  if (repo && action === 'work' && issueNumber) where = `${repo}#${issueNumber}`;
  else if (repo && prNumber) where = `${repo} PR #${prNumber}`;
  else if (repo && issueNumber) where = `${repo}#${issueNumber}`;
  const parts = [label];
  if (where) parts.push(where);
  if (meta.chatTitle) parts.push(quoted(meta.chatTitle));
  // A run nobody asked for has to say so, or an unexpected push at 3am looks
  // like someone else is using the machine.
  const autoPrefix = meta.auto ? '自动 · ' : '';
  const title = truncate(`${autoPrefix}${parts.join(' · ')}${STATUS_SUFFIX[status] || ''}`, TITLE_MAX);

  // ---- body: what this task was about + the key result ---------------------
  const body = [];
  if (meta.subject) body.push(truncate(meta.subject, SUMMARY_MAX));
  if (typeof meta.sequence === 'number' && meta.sequence > 1) {
    body.push(`本 repo 第 ${meta.sequence} 个 ${label}`);
  }
  const gist = summarize(job.conversation);
  if (gist && gist !== body[0]) body.push(gist);
  if (status === 'success' && result.prUrl && !body.some((l) => l.includes(result.prUrl))) {
    body.push(result.prUrl);
  }
  if (status === 'success' && result.buildNumber) {
    body.push(`build ${result.version ? `${result.version} (${result.buildNumber})` : result.buildNumber}`);
  }
  if (result.recoveryMessage) body.push(result.recoveryMessage);
  if (status !== 'success') {
    const why = result.error || (job.exitCode != null ? `exit code ${job.exitCode}` : null);
    if (why) body.push(String(why).split('\n')[0]);
  }
  if (!body.length) body.push(`${label} ${status}`);

  return {
    title,
    message: body.join('\n'),
    tags: [STATUS_TAG[status] || 'robot'],
    priority: status === 'failed' ? 4 : 3,
    click: clickUrl(cfg, meta, result) || undefined,
    status,
  };
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

const seen = new Map();

function alreadyPushed(key) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > DEDUP_MS) seen.delete(k);
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

/** POST one message to ntfy. Resolves `{ok, error?}` — never rejects. */
async function publish({ title, message, tags, priority, click }) {
  const cfg = loadConfig();
  if (!cfg.enabled) return { ok: false, skipped: true, error: 'ntfy not configured' };
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const payload = { topic: cfg.topic, title, message, tags, priority };
  if (click) payload.click = click;

  try {
    const res = await fetch(`${cfg.server}/`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const error = `ntfy responded ${res.status} ${truncate(text, 120)}`;
      console.warn(`[notify] ${error}`);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[notify] push failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Announce a job that just reached a terminal state. Fire-and-forget: callers
 * must not await it and it can never reject.
 * @param {{key:string, meta:object, result:object, conversation:string,
 *          exitCode:number|null, cancelled:boolean}} job
 */
function jobFinished(job) {
  try {
    const cfg = loadConfig();
    if (!cfg.enabled) return;
    if (job.meta && job.meta.notify === false) return;
    if (alreadyPushed(job.key || JSON.stringify(job.meta || {}))) return;
    const note = buildNotification(job, cfg);
    publish(note); // fire and forget; publish() swallows its own errors
  } catch (err) {
    console.warn(`[notify] could not build notification: ${err.message}`);
  }
}

/** "Send a test push" — same formatting path, bypassing de-dup. */
async function sendTest() {
  const cfg = loadConfig();
  if (!cfg.enabled) return { ok: false, skipped: true, error: 'ntfy not configured' };
  return publish({
    title: 'cloud-copilot · 测试通知',
    message: '推送已配置好。任务完成时你会收到这样一条带任务标识的通知。',
    tags: ['white_check_mark'],
    priority: 3,
    click: cfg.appBaseUrl ? `${cfg.appBaseUrl}/` : undefined,
  });
}

module.exports = { jobFinished, buildNotification, summarize, publish, sendTest, status, loadConfig };
