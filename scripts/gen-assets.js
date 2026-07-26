#!/usr/bin/env node
'use strict';

/**
 * Regenerates the small binary assets used by the completion-notification
 * feature (issue #15):
 *
 *   public/sounds/success.wav   short ascending chime
 *   public/sounds/failure.wav   short descending chime
 *   public/icons/icon-192.png   PWA icon (required for iOS Home Screen install)
 *   public/icons/icon-512.png
 *
 * The outputs are committed, so this script only needs to be re-run when the
 * chimes or the icon design change:  `node scripts/gen-assets.js`
 *
 * Deliberately dependency-free (no canvas / no audio library) so it runs on a
 * bare `node` with nothing installed.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SOUNDS_DIR = path.join(ROOT, 'public', 'sounds');
const ICONS_DIR = path.join(ROOT, 'public', 'icons');

// ---------------------------------------------------------------- WAV chimes
const SAMPLE_RATE = 16000; // plenty for pure sine tones under ~1.5 kHz
const AMPLITUDE = 0.32;

/**
 * @param {Array<{freq:number, start:number, dur:number}>} notes
 * @param {number} totalSec
 */
function renderTone(notes, totalSec) {
  const n = Math.round(totalSec * SAMPLE_RATE);
  const buf = new Float32Array(n);
  for (const note of notes) {
    const from = Math.round(note.start * SAMPLE_RATE);
    const len = Math.round(note.dur * SAMPLE_RATE);
    for (let i = 0; i < len && from + i < n; i++) {
      const t = i / SAMPLE_RATE;
      // Percussive envelope: fast attack, exponential decay.
      const attack = Math.min(1, t / 0.006);
      const decay = Math.exp(-t * (3.2 / note.dur));
      buf[from + i] += Math.sin(2 * Math.PI * note.freq * t) * attack * decay;
    }
  }
  return buf;
}

function toWav(samples) {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16); // PCM chunk size
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  out.writeUInt16LE(2, 32); // block align
  out.writeUInt16LE(16, 34); // bits per sample
  out.write('data', 36);
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] * AMPLITUDE));
    out.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return out;
}

// Ascending major third + fifth — reads as "done, all good".
const SUCCESS = toWav(renderTone([
  { freq: 880.0, start: 0.0, dur: 0.16 },   // A5
  { freq: 1108.7, start: 0.11, dur: 0.16 }, // C#6
  { freq: 1318.5, start: 0.22, dur: 0.26 }, // E6
], 0.5));

// Descending minor second — reads as "something went wrong".
const FAILURE = toWav(renderTone([
  { freq: 440.0, start: 0.0, dur: 0.2 },   // A4
  { freq: 329.6, start: 0.18, dur: 0.32 }, // E4
], 0.52));

// ------------------------------------------------------------------- PNG icon
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Rounded-square blue tile with a white cloud — matches the app's ☁️ branding. */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const S = 3; // supersampling factor for cheap anti-aliasing

  // Cloud = union of three discs plus a slab, in normalised (0..1) coordinates.
  const discs = [
    { x: 0.38, y: 0.52, r: 0.16 },
    { x: 0.58, y: 0.46, r: 0.21 },
    { x: 0.73, y: 0.56, r: 0.14 },
  ];
  const slab = { x0: 0.34, x1: 0.75, y0: 0.55, y1: 0.68 };

  const inTile = (x, y) => {
    const dx = Math.min(x, size - x);
    const dy = Math.min(y, size - y);
    if (dx >= radius || dy >= radius) return true;
    const cx = dx < radius ? radius : dx;
    const cy = dy < radius ? radius : dy;
    return Math.hypot(cx - dx, cy - dy) <= radius;
  };

  const inCloud = (x, y) => {
    const nx = x / size;
    const ny = y / size;
    for (const d of discs) if (Math.hypot(nx - d.x, ny - d.y) <= d.r) return true;
    return nx >= slab.x0 && nx <= slab.x1 && ny >= slab.y0 && ny <= slab.y1;
  };

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0;
      let cloud = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = px + (sx + 0.5) / S;
          const y = py + (sy + 0.5) / S;
          if (inTile(x, y)) tile++;
          if (inCloud(x, y)) cloud++;
        }
      }
      const samples = S * S;
      const tileA = tile / samples;
      const cloudA = (cloud / samples) * tileA;
      // Vertical gradient #2563eb -> #1d4ed8.
      const g = py / size;
      const bg = [
        Math.round(0x25 + (0x1d - 0x25) * g),
        Math.round(0x63 + (0x4e - 0x63) * g),
        Math.round(0xeb + (0xd8 - 0xeb) * g),
      ];
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(bg[0] * (1 - cloudA) + 255 * cloudA);
      rgba[i + 1] = Math.round(bg[1] * (1 - cloudA) + 255 * cloudA);
      rgba[i + 2] = Math.round(bg[2] * (1 - cloudA) + 255 * cloudA);
      rgba[i + 3] = Math.round(tileA * 255);
    }
  }
  return encodePng(size, size, rgba);
}

// ------------------------------------------------------------------------ run
fs.mkdirSync(SOUNDS_DIR, { recursive: true });
fs.mkdirSync(ICONS_DIR, { recursive: true });

const written = [
  [path.join(SOUNDS_DIR, 'success.wav'), SUCCESS],
  [path.join(SOUNDS_DIR, 'failure.wav'), FAILURE],
  [path.join(ICONS_DIR, 'icon-192.png'), drawIcon(192)],
  [path.join(ICONS_DIR, 'icon-512.png'), drawIcon(512)],
];

for (const [file, buf] of written) {
  fs.writeFileSync(file, buf);
  console.log(`wrote ${path.relative(ROOT, file)} (${(buf.length / 1024).toFixed(1)} KB)`);
}
