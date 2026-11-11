/**
 * Main display console in front of the crew's faces and the instruments on it: three MFD bezels with soft
 * keys (the screens themselves are drawn by the display pass), the flight director attitude indicator
 * housing (its ball is drawn with the shared navball texture), annunciator matrix, master alarm lamps,
 * guarded toggle switches with position legends, rotary selectors and seven-segment readouts.
 *
 * Console coordinates: x = part +X (across the cabin), u = up the panel (the seats' head-up direction U),
 * in the plane `distance` in front of the eye points along their look direction L. Sections may tilt about
 * their edge adjoining the main band (+ = top edge toward the crew).
 */
import { DEG, v3, type Vec3 } from '@/core/math';
import type { ConsoleSectionDef, LampDef, ReadoutDef, RotaryDef, SwitchDef } from '../layout';
import { FLAG_EDGE, frameAt, local, offsetFrame, tiltFrame, type Attr, type Frame } from '../mesh';
import { insideDistance } from '../mould';
import { FLAG_EMISSIVE, FLAG_SEGMENT, seatFrames, type CabinContext } from './context';

export interface SectionFrame {
  def: ConsoleSectionDef;
  /** Frame at the section's hinge line (x = 0); x = +X, y = up the (tilted) panel, n = toward the crew. */
  frame: Frame;
  uHinge: number;
}

/** Console base frame: origin on the cabin centre line `distance` in front of the eye points, n facing the crew. */
export function consoleBase(ctx: CabinContext): Frame {
  const s = seatFrames(ctx.def)[0]!;
  const eyeLine = { x: 0, y: s.eye.y, z: s.eye.z };
  return frameAt(v3.addScaled(eyeLine, s.L, ctx.layout.console.distance), s.R, s.U);
}

export function sectionFrames(ctx: CabinContext): SectionFrame[] {
  const base = consoleBase(ctx);
  return ctx.layout.console.sections.map((def) => {
    const [u0, u1] = def.u;
    const uHinge = u0 > 0.1 ? u0 : u1 < -0.1 ? u1 : (u0 + u1) / 2;
    let f = offsetFrame(base, 0, uHinge, -(def.offset ?? 0));
    f = tiltFrame(f, (def.tiltDeg ?? 0) * DEG);
    return { def, frame: f, uHinge };
  });
}

/** Frame of an instrument at console coordinates (x, u): on the face of the section that contains it. */
export function consoleFrameAt(ctx: CabinContext, sections: SectionFrame[], x: number, u: number): Frame {
  const sec = sections.find((s) => x >= s.def.x[0] - 1e-6 && x <= s.def.x[1] + 1e-6 && u >= s.def.u[0] - 1e-6 && u <= s.def.u[1] + 1e-6);
  if (!sec) throw new Error(`cockpit console: no section contains (x ${x}, u ${u})`);
  return offsetFrame(sec.frame, x, u - sec.uHinge, 0);
}

const MARGIN = 0.012;

/** Shrink a corner point toward `toward` until it is MARGIN inside the inner wall. */
function fitInside(ctx: CabinContext, p: Vec3, toward: Vec3): Vec3 {
  const need = ctx.def.wallThickness + MARGIN;
  if (insideDistance(ctx.def, p) >= need) return p;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (insideDistance(ctx.def, v3.lerp(p, toward, mid)) >= need) hi = mid;
    else lo = mid;
  }
  return v3.lerp(p, toward, hi);
}

/**
 * The console section slabs: face polygon clipped to the wall (corners cut where the cone closes in), a
 * chamfered edge, and a body that runs back toward the wall as far as it fits.
 */
function sectionSlab(ctx: CabinContext, sec: SectionFrame): void {
  const b = ctx.b;
  const [x0, x1] = sec.def.x;
  const [u0, u1] = sec.def.u;
  const f = sec.frame;
  const depth = sec.def.depth ?? ctx.layout.console.depth;
  const pt = (x: number, u: number, c = 0): Vec3 => local(f, x, u - sec.uHinge, c);
  // Corners of the face, each pulled toward the section centre if the wall is in the way; edges are
  // sampled so a corner that is cut becomes two points.
  const centre = pt((x0 + x1) / 2, (u0 + u1) / 2);
  const rect: [number, number][] = [[x0, u0], [x1, u0], [x1, u1], [x0, u1]];
  const poly: Vec3[] = [];
  for (let i = 0; i < 4; i++) {
    const [ax, au] = rect[i]!;
    const [bx, bu] = rect[(i + 1) % 4]!;
    // Edges sampled finely enough for the occlusion bake at full detail.
    const segs = Math.max(6, Math.min(48, Math.ceil(Math.hypot((bx - ax) * 1, bu - au) / ctx.b.maxEdge)));
    for (let k = 0; k < segs; k++) {
      const t = k / segs;
      const p = pt(ax + (bx - ax) * t, au + (bu - au) * t);
      poly.push(fitInside(ctx, p, centre));
    }
  }
  const panelMat = ctx.m('panel');
  const n = f.n;
  const ch = 0.006;
  // Face (fan from the centre), chamfer ring, side walls back to the body depth.
  const shrinkTo = (p: Vec3, d: number): Vec3 => v3.add(p, v3.scale(v3.normalize(v3.sub(centre, p)), d));
  const faceLoop = poly.map((p) => shrinkTo(p, ch));
  // Face: concentric rings from the centre out to the loop (subdivided like the other flat faces).
  b.part();
  const reach = Math.max(...faceLoop.map((p) => v3.dist(p, centre)));
  const rings = Math.max(1, Math.min(24, Math.ceil(reach / ctx.b.maxEdge)));
  const ci = b.vertex(centre, n, f.x, [0, 0], panelMat);
  const first = b.vertexCount;
  for (let r = 1; r <= rings; r++) {
    for (const p of faceLoop) {
      const q = v3.lerp(centre, p, r / rings);
      const d = v3.sub(q, centre);
      b.vertex(q, n, f.x, [v3.dot(d, f.x), v3.dot(d, f.y)], panelMat);
    }
  }
  const nl = faceLoop.length;
  for (let i = 0; i < nl; i++) b.tri(ci, first + i, first + ((i + 1) % nl));
  for (let r = 1; r < rings; r++) {
    const a0 = first + (r - 1) * nl;
    const a1 = first + r * nl;
    for (let i = 0; i < nl; i++) b.quad(a0 + i, a1 + i, a1 + ((i + 1) % nl), a0 + ((i + 1) % nl));
  }
  const chamferBack = poly.map((p) => v3.addScaled(p, n, -ch));
  ringLoops(ctx, faceLoop, chamferBack, ctx.m('panel', { flags: FLAG_EDGE }), (i) => v3.normalize(v3.add(n, v3.normalize(v3.sub(poly[i]!, centre)))));
  // Quarter-turn fasteners at the panel's corners (where the corner is not cut by the wall).
  if (ctx.detail === 0) {
    for (const [x, u] of [[x0 + 0.012, u0 + 0.012], [x1 - 0.012, u0 + 0.012], [x1 - 0.012, u1 - 0.012], [x0 + 0.012, u1 - 0.012]] as [number, number][]) {
      const p = pt(x, u);
      if (insideDistance(ctx.def, p) < ctx.def.wallThickness + MARGIN + 0.01) continue;
      fastener(ctx, offsetFrame(f, x, u - sec.uHinge, 0));
    }
  }
  // Body: each back corner as deep as fits.
  const backLoop = chamferBack.map((p) => fitInside(ctx, v3.addScaled(p, n, -depth), p));
  ringLoops(ctx, chamferBack, backLoop, ctx.m('consoleBody', { ao: 0.6 }), (i) => v3.normalize(v3.sub(poly[i]!, centre)));
  // Back face.
  const bc = v3.addScaled(centre, n, -depth * 0.9);
  const bci = b.vertex(fitInside(ctx, bc, centre), v3.neg(n), f.x, [0, 0], ctx.m('consoleBody', { ao: 0.5 }));
  const bfirst = b.vertexCount;
  for (const p of backLoop) b.vertex(p, v3.neg(n), f.x, [0, 0], ctx.m('consoleBody', { ao: 0.5 }));
  for (let i = 0; i < backLoop.length; i++) b.tri(bci, bfirst + ((i + 1) % backLoop.length), bfirst + i);
}

/** Quarter-turn panel fastener: dimpled cup washer, slotted stud head. */
function fastener(ctx: CabinContext, f: Frame): void {
  const b = ctx.b;
  b.lathe(f.o, f.n, [[0.0062, 0], [0.0062, 0.0006], [0.0052, 0.0011], [0.0046, 0.0009]], 20, ctx.m('steel'), { ref: f.x });
  b.lathe(local(f, 0, 0, 0.0009), f.n, [[0.0042, 0], [0.0042, 0.0007], [0.0034, 0.0012], [0.0, 0.0013]], 20, ctx.m('steel', { flags: FLAG_EDGE }), { ref: f.x });
  b.box(offsetFrame(f, 0, 0, 0.0021), 0.0036, 0.00045, 0.0002, 0.00005, ctx.m('cavity'));
}

function ringLoops(ctx: CabinContext, a: Vec3[], c: Vec3[], attr: Attr, normal: (i: number) => Vec3): void {
  const b = ctx.b;
  const n = a.length;
  const base = b.vertexCount;
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    const t = v3.normalize(v3.sub(a[(k + 1) % n]!, a[k]!));
    b.vertex(a[k]!, normal(k), t, [i * 0.02, 0], attr);
    b.vertex(c[k]!, normal(k), t, [i * 0.02, v3.dist(a[k]!, c[k]!)], attr);
  }
  for (let i = 0; i < n; i++) {
    const q = base + i * 2;
    b.quad(q, q + 1, q + 3, q + 2);
  }
}

export function buildConsole(ctx: CabinContext): void {
  const sections = sectionFrames(ctx);
  for (const s of sections) sectionSlab(ctx, s);
  const con = ctx.layout.console;
  const at = (x: number, u: number): Frame => consoleFrameAt(ctx, sections, x, u);
  con.displays.forEach((d, i) => displayBezel(ctx, at(d.x, d.u), d.activeWidth, d.activeHeight, d.border, d.keys, i));
  fdai(ctx, at(con.navball.x, con.navball.u), con.navball.ballRadius, con.navball.housing);
  if (ctx.detail === 2) return;
  annunciator(ctx, at(con.annunciator.x, con.annunciator.u), con.annunciator.columns, con.annunciator.cell, con.annunciator.lamps);
  con.masterAlarms.forEach((ma, i) => masterAlarm(ctx, at(ma.x, ma.u), ma.size, i));
  if (ctx.detail > 0) return;
  for (const row of con.switchRows) row.switches.forEach((sw, i) => toggleSwitch(ctx, at(row.x + i * row.pitch, row.u), sw, `console:${row.x}:${row.u}:${i}`));
  for (const r of con.rotaries) rotary(ctx, at(r.x, r.u), r.radius, r.selector, `rot:${r.x}:${r.u}`);
  for (const r of con.readouts) readout(ctx, at(r.x, r.u), r.digitHeight, r.readout, `ro:${r.x}:${r.u}`);
  for (const l of con.lamps) singleLamp(ctx, at(l.x, l.u), l.size, l.lamp, `lamp:${l.x}:${l.u}`);
  // Mounting struts from the console top corners to the wall.
  for (const s of sections) {
    const f = s.frame;
    for (const x of [s.def.x[0] + 0.05, s.def.x[1] - 0.05]) {
      const top = local(f, x, s.def.u[1] - s.uHinge - 0.02, -con.depth * 0.5);
      const dir = v3.normalize(v3.add(v3.scale(f.n, -1), v3.scale(f.y, 0.6)));
      let end = v3.addScaled(top, dir, 0.6);
      end = fitInsideAlong(ctx, top, end);
      if (v3.dist(top, end) > 0.05) ctx.b.tube([top, end], 0.01, 8, ctx.m('couchFrame'));
    }
  }
}

function fitInsideAlong(ctx: CabinContext, from: Vec3, to: Vec3): Vec3 {
  const need = ctx.def.wallThickness + 0.004;
  let lo = 0;
  let hi = 1;
  if (insideDistance(ctx.def, to) >= need) return to;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (insideDistance(ctx.def, v3.lerp(from, to, mid)) >= need) lo = mid;
    else hi = mid;
  }
  return v3.lerp(from, to, lo);
}

/** MFD bezel: frame around the recessed screen, soft keys along both sides, legend. */
function displayBezel(ctx: CabinContext, f: Frame, w: number, h: number, border: number, keys: number, index: number): void {
  const b = ctx.b;
  const depth = 0.022;
  const outerW = w / 2 + border;
  const outerH = h / 2 + border * 0.8;
  const bez = ctx.m('bezel');
  // Bezel ring (four boxes) and the screen recess.
  const recess = 0.004;
  b.box(offsetFrame(f, 0, h / 2 + (border * 0.8) / 2, depth / 2), outerW, (border * 0.8) / 2, depth / 2, 0.003, bez);
  b.box(offsetFrame(f, 0, -h / 2 - (border * 0.8) / 2, depth / 2), outerW, (border * 0.8) / 2, depth / 2, 0.003, bez);
  b.box(offsetFrame(f, -w / 2 - border / 2, 0, depth / 2), border / 2, h / 2, depth / 2, 0.003, bez);
  b.box(offsetFrame(f, w / 2 + border / 2, 0, depth / 2), border / 2, h / 2, depth / 2, 0.003, bez);
  // Inner lip of the recess (dark), framing the active area.
  const lip = ctx.m('anodized', { ao: 0.6 });
  b.box(offsetFrame(f, 0, h / 2 + 0.002, depth - recess / 2), w / 2 + 0.004, 0.002, recess / 2, 0.0005, lip);
  b.box(offsetFrame(f, 0, -h / 2 - 0.002, depth - recess / 2), w / 2 + 0.004, 0.002, recess / 2, 0.0005, lip);
  b.box(offsetFrame(f, -w / 2 - 0.002, 0, depth - recess / 2), 0.002, h / 2, recess / 2, 0.0005, lip);
  b.box(offsetFrame(f, w / 2 + 0.002, 0, depth - recess / 2), 0.002, h / 2, recess / 2, 0.0005, lip);
  const screen = offsetFrame(f, 0, 0, depth - recess);
  ctx.displays[index] = { index, frame: screen, width: w, height: h };
  if (ctx.detail > 0) return;
  // Soft keys: `keys` per side, with a dimple and a legend tick.
  const key = ctx.m('keycap');
  for (const side of [-1, 1]) {
    for (let k = 0; k < keys; k++) {
      const v = h / 2 - ((k + 0.5) * h) / keys;
      b.box(offsetFrame(f, side * (w / 2 + border / 2), v, depth + 0.003), 0.0085, 0.0062, 0.003, 0.0015, key);
    }
  }
  // Brightness rocker and power key on the lower border.
  b.box(offsetFrame(f, w / 2 - 0.02, -h / 2 - border * 0.4, depth + 0.003), 0.012, 0.005, 0.003, 0.0015, key);
  b.box(offsetFrame(f, -w / 2 + 0.02, -h / 2 - border * 0.4, depth + 0.003), 0.006, 0.005, 0.003, 0.0015, ctx.m('keycap'));
  ctx.labelQuad(offsetFrame(f, 0, -h / 2 - border * 0.4, depth), 0, 0, 0.05, 0.008, `MFD ${index + 1}`, 'bezel', { color: 0, backlit: true });
  ctx.labelQuad(offsetFrame(f, w / 2 - 0.02, -h / 2 - border * 0.4 + 0.0085, depth), 0, 0, 0.03, 0.005, 'BRT', 'bezel', { color: 4, backlit: true });
  for (const [x, y] of [[-outerW + 0.006, outerH - 0.006], [outerW - 0.006, outerH - 0.006], [-outerW + 0.006, -outerH + 0.006], [outerW - 0.006, -outerH + 0.006]] as [number, number][]) {
    b.cylinder(local(f, x, y, depth), f.n, 0.0025, 0.0012, 8, ctx.m('steel'), { caps: 'top' });
  }
}

/** Flight director attitude indicator: square bezel with a round window, recessed cavity, roll scale. */
function fdai(ctx: CabinContext, f: Frame, ballR: number, housing: number): void {
  const b = ctx.b;
  const hs = housing / 2;
  const depth = 0.035;
  const holeR = ballR * 1.12;
  const n = 48;
  const outline: [number, number][] = [];
  const hole: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    // Rounded square: superellipse of exponent 8.
    const c = Math.cos(a);
    const s = Math.sin(a);
    const k = (Math.abs(c) ** 8 + Math.abs(s) ** 8) ** (-1 / 8);
    outline.push([hs * c * k, hs * s * k]);
    hole.push([holeR * c, holeR * s]);
  }
  b.extrude(f, outline, depth, ctx.m('bezel'), { hole, bevel: 0.003, caps: 'front' });
  // Cavity behind the window: black, deep enough to hold the ball.
  b.cylinder(local(f, 0, 0, depth - 0.045), f.n, holeR, 0.045, n, ctx.m('cavity', { ao: 0.3 }), { caps: 'bottom' });
  const centre = local(f, 0, 0, depth - 0.006 - ballR);
  ctx.navball = { frame: { ...f, o: centre }, radius: ballR };
  if (ctx.detail > 0) return;
  // Roll scale ring printed on the bezel face, fasteners, legend.
  const face = offsetFrame(f, 0, 0, depth);
  ctx.labelRing(face, holeR + 0.001, holeR + 0.015, '#ROLL', 'bezel', { color: 0, backlit: true, lift: 0.0003 });
  for (const [x, y] of [[-hs + 0.008, hs - 0.008], [hs - 0.008, hs - 0.008], [-hs + 0.008, -hs + 0.008], [hs - 0.008, -hs + 0.008]] as [number, number][]) {
    b.cylinder(local(face, x, y, 0), f.n, 0.003, 0.0012, 8, ctx.m('steel'), { caps: 'top' });
  }
  ctx.labelQuad(face, 0, -hs + 0.006, 0.05, 0.007, 'FDAI', 'bezel', { color: 0, backlit: true });
}

function lampControl(ctx: CabinContext, key: string, f: Frame, lamp: LampDef) {
  return ctx.control(key, () => ({ kind: 'lamp', pivot: f.o, axis: f.n, binding: lamp.binding, lamp }));
}

/** Annunciator matrix: housing with a grid of legend lenses. */
function annunciator(ctx: CabinContext, f: Frame, columns: number, cell: [number, number], lamps: LampDef[]): void {
  const rows = Math.ceil(lamps.length / columns);
  const [cw, chh] = cell;
  const W = columns * cw;
  const H = rows * chh;
  ctx.b.box(offsetFrame(f, 0, 0, 0.008), W / 2 + 0.006, H / 2 + 0.006, 0.008, 0.002, ctx.m('bezel'));
  lamps.forEach((lamp, i) => {
    const c = i % columns;
    const r = Math.floor(i / columns);
    const lf = offsetFrame(f, -W / 2 + (c + 0.5) * cw, H / 2 - (r + 0.5) * chh, 0.016);
    lens(ctx, lf, cw / 2 - 0.0015, chh / 2 - 0.0015, lamp, `ann:${i}`);
  });
  ctx.labelQuad(offsetFrame(f, 0, H / 2 + 0.012, 0), 0, 0, 0.12, 0.008, 'CAUTION & WARNING', 'panel', { color: 0, backlit: true });
}

/** A legend lens: dark tinted face that glows in the lamp colour with its legend brighter. */
function lens(ctx: CabinContext, f: Frame, hx: number, hy: number, lamp: LampDef, key: string): void {
  const c = lampControl(ctx, key, f, lamp);
  if (ctx.detail > 0) {
    ctx.b.box(offsetFrame(f, 0, 0, -0.002), hx, hy, 0.002, 0.0005, ctx.m('lens', { ctl: c.index, flags: FLAG_EMISSIVE }));
    return;
  }
  const rect = ctx.label(lamp.label, hy * 2 * 0.95, hx * 2 * 0.95, { weight: 700 });
  const lensAttr = ctx.m('lens', { ctl: c.index, flags: FLAG_EMISSIVE, ink: 4, label: { rect, origin: [-hx, -hy], size: [hx * 2, hy * 2] } });
  ctx.b.box(offsetFrame(f, 0, 0, -0.002), hx, hy, 0.002, 0.0006, ctx.m('lens', { ctl: c.index, flags: FLAG_EMISSIVE }), { frontAttr: lensAttr });
}

function masterAlarm(ctx: CabinContext, f: Frame, size: number, i: number): void {
  const lamp: LampDef = { label: 'MASTER ALARM', binding: 'masterAlarm', color: [1, 0.12, 0.06], luminance: 600, flashHz: 2 };
  ctx.b.box(offsetFrame(f, 0, 0, 0.006), size / 2 + 0.005, size / 2 + 0.005, 0.006, 0.002, ctx.m('bezel'));
  lens(ctx, offsetFrame(f, 0, 0, 0.016), size / 2, size / 2, lamp, `master:${i}`);
}

function singleLamp(ctx: CabinContext, f: Frame, size: number, lamp: LampDef, key: string): void {
  ctx.b.box(offsetFrame(f, 0, 0, 0.004), size / 2 + 0.003, size * 0.35 + 0.003, 0.004, 0.0015, ctx.m('bezel'));
  lens(ctx, offsetFrame(f, 0, 0, 0.0105), size / 2, size * 0.35, lamp, key);
}

/** Toggle switch: mounting nut, bat-handle lever (animated), optional flip guard, legends. */
export function toggleSwitch(ctx: CabinContext, f: Frame, sw: SwitchDef, key: string, panelMat = 'panel'): void {
  const b = ctx.b;
  const throwDeg = 28;
  // Keyed lock washer with its anti-rotation tab, hex nut, threaded bushing.
  b.cylinder(local(f, 0, 0, 0), f.n, 0.0085, 0.0007, 20, ctx.m('steel'), { caps: 'top' });
  b.box(offsetFrame(f, 0, 0.0095, 0.00035), 0.0016, 0.0022, 0.00035, 0.0001, ctx.m('steel'));
  b.lathe(local(f, 0, 0, 0.0007), f.n, [[0.0072, 0], [0.0072, 0.0026], [0.0062, 0.0032], [0.0046, 0.0032]], 6, ctx.m('steel'), { ref: f.x });
  b.cylinder(local(f, 0, 0, 0.0032), f.n, 0.0046, 0.0042, 16, ctx.m('steel', { flags: FLAG_EDGE }), { caps: 'top' });
  const pivot = local(f, 0, 0, 0.0074);
  // Lever along +n at rest; a rotation by +a about +x tips it toward -y, so "up" (position 0) is -throw.
  const c = ctx.control(key, () => ({ kind: 'toggle', pivot, axis: f.x, binding: sw.binding, angles: [-throwDeg * DEG, throwDeg * DEG] }));
  // Bat-handle lever: a tapered chrome shank swelling into a rounded tip.
  b.lathe(pivot, f.n, [[0.0, -0.0004], [0.0017, 0], [0.0019, 0.008], [0.0024, 0.017], [0.0031, 0.0215], [0.0029, 0.0235], [0.0018, 0.0248], [0.0, 0.0252]], 14, ctx.m('steel', { ctl: c.index }), { ref: f.x });
  const labelMat = panelMat;
  ctx.labelQuad(f, 0, 0.024, 0.034, 0.0065, sw.label, labelMat, { color: panelMat === 'panel' ? 0 : 1, backlit: panelMat === 'panel' });
  if (sw.up) ctx.labelQuad(f, 0.0125, 0.0105, 0.014, 0.0045, sw.up, labelMat, { color: panelMat === 'panel' ? 4 : 1, style: { align: 'left' } });
  if (sw.down) ctx.labelQuad(f, 0.0125, -0.0105, 0.014, 0.0045, sw.down, labelMat, { color: panelMat === 'panel' ? 4 : 1, style: { align: 'left' } });
  if (sw.kind === 'guarded') {
    // U-shaped guard hinged below the switch: open (swung down) while the switch is on.
    const hinge = local(f, 0, -0.012, 0.004);
    const g = ctx.control(`${key}:guard`, () => ({ kind: 'guard', pivot: hinge, axis: f.x, binding: sw.binding, angles: [-115 * DEG, 0] }));
    // Bail guard: two side cheeks joined by a rounded bar over the lever tip.
    const ga = ctx.m('guard', { ctl: g.index });
    const gf = offsetFrame(f, 0, 0.002, 0.0115);
    for (const s of [-1, 1]) b.box(offsetFrame(gf, s * 0.0095, 0, 0), 0.001, 0.014, 0.0105, 0.0004, ga);
    b.cylinder(local(gf, -0.0095, 0.012, 0.0095), f.x, 0.0016, 0.019, 8, ga);
    b.cylinder(v3.addScaled(hinge, f.x, -0.011), f.x, 0.0018, 0.022, 8, ctx.m('steel'));
  }
}

/** Rotary selector: fluted knob with a pointer (animated), skirt and position legends. */
function rotary(ctx: CabinContext, f: Frame, radius: number, sel: RotaryDef, key: string): void {
  const b = ctx.b;
  const spread = Math.min(150, (sel.positions.length - 1) * 30) * DEG;
  const angles = sel.positions.map((_, i) => (sel.positions.length === 1 ? 0 : spread / 2 - (i * spread) / (sel.positions.length - 1)));
  const c = ctx.control(key, () => ({ kind: 'rotary', pivot: f.o, axis: f.n, binding: sel.binding, angles, fixed: sel.fixed }));
  b.cylinder(local(f, 0, 0, 0), f.n, radius * 1.35, 0.002, 28, ctx.m('anodized'));
  b.lathe(local(f, 0, 0, 0.002), f.n, [[radius, 0], [radius, radius * 0.8], [radius * 0.82, radius * 1.0], [0.0, radius * 1.02]], 24, ctx.m('knob', { ctl: c.index }), { ref: f.y });
  // Pointer line on the knob top.
  b.box(offsetFrame(f, 0, radius * 0.45, 0.002 + radius * 1.02), 0.0012, radius * 0.42, 0.0004, 0.0002, ctx.m('pointer', { ctl: c.index }));
  sel.positions.forEach((p, i) => {
    const a = angles[i]!;
    const r = radius * 1.35 + 0.009;
    ctx.labelQuad(f, -Math.sin(a) * r, Math.cos(a) * r, 0.02, 0.0045, p, 'panel', { color: 4, backlit: true });
  });
  ctx.labelQuad(f, 0, -radius * 1.35 - 0.008, 0.04, 0.0058, sel.label, 'panel', { color: 0, backlit: true });
}

/** Seven-segment readout: smoked window, digits made of segments lit per the digit's mask. */
function readout(ctx: CabinContext, f: Frame, dh: number, ro: ReadoutDef, key: string): void {
  const b = ctx.b;
  const dw = dh * 0.58;
  const gap = dh * 0.22;
  const n = ro.digits;
  const colonW = dh * 0.28;
  const colons = ro.colons ?? [];
  const total = n * dw + (n - 1) * gap + colons.length * colonW;
  b.box(offsetFrame(f, 0, 0, 0.006), total / 2 + 0.008, dh / 2 + 0.006, 0.006, 0.002, ctx.m('bezel'));
  b.box(offsetFrame(f, 0, 0, 0.0115), total / 2 + 0.003, dh / 2 + 0.002, 0.0006, 0.0002, ctx.m('smoked'));
  const seg = (dx: number, x0: number, y0: number, x1: number, y1: number, ctl: number, bit: number): void => {
    // Segment as a hexagonal bar between (x0, y0) and (x1, y1) in digit units.
    const p = (x: number, y: number): Vec3 => local(f, dx + x, y, 0.0125);
    const ex = x1 - x0;
    const ey = y1 - y0;
    const l = Math.hypot(ex, ey);
    const tx = ex / l;
    const ty = ey / l;
    const w = dh * 0.055;
    const nx = -ty * w;
    const ny = tx * w;
    const a = ctx.m('segment', { ctl, sub: bit, flags: FLAG_SEGMENT | FLAG_EMISSIVE });
    const pts = [p(x0 + tx * w, y0 + ty * w), p(x0 + tx * 2 * w + nx, y0 + ty * 2 * w + ny), p(x1 - tx * 2 * w + nx, y1 - ty * 2 * w + ny), p(x1 - tx * w, y1 - ty * w), p(x1 - tx * 2 * w - nx, y1 - ty * 2 * w - ny), p(x0 + tx * 2 * w - nx, y0 + ty * 2 * w - ny)];
    const ids = pts.map((q) => b.vertex(q, f.n, f.x, [0, 0], a));
    b.tri(ids[0]!, ids[2]!, ids[1]!);
    b.tri(ids[0]!, ids[3]!, ids[2]!);
    b.tri(ids[0]!, ids[4]!, ids[3]!);
    b.tri(ids[0]!, ids[5]!, ids[4]!);
  };
  let x = -total / 2 + dw / 2;
  const hw = dw / 2;
  const hh = dh / 2;
  const slant = dh * 0.06;
  for (let d = 0; d < n; d++) {
    const c = ctx.control(`${key}:${d}`, () => ({ kind: 'digit', pivot: f.o, axis: f.n, binding: 'none', readout: ro, digit: d }));
    // Segments a..g (bits 0..6) with a slight italic slant.
    seg(x, -hw + slant, hh, hw + slant, hh, c.index, 0);
    seg(x, hw + slant, hh, hw, 0, c.index, 1);
    seg(x, hw, 0, hw - slant, -hh, c.index, 2);
    seg(x, -hw - slant, -hh, hw - slant, -hh, c.index, 3);
    seg(x, -hw, 0, -hw - slant, -hh, c.index, 4);
    seg(x, -hw + slant, hh, -hw, 0, c.index, 5);
    seg(x, -hw, 0, hw, 0, c.index, 6);
    x += dw + gap;
    if (colons.includes(d)) {
      const cx = x - gap / 2 - dw / 2 + colonW / 2;
      for (const y of [dh * 0.22, -dh * 0.22]) seg(cx - 0.5 * dw * 0.1, -dh * 0.04, y, dh * 0.04, y, c.index, 7);
      x += colonW;
    }
  }
  ctx.labelQuad(f, -total / 2 + 0.002, dh / 2 + 0.0105, 0.05, 0.0058, ro.label, 'panel', { color: 0, backlit: true, style: { align: 'left' } });
}

export type { Attr };
