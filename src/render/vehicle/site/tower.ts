/**
 * Umbilical tower with swing arms and crew access arm, lightning masts and their catenary wires.
 *
 * Tower model frame: origin at the tower centre on the pad surface, the vehicle axis at x = -vehicleDistance
 * (the tower's working face looks toward -X). Swing arms hinge on that face and reach the vehicle skin;
 * they swing aside about a vertical hinge when `SiteState.arms` goes to 1 (engine ignition), the crew
 * access arm when `SiteState.crewArm` does.
 */
import type { QuatTuple, Vec3Tuple } from '@/core/math';
import { decalUv } from '../decals';
import { MeshBuilder, xf } from '../geom/builder';
import { DEG, Profile, ball, beam, box, frustum, lathe, pipe, rod, tube } from '../geom/prims';
import type { MatId } from '../materials';
import { buildModel, parseList } from '../parts/common';
import type { PartLight, PartModel } from '../parts/types';
import { handrail } from './pad';
import { numParam, staticSite, strParam, type SiteGenerator } from './types';

/** Marking on a vertical board: centre, width along `right`, height along +Y, facing `right x up`. */
function boardDecal(b: MeshBuilder, name: string, centre: Vec3Tuple, right: Vec3Tuple, width: number, height: number): void {
  const [u0, v0, u1, v1] = decalUv(name);
  const n: Vec3Tuple = [-right[2], 0, right[0]];
  b.begin(false, 'sign');
  const at = (sx: number, sy: number): Vec3Tuple => [centre[0] + right[0] * sx * (width / 2), centre[1] + sy * (height / 2), centre[2] + right[2] * sx * (width / 2)];
  const ids = [
    [-1, -1, u0, v1],
    [1, -1, u1, v1],
    [1, 1, u1, v0],
    [-1, 1, u0, v0],
  ].map(([sx, sy, u, v]) => {
    const p = at(sx!, sy!);
    return b.v(p[0], p[1], p[2], n[0], n[1], n[2], right[0], 0, right[2], u!, v!, -1);
  });
  // right x up = (r.x, 0, r.z) x (0, 1, 0) = (-r.z, 0, r.x) = n: counter-clockwise seen from n.
  b.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
}

/** Box truss along -X from the origin: four chords, posts and diagonals every `bay` metres. */
function trussArm(b: MeshBuilder, length: number, width: number, height: number, bay: number, chord: number): void {
  const hz = width / 2;
  for (const y of [0, height]) for (const z of [-hz, hz]) beam(b, [0, y, z], [-length, y, z], chord, chord, [0, 1, 0], 'chord');
  if (b.lod === 2) return;
  const n = Math.max(2, Math.round(length / bay));
  for (let i = 0; i <= n; i++) {
    const x = (-length * i) / n;
    for (const z of [-hz, hz]) rod(b, [x, 0, z], [x, height, z], chord * 0.32, b.pick(6, 5, 4), 'post');
    for (const y of [0, height]) rod(b, [x, y, -hz], [x, y, hz], chord * 0.32, b.pick(6, 5, 4), 'cross');
    if (i < n) {
      const x1 = (-length * (i + 1)) / n;
      const up = i % 2 === 0;
      for (const z of [-hz, hz]) rod(b, [x, up ? 0 : height, z], [x1, up ? height : 0, z], chord * 0.28, b.pick(6, 5, 4), 'diagonal');
      if (b.lod === 0) rod(b, [x, height, up ? -hz : hz], [x1, height, up ? hz : -hz], chord * 0.25, 5, 'lateral');
    }
  }
}

export const padUmbilicalTower: SiteGenerator = ({ params }) => {
  const H = numParam(params, 'height', 138);
  const half = numParam(params, 'half', 5);
  const dist = numParam(params, 'vehicleDistance', 27);
  const levelH = numParam(params, 'levelHeight', 6);
  const levels = Math.floor(H / levelH);
  const col = half - 0.45;
  const arms = parseList(strParam(params, 'arms', '')).map((e) => ({ y: e.n[0]!, reach: e.n[1]! }));
  const crew = { y: numParam(params, 'crewArmHeight', 119), reach: numParam(params, 'crewArmReach', 2.35) };
  const hingeZ = -(half - 1.6);
  const crewHingeZ = half - 3.0;
  const face = -half - 0.5;
  const lampHeights = [0.2, 0.42, 0.64, 0.84].map((f) => Math.round((H * f) / levelH) * levelH + 2.2);

  const body = buildModel('pad.umbilicalTower', (b) => {
    // ---- columns, level frames, bracing
    b.mat('paint-grey').masks(0.2, 1, 0.6, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(b, 0.9, H + 0.5, 0.9, [sx * col, H / 2 - 0.25, sz * col], 'column');
    const stepL = b.pick(1, 1, 4);
    for (let l = stepL; l <= levels; l += stepL) {
      const y = l * levelH;
      for (const s of [-1, 1]) {
        box(b, 2 * col, 0.5, 0.3, [0, y - 0.25, s * col], 'level-beam');
        box(b, 0.3, 0.5, 2 * col, [s * col, y - 0.25, 0], 'level-beam');
      }
    }
    if (b.lod < 2) {
      for (let l = 0; l < levels; l++) {
        const y0 = l * levelH + 0.05;
        const y1 = (l + 1) * levelH - 0.5;
        const flip = l % 2 === 0;
        const corners: [number, number][] = [
          [-col, -col],
          [col, -col],
          [col, col],
          [-col, col],
        ];
        for (let f = 0; f < 4; f++) {
          const a = corners[f]!;
          const c = corners[(f + 1) % 4]!;
          // The working face (-X side, f = 3) stays open for the arms on the levels that carry one.
          rod(b, [flip ? a[0] : c[0], y0, flip ? a[1] : c[1]], [flip ? c[0] : a[0], y1, flip ? c[1] : a[1]], 0.11, b.pick(8, 5, 4), 'brace');
          if (b.lod === 0) rod(b, [flip ? c[0] : a[0], y0, flip ? c[1] : a[1]], [flip ? a[0] : c[0], y1, flip ? a[1] : c[1]], 0.11, 8, 'brace');
        }
      }
      // ---- floors, elevator shaft, stairs
      b.mat('grating').masks(0.2, 0.9, 0.5, 0);
      for (let l = 1; l <= levels; l++) box(b, 2 * col - 0.4, 0.06, 2 * col - 0.4, [0, l * levelH + 0.03, 0], 'floor');
      b.mat('paint-white-b').masks(0.15, 1, 0.5, 0);
      box(b, 3, H - 1, 3, [col - 1.9, (H - 1) / 2, col - 1.9], 'elevator');
      if (b.lod === 0) {
        b.mat('galvanised').masks(0.2, 1, 0.5, 0);
        for (let l = 0; l < levels; l++) {
          const y0 = l * levelH + 0.06;
          const ym = y0 + levelH / 2;
          beam(b, [-col + 1.2, y0, col - 3.6], [-col + 1.2, ym, col - 0.9], 1.0, 0.05, [1, 0, 0], 'stair');
          beam(b, [-col + 2.4, ym, col - 0.9], [-col + 2.4, y0 + levelH, col - 3.6], 1.0, 0.05, [1, 0, 0], 'stair');
          box(b, 2.4, 0.05, 0.9, [-col + 1.8, ym, col - 0.45], 'landing');
        }
      }
      // ---- propellant and gas risers on the working face, cable tray
      b.mat('steel-brushed').masks(0.1, 1, 0.4, 0.4);
      const top = Math.max(...arms.map((a) => a.y), crew.y) + 1.5;
      for (let i = 0; i < 4; i++) {
        const z = hingeZ + 1.6 + i * 0.75;
        pipe(b, [[face + 0.2, 0.5, z], [face + 0.2, top - i * 4, z]], 0.24 - i * 0.03, 0.5, { segs: b.pick(12, 6, 5), tag: 'riser' });
      }
      b.mat('galvanised');
      box(b, 0.12, top, 0.7, [face + 0.25, top / 2, crewHingeZ + 1.6], 'cable-tray');
      // ---- hammerhead crane and lightning rod
      b.mat('paint-yellow').masks(0.25, 1, 0.3, 0);
      const cy = H + 2.2;
      box(b, 3.2, 3.6, 3.2, [0, H + 1.6, 0], 'slew');
      b.at(xf.translate(0, cy + 1.4, 0), () => trussArm(b, dist - 1.5, 2.2, 2.4, 3, 0.3));
      b.at(xf.mul(xf.translate(0, cy + 1.4, 0), xf.rotY(Math.PI)), () => trussArm(b, 10, 2.2, 2.4, 3, 0.3));
      b.mat('concrete-wall');
      box(b, 3.2, 2, 2.6, [9, cy + 2.4, 0], 'counterweight');
      b.mat('paint-white-b');
      box(b, 2.4, 2.4, 2.2, [-2.6, cy + 0.2, 1.9], 'cab');
      b.mat('steel-dark');
      rod(b, [-(dist - 2.5), cy + 1.4, 0], [-(dist - 2.5), cy - 3.5, 0], 0.05, 6, 'hoist');
      box(b, 0.7, 0.9, 0.5, [-(dist - 2.5), cy - 3.9, 0], 'hook-block');
      b.mat('paint-grey');
      rod(b, [0, cy + 3.8, 0], [0, cy + 19, 0], 0.16, b.pick(8, 6, 4), 'lightning-rod');
      // ---- signs on the two flanks
      b.mat('paint-navy').masks(0.1, 1, 0.3, 0);
      for (const s of [-1, 1]) {
        box(b, 2 * half - 0.4, 2.2, 0.15, [0, H - 9, s * (half + 0.1)], 'sign-board');
        b.mat('decal');
        boardDecal(b, 'spaceport', [0, H - 9, s * (half + 0.19)], [s, 0, 0], 2 * half - 0.9, 1.0);
        boardDecal(b, 'lc1', [0, H - 12.6, s * (half + 0.19)], [s, 0, 0], 3.8, 2.0);
        b.mat('paint-navy');
        box(b, 4.2, 2.4, 0.15, [0, H - 12.6, s * (half + 0.1)], 'sign-board');
      }
      // ---- lamp housings facing the vehicle
      b.mat('steel-dark').masks(0.2, 1, 0.3, 0);
      for (const y of lampHeights) for (const z of [-2.2, 2.2]) box(b, 0.5, 0.9, 1.3, [face + 0.1, y, z], 'lamp-housing');
    }
    b.mat('concrete-wall').masks(0, 1, 0.6, 0);
    box(b, 2 * half + 3, 1.2, 2 * half + 3, [0, 0, 0], 'foundation');
  });

  const armModel = (name: string, length: number, crewArm: boolean): PartModel =>
    buildModel(name, (b) => {
      // Arm frame: origin on the hinge axis at walkway level; the arm runs along -X.
      b.mat(crewArm ? 'paint-white' : 'paint-grey').masks(0.2, 1, 0.5, 0);
      if (crewArm) {
        // Enclosed walkway and the white room at its tip; the room's seal faces the hatch (-X).
        box(b, length - 3.4, 2.7, 2.3, [-(length - 3.4) / 2, 1.3, 0], 'walkway');
        box(b, 4.2, 3.4, 5.0, [-length + 2.1, 1.45, -(crewHingeZ - 0)], 'white-room');
        if (b.lod < 2) {
          b.mat('rubber');
          box(b, 0.35, 2.5, 2.3, [-length - 0.1, 1.3, -crewHingeZ], 'seal');
          b.mat('glass');
          for (let i = 0; i < 5; i++) for (const s of [-1, 1]) box(b, 1.1, 0.7, 0.04, [-2.5 - i * 2.6, 1.7, s * 1.16], 'window');
          b.mat('paint-navy');
          box(b, length - 3.4, 0.3, 2.34, [-(length - 3.4) / 2, 0.35, 0], 'stripe');
        }
      } else {
        trussArm(b, length - 0.6, 2.2, 2.6, 2.4, 0.2);
        if (b.lod < 2) {
          b.mat('grating');
          box(b, length - 0.8, 0.05, 1.3, [-(length - 0.8) / 2, 0.12, 0], 'walkway');
          handrail(b, [[0, 0.14, 0.65], [-length + 0.8, 0.14, 0.65]], 1.05, 2.4);
          // Propellant lines along the arm, ending in the umbilical carrier that meets the vehicle's plate.
          b.mat('steel-brushed').masks(0.1, 1, 0.4, 0.5);
          const off = -hingeZ;
          for (let i = 0; i < 3; i++) {
            const z = -0.75 + i * 0.3;
            pipe(b, [[0.2, 2.0, z], [-length + 2.2, 2.0, z], [-length + 0.9, 1.5, off - 0.5 + i * 0.5], [-length + 0.05, 1.5, off - 0.5 + i * 0.5]], 0.13 - i * 0.02, 0.6, { segs: b.pick(10, 6, 5), tag: 'line' });
          }
          b.mat('paint-grey').masks(0.2, 1, 0.5, 0);
          beam(b, [-length + 0.6, 0.6, -1.1], [-length + 0.6, 0.6, off + 1.3], 0.5, 0.4, [1, 0, 0], 'carrier-beam');
          beam(b, [-length + 0.6, 2.3, -1.1], [-length + 0.6, 2.3, off + 1.3], 0.3, 0.3, [1, 0, 0], 'carrier-beam');
          b.mat('steel-brushed');
          box(b, 0.16, 1.5, 2.4, [-length + 0.02, 1.45, off], 'carrier-plate');
        }
      }
      b.mat('steel-dark').masks(0.2, 1, 0.5, 0);
      frustum(b, 0.36, 0.36, -0.3, 2.9, b.pick(16, 10, 6), 'hinge');
    });

  const models: Record<string, PartModel> = { body };
  arms.forEach((a, i) => {
    models[`arm${i}`] = armModel(`pad.umbilicalTower.arm${i}`, dist - half - 0.5 - a.reach, false);
  });
  models['crewArm'] = armModel('pad.umbilicalTower.crewArm', dist - half - 0.5 - crew.reach, true);
  models['lamps'] = buildModel('pad.umbilicalTower.lamps', (b) => {
    b.mat('lamp').masks(0, 1, 0, 0);
    for (const y of lampHeights) for (const z of [-2.2, 2.2]) box(b, 0.05, 0.7, 1.1, [face - 0.17, y, z], 'lens');
  });
  models['beacons'] = buildModel('pad.umbilicalTower.beacons', (b) => {
    b.mat('lamp-red').masks(0, 1, 0, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.at(xf.translate(sx * col, H + 0.5, sz * col), () => ball(b, 0.22, 0, b.pick(10, 6, 5), b.pick(6, 4, 3), 0.22, 'beacon'));
    b.at(xf.translate(0, H + 21.3, 0), () => ball(b, 0.25, 0, b.pick(10, 6, 5), b.pick(6, 4, 3), 0.25, 'beacon'));
  });

  const lights: PartLight[] = lampHeights.map((y) => ({ pos: [face - 3.5, y, 0] as Vec3Tuple, intensity: [2.6e5, 2.5e5, 2.3e5] as Vec3Tuple, range: 110 }));
  const yaw = (angle: number): QuatTuple | null => (angle === 0 ? null : [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)]);
  return {
    models,
    pose(state, emit, moving) {
      emit('body', null, null);
      const t = state.arms * state.arms * (3 - 2 * state.arms);
      arms.forEach((a, i) => emit(`arm${i}`, [face, a.y - 1.45, hingeZ], yaw(-68 * DEG * t), { moving: moving.arms }));
      const c = state.crewArm * state.crewArm * (3 - 2 * state.crewArm);
      emit('crewArm', [face, crew.y - 1.3, crewHingeZ], yaw(78 * DEG * c), { moving: moving.crewArm });
      emit('lamps', null, null, { emissive: state.night, castShadow: false });
      emit('beacons', null, null, { emissive: state.night, castShadow: false });
    },
    lights,
  };
};

export const padLightningMast: SiteGenerator = ({ params }) => {
  const H = numParam(params, 'height', 165);
  const steel = numParam(params, 'steelHeight', 140);
  const r0 = numParam(params, 'baseHalf', 6.5);
  const r1 = numParam(params, 'topHalf', 1.1);
  const bays = numParam(params, 'bays', 14);
  // Lattice tower in aviation red and white bands, carrying an insulating mast for the catenary wires.
  const half = (y: number): number => r0 + (r1 - r0) * Math.pow(y / steel, 0.8);
  const levelY = (l: number): number => steel * (1 - Math.pow(1 - l / bays, 1.35));
  const node = (k: number, l: number): Vec3Tuple => {
    const y = levelY(l);
    const h = half(y);
    return [(k === 0 || k === 3 ? -1 : 1) * h, y, (k < 2 ? -1 : 1) * h];
  };
  const body = buildModel('pad.lightningMast', (b) => {
    const step = b.pick(1, 1, 2);
    for (let l = 0; l < bays; l += step) {
      const m = Math.min(bays, l + step);
      b.mat(Math.floor(l / 2) % 2 === 0 ? 'paint-red' : 'paint-white').masks(0.15, 1, 0.3, 0);
      const leg = 0.2 - 0.1 * (l / bays);
      for (let k = 0; k < 4; k++) {
        rod(b, node(k, l), node(k, m), leg, b.pick(8, 6, 4), 'leg');
        if (b.lod === 2) continue;
        rod(b, node(k, m), node((k + 1) % 4, m), leg * 0.45, b.pick(6, 5, 4), 'ring');
        rod(b, node(k, l), node((k + 1) % 4, m), leg * 0.4, b.pick(6, 5, 4), 'brace');
        if (b.lod === 0) rod(b, node((k + 1) % 4, l), node(k, m), leg * 0.4, 6, 'brace');
      }
    }
    b.mat('paint-grey').masks(0.1, 1, 0.3, 0);
    lathe(b, Profile.at(0, steel - 0.5).corner(0.42, steel - 0.5).to(0.3, steel + 6).to(0.12, H).corner(0, H), { segs: b.pick(12, 8, 5), tag: 'top-mast' });
    if (b.lod < 2) {
      b.mat('galvanised').masks(0.2, 1, 0.3, 0);
      box(b, 2 * r1 + 0.6, 0.12, 2 * r1 + 0.6, [0, steel, 0], 'top-platform');
      b.mat('concrete-wall').masks(0, 1, 0.3, 0);
      for (let k = 0; k < 4; k++) {
        const p = node(k, 0);
        box(b, 2.4, 1.4, 2.4, [p[0], 0.1, p[2]], 'footing');
      }
    }
  });
  const beacons = buildModel('pad.lightningMast.beacons', (b) => {
    b.mat('lamp-red').masks(0, 1, 0, 0);
    for (const l of [Math.round(bays * 0.5), bays]) {
      for (let k = 0; k < 4; k++) {
        const p = node(k, l);
        b.at(xf.translate(p[0], p[1] + 0.35, p[2]), () => ball(b, 0.22, 0, b.pick(10, 6, 5), b.pick(6, 4, 3), 0.22, 'beacon'));
      }
    }
  });
  return {
    models: { body, beacons },
    pose: (state, emit) => {
      emit('body', null, null);
      emit('beacons', null, null, { emissive: state.night, castShadow: false });
    },
  };
};

export const padCatenary: SiteGenerator = ({ params }) => {
  // Wire from (0, y0, 0) to (dx, y1, dz) in the model frame, sagging by `sag` at mid-span.
  const dx = numParam(params, 'dx', 100);
  const dz = numParam(params, 'dz', 0);
  const y0 = numParam(params, 'y0', 164);
  const y1 = numParam(params, 'y1', 164);
  const sag = numParam(params, 'sag', 9);
  const radius = numParam(params, 'radius', 0.035);
  const body = buildModel('pad.catenary', (b) => {
    b.mat('steel-bare' as MatId).masks(0.1, 1, 0.2, 0);
    const n = b.pick(28, 14, 6);
    const pts: Vec3Tuple[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push([dx * t, y0 + (y1 - y0) * t - sag * 4 * t * (1 - t), dz * t]);
    }
    tube(b, pts, radius, { segs: b.pick(6, 4, 3), tag: 'wire' });
  });
  return { models: { body }, pose: staticSite };
};
