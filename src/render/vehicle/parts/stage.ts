/**
 * 'stage.tank': a launch-vehicle stage built from its definition: outer mould line from PartDef.bounds,
 * tank sections from PartDef.resources (tankBottomY / tankHeight), engine mount pads from the 'engine*'
 * attach nodes. One watertight shell (outer skin, skirt interiors, both domes) plus external detail:
 * stringer-stiffened or corrugated skirts and intertank, weld lands, systems tunnels, pressurisation
 * lines, umbilical plates, vents, access doors, hold-down posts, base heat shield and the forward-dome
 * fittings seen inside the interstage after separation.
 */
import type { Vec3Tuple } from '@/core/math';
import { MeshBuilder, polar, xf } from '../geom/builder';
import { DEG, Profile, TAU, bolt, boltCircle, boltRing, box, frustum, lathe, phisWith, pipe, radialFrame, ringSolid, type LatheRegion, type MaskOut } from '../geom/prims';
import { isMatId, type MatId } from '../materials';
import { accessDoor, band, bandRegion, buildModel, decalRegion, parseList, raceway, regionBounds, regionHeights, seams, sootRamp, stringers, umbilicalPlate, ventPort } from './common';
import { Params, staticPose, type PartGenerator } from './types';

const mat = (id: string, where: string): MatId => {
  if (!isMatId(id)) throw new Error(`${where}: unknown material "${id}"`);
  return id;
};

export const stageTank: PartGenerator = ({ def, params }) => {
  const where = `visuals/parts/${def.id}`;
  const P = new Params(params, where);
  const R = def.bounds.radius;
  const H = def.bounds.yMax - def.bounds.yMin;
  const wall = P.num('wall', 0.045);
  const Ri = R - wall;

  // Tank sections, bottom to top (small bottles such as RCS tanks are not sections).
  const tanks = (def.resources ?? [])
    .filter((r) => r.tankHeight > 1)
    .map((r) => ({ y0: r.tankBottomY, y1: r.tankBottomY + r.tankHeight }))
    .sort((a, b) => a.y0 - b.y0);
  if (tanks.length === 0) throw new Error(`${where}: stage.tank needs at least one tank resource`);
  const aftTop = P.num('aftSkirtTop', tanks[0]!.y0);
  const fwdBottom = P.num('fwdSkirtBottom', tanks[tanks.length - 1]!.y1);
  const skin = mat(P.str('skin', 'paint-white'), where);
  const skinAlt = mat(P.str('skinAlt', skin), where);
  const aftMat = mat(P.str('aftSkirt', skin), where);
  const fwdMat = mat(P.str('fwdSkirt', skin), where);
  const interMat = mat(P.str('intertank', 'paint-black'), where);
  const domeMat = mat(P.str('dome', 'alu-machined'), where);
  const innerMat = mat(P.str('inner', 'primer'), where);
  const ringStep = P.num('ringSpacing', 2.6);
  const frostW = P.num('frost', 1);
  const sootTop = P.num('sootTop', 7);
  const baseY = P.num('baseShieldY', 0.3);
  const domeAft = P.num('domeAft', R * 0.5);
  const domeFwd = P.num('domeFwd', R * 0.5);
  const fwdApex = P.num('fwdDomeApex', H - 0.7);
  const aftStringers = P.num('aftStringers', 0);
  const fwdStringers = P.num('fwdStringers', 0);
  const interStyle = P.str('intertankStyle', 'corrugated');
  const interCount = P.num('intertankCount', 96);

  // Intertank gaps between consecutive tanks.
  const gaps: { y0: number; y1: number }[] = [];
  for (let i = 0; i + 1 < tanks.length; i++) if (tanks[i + 1]!.y0 - tanks[i]!.y1 > 0.4) gaps.push({ y0: tanks[i]!.y1, y1: tanks[i + 1]!.y0 });
  const inGap = (y: number): boolean => gaps.some((g) => y >= g.y0 - 1e-6 && y < g.y1 - 1e-6);

  // Livery.
  const regionsFull: LatheRegion[] = [];
  const regionsBands: LatheRegion[] = [];
  for (const e of parseList(P.str('bands', ''))) {
    const r = bandRegion(mat(e.name, where), e.n[0]!, e.n[1]!, e.n[2]!, e.n[3]!, ['skin0', 'skin1']);
    regionsFull.push(r);
    regionsBands.push(r);
  }
  for (const e of parseList(P.str('decals', ''))) regionsFull.push(decalRegion(e.name, R, e.n[0]!, e.n[1]!, e.n[2]!, e.flags.includes('rot'), ['skin0', 'skin1']));

  const engineNodes = def.attachNodes.filter((n) => n.id.startsWith('engine'));
  const frostAt = (y: number): number => {
    let w = 0;
    for (const t of tanks) w = Math.max(w, Math.min(1, (y - t.y0 + 0.1) / 0.5, (t.y1 + 0.1 - y) / 0.5));
    return Math.max(0, w) * frostW;
  };

  const shell = (b: MeshBuilder): void => {
    const segs = b.pick(144, 64, 20);
    const regions = b.lod === 0 ? regionsFull : b.lod === 1 ? regionsFull : regionsBands;
    // Heights of the skin rings.
    const ys = new Set<number>([0, aftTop, fwdBottom, H]);
    for (const t of tanks) {
      ys.add(t.y0);
      ys.add(t.y1);
      if (b.lod < 2) {
        const n = Math.max(1, Math.round((t.y1 - t.y0) / ringStep));
        for (let i = 1; i < n; i++) ys.add(t.y0 + ((t.y1 - t.y0) * i) / n);
        ys.add(Math.min(t.y0 + 0.5, t.y1));
        ys.add(Math.max(t.y1 - 0.5, t.y0));
      }
    }
    if (b.lod < 2) for (let y = 1; y < Math.min(sootTop, H); y += 1) ys.add(y);
    const sorted = [...ys].filter((y) => y >= 0 && y <= H).sort((a, c) => a - c);
    const matAt = (y: number): MatId => {
      if (y < aftTop - 1e-6) return aftMat;
      if (y >= fwdBottom - 1e-6) return fwdMat;
      let base = 0;
      for (const t of tanks) {
        const n = Math.max(1, Math.round((t.y1 - t.y0) / ringStep));
        // Barrel rings alternate between two slightly different paints (panel-to-panel variation).
        if (y >= t.y0 && y < t.y1) return (base + Math.floor(((y - t.y0) / (t.y1 - t.y0)) * n)) % 2 === 0 ? skin : skinAlt;
        base += n;
      }
      return inGap(y) ? interMat : skin;
    };

    const nd = b.pick(14, 8, 3);
    const aftEq = P.num('aftDomeEquator', aftTop + 0.6);
    const p = Profile.at(0, aftEq - domeAft);
    p.mat(domeMat);
    // Aft dome (convex downward), from its lowest point out to the skirt wall.
    for (let i = 1; i <= nd; i++) {
      const a = ((Math.PI / 2) * i) / nd;
      p.to(Ri * Math.sin(a), aftEq - domeAft * Math.cos(a));
    }
    p.hard().mat(innerMat);
    p.corner(Ri, 0).mat('alu-machined');
    p.corner(R, 0).mark('skin0');
    for (let i = 0; i + 1 < sorted.length; i++) {
      p.mat(matAt((sorted[i]! + sorted[i + 1]!) / 2));
      p.to(R, sorted[i + 1]!);
    }
    p.hard().mark('skin1').mat('alu-machined');
    p.corner(Ri, H).mat(innerMat);
    const eq = fwdApex - domeFwd;
    p.corner(Ri, eq).mat(domeMat);
    for (let i = 1; i <= nd; i++) {
      const a = ((Math.PI / 2) * i) / nd;
      p.to(Ri * Math.cos(a), eq + domeFwd * Math.sin(a));
    }
    p.splitAtY('skin0', 'skin1', regionHeights(regions));
    b.mat(skin);
    lathe(b, p, {
      phis: phisWith(segs, regionBounds(regions)),
      regions,
      tag: 'shell',
      mask: (y: number, _phi: number, r: number, m: MaskOut) => {
        // The mask callback sees every ring; only the outer skin frosts and soots.
        const outer = r > R - 1e-4;
        m.frost = outer ? frostAt(y) : 0;
        m.soot = outer ? 0.12 + 0.88 * sootRamp(y, 0, sootTop) : y < aftTop + 1 ? 0.6 : 0;
        m.ao = outer ? 1 : y < aftTop + 1 ? 0.55 : 0.7;
        m.wear = outer && (y < 0.02 || y > H - 0.02) ? 0.5 : 0;
      },
    });
  };

  const detail = (b: MeshBuilder): void => {
    const segs = b.pick(144, 64, 20);
    // ---- intertank
    for (const g of gaps) {
      if (b.lod === 2) continue;
      if (interStyle === 'corrugated' && b.lod === 0) {
        b.mat(interMat).masks(0, 1, 0.15, 0);
        const amp = 0.014;
        const cp = Profile.at(R - 0.003, g.y0 + 0.02)
          .to(R + amp + 0.004, g.y0 + 0.07)
          .mark('c0')
          .to(R + amp + 0.004, g.y1 - 0.07)
          .mark('c1')
          .to(R - 0.003, g.y1 - 0.02);
        cp.pts[0]!.hard = false;
        lathe(b, cp, { segs: interCount * 6, corr: { n: interCount, amp, span: ['c0', 'c1'] }, closed: false, tag: 'corrugation' });
      } else {
        b.mat(interMat).masks(0.1, 1, 0.15, 0);
        stringers(b, R, g.y0 + 0.04, R, g.y1 - 0.04, b.pick(interCount, interCount / 2, 0), 0.06, 0.035);
      }
      b.mat('steel-bare').masks(0.2, 1, 0.15, 0);
      band(b, R, g.y0, 0.07, 0.012, segs, 'frame');
      band(b, R, g.y1, 0.07, 0.012, segs, 'frame');
    }
    // ---- skirts
    if (b.lod < 2) {
      if (aftStringers > 0 && aftTop > 0.6) {
        b.mat(aftMat).masks(0.1, 1, 0.9, 0);
        stringers(b, R, 0.12, R, aftTop - 0.08, b.pick(aftStringers, aftStringers / 2, 0), 0.07, 0.04);
      }
      if (fwdStringers > 0 && H - fwdBottom > 0.5) {
        b.mat(fwdMat).masks(0.1, 1, 0.1, 0);
        stringers(b, R, fwdBottom + 0.08, R, H - 0.12, b.pick(fwdStringers, fwdStringers / 2, 0), 0.07, 0.04);
      }
      b.mat('steel-bare').masks(0.25, 1, 0.5, 0);
      band(b, R, 0.05, 0.1, 0.016, segs, 'frame');
      band(b, R, H - 0.05, 0.1, 0.016, segs, 'frame');
      if (aftTop > 0.6) band(b, R, aftTop, 0.08, 0.012, segs, 'frame');
      if (H - fwdBottom > 0.5) band(b, R, fwdBottom, 0.08, 0.012, segs, 'frame');
    }
    // ---- weld lands and longitudinal seams on the tank barrels
    if (b.lod === 0) {
      let ringNo = 0;
      for (const t of tanks) {
        const n = Math.max(1, Math.round((t.y1 - t.y0) / ringStep));
        for (let i = 0; i < n; i++) {
          const y0 = t.y0 + ((t.y1 - t.y0) * i) / n;
          const y1 = t.y0 + ((t.y1 - t.y0) * (i + 1)) / n;
          const m = ringNo % 2 === 0 ? skin : skinAlt;
          b.mat(m).masks(0.15, 1, 0.12, frostAt((y0 + y1) / 2));
          if (i > 0) band(b, R, y0, 0.045, 0.004, segs, 'weld');
          seams(b, R, y0 + 0.03, y1 - 0.03, P.num('seamsPerRing', 6), 0.03, 0.003, (ringNo % 2) * (Math.PI / P.num('seamsPerRing', 6)));
          ringNo++;
        }
      }
    }
    // ---- flange fasteners
    if (b.lod === 0) {
      b.mat('steel-bare').masks(0.3, 1, 0.4, 0);
      const nb = Math.round((TAU * R) / 0.2);
      boltRing(b, R + 0.014, 0.05, nb, 0.014, 0.01);
      boltRing(b, R + 0.014, H - 0.05, nb, 0.014, 0.01);
    }
    // ---- systems tunnels and external lines
    for (const e of parseList(P.str('raceways', ''))) {
      if (b.lod === 2) continue;
      b.masks(0.1, 1, 0.2, 0);
      raceway(b, R, e.n[0]! * DEG, e.n[1]!, e.n[2]!, e.n[3] ?? 0.5, e.n[4] ?? 0.16, mat(e.name || 'paint-white', where));
    }
    for (const e of parseList(P.str('lines', ''))) {
      if (b.lod === 2) continue;
      const phi = e.n[0]! * DEG;
      const y0 = e.n[1]!;
      const y1 = e.n[2]!;
      const r = e.n[3] ?? 0.05;
      const off = R + r + 0.035;
      b.mat(mat(e.name || 'steel-brushed', where)).masks(0.1, 1, 0.2, 0);
      pipe(b, [polar(R - 0.05, phi, y0), polar(off, phi, y0), polar(off, phi, y1), polar(R - 0.05, phi, y1)], r, r * 2.2, { segs: b.pick(12, 8, 6), tag: 'line' });
      if (b.lod === 0) {
        b.mat('steel-bare');
        const n = Math.max(1, Math.round((y1 - y0) / 2.2));
        for (let i = 1; i < n; i++) b.at(radialFrame(R - 0.01, phi, y0 + ((y1 - y0) * i) / n), () => box(b, 0.06, r * 2 + 0.06, r * 2 + 0.05, [0, r + 0.03, 0], 'clamp'));
      }
    }
    for (const e of parseList(P.str('umbilicals', ''))) {
      b.masks(0.2, 1, 0.3, 0);
      if (b.lod < 2) umbilicalPlate(b, R, e.n[0]! * DEG, e.n[1]!, e.n[2]!, e.n[3]!, e.n[4] ?? 4);
    }
    for (const e of parseList(P.str('vents', ''))) {
      b.masks(0.2, 1, 0.1, 0.6);
      if (b.lod < 2) ventPort(b, R, e.n[0]! * DEG, e.n[1]!, e.n[2] ?? 0.06, e.n[3] ?? 0.12);
    }
    for (const e of parseList(P.str('doors', ''))) {
      const y = e.n[1]!;
      b.mat(y < aftTop ? aftMat : y > fwdBottom ? fwdMat : skin).masks(0.2, 1, 0.3, 0);
      accessDoor(b, R, e.n[0]! * DEG, y, e.n[2]!, e.n[3]!);
    }
    // ---- hold-down posts at the base ring
    const posts = P.num('holdDownPosts', 0);
    if (posts > 0 && b.lod < 2) {
      b.mat('steel-dark').masks(0.3, 1, 0.9, 0);
      for (let i = 0; i < posts; i++) {
        const phi = P.num('holdDownPhase', 45) * DEG + (i / posts) * TAU;
        b.at(radialFrame(R - 0.02, phi, 0.25), () => {
          box(b, 0.5, 0.2, 0.56, [0, 0.1, 0], 'post');
          if (b.lod === 0) {
            b.mat('steel-bare');
            for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.at(xf.translate(sx * 0.17, 0.2, sz * 0.2), () => bolt(b, 0.03, 0.02));
            b.mat('steel-dark');
          }
        });
      }
    }
    // ---- base heat shield and engine mounts
    if (baseY > 0) {
      b.mat('blanket-silver').masks(0, 0.75, 1, 0);
      lathe(b, Profile.at(0, baseY - 0.025).corner(Ri - 0.004, baseY - 0.025).corner(Ri - 0.004, baseY + 0.025).corner(0, baseY + 0.025), { segs: b.pick(96, 48, 16), tag: 'closeout' });
      if (b.lod === 0) {
        b.mat('steel-dark').masks(0.1, 0.7, 1, 0);
        for (const rr of [0.33, 0.66]) ringSolid(b, Ri * rr - 0.03, Ri * rr + 0.03, baseY - 0.06, baseY - 0.02, 72, 'rib');
        for (let i = 0; i < 16; i++) {
          const phi = (i / 16) * TAU + Math.PI / 16;
          b.at(xf.along(polar(Ri * 0.36, phi, baseY - 0.04), polar(Ri - 0.02, phi, baseY - 0.04), [0, 1, 0]), () => box(b, 0.04, Ri * 0.64 - 0.02, 0.06, [0, (Ri * 0.64 - 0.02) / 2, 0], 'rib'));
        }
      }
    }
    if (b.lod === 0 && engineNodes.length > 0) {
      b.mat('steel-dark').masks(0.1, 0.6, 0.5, 0);
      let rMount = 0;
      for (const n of engineNodes) {
        const rp = n.size / 2 + 0.04;
        b.at(xf.translate(n.pos[0], n.pos[1], n.pos[2]), () => frustum(b, rp, rp * 0.8, 0, 0.3, 28, 'mount'));
        rMount = Math.max(rMount, Math.hypot(n.pos[0], n.pos[2]));
      }
      const yTop = engineNodes[0]!.pos[1] + 0.3;
      // Thrust beams: a ring over the outer engines and a cruciform to the skirt.
      if (rMount > 0.5) ringSolid(b, rMount - 0.2, rMount + 0.2, yTop, yTop + 0.35, 64, 'thrust');
      for (let i = 0; i < 8; i++) {
        const phi = (i / 8) * TAU + Math.PI / 8;
        b.at(xf.along(polar(0.15, phi, yTop + 0.18), polar(Ri - 0.01, phi, yTop + 0.18), [0, 1, 0]), () => box(b, 0.35, Ri - 0.16, 0.14, [0, (Ri - 0.16) / 2, 0], 'thrust'));
      }
    }
    // ---- forward dome fittings and the inside of the forward skirt
    if (b.lod < 2 && H - fwdBottom > 0.3) {
      const eq = fwdApex - domeFwd;
      b.mat(innerMat).masks(0.1, 0.7, 0, 0);
      const nIn = b.pick(72, 36, 0);
      stringers(b, Ri - 0.045, eq + 0.25, Ri - 0.045, H - 0.08, nIn, 0.05, 0.045);
      b.mat('alu-machined');
      ringSolid(b, Ri - P.num('fwdFlange', 0.11), Ri - 0.002, H - 0.06, H, segs, 'flange');
      ringSolid(b, Ri - 0.09, Ri - 0.002, eq + 0.12, eq + 0.17, segs, 'frame');
      // Manhole cover at the apex with its bolt circle.
      b.mat('steel-brushed').masks(0.15, 0.85, 0, 0);
      lathe(b, Profile.at(0, fwdApex - 0.03).corner(0.42, fwdApex - 0.03).corner(0.42, fwdApex + 0.035).to(0.3, fwdApex + 0.06).to(0, fwdApex + 0.065), { segs: b.pick(40, 20, 8), tag: 'manhole' });
      if (b.lod === 0) {
        b.mat('steel-bare');
        boltCircle(b, 0.37, fwdApex + 0.035, 24, 0.014, 0.012);
        // Vent / relief line from the dome to the skirt wall, pressurisation line and a sensor conduit.
        b.mat('steel-brushed').masks(0.1, 0.8, 0, 0.5);
        const domeY = (r: number): number => eq + domeFwd * Math.sqrt(Math.max(0, 1 - (r / Ri) ** 2));
        const run = (phi: number, r0: number, rad: number): void => {
          const pts: Vec3Tuple[] = [polar(r0, phi, domeY(r0) - 0.02), polar(r0, phi, domeY(r0) + 0.22)];
          for (const f of [0.45, 0.65, 0.82, 0.93]) pts.push(polar(Ri * f, phi, Math.max(domeY(Ri * f) + 0.16, eq + 0.4)));
          pts.push(polar(Ri - 0.03, phi, Math.max(domeY(Ri * 0.93) + 0.16, eq + 0.4)));
          pipe(b, pts, rad, rad * 3, { segs: 10, tag: 'line' });
        };
        run(35 * DEG, 0.9, 0.06);
        run(170 * DEG, 1.3, 0.035);
        b.mat('steel-dark');
        run(260 * DEG, 0.6, 0.018);
        // Relief valve body on the vent line.
        b.mat('alu-cast');
        b.at(xf.translate(...polar(0.9, 35 * DEG, domeY(0.9) + 0.22)), () => frustum(b, 0.11, 0.11, -0.08, 0.14, 16, 'valve'));
      }
    }
  };

  const body = buildModel(`${def.id}.body`, (b) => {
    shell(b);
    detail(b);
  });
  return { models: { body }, pose: staticPose };
};
