/**
 * The `dump` role (ARCHITECTURE 15.3, 16.2): a cron job (hourly on Railway) of the ONE image, holding the
 * `dumps` credential and nothing else of value. Each run:
 *
 *  1. refuses to run unless `pg_dump`'s major equals the server's (the image installs the PGDG
 *     postgresql-client-18 beside Node for this);
 *  2. reads the change marker `meta.change_seq` and skips when it has not moved since the newest dump (an
 *     empty universe uploads nothing although its lease row is rewritten every 5 s). The schema is
 *     server-persistence's (wave 5); a database without a `meta` table has no marker, which is logged, and
 *     every due run dumps;
 *  3. keeps to the upload budget (1.5 GB a day by default): the interval is the shortest of 1, 2, 3, 4, 6, 8,
 *     12 and 24 hours at which a day of dumps of the newest dump's size fits the budget, and a run inside
 *     that interval, or one whose upload would pass today's budget, is skipped;
 *  4. dumps everything except the data of island_jrnl, island_ckpt and usage_hour with `pg_dump -Fc` and
 *     uploads it as dumps/<UTC time>-<marker>.dump;
 *  5. prunes: keeps the newest 24, the newest of each of the last 14 UTC days and the newest of each of the
 *     last 8 ISO weeks, and deletes every other key under dumps/ (buckets have no lifecycle rules).
 *
 * Exit code 0 for a dump or a skip, non-zero for a refusal or a failure (Railway shows the cron run failed).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { bucketFromEnv, s3For, type BucketConfig } from '../packs/bucket';
import type { RoleContext, RoleHandle, RoleModule } from './types';

export const DUMP_PREFIX = 'dumps/';
export const EXCLUDED_DATA = ['island_jrnl', 'island_ckpt', 'usage_hour'];
const INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24];

export interface DumpObject {
  key: string;
  at: number;
  marker: string;
  bytes: number;
}

/** dumps/20261112T090000Z-<marker>.dump */
export function dumpKey(atMs: number, marker: string): string {
  const iso = new Date(atMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${DUMP_PREFIX}${iso}-${marker}.dump`;
}

export function parseDumpKey(key: string, bytes: number): DumpObject | null {
  const m = /^dumps\/(\d{8}T\d{6}Z)-([A-Za-z0-9_]+)\.dump$/.exec(key);
  if (!m) return null;
  const s = m[1]!;
  const at = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)), Number(s.slice(9, 11)), Number(s.slice(11, 13)), Number(s.slice(13, 15)));
  return { key, at, marker: m[2]!, bytes };
}

/** ISO week id (year-week) of a time. */
function isoWeek(ms: number): string {
  const d = new Date(ms);
  const date = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monday0 = (new Date(date).getUTCDay() + 6) % 7;
  const thursday = date + (3 - monday0) * 86_400_000;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return `${year}-W${week}`;
}

/** Retention: the newest 24, the newest of each of the last 14 days, the newest of each of the last 8 weeks. */
export function retention(dumps: DumpObject[], nowMs: number, keep = { hourly: 24, daily: 14, weekly: 8 }): { keep: DumpObject[]; remove: DumpObject[] } {
  const sorted = [...dumps].sort((a, b) => b.at - a.at);
  const kept = new Set<string>();
  sorted.slice(0, keep.hourly).forEach((d) => kept.add(d.key));
  const today = Math.floor(nowMs / 86_400_000);
  const seenDays = new Set<number>();
  for (const d of sorted) {
    const day = Math.floor(d.at / 86_400_000);
    if (today - day >= keep.daily || seenDays.has(day)) continue;
    seenDays.add(day);
    kept.add(d.key);
  }
  const weeks: string[] = [];
  for (let i = 0; i < keep.weekly; i++) weeks.push(isoWeek(nowMs - i * 7 * 86_400_000));
  const seenWeeks = new Set<string>();
  for (const d of sorted) {
    const w = isoWeek(d.at);
    if (!weeks.includes(w) || seenWeeks.has(w)) continue;
    seenWeeks.add(w);
    kept.add(d.key);
  }
  return { keep: sorted.filter((d) => kept.has(d.key)), remove: sorted.filter((d) => !kept.has(d.key)) };
}

/** Hours between dumps so that a day of dumps of `bytes` fits `budget`. */
export function intervalHours(bytes: number, budget: number): number {
  for (const h of INTERVALS) if ((24 / h) * bytes <= budget) return h;
  return 24;
}

export type DumpDecision = { run: true; reason: string } | { run: false; reason: string };

/** Whether to dump now, from the marker and the dumps already in the bucket. */
export function decide(marker: string | null, dumps: DumpObject[], nowMs: number, budget: number): DumpDecision {
  const newest = [...dumps].sort((a, b) => b.at - a.at)[0];
  if (!newest) return { run: true, reason: 'no dump yet' };
  if (marker !== null && newest.marker === marker) return { run: false, reason: `change_seq ${marker} has not moved since ${newest.key}` };
  const h = intervalHours(newest.bytes, budget);
  if (nowMs - newest.at < h * 3600_000 - 5 * 60_000) return { run: false, reason: `interval ${h} h: the newest dump is ${((nowMs - newest.at) / 3600_000).toFixed(2)} h old` };
  const today = Math.floor(nowMs / 86_400_000);
  const usedToday = dumps.filter((d) => Math.floor(d.at / 86_400_000) === today).reduce((n, d) => n + d.bytes, 0);
  if (usedToday + newest.bytes > budget) return { run: false, reason: `upload budget: ${usedToday} bytes today, budget ${budget}` };
  return { run: true, reason: marker === null ? 'no change marker (no meta table): due by interval' : `change_seq moved (${newest.marker} -> ${marker})` };
}

export async function listDumps(client: S3Client, b: BucketConfig): Promise<DumpObject[]> {
  const out: DumpObject[] = [];
  let token: string | undefined;
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: b.bucket, Prefix: DUMP_PREFIX, ContinuationToken: token }));
    for (const o of r.Contents ?? []) {
      const d = o.Key ? parseDumpKey(o.Key, o.Size ?? 0) : null;
      if (d) out.push(d);
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Major version of a pg_dump binary. */
export function pgDumpMajor(bin: string): number {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.error) throw new Error(`${bin}: ${r.error.message}`);
  const m = /(\d+)(?:\.\d+)?/.exec(r.stdout ?? '');
  if (!m) throw new Error(`${bin} --version printed ${JSON.stringify(r.stdout)}`);
  return Number(m[1]);
}

export async function runDump(o: { databaseUrl: string; bucket: BucketConfig; pgDump: string; budget: number; now: () => number; log: RoleContext['log'] }): Promise<number> {
  const client = s3For(o.bucket);
  const db = new pg.Client({ connectionString: o.databaseUrl, connectionTimeoutMillis: 10_000 });
  await db.connect();
  let marker: string | null;
  try {
    const serverMajor = Math.floor(Number((await db.query<{ v: string }>(`select current_setting('server_version_num') as v`)).rows[0]!.v) / 10000);
    const dumpMajor = pgDumpMajor(o.pgDump);
    if (dumpMajor !== serverMajor) {
      o.log.error('dump-refused', { reason: `pg_dump is ${dumpMajor}, the server is ${serverMajor}` });
      return 3;
    }
    const meta = await db.query(`select to_regclass('meta') as t`);
    if ((meta.rows[0] as { t: string | null }).t === null) marker = null;
    else {
      const r = await db.query<{ value: string }>(`select value::text as value from meta where key = 'change_seq'`);
      marker = r.rows[0]?.value ?? '0';
    }
  } finally {
    await db.end();
  }
  const dumps = await listDumps(client, o.bucket);
  const d = decide(marker, dumps, o.now(), o.budget);
  if (marker === null) o.log.warn('dump-no-marker', { note: 'no meta table: the skip rule has no change marker' });
  if (d.run) {
    const file = path.join(os.tmpdir(), `fsp-dump-${process.pid}.dump`);
    const t0 = performance.now();
    const args = ['-Fc', '--no-owner', '--no-privileges', ...EXCLUDED_DATA.flatMap((t) => ['--exclude-table-data', t]), '-f', file, o.databaseUrl];
    const code = await new Promise<number>((resolve) => {
      const p = spawn(o.pgDump, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (c: Buffer) => (err += c.toString()));
      p.on('close', (c) => {
        if (c !== 0) o.log.error('pg-dump-failed', { code: c, stderr: err.slice(0, 2000) });
        resolve(c ?? 1);
      });
    });
    if (code !== 0) return 4;
    const bytes = fs.statSync(file).size;
    const at = o.now();
    const key = dumpKey(at, marker ?? 'none');
    await client.send(new PutObjectCommand({ Bucket: o.bucket.bucket, Key: key, Body: fs.createReadStream(file), ContentLength: bytes, ContentType: 'application/octet-stream' }));
    fs.rmSync(file, { force: true });
    dumps.push({ key, at, marker: marker ?? 'none', bytes });
    o.log.info('dump-written', { key, bytes, seconds: (performance.now() - t0) / 1000, reason: d.reason });
  } else o.log.info('dump-skipped', { reason: d.reason });
  const { keep, remove } = retention(dumps, o.now());
  for (const r of remove) await client.send(new DeleteObjectCommand({ Bucket: o.bucket.bucket, Key: r.key }));
  o.log.info('dump-pruned', { kept: keep.length, removed: remove.map((r) => r.key) });
  return 0;
}

const dumpRole: RoleModule = {
  kind: 'job',
  async start(ctx: RoleContext): Promise<RoleHandle & { done: Promise<number> }> {
    const url = ctx.env.DATABASE_URL;
    const bucket = bucketFromEnv('DUMPS', ctx.env);
    if (!url) throw new Error('dump: DATABASE_URL is needed');
    if (!bucket) throw new Error('dump: the DUMPS_* bucket variables are needed');
    if (bucketFromEnv('PACKS', ctx.env)) throw new Error('dump: this process holds the packs credential; the dump role must hold only the dumps credential');
    const budget = Number(ctx.env.DUMP_BUDGET_BYTES_PER_DAY ?? 1.5e9);
    const done = runDump({ databaseUrl: url, bucket, pgDump: ctx.env.PG_DUMP ?? 'pg_dump', budget, now: () => Date.now(), log: ctx.log });
    return { done, health: () => ({ ok: true }), drain: async () => undefined };
  },
};

export default dumpRole;
