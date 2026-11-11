/**
 * 'pad.groundworks': the earthworks a launch complex stands on. A complex is not a set of objects on a
 * plane: its hardstand lies in a graded field of compacted crushed stone whose edge slopes away under the
 * natural ground, service roads join the pad, the tank farms and the perimeter, each tank farm stands on its
 * own stone pad, and earth berms shield the farms from the pad.
 *
 * Everything is given in the site frame of the structure (origin at the pad centre for an offset of zero;
 * +X east, +Z south) by the structure's parameters:
 *
 *   radius, lobes        the graded field: mean radius (m) and how far its outline wanders (0..0.2)
 *   innerRadius          radius inside which the field is not built (it is under the hardstand)
 *   pads                 "x,z,radius;..."                   stone pads (under tank farms, buildings, mast feet)
 *   roads                "x,z>x,z>...@width;..."            asphalt roads along polylines
 *   berms                "x,z,radius,a0Deg,a1Deg,height;..." earth berms: arcs about (x, z), angles from +X toward -Z
 *
 * Models: 'ground' (stone field, pads and roads: flat, cast no shadow, with their grime shown) and 'berms'.
 * Every surface ends in a shoulder that goes below grade, so no slab shows an edge or an underside whatever
 * the terrain does next to it.
 */
import { MeshBuilder } from '../geom/builder';
import { DEG, TAU } from '../geom/prims';
import { buildModel, noise2, parseList } from '../parts/common';
import { numParam, strParam, type SiteGenerator } from './types';

/** How far a shoulder runs out and down from the edge of a surface, m. */
const SHOULDER = 4.5;
const SHOULDER_DROP = 0.75;

/**
 * Field of stone about (cx, cz) between `rIn` and an outline r(theta), on a polar grid, with a shoulder that
 * slopes below grade. `grime` is the vertex grime weight (tone variation larger than a texture tile).
 */
function stoneField(b: MeshBuilder, cx: number, cz: number, rIn: number, outline: (theta: number) => number, y: number, step: number, grime: (x: number, z: number) => number, tag: string): void {
  b.begin(false, tag);
  let rMax = 0;
  for (let k = 0; k < 64; k++) rMax = Math.max(rMax, outline((k / 64) * TAU));
  const spokes = Math.max(12, Math.round((TAU * rMax) / step));
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
      // The shoulder leans outward: its normal tips by half its slope at the edge, by all of it at the foot.
      const tilt = (j >= rings ? SHOULDER_DROP / SHOULDER : 0) * (shoulder ? 1 : 0.5);
      const l = Math.hypot(1, tilt);
      // Tangent round the field (perpendicular to the radial plane the normal lies in).
      const v = b.v(x, shoulder ? y - SHOULDER_DROP : y, z, (Math.cos(th) * tilt) / l, 1 / l, (-Math.sin(th) * tilt) / l, -Math.sin(th), 0, -Math.cos(th), x, -z);
      b.setMask(v, 0, 1, grime(x, z), 0);
      row.push(v);
    }
    ids.push(row);
  }
  // Counter-clockwise seen from above (theta runs from +X toward -Z, which is counter-clockwise from above).
  for (let j = 0; j <= rings; j++) for (let k = 0; k < spokes; k++) b.quad(ids[j]![k]!, ids[j + 1]![k]!, ids[j + 1]![k + 1]!, ids[j]![k + 1]!);
}

/** Road along a polyline: a crowned asphalt strip with stone shoulders that slope below grade, and edge lines. */
function road(b: MeshBuilder, pts: [number, number][], width: number, y: number, grime: (x: number, z: number) => number): void {
  const hw = width / 2;
  const sh = 1.6;
  // Offsets across the road and their heights: shoulder foot, shoulder top, edge, crown, edge, shoulder top, foot.
  const cross: [number, number, boolean][] = [
    [-hw - sh - 2.2, -SHOULDER_DROP, false],
    [-hw - sh, 0, false],
    [-hw, 0.05, true],
    [0, 0.11, true],
    [hw, 0.05, true],
    [hw + sh, 0, false],
    [hw + sh + 2.2, -SHOULDER_DROP, false],
  ];
  // Stations along the polyline with their tangents (mitred at the corners).
  const st: { p: [number, number]; n: [number, number]; s: number }[] = [];
  let run = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const c = pts[i + 1]!;
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const n = Math.max(1, Math.round(l / b.pick(8, 16, 60)));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const t = k / n;
      // Normal to the left of the direction of travel, averaged with the next segment at a corner.
      let dx = (c[0] - a[0]) / l;
      let dz = (c[1] - a[1]) / l;
      if (k === n && i + 2 < pts.length) {
        const d = pts[i + 2]!;
        const l2 = Math.hypot(d[0] - c[0], d[1] - c[1]);
        dx += (d[0] - c[0]) / l2;
        dz += (d[1] - c[1]) / l2;
        const m = Math.hypot(dx, dz);
        dx /= m;
        dz /= m;
      }
      st.push({ p: [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t], n: [dz, -dx], s: run + l * t });
    }
    run += l;
  }
  for (const [mat, from, to] of [
    ['gravel-fill', 0, 2],
    ['asphalt', 2, 4],
    ['gravel-fill', 4, 6],
  ] as const) {
    b.mat(mat);
    b.begin(false, 'road');
    const rows: number[][] = [];
    for (const q of st) {
      const row: number[] = [];
      for (let c = from; c <= to; c++) {
        const [off, dy] = cross[c]!;
        const x = q.p[0] + q.n[0] * off;
        const z = q.p[1] + q.n[1] * off;
        const v = b.v(x, y + dy, z, 0, 1, 0, 1, 0, 0, x, -z);
        b.setMask(v, 0, 1, grime(x, z) * (mat === 'asphalt' ? 0.5 : 1), 0);
        row.push(v);
      }
      rows.push(row);
    }
    // n = (dz, -dx) is to the LEFT of travel seen from above (+Z is south): offsets grow to the left, so
    // (station i, c) -> (station i + 1, c) -> (i + 1, c + 1) -> (i, c + 1) is counter-clockwise from above.
    for (let i = 0; i + 1 < rows.length; i++) for (let c = 0; c + 1 < rows[i]!.length; c++) b.quad(rows[i]![c]!, rows[i + 1]![c]!, rows[i + 1]![c + 1]!, rows[i]![c + 1]!);
  }
  if (b.lod < 2) {
    // Painted edge lines (worn: they carry the road's grime).
    b.mat('paint-white');
    b.begin(false, 'ground-marking');
    for (const side of [-1, 1]) {
      const rows: [number, number][] = [];
      for (const q of st) {
        const mk = (off: number): number => {
          const x = q.p[0] + q.n[0] * off;
          const z = q.p[1] + q.n[1] * off;
          const v = b.v(x, y + 0.062 + 0.0004 * Math.abs(off), z, 0, 1, 0, 1, 0, 0, x, -z);
          b.setMask(v, 0.5, 1, 0.5, 0);
          return v;
        };
        rows.push([mk(side * (hw - 0.45) - 0.07), mk(side * (hw - 0.45) + 0.07)]);
      }
      for (let i = 0; i + 1 < rows.length; i++) b.quad(rows[i]![0], rows[i + 1]![0], rows[i + 1]![1], rows[i]![1]);
    }
  }
}

/** Earth berm: an arc about (cx, cz) of radius `r` from a0 to a1, `h` high, tapering to the ground at both ends. */
function berm(b: MeshBuilder, cx: number, cz: number, r: number, a0: number, a1: number, h: number): void {
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
    const row: number[] = [];
    for (const [dr, y, nr] of [
      [-base, -0.5, -0.45],
      [-crest, hh, -0.3],
      [crest, hh, 0.3],
      [base, -0.5, 0.45],
    ] as [number, number, number][]) {
      const rr = r + dr * (0.6 + 0.4 * Math.max(0.2, k));
      const x = cx + rr * c;
      const z = cz - rr * s;
      const l = Math.hypot(nr, 1);
      const v = b.v(x, y, z, (c * nr) / l, 1 / l, (-s * nr) / l, -s, 0, -c, th * r, dr);
      b.setMask(v, 0, y > 0 ? 1 : 0.7, 0.15 + 0.35 * noise2(x / 6, z / 6, 43), 0);
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

export const padGroundworks: SiteGenerator = ({ params }) => {
  const R = numParam(params, 'radius', 165);
  const lobes = numParam(params, 'lobes', 0.06);
  const rIn = numParam(params, 'innerRadius', 40);
  const y = numParam(params, 'height', 0.12);
  // Outline of the graded field: never a circle (earthworks follow what stands on them and what the
  // bulldozers left), always at least (1 - 2.2 lobes) R.
  const outline = (th: number): number => R * (1 + lobes * Math.sin(3 * th + 1.0) + 0.65 * lobes * Math.sin(5 * th + 2.2) + 0.5 * lobes * Math.sin(9 * th + 0.7));
  const pads = parseList(strParam(params, 'pads', '')).map((e) => ({ x: e.n[0]!, z: e.n[1]!, r: e.n[2]! }));
  const roads = strParam(params, 'roads', '')
    .split(';')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      const [path, w] = t.split('@');
      const pts = path!.split('>').map((q) => q.split(',').map(Number) as [number, number]);
      if (pts.length < 2 || pts.some((q) => q.length !== 2 || !Number.isFinite(q[0]) || !Number.isFinite(q[1]))) throw new Error(`pad.groundworks: bad road "${t}"`);
      return { pts, width: Number(w ?? 7) };
    });
  const berms = parseList(strParam(params, 'berms', '')).map((e) => ({ x: e.n[0]!, z: e.n[1]!, r: e.n[2]!, a0: e.n[3]! * DEG, a1: e.n[4]! * DEG, h: e.n[5] ?? 3 }));

  /** Tone of the stone: dust and damp in patches tens of metres across, darker where vehicles run toward the pad. */
  const grime = (x: number, z: number): number => Math.max(0, Math.min(0.5, 0.42 * noise2(x / 31, z / 31, 51) + 0.2 * noise2(x / 9, z / 9, 53) - 0.12));

  const ground = buildModel('pad.groundworks', (b) => {
    const step = b.pick(7, 14, 40);
    b.mat('gravel-fill').masks(0, 1, 0, 0);
    stoneField(b, 0, 0, rIn, outline, y, step, grime, 'stone');
    pads.forEach((p, i) => {
      b.mat('gravel-fill');
      stoneField(b, p.x, p.z, 0.5, (th) => p.r * (1 + 0.07 * Math.sin(3 * th + i) + 0.05 * Math.sin(7 * th + 2 * i)), y - 0.02, step, grime, 'stone');
    });
    for (const r of roads) road(b, r.pts, r.width, y + 0.04, grime);
  });
  const mounds = buildModel('pad.groundworks.berms', (b) => {
    b.mat('gravel-fill').masks(0, 1, 0.3, 0);
    for (const m of berms) berm(b, m.x, m.z, m.r, m.a0, m.a1, m.h);
  });
  const withBerms = berms.length > 0;
  return {
    models: { ground, ...(withBerms ? { berms: mounds } : {}) },
    pose: (_state, emit) => {
      emit('ground', null, null, { castShadow: false, grime: 1 });
      if (withBerms) emit('berms', null, null, { grime: 1 });
    },
  };
};
