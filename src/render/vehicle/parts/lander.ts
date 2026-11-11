/**
 * The lunar lander:
 *   'lander.descent'  descent stage: four tank lobes about a central engine well, wrapped in crinkled
 *                     multi-layer insulation, base frame and outriggers, RCS quads, pressurant bottles,
 *                     ladder, landing radar, landing lights
 *   'lander.ascent'   ascent / service stage: foil-wrapped drum with radiators, RCS quads, CMG housing,
 *                     ladder, a deployable antenna and a fold-down egress platform
 *   'lander.legs'     four articulated legs from the `legs` module: telescoping primary strut (the lower
 *                     piston holds the crush core), two telescoping secondary struts and a foot pad each
 * RCS clusters, legs, lamps and engine mounts are taken from the part definition.
 */
import type { PartDef } from '@/core/contracts/defs';
import type { QuatTuple, Vec3Tuple } from '@/core/math';
import { MeshBuilder, add3, cross3, dot3, len3, lerp3, norm3, polar, scale3, sub3, xf } from '../geom/builder';
import { DEG, Profile, TAU, ball, beam, box, frustum, lathe, pipe, radialFrame, ringSolid, rod } from '../geom/prims';
import type { MatId } from '../materials';
import { lampCandela } from './capsule';
import { band, buildModel, curvedPanel, hash01, noise2, thruster } from './common';
import { Params, type PartGenerator, type PartLight, type PoseInput, type PoseSink } from './types';

/** Quaternion (x, y, z, w) of the frame whose +Y is `dir` and whose +X is as close to `hint` as possible. */
export function quatAlong(dir: Vec3Tuple, hint: Vec3Tuple): QuatTuple {
  const y = norm3(dir);
  let x = sub3(hint, scale3(y, dot3(hint, y)));
  if (dot3(x, x) < 1e-10) x = sub3([0, 0, 1], scale3(y, y[2]));
  x = norm3(x);
  const z = cross3(x, y);
  const m00 = x[0];
  const m01 = y[0];
  const m02 = z[0];
  const m10 = x[1];
  const m11 = y[1];
  const m12 = z[1];
  const m20 = x[2];
  const m21 = y[2];
  const m22 = z[2];
  const tr = m00 + m11 + m22;
  let q: QuatTuple;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/**
 * Insulation blanket: a grid over (s, t) in [0, 1]^2 on a base surface, `sizeU` x `sizeV` metres. The film is
 * loose: it stands off the structure by `puff`, is pulled down to it at stand-off buttons about every 0.36 m
 * and along its taped edges, and sags and bulges between them over decimetres (so the silhouette of a
 * wrapped tank is never a clean cylinder). Normals come from the displaced positions; tangents run along s.
 * The normal map's creases ride on top of this; each panel samples its own part of the map.
 * With `tape`, the panel's far edges (s = 1 and t = 1) carry a tape strip that laps onto its neighbours,
 * and the buttons are modelled (LOD 0). Open sheet (one component per call).
 */
function foil(b: MeshBuilder, nu: number, nv: number, base: (s: number, t: number) => { p: Vec3Tuple; n: Vec3Tuple }, sizeU: number, sizeV: number, seed: number, puff = 0.03, tape: MatId | null = null): void {
  const prev = b.material;
  b.begin(false, 'foil');
  const bu = Math.max(1, Math.round(sizeU / 0.36));
  const bv = Math.max(1, Math.round(sizeV / 0.36));
  const u0 = hash01(seed, 91) * 1.2;
  const v0 = hash01(seed, 92) * 1.2;
  const lift = (s: number, t: number): number => {
    const x = s * sizeU;
    const y = t * sizeV;
    const edge = Math.min(x, sizeU - x, y, sizeV - y);
    // Rounded shoulder from the taped edge up to the pillow over 9 cm (finite slope at the edge).
    const e = Math.min(1, edge / 0.09);
    const shoulder = e * (2 - e);
    // Dimple at the nearest stand-off button.
    const ks = Math.round(s * bu);
    const kt = Math.round(t * bv);
    let pin = 1;
    if (ks > 0 && ks < bu && kt > 0 && kt < bv) {
      const d = Math.hypot(x - (ks / bu) * sizeU, y - (kt / bv) * sizeV);
      pin = 1 - 0.8 * Math.exp(-(d * d) / (2 * 0.06 * 0.06));
    }
    const sag = (noise2(x / 0.32 + seed * 0.37, y / 0.32, 3) - 0.5) * 0.03 + (noise2(x / 0.12, y / 0.12 + seed * 0.21, 5) - 0.5) * 0.009;
    return (puff * pin + sag) * shoulder;
  };
  const at = (s: number, t: number, extra = 0): Vec3Tuple => {
    const q = base(s, t);
    return add3(q.p, scale3(q.n, lift(s, t) + extra));
  };
  const P: Vec3Tuple[][] = [];
  for (let j = 0; j <= nv; j++) {
    const row: Vec3Tuple[] = [];
    for (let i = 0; i <= nu; i++) row.push(at(i / nu, j / nv));
    P.push(row);
  }
  const ids: number[][] = [];
  const frame = (i: number, j: number): { n: Vec3Tuple; t: Vec3Tuple; w: number } => {
    const du = sub3(P[j]![Math.min(nu, i + 1)]!, P[j]![Math.max(0, i - 1)]!);
    const dv = sub3(P[Math.min(nv, j + 1)]![i]!, P[Math.max(0, j - 1)]![i]!);
    let n = cross3(du, dv);
    const ref = base(i / nu, j / nv).n;
    if (dot3(n, ref) < 0) n = scale3(n, -1);
    n = norm3(n);
    const t = norm3(sub3(du, scale3(n, dot3(du, n))));
    // Handedness: v runs along dv.
    return { n, t, w: dot3(cross3(n, t), dv) >= 0 ? 1 : -1 };
  };
  for (let j = 0; j <= nv; j++) {
    const row: number[] = [];
    for (let i = 0; i <= nu; i++) {
      const f = frame(i, j);
      row.push(b.vt(P[j]![i]!, f.n, f.t, u0 + (i / nu) * sizeU, v0 + (j / nv) * sizeV, f.w));
    }
    ids.push(row);
  }
  // Wind the quads so that they face the base normal.
  const a = P[0]![0]!;
  const facing = dot3(cross3(sub3(P[0]![1]!, a), sub3(P[1]![0]!, a)), base(0, 0).n) >= 0;
  const quad = (q0: number, q1: number, q2: number, q3: number): void => {
    if (facing) b.quad(q0, q1, q2, q3);
    else b.quad(q0, q3, q2, q1);
  };
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) quad(ids[j]![i]!, ids[j]![i + 1]!, ids[j + 1]![i + 1]!, ids[j + 1]![i]!);
  if (tape && b.lod < 2) {
    // Tape over the joints to the next panels: a strip 4 cm wide, half on this panel, standing 2 mm proud.
    b.mat(tape);
    const strip = (n: number, point: (k: number, side: number) => { s: number; t: number }): void => {
      let prevIn = -1;
      let prevOut = -1;
      for (let k = 0; k <= n; k++) {
        const pi = point(k, 0);
        const po = point(k, 1);
        const q = base(Math.min(1, po.s), Math.min(1, po.t));
        const along = sub3(at(Math.min(1, pi.s + 1e-3), pi.t), at(Math.max(0, pi.s - 1e-3), pi.t));
        const tan = norm3(sub3(along, scale3(q.n, dot3(along, q.n))));
        const vin = b.vt(at(pi.s, pi.t, 0.002), q.n, tan, pi.s * sizeU, pi.t * sizeV);
        const vout = b.vt(add3(base(po.s, po.t).p, scale3(q.n, 0.002)), q.n, tan, po.s * sizeU, po.t * sizeV);
        if (k > 0) {
          // Wind the strip to face the base normal.
          const pa = b.position(prevIn);
          if (dot3(cross3(sub3(b.position(vin), pa), sub3(b.position(prevOut), pa)), q.n) >= 0) b.quad(prevIn, vin, vout, prevOut);
          else b.quad(prevIn, prevOut, vout, vin);
        }
        prevIn = vin;
        prevOut = vout;
      }
    };
    const ws = 0.02 / sizeU;
    const wt = 0.02 / sizeV;
    strip(Math.max(2, Math.round(nv / 2)), (k, side) => ({ s: side === 0 ? 1 - ws : 1 + ws, t: k / Math.max(2, Math.round(nv / 2)) }));
    strip(Math.max(2, Math.round(nu / 2)), (k, side) => ({ s: k / Math.max(2, Math.round(nu / 2)), t: side === 0 ? 1 - wt : 1 + wt }));
    if (b.lod === 0) {
      b.mat('alu-machined');
      for (let kt = 1; kt < bv; kt++) {
        for (let ks = 1; ks < bu; ks++) {
          const q = base(ks / bu, kt / bv);
          const p = at(ks / bu, kt / bv, -0.001);
          b.at(xf.along(p, add3(p, q.n)), () => frustum(b, 0.013, 0.011, 0, 0.004, 8, 'button'));
        }
      }
    }
  }
  b.mat(prev);
}

/** RCS clusters of a part: thrusters grouped by position. */
function rcsClusters(def: PartDef): { pos: Vec3Tuple; dirs: Vec3Tuple[] }[] {
  const out: { pos: Vec3Tuple; dirs: Vec3Tuple[] }[] = [];
  const m = def.modules.find((x) => x.type === 'rcs');
  if (!m || m.type !== 'rcs') return out;
  for (const t of m.thrusters) {
    let c = out.find((x) => len3(sub3(x.pos, t.pos as Vec3Tuple)) < 0.05);
    if (!c) {
      c = { pos: t.pos as Vec3Tuple, dirs: [] };
      out.push(c);
    }
    if (!c.dirs.some((d) => dot3(d, t.dir as Vec3Tuple) > 0.99)) c.dirs.push(t.dir as Vec3Tuple);
  }
  return out;
}

/** RCS quad: a small housing on a boom from the hull with one bell per firing direction. */
function rcsQuad(b: MeshBuilder, cluster: { pos: Vec3Tuple; dirs: Vec3Tuple[] }, hullR: number, exitR: number, inset = 0): void {
  const phi = Math.atan2(cluster.pos[0], cluster.pos[2]);
  const rad: Vec3Tuple = [Math.sin(phi), 0, Math.cos(phi)];
  // `inset` draws the quad a little inboard of the thrust axis (keeps the hardware inside the part envelope).
  const r = Math.hypot(cluster.pos[0], cluster.pos[2]) - inset;
  const c = { pos: [rad[0] * r, cluster.pos[1], rad[2] * r] as Vec3Tuple, dirs: cluster.dirs };
  const prev = b.material;
  b.mat('alu-machined').masks(0.25, 1, 0.5, 0);
  const core = 0.075 + exitR;
  // The housing is set back so that its outer face stands only a few centimetres beyond the thruster axis.
  const hc = r - (core - 0.045);
  b.at(xf.translate(rad[0] * hc, c.pos[1], rad[2] * hc), () => box(b, core * 2, core * 2, core * 2, [0, 0, 0], 'rcs-housing'));
  if (hc - core > hullR) {
    b.mat('steel-brushed');
    rod(b, [rad[0] * (hullR - 0.03), c.pos[1], rad[2] * (hullR - 0.03)], [rad[0] * (hc - core + 0.01), c.pos[1], rad[2] * (hc - core + 0.01)], 0.04, b.pick(12, 8, 6), 'rcs-boom');
  }
  for (const d of c.dirs) {
    const dn = norm3(d);
    thruster(b, add3(c.pos, scale3(dn, core + 0.11)), dn, exitR, 0.13);
  }
  b.mat(prev);
}

/** Ladder on a hull at azimuth phi: two rails standing off the surface and rungs between them. */
function ladder(b: MeshBuilder, radiusAt: (y: number) => number, phi: number, y0: number, y1: number, half = 0.22): void {
  if (b.lod === 2) return;
  const prev = b.material;
  b.mat('alu-machined').masks(0.3, 1, 0.3, 0);
  const off = 0.09;
  const tan: Vec3Tuple = [Math.cos(phi), 0, -Math.sin(phi)];
  const at = (y: number, side: number, extra = 0): Vec3Tuple => add3(polar(radiusAt(y) + off + extra, phi, y), scale3(tan, side * half));
  for (const side of [-1, 1]) {
    rod(b, at(y0, side), at(y1, side), 0.016, b.pick(8, 6, 4), 'ladder-rail');
    if (b.lod === 0) for (const y of [y0 + 0.05, (y0 + y1) / 2, y1 - 0.05]) rod(b, at(y, side, -off - 0.01), at(y, side), 0.011, 6, 'ladder-post');
  }
  const n = Math.max(2, Math.round((y1 - y0) / 0.3));
  for (let i = 0; i <= n; i++) {
    const y = y0 + 0.04 + ((y1 - y0 - 0.08) * i) / n;
    rod(b, at(y, -1), at(y, 1), 0.012, b.pick(8, 6, 4), 'rung');
  }
  b.mat(prev);
}

// ------------------------------------------------------------------------------------------- descent

export const landerDescent: PartGenerator = ({ def, params }) => {
  const where = `visuals/parts/${def.id}`;
  const P = new Params(params, where);
  const R = def.bounds.radius;
  const H = def.bounds.yMax;
  const tankR = P.num('tankRadius', 1.0);
  const tankD = P.num('tankDistance', R - tankR - 0.1);
  const coreR = P.num('coreRadius', 1.72);
  const lobes = P.num('lobes', 4);
  const wellR = P.num('wellRadius', 0.96);
  const engineNode = def.attachNodes.find((n) => n.id === 'engine');
  const topR = (def.attachNodes.find((n) => n.id === 'top')?.size ?? 4) / 2;
  const y0 = 0.14;
  const y1 = H - 0.12;
  const gold = P.str('foil', 'mli-gold') as MatId;
  const silver = P.str('foilAlt', 'mli-silver') as MatId;
  const dark = P.str('foilDark', 'mli-black') as MatId;
  const ladderPhi = P.num('ladderAzimuthDeg', 180) * DEG;

  /** Plan-view radius of the wrapped body at azimuth phi: the tank lobes over the core. */
  const outline = (phi: number): number => {
    let r = coreR;
    for (let k = 0; k < lobes; k++) {
      const d = phi - (k / lobes) * TAU;
      const sn = Math.sin(d) * tankD;
      if (Math.cos(d) > 0 && Math.abs(sn) < tankR) r = Math.max(r, tankD * Math.cos(d) + Math.sqrt(tankR * tankR - sn * sn));
    }
    return r;
  };
  const outlineNormal = (phi: number): Vec3Tuple => {
    const e = 1e-3;
    const a = polar(outline(phi - e), phi - e, 0);
    const c = polar(outline(phi + e), phi + e, 0);
    // Tangent runs with increasing phi; the outward normal is tangent x up.
    const t = norm3(sub3(c, a));
    return norm3(cross3(t, [0, 1, 0]));
  };
  // Half angle of a lobe where it meets the core.
  let lobeHalf = 0.1;
  while (lobeHalf < Math.PI / lobes && outline(lobeHalf) > coreR + 1e-4) lobeHalf += 0.002;

  const clusters = rcsClusters(def);
  const lightIndex = def.modules.findIndex((m) => m.type === 'light');
  const lampAz = [ladderPhi - 0.5, ladderPhi + 0.5];
  const lampAt = (phi: number): Vec3Tuple => polar(outline(phi) - 0.05, phi, y0 + 0.02);

  const body = buildModel(`${def.id}.body`, (b) => {
    // ---- insulation blankets around the sides
    const rows = b.pick(2, 2, 1);
    const perLobe = b.pick(3, 3, 1);
    let seed = 1;
    for (let k = 0; k < lobes; k++) {
      const c = (k / lobes) * TAU;
      const panels: [number, number, MatId][] = [];
      for (let i = 0; i < perLobe; i++) panels.push([c - lobeHalf + (2 * lobeHalf * i) / perLobe, c - lobeHalf + (2 * lobeHalf * (i + 1)) / perLobe, gold]);
      panels.push([c + lobeHalf, c + TAU / lobes - lobeHalf, silver]);
      for (const [p0, p1, m] of panels) {
        for (let r = 0; r < rows; r++) {
          const ya = y0 + ((y1 - y0) * r) / rows;
          const yb = y0 + ((y1 - y0) * (r + 1)) / rows;
          // Between the tank lobes the lower blanket is black polyimide (the bays that face the engine plume).
          const pm = m === silver && r === 0 && rows > 1 ? dark : m;
          b.mat(pm).masks(0, 1, 0.25 + 0.5 * (1 - r / rows), 0);
          const arc = ((p1 - p0) * (outline(p0) + outline(p1))) / 2;
          foil(
            b,
            b.pick(Math.max(6, Math.round(arc / 0.06)), Math.max(3, Math.round(arc / 0.16)), 2),
            b.pick(Math.max(6, Math.round((yb - ya) / 0.07)), 6, 1),
            (s, t) => {
              const phi = p0 + (p1 - p0) * s;
              return { p: polar(outline(phi), phi, ya + (yb - ya) * t), n: outlineNormal(phi) };
            },
            arc,
            yb - ya,
            seed++ * 31,
            0.03,
            pm === gold ? 'tape-kapton' : 'tape-silver',
          );
        }
      }
    }
    // ---- top and bottom decks
    const deck = (y: number, rIn: number, up: boolean, m: MatId, soot: number): void => {
      b.mat(m).masks(0, 0.9, soot, 0);
      const n = b.pick(96, 48, 16);
      for (let q = 0; q < 4; q++) {
        const p0 = (q / 4) * TAU;
        foil(
          b,
          n / 4,
          b.pick(6, 3, 1),
          (s, t) => {
            const phi = up ? p0 + (TAU / 4) * s : p0 + (TAU / 4) * (1 - s);
            const r = rIn + (outline(phi) - rIn) * t;
            return { p: polar(r, phi, y), n: [0, up ? 1 : -1, 0] };
          },
          (TAU / 4) * 2.2,
          1.5,
          seed++ * 17,
          0.012,
        );
      }
    };
    deck(y1, Math.min(topR - 0.1, coreR - 0.08), true, gold, 0.2);
    deck(y0, wellR, false, 'blanket-silver', 1);

    // ---- mating rings, base frame, engine well and mount
    const segs = b.pick(96, 48, 16);
    b.mat('alu-machined').masks(0.3, 0.85, 0.5, 0);
    ringSolid(b, topR - 0.12, topR, y1 - 0.02, H, segs, 'top-ring');
    ringSolid(b, R - 0.12, R, 0, 0.1, segs, 'base-ring');
    if (b.lod < 2) {
      const spokes = 8;
      for (let i = 0; i < spokes; i++) {
        const phi = (i / spokes) * TAU + TAU / (2 * spokes);
        beam(b, polar(wellR, phi, 0.06), polar(R - 0.1, phi, 0.06), 0.09, 0.07, [0, 1, 0], 'base-spoke');
      }
    }
    b.mat('blanket-silver').masks(0, 0.7, 1, 0);
    const mountY = engineNode ? engineNode.pos[1] : H * 0.65;
    const mountR = engineNode ? engineNode.size / 2 + 0.05 : 0.5;
    // Well wall (faces the engine), thrust cone and the mount pad whose underside is the engine interface.
    const wp = Profile.at(wellR, y0 - 0.02).to(wellR, mountY - 0.35).to(mountR + 0.1, mountY + 0.02);
    wp.pts[0]!.hard = false;
    const wall = new Profile();
    for (const q of [...wp.pts].reverse()) wall.pts.push({ ...q });
    lathe(b, wall, { segs, closed: false, tag: 'well' });
    b.mat('steel-dark').masks(0.2, 0.7, 0.8, 0);
    frustum(b, mountR, mountR + 0.1, mountY, mountY + 0.2, b.pick(32, 16, 8), 'mount');

    // ---- outriggers to the leg hinges on the diagonals (hinge points come with the legs part; the trusses
    // end on the diagonal at the envelope radius)
    if (b.lod < 2) {
      b.mat('alu-machined').masks(0.3, 1, 0.3, 0);
      for (let k = 0; k < lobes; k++) {
        const phi = ((k + 0.5) / lobes) * TAU;
        const tip = polar(P.num('outriggerRadius', R - 0.12), phi, P.num('outriggerY', H * 0.53));
        for (const dy of [-1, 1]) {
          for (const dp of [-0.16, 0.16]) rod(b, polar(coreR - 0.05, phi + dp, H * 0.53 + dy * H * 0.36), tip, 0.035, b.pick(10, 6, 5), 'outrigger');
        }
        rod(b, polar(R - 0.08, phi, 0.08), tip, 0.03, b.pick(10, 6, 5), 'outrigger');
        if (b.lod === 0) b.at(xf.translate(tip[0], tip[1], tip[2]), () => ball(b, 0.07, 0, 12, 8, 0.07, 'node'));
        // Pressurant bottle strapped to the diagonal face.
        b.mat(silver).masks(0, 1, 0.2, 0);
        b.at(xf.translate(...polar(coreR + 0.24, phi, H * 0.82)), () => ball(b, 0.27, 0, b.pick(20, 10, 6), b.pick(12, 6, 4), 0.27, 'bottle'));
        b.mat('alu-machined').masks(0.3, 1, 0.3, 0);
        if (b.lod === 0) b.at(xf.translate(...polar(coreR + 0.24, phi, H * 0.82)), () => band(b, 0.27, 0, 0.03, 0.006, 20, 'strap'));
      }
    }
    // ---- RCS quads, ladder, landing radar
    for (const c of clusters) rcsQuad(b, c, outline(Math.atan2(c.pos[0], c.pos[2])), P.num('rcsExitRadius', 0.05));
    ladder(b, () => outline(ladderPhi), ladderPhi, y0 + 0.1, y1 - 0.05);
    if (b.lod < 2) {
      b.mat('alu-machined').masks(0.2, 1, 0.8, 0);
      const rp = polar(wellR + 0.45, ladderPhi + 0.9, y0 - 0.005);
      b.at(xf.mul(xf.translate(rp[0], rp[1], rp[2]), xf.rotX(Math.PI)), () => {
        box(b, 0.5, 0.05, 0.42, [0, 0.025, 0], 'radar');
        if (b.lod === 0) for (const sx of [-0.12, 0.12]) for (const sz of [-0.1, 0.1]) b.at(xf.translate(sx, 0.05, sz), () => frustum(b, 0.07, 0.085, 0, 0.03, 12, 'horn'));
      });
      b.mat('steel-dark');
      // Landing lamps: a finned housing under the base ring with a deep reflector bowl round the lens.
      for (const phi of lampAz) {
        b.at(xf.mul(xf.translate(...lampAt(phi)), xf.rotX(Math.PI)), () => {
          frustum(b, 0.085, 0.1, 0, 0.05, b.pick(16, 8, 6), 'lamp-body');
          b.mat('alu-machined');
          frustum(b, 0.1, 0.125, 0.05, 0.13, b.pick(16, 8, 6), 'lamp-bowl');
          if (b.lod === 0) for (let i = 0; i < 4; i++) band(b, 0.092, 0.008 + i * 0.011, 0.005, 0.012, 16, 'band');
          b.mat('steel-dark');
        });
      }
    }
  });

  const lamp = buildModel(`${def.id}.lamp`, (b) => {
    b.mat('lamp').masks(0, 1, 0, 0);
    for (const phi of lampAz) b.at(xf.mul(xf.translate(...lampAt(phi)), xf.rotX(Math.PI)), () => frustum(b, 0.086, 0.08, 0.075, 0.085, b.pick(16, 8, 6), 'lens'));
  });

  const pose = (input: PoseInput, emit: PoseSink): void => {
    emit('body', null, null);
    emit('lamp', null, null, { emissive: input.anim.lamp, castShadow: false, cold: true });
  };
  const lights = (input: PoseInput): PartLight[] => {
    const m = def.modules[lightIndex];
    if (!m || m.type !== 'light' || input.anim.lamp <= 0) return [];
    const cd = (lampCandela(m.params) / lampAz.length) * input.anim.lamp;
    // A lamp looks down and a little outward: a spot at its lens whose cone takes in the touchdown area and
    // the legs on its side, never the hull above it.
    return lampAz.map((phi) => {
      const p = lampAt(phi);
      const dir = norm3(polar(Math.sin(25 * DEG), phi, -Math.cos(25 * DEG)));
      return { pos: [p[0], p[1] - 0.1, p[2]] as Vec3Tuple, dir, cone: [20 * DEG, 36 * DEG] as [number, number], radius: 0.09, intensity: [cd, cd * 0.97, cd * 0.9] as Vec3Tuple, range: 40 };
    });
  };
  return { models: { body, lamp }, pose, lights };
};

// -------------------------------------------------------------------------------------------- ascent

export const landerAscent: PartGenerator = ({ def, params }) => {
  const where = `visuals/parts/${def.id}`;
  const P = new Params(params, where);
  const R = def.bounds.radius;
  const H = def.bounds.yMax;
  const skinR = R - P.num('skinInset', 0.07);
  const y0 = 0.13;
  const y1 = H - 0.15;
  const foilMat = P.str('foil', 'mli-silver') as MatId;
  const foilAlt = P.str('foilAlt', 'mli-gold') as MatId;
  const engineNode = def.attachNodes.find((n) => n.id === 'engine');
  const ladderPhi = P.num('ladderAzimuthDeg', 180) * DEG;
  const antennaPhi = P.num('antennaAzimuthDeg', 300) * DEG;
  const clusters = rcsClusters(def);
  const lightIndex = def.modules.findIndex((m) => m.type === 'light');
  const hingeY = H - 0.22;
  const platformHinge = polar(skinR + 0.05, ladderPhi, hingeY);
  const antennaHinge = polar(skinR + 0.04, antennaPhi, H * 0.7);
  const lampAt = polar(skinR + 0.03, ladderPhi + 0.42, H - 0.5);

  const body = buildModel(`${def.id}.body`, (b) => {
    // ---- foil skin in panels, with four flat radiators
    const around = b.pick(12, 12, 6);
    const rows = b.pick(3, 3, 1);
    let seed = 400;
    for (let i = 0; i < around; i++) {
      const p0 = (i / around) * TAU;
      const p1 = ((i + 1) / around) * TAU;
      for (let r = 0; r < rows; r++) {
        const ya = y0 + ((y1 - y0) * r) / rows;
        const yb = y0 + ((y1 - y0) * (r + 1)) / rows;
        b.mat(r === 0 && i % 3 === 1 ? foilAlt : foilMat).masks(0, 1, 0.2 + 0.4 * (1 - r / rows), 0);
        const arc = (p1 - p0) * skinR;
        foil(
          b,
          b.pick(Math.round(arc / 0.055), Math.round(arc / 0.16), 2),
          b.pick(Math.round((yb - ya) / 0.06), 5, 1),
          (s, t) => {
            const phi = p0 + (p1 - p0) * s;
            return { p: polar(skinR, phi, ya + (yb - ya) * t), n: [Math.sin(phi), 0, Math.cos(phi)] };
          },
          arc,
          yb - ya,
          seed++ * 13,
          0.024,
          'tape-silver',
        );
      }
    }
    if (b.lod < 2) {
      b.mat('paint-white').masks(0.1, 1, 0.2, 0);
      for (let i = 0; i < 4; i++) {
        const phi = ((i + 0.5) / 4) * TAU;
        if (Math.abs(((phi - antennaPhi + Math.PI * 3) % TAU) - Math.PI) < 0.3) continue;
        // Radiator panel standing off the foil: a face sheet that follows the hull, the coolant tubes showing
        // through it as ribs, headers at both ends with their feed lines into the hull, an edge frame.
        const rs = skinR + 0.022;
        const rh = H * 0.42;
        const rw = 0.95;
        const ry = H * 0.52;
        curvedPanel(b, rs, phi, ry, rw, rh, 0.028, 'radiator', 0);
        if (b.lod === 0) {
          for (let k = 0; k < 9; k++) curvedPanel(b, rs + 0.028, phi + ((k - 4) * 0.1) / rs, ry, 0.024, rh - 0.18, 0.006, 'radiator-tube', 0.002);
          b.mat('alu-machined');
          for (const s of [-1, 1]) {
            curvedPanel(b, rs + 0.028, phi, ry + s * (rh / 2 - 0.045), rw - 0.05, 0.05, 0.016, 'radiator-header', 0.002);
            curvedPanel(b, rs, phi + (s * (rw / 2 + 0.012)) / rs, ry, 0.024, rh + 0.02, 0.036, 'radiator-frame', 0);
          }
          b.mat('steel-brushed');
          for (const s of [-1, 1]) {
            const y = ry + s * (rh / 2 - 0.045);
            pipe(b, [polar(rs + 0.05, phi + 0.36 / rs, y), polar(rs + 0.05, phi + (rw / 2 + 0.09) / rs, y), polar(skinR - 0.03, phi + (rw / 2 + 0.09) / rs, y)], 0.012, 0.03, { segs: 6, tag: 'radiator-line' });
          }
          b.mat('paint-white');
        }
      }
    }
    // ---- decks, mating rings, engine well and mount
    const segs = b.pick(96, 48, 16);
    const deckSegs = b.pick(64, 32, 12);
    b.mat(foilAlt).masks(0, 0.9, 0.2, 0);
    for (let q = 0; q < 4; q++) foil(b, deckSegs / 4, b.pick(8, 4, 1), (s, t) => ({ p: polar((skinR + 0.01) * t + 0.02 * (1 - t), (q / 4 + s / 4) * TAU, y1 + 0.01), n: [0, 1, 0] }), 3, 2, 900 + q, 0.01);
    const wellR = engineNode ? Math.max(0.5, engineNode.size * 0.9) : 0.5;
    b.mat('blanket-silver').masks(0, 0.9, 1, 0);
    for (let q = 0; q < 4; q++) foil(b, deckSegs / 4, b.pick(6, 3, 1), (s, t) => ({ p: polar(wellR + (skinR + 0.01 - wellR) * t, (q / 4 + (1 - s) / 4) * TAU, y0 - 0.01), n: [0, -1, 0] }), 3, 1.5, 950 + q, 0.008);
    b.mat('alu-machined').masks(0.3, 0.85, 0.4, 0);
    ringSolid(b, R - 0.13, R, y1 - 0.02, H, segs, 'top-ring');
    ringSolid(b, R - 0.13, R, 0, y0 + 0.02, segs, 'base-ring');
    if (engineNode) {
      const my = engineNode.pos[1];
      const mr = engineNode.size / 2 + 0.04;
      b.mat('blanket-silver').masks(0, 0.7, 1, 0);
      const wall = new Profile();
      wall.pts.push({ r: mr + 0.08, y: my + 0.02, hard: false, mat: undefined }, { r: wellR, y: my - 0.3, hard: false, mat: undefined }, { r: wellR, y: y0 - 0.02, hard: false, mat: undefined });
      lathe(b, wall, { segs: deckSegs, closed: false, tag: 'well' });
      b.mat('steel-dark').masks(0.2, 0.7, 0.8, 0);
      frustum(b, mr, mr + 0.08, my, my + 0.16, b.pick(28, 14, 8), 'mount');
    }
    // ---- RCS quads, CMG housing, ladder, lamp housing
    for (const c of clusters) rcsQuad(b, c, skinR, P.num('rcsExitRadius', 0.042), P.num('rcsInset', 0));
    if (b.lod < 2) {
      b.mat('alu-machined').masks(0.25, 1, 0.3, 0);
      b.at(radialFrame(skinR - 0.02, 135 * DEG, H * 0.74), () => {
        box(b, 0.5, 0.12, 0.55, [0, 0.06, 0], 'cmg');
        if (b.lod === 0) for (let i = 0; i < 7; i++) box(b, 0.46, 0.035, 0.012, [0, 0.135, -0.24 + i * 0.08], 'fin');
      });
      b.mat('steel-dark');
      b.at(xf.along(lampAt, add3(lampAt, polar(1, ladderPhi + 0.42, -0.6))), () => frustum(b, 0.06, 0.07, -0.02, 0.06, b.pick(14, 8, 6), 'lamp-body'));
    }
    // Beside the stowed platform, up to its hinge line.
    ladder(b, () => skinR + 0.02, ladderPhi + 0.36, y0 + 0.08, hingeY);
  });

  // Antenna: dish on a boom, hinged at the hull. Model frame: origin at the hinge, +Y along the stowed
  // boom (up the hull), +Z outward.
  const antenna = buildModel(`${def.id}.antenna`, (b) => {
    b.mat('alu-machined').masks(0.3, 1, 0.2, 0);
    rod(b, [0, 0, 0.02], [0, 0.34, 0.02], 0.022, b.pick(10, 6, 5), 'boom');
    if (b.lod < 2) rod(b, [-0.06, 0, 0.02], [0.06, 0, 0.02], 0.03, b.pick(10, 6, 5), 'hinge');
    b.mat('paint-white').masks(0.15, 1, 0.2, 0);
    // Shallow dish stowed face-to-hull (toward -Z); swung out past horizontal it looks up at the sky.
    b.at(xf.mul(xf.translate(0, 0.36, 0.115), xf.rotX(-Math.PI / 2)), () => {
      const n = b.pick(8, 4, 2);
      const p = Profile.at(0, 0);
      p.pts[0]!.hard = false;
      for (let i = 1; i <= n; i++) p.to((0.34 * i) / n, 0.07 * ((i / n) * (i / n)));
      p.hard().corner(0.34, 0.082);
      for (let i = n - 1; i >= 0; i--) p.to((0.34 * i) / n, 0.012 + 0.07 * ((i / n) * (i / n)));
      lathe(b, p.outward(), { segs: b.pick(40, 20, 10), tag: 'dish' });
      if (b.lod === 0) {
        b.mat('alu-machined');
        for (let i = 0; i < 3; i++) rod(b, polar(0.3, (i / 3) * TAU, 0.075), [0, 0.1, 0], 0.006, 6, 'feed-strut');
        frustum(b, 0.03, 0.022, 0.075, 0.105, 10, 'feed');
      }
    });
  });

  // Egress platform: grating hinged at the hull. Model frame: origin at the hinge, stowed hanging toward
  // -Y against the hull, +Z outward.
  const platform = buildModel(`${def.id}.platform`, (b) => {
    const len = P.num('platformLength', 0.85);
    const wid = P.num('platformWidth', 0.8);
    b.mat('grating').masks(0.3, 1, 0.3, 0);
    box(b, wid, len, 0.03, [0, -len / 2 - 0.03, 0.03], 'platform');
    if (b.lod < 2) {
      b.mat('alu-machined');
      for (const sx of [-1, 1]) rod(b, [sx * (wid / 2), -0.03, 0.03], [sx * (wid / 2), -len - 0.03, 0.03], 0.018, b.pick(8, 6, 4), 'toe-rail');
      rod(b, [-wid / 2, -len - 0.03, 0.03], [wid / 2, -len - 0.03, 0.03], 0.018, b.pick(8, 6, 4), 'toe-rail');
      rod(b, [-wid / 2 - 0.02, 0, 0.02], [wid / 2 + 0.02, 0, 0.02], 0.022, b.pick(10, 6, 5), 'hinge');
    }
  });

  const lamp = buildModel(`${def.id}.lamp`, (b) => {
    b.mat('lamp').masks(0, 1, 0, 0);
    b.at(xf.along(lampAt, add3(lampAt, polar(1, ladderPhi + 0.42, -0.6))), () => frustum(b, 0.052, 0.046, 0.06, 0.068, b.pick(14, 8, 6), 'lens'));
  });

  const pose = (input: PoseInput, emit: PoseSink): void => {
    emit('body', null, null);
    const a = input.anim.antenna;
    const t = a * a * (3 - 2 * a);
    // Antenna: frame with +Y up the hull and +Z outward, then swung outward about the hinge (its local X).
    const out = (phi: number): QuatTuple => [0, Math.sin(phi / 2), 0, Math.cos(phi / 2)];
    const swing = (q: QuatTuple, angle: number): QuatTuple => {
      const s = Math.sin(angle / 2);
      const c = Math.cos(angle / 2);
      // q * rotX(angle)
      return [q[3] * s + q[0] * c, q[1] * c + q[2] * s, q[2] * c - q[1] * s, q[3] * c - q[0] * s];
    };
    emit('antenna', antennaHinge, swing(out(antennaPhi), 112 * DEG * t));
    emit('platform', platformHinge, swing(out(ladderPhi), -90 * DEG * t));
    emit('lamp', null, null, { emissive: input.anim.lamp, castShadow: false, cold: true });
  };
  const lights = (input: PoseInput): PartLight[] => {
    const m = def.modules[lightIndex];
    if (!m || m.type !== 'light' || input.anim.lamp <= 0) return [];
    const cd = lampCandela(m.params) * input.anim.lamp;
    const dir = norm3(polar(1, ladderPhi + 0.42, -0.6));
    return [{ pos: add3(lampAt, scale3(dir, 0.1)), dir, cone: [18 * DEG, 30 * DEG], radius: 0.08, intensity: [cd, cd * 0.97, cd * 0.9], range: 30 }];
  };
  return { models: { body, antenna, platform, lamp }, pose, lights };
};

// ---------------------------------------------------------------------------------------------- legs

export interface LegPose {
  hinge: Vec3Tuple;
  foot: Vec3Tuple;
  /** Unit vector hinge -> foot and the strut length. */
  dir: Vec3Tuple;
  length: number;
}

/** Foot position of leg `i` for a deployment fraction and stroke compression (the sim's own rule). */
export function legPose(leg: { hinge: number[]; footDeployed: number[]; footStowed: number[] }, deploy: number, compression: number): LegPose {
  const t = deploy * deploy * (3 - 2 * deploy);
  const hinge = leg.hinge as Vec3Tuple;
  const free = lerp3(leg.footStowed as Vec3Tuple, leg.footDeployed as Vec3Tuple, t);
  const d = sub3(free, hinge);
  const l = len3(d);
  const dir = scale3(d, 1 / l);
  const length = Math.max(0.3, l - Math.max(0, compression));
  return { hinge, foot: add3(hinge, scale3(dir, length)), dir, length };
}

const BROKEN_SPLAY = 30 * DEG;
const BROKEN_PAD_TILT = 27 * DEG;

/**
 * Pose of a leg whose primary strut has failed at the crush core: the upper tube, still held by the
 * secondary struts, has swung `BROKEN_SPLAY` up toward the horizontal about the hinge; the piston has torn
 * out of it and hangs from the tube's mouth as a kinked strut that reaches down to the height at which the
 * foot stood (so it stands on the ground the vessel rests on); the pad lies tilted on its rim.
 */
export function brokenLegPose(lp: LegPose, upperLen: number, lowerLen: number): { upperDir: Vec3Tuple; lowerDir: Vec3Tuple; knee: Vec3Tuple; foot: Vec3Tuple; padUp: Vec3Tuple } {
  const phi = Math.atan2(lp.hinge[0], lp.hinge[2]);
  const er: Vec3Tuple = [Math.sin(phi), 0, Math.cos(phi)];
  // Angle of the strut below the horizontal in the leg's radial plane.
  const th0 = Math.atan2(-lp.dir[1], dot3(lp.dir, er));
  const at = (th: number): Vec3Tuple => [er[0] * Math.cos(th), -Math.sin(th), er[2] * Math.cos(th)];
  const upperDir = at(th0 - BROKEN_SPLAY);
  const knee = add3(lp.hinge, scale3(upperDir, upperLen - 0.25));
  // The piston drops from the knee to the foot's old height, as steeply as its length allows.
  const reach = lowerLen - 0.1;
  const thLow = Math.asin(Math.max(-1, Math.min(1, (knee[1] - lp.foot[1]) / reach)));
  const lowerDir = at(Math.max(thLow, th0 + 8 * DEG));
  const foot = add3(knee, scale3(lowerDir, reach));
  return { upperDir, lowerDir, knee, foot, padUp: [-er[0] * Math.sin(BROKEN_PAD_TILT), Math.cos(BROKEN_PAD_TILT), -er[2] * Math.sin(BROKEN_PAD_TILT)] };
}

export const landerLegs: PartGenerator = ({ def, params }) => {
  const where = `visuals/parts/${def.id}`;
  const P = new Params(params, where);
  const legsIndex = def.modules.findIndex((m) => m.type === 'legs');
  const legsDef = def.modules[legsIndex];
  if (!legsDef || legsDef.type !== 'legs') throw new Error(`${where}: lander.legs needs a legs module`);
  const legs = legsDef.legs;
  const padR = P.num('padRadius', (def.contactPoints?.[0]?.radius ?? 0.4) + 0.05);
  const padDrop = def.contactPoints?.[0]?.radius ?? 0.4;
  const upperLen = P.num('upperLength', 2.7);
  const lowerLen = P.num('lowerLength', 2.25);
  const collar = P.num('collar', 2.55);
  const braceLen = P.num('braceLength', 2.6);
  const anchorR = P.num('anchorRadius', 2.9);
  const anchorY = P.num('anchorY', 0.1);
  const anchorSpread = P.num('anchorSpreadDeg', 28) * DEG;
  const rUp = P.num('strutRadius', 0.085);

  const anchors = (i: number): [Vec3Tuple, Vec3Tuple] => {
    const phi = Math.atan2(legs[i]!.hinge[0]!, legs[i]!.hinge[2]!);
    return [polar(anchorR, phi - anchorSpread, anchorY), polar(anchorR, phi + anchorSpread, anchorY)];
  };

  // Static fittings: hinge clevises and brace anchors.
  const body = buildModel(`${def.id}.body`, (b) => {
    b.mat('alu-machined').masks(0.35, 1, 0.3, 0);
    legs.forEach((leg, i) => {
      const h = leg.hinge as Vec3Tuple;
      const phi = Math.atan2(h[0], h[2]);
      b.at(xf.mul(xf.translate(h[0], h[1], h[2]), xf.rotY(phi)), () => {
        // Local +Z = outward.
        box(b, 0.34, 0.3, 0.16, [0, 0, -0.1], 'hinge-block');
        if (b.lod < 2) {
          for (const sx of [-1, 1]) box(b, 0.04, 0.24, 0.2, [sx * 0.13, 0, 0.04], 'clevis');
          b.mat('steel-bare');
          rod(b, [-0.19, 0, 0.06], [0.19, 0, 0.06], 0.035, b.pick(12, 8, 6), 'hinge-pin');
          b.mat('alu-machined');
        }
      });
      for (const a of anchors(i)) b.at(xf.translate(a[0], a[1], a[2]), () => ball(b, 0.075, 0, b.pick(12, 8, 6), b.pick(8, 5, 4), 0.075, 'anchor'));
    });
  });

  // Primary strut, upper half: origin at the hinge, +Y toward the foot.
  const upper = buildModel(`${def.id}.upper`, (b) => {
    b.mat('alu-machined').masks(0.25, 1, 0.3, 0);
    const p = Profile.at(0, 0.02)
      .corner(rUp * 0.8, 0.02)
      .to(rUp, 0.14)
      .to(rUp, upperLen - 0.12)
      .to(rUp * 1.25, upperLen - 0.1)
      .to(rUp * 1.25, upperLen)
      .hard()
      .corner(rUp * 0.8, upperLen)
      .corner(0, upperLen);
    lathe(b, p, { segs: b.pick(24, 12, 6), tag: 'strut' });
    if (b.lod < 2) {
      b.mat('steel-bare').masks(0.4, 1, 0.3, 0);
      frustum(b, rUp * 1.5, rUp * 1.5, collar - 0.05, collar + 0.05, b.pick(20, 10, 6), 'collar');
      b.mat('mli-gold').masks(0, 1, 0.3, 0);
      // Thermal sleeve over the upper part of the strut.
      const sl = Profile.at(rUp + 0.004, 0.3).to(rUp + 0.014, 0.34).to(rUp + 0.014, collar - 0.45).to(rUp + 0.004, collar - 0.4);
      sl.pts[0]!.hard = false;
      lathe(b, sl, { segs: b.pick(24, 12, 6), closed: false, tag: 'sleeve' });
    }
  });

  // Primary strut, lower piston with the crush-core cartridge: origin at the foot joint, +Y toward the hinge.
  const lower = buildModel(`${def.id}.lower`, (b) => {
    b.mat('steel-bare').masks(0.35, 1, 0.4, 0);
    const r = rUp * 0.72;
    const p = Profile.at(0, 0)
      .corner(r * 0.9, 0)
      .to(r, 0.06)
      .to(r, lowerLen - 0.03)
      .to(r * 0.8, lowerLen)
      .corner(0, lowerLen);
    lathe(b, p, { segs: b.pick(20, 10, 6), tag: 'piston' });
    if (b.lod < 2) {
      // Crush-core cartridge housing with its vented cap, above the foot joint.
      b.mat('alu-machined').masks(0.3, 1, 0.5, 0);
      frustum(b, rUp * 1.05, rUp * 1.05, 0.12, 0.62, b.pick(20, 10, 6), 'crush-core');
      b.mat('steel-dark');
      for (const y of [0.2, 0.37, 0.54]) band(b, rUp * 1.05, y, 0.03, 0.006, b.pick(20, 10, 6), 'core-band');
      b.mat('steel-bare');
      ball(b, rUp * 0.95, 0, b.pick(16, 8, 6), b.pick(10, 6, 4), rUp * 0.95, 'foot-joint');
    }
  });

  // Foot pad: origin at the joint; the dish stands on the ground `padDrop` below it.
  const pad = buildModel(`${def.id}.pad`, (b) => {
    b.mat('alu-machined').masks(0.4, 1, 0.9, 0);
    const n = b.pick(6, 3, 2);
    const p = Profile.at(0, -padDrop);
    p.pts[0]!.hard = false;
    // Underside: shallow dish with an upturned rim; top: cone up to the socket.
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      p.to(padR * t * 0.92, -padDrop + 0.05 * t * t * t);
    }
    p.to(padR, -padDrop + 0.11)
      .hard()
      .corner(padR - 0.02, -padDrop + 0.12)
      .to(padR * 0.55, -padDrop + 0.1)
      .to(0.12, -0.11)
      .to(0.1, -0.02)
      .corner(0, -0.02);
    lathe(b, p, { segs: b.pick(40, 20, 10), tag: 'pad' });
    if (b.lod === 0) {
      // Radial stiffening ribs on the upper face.
      b.mat('alu-machined').masks(0.4, 1, 0.9, 0);
      for (let i = 0; i < 8; i++) {
        const phi = (i / 8) * TAU;
        beam(b, polar(0.13, phi, -0.14), polar(padR * 0.9, phi, -padDrop + 0.125), 0.02, 0.05, [0, 1, 0], 'rib');
      }
      b.mat('mli-gold').masks(0, 1, 0.9, 0);
      const cover = Profile.at(0.14, -0.1).to(padR * 0.5, -padDrop + 0.115);
      cover.pts[0]!.hard = false;
      const up = new Profile();
      for (const q of [...cover.pts].reverse()) up.pts.push({ ...q });
      lathe(b, up, { segs: 32, closed: false, tag: 'pad-foil' });
    }
  });

  // What a failed primary strut shows at its mouth: the crush-core cartridge, split open, with the crushed
  // honeycomb spilling out of it. Origin at the knee, +Y along the piston toward the foot.
  const crushed = buildModel(`${def.id}.crushed`, (b) => {
    b.mat('alu-cast').masks(0.6, 0.8, 0.6, 0);
    // Accordion of crushed cells: a zig-zag column that leans out of the tube's mouth.
    const n = b.pick(9, 5, 2);
    const p = Profile.at(0, -0.1);
    p.corner(rUp * 0.9, -0.1);
    for (let i = 1; i <= n; i++) p.corner(rUp * (i % 2 === 1 ? 1.5 - 0.05 * i : 0.85), -0.1 + (0.5 * i) / n);
    p.corner(0, 0.4);
    lathe(b, p, { segs: b.pick(14, 8, 6), tag: 'crushed-core' });
    if (b.lod < 2) {
      // The torn mouth of the upper tube: four petals bent outward.
      b.mat('alu-machined').masks(0.7, 1, 0.4, 0);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + 0.4;
        beam(b, polar(rUp, a, -0.12), polar(rUp * (2.1 + 0.5 * hash01(i, 77)), a + 0.25, 0.1 + 0.1 * hash01(i, 78)), 0.11, 0.012, [0, 1, 0], 'petal');
      }
    }
  });

  // Secondary struts: tube from the body anchor (+Y toward the collar) and rod from the collar (+Y toward the anchor).
  const braceUpper = buildModel(`${def.id}.braceUpper`, (b) => {
    b.mat('alu-machined').masks(0.25, 1, 0.3, 0);
    frustum(b, 0.045, 0.045, 0.04, braceLen, b.pick(14, 8, 5), 'brace');
    if (b.lod < 2) frustum(b, 0.058, 0.058, braceLen - 0.08, braceLen, b.pick(14, 8, 5), 'gland');
  });
  const braceLower = buildModel(`${def.id}.braceLower`, (b) => {
    b.mat('steel-bare').masks(0.3, 1, 0.3, 0);
    frustum(b, 0.03, 0.03, 0.04, braceLen, b.pick(12, 8, 5), 'brace-rod');
    if (b.lod < 2) ball(b, 0.05, 0, b.pick(12, 8, 6), b.pick(8, 5, 4), 0.05, 'rod-end');
  });

  const pose = (input: PoseInput, emit: PoseSink): void => {
    emit('body', null, null);
    const m = input.modules[legsIndex];
    const state = m && m.type === 'legs' ? m : null;
    legs.forEach((leg, i) => {
      const lp = legPose(leg, state ? state.deploy : 0, state ? (state.compression[i] ?? 0) : 0);
      const phi = Math.atan2(lp.hinge[0], lp.hinge[2]);
      const tan: Vec3Tuple = [Math.cos(phi), 0, -Math.sin(phi)];
      let upperDir = lp.dir;
      if (state && state.broken[i] === true && state.deploy > 0.5) {
        // A broken leg: the primary strut has let go at the crush core. The upper tube, still held by the
        // secondary struts, has splayed outward; the piston has pulled out of it and stands kinked on its
        // foot pad, which lies tilted on the ground.
        const br = brokenLegPose(lp, upperLen, lowerLen);
        upperDir = br.upperDir;
        emit('upper', lp.hinge, quatAlong(br.upperDir, tan));
        emit('crushed', br.knee, quatAlong(br.lowerDir, tan));
        emit('lower', br.foot, quatAlong(scale3(br.lowerDir, -1), tan));
        emit('pad', br.foot, quatAlong(br.padUp, tan));
      } else {
        emit('upper', lp.hinge, quatAlong(lp.dir, tan));
        emit('lower', lp.foot, quatAlong(scale3(lp.dir, -1), tan));
        emit('pad', lp.foot, [0, Math.sin(phi / 2), 0, Math.cos(phi / 2)]);
      }
      const c = add3(lp.hinge, scale3(upperDir, collar));
      for (const a of anchors(i)) {
        const d = norm3(sub3(c, a));
        emit('braceUpper', a, quatAlong(d, tan));
        emit('braceLower', c, quatAlong(scale3(d, -1), tan));
      }
    });
  };
  return { models: { body, upper, lower, pad, crushed, braceUpper, braceLower }, pose };
};
