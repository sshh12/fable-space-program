/**
 * The starts of the transfer flights (tests/unit/solar-system/transferFlight.test.ts), from the pilot's own
 * porkchop: the parking orbit a player launches into for a window (the departure plane), and the state at the
 * planet's sphere on that window's arrival hyperbola (the arrival legs). A module of its own so tools can print them.
 */
import type { BodySnapshot } from '../../../src/core/contracts/sim';
import { quat } from '../../../src/core/math/quat';
import { v3, type Vec3 } from '../../../src/core/math/vec3';
import { MOON_FLYBY_SHARE, TransferPilot } from '../../../src/pilot/generic/transfer';
import { bestWindow, captureDeltaVFromExcess, ejectionDeltaV, meanOrbit, synodic, type WindowArc } from '../../../src/pilot/generic/transferMath';
import { makeOrbit, propagate } from '../../../src/sim/orbit/kepler';
import { loadStaged } from './fixtures';

/** The window the pilot chooses for `targetId` from a parking orbit of radius `parkingRadius` at `startUt` (coplanar departure costs), and the flyby radius it aims at about the planet. */
export async function pilotWindow(targetId: string, startUt: number, parkingRadius: number): Promise<{ arc: WindowArc; planetId: string; aimRadius: number }> {
  const { defs, system } = await loadStaged();
  const snaps = system.buildBodySnapshots(startUt);
  const by = (id: string): BodySnapshot => snaps.find((b) => b.id === id)!;
  const origin = by('earth');
  const star = by(defs.bodies['earth']!.parent!);
  const planetId = defs.bodies[targetId]!.parent === star.id ? targetId : defs.bodies[targetId]!.parent!;
  const planet = by(planetId);
  const muS = defs.bodies[star.id]!.mu;
  const muO = defs.bodies['earth']!.mu;
  const muP = defs.bodies[planetId]!.mu;
  // the pilot's arrival costs: the capture at the planet, or for a moon the speed relative to it where the flyby crosses its orbit
  const pdef = defs.bodies[planetId]!;
  const rPeri = (pdef.shape ? pdef.shape.equatorialRadius : pdef.radius) + TransferPilot.defaultPeriapsisAltitude(defs, planetId);
  const rp = planetId === targetId ? rPeri : Math.max(rPeri, MOON_FLYBY_SHARE * meanOrbit(by(targetId), planet, muP).a);
  const ra = Math.max(1.01 * rp, 0.3 * (planet.soiRadius ?? 0));
  const arriveCost = planetId === targetId ? (vinf: number): number => captureDeltaVFromExcess(muP, vinf, rp, ra) : (vinf: number): number => Math.sqrt(vinf * vinf + (2 * muP) / rp) - Math.sqrt(muP / rp);
  const fromUt = startUt + 2 * 3600 + 3600;
  const arc = bestWindow({
    origin,
    planet,
    parent: star,
    muParent: muS,
    departCost: (vinf) => ejectionDeltaV(muO, parkingRadius, v3.len(vinf)),
    arriveCost,
    fromUt,
    toUt: fromUt + 0.8 * synodic(muS, meanOrbit(origin, star, muS).a, meanOrbit(planet, star, muS).a),
  })!;
  return { arc, planetId, aimRadius: rp };
}

/**
 * The parking orbit a player launches into for a departure toward `targetId` soon after `startUt`: the plane that
 * holds the outgoing asymptote of the window the pilot will choose, at the scenario's inclination or, when the
 * asymptote lies further from the equator, one degree more than its declination (a pad at the scenario's latitude
 * reaches any inclination above it). Inclination and node, degrees, in the Earth's equatorial frame (the ROOT
 * axes: the staged Earth's pole is +Z).
 */
export async function departurePlane(targetId: string, startUt: number, floorInclinationDeg: number, parkingRadius: number): Promise<{ inclinationDeg: number; lanDeg: number }> {
  const { arc } = await pilotWindow(targetId, startUt, parkingRadius);
  const s = v3.normalize(arc.vInfDepart);
  const dec = Math.asin(s.z);
  const ra0 = Math.atan2(s.y, s.x);
  const inc = Math.max((floorInclinationDeg * Math.PI) / 180, Math.abs(dec) + Math.PI / 180);
  const lan = ra0 + Math.asin(-Math.tan(dec) / Math.tan(inc));
  return { inclinationDeg: (inc * 180) / Math.PI, lanDeg: ((((lan * 180) / Math.PI) % 360) + 360) % 360 };
}

/**
 * The start of an arrival leg: the craft at the planet's sphere (0.98 of its radius) on the hyperbola of the
 * window's arrival excess velocity. For a planet: its periapsis `periapsisShare` x the aim radius at the window's
 * arrival time, in the plane through the asymptote nearest the planet's equator. For a moon: its periapsis at the
 * moon's position at the prograde pass nearest the arrival, `periapsisShare` x the moon's distance out. Whole
 * seconds (on the tick grid), BCI of the planet.
 */
export async function arrivalStart(targetId: string, windowFromUt: number, parkingRadius: number, periapsisShare = 1): Promise<{ startUt: number; bodyId: string; r: Vec3; v: Vec3 }> {
  const { system } = await loadStaged();
  const { arc, planetId, aimRadius } = await pilotWindow(targetId, windowFromUt, parkingRadius);
  const P = system.body(planetId);
  const mu = P.mu;
  const d = v3.normalize(arc.vInfArrive);
  const vinf = v3.len(arc.vInfArrive);
  let tPeri = arc.arriveUt;
  let rp = periapsisShare * aimRadius;
  let h: Vec3;
  let pHat: Vec3;
  const nuInfOf = (r: number): number => Math.acos(-1 / (1 + (r * vinf * vinf) / mu));
  if (targetId !== planetId) {
    // a moon: the flyby's periapsis where the moon is at that moment (what the heliocentric correction arranges),
    // `periapsisShare` - 1 of the moon's orbit radius outside it, prograde with the moon
    const W = system.orbitNormal(targetId, arc.arriveUt)!;
    const period = system.orbitConic(targetId, arc.arriveUt)!.period!;
    const f = (t: number): number => v3.dot(v3.normalize(system.stateRelative(targetId, planetId, t).r), d) + Math.cos(nuInfOf(v3.len(system.stateRelative(targetId, planetId, t).r)));
    let best: { t: number; h: Vec3; p: Vec3 } | null = null;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      let a = arc.arriveUt - period + (2 * period * i) / n;
      let b = a + (2 * period) / n;
      if (Math.sign(f(a)) === Math.sign(f(b))) continue;
      for (let k = 0; k < 80; k++) {
        const m = 0.5 * (a + b);
        if (Math.sign(f(m)) === Math.sign(f(a))) a = m;
        else b = m;
      }
      const t = 0.5 * (a + b);
      const m = v3.normalize(system.stateRelative(targetId, planetId, t).r);
      const nu = nuInfOf(v3.len(system.stateRelative(targetId, planetId, t).r));
      for (const sign of [1, -1]) {
        const hh = v3.scale(v3.normalize(v3.cross(d, m)), sign);
        const pp = v3.sub(v3.scale(d, -Math.cos(nu)), v3.scale(v3.cross(hh, d), Math.sin(nu)));
        if (v3.dot(pp, m) > 0.999999 && v3.dot(hh, W) > 0 && (!best || Math.abs(t - arc.arriveUt) < Math.abs(best.t - arc.arriveUt))) best = { t, h: hh, p: pp };
      }
    }
    if (!best) throw new Error(`arrivalStart: no prograde pass of ${targetId} at the flyby's periapsis near the arrival`);
    tPeri = best.t;
    h = best.h;
    pHat = best.p;
    rp = periapsisShare * v3.len(system.stateRelative(targetId, planetId, tPeri).r);
  } else {
    const pole = quat.rotate(system.orientation(planetId, arc.arriveUt), { x: 0, y: 0, z: 1 });
    h = v3.normalize(v3.reject(pole, d));
    const nu = nuInfOf(rp);
    pHat = v3.sub(v3.scale(d, -Math.cos(nu)), v3.scale(v3.cross(h, d), Math.sin(nu)));
  }
  const qHat = v3.cross(h, pHat);
  const vp = Math.sqrt(vinf * vinf + (2 * mu) / rp);
  const hyp = makeOrbit(planetId, mu, v3.scale(pHat, rp), v3.scale(qHat, vp), tPeri);
  const soi = 0.98 * P.soiRadius!;
  let lo = 0;
  let hi = 86400;
  while (v3.len(propagate(hyp, tPeri - hi).r) < soi) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const m = 0.5 * (lo + hi);
    if (v3.len(propagate(hyp, tPeri - m).r) < soi) lo = m;
    else hi = m;
  }
  const startUt = Math.round(tPeri - hi);
  const s = propagate(hyp, startUt);
  return { startUt, bodyId: planetId, r: s.r, v: s.v };
}
