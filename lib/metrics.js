'use strict';

/**
 * Machine metrics for the scheduler dashboard.
 *
 * The question this answers is not "how is the Mac doing" in the abstract — it
 * is "is the work cloud-copilot started right now more than this machine can
 * take?". So every number is either a whole-machine total or a per-session
 * share of that total, and the two are collected from the same sample so they
 * can honestly be compared.
 *
 * Per-session CPU is summed over the session's whole process GROUP, because a
 * deploy's cost lives in xcodebuild, not in the copilot process that started
 * it. `ps` reports %CPU relative to one core, so a 4-core-saturated build shows
 * 400%; dividing by the core count turns that into the share of the machine a
 * human actually asked about.
 *
 * Nothing here needs sudo. `powermetrics` would give nicer GPU/power figures
 * and is deliberately not used: a dashboard that only works when run as root is
 * a dashboard that stops working.
 */

const os = require('os');
const { execFileSync } = require('child_process');

const CORES = os.cpus().length || 1;

let prevCpu = null;

/** Total/idle jiffies across all cores, for a delta-based CPU percentage. */
function cpuTotals() {
  let idle = 0;
  let total = 0;
  const per = [];
  for (const c of os.cpus()) {
    const t = c.times;
    const all = t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
    total += all;
    per.push({ idle: t.idle, total: all });
  }
  return { idle, total, per };
}

/**
 * Whole-machine CPU use since the previous call.
 *
 * `os.cpus()` is cumulative since boot, so a single reading would report the
 * average since power-on — a number that never moves and never means anything.
 * The first call therefore seeds the baseline and reports null rather than
 * lying.
 */
function sampleCpu() {
  const now = cpuTotals();
  const prev = prevCpu;
  prevCpu = now;
  if (!prev) return { overall: null, perCore: [], cores: CORES };
  const dIdle = now.idle - prev.idle;
  const dTotal = now.total - prev.total;
  const overall = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : null;
  const perCore = now.per.map((c, i) => {
    const p = prev.per[i] || c;
    const dt = c.total - p.total;
    const di = c.idle - p.idle;
    return dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
  });
  return { overall, perCore, cores: CORES };
}

function sh(cmd, args, timeout = 4000) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  } catch {
    return '';
  }
}

/**
 * GPU utilisation on Apple Silicon / Intel Macs, or null where unavailable.
 *
 * IOAccelerator's PerformanceStatistics dictionary is the only unprivileged
 * source for this; its key names differ between GPU families, hence the list.
 */
function gpu() {
  if (process.platform !== 'darwin') return null;
  const out = sh('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
  if (!out) return null;
  const pick = (label) => {
    const m = out.match(new RegExp(`"${label}"=(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const device = pick('Device Utilization %');
  if (device === null) return null;
  return {
    utilization: device,
    renderer: pick('Renderer Utilization %'),
    tiler: pick('Tiler Utilization %'),
    inUseMemoryBytes: pick('In use system memory'),
    allocatedMemoryBytes: pick('Alloc system memory'),
  };
}

/**
 * Real memory pressure on macOS.
 *
 * `os.freemem()` on darwin counts only genuinely untouched pages and so reads
 * near zero on a healthy machine — showing it as "99% memory used" would be
 * alarming and wrong. `memory_pressure` reports the number the kernel itself
 * acts on.
 */
function memory() {
  const total = os.totalmem();
  const free = os.freemem();
  let freePercent = null;
  if (process.platform === 'darwin') {
    const out = sh('memory_pressure', []);
    const m = out.match(/System-wide memory free percentage:\s*(\d+)%/);
    if (m) freePercent = Number(m[1]);
  }
  const usedPercent = freePercent === null ? ((total - free) / total) * 100 : 100 - freePercent;
  return { totalBytes: total, freeBytes: free, usedPercent };
}

function disk() {
  const out = sh('df', ['-k', '/']);
  const line = out.trim().split('\n').pop() || '';
  const cols = line.split(/\s+/);
  if (cols.length < 5) return null;
  const totalKb = Number(cols[1]);
  const usedKb = Number(cols[2]);
  const availKb = Number(cols[3]);
  if (!Number.isFinite(totalKb) || !totalKb) return null;
  return {
    totalBytes: totalKb * 1024,
    usedBytes: usedKb * 1024,
    freeBytes: availKb * 1024,
    usedPercent: (usedKb / (usedKb + availKb)) * 100,
  };
}

/**
 * CPU and RSS per process group, from one `ps` sweep.
 *
 * One sweep rather than one per session: `ps` costs a fork, and a dashboard
 * polling six sessions individually would spend more CPU measuring than the
 * measurement is worth.
 */
function processGroups() {
  const out = sh('ps', ['-eo', 'pgid=,pid=,pcpu=,rss=']);
  const groups = new Map();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)$/);
    if (!m) continue;
    const pgid = Number(m[1]);
    const g = groups.get(pgid) || { cpu: 0, rssBytes: 0, processes: 0 };
    g.cpu += Number(m[3]);
    g.rssBytes += Number(m[4]) * 1024;
    g.processes += 1;
    groups.set(pgid, g);
  }
  return groups;
}

/**
 * A full metrics snapshot.
 *
 * @param {Array<{id:string,pid:number,pgid:number}>} pids supervised sessions
 */
function snapshot(pids = []) {
  const cpu = sampleCpu();
  const groups = processGroups();
  const sessions = pids.map((p) => {
    const g = groups.get(p.pgid) || { cpu: 0, rssBytes: 0, processes: 0 };
    return {
      id: p.id,
      pid: p.pid,
      pgid: p.pgid,
      // As reported by ps: 100 = one core fully busy.
      cpuPercentOfCore: Number(g.cpu.toFixed(1)),
      // The share of the whole machine, which is the number people mean.
      cpuPercentOfMachine: Number((g.cpu / CORES).toFixed(1)),
      rssBytes: g.rssBytes,
      processes: g.processes,
    };
  });
  const supervisedCpu = sessions.reduce((a, s) => a + s.cpuPercentOfMachine, 0);
  return {
    at: Date.now(),
    host: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    uptimeSec: Math.round(os.uptime()),
    cpu: {
      cores: CORES,
      overallPercent: cpu.overall === null ? null : Number(cpu.overall.toFixed(1)),
      perCorePercent: cpu.perCore.map((v) => Number(v.toFixed(1))),
      loadAvg: os.loadavg().map((v) => Number(v.toFixed(2))),
    },
    memory: memory(),
    gpu: gpu(),
    disk: disk(),
    sessions,
    supervised: {
      count: sessions.length,
      cpuPercentOfMachine: Number(supervisedCpu.toFixed(1)),
      rssBytes: sessions.reduce((a, s) => a + s.rssBytes, 0),
    },
  };
}

const pct = (v) => (v === null || v === undefined ? '?' : `${Math.round(v)}%`);
const gib = (b) => `${(b / 1024 ** 3).toFixed(1)}G`;

/** One-screen summary, sized for an ntfy push on a phone. */
function summarize(snap) {
  const lines = [];
  lines.push(
    `CPU ${pct(snap.cpu.overallPercent)} of ${snap.cpu.cores} cores · load ${snap.cpu.loadAvg.join(' ')}`,
  );
  lines.push(`RAM ${pct(snap.memory.usedPercent)} of ${gib(snap.memory.totalBytes)}`);
  if (snap.gpu) lines.push(`GPU ${pct(snap.gpu.utilization)}`);
  if (snap.disk) lines.push(`Disk ${pct(snap.disk.usedPercent)} used, ${gib(snap.disk.freeBytes)} free`);
  lines.push(
    `${snap.supervised.count} supervised session(s) using ${pct(snap.supervised.cpuPercentOfMachine)} of the machine`,
  );
  return lines.join('\n');
}

module.exports = { snapshot, summarize, CORES };
