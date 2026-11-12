/**
 * The terrain guard (lead-owned; MIGRATION_V2 section 8, ARCHITECTURE 10): what must not change while bakes
 * add bodies and regions and the terrain code is generalised.
 *
 *  1. HEIGHTS. The real TerrainProvider on the real baked tiles, asked at fixed body-fixed directions per
 *     terrain body (2,000 today), three ways: the collision surface, and the band-limited surface at two
 *     band limits. Compared BIT FOR BIT (the float64 bit patterns are stored).
 *  2. TILES. A summary of every tile directory (tile set / layer / face / level): file count, a hash of the
 *     sorted file names, total bytes (by stat) and, in the full form, a hash of every file's content.
 *
 * THE DIRECTIONS ARE STORED, NOT REGENERATED. terrain-guard.heights.json holds, per body, the directions
 * themselves (bit patterns) in GROUPS: one `uniform` group over the sphere and one group per named place (a
 * launch site, a landing target) in discs about it. The test samples the stored directions, so nothing that
 * happens to the definition library afterwards (thirty more bodies, a second site, a renamed site, a new
 * scenario) moves a single point. A group's points are a pure function of the body id, the group key and
 * the place (seeded from a hash of `<bodyId>:<key>`), so a new place is APPENDED as a new group and every
 * existing point keeps its index, its direction and its recorded height. A later step that adds flatten
 * discs can therefore assert that the only heights that changed are those of points inside the new discs
 * (`heightDifferences` returns each changed point with its group, latitude and longitude).
 *
 * Files (all `terrain-guard.*`, owned by the lead; nobody else rewrites them):
 *   terrain-guard.ts            this module: groups, sampling, the directory summary, the comparisons
 *   terrain-guard.test.ts       the comparison (part of the unit suite; skips a body whose tiles are not baked)
 *   terrain-guard.record.ts     the recorder (the lead's act)
 *   terrain-guard.heights.json  the recorded directions and heights
 *   terrain-guard.tiles.json    the recorded directory summaries
 *
 * Commands:
 *   node tools/dev/heavy.mjs --class=cpu -- npx vitest run tests/unit/terrain-core/terrain-guard.test.ts
 *       heights bit for bit; every directory's file count, name hash and bytes
 *   TERRAIN_GUARD_FULL=1 node tools/dev/heavy.mjs --class=bake -- npx vitest run tests/unit/terrain-core/terrain-guard.test.ts
 *       additionally every directory's content hash (reads every tile). A bake package runs this form
 *       before its hand-off: "existing tiles byte-identical".
 *
 * A bake that ADDS tiles makes the summary of the directories it adds to differ; that is the point: the
 * package states which directories it changed, and the lead re-records after checking that nothing else did.
 * The check and the re-recording are one act: `terrain-guard.record.ts --tiles-additions --changed
 * <tileset>/.` reads every file, refuses to write if a recorded directory is gone or differs in files,
 * names, bytes or content (`auditTiles`), and lists what was added. A bake that REPLACES the tiles of a
 * region in place is re-recorded by `--tiles-replaced --footprint <file>`: nothing added or removed, and
 * nothing outside the footprint differs; the footprint is taken from this guard's own history (the
 * directories the region's first bake added), never from the package. Its heights are re-recorded for that
 * region's place group alone (`--resample-group`), which refuses while any other point differs.
 *
 * History of the recordings. 2026-11-11: Earth and Moon, 2,000 points each. 2026-11-12, 05:25: the
 * Madrakah region was added to the Earth set (840 directories on face 2, levels 8-12; request site-bake-1):
 * the summary re-recorded by --tiles-additions, and the place group `site:madrakah` appended to Earth
 * (2,800 points). 2026-11-12, 10:40: the region was re-baked on GLO-30 and replaced in place (506 of its
 * 840 directories and the manifest differ, nothing else): the summary re-recorded by --tiles-replaced and
 * the heights of `site:madrakah` alone by --resample-group (497 of its 800 points on the collision query).
 * That group is centred on the reference pad of the FIRST pad layout (18.996 N 57.794 E); the pads have
 * since moved 9-41 km north along the coast. 2026-11-12, 11:30: site-bake closed with 16 pads at Madrakah
 * and 9 at Ka Lae; one PAD-FIELD group per site appended, `pads:madrakah` and `pads:ka-lae`
 * (`--add-pads`): PAD_POINTS points about every pad, inside its future flatten disc, either side of both
 * rims and beyond (`PAD_LAYOUT`), with the pads and radii stored in the group. STILL TO COME: the flatten
 * discs of the new pads exist only once fleet-data writes the site files; the heights are then re-recorded
 * (`--resample`) by the lead under the rule "only points inside new flatten discs may change"
 * (`padZoneOf` says on which side a changed point lies; LC-1's disc exists already and does not move).
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

/** Points of the uniform group and of each place group. */
export const UNIFORM_POINTS = 1200;
export const PLACE_POINTS = 800;
/** Radii of the discs about a named place, m: a quarter of a place group's points in each. */
export const CLUSTER_RADII = [200_000, 20_000, 2_000, 200] as const;
/**
 * The points about ONE pad of a pad-field group, ring by ring, with radii as `f x F + b x B` of the pad's
 * flat radius F and blend radius B (a flatten disc is flat inside F and blended back to the natural terrain
 * by B). A ring whose two radii are equal is a circle; the others are filled uniformly by area. The rims
 * are sampled 2 % inside and 2 % outside, never ON a radius, where rounding would decide the side.
 *   centre       the pad's centre itself
 *   flat         the flat disc
 *   flatRimIn    just inside the flat rim            flatRimOut   just outside it (the blend begins)
 *   blend        the blend ring
 *   outerRimIn   just inside the outer rim           outerRimOut  just outside it: must NOT change
 *   beyond, far  the ground outside the disc, out to twice and four times the blend radius: must NOT change
 */
export const PAD_LAYOUT = [
  { ring: 'centre', count: 1, inner: [0, 0], outer: [0, 0] },
  { ring: 'flat', count: 11, inner: [0, 0], outer: [0.95, 0] },
  { ring: 'flatRimIn', count: 4, inner: [0.98, 0], outer: [0.98, 0] },
  { ring: 'flatRimOut', count: 4, inner: [1.02, 0], outer: [1.02, 0] },
  { ring: 'blend', count: 12, inner: [1.05, 0], outer: [0, 0.95] },
  { ring: 'outerRimIn', count: 4, inner: [0, 0.98], outer: [0, 0.98] },
  { ring: 'outerRimOut', count: 4, inner: [0, 1.02], outer: [0, 1.02] },
  { ring: 'beyond', count: 12, inner: [0, 1.05], outer: [0, 2] },
  { ring: 'far', count: 4, inner: [0, 2], outer: [0, 4] },
] as const;
/** Points per pad of a pad-field group. */
export const PAD_POINTS = PAD_LAYOUT.reduce((n, r) => n + r.count, 0);
/** Band limits of the two band-limited queries, m. */
export const BAND_LIMITS = [25, 1000] as const;
/** Radius loaded about each point before it is asked, m. */
const LOAD_RADIUS = 40;

/** One pad of a pad-field group: its centre and the radii of its flatten disc as the layout was resolved, m. */
export interface GuardPad {
  id: string;
  latDeg: number;
  lonDeg: number;
  flatRadius: number;
  blendRadius: number;
}

export interface GuardGroup {
  /**
   * 'uniform'; a place: 'site:<id>' / 'landing:<lat>,<lon>' as the place was called when it was recorded; or
   * a pad field: 'pads:<site id>'.
   */
  key: string;
  /** Number of points; they are the next `count` points of the body, in group order. */
  count: number;
  /** A place group's centre, degrees (information; the directions are what is compared). */
  latDeg?: number;
  lonDeg?: number;
  /**
   * Content hash of the tile set's manifest when this group was APPENDED (information). Absent = the group
   * is of the body's first recording (`GuardBodyHeights.tilesetContentHash`).
   */
  recordedOn?: string;
  /**
   * A pad-field group: the pads it is laid over, in order, PAD_POINTS points each (`PAD_LAYOUT`). The pads
   * and their radii are those the layout was RESOLVED for; the discs that a site file later states are held
   * against these points, not the other way round.
   */
  pads?: GuardPad[];
}

export interface GuardBodyHeights {
  /** Content hash of the tile set's manifest when the heights were recorded (information; the heights are the guard). */
  tilesetContentHash: string;
  /** Reference radius the place discs were laid out on, m. */
  radius: number;
  groups: GuardGroup[];
  /** Hex of the float64 bit patterns, big-endian, in point order: 48 characters per direction (x, y, z), 16 per height. */
  directions: string;
  collision: string;
  band: Record<string, string>;
}

export interface GuardHeights {
  format: 2;
  bandLimits: number[];
  node: string;
  bodies: Record<string, GuardBodyHeights>;
}

export interface DirSummary {
  files: number;
  /** sha256 (16 hex) of the sorted file names. */
  names: string;
  /** Total bytes of the files (by stat in the every-commit form, by reading in the full form: the same number). */
  bytes: number;
  /** Full form only: sha256 (16 hex) of every file's name and bytes in name order. */
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

export const dirOf = (latDeg: number, lonDeg: number): Vec3 => {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) };
};

export const latLonOf = (d: Vec3): { latDeg: number; lonDeg: number } => ({ latDeg: Math.asin(Math.max(-1, Math.min(1, d.z))) / DEG, lonDeg: Math.atan2(d.y, d.x) / DEG });

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

/** FNV-1a over the UTF-16 code units: the seed of a group is a function of its names only. */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The directions of one group: a pure function of the body id, the group key and, for a place, its centre
 * and the body's radius. Used only when a group is CREATED; afterwards the stored directions are the truth.
 */
export function groupDirections(bodyId: string, group: GuardGroup, radius: number): Vec3[] {
  if (group.pads) return group.pads.flatMap((pad) => padDirections(bodyId, group.key, pad, radius));
  const rng = new Prng(seedOf(`${bodyId}:${group.key}`));
  const u = (): number => rng.nextU32() / 4294967296;
  const out: Vec3[] = [];
  if (group.latDeg === undefined || group.lonDeg === undefined) {
    for (let i = 0; i < group.count; i++) {
      const z = 2 * u() - 1;
      const lon = 2 * Math.PI * u();
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      out.push({ x: r * Math.cos(lon), y: r * Math.sin(lon), z });
    }
    return out;
  }
  const centre = dirOf(group.latDeg, group.lonDeg);
  for (let i = 0; i < group.count; i++) {
    const disc = CLUSTER_RADII[Math.floor((i * CLUSTER_RADII.length) / group.count)]!;
    // Uniform over the disc of that radius about the place.
    const rho = disc * Math.sqrt(u());
    const az = 2 * Math.PI * u();
    out.push(offset(centre, rho * Math.sin(az), rho * Math.cos(az), radius));
  }
  return out;
}

/**
 * The PAD_POINTS directions about one pad of a pad-field group: a pure function of the body id, the group
 * key and the pad (its id, centre and two radii), seeded from `<bodyId>:<key>:<pad id>`, so a pad's points
 * do not depend on the other pads of the field. Azimuths are spread over the ring (one point per equal
 * sector, placed at random inside it), so every side of a rim is sampled.
 */
export function padDirections(bodyId: string, key: string, pad: GuardPad, radius: number): Vec3[] {
  if (!(pad.flatRadius > 0 && pad.blendRadius > pad.flatRadius)) throw new Error(`pad ${pad.id}: needs 0 < flatRadius < blendRadius`);
  const rng = new Prng(seedOf(`${bodyId}:${key}:${pad.id}`));
  const u = (): number => rng.nextU32() / 4294967296;
  const centre = dirOf(pad.latDeg, pad.lonDeg);
  const out: Vec3[] = [];
  for (const ring of PAD_LAYOUT) {
    const r0 = ring.inner[0] * pad.flatRadius + ring.inner[1] * pad.blendRadius;
    const r1 = ring.outer[0] * pad.flatRadius + ring.outer[1] * pad.blendRadius;
    for (let i = 0; i < ring.count; i++) {
      if (r1 === 0) {
        out.push(centre);
        continue;
      }
      const rho = Math.sqrt(r0 * r0 + u() * (r1 * r1 - r0 * r0));
      const az = (2 * Math.PI * (i + u())) / ring.count;
      out.push(offset(centre, rho * Math.sin(az), rho * Math.cos(az), radius));
    }
  }
  return out;
}

/** Where a point lies with respect to a flatten disc: flat (inside F), blend (between F and B) or outside (beyond B). */
export type PadZone = 'flat' | 'blend' | 'outside';

/**
 * A point against the flatten discs of a list of pads: the pad whose disc holds it and the zone there (the
 * innermost zone wins where two discs overlap), else the nearest pad and 'outside'. Distances are great
 * circles on the sphere of `radius`. This is what "only points inside new flatten discs may change" is
 * decided with.
 */
export function padZoneOf(pads: readonly GuardPad[], point: { latDeg: number; lonDeg: number }, radius: number): { pad: string; zone: PadZone; distance: number } | null {
  let best: { pad: string; zone: PadZone; distance: number } | null = null;
  const rank = { flat: 0, blend: 1, outside: 2 } as const;
  for (const pad of pads) {
    const distance = distanceTo(point, pad.latDeg, pad.lonDeg, radius);
    const zone: PadZone = distance <= pad.flatRadius ? 'flat' : distance <= pad.blendRadius ? 'blend' : 'outside';
    if (!best || rank[zone] < rank[best.zone] || (rank[zone] === rank[best.zone] && distance < best.distance)) best = { pad: pad.id, zone, distance };
  }
  return best;
}

/** The named places of a body as the library has them now (for creating groups; the guard never re-derives them). */
export function namedPlaces(defs: DefLibrary, bodyId: string): GuardGroup[] {
  const places = new Map<string, GuardGroup>();
  for (const s of Object.values(defs.sites)) {
    if (s.bodyId === bodyId) places.set(`site:${s.id}`, { key: `site:${s.id}`, count: PLACE_POINTS, latDeg: s.location.latDeg, lonDeg: s.location.lonDeg });
  }
  for (const sc of Object.values(defs.scenarios)) {
    const t = sc.suggestedLanding;
    if (!t || t.bodyId !== bodyId) continue;
    const key = `landing:${t.latDeg.toFixed(6)},${t.lonDeg.toFixed(6)}`;
    places.set(key, { key, count: PLACE_POINTS, latDeg: t.latDeg, lonDeg: t.lonDeg });
  }
  return [...places.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
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

export const directionsHex = (dirs: Vec3[]): string => dirs.map((d) => bitsHex(d.x) + bitsHex(d.y) + bitsHex(d.z)).join('');
export function directionsOf(hex: string): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i + 48 <= hex.length; i += 48) out.push({ x: hexToNumber(hex.slice(i, i + 16)), y: hexToNumber(hex.slice(i + 16, i + 32)), z: hexToNumber(hex.slice(i + 32, i + 48)) });
  return out;
}

export interface SampledHeights {
  collision: string;
  band: Record<string, string>;
}

type Terrain = Awaited<ReturnType<typeof createTerrainProvider>>;
export const openTerrain = (defs: DefLibrary): Promise<Terrain> => createTerrainProvider(defs, createFsTileSource(TILES_ROOT));

/** The three height queries at the given directions of one body. */
export async function sampleHeights(terrain: Terrain, bodyId: string, dirs: Vec3[]): Promise<SampledHeights> {
  let collision = '';
  const band: Record<string, string> = Object.fromEntries(BAND_LIMITS.map((l) => [String(l), '']));
  for (const dir of dirs) {
    await terrain.ensureLoaded(bodyId, dir, LOAD_RADIUS, 'terrain-guard');
    collision += bitsHex(terrain.heightAt(bodyId, dir));
    for (const l of BAND_LIMITS) band[String(l)] += bitsHex(terrain.heightAt(bodyId, dir, l));
  }
  return { collision, band };
}

/** The group a point index belongs to. */
export function groupOf(groups: GuardGroup[], index: number): GuardGroup | null {
  let start = 0;
  for (const g of groups) {
    if (index < start + g.count) return g;
    start += g.count;
  }
  return null;
}

export interface ChangedPoint {
  index: number;
  group: string;
  latDeg: number;
  lonDeg: number;
  recorded: number;
  current: number;
}

/** Every point whose height differs between two hex strings (at most `max`), with where it is. */
export function heightDifferences(body: GuardBodyHeights, recorded: string, current: string, max = Infinity): ChangedPoint[] {
  const out: ChangedPoint[] = [];
  const dirs = directionsOf(body.directions);
  const n = Math.max(recorded.length, current.length) / 16;
  for (let i = 0; i < n && out.length < max; i++) {
    const a = recorded.slice(i * 16, i * 16 + 16);
    const b = current.slice(i * 16, i * 16 + 16);
    if (a === b) continue;
    const where = dirs[i] ? latLonOf(dirs[i]!) : { latDeg: Number.NaN, lonDeg: Number.NaN };
    out.push({ index: i, group: groupOf(body.groups, i)?.key ?? 'none', ...where, recorded: a.length === 16 ? hexToNumber(a) : Number.NaN, current: b.length === 16 ? hexToNumber(b) : Number.NaN });
  }
  return out;
}

/** Great-circle distance on a sphere of `radius` between a point of the guard and a place, m. */
export function distanceTo(point: { latDeg: number; lonDeg: number }, latDeg: number, lonDeg: number, radius: number): number {
  const a = dirOf(point.latDeg, point.lonDeg);
  const b = dirOf(latDeg, lonDeg);
  return radius * Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));
}

const short = (h: ReturnType<typeof createHash>): string => h.digest('hex').slice(0, 16);

/**
 * Summaries of every directory of a tile set that holds files: count, names and bytes; `full` also reads
 * every file for the content hash. Directory names are relative to the tile set root, forward slashes; '.'
 * is the root.
 */
export async function summariseTileset(tileset: string, full: boolean): Promise<Record<string, DirSummary>> {
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
    const summary: DirSummary = { files: names.length, names: short(createHash('sha256').update(names.join('\n'))), bytes: 0 };
    if (full) {
      const h = createHash('sha256');
      for (const name of names) {
        const buf = fs.readFileSync(path.join(abs, name));
        summary.bytes += buf.length;
        h.update(name);
        h.update('\0');
        h.update(buf);
      }
      summary.content = short(h);
    } else {
      // Sizes by stat, a batch at a time (hundreds of thousands of files: the stats are the cost).
      for (let i = 0; i < names.length; i += 256) {
        const sizes = await Promise.all(names.slice(i, i + 256).map((name) => fs.promises.stat(path.join(abs, name)).then((st) => st.size)));
        for (const s of sizes) summary.bytes += s;
      }
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
    else if (a.bytes !== b.bytes) out.push(`${k}: ${a.bytes} bytes recorded, ${b.bytes} now`);
    else if (full && a.content !== b.content) out.push(`${k}: content changed (${a.content} -> ${b.content})`);
    if (out.length >= max) break;
  }
  return out;
}

export interface TileAudit {
  /** What the bake may not have done (see `auditTiles`). Empty = the summary may be re-recorded. */
  violations: string[];
  /** The directories the package named as changed (they must differ), with what changed in them. */
  changed: string[];
  /** Directories of the footprint that differ (a bake that REPLACES the tiles of a region), sorted. */
  replaced: string[];
  /** New directories, sorted (a violation each unless the bake is one that adds). */
  added: string[];
  /** Recorded directories that are byte-identical (files, names, bytes, content). */
  unchanged: number;
}
/** The audit of a bake that only adds (the name it had before replacing bakes existed). */
export type AdditionsAudit = TileAudit;

export interface TileAuditRule {
  /** Directories that must be there on both sides and must in fact differ (a tile set's root with its manifest). */
  expectChanged?: readonly string[];
  /** The footprint of a replacing bake: directories that MAY differ (some come out byte-identical). Each must have been recorded. */
  mayChange?: ReadonlySet<string>;
  /** True for a bake that adds directories; false for one that replaces files in place (a new directory is then a violation). */
  additions: boolean;
}

/**
 * The check the lead makes before re-recording the tile summary. The full form on both sides: every recorded
 * directory is still there with the same files, names, bytes and CONTENT, except
 *   - the directories named as changed (`expectChanged`), which must exist on both sides and must differ;
 *   - for a bake that REPLACES the tiles of a region, the directories of its footprint (`mayChange`), which
 *     may differ and must keep their file names (a replacing bake adds and removes no file).
 * A directory that is new is an addition: allowed for a bake that adds, a violation for one that replaces.
 * Nothing is truncated: every violation, every replaced and every added directory is returned.
 */
export function auditTiles(recorded: Record<string, DirSummary>, current: Record<string, DirSummary>, rule: TileAuditRule): TileAudit {
  const audit: TileAudit = { violations: [], changed: [], replaced: [], added: [], unchanged: 0 };
  const expectChanged = rule.expectChanged ?? [];
  const mayChange = rule.mayChange ?? new Set<string>();
  const describe = (a: DirSummary, b: DirSummary): string | null => {
    if (a.files !== b.files || a.names !== b.names) return `${a.files} files recorded, ${b.files} now (names ${a.names} -> ${b.names})`;
    if (a.bytes !== b.bytes) return `${a.bytes} bytes recorded, ${b.bytes} now`;
    if (a.content === undefined || b.content === undefined) return 'no content hash on one side: the audit needs the full form of both';
    if (a.content !== b.content) return `content changed (${a.content} -> ${b.content})`;
    return null;
  };
  for (const k of Object.keys(recorded).sort()) {
    const a = recorded[k]!;
    const b = current[k];
    if (!b) {
      audit.violations.push(`${k}: directory is gone (had ${a.files} files)`);
      continue;
    }
    const difference = describe(a, b);
    const blind = a.content === undefined || b.content === undefined;
    if (expectChanged.includes(k)) {
      if (difference === null) audit.violations.push(`${k}: named as changed, but it is byte-identical`);
      else if (blind) audit.violations.push(`${k}: no content hash on one side: the audit needs the full form of both`);
      else audit.changed.push(`${k}: ${difference}`);
    } else if (difference === null) audit.unchanged++;
    else if (!mayChange.has(k)) audit.violations.push(`${k}: ${difference}`);
    else if (blind) audit.violations.push(`${k}: no content hash on one side: the audit needs the full form of both`);
    else if (a.files !== b.files || a.names !== b.names) audit.violations.push(`${k}: inside the footprint, but its files changed: ${difference} (a replacing bake adds and removes no file)`);
    else audit.replaced.push(k);
  }
  for (const k of expectChanged) if (!(k in recorded)) audit.violations.push(`${k}: named as changed, but it was never recorded`);
  for (const k of [...mayChange].sort()) if (!(k in recorded)) audit.violations.push(`${k}: in the footprint, but it was never recorded`);
  audit.added = Object.keys(current)
    .filter((k) => !(k in recorded))
    .sort();
  for (const k of audit.added) {
    if (!rule.additions) audit.violations.push(`${k}: new directory (${current[k]!.files} files): a bake that replaces adds none`);
    else if (current[k]!.content === undefined) audit.violations.push(`${k}: no content hash: the audit needs the full form`);
  }
  return audit;
}

/** `auditTiles` for a bake that ADDS tiles: nothing recorded changes but the directories named. */
export function auditAdditions(recorded: Record<string, DirSummary>, current: Record<string, DirSummary>, expectChanged: readonly string[] = []): AdditionsAudit {
  return auditTiles(recorded, current, { expectChanged, additions: true });
}

/** First and one-past-last point index of a group of a body, or null when the body has no such group. */
export function groupRange(groups: GuardGroup[], key: string): { start: number; end: number } | null {
  let start = 0;
  for (const g of groups) {
    if (g.key === key) return { start, end: start + g.count };
    start += g.count;
  }
  return null;
}

/**
 * The heights of ONE group taken from a new sampling of the whole body, every other point as recorded:
 * what a re-recording of one place may change. `outside` lists every point outside the group whose height
 * differs between the recording and the sampling, in any of the queries: the re-recording is refused while
 * that list is not empty. `changedInGroup` counts the points of the group that differ, per query.
 */
export function spliceGroup(body: GuardBodyHeights, key: string, sampled: SampledHeights): { body: GuardBodyHeights; outside: (ChangedPoint & { query: string })[]; changedInGroup: Record<string, number> } {
  const range = groupRange(body.groups, key);
  if (!range) throw new Error(`no group ${key} (groups: ${body.groups.map((g) => g.key).join(', ')})`);
  const queries: [string, string, string][] = [['collision', body.collision, sampled.collision], ...Object.keys(body.band).map((l): [string, string, string] => [`band ${l} m`, body.band[l]!, sampled.band[l] ?? ''])];
  const outside: (ChangedPoint & { query: string })[] = [];
  const changedInGroup: Record<string, number> = {};
  for (const [query, recorded, current] of queries) {
    if (current.length !== recorded.length) throw new Error(`${query}: the sampling has ${current.length / 16} points, the recording ${recorded.length / 16}`);
    const diffs = heightDifferences(body, recorded, current);
    changedInGroup[query] = diffs.filter((d) => d.index >= range.start && d.index < range.end).length;
    for (const d of diffs) if (d.index < range.start || d.index >= range.end) outside.push({ ...d, query });
  }
  const splice = (recorded: string, current: string): string => recorded.slice(0, range.start * 16) + current.slice(range.start * 16, range.end * 16) + recorded.slice(range.end * 16);
  const band = Object.fromEntries(Object.keys(body.band).map((l) => [l, splice(body.band[l]!, sampled.band[l]!)]));
  return { body: { ...body, collision: splice(body.collision, sampled.collision), band }, outside, changedInGroup };
}
