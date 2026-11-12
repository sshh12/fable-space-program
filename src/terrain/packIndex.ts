/**
 * The tile pack format (ARCHITECTURE 10.4): what `tools/pack` writes and what the pack source reads. Pure
 * data and arithmetic: no I/O, no clock, so the packer (Node) and the client (main thread, workers) share
 * one definition of every byte. `TilePackIndex` is defined here by `platform-delivery`; the lead lifts it
 * into `src/core/contracts/terrain.ts` afterwards.
 *
 * Objects (all content-addressed: the name is the first 32 hex digits of the SHA-256 of the bytes, and an
 * object is never rewritten):
 *
 *   <hash>.pack   64-256 MB of tile bytes copied unchanged from the bake. A tile GROUP is every layer of one
 *                 kind at one tile coordinate, stored adjacent in the kind's layer order. Groups follow each
 *                 other by level, then face, then Morton order of (x, y) inside the face. Height is a kind of
 *                 its own (so the servers read height packs only); the other layers of a large body form the
 *                 `surface` kind; a small body has one kind per layer. Plain files of a set (the manifest,
 *                 globals, any other file) are a kind of their own (`files`), in path order. Pack boundaries
 *                 are content-defined (a group-hash rule between a minimum and a maximum size), so a later
 *                 bake that adds tiles changes only the packs around what it added.
 *   <hash>.idx    the index of one set: FPI1 magic, u32 header length, the header JSON (packs, kinds,
 *                 sections, files) and binary sections of records. A record is the location of one group:
 *                 u16 pack number, u32 offset in the pack, then one u32 length per layer of the kind
 *                 (ABSENT_LENGTH when that layer has no tile at that coordinate). A section holds at most
 *                 SECTION_MAX_RECORDS records of one (kind, level, face), so a client reads the index lazily,
 *                 by range, a section at a time.
 *   boot pack     one small pack (FPB1) whose header lists every entry it carries; built by `tools/pack boot`.
 *
 * The record of a tile is found WITHOUT a key in the file: the groups of a (kind, level, face) are exactly the
 * tile coordinates that any layer of the kind has there (`layerHasTile`, a pure function of the manifest), in
 * Morton order. At a level where a layer of the kind is global the set is dense and the ordinal is the Morton
 * code itself; at a sparse level the ordinal is the rank of the code among the covered ones.
 */
import type { TileManifest, TileRect } from '../core/contracts/terrain';
import type { TileKey } from '../core/geo/cubeSphere';

export const PACK_INDEX_MAGIC = 'FPI1';
export const BOOT_PACK_MAGIC = 'FPB1';
export const PACK_FORMAT_VERSION = 1;
/** Pack sizes (bytes): content-defined boundaries never fall below the minimum nor above the maximum. */
export const PACK_MIN_BYTES = 64 * 1024 * 1024;
export const PACK_MAX_BYTES = 256 * 1024 * 1024;
/** Records per index section. */
export const SECTION_MAX_RECORDS = 4096;
/** Length of a layer that has no tile at a coordinate of its group. */
export const ABSENT_LENGTH = 0xffffffff;
/** Hex digits of a content hash (128 bits of SHA-256). */
export const HASH_HEX = 32;
/** Deepest level the Morton arithmetic here supports (x, y < 2^15). */
export const MAX_PACK_LEVEL = 15;

/** One pack an index refers to. */
export interface PackRef {
  hash: string;
  bytes: number;
}

/** A kind of group: the layers stored together, in this order. `files` is the plain-file kind. */
export interface PackKind {
  name: string;
  layers: string[];
}

/** One section of records: ordinals [first, first + count) of (kind, level, face), at [offset, offset + bytes) of the index object. */
export interface PackSection {
  k: number;
  l: number;
  f: number;
  first: number;
  count: number;
  offset: number;
  bytes: number;
}

/** A plain file of a set: [pack number, offset, length, sha256 of the file (32 hex)]. */
export type PackFileEntry = [number, number, number, string];

/** The JSON header of a `.idx` object. */
export interface TilePackIndex {
  v: typeof PACK_FORMAT_VERSION;
  /** Set name: a tile set (`earth`) or a file set (`sky`, `assets`). */
  set: string;
  /** `tiles` when the set has a manifest.json (a TileManifest), `files` for a plain file set. */
  type: 'tiles' | 'files';
  /** The manifest's contentHash at packing time (tile sets). */
  contentHash: string | null;
  packs: PackRef[];
  kinds: PackKind[];
  sections: PackSection[];
  /** Path relative to the set root (forward slashes) -> location. Tile sets list manifest.json here. */
  files: Record<string, PackFileEntry>;
}

/** Size in bytes of one record of a kind with `layerCount` layers. */
export const recordBytes = (layerCount: number): number => 6 + 4 * layerCount;

/** Location of one group, decoded. `lengths[i]` is ABSENT_LENGTH for an absent layer. */
export interface GroupRecord {
  pack: number;
  offset: number;
  lengths: number[];
}

export function encodeRecord(view: DataView, at: number, r: GroupRecord): void {
  view.setUint16(at, r.pack, true);
  view.setUint32(at + 2, r.offset, true);
  for (let i = 0; i < r.lengths.length; i++) view.setUint32(at + 6 + 4 * i, r.lengths[i]!, true);
}

export function decodeRecord(view: DataView, at: number, layerCount: number): GroupRecord {
  const lengths: number[] = [];
  for (let i = 0; i < layerCount; i++) lengths.push(view.getUint32(at + 6 + 4 * i, true));
  return { pack: view.getUint16(at, true), offset: view.getUint32(at + 2, true), lengths };
}

/** Byte range of layer `layerIdx` inside a group, or null when that layer is absent there. */
export function layerRange(r: GroupRecord, layerIdx: number): { offset: number; length: number } | null {
  const len = r.lengths[layerIdx];
  if (len === undefined || len === ABSENT_LENGTH) return null;
  let off = r.offset;
  for (let i = 0; i < layerIdx; i++) {
    const l = r.lengths[i]!;
    if (l !== ABSENT_LENGTH) off += l;
  }
  return { offset: off, length: len };
}

/** Total bytes of a group (the present layers). */
export function groupBytes(r: GroupRecord): number {
  let n = 0;
  for (const l of r.lengths) if (l !== ABSENT_LENGTH) n += l;
  return n;
}

// ------------------------------------------------------------------------------------------------- Morton

function spread16(v: number): number {
  let x = v & 0xffff;
  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  return x >>> 0;
}

function compact16(v: number): number {
  let x = v & 0x55555555;
  x = (x | (x >>> 1)) & 0x33333333;
  x = (x | (x >>> 2)) & 0x0f0f0f0f;
  x = (x | (x >>> 4)) & 0x00ff00ff;
  x = (x | (x >>> 8)) & 0x0000ffff;
  return x >>> 0;
}

/** Morton code of (x, y): x in the even bits, y in the odd bits. x, y < 2^15. */
export function mortonEncode(x: number, y: number): number {
  return (spread16(x) | (spread16(y) << 1)) >>> 0;
}

export function mortonDecode(code: number): { x: number; y: number } {
  return { x: compact16(code), y: compact16(code >>> 1) };
}

// ------------------------------------------------------------------------------------------- group sets

/** Kinds of a tile set: `height` alone and the rest as `surface` for a large body; one kind per layer for a small one. */
export function tileKinds(manifest: TileManifest, small: boolean): PackKind[] {
  const names = Object.keys(manifest.layers).sort();
  if (small) return names.map((n) => ({ name: n, layers: [n] }));
  const kinds: PackKind[] = [];
  if (names.includes('height')) kinds.push({ name: 'height', layers: ['height'] });
  const rest = names.filter((n) => n !== 'height');
  if (rest.length > 0) kinds.push({ name: 'surface', layers: rest });
  return kinds;
}

/** Deepest level any layer of the kind has a tile at. */
export function kindMaxLevel(manifest: TileManifest, kind: PackKind): number {
  let max = -1;
  for (const name of kind.layers) {
    const lm = manifest.layers[name];
    if (!lm) continue;
    max = Math.max(max, lm.globalMaxLevel);
    for (const l of Object.keys(lm.coverage)) if ((lm.coverage[l] ?? []).length > 0) max = Math.max(max, Number(l));
  }
  return max;
}

/** The set of groups of (kind, level, face): dense (every tile), or the sorted Morton codes of the covered tiles. */
export type GroupSet = { dense: true; count: number } | { dense: false; codes: Uint32Array };

export function groupSet(manifest: TileManifest, kind: PackKind, level: number, face: number): GroupSet {
  if (level > MAX_PACK_LEVEL) throw new Error(`pack format: level ${level} is deeper than ${MAX_PACK_LEVEL}`);
  let dense = false;
  const rects: TileRect[] = [];
  for (const name of kind.layers) {
    const lm = manifest.layers[name];
    if (!lm) continue;
    if (level <= lm.globalMaxLevel) dense = true;
    for (const r of lm.coverage[String(level)] ?? []) if (r.face === face) rects.push(r);
  }
  const side = 2 ** level;
  if (dense) return { dense: true, count: side * side };
  const codes = new Set<number>();
  for (const r of rects) {
    for (let y = Math.max(0, r.y0); y <= Math.min(side - 1, r.y1); y++) {
      for (let x = Math.max(0, r.x0); x <= Math.min(side - 1, r.x1); x++) codes.add(mortonEncode(x, y));
    }
  }
  return { dense: false, codes: Uint32Array.from([...codes].sort((a, b) => a - b)) };
}

export const groupSetSize = (s: GroupSet): number => (s.dense ? s.count : s.codes.length);

/** Morton code of the group with this ordinal. */
export const groupCodeAt = (s: GroupSet, ordinal: number): number => (s.dense ? ordinal : s.codes[ordinal]!);

/** Ordinal of the tile in its group set, or -1 when the kind has no group there. */
export function groupOrdinal(s: GroupSet, key: TileKey): number {
  const side = 2 ** key.level;
  if (key.x < 0 || key.y < 0 || key.x >= side || key.y >= side) return -1;
  const code = mortonEncode(key.x, key.y);
  if (s.dense) return code;
  let lo = 0;
  let hi = s.codes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = s.codes[mid]!;
    if (c === code) return mid;
    if (c < code) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Which section of the header holds ordinal `ordinal` of (kind, level, face); -1 if none. */
export function findSection(header: TilePackIndex, k: number, level: number, face: number, ordinal: number): number {
  for (let i = 0; i < header.sections.length; i++) {
    const s = header.sections[i]!;
    if (s.k === k && s.l === level && s.f === face && ordinal >= s.first && ordinal < s.first + s.count) return i;
  }
  return -1;
}

// ------------------------------------------------------------------------------------- the index object

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Bytes of a `.idx` object: magic, header length, header JSON, then the section bytes (offsets are absolute). */
export function encodeIndexObject(header: TilePackIndex, sectionBytes: Uint8Array[]): Uint8Array {
  // Section offsets depend on the header length, which depends on the offsets: iterate to a fixed point.
  let headerLen = 0;
  let json = '';
  for (let pass = 0; pass < 8; pass++) {
    let at = 8 + headerLen;
    for (let i = 0; i < header.sections.length; i++) {
      header.sections[i]!.offset = at;
      at += sectionBytes[i]!.length;
    }
    json = JSON.stringify(header);
    const len = textEncoder.encode(json).length;
    if (len === headerLen) break;
    headerLen = len;
  }
  const head = textEncoder.encode(json);
  if (head.length !== headerLen) throw new Error('pack index: the header length did not settle');
  let total = 8 + head.length;
  for (const s of sectionBytes) total += s.length;
  const out = new Uint8Array(total);
  out.set(textEncoder.encode(PACK_INDEX_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, head.length, true);
  out.set(head, 8);
  let at = 8 + head.length;
  for (const s of sectionBytes) {
    out.set(s, at);
    at += s.length;
  }
  return out;
}

/** Header length of an index object from its first 8 bytes (throws on a wrong magic). */
export function indexHeaderLength(first8: Uint8Array): number {
  if (first8.length < 8 || textDecoder.decode(first8.subarray(0, 4)) !== PACK_INDEX_MAGIC) throw new Error('pack index: bad magic');
  return new DataView(first8.buffer, first8.byteOffset, 8).getUint32(4, true);
}

/** Parse the header JSON (bytes 8 .. 8 + headerLength of the object). */
export function decodeIndexHeader(json: Uint8Array): TilePackIndex {
  const h = JSON.parse(textDecoder.decode(json)) as TilePackIndex;
  if (h.v !== PACK_FORMAT_VERSION) throw new Error(`pack index: version ${String(h.v)} is not ${PACK_FORMAT_VERSION}`);
  if (!Array.isArray(h.packs) || !Array.isArray(h.kinds) || !Array.isArray(h.sections) || typeof h.files !== 'object') throw new Error('pack index: malformed header');
  return h;
}

// ----------------------------------------------------------------------------------------------- boot pack

/** One entry of a boot pack: a tile (set, layer, key) or a file (set, path, optionally a byte range of it). */
export type BootEntry =
  | { set: string; layer: string; face: number; level: number; x: number; y: number; o: number; n: number }
  | { set: string; path: string; from?: number; o: number; n: number };

export interface BootPackHeader {
  v: typeof PACK_FORMAT_VERSION;
  entries: BootEntry[];
}

/** Bytes of a boot pack: magic, u32 header length, header JSON, data (entry offsets are relative to the data start). */
export function encodeBootPack(entries: { entry: BootEntry; bytes: Uint8Array }[]): Uint8Array {
  let o = 0;
  const list: BootEntry[] = [];
  for (const { entry, bytes } of entries) {
    list.push({ ...entry, o, n: bytes.length });
    o += bytes.length;
  }
  const head = textEncoder.encode(JSON.stringify({ v: PACK_FORMAT_VERSION, entries: list } satisfies BootPackHeader));
  const out = new Uint8Array(8 + head.length + o);
  out.set(textEncoder.encode(BOOT_PACK_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, head.length, true);
  out.set(head, 8);
  let at = 8 + head.length;
  for (const { bytes } of entries) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

export function decodeBootPack(bytes: Uint8Array): { header: BootPackHeader; data: Uint8Array } {
  if (bytes.length < 8 || textDecoder.decode(bytes.subarray(0, 4)) !== BOOT_PACK_MAGIC) throw new Error('boot pack: bad magic');
  const len = new DataView(bytes.buffer, bytes.byteOffset, 8).getUint32(4, true);
  const header = JSON.parse(textDecoder.decode(bytes.subarray(8, 8 + len))) as BootPackHeader;
  if (header.v !== PACK_FORMAT_VERSION || !Array.isArray(header.entries)) throw new Error('boot pack: malformed header');
  return { header, data: bytes.subarray(8 + len) };
}

/** Key of a tile entry of a boot pack (also used by the pack source to look tiles up). */
export const bootTileKey = (set: string, layer: string, k: TileKey): string => `${set}/${layer}/${k.face}/${k.level}/${k.x}/${k.y}`;

// -------------------------------------------------------------------------------------------- pack list

/**
 * The pack list (ARCHITECTURE 10.4): what a client reads from `TileSourceSpec.packListUrl`. Signed once per
 * UTC day by the role that holds the packs credential; never compiled into the client.
 *   mirrors   ordered candidates. `objects` maps a content hash to its own (presigned) URL; otherwise the URL
 *             is `base + hash` (mode `ranges`) or `base + hash + '/' + n` (mode `slices`, slice n of
 *             `sliceBytes`). Relative URLs resolve against the pack list's own URL.
 *   sets      per set the index object (hash and bytes).
 */
export interface PackListMirror {
  id: string;
  mode: 'ranges' | 'slices';
  sliceBytes?: number;
  base?: string;
  objects?: Record<string, string>;
}

export interface PackList {
  v: typeof PACK_FORMAT_VERSION;
  /** UTC day the bucket URLs were signed for (YYYY-MM-DD). */
  signedDay: string | null;
  /** Seconds after which a client fetches the list again (it also does on a 403). */
  refreshAfterS: number;
  mirrors: PackListMirror[];
  sets: Record<string, { index: string; indexBytes: number }>;
}

export function validatePackList(x: unknown): PackList {
  const p = x as Partial<PackList>;
  if (typeof p !== 'object' || p === null || p.v !== PACK_FORMAT_VERSION) throw new Error('pack list: not a version-1 pack list');
  if (!Array.isArray(p.mirrors) || p.mirrors.length === 0) throw new Error('pack list: no mirrors');
  for (const m of p.mirrors) {
    if (m.mode !== 'ranges' && m.mode !== 'slices') throw new Error(`pack list: mirror ${m.id}: mode must be ranges or slices`);
    if (m.mode === 'slices' && !(typeof m.sliceBytes === 'number' && m.sliceBytes > 0)) throw new Error(`pack list: mirror ${m.id}: slices need sliceBytes`);
    if (!m.objects && typeof m.base !== 'string') throw new Error(`pack list: mirror ${m.id}: needs objects or base`);
    if (m.objects && m.mode === 'slices') throw new Error(`pack list: mirror ${m.id}: per-object URLs are ranges only`);
  }
  if (typeof p.sets !== 'object' || p.sets === null) throw new Error('pack list: sets missing');
  return p as PackList;
}

/** Is this a content hash as the pack format writes it? */
export const isContentHash = (s: string): boolean => s.length === HASH_HEX && /^[0-9a-f]+$/.test(s);
