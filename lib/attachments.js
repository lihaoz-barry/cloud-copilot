'use strict';

/**
 * Image attachment support for chat turns (Admin Terminal + per-PR chat).
 *
 * The browser sends attached images as base64 data URLs in the JSON POST
 * body; we decode them to disk under data/uploads/ so they can be:
 *   - passed to `copilot -p` via `--attachment <path>` for that turn, and
 *   - served back to the browser (via /uploads/<file>) so past conversations
 *     still show the thumbnail when the transcript is reloaded.
 *
 * Files are swept on a retention window (not deleted the instant the turn
 * ends) so reloaded history still has something to point at, while disk
 * usage stays bounded over time.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOADS_DIR = path.join(process.env.CC_DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads');

const MAX_IMAGES_PER_TURN = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB per image, generous for phone photos/screenshots
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // keep uploads around for a week, then sweep

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/;

function ensureDir() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/**
 * Decode an array of `{ name, dataUrl }` image attachments from the client,
 * write each one to disk, and return metadata for both the copilot CLI
 * invocation (`path`, for --attachment) and the persisted transcript
 * (`url`, for redisplay). Invalid/oversized/non-image entries are skipped
 * silently rather than failing the whole turn.
 */
function saveUploadedImages(images) {
  if (!Array.isArray(images) || !images.length) return [];
  ensureDir();
  const saved = [];
  for (const img of images.slice(0, MAX_IMAGES_PER_TURN)) {
    const dataUrl = img && typeof img.dataUrl === 'string' ? img.dataUrl : '';
    const match = DATA_URL_RE.exec(dataUrl);
    if (!match) continue;
    const mimeType = match[1].toLowerCase();
    const buf = Buffer.from(match[2], 'base64');
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) continue;
    const ext = EXT_BY_MIME[mimeType] || '.png';
    const filename = `${Date.now()}-${crypto.randomUUID()}${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filePath, buf);
    saved.push({
      path: filePath,
      url: `/uploads/${filename}`,
      name: (img.name && String(img.name).slice(0, 200)) || filename,
      mimeType,
    });
  }
  return saved;
}

/** Delete uploaded images past the retention window so disk usage doesn't grow unbounded. */
function cleanupOldUploads() {
  let entries;
  try {
    entries = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true });
  } catch {
    return; // directory doesn't exist yet — nothing to clean
  }
  const now = Date.now();
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const filePath = path.join(UPLOADS_DIR, ent.name);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > RETENTION_MS) fs.unlinkSync(filePath);
    } catch {
      /* best-effort cleanup — ignore races with concurrent deletes */
    }
  }
}

module.exports = {
  UPLOADS_DIR,
  MAX_IMAGES_PER_TURN,
  saveUploadedImages,
  cleanupOldUploads,
};
