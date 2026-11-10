/**
 * Enumeration of the tiles of one level that intersect a disc on the sphere (conservative: never misses a
 * tile that meets the disc; may include a few tiles just beyond it).
 */
import { dirToTile, type FaceId, type TileKey } from '../core/geo/cubeSphere';
import type { Vec3 } from '../core/math/vec3';
import { meanTileSizeAt } from './util';

/** Unit tangent basis (any orthonormal pair) at dir. */
export function tangentBasis(dir: Vec3): { ex: Vec3; ey: Vec3 } {
  let ex: Vec3 = { x: -dir.y, y: dir.x, z: 0 };
  let l = Math.sqrt(ex.x * ex.x + ex.y * ex.y);
  if (l < 1e-9) {
    ex = { x: 1, y: 0, z: 0 };
    l = 1;
  }
  ex = { x: ex.x / l, y: ex.y / l, z: 0 };
  const ey = { x: dir.y * ex.z - dir.z * ex.y, y: dir.z * ex.x - dir.x * ex.z, z: dir.x * ex.y - dir.y * ex.x };
  return { ex, ey };
}

/** Unit direction at tangent-plane offset (ox, oy) metres from dir on a sphere of radius R. */
export function offsetDir(dir: Vec3, e: { ex: Vec3; ey: Vec3 }, ox: number, oy: number, R: number): Vec3 {
  const x = dir.x + (e.ex.x * ox + e.ey.x * oy) / R;
  const y = dir.y + (e.ex.y * ox + e.ey.y * oy) / R;
  const z = dir.z + (e.ex.z * ox + e.ey.z * oy) / R;
  const l = Math.sqrt(x * x + y * y + z * z);
  return { x: x / l, y: y / l, z: z / l };
}

/**
 * Tiles of `level` that `exists` accepts and that intersect the disc of `radius` m around `dir` on a sphere
 * of radius R. Samples a grid of spacing h <= tileSize / 6 over the disc widened by 5 h: tiles are at least
 * 0.7 tileSize wide, so each tile meeting the disc contains a sample. Order: first hit along the sample scan
 * (deterministic).
 */
export function tilesInDisc(dir: Vec3, radius: number, level: number, R: number, exists: (face: FaceId, x: number, y: number) => boolean): TileKey[] {
  const ts = meanTileSizeAt(R, level);
  const h = Math.max(1e-3, Math.min(ts / 6, radius / 2));
  const reach = radius + 5 * h;
  const steps = Math.ceil(reach / h);
  const e = tangentBasis(dir);
  const seen = new Set<string>();
  const out: TileKey[] = [];
  for (let a = -steps; a <= steps; a++) {
    for (let b = -steps; b <= steps; b++) {
      const ox = a * h;
      const oy = b * h;
      if (ox * ox + oy * oy > (reach + h) * (reach + h)) continue;
      const t = dirToTile(offsetDir(dir, e, ox, oy, R), level);
      const k = `${t.key.face}/${t.key.x}/${t.key.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (exists(t.key.face, t.key.x, t.key.y)) out.push(t.key);
    }
  }
  return out;
}
