/**
 * Body shape, surface kind and the default rails warp limits (ARCHITECTURE 8.3, 8.4; decision 40).
 *
 *  - `surfaceRadius(body, dirFixed)`: the reference (datum) surface under a body-fixed unit direction: the
 *    oblate spheroid of `BodyDef.shape` (equatorial radius a, polar radius c: r = 1 / sqrt((x^2 + y^2) / a^2 +
 *    z^2 / c^2)) or the sphere of `BodyDef.radius`. It is what altitude, atmosphere sampling, warp limits and the
 *    floor of a body without a surface are measured from. Terrain heights are NOT added to it: a baked height
 *    layer is relative to the mean radius and already carries the body's shape (docs/handoff/planet-bake.md
 *    section 7), so the radar altitude stays |r| - (radius + terrain height).
 *  - `surface: 'none'` (the giants): no solid surface; a vessel below `atmosphere.floorAltitude` above the
 *    reference surface is destroyed (cause 'overstress').
 *  - `warpAltitudeLimits`: one lowest altitude per rails warp level. A body that states none gets the default
 *    from its radius and atmosphere top; a stated list shorter than the number of rails levels (the shipped
 *    Earth and Moon list seven while the table grows to nine) is completed by the default for the levels it
 *    does not state, never below its own last entry.
 */
import { MAX_PHYSICS_WARP_INDEX, WARP_LEVELS, type BodyDef } from '../../core/contracts/defs';
import type { Vec3 } from '../../core/math/vec3';

/** Number of rails warp levels (WARP_LEVELS beyond the physics levels). */
export const RAILS_LEVELS = WARP_LEVELS.length - MAX_PHYSICS_WARP_INDEX - 1;

/** Reference surface radius (m) under a body-fixed unit direction (any length; it is normalised here). */
export function surfaceRadius(body: BodyDef, dirFixed: Vec3): number {
  const s = body.shape;
  if (!s) return body.radius;
  const l2 = dirFixed.x * dirFixed.x + dirFixed.y * dirFixed.y + dirFixed.z * dirFixed.z;
  const a = s.equatorialRadius;
  const c = s.polarRadius;
  return 1 / Math.sqrt(((dirFixed.x * dirFixed.x + dirFixed.y * dirFixed.y) / (a * a) + (dirFixed.z * dirFixed.z) / (c * c)) / l2);
}

/** Altitude (m) of a body-fixed position above the reference surface. */
export function altitudeAboveSurface(body: BodyDef, rFixed: Vec3): number {
  return Math.hypot(rFixed.x, rFixed.y, rFixed.z) - surfaceRadius(body, rFixed);
}

/** Largest and smallest reference-surface radius (equatorial and polar radius of a spheroid). */
export function surfaceRadiusRange(body: BodyDef): { min: number; max: number } {
  const s = body.shape;
  if (!s) return { min: body.radius, max: body.radius };
  return { min: Math.min(s.equatorialRadius, s.polarRadius), max: Math.max(s.equatorialRadius, s.polarRadius) };
}

/** True when the body has no solid surface (`surface: 'none'`). */
export const hasNoSurface = (body: BodyDef): boolean => body.surface === 'none';

/**
 * Altitude above the reference surface below which a vessel is destroyed on a body without a surface
 * (`atmosphere.floorAltitude`), or null for a body with a solid surface. A body without a surface must state
 * the floor (checked by createBodySystem).
 */
export function floorAltitude(body: BodyDef): number | null {
  if (!hasNoSurface(body)) return null;
  const f = body.atmosphere?.floorAltitude;
  return typeof f === 'number' && Number.isFinite(f) ? f : null;
}

/**
 * True when a vessel at the body-fixed position `rFixed` is below the floor of a body without a surface (it
 * is destroyed, cause 'overstress'); always false on a body with a solid surface.
 */
export function belowFloor(body: BodyDef, rFixed: Vec3): boolean {
  const f = floorAltitude(body);
  return f !== null && altitudeAboveSurface(body, rFixed) < f;
}

/**
 * The default rails limits as multiples of the body's radius, per rails level from the lowest (5x) to the
 * highest. The first seven reproduce the scale of the shipped Moon's list (no atmosphere: 0, 0.3 %, 0.6 %,
 * 1.4 %, 3.5 %, 29 % and 1.7 radii), the two levels of decision 40 (1,000,000x and 10,000,000x) continue the
 * progression; levels beyond the table repeat the last factor.
 */
export const DEFAULT_WARP_LIMIT_RADII: readonly number[] = [0, 0.003, 0.006, 0.015, 0.035, 0.3, 1.7, 6, 25];

/** Default lowest altitude of rails level k (0 = the lowest rails level): max(atmosphere top, factor x radius). */
export function defaultWarpAltitudeLimit(body: BodyDef, k: number): number {
  const f = DEFAULT_WARP_LIMIT_RADII[Math.min(k, DEFAULT_WARP_LIMIT_RADII.length - 1)]!;
  const top = body.atmosphere ? body.atmosphere.simTop : 0;
  return Math.max(top, f * body.radius);
}

const resolved = new WeakMap<BodyDef, readonly number[]>();

/**
 * The body's rails warp limits, one per rails level (RAILS_LEVELS entries): the stated list, completed by the
 * default for the levels it does not state (each completed entry at least the entry before it), or the
 * default throughout when the body states none. A stated list longer than the table is an error.
 */
export function warpAltitudeLimitsOf(body: BodyDef): readonly number[] {
  const hit = resolved.get(body);
  if (hit) return hit;
  const stated = (body as { warpAltitudeLimits?: readonly number[] }).warpAltitudeLimits ?? [];
  if (stated.length > RAILS_LEVELS) throw new Error(`bodies/${body.id}.json: warpAltitudeLimits has ${stated.length} entries, the warp table has ${RAILS_LEVELS} rails levels`);
  for (const x of stated) if (typeof x !== 'number' || !(x >= 0) || !Number.isFinite(x)) throw new Error(`bodies/${body.id}.json: warpAltitudeLimits entries must be finite altitudes >= 0`);
  const out = stated.slice();
  for (let k = stated.length; k < RAILS_LEVELS; k++) out.push(Math.max(defaultWarpAltitudeLimit(body, k), k > 0 ? out[k - 1]! : 0));
  const frozen = Object.freeze(out);
  resolved.set(body, frozen);
  return frozen;
}
