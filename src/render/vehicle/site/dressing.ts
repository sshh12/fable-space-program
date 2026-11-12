/**
 * What stands about on a working launch complex besides its structures: parked service vehicles
 * ('pad.vehicle') and the tracking-camera towers round the pad ('pad.cameraTower'). Both stand on the
 * surveyed ground under their origin.
 *
 * 'pad.vehicle' parameters: `kind` 0 = panel van, 1 = pick-up truck; `paint` (a material id); `surface`, the
 * height of what it is parked on over the pad plane (default 0.1 m, a stone pad). The vehicle
 * faces the model's -Z ("north" at heading 0) and stands on its wheels.
 * 'pad.cameraTower' parameters: `height` of the platform, m; the camera looks along the model's -Z.
 */
import type { Vec3Tuple } from '@/core/math';
import type { MeshBuilder } from '../geom/builder';
import { xf } from '../geom/builder';
import { box, frustum, rod } from '../geom/prims';
import { isMatId, type MatId } from '../materials';
import { buildModel } from '../parts/common';
import { extrudeXY, handrail } from './pad';
import { numParam, strParam, type SiteGenerator } from './types';

/** Wheel at `x` along the vehicle on one side (its axle is the build frame's Z): tyre and rim. */
function wheel(b: MeshBuilder, x: number, side: number, halfWidth: number, radius: number): void {
  b.mat('rubber').masks(0, 0.8, 0.4, 0);
  rod(b, [x, radius, side * (halfWidth - 0.25)], [x, radius, side * halfWidth], radius, b.pick(18, 10, 6), 'tyre');
  if (b.lod === 2) return;
  b.mat('alu-cast').masks(0.1, 0.9, 0.3, 0);
  rod(b, [x, radius, side * (halfWidth - 0.03)], [x, radius, side * (halfWidth + 0.012)], radius * 0.56, b.pick(14, 8, 6), 'rim');
}

export const padVehicle: SiteGenerator = ({ params, ground }) => {
  const kind = numParam(params, 'kind', 0);
  const paintId = strParam(params, 'paint', 'paint-white-b');
  if (!isMatId(paintId)) throw new Error(`pad.vehicle: unknown material "${paintId}"`);
  const paint: MatId = paintId;
  // It stands on the surface under it: a stone pad by default (`surface` = its height over the pad plane, m).
  const y0 = Math.max(numParam(params, 'surface', 0.1), ground.hi(0, 0) + 0.06);
  const body = buildModel('pad.vehicle', (b) => {
    b.at(xf.mul(xf.translate(0, y0, 0), xf.rotY(Math.PI / 2)), () => {
      // (Built along +X = the vehicle's forward, then turned so that forward is the model's -Z.)
      const hw = 0.98;
      const wr = 0.36;
      const wb = kind === 0 ? 3.3 : 3.5;
      b.mat(paint).masks(0.05, 1, 0.35, 0);
      if (kind === 0) {
        // Panel van: one box with a raked nose.
        extrudeXY(b, [[-2.55, 0.42], [2.2, 0.42], [2.62, 0.62], [2.62, 1.1], [1.75, 2.25], [-2.55, 2.25]], -hw, hw, 'van-body');
      } else {
        // Pick-up: bonnet, cab, and an open bed with a tailgate.
        extrudeXY(b, [[-0.2, 0.45], [2.75, 0.45], [2.8, 1.0], [1.7, 1.12], [1.1, 1.82], [-0.2, 1.82]], -hw, hw, 'cab');
        for (const sz of [-1, 1]) box(b, 2.65, 0.62, 0.06, [-1.5, 0.95, sz * (hw - 0.03)], 'bed-side');
        box(b, 0.06, 0.62, 2 * hw, [-2.8, 0.95, 0], 'tailgate');
        box(b, 2.65, 0.08, 2 * hw, [-1.5, 0.66, 0], 'bed-floor');
      }
      // Glazing: windscreen on the raked face, side windows, as dark panes a hair proud of the body.
      b.mat('glass').masks(0, 1, 0.15, 0);
      const screen: [Vec3Tuple, Vec3Tuple] = kind === 0 ? [[2.56, 1.22, 0], [1.84, 2.16, 0]] : [[1.66, 1.2, 0], [1.14, 1.78, 0]];
      b.at(xf.along(screen[0], screen[1], [0, 0, 1]), () => {
        const len = Math.hypot(screen[1][0] - screen[0][0], screen[1][1] - screen[0][1]);
        box(b, 2 * hw - 0.22, len, 0.04, [0, len / 2, 0], 'windscreen');
      });
      if (b.lod < 2) {
        const cabX = kind === 0 ? 1.15 : 0.5;
        const top = kind === 0 ? 1.72 : 1.5;
        for (const sz of [-1, 1]) box(b, 0.9, 0.5, 0.02, [cabX, top, sz * (hw + 0.004)], 'side-window');
        // Bumpers, lamps, mirrors.
        b.mat('steel-dark').masks(0.2, 1, 0.3, 0);
        box(b, 0.14, 0.2, 2 * hw + 0.06, [kind === 0 ? 2.66 : 2.84, 0.52, 0], 'bumper');
        box(b, 0.12, 0.18, 2 * hw + 0.06, [kind === 0 ? -2.58 : -2.86, 0.52, 0], 'bumper');
        for (const sz of [-1, 1]) box(b, 0.06, 0.14, 0.2, [cabX + 0.62, top - 0.18, sz * (hw + 0.13)], 'mirror');
        b.mat('lamp').masks(0, 1, 0, 0);
        for (const sz of [-1, 1]) box(b, 0.03, 0.12, 0.26, [kind === 0 ? 2.63 : 2.8, 0.86, sz * (hw - 0.22)], 'headlamp');
      }
      for (const side of [-1, 1]) for (const x of [wb / 2 + 0.2, -wb / 2 + 0.2]) wheel(b, x, side, hw + 0.01, wr);
    });
  });
  return { models: { body }, pose: (_state, emit) => emit('body', null, null, { nearShadowOnly: true, grime: 0.7, emissive: 0 }) };
};

export const padCameraTower: SiteGenerator = ({ params, ground }) => {
  const H = numParam(params, 'height', 11);
  const lo = ground.lo(0, 0) - 0.3;
  const hi = ground.hi(0, 0);
  const body = buildModel(
    'pad.cameraTower',
    (b) => {
      b.mat('concrete-wall').masks(0, 1, 0.3, 0);
      box(b, 2.2, hi - lo + 0.3, 2.2, [0, (hi + lo + 0.3) / 2, 0], 'footing');
      const y = hi + 0.3;
      b.mat('galvanised').masks(0.15, 1, 0.25, 0);
      // A square lattice mast (a solid post from afar), a railed platform, a ladder.
      const r = 0.55;
      if (b.lod === 2) frustum(b, 0.5, 0.5, y, y + H, 4, 'mast-solid');
      else {
        const bays = b.pick(6, 3, 1);
        const node = (k: number, l: number): Vec3Tuple => [k % 2 === 0 ? -r : r, y + (H * l) / bays, k < 2 ? -r : r];
        const ring = [0, 1, 3, 2];
        for (let k = 0; k < 4; k++) {
          const a = ring[k]!;
          const c = ring[(k + 1) % 4]!;
          rod(b, node(a, 0), node(a, bays), b.pick(0.045, 0.09, 0), b.pick(6, 4, 4), 'leg');
          for (let l = 0; l < bays; l++) {
            rod(b, node(a, l), node(c, l + 1), b.pick(0.022, 0.05, 0), 4, 'brace');
            rod(b, node(a, l + 1), node(c, l + 1), b.pick(0.022, 0.05, 0), 4, 'ring');
          }
        }
      }
      box(b, 2.4, 0.08, 2.4, [0, y + H + 0.04, 0], 'platform');
      if (b.lod === 0) {
        b.mat('paint-yellow').masks(0.2, 1, 0.5, 0);
        handrail(b, [[-1.15, y + H + 0.08, -1.15], [1.15, y + H + 0.08, -1.15], [1.15, y + H + 0.08, 1.15], [-1.15, y + H + 0.08, 1.15], [-1.15, y + H + 0.08, -1.15]]);
        b.mat('galvanised');
        for (const sx of [-0.2, 0.2]) rod(b, [sx, y, r + 0.12], [sx, y + H, r + 0.12], 0.018, 5, 'ladder');
        for (let h = 0.3; h < H; h += 0.3) rod(b, [-0.2, y + h, r + 0.12], [0.2, y + h, r + 0.12], 0.012, 4, 'rung');
      }
      if (b.lod < 2) {
        // Tracking camera on a pan-tilt head, its hood and lens toward the pad, and an equipment cabinet.
        b.mat('steel-dark').masks(0.15, 1, 0.3, 0);
        frustum(b, 0.16, 0.12, y + H + 0.08, y + H + 0.95, b.pick(12, 8, 6), 'pedestal');
        b.mat('paint-white-b').masks(0.1, 1, 0.4, 0);
        box(b, 0.5, 0.42, 1.25, [0, y + H + 1.2, -0.1], 'camera');
        b.mat('glass').masks(0, 1, 0.2, 0);
        b.at(xf.mul(xf.translate(0, y + H + 1.2, -0.74), xf.rotX(-Math.PI / 2)), () => frustum(b, 0.15, 0.15, 0, 0.03, b.pick(14, 8, 6), 'lens'));
        b.mat('paint-grey').masks(0.15, 1, 0.4, 0);
        box(b, 0.9, 1.5, 0.6, [1.5, y + 0.75, 0.4], 'cabinet');
      }
    },
    [420, 110],
  );
  const shadow = buildModel('pad.cameraTower.shadow', (b) => {
    b.mat('galvanised');
    frustum(b, 0.42, 0.42, hi + 0.3, hi + 0.3 + H, 4, 'shadow-proxy');
    box(b, 2.4, 0.3, 2.4, [0, hi + 0.3 + H, 0], 'shadow-proxy');
  });
  return {
    models: { body, shadow },
    pose: (_state, emit) => {
      emit('body', null, null, { fineShadowOnly: true, grime: 0.6 });
      emit('shadow', null, null, { shadowProxy: true });
    },
  };
};
