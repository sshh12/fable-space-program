/**
 * Cabin fixtures: side panels with circuit breakers and switches, LED floodlights, handholds, stowage
 * lockers, flexible air ducts with diffusers, cable runs with clamps, the fire extinguisher and a
 * flight-data-file pouch. Everything is placed on the inner wall from azimuth / y and pulled inward until
 * it clears the wall.
 */
import { DEG, v3, type Vec3 } from '@/core/math';
import { frameAt, local, offsetFrame, type Frame } from '../mesh';
import { insideDistance } from '../mould';
import { FLAG_EMISSIVE, seatFrames, type CabinContext } from './context';
import { toggleSwitch } from './console';
import { wallInward, wallPoint } from './shell';

/** Correlated colour temperature -> linear sRGB colour normalised to luminance 1 (Planckian locus fit). */
export function cctColor(k: number): [number, number, number] {
  // Kang et al. chromaticity of the Planckian locus, then xyY -> XYZ -> linear sRGB.
  const t = Math.max(1667, Math.min(25000, k));
  const x = t <= 4000 ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991 : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  const y = t <= 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683 : t <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867 : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  const X = x / y;
  const Z = (1 - x - y) / y;
  const r = 3.2406 * X - 1.5372 - 0.4986 * Z;
  const g = -0.9689 * X + 1.8758 + 0.0415 * Z;
  const b = 0.0557 * X - 0.204 + 1.057 * Z;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [Math.max(0, r / lum), Math.max(0, g / lum), Math.max(0, b / lum)];
}

/**
 * Planar frame on the wall at (az, y), normal into the cabin, text up along the crew's head-up direction:
 * the crew lie across the capsule axis, so "up" on a side panel is toward the dorsal side, not the apex.
 */
export function wallFrame(ctx: CabinContext, azDeg: number, y: number, inset: number): Frame {
  const a = azDeg * DEG;
  const n = wallInward(ctx, a, y);
  const U = seatFrames(ctx.def)[0]!.U;
  let up = v3.reject(U, n);
  if (v3.len(up) < 0.2) up = v3.reject({ x: 0, y: 1, z: 0 }, n);
  up = v3.normalize(up);
  const x = v3.cross(up, n);
  return frameAt(wallPoint(ctx, a, y, inset), x, up);
}

/** Inset (m) that keeps a w x h plate of thickness t on the wall frame clear of the wall by `margin`. */
export function plateInset(ctx: CabinContext, azDeg: number, y: number, w: number, h: number, t: number, margin = 0.004): number {
  const need = ctx.def.wallThickness + margin;
  let inset = 0.002;
  for (let k = 0; k < 40; k++) {
    const f = wallFrame(ctx, azDeg, y, inset);
    let worst = Infinity;
    for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) worst = Math.min(worst, insideDistance(ctx.def, local(f, (sx * w) / 2, (sy * h) / 2, -t)));
    if (worst >= need) return inset;
    inset += need - worst + 0.0005;
  }
  return inset;
}

export function buildFixtures(ctx: CabinContext): void {
  const L = ctx.layout;
  const b = ctx.b;
  const d = ctx.detail;
  // ---- side panels
  for (const p of L.wallPanels) {
    const t = 0.02;
    const inset = plateInset(ctx, p.azDeg, p.y, p.width, p.height, 0) + t;
    const f = wallFrame(ctx, p.azDeg, p.y, inset);
    b.box(offsetFrame(f, 0, 0, -t / 2), p.width / 2, p.height / 2, t / 2, 0.004, ctx.m('panel'));
    if (d === 2) continue;
    // Standoffs to the wall at the corners.
    if (d === 0) {
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const q = local(f, sx * (p.width / 2 - 0.02), sy * (p.height / 2 - 0.02), -t);
          const w = fitWall(ctx, q, v3.neg(f.n));
          if (v3.dist(q, w) > 0.003) b.cylinder(w, v3.sub(q, w), 0.008, v3.dist(q, w), 8, ctx.m('aluminium'));
        }
      }
      ctx.labelQuad(f, 0, p.height / 2 - 0.012, Math.min(0.24, p.width * 0.8), 0.009, p.title, 'panel', { color: 0, backlit: true });
      p.breakers.forEach((row, ri) => {
        row.labels.forEach((label, i) => {
          const x = -((row.labels.length - 1) * row.pitch) / 2 + i * row.pitch;
          breaker(ctx, offsetFrame(f, x, row.v, 0), label, `${p.id}:${ri}:${i}`);
        });
      });
      p.switchRows.forEach((row, ri) => {
        row.switches.forEach((sw, i) => {
          const x = -((row.switches.length - 1) * row.pitch) / 2 + i * row.pitch;
          toggleSwitch(ctx, offsetFrame(f, x, row.v, 0), sw, `${p.id}:sw:${ri}:${i}`);
        });
      });
    }
  }
  if (d === 2) return;

  // ---- floodlights: housing on the wall, diffuser lens facing the aim point
  L.lighting.floods.forEach((fl, i) => {
    const inset = plateInset(ctx, fl.azDeg, fl.y, fl.length, 0.06, 0.035) + 0.035;
    const wf = wallFrame(ctx, fl.azDeg, fl.y, inset);
    const aim = v3.fromTuple(fl.aim);
    const toAim = v3.normalize(v3.sub(aim, wf.o));
    // Lens normal: toward the aim point, tilted within the fixture's swivel range around the wall normal.
    const n = v3.normalize(v3.add(wf.n, v3.scale(v3.reject(toAim, wf.n), 1.2)));
    const along = v3.normalize(v3.reject(wf.x, n));
    const f = clearFrame(ctx, frameAt(wf.o, along, v3.cross(n, along)), fl.length / 2 + 0.03, 0.03, -0.03, 0.008, wf.n);
    const c = ctx.control(`flood:${i}`, () => ({ kind: 'flood', pivot: f.o, axis: f.n, binding: 'lights', flood: i }));
    b.box(offsetFrame(f, 0, 0, -0.012), fl.length / 2 + 0.012, 0.028, 0.014, 0.006, ctx.m('closeout'));
    if (d === 0) {
      b.box(offsetFrame(f, 0, 0, 0.0035), fl.length / 2, 0.018, 0.0035, 0.002, ctx.m('floodLens', { ctl: c.index, flags: FLAG_EMISSIVE }));
      for (const s of [-1, 1]) b.cylinder(local(f, s * (fl.length / 2 + 0.018), 0, -0.012), f.y, 0.008, 0.06, 10, ctx.m('aluminium'), { caps: 'both' });
      const p0 = local(f, -fl.length / 2, 0, 0.008);
      const p1 = local(f, fl.length / 2, 0, 0.008);
      ctx.floods.push({ p0, p1, n: f.n, lumens: fl.lumens, color: cctColor(fl.cct), control: c.index });
    }
  });

  if (d > 0) return;
  // ---- handholds: U-shaped rails standing off the wall
  const holds: [number, number, number][] = [
    [148, 0.95, 0.32],
    [212, 0.95, 0.32],
    [148, 1.48, 0.28],
    [212, 1.48, 0.28],
    [45, 1.95, 0.22],
    [-45, 1.95, 0.22],
    [-122, 1.25, 0.26],
    [122, 1.25, 0.26],
  ];
  for (const [az, y, len] of holds) handhold(ctx, az, y, len);

  // ---- stowage lockers on the lower cone
  const lockers: [number, number, number, number, string][] = [
    [-135, 0.55, 0.36, 0.28, 'B1 · FOOD'],
    [-160, 0.55, 0.3, 0.28, 'B2 · HYGIENE'],
    [135, 0.55, 0.36, 0.28, 'B3 · MEDICAL'],
    [160, 0.55, 0.3, 0.28, 'B4 · SURVIVAL'],
    [-45, 0.52, 0.42, 0.24, 'A1 · CAMERAS'],
    [45, 0.52, 0.42, 0.24, 'A2 · LiOH SPARES'],
    [-10, 0.5, 0.3, 0.22, 'A3 · TOOLS'],
    [10, 0.5, 0.3, 0.22, 'A4 · CLOTHING'],
  ];
  for (const [az, y, w, h, label] of lockers) locker(ctx, az, y, w, h, label);

  // ---- air ducts from the floor plenum to diffusers near the couch heads
  for (const side of [-1, 1]) {
    const pathAz = [side * 118, side * 112, side * 100, side * 78, side * 62];
    const ys = [0.27, 0.45, 0.72, 0.98, 1.12];
    const pts = pathAz.map((az, i) => wallPoint(ctx, az * DEG, ys[i]!, 0.075));
    b.tube(pts, 0.032, 16, ctx.m('duct'), { caps: false });
    const end = pts[pts.length - 1]!;
    const dir = v3.normalize(v3.sub(end, pts[pts.length - 2]!));
    b.cylinder(end, dir, 0.04, 0.03, 18, ctx.m('closeout'), { radius1: 0.05 });
    b.disc(frameAt(v3.addScaled(end, dir, 0.03), v3.anyOrthogonal(dir), v3.cross(dir, v3.anyOrthogonal(dir))), 0.048, 0.0, 18, ctx.m('grille'), { flip: v3.dot(v3.cross(v3.anyOrthogonal(dir), v3.cross(dir, v3.anyOrthogonal(dir))), dir) < 0 });
  }

  // ---- cable runs: bundles along ring frames to the console, with clamps
  const runs: { y: number; az: [number, number]; r: number; mat: string; inset: number }[] = [
    { y: 1.28, az: [-150, -60], r: 0.011, mat: 'cable', inset: 0.06 },
    { y: 1.3, az: [60, 150], r: 0.011, mat: 'cable', inset: 0.06 },
    { y: 1.62, az: [-70, -32], r: 0.009, mat: 'cableBlack', inset: 0.055 },
    { y: 1.62, az: [32, 70], r: 0.009, mat: 'cableBlack', inset: 0.055 },
    { y: 0.92, az: [-120, -30], r: 0.008, mat: 'cableGrey', inset: 0.06 },
    { y: 0.92, az: [30, 120], r: 0.008, mat: 'cableGrey', inset: 0.06 },
  ];
  for (const run of runs) {
    const pts: Vec3[] = [];
    const steps = Math.ceil(Math.abs(run.az[1] - run.az[0]) / 4);
    for (let k = 0; k <= steps; k++) {
      const az = run.az[0] + ((run.az[1] - run.az[0]) * k) / steps;
      pts.push(wallPoint(ctx, az * DEG, run.y + 0.006 * Math.sin(k * 1.7), run.inset));
    }
    for (const off of [-0.6, 0.6]) {
      b.tube(pts.map((p) => v3.addScaled(p, { x: 0, y: 1, z: 0 }, off * run.r * 1.4)), run.r * 0.7, 8, ctx.m(run.mat));
    }
    b.tube(pts, run.r, 10, ctx.m(run.mat));
    for (let k = 1; k < steps; k += 3) {
      const az = run.az[0] + ((run.az[1] - run.az[0]) * k) / steps;
      const wf = wallFrame(ctx, az, run.y, run.inset);
      b.box(offsetFrame(wf, 0, 0, 0), 0.006, run.r * 2.6, run.r * 1.4, 0.002, ctx.m('anodized'));
    }
  }

  // ---- fire extinguisher in its bracket by the hatch
  const ext = wallFrame(ctx, 152, 0.82, plateInset(ctx, 152, 0.82, 0.08, 0.34, 0.07) + 0.07);
  b.cylinder(local(ext, 0, -0.15, -0.035), ext.y, 0.034, 0.27, 20, ctx.m('extinguisher'), { caps: 'bottom' });
  b.lathe(local(ext, 0, 0.12, -0.035), ext.y, [[0.034, 0], [0.03, 0.02], [0.012, 0.035], [0.01, 0.06], [0, 0.065]], 16, ctx.m('extinguisher'));
  b.box(offsetFrame(ext, 0.02, 0.17, -0.035), 0.03, 0.006, 0.01, 0.002, ctx.m('anodized'));
  for (const v of [-0.08, 0.05]) b.box(offsetFrame(ext, 0, v, -0.035), 0.04, 0.009, 0.04, 0.003, ctx.m('webbing'));
  ctx.labelQuad(offsetFrame(ext, 0, -0.03, 0), 0, 0, 0.055, 0.02, 'FIRE EXT', 'extinguisher', { color: 0 });

  // ---- flight data file pouch on the left wall by the commander
  const fdf = wallFrame(ctx, -128, 1.42, plateInset(ctx, -128, 1.42, 0.22, 0.26, 0.05) + 0.05);
  b.box(offsetFrame(fdf, 0, 0, -0.025), 0.11, 0.13, 0.025, 0.012, ctx.m('pouch'));
  b.box(offsetFrame(fdf, 0, 0.11, 0.002), 0.105, 0.012, 0.004, 0.003, ctx.m('velcro'));
  ctx.labelQuad(fdf, 0, -0.03, 0.12, 0.016, 'FLIGHT DATA FILE', 'pouch', { color: 1 });
  // Velcro patches scattered on the blankets: the classic loose-item anchors of a crewed cabin.
  const patches: [number, number][] = [[-30, 1.35], [30, 1.35], [-100, 1.6], [100, 1.6], [-165, 1.25], [165, 1.25], [0, 1.85], [-60, 0.95], [60, 0.95]];
  for (const [az, y] of patches) {
    const pf = wallFrame(ctx, az, y, plateInset(ctx, az, y, 0.05, 0.05, 0.002) + 0.023);
    b.box(pf, 0.025, 0.025, 0.0015, 0.001, ctx.m('velcro'));
  }
}

/** Move a frame along `dir` until the box [-hx, hx] x [-hy, hy] x [z0, z1] around it clears the wall by 3 mm. */
export function clearFrame(ctx: CabinContext, f: Frame, hx: number, hy: number, z0: number, z1: number, dir: Vec3): Frame {
  const need = ctx.def.wallThickness + 0.003;
  let o = f.o;
  for (let k = 0; k < 60; k++) {
    const g = { ...f, o };
    let worst = Infinity;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z of [z0, z1]) worst = Math.min(worst, insideDistance(ctx.def, local(g, sx * hx, sy * hy, z)));
    if (worst >= need) return g;
    o = v3.addScaled(o, dir, need - worst + 0.001);
  }
  return { ...f, o };
}

/** Point on the wall reached from p along dir (or p itself when already at the wall). */
function fitWall(ctx: CabinContext, p: Vec3, dir: Vec3): Vec3 {
  const need = ctx.def.wallThickness + 0.0005;
  let lo = 0;
  let hi = 0.3;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (insideDistance(ctx.def, v3.addScaled(p, dir, mid)) > need) lo = mid;
    else hi = mid;
  }
  return v3.addScaled(p, dir, lo);
}

function breaker(ctx: CabinContext, f: Frame, label: string, key: string): void {
  const b = ctx.b;
  b.cylinder(local(f, 0, 0, 0), f.n, 0.0058, 0.002, 12, ctx.m('steel'));
  b.cylinder(local(f, 0, 0, 0.002), f.n, 0.0042, 0.0035, 12, ctx.m('breakerBand'));
  b.cylinder(local(f, 0, 0, 0.0055), f.n, 0.0045, 0.0055, 12, ctx.m('breakerCap'));
  ctx.labelQuad(f, 0, 0.0115, 0.022, 0.0042, label, 'panel', { color: 0, backlit: true });
  void key;
}

function handhold(ctx: CabinContext, az: number, y: number, len: number): void {
  const inset = plateInset(ctx, az, y, len, 0.04, 0.005);
  const f = wallFrame(ctx, az, y, inset);
  const standoff = 0.05;
  const r = 0.011;
  const pts = [local(f, -len / 2, 0, -0.004), local(f, -len / 2, 0, standoff - 0.02), local(f, -len / 2 + 0.02, 0, standoff), local(f, len / 2 - 0.02, 0, standoff), local(f, len / 2, 0, standoff - 0.02), local(f, len / 2, 0, -0.004)];
  ctx.b.tube(pts, r, 12, ctx.m('handhold'), { caps: true });
  for (const s of [-1, 1]) ctx.b.box(offsetFrame(f, (s * len) / 2, 0, -0.002), 0.018, 0.018, 0.004, 0.002, ctx.m('aluminium'));
}

function locker(ctx: CabinContext, az: number, y: number, w: number, h: number, label: string): void {
  const depth = 0.1;
  const inset = plateInset(ctx, az, y, w, h, depth) + depth;
  const f = wallFrame(ctx, az, y, inset);
  const b = ctx.b;
  b.box(offsetFrame(f, 0, 0, -depth / 2), w / 2, h / 2, depth / 2, 0.006, ctx.m('closeout', { ao: 0.85 }));
  // Door with a seam groove, paddle latch and label.
  b.box(offsetFrame(f, 0, 0, 0.003), w / 2 - 0.008, h / 2 - 0.008, 0.003, 0.002, ctx.m('closeout'));
  b.box(offsetFrame(f, 0, h / 2 - 0.035, 0.008), 0.035, 0.012, 0.003, 0.002, ctx.m('anodized'));
  b.box(offsetFrame(f, 0, h / 2 - 0.035, 0.0115), 0.026, 0.006, 0.0012, 0.0008, ctx.m('steel'));
  ctx.labelQuad(offsetFrame(f, 0, 0, 0.006), 0, -0.01, Math.min(w * 0.8, 0.2), 0.018, label, 'closeout', { color: 1, style: { box: true } });
}
