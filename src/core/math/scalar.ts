export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const TWO_PI = Math.PI * 2;
/** Standard gravity used for Isp and g-load, m/s^2. */
export const G0 = 9.80665;

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const saturate = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
/** Wrap an angle to (-pi, pi]. */
export const wrapPi = (a: number): number => {
  const r = a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
  return r === -Math.PI ? Math.PI : r;
};
/** Wrap an angle to [0, 2 pi). */
export const wrapTwoPi = (a: number): number => a - TWO_PI * Math.floor(a / TWO_PI);

/** Piecewise-linear table lookup with clamped ends. `xs` must be strictly increasing. */
export function interpTable(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (n === 0 || ys.length !== n) throw new Error('interpTable: bad table');
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]!) / (xs[hi]! - xs[lo]!);
  return ys[lo]! + (ys[hi]! - ys[lo]!) * t;
}
