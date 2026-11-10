/**
 * Scalar root finding and minimisation used by the event finders. Pure, deterministic, allocation-free.
 */

/**
 * Brent's method (zeroin) for a root of `f` in [a, b]. Requires f(a) and f(b) of opposite sign (or one of
 * them zero). Returns the abscissa to within `tol` (absolute). `fa`/`fb` may be passed when already known.
 */
export function brentRoot(f: (x: number) => number, a: number, b: number, tol: number, fa = f(a), fb = f(b), maxIter = 200): number {
  if (fa === 0) return a;
  if (fb === 0) return b;
  if ((fa > 0) === (fb > 0)) throw new Error(`brentRoot: root not bracketed in [${a}, ${b}] (f = ${fa}, ${fb})`);
  let c = a;
  let fc = fa;
  let d = b - a;
  let e = d;
  for (let i = 0; i < maxIter; i++) {
    if ((fb > 0) === (fc > 0)) {
      c = a;
      fc = fa;
      d = b - a;
      e = d;
    }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b;
      b = c;
      c = a;
      fa = fb;
      fb = fc;
      fc = fa;
    }
    const tol1 = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tol;
    const xm = 0.5 * (c - b);
    if (Math.abs(xm) <= tol1 || fb === 0) return b;
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa;
      let p: number;
      let q: number;
      if (a === c) {
        p = 2 * xm * s;
        q = 1 - s;
      } else {
        const qq = fa / fc;
        const r = fb / fc;
        p = s * (2 * xm * qq * (qq - r) - (b - a) * (r - 1));
        q = (qq - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      else p = -p;
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) {
        e = d;
        d = p / q;
      } else {
        d = xm;
        e = d;
      }
    } else {
      d = xm;
      e = d;
    }
    a = b;
    fa = fb;
    b += Math.abs(d) > tol1 ? d : xm > 0 ? tol1 : -tol1;
    fb = f(b);
  }
  return b;
}

/**
 * First sign change of `f` going from `a` (f(a) > 0) to `b` (f(b) <= 0), by bisection to `tol`. Returns the
 * right end of the final bracket: the earliest abscissa found at which f <= 0.
 */
export function bisectToNonPositive(f: (x: number) => number, a: number, b: number, tol: number): number {
  let lo = a;
  let hi = b;
  while (hi - lo > tol) {
    const mid = 0.5 * (lo + hi);
    if (mid <= lo || mid >= hi) break;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return hi;
}

const INV_PHI = (Math.sqrt(5) - 1) / 2;

/** Golden-section search for the minimum of a unimodal `f` on [a, b]; returns { x, fx }. */
export function goldenMin(f: (x: number) => number, a: number, b: number, tol: number): { x: number; fx: number } {
  let lo = a;
  let hi = b;
  let x1 = hi - INV_PHI * (hi - lo);
  let x2 = lo + INV_PHI * (hi - lo);
  let f1 = f(x1);
  let f2 = f(x2);
  while (hi - lo > tol) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - INV_PHI * (hi - lo);
      f1 = f(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + INV_PHI * (hi - lo);
      f2 = f(x2);
    }
  }
  return f1 < f2 ? { x: x1, fx: f1 } : { x: x2, fx: f2 };
}
