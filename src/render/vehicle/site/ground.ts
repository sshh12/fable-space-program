/**
 * 'pad.groundworks': the earthworks a launch complex stands on. A complex is not a set of objects on a
 * plane: its hardstand lies in a graded field of compacted crushed stone whose edge slopes away under the
 * natural ground, service roads on fill join the pad, the tank farms and the gate, each tank farm stands on
 * its own stone pad, earth berms shield the farms from the pad, and vehicles have worn tracks into the stone.
 *
 * Everything is BUILT ON THE SURVEYED GROUND (./survey.ts): outside the level areas of the pad shape the
 * terrain keeps a share of its relief, so every surface here is fill over the highest terrain under it
 * (a road's grade line is the smoothed upper envelope of the ground along it plus its pavement), and every
 * edge ends in a shoulder that reaches below the lowest terrain at its foot. Nothing is buried, nothing hangs.
 *
 * All positions are in the site frame of the structure (origin at the pad centre for an offset of zero;
 * +X east, +Z south), given by the structure's parameters:
 *
 *   radius, lobes        the graded field: mean radius (m) and how far its outline wanders (0..0.2)
 *   innerRadius          radius inside which the field is not built (it is under the hardstand)
 *   pads                 "x,z,radius;..." or "x,z,halfX,halfZ,headingDeg;..."   stone pads (round or rounded rectangles)
 *   roads                "x,z>x,z>...@width~fillet;..."     asphalt roads along polylines with rounded corners
 *   tracks               "x,z>x,z>...;..."                  wheel tracks worn into the stone (two ruts each)
 *   berms                "x,z,radius,a0Deg,a1Deg,height;..." earth berms: arcs about (x, z), angles from +X toward -Z
 *   poles                "x,z,headingDeg;..."               road lamp posts (the arm points along the heading)
 *   scorch               "x,z,headingDeg,length;..."        blast staining of the stone: a fan from (x, z) along the heading
 *
 * Models: 'ground' (stone field, pads, roads, tracks: cast no shadow, with their grime shown), 'berms',
 * 'poles' and 'pole-lamps' (lit at night).
 */

import { MeshBuilder, xf } from '../geom/builder';
import { DEG, TAU, box, frustum, rod } from '../geom/prims';
import { buildModel, noise2, parseList } from '../parts/common';
import type { GroundField } from './survey';
import { numParam, strParam, type SiteGenerator } from './types';

/** How far a shoulder runs out and down from the edge of a surface on level ground, m. */
const SHOULDER = 4.5;
const SHOULDER_DROP = 0.75;
/** A shoulder's foot is this far below the lowest terrain there, m; fill stands this far over the highest. */
const FOOT_COVER = 0.5;
const FILL_COVER = 0.06;

/** Polyline "x,z>x,z>..." of a parameter. */
export function parsePath(text: string, what: string): [number, number][] {
  const pts = text.split('>').map((q) => q.split(',').map(Number) as [number, number]);
  if (pts.length < 2 || pts.some((q) => q.length !== 2 || !Number.isFinite(q[0]) || !Number.isFinite(q[1]))) throw new Error(`${what}: bad path "${text}"`);
  return pts;
}

/** Round the corners of a plan polyline with arcs of `radius` (less where a leg is too short for it). */
export function filletPlan(pts: [number, number][], radius: number, closed = false): [number, number][] {
  if (radius <= 0 || pts.length < 3) return pts.slice();
  const n = pts.length;
  const out: [number, number][] = [];
  const first = closed ? 0 : 1;
  const last = closed ? n - 1 : n - 2;
  if (!closed) out.push(pts[0]!);
  for (let i = first; i <= last; i++) {
    const p = pts[i]!;
    const a = pts[(i - 1 + n) % n]!;
    const c = pts[(i + 1) % n]!;
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const lc = Math.hypot(c[0] - p[0], c[1] - p[1]);
    const ua: [number, number] = [(a[0] - p[0]) / la, (a[1] - p[1]) / la];
    const uc: [number, number] = [(c[0] - p[0]) / lc, (c[1] - p[1]) / lc];
    const cos = Math.max(-1, Math.min(1, ua[0] * uc[0] + ua[1] * uc[1]));
    const half = Math.acos(cos) / 2;
    if (half > Math.PI / 2 - 0.02) {
      out.push(p);
      continue;
    }
    // Tangent length of the arc, kept inside 45 % of both legs.
    const t = Math.min(radius / Math.tan(half), 0.45 * la, 0.45 * lc);
    const r = t * Math.tan(half);
    const bis: [number, number] = [ua[0] + uc[0], ua[1] + uc[1]];
    const bl = Math.hypot(bis[0], bis[1]);
    const centre: [number, number] = [p[0] + (bis[0] / bl) * (r / Math.sin(half)), p[1] + (bis[1] / bl) * (r / Math.sin(half))];
    const a0 = Math.atan2(p[1] + ua[1] * t - centre[1], p[0] + ua[0] * t - centre[0]);
    let sweep = Math.atan2(p[1] + uc[1] * t - centre[1], p[0] + uc[0] * t - centre[0]) - a0;
    while (sweep > Math.PI) sweep -= TAU;
    while (sweep < -Math.PI) sweep += TAU;
    const steps = Math.max(2, Math.ceil((Math.abs(sweep) * r) / 3));
    for (let k = 0; k <= steps; k++) out.push([centre[0] + r * Math.cos(a0 + (sweep * k) / steps), centre[1] + r * Math.sin(a0 + (sweep * k) / steps)]);
  }
  if (!closed) out.push(pts[n - 1]!);
  return out;
}

export interface Station {
  p: [number, number];
  /** Unit normal to the LEFT of travel seen from above (+Z is south), and the unit direction of travel. */
  n: [number, number];
  d: [number, number];
  /** Distance along the path, m. */
  s: number;
}

/** Stations along a plan polyline about every `spacing` metres (both ends exact). */
export function stationsAlong(pts: [number, number][], spacing: number): Station[] {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  const total = cum[cum.length - 1]!;
  const count = Math.max(1, Math.round(total / spacing));
  const at = (s: number): [number, number] => {
    let i = 1;
    while (i < pts.length - 1 && cum[i]! < s) i++;
    const t = (s - cum[i - 1]!) / Math.max(1e-9, cum[i]! - cum[i - 1]!);
    return [pts[i - 1]![0] + (pts[i]![0] - pts[i - 1]![0]) * t, pts[i - 1]![1] + (pts[i]![1] - pts[i - 1]![1]) * t];
  };
  const out: Station[] = [];
  for (let k = 0; k <= count; k++) {
    const s = (total * k) / count;
    const a = at(Math.max(0, s - 0.5));
    const c = at(Math.min(total, s + 0.5));
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    const d: [number, number] = [(c[0] - a[0]) / l, (c[1] - a[1]) / l];
    out.push({ p: at(s), n: [d[1], -d[0]], d, s });
  }
  return out;
}

/**
 * Grade line of a strip `halfWidth` wide along stations 2 m apart: over every station the highest ground
 * across the strip, then its running maximum over +-`reach` metres, smoothed over the same reach (the mean of
 * running maxima never falls under the ground it was taken from), never under `floor`.
 */
function gradeLine(ground: GroundField, st: Station[], halfWidth: number, reach: number, floor: number): number[] {
  const hi = st.map((q) => {
    let h = -Infinity;
    for (let k = -2; k <= 2; k++) h = Math.max(h, ground.hi(q.p[0] + (q.n[0] * halfWidth * k) / 2, q.p[1] + (q.n[1] * halfWidth * k) / 2));
    return h;
  });
  const w = Math.max(1, Math.round(reach / 2));
  const win = (src: number[], i: number, f: (a: number, b: number) => number, init: number): number => {
    let v = init;
    for (let k = Math.max(0, i - w); k <= Math.min(src.length - 1, i + w); k++) v = f(v, src[k]!);
    return v;
  };
  const top = hi.map((_, i) => win(hi, i, Math.max, -Infinity));
  return top.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(top.length - 1, i + w); k++) {
      sum += top[k]!;
      n++;
    }
    return Math.max(floor, sum / n);
  });
}

/**
 * Field of stone about (cx, cz) between `rIn` and an outline r(theta), on a polar grid: level at `y` where
 * the ground lets it, fill over higher ground, and a shoulder that slopes below the terrain at its foot.
 * `grime` is the vertex grime weight (tone variation larger than a texture tile).
 */
function stoneField(b: MeshBuilder, ground: GroundField, cx: number, cz: number, rIn: number, outline: (theta: number) => number, y: number, step: number, grime: (x: number, z: number, edge: number) => number, tag: string): void {
  b.begin(false, tag);
  let rMax = 0;
  for (let k = 0; k < 64; k++) rMax = Math.max(rMax, outline((k / 64) * TAU));
  const spokes = Math.max(16, Math.round((TAU * rMax) / step));
  const rings = Math.max(1, Math.round((rMax - rIn) / step));
  const ids: number[][] = [];
  for (let j = 0; j <= rings + 1; j++) {
    const row: number[] = [];
    for (let k = 0; k <= spokes; k++) {
      const th = (k / spokes) * TAU;
      const ro = outline(th);
      const shoulder = j === rings + 1;
      const r = shoulder ? ro + SHOULDER : rIn + ((ro - rIn) * j) / rings;
      const x = cx + r * Math.cos(th);
      const z = cz - r * Math.sin(th);
      const top = Math.max(y, ground.hi(x, z) + FILL_COVER);
      const py = shoulder ? Math.min(top - SHOULDER_DROP, ground.lo(x, z) - FOOT_COVER) : top;
      // The shoulder leans outward: its normal tips by half its slope at the edge, by all of it at the foot.
      const tilt = (j >= rings ? SHOULDER_DROP / SHOULDER : 0) * (shoulder ? 1 : 0.5);
      const l = Math.hypot(1, tilt);
      // Tangent round the field (perpendicular to the radial plane the normal lies in).
      const v = b.v(x, py, z, (Math.cos(th) * tilt) / l, 1 / l, (-Math.sin(th) * tilt) / l, -Math.sin(th), 0, -Math.cos(th), x, -z);
      b.setMask(v, 0, 1, grime(x, z, shoulder ? 1 : j / rings), 0);
      row.push(v);
    }
    ids.push(row);
  }
  // Counter-clockwise seen from above (theta runs from +X toward -Z, which is counter-clockwise from above).
  for (let j = 0; j <= rings; j++) for (let k = 0; k < spokes; k++) b.quad(ids[j]![k]!, ids[j + 1]![k]!, ids[j + 1]![k + 1]!, ids[j]![k + 1]!);
}

/**
 * Road along a plan path: a crowned asphalt strip on fill, stone shoulders that slope below the terrain,
 * and edge lines. `lift` lowers later roads by a hair where two meet (no two pavements in one plane).
 */
function road(b: MeshBuilder, ground: GroundField, path: [number, number][], width: number, y: number, lift: number, grime: (x: number, z: number) => number): void {
  const hw = width / 2;
  const sh = 1.6;
  const fine = stationsAlong(path, 2);
  const grade = gradeLine(ground, fine, hw + sh, 10, y);
  const every = b.pick(2, 4, 12);
  const pick: number[] = [];
  for (let i = 0; i < fine.length - 1; i += every) pick.push(i);
  pick.push(fine.length - 1);
  // A station's height is the highest grade within its reach, so the chord to the next one stays above it.
  const st = pick.map((i) => {
    let g = -Infinity;
    for (let k = Math.max(0, i - every + 1); k <= Math.min(fine.length - 1, i + every - 1); k++) g = Math.max(g, grade[k]!);
    return { q: fine[i]!, y: g + 0.1 + lift };
  });
  // Offsets across the road and their heights over the grade: foot, shoulder top, edge, crown, edge, top, foot.
  const cross: [number, number][] = [
    [-hw - sh - 2.6, Number.NaN],
    [-hw - sh, 0],
    [-hw, 0.05],
    [0, 0.11],
    [hw, 0.05],
    [hw + sh, 0],
    [hw + sh + 2.6, Number.NaN],
  ];
  const vertex = (q: Station, yRoad: number, c: number): { x: number; z: number; y: number } => {
    const [off, dy] = cross[c]!;
    const x = q.p[0] + q.n[0] * off;
    const z = q.p[1] + q.n[1] * off;
    return { x, z, y: Number.isNaN(dy) ? Math.min(yRoad - SHOULDER_DROP, ground.lo(x, z) - FOOT_COVER) : yRoad + dy };
  };
  for (const [mat, from, to] of [
    ['gravel-fill', 0, 2],
    ['asphalt', 2, 4],
    ['gravel-fill', 4, 6],
  ] as const) {
    b.mat(mat);
    b.begin(false, 'road');
    const rows: number[][] = [];
    for (const s of st) {
      const row: number[] = [];
      for (let c: number = from; c <= to; c++) {
        const p = vertex(s.q, s.y, c);
        // The embankment's faces lean outward.
        const lean = c === 0 ? -0.35 : c === 6 ? 0.35 : 0;
        const l = Math.hypot(1, lean);
        const v = b.v(p.x, p.y, p.z, (s.q.n[0] * lean) / l, 1 / l, (s.q.n[1] * lean) / l, s.q.d[0], 0, s.q.d[1], p.x, -p.z);
        b.setMask(v, 0, 1, mat === 'asphalt' ? grime(p.x, p.z) * 0.5 : Math.min(0.75, grime(p.x, p.z) + (c === 0 || c === 6 ? 0.4 : 0.1)), 0);
        row.push(v);
      }
      rows.push(row);
    }
    // n is to the LEFT of travel seen from above (+Z is south): offsets grow to the left, so
    // (station i, c) -> (station i + 1, c) -> (i + 1, c + 1) -> (i, c + 1) is counter-clockwise from above.
    for (let i = 0; i + 1 < rows.length; i++) for (let c = 0; c + 1 < rows[i]!.length; c++) b.quad(rows[i]![c]!, rows[i + 1]![c]!, rows[i + 1]![c + 1]!, rows[i]![c + 1]!);
  }
  if (b.lod < 2) {
    // Painted edge lines (worn: they carry the road's grime).
    b.mat('paint-white');
    b.begin(false, 'ground-marking');
    for (const side of [-1, 1]) {
      const rows: [number, number][] = [];
      for (const s of st) {
        const mk = (off: number): number => {
          const x = s.q.p[0] + s.q.n[0] * off;
          const z = s.q.p[1] + s.q.n[1] * off;
          const v = b.v(x, s.y + 0.062 + 0.0004 * Math.abs(off), z, 0, 1, 0, s.q.d[0], 0, s.q.d[1], x, -z);
          b.setMask(v, 0.5, 1, 0.5, 0);
          return v;
        };
        rows.push([mk(side * (hw - 0.45) - 0.07), mk(side * (hw - 0.45) + 0.07)]);
      }
      for (let i = 0; i + 1 < rows.length; i++) b.quad(rows[i]![0], rows[i + 1]![0], rows[i + 1]![1], rows[i]![1]);
    }
  }
}

/** Two wheel ruts along a path: ribbons of darker, pressed stone a hair above the surface they run on. */
function wheelTrack(b: MeshBuilder, ground: GroundField, path: [number, number][], y: number, seed: number): void {
  const st = stationsAlong(filletPlan(path, 14), b.pick(3, 6, 6));
  b.begin(false, 'ground-marking');
  for (const side of [-1, 1]) {
    const rows: [number, number][] = [];
    for (const q of st) {
      // The ruts wander and fade in and out along the track.
      const wander = (noise2(q.s / 23, seed, 61) - 0.5) * 1.2;
      const strength = 0.25 + 0.5 * noise2(q.s / 17, seed + side, 67);
      const mk = (off: number): number => {
        const x = q.p[0] + q.n[0] * (off + wander);
        const z = q.p[1] + q.n[1] * (off + wander);
        const v = b.v(x, Math.max(y, ground.hi(x, z) + FILL_COVER) + 0.012, z, 0, 1, 0, q.d[0], 0, q.d[1], x, -z);
        b.setMask(v, 0, 1, strength, 0);
        return v;
      };
      rows.push([mk(side * 0.95 - 0.26), mk(side * 0.95 + 0.26)]);
    }
    for (let i = 0; i + 1 < rows.length; i++) b.quad(rows[i]![0], rows[i + 1]![0], rows[i + 1]![1], rows[i]![1]);
  }
}

/** Earth berm on the ground: an arc about (cx, cz) of radius `r` from a0 to a1, `h` high, tapering at both ends. */
function berm(b: MeshBuilder, ground: GroundField, cx: number, cz: number, r: number, a0: number, a1: number, h: number): void {
  b.begin(false, 'berm');
  const n = Math.max(4, Math.round((Math.abs(a1 - a0) * r) / b.pick(4, 8, 20)));
  const base = h * 2.1;
  const crest = h * 0.45;
  const rows: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const th = a0 + (a1 - a0) * t;
    // Height tapers over the first and last tenth; the crest wanders a little.
    const k = Math.min(1, t / 0.1, (1 - t) / 0.1) * (0.9 + 0.2 * noise2(t * 7, r * 0.1, 41));
    const hh = h * Math.max(0.04, k);
    const c = Math.cos(th);
    const s = Math.sin(th);
    const under = ground.hi(cx + r * c, cz - r * s);
    const row: number[] = [];
    for (const [dr, up, nr] of [
      [-base, Number.NaN, -0.45],
      [-crest, hh, -0.3],
      [crest, hh, 0.3],
      [base, Number.NaN, 0.45],
    ] as [number, number, number][]) {
      const rr = r + dr * (0.6 + 0.4 * Math.max(0.2, k));
      const x = cx + rr * c;
      const z = cz - rr * s;
      const y = Number.isNaN(up) ? ground.lo(x, z) - FOOT_COVER : under + up;
      const l = Math.hypot(nr, 1);
      const v = b.v(x, y, z, (c * nr) / l, 1 / l, (-s * nr) / l, -s, 0, -c, th * r, dr);
      b.setMask(v, 0, Number.isNaN(up) ? 0.7 : 1, 0.15 + 0.35 * noise2(x / 6, z / 6, 43), 0);
      row.push(v);
    }
    rows.push(row);
  }
  const ccw = a1 > a0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      // Radius grows with c; theta from +X toward -Z is counter-clockwise from above.
      if (ccw) b.quad(rows[i]![c]!, rows[i]![c + 1]!, rows[i + 1]![c + 1]!, rows[i + 1]![c]!);
      else b.quad(rows[i]![c]!, rows[i + 1]![c]!, rows[i + 1]![c + 1]!, rows[i]![c + 1]!);
    }
  }
}

/** Height of a road lamp post and the reach of its arm, m. */
const POLE_HEIGHT = 9;
const POLE_ARM = 1.8;

export const padGroundworks: SiteGenerator = ({ params, ground }) => {
  const R = numParam(params, 'radius', 104);
  const lobes = numParam(params, 'lobes', 0.04);
  const rIn = numParam(params, 'innerRadius', 40);
  const y = numParam(params, 'height', 0.12);
  // Outline of the graded field: never a circle and never a clean curve (earthworks follow what stands on them
  // and what the bulldozers left): three broad lobes and a ragged edge a few metres deep.
  const outline = (th: number): number =>
    R * (1 + lobes * Math.sin(3 * th + 1.0) + 0.65 * lobes * Math.sin(5 * th + 2.2) + 0.5 * lobes * Math.sin(9 * th + 0.7)) + 3.2 * (noise2(th * 9, 0.5, 71) - 0.5) + 1.6 * (noise2(th * 31, 0.5, 73) - 0.5);
  const pads = parseList(strParam(params, 'pads', '')).map((e) => (e.n.length >= 5 ? { x: e.n[0]!, z: e.n[1]!, hx: e.n[2]!, hz: e.n[3]!, heading: e.n[4]! * DEG } : { x: e.n[0]!, z: e.n[1]!, hx: e.n[2]!, hz: e.n[2]!, heading: 0 }));
  const roads = strParam(params, 'roads', '')
    .split(';')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      const m = /^([^@~]+)(?:@([\d.]+))?(?:~([\d.]+))?$/.exec(t);
      if (!m) throw new Error(`pad.groundworks: bad road "${t}"`);
      return { path: filletPlan(parsePath(m[1]!, 'pad.groundworks road'), Number(m[3] ?? 0)), width: Number(m[2] ?? 7) };
    });
  const tracks = strParam(params, 'tracks', '')
    .split(';')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => parsePath(t, 'pad.groundworks track'));
  const berms = parseList(strParam(params, 'berms', '')).map((e) => ({ x: e.n[0]!, z: e.n[1]!, r: e.n[2]!, a0: e.n[3]! * DEG, a1: e.n[4]! * DEG, h: e.n[5] ?? 3 }));
  const poles = parseList(strParam(params, 'poles', '')).map((e) => ({ x: e.n[0]!, z: e.n[1]!, heading: (e.n[2] ?? 0) * DEG }));
  const fans = parseList(strParam(params, 'scorch', '')).map((e) => ({ x: e.n[0]!, z: e.n[1]!, dx: Math.sin((e.n[2] ?? 0) * DEG), dz: -Math.cos((e.n[2] ?? 0) * DEG), len: e.n[3] ?? 50 }));
  /** Blast staining where a flame trench empties onto the stone: a fan that widens and fades along the flow, in streaks. */
  const blast = (x: number, z: number): number => {
    let w = 0;
    for (const f of fans) {
      const along = (x - f.x) * f.dx + (z - f.z) * f.dz;
      if (along <= -4) continue;
      const across = (x - f.x) * f.dz - (z - f.z) * f.dx;
      w = Math.max(w, Math.exp(-Math.max(0, along) / f.len) * Math.exp(-((across / (7 + 0.4 * Math.max(0, along))) ** 2)) * (0.5 + 0.5 * noise2(across / 2.1, along / 15, 59)));
    }
    return 0.8 * w;
  };

  /**
   * Tone of the stone: dust and damp in patches tens of metres across, and toward its edge the fill thins
   * into the ground it was spread on (the edge of a graded field is not a line).
   */
  const grime = (x: number, z: number, edge = 0): number => Math.max(0, Math.min(0.85, 0.42 * noise2(x / 31, z / 31, 51) + 0.2 * noise2(x / 9, z / 9, 53) - 0.12 + 0.55 * Math.max(0, edge - 0.55) * (0.6 + 0.8 * noise2(x / 5, z / 5, 57)) + blast(x, z)));

  const groundModel = buildModel('pad.groundworks', (b) => {
    const step = b.pick(3.5, 7, 26);
    b.mat('gravel-fill').masks(0, 1, 0, 0);
    stoneField(b, ground, 0, 0, rIn, outline, y, step, grime, 'stone');
    pads.forEach((p, i) => {
      // A rounded rectangle (a superellipse) turned by its heading, with a wavering edge.
      const rr = (th: number): number => {
        const a = th + p.heading;
        const r = Math.pow(Math.pow(Math.abs(Math.cos(a)) / p.hx, 4) + Math.pow(Math.abs(Math.sin(a)) / p.hz, 4), -0.25);
        return r * (1 + 0.035 * Math.sin(3 * th + i) + 0.025 * Math.sin(7 * th + 2 * i)) + 1.2 * (noise2(th * 11, i, 75) - 0.5);
      };
      stoneField(b, ground, p.x, p.z, 0.5, rr, y - 0.02, step, grime, 'stone');
    });
    roads.forEach((r, i) => road(b, ground, r.path, r.width, y + 0.04, -0.014 * i, grime));
    if (b.lod < 2) {
      b.mat('gravel-fill');
      tracks.forEach((t, i) => wheelTrack(b, ground, t, y, i));
    }
  });
  const mounds = buildModel('pad.groundworks.berms', (b) => {
    b.mat('gravel-fill').masks(0, 1, 0.3, 0);
    for (const m of berms) berm(b, ground, m.x, m.z, m.r, m.a0, m.a1, m.h);
  });
  // Road lamp posts: a tapered steel pole on a concrete stub, an arm, a luminaire.
  const poleFrame = (p: { x: number; z: number; heading: number }, fn: () => void, b: MeshBuilder): void => void b.at(xf.mul(xf.translate(p.x, ground.lo(p.x, p.z) - 0.3, p.z), xf.rotY(-p.heading)), fn);
  const poleModel = buildModel('pad.groundworks.poles', (b) => {
    for (const p of poles) {
      const stub = ground.hi(p.x, p.z) - ground.lo(p.x, p.z) + 0.3 + 0.35;
      poleFrame(
        p,
        () => {
          b.mat('concrete-wall').masks(0, 1, 0.3, 0);
          box(b, 0.6, stub, 0.6, [0, stub / 2, 0], 'pole-base');
          b.mat('galvanised').masks(0.15, 1, 0.25, 0);
          frustum(b, 0.11, 0.06, stub, stub + POLE_HEIGHT, b.pick(10, 6, 4), 'pole');
          rod(b, [0, stub + POLE_HEIGHT - 0.1, 0], [0, stub + POLE_HEIGHT + 0.25, -POLE_ARM], 0.035, b.pick(8, 5, 4), 'pole-arm');
          b.mat('steel-dark');
          box(b, 0.34, 0.12, 0.8, [0, stub + POLE_HEIGHT + 0.27, -POLE_ARM - 0.25], 'luminaire');
        },
        b,
      );
    }
  });
  const poleLamps = buildModel('pad.groundworks.poleLamps', (b) => {
    b.mat('lamp').masks(0, 1, 0, 0);
    for (const p of poles) {
      const stub = ground.hi(p.x, p.z) - ground.lo(p.x, p.z) + 0.3 + 0.35;
      poleFrame(p, () => box(b, 0.26, 0.03, 0.6, [0, stub + POLE_HEIGHT + 0.2, -POLE_ARM - 0.25], 'lens'), b);
    }
  });
  const withBerms = berms.length > 0;
  const withPoles = poles.length > 0;
  return {
    models: { ground: groundModel, ...(withBerms ? { berms: mounds } : {}), ...(withPoles ? { poles: poleModel, 'pole-lamps': poleLamps } : {}) },
    pose: (state, emit) => {
      emit('ground', null, null, { castShadow: false, grime: 1 });
      if (withBerms) emit('berms', null, null, { grime: 1 });
      if (withPoles) {
        emit('poles', null, null, { fineShadowOnly: true });
        emit('pole-lamps', null, null, { emissive: state.night * 0.35, castShadow: false });
      }
    },
  };
};

