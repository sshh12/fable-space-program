/**
 * Synthetic SimSnapshots for the map view's unit tests and its lab (`?scene=synthetic`).
 *
 * The FakeSim only produces single-body patches, so these fixtures build GEOMETRICALLY CONTINUOUS
 * multi-patch chains with src/core/math/conic.ts plus a fixture-only Kepler propagator, by forward
 * patched-conic construction (every patch starts from the propagated end state of the previous one):
 *
 *   current: [0] Earth departure ellipse (AN/DN, SOI entry) -> [1] lunar hyperbola ending in an IMPACT
 *            (impact marker with latitude/longitude; the landing target lies close by, with the predicted
 *            miss in readouts.landingTarget), maneuver node A on it.
 *   planned: node A (radial/normal correction, searched so the flyby clears the Moon and returns to a low
 *            Earth perigee) -> [0] lunar flyby hyperbola (periapsis, SOI exit) -> [1] Earth orbit followed
 *            for 2.5 revolutions (nuEnd - nuStart = 5 pi, endReason 'maneuver'; Ap, Pe, AN, DN, closest
 *            approach to the Moon) to node B -> [2] Earth return to atmosphere entry (speed, flight-path
 *            angle, vacuum periapsis, latitude/longitude).
 *   Every MarkerKind is present; nodes A and B sit on different patches, B 2.5 revolutions ahead.
 *   20 debris orbits, one other vessel, the landing target, the launch site and its recovery zones.
 *
 * Bodies are found generically: the root body, its first attractor child with an SOI (the "moon"), and
 * the star. Body positions come from the fixture's own ephemeris (Kepler orbit from the BodyDef elements),
 * exposed as `bodyPosition` so tests can check continuity in the ROOT frame.
 */
import { NEUTRAL_CONTROLS } from '@/core/contracts/controls';
import type { BodyDef, DefLibrary, KeplerOrbitDef } from '@/core/contracts/defs';
import type { BodySnapshot, ManeuverNode, Marker, Patch, Readouts, SimSnapshot, SurfaceTarget, VesselSnapshot } from '@/core/contracts/sim';
import { dirToLatLon, latLonToDir } from '@/core/geo/cubeSphere';
import {
  conicApsides,
  conicFromState,
  conicPosition,
  conicRadiusCrossing,
  conicTrueAnomaly,
  conicVelocity,
  timeSincePeriapsis,
  type ConicElements,
} from '@/core/math/conic';
import { Prng } from '@/core/math/hash';
import { quat, type Quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { forwardTime } from '../anomalyTime';
import { nodeDvInertial, nodeFrame } from '../nodes';
import { meanToTrue, stateAt, stateFromElements } from './kepler';

const TWO_PI = 2 * Math.PI;
const DAY = 86400;
const OBLIQUITY = 23.4392911 * DEG;

export interface SyntheticOptions {
  /** Presentation time, s since J2000 (default 8.89e8). */
  ut?: number;
  /**
   * Small correction nodes splitting the 2.5-revolution Earth orbit (default 0). With 3 the chain has 8
   * patches (2 current + 6 planned): the load case of the map view's CPU/GPU budget.
   */
  correctionNodes?: number;
}

export interface SyntheticFixture {
  snapshot: SimSnapshot;
  /** ROOT-frame position of a body at time t (the fixture's ephemeris). */
  bodyPosition(bodyId: string, t: number): Vec3;
  /** Ids of the root body, the moon and the star used. */
  rootId: string;
  moonId: string;
  starId: string;
  nodeA: ManeuverNode;
  nodeB: ManeuverNode;
}

interface Ephemeris {
  rootId: string;
  moonId: string;
  starId: string;
  moonConic: ConicElements;
  moonState(t: number): { r: Vec3; v: Vec3 };
  position(id: string, t: number): Vec3;
  velocity(id: string, t: number): Vec3;
  orientation(id: string, t: number): { q: Quat; spin: Vec3 };
}

// ------------------------------------------------------------------------------------------ ephemeris

function sunPosition(t: number): Vec3 {
  // Astronomical Almanac low-precision solar coordinates (equatorial, metres).
  const n = t / DAY;
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const R = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * 149597870700;
  return { x: R * Math.cos(lam), y: R * Math.cos(eps) * Math.sin(lam), z: R * Math.sin(eps) * Math.sin(lam) };
}

const rotX = (v: Vec3, a: number): Vec3 => ({ x: v.x, y: Math.cos(a) * v.y - Math.sin(a) * v.z, z: Math.sin(a) * v.y + Math.cos(a) * v.z });

function buildEphemeris(defs: DefLibrary): Ephemeris {
  const rootId = defs.rootBodyId;
  const root = defs.bodies[rootId]!;
  const moonDef = Object.values(defs.bodies).find((b) => b.parent === rootId && b.gravityRole === 'attractor' && b.orbit?.kind === 'kepler');
  if (!moonDef) throw new Error('synthetic fixture: the root body needs an attractor child with a Kepler orbit');
  const star = Object.values(defs.bodies).find((b) => b.emission !== null);
  if (!star) throw new Error('synthetic fixture: no star in the definitions');
  const o = moonDef.orbit as KeplerOrbitDef;
  const mu = root.mu + moonDef.mu;
  const nu0 = meanToTrue(o.meanAnomalyDeg * DEG, o.e);
  let s = stateFromElements(mu, o.a, o.e, o.iDeg * DEG, o.lanDeg * DEG, o.argPeDeg * DEG, nu0);
  if (o.frame === 'ecliptic') s = { r: rotX(s.r, OBLIQUITY), v: rotX(s.v, OBLIQUITY) };
  const moonConic = conicFromState(mu, s.r, s.v, o.epochUt);
  const moonState = (t: number): { r: Vec3; v: Vec3 } => {
    const st = stateAt(moonConic, t);
    return { r: st.r, v: st.v };
  };
  const position = (id: string, t: number): Vec3 => (id === moonDef.id ? moonState(t).r : id === star.id ? sunPosition(t) : v3.zero());
  const velocity = (id: string, t: number): Vec3 =>
    id === moonDef.id ? moonState(t).v : id === star.id ? v3.scale(v3.sub(sunPosition(t + 1), sunPosition(t - 1)), 0.5) : v3.zero();
  const orientation = (id: string, t: number): { q: Quat; spin: Vec3 } => {
    const def: BodyDef | undefined = defs.bodies[id];
    if (!def) return { q: quat.identity(), spin: v3.zero() };
    const rot = def.rotation;
    if (rot.mode === 'fixedRate') {
      const W = (rot.w0Deg + (rot.rateDegPerDay * (t - rot.epochUt)) / DAY) * DEG;
      const q = quat.mul(
        quat.mul(quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, rot.poleRaDeg * DEG + Math.PI / 2), quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2 - rot.poleDecDeg * DEG)),
        quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, W % TWO_PI),
      );
      return { q, spin: v3.scale(quat.rotate(q, { x: 0, y: 0, z: 1 }), (rot.rateDegPerDay * DEG) / DAY) };
    }
    if (rot.mode === 'tidalLock' && def.parent) {
      const rel = v3.sub(position(id, t), position(def.parent, t));
      const vel = v3.sub(velocity(id, t), velocity(def.parent, t));
      const x = v3.normalize(v3.neg(rel));
      const z = v3.normalize(v3.cross(rel, vel));
      const y = v3.cross(z, x);
      return { q: quat.fromBasis(x, y, z), spin: v3.scale(z, TWO_PI / (moonConic.period ?? Infinity)) };
    }
    return { q: quat.identity(), spin: v3.zero() };
  };
  return { rootId, moonId: moonDef.id, starId: star.id, moonConic, moonState, position, velocity, orientation };
}

// ------------------------------------------------------------------------------------------- helpers

const tsp = (c: ConicElements, nu: number): number => timeSincePeriapsis(c, wrap(nu));
const wrap = (a: number): number => {
  const r = a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
  return r === -Math.PI ? Math.PI : r;
};

/** Time from nu0 forward to nu1 on a conic (closed: unwrapped difference honoured, open: tsp difference). */
function timeAlong(c: ConicElements, nu0: number, nu1: number): number {
  if (c.period === null) return tsp(c, nu1) - tsp(c, nu0);
  const turns = Math.floor((nu1 - nu0) / TWO_PI + 1e-12);
  const rest = nu1 - nu0 - turns * TWO_PI;
  return turns * c.period + (rest > 1e-12 ? forwardTime(c, nu0, nu0 + rest) : 0);
}

function makePatch(bodyId: string, c: ConicElements, tStart: number, nuStart: number, nuEnd: number, endReason: Patch['endReason'], bodyPosAtEnd: Vec3, extra: Partial<Patch> = {}): Patch {
  return { bodyId, conic: c, tStart, tEnd: tStart + timeAlong(c, nuStart, nuEnd), nuStart, nuEnd, endReason, bodyPosAtEnd, markers: [], ...extra };
}

/** Apsides and nodes (relative to the plane with normal `refNormal`) that fall inside the patch span. */
function spanMarkers(p: Patch, radius: number, refNormal: Vec3 | null): Marker[] {
  const c = p.conic;
  const out: Marker[] = [];
  const inSpan = (nu: number): number | null => {
    if (c.period === null) return nu >= p.nuStart && nu <= p.nuEnd ? nu : null;
    let d = nu - p.nuStart;
    d -= TWO_PI * Math.floor(d / TWO_PI);
    return p.nuStart + d <= p.nuEnd ? p.nuStart + d : null;
  };
  const add = (kind: Marker['kind'], nu: number, extra: Partial<Marker>): void => {
    const n = inSpan(nu);
    if (n === null) return;
    out.push({ kind, ut: p.tStart + timeAlong(c, p.nuStart, n), bodyId: p.bodyId, r: conicPosition(c, n), ...extra });
  };
  const { rp, ra } = conicApsides(c);
  add('periapsis', 0, { altitude: rp - radius });
  if (c.period !== null) add('apoapsis', Math.PI, { altitude: ra - radius });
  if (refNormal) {
    const relInc = v3.angle(c.W, refNormal);
    if (relInc > 1e-6) {
      const an = v3.normalize(v3.cross(refNormal, c.W));
      const nuAn = conicTrueAnomaly(c, an);
      add('ascendingNode', nuAn, { value: relInc });
      add('descendingNode', wrap(nuAn + Math.PI), { value: relInc });
    }
  }
  return out.sort((a, b) => a.ut - b.ut);
}

function latLonOnBody(eph: Ephemeris, bodyId: string, rRel: Vec3, t: number): { latitude: number; longitude: number } {
  const { q } = eph.orientation(bodyId, t);
  const ll = dirToLatLon(quat.rotateInv(q, rRel));
  return { latitude: ll.lat, longitude: ll.lon };
}

const greatCircle = (lat1: number, lon1: number, lat2: number, lon2: number): number => v3.angle(latLonToDir(lat1, lon1), latLonToDir(lat2, lon2));

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

// ---------------------------------------------------------------------------------------- the chain

interface Built {
  current: Patch[];
  planned: Patch[];
  nodes: ManeuverNode[];
  vesselState: { r: Vec3; v: Vec3 };
  impact: { lat: number; lon: number; ut: number };
}

function buildChain(defs: DefLibrary, eph: Ephemeris, ut: number, corrections: number): Built {
  const earth = defs.bodies[eph.rootId]!;
  const moon = defs.bodies[eph.moonId]!;
  const muE = earth.mu;
  const muM = moon.mu;
  const Rm = moon.radius;
  const soi = typeof moon.soiRadius === 'number' ? moon.soiRadius : eph.moonConic.a * Math.pow(muM / muE, 0.4);
  const atmTop = earth.atmosphere ? earth.atmosphere.simTop : 100e3;
  const Wm = eph.moonConic.W;
  const Pm = eph.moonConic.P;
  const Qm = eph.moonConic.Q;

  // ---- departure: perigee at 200 km, apogee 420,000 km, plane tilted 6 degrees about a node line psi.
  const tTli = ut - 3 * 3600;
  const rpD = earth.radius + 200e3;
  const raD = 4.2e8;
  const aD = (rpD + raD) / 2;
  const vpD = Math.sqrt(muE * (2 / rpD - 1 / aD));
  const iRel = 6 * DEG;
  const departure = (lambda: number, psi: number): ConicElements => {
    const e1 = v3.add(v3.scale(Pm, Math.cos(psi)), v3.scale(Qm, Math.sin(psi)));
    const Wd = quat.rotate(quat.fromAxisAngle(e1, iRel), Wm);
    const e2 = v3.cross(Wd, e1);
    const up = v3.add(v3.scale(e1, Math.cos(lambda)), v3.scale(e2, Math.sin(lambda)));
    const vdir = v3.cross(Wd, up);
    return conicFromState(muE, v3.scale(up, rpD), v3.scale(vdir, vpD), tTli);
  };
  const soiEntry = (c: ConicElements, t0: number, t1: number): number | null => {
    const d = (t: number): number => v3.dist(stateAt(c, t).r, eph.moonState(t).r) - soi;
    if (d(t0) < 0) return null;
    const step = 3600;
    for (let t = t0 + step; t <= t1; t += step) {
      if (d(t) < 0) {
        let lo = t - step;
        let hi = t;
        for (let i = 0; i < 64; i++) {
          const mid = (lo + hi) / 2;
          if (d(mid) < 0) hi = mid;
          else lo = mid;
        }
        return hi;
      }
    }
    return null;
  };
  const bplane = (lambda: number, psi: number): { bT: number; bR: number; tEnter: number; c: ConicElements } | null => {
    const c = departure(lambda, psi);
    const tEnter = soiEntry(c, tTli + 3600, tTli + 8 * DAY);
    if (tEnter === null) return null;
    const vs = stateAt(c, tEnter);
    const ms = eph.moonState(tEnter);
    const rr = v3.sub(vs.r, ms.r);
    const vh = v3.normalize(v3.sub(vs.v, ms.v));
    const b = v3.sub(rr, v3.scale(vh, v3.dot(rr, vh)));
    const T = v3.normalize(v3.cross(vh, Wm));
    const R = v3.cross(vh, T);
    return { bT: v3.dot(b, T), bR: v3.dot(b, R), tEnter, c };
  };
  // Initial guess: the node line points at the Moon ~3 days after TLI, perigee about 165 deg before it.
  const m3 = eph.moonState(tTli + 3 * DAY).r;
  let psi = Math.atan2(v3.dot(m3, Qm), v3.dot(m3, Pm));
  let lambda = -165 * DEG;
  let best = Infinity;
  for (let dl = -0.7; dl <= 0.7; dl += 0.01) {
    const b = bplane(-165 * DEG + dl, psi);
    if (b && Math.hypot(b.bT, b.bR) < best) {
      best = Math.hypot(b.bT, b.bR);
      lambda = -165 * DEG + dl;
    }
  }
  if (!Number.isFinite(best)) throw new Error('synthetic fixture: no lunar encounter found');
  // Newton on (lambda, psi) to put the B-plane point at a near-central impact.
  const target = { bT: 0.18 * Rm, bR: 0.12 * Rm };
  for (let it = 0; it < 25; it++) {
    const b0 = bplane(lambda, psi);
    if (!b0) throw new Error('synthetic fixture: lost the encounter while targeting');
    const fT = b0.bT - target.bT;
    const fR = b0.bR - target.bR;
    if (Math.hypot(fT, fR) < 1) break;
    const h = 1e-6;
    const bl = bplane(lambda + h, psi)!;
    const bp = bplane(lambda, psi + h)!;
    const j11 = (bl.bT - b0.bT) / h;
    const j21 = (bl.bR - b0.bR) / h;
    const j12 = (bp.bT - b0.bT) / h;
    const j22 = (bp.bR - b0.bR) / h;
    const det = j11 * j22 - j12 * j21;
    let dl = (j22 * fT - j12 * fR) / det;
    let dp = (-j21 * fT + j11 * fR) / det;
    const lim = 0.02;
    const s = Math.max(Math.abs(dl), Math.abs(dp)) > lim ? lim / Math.max(Math.abs(dl), Math.abs(dp)) : 1;
    dl *= s;
    dp *= s;
    lambda -= dl;
    psi -= dp;
  }
  const enc = bplane(lambda, psi)!;
  const cD = enc.c;
  const tEnter = enc.tEnter;

  // ---- current[0]: departure from now to SOI entry
  const now = stateAt(cD, ut);
  const nuNow = conicTrueAnomaly(cD, now.r);
  const atEnter = stateAt(cD, tEnter);
  let nuEnter = conicTrueAnomaly(cD, atEnter.r);
  while (nuEnter < nuNow) nuEnter += TWO_PI;
  const c0 = makePatch(eph.rootId, cD, ut, nuNow, nuEnter, 'soiEnter', eph.position(eph.rootId, tEnter), { nextBodyId: eph.moonId });
  c0.tEnd = tEnter;
  c0.markers = spanMarkers(c0, earth.radius, Wm).filter((m) => m.ut < tEnter);
  c0.markers.push({ kind: 'soiEnter', ut: tEnter, bodyId: eph.rootId, r: atEnter.r });

  // ---- current[1]: lunar hyperbola to impact
  const mEnter = eph.moonState(tEnter);
  const rRel = v3.sub(atEnter.r, mEnter.r);
  const vRel = v3.sub(atEnter.v, mEnter.v);
  const cH = conicFromState(muM, rRel, vRel, tEnter);
  const nuHEnter = conicTrueAnomaly(cH, rRel);
  const crossImpact = conicRadiusCrossing(cH, Rm);
  if (crossImpact === null || cH.p / (1 + cH.e) >= Rm) throw new Error('synthetic fixture: targeting did not produce an impact');
  const nuImpact = -crossImpact;
  const tImpact = tEnter + (tsp(cH, nuImpact) - tsp(cH, nuHEnter));
  const c1 = makePatch(eph.moonId, cH, tEnter, nuHEnter, nuImpact, 'impact', eph.position(eph.moonId, tImpact));
  c1.tEnd = tImpact;
  const rImp = conicPosition(cH, nuImpact);
  const vImp = conicVelocity(cH, nuImpact);
  const impLL = latLonOnBody(eph, eph.moonId, rImp, tImpact);
  c1.markers.push({ kind: 'impact', ut: tImpact, bodyId: eph.moonId, r: rImp, altitude: 0, value: v3.len(vImp), ...impLL });

  // ---- node A on current[1], 20,000 km from the Moon on the way in
  const rA = 20e6;
  const nuA = -Math.acos((cH.p / rA - 1) / cH.e);
  const tA = tEnter + (tsp(cH, nuA) - tsp(cH, nuHEnter));
  const rAv = conicPosition(cH, nuA);
  const vAv = conicVelocity(cH, nuA);
  const frameA = nodeFrame(rAv, vAv);
  const nodeA: ManeuverNode = { id: 'node-a', ut: tA, dv: { prograde: 0, normal: 0, radial: 0 } };
  c1.markers.splice(0, 0, { kind: 'maneuverNode', ut: tA, bodyId: eph.moonId, r: rAv, nodeId: nodeA.id });

  // Search the correction for a flyby that clears the Moon and returns to a low Earth perigee.
  const flyby = (dvR: number, dvN: number) => {
    const v = v3.add(vAv, nodeDvInertial(frameA, { prograde: 0, normal: dvN, radial: dvR }));
    const h = conicFromState(muM, rAv, v, tA);
    if (h.e <= 1) return null;
    const rp = h.p / (1 + h.e);
    if (rp < Rm + 150e3) return null;
    const nuStart = conicTrueAnomaly(h, rAv);
    const nuExit = conicRadiusCrossing(h, soi);
    if (nuExit === null || nuStart >= nuExit) return null;
    const tExit = tA + (tsp(h, nuExit) - tsp(h, nuStart));
    const ms = eph.moonState(tExit);
    const rE = v3.add(conicPosition(h, nuExit), ms.r);
    const vE = v3.add(conicVelocity(h, nuExit), ms.v);
    const cE = conicFromState(muE, rE, vE, tExit);
    if (cE.e >= 0.985) return null;
    const { rp: rpE, ra: raE } = conicApsides(cE);
    const alt = rpE - earth.radius;
    // Perigee just above the atmosphere: node B (2.5 revolutions later, near perigee) then needs only a small burn.
    if (alt < atmTop + 10e3 || raE > 7e8) return null;
    return { h, nuStart, nuExit, tExit, rE, vE, cE, score: Math.abs(Math.log(alt / (atmTop + 40e3))) + Math.hypot(dvR, dvN) / 4000 };
  };
  type Best = { dvR: number; dvN: number; score: number };
  const scan = (r0: number, n0: number, span: number, step: number, seed: Best | null): Best | null => {
    let best = seed;
    for (let dvR = r0 - span; dvR <= r0 + span + 1e-9; dvR += step) {
      for (let dvN = n0 - span; dvN <= n0 + span + 1e-9; dvN += step) {
        const f = flyby(dvR, dvN);
        if (f && (!best || f.score < best.score)) best = { dvR, dvN, score: f.score };
      }
    }
    return best;
  };
  const coarse = scan(0, 0, 900, 30, null);
  if (!coarse) throw new Error('synthetic fixture: no free-return correction found');
  const chosen = scan(coarse.dvR, coarse.dvN, 30, 2, coarse)!;
  nodeA.dv = { prograde: 0, normal: Math.round(chosen.dvN * 10) / 10, radial: Math.round(chosen.dvR * 10) / 10 };
  const fb = flyby(nodeA.dv.radial, nodeA.dv.normal)!;

  // ---- planned[0]: lunar flyby
  const p0 = makePatch(eph.moonId, fb.h, tA, fb.nuStart, fb.nuExit, 'soiExit', eph.position(eph.moonId, fb.tExit), { nextBodyId: eph.rootId, afterNodeId: nodeA.id });
  p0.tEnd = fb.tExit;
  p0.markers = spanMarkers(p0, Rm, null).filter((m) => m.kind === 'periapsis');
  p0.markers.push({ kind: 'soiExit', ut: fb.tExit, bodyId: eph.moonId, r: conicPosition(fb.h, fb.nuExit) });

  // ---- planned[1..]: Earth orbit for 2.5 revolutions to node B (optionally split by correction nodes)
  const planned: Patch[] = [p0];
  const nodes: ManeuverNode[] = [nodeA];
  let c = fb.cE;
  let t = fb.tExit;
  let r = fb.rE;
  let nuS = conicTrueAnomaly(c, r);
  let after = nodeA.id;
  const segments = corrections + 1;
  const prng = new Prng(11);
  let nodeB: ManeuverNode | null = null;
  for (let sIdx = 0; sIdx < segments; sIdx++) {
    const nuE = nuS + (5 * Math.PI) / segments;
    const seg = makePatch(eph.rootId, c, t, nuS, nuE, 'maneuver', eph.position(eph.rootId, t), { afterNodeId: after });
    const end = { r: conicPosition(c, nuE), v: conicVelocity(c, nuE) };
    seg.markers = spanMarkers(seg, earth.radius, Wm);
    // Closest approach to the Moon over this segment (first interior minimum of the separation).
    const N = 1500;
    const dist = (tt: number): number => v3.dist(stateAt(c, tt).r, eph.moonState(tt).r);
    let prevD = dist(seg.tStart);
    let ca: number | null = null;
    for (let i = 1; i < N; i++) {
      const tt = seg.tStart + ((seg.tEnd - seg.tStart) * i) / N;
      const dd = dist(tt);
      const next = dist(seg.tStart + ((seg.tEnd - seg.tStart) * (i + 1)) / N);
      if (dd < prevD && dd <= next) {
        let lo = tt - (seg.tEnd - seg.tStart) / N;
        let hi = tt + (seg.tEnd - seg.tStart) / N;
        for (let k = 0; k < 80; k++) {
          const m1 = lo + (hi - lo) / 3;
          const m2 = hi - (hi - lo) / 3;
          if (dist(m1) < dist(m2)) hi = m2;
          else lo = m1;
        }
        ca = (lo + hi) / 2;
        break;
      }
      prevD = dd;
    }
    if (ca !== null) seg.markers.push({ kind: 'closestApproach', ut: ca, bodyId: eph.rootId, r: stateAt(c, ca).r, value: dist(ca) });
    const last = sIdx === segments - 1;
    const node: ManeuverNode = last
      ? { id: 'node-b', ut: seg.tEnd, dv: { prograde: 0, normal: 0, radial: 0 } }
      : { id: `node-c${sIdx + 1}`, ut: seg.tEnd, dv: { prograde: Math.round(prng.range(-0.6, 0.6) * 10) / 10, normal: 0, radial: Math.round(prng.range(-0.4, 0.4) * 10) / 10 } };
    seg.markers.push({ kind: 'maneuverNode', ut: seg.tEnd, bodyId: eph.rootId, r: end.r, nodeId: node.id });
    seg.markers.sort((a, b) => a.ut - b.ut);
    planned.push(seg);
    const frame = nodeFrame(end.r, end.v);
    if (last) {
      // Node B: the cheapest burn that puts the vacuum perigee 30-70 km up (atmosphere entry ahead).
      let bestB: { pro: number; rad: number; cost: number } | null = null;
      for (let pro = -1500; pro <= 0; pro += 10) {
        for (let rad = -1500; rad <= 1500; rad += 10) {
          const v = v3.add(end.v, nodeDvInertial(frame, { prograde: pro, normal: 0, radial: rad }));
          const cc = conicFromState(muE, end.r, v, seg.tEnd);
          const alt = cc.p / (1 + cc.e) - earth.radius;
          if (alt < 30e3 || alt > 70e3) continue;
          const cost = Math.hypot(pro, rad);
          if (!bestB || cost < bestB.cost) bestB = { pro, rad, cost };
        }
      }
      if (!bestB) throw new Error('synthetic fixture: no entry burn found for node B');
      node.dv = { prograde: bestB.pro, normal: 0, radial: bestB.rad };
      nodeB = node;
    }
    nodes.push(node);
    const v2 = v3.add(end.v, nodeDvInertial(frame, node.dv));
    c = conicFromState(muE, end.r, v2, seg.tEnd);
    t = seg.tEnd;
    r = end.r;
    nuS = conicTrueAnomaly(c, r);
    after = node.id;
  }

  // ---- planned[last]: Earth return to atmosphere entry
  const cross = conicRadiusCrossing(c, earth.radius + atmTop);
  if (cross === null) throw new Error('synthetic fixture: the return orbit does not reach the atmosphere');
  let nuEntry = -cross;
  while (nuEntry < nuS) nuEntry += TWO_PI;
  const pE = makePatch(eph.rootId, c, t, nuS, nuEntry, 'atmosphere', eph.position(eph.rootId, t), { afterNodeId: after });
  const rEn = conicPosition(c, nuEntry);
  const vEn = conicVelocity(c, nuEntry);
  const fpa = Math.asin(v3.dot(v3.normalize(rEn), v3.normalize(vEn)));
  pE.markers.push({
    kind: 'atmosphereEntry',
    ut: pE.tEnd,
    bodyId: eph.rootId,
    r: rEn,
    altitude: atmTop,
    value: v3.len(vEn),
    flightPathAngle: fpa,
    vacuumPeriapsisAltitude: c.p / (1 + c.e) - earth.radius,
    ...latLonOnBody(eph, eph.rootId, rEn, pE.tEnd),
  });
  planned.push(pE);

  if (!nodeB) throw new Error('synthetic fixture: node B missing');
  return { current: [c0, c1], planned, nodes, vesselState: now, impact: { lat: impLL.latitude, lon: impLL.longitude, ut: tImpact } };
}

// -------------------------------------------------------------------------------------- the snapshot

function vesselSnapshot(id: string, name: string, bodyId: string, r: Vec3, v: Vec3, bodyPos: Vec3, bodyVel: Vec3, controllable: boolean, situation: VesselSnapshot['situation']): VesselSnapshot {
  return {
    id,
    name,
    vehicleId: '',
    controllable,
    tier: 'rails',
    situation,
    translationMode: 'rails',
    bodyId,
    r,
    v,
    rRoot: v3.add(bodyPos, r),
    vRoot: v3.add(bodyVel, v),
    q: quat.identity(),
    w: v3.zero(),
    mass: controllable ? 30000 : 800,
    comLocal: v3.zero(),
    boundingRadius: controllable ? 20 : 3,
    parts: [],
    aero: { q: 0, mach: 0, aoa: 0, airDensity: 0, pressure: 0, temperature: 4, airVelocity: v3.zero(), heatFlux: 0, plasmaIntensity: 0 },
    gLoad: 0,
    properAccel: v3.zero(),
    contact: { anyContact: false, maxForce: 0, waterSubmersion: 0 },
    sunVisibility: 1,
    thrust: 0,
    age: 0,
  };
}

export function createSyntheticFixture(defs: DefLibrary, opts: SyntheticOptions = {}): SyntheticFixture {
  const ut = opts.ut ?? 8.89e8;
  const eph = buildEphemeris(defs);
  const built = buildChain(defs, eph, ut, opts.correctionNodes ?? 0);
  const earth = defs.bodies[eph.rootId]!;
  const moon = defs.bodies[eph.moonId]!;
  const starPos = eph.position(eph.starId, ut);

  const bodies: BodySnapshot[] = Object.values(defs.bodies).map((b) => {
    const pos = eph.position(b.id, ut);
    const o = eph.orientation(b.id, ut);
    const toSun = v3.sub(starPos, pos);
    return {
      id: b.id,
      rRoot: pos,
      vRoot: eph.velocity(b.id, ut),
      qFixedToRoot: o.q,
      spinRoot: o.spin,
      sunDir: b.id === eph.starId ? { x: 1, y: 0, z: 0 } : v3.normalize(toSun),
      sunDistance: v3.len(toSun),
      orbit: b.id === eph.moonId ? eph.moonConic : null,
      soiRadius: typeof b.soiRadius === 'number' ? b.soiRadius : null,
    };
  });

  // Surface targets: the landing target near the predicted impact, the launch site and its recovery zones.
  const landing: SurfaceTarget = {
    id: 'landing',
    name: 'Landing target',
    bodyId: eph.moonId,
    kind: 'landing',
    latitude: built.impact.lat + 0.45 * DEG,
    longitude: built.impact.lon + 0.6 * DEG,
    radius: 0,
  };
  const targets: SurfaceTarget[] = [landing];
  const site = Object.values(defs.sites)[0];
  if (site) {
    targets.push({ id: `site:${site.id}`, name: site.name, bodyId: site.bodyId, kind: 'site', latitude: site.location.latDeg * DEG, longitude: site.location.lonDeg * DEG, radius: site.pad.flatRadius });
    site.recoveryZones.forEach((z, i) =>
      targets.push({ id: `recovery:${i}`, name: z.name, bodyId: site.bodyId, kind: 'recovery', latitude: z.latDeg * DEG, longitude: z.lonDeg * DEG, radius: z.radiusKm * 1000 }),
    );
  }
  const missAngle = greatCircle(landing.latitude, landing.longitude, built.impact.lat, built.impact.lon);

  // Vessels: the active one on the departure arc, a relay satellite and 20 debris objects.
  const active = vesselSnapshot('synthetic-vessel', 'Kestrel', eph.rootId, built.vesselState.r, built.vesselState.v, v3.zero(), v3.zero(), true, 'escaping');
  const vessels: VesselSnapshot[] = [active];
  const relay = stateFromElements(earth.mu, 2.6e7, 0.08, 52 * DEG, 40 * DEG, 10 * DEG, 2.2);
  vessels.push(vesselSnapshot('relay-1', 'Relay 1', eph.rootId, relay.r, relay.v, v3.zero(), v3.zero(), true, 'orbiting'));
  const prng = new Prng(1234);
  for (let i = 0; i < 20; i++) {
    const rp = earth.radius + prng.range(250e3, 2500e3);
    const ra = rp + prng.range(0, 1) ** 2 * 3.5e7;
    const a = (rp + ra) / 2;
    const e = (ra - rp) / (ra + rp);
    const s = stateFromElements(earth.mu, a, e, prng.range(0, 100) * DEG, prng.range(0, 360) * DEG, prng.range(0, 360) * DEG, prng.range(0, 360) * DEG);
    vessels.push(vesselSnapshot(`debris-${i + 1}`, `Debris ${i + 1}`, eph.rootId, s.r, s.v, v3.zero(), v3.zero(), false, 'orbiting'));
  }

  const conic = built.current[0]!.conic;
  const aps = conicApsides(conic);
  const rNow = v3.len(built.vesselState.r);
  const readouts: Readouts = {
    met: 3 * 3600,
    altitudeAsl: rNow - earth.radius,
    altitudeRadar: rNow - earth.radius,
    ...(() => {
      const ll = latLonOnBody(eph, eph.rootId, built.vesselState.r, ut);
      return { latitude: ll.latitude, longitude: ll.longitude };
    })(),
    speedOrbital: v3.len(built.vesselState.v),
    speedSurface: v3.len(built.vesselState.v),
    verticalSpeed: v3.dot(built.vesselState.v, v3.normalize(built.vesselState.r)),
    horizontalSpeed: v3.len(v3.reject(built.vesselState.v, v3.normalize(built.vesselState.r))),
    apoapsisAltitude: aps.ra - earth.radius,
    periapsisAltitude: aps.rp - earth.radius,
    timeToApoapsis: null,
    timeToPeriapsis: null,
    inclination: conic.inc,
    eccentricity: conic.e,
    period: conic.period,
    throttle: 0,
    thrust: 0,
    twr: 0,
    mass: active.mass,
    gLoad: 0,
    gDose: 0,
    gDoseLimit: 15,
    dynamicPressure: 0,
    mach: 0,
    angleOfAttack: 0,
    heatFlux: 0,
    ablatorFraction: 1,
    maxTempFraction: 0.1,
    sasEnabled: true,
    sasMode: 'stability',
    sasModesAvailable: ['stability', 'prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn', 'maneuver'],
    rcsEnabled: false,
    fineControl: false,
    legsDeployed: false,
    lightsOn: false,
    chuteEnvelope: 'safe',
    rcsFraction: 1,
    deltaVTotal: 4200,
    targetBodyId: eph.moonId,
    targetRelativeInclination: v3.angle(conic.W, eph.moonConic.W),
    targetClosestApproach: null,
    launchWindow: null,
    nodeBurn: null,
    liftVectorUp: null,
    tiltFromVertical: 0,
    landingTarget: {
      targetId: landing.id,
      distance: missAngle * moon.radius,
      bearingDeg: bearingDeg(built.impact.lat, built.impact.lon, landing.latitude, landing.longitude),
      downRange: 0,
      crossRange: 0,
      predicted: {
        kind: 'impact',
        ut: built.impact.ut,
        latitude: built.impact.lat,
        longitude: built.impact.lon,
        missDistance: missAngle * moon.radius,
        missBearingDeg: bearingDeg(landing.latitude, landing.longitude, built.impact.lat, built.impact.lon),
      },
    },
  };

  const snapshot: SimSnapshot = {
    ut,
    simUt: ut,
    tick: 1,
    warp: { index: 0, factor: 1, maxIndex: 10, limitedBy: null, onRails: true },
    scenario: { id: 'synthetic', startKind: 'state', stagesAlreadyFired: 0 },
    surfaceTargets: targets,
    terrain: { complete: true, pending: false, incompleteQueries: 0 },
    bodies,
    starId: eph.starId,
    vessels,
    activeVesselId: active.id,
    appliedControls: { ...NEUTRAL_CONTROLS, translate: v3.zero() },
    navball: {
      mode: 'orbit',
      qVesselToHorizon: quat.identity(),
      markers: {
        prograde: { x: 0, y: 1, z: 0 },
        retrograde: { x: 0, y: -1, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        antinormal: { x: 0, y: 0, z: -1 },
        radialOut: { x: 1, y: 0, z: 0 },
        radialIn: { x: -1, y: 0, z: 0 },
        maneuver: null,
        target: null,
        antiTarget: null,
        liftVector: null,
      },
      pitchDeg: 0,
      headingDeg: 90,
      rollDeg: 0,
    },
    readouts,
    staging: { nextStage: 0, stages: [], lockout: false },
    patches: { current: built.current, planned: built.planned },
    nodes: built.nodes,
    events: [],
    milestones: [],
    mission: { failed: false, failureReason: null, crewAlive: true },
    cheatCounter: 0,
  };
  const nodeA = built.nodes[0]!;
  const nodeB = built.nodes.find((n) => n.id === 'node-b')!;
  return {
    snapshot,
    bodyPosition: (id, t) => eph.position(id, t),
    rootId: eph.rootId,
    moonId: eph.moonId,
    starId: eph.starId,
    nodeA,
    nodeB,
  };
}

export const createSyntheticSnapshot = (defs: DefLibrary, opts: SyntheticOptions = {}): SimSnapshot => createSyntheticFixture(defs, opts).snapshot;
