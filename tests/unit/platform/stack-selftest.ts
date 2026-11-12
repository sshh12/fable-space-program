/**
 * The launcher-level checks of the local stack (ARCHITECTURE 16.4; the brief's THE SLOT): this script starts
 * stacks itself, so it runs OUTSIDE one, with the stack slot free:
 *
 *   npx tsx tests/unit/platform/stack-selftest.ts [--only=a,b]
 *
 * Checks (each prints PASS or FAIL with its numbers; the exit code is the number of failures):
 *   slot       while a stack is up, heavy.mjs --status shows the stack slot held for it
 *   wait       a second `npm run stack` waits and does not start a second stack; it starts after the first is down
 *   free       the slot is free the moment the wrapped command has exited and the stack is down
 *   status     `npm run stack -- status` reports resident memory at or under 0.6 GB (Postgres, roles, stand-in)
 *   names      two runs with different STACK_NAME leave separate data directories and share no state
 *   kill       after the launcher is killed, `down` leaves no process and no open port and the slot is reclaimed;
 *              a committed row survives that kill
 *   refuse     a data directory created with other cluster settings (the package's default) is refused
 *   shapes     --shape=split and --shape=launch start every process on its own port
 *   offline    the stack starts with the Docker daemon stopped (no Docker process is involved)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PORTS, portOpen, shapeProcesses, type StackState } from '../../../deploy/local/launcher';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LOCK = path.join(REPO, 'data', 'stack', '.launcher.lock');
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const results: { name: string; ok: boolean; note: string }[] = [];
const report = (name: string, ok: boolean, note: string): void => {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${note}`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const want = (n: string): boolean => only.length === 0 || only.includes(n);

/** `npm run stack` with a command; returns the process and its collected output. */
function stack(name: string, args: string[], command: string[]): { p: ChildProcess; out: () => string; done: Promise<number> } {
  let out = '';
  const p = spawn('npm', ['run', '--silent', 'stack', '--', ...args, '--', ...command], { cwd: REPO, env: { ...process.env, STACK_NAME: name }, shell: true, windowsHide: true });
  p.stdout!.on('data', (c: Buffer) => (out += c.toString()));
  p.stderr!.on('data', (c: Buffer) => (out += c.toString()));
  const done = new Promise<number>((r) => p.on('exit', (c) => r(c ?? 1)));
  return { p, out: () => out, done };
}

const stateOf = (name: string): StackState | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'stack', name, 'state.json'), 'utf8')) as StackState;
  } catch {
    return null;
  }
};
const gateStatus = (): string => spawnSync(process.execPath, ['tools/dev/heavy.mjs', '--status'], { cwd: REPO, encoding: 'utf8' }).stdout;
const stackSlotLine = (): string => gateStatus().split(/\r?\n/).find((l) => l.startsWith('stack[0]')) ?? '';
async function waitUp(name: string, sinceMs: number, timeoutMs = 90_000): Promise<StackState> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = stateOf(name);
    if (s && s.running && Date.parse(s.startedAt) >= sinceMs && s.urls.page) return s;
    await sleep(250);
  }
  throw new Error(`stack ${name} did not come up`);
}
const HOLD = (s: number): string[] => ['node', '-e', `"setTimeout(()=>{},${s * 1000})"`];
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function main(): Promise<void> {
  if (stackSlotLine() !== 'stack[0] free') throw new Error(`the stack slot is not free (${stackSlotLine()}): run this when no stack is up`);

  if (want('slot') || want('wait') || want('free') || want('status')) {
    const t0 = Date.now();
    const a = stack('fsp-pd-selftest-a', [], HOLD(25));
    const s = await waitUp('fsp-pd-selftest-a', t0 - 1000);
    const line = stackSlotLine();
    report('slot', line.includes('stack[0] pid') && line.includes('fsp-pd-selftest-a'), line);
    if (want('status')) {
      const st = spawnSync('npm', ['run', '--silent', 'stack', '--', 'status'], { cwd: REPO, encoding: 'utf8', shell: true });
      const j = JSON.parse(st.stdout.trim().split(/\r?\n/).pop()!) as { residentBytes: number; withoutPage: number; postgres: number };
      console.log(st.stdout.trim());
      report('status', j.withoutPage <= 0.6 * 1024 ** 3, `resident ${(j.residentBytes / 1024 ** 2).toFixed(0)} MB in all, ${(j.withoutPage / 1024 ** 2).toFixed(0)} MB without the page server (Postgres ${(j.postgres / 1024 ** 2).toFixed(0)} MB); budget 600 MB`);
    }
    const tb = Date.now();
    const b = stack('fsp-pd-selftest-b', [], ['node', '-e', '"0"']);
    await sleep(6000);
    const bState = stateOf('fsp-pd-selftest-b');
    const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8')) as { pid: number; name: string };
    const bWaiting = b.p.exitCode === null && (!bState || !bState.running || Date.parse(bState.startedAt) < tb) && lock.name === 'fsp-pd-selftest-a';
    report('wait', bWaiting, `after 6 s the second launcher is ${b.p.exitCode === null ? 'still waiting' : `exited ${b.p.exitCode}`}; the launcher lock names ${lock.name}; ${s.processes.length} processes of the first stack up`);
    const codeA = await a.done;
    const aDownAt = Date.now();
    const afterA = stackSlotLine();
    const codeB = await b.done;
    const bState2 = stateOf('fsp-pd-selftest-b');
    report('free', codeA === 0 && (afterA === 'stack[0] free' || afterA.includes('fsp-pd-selftest-b')) && codeB === 0 && !!bState2 && Date.parse(bState2.startedAt) >= aDownAt - 1000, `first stack exited ${codeA}; slot right after: "${afterA}"; the second ran after it (exit ${codeB})`);
    if (want('names')) {
      const aDir = path.join(REPO, 'data', 'stack', 'fsp-pd-selftest-a', 'pg');
      const bDir = path.join(REPO, 'data', 'stack', 'fsp-pd-selftest-b', 'pg');
      report('names', fs.existsSync(path.join(aDir, 'PG_VERSION')) && fs.existsSync(path.join(bDir, 'PG_VERSION')) && aDir !== bDir, `separate clusters ${path.relative(REPO, aDir)} and ${path.relative(REPO, bDir)}`);
    }
  }

  if (want('kill') || want('names')) {
    // A committed row in stack a; then the launcher is killed hard; down cleans up; the row is still there.
    const t0 = Date.now();
    const a = stack('fsp-pd-selftest-a', [], HOLD(300));
    const s = await waitUp('fsp-pd-selftest-a', t0 - 1000);
    const c = new pg.Client({ connectionString: s.postgres.url });
    await c.connect();
    const mark = `selftest-${t0}`;
    await c.query('create table if not exists selftest_marks (mark text primary key)');
    await c.query('insert into selftest_marks values ($1)', [mark]);
    await c.end();
    const pids = [s.launcherPid, ...s.processes.map((p) => p.pid)];
    spawnSync('taskkill', ['/PID', String(s.launcherPid), '/F'], { stdio: 'ignore' }); // the launcher alone, as a crash would
    await a.done;
    await sleep(1500);
    const orphans = pids.filter((p) => p !== s.launcherPid && alive(p));
    const slotAfterKill = stackSlotLine();
    const d = spawnSync('npm', ['run', '--silent', 'stack', '--', 'down'], { cwd: REPO, encoding: 'utf8', shell: true });
    const left = pids.filter(alive);
    const open: number[] = [];
    for (const p of Object.values(PORTS)) if (await portOpen(p)) open.push(p);
    report('kill', left.length === 0 && open.length === 0 && !fs.existsSync(LOCK) && stackSlotLine() === 'stack[0] free', `${orphans.length} role processes outlived the killed launcher; slot after the kill "${slotAfterKill}"; down: ${d.stdout.trim().split(/\r?\n/).pop()}; left ${left.length} processes, open ports [${open.join(',')}]`);
    // The row survived, and stack b (another name) does not see it.
    const t1 = Date.now();
    const check = stack('fsp-pd-selftest-a', [], ['node', '-e', '"0"']);
    const s2 = await waitUp('fsp-pd-selftest-a', t1 - 1000);
    const c2 = new pg.Client({ connectionString: s2.postgres.url });
    await c2.connect();
    const found = (await c2.query('select 1 from selftest_marks where mark = $1', [mark])).rowCount;
    await c2.end();
    await check.done;
    const t2 = Date.now();
    const other = stack('fsp-pd-selftest-b', [], ['node', '-e', '"0"']);
    const s3 = await waitUp('fsp-pd-selftest-b', t2 - 1000);
    const c3 = new pg.Client({ connectionString: s3.postgres.url });
    await c3.connect();
    const inB = (await c3.query(`select to_regclass('selftest_marks') as t`)).rows[0] as { t: string | null };
    await c3.end();
    await other.done;
    report('kill-row', found === 1, `the row committed before the launcher was killed is ${found === 1 ? 'there' : 'MISSING'} after down and a new start`);
    report('names-state', inB.t === null, `stack fsp-pd-selftest-b ${inB.t === null ? 'has no' : 'HAS the'} table of fsp-pd-selftest-a`);
  }

  if (want('refuse')) {
    const dir = path.join(REPO, 'data', 'stack', 'fsp-pd-selftest-c', 'pg');
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const { initdb } = await import('@embedded-postgres/windows-x64');
    const pw = path.join(path.dirname(dir), 'pw.txt');
    fs.writeFileSync(pw, 'stack-local\n');
    const r = spawnSync(initdb, [`--pgdata=${dir}`, '--auth=scram-sha-256', '--username=postgres', `--pwfile=${pw}`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`initdb: ${r.stderr}`);
    const x = stack('fsp-pd-selftest-c', [], ['node', '-e', '"0"']);
    const code = await x.done;
    report('refuse', code !== 0 && /Refusing to start/.test(x.out()), `exit ${code}: ${(x.out().match(/the cluster in .*?locale provider/) ?? ['(no refusal message)'])[0]}`);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }

  if (want('shapes')) {
    for (const shape of ['split', 'launch'] as const) {
      const t0 = Date.now();
      const probe = `"Promise.all(${JSON.stringify(shapeProcesses(shape).map((p) => p.port)).replace(/"/g, '')}.map(p=>fetch('http://127.0.0.1:'+p+'/healthz').then(r=>r.status))).then(s=>{console.log('HEALTH',s.join(','));process.exitCode=s.every(x=>x===200)?0:1})"`;
      const x = stack('fsp-pd-selftest-a', [`--shape=${shape}`], ['node', '-e', probe]);
      const code = await x.done;
      const s = stateOf('fsp-pd-selftest-a');
      const ports = new Set(s?.processes.filter((p) => p.name !== 'page').map((p) => p.port));
      if (code !== 0) console.log(x.out().slice(-1500));
      report(`shape-${shape}`, code === 0 && ports.size === shapeProcesses(shape).length && Date.parse(s!.startedAt) >= t0 - 1000, `${s?.processes.filter((p) => p.name !== 'page').map((p) => `${p.name}:${p.port}`).join(' ')}; ${(x.out().match(/HEALTH .*/) ?? ['no health line'])[0]}; exit ${code}`);
    }
  }

  if (want('offline')) {
    const dockerUp = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 15_000 }).status === 0;
    const procs = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Process -Name "com.docker.backend","Docker Desktop","vmmemWSL" -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count'], { encoding: 'utf8' }).stdout.trim();
    report('offline', !dockerUp, `Docker daemon ${dockerUp ? 'RUNNING' : 'not running'} (${procs} Docker or WSL VM processes) while every stack above ran`);
  }

  for (const n of ['fsp-pd-selftest-a', 'fsp-pd-selftest-b']) fs.rmSync(path.join(REPO, 'data', 'stack', n), { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  fs.mkdirSync(path.join(REPO, 'out', 'platform'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'out', 'platform', 'stack-selftest.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
  process.exit(failed);
}

main().catch((e: unknown) => {
  console.error(`selftest: ${(e as Error).message}`);
  process.exit(99);
});
