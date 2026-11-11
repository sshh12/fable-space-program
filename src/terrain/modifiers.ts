/**
 * Terrain modifiers applied on top of data + amplification: flatten discs from BodyDef.terrain.modifiers and
 * one per LaunchSiteDef on the body (pad.flatRadius / pad.blendRadius / location.padElevation).
 *
 *   H = mix(H_natural, elevation, w(d)),  w = 1 for d <= flatRadius, smoothstep back to 0 at blendRadius,
 * d = great-circle distance on the datum sphere. Discs are applied in definition order (body modifiers
 * first, then sites sorted by id). Amplification and rocks are thereby suppressed on the pad, so it is flat
 * for physics and rendering alike. 'sample' / 'terrain' elevation = the natural DATA height at the centre
 * (final data, no procedural detail), resolved once when the provider is created.
 *
 * A site with `pad.shape` (request terrain-render-6) is levelled by its shape instead of one disc: exactly
 * flat inside the core and on the areas, a share of the natural relief elsewhere inside flatRadius, natural
 * from blendRadius on, every blend with a ragged edge (SitePadShapeDef in src/core/contracts/defs.ts). The
 * weight never reaches beyond blendRadius, so every proximity test by blendRadius stays valid.
 */
import type { BodyDef, LaunchSiteDef, SitePadShapeDef } from '../core/contracts/defs';
import { latLonToDir } from '../core/geo/cubeSphere';
import { DEG } from '../core/math/scalar';
import { smoothstep01 } from './util';

/** A site's shape, resolved for evaluation (local east / north axes, turned rectangles). */
export interface FlattenShape {
  /** Unit east and north at the centre (tangent plane of the site). */
  ex: number;
  ey: number;
  ez: number;
  nx: number;
  ny: number;
  nz: number;
  coreRadius: number;
  coreBlend: number;
  /** 1 - reliefShare: the weight inside flatRadius outside the core and the areas. */
  floor: number;
  areas: { east: number; north: number; halfEast: number; halfNorth: number; cos: number; sin: number; blend: number }[];
  amplitude: number;
  wavelength: number;
}

export interface FlattenDisc {
  /** Unit direction of the centre. */
  cx: number;
  cy: number;
  cz: number;
  flatRadius: number;
  blendRadius: number;
  /** Resolved elevation (m); NaN until a 'sample' elevation has been resolved. */
  elevation: number;
  sample: boolean;
  /** Where the disc comes from (error messages, diagnostics). */
  source: string;
  /** cos of the blend radius angle (fast reject). */
  cosBlend: number;
  /** The site's shape (request terrain-render-6); absent = the plain disc. */
  shape?: FlattenShape;
}

function resolveShape(s: SitePadShapeDef, d: { x: number; y: number; z: number }, flatRadius: number, source: string): FlattenShape {
  const bad = (what: string): never => {
    throw new Error(`${source}: pad.shape ${what}`);
  };
  if (!(s.coreRadius >= 0) || !(s.coreBlend > 0)) bad(`needs coreRadius >= 0 and coreBlend > 0 (got ${s.coreRadius}, ${s.coreBlend})`);
  if (!(s.coreRadius + s.coreBlend <= flatRadius)) bad(`core and its blend must lie inside flatRadius (${s.coreRadius} + ${s.coreBlend} > ${flatRadius})`);
  if (!(s.reliefShare >= 0 && s.reliefShare <= 1)) bad(`reliefShare must be 0..1 (got ${s.reliefShare})`);
  if (!(s.edgeNoise.amplitude >= 0 && s.edgeNoise.amplitude < 1) || !(s.edgeNoise.wavelength > 0)) bad(`edgeNoise needs 0 <= amplitude < 1 and wavelength > 0`);
  // East = Z x d (the body's spin axis is +Z of the body-fixed frame); north = d x east.
  let ex = -d.y;
  let ey = d.x;
  let l = Math.hypot(ex, ey);
  if (l < 1e-12) {
    ex = 1;
    ey = 0;
    l = 1;
  }
  ex /= l;
  ey /= l;
  const ez = 0;
  const nx = d.y * ez - d.z * ey;
  const ny = d.z * ex - d.x * ez;
  const nz = d.x * ey - d.y * ex;
  const areas = s.areas.map((a, i) => {
    if (!(a.halfEast > 0) || !(a.halfNorth > 0) || !(a.blend > 0)) bad(`areas[${i}] needs positive half extents and blend`);
    // The area and its blend must stay inside flatRadius (the disc's reach).
    if (!(Math.hypot(a.east, a.north) + Math.hypot(a.halfEast, a.halfNorth) + a.blend <= flatRadius)) bad(`areas[${i}] reaches beyond flatRadius`);
    const h = a.headingDeg * DEG;
    return { east: a.east, north: a.north, halfEast: a.halfEast, halfNorth: a.halfNorth, cos: Math.cos(h), sin: Math.sin(h), blend: a.blend };
  });
  return { ex, ey, ez, nx, ny, nz, coreRadius: s.coreRadius, coreBlend: s.coreBlend, floor: 1 - s.reliefShare, areas, amplitude: s.edgeNoise.amplitude, wavelength: s.edgeNoise.wavelength };
}

export function buildFlattenDiscs(body: BodyDef, sites: readonly LaunchSiteDef[]): FlattenDisc[] {
  const R = body.radius;
  const out: FlattenDisc[] = [];
  const add = (latDeg: number, lonDeg: number, flatRadius: number, blendRadius: number, elevation: number | 'sample' | 'terrain', source: string, shape?: SitePadShapeDef): void => {
    if (!(flatRadius >= 0) || !(blendRadius > flatRadius)) throw new Error(`${source}: flatten disc needs 0 <= flatRadius < blendRadius (got ${flatRadius}, ${blendRadius})`);
    const d = latLonToDir(latDeg * DEG, lonDeg * DEG);
    const sample = elevation === 'sample' || elevation === 'terrain';
    out.push({
      cx: d.x,
      cy: d.y,
      cz: d.z,
      flatRadius,
      blendRadius,
      elevation: sample ? NaN : (elevation as number),
      sample,
      source,
      cosBlend: Math.cos(Math.min(Math.PI, blendRadius / R)),
      ...(shape ? { shape: resolveShape(shape, d, flatRadius, source) } : {}),
    });
  };
  const terrain = body.terrain!;
  terrain.modifiers.forEach((m, i) => {
    if (m.kind !== 'flattenDisc') throw new Error(`bodies/${body.id}.json: terrain modifier ${i} has unknown kind "${(m as { kind: string }).kind}"`);
    add(m.latDeg, m.lonDeg, m.flatRadius, m.blendRadius, m.elevation, `bodies/${body.id}.json terrain.modifiers[${i}]`);
  });
  for (const s of [...sites].filter((x) => x.bodyId === body.id).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    add(s.location.latDeg, s.location.lonDeg, s.pad.flatRadius, s.pad.blendRadius, s.location.padElevation, `sites/${s.id}.json pad`, s.pad.shape);
  }
  return out;
}

/** Hash of an integer lattice point to [0, 1) (deterministic, no Math.random). */
function lattice(ix: number, iy: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Band-limited value noise in [0, 1] of a point in the site's tangent plane (m), two octaves. */
export function edgeNoise(east: number, north: number, wavelength: number): number {
  let sum = 0;
  let amp = 0.65;
  let f = 1 / wavelength;
  for (let o = 0; o < 2; o++) {
    const x = east * f + o * 17.3;
    const y = north * f - o * 9.1;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const u = smoothstep01(x - ix);
    const v = smoothstep01(y - iy);
    const a = lattice(ix, iy) + (lattice(ix + 1, iy) - lattice(ix, iy)) * u;
    const b = lattice(ix, iy + 1) + (lattice(ix + 1, iy + 1) - lattice(ix, iy + 1)) * u;
    sum += amp * (a + (b - a) * v);
    amp = 0.35;
    f *= 2.3;
  }
  return sum;
}

/** Weight of a ragged blend: t = 0 at the flat edge, 1 at the nominal far end, which noise n (0..1) pulls in by A. */
const ragged = (t: number, n: number, A: number): number => (t <= 0 ? 1 : 1 - smoothstep01(Math.min(1, t * (1 + A * n))));

/** Weight of one disc at unit direction (x, y, z) on a sphere of radius R. */
export function discWeight(d: FlattenDisc, x: number, y: number, z: number, R: number): number {
  const c = d.cx * x + d.cy * y + d.cz * z;
  if (c <= d.cosBlend) return 0;
  const dx = x - d.cx;
  const dy = y - d.cy;
  const dz = z - d.cz;
  const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const dist = 2 * R * Math.asin(Math.min(1, chord / 2));
  const s = d.shape;
  if (!s) {
    if (dist <= d.flatRadius) return 1;
    if (dist >= d.blendRadius) return 0;
    return 1 - smoothstep01((dist - d.flatRadius) / (d.blendRadius - d.flatRadius));
  }
  if (dist <= s.coreRadius) return 1;
  // Position in the site's tangent plane (m) and the edge noise there.
  const pe = R * (dx * s.ex + dy * s.ey + dz * s.ez);
  const pn = R * (dx * s.nx + dy * s.ny + dz * s.nz);
  const n = s.amplitude > 0 ? edgeNoise(pe, pn, s.wavelength) : 0;
  // The disc: the floor (1 - reliefShare) out to flatRadius, a ragged blend to 0 by blendRadius. The core and
  // the areas blend from 1 down to that over their whole blend width.
  const disc = s.floor * ragged((dist - d.flatRadius) / (d.blendRadius - d.flatRadius), n, s.amplitude);
  let w = disc + (1 - disc) * ragged((dist - s.coreRadius) / s.coreBlend, n, s.amplitude);
  if (w >= 1) return 1;
  for (const a of s.areas) {
    const de = pe - a.east;
    const dn = pn - a.north;
    // Into the rectangle's own axes (it is turned clockwise by its heading).
    const u = de * a.cos - dn * a.sin;
    const v = de * a.sin + dn * a.cos;
    const out = Math.hypot(Math.max(Math.abs(u) - a.halfEast, 0), Math.max(Math.abs(v) - a.halfNorth, 0));
    if (out < a.blend) w = Math.max(w, disc + (1 - disc) * ragged(out / a.blend, n, s.amplitude));
    if (w >= 1) return 1;
  }
  return w;
}

/** Combined suppression weight 1 - prod(1 - w_i) (0 = natural terrain). */
export function flattenWeight(discs: readonly FlattenDisc[], x: number, y: number, z: number, R: number): number {
  let keep = 1;
  for (let i = 0; i < discs.length; i++) {
    const w = discWeight(discs[i]!, x, y, z, R);
    if (w > 0) keep *= 1 - w;
  }
  return 1 - keep;
}

/** Apply every disc to a natural height at unit direction (x, y, z). */
export function applyDiscs(discs: readonly FlattenDisc[], h: number, x: number, y: number, z: number, R: number): number {
  for (let i = 0; i < discs.length; i++) {
    const d = discs[i]!;
    const w = discWeight(d, x, y, z, R);
    if (w === 0) continue;
    h = w === 1 ? d.elevation : h + w * (d.elevation - h);
  }
  return h;
}
