/**
 * The terrain guard (lead-owned; MIGRATION_V2 section 8, ARCHITECTURE 10): what must not change while bakes
 * add bodies and regions and the terrain code is generalised.
 *
 *  1. HEIGHTS. The real TerrainProvider on the real baked tiles, asked at 2,000 fixed body-fixed directions
 *     per terrain body, three ways: the collision surface, and the band-limited surface at two band limits.
 *     Compared BIT FOR BIT (the float64 bit patterns are stored).
 *  2. TILES. A summary of every tile directory (tile set / layer / face / level): file count, a hash of the
 *     sorted file names and, in the full form, total bytes and a hash of every file's content.
 *
 * Files (all `terrain-guard.*`, owned by the lead; nobody else rewrites them):
 *   terrain-guard.ts            this module: the fixed directions, the sampling, the directory summary
 *   terrain-guard.test.ts       the comparison (part of the unit suite; skips a body whose tiles are not baked)
 *   terrain-guard.record.ts     the recorder (the lead's act): npx tsx tests/unit/terrain-core/terrain-guard.record.ts
 *   terrain-guard.heights.json  the recorded heights
 *   terrain-guard.tiles.json    the recorded directory summaries
 *
 * Commands:
 *   node tools/dev/heavy.mjs --class=cpu -- npx vitest run tests/unit/terrain-core/terrain-guard.test.ts
 *       heights bit for bit; every directory's file count and name hash
 *   TERRAIN_GUARD_FULL=1 node tools/dev/heavy.mjs --class=bake -- npx vitest run tests/unit/terrain-core/terrain-guard.test.ts
 *       additionally every directory's bytes and content hash (reads every tile: minutes). A bake package
 *       runs this form before its hand-off: "existing tiles byte-identical".
 *
 * A bake that ADDS tiles makes the summary of the directories it adds to differ; that is the point: the
 * package states which directories it changed, and the lead re-records after checking that nothing else did.
 * Likewise new pads add flatten discs: heights inside a new disc change, and the lead re-records then.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import { fsDefSource } from '../../../src/core/defs/fsSource';
import { loadDefs } from '../../../src/core/defs/loader';
import { Prng } from '../../../src/core/math/hash';
import { DEG } from '../../../src/core/math/scalar';
import type { Vec3 } from '../../../src/core/math/vec3';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider } from '../../../src/terrain/provider';

export const GUARD_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(GUARD_DIR, '..', '..', '..');
export const TILES_ROOT = path.join(REPO_ROOT, 'data', 'tiles');
export const HEIGHTS_FILE = path.join(GUARD_DIR, 'terrain-guard.heights.json');
export const TILES_FILE = path.join(GUARD_DIR, 'terrain-guard.tiles.json');

/** Directions per body, and how they are spread. */
export const POINTS_PER_BODY = 2000;
/** Share of the points that are uniform on the sphere; the rest cluster about the body's named places. */
const UNIFORM_SHARE = 0.6;
/** Cluster radii about a named place (a launch site, a scenario's landing target), m. */
const CLUSTER_RADII = [200_000, 20_000, 2_000, 200];
/** Band limits of the two band-limited queries, m. */
export const BAND_LIMITS = [25, 1000] as const;
/** Radius loaded about each point before it is asked, m. */
const LOAD_RADIUS = 40;
const SEED = 20261111;

export interface GuardBodyHeights {
  /** Content hash of the tile set's manifest when the heights were recorded (information; the heights are the guard). */
  tilesetContentHash: string;
  points: number;
  /** Hex of the float64 bit patterns (16 characters per point, big-endian), in point order. */
  collision: string;
  band: Record<string, string>;
}

export interface GuardHeights {
  seed: number;
  pointsPerBody: number;
  bandLimits: number[];
  node: string;
  bodies: Record<string, GuardBodyHeights>;
}

export interface DirSummary {
  files: number;
  /** sha256 (16 hex) of the sorted file names. */
  names: string;
  /** Full form only: total bytes and sha256 (16 hex) of every file's bytes in name order. */
  bytes?: number;
  content?: string;
}

export interface GuardTiles {
  /** Tile set -> directory (relative to the tile set, forward slashes; '.' = its root files) -> summary. */
  tilesets: Record<string, Record<string, DirSummary>>;
}

export function loadRealDefs(): Promise<DefLibrary> {
  return loadDefs(fsDefSource(path.join(REPO_ROOT, 'data', 'defs')));
}

/** Terrain bodies of the library whose tile set is baked, sorted by id. */
export function bakedTerrainBodies(defs: DefLibrary): { bodyId: string; tileset: string }[] {
  return Object.values(defs.bodies)
    .filter((b) => b.terrain !== null && fs.existsSync(path.join(TILES_ROOT, b.terrain.tileset, 'manifest.json')))
    .map((b) => ({ bodyId: b.id, tileset: b.terrain!.tileset }))
    .sort((a, b) => (a.bodyId < b.bodyId ? -1 : 1));
}

const dirOf = (latDeg: number, lonDeg: number): Vec3 => {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) };
};

/** Unit direction at tangent offset (east, north) metres from `dir` on a sphere of radius R. */
function offset(dir: Vec3, east: number, north: number, R: number): Vec3 {
  let ex = { x: -dir.y, y: dir.x, z: 0 };
  const l = Math.hypot(ex.x, ex.y);
  ex = l < 1e-9 ? { x: 1, y: 0, z: 0 } : { x: ex.x / l, y: ex.y / l, z: 0 };
  const ny = { x: dir.y * ex.z - dir.z * ex.y, y: dir.z * ex.x - dir.x * ex.z, z: dir.x * ex.y - dir.y * ex.x };
  const x = dir.x + (ex.x * east + ny.x * north) / R;
  const y = dir.y + (ex.y * east + ny.y * north) / R;
  const z = dir.z + (ex.z * east + ny.z * north) / R;
  const m = Math.hypot(x, y, z);
  return { x: x / m, y: y / m, z: z / m };
}

/**
 * The named places of a body, from data only: every launch site on it (its reference point) and every
 * scenario's landing target on it, in a fixed order. The guard keeps the places it was recorded with (it
 * stores nothing but the heights), so adding a site or a scenario changes the directions: re-record then.
 */
function namedPlaces(defs: DefLibrary, bodyId: string): Vec3[] {
  const places: { key: string; dir: Vec3 }[] = [];
  for (const s of Object.values(defs.sites)) if (s.bodyId === bodyId) places.push({ key: `site:${s.id}`, dir: dirOf(s.location.latDeg, s.location.lonDeg) });
  for (const sc of Object.values(defs.scenarios)) {
    const t = sc.suggestedLanding;
    if (t && t.bodyId === bodyId) places.push({ key: `landing:${t.latDeg.toFixed(6)},${t.lonDeg.toFixed(6)}`, dir: dirOf(t.latDeg, t.lonDeg) });
  }
  const unique = new Map(places.map((p) => [p.key, p.dir]));
  return [...unique.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e[1]);
}

/** The fixed directions of a body: a pure function of the seed, the body's index and its named places. */
export function guardDirections(defs: DefLibrary, bodyId: string): Vec3[] {
  const body = defs.bodies[bodyId]!;
  const index = Object.keys(defs.bodies).sort().indexOf(bodyId);
  const rng = new Prng(SEED + index * 7919);
  const u = (): number => rng.nextU32() / 4294967296;
  const places = namedPlaces(defs, bodyId);
  const uniform = places.length === 0 ? POINTS_PER_BODY : Math.round(POINTS_PER_BODY * UNIFORM_SHARE);
  const out: Vec3[] = [];
  for (let i = 0; i < uniform; i++) {
    const z = 2 * u() - 1;
    const lon = 2 * Math.PI * u();
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.push({ x: r * Math.cos(lon), y: r * Math.sin(lon), z });
  }
  for (let i = uniform; i < POINTS_PER_BODY; i++) {
    const k = i - uniform;
    const place = places[k % places.length]!;
    const radius = CLUSTER_RADII[Math.floor(k / places.length) % CLUSTER_RADII.length]!;
    // Uniform over the disc of that radius about the place.
    const rho = radius * Math.sqrt(u());
    const az = 2 * Math.PI * u();
    out.push(offset(place, rho * Math.sin(az), rho * Math.cos(az), body.radius));
  }
  return out;
}

const f64 = new Float64Array(1);
const u8 = new Uint8Array(f64.buffer);
/** The float64 bit pattern as 16 hex characters (big-endian: sign and exponent first). */
export function bitsHex(x: number): string {
  f64[0] = x;
  let s = '';
  for (let i = 7; i >= 0; i--) s += u8[i]!.toString(16).padStart(2, '0');
  return s;
}
export function hexToNumber(hex: string): number {
  for (let i = 0; i < 8; i++) u8[7 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return f64[0]!;
}

/** Sample the three height queries at the fixed directions of every baked terrain body. */
export async function sampleHeights(defs: DefLibrary, onBody?: (bodyId: string, seconds: number) => void): Promise<GuardHeights> {
  const terrain = await createTerrainProvider(defs, createFsTileSource(TILES_ROOT));
  const bodies: Record<string, GuardBodyHeights> = {};
  for (const { bodyId, tileset } of bakedTerrainBodies(defs)) {
    const t0 = Date.now();
    const dirs = guardDirections(defs, bodyId);
    let collision = '';
    const band: Record<string, string> = Object.fromEntries(BAND_LIMITS.map((l) => [String(l), '']));
    for (const dir of dirs) {
      await terrain.ensureLoaded(bodyId, dir, LOAD_RADIUS, 'terrain-guard');
      collision += bitsHex(terrain.heightAt(bodyId, dir));
      for (const l of BAND_LIMITS) band[String(l)] += bitsHex(terrain.heightAt(bodyId, dir, l));
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(TILES_ROOT, tileset, 'manifest.json'), 'utf8')) as { contentHash?: string };
    bodies[bodyId] = { tilesetContentHash: manifest.contentHash ?? 'unknown', points: dirs.length, collision, band };
    onBody?.(bodyId, (Date.now() - t0) / 1000);
  }
  return { seed: SEED, pointsPerBody: POINTS_PER_BODY, bandLimits: [...BAND_LIMITS], node: process.version, bodies };
}

/** The first differences between two hex strings of heights: point index, recorded and current value. */
export function heightDifferences(recorded: string, current: string, max = 8): { index: number; recorded: number; current: number }[] {
  const out: { index: number; recorded: number; current: number }[] = [];
  const n = Math.max(recorded.length, current.length) / 16;
  for (let i = 0; i < n && out.length < max; i++) {
    const a = recorded.slice(i * 16, i * 16 + 16);
    const b = current.slice(i * 16, i * 16 + 16);
    if (a !== b) out.push({ index: i, recorded: a.length === 16 ? hexToNumber(a) : Number.NaN, current: b.length === 16 ? hexToNumber(b) : Number.NaN });
  }
  return out;
}

const short = (h: ReturnType<typeof createHash>): string => h.digest('hex').slice(0, 16);

/**
 * Summaries of every directory of a tile set that holds files. `full` also reads every file (bytes and a
 * content hash). Directory names are relative to the tile set root, forward slashes; '.' is the root.
 */
export function summariseTileset(tileset: string, full: boolean): Record<string, DirSummary> {
  const root = path.join(TILES_ROOT, tileset);
  const out: Record<string, DirSummary> = {};
  const stack = ['.'];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = path.join(root, rel);
    const names: string[] = [];
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) stack.push(rel === '.' ? e.name : `${rel}/${e.name}`);
      else if (e.isFile()) names.push(e.name);
    }
    if (names.length === 0) continue;
    names.sort();
    const summary: DirSummary = { files: names.length, names: short(createHash('sha256').update(names.join('\n'))) };
    if (full) {
      const h = createHash('sha256');
      let bytes = 0;
      for (const name of names) {
        const buf = fs.readFileSync(path.join(abs, name));
        bytes += buf.length;
        h.update(name);
        h.update('\0');
        h.update(buf);
      }
      summary.bytes = bytes;
      summary.content = short(h);
    }
    out[rel] = summary;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/** Directories that differ between a recorded and a current summary (added, removed or changed), at most `max`. */
export function tileDifferences(recorded: Record<string, DirSummary>, current: Record<string, DirSummary>, full: boolean, max = 12): string[] {
  const out: string[] = [];
  const keys = [...new Set([...Object.keys(recorded), ...Object.keys(current)])].sort();
  for (const k of keys) {
    const a = recorded[k];
    const b = current[k];
    if (!a) out.push(`${k}: new directory (${b!.files} files)`);
    else if (!b) out.push(`${k}: directory is gone (had ${a.files} files)`);
    else if (a.files !== b.files || a.names !== b.names) out.push(`${k}: ${a.files} files recorded, ${b.files} now (names ${a.names} -> ${b.names})`);
    else if (full && (a.bytes !== b.bytes || a.content !== b.content)) out.push(`${k}: content changed (${a.bytes} bytes ${a.content} -> ${b.bytes} bytes ${b.content})`);
    if (out.length >= max) break;
  }
  return out;
}
