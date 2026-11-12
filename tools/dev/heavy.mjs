#!/usr/bin/env node
/**
 * Machine-wide gate for heavy jobs (lead-owned). Several agents share this machine; on 2026-11-10 it
 * bug-checked under their combined load. Every heavy command goes through this wrapper so that only a few
 * run at once and none starts while physical memory is short.
 *
 *   node tools/dev/heavy.mjs --class=cpu  -- npx vitest run src/terrain
 *   node tools/dev/heavy.mjs --class=gpu  -- npx playwright test tests/browser/ocean --project=functional
 *   node tools/dev/heavy.mjs --class=bake --label=earth-albedo -- data/cache/earth/venv/Scripts/python.exe -I tools/bake/earth/bake.py
 *   node tools/dev/heavy.mjs --class=stack -- node deploy/local/stack.mjs -- npx vitest run tests/net   (npm run stack -- -- <suite>)
 *   node tools/dev/heavy.mjs --status
 *
 * Classes and concurrent slots (override with HEAVY_CAP_CPU / HEAVY_CAP_GPU / HEAVY_CAP_BAKE):
 *   cpu    3  vitest, tsc over many paths, node benchmarks, headless mission runs
 *   gpu    1  Playwright / Chrome with WebGPU (functional); perf specs still take withGpuLock inside
 *   bake   1  Python or Node data bakes with worker pools (keep each pool at 6 workers or fewer)
 *   stack  1  the local stack (ARCHITECTURE 16.4): host processes with an embedded Postgres, or the docker
 *             compose form. ALWAYS ONE, with no override: the two forms never run together and never twice.
 *
 * The stack slot model. This wrapper frees a slot when the wrapped command exits, so the stack LAUNCHER is
 * the wrapped command: it brings the stack up, runs the suite it was given, brings the stack down and
 * exits, and the slot is held for exactly that long. There is no background mode: a stack left running
 * behind a finished wrapper would hold no slot. A second launcher waits here; a launcher that died leaves
 * a slot whose holder is dead, which is reclaimed like any other; --status shows the holder. A command
 * inside a stack that needs the GPU or many cores is itself wrapped in --class=gpu or --class=cpu.
 *
 * Who holds a slot. The slot file records the wrapper's pid AND the pid of the command it started. The
 * slot is held while EITHER is alive, and after both are gone while anything they started is still alive:
 * a wrapper that is killed (Windows cannot deliver it a signal first) takes its direct child with it, but
 * what that child started lives on (measured: `npx tsx script` behind a killed wrapper ran to its end, and
 * so did a process the command had detached). So before a waiter treats a slot whose two pids are dead as
 * free, it looks ONCE at the process table for live processes whose parent was one of them (ORPHANS), writes
 * them into the slot file, and the slot stays held until they and their own children are gone. That query
 * costs a PowerShell start and runs only in this rare case. It follows parent links, so a process orphaned
 * twice (its parent killed as well) is not seen: a launcher that must never run twice (the local stack)
 * therefore takes its own exclusive lock under its state directory as well.
 * On a signal the wrapper kills the command's whole process tree (on Windows `taskkill /T /F`: killing the
 * shell alone would leave the command behind). A command that starts with `node` is started without a
 * shell, so the recorded pid is the command itself; anything else needs the shell (.cmd shims).
 *
 * A job waits for a free slot of its class AND for free physical memory above HEAVY_MIN_FREE_GB
 * (default 12). After HEAVY_MAX_WAIT_MIN (default 45) of waiting on memory alone it starts anyway and says
 * so. The wrapper passes stdio through and exits with the command's exit code. A slot whose holder died is
 * reclaimed automatically.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lockDir = path.join(repoRoot, 'out', 'locks');
const CAPS = {
  cpu: Number(process.env.HEAVY_CAP_CPU ?? 3),
  gpu: Number(process.env.HEAVY_CAP_GPU ?? 1),
  bake: Number(process.env.HEAVY_CAP_BAKE ?? 1),
  stack: 1,
};
const MIN_FREE_GB = Number(process.env.HEAVY_MIN_FREE_GB ?? 12);
const MAX_WAIT_MIN = Number(process.env.HEAVY_MAX_WAIT_MIN ?? 45);
const GB = 1024 ** 3;

function usage(msg) {
  if (msg) console.error(`heavy: ${msg}`);
  console.error('usage: node tools/dev/heavy.mjs --class=cpu|gpu|bake|stack [--label=text] -- <command> [args...]');
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

/**
 * Live processes whose parent is one of `parents`, as { pid, created (ms since the epoch) }. One look at the
 * process table (Windows: a CIM query through PowerShell; elsewhere `ps`). Empty when the table cannot be read.
 */
function liveChildrenOf(parents) {
  if (parents.length === 0) return [];
  try {
    const rows = [];
    if (process.platform === 'win32') {
      const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }';
      const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      for (const line of (res.stdout ?? '').split(/\r?\n/)) {
        const m = /^(\d+) (\d+) (\d+)/.exec(line.trim());
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: Number(m[3]) });
      }
    } else {
      const res = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 20_000 });
      for (const line of (res.stdout ?? '').split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: 0 });
      }
    }
    return rows.filter((r) => parents.includes(r.ppid) && r.pid !== r.ppid && r.pid !== process.pid);
  } catch {
    return [];
  }
}

/**
 * Whether the holder of a slot file still holds it: 'alive' (its wrapper or its command lives), 'orphans'
 * (both are gone, something they started lives; `orphans` in the slot file lists it) or 'dead'.
 */
function holderState(file, h) {
  if ((typeof h.pid === 'number' && alive(h.pid)) || (typeof h.childPid === 'number' && alive(h.childPid))) return 'alive';
  const known = Array.isArray(h.orphans) ? h.orphans.filter((p) => typeof p === 'number') : [];
  if (known.some(alive)) return 'orphans';
  // Both recorded pids, and every orphan found so far, are gone: look once for what they left behind.
  const first = h.deadSeen === undefined;
  const deadSeen = h.deadSeen ?? Date.now();
  const since = Date.parse(h.since ?? '') || 0;
  const parents = [h.pid, h.childPid, ...known].filter((p) => typeof p === 'number');
  // The first look accepts only processes created while the slot was held (a later process that reuses a
  // dead pid and starts children of its own is not ours); later looks follow the orphans' own children.
  const found = liveChildrenOf(parents)
    .filter((r) => !first || r.created === 0 || (r.created >= since - 1000 && r.created <= deadSeen))
    .map((r) => r.pid);
  try {
    const now = readHolder(file);
    if (now && now.pid === h.pid && now.since === h.since) fs.writeFileSync(file, JSON.stringify({ ...now, deadSeen, orphans: [...new Set([...known, ...found])] }));
  } catch {
    /* another waiter is writing the same finding */
  }
  return found.length > 0 ? 'orphans' : 'dead';
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
      if (holder && typeof holder.pid === 'number') stale = holderState(file, holder) === 'dead';
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
      const state = h && typeof h.pid === 'number' ? holderState(slotFile(cls, i), h) : 'dead';
      if (state === 'alive') {
        const who = alive(h.pid) ? `pid ${h.pid}` : `pid ${h.childPid} (its wrapper ${h.pid} is gone; the command still runs)`;
        lines.push(`${cls}[${i}] ${who} since ${h.since} ${h.label ?? ''}`);
      } else if (state === 'orphans') {
        const left = (readHolder(slotFile(cls, i))?.orphans ?? []).filter(alive);
        lines.push(`${cls}[${i}] HELD BY ORPHANS pid ${left.join(', ')} (wrapper ${h.pid} and its command are gone; what they started still runs) since ${h.since} ${h.label ?? ''}`);
      }
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
if (!cls || !(cls in CAPS)) usage('--class must be cpu, gpu, bake or stack');
const cmd = argv.slice(sep + 1);
const label = opts.label ?? cmd.join(' ').slice(0, 120);

fs.mkdirSync(lockDir, { recursive: true });
const t0 = Date.now();

// Waiting order: first come, first served within a class. Every waiter keeps a ticket file named by its
// start time and refreshes it on each poll; it tries for a slot only while no OLDER live ticket of its class
// exists. A ticket whose process is gone, or that was not refreshed for TICKET_STALE_MS (a killed waiter, a
// reused pid), is removed by whoever sees it. Taking a slot is still decided by the exclusive creation of the
// slot file alone (tryAcquire), so the order can delay a waiter but can never admit two.
const TICKET_STALE_MS = 30_000;
const ticketName = `queue-${cls}-${String(t0).padStart(15, '0')}-${process.pid}.ticket`;
const ticketFile = path.join(lockDir, ticketName);
function touchTicket() {
  try {
    fs.writeFileSync(ticketFile, label);
  } catch {
    /* the order is best effort: without a ticket this waiter simply competes as before */
  }
}
function dropTicket() {
  try {
    fs.unlinkSync(ticketFile);
  } catch {
    /* already gone */
  }
}
/** Name of an older live ticket of this class, or null when this waiter is first in line. */
function olderWaiter() {
  let names;
  try {
    names = fs.readdirSync(lockDir);
  } catch {
    return null;
  }
  const prefix = `queue-${cls}-`;
  for (const name of names.filter((n) => n.startsWith(prefix) && n.endsWith('.ticket')).sort()) {
    if (name >= ticketName) break;
    const file = path.join(lockDir, name);
    const pid = Number(/-(\d+)\.ticket$/.exec(name)?.[1]);
    let fresh;
    try {
      fresh = Date.now() - fs.statSync(file).mtimeMs < TICKET_STALE_MS;
    } catch {
      continue; // removed meanwhile
    }
    if (fresh && Number.isInteger(pid) && alive(pid)) return name;
    try {
      fs.unlinkSync(file);
    } catch {
      /* another waiter removed it */
    }
  }
  return null;
}
process.on('exit', dropTicket);

let lock = null;
let lastNote = 0;
for (;;) {
  const freeGb = os.freemem() / GB;
  const waitedMin = (Date.now() - t0) / 60_000;
  const memoryOk = freeGb >= MIN_FREE_GB || waitedMin >= MAX_WAIT_MIN;
  touchTicket();
  if (memoryOk && olderWaiter() === null) {
    lock = tryAcquire(cls, label);
    if (lock) {
      dropTicket();
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

// A `node ...` command is started directly (the recorded pid is the command); anything else through the shell.
const direct = /^node(\.exe)?$/i.test(cmd[0]);
const child = direct
  ? spawn(process.execPath, cmd.slice(1), { stdio: 'inherit', env: { ...process.env, HEAVY_GATE: cls } })
  : spawn(cmd.map(quoteArg).join(' '), { stdio: 'inherit', shell: true, env: { ...process.env, HEAVY_GATE: cls } });

// Record the command's pid in the slot file: the slot stays held while it lives, even without this wrapper.
if (typeof child.pid === 'number') {
  try {
    const h = readHolder(lock);
    if (h && h.pid === process.pid) fs.writeFileSync(lock, JSON.stringify({ ...h, childPid: child.pid }));
  } catch {
    /* the slot is still held through this wrapper's pid */
  }
}

/** Kill the command and everything it started. */
function killTree() {
  if (typeof child.pid !== 'number' || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch {
    /* already exited */
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, () => {
    killTree();
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
