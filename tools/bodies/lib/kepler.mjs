// Orbit and frame maths of tools/bodies, written to the semantics of the v2 body contract
// (src/core/contracts/defs.ts) and of the v1 runtime (src/sim/bodies): the generator's validation evaluates the
// staged definitions exactly as the body system will.
//
//   KeplerOrbitDef  element(ut) = element0 + rate x (ut - epochUt) / (36525 d), M(ut) = M0 + n (ut - epochUt),
//                   n = meanMotionDegPerDay (else sqrt(mu / a^3)); plane frames:
//                     'ecliptic'       Rx(+obliquity J2000), the runtime's Q_ECLIPTIC_TO_EQUATORIAL
//                     'parentEquator'  the parent's spin pole (RotationDef.poleRaDeg / poleDecDeg)
//                     { pole }         an explicit plane normal in ICRF
//                   A pole frame is Rz(ra + 90 deg) Rx(90 deg - dec) (src/sim/bodies/rotation.ts poleQuat): its +X
//                   axis is the ascending node of the plane on the ICRF equator, the origin of the JPL satellite
//                   tables' node ("measured from the node of the reference plane on the ICRF equator").
//   sunLowPrecision the Astronomical Almanac low-precision Sun of src/sim/bodies/ephemeris.ts, verbatim;
//                   inverted = minus that vector (Earth about the Sun).

export const DEG = Math.PI / 180;
/** J2000 obliquity of the runtime (src/sim/bodies/ephemeris.ts OBLIQUITY_J2000), degrees. */
export const OBLIQUITY_J2000_DEG = 23.4392911;
export const AU_M = 149597870700;
export const DAY_S = 86400;
export const CENTURY_S = 36525 * DAY_S;
export const JD_J2000 = 2451545.0;

export const utToJd = (ut) => JD_J2000 + ut / DAY_S;
export const jdToUt = (jd) => (jd - JD_J2000) * DAY_S;

// ------------------------------------------------------------------------------------------------- vectors

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => scale(a, 1 / len(a));
/** Angle between two vectors, radians (stable for small angles). */
export const angleBetween = (a, b) => Math.atan2(len(cross(a, b)), dot(a, b));

// ------------------------------------------------------------------------------------------------ matrices

/** 3x3 matrices as row-major arrays of rows. */
export const matMul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
export const matVec = (A, v) => A.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
export const transpose = (A) => [0, 1, 2].map((i) => [A[0][i], A[1][i], A[2][i]]);
export const rotX = (t) => [[1, 0, 0], [0, Math.cos(t), -Math.sin(t)], [0, Math.sin(t), Math.cos(t)]];
export const rotZ = (t) => [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]];

/** Elements' plane -> ICRF for a plane with normal (ra, dec): Rz(ra + 90) Rx(90 - dec). */
export const poleFrame = (raDeg, decDeg) => matMul(rotZ((raDeg + 90) * DEG), rotX((90 - decDeg) * DEG));
/** Ecliptic J2000 -> ICRF. */
export const ECLIPTIC_TO_ICRF = rotX(OBLIQUITY_J2000_DEG * DEG);

/** Unit vector of a direction (ra, dec) in degrees. */
export const radecToVec = (raDeg, decDeg) => [Math.cos(decDeg * DEG) * Math.cos(raDeg * DEG), Math.cos(decDeg * DEG) * Math.sin(raDeg * DEG), Math.sin(decDeg * DEG)];
export const vecToRadec = (v) => {
  const u = norm(v);
  let ra = Math.atan2(u[1], u[0]) / DEG;
  if (ra < 0) ra += 360;
  return { raDeg: ra, decDeg: Math.asin(Math.max(-1, Math.min(1, u[2]))) / DEG };
};

// ------------------------------------------------------------------------------------------------ anomalies

export function eccentricFromMean(e, M) {
  let Mr = M % (2 * Math.PI);
  if (Mr > Math.PI) Mr -= 2 * Math.PI;
  if (Mr < -Math.PI) Mr += 2 * Math.PI;
  let E = e < 0.8 ? Mr : Math.PI * Math.sign(Mr || 1);
  for (let k = 0; k < 50; k++) {
    const f = E - e * Math.sin(E) - Mr;
    const d = f / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-15) break;
  }
  return E + (M - Mr);
}

export const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
export const wrap360 = (d) => ((d % 360) + 360) % 360;

/**
 * State (m, m/s) in the elements' plane frame rotated to ICRF by `plane`, for elements
 * { a (m), e, iDeg, lanDeg, argPeDeg, M (rad) } and the mean anomaly rate n (rad/s).
 */
export function stateFromElements(el, n, plane) {
  const E = eccentricFromMean(el.e, el.M);
  const cE = Math.cos(E);
  const sE = Math.sin(E);
  const b = el.a * Math.sqrt(1 - el.e * el.e);
  const x = el.a * (cE - el.e);
  const y = b * sE;
  const Edot = n / (1 - el.e * cE);
  const vx = -el.a * sE * Edot;
  const vy = b * cE * Edot;
  const O = el.lanDeg * DEG;
  const w = el.argPeDeg * DEG;
  const i = el.iDeg * DEG;
  const cO = Math.cos(O), sO = Math.sin(O), cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(i), si = Math.sin(i);
  const P = [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si];
  const Q = [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si];
  const r = add(scale(P, x), scale(Q, y));
  const v = add(scale(P, vx), scale(Q, vy));
  return { r: matVec(plane, r), v: matVec(plane, v) };
}

/**
 * Evaluate a KeplerOrbitDef at `ut`. `muSum` = mu used when meanMotionDegPerDay is absent; `parentPole` =
 * { raDeg, decDeg } of the parent's RotationDef (needed for 'parentEquator').
 */
export function keplerState(def, ut, { muSum, parentPole } = {}) {
  const dtCy = (ut - def.epochUt) / CENTURY_S;
  const r = def.rates ?? {};
  const el = {
    a: def.a + (r.a ?? 0) * dtCy,
    e: def.e + (r.e ?? 0) * dtCy,
    iDeg: def.iDeg + (r.iDeg ?? 0) * dtCy,
    lanDeg: def.lanDeg + (r.lanDeg ?? 0) * dtCy,
    argPeDeg: def.argPeDeg + (r.argPeDeg ?? 0) * dtCy,
  };
  const n = def.meanMotionDegPerDay !== undefined ? (def.meanMotionDegPerDay * DEG) / DAY_S : Math.sqrt(muSum / el.a ** 3);
  el.M = def.meanAnomalyDeg * DEG + n * (ut - def.epochUt);
  let plane;
  if (def.frame === 'ecliptic') plane = ECLIPTIC_TO_ICRF;
  else if (def.frame === 'parentEquator') {
    if (!parentPole) throw new Error('keplerState: parentEquator needs the parent pole');
    plane = poleFrame(parentPole.raDeg, parentPole.decDeg);
  } else plane = poleFrame(def.frame.pole.raDeg, def.frame.pole.decDeg);
  return stateFromElements(el, n, plane);
}

/** src/sim/bodies/ephemeris.ts sunLowPrecisionState, verbatim (geocentric Sun, m, m/s). */
export function sunLowPrecisionState(ut) {
  const d = ut / 86400;
  const Ldeg = (280.46 + 0.9856474 * d) % 360;
  const gdeg = (357.528 + 0.9856003 * d) % 360;
  const g = gdeg * DEG;
  const sg = Math.sin(g);
  const cg = Math.cos(g);
  const s2g = Math.sin(2 * g);
  const c2g = Math.cos(2 * g);
  const lambda = Ldeg * DEG + (1.915 * sg + 0.02 * s2g) * DEG;
  const eps = (23.439 - 0.0000004 * d) * DEG;
  const R = (1.00014 - 0.01671 * cg - 0.00014 * c2g) * AU_M;
  const cl = Math.cos(lambda);
  const sl = Math.sin(lambda);
  const ce = Math.cos(eps);
  const se = Math.sin(eps);
  const SUN_DL = 0.9856474 * DEG;
  const SUN_DG = 0.9856003 * DEG;
  const dLambda = SUN_DL + (1.915 * cg + 0.04 * c2g) * DEG * SUN_DG;
  const dEps = -0.0000004 * DEG;
  const dR = (0.01671 * sg + 0.00028 * s2g) * SUN_DG * AU_M;
  const k = 1 / 86400;
  return {
    r: [R * cl, R * ce * sl, R * se * sl],
    v: [
      (dR * cl - R * sl * dLambda) * k,
      (dR * ce * sl + R * (-se * dEps * sl + ce * cl * dLambda)) * k,
      (dR * se * sl + R * (ce * dEps * sl + se * cl * dLambda)) * k,
    ],
  };
}

/** Evaluate any OrbitDef relative to the parent (ICRF axes). */
export function orbitState(orbit, ut, ctx) {
  if (orbit.kind === 'kepler') return keplerState(orbit, ut, ctx);
  if (orbit.kind === 'sunLowPrecision') {
    const s = sunLowPrecisionState(ut);
    return orbit.inverted ? { r: scale(s.r, -1), v: scale(s.v, -1) } : s;
  }
  throw new Error(`orbitState: unknown orbit kind ${orbit.kind}`);
}

/** Classical elements of a state about mu (radians; for fitting and reports). */
export function elementsFromState(r, v, mu) {
  const h = cross(r, v);
  const rl = len(r);
  const ev = sub(scale(cross(v, h), 1 / mu), scale(r, 1 / rl));
  const e = len(ev);
  const energy = dot(v, v) / 2 - mu / rl;
  const a = -mu / (2 * energy);
  const i = Math.acos(h[2] / len(h));
  const nodeV = [-h[1], h[0], 0];
  const nl = len(nodeV);
  let O = nl > 0 ? Math.atan2(nodeV[1], nodeV[0]) : 0;
  let w = nl > 0 && e > 0 ? Math.atan2(dot(cross(nodeV, ev), h) / len(h), dot(nodeV, ev)) : 0;
  let nu = e > 0 ? Math.atan2(dot(cross(ev, r), h) / len(h), dot(ev, r)) : 0;
  if (O < 0) O += 2 * Math.PI;
  if (w < 0) w += 2 * Math.PI;
  if (nu < 0) nu += 2 * Math.PI;
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
  const M = E - e * Math.sin(E);
  return { a, e, i, O, w, nu, M: M < 0 ? M + 2 * Math.PI : M, h };
}
