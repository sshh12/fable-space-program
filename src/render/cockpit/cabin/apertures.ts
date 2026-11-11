/**
 * Openings of the cabin: window bezels with multi-pane glazing and roller shades at the shared window
 * outlines, the side hatch (plug door with latch linkage, gearbox, handle, hinges, pressure-equalisation
 * valve and its round window) and the docking hatch at the apex tunnel.
 *
 * Every frame starts at the INNER outline of its opening (the shared outline carried inward through the
 * wall) and grows into the cabin along the opening's inward normal, so it lines up with the exterior cut.
 */
import { v3, type Vec3 } from '@/core/math';
import { FLAG_EDGE, frameAt, local, offsetFrame, type Attr, type Frame } from '../mesh';
import { conePointAt, openingFrame, openingsOf, radialDir, revPoint, type Opening } from '../mould';
import { FLAG_ENCLOSURE, type ApertureMeta, type CabinContext, type PaneMeta } from './context';

type Loop = [number, number][];

/** Offset a closed (u, v) outline along its outward normals by d (exact for rounded rectangles and circles). */
export function offsetLoop(loop: Loop, d: number): Loop {
  const n = loop.length;
  return loop.map((p, i) => {
    const a = loop[(i - 1 + n) % n]!;
    const b = loop[(i + 1) % n]!;
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    // Counter-clockwise loop: the outward normal is the tangent turned clockwise.
    return [p[0] + (ty / l) * d, p[1] - (tx / l) * d];
  });
}

interface OpeningGeom {
  o: Opening;
  frame: { t: Vec3; g: Vec3; n: Vec3; centreOuter: Vec3; centreInner: Vec3 };
  /** Into the cabin (= -outward normal at the centre). */
  inward: Vec3;
  /** Point on the inner wall at outline coordinates (u, v), pushed `depth` into the cabin along `inward`. */
  at(u: number, v: number, depth: number): Vec3;
  /** Pane plane frame at a depth (x = t, y = g, n = inward). */
  plane(depth: number): Frame;
}

function geomOf(ctx: CabinContext, o: Opening): OpeningGeom {
  const m = ctx.mould;
  const frame = openingFrame(m, o.azDeg, o.y);
  const inward = v3.neg(frame.n);
  return {
    o,
    frame,
    inward,
    at: (u, v, depth) => v3.addScaled(conePointAt(m, o.azDeg, o.y, u, v, m.wall), inward, depth),
    plane: (depth) => ({ o: v3.addScaled(frame.centreInner, inward, depth), x: frame.t, y: frame.g, n: inward }),
  };
}

/** Ring of quads between two loops of equal length (points given directly). */
function ringBetween(ctx: CabinContext, a: Vec3[], b: Vec3[], attr: Attr, normal: (i: number) => Vec3, tangent: (i: number) => Vec3): void {
  const bld = ctx.b;
  const n = a.length;
  const base = bld.vertexCount;
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    if (i > 0) s += v3.dist(a[k]!, a[(i - 1) % n]!);
    bld.vertex(a[k]!, normal(k), tangent(k), [s, 0], attr);
    bld.vertex(b[k]!, normal(k), tangent(k), [s, v3.dist(a[k]!, b[k]!)], attr);
  }
  for (let i = 0; i < n; i++) {
    const q = base + i * 2;
    bld.quad(q, q + 2, q + 3, q + 1);
  }
}

/** Loop points in 3-D at depth (per point) from the inner wall. */
const loop3 = (g: OpeningGeom, loop: Loop, depth: number | ((i: number) => number)): Vec3[] => loop.map(([u, v], i) => g.at(u, v, typeof depth === 'number' ? depth : depth(i)));

/** Depths that make a loop planar at `planeDepth` from the opening centre along the inward normal. */
const planarDepths = (g: OpeningGeom, loop: Loop, planeDepth: number): ((i: number) => number) => {
  const base = loop.map(([u, v]) => v3.dot(v3.sub(g.at(u, v, 0), g.frame.centreInner), g.inward));
  return (i) => planeDepth - base[i]!;
};

function tangentOf(points: Vec3[]): (i: number) => Vec3 {
  return (i) => v3.normalize(v3.sub(points[(i + 1) % points.length]!, points[(i - 1 + points.length) % points.length]!));
}

/**
 * Bezel around an opening: tunnel wall, chamfered front face, outer side. Returns the panes it holds and
 * the depth of its inner edge's plane (from the inner wall's centre along the inward normal). The bezel
 * belongs to the enclosure: the sun sees it as the window's aperture (WindowMeta.aperture).
 */
function bezel(ctx: CabinContext, g: OpeningGeom, base: Loop, width: number, depth: number, mat: string, paneDepths: number[]): { panes: PaneMeta[]; edgeDepth: number } {
  const ch = Math.min(0.004, width * 0.2);
  const planar = (d: number): ((i: number) => number) => planarDepths(g, base, d);
  const a0 = loop3(g, base, 0);
  const a1 = loop3(g, base, planar(depth - ch));
  const l1 = offsetLoop(base, ch);
  const l2 = offsetLoop(base, width - ch);
  const l3 = offsetLoop(base, width);
  const a1c = loop3(g, l1, planarDepths(g, l1, depth));
  const b1c = loop3(g, l2, planarDepths(g, l2, depth));
  const b1 = loop3(g, l3, planarDepths(g, l3, depth - ch));
  const b0 = loop3(g, l3, 0);
  const attr = ctx.m(mat, { flags: FLAG_ENCLOSURE });
  const toCentre = (pts: Vec3[]) => (i: number): Vec3 => v3.normalize(v3.reject(v3.sub(g.frame.centreInner, pts[i]!), g.inward));
  const fromCentre = (pts: Vec3[]) => (i: number): Vec3 => v3.neg(toCentre(pts)(i));
  ringBetween(ctx, a0, a1, ctx.m(mat, { ao: 0.75, flags: FLAG_ENCLOSURE }), toCentre(a0), tangentOf(a0));
  ringBetween(ctx, a1, a1c, { ...attr, flags: FLAG_ENCLOSURE | FLAG_EDGE }, (i) => v3.normalize(v3.add(toCentre(a1)(i), g.inward)), tangentOf(a1));
  ringBetween(ctx, a1c, b1c, attr, () => g.inward, tangentOf(a1c));
  ringBetween(ctx, b1c, b1, { ...attr, flags: FLAG_ENCLOSURE | FLAG_EDGE }, (i) => v3.normalize(v3.add(fromCentre(b1)(i), g.inward)), tangentOf(b1c));
  ringBetween(ctx, b1, b0, ctx.m(mat, { ao: 0.8, flags: FLAG_ENCLOSURE }), fromCentre(b1), tangentOf(b1));
  // Panes and their seals: a dark gasket ring where each pane meets the tunnel wall. Pane depths count from
  // the most inward point of the outline (the wall is concave seen from the cabin, so a planar pane must
  // clear the sagitta of the curved opening).
  const sagitta = Math.max(0, ...base.map(([u, v]) => v3.dot(v3.sub(g.at(u, v, 0), g.frame.centreInner), g.inward)));
  const panes: PaneMeta[] = [];
  for (const pd0 of paneDepths) {
    const pd = pd0 + sagitta;
    const outline = loop3(g, base, planar(pd));
    panes.push({ frame: g.plane(pd), outline, depth: pd });
    if (ctx.detail === 0) {
      const inner = loop3(g, offsetLoop(base, -0.006), planarDepths(g, offsetLoop(base, -0.006), pd + 0.0015));
      ringBetween(ctx, outline.map((p) => v3.addScaled(p, g.inward, 0.0015)), inner, ctx.m('rubber', { flags: FLAG_ENCLOSURE }), () => g.inward, tangentOf(outline));
    }
  }
  return { panes, edgeDepth: depth - ch };
}

/** The window's aperture for the sun: the shared outline as a prism from the outer mould line to the bezel edge. */
function apertureOf(ctx: CabinContext, g: OpeningGeom, o: Opening, edgeDepth: number): ApertureMeta {
  // The outer outline is curved (it lies on the cone): its prism end is the mean plane of its points.
  const pts = o.outline(64).map(([u, v]) => conePointAt(ctx.mould, o.azDeg, o.y, u, v, 0));
  const sag = pts.reduce((s, p) => s + v3.dot(v3.sub(p, g.frame.centreOuter), g.inward), 0) / pts.length;
  return {
    centre: v3.addScaled(g.frame.centreOuter, g.inward, sag),
    inward: g.inward,
    t: g.frame.t,
    g: g.frame.g,
    hw: o.width / 2,
    hh: o.height / 2,
    rc: o.cornerRadius,
    innerDepth: ctx.mould.wall + edgeDepth - sag,
  };
}

/** Polygon area of a planar loop (part frame). */
function loopArea(pts: Vec3[]): number {
  let s = v3.zero();
  for (let i = 0; i < pts.length; i++) s = v3.add(s, v3.cross(pts[i]!, pts[(i + 1) % pts.length]!));
  return v3.len(s) / 2;
}

export function buildWindows(ctx: CabinContext): void {
  const w = ctx.layout.windows;
  const count = ctx.detail === 0 ? 64 : 24;
  for (const o of openingsOf(ctx.mould).filter((x) => x.kind === 'window')) {
    const g = geomOf(ctx, o);
    const base = o.outline(count);
    const { panes, edgeDepth } = bezel(ctx, g, base, w.bezelWidth, w.bezelDepth, 'bezel', ctx.detail === 2 ? [w.panes[w.panes.length - 1]!] : w.panes);
    if (ctx.detail === 0) {
      const outline = loop3(g, base, planarDepths(g, base, w.panes[w.panes.length - 1]!));
      ctx.windows.push({ id: o.id, kind: 'window', outline: loop3(g, base, 0), centre: g.frame.centreInner, inward: g.inward, area: loopArea(outline), panes, aperture: apertureOf(ctx, g, o, edgeDepth) });
      shade(ctx, g, o, w.shades[o.id] ?? 0);
      // Bezel fasteners and a window placard.
      const f = g.plane(w.bezelDepth);
      const steel = ctx.m('steel');
      const hw = o.width / 2 + w.bezelWidth / 2;
      const hh = o.height / 2 + w.bezelWidth / 2;
      for (const [u, v] of [[-hw, -hh * 0.6], [hw, -hh * 0.6], [-hw, hh * 0.6], [hw, hh * 0.6], [-hw * 0.5, hh], [hw * 0.5, hh]] as [number, number][]) {
        ctx.b.cylinder(local(f, u, v, -0.0005), f.n, 0.0035, 0.0015, 8, steel, { caps: 'top' });
      }
      ctx.labelQuad(f, 0, -(o.height / 2 + w.bezelWidth * 0.55), 0.08, 0.009, o.id.toUpperCase().replace('-', ' '), 'bezel', { color: 0, backlit: true, lift: 0.0005 });
    }
  }
}

/**
 * Roller shade: cassette along the apex-side (+v) edge (clear of the crew's oblique line of sight, which
 * comes from the aft side), guide rails, pull bar; the fabric covers `extension` of the window.
 */
function shade(ctx: CabinContext, g: OpeningGeom, o: Opening, extension: number): void {
  const w = ctx.layout.windows;
  const f = g.plane(w.bezelDepth);
  const hw = o.width / 2 + w.bezelWidth * 0.55;
  const v0 = o.height / 2 + w.bezelWidth * 0.35;
  const cassette = offsetFrame(f, 0, v0, 0.011);
  ctx.b.box(cassette, hw, 0.011, 0.011, 0.004, ctx.m('closeout'));
  for (const s of [-1, 1]) {
    const rail = offsetFrame(f, s * (o.width / 2 + w.bezelWidth * 0.5), 0, 0.004);
    ctx.b.box(rail, 0.004, o.height / 2, 0.004, 0.001, ctx.m('aluminium'));
  }
  const ext = Math.max(0, Math.min(1, extension));
  const vBar = v0 - 0.012 - ext * (o.height + w.bezelWidth * 0.3);
  ctx.b.box(offsetFrame(f, 0, vBar, 0.009), o.width / 2 + 0.003, 0.006, 0.005, 0.002, ctx.m('aluminium'));
  ctx.b.box(offsetFrame(f, 0, vBar - 0.012, 0.012), 0.022, 0.006, 0.004, 0.002, ctx.m('webbingOrange'));
  if (ext > 0.02) {
    const fabric = ctx.m('shade');
    const p = (u: number, v: number): Vec3 => local(f, u, v, 0.006);
    ctx.b.flatQuad(p(-o.width / 2, vBar), p(o.width / 2, vBar), p(o.width / 2, v0 - 0.012), p(-o.width / 2, v0 - 0.012), fabric);
  }
}

export function buildHatch(ctx: CabinContext): void {
  const m = ctx.mould;
  const h = ctx.layout.hatch;
  const openings = openingsOf(m);
  const hatch = openings.find((x) => x.kind === 'hatch')!;
  const win = openings.find((x) => x.kind === 'hatchWindow')!;
  const g = geomOf(ctx, hatch);
  const count = ctx.detail === 0 ? 72 : 28;
  const base = hatch.outline(count);
  const b = ctx.b;
  const T = h.thickness;
  // ---- frame on the wall around the opening: seal land and a dark seal
  const seal = ctx.m('rubber');
  const ring0 = loop3(g, base, 0);
  const ringSeal = loop3(g, offsetLoop(base, 0.014), 0.004);
  ringBetween(ctx, ring0, ringSeal, seal, () => g.inward, tangentOf(ring0));
  const land = loop3(g, offsetLoop(base, 0.05), 0.006);
  ringBetween(ctx, ringSeal, land, ctx.m('aluminium'), () => g.inward, tangentOf(ringSeal));
  ringBetween(ctx, land, loop3(g, offsetLoop(base, 0.056), 0), ctx.m('aluminium', { ao: 0.8 }), (i) => v3.normalize(v3.reject(v3.sub(land[i]!, g.frame.centreInner), g.inward)), tangentOf(land));

  // ---- door: edge wall from the opening outline (inset by the seal gap) to a planar inner face at depth T
  const doorLoop = offsetLoop(base, -0.004);
  const edge0 = loop3(g, doorLoop, 0.002);
  const edge1 = loop3(g, doorLoop, planarDepths(g, doorLoop, T - 0.006));
  const toC = (pts: Vec3[]) => (i: number): Vec3 => v3.normalize(v3.reject(v3.sub(pts[i]!, g.frame.centreInner), g.inward));
  const doorMat = ctx.m('hatch');
  ringBetween(ctx, edge0, edge1, doorMat, toC(edge0), tangentOf(edge0));
  const rimOuter = loop3(g, offsetLoop(doorLoop, -0.006), planarDepths(g, offsetLoop(doorLoop, -0.006), T));
  ringBetween(ctx, edge1, rimOuter, doorMat, (i) => v3.normalize(v3.add(toC(edge1)(i), g.inward)), tangentOf(edge1));
  const face = g.plane(T);
  const rimW = 0.05;
  const rimInner = loop3(g, offsetLoop(doorLoop, -rimW), planarDepths(g, offsetLoop(doorLoop, -rimW), T));
  ringBetween(ctx, rimOuter, rimInner, doorMat, () => g.inward, tangentOf(rimOuter));
  // Recessed pocket floor and its wall.
  const pocket = 0.022;
  const pocketWall = loop3(g, offsetLoop(doorLoop, -rimW), planarDepths(g, offsetLoop(doorLoop, -rimW), T - pocket));
  ringBetween(ctx, rimInner, pocketWall, ctx.m('hatch', { ao: 0.8 }), (i) => v3.neg(toC(rimInner)(i)), tangentOf(rimInner));
  // Pocket floor with the window opening.
  const wr = win.width / 2;
  const holeLoop: Loop = [];
  const pocketLoop = offsetLoop(doorLoop, -rimW);
  for (let i = 0; i < pocketLoop.length; i++) {
    const [u, v] = pocketLoop[i]!;
    const a = Math.atan2(v, u);
    holeLoop.push([Math.cos(a) * (wr + 0.035), Math.sin(a) * (wr + 0.035)]);
  }
  const floorF = g.plane(T - pocket);
  ringBetween(ctx, pocketLoop.map(([u, v]) => local(floorF, u, v)), holeLoop.map(([u, v]) => local(floorF, u, v)), ctx.m('hatch', { ao: 0.7 }), () => g.inward, (i) => v3.normalize(localDirOf(floorF, -pocketLoop[i]![1], pocketLoop[i]![0])));

  // ---- window through the door: tunnel from the wall to the pocket floor, bezel ring, panes
  const wg = geomOf(ctx, win);
  const wLoop = win.outline(count);
  const wPanes = ctx.layout.windows.panes.map((d) => Math.min(d, T - pocket - 0.004));
  const { panes, edgeDepth } = bezel(ctx, wg, wLoop, 0.035, T - pocket + 0.012, 'bezel', ctx.detail === 2 ? [wPanes[wPanes.length - 1]!] : wPanes);
  if (ctx.detail === 0) {
    const outline = loop3(wg, wLoop, planarDepths(wg, wLoop, wPanes[wPanes.length - 1]!));
    ctx.windows.push({ id: 'hatch-window', kind: 'hatchWindow', outline: loop3(wg, wLoop, 0), centre: wg.frame.centreInner, inward: wg.inward, area: loopArea(outline), panes, aperture: apertureOf(ctx, wg, win, edgeDepth) });
  }
  if (ctx.detail === 2) return;

  // ---- rib grid in the pocket (around the window), gearbox, handle, latches and linkage, hinges, valve
  const hw = hatch.width / 2 - rimW - 0.01;
  const hh = hatch.height / 2 - rimW - 0.01;
  const ribH = pocket - 0.003;
  const ribs = ctx.m('hatch', { ao: 0.85 });
  for (const u of [-hw * 0.5, hw * 0.5]) {
    for (const [v0, v1] of [[-hh, -(wr + 0.04)], [wr + 0.04, hh]] as [number, number][]) {
      b.box(offsetFrame(floorF, u, (v0 + v1) / 2, ribH / 2), 0.004, (v1 - v0) / 2, ribH / 2, 0.001, ribs);
    }
  }
  for (const v of [-hh * 0.55, hh * 0.55]) {
    for (const [u0, u1] of [[-hw, -(wr + 0.04)], [wr + 0.04, hw]] as [number, number][]) {
      b.box(offsetFrame(floorF, (u0 + u1) / 2, v, ribH / 2), (u1 - u0) / 2, 0.004, ribH / 2, 0.001, ribs);
    }
  }
  if (ctx.detail > 0) return;
  // Gearbox below the window (toward the floor), handle on its shaft.
  const side = h.handleSide;
  const gbF = offsetFrame(face, 0, -hh * 0.62, 0.02);
  b.box(gbF, 0.085, 0.05, 0.022, 0.006, ctx.m('anodized'));
  const shaft = local(gbF, 0, 0, 0.022);
  b.cylinder(shaft, face.n, 0.022, 0.012, 20, ctx.m('steel'));
  const handleEnd = local(gbF, side * 0.2, 0.05, 0.034);
  b.tube([local(gbF, 0, 0, 0.03), v3.lerp(local(gbF, 0, 0, 0.03), handleEnd, 0.5), handleEnd], 0.011, 10, ctx.m('caution'), { caps: true });
  b.cylinder(v3.addScaled(handleEnd, face.n, -0.005), face.n, 0.016, 0.1, 14, ctx.m('rubber'), { caps: 'both' });
  ctx.labelQuad(gbF, 0, -0.068, 0.15, 0.014, 'HATCH  ◄ OPEN   CLOSE ►', 'hatch', { color: 1 });
  ctx.labelQuad(offsetFrame(face, 0, hh * 0.85, 0), 0, 0, 0.26, 0.016, 'SIDE HATCH  ·  EQUALIZE BEFORE OPENING', 'hatch', { color: 1, style: { box: true } });
  // Latches around the edge and rods to the gearbox.
  const latches = h.latches;
  const steel = ctx.m('steel');
  for (let i = 0; i < latches; i++) {
    const k = Math.round((i / latches) * doorLoop.length) % doorLoop.length;
    const [u, v] = offsetLoop(doorLoop, -0.03)[k]!;
    const lf = frameAt(local(face, u, v, 0.008), v3.normalize(localDirOf(face, u, v)), v3.normalize(localDirOf(face, -v, u)));
    b.box(lf, 0.016, 0.012, 0.008, 0.002, ctx.m('anodized'));
    if (Math.abs(v) < hh * 0.9 || Math.abs(u) < hw * 0.9) {
      const from = local(gbF, 0, 0, 0.012);
      const to = local(face, u * 0.92, v * 0.92, 0.012);
      b.tube([from, v3.lerp(from, to, 0.5), to], 0.0035, 6, steel);
    }
  }
  // Hinges on the +u side.
  for (const v of [-hh * 0.6, hh * 0.6]) {
    const p = g.at(-side * (hatch.width / 2 + 0.03), v, 0.026);
    b.cylinder(v3.addScaled(p, g.frame.g, -0.05), g.frame.g, 0.018, 0.1, 16, ctx.m('aluminium'));
  }
  // Pressure-equalisation valve.
  const pev = offsetFrame(face, -side * hw * 0.7, hh * 0.55, 0);
  b.cylinder(local(pev, 0, 0, 0), face.n, 0.025, 0.018, 18, ctx.m('anodized'));
  b.box(offsetFrame(pev, 0, 0, 0.024), 0.035, 0.007, 0.006, 0.002, ctx.m('warning'));
  ctx.labelQuad(pev, 0, -0.04, 0.06, 0.01, 'PEV', 'hatch', { color: 1 });
  // Counterbalance strut from the frame to the door.
  const s0 = g.at(-side * (hatch.width / 2 + 0.06), -hatch.height * 0.3, 0.015);
  const s1 = local(face, -side * hw * 0.85, -hh * 0.2, 0.01);
  b.cylinder(s0, v3.sub(s1, s0), 0.012, v3.dist(s0, s1) * 0.55, 12, ctx.m('anodized'));
  b.cylinder(v3.lerp(s0, s1, 0.5), v3.sub(s1, s0), 0.006, v3.dist(s0, s1) * 0.5, 10, ctx.m('steel'));
}

const localDirOf = (f: Frame, a: number, b: number): Vec3 => v3.add(v3.scale(f.x, a), v3.scale(f.y, b));

/**
 * Shadow-only geometry for the core's cascades: every window opening closed at the inner wall (the PLUGS),
 * so that the core's sun never lights the cabin, which the cockpit lights itself (never drawn shaded).
 */
export function buildPlugs(ctx: CabinContext): void {
  const m = ctx.mould;
  const b = ctx.b;
  const attr = ctx.m('bezel');
  for (const o of openingsOf(m).filter((x) => x.kind !== 'hatch')) {
    const g = geomOf(ctx, o);
    const loop = loop3(g, o.outline(96), 0);
    b.part();
    const c = b.vertex(g.frame.centreInner, g.inward, g.frame.t, [0, 0], attr);
    const first = b.vertexCount;
    for (const p of loop) b.vertex(p, g.inward, g.frame.t, [0, 0], attr);
    for (let i = 0; i < loop.length; i++) b.tri(c, first + i, first + ((i + 1) % loop.length));
  }
}

export function buildDockingHatch(ctx: CabinContext): void {
  const m = ctx.mould;
  const y = ctx.layout.hatch.dockingHatchY;
  const r = m.tunnelInnerRadius;
  const b = ctx.b;
  const down = { x: 0, y: -1, z: 0 };
  const face = frameAt({ x: 0, y: y - 0.03, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  // frameAt(x, y) gives n = x cross y = -Y: the face looks down into the cabin.
  const sides = ctx.detail === 0 ? 64 : 24;
  b.disc(face, r - 0.004, 0.0, sides, ctx.m('hatch'));
  b.cylinder({ x: 0, y: y - 0.03, z: 0 }, { x: 0, y: 1, z: 0 }, r - 0.004, 0.03, sides, ctx.m('hatch', { ao: 0.8 }), { caps: 'none' });
  // Tunnel ring frame at the cone joint.
  b.lathe({ x: 0, y: m.tunnelJoinY, z: 0 }, { x: 0, y: 1, z: 0 }, [[r + 0.001, -0.02], [r - 0.03, -0.02], [r - 0.03, 0.02], [r + 0.001, 0.02]], sides, ctx.m('aluminium', { ao: 0.85 }));
  if (ctx.detail > 0) return;
  // Hub, crank handle and latch dogs.
  const hub = offsetFrame(face, 0, 0, 0);
  b.cylinder({ x: 0, y: y - 0.03, z: 0 }, down, 0.06, 0.035, 28, ctx.m('anodized'));
  b.cylinder({ x: 0, y: y - 0.065, z: 0 }, down, 0.022, 0.03, 18, ctx.m('steel'));
  const grip = { x: 0.2, y: y - 0.085, z: 0 };
  b.tube([{ x: 0, y: y - 0.085, z: 0 }, grip], 0.012, 10, ctx.m('caution'), { caps: true });
  b.cylinder(grip, down, 0.017, 0.09, 14, ctx.m('rubber'));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 2 * Math.PI + 0.3;
    const p = revPoint(r - 0.045, y - 0.038, a);
    const f = frameAt(p, radialDir(a), { x: Math.cos(a), y: 0, z: -Math.sin(a) });
    b.box(f, 0.022, 0.014, 0.008, 0.002, ctx.m('aluminium'));
    b.tube([{ x: 0, y: y - 0.05, z: 0 }, revPoint(r - 0.07, y - 0.048, a)], 0.004, 6, ctx.m('steel'));
  }
  ctx.labelQuad(offsetFrame(hub, 0, -0.18, 0), 0, 0, 0.22, 0.015, 'DOCKING HATCH · PEV FIRST', 'hatch', { color: 1, style: { box: true } });
}
