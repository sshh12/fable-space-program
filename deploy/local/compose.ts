/**
 * The Docker forms of the local stack (ARCHITECTURE 16.4): `--compose` (deploy/local/compose.yml: the roles in
 * the pinned image, the Postgres 18 image Railway's template is built on, MinIO as the S3 store for the dump
 * and the upload and presign scripts) and `--db=docker` (only Postgres in a container, the rest as host
 * processes is NOT offered separately: it is the compose file's `postgres` service with the host stack's
 * roles pointed at it, which the compose form already covers).
 *
 * Machine rule (2026-11-12, the lead): the Docker VM must be capped before any of this runs. The launcher
 * refuses unless %UserProfile%\.wslconfig caps the WSL 2 VM at 6 GB or less (ARCHITECTURE 16.4). It starts
 * the Docker daemon if it is stopped and stops what it started. Tiles reach the containers over HTTP from
 * the host's bucket stand-in (host.docker.internal), never as the plain-file tree through a bind mount.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEASURED_SLICE_BYTES } from '../packs/packList';
import { startBucketStandIn } from './bucketStandIn';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_FILE = path.join(REPO, 'deploy', 'local', 'compose.yml');

/** The WSL 2 memory cap in GB from .wslconfig, or null when there is none. */
export function wslMemoryCapGb(file = path.join(os.homedir(), '.wslconfig')): number | null {
  if (!fs.existsSync(file)) return null;
  let section = '';
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const s = /^\[(.+)\]$/.exec(line);
    if (s) {
      section = s[1]!.toLowerCase();
      continue;
    }
    const m = /^memory\s*=\s*(\d+(?:\.\d+)?)\s*(GB|MB)$/i.exec(line);
    if (section === 'wsl2' && m) return m[2]!.toUpperCase() === 'GB' ? Number(m[1]) : Number(m[1]) / 1024;
  }
  return null;
}

export function assertDockerAllowed(): void {
  const cap = wslMemoryCapGb();
  if (cap === null || cap > 6) {
    throw new Error(
      `the Docker forms need the WSL 2 VM capped at 6 GB in %UserProfile%\\.wslconfig (found ${cap === null ? 'no cap' : `${cap} GB`}); ` +
        'the machine has bug-checked under load and an uncapped VM is not run beside it (docs/OPEN_QUESTIONS_V2.md, "Small things")',
    );
  }
}

const docker = (args: string[], timeoutMs = 60_000): { status: number; out: string } => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

/** Make sure the daemon runs; returns true when this call started it (so the caller stops it again). */
export async function ensureDaemon(say: (l: string) => void): Promise<boolean> {
  if (docker(['info'], 15_000).status === 0) return false;
  say('starting Docker Desktop');
  const r = docker(['desktop', 'start', '--timeout', '180'], 200_000);
  if (r.status !== 0) throw new Error(`docker desktop start failed: ${r.out.trim()}`);
  if (docker(['info'], 30_000).status !== 0) throw new Error('the Docker daemon did not come up');
  return true;
}

export function stopDaemon(say: (l: string) => void): void {
  say('stopping Docker Desktop (this launcher started it)');
  docker(['desktop', 'stop'], 120_000);
}

export interface ComposeRun {
  name: string;
  opts: { shape: string; page: string; compose: boolean; db: string; fresh: boolean };
  command: string[];
  takeLock: () => void;
  releaseLock: () => void;
  say: (line: string) => void;
}

const quoteArg = (a: string): string => (/^[A-Za-z0-9_\-./:=@,+\\*]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

/**
 * Bring the compose stack up (project fsp-<name>), run the command with STACK_URL (the shell in the image),
 * STACK_ENDPOINTS and COMPOSE_PROJECT set, and take everything down again.
 */
export async function runCompose(o: ComposeRun): Promise<number> {
  assertDockerAllowed();
  if (!o.opts.compose) throw new Error('--db=docker is the compose form\'s postgres service: run with --compose');
  if (o.opts.shape !== 'combined') throw new Error('the compose form runs the combined shape (the suites of 28.6 that need signals and the pinned build)');
  o.takeLock();
  const project = `fsp-${o.name}`.toLowerCase();
  const dataDir = path.join(REPO, 'data', 'stack', o.name);
  fs.mkdirSync(dataDir, { recursive: true });
  let started = false;
  const standIn = await startBucketStandIn({ packsDir: path.join(REPO, 'data', 'packs'), bucket: 'packs', accessKeyId: 'stack-local', secretAccessKey: 'stack-local-secret', sliceBytes: MEASURED_SLICE_BYTES, host: '0.0.0.0', port: 47201 });
  const env = { ...process.env, COMPOSE_PROJECT_NAME: project };
  try {
    started = await ensureDaemon(o.say);
    if (o.opts.fresh) docker(['compose', '-f', COMPOSE_FILE, '-p', project, 'down', '-v'], 120_000);
    const up = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, '-p', project, 'up', '-d', '--build', '--wait'], { stdio: 'inherit', env, timeout: 900_000 });
    if (up.status !== 0) throw new Error('docker compose up failed');
    const endpointsFile = path.join(dataDir, 'endpoints.json');
    const ep = (await (await fetch('http://127.0.0.1:47202/endpoints.json')).text()).trim();
    fs.writeFileSync(endpointsFile, `${ep}\n`);
    o.say(`compose stack ${project} up; page http://127.0.0.1:47202`);
    if (o.command.length === 0) {
      o.say('no command: running until interrupted');
      await new Promise<never>(() => undefined);
    }
    return await new Promise<number>((resolve) => {
      const c = spawn(o.command.map(quoteArg).join(' '), { stdio: 'inherit', shell: true, cwd: REPO, env: { ...env, STACK_URL: 'http://127.0.0.1:47202', STACK_ENDPOINTS: endpointsFile, COMPOSE_PROJECT: project, COMPOSE_FILE } });
      c.on('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    docker(['compose', '-f', COMPOSE_FILE, '-p', project, 'down'], 180_000);
    await standIn.close();
    if (started) stopDaemon(o.say);
    o.releaseLock();
  }
}
