/**
 * The request list of fsp-probe (deploy/modal/fsp_probe.py): real tile range requests against the packs bucket.
 *
 *   npx tsx deploy/modal/make-requests.ts [--per-set=20000] [--trace=docs/capacity/traces/<file>.json]
 *
 * For every tile set of deploy/pack-sets.json (what is in the bucket), `per-set` tile groups are drawn from its
 * index (every level and face, in proportion to their counts) and each becomes the byte range of that group
 * in its pack; the tile reads of a recorded session are added as the byte ranges of their tiles. The pack
 * list's presigned URL of every pack is included (signed for today's UTC day). Written to
 * out/platform/probe-requests.json (git-ignored: the URLs are bearer URLs for 7 days).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeIndexHeader, decodeRecord, groupBytes, indexHeaderLength, layerRange, recordBytes } from '../../src/terrain/packIndex';
import { packKey, presignGet, s3For, bucketFromEnv } from '../packs/bucket';
import { readPackSetsFile } from '../packs/packList';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const opt = (n: string): string | undefined => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

function loadEnv(): void {
  const pub = JSON.parse(fs.readFileSync(path.join(REPO, 'deploy', 'railway', 'buckets.json'), 'utf8')) as Record<string, { bucket: string; endpoint: string; region: string; pathStyle: boolean }>;
  const p = pub.packs!;
  process.env.PACKS_BUCKET ??= p.bucket;
  process.env.PACKS_ENDPOINT ??= p.endpoint;
  process.env.PACKS_REGION ??= p.region;
  process.env.PACKS_PATH_STYLE ??= p.pathStyle ? '1' : '0';
  for (const line of fs.readFileSync(path.join(REPO, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^(PACKS_[A-Z_]+)=(.*)$/.exec(line);
    if (m) process.env[m[1]!] ??= m[2]!;
  }
}

/** Mulberry32: a seeded generator, so the request list is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main(): Promise<void> {
  loadEnv();
  const b = bucketFromEnv('PACKS')!;
  const client = s3For(b);
  const sets = readPackSetsFile(path.join(REPO, 'deploy', 'pack-sets.json'));
  const perSet = Number(opt('per-set') ?? 20000);
  const rand = rng(20261112);
  const ranges: [string, number, number][] = [];
  const urls: Record<string, string> = {};
  const now = Date.now();
  for (const [set, s] of Object.entries(sets.sets)) {
    if (s.type !== 'tiles') continue;
    const idx = fs.readFileSync(path.join(REPO, 'data', 'packs', set, `${s.index}.idx`));
    const len = indexHeaderLength(idx.subarray(0, 8));
    const header = decodeIndexHeader(idx.subarray(8, 8 + len));
    const total = header.sections.reduce((n, x) => n + x.count, 0);
    for (const sec of header.sections) {
      const kind = header.kinds[sec.k]!;
      const rb = recordBytes(kind.layers.length);
      const view = new DataView(idx.buffer, idx.byteOffset + sec.offset, sec.bytes);
      const take = Math.max(1, Math.round((perSet * sec.count) / total));
      for (let i = 0; i < take; i++) {
        const rec = decodeRecord(view, Math.floor(rand() * sec.count) * rb, kind.layers.length);
        ranges.push([header.packs[rec.pack]!.hash, rec.offset, groupBytes(rec)]);
      }
    }
    for (const p of s.packs) urls[p.hash] = await presignGet(client, b, packKey(p.hash), now);
    // The session's own tile reads, when a trace is given: each as the range of that one tile.
    const traceFile = opt('trace');
    if (traceFile) {
      const doc = JSON.parse(fs.readFileSync(path.resolve(REPO, traceFile), 'utf8')) as { entries: { path: string; status: number }[] };
      const lk = new Map<string, [number, number]>();
      header.kinds.forEach((k, ki) => k.layers.forEach((l, li) => lk.set(l, [ki, li])));
      const { groupSet, groupOrdinal } = await import('../../src/terrain/packIndex');
      const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'tiles', set, 'manifest.json'), 'utf8'));
      for (const e of doc.entries) {
        const m = new RegExp(`^/tiles/${set}/([^/]+)/(\\d)/(\\d+)/(\\d+)/(\\d+)\\.`).exec(e.path);
        if (!m || e.status !== 200) continue;
        const [ki, li] = lk.get(m[1]!) ?? [-1, -1];
        if (ki < 0) continue;
        const key = { face: Number(m[2]) as 0, level: Number(m[3]), x: Number(m[4]), y: Number(m[5]) };
        const ord = groupOrdinal(groupSet(manifest, header.kinds[ki]!, key.level, key.face), key);
        const sec = header.sections.find((x) => x.k === ki && x.l === key.level && x.f === key.face && ord >= x.first && ord < x.first + x.count);
        if (!sec || ord < 0) continue;
        const rec = decodeRecord(new DataView(idx.buffer, idx.byteOffset + sec.offset, sec.bytes), (ord - sec.first) * recordBytes(header.kinds[ki]!.layers.length), header.kinds[ki]!.layers.length);
        const r = layerRange(rec, li);
        if (r) ranges.push([header.packs[rec.pack]!.hash, r.offset, r.length]);
      }
    }
  }
  const out = path.join(REPO, 'out', 'platform', 'probe-requests.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ signedFor: new Date(now).toISOString().slice(0, 10), urls, ranges }));
  const bytes = ranges.reduce((n, r) => n + r[2], 0);
  console.log(JSON.stringify({ file: path.relative(REPO, out), sets: Object.keys(sets.sets), packs: Object.keys(urls).length, ranges: ranges.length, meanRangeBytes: Math.round(bytes / ranges.length) }));
}

main().catch((e: unknown) => {
  console.error(`make-requests: ${(e as Error).message}`);
  process.exitCode = 1;
});
