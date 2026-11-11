/**
 * 'engine.liquid': a gimballed liquid rocket engine sized from its definition (exit diameter of the first
 * nozzle, overall length and envelope from PartDef.bounds, mount flange from the 'top' attach node).
 *
 * Part frame: origin at the gimbal mount, the bell hangs toward -Y. Models:
 *   'engine'  everything that is regeneratively cooled or cold: mount, gimbal block, injector dome,
 *             chamber and upper bell (channel-wall banding in the normal map, hat-band stiffeners),
 *             turbopumps, ducts, inlet bellows, gimbal actuators, lines, heat-shield boot
 *   'hotA', 'hotB'  the radiatively cooled lower bell in two bands, instanced with their own temperature
 *             so the bell glows after a burn and cools from the lip inward
 * All three rotate together about the mount by the gimbal angles of the engine module.
 */
import type { QuatTuple, Vec3Tuple } from '@/core/math';
import { MeshBuilder, polar, xf } from '../geom/builder';
import { DEG, Profile, TAU, arcPath, bolt, boltCircle, box, frustum, lathe, pipe, rod, torus, tube } from '../geom/prims';
import type { MatId } from '../materials';
import { band, buildModel } from './common';
import { Params, type PartGenerator, type PoseInput, type PoseSink } from './types';

interface Contour {
  /** Distance below the mount (m), inner and outer radius. */
  x: number[];
  rin: number[];
  rout: number[];
}

export const engineLiquid: PartGenerator = ({ def, params }) => {
  const where = `visuals/parts/${def.id}`;
  const P = new Params(params, where);
  const engine = def.modules.find((m) => m.type === 'engine');
  if (!engine || engine.type !== 'engine' || !engine.nozzles[0]) throw new Error(`${where}: engine.liquid needs an engine module with a nozzle`);
  const top = def.attachNodes.find((n) => n.id === 'top');
  const L = -def.bounds.yMin;
  const Re = engine.nozzles[0].exitDiameter / 2;
  const s = Re / 0.95;
  const expansion = P.num('expansion', 34);
  const Rt = Re / Math.sqrt(expansion);
  const Rc = Rt * P.num('contraction', 1.7);
  const mountR = (top ? top.size / 2 : Re * 0.6) * 0.97;
  const pumps = P.num('pumps', 2);
  const hotFrom = P.num('hotFrom', 0.72);
  const hotScale = P.num('hotScale', 1);
  const bootR = P.num('bootRadius', 0);
  const bootY = P.num('bootY', 0);
  const bellMat = P.str('bell', 'nozzle-wall') as MatId;
  const extMat = P.str('extension', 'nozzle-ext') as MatId;
  const bands = P.num('bands', 7);
  // Seconds of full-throttle firing that soot the engine completely (0 = it burns clean). The soot of the
  // engine's own exhaust settles inside the chamber and bell only; the outside stays bare metal.
  const sootSeconds = P.num('sootSeconds', 60);
  const innerSoot = sootSeconds > 0 ? 1 : 0;

  // Stations (x = distance below the mount).
  const xI = 0.1 + 0.11 * L; // injector face
  const Lc = 0.09 * L; // cylindrical chamber
  const conv = 1.2 * Rc;
  const xT = xI + Lc + conv; // throat
  const Lb = L - xT; // bell
  const thetaN = 33 * DEG;
  const thetaE = P.num('exitAngleDeg', 9) * DEG;

  /** Inner radius of the bell at distance t (0..1) along it: Rao parabola as a quadratic Bezier. */
  const bell = (t: number): [number, number] => {
    const p0: [number, number] = [0, Rt * 1.01];
    const p2: [number, number] = [Lb, Re - 0.012 * s];
    // Control point: intersection of the entry and exit tangents.
    const tn = Math.tan(thetaN);
    const te = Math.tan(thetaE);
    const cx = (p2[1] - p0[1] - te * p2[0]) / (tn - te);
    const c: [number, number] = [Math.max(0.02 * Lb, Math.min(0.9 * Lb, cx)), 0];
    c[1] = p0[1] + tn * c[0];
    const a = (1 - t) * (1 - t);
    const b = 2 * t * (1 - t);
    const d = t * t;
    return [a * p0[0] + b * c[0] + d * p2[0], a * p0[1] + b * c[1] + d * p2[1]];
  };

  const contour = (b: MeshBuilder): Contour => {
    const nb = b.pick(34, 14, 5);
    const nc = b.pick(8, 4, 2);
    const c: Contour = { x: [], rin: [], rout: [] };
    const push = (x: number, rin: number, wall: number): void => {
      c.x.push(x);
      c.rin.push(rin);
      c.rout.push(rin + wall);
    };
    push(xI, Rc, 0.035 * s);
    push(xI + Lc, Rc, 0.035 * s);
    for (let i = 1; i <= nc; i++) {
      // Convergent: cosine blend from the chamber to the throat.
      const t = i / nc;
      const r = Rt + (Rc - Rt) * (0.5 + 0.5 * Math.cos(Math.PI * t));
      push(xI + Lc + conv * t, r, (0.035 + 0.02 * Math.sin(Math.PI * t)) * s);
    }
    for (let i = 1; i <= nb; i++) {
      // Denser rings near the throat where the curvature is.
      const t = Math.pow(i / nb, 1.35);
      const [bx, br] = bell(t);
      push(xT + bx, br, (0.03 * (1 - t) + 0.011) * s);
    }
    return c;
  };

  /** Bell wall between contour indices i0..i1 as a closed band; `capTop` closes onto the axis as the chamber. */
  const rInAt = (c: Contour, x: number): number => {
    for (let i = 0; i + 1 < c.x.length; i++) {
      if (x <= c.x[i + 1]!) {
        const t = (x - c.x[i]!) / (c.x[i + 1]! - c.x[i]!);
        return c.rin[i]! + (c.rin[i + 1]! - c.rin[i]!) * Math.max(0, Math.min(1, t));
      }
    }
    return c.rin[c.rin.length - 1]!;
  };

  const wallBand = (b: MeshBuilder, c: Contour, i0: number, i1: number, outer: (i: number) => MatId, inner: MatId, segs: number, top: boolean): void => {
    let p: Profile;
    if (top) {
      // Injector face (seen from below), inner wall down, lip, outer wall up, injector dome to the axis.
      p = Profile.at(0, -c.x[i0]!).mat(inner);
      p.corner(c.rin[i0]!, -c.x[i0]!);
    } else {
      p = Profile.at(c.rin[i0]!, -c.x[i0]!).mat(inner);
    }
    for (let i = i0 + 1; i <= i1; i++) p.to(c.rin[i]!, -c.x[i]!);
    p.hard().mat('steel-dark');
    p.corner(c.rout[i1]!, -c.x[i1]!);
    for (let i = i1 - 1; i >= i0; i--) {
      p.mat(outer(i));
      p.to(c.rout[i]!, -c.x[i]!);
    }
    if (top) {
      p.hard().mat('alu-cast');
      const n = b.pick(6, 3, 2);
      const r0 = c.rout[i0]!;
      const h = 0.75 * r0;
      for (let k = 1; k <= n; k++) {
        const a = ((Math.PI / 2) * k) / n;
        p.to(r0 * Math.cos(a), -c.x[i0]! + h * Math.sin(a));
      }
    } else {
      p.hard().mat('steel-dark');
      p.corner(c.rin[i0]!, -c.x[i0]!).close();
    }
    lathe(b, p, {
      segs,
      tag: 'bell',
      // The gas side (injector face, chamber and bell wall) takes the soot; the outside takes none.
      mask: (y, _phi, r, m) => {
        const x = -y;
        const gasSide = x >= c.x[i0]! - 1e-6 && r < (rInAt(c, x) + rOutAt(c, x)) / 2;
        m.soot = gasSide ? innerSoot : 0;
      },
    });
  };

  const bellSegs = (b: MeshBuilder): number => b.pick(80, 36, 14);
  const split = (c: Contour): [number, number] => {
    // First contour index of the radiative extension and of its lower band.
    let iA = c.x.length - 1;
    for (let i = 0; i < c.x.length; i++) {
      if ((c.x[i]! - xT) / Lb >= hotFrom) {
        iA = i;
        break;
      }
    }
    iA = Math.min(iA, c.x.length - 3);
    const iB = Math.min(c.x.length - 2, Math.round((iA + c.x.length - 1) / 2));
    return [Math.max(2, iA), Math.max(3, iB)];
  };
  const rOutAt = (c: Contour, x: number): number => {
    for (let i = 0; i + 1 < c.x.length; i++) {
      if (x <= c.x[i + 1]!) {
        const t = (x - c.x[i]!) / (c.x[i + 1]! - c.x[i]!);
        return c.rout[i]! + (c.rout[i + 1]! - c.rout[i]!) * Math.max(0, Math.min(1, t));
      }
    }
    return c.rout[c.rout.length - 1]!;
  };

  const main = (b: MeshBuilder): void => {
    const c = contour(b);
    const [iA] = split(c);
    const segs = bellSegs(b);
    b.mat(bellMat).masks(0.05, 1, 0, 0);
    const xJ = c.x[iA]!;
    // Chamber jacket is plain alloy down to the throat, channel wall below.
    wallBand(b, c, 0, iA, (i) => (c.x[i]! < xT - conv * 0.4 ? 'inconel' : bellMat), 'copper', segs, true);

    // ---- mount, gimbal block and bearing
    b.mat('steel-dark').masks(0.2, 0.9, 0, 0);
    frustum(b, mountR, mountR, -0.05 * s - 0.01, 0, b.pick(40, 20, 10), 'mount');
    if (b.lod < 2) {
      frustum(b, 0.17 * s, 0.2 * s, -(xI - 0.75 * c.rout[0]!) - 0.02, -0.05 * s, b.pick(24, 12, 8), 'gimbal');
      b.mat('steel-bare');
      const yb = -(0.05 * s + 0.5 * (xI - 0.75 * c.rout[0]! - 0.05 * s));
      rod(b, [-0.24 * s, yb, 0], [0.24 * s, yb, 0], 0.055 * s, b.pick(16, 8, 6), 'trunnion');
      rod(b, [0, yb, -0.24 * s], [0, yb, 0.24 * s], 0.055 * s, b.pick(16, 8, 6), 'trunnion');
      if (b.lod === 0) boltCircle(b, mountR * 0.86, -0.05 * s - 0.01, 16, 0.018 * s + 0.004, 0.012, true);
    }

    // ---- stiffener hat bands, throat jacket ring, manifolds
    if (b.lod < 2) {
      b.mat('steel-dark').masks(0.15, 1, 0, 0);
      const nBands = b.pick(bands, Math.ceil(bands / 2), 0);
      for (let k = 0; k < nBands; k++) {
        const x = xT + Lb * (0.06 + (hotFrom - 0.1) * ((k + 0.5) / nBands));
        if (x > xJ - 0.03) break;
        band(b, rOutAt(c, x), -x, 0.035 * s + 0.01, 0.014 * s + 0.004, segs, 'hatband');
      }
      band(b, rOutAt(c, xT), -xT, 0.09 * s, 0.03 * s, segs, 'throat-ring');
      b.mat('inconel').masks(0.1, 1, 0, 0);
      // Coolant inlet manifold at the joint to the extension, collector under the injector.
      torus(b, rOutAt(c, xJ - 0.05 * s) + 0.035 * s, 0.045 * s, -(xJ - 0.06 * s), segs, b.pick(10, 6, 4), 'manifold');
      torus(b, c.rout[0]! + 0.03 * s, 0.04 * s, -(xI + 0.03), b.pick(48, 24, 10), b.pick(10, 6, 4), 'manifold');
      if (b.lod === 0) {
        b.mat('steel-bare').masks(0.25, 1, 0, 0);
        const rj = rOutAt(c, xJ) + 0.012 * s;
        for (let i = 0; i < 48; i++) {
          const phi = (i / 48) * TAU;
          b.at(xf.along(polar(rj, phi, -xJ + 0.012), polar(rj + 1, phi, -xJ + 0.012 + 0.4), [0, 1, 0]), () => bolt(b, 0.008 * s + 0.003, 0.008));
        }
        boltCircle(b, c.rout[0]! * 0.82, -xI + 0.75 * c.rout[0]! * Math.sin(Math.acos(0.82)), 20, 0.012 * s + 0.003, 0.01);
      }
    }

    // ---- turbopumps, preburners and ducts
    const rp = 0.19 * s;
    const pumpR = Rc + 0.07 * s + rp;
    const pumpTop = 0.08 * s + 0.05;
    const pumpLen = Math.min(0.3 * L, xT - pumpTop - 0.02);
    if (b.lod < 2) {
      for (let k = 0; k < pumps; k++) {
        const phi = k * Math.PI + 20 * DEG;
        const scaleK = k === 0 ? 1 : 0.86;
        const r = rp * scaleK;
        b.at(xf.translate(...polar(pumpR, phi, -pumpTop)), () => {
          // Stacked housings: inlet, inducer, volute, turbine, preburner.
          const H = pumpLen;
          b.mat('alu-cast').masks(0.1, 0.9, 0, 0);
          const p = Profile.at(0, 0)
            .corner(r * 0.55, 0)
            .corner(r * 0.55, -0.1 * H)
            .to(r * 0.8, -0.14 * H)
            .to(r * 0.8, -0.26 * H)
            .to(r, -0.3 * H)
            .to(r, -0.44 * H)
            .to(r * 0.72, -0.5 * H)
            .mat('steel-dark')
            .to(r * 0.72, -0.6 * H)
            .to(r * 0.92, -0.64 * H)
            .mat('inconel')
            .to(r * 0.92, -0.86 * H)
            .to(r * 0.6, -0.95 * H)
            .to(r * 0.42, -H)
            .corner(0, -H)
            .outward();
          lathe(b, p, { segs: b.pick(28, 14, 8), tag: 'pump' });
          if (b.lod === 0) {
            b.mat('steel-bare');
            boltCircle(b, r * 0.9, -0.3 * H, 14, 0.009 * s + 0.003, 0.008);
            boltCircle(b, r * 0.86, -0.64 * H, 14, 0.009 * s + 0.003, 0.008);
          }
        });
        // Discharge duct from the volute to the injector collector.
        const side = polar(pumpR - r * 0.95 * 0.3, phi, -(pumpTop + 0.37 * pumpLen));
        const tangent = polar(1, phi + Math.PI / 2, 0);
        const out: Vec3Tuple = [side[0] + tangent[0] * r * 1.25, side[1], side[2] + tangent[2] * r * 1.25];
        b.mat(k === 0 ? 'steel-brushed' : 'inconel').masks(0.1, 0.95, 0, 0);
        pipe(b, [side, out, [out[0] * 0.55, -(xI - 0.02), out[2] * 0.55], polar(c.rout[0]! * 0.7, phi + 0.9, -(xI - 0.35 * c.rout[0]!))], 0.055 * s, 0.14 * s, { segs: b.pick(12, 8, 6), tag: 'duct' });
        // Hot-gas duct from the turbine to the injector.
        const tb = polar(pumpR - r * 0.3, phi, -(pumpTop + 0.75 * pumpLen));
        b.mat('inconel');
        pipe(b, [tb, polar(pumpR * 0.55, phi - 0.35, -(pumpTop + 0.78 * pumpLen)), polar(c.rout[0]! * 0.95, phi - 0.6, -(xI + Lc * 0.4))], 0.07 * s, 0.16 * s, { segs: b.pick(12, 8, 6), tag: 'duct' });
        // Propellant inlet with a gimbal bellows up to the stage.
        const inR = r * 0.5;
        const top0 = polar(pumpR, phi, -pumpTop);
        const top1 = polar(Math.min(pumpR * 1.05, def.bounds.radius - inR - 0.02), phi, -0.02 - 0.4 * inR);
        b.mat('steel-bare').masks(0.1, 1, 0, 0.4);
        const n = b.pick(28, 10, 4);
        const path: Vec3Tuple[] = [];
        for (let i = 0; i <= n; i++) path.push([top0[0] + ((top1[0] - top0[0]) * i) / n, top0[1] + ((top1[1] - top0[1]) * i) / n, top0[2] + ((top1[2] - top0[2]) * i) / n]);
        tube(b, path, (i, m) => inR * (b.lod === 0 && i > m * 0.25 && i < m * 0.8 ? 1 + 0.09 * (i % 2 === 0 ? 1 : -1) : 1), { segs: b.pick(16, 10, 6), tag: 'bellows' });
      }
      // Regenerative coolant feed: from the second pump (or the collector) down the bell to the inlet manifold.
      const phiF = (pumps > 1 ? Math.PI : 0) + 62 * DEG;
      b.mat('steel-brushed').masks(0.1, 1, 0, 0);
      const feed: Vec3Tuple[] = [polar(c.rout[0]! + 0.09 * s, phiF, -(xI + 0.1 * Lc))];
      for (const f of [0.5, 0.8, 0.95]) {
        const x = xI + (xJ - xI) * f;
        feed.push(polar(rOutAt(c, x) + 0.075 * s, phiF, -x));
      }
      feed.push(polar(rOutAt(c, xJ - 0.06 * s) + 0.03 * s, phiF, -(xJ - 0.06 * s)));
      pipe(b, feed, 0.04 * s, 0.1 * s, { segs: b.pick(10, 6, 5), tag: 'feed' });
    }

    // ---- gimbal actuators
    if (b.lod < 2) {
      for (const phi of [110 * DEG, 200 * DEG]) {
        const low = polar(rOutAt(c, xT - conv * 0.5) + 0.05 * s, phi, -(xT - conv * 0.5));
        const high = polar(mountR * 0.92, phi, -0.04 * s - 0.03);
        const mid: Vec3Tuple = [low[0] + (high[0] - low[0]) * 0.55, low[1] + (high[1] - low[1]) * 0.55, low[2] + (high[2] - low[2]) * 0.55];
        b.mat('steel-dark').masks(0.2, 0.95, 0, 0);
        rod(b, high, mid, 0.05 * s, b.pick(14, 8, 6), 'actuator');
        b.mat('steel-bare');
        rod(b, mid, low, 0.026 * s, b.pick(12, 8, 6), 'actuator-rod');
        if (b.lod === 0) {
          b.mat('steel-dark');
          b.at(xf.translate(low[0], low[1], low[2]), () => box(b, 0.09 * s, 0.07 * s, 0.09 * s, [0, 0, 0], 'lug'));
          b.at(xf.translate(high[0], high[1], high[2]), () => box(b, 0.1 * s, 0.06 * s, 0.1 * s, [0, 0, 0], 'lug'));
        }
      }
    }

    // ---- small lines, igniter, harness and sensor boxes
    if (b.lod === 0) {
      b.mat('steel-bare').masks(0.1, 1, 0, 0.3);
      for (let k = 0; k < 5; k++) {
        const phi0 = (k / 5) * TAU + 0.4;
        const x0 = xI + Lc * (0.2 + 0.15 * k);
        const pts: Vec3Tuple[] = [polar(c.rout[0]! + 0.06 * s, phi0, -(xI - 0.1 * s))];
        for (const a of arcPath(c.rout[0]! + 0.05 * s + 0.012 * k * s, -x0, phi0, phi0 + 1.5 + 0.3 * k, 8)) pts.push(a);
        const xe = xT + Lb * (0.1 + 0.1 * k);
        pts.push(polar(rOutAt(c, xe) + 0.03 * s, phi0 + 1.6 + 0.3 * k, -xe));
        pipe(b, pts, 0.009 * s + 0.003, 0.05 * s, { segs: 6, tag: 'line' });
      }
      b.mat('rubber').masks(0, 1, 0, 0);
      const hp: Vec3Tuple[] = [];
      for (let i = 0; i <= 30; i++) {
        const t = i / 30;
        const x = xI - 0.05 + (xT + Lb * 0.3 - xI) * t;
        hp.push(polar(Math.max(rOutAt(c, x), c.rout[0]!) + 0.04 * s, 4.2 + 0.5 * Math.sin(t * 5), -x));
      }
      tube(b, hp, 0.012 * s + 0.004, { segs: 6, tag: 'harness' });
      b.mat('alu-machined').masks(0.2, 1, 0, 0);
      for (const [phi, x] of [
        [4.25, xI + Lc * 0.6],
        [1.1, xT - conv * 0.2],
      ] as const) {
        const o = polar(Math.max(rOutAt(c, x), Rc) + 0.07 * s, phi, -x);
        b.at(xf.mul(xf.translate(o[0], o[1], o[2]), xf.rotY(phi)), () => box(b, 0.12 * s, 0.09 * s, 0.05 * s, [0, 0, 0], 'sensor'));
      }
      // Torch igniter on the injector dome.
      b.mat('steel-bare');
      rod(b, polar(c.rout[0]! * 0.45, 2.4, -(xI - 0.6 * c.rout[0]!)), polar(c.rout[0]! * 0.75, 2.4, -(xI - 1.1 * c.rout[0]!) - 0.02), 0.03 * s, 10, 'igniter');
    }

    // ---- flexible heat-shield boot between the engine and the stage's base closeout
    if (bootR > 0 && b.lod < 2) {
      b.mat('blanket').masks(0, 0.8, 1, 0);
      const x0 = xT + 0.02;
      const r0 = rOutAt(c, x0) + 0.02 * s;
      const p = Profile.at(r0, -x0);
      p.pts[0]!.hard = false;
      const folds = b.pick(7, 3, 1);
      for (let i = 1; i <= folds * 2; i++) {
        const t = i / (folds * 2);
        const r = r0 + (bootR - r0) * t;
        const y = -x0 + (bootY + x0) * t + (i % 2 === 1 ? -0.035 : 0.02) * s * (1 - 0.3 * t);
        p.to(r, y);
      }
      lathe(b, p, { segs: b.pick(64, 28, 12), closed: false, tag: 'boot' });
    }
  };

  const hot = (which: 0 | 1) => (b: MeshBuilder): void => {
    const c = contour(b);
    const [iA, iB] = split(c);
    const i0 = which === 0 ? iA : iB;
    const i1 = which === 0 ? iB : c.x.length - 1;
    const segs = bellSegs(b);
    b.mat(extMat).masks(0.05, 1, 0, 0);
    wallBand(b, c, i0, i1, () => extMat, extMat, segs, false);
    if (b.lod < 2) {
      b.mat('steel-dark').masks(0.1, 1, 0, 0);
      const x = (c.x[i0]! + c.x[i1]!) / 2;
      band(b, rOutAt(c, x), -x, 0.03 * s + 0.008, 0.012 * s + 0.003, segs, 'hatband');
      if (which === 1) band(b, rOutAt(c, c.x[i1]! - 0.02 * s), -(c.x[i1]! - 0.02 * s), 0.03 * s + 0.008, 0.012 * s + 0.004, segs, 'lip-ring');
    }
  };

  const lodPixels = [P.num('lod1Pixels', 200), P.num('lod2Pixels', 44)];
  const models = {
    engine: buildModel(`${def.id}.engine`, main, lodPixels),
    hotA: buildModel(`${def.id}.hotA`, hot(0), lodPixels),
    hotB: buildModel(`${def.id}.hotB`, hot(1), lodPixels),
  };

  const engineIndex = def.modules.findIndex((m) => m.type === 'engine');
  const pose = (input: PoseInput, emit: PoseSink): void => {
    const m = input.modules[engineIndex];
    let rot: QuatTuple | null = null;
    if (m && m.type === 'engine' && (m.gimbal[0] !== 0 || m.gimbal[1] !== 0)) {
      // Rotation about X then Z by the two gimbal angles (small angles commute to first order).
      const hx = m.gimbal[0] / 2;
      const hz = m.gimbal[1] / 2;
      const sx = Math.sin(hx);
      const cx = Math.cos(hx);
      const sz = Math.sin(hz);
      const cz = Math.cos(hz);
      rot = [sx * cz, -sx * sz, cx * sz, cx * cz];
    }
    const T = input.anim.nozzleTemp;
    const glow = T > 300 ? 260 + (T - 260) * hotScale : 0;
    emit('engine', null, rot);
    emit('hotA', null, rot, { temperature: glow > 0 ? 260 + (glow - 260) * 0.8 : 0 });
    emit('hotB', null, rot, { temperature: glow });
  };
  return { models, pose, sootSeconds };
};
