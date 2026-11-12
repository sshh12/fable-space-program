// Levenberg-Marquardt least squares with numerical derivatives (used by lib/ellipseFit.mjs).

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
