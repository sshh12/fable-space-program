/**
 * Geometry the scripted pilot works out from what the HUD and the map show (snapshot bodies, patches and
 * readouts): positions on conics at a time, body orientation a little ahead, great circles on a body.
 * Pure functions of their arguments; the pilot never reads simulation internals.
 */
import type { BodySnapshot, Patch } from '@/core/contracts/sim';
import { conicPosition, conicVelocity, type ConicElements } from '@/core/math/conic';
import { quat, type Quat } from '@/core/math/quat';
import { TWO_PI } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';

export interface State {
  r: Vec3;
  v: Vec3;
}

/** True anomaly on a (non-radial) conic at time t. */
export function trueAnomalyAtTime(c: ConicElements, t: number): number {
  const e = c.e;
  const dt = t - c.tPeriapsis;
  if (c.period !== null) {
    // Elliptic: Kepler's equation by Newton from a good start.
    let M = (TWO_PI * dt) / c.period;
    M -= TWO_PI * Math.round(M / TWO_PI);
    let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
    for (let i = 0; i < 50; i++) {
      const f = E - e * Math.sin(E) - M;
      const d = f / (1 - e * Math.cos(E));
      E -= d;
      if (Math.abs(d) < 1e-14) break;
    }
    return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  }
  if (e > 1 && Number.isFinite(c.a)) {
    const a = -c.a;
    const N = Math.sqrt(c.mu / (a * a * a)) * dt;
    let H = Math.asinh(N / e);
    for (let i = 0; i < 80; i++) {
      const f = e * Math.sinh(H) - H - N;
      const d = f / (e * Math.cosh(H) - 1);
      H -= d;
      if (Math.abs(d) < 1e-14 * Math.max(1, Math.abs(H))) break;
    }
    return 2 * Math.atan2(Math.sqrt(e + 1) * Math.sinh(H / 2), Math.sqrt(e - 1) * Math.cosh(H / 2));
  }
  // Parabolic: Barker's equation.
  const B = 3 * Math.sqrt(c.mu / (c.p * c.p * c.p)) * dt;
  const y = Math.cbrt(B + Math.sqrt(B * B + 1));
  return 2 * Math.atan(y - 1 / y);
}

/** State on a conic at time t (BCI of its central body). */
export function conicStateAt(c: ConicElements, t: number): State {
  const nu = trueAnomalyAtTime(c, t);
  return { r: conicPosition(c, nu), v: conicVelocity(c, nu) };
}

/** State of a body about its parent at time t from the orbit conic of its snapshot. */
export function bodyStateAt(body: BodySnapshot, t: number): State {
  if (!body.orbit) return { r: v3.zero(), v: v3.zero() };
  return conicStateAt(body.orbit, t);
}

/** BCBF -> ROOT orientation of a uniformly rotating body at time t, from its snapshot taken at `ut`. */
export function orientationAt(body: BodySnapshot, ut: number, t: number): Quat {
  const s = body.spinRoot;
  const dt = t - ut;
  return quat.normalize(quat.mul(quat.fromRotVec({ x: s.x * dt, y: s.y * dt, z: s.z * dt }), body.qFixedToRoot));
}

export function dirFromLatLon(latitude: number, longitude: number): Vec3 {
  const c = Math.cos(latitude);
  return { x: c * Math.cos(longitude), y: c * Math.sin(longitude), z: Math.sin(latitude) };
}

export function latLonOfDir(d: Vec3): { latitude: number; longitude: number } {
  return { latitude: Math.atan2(d.z, Math.hypot(d.x, d.y)), longitude: Math.atan2(d.y, d.x) };
}

/** East / north / up at a position, for a spin axis `pole` in the same frame. */
export function horizonBasis(r: Vec3, pole: Vec3): { east: Vec3; north: Vec3; up: Vec3 } {
  const up = v3.normalize(r);
  let east = v3.cross(pole, up);
  east = v3.len(east) > 1e-12 ? v3.normalize(east) : v3.anyOrthogonal(up);
  return { east, north: v3.cross(up, east), up };
}

/** Unit direction of a pitch above the horizon and a compass azimuth (rad) in a horizon basis. */
export function directionOf(pitch: number, azimuth: number, b: { east: Vec3; north: Vec3; up: Vec3 }): Vec3 {
  const ch = Math.cos(pitch);
  return v3.add(v3.scale(b.up, Math.sin(pitch)), v3.add(v3.scale(b.east, ch * Math.sin(azimuth)), v3.scale(b.north, ch * Math.cos(azimuth))));
}

/** Central angle between two unit directions, rad. */
export const arc = (a: Vec3, b: Vec3): number => v3.angle(a, b);

/** Point reached from unit direction `from` after travelling the central angle `angle` along the unit tangent `along`. */
export function travel(from: Vec3, along: Vec3, angle: number): Vec3 {
  const t = v3.normalize(v3.reject(along, from));
  return v3.normalize(v3.add(v3.scale(from, Math.cos(angle)), v3.scale(t, Math.sin(angle))));
}

/** Compass bearing (rad, clockwise from north) from one body-fixed direction to another. */
export function bearing(from: Vec3, to: Vec3): number {
  const b = horizonBasis(from, { x: 0, y: 0, z: 1 });
  const t = v3.reject(to, b.up);
  return Math.atan2(v3.dot(t, b.east), v3.dot(t, b.north));
}

/** First patch of a list about `bodyId`, or undefined. */
export function patchAbout(patches: readonly Patch[], bodyId: string, from = 0): Patch | undefined {
  for (let i = from; i < patches.length; i++) if (patches[i]!.bodyId === bodyId) return patches[i];
  return undefined;
}

/** Periapsis radius of a conic. */
export const periapsisRadius = (c: ConicElements): number => c.p / (1 + c.e);

/** Smallest signed difference a - b of two angles, in (-pi, pi]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d <= -Math.PI) d += TWO_PI;
  return d;
}

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
