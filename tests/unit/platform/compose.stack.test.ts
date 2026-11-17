/**
 * The compose form of the local stack (ARCHITECTURE 16.4; the brief's compose acceptance), run INSIDE it:
 *
 *   STACK_NAME=fsp-platform-delivery npm run stack -- --compose --fresh -- npx vitest run --no-file-parallelism tests/unit/platform/localStack.stack.test.ts tests/unit/platform/compose.stack.test.ts
 *   (one file after the other: the in-stack suite kills the container's Postgres on purpose)
 *
 * (deploy/local/compose.ts sets COMPOSE_PROJECT, COMPOSE_FILE, STACK_URL and STACK_ENDPOINTS; skipped elsewhere).
 * The generic checks (the container's encoding and locale, citext, advisory lock, fenced write, hard kill, the
 * endpoint document, the boot pack, the pack list) are localStack.stack.test.ts in its compose form; this file
 * has what only the compose form has:
 *   - the Docker VM is capped at 6 GB (.wslconfig, and the memory the daemon reports);
 *   - the image smoke: the roles in the pinned image print the buildId of the host's build of the same commit
 *     (the same server bundle, byte for byte, on the pinned Node base);
 *   - the same pack requests: tiles read through the image's bucket (packs-store, by the presigned URLs of
 *     game's pack list) and through the image's mirror are the plain files' bytes;
 *   - the dump role in the pinned image dumps the container's Postgres to MinIO, and pg_restore restores that
 *     dump into a fresh database of the container AND into an embedded cluster on the host.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { computeBuildId } from '../../../deploy/buildInfo';
import { wslMemoryCapGb } from '../../../deploy/local/compose';
import { pgBinaries } from '../../../deploy/local/launcher';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import type { PackList } from '../../../src/terrain/packIndex';
import { createPackTileSource } from '../../../src/terrain/packSource';

const PROJECT = process.env.COMPOSE_PROJECT;
const FILE = process.env.COMPOSE_FILE ?? path.resolve('deploy', 'local', 'compose.yml');
const PG_URL = (db = 'fsp'): string => `postgres://postgres:stack-local@127.0.0.1:47220/${db}`;
const compose = (args: string[], input?: Buffer, timeout = 600_000) =>
  spawnSync('docker', ['compose', '-f', FILE, '-p', PROJECT!, ...args], { input, encoding: input ? undefined : 'utf8', timeout, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
const text = (b: string | Buffer | null | undefined): string => (b === null || b === undefined ? '' : b.toString());

/** A fresh connection, retried for 30 s while the server starts up or restarts (57P03, a refused or reset connection). */
async function withDb<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
    } catch (e) {
      await c.end().catch(() => undefined);
      const why = `${(e as { code?: string }).code ?? ''} ${(e as Error).message}`;
      if (Date.now() - t0 > 30_000 || !/57P03|ECONNREFUSED|ECONNRESET/.test(why)) throw e;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
}

describe.skipIf(!PROJECT)('the compose form (needs COMPOSE_PROJECT: npm run stack -- --compose -- <this file>)', () => {
  it('the Docker VM is capped at 6 GB', () => {
    const cap = wslMemoryCapGb();
    expect(cap).not.toBeNull();
    expect(cap!).toBeLessThanOrEqual(6);
    const r = spawnSync('docker', ['info', '--format', '{{.MemTotal}} {{.NCPU}}'], { encoding: 'utf8' });
    const [mem, cpus] = r.stdout.trim().split(' ').map(Number);
    console.log(`.wslconfig memory=${cap} GB; the daemon sees ${(mem! / 1024 ** 3).toFixed(2)} GiB and ${cpus} CPUs`);
    expect(mem!).toBeLessThanOrEqual(6 * 1024 ** 3);
  });

  it('image smoke: game and shell in the pinned image print the buildId of the host build of the same commit', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-hostbundle-'));
    try {
      const b = spawnSync('node', ['deploy/build/build-server.mjs', `--out=${out}`], { encoding: 'utf8' });
      expect(b.status, b.stderr).toBe(0);
      const host = JSON.parse(b.stdout.trim().split(/\r?\n/).pop()!) as { bundleHash: string };
      const info = JSON.parse(text(compose(['exec', '-T', 'game', 'cat', '/app/server/build-info.json']).stdout)) as { buildId: string; nodeImageDigest: string; bundleHash: string };
      const health = (await (await fetch('http://127.0.0.1:47203/healthz')).json()) as { ok: boolean; buildId: string };
      const version = (await (await fetch('http://127.0.0.1:47202/version.json')).json()) as { buildId: string };
      console.log(`host bundle ${host.bundleHash}; image bundle ${info.bundleHash} on ${info.nodeImageDigest.slice(0, 19)}...; buildId image ${info.buildId}, from the host bundle ${computeBuildId(info.nodeImageDigest, host.bundleHash)}; game /healthz ${health.buildId}, shell ${version.buildId}`);
      expect(info.bundleHash).toBe(host.bundleHash);
      expect(info.buildId).toBe(computeBuildId(info.nodeImageDigest, host.bundleHash));
      expect(health.ok).toBe(true);
      expect(health.buildId).toBe(info.buildId);
      expect(version.buildId).toBe(info.buildId);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it('the same pack requests: tiles through the image mirror (and the bucket stand-in via the image pack list) are the plain files', async () => {
    const list = (await (await fetch('http://127.0.0.1:47203/packs.json')).json()) as PackList;
    const fsSrc = createFsTileSource('data/tiles');
    const m = await fsSrc.manifest('moon');
    const tiles: { layer: string; key: { face: 0 | 1 | 2 | 3 | 4 | 5; level: number; x: number; y: number } }[] = [];
    for (const layer of Object.keys(m.layers)) for (let face = 0; face < 6; face++) for (let level = 0; level <= 2; level++) tiles.push({ layer, key: { face: face as 0, level, x: 0, y: 0 } });
    // The bucket: the image's packs-store, through the presigned URLs game signs for the host (127.0.0.1:47201);
    // the mirror: the image's shell proxying packs-store.
    const modes = ['bucket', 'mirror'];
    for (const only of modes) {
      const doc = { ...list, mirrors: list.mirrors.filter((x) => x.id === only) };
      const f = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === 'http://compose.local/packs.json') return new Response(JSON.stringify(doc));
        return fetch(input, init);
      }) as typeof fetch;
      const src = createPackTileSource({ packListUrl: 'http://compose.local/packs.json', fetch: f });
      let same = 0;
      for (const t of tiles) {
        const [a, b] = await Promise.all([src.tile('moon', t.layer, t.key), fsSrc.tile('moon', t.layer, t.key)]);
        if (a && b && Buffer.from(a).equals(Buffer.from(b))) same++;
      }
      console.log(`${only}: ${same} of ${tiles.length} moon tiles byte-identical; requests ${JSON.stringify(src.stats().requests)}`);
      expect(same).toBe(tiles.length);
      expect(src.stats().failures).toEqual({});
    }
    console.log(`modes checked: ${modes.join(', ')}`);
  });

  it('the dump role in the pinned image dumps the container Postgres; pg_restore restores it into the container and into an embedded cluster on the host', async () => {
    const mark = `compose-${Date.now()}`;
    await withDb(PG_URL(), async (c) => {
      await c.query('create table if not exists t_dumpcheck (mark text primary key, s text)');
      await c.query('insert into t_dumpcheck values ($1, $2)', [mark, 'Ωμέγα 火星 Łódź']);
    });
    const s3 = new S3Client({ endpoint: 'http://127.0.0.1:47221', region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'stack-local', secretAccessKey: 'stack-local-secret' } });
    await s3.send(new CreateBucketCommand({ Bucket: 'dumps' })).catch((e: { name?: string }) => {
      if (!/BucketAlready/.test(e.name ?? '')) throw e;
    });
    const d = compose(['--profile', 'jobs', 'run', '--rm', 'dump']);
    console.log(`dump role: exit ${d.status}; ${text(d.stdout).trim().split(/\r?\n/).filter((l) => /dump-/.test(l)).slice(-3).join(' | ')}`);
    expect(d.status, text(d.stderr).slice(-2000)).toBe(0);
    const keys = ((await s3.send(new ListObjectsV2Command({ Bucket: 'dumps', Prefix: 'dumps/' }))).Contents ?? []).map((o) => o.Key!).sort();
    expect(keys.length).toBeGreaterThan(0);
    const key = keys.at(-1)!;
    const dump = Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: 'dumps', Key: key }))).Body!.transformToByteArray());
    console.log(`dump ${key}: ${dump.length} bytes (sha256 ${createHash('sha256').update(dump).digest('hex').slice(0, 16)})`);

    // 1. Into a fresh database of the container.
    const r1 = compose(['exec', '-T', 'postgres', 'sh', '-c', 'dropdb --if-exists -U postgres restore_check && createdb -U postgres restore_check && pg_restore -U postgres --no-owner -d restore_check'], dump);
    expect(r1.status, text(r1.stderr).slice(-2000)).toBe(0);
    const inContainer = await withDb(PG_URL('restore_check'), async (c) => (await c.query<{ s: string }>('select s from t_dumpcheck where mark = $1', [mark])).rows[0]?.s);
    expect(inContainer).toBe('Ωμέγα 火星 Łódź');

    // 2. Into an embedded cluster on the host (production's cluster settings), from the image's pg_restore.
    //    No container reaches a process on this host (measured on the first compose run), so the connection
    //    runs the other way: a one-off container of the image publishes a port, the host connects to it and
    //    bridges that connection to the embedded cluster, and pg_restore inside the container talks to a local
    //    port that the container bridges to the host's connection (a reverse tunnel of one connection).
    const { initdb, pg_ctl } = await pgBinaries();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-restore-pg-'));
    const pw = path.join(dir, '..', `${path.basename(dir)}.pw`);
    fs.writeFileSync(pw, 'stack-local\n');
    let started = false;
    let bridge: net.Socket | null = null;
    try {
      const i = spawnSync(initdb, ['-D', dir, '-U', 'postgres', '-A', 'scram-sha-256', `--pwfile=${pw}`, '--encoding=UTF8', '--locale-provider=builtin', '--builtin-locale=C.UTF-8'], { encoding: 'utf8' });
      expect(i.status, i.stderr).toBe(0);
      const logFd = fs.openSync(path.join(os.tmpdir(), `${path.basename(dir)}.log`), 'a');
      const st = spawnSync(pg_ctl, ['start', '-D', dir, '-w', '-t', '60', '-o', '-p 47219 -c listen_addresses=127.0.0.1'], { stdio: ['ignore', logFd, logFd] });
      fs.closeSync(logFd);
      expect(st.status).toBe(0);
      started = true;
      await withDb('postgres://postgres:stack-local@127.0.0.1:47219/postgres', (c) => c.query('create database restore_check'));
      const inner = [
        "const net=require('net'),{spawn}=require('child_process');",
        "net.createServer((host)=>{",
        "  net.createServer((c)=>{c.pipe(host).pipe(c);}).listen(6543,'127.0.0.1',()=>{",
        "    const p=spawn('pg_restore',['--no-owner','-d','postgresql://postgres:stack-local@127.0.0.1:6543/restore_check'],{stdio:['pipe','inherit','inherit']});",
        "    process.stdin.pipe(p.stdin);p.on('exit',(code)=>process.exit(code===null?1:code));",
        "  });",
        "}).listen(47217,'0.0.0.0',()=>console.error('tunnel-ready'));",
      ].join('');
      const child = spawn('docker', ['compose', '-f', FILE, '-p', PROJECT!, '--profile', 'jobs', 'run', '--rm', '-T', '-p', '127.0.0.1:47217:47217', '--entrypoint', 'node', 'dump', '-e', inner], { windowsHide: true });
      let errText = '';
      const ready = new Promise<void>((res) => child.stderr.on('data', (d: Buffer) => {
        errText += d.toString();
        if (errText.includes('tunnel-ready')) res();
      }));
      const exited = new Promise<number>((res) => child.on('exit', (code) => res(code ?? 1)));
      await Promise.race([ready, exited.then(() => undefined)]);
      // The host's end: connect to the published port (retried until it accepts), bridge it to the cluster.
      for (let i = 0; i < 40 && !bridge; i++) {
        bridge = await new Promise<net.Socket | null>((res) => {
          const sock = net.connect(47217, '127.0.0.1', () => res(sock));
          sock.on('error', () => res(null));
        });
        if (!bridge) await new Promise((r) => setTimeout(r, 250));
      }
      expect(bridge).not.toBeNull();
      const db = net.connect(47219, '127.0.0.1');
      bridge!.pipe(db).pipe(bridge!);
      child.stdin.end(dump);
      const code2 = await exited;
      expect(code2, errText.slice(-2000)).toBe(0);
      const onHost = await withDb('postgres://postgres:stack-local@127.0.0.1:47219/restore_check', async (c) => (await c.query<{ s: string }>('select s from t_dumpcheck where mark = $1', [mark])).rows[0]?.s);
      expect(onHost).toBe('Ωμέγα 火星 Łódź');
      console.log(`restored into the container (database restore_check) and into an embedded cluster on the host: the marked row and its text are there in both`);
    } finally {
      bridge?.destroy();
      if (started) {
        const fd = fs.openSync(path.join(os.tmpdir(), `${path.basename(dir)}.log`), 'a');
        spawnSync(pg_ctl, ['stop', '-D', dir, '-m', 'fast', '-w'], { stdio: ['ignore', fd, fd] });
        fs.closeSync(fd);
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(pw, { force: true });
    }
  }, 600_000);
});
