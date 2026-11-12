#!/usr/bin/env node
/**
 * The cost reading of the stage-0 skeleton (ARCHITECTURE 29.2, "one formula"; hosting-small section 9 item 1).
 *
 *   node deploy/railway/usage.mjs snapshot          append one reading to docs/capacity/railway-usage.jsonl:
 *                                                    the workspace's usage and estimated bill, the game
 *                                                    project's usage per service (railway usage projects), and
 *                                                    each service's memory and CPU over the last hour
 *   node deploy/railway/usage.mjs report [--from=<iso>] [--to=<iso>]
 *                                                    the window between two readings (default: the first and
 *                                                    the last): U = the game's usage in the window, projected to
 *                                                    730 hours, per service; judged as U + $5 against $30 (idle);
 *                                                    the workspace bill max($5, U + the other project's
 *                                                    projection) beside it
 *
 * The other project's projection is Railway's own estimate for the period less the game's share of it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG = path.join(REPO, 'docs', 'capacity', 'railway-usage.jsonl');
const PROJECT = '7cc16fa5-1790-44e6-8087-4e75673a5a7a';

function railwayBin() {
  if (process.env.RAILWAY_BIN) return process.env.RAILWAY_BIN;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const exe = path.join(process.env.APPDATA, 'npm', 'node_modules', '@railway', 'cli', 'bin', 'railway.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return 'railway';
}
const rwJson = (args) => {
  const r = spawnSync(railwayBin(), [...args, '--json'], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`railway ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
};

function snapshot() {
  const at = new Date().toISOString();
  const ws = rwJson(['usage']);
  const proj = rwJson(['usage', 'projects', '--project', PROJECT]);
  const metrics = rwJson(['metrics', '--all', '--since', '1h', '--memory', '--cpu', '-p', PROJECT, '-e', 'production']);
  const row = {
    at,
    workspace: { usage: ws.currentUsageDollars, estimatedBill: ws.estimatedBillDollars, period: ws.billingPeriod },
    game: {
      usage: proj.currentUsageDollars,
      services: Object.fromEntries(proj.services.map((s) => [s.name, { total: s.totalDollars, cpu: s.cpuDollars, memory: s.memoryDollars, egress: s.egressDollars, volume: s.volumeDollars }])),
    },
    metrics: Object.fromEntries(metrics.services.filter((s) => s.memory).map((s) => [s.name, { memoryMb: s.memory.current_mb, memoryLimitMb: s.memory.limit_mb, vcpu: s.cpu.current, vcpuLimit: s.cpu.limit }])),
  };
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify(row, null, 1));
}

function report(from, to) {
  const rows = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const a = from ? rows.find((r) => r.at >= from) : rows[0];
  const b = to ? [...rows].reverse().find((r) => r.at <= to) : rows[rows.length - 1];
  if (!a || !b || a === b) throw new Error('need two readings in the window');
  const hours = (Date.parse(b.at) - Date.parse(a.at)) / 3600_000;
  const k = 730 / hours;
  const per = {};
  for (const [name, s] of Object.entries(b.game.services)) {
    const s0 = a.game.services[name] ?? { total: 0, cpu: 0, memory: 0, egress: 0, volume: 0 };
    per[name] = { windowDollars: s.total - s0.total, monthly: (s.total - s0.total) * k, memoryMonthly: (s.memory - s0.memory) * k, cpuMonthly: (s.cpu - s0.cpu) * k, egressMonthly: (s.egress - s0.egress) * k, volumeMonthly: (s.volume - s0.volume) * k };
  }
  const U = Object.values(per).reduce((n, s) => n + s.monthly, 0);
  // The other project: Railway's estimate for the period less the game's own share of the usage so far.
  const other = b.workspace.estimatedBill - b.game.usage * ((Date.parse(b.workspace.period.end) - Date.parse(b.workspace.period.start)) / (Date.parse(b.at) - Date.parse(b.workspace.period.start)));
  const out = {
    window: { from: a.at, to: b.at, hours },
    perService: per,
    U,
    judgedAgainstCeiling: { value: U + 5, ceiling: 30, ok: U + 5 <= 30 },
    workspaceBill: Math.max(5, U + other),
    otherProjectProjection: other,
    memoryNow: b.metrics,
  };
  console.log(JSON.stringify(out, null, 1));
}

const [cmd] = process.argv.slice(2);
const opt = (n) => process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
if (cmd === 'snapshot') snapshot();
else if (cmd === 'report') report(opt('from'), opt('to'));
else {
  console.error('usage: node deploy/railway/usage.mjs snapshot | report [--from=<iso>] [--to=<iso>]');
  process.exit(2);
}
