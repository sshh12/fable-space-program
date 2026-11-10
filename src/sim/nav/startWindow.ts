/**
 * Scenario start-time constraints (docs/research/sim-design.md 15.3), used by tools/sim/findStartTime.ts
 * and re-asserted by tests for any scenario:
 *   (a) a coplanar, ascending-azimuth (northbound) launch opportunity into the target body's orbit plane
 *       opens `launchDelay` (600 s) +/- `launchDelayTolerance` (30 s) after the start;
 *   (b) the Sun is `padSunElevationDeg` (10-35 deg) above the pad horizon at the start and rising (morning);
 *   (c) from start + 3 d to start + 5 d the Sun at the landing target stays within
 *       `landingSunElevationDeg` (5-35 deg), rises throughout, and its disc is fully visible (no eclipse).
 * Elevations are geocentric (planetocentric vertical) and measured from the surface point itself.
 */
import { quat } from '../../core/math/quat';
import { DEG, RAD } from '../../core/math/scalar';
import { v3 } from '../../core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { fixedPosition } from '../frames/bodyFrames';
import { computeLaunchWindow } from './launchWindow';

export interface SurfacePoint {
  bodyId: string;
  /** Planetocentric latitude / east longitude, rad; elevation above the reference radius, m. */
  latitude: number;
  longitude: number;
  elevation: number;
}

export interface StartConstraintOptions {
  launchDelay?: number;
  launchDelayTolerance?: number;
  padSunElevationDeg?: readonly [number, number];
  /** Landing-stay window after the start, s. */
  landingWindow?: readonly [number, number];
  landingSunElevationDeg?: readonly [number, number];
  /** Sampling step inside the landing window, s. */
  sampleStep?: number;
  /** Parking altitude for the launch azimuth, m. */
  parkingAltitude?: number;
}

export const START_CONSTRAINT_DEFAULTS = {
  launchDelay: 600,
  launchDelayTolerance: 30,
  padSunElevationDeg: [10, 35] as const,
  landingWindow: [3 * 86400, 5 * 86400] as const,
  landingSunElevationDeg: [5, 35] as const,
  sampleStep: 600,
};

export interface SunAtPoint {
  /** Elevation above the local (planetocentric) horizon, rad, and its rate, rad/s. */
  elevation: number;
  rate: number;
  /** Visible fraction of the solar disc at the point (eclipses). */
  visibility: number;
}

function elevationOnly(system: BodySystem, p: SurfacePoint, ut: number): { elev: number; posRoot: ReturnType<typeof v3.zero>; up: ReturnType<typeof v3.zero> } {
  const body = system.body(p.bodyId);
  const rFixed = fixedPosition(p.latitude, p.longitude, body.radius + p.elevation);
  const rInertial = quat.rotate(system.orientation(p.bodyId, ut), rFixed);
  const posRoot = v3.add(system.stateRoot(p.bodyId, ut).r, rInertial);
  const up = v3.normalize(rInertial);
  const s = system.sunDirection(posRoot, ut);
  return { elev: Math.asin(Math.max(-1, Math.min(1, v3.dot(up, s.dir)))), posRoot, up };
}

/** Sun elevation, its rate (central difference over +/- 30 s) and disc visibility at a surface point. */
export function sunAtSurfacePoint(system: BodySystem, p: SurfacePoint, ut: number): SunAtPoint {
  const now = elevationOnly(system, p, ut);
  const a = elevationOnly(system, p, ut - 30).elev;
  const b = elevationOnly(system, p, ut + 30).elev;
  const visibility = system.sunVisibility(v3.addScaled(now.posRoot, now.up, 2), ut);
  return { elevation: now.elev, rate: (b - a) / 60, visibility };
}

export interface StartConstraintReport {
  ok: boolean;
  launch: {
    ok: boolean;
    crossingUt: number | null;
    /** crossingUt - startUt, s. */
    delay: number | null;
    launchAzimuthDeg: number | null;
    inertialAzimuthDeg: number | null;
  };
  padSun: { ok: boolean; elevationDeg: number; rising: boolean; elevationAtLaunchDeg: number | null };
  landingSun: {
    ok: boolean;
    startDeg: number;
    endDeg: number;
    minDeg: number;
    maxDeg: number;
    rising: boolean;
    lit: boolean;
    minVisibility: number;
  };
}

/** Pad Sun constraint (b) only (cheap pre-filter for searches). */
export function padSunOk(system: BodySystem, site: SurfacePoint, startUt: number, range: readonly [number, number] = START_CONSTRAINT_DEFAULTS.padSunElevationDeg): boolean {
  const s = sunAtSurfacePoint(system, site, startUt);
  const e = s.elevation * RAD;
  return e >= range[0] && e <= range[1] && s.rate > 0;
}

/** Evaluate the three start constraints for `startUt`. */
export function checkStartConstraints(
  system: BodySystem,
  site: SurfacePoint,
  targetBodyId: string,
  landing: Omit<SurfacePoint, 'elevation'> & { elevation?: number },
  startUt: number,
  options: StartConstraintOptions = {},
): StartConstraintReport {
  const o = { ...START_CONSTRAINT_DEFAULTS, ...options };
  // (a) launch opportunity
  const w = computeLaunchWindow({
    system,
    bodyId: site.bodyId,
    latitude: site.latitude,
    longitude: site.longitude,
    elevation: site.elevation,
    ut: startUt,
    targetBodyId,
    kind: 'ascending',
    ...(options.parkingAltitude !== undefined ? { parkingAltitude: options.parkingAltitude } : {}),
  });
  const coplanar = w !== null && w.coplanar;
  const delay = w ? w.crossingUt - startUt : null;
  const launchOk = coplanar && delay !== null && Math.abs(delay - o.launchDelay) <= o.launchDelayTolerance;
  // (b) pad Sun
  const pad = sunAtSurfacePoint(system, site, startUt);
  const padDeg = pad.elevation * RAD;
  const padOk = padDeg >= o.padSunElevationDeg[0] && padDeg <= o.padSunElevationDeg[1] && pad.rate > 0;
  const padAtLaunch = w ? sunAtSurfacePoint(system, site, w.crossingUt).elevation * RAD : null;
  // (c) landing-site Sun over the stay
  const lp: SurfacePoint = { bodyId: landing.bodyId, latitude: landing.latitude, longitude: landing.longitude, elevation: landing.elevation ?? 0 };
  const t0 = startUt + o.landingWindow[0];
  const t1 = startUt + o.landingWindow[1];
  const n = Math.max(1, Math.ceil((t1 - t0) / o.sampleStep));
  let minDeg = Infinity;
  let maxDeg = -Infinity;
  let rising = true;
  let lit = true;
  let minVis = 1;
  let startDeg = 0;
  let endDeg = 0;
  let prev = -Infinity;
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    const s = sunAtSurfacePoint(system, lp, t);
    const e = s.elevation * RAD;
    if (i === 0) startDeg = e;
    if (i === n) endDeg = e;
    minDeg = Math.min(minDeg, e);
    maxDeg = Math.max(maxDeg, e);
    if (!(s.rate > 0) || !(e > prev)) rising = false;
    prev = e;
    minVis = Math.min(minVis, s.visibility);
    if (s.visibility < 0.999 || e <= 0) lit = false;
  }
  const landOk = minDeg >= o.landingSunElevationDeg[0] && maxDeg <= o.landingSunElevationDeg[1] && rising && lit;
  return {
    ok: launchOk && padOk && landOk,
    launch: {
      ok: launchOk,
      crossingUt: w ? w.crossingUt : null,
      delay,
      launchAzimuthDeg: w ? w.launchAzimuthDeg : null,
      inertialAzimuthDeg: w ? w.inertialAzimuthDeg : null,
    },
    padSun: { ok: padOk, elevationDeg: padDeg, rising: pad.rate > 0, elevationAtLaunchDeg: padAtLaunch },
    landingSun: { ok: landOk, startDeg, endDeg, minDeg, maxDeg, rising, lit, minVisibility: minVis },
  };
}

/** Degrees -> radians helper for callers building SurfacePoints from definition data. */
export const surfacePointFromDeg = (bodyId: string, latDeg: number, lonDeg: number, elevation = 0): SurfacePoint => ({
  bodyId,
  latitude: latDeg * DEG,
  longitude: lonDeg * DEG,
  elevation,
});
