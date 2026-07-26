#!/usr/bin/env node
/**
 * Deterministic UI auditor — headless Chromium via Playwright.
 *
 * This is the "layer 1" of cloud-copilot's UI validation: everything it reports
 * is measured, never guessed, so an agent can act on it without hallucinating.
 * Screenshots are written for the optional "layer 3" multimodal review.
 *
 * Usage:
 *   node audit.mjs --base-url http://127.0.0.1:8787 --route / --viewport 390x844
 *   node audit.mjs --config /path/to/.cloud-copilot.json        # reads the "ui" block
 *
 * Options:
 *   --config <file>        read routes/viewports/baseUrl from a .cloud-copilot.json "ui" block
 *   --base-url <url>       origin under test (overrides config)
 *   --route <path>         repeatable; defaults to "/"
 *   --viewport <WxH>       repeatable; defaults to 390x844 and 1440x900
 *   --out <dir>            screenshot + report output dir (default ./ui-audit)
 *   --storage-state <file> Playwright storageState JSON for authenticated pages
 *   --wait-timeout <ms>    how long to wait for base-url to answer (default 30000)
 *   --min-tap <px>         minimum tap-target edge (default 44)
 *   --json                 print machine-readable JSON instead of markdown
 *   --no-screenshots       skip screenshots (faster, text-only findings)
 *
 * Exit code: 1 if any error-severity finding, else 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadDep(name, hint) {
  try {
    return require(name);
  } catch {
    console.error(
      `[ui-audit] missing dependency "${name}". ${hint}\n` +
        `Run: cd ${path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')} && npm install`
    );
    process.exit(2);
  }
}

const { chromium } = loadDep('playwright', 'Install it in the cloud-copilot repo.');
const axeSource = loadDep('axe-core', 'Install it in the cloud-copilot repo.').source;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { routes: [], viewports: [], screenshots: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--config': out.config = next(); break;
      case '--base-url': out.baseUrl = next(); break;
      case '--route': out.routes.push(next()); break;
      case '--viewport': out.viewports.push(next()); break;
      case '--out': out.out = next(); break;
      case '--storage-state': out.storageState = next(); break;
      case '--wait-timeout': out.waitTimeout = Number(next()); break;
      case '--min-tap': out.minTap = Number(next()); break;
      case '--json': out.json = true; break;
      case '--no-screenshots': out.screenshots = false; break;
      case '-h': case '--help':
        console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        console.error(`[ui-audit] unknown option: ${a}`);
        process.exit(2);
    }
  }
  return out;
}

function parseViewport(s) {
  const m = /^(\d+)x(\d+)$/.exec(String(s).trim());
  if (!m) throw new Error(`bad --viewport "${s}" (expected e.g. 390x844)`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

const args = parseArgs(process.argv.slice(2));

let uiConfig = {};
if (args.config) {
  try {
    uiConfig = JSON.parse(fs.readFileSync(args.config, 'utf8')).ui || {};
  } catch (err) {
    console.error(`[ui-audit] cannot read ${args.config}: ${err.message}`);
    process.exit(2);
  }
}

const baseUrl = (args.baseUrl || uiConfig.baseUrl || '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('[ui-audit] no --base-url and no ui.baseUrl in config');
  process.exit(2);
}

const routes = (args.routes.length ? args.routes : uiConfig.routes || ['/']).map((r) =>
  r.startsWith('/') ? r : `/${r}`
);
const viewports = (args.viewports.length
  ? args.viewports.map(parseViewport)
  : (uiConfig.viewports || [[390, 844], [1440, 900]]).map((v) =>
      Array.isArray(v) ? { width: v[0], height: v[1] } : v
    ));
const outDir = path.resolve(args.out || uiConfig.outDir || 'ui-audit');
const storageState = args.storageState || uiConfig.storageState || undefined;
const waitTimeout = Number.isFinite(args.waitTimeout) ? args.waitTimeout : 30000;
const minTap = Number.isFinite(args.minTap) ? args.minTap : uiConfig.minTapTarget || 44;

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
const findings = [];
function report(f) {
  findings.push(f);
}

// Freeze animations & carets so screenshots are byte-stable across runs.
const STABILIZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}
html { scroll-behavior: auto !important; }
`;

/** Wait until the origin answers, so we don't race a just-started dev server. */
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status < 500) return true;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server at ${url} not ready after ${timeoutMs}ms: ${lastErr?.message || 'unknown'}`);
}

// ---------------------------------------------------------------------------
// In-page collectors (run inside the browser)
// ---------------------------------------------------------------------------

/** Interactive elements that are too small to hit reliably on touch. */
// eslint-disable-next-line no-undef -- runs inside the browser, not in Node
const collectLayout = (minTap) => {
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [onclick], [tabindex]:not([tabindex="-1"])';
  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return el.tagName.toLowerCase() + id + cls + (txt ? ' "' + txt + '"' : '');
  };
  const vw = document.documentElement.clientWidth;
  // Off-canvas drawers/popovers are parked outside the viewport on purpose, so
  // anything with no horizontal overlap at all is closed UI, not a layout bug.
  const onCanvas = (r) => r.right > 0 && r.left < vw;
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && onCanvas(r);
  };

  // The real hit area of a checkbox/radio is its label, not the 13px box.
  const hitRect = (el) => {
    const r = el.getBoundingClientRect();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName !== 'INPUT' || (type !== 'checkbox' && type !== 'radio')) return r;
    const label = el.closest('label') ||
      (el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null);
    return label ? label.getBoundingClientRect() : r;
  };

  const smallTargets = [];
  const overlaps = [];
  const interactive = [...document.querySelectorAll(sel)].filter(visible);
  // Pointer precision only matters on touch-sized viewports; a mouse hits a
  // 33px desktop tab fine, and flagging those buries the real findings.
  if (vw <= 600) {
    for (const el of interactive) {
      const r = hitRect(el);
      const w = Math.round(r.width), h = Math.round(r.height);
      if (w < minTap || h < minTap) {
        smallTargets.push({ el: describe(el), width: w, height: h });
      }
    }
  }
  // Interactive elements that visually cover each other (not nested).
  for (let i = 0; i < interactive.length; i++) {
    for (let j = i + 1; j < interactive.length; j++) {
      const a = interactive[i], b = interactive[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox <= 1 || oy <= 1) continue;
      const area = ox * oy;
      const minArea = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (minArea > 0 && area / minArea > 0.25) {
        overlaps.push({ a: describe(a), b: describe(b), overlapPct: Math.round((area / minArea) * 100) });
      }
    }
  }

  // Horizontal overflow of the document (causes sideways scrolling on mobile).
  const de = document.documentElement;
  const docOverflow = de.scrollWidth - de.clientWidth;

  // Blocks whose content overflows their own box horizontally.
  const clipped = [];
  const truncated = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    if (el.scrollWidth - el.clientWidth > 1 && s.overflowX !== 'auto' && s.overflowX !== 'scroll') {
      clipped.push({ el: describe(el), overflowPx: el.scrollWidth - el.clientWidth });
    }
    // Ellipsised single-line text: content is silently hidden from the user.
    if (s.textOverflow === 'ellipsis' && el.scrollWidth - el.clientWidth > 1 && el.children.length === 0) {
      truncated.push({ el: describe(el), hiddenPx: el.scrollWidth - el.clientWidth });
    }
  }

  // Text that spills past a viewport edge while still being partly on screen —
  // fully off-canvas nodes were already excluded by visible().
  const offscreen = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.children.length > 0) continue;
    if (!(el.textContent || '').trim()) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) {
      offscreen.push({ el: describe(el), left: Math.round(r.left), right: Math.round(r.right), viewportWidth: vw });
    }
  }

  // Tiny body text is hard to read regardless of contrast.
  const tinyText = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.children.length > 0) continue;
    if (!(el.textContent || '').trim()) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs && fs < 12) tinyText.push({ el: describe(el), fontSize: fs });
  }

  const dedupe = (arr, key) => {
    const seen = new Set();
    return arr.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
  };

  return {
    smallTargets: dedupe(smallTargets, (x) => x.el).slice(0, 25),
    overlaps: dedupe(overlaps, (x) => x.a + '|' + x.b).slice(0, 25),
    docOverflow,
    clipped: dedupe(clipped, (x) => x.el).slice(0, 25),
    truncated: dedupe(truncated, (x) => x.el).slice(0, 25),
    offscreen: dedupe(offscreen, (x) => x.el).slice(0, 25),
    tinyText: dedupe(tinyText, (x) => x.el).slice(0, 25),
  };
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function auditRoute(browser, route, viewport) {
  const label = `${route} @ ${viewport.width}x${viewport.height}`;
  const where = { route, viewport: `${viewport.width}x${viewport.height}` };
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    storageState: storageState && fs.existsSync(storageState) ? storageState : undefined,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const badResponses = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => consoleErrors.push(`uncaught: ${err.message}`.slice(0, 300)));
  page.on('requestfailed', (req) => {
    const f = req.failure();
    // Aborted navigations/prefetches are noise; only surface real failures.
    if (f && !/ERR_ABORTED/.test(f.errorText)) {
      badResponses.push(`${req.method()} ${req.url().slice(0, 160)} — ${f.errorText}`);
    }
  });
  page.on('response', (res) => {
    if (res.status() >= 400) badResponses.push(`HTTP ${res.status()} ${res.url().slice(0, 160)}`);
  });

  try {
    const resp = await page.goto(baseUrl + route, { waitUntil: 'load', timeout: 30000 });
    if (resp && resp.status() >= 400) {
      report({ severity: 'error', check: 'http-status', ...where, detail: `page returned HTTP ${resp.status()}` });
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  } catch (err) {
    report({ severity: 'error', check: 'navigation', ...where, detail: err.message.split('\n')[0] });
    await context.close();
    return;
  }

  await page.addStyleTag({ content: STABILIZE_CSS }).catch(() => {});
  await page.waitForTimeout(150);

  // --- layout / sizing / readability -------------------------------------
  let layout;
  try {
    layout = await page.evaluate(collectLayout, minTap);
  } catch (err) {
    report({ severity: 'warn', check: 'layout-probe', ...where, detail: err.message.split('\n')[0] });
    layout = null;
  }

  if (layout) {
    if (layout.docOverflow > 1) {
      report({
        severity: 'error',
        check: 'horizontal-overflow',
        ...where,
        detail: `page scrolls ${layout.docOverflow}px horizontally (content wider than the viewport)`,
      });
    }
    for (const t of layout.smallTargets) {
      report({
        severity: 'warn',
        check: 'tap-target-too-small',
        ...where,
        detail: `${t.el} is ${t.width}x${t.height}px (min ${minTap}x${minTap})`,
      });
    }
    for (const o of layout.overlaps) {
      report({
        severity: 'error',
        check: 'overlapping-controls',
        ...where,
        detail: `${o.a} overlaps ${o.b} by ${o.overlapPct}%`,
      });
    }
    for (const c of layout.clipped) {
      report({ severity: 'warn', check: 'content-clipped', ...where, detail: `${c.el} clips ${c.overflowPx}px of its content` });
    }
    for (const t of layout.truncated) {
      report({ severity: 'info', check: 'text-truncated', ...where, detail: `${t.el} hides ${t.hiddenPx}px behind an ellipsis` });
    }
    for (const o of layout.offscreen) {
      report({
        severity: 'error',
        check: 'text-outside-viewport',
        ...where,
        detail: `${o.el} spans ${o.left}→${o.right}px in a ${o.viewportWidth}px viewport`,
      });
    }
    for (const t of layout.tinyText) {
      report({ severity: 'warn', check: 'text-too-small', ...where, detail: `${t.el} renders at ${t.fontSize}px` });
    }
  }

  // --- accessibility (contrast, labels, structure) ------------------------
  try {
    await page.addScriptTag({ content: axeSource });
    const axe = await page.evaluate(async () =>
      // eslint-disable-next-line no-undef
      await window.axe.run(document, { resultTypes: ['violations'] })
    );
    for (const v of axe.violations || []) {
      if (v.impact !== 'serious' && v.impact !== 'critical') continue;
      const nodes = (v.nodes || []).slice(0, 3).map((n) => n.target.join(' ')).join(', ');
      report({
        severity: v.id === 'color-contrast' ? 'error' : 'warn',
        check: `a11y:${v.id}`,
        ...where,
        detail: `${v.help} (${v.nodes.length} node(s): ${nodes})`,
      });
    }
  } catch (err) {
    report({ severity: 'warn', check: 'a11y-probe', ...where, detail: err.message.split('\n')[0] });
  }

  // --- runtime health ------------------------------------------------------
  for (const e of [...new Set(consoleErrors)].slice(0, 10)) {
    report({ severity: 'error', check: 'console-error', ...where, detail: e });
  }
  for (const e of [...new Set(badResponses)].slice(0, 10)) {
    report({ severity: 'error', check: 'failed-request', ...where, detail: e });
  }

  // --- screenshot for the optional visual review --------------------------
  let shot = null;
  if (args.screenshots) {
    const slug = (route === '/' ? 'root' : route.replace(/^\/+|\/+$/g, '').replace(/[^\w.-]+/g, '_')) +
      `@${viewport.width}x${viewport.height}`;
    shot = path.join(outDir, `${slug}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => { shot = null; });
  }

  await context.close();
  return { label, screenshot: shot };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  await waitForServer(baseUrl + (uiConfig.readyPath || routes[0] || '/'), waitTimeout);

  const browser = await chromium.launch({ headless: true });
  const shots = [];
  try {
    for (const route of routes) {
      for (const viewport of viewports) {
        const r = await auditRoute(browser, route, viewport);
        if (r?.screenshot) shots.push(r.screenshot);
      }
    }
  } finally {
    await browser.close();
  }

  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');
  const infos = findings.filter((f) => f.severity === 'info');

  const result = {
    baseUrl,
    routes,
    viewports: viewports.map((v) => `${v.width}x${v.height}`),
    outDir,
    screenshots: shots,
    counts: { error: errors.length, warn: warns.length, info: infos.length },
    findings,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(result, null, 2));

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n## UI audit — ${baseUrl}`);
    console.log(`routes: ${routes.join(', ')} · viewports: ${result.viewports.join(', ')}`);
    console.log(`errors: ${errors.length} · warnings: ${warns.length} · info: ${infos.length}\n`);
    if (findings.length) {
      console.log('| severity | check | route @ viewport | detail |');
      console.log('| --- | --- | --- | --- |');
      for (const f of findings) {
        const detail = f.detail.replace(/\|/g, '\\|');
        console.log(`| ${f.severity} | ${f.check} | ${f.route} @ ${f.viewport} | ${detail} |`);
      }
    } else {
      console.log('No issues detected.');
    }
    if (shots.length) console.log(`\nScreenshots: ${shots.join(', ')}`);
    console.log(`\nReport: ${path.join(outDir, 'report.json')}`);
  }

  process.exit(errors.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`[ui-audit] ${err.stack || err.message}`);
  process.exit(2);
});
