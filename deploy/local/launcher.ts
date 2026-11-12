/**
 * The local stack (ARCHITECTURE 16.4; hosting-small section 8): the whole game on this machine with no cloud
 * resource, from one command, inside the ONE `stack` slot of the heavy gate.
 *
 *   npm run stack -- [options] -- <command>   bring the stack up, run <command> with STACK_URL, STACK_ENDPOINTS
 *                                             and STACK_STATE set, bring the stack down when it exits (whatever
 *                                             its exit code, and on a signal); exit with its code
 *   npm run stack -- [options]                the same without a command: in the foreground until interrupted
 *   npm run stack -- status                   what runs, with resident memory (no slot needed)
 *   npm run stack -- down                     clean up after a launcher that died: no process, no open port
 *
 * Options:
 *   --shape=combined|split|launch   the wiring of stage 0-1 (game + shell), stage 2 (gate, dir carrying api
 *                                   and pub, sim-1, sim-2, shell) or stage 3 (two gates, dir, sim-1, sim-2,
 *                                   api, pub, shell, packs), each process on its own port. Default combined
 *   --page=dev|build                the page: the Vite dev server (default; it also serves the plain-file
 *                                   tiles) or the shell role serving `npm run stack:client`'s build
 *   --profile=acceptance|load       load: refuses to start with less than 16 GB of physical memory free
 *   --rules=<name>                  the rule set the server roles load (passed as RULES)
 *   --fresh                         a new database (the data directory is deleted first)
 *   --mirror=slices|ranges          the mirror mode the stack's pack list announces (default slices, 2 MiB)
 *   --db=docker                     Postgres 18 in a container instead of the embedded one (needs Docker)
 *   --compose                       the high-fidelity form: deploy/local/compose.yml (needs Docker)
 *   STACK_NAME                      state under data/stack/<name> (default `default`)
 *
 * What it starts (host form): a real PostgreSQL 18 from embedded-postgres in data/stack/<name>/pg, created
 * with production's cluster settings (UTF8, the built-in C.UTF-8 locale) and refused if a data directory
 * was created otherwise; the bucket and mirror stand-in over data/packs (deploy/local/bucketStandIn.ts); the
 * role processes of the shape (the server bundle, as in the image); the page; the endpoint document
 * data/stack/<name>/endpoints.json, the only way a client learns an address.
 *
 * Two locks keep it to one stack: the gate's slot (the launcher refuses to run outside it) and the
 * launcher's own exclusive lock data/stack/.launcher.lock (taken before anything starts, so two stacks
 * can never run even if a wrapper dies). Ports are one fixed range (47200-47221): one stack at a time.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { clusterFacts, type ClusterFacts } from '../roles/hello';
import { startBucketStandIn, type StandIn } from './bucketStandIn';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STACK_ROOT = path.join(REPO, 'data', 'stack');
const LOCK = path.join(STACK_ROOT, '.launcher.lock');
export const PORTS = {
  page: 47200,
  bucket: 47201,
  shell: 47202,
  game: 47203,
  dir: 47204,
  'sim-1': 47205,
  'sim-2': 47206,
  api: 47207,
  pub: 47208,
  packs: 47209,
  'gate-2': 47210,
  pg: 47220,
  minio: 47221,
} as const;
export const CLUSTER_FLAGS = ['--encoding=UTF8', '--locale-provider=builtin', '--builtin-locale=C.UTF-8'];
export { PRODUCTION_PG_SETTINGS as PRODUCTION_SETTINGS } from '../roles/pgsettings';
import { PRODUCTION_PG_SETTINGS as PRODUCTION_SETTINGS } from '../roles/pgsettings';
const PG_USER = 'postgres';
const PG_PASSWORD = 'stack-local';
const PG_DB = 'fsp';
const STAND_IN = { bucket: 'packs', accessKeyId: 'stack-local', secretAccessKey: 'stack-local-secret' };
const SLICE_BYTES = 2 * 1024 * 1024;

type Shape = 'combined' | 'split' | 'launch';
interface Options {
  shape: Shape;
  page: 'dev' | 'build';
  profile: 'acceptance' | 'load';
  rules: string;
  fresh: boolean;
  mirror: 'slices' | 'ranges';
  db: 'embedded' | 'docker';
  compose: boolean;
}

export interface ProcSpec {
  name: string;
  roles: string;
  port: number;
  db: boolean;
  /** Holds the packs credential: signs the pack list (api) or carries the mirror and the boot pack (shell, packs). */
  packs: boolean;
}

export interface StackState {
  name: string;
  running: boolean;
  launcherPid: number;
  startedAt: string;
  options: Options;
  dataDir: string;
  urls: { page: string; shell: string; packList: string; bucket: string; mirror: string };
  endpointsFile: string;
  processes: { name: string; pid: number; port: number | null; roles: string }[];
  postgres: { dir: string; port: number; url: string; initMs: number | null; readyMs: number; facts: ClusterFacts | null; postmasterPid: number | null };
  bootPack: { hash: string; bytes: number; manifest: string } | null;
  serverBundle: string;
  timings: Record<string, number>;
}

/** The processes of a shape (ARCHITECTURE 16.1, 16.4). */
export function shapeProcesses(shape: Shape): ProcSpec[] {
  const shell: ProcSpec = { name: 'shell', roles: 'shell', port: PORTS.shell, db: false, packs: true };
  if (shape === 'combined') return [{ name: 'game', roles: 'game', port: PORTS.game, db: true, packs: true }, shell];
  if (shape === 'split') {
    return [
      { name: 'gate', roles: 'gate', port: PORTS.game, db: false, packs: false },
      { name: 'dir', roles: 'dir,api,pub', port: PORTS.dir, db: true, packs: true },
      { name: 'sim-1', roles: 'sim-1', port: PORTS['sim-1'], db: false, packs: false },
      { name: 'sim-2', roles: 'sim-2', port: PORTS['sim-2'], db: false, packs: false },
      shell,
    ];
  }
  return [
    { name: 'gate', roles: 'gate', port: PORTS.game, db: false, packs: false },
    { name: 'gate-2', roles: 'gate', port: PORTS['gate-2'], db: false, packs: false },
    { name: 'dir', roles: 'dir', port: PORTS.dir, db: true, packs: false },
    { name: 'sim-1', roles: 'sim-1', port: PORTS['sim-1'], db: false, packs: false },
    { name: 'sim-2', roles: 'sim-2', port: PORTS['sim-2'], db: false, packs: false },
    { name: 'api', roles: 'api', port: PORTS.api, db: true, packs: true },
    { name: 'pub', roles: 'pub', port: PORTS.pub, db: false, packs: false },
    shell,
    { name: 'packs', roles: 'packs', port: PORTS.packs, db: false, packs: true },
  ];
}

/** gate / api / pub candidates of a shape, in order (the endpoint document). */
export function shapeEndpoints(shape: Shape): { gate: string[]; api: string[]; pub: string[]; mirrorPort: number } {
  const u = (p: number): string => `http://127.0.0.1:${p}`;
  if (shape === 'combined') return { gate: [u(PORTS.game)], api: [u(PORTS.game)], pub: [u(PORTS.game)], mirrorPort: PORTS.shell };
  if (shape === 'split') return { gate: [u(PORTS.game)], api: [u(PORTS.dir)], pub: [u(PORTS.dir)], mirrorPort: PORTS.shell };
  return { gate: [u(PORTS.game), u(PORTS['gate-2'])], api: [u(PORTS.api)], pub: [u(PORTS.pub)], mirrorPort: PORTS.packs };
}

// ------------------------------------------------------------------------------------------------ helpers

const now = (): string => new Date().toISOString().slice(11, 23);
const say = (line: string): void => {
  process.stderr.write(`stack ${now()} ${line}\n`);
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function killTree(pid: number): void {
  if (!alive(pid)) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

/** Is something listening on the port (127.0.0.1)? */
export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

async function waitFor(what: string, test: () => Promise<boolean>, timeoutMs: number): Promise<number> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if (await test().catch(() => false)) return performance.now() - t0;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what}: not ready after ${(timeoutMs / 1000).toFixed(0)} s`);
}

const httpOk = (url: string): Promise<boolean> =>
  fetch(url, { signal: AbortSignal.timeout(2000) }).then(
    (r) => {
      void r.body?.cancel();
      return r.ok;
    },
    () => false,
  );

function parseArgs(argv: string[]): { opts: Options; command: string[] } {
  const sep = argv.indexOf('--');
  const own = sep >= 0 ? argv.slice(0, sep) : argv;
  const command = sep >= 0 ? argv.slice(sep + 1) : [];
  const opts: Options = { shape: 'combined', page: 'dev', profile: 'acceptance', rules: 'local', fresh: false, mirror: 'slices', db: 'embedded', compose: false };
  for (const a of own) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unknown argument ${a}`);
    const [, k, v] = m;
    const one = <T extends string>(allowed: readonly T[]): T => {
      if (!allowed.includes(v as T)) throw new Error(`--${k} must be one of ${allowed.join(', ')}`);
      return v as T;
    };
    if (k === 'shape') opts.shape = one(['combined', 'split', 'launch'] as const);
    else if (k === 'page') opts.page = one(['dev', 'build'] as const);
    else if (k === 'profile') opts.profile = one(['acceptance', 'load'] as const);
    else if (k === 'rules') opts.rules = v ?? 'local';
    else if (k === 'fresh') opts.fresh = true;
    else if (k === 'mirror') opts.mirror = one(['slices', 'ranges'] as const);
    else if (k === 'db') opts.db = one(['docker'] as const);
    else if (k === 'compose') opts.compose = true;
    else throw new Error(`unknown option --${k}`);
  }
  return { opts, command };
}

const quoteArg = (a: string): string => (/^[A-Za-z0-9_\-./:=@,+\\*]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

// --------------------------------------------------------------------------------------------- the lock

interface LockInfo {
  pid: number;
  name: string;
  since: string;
}

function readLock(): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(LOCK, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

/** The launcher's own exclusive lock; a lock whose holder is dead is taken over. */
function takeLock(name: string): void {
  fs.mkdirSync(STACK_ROOT, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, name, since: new Date().toISOString() } satisfies LockInfo));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const h = readLock();
      if (h && alive(h.pid)) throw new Error(`another stack (${h.name}, launcher pid ${h.pid}, since ${h.since}) holds ${path.relative(REPO, LOCK)}`);
      say(`the lock of a dead launcher (${h ? `${h.name}, pid ${h.pid}` : 'unreadable'}) is taken over; run \`npm run stack -- down\` if its processes still run`);
      fs.rmSync(LOCK, { force: true });
    }
  }
  throw new Error('could not take the launcher lock');
}

function releaseLock(): void {
  const h = readLock();
  if (h && h.pid === process.pid) fs.rmSync(LOCK, { force: true });
}

// ------------------------------------------------------------------------------------------- postgres

async function pgBinaries(): Promise<{ pg_ctl: string; initdb: string; postgres: string }> {
  if (process.platform === 'win32' && process.arch === 'x64') return import('@embedded-postgres/windows-x64');
  if (process.platform === 'linux' && process.arch === 'x64') return import('@embedded-postgres/linux-x64' as string) as Promise<{ pg_ctl: string; initdb: string; postgres: string }>;
  throw new Error(`no embedded Postgres binaries for ${process.platform}-${process.arch}`);
}

export const pgUrl = (db = PG_DB): string => `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PORTS.pg}/${db}`;

/**
 * Run pg_ctl. Its output goes to a file, not a pipe: on Windows the server that `pg_ctl start` launches
 * inherits pg_ctl's handles, and a pipe it holds would keep spawnSync waiting for ever.
 */
function pgCtl(bin: string, args: string[]): { status: number; out: string } {
  const file = path.join(os.tmpdir(), `fsp-pgctl-${process.pid}-${Date.now()}.log`);
  const fd = fs.openSync(file, 'w');
  try {
    const r = spawnSync(bin, args, { stdio: ['ignore', fd, fd], windowsHide: true });
    return { status: r.status ?? 1, out: fs.readFileSync(file, 'utf8') };
  } finally {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
  }
}

function postmasterPid(dir: string): number | null {
  try {
    const n = Number(fs.readFileSync(path.join(dir, 'postmaster.pid'), 'utf8').split(/\r?\n/)[0]);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function stopPostgres(dir: string, mode: 'fast' | 'immediate' = 'fast'): Promise<void> {
  if (!fs.existsSync(path.join(dir, 'postmaster.pid'))) return;
  const { pg_ctl } = await pgBinaries();
  const r = pgCtl(pg_ctl, ['stop', '-D', dir, '-m', mode, '-w', '-t', '30']);
  if (r.status !== 0 && fs.existsSync(path.join(dir, 'postmaster.pid'))) {
    const pid = postmasterPid(dir);
    if (pid && alive(pid)) {
      say(`pg_ctl stop -m ${mode} failed (${r.out.trim()}); killing the postmaster ${pid}`);
      killTree(pid);
    }
  }
}

/** Start the embedded Postgres (initialising it with production's cluster settings when new); refuse a cluster created otherwise. */
async function startPostgres(dir: string, fresh: boolean, logFile: string): Promise<{ initMs: number | null; readyMs: number; facts: ClusterFacts }> {
  const { pg_ctl } = await pgBinaries();
  if (fresh && fs.existsSync(dir)) {
    await stopPostgres(dir, 'immediate');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  let initMs: number | null = null;
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const t0 = performance.now();
    await new EmbeddedPostgres({
      databaseDir: dir,
      port: PORTS.pg,
      user: PG_USER,
      password: PG_PASSWORD,
      authMethod: 'scram-sha-256',
      persistent: true,
      initdbFlags: CLUSTER_FLAGS,
      onLog: (m: string) => fs.appendFileSync(logFile, m),
      onError: (m: unknown) => fs.appendFileSync(logFile, `${String(m)}\n`),
    }).initialise();
    initMs = performance.now() - t0;
  }
  const start = (): number => {
    const t0 = performance.now();
    const r = pgCtl(pg_ctl, ['start', '-D', dir, '-w', '-t', '60', '-l', logFile, '-o', `-p ${PORTS.pg} -c listen_addresses=127.0.0.1`]);
    if (r.status !== 0) throw new Error(`pg_ctl start failed: ${r.out.trim()} (log: ${logFile})`);
    return performance.now() - t0;
  };
  let readyMs = start();
  let settingsChanged = false;
  const admin = new pg.Client({ connectionString: pgUrl('postgres') });
  await admin.connect();
  let facts: ClusterFacts;
  try {
    facts = await clusterFacts(admin);
    if (facts.serverEncoding !== 'UTF8' || facts.localeProvider !== 'builtin') {
      throw new Error(`the cluster in ${dir} is ${facts.serverEncoding} with the ${facts.localeProvider} locale provider; production's is UTF8 with the built-in C.UTF-8 locale. Refusing to start on it: delete it or run with --fresh`);
    }
    // Idempotent, so an initialisation that was interrupted is completed by the next start.
    if ((await admin.query('select 1 from pg_database where datname = $1', [PG_DB])).rowCount === 0) await admin.query(`CREATE DATABASE ${PG_DB}`);
    for (const [k, v] of PRODUCTION_SETTINGS) {
      const cur = (await admin.query<{ v: string }>('select current_setting($1) as v', [k])).rows[0]!.v;
      if (cur !== v) {
        await admin.query(`ALTER SYSTEM SET ${k} = '${v}'`);
        settingsChanged = true;
      }
    }
  } catch (e) {
    await admin.end().catch(() => undefined);
    await stopPostgres(dir);
    throw e;
  }
  await admin.end();
  if (settingsChanged) {
    // The settings of ALTER SYSTEM need a restart (shared_buffers, max_connections); time the second start.
    pgCtl(pg_ctl, ['stop', '-D', dir, '-m', 'fast', '-w']);
    readyMs = start();
  }
  return { initMs, readyMs, facts };
}

// ------------------------------------------------------------------------------------------------- run

function stateFile(name: string): string {
  return path.join(STACK_ROOT, name, 'state.json');
}

function writeState(s: StackState): void {
  fs.writeFileSync(stateFile(s.name), `${JSON.stringify(s, null, 1)}\n`);
}

function readState(name: string): StackState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(name), 'utf8')) as StackState;
  } catch {
    return null;
  }
}

/** The boot manifest the stack's shell serves: deploy/boot-manifest.json when its pack is local, else the newest local one. */
function chooseBootManifest(): { hash: string; bytes: number; manifest: string } | null {
  const tracked = path.join(REPO, 'deploy', 'boot-manifest.json');
  const bootDir = path.join(REPO, 'data', 'packs', 'boot');
  if (fs.existsSync(tracked)) {
    const m = JSON.parse(fs.readFileSync(tracked, 'utf8')) as { hash: string; bytes: number };
    if (fs.existsSync(path.join(bootDir, `${m.hash}.pack`))) return { ...m, manifest: tracked };
  }
  if (!fs.existsSync(bootDir)) return null;
  const local = fs
    .readdirSync(bootDir)
    .filter((f) => f.endsWith('.manifest.json'))
    .map((f) => path.join(bootDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!local) return null;
  const m = JSON.parse(fs.readFileSync(local, 'utf8')) as { hash: string; bytes: number };
  return { ...m, manifest: local };
}

function buildServerBundle(): string {
  const out = path.join(STACK_ROOT, 'server');
  const r = spawnSync(process.execPath, [path.join(REPO, 'deploy', 'build', 'build-server.mjs'), `--out=${path.relative(REPO, out)}`], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`server bundle: ${r.stderr}`);
  say(`server bundle ${r.stdout.trim()}`);
  return path.join(out, 'main.mjs');
}

function buildClient(): string {
  const r = spawnSync('npm', ['run', '--silent', 'stack:client'], { cwd: REPO, encoding: 'utf8', shell: true });
  if (r.status !== 0) throw new Error(`npm run stack:client failed: ${r.stderr || r.stdout}`);
  const last = r.stdout
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith('{'));
  if (!last) throw new Error(`npm run stack:client printed no result: ${r.stdout}`);
  const j = JSON.parse(last) as { dir: string; built: boolean; seconds: number };
  say(`client build ${j.dir} (${j.built ? `built in ${j.seconds} s` : 'unchanged'})`);
  return path.resolve(REPO, j.dir);
}

async function run(opts: Options, command: string[]): Promise<number> {
  const name = process.env.STACK_NAME || 'default';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`STACK_NAME "${name}" may hold letters, digits, dot, dash and underscore only`);
  if (process.env.HEAVY_GATE !== 'stack') throw new Error('the launcher runs only inside the stack slot of the heavy gate: use `npm run stack -- [options] -- <command>`');
  if (opts.compose || opts.db === 'docker') {
    const { runCompose } = await import('./compose');
    return runCompose({ name, opts, command, takeLock: () => takeLock(name), releaseLock, say });
  }
  if (opts.profile === 'load') {
    const free = os.freemem() / 1024 ** 3;
    if (free < 16) throw new Error(`--profile=load needs 16 GB of physical memory free; ${free.toFixed(1)} GB is (ARCHITECTURE 16.4)`);
  }
  takeLock(name);
  const t0 = performance.now();
  const dataDir = path.join(STACK_ROOT, name);
  fs.mkdirSync(dataDir, { recursive: true });
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const token = randomBytes(16).toString('hex');
  const children: { name: string; child: ChildProcess; port: number | null; roles: string }[] = [];
  let standIn: StandIn | null = null;
  const pgDir = path.join(dataDir, 'pg');
  let pgStarted = false;
  let useFile: string | null = null;
  const timings: Record<string, number> = {};
  const urls = { page: '', shell: `http://127.0.0.1:${PORTS.shell}`, packList: '', bucket: `http://127.0.0.1:${PORTS.bucket}/${STAND_IN.bucket}/p/`, mirror: '' };
  const endpointsFile = path.join(dataDir, 'endpoints.json');
  const state: StackState = {
    name,
    running: true,
    launcherPid: process.pid,
    startedAt: new Date().toISOString(),
    options: opts,
    dataDir,
    urls,
    endpointsFile,
    processes: [],
    postgres: { dir: pgDir, port: PORTS.pg, url: pgUrl(), initMs: null, readyMs: 0, facts: null, postmasterPid: null },
    bootPack: null,
    serverBundle: '',
    timings,
  };
  writeState(state);

  let tearingDown: Promise<void> | null = null;
  const teardown = (): Promise<void> => {
    tearingDown ??= (async () => {
      say('stopping');
      // The page server takes no stop message: it holds no state.
      for (const c of children) if (c.port === null && c.child.exitCode === null && c.child.pid) killTree(c.child.pid);
      for (const c of children) {
        if (c.port !== null && c.child.exitCode === null) {
          await fetch(`http://127.0.0.1:${c.port}/_ctl/stop`, { method: 'POST', headers: { 'x-stack-token': token }, signal: AbortSignal.timeout(1500) }).catch(() => undefined);
        }
      }
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline && children.some((c) => c.child.exitCode === null && c.child.signalCode === null)) await new Promise((r) => setTimeout(r, 100));
      for (const c of children) if (c.child.exitCode === null && c.child.pid) killTree(c.child.pid);
      if (standIn) await standIn.close();
      if (pgStarted) await stopPostgres(pgDir);
      if (useFile) fs.rmSync(useFile, { force: true });
      state.running = false;
      writeState(state);
      releaseLock();
      say('down');
    })();
    return tearingDown;
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
    process.on(sig, () => {
      void teardown().then(() => process.exit(130));
    });
  }

  try {
    // Ports: one range, one stack. Anything listening there is a leftover of a dead stack.
    for (const [k, p] of Object.entries(PORTS)) if (await portOpen(p)) throw new Error(`port ${p} (${k}) is in use: another stack, or a leftover of one (\`npm run stack -- down\`)`);

    // 1. Postgres
    const pgRes = await startPostgres(pgDir, opts.fresh, path.join(logsDir, 'postgres.log'));
    pgStarted = true;
    state.postgres = { ...state.postgres, initMs: pgRes.initMs, readyMs: pgRes.readyMs, facts: pgRes.facts, postmasterPid: postmasterPid(pgDir) };
    timings.postgresReadyMs = pgRes.readyMs;
    if (pgRes.initMs !== null) timings.postgresInitMs = pgRes.initMs;
    say(`postgres ${pgRes.facts.serverVersionNum} ${pgRes.facts.serverEncoding}/${pgRes.facts.localeProvider} ready in ${pgRes.readyMs.toFixed(0)} ms${pgRes.initMs !== null ? ` (initialised in ${pgRes.initMs.toFixed(0)} ms)` : ''}`);
    writeState(state);

    // 2. The bucket and mirror stand-in over data/packs
    standIn = await startBucketStandIn({ packsDir: path.join(REPO, 'data', 'packs'), ...STAND_IN, sliceBytes: SLICE_BYTES, port: PORTS.bucket, log: (l) => fs.appendFileSync(path.join(logsDir, 'stand-in.log'), `${l}\n`) });

    // 3. The server bundle and the roles of the shape
    const bundle = buildServerBundle();
    state.serverBundle = bundle;
    const boot = chooseBootManifest();
    state.bootPack = boot;
    if (!boot) throw new Error('no boot pack in data/packs/boot: build one first (npx tsx tools/pack/cli.ts boot --build=<client build>)');
    const clientDir = opts.page === 'build' ? buildClient() : null;
    if (clientDir) {
      // npm run stack:client never prunes a build that has a live use file beside it (lead-baseline-v2 section 12).
      useFile = `${clientDir}.use-${process.pid}`;
      fs.writeFileSync(useFile, JSON.stringify({ pid: process.pid, stack: name, since: new Date().toISOString() }));
    }
    const ep = shapeEndpoints(opts.shape);
    urls.mirror = `http://127.0.0.1:${ep.mirrorPort}/p/`;
    urls.packList = `${ep.api[0]}/packs.json`;
    const common: Record<string, string> = {
      HOST: '127.0.0.1',
      STACK_CONTROL_TOKEN: token,
      STACK_NAME: name,
      RULES: opts.rules,
      NODE_OPTIONS: opts.profile === 'load' ? '--max-old-space-size=1024' : '--max-old-space-size=512',
    };
    const packsEnv: Record<string, string> = {
      PACKS_BUCKET: STAND_IN.bucket,
      PACKS_ENDPOINT: `http://127.0.0.1:${PORTS.bucket}`,
      PACKS_REGION: 'us-east-1',
      PACKS_ACCESS_KEY_ID: STAND_IN.accessKeyId,
      PACKS_SECRET_ACCESS_KEY: STAND_IN.secretAccessKey,
      PACKS_PATH_STYLE: '1',
      PACK_SETS_DIR: path.join(REPO, 'data', 'packs'),
      MIRROR_BASE: urls.mirror,
      MIRROR_MODE: opts.mirror,
      MIRROR_SLICE_BYTES: String(SLICE_BYTES),
      BOOT_MANIFEST: boot.manifest,
      ENDPOINT_GATE: ep.gate.join(','),
      ENDPOINT_API: ep.api.join(','),
      ENDPOINT_PUB: ep.pub.join(','),
    };
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PACKS_|DUMPS_|DATABASE_URL|STACK_|ROLES$|PORT$)/.test(k)));
    for (const spec of shapeProcesses(opts.shape)) {
      const env: Record<string, string | undefined> = { ...baseEnv, ...common, ROLES: spec.roles, PORT: String(spec.port) };
      if (spec.db) env.DATABASE_URL = pgUrl();
      if (spec.packs) Object.assign(env, packsEnv);
      if (spec.name === 'shell' && clientDir) env.STATIC_DIR = clientDir;
      const out = fs.openSync(path.join(logsDir, `${spec.name}.log`), 'a');
      const child = spawn(process.execPath, [bundle], { cwd: REPO, env, stdio: ['ignore', out, out], windowsHide: true });
      children.push({ name: spec.name, child, port: spec.port, roles: spec.roles });
      state.processes.push({ name: spec.name, pid: child.pid!, port: spec.port, roles: spec.roles });
      writeState(state);
    }
    const tRoles = performance.now();
    await Promise.all(
      children.map((c) =>
        waitFor(
          `${c.name} health (log: data/stack/${name}/logs/${c.name}.log)`,
          async () => {
            if (c.child.exitCode !== null) throw new Error(`${c.name} exited with ${c.child.exitCode} (log: data/stack/${name}/logs/${c.name}.log)`);
            return httpOk(`http://127.0.0.1:${c.port}/healthz`);
          },
          60_000,
        ),
      ),
    );
    timings.rolesHealthyMs = performance.now() - tRoles;

    // 4. The endpoint document and the page
    const shellVersion = (await (await fetch(`${urls.shell}/version.json`)).json()) as { clientBuild: string | null };
    fs.writeFileSync(
      endpointsFile,
      `${JSON.stringify({ v: 1, build: shellVersion.clientBuild, gate: ep.gate, api: ep.api, pub: ep.pub, bootPack: { url: `${urls.shell}/boot/${boot.hash}.pack`, hash: boot.hash, bytes: boot.bytes } }, null, 1)}\n`,
    );
    if (opts.page === 'dev') {
      const out = fs.openSync(path.join(logsDir, 'page.log'), 'a');
      const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORTS.page), '--strictPort', '--host', '127.0.0.1'], {
        cwd: REPO,
        env: { ...baseEnv, STACK_ENDPOINTS: endpointsFile },
        stdio: ['ignore', out, out],
        windowsHide: true,
      });
      children.push({ name: 'page', child: vite, port: null, roles: 'vite dev server' });
      state.processes.push({ name: 'page', pid: vite.pid!, port: PORTS.page, roles: 'vite dev server' });
      urls.page = `http://127.0.0.1:${PORTS.page}`;
      timings.pageReadyMs = await waitFor('the dev server', () => httpOk(`${urls.page}/endpoints.json`), 120_000);
    } else urls.page = urls.shell;
    timings.upMs = performance.now() - t0;
    writeState(state);
    say(`up in ${(timings.upMs / 1000).toFixed(1)} s: ${opts.shape}, page ${urls.page}, endpoints ${path.relative(REPO, endpointsFile)}`);

    // 5. The command, or the foreground
    if (command.length === 0) {
      say('no command: running until interrupted (Ctrl+C)');
      await new Promise<never>(() => undefined);
    }
    const code = await new Promise<number>((resolve) => {
      const c = spawn(command.map(quoteArg).join(' '), {
        stdio: 'inherit',
        shell: true,
        cwd: REPO,
        env: { ...process.env, STACK_URL: urls.page, STACK_ENDPOINTS: endpointsFile, STACK_STATE: stateFile(name) },
      });
      c.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      c.on('error', (e) => {
        say(`command failed to start: ${e.message}`);
        resolve(127);
      });
    });
    say(`command exited with ${code}`);
    await teardown();
    return code;
  } catch (e) {
    say(`failed: ${(e as Error).message}`);
    await teardown();
    return 1;
  }
}

// ---------------------------------------------------------------------------------------- status, down

/** Resident memory (bytes) of processes, Postgres children included, from one PowerShell call. */
export function residentMemory(pids: number[], postmaster: number | null): { byPid: Map<number, number>; postgres: number } {
  const byPid = new Map<number, number>();
  let postgres = 0;
  if (process.platform !== 'win32') return { byPid, postgres };
  const ps = [
    `$ids = @(${pids.filter((p) => alive(p)).join(',') || '0'})`,
    `Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { "p $($_.Id) $($_.WorkingSet64)" }`,
    postmaster ? `Get-CimInstance Win32_Process -Filter "ProcessId=${postmaster} OR ParentProcessId=${postmaster}" | ForEach-Object { "g $($_.ProcessId) $($_.WorkingSetSize)" }` : '',
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const m = /^([pg]) (\d+) (\d+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'p') byPid.set(Number(m[2]), Number(m[3]));
    else postgres += Number(m[3]);
  }
  return { byPid, postgres };
}

function status(): number {
  const lock = readLock();
  if (!lock) {
    console.log('no stack is running (no launcher lock)');
    return 0;
  }
  const s = readState(lock.name);
  const up = alive(lock.pid);
  console.log(`stack ${lock.name}: launcher pid ${lock.pid} ${up ? 'running' : 'DEAD (run `npm run stack -- down`)'} since ${lock.since}`);
  if (!s) return up ? 0 : 1;
  console.log(`shape ${s.options.shape}, page ${s.urls.page}, profile ${s.options.profile}, postgres ${s.postgres.facts?.serverVersionNum ?? '?'} ${s.postgres.facts?.serverEncoding ?? ''}/${s.postgres.facts?.localeProvider ?? ''}`);
  const pids = [s.launcherPid, ...s.processes.map((p) => p.pid)];
  const mem = residentMemory(pids, postmasterPid(s.postgres.dir));
  const mb = (b: number): string => `${(b / 1024 ** 2).toFixed(0)} MB`;
  const rows: [string, number][] = [['launcher (bucket and mirror stand-in)', mem.byPid.get(s.launcherPid) ?? 0], ...s.processes.map((p) => [`${p.name} (${p.roles}) :${p.port ?? ''}`, mem.byPid.get(p.pid) ?? 0] as [string, number]), ['postgres (all processes)', mem.postgres]];
  for (const [n, b] of rows) console.log(`  ${n.padEnd(40)} ${mb(b).padStart(8)}`);
  const page = s.processes.find((p) => p.name === 'page');
  const total = rows.reduce((n, [, b]) => n + b, 0);
  const pageBytes = page ? (mem.byPid.get(page.pid) ?? 0) : 0;
  console.log(`  ${'total'.padEnd(40)} ${mb(total).padStart(8)}`);
  console.log(`  ${'stack without the page server'.padEnd(40)} ${mb(total - pageBytes).padStart(8)}`);
  console.log(JSON.stringify({ residentBytes: total, withoutPage: total - pageBytes, postgres: mem.postgres }));
  return 0;
}

async function down(): Promise<number> {
  let cleaned = 0;
  const lock = readLock();
  if (lock && alive(lock.pid)) {
    console.log(`the launcher (pid ${lock.pid}) is alive: stopping it first`);
    killTree(lock.pid);
  }
  const names = fs.existsSync(STACK_ROOT) ? fs.readdirSync(STACK_ROOT).filter((n) => fs.existsSync(stateFile(n))) : [];
  for (const n of names) {
    const s = readState(n);
    if (!s) continue;
    for (const p of [...s.processes, { pid: s.launcherPid }]) {
      if (alive(p.pid)) {
        killTree(p.pid);
        cleaned++;
      }
    }
    if (fs.existsSync(path.join(s.postgres.dir, 'postmaster.pid'))) {
      await stopPostgres(s.postgres.dir, 'fast');
      cleaned++;
    }
    if (s.running) {
      s.running = false;
      writeState(s);
    }
  }
  fs.rmSync(LOCK, { force: true });
  const clientRoot = path.join(STACK_ROOT, 'client');
  if (fs.existsSync(clientRoot)) {
    for (const f of fs.readdirSync(clientRoot)) {
      const m = /.use-(d+)$/.exec(f);
      if (m && !alive(Number(m[1]))) fs.rmSync(path.join(clientRoot, f), { force: true });
    }
  }
  const open: number[] = [];
  for (const p of Object.values(PORTS)) if (await portOpen(p)) open.push(p);
  console.log(open.length === 0 ? `down: ${cleaned} leftover(s) stopped; no port of the stack range is open` : `down: ports still open: ${open.join(', ')} (something outside the stack holds them)`);
  return open.length === 0 ? 0 : 1;
}

// ------------------------------------------------------------------------------------------------ main

/** The launcher's command line (deploy/local/stack.mjs calls it; importing this module runs nothing). */
export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === 'status') return status();
    if (argv[0] === 'down') return await down();
    const { opts, command } = parseArgs(argv);
    return await run(opts, command);
  } catch (e) {
    say((e as Error).message);
    releaseLock();
    return 2;
  }
}
