/**
 * Coverage-edge and continuity checks shared by the synthetic suite and the real-data suite.
 */
import type { TileLayerManifest, TileManifest, TileRect, TileSource } from '../../../src/core/contracts/terrain';
import { layerHasTile } from '../../../src/core/contracts/terrain';
import { dirToTile, tileUvToDir, type FaceId, type TileKey } from '../../../src/core/geo/cubeSphere';
import type { Prng } from '../../../src/core/math/hash';
import type { Vec3 } from '../../../src/core/math/vec3';
import type { TerrainAuthority } from '../../../src/terrain/provider';
import { moveToward } from './helpers';

export interface BoundaryPoint {
  /** Point on the coverage boundary of the level. */
  p: Vec3;
  /** A point slightly inside the covered side (defines the crossing direction). */
  inside: Vec3;
  key: TileKey;
}

const EDGES: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function neighbourExists(layer: TileLayerManifest, key: TileKey, dx: number, dy: number): boolean {
  const n = 2 ** key.level;
  const nx = key.x + dx;
  const ny = key.y + dy;
  if (nx >= 0 && nx < n && ny >= 0 && ny < n) return layerHasTile(layer, { face: key.face, level: key.level, x: nx, y: ny });
  const u = dx < 0 ? -1e-7 : dx > 0 ? 1 + 1e-7 : 0.5;
  const v = dy < 0 ? -1e-7 : dy > 0 ? 1 + 1e-7 : 0.5;
  return layerHasTile(layer, dirToTile(tileUvToDir(key, u, v), key.level).key);
}

/** Random points on the coverage boundary of sparse `level` (edges whose neighbour tile is missing). */
export function boundaryPoints(layer: TileLayerManifest, level: number, count: number, rng: Prng): BoundaryPoint[] {
  const edges: { key: TileKey; dx: number; dy: number }[] = [];
  for (const r of layer.coverage[String(level)] ?? []) {
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) {
        const key: TileKey = { face: r.face as FaceId, level, x, y };
        for (const [dx, dy] of EDGES) if (!neighbourExists(layer, key, dx, dy)) edges.push({ key, dx, dy });
      }
    }
  }
  if (edges.length === 0) return [];
  const out: BoundaryPoint[] = [];
  for (let i = 0; i < count; i++) {
    const e = edges[Math.floor(rng.next() * edges.length)]!;
    const a = 0.02 + 0.96 * rng.next();
    const u = e.dx < 0 ? 0 : e.dx > 0 ? 1 : a;
    const v = e.dy < 0 ? 0 : e.dy > 0 ? 1 : a;
    const ui = e.dx < 0 ? 0.01 : e.dx > 0 ? 0.99 : a;
    const vi = e.dy < 0 ? 0.01 : e.dy > 0 ? 0.99 : a;
    out.push({ p: tileUvToDir(e.key, u, v), inside: tileUvToDir(e.key, ui, vi), key: e.key });
  }
  return out;
}

/** A height layer with the optional `sourceCoverage` of docs/requests/terrain-core-1.md. */
export type LayerWithSource = TileLayerManifest & { sourceCoverage?: Record<string, TileRect[]> };

/**
 * A TileSource whose manifest has no coverage (and no source coverage) at levels >= fromLevel (the
 * "parent-level" surface).
 */
export function truncatedSource(src: TileSource, fromLevel: number): TileSource {
  return {
    async manifest(tileset: string): Promise<TileManifest> {
      const m = await src.manifest(tileset);
      const copy: TileManifest = JSON.parse(JSON.stringify(m)) as TileManifest;
      for (const layer of Object.values(copy.layers) as LayerWithSource[]) {
        for (const k of Object.keys(layer.coverage)) if (Number(k) >= fromLevel) delete layer.coverage[k];
        const sc = layer.sourceCoverage;
        if (sc) for (const k of Object.keys(sc)) if (Number(k) >= fromLevel) delete sc[k];
      }
      return copy;
    },
    tile: (tileset, layer, key) => src.tile(tileset, layer, key),
    file: (tileset, rel) => src.file(tileset, rel),
  };
}

export interface EdgeStats {
  points: number;
  /** max |H(p + 1 mm) - H(p - 1 mm)| across the boundary (includes the honest change due to local slope). */
  maxJump: number;
  /** Points where that raw difference exceeds 1 mm, and the largest one-sided 2 mm change among them. */
  rawOver1mm: number;
  maxLocalChangeAtOver: number;
  /**
   * Discontinuity detector: |H(+1 mm) - H(-1 mm)| minus the larger of the one-sided changes over the same
   * 2 mm just inside (+1..+3 mm) and just outside (-3..-1 mm). A step of size s at the boundary adds s here;
   * a continuous surface of any slope gives ~0.
   */
  maxExcess: number;
  maxSlopeChange: number;
  maxParentDiff: number;
  /**
   * Discontinuity detector of the effective level, built like maxExcess: |E(+1 mm) - E(-1 mm)| minus the larger
   * one-sided change over the neighbouring 2 mm. A step adds its size; E rising smoothly through a source ring
   * of another level (gradient up to ~1.9 levels per ring width) gives ~0.
   */
  maxEJump: number;
  /** The raw |E(+1 mm) - E(-1 mm)| (reported). */
  maxEChange: number;
  /**
   * The same jump and slope tests applied to what the coverage edge adds, Delta = H - H_parent (H_parent =
   * the surface of the manifest without this level): isolates the edge from procedural features that are
   * sharp everywhere (fresh crater rims, rock flanks).
   */
  deltaJump: number;
  deltaSlopeChange: number;
}

/**
 * At each boundary point: the jump statistics above, the change of the 10 cm central-difference slope
 * between 1 mm inside and 1 mm outside, |H(p) - H_parent(p)|, and |E(+1 mm) - E(-1 mm)|. `lambdaH` is the
 * band limit for the jump/parent tests, `lambdaSlope` for the slope test.
 */
export function edgeStats(
  tp: TerrainAuthority,
  parent: TerrainAuthority,
  body: string,
  R: number,
  pts: readonly BoundaryPoint[],
  lambdaH: number,
  lambdaSlope: number,
): EdgeStats {
  let maxJump = 0;
  let maxExcess = 0;
  let rawOver1mm = 0;
  let maxLocalChangeAtOver = 0;
  let maxSlopeChange = 0;
  let maxParentDiff = 0;
  let maxEJump = 0;
  let maxEChange = 0;
  let deltaJump = 0;
  let deltaSlopeChange = 0;
  const h = (d: Vec3, lam: number): number => tp.heightAt(body, d, lam);
  const dlt = (d: Vec3, lam: number): number => tp.heightAt(body, d, lam) - parent.heightAt(body, d, lam);
  for (const q of pts) {
    const pin = moveToward(q.p, q.inside, 1e-3, R);
    const pout = moveToward(q.p, q.inside, -1e-3, R);
    const hin = h(pin, lambdaH);
    const hout = h(pout, lambdaH);
    const j = Math.abs(hin - hout);
    const ref = Math.max(Math.abs(h(moveToward(q.p, q.inside, 3e-3, R), lambdaH) - hin), Math.abs(hout - h(moveToward(q.p, q.inside, -3e-3, R), lambdaH)));
    maxJump = Math.max(maxJump, j);
    maxExcess = Math.max(maxExcess, j - ref);
    if (j > 1e-3) {
      rawOver1mm++;
      maxLocalChangeAtOver = Math.max(maxLocalChangeAtOver, ref);
    }
    const slope = (c: Vec3): number => (h(moveToward(c, q.inside, 0.05, R), lambdaSlope) - h(moveToward(c, q.inside, -0.05, R), lambdaSlope)) / 0.1;
    maxSlopeChange = Math.max(maxSlopeChange, Math.abs(slope(pin) - slope(pout)));
    deltaJump = Math.max(deltaJump, Math.abs(dlt(pin, lambdaH) - dlt(pout, lambdaH)));
    const dslope = (c: Vec3): number => (dlt(moveToward(c, q.inside, 0.05, R), lambdaH) - dlt(moveToward(c, q.inside, -0.05, R), lambdaH)) / 0.1;
    deltaSlopeChange = Math.max(deltaSlopeChange, Math.abs(dslope(pin) - dslope(pout)));
    maxParentDiff = Math.max(maxParentDiff, Math.abs(h(q.p, lambdaH) - parent.heightAt(body, q.p, lambdaH)));
    const E = (d: Vec3): number => tp.residency(body, d).effectiveLevel;
    const eIn = E(pin);
    const eOut = E(pout);
    const eChange = Math.abs(eIn - eOut);
    maxEChange = Math.max(maxEChange, eChange);
    maxEJump = Math.max(maxEJump, eChange - Math.max(Math.abs(E(moveToward(q.p, q.inside, 3e-3, R)) - eIn), Math.abs(eOut - E(moveToward(q.p, q.inside, -3e-3, R)))));
  }
  return { points: pts.length, maxJump, rawOver1mm, maxLocalChangeAtOver, maxExcess, maxSlopeChange, maxParentDiff, maxEJump, maxEChange, deltaJump, deltaSlopeChange };
}

/** Pin the data around every point (unique slots) and wait for it. */
export async function loadAround(tp: TerrainAuthority, body: string, pts: readonly Vec3[], radius: number, prefix: string): Promise<void> {
  await Promise.all(pts.map((p, i) => tp.ensureLoaded(body, p, radius, `${prefix}${i}`)));
}
