// Least-squares fit of a precessing Kepler ellipse (the element set KeplerOrbitDef carries) to Horizons state
// vectors: a, e, i, node, argument of periapsis and mean anomaly at the epoch, the mean motion, and linear rates
// of the node and the apsis (the lead's decision on request bodies-ephemeris-4). Everything in the plane frame
// of the orbit's reference plane (ecliptic, Laplace plane or parent equator).
//
// Internally the elements are non-singular: h, k = e (sin, cos) of the longitude of periapsis w~; p, q =
// tan(i/2) (sin, cos) of the node; the mean longitude L0 = node + argPe + M at the epoch; the mean-longitude rate
// nL and the rates of node and w~. Then (contract form): argPe = w~ - node, M = L - w~, meanMotionDegPerDay =
// nL - rate(w~), rates.lanDeg = rate(node), rates.argPeDeg = rate(w~) - rate(node).
import { leastSquares } from './fit.mjs';
import { DAY_S, DEG, eccentricFromMean, elementsFromState, jdToUt, matVec, transpose } from './kepler.mjs';

const TWO_PI = 2 * Math.PI;

/** Position in the plane frame at dt days after the epoch, for internal parameters x. */
function positionAt(x, dtDays) {
  const [a, h, k, p, q, L0, nL, rO, rW] = x;
  const e = Math.hypot(h, k);
  const w0 = Math.atan2(h, k);
  const ti = Math.hypot(p, q);
  const i = 2 * Math.atan(ti);
  const O = Math.atan2(p, q) + rO * dtDays;
  const W = w0 + rW * dtDays;
  const M = L0 + nL * dtDays - W;
  const w = W - O;
  const E = eccentricFromMean(e, M);
  const xo = a * (Math.cos(E) - e);
  const yo = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cO = Math.cos(O), sO = Math.sin(O), cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(i), si = Math.sin(i);
  return [
    (cO * cw - sO * sw * ci) * xo + (-cO * sw - sO * cw * ci) * yo,
    (sO * cw + cO * sw * ci) * xo + (-sO * sw + cO * cw * ci) * yo,
    sw * si * xo + cw * si * yo,
  ];
}

/** Internal parameters from contract-like start values (angles in degrees, rates in deg/day). */
export function toInternal(s) {
  const W = (s.lanDeg + s.argPeDeg) * DEG;
  const ti = Math.tan((s.iDeg * DEG) / 2);
  return [s.a, s.e * Math.sin(W), s.e * Math.cos(W), ti * Math.sin(s.lanDeg * DEG), ti * Math.cos(s.lanDeg * DEG), W + s.meanAnomalyDeg * DEG, (s.meanMotionDegPerDay + s.apsisRateDegPerDay) * DEG, s.nodeRateDegPerDay * DEG, s.apsisRateDegPerDay * DEG];
}

/** Contract KeplerOrbitDef from internal parameters. */
export function toOrbitDef(x, frame, epochUt) {
  const [a, h, k, p, q, L0, nL, rO, rW] = x;
  const e = Math.hypot(h, k);
  const W = Math.atan2(h, k);
  const O = Math.atan2(p, q);
  const i = 2 * Math.atan(Math.hypot(p, q));
  const wrap = (r) => ((((r / DEG) % 360) + 360) % 360);
  return {
    kind: 'kepler',
    frame,
    a,
    e,
    iDeg: i / DEG,
    lanDeg: wrap(O),
    argPeDeg: wrap(W - O),
    meanAnomalyDeg: wrap(L0 - W),
    epochUt,
    rates: { lanDeg: (rO / DEG) * 36525, argPeDeg: ((rW - rO) / DEG) * 36525 },
    meanMotionDegPerDay: (nL - rW) / DEG,
  };
}

/** Osculating start values (plane frame) of the sample nearest the epoch. */
export function osculatingStart(samples, plane, epochUt, mu) {
  const toPlane = transpose(plane);
  const s = samples.reduce((b, x) => (Math.abs(jdToUt(x.jd) - epochUt) < Math.abs(jdToUt(b.jd) - epochUt) ? x : b));
  const el = elementsFromState(matVec(toPlane, s.r), matVec(toPlane, s.v), mu);
  const n = Math.sqrt(mu / el.a ** 3) * DAY_S / DEG;
  const dt = (jdToUt(s.jd) - epochUt) / DAY_S;
  return { a: el.a, e: el.e, iDeg: el.i / DEG, lanDeg: el.O / DEG, argPeDeg: el.w / DEG, meanAnomalyDeg: el.M / DEG - n * dt, meanMotionDegPerDay: n };
}

/**
 * Fit. `samples` = [{ jd, r }] relative to the parent (ICRF), `plane` = plane -> ICRF matrix, `start` = start
 * values (contract-like, at the epoch), `stages` = growing time spans (days from the epoch, both sides) over
 * which the fit is extended so the mean longitude is never ambiguous. Returns the internal parameters and the
 * residual statistics over all samples.
 */
export function fitEllipse(samples, plane, epochUt, start, { stages, fixRates = false }) {
  const toPlane = transpose(plane);
  const data = samples.map((s) => ({ dt: (jdToUt(s.jd) - epochUt) / DAY_S, r: matVec(toPlane, s.r) })).sort((a, b) => Math.abs(a.dt) - Math.abs(b.dt));
  let x = toInternal(start);
  const scale = x[0];
  const free = fixRates ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const steps = [x[0] * 1e-7, 1e-7, 1e-7, 1e-7, 1e-7, 1e-7, 1e-9, 1e-10, 1e-10];
  for (const span of stages) {
    const use = data.filter((d) => Math.abs(d.dt) <= span);
    if (use.length < 12) continue;
    const resid = (pf) => {
      const xx = x.slice();
      free.forEach((j, m) => (xx[j] = pf[m]));
      const out = [];
      for (const d of use) {
        const m = positionAt(xx, d.dt);
        out.push((m[0] - d.r[0]) / scale, (m[1] - d.r[1]) / scale, (m[2] - d.r[2]) / scale);
      }
      return out;
    };
    const res = leastSquares(resid, free.map((j) => x[j]), { steps: free.map((j) => steps[j]), iterations: 80 });
    free.forEach((j, m) => (x[j] = res.p[m]));
    x[5] = ((x[5] % TWO_PI) + TWO_PI) % TWO_PI;
  }
  return { x, positionAt: (dt) => matVec(plane, positionAt(x, dt)) };
}
