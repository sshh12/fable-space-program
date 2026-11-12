/**
 * The static roles in process (no stack needed): the egress meter, the shell's routes and budgets against the
 * bucket stand-in, the mirror in both modes, the dump role's decisions and retention, the role manifest.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBucketStandIn, type StandIn } from '../../../deploy/local/bucketStandIn';
import { decide, dumpKey, intervalHours, parseDumpKey, retention, type DumpObject } from '../../../deploy/roles/dump';
import { EgressMeter, shellBudgetsFromEnv } from '../../../deploy/roles/egress';
import { createLogger } from '../../../deploy/roles/log';
import { parseRoles } from '../../../deploy/roles/manifest';
import shellRole, { HASHED_ASSET } from '../../../deploy/roles/shell';
import type { RoleContext, RouteHandler } from '../../../deploy/roles/types';
import { encodeBootPack } from '../../../src/terrain/packIndex';

const DAY = 86_400_000;

describe('the egress meter', () => {
  it('stops a route at its budget and resets at 00:00 UTC', () => {
    let t = Date.UTC(2026, 10, 12, 23, 59, 0);
    const m = new EgressMeter({ budgets: { mirror: 1000 }, now: () => t });
    expect(m.open('mirror')).toBe(true);
    m.record('mirror', 999);
    expect(m.open('mirror')).toBe(true);
    m.record('mirror', 1);
    expect(m.open('mirror')).toBe(false);
    expect(m.secondsToReset()).toBe(60);
    t += 60_000;
    expect(m.open('mirror')).toBe(true);
    expect(m.snapshot().routes.mirror!.used).toBe(0);
  });

  it('limits origin bytes per client address in a sliding window', () => {
    let t = Date.UTC(2026, 10, 12, 10, 0, 0);
    const m = new EgressMeter({ budgets: {}, perAddress: { mirror: { bytes: 300, windowS: 600 } }, now: () => t });
    m.record('mirror', 200, 'a');
    m.record('mirror', 100, 'a');
    expect(m.addressOpen('mirror', 'a')).toBe(false);
    expect(m.addressOpen('mirror', 'b')).toBe(true);
    t += 9 * 60_000;
    expect(m.addressOpen('mirror', 'a')).toBe(false);
    t += 2 * 60_000;
    expect(m.addressOpen('mirror', 'a')).toBe(true);
  });

  it('the stage-0 budgets of shell are 3, 1 and 8 GB a day and 300 MB per address in 10 minutes, each a setting', () => {
    const o = shellBudgetsFromEnv({});
    expect(o.budgets).toEqual({ client: 3e9, boot: 1e9, mirror: 8e9 });
    expect(o.perAddress).toEqual({ mirror: { bytes: 300e6, windowS: 600 } });
    expect(shellBudgetsFromEnv({ EGRESS_MIRROR_BYTES_PER_DAY: '5' }).budgets.mirror).toBe(5);
    expect(() => shellBudgetsFromEnv({ EGRESS_BOOT_BYTES_PER_DAY: 'lots' })).toThrow(/non-negative/);
  });
});

describe('the role manifest', () => {
  it('names every role and maps numbered shards to sim', () => {
    expect(parseRoles('shell, game')).toEqual([
      { name: 'shell', role: 'shell' },
      { name: 'game', role: 'game' },
    ]);
    expect(parseRoles('sim-2')[0]!.role).toBe('sim');
    expect(() => parseRoles('nope')).toThrow(/unknown role/);
    expect(() => parseRoles('')).toThrow(/ROLES is empty/);
  });
});

describe('the dump role', () => {
  const at = (iso: string): number => Date.parse(iso);
  const d = (iso: string, marker = '1', bytes = 1000): DumpObject => ({ key: dumpKey(at(iso), marker), at: at(iso), marker, bytes });

  it('names dumps by UTC time and change marker', () => {
    const k = dumpKey(at('2026-11-12T09:00:00Z'), '42');
    expect(k).toBe('dumps/20261112T090000Z-42.dump');
    expect(parseDumpKey(k, 5)).toEqual({ key: k, at: at('2026-11-12T09:00:00Z'), marker: '42', bytes: 5 });
    expect(parseDumpKey('packs/x', 5)).toBeNull();
  });

  it('skips when change_seq has not moved, keeps the interval and the daily upload budget', () => {
    const now = at('2026-11-12T12:00:00Z');
    expect(decide('5', [], now, 1.5e9).run).toBe(true);
    expect(decide('5', [d('2026-11-12T11:00:00Z', '5')], now, 1.5e9)).toMatchObject({ run: false });
    expect(decide('6', [d('2026-11-12T11:00:00Z', '5')], now, 1.5e9)).toMatchObject({ run: true });
    // 100 MB dumps: 24 a day would be 2.4 GB, so every 2 hours.
    expect(intervalHours(100e6, 1.5e9)).toBe(2);
    expect(intervalHours(20e6, 1.5e9)).toBe(1);
    expect(intervalHours(200e6, 1.5e9)).toBe(4);
    expect(decide('6', [d('2026-11-12T11:00:00Z', '5', 100e6)], now, 1.5e9)).toMatchObject({ run: false });
    expect(decide('6', [d('2026-11-12T10:00:00Z', '5', 100e6)], now, 1.5e9)).toMatchObject({ run: true });
    expect(decide(null, [d('2026-11-12T10:00:00Z', 'none')], now, 1.5e9)).toMatchObject({ run: true });
  });

  it('keeps 24 hourly, 14 daily and 8 weekly dumps and removes the rest', () => {
    const now = at('2026-11-12T12:30:00Z');
    const all: DumpObject[] = [];
    for (let h = 0; h < 24 * 90; h++) all.push(d(new Date(now - h * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z'), String(h)));
    const { keep, remove } = retention(all, now);
    expect(keep.length + remove.length).toBe(all.length);
    // the newest 24 are all kept
    for (const k of all.slice(0, 24)) expect(keep.map((x) => x.key)).toContain(k.key);
    // one per day for 14 days, one per week for 8 weeks: at most 24 + 14 + 8 kept
    expect(keep.length).toBeLessThanOrEqual(24 + 14 + 8);
    // the newest 24 already hold the newest dumps of today and yesterday, and the daily ones those of this week
    expect(keep.length).toBeGreaterThanOrEqual(24 + 12 + 5);
    const oldest = Math.min(...keep.map((k) => k.at));
    expect((now - oldest) / DAY).toBeGreaterThan(7 * 6); // the newest of the 8th ISO week back, counting this one
    expect((now - oldest) / DAY).toBeLessThan(7 * 8 + 1);
  });
});

describe('the shell role against the bucket stand-in', () => {
  let tmp: string;
  let standIn: StandIn;
  let server: http.Server;
  let base: string;
  let t = Date.UTC(2026, 10, 12, 20, 0, 0);
  let egress: EgressMeter;
  let boot: Uint8Array;
  let bootHash: string;
  let packHash: string;
  let pack: Buffer;
  let health: () => { ok: boolean };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-shell-'));
    const packs = path.join(tmp, 'packs');
    fs.mkdirSync(path.join(packs, 'boot'), { recursive: true });
    fs.mkdirSync(path.join(packs, 'set'), { recursive: true });
    boot = encodeBootPack([{ entry: { set: 'earth', path: 'manifest.json', o: 0, n: 0 }, bytes: new TextEncoder().encode('{"x":1}') }]);
    bootHash = createHash('sha256').update(boot).digest('hex').slice(0, 32);
    fs.writeFileSync(path.join(packs, 'boot', `${bootHash}.pack`), boot);
    pack = Buffer.alloc(5 * 1024 * 1024 + 123);
    for (let i = 0; i < pack.length; i++) pack[i] = (i * 31) & 0xff;
    packHash = createHash('sha256').update(pack).digest('hex').slice(0, 32);
    fs.writeFileSync(path.join(packs, 'set', `${packHash}.pack`), pack);
    const client = path.join(tmp, 'client');
    fs.mkdirSync(path.join(client, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(client, 'index.html'), '<!doctype html><script type="module" src="/assets/main-AbCdEf12.js"></script>');
    fs.writeFileSync(path.join(client, 'assets', 'main-AbCdEf12.js'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(client, '.build-complete.json'), '{"hash":"clientbuild0001"}');
    fs.writeFileSync(path.join(tmp, 'boot-manifest.json'), JSON.stringify({ hash: bootHash, bytes: boot.length }));
    standIn = await startBucketStandIn({ packsDir: packs, bucket: 'packs', accessKeyId: 'k', secretAccessKey: 's', sliceBytes: 2 * 1024 * 1024 });
    egress = new EgressMeter({ budgets: { client: 3000, boot: boot.length * 2, mirror: 4 * 1024 * 1024 }, perAddress: { mirror: { bytes: 1e12, windowS: 600 } }, now: () => t });
    const handlers: RouteHandler[] = [];
    const ctx: RoleContext = {
      name: 'shell',
      env: {
        STATIC_DIR: client,
        BOOT_MANIFEST: path.join(tmp, 'boot-manifest.json'),
        PACKS_BUCKET: 'packs',
        PACKS_ENDPOINT: standIn.url,
        PACKS_REGION: 'us-east-1',
        PACKS_ACCESS_KEY_ID: 'k',
        PACKS_SECRET_ACCESS_KEY: 's',
        PACKS_PATH_STYLE: '1',
        ENDPOINT_GATE: 'https://gate-a.example,https://gate-b.example',
        ENDPOINT_API: 'https://api.example',
        ENDPOINT_PUB: 'https://pub.example',
      },
      log: createLogger({}, () => undefined),
      egress,
      build: { buildId: 'test', nodeImageDigest: null, bundleHash: null, commit: null },
      http: { add: (h) => handlers.push(h), port: 0 },
      services: { packList: null },
    };
    const h = await shellRole.start(ctx);
    health = () => h.health();
    server = http.createServer(async (req, res) => {
      for (const fn of handlers) if (await fn(req, res)) return;
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (let i = 0; i < 100 && !health().ok; i++) await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(async () => {
    server?.close();
    await standIn?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('passes its health check once the boot pack is loaded and verified', () => {
    expect(health().ok).toBe(true);
  });

  it('serves the endpoint document no-cache with the candidates in order', async () => {
    const r = await fetch(`${base}/endpoints.json`);
    expect(r.headers.get('cache-control')).toBe('no-cache');
    expect(await r.json()).toEqual({
      v: 1,
      build: 'clientbuild0001',
      gate: ['https://gate-a.example', 'https://gate-b.example'],
      api: ['https://api.example'],
      pub: ['https://pub.example'],
      bootPack: { url: `/boot/${bootHash}.pack`, hash: bootHash, bytes: boot.length },
    });
  });

  it('index.html is no-cache, hashed assets immutable, both cross-origin isolated', async () => {
    const i = await fetch(`${base}/`);
    expect(i.headers.get('cache-control')).toBe('no-cache');
    expect(i.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(HASHED_ASSET.test('/assets/main-AbCdEf12.js')).toBe(true);
    const a = await fetch(`${base}/assets/main-AbCdEf12.js`);
    expect(a.headers.get('cache-control')).toContain('immutable');
    expect(a.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('a query string on a hashed route gets 404 with no body', async () => {
    for (const p of [`/assets/main-AbCdEf12.js?v=1`, `/boot/${bootHash}.pack?x`, `/p/${packHash}?a=1`, `/p/${packHash}/0?b`]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(404);
      expect((await r.arrayBuffer()).byteLength, p).toBe(0);
    }
  });

  it('the mirror serves ranges and 2 MiB slices of the bucket object', async () => {
    const r = await fetch(`${base}/p/${packHash}`, { headers: { Range: 'bytes=100-199' } });
    expect(r.status).toBe(206);
    expect(Buffer.from(await r.arrayBuffer()).equals(pack.subarray(100, 200))).toBe(true);
    const s = await fetch(`${base}/p/${packHash}/2`);
    expect(s.status).toBe(200);
    expect(s.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await s.arrayBuffer()).equals(pack.subarray(4 * 1024 * 1024))).toBe(true);
    expect((await fetch(`${base}/p/${packHash}/3`)).status).toBe(404);
  });

  it('each route stops at its budget: client 503, boot pack a redirect to the bucket, mirror 429; all reset at 00:00 UTC', async () => {
    // client build: 3000 bytes a day, 1000 per request
    let last = 0;
    for (let i = 0; i < 4; i++) last = (await fetch(`${base}/assets/main-AbCdEf12.js`)).status;
    expect(last).toBe(503);
    const after = await fetch(`${base}/assets/main-AbCdEf12.js`);
    expect(Number(after.headers.get('retry-after'))).toBe(4 * 3600);
    expect((await fetch(`${base}/`)).status).toBe(200); // the page itself still answers
    // boot pack: two copies a day, then a redirect to a presigned bucket URL
    expect((await fetch(`${base}/boot/${bootHash}.pack`)).status).toBe(200);
    expect((await fetch(`${base}/boot/${bootHash}.pack`)).status).toBe(200);
    const redirect = await fetch(`${base}/boot/${bootHash}.pack`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    const loc = redirect.headers.get('location')!;
    expect(loc).toContain('X-Amz-Signature=');
    const viaBucket = await fetch(loc);
    expect(viaBucket.status).toBe(200);
    expect(createHash('sha256').update(new Uint8Array(await viaBucket.arrayBuffer())).digest('hex').slice(0, 32)).toBe(bootHash);
    // mirror: 4 MiB a day; two 2 MiB slices pass, the third is refused
    // (bodies are read: the meter counts bytes as they are sent, so an unread body is not spent yet)
    const get = async (p: string): Promise<number> => {
      const r = await fetch(`${base}${p}`);
      await r.arrayBuffer();
      return r.status;
    };
    expect(await get(`/p/${packHash}/0`)).toBe(200);
    expect(await get(`/p/${packHash}/1`)).toBe(200);
    const refused = await fetch(`${base}/p/${packHash}/2`);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    t = Date.UTC(2026, 10, 13, 0, 0, 1);
    expect((await fetch(`${base}/p/${packHash}/2`)).status).toBe(200);
    expect((await fetch(`${base}/assets/main-AbCdEf12.js`)).status).toBe(200);
    expect((await fetch(`${base}/boot/${bootHash}.pack`)).status).toBe(200);
    const snap = egress.snapshot();
    expect(snap.day).toBe('2026-11-13');
  });
});

describe('the shell refuses to be healthy without the right boot pack', () => {
  it('a manifest naming bytes the bucket does not hold keeps the health check failing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-shell-bad-'));
    const packs = path.join(tmp, 'packs');
    fs.mkdirSync(path.join(packs, 'boot'), { recursive: true });
    const real = encodeBootPack([]);
    const hash = createHash('sha256').update(real).digest('hex').slice(0, 32);
    fs.writeFileSync(path.join(packs, 'boot', `${hash}.pack`), real);
    const standIn = await startBucketStandIn({ packsDir: packs, bucket: 'packs', accessKeyId: 'k', secretAccessKey: 's', sliceBytes: 1024 });
    const env = { PACKS_BUCKET: 'packs', PACKS_ENDPOINT: standIn.url, PACKS_REGION: 'us-east-1', PACKS_ACCESS_KEY_ID: 'k', PACKS_SECRET_ACCESS_KEY: 's', PACKS_PATH_STYLE: '1' };
    const cases = [
      { name: 'missing pack', manifest: { hash: 'f'.repeat(32), bytes: 10 } },
      { name: 'wrong size', manifest: { hash, bytes: real.length + 1 } },
    ];
    try {
      for (const c of cases) {
        fs.writeFileSync(path.join(tmp, 'm.json'), JSON.stringify(c.manifest));
        const h = await shellRole.start({
          name: 'shell',
          env: { ...env, BOOT_MANIFEST: path.join(tmp, 'm.json') },
          log: createLogger({}, () => undefined),
          egress: new EgressMeter({ budgets: {} }),
          build: { buildId: 'test', nodeImageDigest: null, bundleHash: null, commit: null },
          http: { add: () => undefined, port: 0 },
          services: { packList: null },
        });
        await new Promise((r) => setTimeout(r, 400));
        expect(h.health().ok, c.name).toBe(false);
        await h.drain('test', Date.now());
      }
    } finally {
      await standIn.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
