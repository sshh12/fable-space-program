/**
 * The menu's camera paths (ARCHITECTURE 20, 23; frontend-ux 3.2, 5.11), as pure functions of the body's pose and
 * the site, so that they run alike in the app, a lab and a unit test.
 *
 *   menuEye       a spectator eye above the dawn terminator of a body: fixed against the body-sun line (not on a
 *                 Kepler orbit, so the composition holds at any time), drifting slowly (yaw and breathing).
 *   transitPath   the menu-to-pad flight: computed in float64 in the SITE BODY'S FIXED FRAME (the pad turns with
 *                 the body; an inertial path would leave it behind), log altitude from the eye to the pad, with a
 *                 hold at `holdAltitude` while a gate is open (a slow orbit of the pad, never a stall), and an
 *                 exposure hint that walks from the eye's exposure to the pad's over the lower part of the path,
 *                 so the meter has nothing left to catch up at the hand-over.
 *
 * Frames: positions are ROOT metres unless a name says `Fixed` (body-fixed, from the body's centre); the body's
 * `qFixedToRoot` and `rRoot` come from the frame's snapshot.
 */
import type { BodySnapshot } from '@/core/contracts/sim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { quat, type Quat } from '@/core/math/quat';
import { clamp, DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';

export interface EyePose {
  positionRoot: Vec3;
  /** View-to-ROOT orientation (the camera looks along its -Z, up is +Y). */
  qViewToRoot: Quat;
}

/** A view-to-ROOT rotation looking from `eye` at `target` with `up` as the screen's up. */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Quat {
  const f = v3.normalize(v3.sub(target, eye));
  let r = v3.cross(f, up);
  if (v3.len(r) < 1e-9) r = v3.anyOrthogonal(f);
  r = v3.normalize(r);
  const u = v3.cross(r, f);
  // Columns of the view basis in ROOT: x = r, y = u, z = -f.
  return quat.fromBasis(r, u, v3.scale(f, -1));
}

export interface MenuEyeOptions {
  /** Altitude of the eye above the body's surface radius, m. */
  altitude: number;
  /** How far the sun stands behind the limb as seen from the eye, deg (rim light). */
  sunBehindLimbDeg: number;
  /** Seconds since the menu began (the drift), and whether the drift runs (reduced motion stops it). */
  t: number;
  drift: boolean;
}

/** The menu eye above the dawn terminator of `body` (radius `radius`), looking at the limb with the sun just behind it. */
export function menuEye(body: Pick<BodySnapshot, 'rRoot' | 'sunDir' | 'spinRoot'>, radius: number, opts: MenuEyeOptions): EyePose {
  const sun = v3.normalize(body.sunDir);
  const spin = v3.len(body.spinRoot) > 0 ? v3.normalize(body.spinRoot) : v3.new(0, 0, 1);
  // The dawn side: the terminator point that the spin carries into sunlight (east of the night, toward the sun).
  let dawn = v3.normalize(v3.cross(spin, sun));
  if (v3.len(dawn) < 1e-9) dawn = v3.anyOrthogonal(sun);
  dawn = v3.scale(dawn, -1);
  const yaw = opts.drift ? 0.2 * DEG * opts.t : 0;
  const breathe = opts.drift ? 1 + 0.03 * Math.sin((2 * Math.PI * opts.t) / 40) : 1;
  const r = radius + opts.altitude * breathe;
  // Stand over the night side, as far from the terminator as the horizon's depression plus the sun's offset, so
  // the sun sits just behind the limb ahead: the sunrise arc, the airglow and the night side's lights.
  const dip0 = Math.acos(clamp(radius / r, -1, 1));
  const back = dip0 + opts.sunBehindLimbDeg * DEG;
  const up0 = v3.normalize(v3.add(v3.scale(dawn, Math.cos(back)), v3.scale(sun, -Math.sin(back))));
  const up = quat.rotate(quat.fromAxisAngle(dawn, yaw), up0);
  const eyeRel = v3.scale(up, r);
  // Look toward the limb on the sun's side, raised above the horizon so the limb sits in the lower part of the frame.
  const toSun = v3.normalize(v3.reject(sun, up));
  const dip = Math.acos(clamp(radius / r, -1, 1));
  const lift = 14 * DEG;
  const dir = v3.normalize(v3.add(v3.scale(toSun, Math.cos(dip - lift)), v3.scale(up, -Math.sin(dip - lift))));
  const positionRoot = v3.add(body.rRoot, eyeRel);
  return { positionRoot, qViewToRoot: lookAt(positionRoot, v3.add(positionRoot, dir), up) };
}

export interface TransitPlan {
  /** Body radius at the pad (surface), m. */
  radius: number;
  /** Pad latitude and longitude, deg, and the pad surface's height above `radius`, m. */
  padLatDeg: number;
  padLonDeg: number;
  padHeight: number;
  /** Where the flight starts, body-fixed (m from the body's centre). */
  startFixed: Vec3;
  /** Final camera offset from the pad, in the pad's east/north/up, m (the chase rig's starting pose). */
  endOffsetEnu: Vec3;
  /** Altitude of the holding drift above the pad, m (ARCHITECTURE 23: 3 km). */
  holdAltitude: number;
  /** Exposure at the start (the eye's) and at the pad, EV100. */
  startEv: number;
  padEv: number;
  /** Length of the whole path at normal speed, s. */
  duration: number;
}

/** East, north and up of a point at (lat, lon), body-fixed. */
function enuFixed(latDeg: number, lonDeg: number): { e: Vec3; n: Vec3; u: Vec3 } {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const u = latLonToDir(lat, lon);
  const e = v3.new(-Math.sin(lon), Math.cos(lon), 0);
  const n = v3.cross(u, e);
  return { e, n, u };
}

const smooth = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * t * (t * (6 * t - 15) + 10);
};

/** Progress 0..1 along the path at which the camera stands at the holding altitude. */
export function holdProgress(plan: TransitPlan): number {
  const { h0, h1 } = altitudes(plan);
  const hHold = Math.max(plan.holdAltitude, h1);
  // The altitude follows h(u) = h0 (h1 / h0)^s(u); invert s(u) = log(hHold / h0) / log(h1 / h0) by bisection.
  const target = Math.log(hHold / h0) / Math.log(h1 / h0);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (lo + hi);
    if (easeAlt(mid) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function altitudes(plan: TransitPlan): { h0: number; h1: number } {
  const padR = plan.radius + plan.padHeight;
  const h0 = Math.max(1, v3.len(plan.startFixed) - padR);
  const h1 = Math.max(1, plan.endOffsetEnu.z);
  return { h0, h1 };
}

/** Altitude progress: an eased start and a slower middle (the cloud deck), as log-altitude fraction 0..1. */
const easeAlt = (u: number): number => smooth(u);

export interface TransitSample {
  /** Body-fixed camera position and the point it looks at, m. */
  positionFixed: Vec3;
  targetFixed: Vec3;
  upFixed: Vec3;
  /** Altitude above the pad surface, m. */
  altitude: number;
  /** The exposure hint for this point: EV100 to head for and the rate to get there, EV per second. */
  exposureHint: { targetEv100: number; rateEvPerS: number };
}

/**
 * The camera at progress `u` (0..1) of the path, body-fixed. `holdAngle` (rad) turns the camera about the pad's
 * up axis during the holding drift (0 outside it).
 */
export function transitSample(plan: TransitPlan, u: number, holdAngle = 0): TransitSample {
  const { h0, h1 } = altitudes(plan);
  const s = easeAlt(u);
  const altitude = h0 * Math.pow(h1 / h0, s);
  const pad = enuFixed(plan.padLatDeg, plan.padLonDeg);
  const padR = plan.radius + plan.padHeight;
  const padFixed = v3.scale(pad.u, padR);
  const startDir = v3.normalize(plan.startFixed);
  // The ground track closes in as the altitude falls (fraction of the log descent), so the pad stays ahead.
  const f = smooth(clamp(s * 1.15, 0, 1));
  const angle = Math.acos(clamp(v3.dot(startDir, pad.u), -1, 1));
  let dir: Vec3;
  if (angle < 1e-9) dir = pad.u;
  else {
    const axis = v3.normalize(v3.cross(startDir, pad.u));
    dir = quat.rotate(quat.fromAxisAngle(axis, angle * f), startDir);
  }
  // Near the pad the camera moves onto the chase pose's bearing (east/north offset), turned by the hold angle.
  const near = smooth((Math.log(h0) - Math.log(altitude)) / (Math.log(h0) - Math.log(h1)) * 1.6 - 0.6);
  const offset = v3.add(v3.scale(pad.e, plan.endOffsetEnu.x * near), v3.scale(pad.n, plan.endOffsetEnu.y * near));
  const turned = holdAngle !== 0 ? quat.rotate(quat.fromAxisAngle(pad.u, holdAngle), offset) : offset;
  const over = v3.add(v3.scale(dir, padR + altitude), turned);
  // Look ahead at the pad; high up, at a point ahead on the track so the horizon stays in frame.
  const look = v3.add(padFixed, v3.scale(pad.u, altitude * 0.15));
  const up = v3.normalize(over);
  // Exposure: the eye's EV until 100 km, then toward the pad's prior, reaching it at the end of the path.
  const w = smooth((Math.log(Math.max(h1 * 1.0001, 1e5)) - Math.log(Math.min(altitude, 1e5))) / (Math.log(Math.max(h1 * 1.0001, 1e5)) - Math.log(h1)));
  const targetEv100 = plan.startEv + (plan.padEv - plan.startEv) * w;
  const rateEvPerS = Math.max(0.5, (Math.abs(plan.padEv - plan.startEv) / Math.max(plan.duration, 1e-3)) * 4);
  return { positionFixed: over, targetFixed: look, upFixed: up, altitude, exposureHint: { targetEv100, rateEvPerS } };
}

/** A body-fixed point to ROOT, with the body's pose of the frame. */
export const fixedToRoot = (body: Pick<BodySnapshot, 'rRoot' | 'qFixedToRoot'>, p: Vec3): Vec3 => v3.add(body.rRoot, quat.rotate(body.qFixedToRoot, p));
/** A ROOT point to body-fixed. */
export const rootToFixed = (body: Pick<BodySnapshot, 'rRoot' | 'qFixedToRoot'>, p: Vec3): Vec3 => quat.rotateInv(body.qFixedToRoot, v3.sub(p, body.rRoot));

/** The eye pose of a transit sample in ROOT, for this frame's body pose. */
export function transitPose(body: Pick<BodySnapshot, 'rRoot' | 'qFixedToRoot'>, sample: TransitSample): EyePose {
  const positionRoot = fixedToRoot(body, sample.positionFixed);
  const target = fixedToRoot(body, sample.targetFixed);
  const up = quat.rotate(body.qFixedToRoot, sample.upFixed);
  return { positionRoot, qViewToRoot: lookAt(positionRoot, target, up) };
}
