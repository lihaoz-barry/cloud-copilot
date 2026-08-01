'use strict';

/**
 * The daily summary of what the scheduler did while you weren't looking.
 *
 * Written to `data/reports/<date>.json` (structured, for the panel) and
 * `.md` (for humans and for anything else that wants to read it). Optionally
 * emailed. Old reports are pruned on the way out.
 */

const fs = require('fs');
const path = require('path');

const queue = require('./queue');
const config = require('./queueConfig');
const mailer = require('./mailer');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REPORTS_DIR = process.env.CC_REPORTS_DIR || path.join(DATA_DIR, 'reports');

const STATUS_ICON = {
  success: '✅',
  failed: '❌',
  skipped: '⏭',
  cancelled: '⛔',
  interrupted: '⚠️',
};

function ensureDir() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  return `${Math.floor(totalMin / 60)}h${String(totalMin % 60).padStart(2, '0')}m`;
}

/** One line describing what happened to a task. */
function describeTask(t) {
  const icon = STATUS_ICON[t.status] || '•';
  const label = t.title || (t.issueNumber ? `#${t.issueNumber}` : t.type);
  const bits = [];
  if (t.prNumber) bits.push(`→ PR #${t.prNumber}`);
  if (t.durationMs) bits.push(formatDuration(t.durationMs));
  if (t.status !== 'success' && t.error) bits.push(t.error);
  return `${icon} ${label}${bits.length ? '  ' + bits.join('  ') : ''}`;
}

/**
 * Build the report structure for the window ending now.
 * @param {object} opts { sinceIso, date }
 */
function build({ sinceIso, date } = {}) {
  const since = sinceIso || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const tasks = queue.finishedSince(since);

  const counts = { success: 0, failed: 0, skipped: 0, cancelled: 0, interrupted: 0 };
  let totalMs = 0;
  const byRepo = {};

  for (const t of tasks) {
    if (counts[t.status] === undefined) counts[t.status] = 0;
    counts[t.status]++;
    totalMs += t.durationMs || 0;
    if (!byRepo[t.repo]) byRepo[t.repo] = [];
    byRepo[t.repo].push({
      id: t.id,
      type: t.type,
      status: t.status,
      title: t.title,
      issueNumber: t.issueNumber,
      prNumber: t.prNumber,
      prUrl: t.prUrl,
      durationMs: t.durationMs,
      error: t.error,
      finishedAt: t.finishedAt,
    });
  }

  const summary = queue.summary();
  const needsAttention = tasks
    .filter((t) => t.status === 'failed')
    .map((t) => ({ repo: t.repo, title: t.title || t.type, error: t.error }));

  return {
    version: 1,
    date: date || queue.localDateKey(),
    generatedAt: new Date().toISOString(),
    since,
    total: tasks.length,
    counts,
    totalMs,
    byRepo,
    pending: summary.pending,
    needsAttention,
  };
}

/** The human-readable form — also the email body. */
function renderMarkdown(r) {
  const lines = [];
  lines.push(`# 📊 cloud-copilot 日报 · ${r.date}`);
  lines.push('');

  if (!r.total) {
    lines.push('过去 24 小时没有任务执行。');
    lines.push('');
    lines.push(`⏳ 队列中还有 ${r.pending} 个待办`);
    return lines.join('\n');
  }

  const c = r.counts;
  lines.push(
    `跑完 ${r.total} 个任务 · ✅ ${c.success || 0}  ❌ ${c.failed || 0}  ⏭ ${c.skipped || 0}` +
      `${c.cancelled ? `  ⛔ ${c.cancelled}` : ''}` +
      `　　用时合计 ${formatDuration(r.totalMs)}`,
  );
  lines.push('');

  for (const [repo, tasks] of Object.entries(r.byRepo)) {
    lines.push(`## ${repo}`);
    for (const t of tasks) lines.push(`- ${describeTask(t)}`);
    lines.push('');
  }

  lines.push(`⏳ 队列中还有 ${r.pending} 个待办`);
  if (r.needsAttention.length) {
    lines.push('');
    lines.push('⚠️ 需要你看一下(已停在 cooldown,面板可重试):');
    for (const n of r.needsAttention) lines.push(`- **${n.repo}** ${n.title} — ${n.error || '失败'}`);
  }
  return lines.join('\n');
}

function pathsFor(date) {
  return {
    json: path.join(REPORTS_DIR, `${date}.json`),
    md: path.join(REPORTS_DIR, `${date}.md`),
  };
}

function write(report) {
  ensureDir();
  const p = pathsFor(report.date);
  fs.writeFileSync(p.json, JSON.stringify(report, null, 2));
  fs.writeFileSync(p.md, renderMarkdown(report));
  return p;
}

/** Delete reports older than the configured retention window. */
function pruneOld(retentionDays = config.get().reportRetentionDays) {
  ensureDir();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const f of fs.readdirSync(REPORTS_DIR)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.(json|md)$/.exec(f);
    if (!m) continue;
    if (new Date(`${m[1]}T23:59:59`).getTime() < cutoff) {
      try {
        fs.unlinkSync(path.join(REPORTS_DIR, f));
        removed++;
      } catch {
        /* already gone */
      }
    }
  }
  return removed;
}

function list() {
  ensureDir();
  return fs
    .readdirSync(REPORTS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
    .reverse();
}

function read(date) {
  const p = pathsFor(date);
  try {
    const json = JSON.parse(fs.readFileSync(p.json, 'utf8'));
    let markdown = '';
    try {
      markdown = fs.readFileSync(p.md, 'utf8');
    } catch {
      markdown = renderMarkdown(json);
    }
    return { ...json, markdown };
  } catch {
    return null;
  }
}

/**
 * Generate, persist, prune, and (if configured) email. Email failures are
 * reported but never propagate — the report is already safely on disk.
 */
async function generateAndDeliver(opts = {}) {
  const report = build(opts);
  write(report);
  pruneOld();

  let mail = { ok: false, skipped: 'not configured' };
  if (mailer.isConfigured()) {
    mail = await mailer.send({
      subject: `cloud-copilot 日报 ${report.date} · ✅${report.counts.success || 0} ❌${report.counts.failed || 0}`,
      text: renderMarkdown(report),
    });
  }
  return { report, mail };
}

module.exports = {
  REPORTS_DIR,
  build,
  renderMarkdown,
  describeTask,
  formatDuration,
  write,
  pruneOld,
  list,
  read,
  generateAndDeliver,
};
