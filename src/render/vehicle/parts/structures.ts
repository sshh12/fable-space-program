/**
 * Structural parts between the stages and around them:
 *   'stage.interstage'  cylindrical or conical interstage: composite skin, isogrid interior, vents,
 *                       separation joint, pusher springs
 *   'stage.ring'        adapter / separation rings, optionally with a seat that follows a capsule mould line
 *   'motor.pack'        solid separation / ullage motors in pods, one per nozzle of the part's engine module
 *   'rcs.pod'           aft attitude-control pod with its thrusters
 *   'pad.clamp'         hold-down clamp with a retracting arm
 * Radii come from the attach-node sizes of the definition, heights from PartDef.bounds.
 */
import type { PartDef } from '@/core/contracts/defs';
import type { QuatTuple, Vec3Tuple } from '@/core/math';
import { decalSheetOf } from '../decals';
import { MeshBuilder, add3, norm3, polar, scale3, xf } from '../geom/builder';
import { DEG, Profile, TAU, arcPath, beam, bolt, boltRing, bottle, box, extrude, frustum, lathe, phisWith, pipe, radialFrame, rectPoly, ringSolid, rod, tube, type LatheRegion, type MaskOut } from '../geom/prims';
import { isMatId, type MatId } from '../materials';
import { accessDoor, band, bandRegion, buildModel, decalRegion, parseList, regionBounds, regionHeights, stringers, surfaceFrame, thruster, umbilicalPlate, type Surface } from './common';
import { mouldLine, shieldY } from './mouldline';
import { Params, staticPose, type PartGenerator, type PoseInput, type PoseSink } from './types';

const mat = (id: string, where: string): MatId => {
  if (!isMatId(id)) throw new Error(`${where}: unknown material "${id}"`);
  return id;
};

const nodeRadius = (def: PartDef, id: string, fallback: number): number => {
  const n = def.attachNodes.find((x) => x.id === id);
  return n ? n.size / 2 : fallback;
};

/** Louvred vent on a cylinder / cone wall: the frame leans with the wall. */
function louvre(b: MeshBuilder, s: Surface, phi: number, y: number, w: number, h: number): void {
  if (b.lod === 2) return;
  const prev = b.material;
  b.at(surfaceFrame(s, phi, y, -0.006), () => {
    // Local +Y = outward normal, +X = up the wall, +Z = tangential.
    b.mat('steel-brushed');
    box(b, h + 0.06, 0.018, w + 0.06, [0, 0.009, 0], 'vent-frame');
    b.mat('steel-dark');
    box(b, h, 0.02, w, [0, 0.012, 0], 'vent');
    if (b.lod === 0) {
      b.mat('steel-brushed');
      const n = Math.max(3, Math.round(h / 0.06));
      for (let i = 0; i < n; i++) {
        const x = -h / 2 + (h * (i + 0.5)) / n;
        b.at(xf.mul(xf.translate(x, 0.026, 0), xf.rotZ(-0.6)), () => box(b, (h / n) * 0.9, 0.006, w - 0.02, [0, 0, 0], 'slat'));
      }
    }
  });
  b.mat(prev);
}

export const stageInterstage: PartGenerator = ({ def, params, defs }) => {
  const sheet = decalSheetOf(defs);
  const where = `visuals/parts/${def.id}`;
  const P = new Params(params, where);
  const Rb = nodeRadius(def, 'bottom', def.bounds.radius);
  const Rt = nodeRadius(def, 'top', def.bounds.radius);
  const H = def.bounds.yMax;
  const wall = P.num('wall', 0.05);
  const skin = mat(P.str('skin', 'carbon'), where);
  const inner = mat(P.str('inner', 'primer'), where);
  const rAt = (y: number): number => Rb + ((Rt - Rb) * y) / H;
  const slope = Math.hypot(Rt - Rb, H) / H;

  const regions: LatheRegion[] = [];
  for (const e of parseList(P.str('bands', ''))) regions.push(bandRegion(mat(e.name, where), e.n[0]!, e.n[1]!, e.n[2]!, e.n[3]!, ['skin0', 'skin1']));
  for (const e of parseList(P.str('decals', ''))) regions.push(decalRegion(sheet, e.name, rAt(e.n[1]!), e.n[0]!, e.n[1]!, e.n[2]! / slope, e.flags.includes('rot'), ['skin0', 'skin1']));

  const body = buildModel(`${def.id}.body`, (b) => {
    const segs = b.pick(144, 64, 20);
    const use = b.lod < 2 ? regions : regions.filter((r) => r.mat !== 'decal');
    const p = Profile.at(Rb - wall, 0).mat('alu-machined');
    p.corner(Rb, 0).mark('skin0').mat(skin);
    const n = b.pick(6, 3, 1);
    for (let i = 1; i <= n; i++) p.to(rAt((H * i) / n), (H * i) / n);
    p.hard().mark('skin1').mat('alu-machined');
    p.corner(Rt - wall, H).mat(inner);
    p.corner(Rb - wall, 0).close();
    p.splitAtY('skin0', 'skin1', regionHeights(use));
    b.mat(skin);
    lathe(b, p, {
      phis: phisWith(segs, regionBounds(use)),
      regions: use,
      tag: 'shell',
      mask: (y: number, _phi: number, r: number, m: MaskOut) => {
        const outer = r > rAt(y) - 1e-4;
        m.soot = outer ? 0.2 : 0.75;
        m.ao = outer ? 1 : 0.6;
        m.wear = outer && (y < 0.02 || y > H - 0.02) ? 0.4 : 0;
      },
    });

    // ---- end flanges (the mating rings of the stack) and the separation joint
    b.mat('alu-machined').masks(0.3, 0.85, 0.5, 0);
    ringSolid(b, Rb - 0.12, Rb - wall + 0.002, 0, 0.05, segs, 'flange');
    ringSolid(b, Rt - 0.12, Rt - wall + 0.002, H - 0.05, H, segs, 'flange');
    if (b.lod < 2) {
      b.mat('steel-bare').masks(0.3, 1, 0.3, 0);
      band(b, rAt(H - 0.06), H - 0.06, 0.09, 0.016, segs, 'sep-joint');
      band(b, rAt(0.06), 0.06, 0.09, 0.014, segs, 'frame');
      if (b.lod === 0) {
        const nb = Math.round((TAU * Rt) / 0.16);
        boltRing(b, rAt(H - 0.06) + 0.014, H - 0.06, nb, 0.012, 0.009);
        boltRing(b, rAt(0.06) + 0.012, 0.06, Math.round((TAU * Rb) / 0.2), 0.012, 0.009);
      }
    }

    // ---- isogrid on the inside
    const rows = Math.max(2, Math.round((H * slope) / P.num('gridPitch', 0.5)));
    const nodes = Math.round((TAU * Rb) / P.num('gridPitch', 0.5) / 1.1);
    if (b.lod < 2) {
      b.mat(inner).masks(0.15, 0.7, 0.75, 0);
      const y0 = 0.1;
      const y1 = H - 0.1;
      const yRow = (j: number): number => y0 + ((y1 - y0) * j) / rows;
      const rIn = (y: number): number => rAt(y) - wall;
      for (let j = 0; j <= rows; j++) ringSolid(b, rIn(yRow(j)) - 0.045, rIn(yRow(j)) + 0.002, yRow(j) - 0.011, yRow(j) + 0.011, b.pick(segs, 48, 0), 'iso-ring');
      if (b.lod === 0) {
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < nodes; i++) {
            const phi = ((i + 0.5 * (j % 2)) / nodes) * TAU;
            for (const sgn of [-1, 1]) {
              const phi2 = phi + (sgn * Math.PI) / nodes;
              const a = polar(rIn(yRow(j)) - 0.021, phi, yRow(j));
              const c = polar(rIn(yRow(j + 1)) - 0.021, phi2, yRow(j + 1));
              beam(b, a, c, 0.042, 0.016, [Math.sin(phi), 0, Math.cos(phi)], 'iso-rib');
            }
          }
        }
      }
    }

    // ---- vents, doors, umbilical, separation springs and pyro line
    const vents = P.num('vents', 8);
    b.masks(0.2, 1, 0.3, 0);
    for (let i = 0; i < vents; i++) louvre(b, rAt, (i / vents) * TAU + P.num('ventPhase', 22.5) * DEG, H * 0.42, 0.5, 0.26);
    b.mat(skin);
    for (const e of parseList(P.str('doors', ''))) accessDoor(b, rAt, e.n[0]! * DEG, e.n[1]!, e.n[2]!, e.n[3]!);
    for (const e of parseList(P.str('umbilicals', ''))) if (b.lod < 2) umbilicalPlate(b, rAt, e.n[0]! * DEG, e.n[1]!, e.n[2]!, e.n[3]!, e.n[4] ?? 4);
    if (b.lod === 0) {
      const springs = P.num('springs', 8);
      for (let i = 0; i < springs; i++) {
        const phi = ((i + 0.5) / springs) * TAU;
        b.at(xf.translate(...polar(Rt - wall - 0.09, phi, H - 0.42)), () => {
          b.mat('steel-dark').masks(0.2, 0.8, 0.6, 0);
          frustum(b, 0.06, 0.06, 0, 0.3, 14, 'spring');
          b.mat('steel-bare');
          frustum(b, 0.035, 0.035, 0.3, 0.41, 12, 'pusher');
          b.mat('steel-dark');
          box(b, 0.16, 0.05, 0.14, [0, -0.02, 0], 'bracket');
        });
      }
      b.mat('steel-brushed').masks(0.1, 0.8, 0.6, 0);
      tube(b, arcPath(Rt - wall - 0.03, H - 0.16, 0, TAU, 96), 0.012, { loop: true, segs: 6, tag: 'pyro-line' });
    }
  });
  return { models: { body }, pose: staticPose };
};

export const stageRing: PartGenerator = ({ def, params, defs }) => {
  const where = `visuals/parts/${def.id}`;
  const P = new Params(params, where);
  const Rb = P.num('rBottom', nodeRadius(def, 'bottom', def.bounds.radius));
  const Rt = P.num('rTop', nodeRadius(def, 'top', def.bounds.radius));
  const H = def.bounds.yMax;
  const wall = P.num('wall', 0.04);
  const skin = mat(P.str('skin', 'alu-machined'), where);
  const inner = mat(P.str('inner', 'primer'), where);
  const seatKey = P.str('seat', '');
  const ml = seatKey ? mouldLine(defs, seatKey) : null;
  const nStr = P.num('stringers', 0);
  const fittings = P.num('fittings', 8);
  const flange = P.num('flange', 0.1);
  const fs = P.num('fittingScale', 1);
  const rAt = (y: number): number => Rb + ((Rt - Rb) * y) / H;

  const body = buildModel(`${def.id}.body`, (b) => {
    const segs = b.pick(128, 56, 18);
    const p = Profile.at(Rb - flange, 0).mat('alu-machined');
    p.corner(Rb, 0).mat(skin);
    if (ml) {
      // The top follows the capsule's heat shield from the rim inward, 3 mm clear of it.
      const clear = 0.003;
      const rimR = ml.heatShield.maxDiameter / 2;
      p.corner(rimR, H - clear).mat('rubber');
      const n = b.pick(8, 4, 2);
      const rIn = rimR - P.num('seatWidth', 0.22);
      for (let i = 1; i <= n; i++) {
        const r = rimR + ((rIn - rimR) * i) / n;
        p.to(r, H + shieldY(ml, r) - ml.heatShield.maxDiameterY - clear);
      }
      p.hard().mat(inner);
      p.corner(rIn, 0.05);
      p.corner(Rb - flange, 0.05).mat('alu-machined');
    } else {
      p.corner(Rt, H).mat('alu-machined');
      p.corner(Rt - flange, H);
      p.corner(Rt - flange, H - 0.045).mat(inner);
      p.corner(Rt - wall, H - 0.045);
      p.corner(Rb - wall, 0.045);
      p.corner(Rb - flange, 0.045).mat('alu-machined');
    }
    p.corner(Rb - flange, 0).close();
    b.mat(skin).masks(0.15, 1, 0.3, 0);
    lathe(b, p, { segs, tag: 'shell', mask: (y: number, _phi: number, r: number, m: MaskOut) => void (m.ao = r > rAt(Math.min(H, Math.max(0, y))) - 0.005 ? 1 : 0.65) });
    if (b.lod === 2) return;
    if (nStr > 0) {
      b.mat(skin).masks(0.2, 1, 0.3, 0);
      stringers(b, rAt(0.1), 0.1, rAt(H - 0.1), H - 0.1, b.pick(nStr, nStr / 2, 0), 0.05, 0.035);
    }
    b.mat('steel-bare').masks(0.3, 1, 0.3, 0);
    band(b, rAt(H - 0.05), H - 0.05, 0.07, 0.014, segs, 'clamp-band');
    band(b, rAt(0.05), 0.05, 0.07, 0.012, segs, 'frame');
    // Separation fittings: bolt catchers / spring housings around the top.
    for (let i = 0; i < fittings; i++) {
      const phi = ((i + 0.5) / fittings) * TAU;
      b.at(surfaceFrame(rAt, phi, H - 0.12, -0.005), () => {
        b.mat('steel-dark').masks(0.3, 1, 0.3, 0);
        box(b, 0.16 * fs, 0.07 * fs, 0.14 * fs, [0, 0.035 * fs, 0], 'fitting');
        if (b.lod === 0) {
          b.mat('steel-bare');
          b.at(xf.translate(0, 0.07 * fs, 0), () => frustum(b, 0.035 * fs, 0.03 * fs, 0, 0.03 * fs, 12, 'catcher'));
          for (const sz of [-1, 1]) b.at(xf.translate(-0.05 * fs, 0.07 * fs, sz * 0.045 * fs), () => bolt(b, 0.012 * fs, 0.008 * fs));
        }
      });
    }
    if (b.lod === 0) {
      b.mat('steel-bare').masks(0.3, 1, 0.3, 0);
      boltRing(b, rAt(0.05) + 0.012, 0.05, Math.round((TAU * Rb) / 0.18), 0.011, 0.008);
    }
    for (const e of parseList(P.str('umbilicals', ''))) umbilicalPlate(b, rAt, e.n[0]! * DEG, e.n[1]!, e.n[2]!, e.n[3]!, e.n[4] ?? 4);
  });
  return { models: { body }, pose: staticPose };
};

export const motorPack: PartGenerator = ({ def, params }) => {
  const where = `visuals/parts/${def.id}`;
  const P = new Params(params, where);
  const engine = def.modules.find((m) => m.type === 'engine');
  if (!engine || engine.type !== 'engine') throw new Error(`${where}: motor.pack needs an engine module`);
  const caseR = P.num('caseRadius', 0.105);
  const caseLen = P.num('caseLength', 0.62);
  const nozzleLen = P.num('nozzleLength', 0.2);
  const podMat = mat(P.str('pod', 'paint-white'), where);
  const skinR = P.num('skinRadius', def.bounds.radius - 0.25);

  const collarR = P.num('collarRadius', 0);

  const body = buildModel(`${def.id}.body`, (b) => {
    if (collarR > 0) {
      // Mounting collar around the structure the motors are strapped to.
      b.mat('steel-brushed').masks(0.25, 1, 0.8, 0);
      ringSolid(b, collarR, collarR + P.num('collarThickness', 0.035), P.num('collarY0', -0.1), P.num('collarY1', 0.1), b.pick(48, 24, 10), 'collar');
    }
    for (const n of engine.nozzles) {
      const d = norm3(n.dir as Vec3Tuple);
      const exit = n.pos as Vec3Tuple;
      const throat = add3(exit, scale3(d, -nozzleLen));
      const head = add3(throat, scale3(d, -caseLen));
      const phi = Math.atan2(exit[0], exit[2]);
      const radial: Vec3Tuple = [Math.sin(phi), 0, Math.cos(phi)];
      b.at(xf.along(head, throat, radial), () => {
        // Case with domed ends, clamp bands and the igniter boss; nozzle with a throat insert.
        b.mat(podMat).masks(0.15, 1, 0.9, 0);
        b.at(xf.translate(0, caseR * 0.6, 0), () => bottle(b, caseR, caseLen - caseR * 1.2, caseR * 0.6, b.pick(20, 10, 6), 'case'));
        if (b.lod < 2) {
          b.mat('steel-bare').masks(0.3, 1, 0.9, 0);
          for (const f of [0.22, 0.78]) band(b, caseR, caseLen * f, 0.03, 0.006, b.pick(20, 10, 6), 'strap');
          frustum(b, caseR * 0.3, caseR * 0.22, -0.03, 0.01, 10, 'igniter');
        }
        b.mat('phenolic').masks(0, 1, 1, 0);
        const re = n.exitDiameter / 2;
        const p = Profile.at(0, caseLen - 0.01)
          .corner(caseR * 0.5, caseLen - 0.01)
          .to(caseR * 0.36, caseLen + nozzleLen * 0.18)
          .to(re * 0.62, caseLen + nozzleLen * 0.6)
          .to(re, caseLen + nozzleLen)
          .hard()
          .corner(re - 0.008, caseLen + nozzleLen)
          .to(re * 0.55, caseLen + nozzleLen * 0.55)
          .to(caseR * 0.2, caseLen + nozzleLen * 0.2)
          .to(0, caseLen + nozzleLen * 0.22);
        lathe(b, p, { segs: b.pick(20, 10, 6), tag: 'nozzle' });
      });
      if (b.lod < 2) {
        // Saddles that tie the case to the skin.
        b.mat('steel-dark').masks(0.3, 0.9, 0.7, 0);
        for (const f of [0.25, 0.75]) {
          const c = add3(head, scale3(d, caseLen * f));
          const r = Math.hypot(c[0], c[2]);
          const depth = Math.max(0.04, r - skinR + 0.01);
          b.at(radialFrame(skinR - 0.01, phi, c[1]), () => box(b, 0.07, depth, caseR * 1.9, [0, depth / 2, 0], 'saddle'));
        }
      }
    }
  });
  return { models: { body }, pose: staticPose, sootSeconds: P.num('sootSeconds', 2) };
};

export const rcsPod: PartGenerator = ({ def, params }) => {
  const where = `visuals/parts/${def.id}`;
  const P = new Params(params, where);
  const rcs = def.modules.find((m) => m.type === 'rcs');
  if (!rcs || rcs.type !== 'rcs') throw new Error(`${where}: rcs.pod needs an rcs module`);
  const hx = P.num('halfDepth', 0.33);
  const hy = P.num('halfHeight', 0.36);
  const hz = P.num('halfWidth', 0.4);
  const exitR = P.num('exitRadius', 0.055);
  const shell = mat(P.str('skin', 'steel-brushed'), where);
  const extra = def.modules.filter((m) => m.type === 'engine').flatMap((m) => (m.type === 'engine' ? m.nozzles : []));

  const body = buildModel(`${def.id}.body`, (b) => {
    b.mat(shell).masks(0.25, 1, 0.5, 0);
    // Housing: chamfered prism along Y; +X is outboard.
    extrude(b, rectPoly(hx, hz, 0.07).map(([x, z]) => [x, z] as [number, number]), -hy, hy, false, 'housing');
    if (b.lod < 2) {
      b.mat('steel-bare').masks(0.3, 1, 0.5, 0);
      box(b, 0.02, hy * 1.5, hz * 1.4, [hx + 0.008, 0, 0], 'cover');
      if (b.lod === 0) for (const sy of [-1, 1]) for (const sz of [-1, 1]) b.at(xf.mul(xf.translate(hx + 0.018, sy * hy * 0.65, sz * hz * 0.6), xf.rotZ(-Math.PI / 2)), () => bolt(b, 0.012, 0.008));
    }
    // One thruster per direction: the exit stands proud of the housing face it fires from.
    const seen = new Set<string>();
    const all = [...rcs.thrusters.map((t) => ({ dir: t.dir as Vec3Tuple, r: exitR, off: 0 })), ...extra.map((n) => ({ dir: n.dir as Vec3Tuple, r: n.exitDiameter / 2, off: 0.14 }))];
    for (const t of all) {
      const d = norm3(t.dir);
      const key = `${d.map((x) => x.toFixed(2)).join(',')}|${t.off}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const reach = Math.abs(d[0]) * hx + Math.abs(d[1]) * hy + Math.abs(d[2]) * hz;
      const centre: Vec3Tuple = [0.08 + t.off * (1 - Math.abs(d[0])), 0, t.off * Math.abs(d[1])];
      const exit = add3(centre, scale3(d, reach + 0.11));
      thruster(b, exit, d, t.r, 0.2);
    }
  });
  return { models: { body }, pose: staticPose };
};

export const padClamp: PartGenerator = ({ def, params }) => {
  const where = `visuals/parts/${def.id}`;
  const P = new Params(params, where);
  const H = def.bounds.yMax;
  const reach = P.num('reach', def.bounds.radius);
  const swing = P.num('swingDeg', 52) * DEG;
  const pivot: Vec3Tuple = [0, H - 0.72, 0.18];

  // Part frame: +Z points away from the vehicle; the arm reaches toward -Z and holds the stage's base
  // post from below at y = H.
  const body = buildModel(`${def.id}.body`, (b) => {
    b.mat('paint-grey').masks(0.25, 1, 0.9, 0);
    box(b, 1.16, 0.12, 1.56, [0, 0.06, 0.02], 'base');
    // Welded pedestal: two side plates and a spine.
    const col: [number, number][] = [
      [-0.3, 0.12],
      [0.62, 0.12],
      [0.5, H - 1.0],
      [0.34, H - 0.52],
      [-0.02, H - 0.52],
      [-0.3, H - 1.3],
    ];
    for (const sx of [-1, 1]) {
      // Side plate in the (z, y) plane: extrude along X with the polygon given as (z, y).
      b.at(xf.fromAxes([sx * 0.26, 0, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]), () => extrude(b, col, -0.035, 0.035, false, 'plate'));
    }
    box(b, 0.46, H - 1.5, 0.08, [0, 0.12 + (H - 1.5) / 2, 0.5], 'spine');
    box(b, 0.46, 0.08, 0.5, [0, H - 1.25, 0.2], 'shelf');
    if (b.lod < 2) {
      // Hydraulic release cylinder and the pivot pin.
      b.mat('steel-dark').masks(0.2, 1, 0.9, 0);
      rod(b, [0, 0.35, 0.42], [0, H - 1.35, 0.1], 0.11, b.pick(18, 10, 6), 'cylinder');
      b.mat('steel-bare');
      rod(b, [0, H - 1.35, 0.1], [0, H - 0.95, -0.02], 0.055, b.pick(14, 8, 6), 'ram');
      rod(b, [-0.34, pivot[1], pivot[2]], [0.34, pivot[1], pivot[2]], 0.07, b.pick(18, 10, 6), 'pin');
      if (b.lod === 0) {
        b.mat('steel-bare').masks(0.3, 1, 0.9, 0);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.at(xf.translate(sx * 0.46, 0.12, 0.02 + sz * 0.62), () => bolt(b, 0.04, 0.035));
        b.mat('paint-yellow');
        box(b, 1.18, 0.03, 0.1, [0, 0.135, -0.7], 'stripe');
        // Gussets between the base plate and the side plates, hydraulic lines up the spine, anchor nuts.
        b.mat('paint-grey').masks(0.3, 1, 0.9, 0);
        for (const sx of [-1, 1]) {
          for (const z of [-0.18, 0.2, 0.5]) {
            b.at(xf.fromAxes([sx * 0.3, 0.12, z], [sx, 0, 0], [0, 0, -sx], [0, 1, 0]), () => extrude(b, [[0, 0], [0.26, 0], [0, 0.5]], -0.012, 0.012, false, 'gusset'));
          }
        }
        b.mat('steel-bare').masks(0.2, 1, 0.9, 0);
        for (const x of [-0.12, 0, 0.12]) pipe(b, [[x, 0.3, 0.56], [x, H - 1.5, 0.56], [x, H - 1.36, 0.3]], 0.016, 0.06, { segs: 6, tag: 'hydraulic-line' });
        b.mat('steel-dark');
        box(b, 0.34, 0.5, 0.22, [0, 0.55, 0.66], 'manifold');
      }
    }
  });

  const arm = buildModel(`${def.id}.arm`, (b) => {
    // Arm frame: origin at the pivot.
    const tipZ = -reach - pivot[2];
    const topY = H - pivot[1];
    b.mat('paint-yellow').masks(0.35, 1, 0.9, 0);
    const prof: [number, number][] = [
      [0.2, -0.16],
      [0.26, 0.1],
      [0.05, 0.3],
      [tipZ + 0.3, topY - 0.02],
      [tipZ, topY - 0.02],
      [tipZ, topY - 0.16],
      [tipZ + 0.24, topY - 0.3],
      [-0.2, -0.2],
    ];
    // Polygon given as (z, y); extrude along X.
    b.at(xf.fromAxes([0, 0, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]), () => extrude(b, prof, -0.2, 0.2, false, 'arm'));
    b.mat('steel-bare').masks(0.5, 1, 0.9, 0);
    // Bearing shoe that carries the stage: its top face is the hold-down plane.
    box(b, 0.44, 0.02, 0.26, [0, topY - 0.01, tipZ + 0.14], 'shoe');
    if (b.lod < 2) {
      // Black warning chevrons on the yellow arm, pivot bosses, grease fittings.
      b.mat('paint-black').masks(0.35, 1, 0.9, 0);
      for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) box(b, 0.006, 0.11, 0.2, [sx * 0.2015, topY * (0.3 + 0.16 * i) * 0.9 + 0.02, tipZ * (0.16 + 0.19 * i)], 'chevron');
      if (b.lod === 0) {
        b.mat('steel-dark');
        for (const sx of [-1, 1]) b.at(xf.mul(xf.translate(sx * 0.2, 0, 0), xf.rotZ(-sx * (Math.PI / 2))), () => frustum(b, 0.12, 0.12, 0, 0.03, 16, 'boss'));
      }
    }
  });

  const pose = (input: PoseInput, emit: PoseSink): void => {
    emit('body', null, null);
    const a = (swing * input.anim.clamp) / 2;
    const rot: QuatTuple | null = input.anim.clamp > 0 ? [Math.sin(a), 0, 0, Math.cos(a)] : null;
    emit('arm', pivot, rot);
  };
  return { models: { body, arm }, pose };
};

