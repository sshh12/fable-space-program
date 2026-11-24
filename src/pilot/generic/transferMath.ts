/**
 * The arithmetic of the generic transfer pilot (src/pilot/generic/transfer.ts), from what a player sees: the
 * bodies' states and orbits in the snapshot. Patched conics between two bodies about one parent; Hohmann
 * transfers between the mean orbits; the hyperbolic ejection from a parking orbit. The pilot imports src/core
 * only (ARCHITECTURE 2), so this is its own copy of these few formulas, not the planner of src/sim/nav.
 */
import type { BodySnapshot } from '@/core/contracts/sim';
import { v3, type Vec3 } from '@/core/math/vec3';

const TWO_PI = 2 * Math.PI;
export const wrap2pi = (x: number): number => ((x % TWO_PI) + TWO_PI) % TWO_PI;

/** Position and velocity of `body` relative to `parent` (both from the snapshot, ROOT axes). */
export function relativeTo(body: BodySnapshot, parent: BodySnapshot): { r: Vec3; v: Vec3 } {
  return { r: v3.sub(body.rRoot, parent.rRoot), v: v3.sub(body.vRoot, parent.vRoot) };
}

/** Mean motion (rad/s) and mean orbit radius of a body about its parent, from its orbit in the snapshot (or its state). */
export function meanOrbit(body: BodySnapshot, parent: BodySnapshot, muParent: number): { n: number; a: number } {
  const c = body.orbit;
  if (c && c.e < 1 && c.a > 0) return { n: Math.sqrt(muParent / (c.a * c.a * c.a)), a: c.a };
  const s = relativeTo(body, parent);
  const r = v3.len(s.r);
  return { n: Math.sqrt(muParent / (r * r * r)), a: r };
}

/** Phase angle of `to` ahead of `from` about their common parent, in `from`'s orbit plane, rad (-pi, pi]. */
export function phaseAngle(from: BodySnapshot, to: BodySnapshot, parent: BodySnapshot): number {
  const a = relativeTo(from, parent);
  const b = relativeTo(to, parent).r;
  const n = v3.normalize(v3.cross(a.r, a.v));
  const bp = v3.reject(b, n);
  return Math.atan2(v3.dot(v3.cross(a.r, bp), n), v3.dot(a.r, bp));
}

/** Hohmann transfer between circular orbits r1 -> r2 about mu: time of flight, the phase the target must lead by, the excess speeds. */
export function hohmann(mu: number, r1: number, r2: number): { tof: number; phase: number; vInfDepart: number; vInfArrive: number } {
  const a = (r1 + r2) / 2;
  const tof = Math.PI * Math.sqrt((a * a * a) / mu);
  const n2 = Math.sqrt(mu / (r2 * r2 * r2));
  return {
    tof,
    phase: Math.PI - n2 * tof,
    // signed: positive = faster than the departure body (an outward transfer)
    vInfDepart: Math.sqrt(mu / r1) * (Math.sqrt(r2 / a) - 1),
    vInfArrive: Math.sqrt(mu / r2) * (1 - Math.sqrt(r1 / a)),
  };
}

/**
 * Seconds until the phase angle reaches the Hohmann value (the next window), from the present phase and the two
 * mean motions (the phase changes at n_to - n_from).
 */
export function timeToWindow(phaseNow: number, phaseWanted: number, nFrom: number, nTo: number): number {
  const rate = nTo - nFrom;
  return rate < 0 ? wrap2pi(phaseNow - phaseWanted) / -rate : wrap2pi(phaseWanted - phaseNow) / rate;
}

/** Speed change at radius r (circular orbit) to leave on a hyperbola of excess speed vinf. */
export const ejectionDeltaV = (mu: number, r: number, vinf: number): number => Math.sqrt(vinf * vinf + (2 * mu) / r) - Math.sqrt(mu / r);

/**
 * Direction of the ejection burn in a circular parking orbit of normal `h` (unit) for an outgoing asymptote
 * along `asymptote` (projected into the orbit plane): the periapsis of the hyperbola lies the true anomaly of
 * the asymptote, acos(-1/e), behind it, against the direction of motion.
 */
export function ejectionPoint(mu: number, r: number, vinf: number, asymptote: Vec3, h: Vec3): Vec3 {
  const e = 1 + (r * vinf * vinf) / mu;
  const nuInf = Math.acos(-1 / e);
  const a = v3.normalize(v3.reject(asymptote, h));
  // rotate a about h by -nuInf
  const b = v3.cross(h, a);
  return v3.add(v3.scale(a, Math.cos(nuInf)), v3.scale(b, -Math.sin(nuInf)));
}

/** Seconds until a circular orbit (position r, velocity v about mu) reaches the direction `dir` (in its plane). */
export function timeToDirection(mu: number, r: Vec3, v: Vec3, dir: Vec3): number {
  const h = v3.normalize(v3.cross(r, v));
  const rm = v3.len(r);
  const n = Math.sqrt(mu / (rm * rm * rm));
  const d = v3.normalize(v3.reject(dir, h));
  const ang = Math.atan2(v3.dot(v3.cross(r, d), h), v3.dot(r, d));
  return wrap2pi(ang) / n;
}

/**
 * Speed change at periapsis rp of a hyperbola of semi-major axis aHyp (< 0) about mu to stay in the bound ellipse
 * of periapsis rp and apoapsis ra (the capture burn, retrograde).
 */
export function captureDeltaV(mu: number, aHyp: number, rp: number, ra: number): number {
  const vHyp = Math.sqrt(mu * (2 / rp - 1 / aHyp));
  const vEll = Math.sqrt(mu * (2 / rp - 2 / (rp + ra)));
  return vHyp - vEll;
}
