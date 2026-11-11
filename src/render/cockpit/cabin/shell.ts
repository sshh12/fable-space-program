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
import { FLAG_ENCLOSURE, FLAG_OVERLAY, type CabinContext } from './context';
import { QUILT, quiltHeight } from './quilt';

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
  const regions = openingRegions(ctx, detail === 0 ? 128 : 48, surface);
  // The wall, the tunnel and the floor bound the cabin: the sun's way in is the windows' apertures.
  const structure = ctx.m('structure', { flags: FLAG_ENCLOSURE });
  const yFloor = m.floorY;
  const yTop = m.tunnelJoinY;
  coneWall(ctx, { surface, regions, y0: yFloor, y1: yTop, attr: structure, nAz: detail === 0 ? 120 : detail === 1 ? 72 : 36, nY: detail === 0 ? 18 : detail === 1 ? 12 : 6, rings: detail === 0 ? 5 : 2 });

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
  const floor = ctx.m('floor', { flags: FLAG_ENCLOSURE });
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
    const closeout = frames[j + 1]! <= sh.closeoutTopY + 1e-6;
    // A blanket's rim tucks under the frames' flanges, up to the web; a hard panel stops short of them.
    const clear = closeout ? fw * 0.6 : 0.007;
    const ya = frames[j]! + (j === 0 ? 0.01 : clear);
    const yb = frames[j + 1]! - (j + 1 === frames.length - 1 ? 0.015 : clear);
    if (yb - ya < 0.06) continue;
    for (let k = 0; k < ns; k++) {
      const s0 = (k + 0.5) / ns;
      const s1 = (k + 1.5) / ns;
      const gapAz = (sh.stringer.width * 0.5 + (closeout ? sh.blanket.inset : 0.0015)) / m.innerRadius((ya + yb) / 2);
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

/** Deterministic pseudo-random numbers in [0, 1) from an integer seed (mulberry32). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Insulation blanket over a bay. A soft part, modelled as one: the batting bulges toward the cabin between
 * the frames, the rim rolls over and tucks down to the wall under the frame flanges, press studs pin it to
 * the structure and pinch it, the fill sags a little unevenly. Most bays are quilted (diamond cells sewn
 * through, each a pillow: cabin/quilt.ts gives the relief, the mesh is displaced by it and the shader
 * shades it per pixel); some are plain liner panels. No two bays are sewn alike: the quilting turns, shifts
 * and wanders from bay to bay. At full detail the bay may carry a row of hook-and-loop squares, seated on
 * the cloth.
 */
function blanket(ctx: CabinContext, a0: number, a1: number, y0: number, y1: number): void {
  const { b, mould: m, layout } = ctx;
  const th = layout.shell.blanket.thickness;
  const detail = ctx.detail;
  const ac = (a0 + a1) / 2;
  const yc = (y0 + y1) / 2;
  // Metres along the generator per metre of height.
  const gen = 1 / m.cone.genY;
  const H = (y1 - y0) * gen;
  const W = (a1 - a0) * m.innerRadius(yc);
  const rnd = seeded(Math.round(a0 * 4096) * 7919 + Math.round(y0 * 4096) * 104729 + 17);
  const plain = rnd() < 0.2 || Math.min(W, H) < 0.12;
  const cell = QUILT.cell * (0.93 + 0.14 * rnd());
  const turn = (rnd() - 0.5) * 0.16;
  const cs = Math.cos(turn);
  const sn = Math.sin(turn);
  const phase: [number, number] = [rnd(), rnd()];
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  const roll = Math.min(0.028, W / 3.2, H / 3.2);
  // Press studs: near the corners and along the long edges.
  const studs: [number, number][] = [];
  const inset = Math.min(0.03, roll * 1.1);
  if (Math.min(W, H) > 0.1) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) studs.push([sx * (W / 2 - inset), sy * (H / 2 - inset)]);
    const nx = Math.floor(W / 0.26);
    for (let k = 1; k < nx; k++) for (const sy of [-1, 1]) studs.push([-W / 2 + (W * k) / nx, sy * (H / 2 - inset)]);
    const ny = Math.floor(H / 0.26);
    for (let k = 1; k < ny; k++) for (const sx of [-1, 1]) studs.push([sx * (W / 2 - inset), -H / 2 + (H * k) / ny]);
  }
  const edge = (d: number): number => (d >= roll ? 1 : Math.sqrt(Math.max(0, 1 - (1 - d / roll) ** 2)));
  /** The blanket at bay coordinates (s, t) in 0..1: the displaced point, the smooth surface under it, uv0. */
  const at = (s: number, t: number, lift = 0): { p: Vec3; base: Vec3; uv: [number, number] } => {
    const a = a0 + (a1 - a0) * s;
    const y = y0 + (y1 - y0) * t;
    const r = m.innerRadius(y);
    const xm = (a - ac) * r;
    const ym = (y - yc) * gen;
    const e = edge(Math.min(s, 1 - s) * (a1 - a0) * r) * edge(Math.min(t, 1 - t) * H);
    let pinch = 0;
    for (const [sx, sy] of studs) pinch = Math.max(pinch, Math.exp(-((xm - sx) ** 2 + (ym - sy) ** 2) / (0.024 * 0.024)));
    const sag = 0.0024 * (Math.sin(xm * 9 + ph[0]!) * Math.sin(ym * 7 + ph[1]!) + 0.5 * Math.sin(xm * 17 + ym * 13 + ph[2]!));
    const thick = 0.003 + (th * (1 - 0.5 * pinch) + sag) * e;
    // Quilt coordinates: metric bay coordinates turned, scaled to cells, shifted, and bent a little.
    const wx = 0.07 * Math.sin(ym * 11 + ph[3]!) + 0.04 * Math.sin(xm * 23 + ph[0]!);
    const wy = 0.07 * Math.sin(xm * 10 + ph[2]!) + 0.04 * Math.sin(ym * 19 + ph[1]!);
    const q: [number, number] = [(cs * xm - sn * ym) / cell + phase[0] + wx, (sn * xm + cs * ym) / cell + phase[1] + wy];
    const relief = plain ? 0 : quiltHeight(q[0], q[1]) * e * (1 - 0.6 * pinch);
    return { p: wallPoint(ctx, a, y, thick + relief + lift), base: wallPoint(ctx, a, y, thick + lift), uv: plain ? [xm, ym] : q };
  };
  // Grid: fine rows over the rolled rim, an even grid inside.
  const step = detail === 0 ? 0.016 : detail === 1 ? 0.07 : 0.14;
  const rim = detail === 0 ? [0, 0.22, 0.55, 1] : [0, 1];
  const axis = (L: number): number[] => {
    const n = Math.max(1, Math.round((L - 2 * roll) / step));
    const out = rim.map((x) => (x * roll) / L);
    for (let k = 1; k < n; k++) out.push((roll + ((L - 2 * roll) * k) / n) / L);
    for (const x of [...rim].reverse()) out.push(1 - (x * roll) / L);
    return out;
  };
  const S = axis(W);
  const T = axis(H);
  // Out of the cabin's sun map (it lies on the wall and shades nothing but itself, and its mesh is coarser
  // than its quilting; the shader shades the relief).
  const attr: Attr = ctx.m(plain ? 'liner' : 'blanket', { flags: FLAG_ENCLOSURE });
  b.surface(S.length - 1, T.length - 1, (i, j) => at(S[i]!, T[j]!), attr, { flip: true });
  if (detail > 0) return;

  // Press studs: a domed metal cap on the cloth (overlay: the cloth under it is not buried in the bake).
  const stud = ctx.m('stud', { flags: FLAG_OVERLAY });
  const frameOn = (xm: number, ym: number): { o: Vec3; n: Vec3 } => {
    const t = 0.5 + ym / H;
    const y = y0 + (y1 - y0) * t;
    const s = 0.5 + xm / ((a1 - a0) * m.innerRadius(y));
    return { o: at(s, t).base, n: wallInward(ctx, a0 + (a1 - a0) * s, y) };
  };
  for (const [sx, sy] of studs) {
    const f = frameOn(sx, sy);
    b.lathe(v3.addScaled(f.o, f.n, -0.0005), f.n, [[0.0058, 0], [0.005, 0.0016], [0, 0.0023]], 7, stud);
  }
  // Hook-and-loop squares where the crew park loose items: a small grid sewn on a plain liner panel,
  // square to the bay, each square a pad standing a millimetre and a half off the cloth.
  if (plain && W > 0.2 && H > 0.24) {
    const nx = 2 + Math.floor(rnd() * 3);
    const ny = 1 + Math.floor(rnd() * 3);
    const size = 0.024 + 0.006 * rnd();
    const pitch = size + 0.022 + 0.02 * rnd();
    const cx = (rnd() - 0.5) * Math.max(0, W - 0.14 - nx * pitch);
    const cy = (rnd() - 0.5) * Math.max(0, H - 0.14 - ny * pitch);
    const velcro = ctx.m('velcro', { flags: FLAG_OVERLAY });
    const onCloth = (xm: number, ym: number, lift: number): Vec3 => {
      const t = 0.5 + ym / H;
      const y = y0 + (y1 - y0) * t;
      return at(0.5 + xm / ((a1 - a0) * m.innerRadius(y)), t, lift).p;
    };
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const px = cx + (i - (nx - 1) / 2) * pitch;
        const py = cy + (j - (ny - 1) / 2) * pitch;
        // Top face, and a skirt down to the cloth.
        b.surface(2, 2, (u, v) => ({ p: onCloth(px + (u / 2 - 0.5) * size, py + (v / 2 - 0.5) * size, 0.0016), uv: [px + (u / 2 - 0.5) * size, py + (v / 2 - 0.5) * size] }), velcro, { flip: true });
        const ring: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (let k = 0; k < 4; k++) {
          const [ax, ay] = ring[k]!;
          const [bx, by] = ring[(k + 1) % 4]!;
          const pa = onCloth(px + (ax * size) / 2, py + (ay * size) / 2, 0.0016);
          const pb = onCloth(px + (bx * size) / 2, py + (by * size) / 2, 0.0016);
          const qa = onCloth(px + (ax * size) / 2, py + (ay * size) / 2, 0);
          const qb = onCloth(px + (bx * size) / 2, py + (by * size) / 2, 0);
          const out = v3.normalize(v3.sub(v3.lerp(pa, pb, 0.5), onCloth(px, py, 0.0016)));
          b.strip(pa, pb, qb, qa, out, v3.normalize(v3.sub(pb, pa)), velcro);
        }
      }
    }
  }
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
