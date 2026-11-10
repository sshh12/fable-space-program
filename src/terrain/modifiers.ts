/**
 * Terrain modifiers applied on top of data + amplification: flatten discs from BodyDef.terrain.modifiers and
 * one per LaunchSiteDef on the body (pad.flatRadius / pad.blendRadius / location.padElevation).
 *
 *   H = mix(H_natural, elevation, w(d)),  w = 1 for d <= flatRadius, smoothstep back to 0 at blendRadius,
 * d = great-circle distance on the datum sphere. Discs are applied in definition order (body modifiers
 * first, then sites sorted by id). Amplification and rocks are thereby suppressed on the pad, so it is flat
 * for physics and rendering alike. 'sample' / 'terrain' elevation = the natural DATA height at the centre
 * (final data, no procedural detail), resolved once when the provider is created.
 */
import type { BodyDef, LaunchSiteDef } from '../core/contracts/defs';
import { latLonToDir } from '../core/geo/cubeSphere';
import { DEG } from '../core/math/scalar';
import { smoothstep01 } from './util';

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
}

export function buildFlattenDiscs(body: BodyDef, sites: readonly LaunchSiteDef[]): FlattenDisc[] {
  const R = body.radius;
  const out: FlattenDisc[] = [];
  const add = (latDeg: number, lonDeg: number, flatRadius: number, blendRadius: number, elevation: number | 'sample' | 'terrain', source: string): void => {
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
    });
  };
  const terrain = body.terrain!;
  terrain.modifiers.forEach((m, i) => {
    if (m.kind !== 'flattenDisc') throw new Error(`bodies/${body.id}.json: terrain modifier ${i} has unknown kind "${(m as { kind: string }).kind}"`);
    add(m.latDeg, m.lonDeg, m.flatRadius, m.blendRadius, m.elevation, `bodies/${body.id}.json terrain.modifiers[${i}]`);
  });
  for (const s of [...sites].filter((x) => x.bodyId === body.id).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    add(s.location.latDeg, s.location.lonDeg, s.pad.flatRadius, s.pad.blendRadius, s.location.padElevation, `sites/${s.id}.json pad`);
  }
  return out;
}

/** Weight of one disc at unit direction (x, y, z) on a sphere of radius R. */
export function discWeight(d: FlattenDisc, x: number, y: number, z: number, R: number): number {
  const c = d.cx * x + d.cy * y + d.cz * z;
  if (c <= d.cosBlend) return 0;
  const dx = x - d.cx;
  const dy = y - d.cy;
  const dz = z - d.cz;
  const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const dist = 2 * R * Math.asin(Math.min(1, chord / 2));
  if (dist <= d.flatRadius) return 1;
  if (dist >= d.blendRadius) return 0;
  return 1 - smoothstep01((dist - d.flatRadius) / (d.blendRadius - d.flatRadius));
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
