/**
 * Water tower, propellant tank farms (vacuum-jacketed spheres, horizontal bullets, vaporisers, pump skid,
 * vent stack, dike) and the low support buildings of the launch complex.
 */
import type { Vec3Tuple } from '@/core/math';
import { MeshBuilder, polar, xf } from '../geom/builder';
import { Profile, TAU, ball, bottle, box, frustum, lathe, phisWith, pipe, rod } from '../geom/prims';
import { band, bandRegion, buildModel, decalRegion, regionBounds, regionHeights } from '../parts/common';
import { handrail } from './pad';
import { numParam, staticSite, strParam, type SiteGenerator } from './types';

/** Sphere tank on a ring of legs with cross bracing; `label` is a decal on its equator. */
function sphereTank(b: MeshBuilder, radius: number, centreY: number, label: string, legs: number): void {
  b.mat('paint-white').masks(0.1, 1, 0.3, 0.5);
  const n = b.pick(20, 10, 5);
  const p = Profile.at(0, centreY - radius);
  p.pts[0]!.hard = false;
  for (let i = 1; i < n; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / n;
    if (i === Math.round(n * 0.38)) p.mark('s0');
    if (i === Math.round(n * 0.62)) p.mark('s1');
    p.to(radius * Math.cos(a), centreY + radius * Math.sin(a));
  }
  p.to(0, centreY + radius);
  const regions = b.lod < 2 ? [decalRegion(label, radius, 200, centreY, radius * 0.22, false, ['s0', 's1']), bandRegion('paint-navy', 0, 360, centreY - radius * 0.2, centreY - radius * 0.15, ['s0', 's1'])] : [];
  p.splitAtY('s0', 's1', regionHeights(regions));
  lathe(b, p, { phis: phisWith(b.pick(72, 36, 14), regionBounds(regions)), regions, tag: 'sphere' });
  if (b.lod === 2) return;
  // Legs tangent to the equator, bracing, top dome fitting and the stair up the side.
  b.mat('paint-grey').masks(0.2, 1, 0.3, 0);
  const rl = radius * 0.94;
  for (let k = 0; k < legs; k++) {
    const phi = (k / legs) * TAU;
    rod(b, polar(rl, phi, -0.3), polar(rl, phi, centreY - radius * 0.2), radius * 0.035, b.pick(12, 8, 5), 'leg');
    const next = ((k + 1) / legs) * TAU;
    rod(b, polar(rl, phi, 0.4), polar(rl, next, centreY - radius * 0.45), radius * 0.012, b.pick(6, 5, 4), 'brace');
    if (b.lod === 0) rod(b, polar(rl, next, 0.4), polar(rl, phi, centreY - radius * 0.45), radius * 0.012, 6, 'brace');
  }
  b.mat('steel-brushed');
  frustum(b, radius * 0.11, radius * 0.11, centreY + radius - 0.05, centreY + radius + 0.9, b.pick(20, 10, 6), 'dome-fitting');
  pipe(b, [[0, centreY + radius + 0.6, 0], [radius * 0.5, centreY + radius + 0.6, 0], polar(radius * 1.02, 0.6, centreY + radius * 0.5), polar(radius * 1.02, 0.6, 0.4)], radius * 0.02, radius * 0.2, { segs: b.pick(8, 6, 4), tag: 'vent-line' });
  b.mat('galvanised');
  box(b, 1.1, 0.06, radius * 0.5, [radius * 0.25, centreY + radius + 0.02, 0], 'top-walkway');
}

export const padWaterTower: SiteGenerator = ({ params }) => {
  const colH = numParam(params, 'columnHeight', 52);
  const tankR = numParam(params, 'tankRadius', 9.5);
  const tankH = numParam(params, 'tankHalfHeight', 6.5);
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
    const regions = b.lod < 2 ? [decalRegion('h2o', tankR, 135, cy - tankH * 0.05, tankH * 0.34, false, ['t0', 't1']), decalRegion('lc1', tankR, 315, cy - tankH * 0.05, tankH * 0.5, false, ['t0', 't1']), bandRegion('paint-navy', 0, 360, cy - tankH * 0.42, cy - tankH * 0.34, ['t0', 't1'])] : [];
    p.splitAtY('t0', 't1', regionHeights(regions));
    lathe(b, p, { phis: phisWith(b.pick(72, 36, 14), regionBounds(regions)), regions, tag: 'water-tower' });
    if (b.lod === 2) return;
    b.mat('paint-red').masks(0.2, 1, 0.3, 0);
    // Deluge main down the column and away toward the pad (the run to the pad is a pipe-run structure).
    pipe(b, [[3.2, colH * 0.8, 0], [4.2, colH * 0.7, 0], [5.2, 1.6, 0], [9, 1.6, 0]], 0.55, 2, { segs: b.pick(14, 8, 5), tag: 'main' });
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

export const padTankFarm: SiteGenerator = ({ params }) => {
  const kind = strParam(params, 'propellant', 'lox-ch4');
  const hx = numParam(params, 'halfX', 34);
  const hz = numParam(params, 'halfZ', 26);
  const body = buildModel(`pad.tankFarm.${kind}`, (b) => {
    // Gravel pad inside a low concrete dike.
    b.mat('gravel').masks(0, 1, 0.2, 0);
    box(b, 2 * hx, 0.5, 2 * hz, [0, -0.1, 0], 'pad');
    b.mat('concrete-wall').masks(0, 1, 0.3, 0);
    for (const s of [-1, 1]) {
      box(b, 2 * hx + 1, 1.5, 0.5, [0, 0.45, s * hz], 'dike');
      box(b, 0.5, 1.5, 2 * hz + 1, [s * hx, 0.45, 0], 'dike');
    }
    if (kind === 'lh2') {
      // Liquid hydrogen: one large jacketed sphere, gas tube banks, a tall vent stack.
      b.at(xf.translate(-hx * 0.3, 0, 0), () => sphereTank(b, 10.5, 12.5, 'lh2', 10));
      for (const z of [-hz * 0.55, hz * 0.55]) {
        b.at(xf.translate(hx * 0.5, 0, z), () => {
          b.mat('steel-brushed').masks(0.15, 1, 0.3, 0);
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) b.at(xf.mul(xf.translate(-5.5, 1.3 + j * 0.72, (i - 1) * 0.72), xf.rotZ(-Math.PI / 2)), () => bottle(b, 0.3, 10.4, 0.3, b.pick(12, 8, 5), 'tube'));
          if (b.lod < 2) {
            b.mat('paint-grey');
            for (const x of [-4.5, 0, 4.5]) box(b, 0.25, 3.2, 2.6, [x, 1.6, 0], 'tube-frame');
          }
        });
      }
      b.mat('steel-brushed').masks(0.1, 1, 0.3, 0);
      rod(b, [hx * 0.8, 0, 0], [hx * 0.8, 38, 0], 0.22, b.pick(10, 6, 5), 'vent-stack');
      if (b.lod < 2) {
        frustum(b, 0.36, 0.3, 37.5, 39.2, 10, 'flare-tip');
        for (let k = 0; k < 3; k++) rod(b, [hx * 0.8, 26, 0], [hx * 0.8 + 9 * Math.sin((k / 3) * TAU), 0.2, 9 * Math.cos((k / 3) * TAU)], 0.025, 4, 'guy');
        pipe(b, [[-hx * 0.3, 1.2, 9.5], [-hx * 0.3, 1.2, hz * 0.8], [hx * 0.8, 1.2, hz * 0.8], [hx * 0.8, 1.2, 0.5]], 0.14, 0.6, { segs: b.pick(8, 6, 4), tag: 'vent-header' });
      }
    } else {
      // Liquid oxygen sphere and two horizontal methane bullets with their vaporiser bank and pump skid.
      b.at(xf.translate(-hx * 0.42, 0, -hz * 0.1), () => sphereTank(b, 8.5, 10.5, 'lox', 8));
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
            const regions = b.lod < 2 ? [decalRegion('lch4', R, z > 0 ? 0 : 180, 0, 1.3, true, ['b0', 'b1'])] : [];
            p.splitAtY('b0', 'b1', regionHeights(regions));
            lathe(b, p, { phis: phisWith(b.pick(40, 20, 10), regionBounds(regions)), regions, tag: 'bullet' });
            if (b.lod < 2) {
              b.mat('steel-bare');
              for (const y of [-7, 0, 7]) band(b, R, y, 0.12, 0.02, b.pick(40, 20, 10), 'strap');
            }
          });
          b.mat('concrete-wall');
          for (const x of [-7.5, 7.5]) box(b, 1.2, 3.4, 5, [x, -2.6, 0], 'saddle');
        });
      }
      if (b.lod < 2) {
        // Ambient vaporisers: banks of finned tubes.
        b.mat('alu-machined').masks(0.2, 1, 0.3, 0.8);
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 6; j++) box(b, 0.45, 7, 0.45, [hx * 0.72 + i * 1.1, 3.7, -hz * 0.75 + j * 1.1], 'vaporiser');
        }
        b.mat('paint-grey');
        box(b, 5, 0.3, 7.2, [hx * 0.72 + 1.65, 0.2, -hz * 0.75 + 2.75], 'vaporiser-base');
        // Pump skid and manifold.
        b.mat('paint-navy').masks(0.2, 1, 0.3, 0);
        box(b, 6, 1.6, 2.6, [-hx * 0.05, 1.0, hz * 0.72], 'pump-skid');
        b.mat('steel-brushed').masks(0.1, 1, 0.3, 0.5);
        pipe(b, [[-hx * 0.42, 1.4, -hz * 0.1 + 8], [-hx * 0.42, 1.4, hz * 0.72], [hx * 0.9, 1.4, hz * 0.72]], 0.28, 1, { segs: b.pick(12, 8, 5), tag: 'manifold' });
        pipe(b, [[hx * 0.3, 1.4, hz * 0.1], [hx * 0.3, 1.4, hz * 0.72]], 0.2, 0.8, { segs: b.pick(10, 6, 5), tag: 'manifold' });
        b.mat('paint-yellow');
        handrail(b, [[-hx + 1, 1.2, -hz + 1], [hx - 1, 1.2, -hz + 1]], 1.0, 4);
      }
    }
  });
  return { models: { body }, pose: staticSite };
};

export const padBuilding: SiteGenerator = ({ params }) => {
  const sx = numParam(params, 'sizeX', 30);
  const sz = numParam(params, 'sizeZ', 14);
  const h = numParam(params, 'height', 7);
  const body = buildModel('pad.building', (b) => {
    b.mat('concrete-wall').masks(0, 1, 0.3, 0);
    box(b, sx, h + 0.4, sz, [0, h / 2 - 0.2, 0], 'building');
    b.mat('paint-grey').masks(0.1, 1, 0.3, 0);
    box(b, sx + 0.8, 0.35, sz + 0.8, [0, h + 0.17, 0], 'roof');
    if (b.lod === 2) return;
    // Roll-up doors, a personnel door, roof plant.
    b.mat('galvanised').masks(0.2, 1, 0.3, 0);
    const doors = Math.max(1, Math.round(sx / 9));
    for (let i = 0; i < doors; i++) box(b, 4.6, h * 0.72, 0.12, [-sx / 2 + (sx * (i + 0.5)) / doors, h * 0.36, -sz / 2 - 0.03], 'door');
    b.mat('paint-navy');
    box(b, 1.1, 2.2, 0.1, [sx / 2 - 2, 1.1, sz / 2 + 0.03], 'door');
    b.mat('galvanised');
    for (let i = 0; i < 3; i++) box(b, 2.2, 1.3, 2.2, [-sx * 0.3 + i * (sx * 0.3), h + 1, 0], 'roof-unit');
    const cables: Vec3Tuple[] = [[-sx / 2 + 1, h + 0.5, sz / 2 - 1], [-sx / 2 + 1, h + 4, sz / 2 - 1]];
    rod(b, cables[0]!, cables[1]!, 0.06, 6, 'antenna');
  });
  return { models: { body }, pose: staticSite };
};
