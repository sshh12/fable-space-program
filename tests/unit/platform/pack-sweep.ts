/**
 * The pack sweep and the trace replay (platform-delivery acceptance; ARCHITECTURE 10.4). Run INSIDE the local
 * stack, which provides the bucket stand-in and the shell's mirror:
 *
 *   STACK_NAME=fsp-platform-delivery npm run stack -- -- npx tsx tests/unit/platform/pack-sweep.ts sweep [--sets=moon,earth]
 *   STACK_NAME=fsp-platform-delivery npm run stack -- -- npx tsx tests/unit/platform/pack-sweep.ts trace docs/capacity/traces/<file>.json
 *
 * sweep  every tile the manifest promises (every layer, every level), every plain file of every packed tile
 *        set, read through createPackTileSource in four modes and compared byte for byte with the fs source:
 *        whole packs on disk; the bucket (presigned ranges, the stand-in); the mirror in `ranges` mode; the
 *        mirror in `slices` mode (2 MiB). The mirrors are the stack's shell proxying the bucket stand-in.
 * trace  the recorded first session's tile requests, replayed in their order and timing windows (requests
 *        issued within 50 ms of each other are concurrent) through the pack source, against per-file fetching:
 *        requests and bytes on the bucket path, and bytes transferred in the mirror's slice mode
 *        (bytes sent per byte needed).
 * Results are printed and written to out/platform/<command>.json; the exit code is the number of mismatches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TileManifest } from '../../../src/core/contracts/terrain';
import { layerHasTile } from '../../../src/core/contracts/terrain';
import type { FaceId, TileKey } from '../../../src/core/geo/cubeSphere';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import type { PackList } from '../../../src/terrain/packIndex';
import { createPackTileSource, type PackTileSource } from '../../../src/terrain/packSource';
import type { StackState } from '../../../deploy/local/launcher';
import { createLocalPackFetch, LOCAL_PACK_LIST_URL } from '../../../tools/pack/localPacks';
import { packedSets } from '../../../tools/pack/packer';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TILES = path.join(REPO, 'data', 'tiles');
const PACKS = path.join(REPO, 'data', 'packs');
const STATE = process.env.STACK_STATE;
if (!STATE) {
  console.error('pack-sweep: run inside the local stack (npm run stack -- -- npx tsx tests/unit/platform/pack-sweep.ts ...)');
  process.exit(2);
}
const state = JSON.parse(fs.readFileSync(STATE, 'utf8')) as StackState;
const [cmd, arg] = process.argv.slice(2);
const opt = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** A source whose pack list is `list` (served from memory), with requests counted. */
function sourceWith(list: PackList, extra: Partial<Parameters<typeof createPackTileSource>[0]> = {}): PackTileSource {
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'http://pack-list.local/packs.json') return new Response(JSON.stringify(list), { status: 200 });
    return fetch(input, init);
  }) as typeof fetch;
  return createPackTileSource({ packListUrl: 'http://pack-list.local/packs.json', fetch: f, ...extra });
}

async function stackList(): Promise<PackList> {
  const r = await fetch(state.urls.packList);
  if (!r.ok) throw new Error(`pack list ${state.urls.packList}: ${r.status}`);
  return (await r.json()) as PackList;
}

function* promised(m: TileManifest): Generator<{ layer: string; key: TileKey }> {
  for (const [layer, lm] of Object.entries(m.layers)) {
    let maxL = lm.globalMaxLevel;
    for (const [l, rects] of Object.entries(lm.coverage)) if (rects.length > 0) maxL = Math.max(maxL, Number(l));
    for (let level = 0; level <= maxL; level++) {
      const side = 2 ** level;
      for (let face = 0; face < 6; face++) {
        if (level <= lm.globalMaxLevel) {
          for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) yield { layer, key: { face: face as FaceId, level, x, y } };
        } else {
          for (const r of lm.coverage[String(level)] ?? []) {
            if (r.face !== face) continue;
            for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
              const key = { face: face as FaceId, level, x, y };
              if (layerHasTile(lm, key)) yield { layer, key };
            }
          }
        }
      }
    }
  }
}

async function sweep(): Promise<number> {
  const wanted = opt('sets')?.split(',');
  const sets = packedSets(PACKS).filter((s) => s.type === 'tiles' && (!wanted || wanted.includes(s.set)));
  const base = await stackList();
  const bucket = base.mirrors.find((m) => m.id === 'bucket')!;
  const mirrorBase = state.urls.mirror;
  const modes: [string, PackTileSource][] = [
    ['whole packs on disk', createPackTileSource({ packListUrl: LOCAL_PACK_LIST_URL, fetch: createLocalPackFetch(PACKS) })],
    ['bucket ranges (presigned)', sourceWith({ ...base, mirrors: [bucket] })],
    ['mirror ranges', sourceWith({ ...base, mirrors: [{ id: 'mirror', mode: 'ranges', base: mirrorBase }] })],
    ['mirror slices 2 MiB', sourceWith({ ...base, mirrors: [{ id: 'mirror', mode: 'slices', base: mirrorBase, sliceBytes: 2 * 1024 * 1024 }] })],
  ];
  const fsSrc = createFsTileSource(TILES);
  let mismatches = 0;
  const report: Record<string, unknown> = {};
  for (const s of sets) {
    const t0 = performance.now();
    const m = await fsSrc.manifest(s.set);
    for (const [name, src] of modes) {
      const pm = await src.manifest(s.set);
      if (JSON.stringify(pm) !== JSON.stringify(m)) {
        mismatches++;
        console.log(`MISMATCH ${s.set} manifest (${name})`);
      }
    }
    // Plain files (globals and others): every one of them, every mode.
    const files: string[] = [];
    const walk = (rel: string): void => {
      for (const e of fs.readdirSync(path.join(TILES, s.set, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (rel !== '' || !(e.name in m.layers)) walk(r);
        } else files.push(r);
      }
    };
    walk('');
    for (const f of files) {
      const want = fs.readFileSync(path.join(TILES, s.set, f));
      for (const [name, src] of modes) {
        const got = Buffer.from(await src.file(s.set, f));
        if (!got.equals(want)) {
          mismatches++;
          console.log(`MISMATCH ${s.set} file ${f} (${name})`);
        }
      }
    }
    let count = 0;
    let bytes = 0;
    let batch: { layer: string; key: TileKey }[] = [];
    const flush = async (): Promise<void> => {
      const want = await Promise.all(batch.map((t) => fsSrc.tile(s.set, t.layer, t.key)));
      for (const [name, src] of modes) {
        const got = await Promise.all(batch.map((t) => src.tile(s.set, t.layer, t.key)));
        for (let i = 0; i < batch.length; i++) {
          if (!got[i] || !Buffer.from(got[i]!).equals(Buffer.from(want[i]!))) {
            mismatches++;
            if (mismatches < 20) console.log(`MISMATCH ${s.set} ${batch[i]!.layer} ${JSON.stringify(batch[i]!.key)} (${name})`);
          }
        }
      }
      for (const w of want) bytes += w!.length;
      count += batch.length;
      batch = [];
    };
    for (const t of promised(m)) {
      batch.push(t);
      if (batch.length >= 4000) {
        await flush();
        if (count % 100_000 < 4000) console.log(`${s.set}: ${count} tiles, ${(bytes / 1e9).toFixed(2)} GB, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
      }
    }
    await flush();
    const seconds = (performance.now() - t0) / 1000;
    report[s.set] = { tiles: count, files: files.length, bytes, seconds, modes: Object.fromEntries(modes.map(([n, src]) => [n, src.stats()])) };
    console.log(`${s.set}: ${count} tiles and ${files.length} files, ${(bytes / 1e9).toFixed(2)} GB, compared in 4 modes in ${seconds.toFixed(0)} s; mismatches so far ${mismatches}`);
  }
  fs.mkdirSync(path.join(REPO, 'out', 'platform'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'out', 'platform', 'sweep.json'), JSON.stringify({ at: new Date().toISOString(), mismatches, report }, null, 1));
  console.log(`sweep: ${mismatches} mismatches`);
  return mismatches;
}

interface TraceEntry {
  t: number;
  path: string;
  status: number;
  bytes: number;
}

async function trace(file: string): Promise<number> {
  const doc = JSON.parse(fs.readFileSync(path.resolve(REPO, file), 'utf8')) as { entries: TraceEntry[] };
  const tiles = doc.entries
    .filter((e) => e.path.startsWith('/tiles/') && e.status === 200)
    .map((e) => {
      const m = /^\/tiles\/([^/]+)\/([^/]+)\/(\d)\/(\d+)\/(\d+)\/(\d+)\.[a-z0-9]+/.exec(e.path);
      return m ? { t: e.t, set: m[1]!, layer: m[2]!, key: { face: Number(m[3]) as FaceId, level: Number(m[4]), x: Number(m[5]), y: Number(m[6]) }, bytes: e.bytes } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.t - b.t);
  const sets = new Set(packedSets(PACKS).map((s) => s.set));
  const replay = tiles.filter((t) => sets.has(t.set));
  const skipped = tiles.length - replay.length;
  const base = await stackList();
  const bucket = base.mirrors.find((m) => m.id === 'bucket')!;
  const runs: Record<string, unknown> = {};
  for (const [name, list] of [
    ['bucket ranges', { ...base, mirrors: [bucket] }],
    ['mirror slices 2 MiB', { ...base, mirrors: [{ id: 'mirror', mode: 'slices' as const, base: state.urls.mirror, sliceBytes: 2 * 1024 * 1024 }] }],
    ['mirror slices 1 MiB', { ...base, mirrors: [{ id: 'mirror', mode: 'slices' as const, base: state.urls.mirror, sliceBytes: 1024 * 1024 }] }],
  ] as [string, PackList][]) {
    const src = sourceWith(list);
    for (const s of new Set(replay.map((t) => t.set))) await src.manifest(s);
    const before = src.stats();
    let i = 0;
    while (i < replay.length) {
      const t0 = replay[i]!.t;
      const window: typeof replay = [];
      while (i < replay.length && replay[i]!.t - t0 <= 50) window.push(replay[i++]!);
      await Promise.all(window.map((t) => src.tile(t.set, t.layer, t.key)));
    }
    const after = src.stats();
    const id = list.mirrors[0]!.id;
    const requests = (after.requests[id] ?? 0) - (before.requests[id] ?? 0);
    const received = (after.bytesReceived[id] ?? 0) - (before.bytesReceived[id] ?? 0);
    const needed = after.bytesNeeded - before.bytesNeeded;
    runs[name] = { requests, bytesReceived: received, bytesNeeded: needed, bytesPerByteNeeded: received / needed };
    console.log(`${name}: ${replay.length} tile reads -> ${requests} requests (${(replay.length / requests).toFixed(1)}x fewer than per file); ${(received / 1e6).toFixed(1)} MB received for ${(needed / 1e6).toFixed(1)} MB needed (${(received / needed).toFixed(3)} bytes per byte needed)`);
  }
  const perFileBytes = replay.reduce((n, t) => n + Math.max(0, t.bytes), 0);
  const out = { at: new Date().toISOString(), trace: file, tileReads: replay.length, skippedNotPacked: skipped, perFile: { requests: replay.length, bytes: perFileBytes }, runs };
  fs.mkdirSync(path.join(REPO, 'out', 'platform'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'out', 'platform', 'trace.json'), JSON.stringify(out, null, 1));
  const bucketRun = runs['bucket ranges'] as { requests: number };
  const ok = bucketRun.requests * 5 <= replay.length;
  console.log(`request count: ${replay.length} per-file requests against ${bucketRun.requests} pack requests: ${ok ? 'PASS' : 'FAIL'} (at least 5x fewer)`);
  return ok ? 0 : 1;
}

const code = cmd === 'sweep' ? await sweep() : cmd === 'trace' ? await trace(arg ?? '') : (console.error('usage: pack-sweep.ts sweep [--sets=a,b] | trace <file>'), 2);
process.exitCode = code;
