#!/usr/bin/env node
/**
 * Machine-wide gate for heavy jobs (lead-owned). Several agents share this machine; on 2026-11-10 it
 * bug-checked under their combined load. Every heavy command goes through this wrapper so that only a few
 * run at once and none starts while physical memory is short.
 *
 *   node tools/dev/heavy.mjs --class=cpu  -- npx vitest run src/terrain
 *   node tools/dev/heavy.mjs --class=gpu  -- npx playwright test tests/browser/ocean --project=functional
 *   node tools/dev/heavy.mjs --class=bake --label=earth-albedo -- data/cache/earth/venv/Scripts/python.exe -I tools/bake/earth/bake.py
 *   node tools/dev/heavy.mjs --status
 *
 * Classes and concurrent slots (override with HEAVY_CAP_CPU / HEAVY_CAP_GPU / HEAVY_CAP_BAKE):
 *   cpu   3  vitest, tsc over many paths, node benchmarks, headless mission runs
 *   gpu   3  Playwright / Chrome with WebGPU (functional); perf specs still take withGpuLock inside
 *   bake  1  Python or Node data bakes with worker pools (keep each pool at 6 workers or fewer)
 *
 * A job waits for a free slot of its class AND for free physical memory above HEAVY_MIN_FREE_GB
 * (default 12). After HEAVY_MAX_WAIT_MIN (default 45) of waiting on memory alone it starts anyway and says
 * so. The wrapper passes stdio through and exits with the command's exit code. A slot whose holder died is
 * reclaimed automatically.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lockDir = path.join(repoRoot, 'out', 'locks');
const CAPS = {
  cpu: Number(process.env.HEAVY_CAP_CPU ?? 3),
  gpu: Number(process.env.HEAVY_CAP_GPU ?? 3),
  bake: Number(process.env.HEAVY_CAP_BAKE ?? 1),
};
const MIN_FREE_GB = Number(process.env.HEAVY_MIN_FREE_GB ?? 12);
const MAX_WAIT_MIN = Number(process.env.HEAVY_MAX_WAIT_MIN ?? 45);
const GB = 1024 ** 3;

function usage(msg) {
  if (msg) console.error(`heavy: ${msg}`);
  console.error('usage: node tools/dev/heavy.mjs --class=cpu|gpu|bake [--label=text] -- <command> [args...]');
  console.error('       node tools/dev/heavy.mjs --status');
  process.exit(2);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readHolder(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function slotFile(cls, i) {
  return path.join(lockDir, `heavy-${cls}-${i}.lock`);
}

/** Try to take one slot of the class; returns the lock file path or null. */
function tryAcquire(cls, label) {
  for (let i = 0; i < CAPS[cls]; i++) {
    const file = slotFile(cls, i);
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, label, since: new Date().toISOString() }));
      fs.closeSync(fd);
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
      const holder = readHolder(file);
      let stale = false;
      if (holder && typeof holder.pid === 'number') stale = !alive(holder.pid);
      else {
        try {
          stale = Date.now() - fs.statSync(file).mtimeMs > 10_000;
        } catch {
          stale = false;
        }
      }
      if (stale) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* another waiter removed it */
        }
        i--;
      }
    }
  }
  return null;
}

function status() {
  const lines = [`free ${(os.freemem() / GB).toFixed(1)} GB of ${(os.totalmem() / GB).toFixed(1)} GB; floor ${MIN_FREE_GB} GB`];
  for (const cls of Object.keys(CAPS)) {
    for (let i = 0; i < CAPS[cls]; i++) {
      const h = readHolder(slotFile(cls, i));
      if (h && alive(h.pid)) lines.push(`${cls}[${i}] pid ${h.pid} since ${h.since} ${h.label ?? ''}`);
      else lines.push(`${cls}[${i}] free`);
    }
  }
  return lines.join('\n');
}

function quoteArg(a) {
  if (/^[A-Za-z0-9_\-./:=@,+\\*]+$/.test(a)) return a;
  return `"${a.replace(/"/g, '\\"')}"`;
}

const argv = process.argv.slice(2);
if (argv.includes('--status')) {
  fs.mkdirSync(lockDir, { recursive: true });
  console.log(status());
  process.exit(0);
}
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) usage('missing "-- <command>"');
const opts = Object.fromEntries(
  argv.slice(0, sep).map((a) => {
    const m = /^--([a-z]+)=(.*)$/.exec(a);
    if (!m) usage(`bad option ${a}`);
    return [m[1], m[2]];
  }),
);
const cls = opts.class;
if (!cls || !(cls in CAPS)) usage('--class must be cpu, gpu or bake');
const cmd = argv.slice(sep + 1);
const label = opts.label ?? cmd.join(' ').slice(0, 120);

fs.mkdirSync(lockDir, { recursive: true });
const t0 = Date.now();
let lock = null;
let lastNote = 0;
for (;;) {
  const freeGb = os.freemem() / GB;
  const waitedMin = (Date.now() - t0) / 60_000;
  const memoryOk = freeGb >= MIN_FREE_GB || waitedMin >= MAX_WAIT_MIN;
  if (memoryOk) {
    lock = tryAcquire(cls, label);
    if (lock) {
      if (freeGb < MIN_FREE_GB) console.error(`heavy: starting below the memory floor after ${waitedMin.toFixed(0)} min (free ${freeGb.toFixed(1)} GB)`);
      break;
    }
  }
  if (Date.now() - lastNote > 60_000) {
    lastNote = Date.now();
    console.error(`heavy: waiting for a ${cls} slot (free ${freeGb.toFixed(1)} GB, waited ${waitedMin.toFixed(1)} min)\n${status()}`);
  }
  await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
}

let released = false;
function release() {
  if (released) return;
  released = true;
  try {
    const h = readHolder(lock);
    if (h && h.pid === process.pid) fs.unlinkSync(lock);
  } catch {
    /* already gone */
  }
}

const child = spawn(cmd.map(quoteArg).join(' '), {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, HEAVY_GATE: cls },
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, () => {
    try {
      child.kill();
    } catch {
      /* already exited */
    }
    release();
    process.exit(130);
  });
}
process.on('exit', release);
child.on('error', (e) => {
  console.error(`heavy: failed to start: ${e.message}`);
  release();
  process.exit(127);
});
child.on('exit', (code, signal) => {
  release();
  process.exit(code ?? (signal ? 1 : 0));
});
