/**
 * The tile packer (ARCHITECTURE 10.4; format in src/terrain/packIndex.ts). Node only.
 *
 *   packSet(opts)  one tile set (a directory with a TileManifest) or one plain file set (sky data, assets) into
 *                  content-addressed packs and one index object under <out>/<set>/, plus the local pointer
 *                  <out>/<set>/current.json naming the index. Tile bytes are copied unchanged.
 *
 * Incremental and content-addressed:
 *  - Pack boundaries are content-defined. Every group has a boundary id (a hash of its file paths and sizes);
 *    a pack is closed after a group whose id is 0 modulo `cutModulus` once it holds at least `minBytes`, and
 *    before it would pass `maxBytes`; a kind always starts a new pack. So a bake that adds tiles changes the
 *    packs around the additions only, and every other pack keeps its bytes and therefore its name.
 *  - A pack is named by the SHA-256 of its bytes. The run that writes it hashes what it writes; a pack whose
 *    name exists already is never written again (same bytes).
 *  - A chunk whose files are unchanged (same paths, sizes and modification times as when its pack was written:
 *    <out>/<set>/.chunks.json) is not read at all. A re-run over unchanged tiles stats the files and reads none.
 *  - The packer is deterministic: the same tiles give the same pack and index names on any machine.
 *
 * Packs that no index refers to any more stay on disk until `pruneSet` is run explicitly; the bucket is never
 * pruned (no role and no tool deletes or overwrites a pack there).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { TileManifest } from '../../src/core/contracts/terrain';
import { layerHasTile } from '../../src/core/contracts/terrain';
import { tilePath, type FaceId, type TileKey } from '../../src/core/geo/cubeSphere';
import {
  ABSENT_LENGTH,
  encodeIndexObject,
  encodeRecord,
  groupCodeAt,
  groupSet,
  groupSetSize,
  HASH_HEX,
  kindMaxLevel,
  mortonDecode,
  PACK_FORMAT_VERSION,
  PACK_MAX_BYTES,
  PACK_MIN_BYTES,
  recordBytes,
  SECTION_MAX_RECORDS,
  tileKinds,
  type PackFileEntry,
  type PackKind,
  type PackRef,
  type PackSection,
  type TilePackIndex,
} from '../../src/terrain/packIndex';
import { validateTileManifest } from '../../src/terrain/tileSource';

/** A tile set is small (one kind per layer, ARCHITECTURE 10.4) when all its tiles fit one pack. */
export const SMALL_SET_BYTES = PACK_MAX_BYTES;
/** Expected number of groups between content-defined cuts once a pack has its minimum size. */
export const DEFAULT_CUT_MODULUS = 2048;

export interface PackOptions {
  /** Directory of the set (data/tiles/<set>, data/sky, public/assets). */
  dir: string;
  set: string;
  /** `tiles`: the directory holds a TileManifest and its layers; `files`: every file is a plain file. */
  type: 'tiles' | 'files';
  /** Output root (data/packs). */
  out: string;
  minBytes?: number;
  maxBytes?: number;
  cutModulus?: number;
  /** Concurrent file operations. */
  concurrency?: number;
  /** A tile set whose tiles total at most this is packed as a small body (one kind per layer). Default SMALL_SET_BYTES. */
  smallSetBytes?: number;
  /** Refuse to write a pack that would leave less than this free on the output's disk (PACKAGE_RULES 13d). */
  minFreeBytes?: number;
  log?: (line: string) => void;
}

export interface PackResult {
  set: string;
  type: 'tiles' | 'files';
  index: string;
  indexBytes: number;
  packs: PackRef[];
  /** Packs written by this run (the others existed already). */
  written: string[];
  groups: number;
  tiles: number;
  files: number;
  bytes: number;
  filesRead: number;
  seconds: number;
  contentHash: string | null;
}

/** The pointer <out>/<set>/current.json. */
export interface CurrentPointer {
  set: string;
  type: 'tiles' | 'files';
  index: string;
  indexBytes: number;
  packs: PackRef[];
  contentHash: string | null;
  packedAt: string;
}

export const contentHashOf = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex').slice(0, HASH_HEX);

/** One element of the stream of a kind: a tile group (several files) or one plain file. */
interface Item {
  /** Absolute paths of the layers in kind order (null = absent). */
  files: (string | null)[];
  sizes: number[];
  mtimes: number[];
  /** Boundary id: hash of the relative paths and sizes. */
  id: string;
  bytes: number;
  key: TileKey | null;
  relPath: string | null;
  /** Plain files only: sha256 of the content (32 hex). */
  sha: string | null;
}

interface Chunk {
  kind: number;
  items: Item[];
  bytes: number;
  fingerprint: string;
  hash: string | null;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/** Every file under `dir` (forward-slash paths relative to it), sorted; `skipTop` names top-level directories to leave out. */
export function listFiles(dir: string, skipTop: Set<string> = new Set()): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!(rel === '' && skipTop.has(e.name))) stack.push(r);
      } else if (e.isFile()) out.push(r);
    }
  }
  return out.sort();
}

/** Bounded-concurrency map that keeps the order of results. */
export async function mapOrdered<T, R>(items: T[], concurrency: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

const shortHash = (parts: (string | number)[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, HASH_HEX);

export async function packSet(o: PackOptions): Promise<PackResult> {
  const t0 = Date.now();
  const log = o.log ?? (() => undefined);
  const minBytes = o.minBytes ?? PACK_MIN_BYTES;
  const maxBytes = o.maxBytes ?? PACK_MAX_BYTES;
  const cutModulus = o.cutModulus ?? DEFAULT_CUT_MODULUS;
  const concurrency = o.concurrency ?? 64;
  const outDir = path.join(o.out, o.set);
  fs.mkdirSync(outDir, { recursive: true });
  const chunksFile = path.join(outDir, '.chunks.json');
  const chunkCache: Record<string, string> = readJson(chunksFile, {});
  let filesRead = 0;

  const manifestPath = path.join(o.dir, 'manifest.json');
  let manifest: TileManifest | null = null;
  if (o.type === 'tiles') manifest = validateTileManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown, o.set);

  // ---- plain files: everything outside the layer directories (manifest, globals, other files). Read and
  // hashed in the scan (they are few), so the index can carry each file's own hash.
  const layerDirs = new Set(manifest ? Object.keys(manifest.layers) : []);
  const plainRel = listFiles(o.dir, layerDirs).filter((r) => !r.split('/').some((p) => p.startsWith('.')));
  const plainItems = await mapOrdered(plainRel, concurrency, async (rel): Promise<Item> => {
    const abs = path.join(o.dir, rel);
    const st = await fsp.stat(abs);
    const buf = await fsp.readFile(abs);
    filesRead++;
    return { files: [abs], sizes: [buf.length], mtimes: [st.mtimeMs], id: shortHash([rel, buf.length]), bytes: buf.length, key: null, relPath: rel, sha: contentHashOf(buf) };
  });

  // ---- tile kinds
  let kinds: PackKind[] = [];
  const streams: Item[][] = [];
  let tileCount = 0;
  if (manifest) {
    const m = manifest;
    const kindItems = async (kind: PackKind): Promise<Item[]> => {
      const keys: TileKey[] = [];
      const maxL = kindMaxLevel(m, kind);
      for (let level = 0; level <= maxL; level++) {
        for (let face = 0; face < 6; face++) {
          const gs = groupSet(m, kind, level, face);
          const n = groupSetSize(gs);
          for (let i = 0; i < n; i++) {
            const { x, y } = mortonDecode(groupCodeAt(gs, i));
            keys.push({ face: face as FaceId, level, x, y });
          }
        }
      }
      log(`${o.set}/${kind.name}: ${keys.length} groups`);
      let done = 0;
      return mapOrdered(keys, concurrency, async (key): Promise<Item> => {
        const files: (string | null)[] = [];
        const sizes: number[] = [];
        const mtimes: number[] = [];
        const idParts: (string | number)[] = [];
        for (const layer of kind.layers) {
          const lm = m.layers[layer]!;
          if (!layerHasTile(lm, key)) {
            files.push(null);
            sizes.push(ABSENT_LENGTH);
            mtimes.push(0);
            continue;
          }
          const rel = tilePath(o.set, layer, key, lm.ext).slice(o.set.length + 1);
          const abs = path.join(o.dir, rel);
          let st: fs.Stats;
          try {
            st = await fsp.stat(abs);
          } catch (e) {
            throw new Error(`pack ${o.set}: the manifest promises ${rel} but it cannot be read (${(e as Error).message})`);
          }
          files.push(abs);
          sizes.push(st.size);
          mtimes.push(st.mtimeMs);
          idParts.push(rel, st.size);
        }
        if (++done % 100000 === 0) log(`${o.set}/${kind.name}: scanned ${done}/${keys.length}`);
        let bytes = 0;
        for (const s of sizes) if (s !== ABSENT_LENGTH) bytes += s;
        return { files, sizes, mtimes, id: shortHash(idParts), bytes, key, relPath: null, sha: null };
      });
    };
    // A small body (all of it fits one pack) gets one kind per layer; a large one height and surface.
    const big = tileKinds(m, false);
    const perKind: Item[][] = [];
    let total = 0;
    for (const kind of big) {
      const items = await kindItems(kind);
      perKind.push(items);
      for (const it of items) total += it.bytes;
    }
    if (total <= (o.smallSetBytes ?? SMALL_SET_BYTES) && Object.keys(m.layers).length > 1) {
      kinds = tileKinds(m, true);
      for (const kind of kinds) streams.push(await kindItems(kind));
    } else {
      kinds = big;
      streams.push(...perKind);
    }
    for (const s of streams) for (const it of s) tileCount += it.files.filter((f) => f !== null).length;
  }
  kinds = [...kinds, { name: 'files', layers: ['file'] }];
  streams.push(plainItems);

  // ---- content-defined chunks
  const chunks: Chunk[] = [];
  streams.forEach((items, k) => {
    let cur: Item[] = [];
    let curBytes = 0;
    const close = (): void => {
      if (cur.length === 0) return;
      const parts: (string | number)[] = [];
      for (const it of cur) parts.push(it.id, ...it.mtimes);
      chunks.push({ kind: k, items: cur, bytes: curBytes, fingerprint: shortHash(parts), hash: null });
      cur = [];
      curBytes = 0;
    };
    for (const it of items) {
      if (it.bytes > maxBytes) throw new Error(`pack ${o.set}: one group is ${it.bytes} bytes, more than a pack may hold`);
      if (curBytes > 0 && curBytes + it.bytes > maxBytes) close();
      cur.push(it);
      curBytes += it.bytes;
      if (curBytes >= minBytes && Number.parseInt(it.id.slice(0, 8), 16) % cutModulus === 0) close();
    }
    close();
  });

  // ---- write the packs that do not exist yet
  const written: string[] = [];
  let reused = 0;
  for (const ch of chunks) {
    const known = chunkCache[ch.fingerprint];
    if (known && fs.existsSync(path.join(outDir, `${known}.pack`))) {
      ch.hash = known;
      reused++;
      continue;
    }
    if (o.minFreeBytes !== undefined) {
      const st = fs.statfsSync(outDir);
      const free = st.bavail * st.bsize;
      if (free - ch.bytes < o.minFreeBytes) throw new Error(`pack ${o.set}: writing ${(ch.bytes / 1e9).toFixed(2)} GB would leave ${((free - ch.bytes) / 1e9).toFixed(1)} GB free, under the ${(o.minFreeBytes / 1e9).toFixed(0)} GB floor; stopped (the packs written so far are kept and reused by the next run)`);
    }
    const tmp = path.join(outDir, `.writing-${process.pid}.pack`);
    const fd = fs.openSync(tmp, 'w');
    const h = createHash('sha256');
    let at = 0;
    try {
      const flat: { file: string; size: number }[] = [];
      for (const it of ch.items) it.files.forEach((f, i) => f !== null && flat.push({ file: f, size: it.sizes[i]! }));
      for (let i = 0; i < flat.length; i += 512) {
        const batch = flat.slice(i, i + 512);
        const bufs = await mapOrdered(batch, concurrency, (e) => fsp.readFile(e.file));
        filesRead += bufs.length;
        bufs.forEach((b, j) => {
          if (b.length !== batch[j]!.size) throw new Error(`pack ${o.set}: ${batch[j]!.file} changed while packing (${b.length} bytes, scanned ${batch[j]!.size}); run again`);
          h.update(b);
          fs.writeSync(fd, b, 0, b.length, at);
          at += b.length;
        });
      }
    } finally {
      fs.closeSync(fd);
    }
    if (at !== ch.bytes) throw new Error(`pack ${o.set}: wrote ${at} bytes, expected ${ch.bytes}`);
    const hash = h.digest('hex').slice(0, HASH_HEX);
    const final = path.join(outDir, `${hash}.pack`);
    if (fs.existsSync(final)) fs.unlinkSync(tmp);
    else {
      fs.renameSync(tmp, final);
      written.push(hash);
    }
    ch.hash = hash;
    chunkCache[ch.fingerprint] = hash;
    writeJsonAtomic(chunksFile, chunkCache);
    log(`${o.set}: pack ${hash} ${(ch.bytes / 1e6).toFixed(1)} MB, ${ch.items.length} groups (${chunks.indexOf(ch) + 1}/${chunks.length})`);
  }
  log(`${o.set}: ${chunks.length} packs, ${written.length} written, ${reused} unchanged`);

  // ---- the index
  const packs: PackRef[] = [];
  const packNo = new Map<string, number>();
  const sectionBytes: Uint8Array[] = [];
  const sections: PackSection[] = [];
  const files: Record<string, PackFileEntry> = {};
  const perKey = new Map<string, { k: number; l: number; f: number; recs: Uint8Array[] }>();
  for (const ch of chunks) {
    let no = packNo.get(ch.hash!);
    if (no === undefined) {
      no = packs.length;
      packs.push({ hash: ch.hash!, bytes: ch.bytes });
      packNo.set(ch.hash!, no);
    }
    let offset = 0;
    const kind = kinds[ch.kind]!;
    for (const it of ch.items) {
      if (it.key === null) files[it.relPath!] = [no, offset, it.bytes, it.sha!];
      else {
        const rec = new Uint8Array(recordBytes(kind.layers.length));
        encodeRecord(new DataView(rec.buffer), 0, { pack: no, offset, lengths: it.sizes });
        const k = `${ch.kind}/${it.key.level}/${it.key.face}`;
        let e = perKey.get(k);
        if (!e) perKey.set(k, (e = { k: ch.kind, l: it.key.level, f: it.key.face, recs: [] }));
        e.recs.push(rec);
      }
      offset += it.bytes;
    }
  }
  if (packs.length > 0xffff) throw new Error(`pack ${o.set}: more than 65,535 packs`);
  for (const e of [...perKey.values()].sort((a, b) => a.k - b.k || a.l - b.l || a.f - b.f)) {
    const rb = recordBytes(kinds[e.k]!.layers.length);
    for (let first = 0; first < e.recs.length; first += SECTION_MAX_RECORDS) {
      const count = Math.min(SECTION_MAX_RECORDS, e.recs.length - first);
      const buf = new Uint8Array(count * rb);
      for (let i = 0; i < count; i++) buf.set(e.recs[first + i]!, i * rb);
      sections.push({ k: e.k, l: e.l, f: e.f, first, count, offset: 0, bytes: buf.length });
      sectionBytes.push(buf);
    }
  }
  const header: TilePackIndex = {
    v: PACK_FORMAT_VERSION,
    set: o.set,
    type: o.type,
    contentHash: manifest ? manifest.contentHash : null,
    packs,
    kinds,
    sections,
    files,
  };
  const idx = encodeIndexObject(header, sectionBytes);
  const indexHash = contentHashOf(idx);
  const idxFile = path.join(outDir, `${indexHash}.idx`);
  if (!fs.existsSync(idxFile)) {
    fs.writeFileSync(`${idxFile}.${process.pid}.tmp`, idx);
    fs.renameSync(`${idxFile}.${process.pid}.tmp`, idxFile);
  }
  // A manifest that changed while we packed means the set was being re-baked: refuse to move the pointer.
  if (manifest) {
    const now = validateTileManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown, o.set);
    if (now.contentHash !== manifest.contentHash) throw new Error(`pack ${o.set}: the manifest changed while packing (${manifest.contentHash} -> ${now.contentHash}); run again`);
  }
  const pointer: CurrentPointer = {
    set: o.set,
    type: o.type,
    index: indexHash,
    indexBytes: idx.length,
    packs,
    contentHash: header.contentHash,
    packedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(outDir, 'current.json'), pointer);
  let bytes = 0;
  for (const p of packs) bytes += p.bytes;
  return {
    set: o.set,
    type: o.type,
    index: indexHash,
    indexBytes: idx.length,
    packs,
    written,
    groups: chunks.reduce((n, c) => n + c.items.length, 0),
    tiles: tileCount,
    files: plainItems.length,
    bytes,
    filesRead,
    seconds: (Date.now() - t0) / 1000,
    contentHash: header.contentHash,
  };
}

/** The current pointer of a packed set, or null. */
export function readCurrent(out: string, set: string): CurrentPointer | null {
  return readJson<CurrentPointer | null>(path.join(out, set, 'current.json'), null);
}

/** Every packed set under `out` (directories with a current.json). */
export function packedSets(out: string): CurrentPointer[] {
  if (!fs.existsSync(out)) return [];
  return fs
    .readdirSync(out, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readCurrent(out, e.name))
    .filter((p): p is CurrentPointer => p !== null)
    .sort((a, b) => a.set.localeCompare(b.set));
}

/** Delete local packs and indexes of a set that its current index does not name (never touches a bucket). */
export function pruneSet(out: string, set: string): { removed: string[]; keptBytes: number } {
  const cur = readCurrent(out, set);
  if (!cur) throw new Error(`prune ${set}: no current.json`);
  const keep = new Set([...cur.packs.map((p) => `${p.hash}.pack`), `${cur.index}.idx`]);
  const removed: string[] = [];
  let keptBytes = 0;
  for (const name of fs.readdirSync(path.join(out, set))) {
    if (!/\.(pack|idx)$/.test(name)) continue;
    const abs = path.join(out, set, name);
    if (keep.has(name)) keptBytes += fs.statSync(abs).size;
    else {
      fs.unlinkSync(abs);
      removed.push(name);
    }
  }
  return { removed, keptBytes };
}
