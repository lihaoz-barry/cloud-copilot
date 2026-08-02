'use strict';

/**
 * "What to Test" changelog builder for the ios-testflight deploy path.
 *
 * The text produced here is what TestFlight testers actually read next to a
 * build, so it has to be one short Chinese sentence describing the change —
 * not the raw PR title, which in practice is often English, carries a
 * `feat:` prefix, and repeats the `(closes #N)` reference.
 *
 * Two layers:
 *   1. `normalizeTitle()` — deterministic cleanup that always runs.
 *   2. `translateToChinese()` — one short, timeout-bounded headless Copilot
 *      call, used only when the cleaned title still isn't Chinese. It is
 *      best-effort: any failure falls back to layer 1 rather than blocking
 *      or failing the deploy.
 *
 * Everything returned is passed through `shellSafe()` last, because the final
 * string is interpolated into `fastlane beta changelog:'...'` — the PR title
 * comes from GitHub and Copilot's reply is model output; neither is trusted.
 */

const { execFile } = require('child_process');

// TestFlight shows the note in a narrow column; one sentence is the target.
const MAX_LEN = 40;

// Model used for the translation hop. Deliberately a small, fast one — this
// runs inline before the deploy starts, so latency is user-visible.
const TRANSLATE_MODEL = process.env.CHANGELOG_MODEL || 'claude-haiku-4.5';
const TRANSLATE_TIMEOUT_MS = Number(process.env.CHANGELOG_TIMEOUT_MS || 60000);

// Conventional-commit prefix: `feat:`, `fix(ui)!:`, `docs：` (full-width colon).
const PREFIX_RE =
  /^\s*(?:build|chore|ci|docs|feat|feature|fix|perf|refactor|revert|style|test)(?:\([^)]*\))?!?\s*[:：]\s*/i;
// Issue references anywhere in the title: "(closes #79)", "closes #79", "fixes #79".
const ISSUE_REF_RE = /[（(]?\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*#\d+\s*[)）]?/gi;
// A bare trailing "#79" / "(#79)" left over from a squash-merge title.
const TRAILING_HASH_RE = /\s*[（(]?#\d+[)）]?\s*$/;

// Counting regexes are global; the membership test deliberately is NOT —
// a /g regex reused across `.test()` calls carries `lastIndex` between them.
const HAN_G_RE = /[㐀-䶿一-鿿]/g;
const LATIN_G_RE = /[A-Za-z]/g;
const HAN_RE = /[㐀-䶿一-鿿]/;

/** Characters that would break out of the single-quoted `changelog:'...'` arg. */
function shellSafe(text) {
  return text.replace(/['"`$\\]/g, '').replace(/\s+/g, ' ').trim();
}

/** Does the text contain any Chinese at all? */
function hasHan(text) {
  return HAN_RE.test(text);
}

/**
 * Is this already a Chinese note? A stray Latin product name ("Cook Now",
 * "OpenAI Whisper") is fine; a full English sentence is not. Used to decide
 * whether a title needs translating — NOT to grade the translation, which is
 * checked with the looser `hasHan()` (a note like "接入 Xcode Cloud 到 CI/CD"
 * is a perfectly good result that this stricter test would reject).
 */
function isMostlyChinese(text) {
  const han = (text.match(HAN_G_RE) || []).length;
  const latin = (text.match(LATIN_G_RE) || []).length;
  return han > 0 && han >= latin;
}

/**
 * Bilingual titles in these repos are written "中文 / English" (or the
 * reverse). Ship only the Chinese half so testers get one clean sentence
 * instead of the same thing twice.
 */
function pickChineseHalf(text) {
  const parts = text.split(/\s+[/|｜]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return text;
  const han = parts.filter(hasHan);
  return han.length && han.length < parts.length ? han.join(' ') : text;
}

/** Cut to one line's worth of text, marking the cut so it doesn't read as a typo. */
function truncate(text, max = MAX_LEN) {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * Deterministic cleanup of a PR title: drop shell-unsafe characters, issue
 * references and commit-type prefixes, keep the Chinese half of a bilingual
 * title. Returns '' when nothing usable is left.
 */
function normalizeTitle(raw) {
  let text = shellSafe(String(raw || ''));
  text = text.replace(ISSUE_REF_RE, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(PREFIX_RE, '');
  text = pickChineseHalf(text);
  text = text.replace(TRAILING_HASH_RE, '');
  return text.replace(/\s+/g, ' ').trim();
}

/** Note used when a build has no usable title to describe it. */
function fallbackNote(version, buildNumber) {
  const v = version ? `v${version} ` : '';
  return `${v}构建 ${buildNumber}（暂无变更说明）`;
}

// The CLI prints its own chrome (credits, resume hint) around the reply, so we
// ask for a marker line and read that back rather than guessing at the shape.
const MARKER = 'WHAT_TO_TEST:';
const MARKER_RE = /^\s*WHAT_TO_TEST:\s*(.+)$/gm;

/**
 * Ask Copilot for a short Chinese rendering of `text`. Resolves to null on any
 * failure (missing binary, non-zero exit, timeout, unparseable reply) — the
 * caller then keeps the deterministic text.
 */
function translateToChinese(text, { bin, model = TRANSLATE_MODEL, timeoutMs = TRANSLATE_TIMEOUT_MS } = {}) {
  const prompt =
    `Rewrite the following iOS release note as ONE short sentence in Simplified Chinese, ` +
    `at most ${MAX_LEN} characters, describing what changed for a TestFlight tester. ` +
    `Keep product/brand names as-is. No issue numbers, no commit-type prefixes, no quotes, ` +
    `no trailing period. Answer with exactly one line starting with "${MARKER}" and nothing ` +
    `else.\n\nInput: ${text}`;
  return new Promise((resolve) => {
    execFile(
      bin,
      ['-p', prompt, '--model', model],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        // Last match wins: the model may restate the instruction before answering.
        let answer = null;
        for (const m of String(stdout || '').matchAll(MARKER_RE)) answer = m[1];
        if (!answer) return resolve(null);
        const cleaned = shellSafe(answer);
        resolve(hasHan(cleaned) ? truncate(cleaned) : null);
      },
    );
  });
}

/**
 * Build the "What to Test" note for a build: normalize the PR title, translate
 * it if it still isn't Chinese, and truncate. `copilotBin` is optional — omit
 * it (or let the call fail) and the deterministic result is used as-is.
 */
async function resolveChangelog({ pr, version, buildNumber, copilotBin, model, timeoutMs }) {
  const normalized = truncate(normalizeTitle(pr && pr.title));
  if (!normalized) return shellSafe(fallbackNote(version, buildNumber));
  if (isMostlyChinese(normalized) || !copilotBin) return normalized;
  const translated = await translateToChinese(normalized, { bin: copilotBin, model, timeoutMs });
  return translated || normalized;
}

module.exports = {
  MAX_LEN,
  TRANSLATE_MODEL,
  shellSafe,
  hasHan,
  isMostlyChinese,
  pickChineseHalf,
  truncate,
  normalizeTitle,
  fallbackNote,
  translateToChinese,
  resolveChangelog,
};
