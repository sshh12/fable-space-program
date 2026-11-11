/**
 * Pressure shell: the inner wall (mould line offset inward by the wall thickness) with the openings cut
 * exactly at the shared outlines, ring frames, stringers, quilted insulation blankets on the upper cone,
 * hard close-out panels on the lower cone, the floor over the aft bulkhead and the short apex tunnel.
 *
 * The wall is meshed on an (azimuth, y) grid. Around every opening a rectangular region of that grid is cut
 * out and re-meshed as rings running from the opening outline to the region border, sampled at the grid's
 * own border vertices, so the wall is watertight and the opening edge lies exactly on the outline.
 */
import { DEG, v3, type Vec3 } from '@/core/math';
import { frameAt, type Attr } from '../mesh';
import { azimuthOf, coneNormal, conePointAt, openingsOf, radialDir, revPoint, type Opening } from '../mould';
import type { CabinContext } from './context';

const TWO_PI = 2 * Math.PI;
/** Azimuth in [0, 2 pi): the grid seam is at +Z (dorsal), between the forward windows. */
const az360 = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;

export interface Region {
  opening: Opening;
  az0: number;
  az1: number;
  y0: number;
  y1: number;
  /** Inner outline (part frame) and its (az, y) coordinates. */
  outline: Vec3[];
  azy: [number, number][];
  centre: [number, number];
}

/**
 * A wall surface of revolution: the inner pressure wall (depth = wall thickness below the mould line, the
 * cabin side) or the outer mould line itself (depth 0). `inward` points into the capsule.
 */
export interface WallSurface {
  depth: number;
  radius(y: number): number;
  inward(az: number, y: number): Vec3;
}

export function innerSurface(ctx: CabinContext): WallSurface {
  return { depth: ctx.mould.wall, radius: (y) => ctx.mould.innerRadius(y), inward: (az, y) => wallInward(ctx, az, y) };
}
/** The outer mould line of the cone (lab stand-in hulls). */
export function outerSurface(ctx: CabinContext): WallSurface {
  return { depth: 0, radius: (y) => ctx.mould.outerRadius(y), inward: (az) => v3.neg(coneNormal(ctx.mould, az)) };
}

/** Grid-aligned cut-out regions around the windows and the hatch (the hatch window lies inside the hatch). */
export function openingRegions(ctx: CabinContext, count = 96, surface: WallSurface = innerSurface(ctx), kinds: readonly Opening['kind'][] = ['window', 'hatch']): Region[] {
  const margin = ctx.layout.shell.openingMargin;
  return openingsOf(ctx.mould)
    .filter((o) => kinds.includes(o.kind))
    .map((o) => {
      const outline = o.outline(count).map(([u, v]) => conePointAt(ctx.mould, o.azDeg, o.y, u, v, surface.depth));
      const c = az360(o.azDeg * DEG);
      // Unwrap azimuths around the centre so a region may straddle the seam.
      const azy = outline.map((p): [number, number] => {
        let a = az360(azimuthOf(p));
        if (a - c > Math.PI) a -= TWO_PI;
        if (c - a > Math.PI) a += TWO_PI;
        return [a, p.y];
      });
      const azs = azy.map((p) => p[0]);
      const ys = azy.map((p) => p[1]);
      const yc = (Math.min(...ys) + Math.max(...ys)) / 2;
      const rMid = surface.radius(yc);
      return {
        opening: o,
        az0: Math.min(...azs) - margin / rMid,
        az1: Math.max(...azs) + margin / rMid,
        y0: Math.min(...ys) - margin,
        y1: Math.max(...ys) + margin,
        outline,
        azy,
        centre: [c, yc],
      };
    });
}

/** Inner-wall point at (az, y) and the unit normal pointing into the cabin. */
export function wallPoint(ctx: CabinContext, az: number, y: number, inset = 0): Vec3 {
  const m = ctx.mould;
  const n = wallInward(ctx, az, y);
  return v3.addScaled(revPoint(m.innerRadius(y), y, az), n, inset);
}
export function wallInward(ctx: CabinContext, az: number, y: number): Vec3 {
  return y >= ctx.mould.tunnelJoinY ? v3.neg(radialDir(az)) : v3.neg(coneNormal(ctx.mould, az));
}

/** Free azimuth intervals at height band [ya, yb] after removing regions that overlap the band. */
function freeIntervals(regions: Region[], ya: number, yb: number, gap: number): [number, number][] {
  let free: [number, number][] = [[0, TWO_PI]];
  for (const r of regions) {
    if (r.y1 <= ya || r.y0 >= yb) continue;
    const cut: [number, number][] = [];
    // A region may straddle the seam: test it at its unwrapped azimuths and shifted by 2 pi.
    for (const shift of [-TWO_PI, 0, TWO_PI]) cut.push([r.az0 + shift - gap, r.az1 + shift + gap]);
    free = free.flatMap(([a, b]) => {
      let parts: [number, number][] = [[a, b]];
      for (const [c0, c1] of cut) {
        parts = parts.flatMap(([p, q]): [number, number][] => {
          if (c1 <= p || c0 >= q) return [[p, q]];
          const out: [number, number][] = [];
          if (c0 > p) out.push([p, c0]);
          if (c1 < q) out.push([c1, q]);
          return out;
        });
      }
      return parts;
    });
  }
  return free.filter(([a, b]) => b - a > 1e-3);
}

export interface ConeWallOptions {
  surface: WallSurface;
  regions: Region[];
  y0: number;
  y1: number;
  attr: Attr;
  nAz: number;
  nY: number;
  rings: number;
  /** Normals pointing out of the capsule (an exterior hull) instead of into the cabin. */
  outward?: boolean;
}

/**
 * Watertight wall of revolution between y0 and y1 on an (azimuth, y) grid with the regions around the
 * openings re-meshed as rings from the exact opening outline to the grid-aligned region border.
 */
export function coneWall(ctx: CabinContext, o: ConeWallOptions): void {
  const { b } = ctx;
  const { regions, surface } = o;
  const yFloor = o.y0;
  const yTop = o.y1;
  const structure = o.attr;
  const nAz = o.nAz;
  const nY = o.nY;
  const sign = o.outward ? -1 : 1;
  const point = (a: number, y: number): Vec3 => revPoint(surface.radius(y), y, a);
  const normal = (a: number, y: number): Vec3 => v3.scale(surface.inward(a, y), sign);
  // Uniform values that fall close to a region border are dropped so the borders themselves stay exact.
  const merge = (uniform: number[], exact: number[], eps: number): number[] =>
    [...uniform.filter((v) => exact.every((e) => Math.abs(v - e) > eps)), ...exact].sort((x, y) => x - y).filter((v, i, a) => i === 0 || v - a[i - 1]! > 1e-9);
  const azUniform: number[] = [];
  for (let i = 0; i <= nAz; i++) azUniform.push((i / nAz) * TWO_PI);
  const yUniform: number[] = [];
  for (let j = 0; j <= nY; j++) yUniform.push(yFloor + ((yTop - yFloor) * j) / nY);
  const AZ = merge(azUniform, regions.flatMap((r) => [az360(r.az0), az360(r.az1)]), 0.6 * DEG);
  if (AZ[0]! > 1e-9) AZ.unshift(0);
  if (AZ[AZ.length - 1]! < TWO_PI - 1e-9) AZ.push(TWO_PI);
  const Y = merge(yUniform, regions.flatMap((r) => [r.y0, r.y1]), 0.012);
  const inRegion = (a: number, y: number): Region | null => {
    for (const r of regions) {
      for (const shift of [-TWO_PI, 0, TWO_PI]) {
        const aa = a + shift;
        if (aa > r.az0 && aa < r.az1 && y > r.y0 && y < r.y1) return r;
      }
    }
    return null;
  };
  const vid = new Map<string, number>();
  const wallVertex = (i: number, j: number): number => {
    const key = `${i % (AZ.length - 1)}|${j}`;
    let k = vid.get(key);
    if (k === undefined) {
      const a = AZ[i % (AZ.length - 1)]!;
      const y = Y[j]!;
      k = b.vertex(point(a, y), normal(a, y), { x: Math.cos(a), y: 0, z: -Math.sin(a) }, [a * surface.radius(y), y], structure);
      vid.set(key, k);
    }
    return k;
  };
  for (let j = 0; j + 1 < Y.length; j++) {
    for (let i = 0; i + 1 < AZ.length; i++) {
      const ac = (AZ[i]! + AZ[i + 1]!) / 2;
      const yc = (Y[j]! + Y[j + 1]!) / 2;
      if (inRegion(ac, yc)) continue;
      // Seen from inside (normal toward the axis) azimuth increases to the left: this order is counter-clockwise.
      b.quad(wallVertex(i, j), wallVertex(i, j + 1), wallVertex(i + 1, j + 1), wallVertex(i + 1, j));
    }
  }

  // ---- region patches: rings from the opening outline to the grid-aligned border
  for (const r of regions) {
    const border: [number, number][] = [];
    const azIn = AZ.filter((a) => a > r.az0 + 1e-9 && a < r.az1 - 1e-9);
    // Region border in unwrapped azimuth; grid values may need shifting by 2 pi.
    const unwrap = (a: number): number => {
      let x = a;
      while (x < r.az0 - 1e-6) x += TWO_PI;
      while (x > r.az1 + 1e-6) x -= TWO_PI;
      return x;
    };
    const inner = [...new Set([...azIn.map(unwrap)])].sort((x, y) => x - y);
    const yIn = Y.filter((y) => y > r.y0 + 1e-9 && y < r.y1 - 1e-9);
    // Counter-clockwise in (az, y) seen from outside = clockwise from inside: bottom, right, top, left.
    border.push([r.az0, r.y0], ...inner.map((a): [number, number] => [a, r.y0]), [r.az1, r.y0]);
    border.push(...yIn.map((y): [number, number] => [r.az1, y]), [r.az1, r.y1]);
    border.push(...[...inner].reverse().map((a): [number, number] => [a, r.y1]), [r.az0, r.y1]);
    border.push(...[...yIn].reverse().map((y): [number, number] => [r.az0, y]));
    // Normalised polar angle of each border point around the region centre.
    const [ca, cy] = r.centre;
    const sa = (r.az1 - r.az0) / 2;
    const sy = (r.y1 - r.y0) / 2;
    const ang = (p: [number, number]): number => Math.atan2((p[1] - cy) / sy, (p[0] - ca) / sa);
    // Hole point at a polar angle: ray from the centre against the outline polygon (normalised space).
    const hole = r.azy.map((p): [number, number] => [(p[0] - ca) / sa, (p[1] - cy) / sy]);
    const holeAt = (theta: number): { azy: [number, number]; p: Vec3 } => {
      const dx = Math.cos(theta);
      const dy = Math.sin(theta);
      let best = { t: Infinity, k: 0, w: 0 };
      for (let k = 0; k < hole.length; k++) {
        const [x0, y0] = hole[k]!;
        const [x1, y1] = hole[(k + 1) % hole.length]!;
        const ex = x1 - x0;
        const ey = y1 - y0;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = (x0 * ey - y0 * ex) / den;
        const w = (x0 * dy - y0 * dx) / den;
        if (t > 0 && w >= -1e-9 && w <= 1 + 1e-9 && t < best.t) best = { t, k, w };
      }
      const pa = r.outline[best.k]!;
      const pb = r.outline[(best.k + 1) % r.outline.length]!;
      const p = v3.lerp(pa, pb, best.w);
      const q0 = r.azy[best.k]!;
      const q1 = r.azy[(best.k + 1) % r.azy.length]!;
      return { azy: [q0[0] + (q1[0] - q0[0]) * best.w, q0[1] + (q1[1] - q0[1]) * best.w], p };
    };
    const rings = o.rings;
    const base = b.vertexCount;
    const N = border.length;
    for (let k = 0; k <= rings; k++) {
      const t = (k / rings) ** 1.6;
      for (let i = 0; i < N; i++) {
        const bp = border[i]!;
        const h = holeAt(ang(bp));
        const a = h.azy[0] + (bp[0] - h.azy[0]) * t;
        const y = h.azy[1] + (bp[1] - h.azy[1]) * t;
        const p = k === 0 ? h.p : point(a, y);
        b.vertex(p, normal(a, y), { x: Math.cos(a), y: 0, z: -Math.sin(a) }, [a * surface.radius(y), y], structure);
      }
    }
    for (let k = 0; k < rings; k++) {
      for (let i = 0; i < N; i++) {
        const a0 = base + k * N + i;
        const a1 = base + k * N + ((i + 1) % N);
        b.quad(a0, a1, a1 + N, a0 + N);
      }
    }
  }

}

export function buildShell(ctx: CabinContext): Region[] {
  const { b, mould: m, layout } = ctx;
  const sh = layout.shell;
  const detail = ctx.detail;
  const surface = innerSurface(ctx);
  const regions = openingRegions(ctx, detail === 0 ? 96 : 48, surface);
  const structure = ctx.m('structure');
  const yFloor = m.floorY;
  const yTop = m.tunnelJoinY;
  coneWall(ctx, { surface, regions, y0: yFloor, y1: yTop, attr: structure, nAz: detail === 0 ? 160 : detail === 1 ? 72 : 36, nY: detail === 0 ? 30 : detail === 1 ? 12 : 6, rings: detail === 0 ? 5 : 2 });

  // ---- apex tunnel wall from the cone joint up to the docking hatch, and its lip
  const yDock = layout.hatch.dockingHatchY;
  b.patch(
    (s, t) => revPoint(m.tunnelInnerRadius, yTop + (yDock - yTop) * t, s * TWO_PI),
    detail === 0 ? 64 : 24,
    1,
    structure,
    { flip: true, normalAt: (s) => v3.neg(radialDir(s * TWO_PI)) },
  );

  // ---- floor over the aft bulkhead
  const floorR = m.innerRadius(yFloor);
  const floor = ctx.m('floor');
  const nr = detail === 0 ? 10 : 3;
  b.patch(
    (s, t) => {
      const a = s * TWO_PI;
      const r = floorR * t;
      return { x: r * Math.sin(a), y: yFloor, z: r * Math.cos(a) };
    },
    detail === 0 ? 96 : 32,
    nr,
    floor,
    { normalAt: () => ({ x: 0, y: 1, z: 0 }), flip: true },
  );

  if (detail === 2) return regions;

  // ---- ring frames (horizontal T sections), interrupted at the openings
  const fd = sh.frame.depth;
  const fw = sh.frame.width;
  for (const yf of sh.ringFramesY) {
    if (yf <= yFloor + fw || yf >= yTop - fw) continue;
    for (const [a0, a1] of freeIntervals(regions, yf - fw, yf + fw, 0.01 / m.innerRadius(yf))) {
      ringFrameArc(ctx, yf, a0, a1, fd, fw);
    }
  }

  // ---- stringers along the generators
  const ns = sh.stringers;
  for (let k = 0; k < ns; k++) {
    const a = ((k + 0.5) / ns) * TWO_PI;
    stringer(ctx, regions, a, yFloor + 0.02, yTop - 0.02, sh.stringer.depth, sh.stringer.width);
  }

  // ---- blankets (upper cone) and close-out panels (lower cone) in the bays
  const frames = [yFloor, ...sh.ringFramesY.filter((y) => y > yFloor && y < yTop), yTop];
  for (let j = 0; j + 1 < frames.length; j++) {
    const ya = frames[j]! + (j === 0 ? 0.01 : fw * 0.6);
    const yb = frames[j + 1]! - (j + 1 === frames.length - 1 ? 0.015 : fw * 0.6);
    if (yb - ya < 0.06) continue;
    const closeout = frames[j + 1]! <= sh.closeoutTopY + 1e-6;
    for (let k = 0; k < ns; k++) {
      const s0 = (k + 0.5) / ns;
      const s1 = (k + 1.5) / ns;
      const gapAz = (sh.stringer.width * 0.5 + sh.blanket.inset) / m.innerRadius((ya + yb) / 2);
      // Bays are clipped against the opening regions band by band.
      const intervals = clipInterval([s0 * TWO_PI + gapAz, s1 * TWO_PI - gapAz], freeIntervals(regions, ya, yb, 0.012 / m.innerRadius((ya + yb) / 2)));
      for (const [a0, a1] of intervals) {
        if ((a1 - a0) * m.innerRadius(yb) < 0.08) continue;
        if (closeout) closeoutPanel(ctx, a0, a1, ya, yb);
        else blanket(ctx, a0, a1, ya, yb);
      }
      // Blanket strips above and below an opening region inside this bay column.
      if (!closeout) {
        for (const r of regions) {
          const bands: [number, number][] = [];
          if (r.y0 > ya + 0.06 && r.y0 < yb) bands.push([ya, r.y0 - 0.012]);
          if (r.y1 < yb - 0.06 && r.y1 > ya) bands.push([r.y1 + 0.012, yb]);
          for (const [b0, b1] of bands) {
            if (b1 - b0 < 0.05) continue;
            const ints = clipInterval([s0 * TWO_PI + gapAz, s1 * TWO_PI - gapAz], [[r.az0, r.az1], [r.az0 + TWO_PI, r.az1 + TWO_PI], [r.az0 - TWO_PI, r.az1 - TWO_PI]]);
            // Only the part of the bay column that the region cut away, limited to free space in that band.
            for (const iv of ints) for (const [a0, a1] of clipInterval(iv, freeIntervals(regions, b0, b1, 0.012 / m.innerRadius(b1)))) if ((a1 - a0) * m.innerRadius(b1) > 0.06) blanket(ctx, a0, a1, b0, b1);
          }
        }
      }
    }
  }

  // ---- floor tie-down rails
  if (detail === 0) {
    const alu = ctx.m('aluminium');
    for (const z of [-0.95, 0.95]) {
      const half = Math.sqrt(Math.max(0, floorR * floorR - z * z)) - 0.06;
      b.box(frameAt({ x: 0, y: yFloor + 0.008, z }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }), half, 0.016, 0.008, 0.002, alu);
    }
  }
  return regions;
}

function clipInterval(iv: [number, number], allowed: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of allowed) {
    const lo = Math.max(iv[0], a);
    const hi = Math.min(iv[1], b);
    if (hi - lo > 1e-4) out.push([lo, hi]);
  }
  return out;
}

/** One arc of a ring frame: web from the wall inward, T flange at its inner edge. */
function ringFrameArc(ctx: CabinContext, y: number, a0: number, a1: number, depth: number, width: number): void {
  const { b, mould: m } = ctx;
  const attr = ctx.m('structure', { ao: 0.9 });
  const segs = Math.max(2, Math.ceil(((a1 - a0) / TWO_PI) * (ctx.detail === 0 ? 160 : 64)));
  const web = 0.003;
  const rIn = m.innerRadius(y) - depth;
  const at = (a: number, r: number, yy: number): Vec3 => revPoint(r, yy, a);
  const lerpA = (s: number): number => a0 + (a1 - a0) * s;
  const down = { x: 0, y: -1, z: 0 };
  const up = { x: 0, y: 1, z: 0 };
  // Web underside and top (horizontal annuli from the wall to the flange).
  b.patch((s, t) => at(lerpA(s), m.innerRadius(y - web) + (rIn + web - m.innerRadius(y - web)) * t, y - web), segs, 1, attr, { normalAt: () => down });
  b.patch((s, t) => at(lerpA(s), m.innerRadius(y + web) + (rIn + web - m.innerRadius(y + web)) * t, y + web), segs, 1, attr, { normalAt: () => up, flip: true });
  // Flange: inner face, back faces and edges.
  const hf = width / 2;
  const tf = 0.003;
  b.patch((s, t) => at(lerpA(s), rIn, y - hf + 2 * hf * t), segs, 1, attr, { normalAt: (s) => v3.neg(radialDir(lerpA(s))), flip: true });
  b.patch((s, t) => at(lerpA(s), rIn + tf, y - hf + (hf - web) * t), segs, 1, attr, { normalAt: (s) => radialDir(lerpA(s)) });
  b.patch((s, t) => at(lerpA(s), rIn + tf, y + web + (hf - web) * t), segs, 1, attr, { normalAt: (s) => radialDir(lerpA(s)) });
  b.patch((s, t) => at(lerpA(s), rIn + tf * t, y - hf), segs, 1, attr, { normalAt: () => down, flip: true });
  b.patch((s, t) => at(lerpA(s), rIn + tf * t, y + hf), segs, 1, attr, { normalAt: () => up });
  // End caps where the frame meets an opening surround.
  for (const a of [a0, a1]) {
    const t = { x: Math.cos(a), y: 0, z: -Math.sin(a) };
    const n = a === a0 ? v3.neg(t) : t;
    const p0 = at(a, m.innerRadius(y - hf), y - hf);
    const p1 = at(a, rIn, y - hf);
    const p2 = at(a, rIn, y + hf);
    const p3 = at(a, m.innerRadius(y + hf), y + hf);
    b.strip(p0, p1, p2, p3, n, { x: 0, y: 1, z: 0 }, attr);
  }
}

/** A stringer along the generator at azimuth a, split around the openings. */
function stringer(ctx: CabinContext, regions: Region[], a: number, y0: number, y1: number, depth: number, width: number): void {
  const { b, mould: m } = ctx;
  const attr = ctx.m('structure', { ao: 0.85 });
  let spans: [number, number][] = [[y0, y1]];
  for (const r of regions) {
    for (const shift of [-TWO_PI, 0, TWO_PI]) {
      const aa = a + shift;
      const halfAz = (width / 2 + 0.01) / m.innerRadius((r.y0 + r.y1) / 2);
      if (aa + halfAz < r.az0 || aa - halfAz > r.az1) continue;
      spans = spans.flatMap(([p, q]): [number, number][] => {
        if (r.y1 + 0.01 <= p || r.y0 - 0.01 >= q) return [[p, q]];
        const out: [number, number][] = [];
        if (r.y0 - 0.01 > p) out.push([p, r.y0 - 0.01]);
        if (r.y1 + 0.01 < q) out.push([r.y1 + 0.01, q]);
        return out;
      });
    }
  }
  const n = v3.neg(coneNormal(m, a));
  const t = { x: Math.cos(a), y: 0, z: -Math.sin(a) };
  for (const [ya, yb] of spans) {
    if (yb - ya < 0.05) continue;
    const segs = Math.max(1, Math.ceil((yb - ya) / 0.15));
    const pt = (y: number, side: number, d: number): Vec3 => v3.add(v3.addScaled(wallPoint(ctx, a, y), t, side * width * 0.5), v3.scale(n, d));
    b.patch((s, tt) => pt(ya + (yb - ya) * tt, -1 + 2 * s, depth), 1, segs, attr, { normalAt: () => n, flip: true });
    b.patch((s, tt) => pt(ya + (yb - ya) * tt, -1, depth * s), 1, segs, attr, { normalAt: () => v3.neg(t) });
    b.patch((s, tt) => pt(ya + (yb - ya) * tt, 1, depth * s), 1, segs, attr, { normalAt: () => t, flip: true });
  }
}

/** Quilted insulation blanket over a bay: puffed toward the cabin, its edges tucked to the wall. */
function blanket(ctx: CabinContext, a0: number, a1: number, y0: number, y1: number): void {
  const { b, mould: m, layout } = ctx;
  const th = layout.shell.blanket.thickness;
  const ns = Math.max(2, Math.ceil(((a1 - a0) * m.innerRadius(y0)) / (ctx.detail === 0 ? 0.04 : 0.12)));
  const nt = Math.max(2, Math.ceil((y1 - y0) / (ctx.detail === 0 ? 0.04 : 0.12)));
  const edge = (x: number): number => {
    const d = Math.min(x, 1 - x) * 2;
    return Math.min(1, d * 6) ** 0.5;
  };
  const at = (s: number, t: number): Vec3 => {
    const a = a0 + (a1 - a0) * s;
    const y = y0 + (y1 - y0) * t;
    return wallPoint(ctx, a, y, 0.002 + th * edge(s) * edge(t));
  };
  const attr: Attr = ctx.m('blanket');
  b.patch(at, ns, nt, attr, { flip: true, uvOffset: [a0 * m.innerRadius(y0), y0], aoAt: (s, t) => 0.72 + 0.28 * edge(s) * edge(t) });
}

/** Hard close-out panel on the lower cone: flat in (az, y), chamfered, with fasteners at the corners. */
function closeoutPanel(ctx: CabinContext, a0: number, a1: number, y0: number, y1: number): void {
  const { b, mould: m } = ctx;
  const inset = 0.012;
  const ns = Math.max(2, Math.ceil(((a1 - a0) * m.innerRadius(y0)) / 0.06));
  const attr = ctx.m('closeout');
  const chamfer = 0.006;
  // Face (inset), and a chamfered rim back to the wall.
  b.patch((s, t) => wallPoint(ctx, a0 + (a1 - a0) * s, y0 + (y1 - y0) * t, inset), ns, 2, attr, { flip: true, uvOffset: [a0 * m.innerRadius(y0), y0] });
  const rim = (sa: number, ta: number, sb: number, tb: number): void => {
    const pa = wallPoint(ctx, a0 + (a1 - a0) * sa, y0 + (y1 - y0) * ta, inset);
    const pb = wallPoint(ctx, a0 + (a1 - a0) * sb, y0 + (y1 - y0) * tb, inset);
    const mid = v3.lerp(pa, pb, 0.5);
    const centre = wallPoint(ctx, (a0 + a1) / 2, (y0 + y1) / 2, inset);
    const out = v3.normalize(v3.reject(v3.sub(mid, centre), wallInward(ctx, (a0 + a1) / 2, (y0 + y1) / 2)));
    const qa = v3.add(wallPoint(ctx, a0 + (a1 - a0) * sa, y0 + (y1 - y0) * ta, 0.001), v3.scale(out, chamfer));
    const qb = v3.add(wallPoint(ctx, a0 + (a1 - a0) * sb, y0 + (y1 - y0) * tb, 0.001), v3.scale(out, chamfer));
    b.strip(pa, pb, qb, qa, v3.normalize(v3.add(out, wallInward(ctx, (a0 + a1) / 2, (y0 + y1) / 2))), v3.normalize(v3.sub(pb, pa)), ctx.m('closeout', { ao: 0.7 }));
  };
  rim(0, 0, 1, 0);
  rim(1, 0, 1, 1);
  rim(1, 1, 0, 1);
  rim(0, 1, 0, 0);
  if (ctx.detail > 0) return;
  // Fasteners: four corners plus mid-points of the long edges.
  const steel = ctx.m('steel');
  const pts: [number, number][] = [[0.04, 0.08], [0.96, 0.08], [0.04, 0.92], [0.96, 0.92], [0.5, 0.08], [0.5, 0.92]];
  for (const [s, t] of pts) {
    const ds = 0.018 / ((a1 - a0) * m.innerRadius(y0));
    const ss = s < 0.5 ? Math.max(s, ds) : s > 0.5 ? Math.min(s, 1 - ds) : s;
    const tt = t < 0.5 ? Math.max(t, 0.018 / (y1 - y0)) : Math.min(t, 1 - 0.018 / (y1 - y0));
    const a = a0 + (a1 - a0) * ss;
    const y = y0 + (y1 - y0) * tt;
    const n = wallInward(ctx, a, y);
    b.cylinder(wallPoint(ctx, a, y, inset - 0.0005), n, 0.0042, 0.0018, 10, steel, { radius1: 0.0034, caps: 'top' });
  }
}
