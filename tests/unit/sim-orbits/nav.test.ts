import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, LaunchSiteDef, ScenarioDef } from '../../../src/core/contracts/defs';
import type { Patch, SurfaceTarget } from '../../../src/core/contracts/sim';
import { quat, type Quat } from '../../../src/core/math/quat';
import { DEG, RAD } from '../../../src/core/math/scalar';
import { v3, type Vec3 } from '../../../src/core/math/vec3';
import type { BodySystem } from '../../../src/sim/bodies/bodySystem';
import { dirFromLatLon, enuBasis } from '../../../src/sim/frames/bodyFrames';
import { padState } from '../../../src/sim/frames/padState';
import { computeLaunchWindow, angleFromTargetPlane, launchWindowReadout } from '../../../src/sim/nav/launchWindow';
import { computeLandingTargetReadout, greatCircle } from '../../../src/sim/nav/landingTarget';
import { computeNavball, navballModeAfter, defaultNavballMode, tiltFromVertical } from '../../../src/sim/nav/navball';
import { computeOrbitalReadouts } from '../../../src/sim/nav/readouts';
import { buildSurfaceTargets } from '../../../src/sim/nav/surfaceTargets';
import { predictPatches } from '../../../src/sim/orbit/patches';
import { loadWorld, mainIds, utOf } from './fixtures';

let defs: DefLibrary;
let sys: BodySystem;
let EARTH = '';
let MOON = '';
let site: LaunchSiteDef;
const T0 = utOf(2028, 3, 1, 4);

beforeAll(async () => {
  ({ defs, system: sys } = await loadWorld());
  ({ root: EARTH, moon: MOON } = mainIds(sys));
  site = Object.values(defs.sites)[0]!;
});

const finiteVec = (v: Vec3 | null): boolean => v === null || v3.isFinite(v);
function allFinite(nb: ReturnType<typeof computeNavball>): boolean {
  const m = nb.markers;
  return (
    quat.isFinite(nb.qVesselToHorizon) &&
    [nb.pitchDeg, nb.headingDeg, nb.rollDeg].every(Number.isFinite) &&
    [m.prograde, m.retrograde, m.normal, m.antinormal, m.radialOut, m.radialIn, m.maneuver, m.target, m.antiTarget, m.liftVector].every(finiteVec)
  );
}

describe('navball', () => {
  it('on the pad: pitch 90, heading = pad azimuth, roll 0, no NaN in either mode', () => {
    const pad = padState(sys, site, T0, 0);
    for (const mode of ['surface', 'orbit'] as const) {
      const nb = computeNavball({ mode, q: pad.q, r: pad.r, v: pad.v, qFixedToInertial: sys.orientation(EARTH, T0), spin: sys.spin(EARTH) });
      expect(allFinite(nb)).toBe(true);
      expect(nb.pitchDeg).toBeCloseTo(90, 9);
      expect(nb.headingDeg).toBeCloseTo(site.padAzimuthDeg, 9);
      expect(nb.rollDeg).toBeCloseTo(0, 9);
      if (mode === 'surface') {
        // at rest relative to the ground: prograde = up = the nose
        expect(v3.dist(nb.markers.prograde, v3.unitY())).toBeLessThan(1e-9);
      } else {
        // inertial velocity points east; the ventral side (-Z) faces the 90 deg pad azimuth
        expect(v3.dist(nb.markers.prograde, { x: 0, y: 0, z: -1 })).toBeLessThan(1e-6);
      }
      // horizon frame: the nose maps to ENU up
      expect(v3.dist(quat.rotate(nb.qVesselToHorizon, v3.unitY()), v3.unitZ())).toBeLessThan(1e-9);
    }
  });

  it('pitch keeps full precision at the vertical (pads anywhere, any time; a 1e-8 rad tilt is resolved)', () => {
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const t = T0 + i * 7919.3;
      const s: LaunchSiteDef = { ...site, location: { ...site.location, latDeg: -85 + (i * 37.1) % 170, lonDeg: -180 + (i * 53.7) % 360 }, padAzimuthDeg: (i * 29) % 360 };
      const pad = padState(sys, s, t, 0);
      const nb = computeNavball({ mode: 'surface', q: pad.q, r: pad.r, v: pad.v, qFixedToInertial: sys.orientation(EARTH, t), spin: sys.spin(EARTH) });
      worst = Math.max(worst, Math.abs(nb.pitchDeg - 90));
    }
    expect(worst).toBeLessThan(1e-12);
    const pad = padState(sys, site, T0, 0);
    for (const tilt of [1e-8, 1e-6, 1e-3]) {
      // pitch down about +X by `tilt`: the nose leaves the vertical by exactly that angle
      const q = quat.mul(pad.q, quat.fromAxisAngle(v3.unitX(), -tilt));
      const nb = computeNavball({ mode: 'surface', q, r: pad.r, v: pad.v, qFixedToInertial: sys.orientation(EARTH, T0), spin: sys.spin(EARTH) });
      expect(Math.abs(nb.pitchDeg - (90 - tilt * RAD))).toBeLessThan(1e-10);
    }
  });

  function orbitalAttitude(): { q: Quat; r: Vec3; v: Vec3 } {
    // equatorial circular orbit over the prime meridian direction of ROOT +X, moving east (+Y)
    const R = sys.body(EARTH).radius + 300e3;
    const r = { x: R, y: 0, z: 0 };
    const v = { x: 0, y: Math.sqrt(sys.body(EARTH).mu / R), z: 0 };
    // nose = prograde (+Y), dorsal = up (+X), starboard = Y x Z = -Z (south)
    const q = quat.fromBasis({ x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });
    return { q, r, v };
  }

  it('known attitudes give the expected pitch/heading/roll and marker positions', () => {
    const { q, r, v } = orbitalAttitude();
    const base = { mode: 'orbit' as const, r, v, qFixedToInertial: quat.identity(), spin: sys.spin(EARTH) };
    const nb = computeNavball({ ...base, q });
    expect(nb.pitchDeg).toBeCloseTo(0, 9);
    expect(nb.headingDeg).toBeCloseTo(90, 9);
    expect(nb.rollDeg).toBeCloseTo(0, 9);
    expect(v3.dist(nb.markers.prograde, v3.unitY())).toBeLessThan(1e-12);
    expect(v3.dist(nb.markers.retrograde, { x: 0, y: -1, z: 0 })).toBeLessThan(1e-12);
    expect(v3.dist(nb.markers.radialOut, v3.unitZ())).toBeLessThan(1e-12);
    expect(v3.dist(nb.markers.normal, { x: -1, y: 0, z: 0 })).toBeLessThan(1e-12); // north = port side
    // pitch up 20 deg (rotation about +X: nose toward dorsal)
    const pu = computeNavball({ ...base, q: quat.mul(q, quat.fromAxisAngle(v3.unitX(), 20 * DEG)) });
    expect(pu.pitchDeg).toBeCloseTo(20, 9);
    expect(pu.headingDeg).toBeCloseTo(90, 9);
    expect(pu.rollDeg).toBeCloseTo(0, 9);
    // roll right 30 deg (about +Y)
    const rr = computeNavball({ ...base, q: quat.mul(q, quat.fromAxisAngle(v3.unitY(), 30 * DEG)) });
    expect(rr.rollDeg).toBeCloseTo(30, 9);
    expect(rr.pitchDeg).toBeCloseTo(0, 9);
    // yaw right 15 deg (nose toward starboard = south): heading 105
    const yr = computeNavball({ ...base, q: quat.mul(q, quat.fromAxisAngle(v3.unitZ(), -15 * DEG)) });
    expect(yr.headingDeg).toBeCloseTo(105, 9);
    // maneuver, target and lift markers are carried into the VES frame
    const m = computeNavball({ ...base, q, maneuverDv: { x: 0, y: 0, z: 50 }, targetDir: { x: 0, y: 1, z: 0 }, liftVectorVes: { x: 0, y: 0, z: 2 } });
    expect(v3.dist(m.markers.maneuver!, { x: -1, y: 0, z: 0 })).toBeLessThan(1e-12); // ROOT +Z = north = port
    expect(v3.dist(m.markers.target!, v3.unitY())).toBeLessThan(1e-12);
    expect(v3.dist(m.markers.antiTarget!, { x: 0, y: -1, z: 0 })).toBeLessThan(1e-12);
    expect(v3.dist(m.markers.liftVector!, v3.unitZ())).toBeLessThan(1e-12);
    expect(nb.markers.maneuver).toBeNull();
    expect(tiltFromVertical(q, r) * RAD).toBeCloseTo(90, 9);
  });

  it('robust in vertical flight, at zero velocity and at a pole', () => {
    const R = sys.body(EARTH).radius;
    const up = { x: 0.6, y: 0.8, z: 0 };
    const r = v3.scale(up, R + 1000);
    const q = quat.fromTo(v3.unitY(), up);
    for (const v of [v3.scale(up, 300), v3.zero(), v3.cross(sys.spin(EARTH), r)]) {
      for (const mode of ['surface', 'orbit'] as const) {
        const nb = computeNavball({ mode, q, r, v, qFixedToInertial: sys.orientation(EARTH, T0), spin: sys.spin(EARTH) });
        expect(allFinite(nb)).toBe(true);
        expect(v3.len(nb.markers.normal)).toBeCloseTo(1, 12);
        expect(Math.abs(v3.dot(nb.markers.normal, nb.markers.prograde))).toBeLessThan(1e-9);
      }
    }
    const pole = { x: 0, y: 0, z: R + 10 };
    const nb = computeNavball({ mode: 'surface', q: quat.fromTo(v3.unitY(), v3.unitZ()), r: pole, v: v3.zero(), qFixedToInertial: quat.identity(), spin: sys.spin(EARTH) });
    expect(allFinite(nb)).toBe(true);
  });

  it('surface/orbit switch with 5 % hysteresis, edge-triggered', () => {
    const A = defs.bodies[EARTH]!.navballSwitchAltitude;
    expect(defaultNavballMode(A - 1, A)).toBe('surface');
    expect(defaultNavballMode(A + 1, A)).toBe('orbit');
    expect(navballModeAfter('surface', A, A * 1.04, A)).toBe('surface');
    expect(navballModeAfter('surface', A * 1.04, A * 1.06, A)).toBe('orbit');
    expect(navballModeAfter('orbit', A * 1.06, A * 0.96, A)).toBe('orbit');
    expect(navballModeAfter('orbit', A * 0.96, A * 0.94, A)).toBe('surface');
    // a manual choice sticks until the next crossing
    expect(navballModeAfter('surface', A * 2, A * 2.1, A)).toBe('surface');
  });
});

describe('orbital readouts', () => {
  it('apsides, times, inclination to the body equator, speeds', () => {
    const R = sys.body(EARTH).radius;
    const rp = R + 200e3;
    const ra = R + 400e3;
    const a = (rp + ra) / 2;
    const mu = sys.body(EARTH).mu;
    const vp = Math.sqrt(mu * (2 / rp - 1 / a));
    const inc = 28.5 * DEG;
    const r = { x: rp, y: 0, z: 0 };
    const v = { x: 0, y: vp * Math.cos(inc), z: vp * Math.sin(inc) };
    const ro = computeOrbitalReadouts({ system: sys, bodyId: EARTH, r, v, ut: T0 });
    expect(ro.periapsisAltitude).toBeCloseTo(200e3, 3);
    expect(ro.apoapsisAltitude).toBeCloseTo(400e3, 3);
    expect(ro.inclination * RAD).toBeCloseTo(28.5, 9);
    const P = 2 * Math.PI * Math.sqrt((a * a * a) / mu);
    expect(ro.period!).toBeCloseTo(P, 6);
    expect(ro.timeToApoapsis!).toBeCloseTo(P / 2, 4);
    expect(ro.timeToPeriapsis!).toBeCloseTo(P, 4);
    expect(ro.verticalSpeed).toBeCloseTo(0, 6);
    expect(ro.speedOrbital).toBeCloseTo(vp, 9);
    expect(ro.horizontalSpeed).toBeLessThan(vp);
    expect(ro.targetRelativeInclination).toBeNull();
    const t = computeOrbitalReadouts({ system: sys, bodyId: EARTH, r, v, ut: T0, targetBodyId: MOON });
    expect(t.targetRelativeInclination!).toBeGreaterThan(0);
    // hyperbola: no apoapsis, no period
    const h = computeOrbitalReadouts({ system: sys, bodyId: EARTH, r, v: v3.scale(v, 1.5), ut: T0 });
    expect(h.apoapsisAltitude).toBe(Infinity);
    expect(h.period).toBeNull();
    expect(h.timeToApoapsis).toBeNull();
  });
});

describe('launch window', () => {
  it('at the returned crossing time the pad lies in the Moon orbit plane within 0.01 deg', () => {
    const lat = site.location.latDeg * DEG;
    const lon = site.location.lonDeg * DEG;
    const rFixed = v3.scale(dirFromLatLon(lat, lon), sys.body(EARTH).radius);
    for (const kind of ['ascending', 'descending', 'next'] as const) {
      const w = computeLaunchWindow({ system: sys, bodyId: EARTH, latitude: lat, longitude: lon, ut: T0, targetBodyId: MOON, kind })!;
      expect(w.coplanar).toBe(true);
      expect(w.timeToPlaneCrossing).toBeGreaterThanOrEqual(0);
      expect(w.timeToPlaneCrossing).toBeLessThan(86164.1);
      expect(Math.abs(angleFromTargetPlane(sys, EARTH, rFixed, MOON, w.crossingUt)) * RAD).toBeLessThan(0.01);
      if (kind === 'ascending') {
        expect(w.ascending).toBe(true);
        expect(w.inertialAzimuthDeg).toBeGreaterThan(75);
        expect(w.inertialAzimuthDeg).toBeLessThan(90);
        // surface azimuth is corrected for the pad's eastward rotation speed
        expect(w.launchAzimuthDeg).toBeLessThan(w.inertialAzimuthDeg);
      }
      if (kind === 'descending') {
        expect(w.ascending).toBe(false);
        expect(w.inertialAzimuthDeg).toBeGreaterThan(90);
        expect(w.inertialAzimuthDeg).toBeLessThan(105);
      }
    }
    // consecutive ascending opportunities are one sidereal day apart
    const w1 = computeLaunchWindow({ system: sys, bodyId: EARTH, latitude: lat, longitude: lon, ut: T0, targetBodyId: MOON, kind: 'ascending' })!;
    const w2 = computeLaunchWindow({ system: sys, bodyId: EARTH, latitude: lat, longitude: lon, ut: w1.crossingUt + 1, targetBodyId: MOON, kind: 'ascending' })!;
    expect(w2.crossingUt - w1.crossingUt).toBeCloseTo(86164.0905, 2);
    const ro = launchWindowReadout({ system: sys, bodyId: EARTH, latitude: lat, longitude: lon, ut: T0, targetBodyId: MOON })!;
    expect(ro.timeToPlaneCrossing).toBeGreaterThanOrEqual(0);
  });

  it('non-coplanar site: due-east launch when the orbit plane contains the Moon after the transfer time', () => {
    const lat = 45 * DEG;
    const w = computeLaunchWindow({ system: sys, bodyId: EARTH, latitude: lat, longitude: 0, ut: T0, targetBodyId: MOON, transferTime: 4 * 86400 })!;
    expect(w.coplanar).toBe(false);
    expect(w.inertialAzimuthDeg).toBe(90);
    expect(w.launchAzimuthDeg).toBeCloseTo(90, 9);
    const q = sys.orientation(EARTH, w.crossingUt);
    const r = quat.rotate(q, dirFromLatLon(lat, 0));
    const north = enuBasis(q, r).north;
    const moon = v3.normalize(sys.stateRelParent(MOON, w.crossingUt + 4 * 86400).r);
    expect(Math.abs(v3.dot(north, moon))).toBeLessThan(1e-6);
  });
});

describe('surface targets and landing-target readout', () => {
  const R = 1737400;
  const tgt = (id: string, latDeg: number, lonDeg: number, kind: SurfaceTarget['kind'] = 'landing', bodyId = 'b'): SurfaceTarget => ({
    id,
    name: id,
    bodyId,
    kind,
    latitude: latDeg * DEG,
    longitude: lonDeg * DEG,
    radius: 0,
  });
  const sub = dirFromLatLon(0, 0);
  const east = { x: 0, y: 1, z: 0 };
  const north = { x: 0, y: 0, z: 1 };

  it('analytic distance and bearing', () => {
    const r1 = computeLandingTargetReadout([tgt('e', 0, 1)], 'b', sub, null, R, [])!;
    expect(r1.distance).toBeCloseTo(R * DEG, 6);
    expect(r1.bearingDeg).toBeCloseTo(90, 9);
    expect(r1.downRange).toBe(0);
    expect(r1.crossRange).toBe(0);
    expect(r1.predicted).toBeNull();
    const r2 = computeLandingTargetReadout([tgt('n', 2, 0)], 'b', sub, null, R, [])!;
    expect(r2.bearingDeg).toBeCloseTo(0, 9);
    expect(r2.distance).toBeCloseTo(2 * R * DEG, 6);
    // a target at (30 N, 30 E) seen from (0, 0): spherical distance acos(cos30 cos30)
    const r3 = computeLandingTargetReadout([tgt('ne', 30, 30)], 'b', sub, null, R, [])!;
    expect(r3.distance).toBeCloseTo(R * Math.acos(Math.cos(30 * DEG) ** 2), 4);
    expect(r3.bearingDeg).toBeCloseTo(Math.atan2(Math.sin(30 * DEG), Math.tan(30 * DEG)) * RAD, 6);
    expect(greatCircle(sub, sub).angle).toBe(0);
  });

  it('down-range / cross-range signs for targets ahead, behind, left and right', () => {
    const d = R * 0.5 * DEG;
    const ahead = computeLandingTargetReadout([tgt('t', 0, 0.5)], 'b', sub, east, R, [])!;
    expect(ahead.downRange).toBeCloseTo(d, 3);
    expect(Math.abs(ahead.crossRange)).toBeLessThan(1e-6);
    const behind = computeLandingTargetReadout([tgt('t', 0, -0.5)], 'b', sub, east, R, [])!;
    expect(behind.downRange).toBeCloseTo(-d, 3);
    const right = computeLandingTargetReadout([tgt('t', -0.5, 0)], 'b', sub, east, R, [])!; // south of an eastward track
    expect(right.crossRange).toBeCloseTo(d, 3);
    expect(Math.abs(right.downRange)).toBeLessThan(1e-3);
    const left = computeLandingTargetReadout([tgt('t', 0.5, 0)], 'b', sub, east, R, [])!;
    expect(left.crossRange).toBeCloseTo(-d, 3);
    // northbound track: an eastern target is to the right
    const nr = computeLandingTargetReadout([tgt('t', 0, 0.5)], 'b', sub, north, R, [])!;
    expect(nr.crossRange).toBeCloseTo(d, 3);
  });

  function fakePatch(kind: 'impact' | 'atmosphereEntry', latDeg: number, lonDeg: number, bodyId = 'b'): Patch {
    return {
      bodyId,
      conic: { mu: 1, p: 1, e: 0, a: 1, P: v3.unitX(), Q: v3.unitY(), W: v3.unitZ(), tPeriapsis: 0, period: 1, inc: 0, lan: 0, argPe: 0 },
      tStart: 0,
      tEnd: 100,
      nuStart: 0,
      nuEnd: 1,
      endReason: kind === 'impact' ? 'impact' : 'atmosphere',
      bodyPosAtEnd: v3.zero(),
      markers: [{ kind, ut: 100, bodyId, r: v3.zero(), latitude: latDeg * DEG, longitude: lonDeg * DEG }],
    };
  }

  it('predicted miss equals the marker-to-target arc; nearest target to the arrival point', () => {
    const targets = [tgt('a', 0, 1), tgt('z', 0, 10, 'recovery')];
    const p = computeLandingTargetReadout(targets, 'b', sub, east, R, [fakePatch('impact', 0.1, 9.5)])!;
    expect(p.targetId).toBe('z');
    expect(p.predicted!.kind).toBe('impact');
    expect(p.predicted!.missDistance).toBeCloseTo(R * greatCircle(dirFromLatLon(0, 10 * DEG), dirFromLatLon(0.1 * DEG, 9.5 * DEG)).angle, 6);
    expect(p.predicted!.missBearingDeg).toBeGreaterThan(270);
    // no prediction: nearest to the sub-point
    const q = computeLandingTargetReadout(targets, 'b', sub, east, R, [])!;
    expect(q.targetId).toBe('a');
    const e = computeLandingTargetReadout(targets, 'b', sub, east, R, [fakePatch('atmosphereEntry', 0, 2)])!;
    expect(e.predicted!.kind).toBe('entry');
    // markers on another body are ignored
    const o = computeLandingTargetReadout(targets, 'b', sub, east, R, [fakePatch('impact', 0, 9.9, 'other')])!;
    expect(o.predicted).toBeNull();
  });

  it('null when the body has no landing or recovery target', () => {
    expect(computeLandingTargetReadout([tgt('s', 0, 0, 'site')], 'b', sub, east, R, [])).toBeNull();
    expect(computeLandingTargetReadout([tgt('x', 0, 0, 'landing', 'other')], 'b', sub, east, R, [])).toBeNull();
  });

  it('buildSurfaceTargets: landing, site and recovery zones from scenario and site data', () => {
    const scenario: ScenarioDef = {
      id: 'test-scenario',
      name: 'test',
      vehicle: 'v',
      site: site.id,
      startUt: 0,
      start: { kind: 'pad' },
      stagesAlreadyFired: 0,
      target: MOON,
      suggestedLanding: { bodyId: MOON, latDeg: 0.674, lonDeg: 23.473, name: 'Target' },
      milestones: [],
    };
    const t = buildSurfaceTargets(defs, scenario);
    expect(t[0]).toMatchObject({ id: 'landing', kind: 'landing', bodyId: MOON, radius: 0 });
    expect(t[0]!.latitude).toBeCloseTo(0.674 * DEG, 15);
    expect(t[1]).toMatchObject({ id: `site:${site.id}`, kind: 'site', bodyId: site.bodyId, radius: site.pad.flatRadius });
    expect(t.filter((x) => x.kind === 'recovery')).toHaveLength(site.recoveryZones.length);
    expect(t[2]!.radius).toBe(site.recoveryZones[0]!.radiusKm * 1000);
    expect(buildSurfaceTargets(defs, { ...scenario, suggestedLanding: null })[0]!.kind).toBe('site');
  });

  it('end to end: lunar impact prediction feeds the readout', () => {
    const Rm = sys.body(MOON).radius;
    const rA = Rm + 15e3;
    const rP = Rm - 30e3;
    const a = (rA + rP) / 2;
    const vA = Math.sqrt(sys.body(MOON).mu * (2 / rA - 1 / a));
    const state = { bodyId: MOON, r: { x: rA, y: 0, z: 0 }, v: { x: 0, y: vA, z: 0 } };
    const { current } = predictPatches(sys, state, T0, []);
    const imp = current[0]!.markers.find((m) => m.kind === 'impact')!;
    const targets: SurfaceTarget[] = [{ id: 'landing', name: 'l', bodyId: MOON, kind: 'landing', latitude: imp.latitude!, longitude: imp.longitude! + 0.01, radius: 0 }];
    const subDir = v3.normalize(quat.rotateInv(sys.orientation(MOON, T0), state.r));
    const r = computeLandingTargetReadout(targets, MOON, subDir, null, Rm, current)!;
    expect(r.predicted!.kind).toBe('impact');
    expect(r.predicted!.missDistance).toBeCloseTo(Rm * 0.01 * Math.cos(imp.latitude!), 0);
  });
});
