/**
 * 'capsule.mouldline': the crew capsule exterior, built on the shared CapsuleMouldLineDef section named by
 * the `mouldLine` parameter. Nothing here restates the mould line: profile, heat shield, cone, apex tunnel,
 * wall thickness, windows and hatch are read from that section, and the openings are cut exactly there
 * (the cockpit interior frames the same openings from the same file).
 *
 * Models: 'body' (heat shield, back shell with real openings and their reveals, hatch door, RCS blisters,
 * parachute bay, markings), 'glass' (outer window panes: opaque dark glass facing outward only, drawn
 * without shadow so sunlight still enters the cabin), 'lamp' (exterior light lens).
 *
 * 'capsule.apexCover': the jettisonable cover over the parachute bay.
 */
import type { CapsuleMouldLineDef } from '@/core/contracts/defs';
import type { Vec3Tuple } from '@/core/math';
import { decalSheetOf } from '../decals';
import { MeshBuilder, add3, dot3, norm3, scale3, sub3, xf } from '../geom/builder';
import { DEG, Profile, TAU, bolt, box, frustum, lathe, patchVertex, rod, zipLoops, boltCircle, type LatheRegion } from '../geom/prims';
import { materialDef, type MatId } from '../materials';
import { buildModel, hash01, thruster } from './common';
import type { PartModel } from './types';
import { mouldLine, shellRadius, shieldContour } from './mouldline';
import { Params, staticPose, type PartGenerator, type PartLight, type PoseInput, type PoseSink } from './types';

interface LoopPoint {
  a: number;
  b: number;
  /** Outward normal in the opening plane. */
  oa: number;
  ob: number;
}

/** Counter-clockwise outline of a rounded rectangle (half sizes hw, hh; corner radius rho), starting at (hw, 0). */
export function roundRectLoop(hw: number, hh: number, rho: number, step: number, cornerSegs: number): LoopPoint[] {
  const r = Math.max(1e-4, Math.min(rho, hw, hh));
  const out: LoopPoint[] = [];
  const line = (x0: number, y0: number, x1: number, y1: number, nx: number, ny: number, skipFirst: boolean): void => {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let i = skipFirst ? 1 : 0; i < n; i++) out.push({ a: x0 + ((x1 - x0) * i) / n, b: y0 + ((y1 - y0) * i) / n, oa: nx, ob: ny });
  };
  const arc = (cx: number, cy: number, a0: number): void => {
    for (let i = 0; i < cornerSegs; i++) {
      const t = a0 + ((Math.PI / 2) * i) / cornerSegs;
      out.push({ a: cx + r * Math.cos(t), b: cy + r * Math.sin(t), oa: Math.cos(t), ob: Math.sin(t) });
    }
  };
  line(hw, 0, hw, hh - r, 1, 0, false);
  arc(hw - r, hh - r, 0);
  line(hw - r, hh, -(hw - r), hh, 0, 1, false);
  arc(-(hw - r), hh - r, Math.PI / 2);
  line(-hw, hh - r, -hw, -(hh - r), -1, 0, false);
  arc(-(hw - r), -(hh - r), Math.PI);
  line(-(hw - r), -hh, hw - r, -hh, 0, -1, false);
  arc(hw - r, -(hh - r), 1.5 * Math.PI);
  line(hw, -(hh - r), hw, 0, 1, 0, false);
  return out;
}

/** Distance from the centre to a rounded rectangle along the ray at angle theta. */
export function roundRectRay(theta: number, hw: number, hh: number, rho: number): number {
  const r = Math.max(1e-4, Math.min(rho, hw, hh));
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = Math.min(hw / Math.max(1e-9, Math.abs(c)), hh / Math.max(1e-9, Math.abs(s)));
  const x = Math.abs(t * c);
  const y = Math.abs(t * s);
  if (x <= hw - r + 1e-9 || y <= hh - r + 1e-9) return t;
  // Corner: intersect with the circle about (hw - r, hh - r) in the first quadrant.
  const cx = hw - r;
  const cy = hh - r;
  const ac = Math.abs(c);
  const as = Math.abs(s);
  const bq = ac * cx + as * cy;
  const disc = bq * bq - (cx * cx + cy * cy - r * r);
  return bq + Math.sqrt(Math.max(0, disc));
}

interface Opening {
  id: string;
  phi: number;
  hw: number;
  hh: number;
  rho: number;
  C: Vec3Tuple;
  T: Vec3Tuple;
  S: Vec3Tuple;
  N: Vec3Tuple;
  hatch: boolean;
}

/** The openings of a mould line with their tangent frames (shared by the generator and the unit tests). */
export function capsuleOpenings(ml: CapsuleMouldLineDef): Opening[] {
  const k = (ml.heatShield.maxDiameter / 2 - ml.cone.radiusTop) / (ml.cone.yTop - ml.cone.yBottom);
  const n = Math.hypot(1, k);
  const frame = (id: string, azDeg: number, y: number, w: number, h: number, rho: number, hatch: boolean): Opening => {
    const phi = ((azDeg * DEG) % TAU + TAU) % TAU;
    const er: Vec3Tuple = [Math.sin(phi), 0, Math.cos(phi)];
    const r = shellRadius(ml, y);
    return {
      id,
      phi,
      hw: w / 2,
      hh: h / 2,
      rho,
      C: [r * er[0], y, r * er[2]],
      T: [Math.cos(phi), 0, -Math.sin(phi)],
      S: [(-k * er[0]) / n, 1 / n, (-k * er[2]) / n],
      N: [er[0] / n, k / n, er[2] / n],
      hatch,
    };
  };
  const out = ml.windows.map((w) => frame(w.id, w.azimuthDeg, w.y, w.width, w.shape === 'round' ? w.width : w.height, w.shape === 'round' ? w.width / 2 : w.cornerRadius, false));
  out.push(frame('hatch', ml.hatch.azimuthDeg, ml.hatch.y, ml.hatch.width, ml.hatch.height, ml.hatch.cornerRadius, true));
  return out;
}

/** Point of the back shell reached from an opening's tangent plane at (a, b) along the opening normal. */
export function projectToShell(ml: CapsuleMouldLineDef, o: Opening, a: number, b: number, lift = 0): Vec3Tuple {
  const q0 = add3(add3(o.C, scale3(o.T, a)), scale3(o.S, b));
  const f = (d: number): number => {
    const q = add3(q0, scale3(o.N, d));
    return Math.hypot(q[0], q[2]) - shellRadius(ml, q[1]);
  };
  let d0 = 0;
  let d1 = -0.01;
  let f0 = f(d0);
  let f1 = f(d1);
  for (let i = 0; i < 12 && Math.abs(f1) > 1e-9 && f1 !== f0; i++) {
    const d2 = d1 - (f1 * (d1 - d0)) / (f1 - f0);
    d0 = d1;
    f0 = f1;
    d1 = d2;
    f1 = f(d1);
  }
  return add3(q0, scale3(o.N, d1 + lift));
}

export const capsuleMouldline: PartGenerator = ({ def, params, defs }) => {
  const where = `visuals/parts/${def.id}`;
  const P = new Params(params, where);
  const ml = mouldLine(defs, P.str('mouldLine'));
  const sheet = decalSheetOf(defs);
  const shellMat = P.str('backShell', 'tile-white') as MatId;
  const shieldMat = P.str('heatShield', 'ablator') as MatId;
  const frameW = P.num('windowFrame', 0.022);
  const yB = ml.cone.yBottom;
  const yT = ml.cone.yTop;
  const rB = ml.heatShield.maxDiameter / 2;
  const rTun = ml.apexTunnel.radius;
  const yTop = ml.apexTunnel.yTop;
  const k = (rB - ml.cone.radiusTop) / (yT - yB);
  const slope = Math.hypot(1, k);
  const openings = capsuleOpenings(ml);
  const depth = ml.wallThickness;
  // Grid seam where no opening is near.
  let seam = 0;
  let far = -1;
  for (let c = 0; c < 72; c++) {
    const phi = (c / 72) * TAU;
    let d = Infinity;
    for (const o of openings) d = Math.min(d, Math.abs(((phi - o.phi + Math.PI * 3) % TAU) - Math.PI));
    if (d > far) {
      far = d;
      seam = phi;
    }
  }
  // Back-shell tiles are laid in courses round the cone: every course holds a whole number of tiles of the
  // same width, so the tiles do not narrow toward the apex, and each course is offset against its neighbours.
  const tileSize = P.num('tileSize', 0.18);
  const courses = Math.max(1, Math.round(((yT - yB) * slope) / tileSize));
  const tilesIn: number[] = [];
  const coursePhase: number[] = [];
  for (let c = 0; c < courses; c++) {
    const yMid = yB + ((yT - yB) * (c + 0.5)) / courses;
    tilesIn.push(Math.max(3, Math.round((TAU * shellRadius(ml, yMid)) / tileSize)));
    coursePhase.push(Math.floor(hash01(c, 41) * 8) * tileSize + (c % 2) * 0.5 * tileSize + (hash01(c, 43) - 0.5) * 0.3 * tileSize);
  }
  const rcsDef = def.modules.find((m) => m.type === 'rcs');

  /** Scorch weight of the back shell: streaks that start at the shoulder and thin out toward the apex. */
  const scorch = (phi: number, y: number): number => {
    const up = Math.max(0, 1 - (y - yB) / (yT - yB));
    const streak = 0.45 + 0.55 * hash01(Math.floor((phi / TAU) * 90), 7);
    return Math.min(1, 0.18 + 0.82 * Math.pow(up, 1.6) * streak);
  };

  /**
   * Char weight of the heat shield: even in the stagnation region, combed into radial streaks toward the
   * shoulder where the flow ran outward (three widths of streak, fixed per azimuth).
   */
  const shieldChar = (phi: number, r: number): number => {
    const a = phi / TAU;
    const streak = 0.5 * hash01(Math.floor(a * 18), 11) + 0.3 * hash01(Math.floor(a * 48), 12) + 0.2 * hash01(Math.floor(a * 144), 13);
    const t = Math.min(1, r / rB);
    return 1 - 0.62 * Math.pow(t, 1.4) * (1 - streak);
  };

  /** Azimuth grid shared by the heat shield and the back shell of one LOD (their rims meet vertex for vertex). */
  const azimuths = (b: MeshBuilder): { N: number; dphi: number; phiOf: (i: number) => number; phis: number[] } => {
    const N = b.pick(144, 72, 24);
    const dphi = TAU / N;
    const phiOf = (i: number): number => seam + i * dphi;
    const phis: number[] = [];
    for (let i = 0; i <= N; i++) phis.push(phiOf(i));
    return { N, dphi, phiOf, phis };
  };

  /** Far LOD: the glazing as dark patches of the back shell, and the azimuth grid with lines on their edges. */
  const farGlazing = (): LatheRegion[] =>
    openings.map((o) => {
      const half = (o.hatch ? ml.hatch.window.radius : o.hw) / shellRadius(ml, o.C[1]);
      const hy = (o.hatch ? ml.hatch.window.radius : o.hh) / slope;
      return { phi0: o.phi - half, phi1: o.phi + half, y0: o.C[1] - hy, y1: o.C[1] + hy, mat: 'glass' as MatId, span: ['c0', 'c1'] as [string, string] };
    });
  const farPhis = (): number[] => {
    const N = 24;
    const phis: number[] = [];
    for (let i = 0; i <= N; i++) phis.push((i / N) * TAU);
    for (const r of farGlazing()) {
      for (const bound of [r.phi0, r.phi1]) {
        let best = 1;
        for (let i = 1; i < N; i++) if (Math.abs(phis[i]! - bound) < Math.abs(phis[best]! - bound)) best = i;
        phis[best] = bound;
      }
    }
    return phis.sort((a, c) => a - c);
  };

  /** Heat shield: apex to the maximum diameter, on the azimuth grid of the back shell. */
  const shield = (b: MeshBuilder): void => {
    const phis = b.lod === 2 ? farPhis() : azimuths(b).phis;
    b.mat(shieldMat).masks(0, 1, 1, 0);
    b.begin(false, 'capsule-skin');
    const sc = shieldContour(ml, b.pick(4, 2, 1));
    const sp = Profile.at(sc[0]![0], sc[0]![1]);
    sp.pts[0]!.hard = false;
    for (let i = 1; i < sc.length; i++) sp.to(sc[i]![0], sc[i]![1]);
    lathe(b, sp, { phis, join: true, mask: (_y, phi, r, m) => void (m.soot = shieldChar(phi, r)) });
    if (b.lod === 0) {
      // Compression pads where the shield sat on the adapter.
      b.mat('steel-dark').masks(0.2, 1, 1, 0);
      const padR = rB - 0.09;
      const sy = shieldContour(ml, 4).reduce((best, p) => (Math.abs(p[0] - padR) < Math.abs(best[0] - padR) ? p : best));
      for (let i = 0; i < 6; i++) {
        const phi = (i / 6) * TAU + 0.2;
        b.at(xf.mul(xf.translate(sy[0] * Math.sin(phi), sy[1] - 0.004, sy[0] * Math.cos(phi)), xf.rotX(Math.PI)), () => frustum(b, 0.06, 0.055, 0, 0.012, 16, 'pad'));
      }
    }
  };

  const skin = (b: MeshBuilder, glass: MeshBuilder | null): void => {
    const { N, dphi, phiOf, phis } = azimuths(b);
    // Sub-rows per tile course.
    const sub = b.pick(3, 2, 1);
    const M = courses * sub;
    const yOf = (j: number): number => yB + ((yT - yB) * j) / M;

    // ---- back shell cone as a grid with the opening blocks left out
    b.mat(shellMat).masks(0, 1, 1, 0);
    b.begin(false, 'capsule-skin');
    const vid = new Map<number, number>();
    const coneVertex = (phi: number, y: number, u: number, v: number): number => {
      const r = shellRadius(ml, y);
      const s = Math.sin(phi);
      const c = Math.cos(phi);
      const idx = b.v(r * s, y, r * c, s / slope, k / slope, c / slope, c, 0, -s, u, v);
      b.setMask(idx, 0, 1, scorch(phi, y), 0);
      return idx;
    };
    /** Grid vertex (i, j) as a vertex of tile course c (rows between two courses exist once per course). */
    const grid = (i: number, j: number, c: number): number => {
      const key = (c * (M + 1) + j) * (N + 1) + i;
      let v = vid.get(key);
      if (v === undefined) {
        v = coneVertex(phiOf(i), yOf(j), (i / N) * tilesIn[c]! * tileSize + coursePhase[c]!, (c + (j - c * sub) / sub) * tileSize);
        vid.set(key, v);
      }
      return v;
    };
    /** Texture coordinates round an opening: the close-out tiles are laid square to the opening. */
    const planarUv = (o: Opening, p: Vec3Tuple): [number, number] => {
      const rel = sub3(p, o.C);
      return [dot3(rel, o.T) + 0.31 * tileSize, dot3(rel, o.S) + 0.47 * tileSize];
    };
    const shellPoint = (o: Opening, p: Vec3Tuple): number => {
      let phi = Math.atan2(p[0], p[2]);
      while (phi < seam) phi += TAU;
      while (phi >= seam + TAU) phi -= TAU;
      const [u, v] = planarUv(o, p);
      return coneVertex(phi, p[1], u, v);
    };
    /** Vertex at an opening-plane position (a, b) projected onto the shell. */
    const shellVertex = (o: Opening, a: number, bb: number): number => shellPoint(o, projectToShell(ml, o, a, bb));

    const owner = new Int16Array(N * M).fill(-1);
    const blocks: { o: Opening; i0: number; i1: number; j0: number; j1: number }[] = [];
    if (b.lod < 2) {
      openings.forEach((o, n) => {
        let pMin = Infinity;
        let pMax = -Infinity;
        let yMin = Infinity;
        let yMax = -Infinity;
        for (const q of roundRectLoop(o.hw + frameW, o.hh + frameW, o.rho + frameW, 0.05, 4)) {
          const p = projectToShell(ml, o, q.a, q.b);
          let phi = Math.atan2(p[0], p[2]);
          while (phi < seam) phi += TAU;
          pMin = Math.min(pMin, phi);
          pMax = Math.max(pMax, phi);
          yMin = Math.min(yMin, p[1]);
          yMax = Math.max(yMax, p[1]);
        }
        const margin = 0.02;
        const rr = shellRadius(ml, o.C[1]);
        const i0 = Math.floor((pMin - margin / rr - seam) / dphi);
        const i1 = Math.ceil((pMax + margin / rr - seam) / dphi);
        const j0 = Math.max(0, Math.floor(((yMin - margin / slope - yB) / (yT - yB)) * M));
        const j1 = Math.min(M, Math.ceil(((yMax + margin / slope - yB) / (yT - yB)) * M));
        if (i0 < 0 || i1 > N) throw new Error(`${where}: opening "${o.id}" crosses the grid seam`);
        for (let j = j0; j < j1; j++) {
          for (let i = i0; i < i1; i++) {
            if (owner[j * N + i] !== -1) throw new Error(`${where}: openings "${o.id}" and "${openings[owner[j * N + i]!]!.id}" are too close`);
            owner[j * N + i] = n;
          }
        }
        blocks.push({ o, i0, i1, j0, j1 });
      });
    }
    for (let j = 0; j < M; j++) {
      const c = Math.floor(j / sub);
      for (let i = 0; i < N; i++) {
        if (owner[j * N + i] !== -1) continue;
        b.quad(grid(i, j, c), grid(i + 1, j, c), grid(i + 1, j + 1, c), grid(i, j + 1, c));
      }
    }

    const reveals: { o: Opening; loop: LoopPoint[]; depth: number; mat: MatId }[] = [];
    for (const blk of blocks) {
      const o = blk.o;
      // Border of the block, counter-clockwise seen from outside.
      const border: number[] = [];
      const ang: number[] = [];
      const pushB = (i: number, j: number): void => {
        // The block's own copy of the grid vertex (same position, close-out texture coordinates).
        const s = Math.sin(phiOf(i));
        const c = Math.cos(phiOf(i));
        const r = shellRadius(ml, yOf(j));
        const p: Vec3Tuple = [r * s, yOf(j), r * c];
        const rel = sub3(p, o.C);
        border.push(shellPoint(o, p));
        ang.push(Math.atan2(dot3(rel, o.S), dot3(rel, o.T)));
      };
      for (let i = blk.i0; i <= blk.i1; i++) pushB(i, blk.j0);
      for (let j = blk.j0 + 1; j <= blk.j1; j++) pushB(blk.i1, j);
      for (let i = blk.i1 - 1; i >= blk.i0; i--) pushB(i, blk.j1);
      for (let j = blk.j1 - 1; j > blk.j0; j--) pushB(blk.i0, j);
      // Ring just outside the retainer frame, one vertex per border vertex along the same ray.
      b.mat(shellMat);
      const ring: number[] = border.map((_, n) => {
        const t = roundRectRay(ang[n]!, o.hw + frameW, o.hh + frameW, o.rho + frameW);
        return shellVertex(o, t * Math.cos(ang[n]!), t * Math.sin(ang[n]!));
      });
      for (let n = 0; n < border.length; n++) {
        const m = (n + 1) % border.length;
        b.quad(border[n]!, border[m]!, ring[m]!, ring[n]!);
      }
      // Retainer frame between that ring and the opening edge.
      const loop = roundRectLoop(o.hw, o.hh, o.rho, b.pick(0.03, 0.06, 0.1), b.pick(6, 3, 2));
      const edge = loop.map((q) => shellVertex(o, q.a, q.b));
      b.mat(o.hatch ? 'steel-dark' : 'alu-machined');
      zipLoops(
        b,
        ring,
        ang,
        edge,
        loop.map((q) => Math.atan2(q.b, q.a)),
      );
      reveals.push({ o, loop, depth, mat: 'paint-black' });
    }

    // ---- apex tunnel, its rim and the parachute bay deck
    b.mat(shellMat).masks(0.05, 1, 0.2, 0);
    const deckY = yTop - 0.13;
    const tp = Profile.at(ml.cone.radiusTop, yT)
      .to(rTun, yTop)
      .hard()
      .mat('alu-machined')
      .corner(rTun - 0.06, yTop)
      .mat('steel-brushed')
      .corner(rTun - 0.06, deckY)
      .mat('blanket')
      .corner(0, deckY);
    lathe(b, tp, { phis, join: true });

    // ---- reveals: the cut through the wall, down to the pressure shell
    for (const r of reveals) {
      const o = r.o;
      b.mat(r.mat).masks(0.1, 0.6, 0.1, 0);
      b.begin(false, 'capsule-reveal');
      let run = 0;
      const rows: [number, number][] = [];
      const n = r.loop.length;
      for (let i = 0; i <= n; i++) {
        const q = r.loop[i % n]!;
        const prev = r.loop[(i + n - 1) % n]!;
        if (i > 0) run += Math.hypot(q.a - prev.a, q.b - prev.b);
        const p = projectToShell(ml, o, q.a, q.b);
        const nrm: Vec3Tuple = [-(q.oa * o.T[0] + q.ob * o.S[0]), -(q.oa * o.T[1] + q.ob * o.S[1]), -(q.oa * o.T[2] + q.ob * o.S[2])];
        const tan: Vec3Tuple = [-q.ob * o.T[0] + q.oa * o.S[0], -q.ob * o.T[1] + q.oa * o.S[1], -q.ob * o.T[2] + q.oa * o.S[2]];
        const outer = patchVertex(b, { p, n: nrm, t: tan, u: run, v: 0 });
        const inner = patchVertex(b, { p: add3(p, scale3(o.N, -r.depth)), n: nrm, t: tan, u: run, v: r.depth });
        rows.push([outer, inner]);
      }
      for (let i = 0; i < n; i++) b.quad(rows[i]![0], rows[i + 1]![0], rows[i + 1]![1], rows[i]![1]);

      // ---- glass: windows get an outer pane; the hatch gets its door with a round window
      if (!o.hatch) {
        if (glass) pane(glass, o, r.loop, 0.03);
      } else door(b, glass, o);
    }
  };

  /** Planar outer pane inside a reveal, facing outward only. */
  const pane = (g: MeshBuilder, o: Opening, loop: LoopPoint[], inset: number): void => {
    g.mat('glass').masks(0, 1, 0.3, 0);
    g.begin(false, 'pane');
    const at = (a: number, bb: number): Vec3Tuple => add3(add3(add3(o.C, scale3(o.T, a)), scale3(o.S, bb)), scale3(o.N, -inset));
    const c = g.vt(at(0, 0), o.N, o.T, 0, 0);
    const ids = loop.map((q) => g.vt(at(q.a, q.b), o.N, o.T, q.a, q.b));
    for (let i = 0; i < ids.length; i++) g.tri(c, ids[i]!, ids[(i + 1) % ids.length]!);
  };

  /** Hatch door: follows the shell, with a perimeter gap, edge walls, a retainer ring and a round window. */
  const door = (b: MeshBuilder, glass: MeshBuilder | null, o: Opening): void => {
    const gapW = 0.008;
    const rw = ml.hatch.window.radius;
    const rRing = rw + 0.028;
    const n = b.pick(72, 36, 16);
    const rings = b.pick(9, 5, 2);
    const hw = o.hw - gapW;
    const hh = o.hh - gapW;
    const rho = Math.max(0.01, o.rho - gapW);
    b.mat(shellMat);
    b.begin(false, 'capsule-door');
    const ringsV: number[][] = [];
    const point = (s: number, i: number): [number, number] => {
      const th = (i / n) * TAU;
      const t0 = roundRectRay(th, hw, hh, rho);
      const t = t0 + (rRing - t0) * s;
      return [t * Math.cos(th), t * Math.sin(th)];
    };
    const vAt = (a: number, bb: number): number => {
      const p = projectToShell(ml, o, a, bb);
      const phi = Math.atan2(p[0], p[2]);
      const s = Math.sin(phi);
      const c = Math.cos(phi);
      const idx = b.v(p[0], p[1], p[2], s / slope, k / slope, c / slope, c, 0, -s, a, bb);
      b.setMask(idx, 0.1, 1, scorch(o.phi, p[1]), 0);
      return idx;
    };
    for (let s = 0; s <= rings; s++) {
      const row: number[] = [];
      for (let i = 0; i <= n; i++) {
        const [a, bb] = point(s / rings, i % n);
        row.push(vAt(a, bb));
      }
      ringsV.push(row);
    }
    // Rings run from the outline inward: counter-clockwise outside means outer-to-inner quads wind this way.
    for (let s = 0; s < rings; s++) for (let i = 0; i < n; i++) b.quad(ringsV[s]![i]!, ringsV[s]![i + 1]!, ringsV[s + 1]![i + 1]!, ringsV[s + 1]![i]!);
    // Retainer ring of the window.
    b.mat('alu-machined');
    const inner: number[] = [];
    for (let i = 0; i <= n; i++) {
      const th = ((i % n) / n) * TAU;
      inner.push(vAt(rw * Math.cos(th), rw * Math.sin(th)));
    }
    for (let i = 0; i < n; i++) b.quad(ringsV[rings]![i]!, ringsV[rings]![i + 1]!, inner[i + 1]!, inner[i]!);
    // Edge wall of the door (faces the gap) and the wall of the window bore (faces its centre).
    const wall = (radiusAt: (th: number) => number, inward: boolean, d: number, m: MatId): void => {
      b.mat(m);
      const rows: [number, number][] = [];
      for (let i = 0; i <= n; i++) {
        const th = ((i % n) / n) * TAU;
        const t = radiusAt(th);
        const p = projectToShell(ml, o, t * Math.cos(th), t * Math.sin(th));
        // Outline normal approximated by the ray direction (exact on the circle, within a few degrees on the rounded rectangle's sides).
        const sgn = inward ? -1 : 1;
        const nrm: Vec3Tuple = [sgn * (Math.cos(th) * o.T[0] + Math.sin(th) * o.S[0]), sgn * (Math.cos(th) * o.T[1] + Math.sin(th) * o.S[1]), sgn * (Math.cos(th) * o.T[2] + Math.sin(th) * o.S[2])];
        const tan: Vec3Tuple = [-Math.sin(th) * o.T[0] + Math.cos(th) * o.S[0], -Math.sin(th) * o.T[1] + Math.cos(th) * o.S[1], -Math.sin(th) * o.T[2] + Math.cos(th) * o.S[2]];
        rows.push([patchVertex(b, { p, n: nrm, t: tan, u: th * t, v: 0 }), patchVertex(b, { p: add3(p, scale3(o.N, -d)), n: nrm, t: tan, u: th * t, v: d })]);
      }
      for (let i = 0; i < n; i++) {
        if (inward) b.quad(rows[i]![0], rows[i + 1]![0], rows[i + 1]![1], rows[i]![1]);
        else b.quad(rows[i]![0], rows[i]![1], rows[i + 1]![1], rows[i + 1]![0]);
      }
    };
    wall((th) => roundRectRay(th, hw, hh, rho), false, 0.045, 'steel-dark');
    wall(() => rw, true, 0.05, 'paint-black');
    if (glass) {
      const loop: LoopPoint[] = [];
      const m = b.pick(40, 20, 10);
      for (let i = 0; i < m; i++) {
        const th = (i / m) * TAU;
        loop.push({ a: rw * Math.cos(th), b: rw * Math.sin(th), oa: Math.cos(th), ob: Math.sin(th) });
      }
      pane(glass, o, loop, 0.022);
    }
    if (b.lod === 0) {
      // Hinges on one side, a recessed release handle on the other, fasteners on the window retainer.
      const negS: Vec3Tuple = [-o.S[0], -o.S[1], -o.S[2]];
      /** Frame on the shell at (a, bb): +X tangential, +Y outward, +Z down the slope. */
      const on = (a: number, bb: number, lift = 0): ReturnType<typeof xf.fromAxes> => xf.fromAxes(projectToShell(ml, o, a, bb, lift), o.T, o.N, negS);
      b.mat('steel-dark').masks(0.3, 1, 0.3, 0);
      for (const sb of [-0.26, 0.26]) b.at(on(o.hw + 0.004, sb, -0.004), () => box(b, 0.07, 0.03, 0.13, [0, 0.015, 0], 'hinge'));
      b.mat('alu-machined');
      b.at(on(-o.hw + 0.1, 0, 0), () => {
        rod(b, [0, 0.032, -0.08], [0, 0.032, 0.08], 0.011, 8, 'handle');
        for (const sb of [-0.08, 0.08]) rod(b, [0, -0.004, sb], [0, 0.032, sb], 0.009, 8, 'handle');
      });
      b.mat('steel-bare');
      for (let i = 0; i < 12; i++) {
        const th = (i / 12) * TAU;
        b.at(on((rw + 0.014) * Math.cos(th), (rw + 0.014) * Math.sin(th), 0), () => bolt(b, 0.005, 0.003));
      }
    }
  };

  /** Marking on a patch that follows the shell just above the tiles. */
  const placard = (b: MeshBuilder, name: string, azDeg: number, y: number, height: number): void => {
    const phi = azDeg * DEG;
    const r0 = shellRadius(ml, y);
    const width = height * sheet.aspect(name);
    const [u0, v0, u1, v1] = sheet.uv(name);
    const nu = Math.max(2, Math.round(width / 0.09));
    b.mat('decal').masks(0, 1, 0, 0);
    b.begin(false, 'placard');
    const rows: number[][] = [];
    for (let j = 0; j <= 2; j++) {
      const row: number[] = [];
      for (let i = 0; i <= nu; i++) {
        const yy = y + ((j / 2 - 0.5) * height) / slope;
        const rr = shellRadius(ml, yy) + 0.0025;
        const ph = phi + ((i / nu - 0.5) * width) / r0;
        const s = Math.sin(ph);
        const c = Math.cos(ph);
        const idx = b.v(rr * s, yy, rr * c, s / slope, k / slope, c / slope, c, 0, -s, u0 + ((u1 - u0) * i) / nu, v1 + ((v0 - v1) * j) / 2);
        b.setMask(idx, 0, 1, scorch(ph, yy), 0);
        row.push(idx);
      }
      rows.push(row);
    }
    for (let j = 0; j < 2; j++) for (let i = 0; i < nu; i++) b.quad(rows[j]![i]!, rows[j]![i + 1]!, rows[j + 1]![i + 1]!, rows[j + 1]![i]!);
  };

  const fittings = (b: MeshBuilder): void => {
    if (b.lod === 2) return;
    // ---- parachute mortars and riser fittings on the bay deck (seen after the apex cover is gone)
    const deckY = yTop - 0.13;
    b.mat('steel-brushed').masks(0.2, 0.8, 0.2, 0);
    // Two drogue mortars near the centre, three main-chute mortars around them.
    for (let i = 0; i < 5; i++) {
      const drogue = i < 2;
      const phi = drogue ? i * Math.PI + 0.5 : ((i - 2) / 3) * TAU;
      const rr = drogue ? 0.12 : 0.29;
      const tubeR = drogue ? 0.065 : 0.085;
      b.at(xf.translate(rr * Math.sin(phi), deckY, rr * Math.cos(phi)), () => frustum(b, tubeR, tubeR, 0, 0.1, b.pick(16, 8, 6), 'mortar'));
    }
    // ---- RCS thrusters in blisters on the back shell
    if (rcsDef && rcsDef.type === 'rcs') {
      const clusters = new Map<string, { pos: Vec3Tuple; dirs: Vec3Tuple[] }>();
      for (const t of rcsDef.thrusters) {
        const key = t.pos.map((x) => x.toFixed(2)).join(',');
        const c = clusters.get(key) ?? { pos: t.pos as Vec3Tuple, dirs: [] };
        if (!c.dirs.some((d) => dot3(d, t.dir as Vec3Tuple) > 0.99)) c.dirs.push(t.dir as Vec3Tuple);
        clusters.set(key, c);
      }
      for (const c of clusters.values()) {
        const phi = Math.atan2(c.pos[0], c.pos[2]);
        const y = c.pos[1];
        const r = shellRadius(ml, y);
        const er: Vec3Tuple = [Math.sin(phi), 0, Math.cos(phi)];
        const nrm: Vec3Tuple = [er[0] / slope, k / slope, er[2] / slope];
        const S: Vec3Tuple = [(-k * er[0]) / slope, 1 / slope, (-k * er[2]) / slope];
        const T: Vec3Tuple = [Math.cos(phi), 0, -Math.sin(phi)];
        const base: Vec3Tuple = [r * er[0], y, r * er[2]];
        b.mat('steel-dark').masks(0.2, 1, 0.8, 0);
        b.at(xf.fromAxes(add3(base, scale3(nrm, -0.01)), T, nrm, [-S[0], -S[1], -S[2]]), () => box(b, 0.3, 0.07, 0.3, [0, 0.035, 0], 'rcs-blister'));
        for (const d of c.dirs) {
          // Exit on the blister face the jet leaves through, lifted clear of the tiles.
          const dn = norm3(d);
          const side = sub3(dn, scale3(nrm, dot3(dn, nrm)));
          const exit = add3(add3(base, scale3(nrm, 0.036)), scale3(norm3(side), 0.19));
          thruster(b, exit, norm3(add3(scale3(norm3(side), 0.92), scale3(nrm, 0.38))), 0.032, 0.1);
        }
      }
    }
    if (b.lod === 0) {
      // ---- tape over the back-shell panel joints, handrails by the hatch, umbilical plate, compression pads
      b.mat('blanket-silver').masks(0, 1, 0.5, 0);
      const joints = 8;
      for (let i = 0; i < joints; i++) {
        const phi = seam + ((i + 0.5) / joints) * TAU;
        if (openings.some((o) => Math.abs(((phi - o.phi + Math.PI * 3) % TAU) - Math.PI) < (o.hw + 0.12) / shellRadius(ml, o.C[1]))) continue;
        const a: Vec3Tuple = [(shellRadius(ml, yB + 0.06) + 0.001) * Math.sin(phi), yB + 0.06, (shellRadius(ml, yB + 0.06) + 0.001) * Math.cos(phi)];
        const c: Vec3Tuple = [(shellRadius(ml, yT - 0.05) + 0.001) * Math.sin(phi), yT - 0.05, (shellRadius(ml, yT - 0.05) + 0.001) * Math.cos(phi)];
        b.at(xf.along(a, c, [Math.cos(phi), 0, -Math.sin(phi)]), () => box(b, 0.035, Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), 0.003, [0, Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]) / 2, 0], 'tape'));
      }
      const hatch = openings.find((o) => o.hatch)!;
      b.mat('alu-machined').masks(0.3, 1, 0.3, 0);
      for (const sa of [-1, 1]) {
        const p0 = projectToShell(ml, hatch, sa * (hatch.hw + 0.16), -0.3, 0.045);
        const p1 = projectToShell(ml, hatch, sa * (hatch.hw + 0.16), 0.3, 0.045);
        rod(b, p0, p1, 0.012, 8, 'handrail');
        for (const p of [p0, p1]) rod(b, add3(p, scale3(hatch.N, -0.05)), p, 0.01, 8, 'handrail');
      }
      b.mat('steel-brushed');
      const uphi = 90 * DEG + 0.35;
      const uy = yB + 0.28;
      const ur = shellRadius(ml, uy);
      const uer: Vec3Tuple = [Math.sin(uphi), 0, Math.cos(uphi)];
      b.at(xf.fromAxes([ur * uer[0], uy, ur * uer[2]], [Math.cos(uphi), 0, -Math.sin(uphi)], [uer[0] / slope, k / slope, uer[2] / slope], [(k * uer[0]) / slope, -1 / slope, (k * uer[2]) / slope]), () => {
        box(b, 0.3, 0.02, 0.2, [0, 0.008, 0], 'umbilical');
        b.mat('steel-dark');
        for (const sx of [-0.08, 0.08]) b.at(xf.translate(sx, 0.018, 0), () => frustum(b, 0.035, 0.03, 0, 0.02, 12, 'port'));
      });
      b.mat('steel-bare').masks(0.2, 1, 0.3, 0);
      for (const o of openings) {
        if (o.hatch) continue;
        const pts = roundRectLoop(o.hw + frameW * 0.5, o.hh + frameW * 0.5, o.rho + frameW * 0.5, 0.075, 2);
        for (const q of pts) {
          const p = projectToShell(ml, o, q.a, q.b);
          b.at(xf.along(p, add3(p, o.N)), () => bolt(b, 0.0045, 0.0025));
        }
      }
    }
    // ---- markings
    for (const e of P.str('placards', '').split(';')) {
      const m = /^(\w[\w-]*)@(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/.exec(e.trim());
      if (m) placard(b, m[1]!, Number(m[2]), Number(m[3]), Number(m[4]));
    }
  };

  const lampPos = ((): { p: Vec3Tuple; n: Vec3Tuple } => {
    const hatch = openings.find((o) => o.hatch)!;
    return { p: projectToShell(ml, hatch, 0, hatch.hh + 0.16, 0.012), n: hatch.N };
  })();

  // The body and the glass model are generated together per LOD (the panes sit in the body's reveals).
  const glassLods: MeshBuilder[] = [];
  const body = buildModel(`${def.id}.body`, (b) => {
    const g = new MeshBuilder(b.lod);
    glassLods[b.lod] = g;
    if (b.lod < 2) {
      skin(b, g);
    } else {
      // Far LOD: the back shell as one surface of revolution with dark patches where the glazing is (its rim
      // meets the far LOD of the heat shield).
      b.mat(shellMat).masks(0, 1, 1, 0);
      const p = Profile.at(rB, yB).mark('c0');
      const ys = new Set<number>([yT]);
      for (const o of openings) {
        ys.add(o.C[1] - (o.hatch ? ml.hatch.window.radius : o.hh) / slope);
        ys.add(o.C[1] + (o.hatch ? ml.hatch.window.radius : o.hh) / slope);
      }
      for (const y of [...ys].sort((a, c) => a - c)) p.to(shellRadius(ml, y), y);
      p.hard().mark('c1');
      p.corner(rTun, yTop).corner(0, yTop);
      lathe(b, p, { phis: farPhis(), regions: farGlazing(), closed: false, tag: 'capsule-skin', mask: (y, phi, _r, m) => void (m.soot = scorch(phi, y)) });
    }
    fittings(b);
  });
  // The far LOD of the glass model is empty (the body carries dark patches there).
  const glass = buildFrom(`${def.id}.glass`, glassLods.map((g) => g.build()));
  // The heat shield is a model of its own: it is drawn at the temperature of the ablating surface, which the
  // structure behind it never reaches.
  const shieldModel = buildModel(`${def.id}.shield`, shield);
  const lamp = buildModel(`${def.id}.lamp`, (b) => {
    b.mat('lamp').masks(0, 1, 0, 0);
    b.at(xf.along(lampPos.p, add3(lampPos.p, lampPos.n)), () => {
      b.mat('steel-dark');
      frustum(b, 0.045, 0.045, -0.01, 0.012, b.pick(16, 8, 6), 'lamp-body');
      b.mat('lamp');
      frustum(b, 0.036, 0.03, 0.012, 0.02, b.pick(16, 8, 6), 'lens');
    });
  });

  const lightIndex = def.modules.findIndex((m) => m.type === 'light');
  const lightDef = def.modules[lightIndex];
  const shieldIndex = def.modules.findIndex((m) => m.type === 'heatShield');
  const pose = (input: PoseInput, emit: PoseSink): void => {
    emit('body', null, null);
    const hs = input.modules[shieldIndex];
    emit('shield', null, null, { temperature: hs && hs.type === 'heatShield' ? hs.surfaceTemp : 0 });
    emit('glass', null, null, { castShadow: false, cold: true });
    emit('lamp', null, null, { emissive: input.anim.lamp, castShadow: false, cold: true });
  };
  const lights = (input: PoseInput): PartLight[] => {
    if (!lightDef || lightDef.type !== 'light' || input.anim.lamp <= 0) return [];
    const cd = lampCandela(lightDef.params);
    const p = add3(lampPos.p, scale3(lampPos.n, 0.6));
    return [{ pos: p, intensity: [cd, cd * 0.97, cd * 0.9], range: 40 }];
  };
  return { models: { body, shield: shieldModel, glass, lamp }, pose, lights };
};

/** Luminous intensity (cd) of a lamp from its `lumens` and `beamDeg` parameters. */
export function lampCandela(p: Record<string, number>): number {
  const lumens = p['lumens'] ?? 5000;
  const beam = ((p['beamDeg'] ?? 60) * DEG) / 2;
  return lumens / (TAU * (1 - Math.cos(beam)));
}

function buildFrom(name: string, lods: ReturnType<MeshBuilder['build']>[]): PartModel {
  const ids: MatId[] = [];
  for (const m of lods) for (const id of m.materialIds) if (!ids.includes(id)) ids.push(id);
  for (const m of lods) {
    m.groups = m.groups.map((g) => ({ ...g, material: ids.indexOf(m.materialIds[g.material]!) }));
    m.materialIds = ids;
  }
  return { name, lods, materials: ids.map(materialDef) };
}

export const capsuleApexCover: PartGenerator = ({ def, params }) => {
  const P = new Params(params, `visuals/parts/${def.id}`);
  const R = def.bounds.radius;
  const H = def.bounds.yMax;
  const seat = (def.attachNodes.find((n) => n.id === 'bottom')?.size ?? 2 * R) / 2;
  const skinMat = P.str('skin', 'tile-white') as MatId;
  const body = buildModel(`${def.id}.body`, (b) => {
    b.mat(skinMat).masks(0.1, 1, 0.5, 0);
    const n = b.pick(8, 4, 2);
    // Underside (a shallow cup over the parachute bay), seat ring, side wall, crowned top with a flat land
    // for the escape tower.
    const p = Profile.at(0, 0.06).mat('blanket');
    p.corner(seat - 0.07, 0.06).mat('alu-machined');
    p.corner(seat - 0.07, 0).corner(R, 0).mat(skinMat);
    p.corner(R, H * 0.45);
    for (let i = 1; i <= n; i++) {
      const a = ((Math.PI / 2) * i) / n;
      p.to(seat - 0.02 + (R - seat + 0.02) * Math.cos(a), H * 0.45 + H * 0.55 * Math.sin(a));
    }
    p.hard().corner(0, H);
    lathe(b, p, { segs: b.pick(72, 36, 16), tag: 'apex-cover' });
    if (b.lod === 0) {
      b.mat('steel-bare').masks(0.3, 1, 0.3, 0);
      // Countersunk flush with the land the escape tower sits on.
      boltCircle(b, seat - 0.2, H - 0.008, 8, 0.012, 0.008);
      b.mat('alu-machined');
      for (const phi of [0.8, 0.8 + Math.PI]) rod(b, [0.3 * Math.sin(phi), H, 0.3 * Math.cos(phi)], [0.3 * Math.sin(phi + 0.5), H, 0.3 * Math.cos(phi + 0.5)], 0.008, 6, 'lanyard');
    }
  });
  return { models: { body }, pose: staticPose };
};
