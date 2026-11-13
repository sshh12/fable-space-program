/**
 * Near-field geometry on the CPU (float64): activation of the hand-over (ARCHITECTURE 10.2), the planet-fixed
 * plane the wave field and the surface mesh live in, the camera's nadir on it, and the CDLOD quadtree of
 * surface patches out to fadeEnd.
 *
 * The plane: a gnomonic chart of the sea-level sphere around an ANCHOR direction a (the centre of the
 * cube-sphere tile of level ANCHOR_LEVEL that held the nadir when the near field switched on), with axes
 * e = east, f = north at a, scaled so plane metres equal surface metres at a:
 *   (x, y) = R (n . e, n . f) / (n . a),        n(x, y) = normalize(a + (x e + y f) / R).
 * The FFT cascades are sampled at plane coordinates modulo their patch lengths (which divide the 8192 m
 * period), so the waves are fixed to the planet while the camera moves; the anchor is kept while the near
 * field stays active (re-anchoring happens only while nothing is drawn, or after ANCHOR_MAX_DRIFT, where the
 * chart's scale error is 0.4 %).
 */
import { CUBE_FACES, dirToTile, tileUvToDir } from '@/core/geo/cubeSphere';
import { quat, v3, type Quat, type Vec3 } from '@/core/math';

export const ANCHOR_LEVEL = 5;
/** Largest distance of the nadir from the anchor before the chart is re-anchored even while active, m. */
export const ANCHOR_MAX_DRIFT = 400e3;

export interface OceanNearFieldValue {
  /** Frame body index (index into FrameContext.bodies, < MAX_BODIES), -1 = no near field. */
  bodyIndex: number;
  fadeStart: number;
  fadeEnd: number;
}

/**
 * The 'ocean.nearField' value for a camera `altitudeAboveSea` metres above the sea of frame body `bodyIndex`
 * (-1 or null tunables: that body has no ocean). Active while the camera is no higher than fadeEnd above the
 * sea: from higher up no water pixel is closer than fadeEnd, so the switch itself is invisible.
 */
export function nearFieldValue(bodyIndex: number, hasOcean: boolean, altitudeAboveSea: number, fadeStart: number, fadeEnd: number): OceanNearFieldValue {
  const active = bodyIndex >= 0 && hasOcean && Number.isFinite(altitudeAboveSea) && altitudeAboveSea <= fadeEnd;
  return active ? { bodyIndex, fadeStart, fadeEnd } : { bodyIndex: -1, fadeStart, fadeEnd };
}

/** 16-byte uniform payload of 'ocean.nearField': i32 bodyIndex, f32 fadeStart, f32 fadeEnd, f32 reserved. */
export function packNearField(v: OceanNearFieldValue, out = new ArrayBuffer(16)): ArrayBuffer {
  new Int32Array(out, 0, 1)[0] = v.bodyIndex;
  const f = new Float32Array(out, 4, 3);
  f[0] = v.fadeStart;
  f[1] = v.fadeEnd;
  f[2] = 0;
  return out;
}

export interface OceanChart {
  /** Unit anchor direction and east / north axes, body-fixed. */
  a: Vec3;
  e: Vec3;
  f: Vec3;
  radius: number;
}

/** The chart anchored at the centre of the ANCHOR_LEVEL cube tile that contains `dir` (unit, body-fixed). */
export function anchorChart(dir: Vec3, radius: number): OceanChart {
  const { key } = dirToTile(dir, ANCHOR_LEVEL);
  const a = tileUvToDir(key, 0.5, 0.5);
  let e = v3.cross({ x: 0, y: 0, z: 1 }, a);
  // At a pole "east" is undefined: any horizontal axis will do.
  if (v3.lenSq(e) < 1e-12) e = v3.fromTuple([...CUBE_FACES[0]!.u]);
  e = v3.normalize(e);
  const f = v3.normalize(v3.cross(a, e));
  return { a, e, f, radius };
}

/** Plane coordinates (m) of a body-fixed direction; null beyond the chart's hemisphere. */
export function chartCoords(c: OceanChart, n: Vec3): { x: number; y: number } | null {
  const na = v3.dot(n, c.a);
  if (na <= 1e-6) return null;
  return { x: (c.radius * v3.dot(n, c.e)) / na, y: (c.radius * v3.dot(n, c.f)) / na };
}

/** Body-fixed unit direction of plane coordinates. */
export function chartDir(c: OceanChart, x: number, y: number): Vec3 {
  return v3.normalize(v3.add(c.a, v3.add(v3.scale(c.e, x / c.radius), v3.scale(c.f, y / c.radius))));
}

/**
 * The frame's reference ("nadir") point: plane coordinates of the camera's nadir, its unit direction cHat,
 * and the scale |q_c| of the unnormalised chart vector there (vertex offsets are divided by it).
 */
export interface ChartReference {
  x: number;
  y: number;
  cHat: Vec3;
  qLen: number;
}

export function chartReference(c: OceanChart, nadirDir: Vec3): ChartReference {
  const xy = chartCoords(c, nadirDir);
  if (!xy) throw new Error('ocean: nadir outside the near-field chart');
  const q = v3.add(c.a, v3.add(v3.scale(c.e, xy.x / c.radius), v3.scale(c.f, xy.y / c.radius)));
  const qLen = v3.len(q);
  return { x: xy.x, y: xy.y, cHat: v3.scale(q, 1 / qLen), qLen };
}

/**
 * Offset R (n - cHat) of the point at plane offset (u, v) from the reference, cancellation-free (the WGSL
 * `oceanSphereOffset` is the same expression in float32).
 */
export function sphereOffset(c: OceanChart, ref: ChartReference, u: number, v: number): Vec3 {
  const d = v3.scale(v3.add(v3.scale(c.e, u), v3.scale(c.f, v)), 1 / (c.radius * ref.qLen));
  const e = 2 * v3.dot(ref.cHat, d) + v3.dot(d, d);
  const s = Math.sqrt(1 + e);
  const inv = -e / (s * (1 + s));
  return v3.scale(v3.add(v3.scale(d, 1 + inv), v3.scale(ref.cHat, inv)), c.radius);
}

/** Session state: the chart is kept while the near field is active and the nadir stays within ANCHOR_MAX_DRIFT. */
export class ChartKeeper {
  chart: OceanChart | null = null;
  private bodyId: string | null = null;

  update(bodyId: string, nadirDir: Vec3, radius: number, active: boolean): OceanChart {
    const keep = this.chart !== null && this.bodyId === bodyId && active && this.drift(nadirDir) < ANCHOR_MAX_DRIFT;
    if (!keep) {
      const next = anchorChart(nadirDir, radius);
      // Re-anchoring onto the tile that already anchors the chart changes nothing.
      if (!this.chart || this.bodyId !== bodyId || v3.dist(next.a, this.chart.a) > 1e-12 || this.chart.radius !== radius) this.chart = next;
      this.bodyId = bodyId;
    }
    return this.chart!;
  }

  /**
   * Forget the chart: the next update anchors it where the nadir then is. (Which tile anchors the chart otherwise
   * depends on where the camera has been: a frame-exact capture must not.)
   */
  reset(): void {
    this.chart = null;
    this.bodyId = null;
  }

  private drift(n: Vec3): number {
    const c = this.chart!;
    return c.radius * Math.acos(Math.min(1, Math.max(-1, v3.dot(n, c.a))));
  }
}

// ---------------------------------------------------------------------------------------- CDLOD patches

/** Cells per side of one drawn patch (a quadrant of a quadtree node). */
export const PATCH_CELLS = 16;
/** Side of a leaf quadtree node, m (its quadrants have PATCH_CELLS cells of LEAF_SIZE / (2 PATCH_CELLS)). */
export const LEAF_SIZE = 4;
export const TREE_LEVELS = 19;
export const ROOT_SIZE = LEAF_SIZE * 2 ** (TREE_LEVELS - 1);
/**
 * LOD range of level l is LOD_RANGE x node size; vertices morph to the parent grid over the outer
 * MORPH_FRACTION of it. Crack-free needs the morph of level l + 1 to start beyond the farthest point of a
 * level-l node: (1 - MORPH_FRACTION) 2 LOD_RANGE >= LOD_RANGE + sqrt 2 (4.5 >= 4.41 here).
 */
export const LOD_RANGE = 3;
export const MORPH_FRACTION = 0.25;

export interface SurfacePatch {
  /** Plane coordinates of the patch's lower-left corner relative to the anchor, m (exact multiples of the cell size). */
  x0: number;
  y0: number;
  /** Quadtree level (0 = leaf) and cell size, m. */
  level: number;
  cell: number;
}

export const nodeSize = (level: number): number => LEAF_SIZE * 2 ** level;
export const lodRange = (level: number): number => LOD_RANGE * nodeSize(level);

export interface PatchSelectionInput {
  /** Camera position in plane coordinates (nadir x, y) and height above the chart plane, m. */
  camX: number;
  camY: number;
  camH: number;
  /** Nothing farther than this from the camera is drawn (fadeEnd), m. */
  maxDistance: number;
  /** Vertical margin of the wave field (amplitude bound), m. */
  waveMargin: number;
  /** Sea-level radius, m: patches wholly beyond the horizon (crests included) are not drawn. Omitted = no horizon cull. */
  seaRadius?: number;
  /** Optional culling of a patch box (plane coords corner + size, z range) against the view; true = visible. */
  visible?: (x0: number, y0: number, size: number, zMin: number, zMax: number) => boolean;
}

/**
 * Horizontal distance (m) beyond which no point of a sea surface with crests up to `waveMargin` can be seen from
 * `camH` above sea level on a sphere of radius `seaRadius`: the camera's horizon distance plus a crest's.
 */
export function horizonDistance(camH: number, waveMargin: number, seaRadius: number): number {
  // Conservative: the camera's own term is taken from a trough below it (camH + waveMargin above the surface).
  const h = Math.max(camH, 0) + waveMargin;
  return Math.sqrt(h * (2 * seaRadius + h)) + Math.sqrt(waveMargin * (2 * seaRadius + waveMargin));
}

function boxDistance(x0: number, y0: number, size: number, zMin: number, zMax: number, cx: number, cy: number, cz: number): number {
  const dx = Math.max(x0 - cx, 0, cx - (x0 + size));
  const dy = Math.max(y0 - cy, 0, cy - (y0 + size));
  const dz = Math.max(zMin - cz, 0, cz - zMax);
  return Math.hypot(dx, dy, dz);
}

/**
 * CDLOD selection (Strugar 2010) over the chart: a node of level l is drawn at its own resolution where it
 * lies beyond the LOD range of level l - 1, its children replace it where they are in range. Every node is
 * emitted as quadrants (patches of PATCH_CELLS cells). The plane's curvature drop over the near field
 * (fadeEnd^2 / 2R, 70 m at 30 km) is negligible against the ranges.
 */
export function selectPatches(inp: PatchSelectionInput, out: SurfacePatch[] = []): SurfacePatch[] {
  out.length = 0;
  const { camX, camY, camH, maxDistance, waveMargin } = inp;
  const zMin = -waveMargin;
  const zMax = waveMargin;
  const half = ROOT_SIZE / 2;
  const horizon = inp.seaRadius ? horizonDistance(camH, waveMargin, inp.seaRadius) : Infinity;
  const visit = (x0: number, y0: number, level: number): boolean => {
    const size = nodeSize(level);
    const dist = boxDistance(x0, y0, size, zMin, zMax, camX, camY, camH);
    if (dist > maxDistance) return true; // nothing to draw here, and the parent need not cover it
    if (dist > lodRange(level)) return false; // the parent must cover this area
    if (boxDistance(x0, y0, size, 0, 0, camX, camY, 0) > horizon) return true; // below the horizon
    if (inp.visible && !inp.visible(x0, y0, size, zMin, zMax)) return true;
    const cell = size / (2 * PATCH_CELLS);
    const emitQuadrant = (qx: number, qy: number): void => {
      const qx0 = x0 + qx * size * 0.5;
      const qy0 = y0 + qy * size * 0.5;
      if (boxDistance(qx0, qy0, size * 0.5, zMin, zMax, camX, camY, camH) > maxDistance) return;
      if (boxDistance(qx0, qy0, size * 0.5, 0, 0, camX, camY, 0) > horizon) return;
      out.push({ x0: qx0, y0: qy0, level, cell });
    };
    if (level === 0 || boxDistance(x0, y0, size, zMin, zMax, camX, camY, camH) > lodRange(level - 1)) {
      for (let q = 0; q < 4; q++) emitQuadrant(q & 1, q >> 1);
      return true;
    }
    const hs = size * 0.5;
    for (let q = 0; q < 4; q++) {
      const qx = q & 1;
      const qy = q >> 1;
      if (!visit(x0 + qx * hs, y0 + qy * hs, level - 1)) emitQuadrant(qx, qy);
    }
    return true;
  };
  // The root is centred on the anchor; the camera is within ANCHOR_MAX_DRIFT of it.
  visit(-half, -half, TREE_LEVELS - 1);
  return out;
}

/** Rotation body-fixed -> ROOT as a row-major 3 x 3 in a Float32Array slot of 12 (vec4 columns for WGSL mat3x3). */
export function packRotation(q: Quat, out: Float32Array, offset: number): void {
  // Columns of the matrix = images of the body-fixed axes.
  const cx = quat.rotate(q, { x: 1, y: 0, z: 0 });
  const cy = quat.rotate(q, { x: 0, y: 1, z: 0 });
  const cz = quat.rotate(q, { x: 0, y: 0, z: 1 });
  out.set([cx.x, cx.y, cx.z, 0, cy.x, cy.y, cy.z, 0, cz.x, cz.y, cz.z, 0], offset);
}
