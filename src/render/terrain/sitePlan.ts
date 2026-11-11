/**
 * The ground plan of a launch site as the terrain draws it: concrete hardstands under the structures that
 * stand on slabs, gravel beds under lanes, a compacted shoulder around the concrete. Pure geometry, shared
 * by the surface shader (through the material uniform, `siteGround` in shaders/surface.ts is its twin) and by
 * the ground cover (nothing grows on the plan).
 *
 * The plan is derived from `LaunchSiteDef.structures` by the names of their footprint parameters, never by
 * model id: `halfX` / `halfZ` (a slab), `sizeX` / `sizeZ` (a building on its pad), `length` with
 * `trackWidth` (a lane bed, centred on the structure's origin, running along its z axis). A site without
 * any slab gets one square hardstand of the body's `apronRadiusM`.
 *
 * Frame of a structure (src/render/vehicle/site/types.ts): +X east and +Z south at heading 0, turned
 * clockwise by the heading; `offsetEnu` is east, north, up from the pad centre.
 */
import type { LaunchSiteDef } from '@/core/contracts/defs';
import { DEG } from '@/core/math';

export const MAX_SITES = 4;
export const MAX_SITE_SHAPES = 24;
export const SHAPE_SLAB = 0;
export const SHAPE_GRAVEL = 1;

export interface SiteShape {
  /** Centre east and north of the pad centre, m. */
  e: number;
  n: number;
  /** Half sizes along the shape's x and z axes, m. */
  halfX: number;
  halfZ: number;
  /** Heading of the shape, rad (clockwise from north). */
  heading: number;
  kind: typeof SHAPE_SLAB | typeof SHAPE_GRAVEL;
  /** Corner radius, m. */
  corner: number;
}

export interface SitePlanTunables {
  /** Half size of the default hardstand of a site without slabs, m (0 = the body draws no site ground). */
  apronRadiusM: number;
  /** Concrete beyond the footprint of a slab, m. */
  apronMarginM: number;
  /** Width of the compacted shoulder around the concrete, m. */
  apronShoulderM: number;
}

export interface SitePlan {
  shapes: SiteShape[];
  /** Distance from the pad centre beyond which the plan holds nothing (shoulder and its ragged edge included), m. */
  reach: number;
  shoulder: number;
}

const num = (p: Record<string, number | string> | undefined, key: string): number | null => {
  const v = p?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

export function buildSitePlan(site: Pick<LaunchSiteDef, 'structures' | 'pad'>, t: SitePlanTunables): SitePlan {
  const shapes: SiteShape[] = [];
  if (t.apronRadiusM <= 0) return { shapes, reach: 0, shoulder: 0 };
  const limit = site.pad.flatRadius;
  for (const s of site.structures) {
    const p = s.params;
    const heading = s.headingDeg * DEG;
    const [e, n] = s.offsetEnu;
    const halfX = num(p, 'halfX') ?? (num(p, 'sizeX') !== null ? num(p, 'sizeX')! / 2 : null);
    const halfZ = num(p, 'halfZ') ?? (num(p, 'sizeZ') !== null ? num(p, 'sizeZ')! / 2 : null);
    if (halfX !== null && halfZ !== null) {
      shapes.push({ e, n, halfX: halfX + t.apronMarginM, halfZ: halfZ + t.apronMarginM, heading, kind: SHAPE_SLAB, corner: Math.min(t.apronMarginM, 0.5 * Math.min(halfX, halfZ)) });
      continue;
    }
    const length = num(p, 'length');
    const track = num(p, 'trackWidth');
    if (length !== null && track !== null) {
      const half = (num(p, 'median') ?? 0) / 2 + track + 0.4 * t.apronShoulderM;
      shapes.push({ e, n, halfX: half, halfZ: length / 2, heading, kind: SHAPE_GRAVEL, corner: 1.5 });
    }
  }
  if (!shapes.some((s) => s.kind === SHAPE_SLAB)) {
    const half = Math.min(t.apronRadiusM, limit / Math.SQRT2);
    shapes.unshift({ e: 0, n: 0, halfX: half, halfZ: half, heading: 0, kind: SHAPE_SLAB, corner: Math.min(t.apronMarginM, 0.25 * half) });
  }
  if (shapes.length > MAX_SITE_SHAPES) shapes.length = MAX_SITE_SHAPES;
  let reach = 0;
  for (const s of shapes) reach = Math.max(reach, Math.hypot(s.e, s.n) + Math.hypot(s.halfX, s.halfZ));
  return { shapes, reach: reach + 2.5 * t.apronShoulderM + 4, shoulder: t.apronShoulderM };
}

export interface SiteGround {
  /** Signed distance to the concrete, m (negative inside). */
  concrete: number;
  /** Signed distance to the gravel (lane beds and the shoulder around the concrete), m, before its ragged edge. */
  gravel: number;
  /** Position in the frame of the nearest slab, m. */
  qx: number;
  qz: number;
}

/** The plan at a point east / north of the pad centre (the twin of `siteGround` in shaders/surface.ts). */
export function siteGround(plan: SitePlan, e: number, n: number): SiteGround {
  const o: SiteGround = { concrete: 1e6, gravel: 1e6, qx: e, qz: n };
  for (const s of plan.shapes) {
    const dx = e - s.e;
    const dy = n - s.n;
    const c = Math.cos(s.heading);
    const sn = Math.sin(s.heading);
    const px = dx * c - dy * sn;
    const pz = -(dx * sn + dy * c);
    const kx = Math.abs(px) - (s.halfX - s.corner);
    const kz = Math.abs(pz) - (s.halfZ - s.corner);
    const sd = Math.hypot(Math.max(kx, 0), Math.max(kz, 0)) + Math.min(Math.max(kx, kz), 0) - s.corner;
    if (s.kind === SHAPE_SLAB) {
      if (sd < o.concrete) {
        o.concrete = sd;
        o.qx = px;
        o.qz = pz;
      }
    } else if (sd < o.gravel) o.gravel = sd;
  }
  o.gravel = Math.min(o.gravel, o.concrete - plan.shoulder);
  return o;
}

/** Rows of the material uniform that hold one site's shapes: two vec4f per shape. */
export function packSiteShapes(plan: SitePlan, out: Float32Array, at: number): void {
  plan.shapes.forEach((s, i) => {
    out.set([s.e, s.n, s.halfX, s.halfZ, Math.cos(s.heading), Math.sin(s.heading), s.kind, s.corner], at + i * 8);
  });
}
