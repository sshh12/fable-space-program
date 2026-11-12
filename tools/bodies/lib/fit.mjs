// Least-squares fit of orbit elements to Horizons state vectors (the brief's fallback path for the moons whose
// mean-element convention does not reproduce): the plane (inclination and node on the moon's reference plane),
// the periapsis and the phase are fitted at an epoch; a, e, the period and the precession rates stay the table's.
import { DEG, elementsFromState, jdToUt, keplerState, matVec, transpose, poleFrame, len, sub } from './kepler.mjs';

/** Gauss-Newton with Levenberg damping and numerical derivatives. `resid(p)` returns an array of residuals. */
export function leastSquares(resid, p0, { steps = [1e-6], iterations = 60 } = {}) {
  let p = p0.slice();
  let r = resid(p);
  let cost = r.reduce((s, x) => s + x * x, 0);
  let lambda = 1e-3;
  for (let it = 0; it < iterations; it++) {
    const J = p.map((_, k) => {
      const h = steps[k] ?? steps[0];
      const q = p.slice();
      q[k] += h;
      const rq = resid(q);
      return rq.map((x, i) => (x - r[i]) / h);
    });
    const m = p.length;
    const A = Array.from({ length: m }, (_, a) => Array.from({ length: m }, (_, b) => J[a].reduce((s, x, i) => s + x * J[b][i], 0)));
    const g = Array.from({ length: m }, (_, a) => J[a].reduce((s, x, i) => s + x * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const Ad = A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) : v)));
      const dp = solve(Ad, g.map((x) => -x));
      const q = p.map((v, k) => v + dp[k]);
      const rq = resid(q);
      const cq = rq.reduce((s, x) => s + x * x, 0);
      if (cq < cost) {
        const rel = (cost - cq) / Math.max(cost, 1e-300);
        p = q;
        r = rq;
        cost = cq;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        if (rel < 1e-14) return { p, cost, residuals: r };
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { p, cost, residuals: r };
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Fit iDeg, lanDeg, argPeDeg and meanAnomalyDeg of `base` (a KeplerOrbitDef whose frame is a pole frame, with
 * a, e, meanMotionDegPerDay and rates already set) at base.epochUt to Horizons samples [{ jd, r, v }] given in
 * ICRF axes relative to the parent. Returns the fitted def and the rms / max position residual (m).
 */
export function fitPlanePhase(base, samples, { muSum }) {
  const plane = poleFrame(base.frame.pole.raDeg, base.frame.pole.decDeg);
  const toPlane = transpose(plane);
  // Initial guess: osculating elements of the sample nearest the epoch, in the reference plane.
  const s0 = samples.reduce((best, s) => (Math.abs(jdToUt(s.jd) - base.epochUt) < Math.abs(jdToUt(best.jd) - base.epochUt) ? s : best));
  const el = elementsFromState(matVec(toPlane, s0.r), matVec(toPlane, s0.v), muSum);
  const dt0 = jdToUt(s0.jd) - base.epochUt;
  const n = (base.meanMotionDegPerDay * DEG) / 86400;
  const p0 = [el.i / DEG, el.O / DEG, el.w / DEG, (el.M - n * dt0) / DEG];
  const make = (p) => ({ ...base, iDeg: p[0], lanDeg: p[1], argPeDeg: p[2], meanAnomalyDeg: p[3] });
  const resid = (p) => {
    const d = make(p);
    const out = [];
    for (const s of samples) {
      const m = keplerState(d, jdToUt(s.jd), { muSum });
      const e = sub(m.r, s.r);
      out.push(e[0] / base.a, e[1] / base.a, e[2] / base.a);
    }
    return out;
  };
  const res = leastSquares(resid, p0, { steps: [1e-5, 1e-5, 1e-5, 1e-5] });
  const def = make(res.p.map((x, k) => (k === 0 ? x : ((x % 360) + 360) % 360)));
  let max = 0;
  let sum = 0;
  for (const s of samples) {
    const m = keplerState(def, jdToUt(s.jd), { muSum });
    const d = len(sub(m.r, s.r));
    max = Math.max(max, d);
    sum += d * d;
  }
  return { def, rms: Math.sqrt(sum / samples.length), max };
}
