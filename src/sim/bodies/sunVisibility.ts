/**
 * Visible fraction of the solar disc seen from a point, behind any number of occulting spheres
 * (umbra 0, penumbra, annular, full light 1).
 *
 * Geometry is done in the plane tangent to the sky at the Sun's centre (azimuthal-equidistant about the
 * Sun direction). The Sun is a circle of angular radius rs. An occulting body of angular radius rb whose
 * limb passes at angular distance e = sep - rb from the Sun's centre is represented by its OSCULATING
 * circle there: radius tan(rb) (the geodesic curvature of a small circle of radius rb is cot rb), centre at
 * distance e + tan(rb). The limb position along the Sun-body line is exact; area and curvature errors of
 * the tangent-plane picture are of order r^2 relative (rs, rb ~ 0.0047 rad for Sun and Moon discs: ~1e-5
 * of the disc), and the model stays correct for bodies that fill half the sky, e.g. the Earth seen from
 * the pad (rb = 90 deg: a straight horizon).
 *
 * The overlap of two circles is the sum of two circular segments, each evaluated as r^2 (a - sin a cos a)
 * with the half-angle a, with a series for small a, so a huge osculating radius has no cancellation.
 * When two or more bodies overlap the disc at the same time (only possible when one body is in front of
 * the other as seen from the point), the visible area is integrated numerically over the disc (exact
 * union of the covered chords; 512 strips in the substitution x = rs sin(theta), error < 1e-5).
 */
import { v3, type Vec3 } from '../../core/math/vec3';

/** g(a) = a - sin(a) cos(a) = (2a - sin 2a)/2, cancellation-free. */
function segG(a: number): number {
  if (Math.abs(a) < 0.1) {
    const u = 2 * a;
    const u2 = u * u;
    // (u - sin u)/2 = (u^3/6 - u^5/120 + u^7/5040 - u^9/362880 + u^11/39916800)/2
    return (u * u2 * (1 / 6 - u2 * (1 / 120 - u2 * (1 / 5040 - u2 * (1 / 362880 - u2 / 39916800))))) / 2;
  }
  return a - Math.sin(a) * Math.cos(a);
}

/** An occulter in the tangent plane: osculating circle (rho finite) or straight edge (rho = Infinity). */
interface PlaneOcculter {
  /** Unit direction (2-D) from the Sun's centre toward the occulter's centre. */
  ux: number;
  uy: number;
  /** Signed distance from the Sun's centre to the limb along u (positive: Sun centre outside). */
  e: number;
  /** Osculating radius (Infinity for a straight limb). */
  rho: number;
}

const HALF_PLANE_RATIO = 1e7;

/**
 * Fraction (0..1) of a solar disc of angular radius `rs` covered by ONE occulter of angular radius `rb`
 * whose centre is `sep` radians from the Sun's centre.
 */
export function occultedFraction(rs: number, rb: number, sep: number): number {
  const e = sep - rb;
  if (e >= rs) return 0;
  const rho = rb >= Math.PI / 2 ? Infinity : Math.tan(rb);
  if (!(rho < HALF_PLANE_RATIO * rs)) {
    // Straight limb at distance e from the centre: covered segment beyond the chord at x = e.
    if (e <= -rs) return 1;
    const y = Math.sqrt(rs * rs - e * e);
    const a = Math.atan2(y, e);
    return (rs * rs * segG(a)) / (Math.PI * rs * rs);
  }
  const D = e + rho;
  if (D <= rho - rs) return 1; // Sun entirely behind the body
  if (D <= rs - rho) return (rho * rho) / (rs * rs); // body entirely inside the disc (annular)
  // Partial overlap: chord at x from the Sun's centre (toward the occulter), D - x from the occulter centre.
  const x = (e * (e + 2 * rho) + rs * rs) / (2 * D);
  const y = Math.sqrt(Math.max(0, rs * rs - x * x));
  const dmx = rho + (e * e - rs * rs) / (2 * D);
  const a1 = Math.atan2(y, x);
  const a2 = Math.atan2(y, dmx);
  const overlap = rs * rs * segG(a1) + rho * rho * segG(a2);
  return Math.min(1, Math.max(0, overlap / (Math.PI * rs * rs)));
}

/** Covered y-interval of the vertical line at abscissa x by an occulter, or null. */
function coveredInterval(o: PlaneOcculter, x: number): [number, number] | null {
  if (!Number.isFinite(o.rho)) {
    // half-plane: points p with p . u >= e
    if (Math.abs(o.uy) < 1e-15) return x * o.ux >= o.e ? [-Infinity, Infinity] : null;
    const y0 = (o.e - x * o.ux) / o.uy;
    return o.uy > 0 ? [y0, Infinity] : [-Infinity, y0];
  }
  const D = o.e + o.rho;
  const cx = D * o.ux;
  const cy = D * o.uy;
  const dx = x - cx;
  if (Math.abs(dx) >= o.rho) return null;
  const w = Math.sqrt(o.rho * o.rho - dx * dx);
  return [cy - w, cy + w];
}

function unionVisibleFraction(rs: number, occ: PlaneOcculter[]): number {
  const N = 512;
  let visible = 0;
  let total = 0;
  const ivs: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const th = -Math.PI / 2 + ((i + 0.5) * Math.PI) / N;
    const x = rs * Math.sin(th);
    const c = rs * Math.cos(th);
    const weight = rs * Math.cos(th); // dx = rs cos(th) dth
    ivs.length = 0;
    for (const o of occ) {
      const iv = coveredInterval(o, x);
      if (!iv) continue;
      const lo = Math.max(-c, iv[0]);
      const hi = Math.min(c, iv[1]);
      if (hi > lo) ivs.push([lo, hi]);
    }
    ivs.sort((p, q) => p[0] - q[0]);
    let covered = 0;
    let curLo = -Infinity;
    let curHi = -Infinity;
    for (const [lo, hi] of ivs) {
      if (lo > curHi) {
        if (curHi > curLo) covered += curHi - curLo;
        curLo = lo;
        curHi = hi;
      } else if (hi > curHi) curHi = hi;
    }
    if (curHi > curLo) covered += curHi - curLo;
    visible += (2 * c - covered) * weight;
    total += 2 * c * weight;
  }
  return Math.max(0, Math.min(1, visible / total));
}

/** A sphere that can hide the Sun. */
export interface OccultingSphere {
  centre: Vec3;
  radius: number;
}

/**
 * Visible fraction of the disc of a star (centre `starPos`, radius `starRadius`) seen from `point`
 * behind the given spheres. All positions in one frame. Returns 0 when the point is inside a sphere.
 */
export function sunVisibleFraction(point: Vec3, starPos: Vec3, starRadius: number, spheres: readonly OccultingSphere[]): number {
  const toSun = v3.sub(starPos, point);
  const dS = v3.len(toSun);
  if (!(dS > starRadius)) return 1;
  const sHat = v3.scale(toSun, 1 / dS);
  const rs = Math.asin(starRadius / dS);
  const hits: { o: OccultingSphere; rb: number; sep: number; dir: Vec3; f: number }[] = [];
  for (const sp of spheres) {
    const toB = v3.sub(sp.centre, point);
    const dB = v3.len(toB);
    if (!(dB > sp.radius)) return 0;
    if (dB - sp.radius >= dS) continue; // entirely beyond the star
    const bHat = v3.scale(toB, 1 / dB);
    const rb = Math.asin(Math.min(1, sp.radius / dB));
    const sep = v3.angle(sHat, bHat);
    if (sep - rb >= rs) continue;
    const f = occultedFraction(rs, rb, sep);
    if (f > 0) hits.push({ o: sp, rb, sep, dir: bHat, f });
  }
  if (hits.length === 0) return 1;
  if (hits.length === 1) return 1 - hits[0]!.f;
  // Several occulters on the disc: exact union by strip integration in the tangent plane.
  const first = hits[0]!;
  let e1 = v3.reject(first.dir, sHat);
  e1 = v3.len(e1) > 1e-15 ? v3.normalize(e1) : v3.anyOrthogonal(sHat);
  const e2 = v3.cross(sHat, e1);
  const occ: PlaneOcculter[] = hits.map((h) => {
    let u = v3.reject(h.dir, sHat);
    u = v3.len(u) > 1e-15 ? v3.normalize(u) : e1;
    const rho = h.rb >= Math.PI / 2 ? Infinity : Math.tan(h.rb);
    return { ux: v3.dot(u, e1), uy: v3.dot(u, e2), e: h.sep - h.rb, rho: rho < HALF_PLANE_RATIO * rs ? rho : Infinity };
  });
  return unionVisibleFraction(rs, occ);
}
