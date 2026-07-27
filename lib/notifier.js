'use strict';

/**
 * Server-side push notifications (ntfy) — issue #27.
 *
 * Previously the only phone notification came from the Copilot CLI's own
 * `sessionEnd` hook, whose payload is just `{sessionId, cwd, reason}`. That can
 * only ever say "[repo] session complete", so a burst of Create PR / Deploy /
 * chat runs on the same repo produced several identical, useless pushes.
 *
 * The server, by contrast, knows exactly which job finished: its action, repo,
 * issue/PR number, chat title and outcome — the very same context the in-app
 * notifications (public/notify.js) already use. This module turns that context
 * into a push:
 *
 *   title  = task identity   ("Create PR · cloud-copilot#27")
 *   body   = what it was about + the key result (PR link / build / error line)
 *   tags   = ✅ / ❌ / ⚠️  so success vs. failure is obvious at a glance
 *   click  = deep link back into the app (repo card / PR page / that chat)
 *
 * Design rules:
 *   - Configuration is machine-local (`~/.config/cloud-copilot/notify.env` or
 *     env vars). Nothing — least of all a topic name — is hard-coded.
 *   - Unconfigured means silent: no push, no error, no log noise.
 *   - A push can never affect a job: everything is wrapped in try/catch with a
 *     10s timeout, and failures are logged only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SERVER = 'https://ntfy.sh';
const TIMEOUT_MS = 10000;
const DEDUP_MS = 60000; // same job key pushes at most once per minute

/** Machine-local config file; overridable for tests via an env var. */
function configFile() {
  return (
    process.env.CLOUD_COPILOT_NOTIFY_ENV ||
    path.join(os.homedir(), '.config', 'cloud-copilot', 'notify.env')
  );
}

// ---------------------------------------------------------------- config

/** Parse a trivial `KEY=value` env file (no shell expansion, `#` comments). */
function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

let cachedConfig = null;

function readConfigFile() {
  try {
    return parseEnvFile(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {}; // no file is the normal, silent case
  }
}

/**
 * Effective config. Real environment variables win over the config file so a
 * one-off `NTFY_TOPIC=... npm start` can override the machine default.
 */
function loadConfig() {
  if (cachedConfig) return cachedConfig;
  const file = readConfigFile();
  const pick = (key) => (process.env[key] != null && process.env[key] !== '' ? process.env[key] : file[key]);
  const topic = (pick('NTFY_TOPIC') || '').trim();
  const enabledRaw = (pick('NTFY_ENABLED') || '').trim().toLowerCase();
  const disabled = ['0', 'false', 'no', 'off'].includes(enabledRaw);
  cachedConfig = {
    enabled: Boolean(topic) && !disabled,
    server: (pick('NTFY_SERVER') || DEFAULT_SERVER).trim().replace(/\/+$/, ''),
    topic,
    token: (pick('NTFY_TOKEN') || '').trim(),
    // Absolute URL the phone can reach this app on, used for the tap-through
    // deep link. Without it the notification simply has no click action.
    baseUrl: (pick('APP_BASE_URL') || '').trim().replace(/\/+$/, ''),
  };
  return cachedConfig;
}

/** Drop the memoised config (tests, or after editing notify.env). */
function reloadConfig() {
  cachedConfig = null;
  return loadConfig();
}

// ------------------------------------------------------------- formatting

const ACTION_LABEL = {
  work: 'Create PR',
  deploy: 'Deploy',
  merge: 'Merge',
  chat: 'PR chat',
  admin: 'Admin chat',
  'admin-chat': 'Admin chat',
  'preissue-chat': 'Issue draft',
};

// Status → (emoji tag, human suffix, priority). ntfy renders a tag that matches
// an emoji shortcode in front of the title, so success/failure is visible even
// before reading the text.
// Priority is ntfy's numeric scale (1 min … 5 max) — the JSON publish API
// rejects the string aliases the HTTP-header API accepts.
const STATUS_STYLE = {
  success: { tag: 'white_check_mark', suffix: '', priority: 3 },
  failed: { tag: 'x', suffix: ' 失败', priority: 4 },
  aborted: { tag: 'warning', suffix: ' 已中断', priority: 2 },
  blocked: { tag: 'no_entry', suffix: ' 被阻止', priority: 3 },
  conflict: { tag: 'warning', suffix: ' 冲突', priority: 4 },
};

const clip = (s, n) => {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Copilot CLI's end-of-run stats footer — never part of the actual answer. */
const FOOTER_RE = /^(Total duration|Total cost|Changes\s|AI Credits\b|Tokens\b|Resume\b|Session\b|Wrap-up\b)/;
// Tool-call blocks are rendered with these box-drawing prefixes.
const TOOL_LINE_RE = /^[●│└┌├┤┬┴┼╭╮╰╯─━]/;

/**
 * Best-effort one-line summary of a Copilot run: the beginning of the final
 * prose answer, i.e. what comes after the last tool-call block and before the
 * stats footer. Used as the notification body for chat-style jobs.
 */
function summarizeTranscript(text, max = 140) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  // Drop the trailing stats footer (and any blank lines around it).
  let end = lines.length;
  while (end > 0) {
    const l = lines[end - 1].trim();
    if (!l || FOOTER_RE.test(l)) end -= 1;
    else break;
  }
  // Walk back to the end of the last tool-call block: everything after it is
  // the assistant's own prose.
  let start = end;
  while (start > 0) {
    const l = lines[start - 1].trim();
    if (TOOL_LINE_RE.test(l)) break;
    start -= 1;
  }
  const prose = [];
  let inFence = false;
  for (const raw of lines.slice(start, end)) {
    const l = raw.trim();
    if (l.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !l) continue;
    if (FOOTER_RE.test(l) || TOOL_LINE_RE.test(l)) continue;
    prose.push(l.replace(/\*\*/g, '').replace(/^[#>\-*]\s*/, ''));
    if (prose.join(' ').length >= max || prose.length >= 4) break;
  }
  return clip(prose.join(' '), max);
}

/** First meaningful line of an error/transcript, for failure bodies. */
function firstErrorLine(text, max = 140) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 200; i -= 1) {
    const l = lines[i].trim();
    if (!l || FOOTER_RE.test(l) || TOOL_LINE_RE.test(l)) continue;
    if (/error|failed|fatal|cannot|denied|conflict|exception/i.test(l)) return clip(l.replace(/\*\*/g, ''), max);
  }
  return '';
}

/** Where the job lives, in words: `repo#12`, `repo PR #34`, or a chat title. */
function scopeOf(info) {
  const action = info.action;
  if (action === 'admin' || action === 'admin-chat' || action === 'preissue-chat') {
    return clip(info.chatTitle || info.repo || 'all repos', 60);
  }
  // Create PR is identified by its ISSUE (the PR is a result, not the target);
  // deploy/merge/chat act on a PR.
  if (action === 'work' && info.issueNumber) return `${info.repo || ''}#${info.issueNumber}`.trim();
  if (info.prNumber) return `${info.repo || ''} PR #${info.prNumber}`.trim();
  if (info.issueNumber) return `${info.repo || ''}#${info.issueNumber}`;
  return info.repo || '';
}

/** Deep link back into the app for this job (needs APP_BASE_URL). */
function deepLink(info, baseUrl) {
  if (!baseUrl) return '';
  const enc = encodeURIComponent;
  if (info.action === 'admin' || info.action === 'admin-chat') {
    return info.chatId ? `${baseUrl}/#/chat/${enc(info.chatId)}` : `${baseUrl}/`;
  }
  if (info.action === 'preissue-chat') {
    return info.repo && info.preIssueId
      ? `${baseUrl}/#/preissue/${enc(info.repo)}/${enc(info.preIssueId)}`
      : `${baseUrl}/`;
  }
  if (info.repo && info.issueNumber && info.prNumber) {
    return `${baseUrl}/#/pr/${enc(info.repo)}/${info.issueNumber}/${info.prNumber}`;
  }
  return `${baseUrl}/`;
}

/**
 * Turn a finished job into an ntfy message.
 *
 * @param {object} info { action, status, repo, issueNumber, prNumber, prUrl,
 *   issueTitle, chatTitle, chatId, preIssueId, mode, summary, transcript,
 *   version, buildNumber, error }
 * @param {object} [opts] { baseUrl }
 * @returns {{title:string, message:string, tags:string[], priority:number, click:string}}
 */
function buildNotification(info, opts = {}) {
  const style = STATUS_STYLE[info.status] || { tag: 'grey_question', suffix: ` ${info.status || ''}`.trimEnd(), priority: 3 };
  const label = ACTION_LABEL[info.action] || info.action || 'Task';
  const scope = scopeOf(info);
  // e.g. "Create PR · cloud-copilot#27 失败", "Admin chat · 刷新页面后聊天新开了 tab"
  const title = `${label}${scope ? ` · ${scope}` : ''}${style.suffix}`;

  const lines = [];
  const isChat = ['chat', 'admin', 'admin-chat', 'preissue-chat'].includes(info.action);

  if (info.action === 'work' && info.issueTitle) lines.push(clip(info.issueTitle, 120));
  if (info.action === 'chat') {
    const prefix = info.mode === 'apply' ? '(apply)' : '(plan)';
    lines.push(clip(`${prefix} ${info.chatTitle || ''}`, 130));
  }

  const summary = info.summary || (isChat ? summarizeTranscript(info.transcript) : '');
  if (summary) lines.push(summary);

  if (info.status === 'success') {
    if (info.prUrl) lines.push(`PR #${info.prNumber}: ${info.prUrl}`);
    else if (info.prNumber && !isChat) lines.push(`PR #${info.prNumber}`);
    if (info.buildNumber) lines.push(`build ${info.version ? `${info.version} (${info.buildNumber})` : info.buildNumber}`);
  } else if (info.status !== 'aborted') {
    const err = info.error || firstErrorLine(info.transcript);
    if (err) lines.push(err);
  }

  if (!lines.length) {
    const what = { success: '完成', failed: '失败', aborted: '被中断', blocked: '被阻止', conflict: '有冲突' }[info.status] || info.status;
    lines.push(`${label} ${what}。`);
  }

  return {
    title,
    message: clip(lines.join('\n'), 500),
    tags: [style.tag],
    priority: style.priority,
    click: deepLink(info, opts.baseUrl || ''),
  };
}

// ------------------------------------------------------------------ send

const seen = new Map();

function alreadyPushed(key) {
  if (!key) return false;
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > DEDUP_MS) seen.delete(k);
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

/**
 * Publish one notification for a finished job. Never throws, never rejects.
 * Resolves to true only when ntfy accepted the message.
 *
 * @returns {Promise<boolean>}
 */
async function notifyJobFinished(info) {
  try {
    if (!info || !info.status) return false;
    const cfg = loadConfig();
    if (!cfg.enabled) return false; // unconfigured → silent, by design
    if (alreadyPushed(`${info.key || ''}|${info.status}`)) return false;

    const n = buildNotification(info, { baseUrl: cfg.baseUrl });
    const body = {
      topic: cfg.topic,
      title: n.title,
      message: n.message,
      tags: n.tags,
      priority: n.priority,
    };
    if (n.click) body.click = n.click;
    // A direct link to the PR on GitHub is the single most useful follow-up.
    if (info.prUrl) body.actions = [{ action: 'view', label: 'Open PR', url: info.prUrl, clear: true }];

    const headers = { 'Content-Type': 'application/json' };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

    const res = await fetch(cfg.server, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[notify] ntfy responded ${res.status} for "${n.title}"`);
      return false;
    }
    return true;
  } catch (err) {
    // Pushes are strictly best-effort: a dead network must never change a job.
    console.warn(`[notify] push failed: ${err.message}`);
    return false;
  }
}

module.exports = {
  configFile,
  loadConfig,
  reloadConfig,
  buildNotification,
  notifyJobFinished,
  summarizeTranscript,
  parseEnvFile,
};
