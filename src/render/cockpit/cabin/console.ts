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
import { EDGE_SPAN, FLAG_EDGE, frameAt, local, localDir, offsetFrame, tiltFrame, type Attr, type Frame } from '../mesh';
import { insideDistance } from '../mould';
import { FLAG_EMISSIVE, FLAG_OVERLAY, FLAG_SEGMENT, seatFrames, type CabinContext } from './context';
import { skinHeight } from './shell';

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

/**
 * How the console meets the hull (request cockpit-lead-1). The face plate of every section ends where the
 * conical wall closes in: its hull-side edge follows the wall's curvature at a constant stand-off, clear of
 * the insulation blankets' crowns, and carries a seal bead toward the wall. The body behind the plate stands
 * a little further off, clear of the ring frames it passes, and follows the wall back as the cone narrows:
 * both are limited ROW BY ROW along the cabin's width (the wall is a surface of revolution about the part's
 * Y axis and the console's x axis is the part's X: at a given height on the panel and depth behind it, the
 * console may reach a half-width that the wall decides). Nothing is pulled about or cut diagonally.
 */
const FACE_GAP = 0.012;
const BODY_GAP = 0.004;
/** Thickness of a section's face plate (m): the chamfer plus a square return. */
const PLATE = 0.012;
/** Seal bead along the hull-side edge of a face plate: radius and how far its centre stands outboard of the edge. */
const BEAD_RADIUS = 0.005;
const BEAD_OUT = 0.004;

/** Stand-off of the face plates (clear of the blankets) and of the bodies (clear of the frames) from the inner wall. */
export function consoleStandoff(ctx: CabinContext): { face: number; body: number } {
  const sh = ctx.layout.shell;
  // The plates lie between two ring frames (blankets under their edges); the bodies cross frames.
  const blankets = skinHeight(ctx, sh.closeoutTopY + 0.1, sh.closeoutTopY + 0.11);
  const frames = Math.max(...sh.ringFramesY.map((y) => skinHeight(ctx, y, y)));
  return { face: blankets + FACE_GAP, body: Math.max(frames, blankets) + BODY_GAP };
}

/**
 * Largest |x| (m) at which the point (x, u, c) of a frame (x across the cabin) stands `standoff` inside the
 * inner wall; 0 when even the centre line does not.
 */
function hullHalfWidth(ctx: CabinContext, f: Frame, u: number, c: number, standoff: number): number {
  const need = ctx.def.wallThickness + standoff;
  if (insideDistance(ctx.def, local(f, 0, u, c)) < need) return 0;
  let lo = 0;
  let hi = 2.5;
  for (let k = 0; k < 32; k++) {
    const mid = (lo + hi) / 2;
    if (insideDistance(ctx.def, local(f, mid, u, c)) >= need) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** A point slid from p toward `toward` until it stands `standoff` inside the inner wall. */
function fitToward(ctx: CabinContext, p: Vec3, toward: Vec3, standoff: number): Vec3 {
  const need = ctx.def.wallThickness + standoff;
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

/** Footprint of a part mounted on the console, in console coordinates (x across, u up the panel). */
export interface Footprint {
  x0: number;
  x1: number;
  u0: number;
  u1: number;
  /** What it is (for the message when it does not fit on the panel). */
  name?: string;
}

/**
 * Grid lines between a and b: even spacing `step`, plus the given exact lines (a mounted part's outline and
 * a line just off it), the even ones that fall too close to an exact one dropped.
 */
function gridLines(a: number, b: number, step: number, exact: number[]): number[] {
  const ex = exact.filter((v) => v > a + 0.008 && v < b - 0.008).sort((p, q) => p - q).filter((v, i, arr) => i === 0 || v - arr[i - 1]! > 0.003);
  const n = Math.max(1, Math.round((b - a) / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const v = a + ((b - a) * i) / n;
    if (i === 0 || i === n || ex.every((e) => Math.abs(e - v) > step * 0.4)) out.push(v);
  }
  return [...out, ...ex].sort((p, q) => p - q);
}

/** A closed loop without its repeated points (rows that the hull limits to the same point). */
function dedupe(loop: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of loop) if (out.length === 0 || v3.dist(out[out.length - 1]!, p) > 1e-5) out.push(p);
  while (out.length > 1 && v3.dist(out[0]!, out[out.length - 1]!) <= 1e-5) out.pop();
  return out;
}

/**
 * One console section: a face plate fitted to the hull, a chamfered edge with a square return, and a closed
 * body behind it that follows the wall back (side cheeks, a back cover), so nothing of the cabin shows under
 * or behind the console and nothing of the console reaches into the wall or what lies on it.
 *
 * The face is a regular grid (the baked occlusion lives on its vertices), with grid lines laid along the
 * outline of every large part mounted on it and again a few millimetres off: the contact shadow of a bezel
 * or a housing is then a band of even width that follows the part, the same for identical parts. Where the
 * wall limits a row, the grid points beyond the limit lie ON the limit: the plate's hull-side edge is the
 * wall's own curve at the face stand-off.
 */
function sectionSlab(ctx: CabinContext, sec: SectionFrame, parts: Footprint[], skirt = false): void {
  const b = ctx.b;
  const [x0, x1] = sec.def.x;
  const [u0, u1] = sec.def.u;
  const f = sec.frame;
  const depth = sec.def.depth ?? ctx.layout.console.depth;
  const so = consoleStandoff(ctx);
  const pt = (x: number, u: number, c = 0): Vec3 => local(f, x, u - sec.uHinge, c);
  const centre = pt((x0 + x1) / 2, (u0 + u1) / 2);
  const fine = ctx.detail === 0;
  const step = fine ? 0.014 : 0.2;
  const mine = fine ? parts.filter((p) => p.x1 > x0 && p.x0 < x1 && p.u1 > u0 && p.u0 < u1) : [];
  const X = gridLines(x0, x1, step, mine.flatMap((p) => [p.x0 - 0.008, p.x0 - 0.002, p.x1 + 0.002, p.x1 + 0.008]));
  const U = gridLines(u0, u1, step, mine.flatMap((p) => [p.u0 - 0.008, p.u0 - 0.002, p.u1 + 0.002, p.u1 + 0.008]));
  const nx = X.length - 1;
  const nu = U.length - 1;
  const panelMat = ctx.m('panel');
  const n = f.n;
  const ch = 0.006;
  // Per row: how far the hull lets the face reach to either side.
  const limit = U.map((u) => hullHalfWidth(ctx, f, u - sec.uHinge, 0, so.face));
  const xAt = (i: number, j: number): number => Math.max(-limit[j]!, Math.min(limit[j]!, X[i]!));
  const clipped = (i: number, j: number): boolean => Math.abs(X[i]!) > limit[j]! + 1e-9;
  const outlineAt = (i: number, j: number): Vec3 => pt(xAt(i, j), U[j]!);
  const shrinkTo = (p: Vec3, d: number): Vec3 => v3.add(p, v3.scale(v3.normalize(v3.sub(centre, p)), d));
  // The grid: the border row and every point on the hull's limit are the outline (chamfered: the face ends
  // `ch` inside it).
  b.part();
  const first = b.vertexCount;
  for (let j = 0; j <= nu; j++) {
    for (let i = 0; i <= nx; i++) {
      const border = i === 0 || j === 0 || i === nx || j === nu || clipped(i, j);
      const q = border ? shrinkTo(outlineAt(i, j), ch) : outlineAt(i, j);
      const d = v3.sub(q, centre);
      b.vertex(q, n, f.x, [v3.dot(d, f.x), v3.dot(d, f.y)], panelMat);
    }
  }
  for (let j = 0; j < nu; j++) {
    for (let i = 0; i < nx; i++) {
      // (A cell wholly beyond the hull's limit has no area.)
      if (xAt(i + 1, j) - xAt(i, j) < 1e-6 && xAt(i + 1, j + 1) - xAt(i, j + 1) < 1e-6) continue;
      const k = first + j * (nx + 1) + i;
      b.quad(k, k + 1, k + nx + 2, k + nx + 1);
    }
  }
  // The outline, counter-clockwise seen from the crew, as (column, row) of the grid.
  const ring: [number, number][] = [];
  for (let i = 0; i < nx; i++) ring.push([i, 0]);
  for (let j = 0; j < nu; j++) ring.push([nx, j]);
  for (let i = nx; i > 0; i--) ring.push([i, nu]);
  for (let j = nu; j > 0; j--) ring.push([0, j]);
  // The body's outline behind the plate, row by row at the body's stand-off, and its back, as deep as the
  // layout asks and as wide as the wall leaves there.
  const bodyAt = (i: number, j: number, c: number): Vec3 => {
    const u = U[j]! - sec.uHinge;
    const w = hullHalfWidth(ctx, f, u, c, so.body);
    // (Where the cone has closed over this row altogether the body ends on the centre line's last clear depth.)
    if (w <= 0) return fitToward(ctx, local(f, 0, u, c), local(f, 0, u, -PLATE), so.body);
    return local(f, Math.max(-w, Math.min(w, X[i]!)), u, c);
  };
  const keep: number[] = [];
  {
    const pts = ring.map(([i, j]) => outlineAt(i, j));
    pts.forEach((p, k) => {
      if (keep.length === 0 || v3.dist(pts[keep[keep.length - 1]!]!, p) > 1e-5) keep.push(k);
    });
    while (keep.length > 1 && v3.dist(pts[keep[0]!]!, pts[keep[keep.length - 1]!]!) <= 1e-5) keep.pop();
  }
  const loop = keep.map((k) => ring[k]!);
  const poly = loop.map(([i, j]) => outlineAt(i, j));
  const out = (k: number): Vec3 => v3.normalize(v3.sub(poly[k]!, centre));
  const faceLoop = poly.map((p) => shrinkTo(p, ch));
  const chamferBack = poly.map((p) => v3.addScaled(p, n, -ch));
  const plateBack = poly.map((p) => v3.addScaled(p, n, -PLATE));
  ringLoops(ctx, faceLoop, chamferBack, ctx.m('panel', { flags: FLAG_EDGE }), (k) => v3.normalize(v3.add(n, out(k))));
  ringLoops(ctx, chamferBack, plateBack, ctx.m('panel'), out);
  const bodyFront = loop.map(([i, j]) => bodyAt(i, j, -PLATE));
  const bodyBack = loop.map(([i, j]) => bodyAt(i, j, -depth));
  const bodyMat = ctx.m('consoleBody', { ao: 0.6 });
  // The plate's back, from its edge in to the body (the overhang by which the plate reaches closer to the wall).
  ringLoops(ctx, plateBack, bodyFront, ctx.m('consoleBody', { ao: 0.5 }), () => v3.neg(n));
  ringLoops(ctx, bodyFront, bodyBack, bodyMat, out);
  // Back cover.
  {
    const bc = v3.scale(bodyBack.reduce((a, p) => v3.add(a, p), v3.zero()), 1 / bodyBack.length);
    const cover = ctx.m('consoleBody', { ao: 0.5 });
    const bci = b.vertex(bc, v3.neg(n), f.x, [0, 0], cover);
    const bfirst = b.vertexCount;
    for (const p of bodyBack) b.vertex(p, v3.neg(n), f.x, [0, 0], cover);
    for (let k = 0; k < bodyBack.length; k++) if (v3.dist(bodyBack[k]!, bodyBack[(k + 1) % bodyBack.length]!) > 1e-5) b.tri(bci, bfirst + ((k + 1) % bodyBack.length), bfirst + k);
  }
  // Quarter-turn fasteners at the panel's corners (where the hull has not taken the corner).
  if (fine) {
    for (const [x, u] of [[x0 + 0.012, u0 + 0.012], [x1 - 0.012, u0 + 0.012], [x1 - 0.012, u1 - 0.012], [x0 + 0.012, u1 - 0.012]] as [number, number][]) {
      if (Math.abs(x) + 0.012 > hullHalfWidth(ctx, f, u - sec.uHinge, 0, so.face)) continue;
      fastener(ctx, offsetFrame(f, x, u - sec.uHinge, 0));
    }
  }
  // Where the hull limits the plate: a seal bead along that edge toward the wall, and brackets from the
  // body's cheek to the structure. Both reach toward the hull by design: a mount.
  if (ctx.detail < 2) {
    for (const side of [-1, 1]) {
      const col = side < 0 ? 0 : nx;
      const rows: number[] = [];
      for (let j = 0; j <= nu; j++) if (clipped(col, j)) rows.push(j);
      if (rows.length < 2) continue;
      b.group('mount:console');
      const path = rows.map((j) => v3.add(pt(xAt(col, j), U[j]!, -PLATE / 2), v3.scale(f.x, side * BEAD_OUT)));
      b.tube(path, BEAD_RADIUS, fine ? 10 : 6, ctx.m('seal'), { caps: true });
      if (fine) {
        for (const t of [0.22, 0.78]) {
          const j = rows[Math.round(t * (rows.length - 1))]!;
          const from = v3.lerp(bodyAt(col, j, -PLATE), bodyAt(col, j, -depth), 0.3);
          const az = Math.atan2(from.x, from.z);
          // (The post ends a rim's slope short of the sloping wall: its foot does not reach into it.)
          const reach = v3.dist(from, fitWallAlong(ctx, from, { x: Math.sin(az), y: 0, z: Math.cos(az) })) - 0.01;
          if (reach > 0.01) b.cylinder(from, { x: Math.sin(az), y: 0, z: Math.cos(az) }, 0.011, reach, 10, ctx.m('aluminium'));
        }
      }
      b.group('console');
    }
  }
  // The lowest section closes the space under the console: a skirt from its lower edge, down and back
  // toward the wall (a close-out panel with a row of fasteners), so the eye does not run on under the
  // console. It ends at the body's stand-off from the wall.
  if (skirt) {
    const down = v3.normalize(v3.add(v3.scale(f.y, -0.75), v3.scale(n, -0.65)));
    const cols: number[] = [];
    for (let i = 0; i <= nx; i++) if (i === 0 || xAt(i, 0) - xAt(cols[cols.length - 1]!, 0) > 1e-6) cols.push(i);
    const top = cols.map((i) => v3.addScaled(outlineAt(i, 0), n, -ch));
    const bottom = top.map((p) => fitToward(ctx, v3.addScaled(p, down, 0.7), p, so.body));
    const skirtMat = ctx.m('panel', { ao: 0.7 });
    const sn = v3.normalize(v3.cross(down, f.x));
    const first2 = b.vertexCount;
    cols.forEach((i, k) => {
      b.vertex(top[k]!, sn, f.x, [xAt(i, 0), 0], skirtMat);
      b.vertex(bottom[k]!, sn, f.x, [xAt(i, 0), v3.dist(top[k]!, bottom[k]!)], skirtMat);
    });
    for (let k = 0; k + 1 < cols.length; k++) b.quad(first2 + 2 * k, first2 + 2 * k + 1, first2 + 2 * k + 3, first2 + 2 * k + 2);
    if (fine) {
      for (let k = 1; k + 1 < cols.length; k += 4) fastener(ctx, frameAt(v3.lerp(top[k]!, bottom[k]!, 0.06), f.x, v3.neg(down)), 0.8);
    }
  }
}

/** The point where the ray from p along the unit direction d (toward the wall) reaches the inner wall. */
function fitWallAlong(ctx: CabinContext, p: Vec3, d: Vec3): Vec3 {
  const need = ctx.def.wallThickness + 0.0005;
  let lo = 0;
  let hi = 0.4;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (insideDistance(ctx.def, v3.addScaled(p, d, mid)) > need) lo = mid;
    else hi = mid;
  }
  return v3.addScaled(p, d, lo);
}

/** Quarter-turn panel fastener: dimpled cup washer, slotted stud head (an overlay: it does not bury the panel's vertices). */
function fastener(ctx: CabinContext, f: Frame, scale = 1): void {
  const b = ctx.b;
  const s = scale;
  b.lathe(f.o, f.n, [[0.0062 * s, 0], [0.0062 * s, 0.0006 * s], [0.0052 * s, 0.0011 * s], [0.0046 * s, 0.0009 * s]], 20, ctx.m('steel', { flags: FLAG_OVERLAY }), { ref: f.x });
  b.lathe(local(f, 0, 0, 0.0009 * s), f.n, [[0.0042 * s, 0], [0.0042 * s, 0.0007 * s], [0.0034 * s, 0.0012 * s], [0.0, 0.0013 * s]], 20, ctx.m('steel', { flags: FLAG_EDGE | FLAG_OVERLAY }), { ref: f.x });
  b.box(offsetFrame(f, 0, 0, 0.0021 * s), 0.0036 * s, 0.00045 * s, 0.0002 * s, 0.00005 * s, ctx.m('cavity', { flags: FLAG_OVERLAY }));
}

function ringLoops(ctx: CabinContext, a: Vec3[], c: Vec3[], attr: Attr, normal: (i: number) => Vec3): void {
  const b = ctx.b;
  const n = a.length;
  const base = b.vertexCount;
  const edge = ((attr.flags ?? 0) & FLAG_EDGE) !== 0;
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    if (i > 0) s += v3.dist(a[k]!, a[(k - 1 + n) % n]!);
    const t = v3.normalize(v3.sub(a[(k + 1) % n]!, a[k]!));
    b.vertex(a[k]!, normal(k), t, [s, 0], attr);
    b.vertex(c[k]!, normal(k), t, [s, edge ? EDGE_SPAN : v3.dist(a[k]!, c[k]!)], attr);
  }
  for (let i = 0; i < n; i++) {
    const q = base + i * 2;
    b.quad(q, q + 1, q + 3, q + 2);
  }
}

/** Half sizes of a seven-segment readout's housing (width, height). */
function readoutHalf(dh: number, ro: ReadoutDef): [number, number] {
  const dw = dh * 0.58;
  const total = ro.digits * dw + (ro.digits - 1) * dh * 0.22 + (ro.colons ?? []).length * dh * 0.28;
  return [total / 2 + 0.008, dh / 2 + 0.006];
}

export function buildConsole(ctx: CabinContext): void {
  const sections = sectionFrames(ctx);
  const con = ctx.layout.console;
  // Footprints of the large parts: the panels' meshes follow their outlines (sectionSlab).
  const rect = (x: number, u: number, hx: number, hu: number, name = ''): Footprint => ({ x0: x - hx, x1: x + hx, u0: u - hu, u1: u + hu, name });
  const ann = con.annunciator;
  const parts: Footprint[] = [
    ...con.displays.map((d, i) => rect(d.x, d.u, d.activeWidth / 2 + d.border, d.activeHeight / 2 + d.border * 0.8, `display ${i + 1}`)),
    rect(con.navball.x, con.navball.u, con.navball.housing / 2, con.navball.housing / 2, 'attitude indicator'),
    rect(ann.x, ann.u, (ann.columns * ann.cell[0]) / 2 + 0.006, (Math.ceil(ann.lamps.length / ann.columns) * ann.cell[1]) / 2 + 0.006, 'annunciator'),
    ...con.masterAlarms.map((m, i) => rect(m.x, m.u, m.size / 2 + 0.005, m.size / 2 + 0.005, `master alarm ${i + 1}`)),
    ...con.readouts.map((r) => {
      const [hx, hu] = readoutHalf(r.digitHeight, r.readout);
      return rect(r.x, r.u, hx, hu, `readout ${r.readout.label}`);
    }),
  ];
  // The small parts too (their bodies and their nomenclature), for the fit check only.
  const small: Footprint[] = [
    ...con.switchRows.flatMap((row) => row.switches.map((sw, i) => rect(row.x + i * row.pitch, row.u, 0.019, 0.038, `switch ${sw.label}`))),
    ...con.rotaries.map((r) => rect(r.x, r.u, r.radius * 1.35 + 0.02, r.radius * 1.35 + 0.014, `selector ${r.selector.label}`)),
    ...con.lamps.map((l) => rect(l.x, l.u, l.size / 2 + 0.003, l.size * 0.35 + 0.003, `lamp ${l.lamp.label}`)),
  ];
  if (ctx.detail === 0) assertPartsFit(ctx, sections, [...parts, ...small]);
  const lowest = sections.reduce((a, s) => (s.def.u[0] < a.def.u[0] ? s : a), sections[0]!);
  for (const s of sections) sectionSlab(ctx, s, parts, s === lowest);
  const at = (x: number, u: number): Frame => consoleFrameAt(ctx, sections, x, u);
  if (ctx.detail < 2) consoleJoints(ctx, sections);
  con.displays.forEach((d, i) => displayBezel(ctx, at(d.x, d.u), d.activeWidth, d.activeHeight, d.border, d.keys, i));
  fdai(ctx, at(con.navball.x, con.navball.u), con.navball.ballRadius, con.navball.housing);
  if (ctx.detail === 2) return;
  annunciator(ctx, at(con.annunciator.x, con.annunciator.u), con.annunciator.columns, con.annunciator.cell, con.annunciator.lamps);
  con.masterAlarms.forEach((ma, i) => masterAlarm(ctx, at(ma.x, ma.u), ma.size, i));
  if (ctx.detail > 0) return;
  for (const row of con.switchRows) {
    row.switches.forEach((sw, i) => toggleSwitch(ctx, at(row.x + i * row.pitch, row.u), sw, `console:${row.x}:${row.u}:${i}`));
    // Wicket guards between neighbouring switches (and at the ends of the row): a hand that brushes the
    // row meets the wickets, not the levers.
    for (let i = 0; i <= row.switches.length; i++) wicket(ctx, at(row.x + (i - 0.5) * row.pitch, row.u));
    // A group line under the row's name labels.
    const f = at(row.x + ((row.switches.length - 1) * row.pitch) / 2, row.u);
    ctx.labelQuad(f, 0, 0.0325, row.switches.length * row.pitch, 0.0012, '#LINE', 'panel', { color: 4 });
  }
  for (const r of con.rotaries) rotary(ctx, at(r.x, r.u), r.radius, r.selector, `rot:${r.x}:${r.u}`);
  for (const r of con.readouts) readout(ctx, at(r.x, r.u), r.digitHeight, r.readout, `ro:${r.x}:${r.u}`);
  for (const l of con.lamps) singleLamp(ctx, at(l.x, l.u), l.size, l.lamp, `lamp:${l.x}:${l.u}`);
}

/**
 * Every part mounted on the console lies on its section's face inside the hull's limit (with the chamfer's
 * width to spare): a layout whose instruments hang over the panel's hull-side edge is refused with the
 * part's name, instead of being built into the wall.
 */
function assertPartsFit(ctx: CabinContext, sections: SectionFrame[], parts: Footprint[]): void {
  const so = consoleStandoff(ctx);
  for (const p of parts) {
    const xc = (p.x0 + p.x1) / 2;
    const uc = (p.u0 + p.u1) / 2;
    const sec = sections.find((s) => xc >= s.def.x[0] - 1e-6 && xc <= s.def.x[1] + 1e-6 && uc >= s.def.u[0] - 1e-6 && uc <= s.def.u[1] + 1e-6);
    if (!sec) throw new Error(`cockpit console: no section contains the ${p.name} at (x ${xc.toFixed(3)}, u ${uc.toFixed(3)})`);
    for (const u of [p.u0, p.u1]) {
      const w = hullHalfWidth(ctx, sec.frame, u - sec.uHinge, 0, so.face) - 0.008;
      const reach = Math.max(Math.abs(p.x0), Math.abs(p.x1));
      if (reach > w) throw new Error(`cockpit console: the ${p.name} reaches x ${reach.toFixed(3)} m at u ${u.toFixed(3)}, but the hull leaves the panel ${w.toFixed(3)} m there: move it inboard`);
    }
  }
}

/** Wicket guard: a U of 3 mm satin round bar standing across the row beside a switch. */
function wicket(ctx: CabinContext, f: Frame): void {
  const r = 0.0015;
  const h = 0.019;
  const half = 0.0125;
  const pts = [local(f, 0, -half, -0.001), local(f, 0, -half, h - 0.004), local(f, 0, -half + 0.004, h), local(f, 0, half - 0.004, h), local(f, 0, half, h - 0.004), local(f, 0, half, -0.001)];
  ctx.b.tube(pts, r, 8, ctx.m('satinSteel'));
}

/**
 * What makes the sections one console: a close-out bead along the hinge line of every tilted section (no
 * slit to look through between two panels), cover strips with fasteners over the butt joints of the main
 * band, and end brackets to the pressure wall.
 */
function consoleJoints(ctx: CabinContext, sections: SectionFrame[]): void {
  const b = ctx.b;
  const body = ctx.m('consoleBody');
  const flat = sections.filter((s) => !s.def.tiltDeg);
  for (const s of sections) {
    if (!s.def.tiltDeg) continue;
    const f = s.frame;
    const mid = local(f, (s.def.x[0] + s.def.x[1]) / 2, 0, -0.011);
    const reach = consoleStandoff(ctx).face + 0.014;
    const p0 = fitInsideAlong(ctx, mid, local(f, s.def.x[0] + 0.004, 0, -0.011), reach);
    const p1 = fitInsideAlong(ctx, mid, local(f, s.def.x[1] - 0.004, 0, -0.011), reach);
    b.cylinder(p0, v3.sub(p1, p0), 0.0125, v3.dist(p0, p1), ctx.detail === 0 ? 14 : 8, body, { caps: 'both', ref: f.n });
  }
  if (ctx.detail > 0) return;
  // Butt joints between coplanar neighbours.
  for (const a of flat) {
    for (const c of flat) {
      if (Math.abs(a.def.x[1] - c.def.x[0]) > 1e-6 || (a.def.offset ?? 0) !== (c.def.offset ?? 0)) continue;
      const u0 = Math.max(a.def.u[0], c.def.u[0]) + 0.01;
      const u1 = Math.min(a.def.u[1], c.def.u[1]) - 0.01;
      const f = offsetFrame(a.frame, a.def.x[1], (u0 + u1) / 2 - a.uHinge, 0);
      b.box(offsetFrame(f, 0, 0, 0.001), 0.0075, (u1 - u0) / 2, 0.001, 0.0006, ctx.m('anodized', { flags: FLAG_OVERLAY }));
      const n = Math.max(2, Math.round((u1 - u0) / 0.085));
      for (let k = 0; k <= n; k++) fastener(ctx, offsetFrame(f, 0, -(u1 - u0) / 2 + 0.012 + ((u1 - u0 - 0.024) * k) / n, 0.002), 0.5);
    }
  }
}

function fitInsideAlong(ctx: CabinContext, from: Vec3, to: Vec3, margin = 0.004): Vec3 {
  const need = ctx.def.wallThickness + margin;
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
  // Page keys along the top border, one above each page tab of the screen (the painter lays its tabs over
  // the left `tabSpan` of the width, one per page), each with a raised index bar.
  const key = ctx.m('keycap');
  const tabW = (w * ctx.layout.displays.tabSpan) / keys;
  for (let k = 0; k < keys; k++) {
    const x = -w / 2 + (k + 0.5) * tabW;
    const kf = offsetFrame(f, x, h / 2 + border * 0.4, depth + 0.003);
    b.box(kf, Math.min(0.0095, tabW * 0.4), 0.0058, 0.003, 0.0015, key);
    b.box(offsetFrame(kf, 0, 0, 0.0033), Math.min(0.004, tabW * 0.18), 0.0006, 0.0003, 0.0001, ctx.m('pointer'));
  }
  // Brightness rocker and power key on the lower border.
  b.box(offsetFrame(f, w / 2 - 0.02, -h / 2 - border * 0.4, depth + 0.003), 0.012, 0.005, 0.003, 0.0015, key);
  b.box(offsetFrame(f, -w / 2 + 0.02, -h / 2 - border * 0.4, depth + 0.003), 0.006, 0.005, 0.003, 0.0015, ctx.m('keycap'));
  ctx.labelQuad(offsetFrame(f, 0, -h / 2 - border * 0.4, depth), 0, 0, 0.05, 0.008, `MFD ${index + 1}`, 'bezel', { color: 0, backlit: true });
  ctx.labelQuad(offsetFrame(f, w / 2 - 0.02, -h / 2 - border * 0.4 + 0.0085, depth), 0, 0, 0.03, 0.005, 'BRT', 'bezel', { color: 4, backlit: true });
  for (const [x, y] of [[-outerW + 0.006, outerH - 0.006], [outerW - 0.006, outerH - 0.006], [-outerW + 0.006, -outerH + 0.006], [outerW - 0.006, -outerH + 0.006]] as [number, number][]) {
    fastener(ctx, offsetFrame(f, x, y, depth), 0.55);
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
    fastener(ctx, offsetFrame(face, x, y, 0), 0.6);
  }
  ctx.labelQuad(face, -hs + 0.016, -hs + 0.006, 0.026, 0.006, 'FDAI', 'bezel', { color: 0, backlit: true });
  // Retaining ring of the cover glass: a machined ring standing off the bezel around the window, in the
  // matt black of instrument bezels (a satin ring this small mirrored the brightest thing in the cabin, a sun
  // patch or a window, as torn white flecks).
  b.lathe(face.o, f.n, [[holeR + 0.0055, 0], [holeR + 0.0055, 0.0022], [holeR + 0.0035, 0.0034], [holeR + 0.0008, 0.0034], [holeR, 0.002], [holeR, -0.003]], 64, ctx.m('matteBlack'), { ref: f.x });
  // Rate needles on the three outer scales (roll above, pitch at the right, yaw below): each slides along
  // its slot with the body rate about its axis, centred at rest.
  // (Each scale lies OUTSIDE the retaining ring, clear of it by two millimetres, on the flat of the bezel
  // between the ring and the bevel; its marks stand on its outer side. Round 6: the slots and the needles
  // lay half under the ring, which the penetration check now finds: webbing and overlays against the solid
  // parts of their own assembly.)
  const r0 = holeR + 0.0055 + 0.002 + 0.0028;
  const scales: { key: string; rate: number; out: [number, number]; along: [number, number] }[] = [
    { key: 'roll', rate: 1, out: [0, 1], along: [1, 0] },
    { key: 'pitch', rate: 0, out: [1, 0], along: [0, 1] },
    { key: 'yaw', rate: 2, out: [0, -1], along: [1, 0] },
  ];
  const travel = 0.016;
  for (const sc of scales) {
    const sf = offsetFrame(face, sc.out[0] * r0, sc.out[1] * r0, 0);
    const lx = sc.along[0] ? travel + 0.004 : 0.0028;
    const ly = sc.along[0] ? 0.0028 : travel + 0.004;
    // Slot (a dark recess printed with its scale), centre mark and end marks.
    b.box(offsetFrame(sf, 0, 0, 0.0002), lx, ly, 0.0002, 0.0001, ctx.m('cavity', { flags: FLAG_OVERLAY }));
    for (const t of [-1, -0.5, 0, 0.5, 1]) {
      const mx = sc.along[0] * t * travel;
      const my = sc.along[1] * t * travel;
      const side = t === 0 ? 0.003 : 0.0026;
      b.box(offsetFrame(sf, mx + sc.out[0] * side, my + sc.out[1] * side, 0.0003), sc.along[0] ? 0.0003 : 0.0012, sc.along[0] ? 0.0012 : 0.0003, 0.0002, 0.00005, ctx.m('pointer', { flags: FLAG_OVERLAY }));
    }
    const axis = localDir(face, sc.along[0], sc.along[1], 0);
    const c = ctx.control(`fdai:${sc.key}`, () => ({ kind: 'needle', pivot: sf.o, axis, binding: 'none', fixed: sc.rate, travel }));
    b.box(offsetFrame(sf, 0, 0, 0.0009), sc.along[0] ? 0.0006 : 0.0022, sc.along[0] ? 0.0022 : 0.0006, 0.0005, 0.0002, ctx.m('caution', { ctl: c.index }));
  }
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
    // Each lens cap stands 1 mm proud of the housing's face (16 mm): never coplanar with it.
    const lf = offsetFrame(f, -W / 2 + (c + 0.5) * cw, H / 2 - (r + 0.5) * chh, 0.017);
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
  const rect = ctx.label(lamp.label, hy * 2 * 0.95, hx * 2 * 0.95, { weight: 700, lens: true });
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
  // (Overlays: the mount hardware lies on the panel and does not bury the panel's baked occlusion.)
  const mount = ctx.m('steel', { flags: FLAG_OVERLAY });
  b.cylinder(local(f, 0, 0, 0), f.n, 0.0085, 0.0007, 20, mount, { caps: 'top' });
  b.box(offsetFrame(f, 0, 0.0095, 0.00035), 0.0016, 0.0022, 0.00035, 0.0001, mount);
  b.lathe(local(f, 0, 0, 0.0007), f.n, [[0.0072, 0], [0.0072, 0.0026], [0.0062, 0.0032], [0.0046, 0.0032]], 6, mount, { ref: f.x });
  b.cylinder(local(f, 0, 0, 0.0032), f.n, 0.0046, 0.0042, 16, ctx.m('steel', { flags: FLAG_EDGE | FLAG_OVERLAY }), { caps: 'top' });
  const pivot = local(f, 0, 0, 0.0074);
  // Lever along +n at rest; a rotation by +a about +x tips it toward -y, so "up" (position 0) is -throw.
  const c = ctx.control(key, () => ({ kind: 'toggle', pivot, axis: f.x, binding: sw.binding, angles: [-throwDeg * DEG, throwDeg * DEG], fixed: sw.fixed }));
  // Bat-handle lever: a tapered chrome shank swelling into a rounded tip.
  b.lathe(pivot, f.n, [[0.0, -0.0004], [0.0017, 0], [0.0019, 0.008], [0.0024, 0.017], [0.0031, 0.0215], [0.0029, 0.0235], [0.0018, 0.0248], [0.0, 0.0252]], 14, ctx.m('steel', { ctl: c.index }), { ref: f.x });
  const labelMat = panelMat;
  // Nomenclature: the switch's name on top, the position legends above and below the lever's throw (the
  // lower one beyond where the lever's tip lies over the panel when the crew look down on it).
  // One ink and one back-light for all nomenclature (name and positions), as on a real engraved panel.
  const ink = { color: panelMat === 'panel' ? 0 : 1, backlit: panelMat === 'panel' };
  ctx.labelQuad(f, 0, 0.0275, 0.036, 0.0062, sw.label, labelMat, ink);
  if (sw.up) ctx.labelQuad(f, 0, 0.0175, 0.03, 0.0048, sw.up, labelMat, ink);
  if (sw.down) ctx.labelQuad(f, 0, -0.0345, 0.03, 0.0048, sw.down, labelMat, ink);
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
    ctx.labelQuad(f, -Math.sin(a) * r, Math.cos(a) * r, 0.02, 0.0045, p, 'panel', { color: 0, backlit: true });
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
