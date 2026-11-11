/**
 * 'fairing.petals': the payload fairing as N petals (N = `fairing.panels` of the part definition). Petal k
 * covers the azimuth sector [k, k + 1) * 360 / N, the convention of the simulation's fairing debris
 * (`<id>#panel<k>`). Each petal is a watertight shell with acoustic blankets and ring frames inside,
 * separation rails along its edges, a base ring segment and a cork-covered shoulder.
 *
 * 'les.tower': launch escape system: boost protective cover shaped from the capsule mould line it
 * shields, truss tower, escape motor with the canted nozzles of the part's engine module, nose cone.
 */
import type { CapsuleMouldLineDef } from '@/core/contracts/defs';
import type { QuatTuple, Vec3Tuple } from '@/core/math';
import { decalSheetOf } from '../decals';
import { MeshBuilder, add3, dot3, norm3, polar, scale3, sub3, xf } from '../geom/builder';
import { DEG, Profile, TAU, ball, beam, bolt, boltCircle, box, frustum, lathe, phisWith, radialFrame, ringSolid, rod, uniformPhis, type LatheRegion, type MaskOut } from '../geom/prims';
import { isMatId, type MatId } from '../materials';
import { accessDoor, band, bandRegion, buildModel, curvedPanel, decalRegion, parseList, regionBounds, regionHeights, surfaceFrame, surfaceSlope, ventPort } from './common';
import { capsuleOpenings, projectToShell, roundRectLoop } from './capsule';
import { mouldLine, shellRadius } from './mouldline';
import { Params, staticPose, type PartGenerator, type PartModel, type PoseInput, type PoseSink } from './types';

const mat = (id: string, where: string): MatId => {
  if (!isMatId(id)) throw new Error(`${where}: unknown material "${id}"`);
  return id;
};

export const fairingPetals: PartGenerator = ({ def, params, defs }) => {
  const sheet = decalSheetOf(defs);
  const where = `visuals/parts/${def.id}`;
  const P = new Params(params, where);
  const mod = def.modules.find((m) => m.type === 'fairing');
  if (!mod || mod.type !== 'fairing') throw new Error(`${where}: fairing.petals needs a fairing module`);
  const N = mod.panels;
  const sector = TAU / N;
  const R = def.bounds.radius;
  const H = def.bounds.yMax;
  const yS = P.num('shoulderY', H - 1.05);
  const rTop = P.num('topRadius', 2.17);
  const wall = P.num('wall', 0.06);
  const gap = P.num('edgeGap', 0.004) / R;
  const skin = mat(P.str('skin', 'paint-white'), where);
  const shoulder = mat(P.str('shoulder', 'cork'), where);
  const liner = mat(P.str('liner', 'blanket'), where);
  const variants = P.num('variants', 2);

  /** Outer radius at height y. */
  const rOut = (y: number): number => {
    if (y <= yS) return R;
    const t = Math.min(1, (y - yS) / (H - yS));
    return rTop + (R - rTop) * Math.sqrt(Math.max(0, 1 - t * t));
  };

  const build = (variant: number): PartModel =>
    buildModel(`${def.id}.panel${variant}`, (b) => {
      const regions: LatheRegion[] = [];
      for (const e of parseList(P.str(`bands${variant}`, ''))) regions.push(bandRegion(mat(e.name, where), e.n[0]!, e.n[1]!, e.n[2]!, e.n[3]!, ['skin0', 'skin1']));
      if (b.lod < 2) for (const e of parseList(P.str(`decals${variant}`, ''))) regions.push(decalRegion(sheet, e.name, R, e.n[0]!, e.n[1]!, e.n[2]!, e.flags.includes('rot'), ['skin0', 'skin1']));
      const segs = b.pick(40, 18, 6);
      const ns = b.pick(12, 6, 3);
      const p = Profile.at(R - wall, 0).mat('alu-machined');
      p.corner(R, 0).mark('skin0').mat(skin);
      const cyl = b.pick(8, 4, 1);
      for (let i = 1; i <= cyl; i++) p.to(R, (yS * i) / cyl);
      p.mat(shoulder);
      for (let i = 1; i <= ns; i++) {
        const y = yS + (H - yS) * Math.sin(((Math.PI / 2) * i) / ns);
        p.to(rOut(y), y);
      }
      p.hard().mark('skin1').mat('alu-machined');
      p.corner(rTop - wall, H).mat(liner);
      for (let i = ns - 1; i >= 0; i--) {
        const y = yS + (H - yS) * Math.sin(((Math.PI / 2) * i) / ns);
        p.to(rOut(y) - wall, y);
      }
      for (let i = cyl - 1; i >= 0; i--) p.to(R - wall, (yS * i) / cyl);
      p.hard().close();
      p.splitAtY('skin0', 'skin1', regionHeights(regions));
      b.mat(skin).masks(0.1, 1, 0.15, 0);
      // Azimuth grid of the sector with the region edges on grid lines.
      let phis = uniformPhis(segs, gap, sector - gap);
      if (regions.length > 0) {
        const full = phisWith(Math.round((segs * TAU) / sector), regionBounds(regions));
        phis = [gap, ...full.filter((x) => x > gap + 1e-4 && x < sector - gap - 1e-4), sector - gap];
      }
      lathe(b, p, {
        phis,
        regions,
        capEnds: true,
        capMat: 'alu-machined',
        tag: 'petal',
        mask: (y: number, _phi: number, r: number, m: MaskOut) => {
          const outer = r > rOut(y) - 1e-4;
          m.ao = outer ? 1 : 0.7;
          m.soot = outer ? 0.1 + 0.25 * Math.max(0, (y - yS) / (H - yS)) : 0.05;
          m.wear = outer && y > yS ? 0.15 : 0;
        },
      });
      if (b.lod === 2) return;
      // ---- separation rails along both edges (outside) and the base ring segment
      b.mat('steel-brushed').masks(0.25, 1, 0.2, 0);
      for (const edge of [gap + 0.006, sector - gap - 0.03]) {
        const rp = Profile.at(R - 0.002, 0.05).corner(R + 0.012, 0.05);
        const n = b.pick(8, 4, 1);
        for (let i = 1; i <= n; i++) rp.to(R + 0.012, 0.05 + ((yS - 0.05) * i) / n);
        for (let i = 1; i <= ns; i++) {
          const y = yS + (H - 0.05 - yS) * Math.sin(((Math.PI / 2) * i) / ns);
          rp.to(rOut(y) + 0.012, y);
        }
        rp.hard().corner(rOut(H - 0.05) - 0.002, H - 0.05);
        for (let i = ns - 1; i >= 0; i--) {
          const y = yS + (H - 0.05 - yS) * Math.sin(((Math.PI / 2) * i) / ns);
          rp.to(rOut(y) - 0.002, y);
        }
        rp.corner(R - 0.002, 0.05).close();
        lathe(b, rp, { phis: [edge, edge + 0.024], capEnds: true, tag: 'rail' });
      }
      b.mat('alu-machined').masks(0.3, 0.8, 0.2, 0);
      lathe(b, Profile.at(R - 0.15, 0).corner(R - wall + 0.002, 0).corner(R - wall + 0.002, 0.12).corner(R - 0.15, 0.12).corner(R - 0.15, 0).close(), { phis: uniformPhis(segs, gap, sector - gap), capEnds: true, tag: 'base-ring' });
      // ---- inside: ring frames, edge beams with latches, blanket retainers
      const frames = b.pick(6, 3, 0);
      for (let i = 1; i <= frames; i++) {
        const y = (yS * i) / (frames + 0.4);
        lathe(b, Profile.at(R - wall - 0.07, y - 0.02).corner(R - wall + 0.002, y - 0.02).corner(R - wall + 0.002, y + 0.02).corner(R - wall - 0.07, y + 0.02).corner(R - wall - 0.07, y - 0.02).close(), {
          phis: uniformPhis(Math.max(4, segs / 2), gap + 0.01, sector - gap - 0.01),
          capEnds: true,
          tag: 'frame',
        });
      }
      for (const edge of [gap + 0.024, sector - gap - 0.024]) {
        beam(b, polar(R - wall - 0.035, edge, 0.12), polar(R - wall - 0.035, edge, yS), 0.07, 0.05, [Math.sin(edge), 0, Math.cos(edge)], 'edge-beam');
        if (b.lod === 0) {
          b.mat('steel-dark');
          const latches = 7;
          for (let i = 0; i < latches; i++) b.at(xf.mul(xf.translate(...polar(R - wall - 0.09, edge, 0.5 + ((yS - 0.8) * i) / (latches - 1))), xf.rotY(edge)), () => box(b, 0.08, 0.14, 0.06, [0, 0, 0], 'latch'));
          b.mat('alu-machined');
        }
      }
      if (b.lod === 0) {
        // Pneumatic thrusters / hinge fittings at the base (flat against the wall: the payload adapter stands
        // 0.1 m inside it), and the vent and access door on the outside.
        b.mat('steel-dark').masks(0.3, 0.8, 0.2, 0);
        for (const f of [0.25, 0.75]) b.at(xf.mul(xf.translate(...polar(R - wall - 0.044, sector * f, 0.2)), xf.rotY(sector * f)), () => box(b, 0.22, 0.2, 0.09, [0, 0, 0], 'hinge-fitting'));
        b.mat('steel-bare').masks(0.3, 1, 0.2, 0);
        for (const edge of [gap + 0.018, sector - gap - 0.018]) for (let i = 0; i < 24; i++) b.at(radialFrame(R + 0.011, edge, 0.3 + ((yS - 0.5) * i) / 23), () => bolt(b, 0.009, 0.005));
      }
      b.mat(skin).masks(0.1, 1, 0.15, 0);
      ventPort(b, R, sector * 0.82, 1.1, 0.05, 0.1);
      accessDoor(b, R, sector * 0.2, 1.4, 0.7, 0.55);
    });

  const models: Record<string, PartModel> = {};
  for (let v = 0; v < variants; v++) models[`panel${v}`] = build(v);
  const rot = (k: number): QuatTuple | null => (k === 0 ? null : [0, Math.sin((k * sector) / 2), 0, Math.cos((k * sector) / 2)]);
  const pose = (input: PoseInput, emit: PoseSink): void => {
    if (input.panel !== null) {
      emit(`panel${input.panel % variants}`, null, rot(input.panel));
      return;
    }
    for (let k = 0; k < N; k++) emit(`panel${k % variants}`, null, rot(k));
  };
  return { models, pose };
};

export const lesTower: PartGenerator = ({ def, params, defs }) => {
  const sheet = decalSheetOf(defs);
  const where = `visuals/parts/${def.id}`;
  const P = new Params(params, where);
  const ml = mouldLine(defs, P.str('mouldLine'));
  const engine = def.modules.find((m) => m.type === 'engine');
  if (!engine || engine.type !== 'engine') throw new Error(`${where}: les.tower needs an engine module`);
  // The skirt of the cover ends at the capsule's maximum diameter: that fixes where the capsule is.
  const yCap = -def.bounds.yMin + ml.heatShield.maxDiameterY;
  const toLes = (yCapsule: number): number => yCapsule - yCap;
  const clear = P.num('coverClearance', 0.03);
  const cw = P.num('coverWall', 0.03);
  const apexR = P.num('apexCoverRadius', 0.55) + clear;
  const coverMat = mat(P.str('cover', 'paint-white'), where);
  const towerMat = mat(P.str('tower', 'paint-white'), where);
  const caseR = P.num('motorRadius', 0.45);
  const tip = def.bounds.yMax;
  const exits = engine.nozzles.map((n) => n.pos as Vec3Tuple);
  const nozY = exits.reduce((s, p) => s + p[1], 0) / exits.length;
  const nozLen = P.num('nozzleLength', 0.55);
  const motorAft = nozY + nozLen * 0.82;
  const motorFwd = P.num('motorTop', tip - 0.9);
  const towerTop = nozY - 0.5;
  const skirtR = P.num('skirtRadius', 0.26);
  const plateY = 0.055;
  const coneSlope = Math.hypot(1, (ml.heatShield.maxDiameter / 2 - ml.cone.radiusTop) / (ml.cone.yTop - ml.cone.yBottom));

  /** Inner radius of the cover at capsule height y. */
  const rIn = (yc: number): number => Math.max(shellRadius(ml, yc) + clear, apexR);
  /** Outer surface of the cover at a height in the part frame. */
  const coverOuter = (y: number): number => rIn(y + yCap) + cw;
  const lining = mat(P.str('lining', 'phenolic'), where);
  const ports = coverPorts(ml, windowPortIds(params['windowPorts'], where), rIn, cw, P.num('portMargin', 0.025), where);
  /** A port as a lathe region of the cover (part frame). */
  const portRegion = (q: CoverPort): LatheRegion => ({ phi0: q.phi0, phi1: q.phi1, y0: toLes(q.y0), y1: toLes(q.y1), mat: coverMat, hole: true });
  const hatchPort = ports.find((q) => q.id === HATCH_WINDOW);

  /** Painted regions and port openings of the cover's lathe at a LOD (none at the far LOD). */
  const coverRegions = (b: MeshBuilder): LatheRegion[] => {
    const regions: LatheRegion[] = [];
    if (b.lod === 2) return regions;
    for (const e of parseList(P.str('decals', ''))) regions.push(decalRegion(sheet, e.name, shellRadius(ml, e.n[1]! + yCap) + clear + cw, e.n[0]!, e.n[1]!, e.n[2]! / coneSlope, false, ['skin0', 'skin1']));
    for (const q of ports) regions.push(portRegion(q));
    return regions;
  };
  /** The cover's lathe azimuths at this LOD (port and decal edges on grid lines). */
  const coverPhis = (b: MeshBuilder, regions: LatheRegion[]): number[] => phisWith(b.pick(120, 56, 20), regionBounds(regions));

  const body = buildModel(`${def.id}.body`, (b) => {
    const segs = b.pick(120, 56, 20);
    // ---- boost protective cover: one shell from the underside of its top plate, down the inside, round
    // the skirt and up the outside; the glazed ports are cut through it (LOD 0 and 1)
    const yBot = toLes(ml.heatShield.maxDiameterY);
    const regions = coverRegions(b);
    const cut = b.lod < 2 ? ports : [];
    const n = b.pick(14, 7, 3);
    const ys: number[] = [];
    for (let i = 0; i <= n; i++) ys.push(ml.heatShield.maxDiameterY + ((ml.cone.yTop - ml.heatShield.maxDiameterY) * i) / n);
    // Where the cone reaches the apex cover radius the shell becomes a cylinder. The inside is a dark
    // lining: it sees no sky and no sun (it faces the capsule a hand's width away).
    const p = Profile.at(0, 0).mat(lining);
    p.corner(apexR, 0).mark('in0');
    let last = Infinity;
    for (let i = ys.length - 1; i >= 0; i--) {
      const r = rIn(ys[i]!);
      if (r === last && i > 0 && rIn(ys[i - 1]!) === r) continue;
      p.to(r, toLes(ys[i]!));
      last = r;
    }
    p.mark('in1');
    p.hard().mat('alu-machined');
    p.corner(rIn(ml.heatShield.maxDiameterY) + cw, yBot).mark('skin0').mat(coverMat);
    last = Infinity;
    for (let i = 1; i < ys.length; i++) {
      const r = rIn(ys[i]!) + cw;
      if (r === last && i + 1 < ys.length && rIn(ys[i + 1]!) + cw === r) continue;
      p.to(r, toLes(ys[i]!));
      last = r;
    }
    p.to(apexR + cw, plateY).hard().mark('skin1').mat('alu-machined');
    p.corner(0, plateY);
    p.splitAtY('skin0', 'skin1', regionHeights(regions));
    p.splitAtY('in0', 'in1', regionHeights(regions));
    b.mat(coverMat).masks(0.1, 1, 0.6, 0);
    lathe(b, p, {
      phis: coverPhis(b, regions),
      regions,
      tag: 'boost-cover',
      closed: cut.length === 0,
      mask: (y: number, _phi: number, r: number, m: MaskOut) => {
        const outer = r > rIn(y + yCap) + cw * 0.5;
        m.soot = outer ? 0.25 + 0.75 * Math.max(0, Math.min(1, (y - yBot) / (plateY - yBot))) : 0.1;
        m.ao = outer ? 1 : 0.12;
      },
    });
    const hy = toLes(ml.hatch.y);
    const hphi = ml.hatch.azimuthDeg * DEG;
    if (b.lod < 2) {
      // Hatch access panel over the capsule hatch (it follows the cone of the cover; open round the hatch
      // window's port), the ports' reveals through the wall and their bezels, vents, skirt band.
      b.mat(coverMat).masks(0.2, 1, 0.5, 0);
      const hl = Math.hypot(1, surfaceSlope(coverOuter, hy));
      const hr = coverOuter(hy);
      const doorHole = hatchPort ? { arc: Math.max(Math.abs(hatchPort.phi0 - hphi), Math.abs(hatchPort.phi1 - hphi)) * hr + 0.002, slant: Math.max(Math.abs(toLes(hatchPort.y0) - hy), Math.abs(toLes(hatchPort.y1) - hy)) * hl + 0.002 } : undefined;
      accessDoor(b, coverOuter, hphi, hy, ml.hatch.width + 0.14, ml.hatch.height + 0.14, doorHole);
      for (const q of ports) {
        const y0 = toLes(q.y0);
        const y1 = toLes(q.y1);
        const edgePhis = portPhis(coverPhis(b, regions), q);
        // Reveal: the cut faces of the wall, facing into the opening (counter-clockwise seen from outside).
        b.mat(lining).masks(0.1, 0.35, 0.1, 0);
        b.begin(false, 'port-reveal');
        const wall = (pts: [number, number][], into: (phi: number, y: number) => Vec3Tuple): void => {
          let u = 0;
          for (let i = 0; i + 1 < pts.length; i++) {
            const [fa, ya] = pts[i]!;
            const [fb, yb] = pts[i + 1]!;
            const pa = polar(coverOuter(ya), fa, ya);
            const pb = polar(coverOuter(yb), fb, yb);
            const run = sub3(pb, pa);
            const len = Math.hypot(...run);
            const at = (f: number, y: number, r: number, nn: Vec3Tuple, uu: number, v: number): number => {
              const t = norm3(sub3(run, scale3(nn, dot3(run, nn))));
              return b.v(r * Math.sin(f), y, r * Math.cos(f), nn[0], nn[1], nn[2], t[0], t[1], t[2], uu, v);
            };
            const nA = into(fa, ya);
            const nB = into(fb, yb);
            const oa = at(fa, ya, coverOuter(ya), nA, u, 0);
            const ob = at(fb, yb, coverOuter(yb), nB, u + len, 0);
            const ia = at(fa, ya, coverOuter(ya) - cw, nA, u, cw);
            const ib = at(fb, yb, coverOuter(yb) - cw, nB, u + len, cw);
            b.quad(oa, ob, ib, ia);
            u += len;
          }
        };
        const upSlope = (f: number, y: number): Vec3Tuple => {
          const k = surfaceSlope(coverOuter, y);
          return norm3([k * Math.sin(f), 1, k * Math.cos(f)]);
        };
        const along = (f: number): Vec3Tuple => [Math.cos(f), 0, -Math.sin(f)];
        wall(edgePhis.map((f) => [f, y0]), (f, y) => upSlope(f, y));
        wall([[q.phi1, y0], [q.phi1, y1]], (f) => scale3(along(f), -1));
        wall([...edgePhis].reverse().map((f) => [f, y1]), (f, y) => scale3(upSlope(f, y), -1));
        wall([[q.phi0, y1], [q.phi0, y0]], (f) => along(f));
        // Bezel: four strips on the outer surface (on the door for the hatch window), lapping 4 mm over the cut.
        b.mat('anodised').masks(0.3, 1, 0.5, 0);
        const yc = (y0 + y1) / 2;
        const rc = coverOuter(yc);
        const l = Math.hypot(1, surfaceSlope(coverOuter, yc));
        const hs = ((y1 - y0) / 2) * l;
        const ha = ((q.phi1 - q.phi0) / 2) * rc;
        const phc = (q.phi0 + q.phi1) / 2;
        const fw = 0.032;
        const lap = 0.004;
        const proud = q.id === HATCH_WINDOW ? 0.015 : 0.008;
        for (const sg of [-1, 1]) curvedPanel(b, coverOuter, phc, yc + (sg * (hs + fw / 2 - lap)) / l, 2 * (ha + fw - lap), fw, proud, 'port-bezel', 0.002);
        for (const sg of [-1, 1]) curvedPanel(b, coverOuter, phc + (sg * (ha + fw / 2 - lap)) / rc, yc, fw, 2 * (hs - lap), proud, 'port-bezel', 0.002);
        if (b.lod === 0) {
          b.mat('steel-bare').masks(0.3, 1, 0.5, 0);
          const nb = Math.max(2, Math.round((2 * hs) / 0.09));
          for (let i = 0; i <= nb; i++) for (const sg of [-1, 1]) b.at(surfaceFrame(coverOuter, phc + (sg * (ha + fw / 2 - lap)) / rc, yc - (hs - 0.02) / l + ((2 * (hs - 0.02)) / l) * (i / nb), proud), () => bolt(b, 0.005, 0.0015));
        }
      }
      b.mat('steel-bare').masks(0.3, 1, 0.5, 0);
      band(b, coverOuter(yBot + 0.06), yBot + 0.06, 0.08, 0.01, segs, 'skirt-band');
      for (const az of [60, 300]) ventPort(b, coverOuter, az * DEG, toLes(ml.heatShield.maxDiameterY + 0.6), 0.04, 0.05);
    }

    // ---- tower: four legs, ring frames and cross bracing
    b.mat(towerMat).masks(0.2, 1, 0.9, 0);
    const legs = 4;
    const r0 = apexR + cw - 0.07;
    const r1 = skirtR - 0.02;
    const bays = b.pick(3, 3, 1);
    const node = (k: number, level: number): Vec3Tuple => {
      const t = level / bays;
      return polar(r0 + (r1 - r0) * t, ((k + 0.5) / legs) * TAU, plateY + (towerTop - plateY) * t);
    };
    for (let k = 0; k < legs; k++) {
      rod(b, node(k, 0), node(k, bays), 0.045, b.pick(12, 8, 5), 'tower-leg');
      if (b.lod === 2) continue;
      for (let l = 0; l <= bays; l++) rod(b, node(k, l), node((k + 1) % legs, l), 0.024, b.pick(8, 6, 4), 'tower-ring');
      for (let l = 0; l < bays; l++) {
        rod(b, node(k, l), node((k + 1) % legs, l + 1), 0.018, b.pick(8, 6, 4), 'tower-brace');
        if (b.lod === 0) rod(b, node((k + 1) % legs, l), node(k, l + 1), 0.018, 8, 'tower-brace');
      }
      if (b.lod === 0) {
        b.mat('steel-dark');
        b.at(xf.translate(...node(k, 0)), () => frustum(b, 0.085, 0.07, -0.005, 0.07, 14, 'tower-foot'));
        b.mat(towerMat);
      }
    }
    // ---- structural skirt under the motor, motor case with domes, nose with ballast and probe
    b.mat('steel-brushed').masks(0.15, 1, 1, 0);
    frustum(b, skirtR, skirtR, towerTop - 0.03, motorAft + 0.05, b.pick(40, 20, 10), 'motor-skirt');
    b.mat(coverMat).masks(0.1, 1, 0.5, 0);
    const mp = Profile.at(0, motorAft - 0.02);
    const nd = b.pick(8, 4, 2);
    for (let i = 1; i <= nd; i++) {
      const a = ((Math.PI / 2) * i) / nd;
      mp.to(caseR * Math.sin(a), motorAft + 0.22 - 0.24 * Math.cos(a));
    }
    mp.mark('case0');
    const rows = b.pick(6, 3, 1);
    for (let i = 1; i <= rows; i++) mp.to(caseR, motorAft + 0.22 + ((motorFwd - motorAft - 0.22) * i) / rows);
    mp.mark('case1').mat('paint-black');
    mp.to(caseR * 0.74, motorFwd + 0.28).mat(coverMat);
    // Ogive nose to the probe.
    const nn = b.pick(10, 5, 2);
    const y0n = motorFwd + 0.28;
    for (let i = 1; i <= nn; i++) {
      const t = i / nn;
      mp.to(caseR * 0.74 * Math.cos((Math.PI / 2) * t) ** 0.8 + 0.022 * t, y0n + (tip - 0.1 - y0n) * t);
    }
    mp.hard().mat('steel-bare');
    mp.corner(0.014, tip - 0.1).to(0.01, tip - 0.01).to(0, tip);
    const caseRegions: LatheRegion[] = [];
    if (b.lod < 2) {
      for (const e of parseList(P.str('motorDecals', ''))) caseRegions.push(decalRegion(sheet, e.name, caseR, e.n[0]!, e.n[1]!, e.n[2]!, e.flags.includes('rot'), ['case0', 'case1']));
      for (const e of parseList(P.str('motorBands', ''))) caseRegions.push(bandRegion(mat(e.name, where), e.n[0]!, e.n[1]!, e.n[2]!, e.n[3]!, ['case0', 'case1']));
    }
    mp.splitAtY('case0', 'case1', regionHeights(caseRegions));
    lathe(b, mp, { phis: phisWith(b.pick(64, 32, 12), regionBounds(caseRegions)), regions: caseRegions, tag: 'motor' });
    if (b.lod < 2) {
      b.mat('steel-bare').masks(0.3, 1, 0.6, 0);
      band(b, caseR, motorAft + 0.3, 0.06, 0.008, 64, 'case-band');
      band(b, caseR, motorFwd - 0.06, 0.06, 0.008, 64, 'case-band');
      b.mat(coverMat);
      b.at(radialFrame(caseR - 0.004, 200 * DEG, (motorAft + motorFwd) / 2 + 0.1), () => box(b, motorFwd - motorAft - 0.5, 0.035, 0.11, [0, 0.017, 0], 'raceway'));
      if (b.lod === 0) {
        b.mat('steel-bare');
        boltCircle(b, skirtR + 0.012, motorAft + 0.05, 20, 0.01, 0.008);
      }
    }
    // ---- escape motor nozzles (positions and cant from the engine module)
    for (const nz of engine.nozzles) {
      const d = norm3(nz.dir as Vec3Tuple);
      const exit = nz.pos as Vec3Tuple;
      const throat = add3(exit, scale3(d, -nozLen));
      const re = nz.exitDiameter / 2;
      b.at(xf.along(throat, exit), () => {
        b.mat('steel-dark').masks(0.1, 1, 1, 0);
        const q = Profile.at(0, -0.12)
          .corner(re * 0.62, -0.12)
          .to(re * 0.62, 0.0)
          .to(re * 0.42, nozLen * 0.16)
          .to(re * 0.7, nozLen * 0.55)
          .to(re, nozLen)
          .hard()
          .mat('phenolic')
          .corner(re - 0.012, nozLen)
          .to(re * 0.66, nozLen * 0.55)
          .to(re * 0.3, nozLen * 0.17)
          .to(0, nozLen * 0.2);
        lathe(b, q, { segs: b.pick(28, 14, 8), tag: 'nozzle' });
        if (b.lod < 2) {
          band(b, re * 0.72, nozLen * 0.57, 0.03, 0.008, b.pick(28, 14, 8), 'nozzle-band');
          // Exit ring of the nozzle and the bolted flange that holds it in the motor's aft closure.
          b.mat('steel-bare').masks(0.3, 1, 0.8, 0);
          band(b, re + 0.001, nozLen - 0.025, 0.04, 0.007, b.pick(28, 14, 8), 'nozzle-band');
          ringSolid(b, re * 0.6, re * 0.88, -0.02, 0.02, b.pick(24, 12, 8), 'nozzle-flange');
        }
      });
    }
    if (b.lod < 2 && engine.nozzles.length > 1) {
      // Aft closure manifold: the forged ring the canted nozzles are bolted into, round the motor case.
      const yM = engine.nozzles.reduce((sum, nz) => sum + nz.pos[1]! - (nz.dir[1]! / Math.hypot(nz.dir[0]!, nz.dir[1]!, nz.dir[2]!)) * nozLen, 0) / engine.nozzles.length;
      b.mat('steel-dark').masks(0.2, 1, 0.9, 0);
      ringSolid(b, caseR - 0.01, caseR + 0.07, yM - 0.09, yM + 0.09, b.pick(48, 24, 12), 'manifold');
    }
    if (b.lod === 0) {
      b.mat('steel-bare').masks(0.3, 1, 0.9, 0);
      b.at(xf.translate(0, tip - 0.1, 0), () => ball(b, 0.022, 0, 10, 6, 0.022, 'probe'));
    }
  });

  // ---- port panes: their own model, left out (with the capsule's panes) when the camera is in the cabin.
  // Each is a dark pane following the cover's cone a little inside the cut (on the surface where the far
  // LOD has no cut).
  const glass = buildModel(`${def.id}.glass`, (g) => {
    g.mat('glass').masks(0, 1, 0.4, 0);
    for (const q of ports) {
      const phis = g.lod < 2 ? portPhis(coverPhis(g, coverRegions(g)), q) : uniformPhis(2, q.phi0, q.phi1);
      const lift = g.lod < 2 ? -0.012 : 0.002;
      const y0 = toLes(q.y0);
      const y1 = toLes(q.y1);
      const pr = Profile.at(coverOuter(y0) + lift, y0).to(coverOuter(y1) + lift, y1);
      lathe(g, pr, { phis, closed: false, tag: 'port-pane' });
    }
  });
  const pose = (_input: PoseInput, emit: PoseSink): void => {
    emit('body', null, null);
    if (ports.length > 0) emit('glass', null, null, { castShadow: false, cold: true });
  };
  return { models: { body, glass }, pose, sootSeconds: P.num('sootSeconds', 3) };
};

/** The lathe azimuths over a port, ascending from its phi0 (azimuths past 2 pi when it crosses 0). */
function portPhis(all: readonly number[], q: CoverPort): number[] {
  return all
    .map((f) => (f < q.phi0 - 1e-9 ? f + TAU : f))
    .filter((f) => f >= q.phi0 - 1e-9 && f <= q.phi1 + 1e-9)
    .sort((a, c) => a - c);
}

/** Port id of the hatch's round window (the mould line's windows are named by their own ids). */
export const HATCH_WINDOW = 'hatch-window';

/** The cover's `windowPorts` parameter: a list of window ids (absent: the hatch window alone). */
function windowPortIds(v: unknown, where: string): string[] {
  if (v === undefined) return [HATCH_WINDOW];
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[;,]/).map((s) => s.trim()).filter((s) => s) : null;
  if (!list || list.some((s) => typeof s !== 'string')) throw new Error(`${where}: "windowPorts" must be a list of window ids`);
  return list as string[];
}

/** A glazed opening in the boost cover: azimuth range (radians, phi1 > phi0) and capsule-frame heights. */
export interface CoverPort {
  id: string;
  phi0: number;
  phi1: number;
  y0: number;
  y1: number;
}

/**
 * Openings of the boost cover: each frames the view through its cabin window from every seat's eye point
 * (the window's outline seen from each eye, carried out to both faces of the cover's wall), plus `margin`
 * along the arc and the meridian. Without seats the window is carried straight out along its normal.
 */
export function coverPorts(ml: CapsuleMouldLineDef, ids: readonly string[], rIn: (yCapsule: number) => number, wall: number, margin: number, where: string): CoverPort[] {
  const openings = capsuleOpenings(ml);
  return ids.map((id) => {
    const o = id === HATCH_WINDOW ? openings.find((x) => x.hatch) : openings.find((x) => x.id === id && !x.hatch);
    if (!o) throw new Error(`${where}: windowPorts: the mould line has no window "${id}"`);
    const outline: Vec3Tuple[] = [];
    if (id === HATCH_WINDOW) {
      const rw = ml.hatch.window.radius;
      for (let i = 0; i < 24; i++) outline.push(projectToShell(ml, o, rw * Math.cos((i / 24) * TAU), rw * Math.sin((i / 24) * TAU)));
    } else for (const q of roundRectLoop(o.hw, o.hh, o.rho, 0.04, 4)) outline.push(projectToShell(ml, o, q.a, q.b));
    const eyes: (Vec3Tuple | null)[] = ml.seats.length > 0 ? ml.seats.map((s) => s.pos as Vec3Tuple) : [null];
    let f0 = Infinity;
    let f1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const eye of eyes) {
      for (const p of outline) {
        const d = eye ? norm3(sub3(p, eye)) : o.N;
        // Only eyes that see the window from inside the cabin frame it.
        if (dot3(d, o.N) < 0.2) continue;
        for (const off of [0, wall]) {
          const R = (y: number): number => rIn(y) + off;
          const f = (t: number): number => {
            const q = add3(p, scale3(d, t));
            return Math.hypot(q[0], q[2]) - R(q[1]);
          };
          let a = 0;
          let c = 0.02;
          while (f(c) < 0 && c < 2) {
            a = c;
            c += 0.02;
          }
          for (let i = 0; i < 30; i++) {
            const m = (a + c) / 2;
            if (f(m) < 0) a = m;
            else c = m;
          }
          const q = add3(p, scale3(d, (a + c) / 2));
          let phi = Math.atan2(q[0], q[2]);
          phi += TAU * Math.round((o.phi - phi) / TAU);
          f0 = Math.min(f0, phi);
          f1 = Math.max(f1, phi);
          y0 = Math.min(y0, q[1]);
          y1 = Math.max(y1, q[1]);
        }
      }
    }
    if (!Number.isFinite(f0)) throw new Error(`${where}: windowPorts: no seat sees out of window "${id}"`);
    const yc = (y0 + y1) / 2;
    const r = rIn(yc) + wall;
    const l = Math.hypot(1, (rIn(yc + 0.005) - rIn(yc - 0.005)) / 0.01);
    const p0 = f0 - margin / r;
    const turn = TAU * Math.floor(p0 / TAU);
    return { id, phi0: p0 - turn, phi1: f1 + margin / r - turn, y0: y0 - margin / l, y1: y1 + margin / l };
  });
}
