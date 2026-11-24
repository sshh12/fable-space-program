/**
 * Launch-window maths (docs/research/sim-design.md 15.2) - information for the HUD, never automation.
 *
 * Target plane = the orbit plane of a body that orbits the launch body (unit normal nT at the start of the
 * search: a frozen ellipse does not precess, and a precessing moon turns its plane by degrees per year at most). Pad direction rP(t) rotates with the launch body.
 *
 *  - Coplanar (|latitude| <= target inclination to the launch body's equator): the times where
 *    rP(t) . nT = 0, solved ANALYTICALLY for the uniform rotation W(t) (two per rotation). Required
 *    inertial launch direction dL = normalize(nT x rP) (prograde in the target plane); inertial azimuth
 *    azI = atan2(dL . east, dL . north); 'ascending' = northbound (azI < 90 deg). Surface-relative azimuth
 *    tan(azR) = (v_orb sin azI - v_rot) / (v_orb cos azI), v_orb = circular speed at the parking altitude,
 *    v_rot = |spin x rP|.
 *  - Non-coplanar: launch due east at the time when the resulting orbit plane (normal = local north)
 *    contains the target's position at t + transferTime: root of north(t) . rT_hat(t + T), by scanning and
 *    Brent.
 * `ascentLeadTime` moves the launch earlier than the crossing (default 0).
 */
import type { Readouts } from '../../core/contracts/sim';
import { quat } from '../../core/math/quat';
import { RAD, TWO_PI } from '../../core/math/scalar';
import { v3, type Vec3 } from '../../core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { primeMeridianAngle } from '../bodies/rotation';
import { azimuthOf, enuBasis, fixedPosition } from '../frames/bodyFrames';
import { brentRoot } from '../orbit/roots';
import { transferWindows } from './transfer';

export const DEFAULT_PARKING_ALTITUDE = 185000;
export const DEFAULT_TRANSFER_TIME = 4 * 86400;

export type LaunchWindowKind = 'next' | 'ascending' | 'descending';

export interface LaunchWindowInput {
  system: BodySystem;
  /** Body the pad is on, and the pad's planetocentric latitude / east longitude (rad) and elevation (m). */
  bodyId: string;
  latitude: number;
  longitude: number;
  elevation?: number;
  ut: number;
  /** Body whose orbit plane is targeted; must orbit `bodyId`. */
  targetBodyId: string;
  kind?: LaunchWindowKind;
  parkingAltitude?: number;
  ascentLeadTime?: number;
  transferTime?: number;
}

export interface LaunchWindow {
  coplanar: boolean;
  /** Time the pad crosses the target plane (coplanar) or the due-east plane contains the target (non-coplanar). */
  crossingUt: number;
  /** crossingUt - ascentLeadTime. */
  launchUt: number;
  timeToPlaneCrossing: number;
  /** Inertial and surface-relative launch azimuths, degrees clockwise from north in [0, 360). */
  inertialAzimuthDeg: number;
  launchAzimuthDeg: number;
  /** Northbound (ascending) launch; null in the non-coplanar case. */
  ascending: boolean | null;
}

function padStateRoot(system: BodySystem, bodyId: string, rFixed: Vec3, t: number): { r: Vec3; enu: ReturnType<typeof enuBasis> } {
  const q = system.orientation(bodyId, t);
  const r = quat.rotate(q, rFixed);
  return { r, enu: enuBasis(q, r) };
}

function surfaceAzimuth(azI: number, vOrb: number, vRot: number): number {
  const a = Math.atan2(vOrb * Math.sin(azI) - vRot, vOrb * Math.cos(azI));
  return a < 0 ? a + TWO_PI : a;
}

/** Next launch window after `ut` (launchUt >= ut), or null when the target does not orbit the launch body or it has no uniform rotation. */
export function computeLaunchWindow(input: LaunchWindowInput): LaunchWindow | null {
  const { system, bodyId, ut, targetBodyId } = input;
  const body = system.body(bodyId);
  const target = system.body(targetBodyId);
  if (target.parentId !== bodyId || !target.ephemeris) return null;
  const rot = body.rotation;
  if (rot.kind !== 'uniform' || rot.rate === 0) return null;
  const lead = input.ascentLeadTime ?? 0;
  const kind = input.kind ?? 'next';
  const rPad = body.radius + (input.elevation ?? 0);
  const rFixed = fixedPosition(input.latitude, input.longitude, rPad);
  const vOrb = Math.sqrt(body.mu / (body.radius + (input.parkingAltitude ?? DEFAULT_PARKING_ALTITUDE)));
  const vRot = Math.abs(rot.rate) * Math.hypot(rFixed.x, rFixed.y);
  const nT = target.ephemeris.normalAt(ut);
  const m = quat.rotateInv(rot.qPole, nT);
  const cl = Math.cos(input.latitude);
  const sl = Math.sin(input.latitude);
  const A = cl * Math.hypot(m.x, m.y);
  const tEarliest = ut + lead;
  const period = TWO_PI / Math.abs(rot.rate);

  if (A > 0 && Math.abs(m.z * sl) <= A) {
    // theta = longitude + W solves A cos(theta - phi) = -m.z sin(lat)
    const phi = Math.atan2(m.y, m.x);
    const delta = Math.acos(Math.max(-1, Math.min(1, (-m.z * sl) / A)));
    const W0 = primeMeridianAngle(rot, tEarliest);
    let best: LaunchWindow | null = null;
    // Each root is one node of the plane on the pad's latitude circle; its kind (north- or southbound
    // launch) is the same on every rotation, so the first occurrence of each root is a candidate.
    for (const root of [phi + delta, phi - delta]) {
      const Wt = root - input.longitude;
      let dW = (Wt - W0) * Math.sign(rot.rate);
      dW -= TWO_PI * Math.floor(dW / TWO_PI);
      const tc = tEarliest + dW / Math.abs(rot.rate);
      const { r, enu } = padStateRoot(system, bodyId, rFixed, tc);
      const dL = v3.normalize(v3.cross(nT, v3.normalize(r)));
      const azI = azimuthOf(dL, enu);
      const ascending = v3.dot(dL, enu.north) > 0;
      if (kind === 'ascending' && !ascending) continue;
      if (kind === 'descending' && ascending) continue;
      const w: LaunchWindow = {
        coplanar: true,
        crossingUt: tc,
        launchUt: tc - lead,
        timeToPlaneCrossing: tc - lead - ut,
        inertialAzimuthDeg: azI * RAD,
        launchAzimuthDeg: surfaceAzimuth(azI, vOrb, vRot) * RAD,
        ascending,
      };
      if (!best || w.crossingUt < best.crossingUt) best = w;
    }
    return best;
  }

  // Non-coplanar: due-east launch whose plane contains the target at t + transferTime.
  const T = input.transferTime ?? DEFAULT_TRANSFER_TIME;
  const f = (t: number): number => {
    const { enu } = padStateRoot(system, bodyId, rFixed, t);
    const rt = v3.normalize(system.stateRelParent(targetBodyId, t + T).r);
    return v3.dot(enu.north, rt);
  };
  const step = period / 48;
  let ta = tEarliest;
  let fa = f(ta);
  for (let i = 0; i < 48 * 3; i++) {
    const tb = ta + step;
    const fb = f(tb);
    if (fa === 0 || (fa > 0) !== (fb > 0)) {
      const tc = fa === 0 ? ta : brentRoot(f, ta, tb, 1e-3, fa, fb);
      const azI = Math.PI / 2;
      return {
        coplanar: false,
        crossingUt: tc,
        launchUt: tc - lead,
        timeToPlaneCrossing: tc - lead - ut,
        inertialAzimuthDeg: 90,
        launchAzimuthDeg: surfaceAzimuth(azI, vOrb, vRot) * RAD,
        ascending: null,
      };
    }
    ta = tb;
    fa = fb;
  }
  return null;
}

/** Readouts.launchWindow form (next window of either kind). */
export function launchWindowReadout(input: Omit<LaunchWindowInput, 'kind'>): Readouts['launchWindow'] {
  const w = computeLaunchWindow({ ...input, kind: 'next' });
  return w ? { timeToPlaneCrossing: w.timeToPlaneCrossing, launchAzimuthDeg: w.launchAzimuthDeg } : null;
}

/** Angle (rad) of a body-fixed point above (+) / below (-) the target body's orbit plane at time t. */
export function angleFromTargetPlane(system: BodySystem, bodyId: string, rFixed: Vec3, targetBodyId: string, t: number): number {
  const target = system.body(targetBodyId);
  if (!target.ephemeris) throw new Error(`angleFromTargetPlane: ${targetBodyId} has no orbit`);
  const r = quat.rotate(system.orientation(bodyId, t), rFixed);
  return Math.asin(Math.max(-1, Math.min(1, v3.dot(v3.normalize(r), target.ephemeris.normalAt(t)))));
}

/** A launch opportunity from a pad toward a target (the contract's `LaunchWindow`, session.ts). */
export interface PadLaunchWindow {
  /** Launch instant, s: the pad's plane crossing (a body orbiting the pad's body) or the departure of the transfer window. */
  ut: number;
  /** Surface-relative launch azimuth, degrees clockwise from north. */
  azimuthDeg: number;
  /** Inclination of the plane launched into against the plane wanted, rad (0 for a coplanar crossing). */
  relativeInclination: number;
  /** Phase angle of the target at `ut`, rad: ahead of the pad in the target's plane (a body orbiting the pad's body), or of the transfer (interplanetary). */
  phaseAngle: number;
}

/**
 * Launch windows from a pad toward a target body between two times (PlanningService.launchWindows):
 *  - a body that orbits the pad's body (a moon): every crossing of its orbit plane by the pad (both kinds),
 *    with the launch azimuth into that plane; out of reach of the pad's latitude, the due-east launches when
 *    the target is in the launch plane after the transfer time, with the plane's relative inclination;
 *  - a body about the pad body's parent, or a moon of one: the transfer windows (one per synodic period,
 *    src/sim/nav/transfer.ts), each launched into the plane that holds the pad and the departure asymptote.
 * Other targets have no window from this pad (an empty list).
 */
export function launchWindowsForPad(
  system: BodySystem,
  pad: { bodyId: string; latitude: number; longitude: number; elevation: number },
  targetBodyId: string,
  fromUt: number,
  toUt: number,
  opts: { parkingAltitude?: number; maxCount?: number } = {},
): PadLaunchWindow[] {
  const maxCount = opts.maxCount ?? 64;
  const out: PadLaunchWindow[] = [];
  const body = system.body(pad.bodyId);
  const target = system.body(targetBodyId);
  const rFixed = fixedPosition(pad.latitude, pad.longitude, body.radius + pad.elevation);
  if (target.parentId === pad.bodyId) {
    let t = fromUt;
    while (t < toUt && out.length < maxCount) {
      const w = computeLaunchWindow({ system, bodyId: pad.bodyId, latitude: pad.latitude, longitude: pad.longitude, elevation: pad.elevation, ut: t, targetBodyId, kind: 'next', ...(opts.parkingAltitude !== undefined ? { parkingAltitude: opts.parkingAltitude } : {}) });
      if (!w || w.launchUt >= toUt) break;
      const nT = target.ephemeris!.normalAt(w.launchUt);
      const { r, enu } = padStateRoot(system, pad.bodyId, rFixed, w.launchUt);
      const relInc = w.coplanar ? 0 : Math.acos(Math.max(-1, Math.min(1, v3.dot(enu.north, nT))));
      const rt = system.stateRelParent(targetBodyId, w.launchUt).r;
      const rp = v3.reject(r, nT);
      const phase = Math.atan2(v3.dot(v3.cross(rp, rt), nT), v3.dot(rp, rt));
      out.push({ ut: w.launchUt, azimuthDeg: w.launchAzimuthDeg, relativeInclination: relInc, phaseAngle: phase });
      t = w.launchUt + 60;
    }
    return out;
  }
  const parent = body.parentId;
  const planetId = target.parentId === parent ? targetBodyId : target.parentId;
  if (parent === null || planetId === null || system.body(planetId).parentId !== parent) return out;
  const rot = body.rotation;
  const vOrb = Math.sqrt(body.mu / (body.radius + (opts.parkingAltitude ?? DEFAULT_PARKING_ALTITUDE)));
  const vRot = rot.kind === 'uniform' ? Math.abs(rot.rate) * Math.hypot(rFixed.x, rFixed.y) : 0;
  for (const arc of transferWindows(system, pad.bodyId, planetId, fromUt, toUt)) {
    if (out.length >= maxCount) break;
    const { r, enu } = padStateRoot(system, pad.bodyId, rFixed, arc.departUt);
    const up = v3.normalize(r);
    const along = v3.reject(arc.vInfDepart, up);
    const dL = v3.len(along) > 0 ? v3.normalize(along) : enu.east;
    const azI = azimuthOf(dL, enu);
    const planeNormal = v3.normalize(v3.cross(up, dL));
    const relInc = Math.acos(Math.max(-1, Math.min(1, v3.dot(planeNormal, enu.north))));
    out.push({ ut: arc.departUt, azimuthDeg: surfaceAzimuth(azI, vOrb, vRot) * RAD, relativeInclination: relInc, phaseAngle: arc.phaseAngle });
  }
  return out;
}
