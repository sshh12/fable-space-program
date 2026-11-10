/**
 * Shared setup for the terrain-core tests: the synthetic fixture tile root, fixture definitions and
 * providers over them, and point/geometry helpers.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import type { TileSource } from '../../../src/core/contracts/terrain';
import { tileUvToDir, type TileKey } from '../../../src/core/geo/cubeSphere';
import { Prng } from '../../../src/core/math/hash';
import type { Vec3 } from '../../../src/core/math/vec3';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider, type TerrainAuthority, type TerrainProviderOptions } from '../../../src/terrain/provider';
import { fixtureDefs, syntheticTileRoot, type FixtureDefOptions } from '../../../tools/terrain-core/fixtures';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export async function fixtureRoot(): Promise<string> {
  return syntheticTileRoot();
}

export async function fixtureProvider(
  o: FixtureDefOptions & TerrainProviderOptions & { source?: TileSource } = {},
): Promise<{ tp: TerrainAuthority; defs: DefLibrary; root: string }> {
  const root = await fixtureRoot();
  const defs = await fixtureDefs(REPO_ROOT, o);
  const tp = await createTerrainProvider(defs, o.source ?? createFsTileSource(root), o);
  return { tp, defs, root };
}

/** Unit direction at tangent offset (east, north) metres from dir on a sphere of radius R. */
export function offset(dir: Vec3, east: number, north: number, R: number): Vec3 {
  let ex = { x: -dir.y, y: dir.x, z: 0 };
  let l = Math.hypot(ex.x, ex.y);
  if (l < 1e-9) {
    ex = { x: 1, y: 0, z: 0 };
    l = 1;
  }
  ex = { x: ex.x / l, y: ex.y / l, z: 0 };
  const ny = { x: dir.y * ex.z - dir.z * ex.y, y: dir.z * ex.x - dir.x * ex.z, z: dir.x * ex.y - dir.y * ex.x };
  const x = dir.x + (ex.x * east + ny.x * north) / R;
  const y = dir.y + (ex.y * east + ny.y * north) / R;
  const z = dir.z + (ex.z * east + ny.z * north) / R;
  const m = Math.hypot(x, y, z);
  return { x: x / m, y: y / m, z: z / m };
}

/** Direction moved by `dist` metres from `dir` toward `toward` (great circle), on radius R. */
export function moveToward(dir: Vec3, toward: Vec3, dist: number, R: number): Vec3 {
  const d = toward.x * dir.x + toward.y * dir.y + toward.z * dir.z;
  let tx = toward.x - d * dir.x;
  let ty = toward.y - d * dir.y;
  let tz = toward.z - d * dir.z;
  const l = Math.hypot(tx, ty, tz);
  tx /= l;
  ty /= l;
  tz /= l;
  const a = dist / R;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: dir.x * c + tx * s, y: dir.y * c + ty * s, z: dir.z * c + tz * s };
}

export const prng = (seed: number): Prng => new Prng(seed);

/** Random tile-local point of a tile. */
export function randomInTile(rng: Prng, key: TileKey): Vec3 {
  return tileUvToDir(key, rng.next(), rng.next());
}

export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const angleBetween = (a: Vec3, b: Vec3): number => {
  const c = a.y * b.z - a.z * b.y;
  const d = a.z * b.x - a.x * b.z;
  const e = a.x * b.y - a.y * b.x;
  return Math.atan2(Math.hypot(c, d, e), a.x * b.x + a.y * b.y + a.z * b.z);
};
