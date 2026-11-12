/**
 * The boot pack (ARCHITECTURE 10.4): one small content-addressed pack holding the baked data the title needs,
 * inside one byte budget that also pays for the first-paint chunks of the client build and the definition
 * library (both built from the repository and NOT in the pack).
 *
 * The contents are data: deploy/boot-pack.json lists items in priority order (tile levels of a layer, plain
 * files, the tail of a file such as the low mips of a sky face). Items are taken greedily in that order while
 * they fit the budget left after the bundle and the definitions; every item that does not fit is recorded as
 * deferred, with its size, in the boot manifest. Tile bytes are copied unchanged; the pack is deterministic.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TileManifest } from '../../src/core/contracts/terrain';
import { layerHasTile } from '../../src/core/contracts/terrain';
import { tilePath, type FaceId } from '../../src/core/geo/cubeSphere';
import { encodeBootPack, type BootEntry } from '../../src/terrain/packIndex';
import { validateTileManifest } from '../../src/terrain/tileSource';
import { contentHashOf } from './packer';

export type BootItem =
  | { set: string; layer: string; levels: [number, number]; note?: string }
  | { set: string; path: string; from?: number; note?: string };

export interface BootConfig {
  /** Bytes for the whole boot set: first-paint chunks + definitions + this pack. */
  budgetBytes: number;
  /** Set name -> directory relative to the repository. */
  roots: Record<string, string>;
  items: BootItem[];
  /** What the title would want and nothing baked can give (stated in the manifest as deferred). */
  notBaked: { item: string; reason: string }[];
}

export interface BootManifest {
  v: 1;
  hash: string;
  bytes: number;
  budgetBytes: number;
  /** First-paint chunks of the client build the budget was computed against. */
  clientBuild: { hash: string | null; firstPaintBytes: number; files: string[] };
  defsBytes: number;
  included: { item: string; bytes: number; entries: number }[];
  deferred: { item: string; bytes: number | null; reason: string }[];
  builtFrom: Record<string, string | null>;
}

export const itemName = (it: BootItem): string =>
  'layer' in it ? `${it.set}/${it.layer} levels ${it.levels[0]}-${it.levels[1]}` : `${it.set}/${it.path}${it.from !== undefined ? ` from byte ${it.from}` : ''}`;

/**
 * Bytes of the first paint of a client build: index.html and every script and stylesheet it references, and
 * every JavaScript chunk those import statically (`import ... from "./x.js"`) - Vite's entry and its static
 * graph. Worker chunks and lazily imported chunks are not first paint.
 */
export function firstPaintBytes(buildDir: string): { bytes: number; files: string[] } {
  const files = new Set<string>(['index.html']);
  const html = fs.readFileSync(path.join(buildDir, 'index.html'), 'utf8');
  const queue: string[] = [];
  for (const m of html.matchAll(/(?:src|href)="\/?([^"]+\.(?:js|css))"/g)) queue.push(m[1]!);
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    if (!f.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(buildDir, f), 'utf8');
    for (const m of text.matchAll(/(?:^|[;\n}])\s*import\s*(?:[\w*{}\s,$]+from\s*)?["']\.\/([^"']+\.js)["']/g)) queue.push(path.posix.join(path.posix.dirname(f), m[1]!));
  }
  let bytes = 0;
  for (const f of files) bytes += fs.statSync(path.join(buildDir, f)).size;
  return { bytes, files: [...files].sort() };
}

/** Total bytes of the definition library as the build ships it (defs/**.json). */
export function defsBytes(buildDir: string): number {
  let n = 0;
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) n += fs.statSync(p).size;
    }
  };
  walk(path.join(buildDir, 'defs'));
  return n;
}

interface Collected {
  entries: { entry: BootEntry; bytes: Uint8Array }[];
  bytes: number;
}

function collect(repoRoot: string, cfg: BootConfig, it: BootItem): Collected {
  const root = cfg.roots[it.set];
  if (!root) throw new Error(`boot pack: no root for set ${it.set}`);
  const dir = path.join(repoRoot, root);
  const out: Collected = { entries: [], bytes: 0 };
  if ('layer' in it) {
    const m: TileManifest = validateTileManifest(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as unknown, it.set);
    const lm = m.layers[it.layer];
    if (!lm) throw new Error(`boot pack: ${it.set} has no layer ${it.layer}`);
    for (let level = it.levels[0]; level <= it.levels[1]; level++) {
      const side = 2 ** level;
      for (let face = 0; face < 6; face++) {
        for (let y = 0; y < side; y++) {
          for (let x = 0; x < side; x++) {
            const key = { face: face as FaceId, level, x, y };
            if (!layerHasTile(lm, key)) continue;
            const b = fs.readFileSync(path.join(dir, tilePath(it.set, it.layer, key, lm.ext).slice(it.set.length + 1)));
            out.entries.push({ entry: { set: it.set, layer: it.layer, face, level, x, y, o: 0, n: 0 }, bytes: b });
            out.bytes += b.length;
          }
        }
      }
    }
  } else {
    const whole = fs.readFileSync(path.join(dir, it.path));
    const b = it.from === undefined ? whole : whole.subarray(it.from);
    out.entries.push({ entry: it.from === undefined ? { set: it.set, path: it.path, o: 0, n: 0 } : { set: it.set, path: it.path, from: it.from, o: 0, n: 0 }, bytes: b });
    out.bytes += b.length;
  }
  return out;
}

/**
 * Build the boot pack into <out>/boot/<hash>.pack and return its manifest (the caller writes it to
 * deploy/boot-manifest.json after the upload). `buildDir` is the client build the budget is measured on.
 */
export function buildBootPack(o: { repoRoot: string; config: BootConfig; buildDir: string; buildHash: string | null; out: string }): BootManifest {
  const fp = firstPaintBytes(o.buildDir);
  const defs = defsBytes(o.buildDir);
  // The pack's own header (one JSON line per entry) is counted against the budget too: reserve it as we go.
  let left = o.config.budgetBytes - fp.bytes - defs;
  const chosen: { entry: BootEntry; bytes: Uint8Array }[] = [];
  const included: BootManifest['included'] = [];
  const deferred: BootManifest['deferred'] = [];
  for (const it of o.config.items) {
    const c = collect(o.repoRoot, o.config, it);
    const headerCost = c.entries.length * 96;
    if (c.bytes + headerCost <= left) {
      chosen.push(...c.entries);
      included.push({ item: itemName(it), bytes: c.bytes, entries: c.entries.length });
      left -= c.bytes + headerCost;
    } else {
      deferred.push({ item: itemName(it), bytes: c.bytes, reason: `does not fit: ${(c.bytes / 1e6).toFixed(2)} MB against ${(Math.max(0, left) / 1e6).toFixed(2)} MB left of the ${(o.config.budgetBytes / 1e6).toFixed(0)} MB boot budget` });
    }
  }
  for (const n of o.config.notBaked) deferred.push({ item: n.item, bytes: null, reason: n.reason });
  const pack = encodeBootPack(chosen);
  const hash = contentHashOf(pack);
  const dir = path.join(o.out, 'boot');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hash}.pack`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(`${file}.tmp`, pack);
    fs.renameSync(`${file}.tmp`, file);
  }
  const builtFrom: Record<string, string | null> = {};
  for (const set of new Set(o.config.items.map((i) => i.set))) {
    const mf = path.join(o.repoRoot, o.config.roots[set]!, 'manifest.json');
    const j = fs.existsSync(mf) ? (JSON.parse(fs.readFileSync(mf, 'utf8')) as { contentHash?: string }) : {};
    builtFrom[set] = j.contentHash ?? null;
  }
  if (pack.length + fp.bytes + defs > o.config.budgetBytes) throw new Error(`boot pack: ${pack.length + fp.bytes + defs} bytes is over the ${o.config.budgetBytes} budget`);
  return {
    v: 1,
    hash,
    bytes: pack.length,
    budgetBytes: o.config.budgetBytes,
    clientBuild: { hash: o.buildHash, firstPaintBytes: fp.bytes, files: fp.files },
    defsBytes: defs,
    included,
    deferred,
    builtFrom,
  };
}
