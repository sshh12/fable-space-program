import type { Vec3 } from '../math/vec3';

/**
 * THE cube-sphere mapping of the engine (plain gnomonic). Used by the bake pipeline (Python mirror in
 * tools/bake/common/cube.py, checked against tools/bake/golden/cube_vectors.json), the terrain height
 * authority, the GPU quadtree and physics. Do not re-implement it anywhere else.
 *
 * Body-fixed frame: +Z = spin axis (north), +X = prime meridian on the equator, right-handed.
 *   dir = (cos lat cos lon, cos lat sin lon, sin lat), lon east-positive, lat planetocentric.
 *
 * Faces: 0 = +X, 1 = -X, 2 = +Y, 3 = -Y, 4 = +Z, 5 = -Z. For face f with normal N and tangents U, V
 * (U x V = N):   dir = normalize(N + s U + t V),  s, t in [-1, 1].
 * On the four equatorial faces U points east and V points north.
 *
 * Tiles: (face, level, x, y) with x, y in [0, 2^level). Tile-local (u, v) in [0, 1]:
 *   s = -1 + 2 (x + u) / 2^level,   t = -1 + 2 (y + v) / 2^level.
 * Every raster layer stores column index increasing with u and ROW index increasing with v (row 0 is the
 * low-t edge), so texture coordinates equal tile (u, v) for every layer.
 */
export type FaceId = 0 | 1 | 2 | 3 | 4 | 5;

export interface TileKey {
  face: FaceId;
  level: number;
  x: number;
  y: number;
}

interface FaceBasis {
  n: readonly [number, number, number];
  u: readonly [number, number, number];
  v: readonly [number, number, number];
}

export const CUBE_FACES: readonly FaceBasis[] = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
  { n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0] },
];

/** Un-normalised cube-space point N + s U + t V. */
export function faceStToCube(face: FaceId, s: number, t: number): Vec3 {
  const f = CUBE_FACES[face]!;
  return {
    x: f.n[0] + s * f.u[0] + t * f.v[0],
    y: f.n[1] + s * f.u[1] + t * f.v[1],
    z: f.n[2] + s * f.u[2] + t * f.v[2],
  };
}

/** Unit body-fixed direction for face coordinates (s, t). */
export function faceStToDir(face: FaceId, s: number, t: number): Vec3 {
  const c = faceStToCube(face, s, t);
  const l = Math.hypot(c.x, c.y, c.z);
  return { x: c.x / l, y: c.y / l, z: c.z / l };
}

/** Face and face coordinates of a direction (need not be unit). Ties resolve to the lower face id. */
export function dirToFaceSt(dir: Vec3): { face: FaceId; s: number; t: number } {
  const ax = Math.abs(dir.x);
  const ay = Math.abs(dir.y);
  const az = Math.abs(dir.z);
  let face: FaceId;
  if (ax >= ay && ax >= az) face = dir.x >= 0 ? 0 : 1;
  else if (ay >= az) face = dir.y >= 0 ? 2 : 3;
  else face = dir.z >= 0 ? 4 : 5;
  const f = CUBE_FACES[face]!;
  const dn = dir.x * f.n[0] + dir.y * f.n[1] + dir.z * f.n[2];
  const du = dir.x * f.u[0] + dir.y * f.u[1] + dir.z * f.u[2];
  const dv = dir.x * f.v[0] + dir.y * f.v[1] + dir.z * f.v[2];
  return { face, s: du / dn, t: dv / dn };
}

/** Unit direction of tile-local (u, v). u, v may lie slightly outside [0, 1] (tile borders). */
export function tileUvToDir(key: TileKey, u: number, v: number): Vec3 {
  const n = 2 ** key.level;
  return faceStToDir(key.face, -1 + (2 * (key.x + u)) / n, -1 + (2 * (key.y + v)) / n);
}

/** Tile containing `dir` at `level`, plus the tile-local (u, v) of the direction. */
export function dirToTile(dir: Vec3, level: number): { key: TileKey; u: number; v: number } {
  const { face, s, t } = dirToFaceSt(dir);
  const n = 2 ** level;
  const fx = Math.min(Math.max(((s + 1) / 2) * n, 0), n * (1 - Number.EPSILON));
  const fy = Math.min(Math.max(((t + 1) / 2) * n, 0), n * (1 - Number.EPSILON));
  const x = Math.min(Math.floor(fx), n - 1);
  const y = Math.min(Math.floor(fy), n - 1);
  return { key: { face, level, x, y }, u: fx - x, v: fy - y };
}

export const latLonToDir = (latRad: number, lonRad: number): Vec3 => {
  const c = Math.cos(latRad);
  return { x: c * Math.cos(lonRad), y: c * Math.sin(lonRad), z: Math.sin(latRad) };
};

/** Planetocentric latitude and east longitude (rad, lon in (-pi, pi]) of a direction (need not be unit). */
export const dirToLatLon = (dir: Vec3): { lat: number; lon: number } => ({
  lat: Math.atan2(dir.z, Math.hypot(dir.x, dir.y)),
  lon: Math.atan2(dir.y, dir.x),
});

export const tileKeyString = (k: TileKey): string => `${k.face}/${k.level}/${k.x}/${k.y}`;

export function parseTileKey(s: string): TileKey {
  const parts = s.split('/').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) throw new Error(`bad tile key "${s}"`);
  return { face: parts[0] as FaceId, level: parts[1]!, x: parts[2]!, y: parts[3]! };
}

export const parentTile = (k: TileKey): TileKey | null =>
  k.level === 0 ? null : { face: k.face, level: k.level - 1, x: k.x >> 1, y: k.y >> 1 };

export const childTiles = (k: TileKey): [TileKey, TileKey, TileKey, TileKey] => [
  { face: k.face, level: k.level + 1, x: 2 * k.x, y: 2 * k.y },
  { face: k.face, level: k.level + 1, x: 2 * k.x + 1, y: 2 * k.y },
  { face: k.face, level: k.level + 1, x: 2 * k.x, y: 2 * k.y + 1 },
  { face: k.face, level: k.level + 1, x: 2 * k.x + 1, y: 2 * k.y + 1 },
];

/** Mean tile edge length on a sphere of `radius` at `level` (quarter circumference / 2^level). */
export const meanTileSize = (radius: number, level: number): number => (Math.PI * radius) / 2 / 2 ** level;

/** Canonical URL path of a tile relative to the tile root: {body}/{layer}/{face}/{level}/{x}/{y}.{ext}. */
export const tilePath = (body: string, layer: string, k: TileKey, ext: string): string =>
  `${body}/${layer}/${k.face}/${k.level}/${k.x}/${k.y}.${ext}`;
