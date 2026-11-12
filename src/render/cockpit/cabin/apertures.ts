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
 * the depth of its inner edge's plane (from the inner wall's centre along the inward normal). The bezel's
 * tunnel belongs to the enclosure: the sun sees it as the window's aperture (WindowMeta.aperture). Its face
 * and its outer side stand proud of the wall and cast into the cabin's sun map: a sun that grazes the wall
 * beside the window is stopped by them.
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
  const proud = ctx.m(mat);
  ringBetween(ctx, a1c, b1c, proud, () => g.inward, tangentOf(a1c));
  ringBetween(ctx, b1c, b1, { ...proud, flags: FLAG_EDGE }, (i) => v3.normalize(v3.add(fromCentre(b1)(i), g.inward)), tangentOf(b1c));
  ringBetween(ctx, b1, b0, ctx.m(mat, { ao: 0.8 }), fromCentre(b1), tangentOf(b1));
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
  const count = ctx.detail === 0 ? 128 : 32;
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
  // Guide rails from under the cassette to a foot block on the bezel's lower edge (no rail ends in the air).
  const railTop = v0 - 0.011;
  const railBottom = -(o.height / 2 + w.bezelWidth * 0.3);
  for (const s of [-1, 1]) {
    const u = s * (o.width / 2 + w.bezelWidth * 0.5);
    ctx.b.box(offsetFrame(f, u, (railTop + railBottom) / 2, 0.004), 0.004, (railTop - railBottom) / 2, 0.004, 0.001, ctx.m('aluminium'));
    ctx.b.box(offsetFrame(f, u, railBottom - 0.004, 0.005), 0.008, 0.006, 0.005, 0.0015, ctx.m('closeout'));
    ctx.b.cylinder(local(f, u, railBottom - 0.004, 0.0095), f.n, 0.0025, 0.0012, 8, ctx.m('steel'), { caps: 'top' });
  }
  const ext = Math.max(0, Math.min(1, extension));
  const vBar = v0 - 0.012 - ext * (o.height + w.bezelWidth * 0.3);
  ctx.b.box(offsetFrame(f, 0, vBar, 0.009), o.width / 2 + 0.003, 0.006, 0.005, 0.002, ctx.m('aluminium'));
  // The pull tab: a loop of flat webbing sewn round the bar, hanging a thumb's length below it.
  {
    const tab = ctx.m('webbingOrange');
    const half = 0.011;
    const drop = 0.03;
    const loop: Vec3[] = [];
    for (let k = 0; k <= 12; k++) {
      const t = k / 12;
      // Down the front of the bar, round the end of the loop, back up behind.
      const a = Math.PI * t;
      loop.push(local(f, 0, vBar - 0.006 - drop * Math.sin(a) * (0.6 + 0.4 * Math.sin(a)), 0.0145 + 0.0035 * Math.cos(a)));
    }
    ctx.b.surface(1, loop.length - 1, (i, j) => {
      const p = loop[j]!;
      return { p: v3.addScaled(p, f.x, (i - 0.5) * 2 * half), uv: [i * 2 * half, j * (drop * 2) / (loop.length - 1)] };
    }, tab);
  }
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
  const count = ctx.detail === 0 ? 128 : 32;
  const base = hatch.outline(count);
  const b = ctx.b;
  const T = h.thickness;
  // ---- frame on the wall around the opening: seal land and a dark seal
  const seal = ctx.m('rubber');
  const ring0 = loop3(g, base, 0);
  const ringSeal = loop3(g, offsetLoop(base, 0.014), 0.004);
  ringBetween(ctx, ring0, ringSeal, seal, () => g.inward, tangentOf(ring0));
  const land = loop3(g, offsetLoop(base, 0.05), 0.006);
  // The seal land: a machined, painted flange (a satin surface: it must not read as a slit of light).
  ringBetween(ctx, ringSeal, land, ctx.m('hatch'), () => g.inward, tangentOf(ringSeal));
  ringBetween(ctx, land, loop3(g, offsetLoop(base, 0.056), 0), ctx.m('hatch', { ao: 0.8 }), (i) => v3.normalize(v3.reject(v3.sub(land[i]!, g.frame.centreInner), g.inward)), tangentOf(land));

  // ---- door: edge wall from the opening outline (inset by the seal gap) to a planar inner face at depth T
  const doorLoop = offsetLoop(base, -0.004);
  const edge0 = loop3(g, doorLoop, 0.002);
  const edge1 = loop3(g, doorLoop, planarDepths(g, doorLoop, T - 0.006));
  const toC = (pts: Vec3[]) => (i: number): Vec3 => v3.normalize(v3.reject(v3.sub(pts[i]!, g.frame.centreInner), g.inward));
  const doorMat = ctx.m('hatch');
  ringBetween(ctx, edge0, edge1, doorMat, toC(edge0), tangentOf(edge0));
  // The door's seal: a rubber bulb between its edge and the frame's land. Nothing of the outside shows
  // around the door, and the closed shell the sun cascades see has no slit.
  const bulbTop = loop3(g, offsetLoop(base, -0.002), 0.0055);
  const bulb = ctx.m('seal', { ao: 0.7 });
  ringBetween(ctx, edge0.map((p) => v3.addScaled(p, g.inward, 0.002)), bulbTop, bulb, (i) => v3.normalize(v3.add(g.inward, toC(edge0)(i))), tangentOf(edge0));
  // (The bulb ends half a millimetre inside the frame's rubber seal, which rises 4 mm over its 14 mm width:
  // no slit between them.)
  ringBetween(ctx, bulbTop, loop3(g, offsetLoop(base, 0.003), 0.0004), bulb, (i) => v3.normalize(v3.add(g.inward, toC(edge0)(i))), tangentOf(edge0));
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
  // In rings a few centimetres apart (the light baked per vertex then falls off smoothly over the floor, not
  // in streaks along long radial quads).
  const floorRings = ctx.detail === 0 ? 12 : 1;
  for (let k = 0; k < floorRings; k++) {
    const ring = (t: number): Vec3[] => pocketLoop.map(([u, v], i) => local(floorF, u + (holeLoop[i]![0] - u) * t, v + (holeLoop[i]![1] - v) * t));
    ringBetween(ctx, ring(k / floorRings), ring((k + 1) / floorRings), ctx.m('hatch', { ao: 0.7 }), () => g.inward, (i) => v3.normalize(localDirOf(floorF, -pocketLoop[i]![1], pocketLoop[i]![0])));
  }
  // The door's outer skin, half a millimetre inside the wall: from under the frame's seal to under the
  // window's bezel. The door is a closed body, so no joint of its inner side (the seal round its edge, the
  // pocket floor against the window's bezel) can open a slit onto the outside.
  const skinLoop = offsetLoop(base, 0.005);
  const skinHole: Loop = skinLoop.map(([u, v]) => {
    const a = Math.atan2(v, u);
    return [Math.cos(a) * (wr + 0.02), Math.sin(a) * (wr + 0.02)];
  });
  ringBetween(ctx, loop3(g, skinLoop, 0.0005), loop3(g, skinHole, 0.0005), ctx.m('hatch', { ao: 0.3 }), () => g.inward, tangentOf(loop3(g, skinLoop, 0.0005)));

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
  // Gearbox below the window (toward the floor): a ribbed housing with a cover plate, and the pump handle
  // on its shaft: a forged arm with a hub, cranked away from the door, and a grip.
  const side = h.handleSide;
  const gbF = offsetFrame(face, 0, -hh * 0.62, 0.02);
  b.box(gbF, 0.085, 0.05, 0.022, 0.006, ctx.m('anodized'));
  b.box(offsetFrame(gbF, 0, 0, 0.0235), 0.07, 0.036, 0.0015, 0.001, ctx.m('hatch'));
  for (const [x, y] of [[-0.06, -0.028], [0.06, -0.028], [-0.06, 0.028], [0.06, 0.028]] as [number, number][]) b.cylinder(local(gbF, x, y, 0.025), face.n, 0.004, 0.003, 6, ctx.m('steel'), { caps: 'top' });
  const shaft = local(gbF, 0, 0, 0.022);
  b.cylinder(shaft, face.n, 0.024, 0.014, 24, ctx.m('steel'), { caps: 'top' });
  b.lathe(local(gbF, 0, 0, 0.036), face.n, [[0.019, 0], [0.019, 0.01], [0.015, 0.014], [0, 0.0145]], 20, ctx.m('caution', { flags: FLAG_EDGE }));
  const armDir = v3.normalize(localDirOf(gbF, side * 0.2, 0.05));
  const armF = frameAt(local(gbF, 0, 0, 0.041), armDir, v3.cross(face.n, armDir));
  const armLen = Math.hypot(0.2, 0.05);
  b.box(offsetFrame(armF, armLen * 0.5, 0, 0), armLen * 0.5, 0.011, 0.0045, 0.002, ctx.m('caution'));
  const handleEnd = local(armF, armLen, 0, 0);
  b.cylinder(v3.addScaled(handleEnd, face.n, -0.004), face.n, 0.009, 0.022, 12, ctx.m('steel'), { caps: 'both' });
  b.lathe(v3.addScaled(handleEnd, face.n, 0.016), face.n, [[0.0, 0], [0.014, 0.002], [0.0165, 0.012], [0.0165, 0.078], [0.019, 0.084], [0.019, 0.09], [0.012, 0.096], [0, 0.097]], 16, ctx.m('rubber'));
  ctx.labelQuad(gbF, 0, -0.068, 0.15, 0.014, 'HATCH  ◄ OPEN   CLOSE ►', 'hatch', { color: 1 });
  ctx.labelQuad(offsetFrame(face, 0, hh * 0.85, 0), 0, 0, 0.26, 0.016, 'SIDE HATCH  ·  EQUALIZE BEFORE OPENING', 'hatch', { color: 1, style: { box: true } });
  // The latch drive: one rod running round the door inside the rim (in the pocket, clear of the window),
  // carried in guide blocks; the gearbox turns it through a crank link. Every latch sits on the rim over
  // the rod: a housing with a bellcrank link down to the rod and a hook that reaches over the door's edge
  // onto a striker post standing on the frame.
  const latches = h.latches;
  // (Satin, bead-blasted steel: a polished rod this thin mirrors the window as a line of light.)
  const steel = ctx.m('satinSteel');
  const rodLoop = offsetLoop(doorLoop, -(rimW + 0.022));
  const rodH = T - pocket + 0.012;
  const rodPts = rodLoop.map(([u, v]) => local(g.plane(rodH), u, v));
  b.tube([...rodPts, rodPts[0]!, rodPts[1]!], 0.0042, 12, steel);
  const guides = Math.max(8, Math.round(rodLoop.length / 9));
  for (let i = 0; i < guides; i++) {
    const k = Math.round(((i + 0.5) / guides) * rodLoop.length) % rodLoop.length;
    const [u, v] = rodLoop[k]!;
    const [u1, v1] = rodLoop[(k + 1) % rodLoop.length]!;
    const gf = frameAt(local(g.plane(T - pocket), u, v, 0.008), v3.normalize(localDirOf(face, u1 - u, v1 - v)), v3.normalize(localDirOf(face, -(v1 - v), u1 - u)));
    b.box(gf, 0.009, 0.011, 0.008, 0.002, ctx.m('anodized'));
  }
  // Crank link from the gearbox to the rod.
  {
    const from = local(gbF, -side * 0.06, -0.03, 0.0);
    const [u, v] = rodLoop.reduce((best, p) => (Math.hypot(p[0] - -side * 0.06, p[1] - (-hh * 0.62 - 0.07)) < Math.hypot(best[0] - -side * 0.06, best[1] - (-hh * 0.62 - 0.07)) ? p : best));
    b.tube([from, local(g.plane(rodH), u, v)], 0.005, 8, steel, { caps: true });
  }
  const rimLoop = offsetLoop(doorLoop, -0.026);
  const outerLoop = offsetLoop(base, 0.03);
  for (let i = 0; i < latches; i++) {
    const k = Math.round(((i + 0.5) / latches) * doorLoop.length) % doorLoop.length;
    const [u, v] = rimLoop[k]!;
    const [un, vn] = doorLoop[k]!;
    // Outward across the rim (from the door's centre line toward its edge) and along the edge.
    const outDir = v3.normalize(localDirOf(face, un - u, vn - v));
    const alongDir = v3.cross(face.n, outDir);
    const lf = frameAt(local(face, u, v, 0.009), outDir, alongDir);
    b.box(lf, 0.019, 0.015, 0.009, 0.002, ctx.m('anodized'));
    b.cylinder(local(lf, -0.006, 0, 0.009), face.n, 0.0055, 0.004, 10, steel, { caps: 'top' });
    // Hook: an arm over the door's edge, its tip turned down onto the striker. (The door is a flat plug in a
    // conical wall: at its sides the rim lies almost flush with the frame, at the top and the bottom it
    // stands several centimetres proud; the hook's drop and the striker's height follow.)
    const tip = local(lf, 0.058, 0, 0.004);
    const [uo, vo] = outerLoop[k]!;
    let under = g.at(uo, vo, 0);
    for (let s = 0; s <= 2.5; s += 0.05) {
      const p = g.at(un + (uo - un) * s, vn + (vo - vn) * s, 0);
      if (Math.abs(v3.dot(v3.sub(p, tip), outDir)) < Math.abs(v3.dot(v3.sub(under, tip), outDir))) under = p;
    }
    const room = v3.dot(v3.sub(tip, under), g.inward);
    const drop = Math.max(0.003, Math.min(0.022, room - 0.012));
    b.box(offsetFrame(lf, 0.036, 0, 0.004), 0.024, 0.006, 0.004, 0.0015, steel);
    b.box(frameAt(v3.addScaled(tip, face.n, -drop / 2), outDir, alongDir), 0.004, 0.006, drop / 2, 0.0015, steel);
    // Striker post on the frame's land, with its roller.
    const top = v3.addScaled(tip, face.n, -drop - 0.002);
    // The post's foot: the point of the frame (10 mm off the wall, following its curve) under the hook's tip.
    let post = g.at(uo, vo, 0.01);
    for (let s = 0; s <= 2.5; s += 0.05) {
      const p = g.at(un + (uo - un) * s, vn + (vo - vn) * s, 0.01);
      if (Math.abs(v3.dot(v3.sub(p, top), outDir)) < Math.abs(v3.dot(v3.sub(post, top), outDir))) post = p;
    }
    const ph = v3.dot(v3.sub(top, post), g.inward);
    if (ph > 0.01) {
      b.box(frameAt(v3.addScaled(post, g.inward, ph / 2), outDir, alongDir), 0.008, 0.011, ph / 2, 0.002, ctx.m('hatch'));
      b.cylinder(v3.addScaled(v3.addScaled(post, g.inward, ph + 0.004), alongDir, -0.012), alongDir, 0.005, 0.024, 10, steel, { caps: 'both' });
    }
    // Bellcrank link from the housing down to the drive rod.
    const [ur, vr] = rodLoop[k]!;
    b.tube([local(lf, -0.016, 0, 0.004), local(g.plane(rodH), ur, vr)], 0.003, 6, steel);
  }
  // Hinges on the +u side.
  for (const v of [-hh * 0.6, hh * 0.6]) {
    const p = g.at(-side * (hatch.width / 2 + 0.03), v, 0.026);
    b.cylinder(v3.addScaled(p, g.frame.g, -0.05), g.frame.g, 0.018, 0.1, 16, ctx.m('aluminium'));
  }
  // Pressure-equalisation valve.
  const pev = offsetFrame(face, -side * hw * 0.7, hh * 0.55, 0);
  // A flanged valve body with a T handle on a stem.
  b.lathe(pev.o, face.n, [[0.03, 0], [0.03, 0.004], [0.024, 0.006], [0.024, 0.017], [0.02, 0.02], [0.009, 0.02]], 24, ctx.m('anodized', { flags: FLAG_EDGE }));
  for (let k = 0; k < 6; k++) b.cylinder(local(pev, Math.cos((k * Math.PI) / 3) * 0.027, Math.sin((k * Math.PI) / 3) * 0.027, 0.004), face.n, 0.0024, 0.002, 6, steel, { caps: 'top' });
  b.cylinder(local(pev, 0, 0, 0.02), face.n, 0.006, 0.014, 12, steel);
  b.cylinder(local(pev, -0.034, 0, 0.034), pev.x, 0.0065, 0.068, 12, ctx.m('warning'), { caps: 'both' });
  b.lathe(local(pev, 0, 0, 0.027), face.n, [[0.0, 0], [0.011, 0.001], [0.011, 0.013], [0.0, 0.014]], 14, ctx.m('warning'));
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
  // The hatch's inner face: a machined plate stiffened by radial ribs between a hub ring and a rim ring, a
  // pressure gauge and its equalisation valve between two ribs.
  const hatchRib = ctx.m('hatch', { ao: 0.85 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * 2 * Math.PI + 0.12;
    const radial = { x: Math.cos(a), y: 0, z: Math.sin(a) };
    const tangent = { x: -Math.sin(a), y: 0, z: Math.cos(a) };
    const r0 = 0.085;
    const r1 = r - 0.075;
    b.box(frameAt(v3.add(face.o, v3.add(v3.scale(radial, (r0 + r1) / 2), v3.scale(face.n, 0.006))), radial, tangent), (r1 - r0) / 2, 0.0035, 0.006, 0.0015, hatchRib);
  }
  b.lathe(face.o, face.n, [[0.092, 0], [0.092, 0.012], [0.08, 0.012], [0.08, 0]], 40, hatchRib, { ref: face.x });
  b.lathe(face.o, face.n, [[r - 0.066, 0], [r - 0.066, 0.012], [r - 0.078, 0.012], [r - 0.078, 0]], 64, hatchRib, { ref: face.x });
  {
    const ga = 1.9;
    const gp = v3.add(face.o, v3.scale({ x: Math.cos(ga), y: 0, z: Math.sin(ga) }, r * 0.55));
    b.lathe(gp, face.n, [[0.028, 0], [0.028, 0.014], [0.024, 0.017], [0, 0.017]], 24, ctx.m('anodized', { flags: FLAG_EDGE }), { ref: face.x });
    b.cylinder(v3.addScaled(gp, face.n, 0.017), face.n, 0.021, 0.0012, 24, ctx.m('pointer'), { caps: 'top' });
    b.box(frameAt(v3.addScaled(gp, face.n, 0.0188), { x: Math.cos(0.7), y: 0, z: Math.sin(0.7) }, { x: -Math.sin(0.7), y: 0, z: Math.cos(0.7) }), 0.009, 0.0009, 0.0005, 0.0002, ctx.m('warning'));
    const vp = v3.add(face.o, v3.scale({ x: Math.cos(ga + 0.5), y: 0, z: Math.sin(ga + 0.5) }, r * 0.55));
    b.cylinder(vp, face.n, 0.012, 0.016, 14, ctx.m('steel'), { caps: 'top' });
    b.cylinder(v3.add(v3.addScaled(vp, face.n, 0.022), v3.scale(face.x, -0.024)), face.x, 0.0045, 0.048, 10, ctx.m('warning'), { caps: 'both' });
  }
  // Its placard: a plate riveted across two ribs.
  b.box(offsetFrame(hub, 0, -0.18, 0.0124), 0.115, 0.0105, 0.0004, 0.0002, ctx.m('aluminium'));
  ctx.labelQuad(offsetFrame(hub, 0, -0.18, 0.0128), 0, 0, 0.22, 0.015, 'DOCKING HATCH · PEV FIRST', 'aluminium', { color: 1, lift: 0.0003, style: { box: true } });
}
