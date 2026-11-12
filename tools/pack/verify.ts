/**
 * Byte verification of a packed set and the release check (platform-delivery fix round, item 7).
 *
 * `verifySetBytes` reads EVERYTHING a set's current index promises through the pack source in whole-pack mode
 * (createLocalPackFetch: the same code path as the network modes) and compares it byte for byte with the
 * source directory: the manifest, every tile of every layer and level the manifest promises, and every plain
 * file. It also checks that the index lists every plain file of the source directory and nothing else, and
 * that the set's recorded contentHash is the source manifest's. On success it writes
 * data/packs/<set>/verified.json naming the index it verified. The packer reuses unchanged chunks from earlier
 * runs (incremental packing), so a repacked set is verified this way before anything is uploaded:
 * `upload` refuses a set whose current index has no clean verification (`assertReleasable`).
 *
 * The release check (`assertReleasable`, also run by `verify` against deploy/pack-sets.json): a tile set's
 * pack contentHash must equal the contentHash of data/tiles/<set>/manifest.json, so a set packed from an
 * older bake (Earth before the Madrakah re-bake, say) cannot be released.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TileManifest } from '../../src/core/contracts/terrain';
import { layerHasTile } from '../../src/core/contracts/terrain';
import type { FaceId, TileKey } from '../../src/core/geo/cubeSphere';
import { createFsTileSource } from '../../src/terrain/fsTileSource';
import { decodeIndexHeader, indexHeaderLength } from '../../src/terrain/packIndex';
import { createPackTileSource } from '../../src/terrain/packSource';
import { createLocalPackFetch, LOCAL_PACK_LIST_URL } from './localPacks';
import { listFiles, readCurrent, type CurrentPointer } from './packer';

export const VERIFIED_FILE = 'verified.json';

export interface Verification {
  set: string;
  index: string;
  contentHash: string | null;
  tiles: number;
  files: number;
  bytes: number;
  mismatches: string[];
  seconds: number;
  verifiedAt: string;
}

/** Every tile a manifest promises, every layer and level, in a fixed order. */
export function* promisedTiles(m: TileManifest): Generator<{ layer: string; key: TileKey }> {
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
            for (let y = r.y0; y <= r.y1; y++) {
              for (let x = r.x0; x <= r.x1; x++) {
                const key = { face: face as FaceId, level, x, y };
                if (layerHasTile(lm, key)) yield { layer, key };
              }
            }
          }
        }
      }
    }
  }
}

/** The plain files of a source directory as the packer takes them: not the layer directories, no dot-names. */
export function plainFiles(dir: string, layers: Set<string>): string[] {
  return listFiles(dir, layers).filter((r) => !r.split('/').some((p) => p.startsWith('.')));
}

/** The contentHash of a tile set's source manifest (null for a plain file set or no manifest). */
export function sourceContentHash(sourceDir: string): string | null {
  const f = path.join(sourceDir, 'manifest.json');
  if (!fs.existsSync(f)) return null;
  return (JSON.parse(fs.readFileSync(f, 'utf8')) as { contentHash?: string }).contentHash ?? null;
}

export async function verifySetBytes(o: { packsDir: string; sourceDir: string; set: string; batch?: number; log?: (line: string) => void }): Promise<Verification> {
  const t0 = performance.now();
  const log = o.log ?? (() => undefined);
  const cur = readCurrent(o.packsDir, o.set);
  if (!cur) throw new Error(`verify ${o.set}: nothing packed (no current.json)`);
  const mismatches: string[] = [];
  const miss = (what: string): void => {
    if (mismatches.length < 100) mismatches.push(what);
    else if (mismatches.length === 100) mismatches.push('(more)');
  };
  const src = createPackTileSource({ packListUrl: LOCAL_PACK_LIST_URL, fetch: createLocalPackFetch(o.packsDir) });
  const idx = fs.readFileSync(path.join(o.packsDir, o.set, `${cur.index}.idx`));
  const header = decodeIndexHeader(idx.subarray(8, 8 + indexHeaderLength(idx.subarray(0, 8))));
  let tiles = 0;
  let bytes = 0;

  let layers = new Set<string>();
  if (cur.type === 'tiles') {
    const fsSrc = createFsTileSource(path.dirname(o.sourceDir));
    const name = path.basename(o.sourceDir);
    const m = await fsSrc.manifest(name);
    layers = new Set(Object.keys(m.layers));
    if (JSON.stringify(await src.manifest(o.set)) !== JSON.stringify(m)) miss('manifest differs');
    if (cur.contentHash !== m.contentHash) miss(`contentHash: packed ${cur.contentHash}, source ${m.contentHash}`);
    const batchSize = o.batch ?? 512;
    let batch: { layer: string; key: TileKey }[] = [];
    let lastLog = performance.now();
    const flush = async (): Promise<void> => {
      const [want, got] = await Promise.all([Promise.all(batch.map((t) => fsSrc.tile(name, t.layer, t.key))), Promise.all(batch.map((t) => src.tile(o.set, t.layer, t.key)))]);
      for (let i = 0; i < batch.length; i++) {
        const a = want[i];
        const b = got[i];
        tiles++;
        if (a) bytes += a.length;
        if (!a || !b || !Buffer.from(a).equals(Buffer.from(b))) {
          const t = batch[i]!;
          miss(`tile ${t.layer} ${t.key.face}/${t.key.level}/${t.key.x}/${t.key.y}`);
        }
      }
      batch = [];
      if (performance.now() - lastLog > 30_000) {
        lastLog = performance.now();
        log(`${o.set}: ${tiles} tiles verified (${(bytes / 1e9).toFixed(2)} GB), ${mismatches.length} mismatches`);
      }
    };
    for (const t of promisedTiles(m)) {
      batch.push(t);
      if (batch.length >= batchSize) await flush();
    }
    await flush();
  }

  // Plain files: the index lists exactly the source's, and each one reads back byte-identical.
  const files = plainFiles(o.sourceDir, layers);
  const indexed = new Set(Object.keys(header.files));
  for (const f of files) {
    if (!indexed.has(f)) {
      miss(`file ${f}: in the source, not in the index`);
      continue;
    }
    const want = fs.readFileSync(path.join(o.sourceDir, f));
    bytes += want.length;
    if (!Buffer.from(await src.file(o.set, f)).equals(want)) miss(`file ${f} differs`);
  }
  for (const f of indexed) if (!files.includes(f)) miss(`file ${f}: in the index, not in the source`);

  const v: Verification = { set: o.set, index: cur.index, contentHash: cur.contentHash, tiles, files: files.length, bytes, mismatches, seconds: Math.round((performance.now() - t0) / 100) / 10, verifiedAt: new Date().toISOString() };
  if (mismatches.length === 0) fs.writeFileSync(path.join(o.packsDir, o.set, VERIFIED_FILE), `${JSON.stringify(v, null, 1)}\n`);
  else fs.rmSync(path.join(o.packsDir, o.set, VERIFIED_FILE), { force: true });
  return v;
}

/**
 * Refuses (throws) to release a set: without a clean byte verification of its current index, or when it is a
 * tile set whose packed contentHash is not the one of its source manifest now.
 */
export function assertReleasable(packsDir: string, set: string, sourceDir: string | null): CurrentPointer {
  const cur = readCurrent(packsDir, set);
  if (!cur) throw new Error(`release ${set}: nothing packed`);
  const vf = path.join(packsDir, set, VERIFIED_FILE);
  const v = fs.existsSync(vf) ? (JSON.parse(fs.readFileSync(vf, 'utf8')) as Verification) : null;
  if (!v || v.index !== cur.index || v.mismatches.length > 0) {
    throw new Error(`release ${set}: index ${cur.index} has no clean byte verification (run: tools/pack/cli.ts check --sets=${set})`);
  }
  if (cur.type === 'tiles') {
    const want = sourceDir ? sourceContentHash(sourceDir) : null;
    if (!want || cur.contentHash !== want) throw new Error(`release ${set}: packed from contentHash ${cur.contentHash}, the tile set is now ${want ?? 'missing'}: repack it`);
  }
  return cur;
}
