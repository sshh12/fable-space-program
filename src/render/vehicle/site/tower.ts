/**
 * Umbilical tower with swing arms and crew access arm, lightning masts and their catenary wires.
 *
 * Tower model frame: origin at the tower centre on the pad surface, the vehicle axis at x = -vehicleDistance
 * (the tower's working face looks toward -X). Swing arms hinge on that face and reach the vehicle skin;
 * they swing aside about a vertical hinge when `SiteState.arms` goes to 1 (engine ignition), the crew
 * access arm when `SiteState.crewArm` does.
 *
 * Lattice structures are thinner than a pixel from most of the distances they are seen from, and a line
 * thinner than a pixel breaks up into dots. Each lattice model therefore switches early (its own
 * `lodPixels`) to a middle LOD with members thick enough to hold a pixel and then to a far LOD that is a
 * solid, slender silhouette.
 */
import type { QuatTuple, Vec3Tuple } from '@/core/math';
import { decalSheetOf, type DecalSheet } from '../decals';
import { MeshBuilder, xf } from '../geom/builder';
import { DEG, Profile, ball, beam, box, frustum, iSection, lathe, pipe, ringSolid, rod, section, tube } from '../geom/prims';
import { materialDef, type MatId } from '../materials';
import { buildModel, noise2, parseList } from '../parts/common';
import type { PartLight, PartModel } from '../parts/types';
import { extrudeZY, gratingPanel, handrail, stairFlight } from './pad';
import { numParam, strParam, type SiteGenerator } from './types';

/** Marking on a vertical board: centre, width along `right`, height along +Y, facing `right x up`. */
export function boardDecal(b: MeshBuilder, sheet: DecalSheet, name: string, centre: Vec3Tuple, right: Vec3Tuple, width: number, height: number): void {
  const [u0, v0, u1, v1] = sheet.uv(name);
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

/** Rectangular frame in the plane x = const: outer size (w along Z, h along Y), bar thickness t, depth along X. */
function frameYZ(b: MeshBuilder, x0: number, x1: number, cy: number, cz: number, w: number, h: number, t: number, tag: string): void {
  const cx = (x0 + x1) / 2;
  const d = Math.abs(x1 - x0);
  for (const s of [-1, 1]) {
    box(b, d, t, w, [cx, cy + s * (h / 2 - t / 2), cz], tag);
    box(b, d, h - 2 * t, t, [cx, cy, cz + s * (w / 2 - t / 2)], tag);
  }
}

/**
 * Crew access arm. Arm frame: origin on the hinge axis at the walkway floor, the arm runs along -X and its
 * seal meets the vehicle at x = -length; the hatch is `hatchZ` to the side of the hinge and 1.3 m above the
 * floor. A box truss carries an enclosed, ribbed walkway tunnel to the white room, whose bellows hood
 * closes on the hatch; kingpost stays and a slewing drive at the hinge.
 */
function crewArm(b: MeshBuilder, length: number, hatchZ: number, sign: { sheet: DecalSheet; name: string } | null): void {
  const roomL = 3.7;
  const roomX0 = -length + 0.55;
  const roomX1 = roomX0 + roomL;
  const zMin = hatchZ - 2.4;
  const zMax = Math.max(1.25, hatchZ + 2.4);
  const roomW = zMax - zMin;
  const roomZ = (zMin + zMax) / 2;
  const yFloor = -0.35;
  const yRoof = 3.05;
  const tunnelEnd = roomX1 - 0.05;
  const tw = 1.0;
  // ---- box truss that carries the tunnel
  b.mat('paint-grey').masks(0.25, 1, 0.4, 0);
  b.at(xf.translate(0.5, -0.5, 0), () => trussArm(b, -roomX1 + 0.5 + 0.3, 2.9, 3.5, 2.4, 0.22));
  // ---- walkway tunnel: panelled sides, pitched roof edges
  const hex: [number, number][] = [
    [-tw, 0],
    [tw, 0],
    [tw, 2.1],
    [tw - 0.32, 2.5],
    [-tw + 0.32, 2.5],
    [-tw, 2.1],
  ];
  b.mat('paint-white').masks(0.15, 1, 0.35, 0);
  extrudeZY(b, hex, tunnelEnd, 0.3, 'tunnel');
  if (b.lod < 2) {
    // Frames every panel, a kick stripe, windows in every second panel.
    const pitch = b.pick(1.2, 2.4, 2.4);
    const frames = Math.max(2, Math.round((0.3 - tunnelEnd) / pitch));
    const ribHex = hex.map(([z, y]) => [z * 1.035, y <= 0 ? -0.04 : y + 0.035] as [number, number]);
    b.mat('alu-machined').masks(0.3, 1, 0.3, 0);
    for (let i = 0; i <= frames; i++) {
      const x = 0.3 + ((tunnelEnd - 0.3) * i) / frames;
      extrudeZY(b, ribHex, x - 0.035, x + 0.035, 'tunnel-frame');
    }
    b.mat('paint-navy').masks(0.15, 1, 0.35, 0);
    for (const s of [-1, 1]) box(b, 0.3 - tunnelEnd - 0.1, 0.28, 0.012, [(0.3 + tunnelEnd) / 2, 0.42, s * (tw + 0.004)], 'stripe');
    const bays = Math.round((0.3 - tunnelEnd) / 2.4);
    for (let i = 0; i < bays; i++) {
      const x = 0.3 - 1.2 - i * 2.4;
      if (x - 0.5 < tunnelEnd) break;
      for (const s of [-1, 1]) {
        b.mat('alu-machined').masks(0.3, 1, 0.3, 0);
        frameXY(b, x, 1.45, s * (tw + 0.012), 0.74, 0.58, 0.06, 0.03);
        b.mat('glass').masks(0, 1, 0.2, 0);
        box(b, 0.62, 0.46, 0.012, [x, 1.45, s * (tw + 0.008)], 'window');
      }
    }
    // Conditioned-air duct and cable tray on the roof, with saddles.
    b.mat('blanket-silver').masks(0, 1, 0.3, 0);
    pipe(
      b,
      [
        [0.9, 2.2, 0.42],
        [0.9, 2.86, 0.42],
        [roomX1 - 0.9, 2.86, 0.42],
        [roomX1 - 0.9, 3.42, Math.min(0.42, zMax - 0.9)],
        [roomX1 - 1.5, 3.42, Math.min(0.42, zMax - 0.9)],
      ],
      0.2,
      0.45,
      { segs: b.pick(14, 8, 6), tag: 'air-duct' },
    );
    b.mat('galvanised').masks(0.2, 1, 0.3, 0);
    box(b, 0.3 - tunnelEnd - 0.4, 0.07, 0.32, [(0.3 + tunnelEnd) / 2, 2.57, -0.42], 'cable-tray');
    if (b.lod === 0) {
      for (let i = 0; i <= frames; i += 2) {
        const x = 0.3 + ((tunnelEnd - 0.3) * i) / frames;
        box(b, 0.1, 0.16, 0.52, [x, 2.62, 0.42], 'duct-saddle');
      }
    }
  }

  // ---- white room: framed, panelled enclosure
  b.mat('paint-white').masks(0.15, 1, 0.35, 0);
  box(b, roomL, yRoof - yFloor, roomW, [(roomX0 + roomX1) / 2, (yFloor + yRoof) / 2, roomZ], 'white-room');
  if (b.lod < 2) {
    // Corner posts, sill and eaves members, wall stiffeners.
    b.mat('paint-grey').masks(0.25, 1, 0.4, 0);
    for (const x of [roomX0, roomX1]) for (const z of [zMin, zMax]) box(b, 0.16, yRoof - yFloor + 0.1, 0.16, [x, (yFloor + yRoof) / 2, z], 'room-post');
    for (const y of [yFloor, yRoof]) {
      for (const z of [zMin, zMax]) box(b, roomL + 0.1, 0.14, 0.14, [(roomX0 + roomX1) / 2, y, z], 'room-rail');
      for (const x of [roomX0, roomX1]) box(b, 0.14, 0.14, roomW + 0.1, [x, y, roomZ], 'room-rail');
    }
    b.mat('alu-machined').masks(0.3, 1, 0.3, 0);
    const nz = Math.max(2, Math.round(roomW / 0.9));
    const nx = Math.max(2, Math.round(roomL / 0.9));
    for (let i = 1; i < nz; i++) {
      const z = zMin + (roomW * i) / nz;
      // The hatch-side wall keeps its opening clear.
      if (Math.abs(z - hatchZ) > 1.0) box(b, 0.035, yRoof - yFloor - 0.2, 0.05, [roomX0 - 0.012, (yFloor + yRoof) / 2, z], 'room-rib');
      if (z < -tw - 0.1 || z > tw + 0.1) box(b, 0.035, yRoof - yFloor - 0.2, 0.05, [roomX1 + 0.012, (yFloor + yRoof) / 2, z], 'room-rib');
    }
    for (let i = 1; i < nx; i++) {
      const x = roomX0 + (roomL * i) / nx;
      // Battens stop short of the porthole and the sign board on the outer flank.
      const clear = Math.abs(x - (roomX0 + roomX1) / 2) < 0.75;
      for (const z of [zMin - 0.012, zMax + 0.012]) {
        if (clear && z < roomZ) box(b, 0.05, 1.05 - yFloor - 0.1, 0.035, [x, (yFloor + 1.05) / 2, z], 'room-rib');
        else box(b, 0.05, yRoof - yFloor - 0.2, 0.035, [x, (yFloor + yRoof) / 2, z], 'room-rib');
      }
    }
    b.mat('paint-navy').masks(0.15, 1, 0.35, 0);
    for (const z of [zMin - 0.004, zMax + 0.004]) box(b, roomL - 0.2, 0.28, 0.012, [(roomX0 + roomX1) / 2, 0.42, z], 'stripe');
    // Porthole on the outer flank, emergency egress door beside the tunnel with its landing.
    b.mat('alu-machined').masks(0.3, 1, 0.3, 0);
    b.at(xf.mul(xf.translate((roomX0 + roomX1) / 2, 1.55, zMin - 0.01), xf.rotX(-Math.PI / 2)), () => ringSolid(b, 0.24, 0.31, 0, 0.035, b.pick(24, 12, 8), 'porthole-frame'));
    b.mat('glass').masks(0, 1, 0.2, 0);
    b.at(xf.mul(xf.translate((roomX0 + roomX1) / 2, 1.55, zMin - 0.01), xf.rotX(-Math.PI / 2)), () => frustum(b, 0.245, 0.245, 0, 0.018, b.pick(24, 12, 8), 'porthole'));
    const doorZ = (zMin + -tw) / 2 - 0.1;
    if (-tw - zMin > 1.5) {
      b.mat('alu-machined').masks(0.3, 1, 0.3, 0);
      frameYZ(b, roomX1 + 0.005, roomX1 + 0.05, 1.08, doorZ, 1.12, 2.2, 0.08, 'door-frame');
      b.mat('paint-red').masks(0.2, 1, 0.3, 0);
      box(b, 0.035, 2.04, 0.96, [roomX1 + 0.022, 1.08, doorZ], 'egress-door');
      b.mat('steel-bare').masks(0.3, 1, 0.3, 0);
      rod(b, [roomX1 + 0.07, 1.05, doorZ + 0.3], [roomX1 + 0.07, 1.05, doorZ + 0.12], 0.014, 6, 'door-handle');
      b.mat('grating').masks(0.2, 1, 0.4, 0);
      box(b, 1.3, 0.05, 1.5, [roomX1 + 0.65, -0.03, doorZ], 'egress-landing');
      handrail(b, [[roomX1 + 0.05, 0, doorZ - 0.72], [roomX1 + 1.27, 0, doorZ - 0.72], [roomX1 + 1.27, 0, doorZ + 0.72]], 1.05, 0.65);
    }
    // Roof: guard rail, a beacon mast, the lifting lugs.
    handrail(b, [[roomX0 + 0.1, yRoof + 0.07, zMin + 0.1], [roomX1 - 0.1, yRoof + 0.07, zMin + 0.1], [roomX1 - 0.1, yRoof + 0.07, zMax - 0.1], [roomX0 + 0.1, yRoof + 0.07, zMax - 0.1], [roomX0 + 0.1, yRoof + 0.07, zMin + 0.1]], 1.05, 1.2);
    // Floor beams under the room and the kickers that carry it from the truss.
    b.mat('paint-grey').masks(0.25, 1, 0.5, 0);
    for (let i = 0; i <= 3; i++) {
      const x = roomX0 + 0.25 + ((roomL - 0.5) * i) / 3;
      if (b.lod === 0) section(b, iSection(0.16, 0.26, 0.016), [x, yFloor - 0.2, zMin], [x, yFloor - 0.2, zMax], [1, 0, 0], 'floor-beam');
      else box(b, 0.16, 0.26, roomW, [x, yFloor - 0.2, roomZ], 'floor-beam');
    }
    for (const z of [-1.45, 1.45]) rod(b, [roomX1 + 2.4, -0.5, z], [roomX0 + 0.4, yFloor - 0.33, Math.max(zMin + 0.3, Math.min(zMax - 0.3, z * 1.6 + hatchZ * 0.5))], 0.075, b.pick(8, 6, 4), 'kicker');
    // ---- bellows hood and seal on the hatch
    b.mat('paint-black').masks(0, 0.6, 0.2, 0);
    box(b, 0.02, 1.62, 1.42, [roomX0 - 0.012, 1.3, hatchZ], 'hood-opening');
    b.mat('alu-machined').masks(0.3, 1, 0.3, 0);
    frameYZ(b, roomX0 - 0.06, roomX0 - 0.005, 1.3, hatchZ, 2.08, 2.28, 0.2, 'hood-collar');
    b.mat('rubber').masks(0, 0.9, 0.3, 0);
    const folds = b.pick(6, 3, 0);
    const x1 = roomX0 - 0.06;
    const x0 = -length + 0.09;
    for (let i = 0; i < folds; i++) {
      const big = i % 2 === 0;
      const xa = x1 + ((x0 - x1) * i) / folds;
      const xb = x1 + ((x0 - x1) * (i + 1)) / folds;
      frameYZ(b, xb, xa, 1.3, hatchZ, big ? 2.0 : 1.82, big ? 2.2 : 2.02, big ? 0.26 : 0.17, 'bellows');
    }
    b.mat('blanket').masks(0, 0.9, 0.3, 0);
    frameYZ(b, -length, -length + 0.09, 1.3, hatchZ, 1.92, 2.12, 0.24, 'seal');
    // Marking beside the egress door or on the outer flank (the structure file names it).
    if (sign) {
      b.mat('decal').masks(0, 1, 0.3, 0);
      const h = 0.5;
      boardDecal(b, sign.sheet, sign.name, [(roomX0 + roomX1) / 2, 2.45, zMin - 0.02], [-1, 0, 0], h * sign.sheet.aspect(sign.name), h);
    }
  } else {
    b.mat('rubber').masks(0, 0.9, 0.3, 0);
    box(b, 0.5, 2.1, 1.9, [-length + 0.3, 1.3, hatchZ], 'bellows');
  }

  // ---- hinge: trunnion, bearing brackets, slewing drive, kingpost with stays
  b.mat('steel-dark').masks(0.2, 1, 0.5, 0);
  frustum(b, 0.36, 0.36, -1.0, 3.6, b.pick(20, 10, 6), 'hinge');
  if (b.lod < 2) {
    for (const y of [-0.5, 3.0]) box(b, 1.1, 0.3, 1.5, [0.2, y, 0], 'hinge-bracket');
    ringSolid(b, 0.42, 0.95, -0.95, -0.7, b.pick(32, 16, 8), 'slew-ring');
    b.mat('paint-yellow').masks(0.25, 1, 0.4, 0);
    box(b, 0.7, 0.55, 0.6, [0.55, -0.42, 1.05], 'slew-drive');
    b.at(xf.translate(0.55, -0.15, 1.05), () => frustum(b, 0.2, 0.2, 0, 0.7, b.pick(14, 8, 6), 'slew-motor'));
    b.mat('paint-grey').masks(0.25, 1, 0.4, 0);
    rod(b, [0, 3.6, 0], [0, 8.4, 0], 0.2, b.pick(12, 8, 5), 'kingpost');
    // Stays: wire rope from the kingpost head to the truss, each with a turnbuckle and a socket at the truss.
    b.mat('steel-dark').masks(0.2, 1, 0.4, 0);
    for (const z of [-1.45, 1.45]) {
      for (const x of [roomX1 + 0.2, roomX1 * 0.5]) {
        const a: Vec3Tuple = [0, 8.3, 0];
        const e: Vec3Tuple = [x, 3.0, z];
        rod(b, a, e, b.pick(0.016, 0.03, 0.03), b.pick(6, 4, 4), 'stay');
        if (b.lod === 0) {
          const at = (t: number): Vec3Tuple => [a[0] + (e[0] - a[0]) * t, a[1] + (e[1] - a[1]) * t, a[2] + (e[2] - a[2]) * t];
          rod(b, at(0.9), at(0.94), 0.035, 8, 'turnbuckle');
          rod(b, at(0.985), at(1), 0.04, 8, 'socket');
        }
      }
    }
  }
}

/** Rectangular frame lying in a plane z = const (a window surround): centre (x, y), outer size w x h. */
function frameXY(b: MeshBuilder, x: number, y: number, z: number, w: number, h: number, t: number, d: number): void {
  for (const s of [-1, 1]) {
    box(b, w, t, d, [x, y + s * (h / 2 - t / 2), z], 'window-frame');
    box(b, t, h - 2 * t, d, [x + s * (w / 2 - t / 2), y, z], 'window-frame');
  }
}

export const padUmbilicalTower: SiteGenerator = ({ params, defs }) => {
  const sheet = decalSheetOf(defs);
  const H = numParam(params, 'height', 138);
  const half = numParam(params, 'half', 5);
  const dist = numParam(params, 'vehicleDistance', 27);
  const levelH = numParam(params, 'levelHeight', 6);
  const levels = Math.floor(H / levelH);
  const col = half - 0.45;
  const arms = parseList(strParam(params, 'arms', '')).map((e) => ({ y: e.n[0]!, reach: e.n[1]! }));
  const crew = { y: numParam(params, 'crewArmHeight', 119), reach: numParam(params, 'crewArmReach', 2.35) };
  // Sign boards on the two flanks: "decal@height,size;..." (content of the site; none = no boards).
  const signs = parseList(strParam(params, 'signs', '')).map((e) => ({ name: e.name, y: e.n[0]!, height: e.n[1]! }));
  const crewSign = strParam(params, 'crewArmSign', '');
  /** Gap between an arm's umbilical carrier and the vehicle's plate that its hoses cross, m. */
  const hose = numParam(params, 'hoseLength', 0.26);
  const hingeZ = -(half - 1.6);
  const crewHingeZ = half - 3.0;
  const face = -half - 0.5;
  const lampHeights = [0.2, 0.42, 0.64, 0.84].map((f) => Math.round((H * f) / levelH) * levelH + 2.2);
  const lodPixels = [numParam(params, 'lod1Pixels', 900), numParam(params, 'lod2Pixels', 260)];

  /**
   * The tower is three models: 'body' (columns, level frames, elevator shaft, risers, crane: casts into
   * every cascade), 'lattice' (bracing, guard rails, stairs: members thinner than a coarse shadow texel,
   * which cast into the fine cascades only) and 'gratings' (the open floors, which cast nothing).
   */
  const build = (part: 'body' | 'lattice' | 'gratings') =>
    (b: MeshBuilder): void => {
      const B = part === 'body';
      const L = part === 'lattice';
      const G = part === 'gratings';
      const first = b.vertexCount;
      // ---- columns (H sections), level frames, bracing
      b.mat('paint-grey').masks(0.2, 1, 0.6, 0);
      if (B) for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          if (b.lod === 0) section(b, iSection(0.9, 0.9, 0.1), [sx * col, -0.5, sz * col], [sx * col, H + 0.25, sz * col], [1, 0, 0], 'column');
          else box(b, b.pick(0.9, 0.9, 1.5), H + 0.75, b.pick(0.9, 0.9, 1.5), [sx * col, H / 2 - 0.125, sz * col], 'column');
        }
      }
      const stepL = b.pick(1, 1, 4);
      for (let l = stepL; B && l <= levels; l += stepL) {
        const y = l * levelH;
        for (const s of [-1, 1]) {
          if (b.lod === 0) {
            section(b, iSection(0.3, 0.5, 0.035), [-col, y - 0.25, s * col], [col, y - 0.25, s * col], [0, 0, 1], 'level-beam');
            section(b, iSection(0.3, 0.5, 0.035), [s * col, y - 0.25, -col], [s * col, y - 0.25, col], [1, 0, 0], 'level-beam');
          } else {
            box(b, 2 * col, 0.5, b.pick(0.3, 0.3, 0.6), [0, y - 0.25, s * col], 'level-beam');
            box(b, b.pick(0.3, 0.3, 0.6), 0.5, 2 * col, [s * col, y - 0.25, 0], 'level-beam');
          }
        }
      }
      if (b.lod === 2 && B) {
        // Far silhouette: the lattice reads as a solid, slightly lighter core.
        b.mat('paint-white-b').masks(0.15, 1, 0.5, 0);
        box(b, 2 * col * 0.72, H - 1, 2 * col * 0.72, [0, (H - 1) / 2, 0], 'core');
        b.mat('paint-yellow').masks(0.25, 1, 0.3, 0);
        box(b, dist + 8, 2.6, 2.4, [-(dist - 11.5) / 2, H + 4.6, 0], 'crane');
      }
      if (b.lod < 2) {
        const braceR = b.pick(0.11, 0.24, 0);
        for (let l = 0; L && l < levels; l++) {
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
            rod(b, [flip ? a[0] : c[0], y0, flip ? a[1] : c[1]], [flip ? c[0] : a[0], y1, flip ? c[1] : a[1]], braceR, b.pick(8, 5, 4), 'brace');
            if (b.lod === 0) {
              rod(b, [flip ? c[0] : a[0], y0, flip ? c[1] : a[1]], [flip ? a[0] : c[0], y1, flip ? a[1] : c[1]], braceR, 8, 'brace');
              // Gusset plates where the braces meet the columns, and the splice plate where they cross.
              const out: Vec3Tuple = [(a[0] + c[0]) / (2 * col), 0, (a[1] + c[1]) / (2 * col)];
              const run: Vec3Tuple = [(c[0] - a[0]) / (2 * col), 0, (c[1] - a[1]) / (2 * col)];
              for (const [px, pz, py] of [[a[0], a[1], y0 + 0.3], [c[0], c[1], y0 + 0.3], [a[0], a[1], y1 - 0.3], [c[0], c[1], y1 - 0.3]] as [number, number, number][]) {
                const s = px === a[0] && pz === a[1] ? 1 : -1;
                b.at(xf.fromAxes([px + run[0] * s * 0.55 + out[0] * 0.02, py, pz + run[2] * s * 0.55 + out[2] * 0.02], run, [0, 1, 0], [-run[2], 0, run[0]]), () => box(b, 0.75, 0.7, 0.025, [0, 0, 0], 'gusset'));
              }
              b.at(xf.fromAxes([(a[0] + c[0]) / 2 + out[0] * 0.02, (y0 + y1) / 2, (a[1] + c[1]) / 2 + out[2] * 0.02], run, [0, 1, 0], [-run[2], 0, run[0]]), () => box(b, 0.6, 0.6, 0.025, [0, 0, 0], 'gusset'));
            }
          }
        }
        // ---- floors with guard rails, elevator shaft, stairs
        if (G) {
          b.masks(0.1, 0.9, 0.3, 0);
          // Open grating between the level beams, in four bays round the elevator shaft and the stair well.
          for (let l = 1; l <= levels; l++) gratingPanel(b, 0, l * levelH + 0.02, 0, 2 * col - 0.4, 2 * col - 0.4, l % 2 === 0);
        }
        if (b.lod === 0 && L) {
          const e = col - 0.25;
          for (let l = 1; l <= levels; l++) {
            const y = l * levelH + 0.06;
            // The working face (-X) is left open where arms and lines pass.
            handrail(b, [[-e, y, -e], [e, y, -e], [e, y, e], [-e, y, e]], 1.1, 2.2);
          }
        }
        const sx0 = col - 1.9;
        b.mat('paint-white-b').masks(0.15, 1, 0.5, 0);
        if (B) box(b, 3, H - 1, 3, [sx0, (H - 1) / 2, sx0], 'elevator');
        // Shaft framing: corner angles, a girt and a landing door at every level, machine room on top.
        b.mat('paint-grey').masks(0.25, 1, 0.5, 0);
        if (B) for (const dx of [-1, 1]) for (const dz of [-1, 1]) box(b, 0.14, H - 1, 0.14, [sx0 + dx * 1.5, (H - 1) / 2, sx0 + dz * 1.5], 'shaft-post');
        if (B) box(b, 3.5, 2.6, 3.5, [sx0, H + 0.8, sx0], 'machine-room');
        if (b.lod === 0) {
          for (let l = 1; B && l <= levels; l++) {
            const y = l * levelH;
            box(b, 3.12, 0.16, 3.12, [sx0, y - 0.3, sx0], 'shaft-girt');
            b.mat('alu-machined');
            box(b, 0.05, 2.25, 1.5, [sx0 - 1.52, y + 1.2, sx0], 'lift-door-frame');
            b.mat('steel-brushed');
            box(b, 0.03, 2.1, 1.3, [sx0 - 1.545, y + 1.15, sx0], 'lift-door');
            b.mat('paint-grey');
          }
          b.mat('galvanised').masks(0.2, 1, 0.5, 0);
          for (let l = 0; L && l < levels; l++) {
            const y0 = l * levelH + 0.06;
            const ym = y0 + levelH / 2;
            const xa = -col + 1.2;
            const xb = -col + 2.4;
            // Two flights per level with a half landing: stringers, grating treads, rails.
            stairFlight(b, [xa, y0, col - 3.6], [xa, ym, col - 0.9], 1.0);
            stairFlight(b, [xb, ym, col - 0.9], [xb, y0 + levelH, col - 3.6], 1.0);
            b.mat('grating');
            box(b, 2.4, 0.05, 0.9, [-col + 1.8, ym - 0.025, col - 0.45], 'landing');
            b.mat('galvanised');
          }
        }
        if (!B) {
          weather(b, first);
          return;
        }
        // ---- propellant and gas risers on the working face with brackets, cable tray
        b.mat('steel-brushed').masks(0.1, 1, 0.4, 0.4);
        const top = Math.max(...arms.map((a) => a.y), crew.y) + 1.5;
        for (let i = 0; i < 4; i++) {
          const z = hingeZ + 1.6 + i * 0.75;
          pipe(b, [[face + 0.2, 0.5, z], [face + 0.2, top - i * 4, z]], 0.24 - i * 0.03, 0.5, { segs: b.pick(12, 6, 5), tag: 'riser' });
        }
        b.mat('galvanised').masks(0.2, 1, 0.4, 0);
        box(b, 0.12, top, 0.7, [face + 0.25, top / 2, crewHingeZ + 1.6], 'cable-tray');
        if (b.lod === 0) for (let y = levelH; y < top - 12; y += levelH) box(b, 0.5, 0.12, 3.3, [face + 0.42, y - 0.6, hingeZ + 2.7], 'riser-bracket');
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
        if (b.lod === 0) {
          b.mat('glass').masks(0, 1, 0.2, 0);
          box(b, 0.03, 1.0, 1.7, [-3.81, cy + 0.55, 1.9], 'cab-window');
        }
        b.mat('steel-dark').masks(0.2, 1, 0.3, 0);
        rod(b, [-(dist - 2.5), cy + 1.4, 0], [-(dist - 2.5), cy - 3.5, 0], b.pick(0.05, 0.12, 0), 6, 'hoist');
        box(b, 0.7, 0.9, 0.5, [-(dist - 2.5), cy - 3.9, 0], 'hook-block');
        b.mat('paint-grey');
        rod(b, [0, cy + 3.8, 0], [0, cy + 19, 0], b.pick(0.16, 0.3, 0), b.pick(8, 6, 4), 'lightning-rod');
        // ---- sign boards on the two flanks
        for (const sg of signs) {
          const w = sg.height * sheet.aspect(sg.name);
          for (const s of [-1, 1]) {
            b.mat('paint-navy').masks(0.1, 1, 0.3, 0);
            box(b, w + 0.5, sg.height + 0.4, 0.15, [0, sg.y, s * (half + 0.1)], 'sign-board');
            b.mat('decal');
            boardDecal(b, sheet, sg.name, [0, sg.y, s * (half + 0.19)], [s, 0, 0], w, sg.height);
          }
        }
        // ---- lamp housings facing the vehicle
        b.mat('steel-dark').masks(0.2, 1, 0.3, 0);
        for (const y of lampHeights) for (const z of [-2.2, 2.2]) box(b, 0.5, 0.9, 1.3, [face + 0.1, y, z], 'lamp-housing');
      }
      if (!B) return;
      weather(b, first);
      b.mat('concrete-wall').masks(0, 1, 0.25, 0);
      box(b, 2 * half + 3, 1.2, 2 * half + 3, [0, 0, 0], 'foundation');
    };
  /**
   * Weathering of the steelwork as vertex grime: every member a little different (no two beams have aged
   * alike), heavier low down where the exhaust cloud reaches, and scorched on the face toward the vehicle.
   */
  const weather = (b: MeshBuilder, from: number): void =>
    b.remask(from, (p, m) => {
      const toward = Math.max(0, Math.min(1, (col - p[0]) / (2 * col)));
      const low = Math.exp(-Math.max(0, p[1]) / 45);
      m.soot = Math.max(0, Math.min(0.85, 0.06 + 0.3 * noise2(p[1] / 6.1 + p[2] * 0.37, p[0] * 0.9 + p[2] * 0.53, 31) + 0.42 * toward * (0.35 + 0.65 * low) + 0.12 * low));
    });
  const body = buildModel('pad.umbilicalTower', build('body'), lodPixels);
  const lattice = buildModel('pad.umbilicalTower.lattice', build('lattice'), lodPixels);
  const gratings = buildModel('pad.umbilicalTower.gratings', build('gratings'), lodPixels);

  const armModel = (name: string, length: number): PartModel =>
    buildModel(name, (b) => {
      // Arm frame: origin on the hinge axis at walkway level; the arm runs along -X.
      b.mat('paint-grey').masks(0.2, 1, 0.5, 0);
      trussArm(b, length - 0.6, 2.2, 2.6, 2.4, 0.2);
      if (b.lod < 2) {
        gratingPanel(b, -(length - 0.8) / 2, 0.12, 0, length - 0.8, 1.3, true);
        handrail(b, [[0, 0.14, 0.65], [-length + 0.8, 0.14, 0.65]], 1.05, 2.4);
        handrail(b, [[0, 0.14, -0.65], [-length + 0.8, 0.14, -0.65]], 1.05, 2.4);
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
        // What crosses the gap to the vehicle's own plate: flex hoses (the cryogenic ones under a sleeve of
        // frost), a cable loom, their couplings, and a drip tray under them. They swing away with the arm.
        const x0 = -length - 0.06;
        const x1 = -length - hose;
        for (const [dz, dy, r, cryo] of [[-0.8, 0.4, 0.1, 1], [-0.4, 0.45, 0.11, 1], [0.05, 0.4, 0.085, 0], [0.5, 0.42, 0.075, 0], [0.85, 0.3, 0.05, 0], [-0.6, -0.25, 0.045, 0], [0.3, -0.3, 0.04, 0]] as [number, number, number, number][]) {
          const y = 1.45 + dy;
          b.mat(cryo ? 'frost' : 'rubber').masks(0, 1, 0.2, 0);
          // (Short and stiff under pressure: each hose droops by a fraction of its own diameter.)
          rod(b, [x0, y, off + dz], [x1, y - r * 0.25, off + dz], r, b.pick(12, 8, 5), 'hose');
          if (b.lod === 0) {
            b.mat('steel-bare').masks(0.2, 1, 0.2, 0);
            for (const x of [x0 + 0.01, x1 + 0.03]) b.at(xf.mul(xf.translate(x, y, off + dz), xf.rotZ(Math.PI / 2)), () => ringSolid(b, r - 0.004, r + 0.024, -0.03, 0.03, 12, 'coupling'));
          }
        }
        b.mat('galvanised').masks(0.2, 1, 0.3, 0);
        box(b, hose + 0.25, 0.03, 2.3, [-length - hose / 2 + 0.1, 0.72, off], 'drip-tray');
        for (const s of [-1, 1]) box(b, hose + 0.25, 0.12, 0.03, [-length - hose / 2 + 0.1, 0.78, off + s * 1.15], 'drip-tray');
      }
      b.mat('steel-dark').masks(0.2, 1, 0.5, 0);
      frustum(b, 0.36, 0.36, -0.3, 2.9, b.pick(16, 10, 6), 'hinge');
    });
  /** Stand-in that casts an arm's shadow where the cascades cannot resolve its truss. */
  const armShadow = (name: string, length: number): PartModel =>
    buildModel(name, (b) => {
      b.mat('paint-grey');
      box(b, length - 0.6, 0.9, 0.8, [-(length - 0.6) / 2, 1.3, 0], 'shadow-proxy');
    });

  const models: Record<string, PartModel> = { body, lattice, gratings };
  arms.forEach((a, i) => {
    models[`arm${i}`] = armModel(`pad.umbilicalTower.arm${i}`, dist - half - 0.5 - a.reach);
    models[`armShadow${i}`] = armShadow(`pad.umbilicalTower.armShadow${i}`, dist - half - 0.5 - a.reach);
  });
  models['crewArm'] = buildModel('pad.umbilicalTower.crewArm', (b) => crewArm(b, dist - half - 0.5 - crew.reach, -crewHingeZ, crewSign ? { sheet, name: crewSign } : null));
  models['lamps'] = buildModel('pad.umbilicalTower.lamps', (b) => {
    b.mat('lamp').masks(0, 1, 0, 0);
    for (const y of lampHeights) for (const z of [-2.2, 2.2]) box(b, 0.05, 0.7, 1.1, [face - 0.17, y, z], 'lens');
    // Work lights: a small fitting under the beam at two corners of every level, as on any working tower.
    if (b.lod < 2) for (let l = 1; l <= levels; l++) for (const [sx, sz] of [[-1, -1], [1, 1]] as [number, number][]) box(b, 0.3, 0.07, 0.12, [sx * (col - 0.9), l * levelH - 0.58, sz * (col - 0.5)], 'work-light');
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
      emit('body', null, null, { grime: 1 });
      emit('lattice', null, null, { grime: 1, fineShadowOnly: true });
      emit('gratings', null, null, { castShadow: false });
      const t = state.arms * state.arms * (3 - 2 * state.arms);
      arms.forEach((a, i) => {
        emit(`arm${i}`, [face, a.y - 1.45, hingeZ], yaw(-68 * DEG * t), { moving: moving.arms, fineShadowOnly: true });
        emit(`armShadow${i}`, [face, a.y - 1.45, hingeZ], yaw(-68 * DEG * t), { moving: moving.arms, shadowProxy: true });
      });
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
  const lodPixels = [numParam(params, 'lod1Pixels', 520), numParam(params, 'lod2Pixels', 170)];
  // Lattice tower in aviation red and white bands, carrying an insulating mast for the catenary wires.
  const half = (y: number): number => r0 + (r1 - r0) * Math.pow(y / steel, 0.8);
  const levelY = (l: number): number => steel * (1 - Math.pow(1 - l / bays, 1.35));
  const node = (k: number, l: number, shrink = 1): Vec3Tuple => {
    const y = levelY(l);
    const h = half(y) * shrink;
    return [(k === 0 || k === 3 ? -1 : 1) * h, y, (k < 2 ? -1 : 1) * h];
  };
  const body = buildModel(
    'pad.lightningMast',
    (b) => {
      const paint = (l: number): MatId => (Math.floor(l / 2) % 2 === 0 ? 'paint-red' : 'paint-white');
      if (b.lod === 2) solid(b, 0.42, paint);
      else {
        const step = b.pick(1, 2, 2);
        // Middle LOD: members thick enough to hold a pixel where it is used.
        const thick = b.pick(1, 2.6, 1);
        for (let l = 0; l < bays; l += step) {
          const m = Math.min(bays, l + step);
          b.mat(paint(l)).masks(0.15, 1, 0.3, 0);
          const leg = (0.2 - 0.1 * (l / bays)) * thick;
          for (let k = 0; k < 4; k++) {
            rod(b, node(k, l), node(k, m), leg, b.pick(8, 5, 4), 'leg');
            rod(b, node(k, m), node((k + 1) % 4, m), leg * b.pick(0.45, 0.55, 1), b.pick(6, 4, 4), 'ring');
            rod(b, node(k, l), node((k + 1) % 4, m), leg * b.pick(0.4, 0.5, 1), b.pick(6, 4, 4), 'brace');
            if (b.lod === 0) rod(b, node((k + 1) % 4, l), node(k, m), leg * 0.4, 6, 'brace');
          }
        }
      }
      b.mat('paint-grey').masks(0.1, 1, 0.3, 0);
      const fat = b.pick(1, 2.2, 3.2);
      lathe(b, Profile.at(0, steel - 0.5).corner(0.42 * fat, steel - 0.5).to(0.3 * fat, steel + 6).to(0.12 * fat, H).corner(0, H), { segs: b.pick(12, 6, 4), tag: 'top-mast' });
      if (b.lod < 2) {
        b.mat('galvanised').masks(0.2, 1, 0.3, 0);
        box(b, 2 * r1 + 0.6, 0.12, 2 * r1 + 0.6, [0, steel, 0], 'top-platform');
      }
      b.mat('concrete-wall').masks(0, 1, 0.3, 0);
      if (b.lod < 2) {
        for (let k = 0; k < 4; k++) {
          const p = node(k, 0);
          box(b, 2.4, 1.4, 2.4, [p[0], 0.1, p[2]], 'footing');
        }
      } else box(b, 2 * r0 * 0.42 + 1.2, 1.2, 2 * r0 * 0.42 + 1.2, [0, 0, 0], 'footing');
    },
    lodPixels,
  );
  /** The mast as a slender solid in bands of `shrink` times the lattice's width. */
  function solid(b: MeshBuilder, shrink: number, paint: (l: number) => MatId): void {
        for (let l = 0; l < bays; l += 2) {
          const m = Math.min(bays, l + 2);
          b.mat(paint(l)).masks(0.15, 1, 0.3, 0);
          const a = node(2, l, shrink);
          const c = node(2, m, shrink);
          b.begin(true, 'mast-solid');
          const ring = (p: Vec3Tuple): Vec3Tuple[] => [
            [-p[0], p[1], -p[2]],
            [p[0], p[1], -p[2]],
            [p[0], p[1], p[2]],
            [-p[0], p[1], p[2]],
          ];
          const lo = ring(a);
          const hi = ring(c);
          for (let f = 0; f < 4; f++) {
            const g = (f + 1) % 4;
            // Faces in the order -Z, +X, +Z, -X; the taper is slight, so the face normal is taken as horizontal.
            const n: Vec3Tuple = f === 0 ? [0, 0, -1] : f === 1 ? [1, 0, 0] : f === 2 ? [0, 0, 1] : [-1, 0, 0];
            const t: Vec3Tuple = f === 0 ? [-1, 0, 0] : f === 1 ? [0, 0, -1] : f === 2 ? [1, 0, 0] : [0, 0, 1];
            const w = 2 * a[0];
            const q = [b.vt(lo[g]!, n, t, 0, a[1]), b.vt(lo[f]!, n, t, w, a[1]), b.vt(hi[f]!, n, t, w, c[1]), b.vt(hi[g]!, n, t, 0, c[1])];
            b.quad(q[0]!, q[1]!, q[2]!, q[3]!);
          }
          // Caps close the band.
          const up: Vec3Tuple = [0, 1, 0];
          const down: Vec3Tuple = [0, -1, 0];
          const tx: Vec3Tuple = [1, 0, 0];
          const cl = lo.map((p) => b.vt(p, down, tx, p[0], p[2]));
          b.quad(cl[0]!, cl[1]!, cl[2]!, cl[3]!);
          const ch = hi.map((p) => b.vt(p, up, tx, p[0], -p[2]));
          b.quad(ch[3]!, ch[2]!, ch[1]!, ch[0]!);
        }
  }
  // Stand-in that casts the mast's shadow where the cascades cannot resolve the lattice: a solid a third of
  // its width (a lattice is mostly air; a full-width solid would cast far too heavy a shadow).
  const shadow = buildModel('pad.lightningMast.shadow', (b) => {
    solid(b, 0.3, () => 'paint-grey');
    box(b, 0.5, H - steel, 0.5, [0, (H + steel) / 2, 0], 'shadow-proxy');
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
    models: { body, shadow, beacons },
    pose: (state, emit) => {
      emit('body', null, null, { fineShadowOnly: true });
      emit('shadow', null, null, { shadowProxy: true });
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
  // A wire thinner than a pixel breaks up into dots, and this mesh system has no coverage-blended lines. So
  // the wire is four models of growing gauge, each used over the range of distances at which it is between
  // one and three pixels wide (switch sizes are in pixels, so this holds at any resolution and field of view):
  // the true wire among the masts, then 0.22, 0.7 and 2.2 m. It never drops out while the masts it joins are
  // in view, and reads as the hairline with its glint that a camera records.
  const gauges = [radius, radius * 3.2, radius * 10, radius * 32];
  const span = Math.hypot(dx, dz, y1 - y0) / 2;
  // Projected diameter of the span's bounding sphere at which a gauge is 0.95 px wide (width = size x gauge / span).
  const lodPixels = gauges.slice(0, -1).map((g) => (0.95 * span) / g);
  const lods = gauges.map((g, i) => {
    const b = new MeshBuilder(Math.min(2, i));
    b.mat('steel-dark').masks(0.1, 1, 0.2, 0);
    const n = [28, 16, 12, 8][i]!;
    const pts: Vec3Tuple[] = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      pts.push([dx * t, y0 + (y1 - y0) * t - sag * 4 * t * (1 - t), dz * t]);
    }
    tube(b, pts, g, { segs: i === 0 ? 6 : 4, tag: 'wire' });
    return b.build();
  });
  const body: PartModel = { name: 'pad.catenary', lods, materials: lods[0]!.materialIds.map(materialDef), lodPixels };
  // No sun shadow: it would be a hair on the ground far below.
  return { models: { body }, pose: (_state, emit) => emit('body', null, null, { castShadow: false }) };
};
