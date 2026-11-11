/**
 * Water tower, propellant tank farms (vacuum-jacketed spheres, horizontal bullets, vaporisers, pump skid,
 * vent stack, dike) and the low support buildings of the launch complex.
 *
 * Every marking (tank labels, signs) is named by the structure's parameters and looked up in the decal sheet
 * of the definition library; without a name the surface stays plain.
 */
import type { Vec3Tuple } from '@/core/math';
import { decalSheetOf, type DecalSheet } from '../decals';
import { MeshBuilder, polar, xf } from '../geom/builder';
import { Profile, TAU, ball, bottle, box, extrude, frustum, iSection, lathe, phisWith, pipe, ringSolid, rod, section, torus, tube, type LatheRegion } from '../geom/prims';
import { band, bandRegion, buildModel, decalRegion, parseList, regionBounds, regionHeights } from '../parts/common';
import type { PartLight } from '../parts/types';
import { handrail } from './pad';
import { boardDecal } from './tower';
import { numParam, staticSite, strParam, type SiteGenerator } from './types';

/** Sphere tank on a ring of legs with cross bracing; `label` (may be empty) is a decal on its equator. */
function sphereTank(b: MeshBuilder, sheet: DecalSheet, radius: number, centreY: number, label: string, legs: number): void {
  b.mat('paint-white').masks(0.1, 1, 0.3, 0.5);
  const n = b.pick(20, 10, 5);
  const p = Profile.at(0, centreY - radius);
  p.pts[0]!.hard = false;
  for (let i = 1; i < n; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / n;
    if (i === Math.round(n * 0.38)) p.mark('s0');
    if (i === Math.round(n * 0.62)) p.mark('s1');
    // The shell is welded from courses of gore plates: alternate courses have aged to a slightly different sheen.
    p.mat(Math.floor((i * 6) / n) % 2 === 0 ? 'paint-white' : 'paint-white-b');
    p.to(radius * Math.cos(a), centreY + radius * Math.sin(a));
  }
  p.to(0, centreY + radius);
  const regions: LatheRegion[] = [];
  if (b.lod < 2) {
    if (label) regions.push(decalRegion(sheet, label, radius, 200, centreY, radius * 0.22, false, ['s0', 's1']));
    regions.push(bandRegion('paint-navy', 0, 360, centreY - radius * 0.2, centreY - radius * 0.15, ['s0', 's1']));
  }
  p.splitAtY('s0', 's1', regionHeights(regions));
  lathe(b, p, { phis: phisWith(b.pick(72, 36, 14), regionBounds(regions)), regions, tag: 'sphere' });
  if (b.lod === 2) return;
  // Weld lands between the plate courses, and the meridian welds of the gores (heavier in the middle LOD).
  b.mat('paint-white-b').masks(0.25, 1, 0.3, 0.5);
  for (let c = 1; c < 6; c++) {
    const a = -Math.PI / 2 + (Math.PI * c) / 6;
    const w = 0.02;
    const land = Profile.at((radius - 0.002) * Math.cos(a - w), centreY + (radius - 0.002) * Math.sin(a - w))
      .to((radius + 0.012) * Math.cos(a - w * 0.5), centreY + (radius + 0.012) * Math.sin(a - w * 0.5))
      .to((radius + 0.012) * Math.cos(a + w * 0.5), centreY + (radius + 0.012) * Math.sin(a + w * 0.5))
      .to((radius - 0.002) * Math.cos(a + w), centreY + (radius - 0.002) * Math.sin(a + w));
    land.pts[0]!.hard = false;
    lathe(b, land, { segs: b.pick(72, 36, 14), closed: false, tag: 'band' });
  }
  const gores = 16;
  for (let g = 0; g < gores; g++) {
    const phi = ((g + 0.5) / gores) * TAU;
    const pts: Vec3Tuple[] = [];
    for (let i = 0; i <= 14; i++) {
      const a = -Math.PI / 2 + 0.22 + ((Math.PI - 0.44) * i) / 14;
      pts.push(polar((radius + 0.004) * Math.cos(a), phi, centreY + (radius + 0.004) * Math.sin(a)));
    }
    tube(b, pts, b.pick(0.02, 0.05, 0.05), { segs: 4, tag: 'seam' });
  }
  // Legs tangent to the equator, bracing, top dome fitting and the stair up the side.
  b.mat('paint-grey').masks(0.2, 1, 0.3, 0);
  const rl = radius * 0.94;
  for (let k = 0; k < legs; k++) {
    const phi = (k / legs) * TAU;
    rod(b, polar(rl, phi, -0.3), polar(rl, phi, centreY - radius * 0.2), radius * 0.035, b.pick(12, 8, 5), 'leg');
    const next = ((k + 1) / legs) * TAU;
    rod(b, polar(rl, phi, 0.4), polar(rl, next, centreY - radius * 0.45), radius * 0.012, b.pick(6, 5, 4), 'brace');
    if (b.lod === 0) {
      rod(b, polar(rl, next, 0.4), polar(rl, phi, centreY - radius * 0.45), radius * 0.012, 6, 'brace');
      b.mat('concrete-wall');
      b.at(xf.translate(...polar(rl, phi, 0)), () => frustum(b, radius * 0.09, radius * 0.07, -0.3, 0.35, 10, 'leg-footing'));
      b.mat('paint-grey');
    }
  }
  b.mat('steel-brushed').masks(0.15, 1, 0.3, 0.3);
  frustum(b, radius * 0.11, radius * 0.11, centreY + radius - 0.05, centreY + radius + 0.9, b.pick(20, 10, 6), 'dome-fitting');
  pipe(b, [[0, centreY + radius + 0.6, 0], [radius * 0.5, centreY + radius + 0.6, 0], polar(radius * 1.02, 0.6, centreY + radius * 0.5), polar(radius * 1.02, 0.6, 0.4)], radius * 0.02, radius * 0.2, { segs: b.pick(8, 6, 4), tag: 'vent-line' });
  // Fill / drain line with its valve at the bottom of the sphere.
  pipe(b, [[0, centreY - radius + 0.05, 0], [0, 1.2, 0], [radius * 0.8, 1.2, radius * 0.3], [radius * 1.25, 1.2, radius * 0.3]], radius * 0.03, radius * 0.12, { segs: b.pick(10, 6, 4), tag: 'fill-line' });
  if (b.lod === 0) {
    b.mat('paint-red').masks(0.2, 1, 0.3, 0);
    b.at(xf.mul(xf.translate(radius * 0.8, 1.2 + radius * 0.07, radius * 0.3), xf.rotX(0)), () => torus(b, radius * 0.035, radius * 0.006, 0, 16, 6, 'handwheel'));
    b.mat('steel-dark');
    rod(b, [radius * 0.8, 1.2, radius * 0.3], [radius * 0.8, 1.2 + radius * 0.07, radius * 0.3], radius * 0.008, 6, 'valve-stem');
  }
  // Access: caged ladder up one leg line and the walkway to the dome fitting.
  b.mat('galvanised').masks(0.2, 1, 0.3, 0);
  box(b, 1.1, 0.06, radius * 0.5, [radius * 0.25, centreY + radius + 0.02, 0], 'top-walkway');
  handrail(b, [[radius * 0.25 - 0.5, centreY + radius + 0.05, -radius * 0.25], [radius * 0.25 - 0.5, centreY + radius + 0.05, radius * 0.25]], 1.0, 1.2);
  handrail(b, [[radius * 0.25 + 0.5, centreY + radius + 0.05, -radius * 0.25], [radius * 0.25 + 0.5, centreY + radius + 0.05, radius * 0.25]], 1.0, 1.2);
  if (b.lod === 0) {
    const phiL = 2.4;
    const stand = radius * 1.01;
    const steps = 22;
    let prev: Vec3Tuple | null = null;
    for (let i = 0; i <= steps; i++) {
      // Ladder that follows the sphere from the equator up to the walkway.
      const a = (Math.PI / 2) * (i / steps) * 0.96;
      const q = polar(stand * Math.cos(a) + 0.12, phiL, centreY + stand * Math.sin(a));
      if (prev) for (const s of [-0.25, 0.25]) rod(b, [prev[0] + s * Math.cos(phiL), prev[1], prev[2] - s * Math.sin(phiL)], [q[0] + s * Math.cos(phiL), q[1], q[2] - s * Math.sin(phiL)], 0.02, 5, 'ladder-rail');
      rod(b, [q[0] - 0.25 * Math.cos(phiL), q[1], q[2] + 0.25 * Math.sin(phiL)], [q[0] + 0.25 * Math.cos(phiL), q[1], q[2] - 0.25 * Math.sin(phiL)], 0.014, 5, 'rung');
      prev = q;
    }
    for (const s of [-0.25, 0.25]) rod(b, [polar(stand + 0.12, phiL, 0.2)[0] + s * Math.cos(phiL), 0.2, polar(stand + 0.12, phiL, 0.2)[2] - s * Math.sin(phiL)], [polar(stand + 0.12, phiL, centreY)[0] + s * Math.cos(phiL), centreY, polar(stand + 0.12, phiL, centreY)[2] - s * Math.sin(phiL)], 0.02, 5, 'ladder-rail');
  }
}

export const padWaterTower: SiteGenerator = ({ params, defs }) => {
  const sheet = decalSheetOf(defs);
  const colH = numParam(params, 'columnHeight', 52);
  const tankR = numParam(params, 'tankRadius', 9.5);
  const tankH = numParam(params, 'tankHalfHeight', 6.5);
  // Markings on the tank: "decal@azimuthDeg,height as a fraction of the tank's half height;...".
  const labels = parseList(strParam(params, 'labels', '')).map((e) => ({ name: e.name, az: e.n[0]!, size: e.n[1]! }));
  const body = buildModel('pad.waterTower', (b) => {
    // Pedestal sphere: a fluted column flaring into the tank.
    b.mat('paint-white').masks(0.1, 1, 0.3, 0);
    const p = Profile.at(0, -0.4).corner(4.6, -0.4).to(4.2, 1.5).to(3.0, colH * 0.3).to(2.6, colH * 0.75).to(2.4, colH - 0.25 * tankH - 1.2);
    const n = b.pick(16, 8, 4);
    const cy = colH + tankH * 0.75;
    for (let i = 1; i < n; i++) {
      const a = -Math.PI * 0.42 + (Math.PI * 0.92 * i) / n;
      if (i === Math.round(n * 0.36)) p.mark('t0');
      if (i === Math.round(n * 0.6)) p.mark('t1');
      p.to(tankR * Math.cos(a), cy + tankH * Math.sin(a));
    }
    p.to(0, cy + tankH);
    const regions: LatheRegion[] = [];
    if (b.lod < 2) {
      for (const l of labels) regions.push(decalRegion(sheet, l.name, tankR, l.az, cy - tankH * 0.05, tankH * l.size, false, ['t0', 't1']));
      regions.push(bandRegion('paint-navy', 0, 360, cy - tankH * 0.42, cy - tankH * 0.34, ['t0', 't1']));
    }
    p.splitAtY('t0', 't1', regionHeights(regions));
    lathe(b, p, { phis: phisWith(b.pick(72, 36, 14), regionBounds(regions)), regions, tag: 'water-tower' });
    if (b.lod === 2) return;
    b.mat('paint-red').masks(0.2, 1, 0.3, 0);
    // Deluge main down the column and away toward the pad (the run to the pad is a pipe-run structure).
    pipe(b, [[3.2, colH * 0.8, 0], [4.2, colH * 0.7, 0], [5.2, 1.6, 0], [9, 1.6, 0]], 0.55, 2, { segs: b.pick(14, 8, 5), tag: 'main' });
    if (b.lod === 0) {
      // Pipe clamps to the column, the isolation valve with its handwheel, the access door at the base.
      b.mat('steel-dark').masks(0.2, 1, 0.3, 0);
      for (const f of [0.2, 0.4, 0.6]) box(b, 1.6, 0.25, 0.5, [4.1 + 0.6 * (0.7 - f), colH * f, 0], 'pipe-clamp');
      b.at(xf.mul(xf.translate(7.2, 1.6, 0), xf.rotZ(Math.PI / 2)), () => frustum(b, 0.75, 0.75, -0.5, 0.5, 18, 'valve-body'));
      b.mat('paint-yellow');
      b.at(xf.translate(7.2, 2.9, 0), () => torus(b, 0.5, 0.045, 0, 20, 6, 'handwheel'));
      b.mat('steel-dark');
      rod(b, [7.2, 2.2, 0], [7.2, 2.9, 0], 0.05, 8, 'valve-stem');
      b.mat('paint-grey');
      b.at(xf.rotY(2.2), () => box(b, 1.1, 2.1, 0.12, [0, 1.25, 4.18], 'door'));
    }
    b.mat('galvanised').masks(0.2, 1, 0.3, 0);
    lathe(b, Profile.at(tankR * 0.3, cy + tankH * 0.93).corner(tankR * 0.45, cy + tankH * 0.93).corner(tankR * 0.45, cy + tankH * 0.93 + 1.1).corner(tankR * 0.3, cy + tankH * 0.93 + 1.1).corner(tankR * 0.3, cy + tankH * 0.93).close(), { segs: 24, tag: 'crown-rail' });
    rod(b, [0, cy + tankH, 0], [0, cy + tankH + 6, 0], 0.08, 6, 'mast');
    b.mat('concrete-wall');
    frustum(b, 6.5, 6.5, -0.5, 0.25, b.pick(32, 16, 8), 'footing');
  });
  const beacons = buildModel('pad.waterTower.beacons', (b) => {
    b.mat('lamp-red').masks(0, 1, 0, 0);
    b.at(xf.translate(0, colH + tankH * 1.75 + 6.2, 0), () => ball(b, 0.25, 0, b.pick(10, 6, 5), b.pick(6, 4, 3), 0.25, 'beacon'));
  });
  return {
    models: { body, beacons },
    pose: (state, emit) => {
      emit('body', null, null);
      emit('beacons', null, null, { emissive: state.night, castShadow: false });
    },
  };
};

/** Finned ambient vaporiser tube: a star section standing on the local XZ plane. */
function vaporiser(b: MeshBuilder, height: number): void {
  if (b.lod > 0) {
    box(b, 0.42, height, 0.42, [0, height / 2, 0], 'vaporiser');
    return;
  }
  const star: [number, number][] = [];
  const fins = 8;
  for (let i = 0; i < fins * 2; i++) {
    const a = (i / (fins * 2)) * TAU;
    const r = i % 2 === 0 ? 0.24 : 0.07;
    // Counter-clockwise seen from +Y: x = r sin, z = r cos runs clockwise in (x, z), so walk it backwards.
    star.push([r * Math.sin(-a), r * Math.cos(-a)]);
  }
  extrude(b, star, 0, height, false, 'vaporiser');
}

/** Centrifugal pump set on the local XZ plane, shaft along +X: motor, coupling guard, volute, flanges. */
function pumpSet(b: MeshBuilder): void {
  b.mat('paint-navy').masks(0.2, 1, 0.3, 0);
  b.at(xf.mul(xf.translate(-0.9, 0.55, 0), xf.rotZ(-Math.PI / 2)), () => {
    frustum(b, 0.34, 0.34, 0, 1.0, b.pick(20, 10, 6), 'motor');
    if (b.lod === 0) for (let i = 1; i < 8; i++) band(b, 0.34, i * 0.12, 0.03, 0.03, 20, 'motor-fin');
    frustum(b, 0.36, 0.3, -0.16, 0, b.pick(20, 10, 6), 'fan-cowl');
  });
  b.mat('paint-yellow');
  box(b, 0.34, 0.3, 0.34, [0.27, 0.55, 0], 'coupling-guard');
  b.mat('steel-dark').masks(0.2, 1, 0.3, 0.3);
  b.at(xf.mul(xf.translate(0.45, 0.55, 0), xf.rotZ(-Math.PI / 2)), () => frustum(b, 0.42, 0.42, 0, 0.36, b.pick(20, 10, 6), 'volute'));
  b.mat('steel-brushed').masks(0.15, 1, 0.3, 0.5);
  pipe(b, [[0.63, 0.55, 0], [1.3, 0.55, 0]], 0.16, 0.2, { segs: b.pick(12, 8, 5), tag: 'suction' });
  pipe(b, [[0.63, 0.95, 0], [0.63, 1.55, 0]], 0.13, 0.2, { segs: b.pick(12, 8, 5), tag: 'discharge' });
  if (b.lod === 0) {
    b.mat('steel-bare');
    b.at(xf.mul(xf.translate(1.05, 0.55, 0), xf.rotZ(-Math.PI / 2)), () => ringSolid(b, 0.16, 0.27, -0.03, 0.03, 16, 'flange'));
    b.at(xf.translate(0.63, 1.3, 0), () => ringSolid(b, 0.13, 0.23, -0.03, 0.03, 16, 'flange'));
  }
  b.mat('paint-grey').masks(0.2, 1, 0.3, 0);
  box(b, 2.5, 0.12, 0.9, [0.1, 0.12, 0], 'base-plate');
}

export const padTankFarm: SiteGenerator = ({ params, defs }) => {
  const sheet = decalSheetOf(defs);
  const kind = strParam(params, 'propellant', 'lox-ch4');
  const hx = numParam(params, 'halfX', 34);
  const hz = numParam(params, 'halfZ', 26);
  const sphereLabel = strParam(params, 'sphereLabel', '');
  const bulletLabel = strParam(params, 'bulletLabel', '');
  const body = buildModel(`pad.tankFarm.${kind}`, (b) => {
    // Gravel pad inside a low concrete dike.
    b.mat('gravel').masks(0, 1, 0.2, 0);
    box(b, 2 * hx, 0.5, 2 * hz, [0, -0.1, 0], 'pad');
    b.mat('concrete-wall').masks(0, 1, 0.3, 0);
    for (const s of [-1, 1]) {
      box(b, 2 * hx + 1, 1.5, 0.5, [0, 0.45, s * hz], 'dike');
      box(b, 0.5, 1.5, 2 * hz + 1, [s * hx, 0.45, 0], 'dike');
    }
    if (b.lod < 2) {
      // Steps over the dike, light poles at the corners.
      b.mat('galvanised').masks(0.2, 1, 0.3, 0);
      for (const s of [-1, 1]) {
        box(b, 1.2, 0.08, 1.5, [hx * 0.6, 1.24, s * hz], 'dike-crossing');
        for (const o of [-1, 1]) for (let k = 0; k < 4; k++) box(b, 1.2, 0.05, 0.28, [hx * 0.6, 0.25 + k * 0.28, s * hz + o * (1.9 - k * 0.3)], 'dike-step');
        if (b.lod === 0) handrail(b, [[hx * 0.6 - 0.6, 1.28, s * hz - 0.75], [hx * 0.6 - 0.6, 1.28, s * hz + 0.75]], 1.0, 0.75);
      }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        rod(b, [sx * (hx - 2), 0, sz * (hz - 2)], [sx * (hx - 2), 9, sz * (hz - 2)], 0.09, b.pick(8, 6, 4), 'light-pole');
        box(b, 0.5, 0.14, 0.9, [sx * (hx - 2) - sx * 0.2, 9.05, sz * (hz - 2) - sz * 0.3], 'light-head');
      }
    }
    if (kind === 'lh2') {
      // Liquid hydrogen: one large jacketed sphere, gas tube banks, a tall vent stack.
      b.at(xf.translate(-hx * 0.3, 0, 0), () => sphereTank(b, sheet, 10.5, 12.5, sphereLabel, 10));
      for (const z of [-hz * 0.55, hz * 0.55]) {
        b.at(xf.translate(hx * 0.5, 0, z), () => {
          b.mat('steel-brushed').masks(0.15, 1, 0.3, 0);
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) b.at(xf.mul(xf.translate(-5.5, 1.3 + j * 0.72, (i - 1) * 0.72), xf.rotZ(-Math.PI / 2)), () => bottle(b, 0.3, 10.4, 0.3, b.pick(12, 8, 5), 'tube'));
          if (b.lod < 2) {
            b.mat('paint-grey');
            for (const x of [-4.5, 0, 4.5]) {
              // Open rack frames between the tubes, not slabs.
              for (const s of [-1, 1]) box(b, 0.16, 3.3, 0.16, [x, 1.65, s * 1.25], 'rack-post');
              for (const y of [0.92, 1.64, 2.36, 3.2]) box(b, 0.14, 0.1, 2.5, [x, y, 0], 'rack-rail');
            }
            b.mat('steel-bare').masks(0.2, 1, 0.3, 0);
            pipe(b, [[5.3, 1.3, -0.72], [5.6, 1.3, -0.72], [5.6, 2.74, -0.72], [5.6, 2.74, 0.72], [5.6, 0.5, 0.72]], 0.06, 0.15, { segs: b.pick(8, 6, 4), tag: 'bank-manifold' });
          }
        });
      }
      b.mat('steel-brushed').masks(0.1, 1, 0.3, 0);
      rod(b, [hx * 0.8, 0, 0], [hx * 0.8, 38, 0], 0.22, b.pick(10, 6, 5), 'vent-stack');
      if (b.lod < 2) {
        frustum(b, 0.36, 0.3, 37.5, 39.2, 10, 'flare-tip');
        for (let k = 0; k < 3; k++) rod(b, [hx * 0.8, 26, 0], [hx * 0.8 + 9 * Math.sin((k / 3) * TAU), 0.2, 9 * Math.cos((k / 3) * TAU)], b.pick(0.025, 0.06, 0), 4, 'guy');
        pipe(b, [[-hx * 0.3, 1.2, 9.5], [-hx * 0.3, 1.2, hz * 0.8], [hx * 0.8, 1.2, hz * 0.8], [hx * 0.8, 1.2, 0.5]], 0.14, 0.6, { segs: b.pick(8, 6, 4), tag: 'vent-header' });
        b.mat('galvanised').masks(0.2, 1, 0.3, 0);
        for (let i = 0; i < 6; i++) box(b, 0.2, 1.05, 0.2, [-hx * 0.3 + (hx * 1.1 * i) / 5, 0.52, hz * 0.8], 'pipe-support');
      }
    } else {
      // Liquid oxygen sphere and two horizontal methane bullets with their vaporiser bank and pump skid.
      b.at(xf.translate(-hx * 0.42, 0, -hz * 0.1), () => sphereTank(b, sheet, 8.5, 10.5, sphereLabel, 8));
      for (const z of [-7, 7]) {
        b.at(xf.translate(hx * 0.3, 4.2, z + hz * 0.1), () => {
          b.mat('paint-white').masks(0.1, 1, 0.3, 0.3);
          // Bullet along X: the lathe axis is turned onto +X; the label region sits on its side.
          // The south bullet is turned so that its label reads upright from the south, the north one from the north.
          b.at(xf.rotZ(z > 0 ? -Math.PI / 2 : Math.PI / 2), () => {
            const n = b.pick(8, 4, 2);
            const R = 2.7;
            const L = 22;
            const p = Profile.at(0, -L / 2 - 1.6);
            p.pts[0]!.hard = false;
            for (let i = 1; i <= n; i++) {
              const a = -Math.PI / 2 + ((Math.PI / 2) * i) / n;
              p.to(R * Math.cos(a), -L / 2 + 1.6 * Math.sin(a));
            }
            p.mark('b0').to(R, L / 2).mark('b1');
            for (let i = 1; i <= n; i++) {
              const a = ((Math.PI / 2) * i) / n;
              p.to(R * Math.cos(a), L / 2 + 1.6 * Math.sin(a));
            }
            const regions = b.lod < 2 && bulletLabel ? [decalRegion(sheet, bulletLabel, R, z > 0 ? 0 : 180, 0, 1.3, true, ['b0', 'b1'])] : [];
            p.splitAtY('b0', 'b1', regionHeights(regions));
            lathe(b, p, { phis: phisWith(b.pick(40, 20, 10), regionBounds(regions)), regions, tag: 'bullet' });
            if (b.lod < 2) {
              b.mat('steel-bare');
              for (const y of [-7, 0, 7]) band(b, R, y, 0.12, 0.02, b.pick(40, 20, 10), 'strap');
            }
          });
          b.mat('concrete-wall');
          for (const x of [-7.5, 7.5]) box(b, 1.2, 3.4, 5, [x, -2.6, 0], 'saddle');
          if (b.lod < 2) {
            // Relief valves and the manway on the crown, the catwalk along it.
            b.mat('steel-brushed').masks(0.15, 1, 0.3, 0.3);
            for (const x of [-6, 5]) rod(b, [x, 2.6, 0], [x, 3.7, 0], 0.11, b.pick(10, 6, 4), 'relief-valve');
            frustum(b, 0.45, 0.45, 2.62, 2.95, b.pick(18, 10, 6), 'manway');
            b.mat('galvanised').masks(0.2, 1, 0.3, 0);
            box(b, 16, 0.05, 0.8, [0, 2.9, 0.9], 'catwalk');
            if (b.lod === 0) handrail(b, [[-8, 2.92, 1.3], [8, 2.92, 1.3]], 1.0, 2);
          }
        });
      }
      if (b.lod < 2) {
        // Ambient vaporisers: banks of finned tubes between a bottom and a top header.
        const vx = hx * 0.72;
        const vz = -hz * 0.75;
        b.mat('alu-machined').masks(0.2, 1, 0.3, 0.8);
        for (let i = 0; i < 4; i++) for (let j = 0; j < 6; j++) b.at(xf.translate(vx + i * 1.1, 0.45, vz + j * 1.1), () => vaporiser(b, 6.9));
        b.mat('steel-brushed').masks(0.15, 1, 0.3, 0.6);
        for (let i = 0; i < 4; i++) {
          for (const y of [0.4, 7.4]) pipe(b, [[vx + i * 1.1, y, vz - 0.5], [vx + i * 1.1, y, vz + 6.0]], 0.09, 0.2, { segs: b.pick(8, 6, 4), tag: 'vaporiser-header' });
        }
        pipe(b, [[vx - 0.6, 7.4, vz - 0.5], [vx + 3.9, 7.4, vz - 0.5]], 0.11, 0.2, { segs: b.pick(8, 6, 4), tag: 'vaporiser-header' });
        b.mat('paint-grey').masks(0.2, 1, 0.3, 0);
        box(b, 5, 0.3, 7.2, [vx + 1.65, 0.2, vz + 2.75], 'vaporiser-base');
        for (const sx of [-0.55, 3.85]) for (const sz of [-0.55, 6.05]) box(b, 0.14, 7.6, 0.14, [vx + sx, 3.9, vz + sz], 'vaporiser-frame');
        // Pump skid: two pump sets on a steel base with a control cabinet, and the manifold.
        const px = -hx * 0.05;
        const pz = hz * 0.72;
        b.mat('paint-grey').masks(0.2, 1, 0.3, 0);
        for (const s of [-1, 1]) {
          if (b.lod === 0) section(b, iSection(0.2, 0.3, 0.02), [px - 3, 0.3, pz + s * 1.1], [px + 3, 0.3, pz + s * 1.1], [0, 0, 1], 'skid-beam');
          else box(b, 6, 0.3, 0.2, [px, 0.3, pz + s * 1.1], 'skid-beam');
        }
        for (const x of [-2.9, -1, 1, 2.9]) box(b, 0.2, 0.2, 2.4, [px + x, 0.3, pz], 'skid-cross');
        for (const x of [-1.6, 1.4]) b.at(xf.translate(px + x, 0.4, pz - 0.2), () => pumpSet(b));
        b.mat('paint-grey').masks(0.2, 1, 0.3, 0);
        box(b, 0.9, 1.8, 0.5, [px - 2.7, 1.35, pz + 0.85], 'control-cabinet');
        if (b.lod === 0) {
          b.mat('steel-bare');
          box(b, 0.02, 1.6, 0.02, [px - 2.7, 1.35, pz + 0.595], 'cabinet-seam');
          rod(b, [px - 2.55, 1.4, pz + 0.61], [px - 2.55, 1.6, pz + 0.61], 0.012, 5, 'cabinet-handle');
        }
        b.mat('steel-brushed').masks(0.1, 1, 0.3, 0.5);
        pipe(b, [[-hx * 0.42, 1.4, -hz * 0.1 + 8], [-hx * 0.42, 1.4, hz * 0.72 + 1.7], [hx * 0.9, 1.4, hz * 0.72 + 1.7]], 0.28, 1, { segs: b.pick(12, 8, 5), tag: 'manifold' });
        pipe(b, [[hx * 0.3, 1.4, hz * 0.1], [hx * 0.3, 1.4, hz * 0.72 + 1.7]], 0.2, 0.8, { segs: b.pick(10, 6, 5), tag: 'manifold' });
        b.mat('galvanised').masks(0.2, 1, 0.3, 0);
        for (let i = 0; i < 7; i++) box(b, 0.22, 1.1, 0.22, [-hx * 0.42 + (hx * 1.3 * i) / 6, 0.55, hz * 0.72 + 1.7], 'pipe-support');
        b.mat('paint-yellow');
        handrail(b, [[-hx + 1, 1.2, -hz + 1], [hx - 1, 1.2, -hz + 1]], 1.0, 4);
      }
    }
  });
  return { models: { body }, pose: staticSite };
};

/**
 * Support building (equipment and operations): precast wall panels on a plinth, roll-up doors with frames
 * and bollards on the -Z side, a personnel door with a canopy and windows on the +Z side, parapet with
 * coping, gutters and downpipes, conduits and a transformer on the +X end, air handlers, ducts, exhaust
 * stacks, a roof hatch and an aerial on the ballasted roof.
 */
export const padBuilding: SiteGenerator = ({ params, defs }) => {
  const sheet = decalSheetOf(defs);
  const sx = numParam(params, 'sizeX', 30);
  const sz = numParam(params, 'sizeZ', 14);
  const h = numParam(params, 'height', 7);
  const sign = strParam(params, 'signDecal', '');
  const doors = Math.max(1, Math.round(sx / 9));
  const doorW = Math.min(4.6, sx / doors - 1.6);
  const doorH = Math.min(h - 1.2, 5.2);
  const doorX = (i: number): number => -sx / 2 + (sx * (i + 0.5)) / doors;
  const manX = sx / 2 - 2;
  const units = Math.max(1, Math.round(sx / 11));
  const unitX = (i: number): number => (units === 1 ? -sx * 0.12 : -sx * 0.32 + (i * sx * 0.64) / (units - 1));

  const body = buildModel('pad.building', (b) => {
    // ---- core, plinth, parapet, roof
    b.mat('concrete-wall').masks(0, 1, 0.3, 0);
    box(b, sx, h + 0.4, sz, [0, h / 2 - 0.2, 0], 'building');
    box(b, sx + 0.24, 0.9, sz + 0.24, [0, 0.25, 0], 'plinth');
    for (const s of [-1, 1]) {
      box(b, sx + 0.3, 0.75, 0.3, [0, h + 0.375, s * (sz / 2)], 'parapet');
      box(b, 0.3, 0.75, sz - 0.3, [s * (sx / 2), h + 0.375, 0], 'parapet');
    }
    b.mat('gravel').masks(0, 1, 0.3, 0);
    box(b, sx - 0.3, 0.1, sz - 0.3, [0, h + 0.05, 0], 'roof-ballast');
    b.mat('galvanised').masks(0.2, 1, 0.3, 0);
    for (const s of [-1, 1]) {
      box(b, sx + 0.44, 0.05, 0.4, [0, h + 0.775, s * (sz / 2)], 'coping');
      box(b, 0.4, 0.05, sz - 0.4, [s * (sx / 2), h + 0.775, 0], 'coping');
    }
    // ---- roof plant
    for (let i = 0; i < units; i++) {
      const x = unitX(i);
      b.mat('galvanised').masks(0.2, 1, 0.3, 0);
      box(b, 2.4, 1.3, 2.0, [x, h + 0.95, 0.4], 'air-handler');
      if (b.lod === 2) continue;
      b.mat('paint-grey').masks(0.2, 1, 0.3, 0);
      for (const s of [-1, 1]) box(b, 2.6, 0.2, 0.16, [x, h + 0.2, 0.4 + s * 0.85], 'plant-rail');
      // Supply duct from the unit to its roof penetration.
      b.mat('galvanised').masks(0.2, 1, 0.3, 0);
      box(b, 0.7, 0.55, 2.2, [x, h + 0.75, -1.7], 'duct');
      box(b, 0.9, 0.5, 0.9, [x, h + 0.35, -2.9], 'duct-curb');
      if (b.lod === 0) {
        // Condenser fans under guards, louvred intake, service panel.
        for (const s of [-0.55, 0.55]) {
          b.mat('steel-dark').masks(0.2, 1, 0.3, 0);
          b.at(xf.translate(x + s, h + 1.6, 0.4), () => frustum(b, 0.44, 0.44, 0, 0.02, 20, 'fan'));
          b.mat('galvanised');
          b.at(xf.translate(x + s, h + 1.6, 0.4), () => ringSolid(b, 0.44, 0.5, 0, 0.1, 20, 'fan-shroud'));
          for (const a of [0, Math.PI / 2]) b.at(xf.mul(xf.translate(x + s, h + 1.69, 0.4), xf.rotY(a)), () => box(b, 0.96, 0.015, 0.02, [0, 0, 0], 'fan-guard'));
        }
        b.mat('steel-dark').masks(0.2, 1, 0.3, 0);
        for (let k = 0; k < 7; k++) box(b, 1.9, 0.07, 0.03, [x, h + 0.55 + k * 0.13, 1.41], 'louvre');
        b.mat('alu-machined');
        box(b, 0.02, 0.9, 1.2, [x + 1.205, h + 0.95, 0.4], 'service-panel');
      }
    }
    if (b.lod === 2) return;
    b.mat('steel-brushed').masks(0.2, 1, 0.3, 0);
    for (const dx of [-0.5, 0.5]) {
      const x = -sx / 2 + 2.2 + dx;
      rod(b, [x, h + 0.1, -sz / 2 + 1.8], [x, h + 2.4, -sz / 2 + 1.8], 0.14, b.pick(12, 8, 5), 'exhaust-stack');
      b.at(xf.translate(x, h + 2.5, -sz / 2 + 1.8), () => frustum(b, 0.26, 0.05, 0, 0.18, b.pick(12, 8, 5), 'stack-cap'));
    }
    b.mat('paint-grey').masks(0.2, 1, 0.3, 0);
    box(b, 0.9, 0.35, 0.9, [sx / 2 - 2.2, h + 0.27, -sz / 2 + 2], 'roof-hatch');
    rod(b, [-sx / 2 + 1, h + 0.1, sz / 2 - 1], [-sx / 2 + 1, h + 5.2, sz / 2 - 1], b.pick(0.05, 0.09, 0.09), 6, 'aerial');
    if (b.lod === 0) for (const y of [3.6, 4.4]) rod(b, [-sx / 2 + 0.4, h + y, sz / 2 - 1], [-sx / 2 + 1.6, h + y, sz / 2 - 1], 0.018, 5, 'aerial-element');

    // ---- precast wall panels with open joints (the core shows in the joints)
    b.mat('concrete-wall').masks(0, 1, 0.3, 0);
    const panel = (len: number, place: (u: number, w: number) => void): void => {
      const n = Math.max(1, Math.round(len / 3.2));
      const w = len / n;
      for (let i = 0; i < n; i++) place(-len / 2 + w * (i + 0.5), w - 0.05);
    };
    const py = (h + 0.75) / 2 + 0.36;
    const ph = h - 0.75;
    for (const s of [-1, 1]) {
      panel(sx, (u, w) => {
        // Door bays on the -Z side stay open.
        if (s < 0 && Array.from({ length: doors }, (_, i) => doorX(i)).some((x) => Math.abs(x - u) < doorW / 2 + w / 2 + 0.2)) return;
        if (s > 0 && Math.abs(u - manX) < 0.7 + w / 2) return;
        box(b, w, ph, 0.1, [u, py, s * (sz / 2 + 0.04)], 'wall-panel');
      });
      panel(sz, (u, w) => box(b, 0.1, ph, w, [s * (sx / 2 + 0.04), py, u], 'wall-panel'));
    }
    // Lintel band over the door bays and beside the personnel door.
    box(b, sx, h - doorH - 0.6, 0.1, [0, (h + doorH + 0.9) / 2 + 0.06, -(sz / 2 + 0.04)], 'lintel');
    box(b, 1.5 + 3.2, h - 2.5 - 0.3, 0.1, [manX, (h + 2.5 + 1.1) / 2 - 0.05, sz / 2 + 0.04], 'lintel');

    // ---- roll-up doors: frame, curtain of slats, bottom bar, bollards, threshold apron
    for (let i = 0; i < doors; i++) {
      const x = doorX(i);
      const z = -sz / 2 - 0.05;
      b.mat('paint-grey').masks(0.25, 1, 0.3, 0);
      for (const s of [-1, 1]) box(b, 0.22, doorH + 0.25, 0.26, [x + s * (doorW / 2 + 0.11), (doorH + 0.25) / 2, z], 'door-jamb');
      box(b, doorW + 0.6, 0.45, 0.34, [x, doorH + 0.4, z - 0.02], 'door-hood');
      b.mat('galvanised').masks(0.2, 1, 0.3, 0);
      box(b, doorW, doorH, 0.05, [x, doorH / 2, z + 0.06], 'door-curtain');
      if (b.lod === 0) {
        const slats = Math.round(doorH / 0.19);
        for (let k = 0; k < slats; k++) box(b, doorW - 0.04, 0.07, 0.035, [x, 0.14 + (k * (doorH - 0.2)) / slats, z + 0.02], 'door-slat');
        b.mat('steel-dark');
        box(b, doorW, 0.1, 0.09, [x, 0.05, z + 0.01], 'door-bar');
      }
      b.mat('paint-yellow').masks(0.3, 1, 0.3, 0);
      for (const s of [-1, 1]) rod(b, [x + s * (doorW / 2 + 0.55), -0.1, z - 0.9], [x + s * (doorW / 2 + 0.55), 1.1, z - 0.9], 0.11, b.pick(12, 8, 5), 'bollard');
      b.mat('concrete').masks(0, 1, 0.3, 0);
      box(b, doorW + 1.6, 0.12, 3.0, [x, 0.0, z - 1.5], 'door-apron');
    }

    // ---- personnel door, canopy, steps, windows on the +Z side
    const zf = sz / 2 + 0.05;
    b.mat('alu-machined').masks(0.3, 1, 0.3, 0);
    for (const s of [-1, 1]) box(b, 0.08, 2.3, 0.14, [manX + s * 0.6, 1.25, zf], 'door-frame');
    box(b, 1.28, 0.08, 0.14, [manX, 2.44, zf], 'door-frame');
    b.mat('paint-navy').masks(0.2, 1, 0.3, 0);
    box(b, 1.12, 2.3, 0.06, [manX, 1.25, zf - 0.01], 'door-leaf');
    b.mat('paint-grey').masks(0.2, 1, 0.3, 0);
    box(b, 2.0, 0.07, 1.1, [manX, 2.75, zf + 0.5], 'canopy');
    b.mat('concrete').masks(0, 1, 0.3, 0);
    box(b, 2.2, 0.2, 1.3, [manX, 0.0, zf + 0.62], 'step');
    if (b.lod === 0) {
      b.mat('steel-bare').masks(0.3, 1, 0.3, 0);
      rod(b, [manX + 0.42, 1.2, zf + 0.04], [manX + 0.42, 1.2, zf + 0.1], 0.02, 6, 'door-handle');
      rod(b, [manX + 0.42, 1.2, zf + 0.1], [manX + 0.3, 1.2, zf + 0.1], 0.014, 6, 'door-handle');
      for (const s of [-1, 1]) rod(b, [manX + s * 0.9, 2.72, zf + 1.0], [manX + s * 0.9, 3.5, zf + 0.03], 0.016, 5, 'canopy-tie');
      b.mat('glass').masks(0, 1, 0.2, 0);
      box(b, 0.3, 0.7, 0.02, [manX + 0.2, 1.75, zf + 0.025], 'door-light');
    }
    const windows = Math.max(1, Math.round((sx - 8) / 6));
    for (let i = 0; i < windows; i++) {
      const x = -sx / 2 + 2.6 + (i * (sx - 9.5)) / Math.max(1, windows - 1 || 1);
      if (Math.abs(x - manX) < 2.4) continue;
      b.mat('alu-machined').masks(0.3, 1, 0.3, 0);
      for (const s of [-1, 1]) {
        box(b, 1.5, 0.08, 0.16, [x, 2.2 + s * 0.52, zf + 0.02], 'window-frame');
        box(b, 0.08, 1.04, 0.16, [x + s * 0.71, 2.2, zf + 0.02], 'window-frame');
      }
      box(b, 1.6, 0.05, 0.22, [x, 1.63, zf + 0.05], 'window-sill');
      b.mat('glass').masks(0, 1, 0.2, 0);
      box(b, 1.36, 0.98, 0.02, [x, 2.2, zf + 0.06], 'window');
    }
    if (sign) {
      b.mat('decal').masks(0, 1, 0.3, 0);
      const sh = Math.min(1.1, h * 0.16);
      boardDecal(b, sheet, sign, [-sx / 2 + 0.8 + (sh * sheet.aspect(sign)) / 2, h - 0.9, zf + 0.06], [1, 0, 0], sh * sheet.aspect(sign), sh);
    }

    // ---- gutters and downpipes on the long sides, conduits and transformer on the +X end
    b.mat('galvanised').masks(0.2, 1, 0.3, 0);
    for (const s of [-1, 1]) {
      box(b, sx + 0.3, 0.12, 0.16, [0, h - 0.02, s * (sz / 2 + 0.2)], 'gutter');
      for (const e of [-1, 1]) {
        const x = e * (sx / 2 - 0.35);
        pipe(b, [[x, h - 0.06, s * (sz / 2 + 0.2)], [x, h - 0.5, s * (sz / 2 + 0.16)], [x, 0.25, s * (sz / 2 + 0.16)], [x, 0.12, s * (sz / 2 + 0.45)]], 0.055, 0.12, { segs: b.pick(8, 6, 4), tag: 'downpipe' });
        if (b.lod === 0) for (const y of [1.2, h * 0.5, h - 1.2]) box(b, 0.2, 0.05, 0.08, [x, y, s * (sz / 2 + 0.13)], 'pipe-bracket');
      }
    }
    const xe = sx / 2 + 0.05;
    b.mat('paint-grey').masks(0.2, 1, 0.3, 0);
    box(b, 0.22, 0.9, 0.7, [xe + 0.11, 1.5, sz * 0.2], 'junction-box');
    b.mat('galvanised').masks(0.2, 1, 0.3, 0);
    for (let k = 0; k < 3; k++) {
      const z = sz * 0.2 - 0.2 + k * 0.2;
      pipe(b, [[xe + 0.08, 1.95, z], [xe + 0.08, h - 0.9 - k * 0.14, z], [xe + 0.08, h - 0.9 - k * 0.14, -sz * 0.3]], 0.03, 0.12, { segs: b.pick(6, 5, 4), tag: 'conduit' });
    }
    b.mat('concrete').masks(0, 1, 0.3, 0);
    box(b, 2.6, 0.25, 2.4, [xe + 1.9, 0.02, -sz * 0.18], 'transformer-pad');
    b.mat('paint-grey').masks(0.2, 1, 0.3, 0);
    box(b, 1.5, 1.5, 1.3, [xe + 1.9, 0.9, -sz * 0.18], 'transformer');
    if (b.lod === 0) {
      for (let k = 0; k < 9; k++) for (const s of [-1, 1]) box(b, 0.03, 1.1, 0.26, [xe + 1.3 + k * 0.15, 0.85, -sz * 0.18 + s * 0.78], 'cooling-fin');
      b.mat('steel-bare').masks(0.2, 1, 0.3, 0);
      for (const dz of [-0.4, 0, 0.4]) rod(b, [xe + 1.9, 1.65, -sz * 0.18 + dz], [xe + 1.9, 2.0, -sz * 0.18 + dz], 0.05, 8, 'bushing');
    }
    pipe(b, [[xe + 1.15, 0.5, -sz * 0.18], [xe + 0.3, 0.5, -sz * 0.18], [xe + 0.12, 0.5, sz * 0.2 - 0.36], [xe + 0.12, 1.05, sz * 0.2 - 0.2]], 0.05, 0.2, { segs: b.pick(8, 6, 4), tag: 'feeder' });
  });

  // Wall lights over the doors (lit at night).
  const lampAt: Vec3Tuple[] = [];
  for (let i = 0; i < doors; i++) lampAt.push([doorX(i), doorH + 0.95, -sz / 2 - 0.2]);
  lampAt.push([manX, 3.05, sz / 2 + 0.16]);
  const lamps = buildModel('pad.building.lamps', (b) => {
    for (const p of lampAt) {
      b.mat('steel-dark').masks(0.2, 1, 0.2, 0);
      box(b, 0.34, 0.14, 0.2, [p[0], p[1] + 0.06, p[2]], 'lamp-housing');
      b.mat('lamp').masks(0, 1, 0, 0);
      box(b, 0.28, 0.05, 0.16, [p[0], p[1] - 0.03, p[2]], 'lens');
    }
  });
  const lights: PartLight[] = lampAt.map((p) => ({ pos: [p[0], p[1] - 0.6, p[2] + Math.sign(p[2]) * 1.2] as Vec3Tuple, intensity: [1500, 1430, 1260] as Vec3Tuple, range: 14 }));
  return {
    models: { body, lamps },
    pose: (state, emit) => {
      emit('body', null, null);
      emit('lamps', null, null, { emissive: state.night * 0.02, castShadow: false });
    },
    lights,
  };
};
