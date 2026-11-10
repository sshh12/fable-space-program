/**
 * Shared float64 helpers for the camera rigs: snapshot lookups, view orientation, frames and the blend curve.
 */
import type { BodyDef, DefLibrary } from '@/core/contracts/defs';
import type { CameraInput, CameraState, ViewKind } from '@/core/contracts/render';
import type { BodySnapshot, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { quat, type Quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';

/** A rig that also states its view kind up front (all rigs of this package do). */
export interface FlightCameraRig {
  readonly mode: string;
  readonly kind: ViewKind;
  activate(from: CameraState | null, snapshot: SimSnapshot): void;
  update(snapshot: SimSnapshot, input: CameraInput, realDt: number): CameraState;
  /** False when the rig cannot produce a view for this snapshot (e.g. the active vessel has no cockpit). */
  isAvailable(snapshot: SimSnapshot): boolean;
}

export function activeVessel(s: SimSnapshot): VesselSnapshot {
  const v = s.vessels.find((x) => x.id === s.activeVesselId);
  if (!v) throw new Error(`snapshot has no active vessel ${s.activeVesselId}`);
  return v;
}

export function bodyById(s: SimSnapshot, id: string): BodySnapshot {
  const b = s.bodies.find((x) => x.id === id);
  if (!b) throw new Error(`snapshot has no body ${id}`);
  return b;
}

export function bodyDef(defs: DefLibrary, id: string): BodyDef {
  const b = defs.bodies[id];
  if (!b) throw new Error(`no body definition ${id}`);
  return b;
}

/** Vessel centre of mass in the ROOT frame. */
export function vesselComRoot(v: VesselSnapshot): Vec3 {
  return v3.add(v.rRoot, quat.rotate(v.q, v.comLocal));
}

/**
 * View -> ROOT orientation for a camera looking along `forward` with `up` as the screen-up hint
 * (view space: +X right, +Y up, looking down -Z). `up` is orthogonalised; a degenerate hint falls back to any
 * perpendicular axis so the result is always a valid rotation.
 */
export function lookRotation(forward: Vec3, up: Vec3): Quat {
  const z = v3.neg(v3.normalize(forward));
  let x = v3.cross(up, z);
  if (v3.len(x) < 1e-9) x = v3.anyOrthogonal(z);
  x = v3.normalize(x);
  const y = v3.cross(z, x);
  return quat.fromBasis(x, y, z);
}

/** Forward (-Z) and up (+Y) of a view orientation, ROOT axes. */
export const viewForward = (q: Quat): Vec3 => quat.rotate(q, { x: 0, y: 0, z: -1 });
export const viewUp = (q: Quat): Vec3 => quat.rotate(q, { x: 0, y: 1, z: 0 });

/**
 * Smooth transition 0 -> 1 on [0, 1] whose derivatives of every order vanish at both ends (the classic
 * C-infinity bump construction). A blend driven by it starts and ends without any step in position,
 * velocity or acceleration.
 */
export function smoothBlend(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const a = Math.exp(-1 / t);
  const b = Math.exp(-1 / (1 - t));
  return a / (a + b);
}

/** Spherical interpolation of unit vectors (robust for nearly opposite inputs). */
export function slerpDir(a: Vec3, b: Vec3, t: number): Vec3 {
  const d = Math.max(-1, Math.min(1, v3.dot(a, b)));
  if (d > 1 - 1e-12) return v3.normalize(v3.lerp(a, b, t));
  let axis = v3.cross(a, b);
  if (v3.len(axis) < 1e-12) axis = v3.anyOrthogonal(a);
  const angle = Math.acos(d);
  return v3.normalize(quat.rotate(quat.fromAxisAngle(axis, angle * t), a));
}

/** Local east/north/up basis at a body-centred position (ROOT axes; up = geocentric radial). */
export function enuAt(rRel: Vec3, qFixedToRoot: Quat): { e: Vec3; n: Vec3; u: Vec3 } {
  const u = v3.normalize(rRel);
  const pole = quat.rotate(qFixedToRoot, v3.unitZ());
  let e = v3.cross(pole, u);
  if (v3.len(e) < 1e-9) e = v3.anyOrthogonal(u);
  e = v3.normalize(e);
  return { e, n: v3.cross(u, e), u };
}

/** Exponential approach factor for a time constant `tau` over `dt`. */
export const approach = (dt: number, tau: number): number => (tau <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dt) / tau));

export const ZERO_CAMERA_INPUT = Object.freeze({ yaw: 0, pitch: 0, zoom: 1 });
