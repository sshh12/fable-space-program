/**
 * Launch pad structures: apron, flame trench with deflector and deluge headers, launch mount (steel table
 * on piers with the exhaust opening, clamp seats, rainbirds, tail service mast, stair tower), crawlerway,
 * pipe runs and floodlight towers.
 */
import type { QuatTuple, Vec3Tuple } from '@/core/math';
import { decalSheetOf, type DecalSheet } from '../decals';
import { MeshBuilder, xf } from '../geom/builder';
import { DEG, TAU, beam, bolt, boltCircle, bottle, box, extrude, frustum, pipe, rectPoly, ringSolid, rod, section, torus, zipLoops } from '../geom/prims';
import type { MatId } from '../materials';
import { buildModel, noise2 } from '../parts/common';
import type { PartLight } from '../parts/types';
import { flatSite, numParam, staticSite, strParam, type SiteGenerator, type SiteSink, type SiteState } from './types';

/** Extrude a polygon given in the (z, y) plane along X between x0 and x1. */
export function extrudeZY(b: MeshBuilder, poly: [number, number][], x0: number, x1: number, tag: string): void {
  // Local X -> world Z, local Y -> world X, local Z -> world Y.
  b.at(xf.fromAxes([0, 0, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]), () => extrude(b, poly, x0, x1, false, tag));
}

/** Extrude a polygon given in the (x, y) plane along Z between z0 and z1 (polygon counter-clockwise seen from -Z). */
export function extrudeXY(b: MeshBuilder, poly: [number, number][], z0: number, z1: number, tag: string): void {
  // Local X -> world X, local Z -> world Y, local Y -> world -Z: right-handed (X x -Z = Y).
  b.at(xf.fromAxes([0, 0, 0], [1, 0, 0], [0, 0, -1], [0, 1, 0]), () => extrude(b, poly, -z1, -z0, false, tag));
}

/** Flat marking on the ground from the decal atlas: a quad with corners a -> b -> c -> d counter-clockwise seen from above. */
export function groundDecal(b: MeshBuilder, sheet: DecalSheet, name: string, centre: Vec3Tuple, width: number, depth: number, yawDeg = 0, repeat = 1): void {
  const [u0, v0, u1, v1] = sheet.uv(name);
  const c = Math.cos(yawDeg * DEG);
  const s = Math.sin(yawDeg * DEG);
  // Local frame: right = (c, 0, -s) ("east" turned by yaw), up-on-page = (-s, 0, -c) ("north").
  const at = (x: number, z: number): Vec3Tuple => [centre[0] + c * x - s * z, centre[1], centre[2] - s * x - c * z];
  b.begin(false, 'ground-marking');
  for (let i = 0; i < repeat; i++) {
    const x0 = -width / 2 + (width * i) / repeat;
    const x1 = -width / 2 + (width * (i + 1)) / repeat;
    const p = [at(x0, -depth / 2), at(x1, -depth / 2), at(x1, depth / 2), at(x0, depth / 2)];
    const uv = [
      [u0, v1],
      [u1, v1],
      [u1, v0],
      [u0, v0],
    ];
    const ids = p.map((q, k) => b.v(q[0], q[1], q[2], 0, 1, 0, c, 0, -s, uv[k]![0]!, uv[k]![1]!, -1));
    b.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
  }
}

/**
 * Closed plate between y0 and y1 whose plan outline is `outer` ([x, z] points, any winding) with a round
 * hole of radius `holeR` about the origin.
 */
export function plateWithHole(b: MeshBuilder, outer: [number, number][], holeR: number, holeSegs: number, y0: number, y1: number, tag: string, topMat?: MatId): void {
  const sideMat = b.material;
  const soot0 = b.soot;
  b.begin(true, tag);
  // Angles counter-clockwise seen from above: theta = atan2(-z, x).
  const pts = outer.map(([x, z]) => ({ x, z, a: Math.atan2(-z, x) })).sort((p, q) => p.a - q.a);
  const hole: { x: number; z: number; a: number }[] = [];
  for (let i = 0; i < holeSegs; i++) {
    const a = -Math.PI + (i / holeSegs) * TAU;
    hole.push({ x: holeR * Math.cos(a), z: -holeR * Math.sin(a), a });
  }
  for (const top of [true, false]) {
    const y = top ? y1 : y0;
    const ny = top ? 1 : -1;
    // The top face may be decked in its own material (the bore below is scorched; the faces keep the
    // plate's own weathering: a soot gradient across one fan of triangles would be drawn as parallel streaks).
    b.mat(top && topMat ? topMat : sideMat);
    const A = pts.map((p) => b.v(p.x, y, p.z, 0, ny, 0, 1, 0, 0, p.x, top ? -p.z : p.z, top ? 1 : -1));
    const B = hole.map((p) => b.v(p.x, y, p.z, 0, ny, 0, 1, 0, 0, p.x, top ? -p.z : p.z, top ? 1 : -1));
    zipLoops(
      b,
      A,
      pts.map((p) => p.a),
      B,
      hole.map((p) => p.a),
      !top,
    );
  }
  // Outer walls (facing away from the centre) and the bore (facing the centre).
  b.mat(sideMat);
  const n = pts.length;
  let run = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % n]!;
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const l = Math.hypot(dx, dz);
    // Counter-clockwise from above: the outward normal is to the right of the travel direction.
    const nx = -dz / l;
    const nz = dx / l;
    // Tangent along the travel direction: cross(N, T) = +Y.
    const tx = dx / l;
    const tz = dz / l;
    const v0 = b.v(p.x, y0, p.z, nx, 0, nz, tx, 0, tz, run, 0);
    const v1 = b.v(q.x, y0, q.z, nx, 0, nz, tx, 0, tz, run + l, 0);
    const v2 = b.v(q.x, y1, q.z, nx, 0, nz, tx, 0, tz, run + l, y1 - y0);
    const v3 = b.v(p.x, y1, p.z, nx, 0, nz, tx, 0, tz, run, y1 - y0);
    b.quad(v0, v1, v2, v3);
    run += l;
  }
  const rows: [number, number][] = [];
  b.soot = Math.max(soot0, 0.9);
  for (let i = 0; i <= holeSegs; i++) {
    const p = hole[i % holeSegs]!;
    const nx = -p.x / holeR;
    const nz = -p.z / holeR;
    // Tangent with cross(N, T) = +Y.
    const tx = nz;
    const tz = -nx;
    const u = -(i / holeSegs) * TAU * holeR;
    rows.push([b.v(p.x, y0, p.z, nx, 0, nz, tx, 0, tz, u, 0), b.v(p.x, y1, p.z, nx, 0, nz, tx, 0, tz, u, y1 - y0)]);
  }
  for (let i = 0; i < holeSegs; i++) b.quad(rows[i]![0], rows[i]![1], rows[i + 1]![1], rows[i + 1]![0]);
  b.soot = soot0;
}

/**
 * One flight of an industrial stair from `from` to `to` (the centre line of its going): two channel
 * stringers, open-grating treads at about 0.2 m rise, and a handrail on both sides.
 */
export function stairFlight(b: MeshBuilder, from: Vec3Tuple, to: Vec3Tuple, width: number): void {
  const prev = b.material;
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const run = Math.hypot(dx, dz);
  // Across the flight, horizontal.
  const ax: Vec3Tuple = [dz / run, 0, -dx / run];
  const off = (p: Vec3Tuple, s: number, up = 0): Vec3Tuple => [p[0] + ax[0] * s, p[1] + up, p[2] + ax[2] * s];
  b.mat('galvanised');
  for (const s of [-1, 1]) beam(b, off(from, (s * width) / 2, -0.12), off(to, (s * width) / 2, -0.12), 0.05, 0.26, ax, 'stringer');
  if (b.lod < 2) {
    const n = Math.max(2, Math.round((to[1] - from[1]) / 0.2));
    b.mat('grating');
    for (let i = 1; i < n; i += b.pick(1, 2, 1)) {
      const t = i / n;
      const c: Vec3Tuple = [from[0] + dx * t, from[1] + (to[1] - from[1]) * t, from[2] + dz * t];
      b.at(xf.along(off(c, -width / 2 + 0.03), off(c, width / 2 - 0.03), [0, 1, 0]), () => box(b, 0.03, width - 0.06, 0.27, [0, (width - 0.06) / 2, 0], 'tread'));
    }
    for (const s of [-1, 1]) handrail(b, [off(from, (s * width) / 2), off(to, (s * width) / 2)], 1.0, 1.3);
  }
  b.mat(prev);
}

/**
 * Open bar grating in the plane y, centred at (cx, cz), `sx` by `sz`: bearing bars on edge along X (or Z),
 * cross bars, and a banding bar round the panel. LOD 0 has every bearing bar (60 mm pitch); LOD 1 keeps the
 * banding and the cross bars, so the panel stays open; the far LOD has none of it. The sky and the structure
 * above show through it from below, as through the real thing (an opaque textured plate does not).
 */
export function gratingPanel(b: MeshBuilder, cx: number, y: number, cz: number, sx: number, sz: number, alongX = true): void {
  if (b.lod === 2) return;
  const prev = b.material;
  b.mat('galvanised');
  const d = 0.035;
  for (const s of [-1, 1]) {
    box(b, sx, d, 0.012, [cx, y, cz + s * (sz / 2 - 0.006)], 'grating');
    box(b, 0.012, d, sz - 0.024, [cx + s * (sx / 2 - 0.006), y, cz], 'grating');
  }
  const L = alongX ? sx : sz;
  const W = alongX ? sz : sx;
  const nc = Math.max(1, Math.round(L / b.pick(0.6, 1.2, 1.2)));
  for (let i = 1; i < nc; i++) {
    const t = -L / 2 + (L * i) / nc;
    if (alongX) box(b, 0.022, d * 0.6, W - 0.024, [cx + t, y - d * 0.15, cz], 'grating');
    else box(b, W - 0.024, d * 0.6, 0.022, [cx, y - d * 0.15, cz + t], 'grating');
  }
  if (b.lod === 0) {
    const nb = Math.max(2, Math.round(W / 0.06));
    for (let i = 1; i < nb; i++) {
      const t = -W / 2 + (W * i) / nb;
      if (alongX) box(b, L - 0.024, d, 0.008, [cx, y, cz + t], 'grating');
      else box(b, 0.008, d, L - 0.024, [cx + t, y, cz], 'grating');
    }
  }
  b.mat(prev);
}

/** Handrail along a polyline at height y: posts and two rails. */
export function handrail(b: MeshBuilder, pts: Vec3Tuple[], height = 1.1, spacing = 2): void {
  if (b.lod === 2) return;
  const prev = b.material;
  b.mat('paint-yellow');
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const c = pts[i + 1]!;
    for (const h of [height, height * 0.55]) rod(b, [a[0], a[1] + h, a[2]], [c[0], c[1] + h, c[2]], 0.025, b.pick(6, 4, 3), 'rail');
    if (b.lod === 0) {
      const l = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      const n = Math.max(1, Math.round(l / spacing));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const p: Vec3Tuple = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
        rod(b, p, [p[0], p[1] + height, p[2]], 0.022, 5, 'rail-post');
      }
    }
  }
  b.mat(prev);
}

/**
 * Ground slab between (x0, z0) and (x1, z1): the top is a grid whose vertices carry a grime weight (stains
 * and weathering larger than a texture tile, so no two bays of the slab look alike), the edge is a skirt
 * down to `yBottom`. An open sheet: the underside is in the ground.
 */
export function groundSlab(b: MeshBuilder, x0: number, x1: number, z0: number, z1: number, yTop: number, yBottom: number, step: number, grime: (x: number, z: number) => number, tag: string): void {
  b.begin(false, tag);
  const nx = Math.max(1, Math.round((x1 - x0) / step));
  const nz = Math.max(1, Math.round((z1 - z0) / step));
  const ids: number[][] = [];
  for (let j = 0; j <= nz; j++) {
    const row: number[] = [];
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      const z = z0 + ((z1 - z0) * j) / nz;
      // Tangent +X, bitangent = N x T = -Z: v runs toward -Z.
      const v = b.v(x, yTop, z, 0, 1, 0, 1, 0, 0, x, -z);
      b.setMask(v, 0, 1, grime(x, z), 0);
      row.push(v);
    }
    ids.push(row);
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) b.quad(ids[j]![i]!, ids[j + 1]![i]!, ids[j + 1]![i + 1]!, ids[j]![i + 1]!);
  // Skirt: one quad per side, facing outward.
  const side = (ax: number, az: number, bx: number, bz: number): void => {
    const l = Math.hypot(bx - ax, bz - az);
    const tx = (bx - ax) / l;
    const tz = (bz - az) / l;
    // Outward normal = T x up.
    const nxx = -tz;
    const nzz = tx;
    const w = grime((ax + bx) / 2, (az + bz) / 2);
    const q = [b.v(ax, yBottom, az, nxx, 0, nzz, tx, 0, tz, 0, 0), b.v(bx, yBottom, bz, nxx, 0, nzz, tx, 0, tz, l, 0), b.v(bx, yTop, bz, nxx, 0, nzz, tx, 0, tz, l, yTop - yBottom), b.v(ax, yTop, az, nxx, 0, nzz, tx, 0, tz, 0, yTop - yBottom)];
    for (const v of q) b.setMask(v, 0, 1, w, 0);
    b.quad(q[0]!, q[1]!, q[2]!, q[3]!);
  };
  side(x1, z0, x0, z0);
  side(x0, z0, x0, z1);
  side(x0, z1, x1, z1);
  side(x1, z1, x1, z0);
}

// --------------------------------------------------------------------------------------------- apron

export const padApron: SiteGenerator = ({ params, defs }) => {
  const sheet = decalSheetOf(defs);
  const hx = numParam(params, 'halfX', 62);
  const hz = numParam(params, 'halfZ', 62);
  const gap = numParam(params, 'trenchHalfWidth', 7.8);
  const t = numParam(params, 'thickness', 0.3);
  // Markings are content of the site: the structure file names the decals (none = unmarked concrete).
  const hazard = strParam(params, 'hazardDecal', '');
  const sign = strParam(params, 'signDecal', '');
  /**
   * Grime of the apron: weathering in patches tens of metres across, rain streaks toward the trench, and the
   * blast staining of earlier launches beside the trench near the mount.
   */
  const grime = (x: number, z: number): number => {
    const patches = 0.62 * noise2(x / 17, z / 17, 3) + 0.26 * noise2(x / 5.3, z / 5.3, 5);
    const d = Math.abs(x) - gap;
    const blast = 0.55 * Math.exp(-Math.max(0, d) / 9) * Math.exp(-((z / 34) ** 2)) * (0.55 + 0.45 * noise2(x / 3.1, z / 9, 9));
    return Math.min(0.85, Math.max(0, patches - 0.26) + blast);
  };
  const body = buildModel('pad.apron', (b) => {
    b.mat('concrete').masks(0, 1, 0, 0);
    const step = b.pick(3.1, 6.2, 20);
    for (const sx of [-1, 1]) groundSlab(b, sx > 0 ? gap : -hx, sx > 0 ? hx : -gap, -hz, hz, t, -0.4, step, grime, 'apron');
    if (b.lod === 2) return;
    // Painted edge lines, hazard stripes along the trench, pad designation.
    b.mat('paint-yellow').masks(0.2, 1, 0.5, 0);
    for (const sx of [-1, 1]) {
      box(b, 0.2, 0.012, 2 * hz - 6, [sx * (hx - 3), t + 0.006, 0], 'line');
      for (const sz of [-1, 1]) box(b, hx - gap - 6, 0.012, 0.2, [sx * (gap + (hx - gap) / 2), t + 0.006, sz * (hz - 3)], 'line');
    }
    b.mat('decal-ground').masks(0, 1, 0.5, 0);
    if (hazard) for (const sx of [-1, 1]) groundDecal(b, sheet, hazard, [sx * (gap + 0.9), t + 0.008, 0], 2 * hz - 8, 0.9, 90, Math.round((2 * hz - 8) / (0.9 * sheet.aspect(hazard))));
    if (sign) {
      const depth = numParam(params, 'signDepth', 8.9);
      groundDecal(b, sheet, sign, [-(gap + (hx - gap) * 0.55), t + 0.008, hz * 0.55], depth * sheet.aspect(sign), depth, 0);
    }
  });
  return { models: { body }, pose: flatSite };
};

// ------------------------------------------------------------------------------------------- trench

export const padFlameTrench: SiteGenerator = ({ params }) => {
  const hw = numParam(params, 'halfWidth', 6);
  const wt = numParam(params, 'wallThickness', 1.7);
  const wh = numParam(params, 'wallHeight', 6.2);
  const hl = numParam(params, 'halfLength', 78);
  const dh = numParam(params, 'deflectorHeight', 5.4);
  const dr = numParam(params, 'deflectorRun', 11);
  const body = buildModel('pad.flameTrench', (b) => {
    // Floor and walls: the walls step down toward the exits.
    b.mat('refractory').masks(0, 0.9, 1, 0);
    box(b, 2 * hw, 0.6, 2 * hl, [0, 0.05, 0], 'floor');
    b.mat('concrete-wall').masks(0, 1, 0.9, 0);
    const side: [number, number][] = [
      [-hl, -0.3],
      [hl, -0.3],
      [hl, 1.3],
      [26, wh],
      [-26, wh],
      [-hl, 1.3],
    ];
    for (const sx of [-1, 1]) extrudeZY(b, side, sx > 0 ? hw : -hw - wt, sx > 0 ? hw + wt : -hw, 'wall');
    // Flame deflector: a double wedge with concave flanks across the whole trench.
    b.mat('refractory').masks(0, 1, 1, 0);
    const n = b.pick(8, 4, 2);
    const flank: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      flank.push([-dr * (1 - u), 0.3 + (dh - 0.3) * Math.pow(u, 1.7)]);
    }
    const poly: [number, number][] = [...flank, ...flank.slice(0, -1).reverse().map(([z, y]) => [-z, y] as [number, number])];
    // The polygon above runs -z .. ridge .. +z along the top; it has to be counter-clockwise in (z, y).
    extrudeZY(b, poly.reverse(), -hw + 0.02, hw - 0.02, 'deflector');
    if (b.lod === 2) return;
    // Deluge headers on the wall tops with spray nozzles into the trench.
    b.mat('paint-red').masks(0.2, 1, 0.8, 0);
    for (const sx of [-1, 1]) {
      const x = sx * (hw + wt * 0.5);
      pipe(b, [[x, wh + 0.45, -24], [x, wh + 0.45, 24]], 0.32, 0.5, { segs: b.pick(14, 8, 6), tag: 'deluge-header' });
      if (b.lod === 0) {
        for (let z = -22; z <= 22; z += 4) {
          rod(b, [x, wh + 0.45, z], [sx * (hw - 0.4), wh - 0.1, z], 0.07, 8, 'deluge-nozzle');
          b.mat('concrete-wall');
          box(b, 0.5, 0.3, 0.5, [x, wh + 0.1, z + 2], 'saddle');
          b.mat('paint-red');
        }
      }
    }
    b.mat('paint-yellow').masks(0.2, 1, 0.8, 0);
    for (const sx of [-1, 1]) handrail(b, [[sx * (hw + wt - 0.15), wh, -25.5], [sx * (hw + wt - 0.15), wh, 25.5]]);
  });
  return { models: { body }, pose: staticSite };
};

// -------------------------------------------------------------------------------------- launch mount

export const padLaunchMount: SiteGenerator = ({ params, site }) => {
  const top = site.pad.clampHeight;
  const thick = numParam(params, 'deckThickness', 4.6);
  const half = numParam(params, 'half', 11);
  const holeR = numParam(params, 'openingRadius', 4.78);
  const pier = numParam(params, 'pierSize', 4.4);
  const pc = numParam(params, 'pierCentre', 8.7);
  const seatR = numParam(params, 'clampCircle', 5.6);
  const mastX = numParam(params, 'serviceMastX', 7.2);
  const mastH = numParam(params, 'serviceMastHeight', 5.6);
  const mastReach = numParam(params, 'serviceMastReach', 4.72);
  const y0 = top - thick;

  const body = buildModel('pad.launchMount', (b) => {
    // ---- piers (grime weights: the mount's body is drawn with its grime shown)
    b.mat('concrete-wall').masks(0, 1, 0.3, 0);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        box(b, pier, y0 + 0.3, pier, [sx * pc, (y0 - 0.3) / 2, sz * pc], 'pier');
        if (b.lod < 2) {
          b.mat('steel-dark');
          box(b, pier + 0.3, 0.35, pier + 0.3, [sx * pc, y0 - 0.17, sz * pc], 'bearing');
          b.mat('concrete-wall');
        }
      }
    }
    // ---- table: box girder deck with the exhaust opening
    b.mat('paint-grey').masks(0.2, 1, 0.22, 0);
    const outline: [number, number][] = [];
    const cut = 2.2;
    for (const [x, z] of [
      [half, -half + cut],
      [half - cut, -half],
      [-half + cut, -half],
      [-half, -half + cut],
      [-half, half - cut],
      [-half + cut, half],
      [half - cut, half],
      [half, half - cut],
    ] as [number, number][]) {
      outline.push([x, z]);
    }
    // Extra points along the sides keep the deck triangles well shaped.
    const dense: [number, number][] = [];
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!;
      const c = outline[(i + 1) % outline.length]!;
      const n = Math.max(1, Math.round(Math.hypot(c[0] - a[0], c[1] - a[1]) / 3));
      for (let k = 0; k < n; k++) dense.push([a[0] + ((c[0] - a[0]) * k) / n, a[1] + ((c[1] - a[1]) * k) / n]);
    }
    plateWithHole(b, dense, holeR, b.pick(72, 36, 16), y0, top, 'deck', 'deck-plate');
    if (b.lod < 2) {
      // Girder flanges, opening liner and the painted keep-out ring.
      b.mat('steel-dark').masks(0.3, 1, 1, 0);
      ringSolid(b, holeR - 0.02, holeR + 0.35, top - 0.01, top + 0.04, b.pick(72, 36, 16), 'opening-ring');
      ringSolid(b, holeR - 0.02, holeR + 0.25, y0 - 0.25, y0 + 0.02, b.pick(72, 36, 16), 'opening-skirt');
      b.mat('paint-yellow');
      ringSolid(b, holeR + 2.4, holeR + 2.7, top - 0.005, top + 0.012, b.pick(72, 36, 16), 'keep-out');
      b.mat('paint-grey').masks(0.25, 1, 0.3, 0);
      for (const y of [y0 + 0.3, top - 0.3]) {
        for (const s of [-1, 1]) {
          box(b, 2 * half - 2 * cut, 0.25, 0.16, [0, y, s * (half + 0.07)], 'flange');
          box(b, 0.16, 0.25, 2 * half - 2 * cut, [s * (half + 0.07), y, 0], 'flange');
        }
      }
      if (b.lod === 0) {
        // Web stiffeners on the four faces.
        for (let i = -4; i <= 4; i++) {
          for (const s of [-1, 1]) {
            box(b, 0.12, thick - 0.7, 0.14, [i * 2, (y0 + top) / 2, s * (half + 0.06)], 'stiffener');
            box(b, 0.14, thick - 0.7, 0.12, [s * (half + 0.06), (y0 + top) / 2, i * 2], 'stiffener');
          }
        }
      }
    }
    // ---- seats under the four hold-down clamps (the clamps themselves are parts of the vehicle)
    b.mat('steel-dark').masks(0.3, 1, 0.6, 0);
    for (let k = 0; k < 4; k++) {
      const phi = ((k + 0.5) / 4) * TAU;
      const x = seatR * Math.sin(phi);
      const z = seatR * Math.cos(phi);
      b.at(xf.mul(xf.translate(x, top - 0.02, z), xf.rotY(phi)), () => {
        box(b, 1.5, 0.04, 1.9, [0, 0.0, 0.05], 'clamp-seat');
        if (b.lod === 0) {
          b.mat('steel-bare');
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.at(xf.translate(sx * 0.66, 0.02, 0.05 + sz * 0.85), () => bolt(b, 0.045, 0.03));
          b.mat('steel-dark');
        }
      });
    }
    if (b.lod < 2) {
      const ringR = holeR + 3.6;
      const nSeg = b.pick(72, 36, 16);
      // ---- refractory lining round the exhaust opening and the deck's fittings: hatches, drain grates,
      // cable trays, the hydraulic power unit of the hold-down clamps
      b.mat('refractory').masks(0, 0.9, 0.9, 0);
      ringSolid(b, holeR + 0.35, holeR + 1.7, top - 0.02, top + 0.035, nSeg, 'refractory-ring');
      b.mat('steel-dark').masks(0.3, 1, 0.1, 0);
      for (const [x, z] of [[-8.6, -3.2], [8.2, 4.6], [-3.4, 8.8], [4.0, -8.9]] as [number, number][]) {
        box(b, 1.3, 0.03, 0.95, [x, top + 0.012, z], 'hatch');
        if (b.lod === 0) {
          b.mat('steel-bare');
          for (const s of [-1, 1]) rod(b, [x + s * 0.35, top + 0.03, z - 0.3], [x + s * 0.35, top + 0.03, z + 0.3], 0.012, 6, 'hatch-handle');
          b.mat('steel-dark');
        }
      }
      b.mat('grating').masks(0.2, 0.8, 0.1, 0);
      for (const [x, z, w, d] of [[0, -half + 1.1, 9, 0.45], [0, half - 1.1, 9, 0.45], [-half + 1.1, 0, 0.45, 9]] as [number, number, number, number][]) box(b, w, 0.02, d, [x, top + 0.008, z], 'drain');
      b.mat('galvanised').masks(0.2, 1, 0.1, 0);
      for (const z of [-half + 1.9, half - 1.9]) {
        box(b, 2 * half - 7, 0.11, 0.42, [0.6, top + 0.055, z], 'cable-tray');
        if (b.lod === 0) for (let x = -half + 4.5; x <= half - 3.4; x += 1.5) box(b, 0.06, 0.125, 0.46, [x, top + 0.063, z], 'tray-strap');
      }
      b.mat('paint-grey').masks(0.25, 1, 0.1, 0);
      box(b, 1.8, 1.15, 1.0, [-half + 2.4, top + 0.575, half - 3.6], 'hydraulic-unit');
      if (b.lod === 0) {
        b.mat('steel-bare');
        for (let i = 0; i < 3; i++) b.at(xf.translate(-half + 1.75 + i * 0.36, top + 1.15, half - 2.85), () => bottle(b, 0.13, 0.75, 0.1, 12, 'accumulator'));
        for (let k = 0; k < 4; k++) {
          const phi = ((k + 0.5) / 4) * TAU;
          pipe(b, [[-half + 2.4 + k * 0.08, top + 0.05, half - 3.0], [-half + 2.4 + k * 0.08, top + 0.05, half - 2.4 + k * 0.1], [(seatR + 1.6) * Math.sin(phi), top + 0.05, (seatR + 1.6) * Math.cos(phi)]], 0.02, 0.2, { segs: 6, tag: 'hydraulic-line' });
        }
      }
      // ---- sound-suppression water: a ring main round the opening, fed by two risers up the south-east
      // pier, with six rainbirds: flanged goose-neck pipes that end in flattened fan nozzles over the opening
      // (Painted pipe: grey epoxy over the whole water system, the fan nozzles in oxide red.)
      // (Grime weights of pipes and fittings stay under the threshold at which the mesh shader starts to
      // draw soot in streaks: streaks across a pipe read as stripes.)
      b.mat('paint-grey').masks(0.2, 1, 0.08, 0);
      torus(b, ringR, 0.17, top + 0.2, nSeg, b.pick(10, 6, 4), 'deluge-main');
      for (const dz of [0, 0.75]) pipe(b, [[half - 0.9, -0.2, half - 2.9 - dz], [half - 0.9, top + 0.2, half - 2.9 - dz], [ringR * 0.72, top + 0.2, ringR * 0.72 - dz * 0.4]], 0.2, 0.7, { segs: b.pick(12, 8, 5), tag: 'deluge-riser' });
      for (let k = 0; k < 6; k++) {
        const phi = (k / 6) * TAU + 0.26;
        const out: Vec3Tuple = [Math.sin(phi), 0, Math.cos(phi)];
        const p: Vec3Tuple = [ringR * out[0], top, ringR * out[2]];
        const neck: Vec3Tuple = [p[0] - out[0] * 1.15, top + 2.25, p[2] - out[2] * 1.15];
        const tip: Vec3Tuple = [p[0] - out[0] * 1.75, top + 2.05, p[2] - out[2] * 1.75];
        b.mat('paint-grey').masks(0.2, 1, 0.08, 0);
        pipe(b, [[p[0], top + 0.2, p[2]], [p[0], top + 1.75, p[2]], neck, tip], 0.22, 0.55, { segs: b.pick(14, 8, 5), tag: 'rainbird' });
        // Flanges at the base and under the bend, saddle on the ring main, brace back to the deck.
        b.at(xf.translate(p[0], top + 0.42, p[2]), () => ringSolid(b, 0.2, 0.34, -0.04, 0.04, b.pick(16, 10, 6), 'rainbird-flange'));
        b.at(xf.translate(p[0], top + 1.4, p[2]), () => ringSolid(b, 0.2, 0.32, -0.035, 0.035, b.pick(16, 10, 6), 'rainbird-flange'));
        rod(b, [p[0] + out[0] * 0.95, top, p[2] + out[2] * 0.95], [p[0] + out[0] * 0.18, top + 1.25, p[2] + out[2] * 0.18], 0.045, b.pick(8, 6, 4), 'rainbird-brace');
        if (b.lod === 0) {
          b.mat('steel-bare');
          b.at(xf.translate(p[0], top + 0.46, p[2]), () => boltCircle(b, 0.28, 0, 10, 0.016, 0.012));
          b.at(xf.translate(p[0], top + 1.435, p[2]), () => boltCircle(b, 0.27, 0, 10, 0.015, 0.012));
        }
        // Fan nozzle: the pipe is flattened into a wide slot that throws a sheet of water across the opening.
        b.mat('paint-red').masks(0.3, 1, 0.1, 0);
        const d: Vec3Tuple = [tip[0] - neck[0], tip[1] - neck[1], tip[2] - neck[2]];
        const l = Math.hypot(d[0], d[1], d[2]);
        const along = (t: number): Vec3Tuple => [tip[0] + (d[0] / l) * t, tip[1] + (d[1] / l) * t, tip[2] + (d[2] / l) * t];
        const across: Vec3Tuple = [out[2], 0, -out[0]];
        section(b, rectPoly(0.3, 0.2, 0.06), along(-0.05), along(0.3), across, 'rainbird-head');
        section(b, rectPoly(0.52, 0.12, 0.03), along(0.3), along(0.62), across, 'rainbird-head');
        b.mat('steel-dark');
        section(b, rectPoly(0.56, 0.035, 0.01), along(0.62), along(0.66), across, 'rainbird-lip');
      }
      // ---- handrails and the stair tower from the apron to the deck
      const e = half - 0.2;
      handrail(b, [[-e + cut, top, -e], [e - cut, top, -e], [e, top, -e + cut], [e, top, e - cut], [e - cut, top, e], [-e + cut, top, e], [-e, top, e - cut], [-e, top, -e + cut], [-e + cut, top, -e]]);
      b.mat('galvanised').masks(0.2, 1, 0.1, 0);
      const sx0 = -half - 3.2;
      const flights = Math.ceil(top / 3);
      const zA = -half + 2;
      const zB = -half + 6.4;
      for (const [x, z] of [
        [sx0 - 1.4, zA - 0.45],
        [sx0 + 1.4, zA - 0.45],
        [sx0 - 1.4, zB + 0.45],
        [sx0 + 1.4, zB + 0.45],
      ] as [number, number][]) {
        box(b, 0.2, top + 1.1, 0.2, [x, (top + 1.1) / 2, z], 'stair-post');
      }
      // Bracing of the stair tower's four faces, one bay per flight.
      for (let f = 0; f < flights; f++) {
        const ya = (top * f) / flights + 0.15;
        const yb = (top * (f + 1)) / flights - 0.15;
        for (const sx of [-1.4, 1.4]) rod(b, [sx0 + sx, f % 2 === 0 ? ya : yb, zA - 0.45], [sx0 + sx, f % 2 === 0 ? yb : ya, zB + 0.45], 0.035, b.pick(6, 4, 4), 'stair-brace');
      }
      for (let f = 0; f < flights; f++) {
        const ya = (top * f) / flights;
        const yb = (top * (f + 1)) / flights;
        const dir = f % 2 === 0 ? 1 : -1;
        const x = sx0 - dir * 0.68;
        stairFlight(b, [x, ya, dir > 0 ? zA + 0.45 : zB - 0.45], [x, yb, dir > 0 ? zB - 0.45 : zA + 0.45], 1.1);
        // Landing across the tower at the head of the flight, with a guard rail on its outer edge.
        const zl = dir > 0 ? zB : zA;
        b.mat('grating').masks(0.2, 0.9, 0.1, 0);
        box(b, 2.7, 0.05, 0.9, [sx0, yb - 0.025, zl], 'landing');
        b.mat('galvanised').masks(0.2, 1, 0.1, 0);
        for (const s of [-1, 1]) box(b, 2.8, 0.16, 0.05, [sx0, yb - 0.1, zl + s * 0.45], 'landing-beam');
        handrail(b, [[sx0 - 1.35, yb, zl + dir * 0.45], [sx0 + 1.35, yb, zl + dir * 0.45]], 1.0, 1.35);
      }
      b.mat('grating').masks(0.2, 0.9, 0.1, 0);
      box(b, 3.4, 0.06, 1.2, [-half - 1.6, top - 0.03, zA + 0.6], 'gangway');
      b.mat('galvanised').masks(0.2, 1, 0.1, 0);
      for (const s of [-1, 1]) box(b, 3.4, 0.2, 0.06, [-half - 1.6, top - 0.13, zA + 0.6 + s * 0.6], 'landing-beam');
      handrail(b, [[-half - 3.2, top, zA], [-half, top, zA]], 1.0, 1.1);
    }
  });

  // Tail service mast: stands on the deck on the tower side and carries the aft umbilical; it tips back
  // at lift-off. Model frame: origin at its hinge on the deck.
  const mast = buildModel('pad.launchMount.mast', (b) => {
    // Two side frames with cross tubes: an open mast, not a block.
    b.mat('paint-grey').masks(0.25, 1, 0.95, 0);
    for (const sz of [-0.62, 0.62]) {
      for (const sx of [-0.25, 0.65]) box(b, 0.14, mastH, 0.14, [sx, mastH / 2, sz], 'mast-post');
      if (b.lod < 2) {
        const bays = 4;
        for (let i = 0; i < bays; i++) {
          const ya = (mastH * i) / bays + 0.1;
          const yb = (mastH * (i + 1)) / bays - 0.1;
          rod(b, [i % 2 === 0 ? -0.25 : 0.65, ya, sz], [i % 2 === 0 ? 0.65 : -0.25, yb, sz], 0.035, b.pick(8, 6, 4), 'mast-brace');
          rod(b, [-0.25, yb, sz], [0.65, yb, sz], 0.035, b.pick(8, 6, 4), 'mast-ring');
        }
      }
    }
    if (b.lod < 2) for (let i = 0; i <= 4; i++) for (const sx of [-0.25, 0.65]) rod(b, [sx, (mastH * i) / 4 + (i === 0 ? 0.2 : -0.1), -0.62], [sx, (mastH * i) / 4 + (i === 0 ? 0.2 : -0.1), 0.62], 0.035, b.pick(8, 6, 4), 'mast-cross');
    b.mat('steel-brushed');
    const reach = mastX - mastReach;
    box(b, reach + 0.2, 0.9, 1.5, [-(reach + 0.2) / 2 + 0.1, mastH - 0.55, 0], 'carrier');
    if (b.lod < 2) {
      b.mat('steel-dark');
      box(b, 0.12, 1.1, 1.7, [-reach - 0.02, mastH - 0.55, 0], 'plate');
      // Weather hood over the umbilical plate, and the flex hoses and cable loom that cross the last
      // hand's breadth to the vehicle's own plate (they come away with the mast when it tips back).
      b.mat('paint-grey');
      box(b, 0.9, 0.06, 1.9, [-reach + 0.3, mastH + 0.06, 0], 'hood');
      for (const s of [-1, 1]) box(b, 0.9, 0.5, 0.05, [-reach + 0.3, mastH - 0.2, s * 0.93], 'hood');
      b.mat('rubber');
      for (const [z, y, r] of [[-0.55, 0.15, 0.085], [-0.2, 0.25, 0.1], [0.2, 0.25, 0.1], [0.55, 0.15, 0.085], [0, -0.25, 0.06], [-0.4, -0.3, 0.045], [0.4, -0.3, 0.045]] as [number, number, number][]) {
        rod(b, [-reach - 0.06, mastH - 0.55 + y, z], [-reach - 0.3, mastH - 0.57 + y, z], r, b.pick(10, 6, 5), 'hose');
        if (b.lod === 0) {
          b.mat('steel-bare');
          b.at(xf.mul(xf.translate(-reach - 0.24, mastH - 0.565 + y, z), xf.rotZ(Math.PI / 2)), () => ringSolid(b, r - 0.004, r + 0.022, -0.03, 0.03, 12, 'hose-collar'));
          b.mat('rubber');
        }
      }
      b.mat('steel-brushed');
      for (const z of [-0.4, 0, 0.4]) pipe(b, [[0.5, 0.3, z], [0.5, mastH - 0.6, z], [-reach + 0.1, mastH - 0.6, z]], 0.09, 0.3, { segs: b.pick(10, 6, 5), tag: 'umbilical-line' });
      b.mat('paint-yellow');
      box(b, 1.1, 0.25, 1.3, [0.2, 0.12, 0], 'hinge');
      if (b.lod === 0) {
        b.mat('steel-bare');
        rod(b, [0.2, 0.26, -0.75], [0.2, 0.26, 0.75], 0.07, 12, 'hinge-pin');
      }
    }
  });

  const pose = (state: SiteState, emit: SiteSink, moving: { arms: boolean }): void => {
    // The deck carries its scorch and rust as vertex grime (heaviest round the exhaust opening).
    emit('body', null, null, { grime: 1 });
    const a = (-28 * DEG * state.arms) / 2;
    // Tips back toward +X (away from the vehicle): rotation about Z.
    const rot: QuatTuple | null = state.arms > 0 ? [0, 0, Math.sin(a), Math.cos(a)] : null;
    emit('mast', [mastX, top, 0], rot, { moving: moving.arms });
  };
  return { models: { body, mast }, pose };
};

// ---------------------------------------------------------------------------------------- crawlerway

export const padCrawlerway: SiteGenerator = ({ params }) => {
  const length = numParam(params, 'length', 380);
  const track = numParam(params, 'trackWidth', 12);
  const median = numParam(params, 'median', 14);
  const body = buildModel('pad.crawlerway', (b) => {
    // Runs along the model's Z axis (its "north"). The tracks are river rock pressed down by the crawler's
    // treads: darker lanes where the treads run, lighter rock thrown up between and beside them.
    const step = b.pick(3, 6, 30);
    const half = length / 2;
    const lanes = (x: number, z: number): number => {
      const off = Math.abs(Math.abs(x) - (median / 2 + track / 2));
      const tread = Math.exp(-(((off - track * 0.22) / (track * 0.16)) ** 2));
      return Math.min(0.8, 0.1 + 0.34 * tread * (0.7 + 0.3 * noise2(x / 2.3, z / 11, 21)) + 0.22 * noise2(x / 9, z / 23, 23));
    };
    b.mat('gravel').masks(0, 1, 0, 0);
    for (const s of [-1, 1]) groundSlab(b, s > 0 ? median / 2 : -median / 2 - track, s > 0 ? median / 2 + track : -median / 2, -half, half, 0.24, -0.36, step, lanes, 'track');
    b.mat('concrete').masks(0, 1, 0, 0);
    const worn = (x: number, z: number): number => Math.max(0, 0.34 * noise2(x / 13, z / 19, 27) + 0.16 * noise2(x / 4.1, z / 6.3, 29) - 0.1);
    groundSlab(b, -median / 2, median / 2, -half, half, 0.175, -0.375, step, worn, 'median');
    for (const s of [-1, 1]) groundSlab(b, s > 0 ? median / 2 + track : -median / 2 - track - 1.2, s > 0 ? median / 2 + track + 1.2 : -median / 2 - track, -half, half, 0.3, -0.4, b.pick(6, 12, 60), worn, 'kerb');
  });
  return { models: { body }, pose: flatSite };
};

// ------------------------------------------------------------------------------------------ pipe run

export const padPipeRun: SiteGenerator = ({ params }) => {
  const length = numParam(params, 'length', 100);
  const radius = numParam(params, 'radius', 0.3);
  const count = numParam(params, 'count', 2);
  const height = numParam(params, 'height', 1.6);
  const material = strParam(params, 'material', 'steel-brushed') as MatId;
  const loopEvery = numParam(params, 'loopEvery', 70);
  const pitchOf = (r: number): number => r * 2 + 0.35;
  const body = buildModel('pad.pipeRun', (b) => {
    const pitch = pitchOf(radius);
    // Along the model's -Z ("north") from the origin, with expansion loops.
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) / 2) * pitch;
      const pts: Vec3Tuple[] = [[x, height, 0]];
      const loops = Math.floor(length / loopEvery);
      for (let k = 1; k <= loops; k++) {
        const z = -(k * length) / (loops + 1);
        const out = 3 + i * pitch;
        pts.push([x, height, z + 2.5], [x + out, height, z + 2.5], [x + out, height, z - 2.5], [x, height, z - 2.5]);
      }
      pts.push([x, height, -length]);
      b.mat(material).masks(0.1, 1, 0.3, 0.3);
      pipe(b, pts, radius, radius * 3, { segs: b.pick(14, 8, 5), tag: 'pipe' });
    }
    b.mat('galvanised').masks(0.2, 1, 0.1, 0);
    const w = count * pitch + 0.5;
    const n = Math.max(2, Math.round(length / 9));
    // The far LOD keeps the two end supports, so the run still stands on the ground.
    for (let k = 0; k <= n; k += b.lod === 2 ? n : 1) {
      const z = -(length * k) / n;
      box(b, 0.22, height - radius, 0.22, [0, (height - radius) / 2, z], 'support');
      if (b.lod < 2) box(b, w, 0.16, 0.26, [0, height - radius - 0.08, z], 'cross-head');
    }
    if (b.lod === 2) return;
    // Both ends of a run meet something (a tank farm's manifold, a valve house wall): each pipe ends in a
    // sleeve collar there instead of a sawn-off tube.
    b.mat('steel-dark');
    for (let i = 0; i < count; i++) for (const z of [-0.12, -length + 0.12]) b.at(xf.mul(xf.translate((i - (count - 1) / 2) * pitch, height, z), xf.rotX(Math.PI / 2)), () => ringSolid(b, radius - 0.01, radius + 0.13, -0.12, 0.12, b.pick(16, 10, 6), 'sleeve'));
    if (b.lod === 0) {
      b.mat('steel-bare');
      for (let i = 0; i < count; i++) for (let k = 1; k < n; k += 3) b.at(xf.mul(xf.translate((i - (count - 1) / 2) * pitch, height, -(length * k) / n + 1.2), xf.rotX(Math.PI / 2)), () => ringSolid(b, radius, radius + 0.07, -0.06, 0.06, 16, 'flange'));
    }
  });
  // The run's own shadow is resolved only close to the camera. In the next cascade a solid bar the width of
  // the pipe bundle casts for it: a clean continuous line beside the run, not the crumbs of its supports.
  const shadow = buildModel('pad.pipeRun.shadow', (b) => {
    b.mat('galvanised');
    box(b, count * pitchOf(radius), radius * 2, length, [0, height, -length / 2], 'shadow-proxy');
  });
  return {
    models: { body, shadow },
    pose: (_state, emit) => {
      emit('body', null, null, { fineShadowOnly: true });
      emit('shadow', null, null, { shadowProxy: true, nearShadowOnly: true });
    },
  };
};

// ---------------------------------------------------------------------------------------- floodlight

export const padFloodlight: SiteGenerator = ({ params }) => {
  const H = numParam(params, 'height', 34);
  const candela = numParam(params, 'candela', 7.0e5);
  const range = numParam(params, 'range', 260);
  const tilt = numParam(params, 'tiltDeg', 24) * DEG;
  const lampC: Vec3Tuple = [0, H - 1.2, -0.9];
  // The lattice is under a pixel from across the pad: heavier members in the middle LOD, a solid mast beyond.
  const lodPixels = [numParam(params, 'lod1Pixels', 400), numParam(params, 'lod2Pixels', 120)];
  const body = buildModel('pad.floodlight', (b) => {
    b.mat('galvanised').masks(0.2, 1, 0.2, 0);
    // Tapered lattice mast: four legs, ring frames, bracing.
    const r0 = 1.3;
    const r1 = 0.45;
    const bays = b.pick(8, 4, 2);
    const node = (k: number, l: number): Vec3Tuple => {
      const t = l / bays;
      const r = r0 + (r1 - r0) * t;
      const phi = ((k + 0.5) / 4) * TAU;
      return [r * Math.sin(phi) * Math.SQRT2, (H - 2.2) * t, r * Math.cos(phi) * Math.SQRT2];
    };
    if (b.lod === 2) frustum(b, r0 * 0.62, r1 * 0.75, 0, H - 2.2, 4, 'mast-solid');
    else {
      for (let k = 0; k < 4; k++) {
        rod(b, node(k, 0), node(k, bays), b.pick(0.07, 0.17, 0), b.pick(8, 5, 4), 'leg');
        for (let l = 1; l <= bays; l++) rod(b, node(k, l), node((k + 1) % 4, l), b.pick(0.035, 0.1, 0), b.pick(6, 4, 4), 'ring');
        for (let l = 0; l < bays; l++) rod(b, node(k, l), node((k + 1) % 4, l + 1), b.pick(0.03, 0.09, 0), b.pick(6, 4, 4), 'brace');
      }
    }
    b.mat('concrete-wall');
    box(b, 3.6, 0.7, 3.6, [0, 0.1, 0], 'footing');
    b.mat('paint-grey');
    box(b, 1.6, 0.25, 1.6, [0, H - 2.1, 0], 'head');
    // Lamp bank frame.
    b.at(xf.mul(xf.translate(lampC[0], lampC[1], lampC[2]), xf.rotX(-tilt)), () => {
      b.mat('steel-dark');
      box(b, 4.4, 2.3, 0.35, [0, 0, 0.12], 'bank');
    });
  }, lodPixels);
  const lamps = buildModel('pad.floodlight.lamps', (b) => {
    b.mat('lamp').masks(0, 1, 0, 0);
    b.at(xf.mul(xf.translate(lampC[0], lampC[1], lampC[2]), xf.rotX(-tilt)), () => {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) box(b, 0.85, 0.85, 0.06, [(i - 1.5) * 1.05, (j - 0.5) * 1.05, -0.08], 'lens');
    });
  });
  // Stand-in that casts the mast's shadow where the cascades cannot resolve its members.
  const shadow = buildModel('pad.floodlight.shadow', (b) => {
    b.mat('galvanised');
    frustum(b, 0.55, 0.3, 0, H - 2.2, 4, 'shadow-proxy');
    box(b, 3.6, 2.0, 0.3, [lampC[0], lampC[1], lampC[2]], 'shadow-proxy');
  });
  // The bank is a battery of searchlights aimed at the vehicle, which stands `aimDistance` in front of it.
  // An omni light at the lenses would light the ground under the mast and leave the vehicle dim, so the
  // bank's light is registered where its beams land: a vertical line light a few metres in front of the
  // vehicle on the bank's side, from above the launch mount to `beamTop`. The vehicle is lit top to bottom
  // and is the brightest thing on the pad; the apron gets what spills past it.
  const aim = numParam(params, 'aimDistance', 80);
  const standoff = numParam(params, 'beamStandoff', 15);
  const z = -(aim - standoff);
  const lights: PartLight[] = [{ pos: [0, numParam(params, 'beamBottom', 32), z], end: [0, numParam(params, 'beamTop', 104), z], intensity: [candela, candela * 0.98, candela * 0.94], range }];
  return {
    models: { body, lamps, shadow },
    pose: (state, emit) => {
      emit('body', null, null, { fineShadowOnly: true });
      emit('shadow', null, null, { shadowProxy: true });
      emit('lamps', null, null, { emissive: state.night, castShadow: false });
    },
    lights,
  };
};
