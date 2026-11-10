#!/usr/bin/env node
/**
 * Resource logger (lead-owned). Appends one line every 15 s to out/sysmon/sysmon-<date>.log and flushes it
 * to disk, so that after a hard crash the last lines show what the machine was doing: free physical memory,
 * the processes holding the most memory (grouped by image name), GPU memory / load / temperature, and the
 * heavy-job slots in use (tools/dev/heavy.mjs).
 *
 *   node tools/dev/sysmon.mjs            run until killed
 *   node tools/dev/sysmon.mjs --tail=20  print the last 20 lines of the newest log and exit
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.join(repoRoot, 'out', 'sysmon');
const lockDir = path.join(repoRoot, 'out', 'locks');
const GB = 1024 ** 3;
fs.mkdirSync(dir, { recursive: true });

const tailArg = process.argv.find((a) => a.startsWith('--tail='));
if (tailArg) {
  const logs = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
  if (logs.length === 0) process.exit(0);
  const lines = fs.readFileSync(path.join(dir, logs[logs.length - 1]), 'utf8').trimEnd().split('\n');
  console.log(lines.slice(-Number(tailArg.slice(7))).join('\n'));
  process.exit(0);
}

function topProcesses() {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    const byName = new Map();
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)","[^"]*","[^"]*","([\d.,\s]+) K"/.exec(line);
      if (!m) continue;
      const kb = Number(m[3].replace(/[^\d]/g, ''));
      const e = byName.get(m[1]) ?? { n: 0, kb: 0 };
      e.n++;
      e.kb += kb;
      byName.set(m[1], e);
    }
    return [...byName.entries()]
      .sort((a, b) => b[1].kb - a[1].kb)
      .slice(0, 8)
      .map(([name, e]) => `${name.replace(/\.exe$/i, '')}x${e.n}=${(e.kb / 1024 / 1024).toFixed(1)}G`)
      .join(' ');
  } catch (e) {
    return `tasklist-failed:${e.code ?? e.message}`;
  }
}

function gpu() {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.used,utilization.gpu,temperature.gpu,power.draw', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true },
    );
    const [mem, util, temp, power] = out.trim().split(/\s*,\s*/);
    return `gpu ${(Number(mem) / 1024).toFixed(1)}G ${util}% ${temp}C ${Math.round(Number(power))}W`;
  } catch {
    return 'gpu n/a';
  }
}

function slots() {
  try {
    const held = [];
    for (const f of fs.readdirSync(lockDir)) {
      const m = /^heavy-([a-z]+)-(\d+)\.lock$/.exec(f);
      if (!m) continue;
      try {
        const h = JSON.parse(fs.readFileSync(path.join(lockDir, f), 'utf8'));
        held.push(`${m[1]}${m[2]}:${String(h.label ?? '').slice(0, 40).replace(/\s+/g, '_')}`);
      } catch {
        /* being written */
      }
    }
    return held.length ? held.join(' ') : '-';
  } catch {
    return '-';
  }
}

function tick() {
  const now = new Date();
  const file = path.join(dir, `sysmon-${now.toISOString().slice(0, 10)}.log`);
  const free = os.freemem() / GB;
  const line = `${now.toISOString()} free ${free.toFixed(1)}G/${(os.totalmem() / GB).toFixed(0)}G${free < 6 ? ' LOW-MEMORY' : ''} | ${gpu()} | slots ${slots()} | ${topProcesses()}\n`;
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

tick();
setInterval(tick, 15_000);
