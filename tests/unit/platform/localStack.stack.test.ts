/**
 * The local stack from the inside (ARCHITECTURE 16.4): run INSIDE a stack, which sets STACK_STATE:
 *
 *   STACK_NAME=fsp-platform-delivery npm run stack -- --page=build -- npx vitest run tests/unit/platform/localStack.stack.test.ts
 *
 * Outside a stack (the plain unit suite, CI) the suite is skipped with that note: it needs the stack's
 * Postgres and roles. The launcher-level checks (the slot, kills, names, shapes, the refused data directory)
 * are tests/unit/platform/stack-selftest.ts, which starts stacks itself.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StackState } from '../../../deploy/local/launcher';

const STATE = process.env.STACK_STATE;
const state = (): StackState => JSON.parse(fs.readFileSync(STATE!, 'utf8')) as StackState;

describe.skipIf(!STATE)('inside the local stack (needs STACK_STATE: run it with npm run stack -- -- <this file>)', () => {
  let s: StackState;
  const clients: pg.Client[] = [];
  const connect = async (): Promise<pg.Client> => {
    const c = new pg.Client({ connectionString: s.postgres.url });
    c.on('error', () => undefined); // the hard-kill test ends every open session on purpose
    await c.connect();
    clients.push(c);
    return c;
  };

  beforeAll(() => {
    s = state();
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
  });

  it('Postgres 18 is ready in under 1 s, a UTF8 cluster with the built-in C.UTF-8 locale and production settings', async () => {
    expect(s.postgres.readyMs).toBeLessThan(1000);
    expect(Math.floor(s.postgres.facts!.serverVersionNum / 10000)).toBe(18);
    expect(s.postgres.facts!.serverEncoding).toBe('UTF8');
    expect(s.postgres.facts!.localeProvider).toBe('builtin');
    expect(s.postgres.facts!.locale).toBe('C.UTF-8');
    const c = await connect();
    const r = await c.query<{ sb: string; mc: string; maxw: string; minw: string }>(
      `select current_setting('shared_buffers') sb, current_setting('max_connections') mc, current_setting('max_wal_size') maxw, current_setting('min_wal_size') minw`,
    );
    expect(r.rows[0]).toEqual({ sb: '96MB', mc: '40', maxw: '256MB', minw: '64MB' });
  });

  it('a text outside Windows-1252 round-trips', async () => {
    const c = await connect();
    const text = 'Ωμέγα 火星 ракета Łódź 🚀 ✓';
    await c.query('create temporary table t_text (s text)');
    await c.query('insert into t_text values ($1)', [text]);
    expect((await c.query<{ s: string }>('select s from t_text')).rows[0]!.s).toBe(text);
  });

  it('citext uniqueness is case-insensitive', async () => {
    const c = await connect();
    await c.query('create extension if not exists citext');
    await c.query('create temporary table t_callsign (callsign citext unique)');
    await c.query(`insert into t_callsign values ('Kestrel-7')`);
    await expect(c.query(`insert into t_callsign values ('KESTREL-7')`)).rejects.toThrow(/duplicate key/);
    await c.query(`insert into t_callsign values ('Łódź')`);
    await expect(c.query(`insert into t_callsign values ('ŁÓDŹ')`)).rejects.toThrow(/duplicate key/);
  });

  it('two sessions contend for one advisory lock and exactly one gets it', async () => {
    const a = await connect();
    const b = await connect();
    const got = await Promise.all([a, b].map(async (c) => (await c.query<{ ok: boolean }>('select pg_try_advisory_lock(4242) as ok')).rows[0]!.ok));
    expect(got.filter(Boolean)).toHaveLength(1);
    await a.query('select pg_advisory_unlock_all()');
    await b.query('select pg_advisory_unlock_all()');
  });

  it('a fenced write with a stale token changes 0 rows', async () => {
    const c = await connect();
    await c.query('create table if not exists t_lease (name text primary key, holder text, token bigint)');
    await c.query(`insert into t_lease values ('lobby', 'a', 1) on conflict (name) do update set holder = 'a', token = 1`);
    // b takes the lease: the token moves.
    await c.query(`update t_lease set holder = 'b', token = token + 1 where name = 'lobby'`);
    const stale = await c.query(`update t_lease set holder = 'a' where name = 'lobby' and token = 1`);
    expect(stale.rowCount).toBe(0);
    const fresh = await c.query(`update t_lease set holder = 'b' where name = 'lobby' and token = 2`);
    expect(fresh.rowCount).toBe(1);
  });

  it('a committed row survives a hard kill of Postgres', async () => {
    const c = await connect();
    const mark = createHash('sha256').update(String(process.hrtime.bigint())).digest('hex').slice(0, 12);
    await c.query('create table if not exists t_durable (mark text primary key, at timestamptz default now())');
    await c.query('insert into t_durable (mark) values ($1)', [mark]);
    await c.end();
    clients.splice(clients.indexOf(c), 1);
    const pid = Number(fs.readFileSync(`${s.postgres.dir}/postmaster.pid`, 'utf8').split(/\r?\n/)[0]);
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    const { pg_ctl } = await import('@embedded-postgres/windows-x64');
    const log = `${s.dataDir}/logs/postgres.log`;
    const fd = fs.openSync(`${s.dataDir}/logs/pg_ctl-restart.log`, 'a');
    const t0 = performance.now();
    const r = spawnSync(pg_ctl, ['start', '-D', s.postgres.dir, '-w', '-t', '60', '-l', log, '-o', `-p ${s.postgres.port} -c listen_addresses=127.0.0.1`], { stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    expect(r.status).toBe(0);
    const recoveredMs = performance.now() - t0;
    const d = await connect();
    expect((await d.query('select mark from t_durable where mark = $1', [mark])).rowCount).toBe(1);
    console.log(`postgres hard-killed and restarted with crash recovery in ${recoveredMs.toFixed(0)} ms; the committed row is there`);
  });

  it('the endpoint document is the only address book: shell serves it no-cache with the candidates in order', async () => {
    const doc = JSON.parse(fs.readFileSync(s.endpointsFile, 'utf8')) as { gate: string[]; api: string[]; pub: string[]; bootPack: { url: string; hash: string; bytes: number } };
    expect(doc.gate.length).toBeGreaterThan(0);
    const r = await fetch(`${s.urls.shell}/endpoints.json`);
    expect(r.headers.get('cache-control')).toBe('no-cache');
    const served = (await r.json()) as typeof doc;
    expect(served.gate).toEqual(doc.gate);
    expect(served.api).toEqual(doc.api);
    expect(served.pub).toEqual(doc.pub);
    expect(served.bootPack.hash).toBe(doc.bootPack.hash);
    for (const u of [...doc.gate, ...doc.api, ...doc.pub]) expect((await fetch(`${u}/healthz`)).ok).toBe(true);
  });

  it('shell serves the boot pack it loaded from the bucket stand-in, verified, immutable, with the isolation headers', async () => {
    const { hash, bytes } = s.bootPack!;
    const r = await fetch(`${s.urls.shell}/boot/${hash}.pack`);
    expect(r.status).toBe(200);
    const b = new Uint8Array(await r.arrayBuffer());
    expect(b.length).toBe(bytes);
    expect(createHash('sha256').update(b).digest('hex').slice(0, 32)).toBe(hash);
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(r.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    const q = await fetch(`${s.urls.shell}/boot/${hash}.pack?v=2`);
    expect(q.status).toBe(404);
    expect((await q.arrayBuffer()).byteLength).toBe(0);
    const h = await fetch(`${s.urls.shell}/healthz`);
    expect(h.status).toBe(200);
  });

  it('the pack list of the stack names the bucket stand-in first and the mirror second', async () => {
    const r = await fetch(s.urls.packList);
    expect(r.ok).toBe(true);
    const list = (await r.json()) as { mirrors: { id: string; mode: string }[]; sets: Record<string, unknown> };
    expect(list.mirrors.map((m) => m.id)).toEqual(['bucket', 'mirror']);
    expect(list.mirrors[1]!.mode).toBe(s.options.mirror);
  });
});
