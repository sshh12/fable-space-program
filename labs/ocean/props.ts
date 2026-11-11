/**
 * Lab props drawn through the core mesh system into the G-buffer: a sloping beach and seabed (terrain
 * material) for the shoreline and refraction scenes, a submerged test object, a capsule-sized hull riding the
 * floating vessel's pose, and marker spheres centred on the PHYSICS water height (oceanSwellHeight), which
 * must sit half-submerged in the rendered surface.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { FrameContext, MeshData, RenderContext, RenderFeature } from '@/core/contracts/render';
import { quat, v3, type Quat, type Vec3 } from '@/core/math';
import { coreOf, instanceInFrame, sphereMesh, type MeshBatch, type ModelHandle, type ParentPose } from '@/render/core';
import { enuAt } from '@/render/core/lab';
import { offsetDir, siteDir, waterHeight, type LabSite, type OceanLabWorld } from './labSim';

/** Revolve a profile (r, y) around +Y. */
function lathe(profile: [number, number][], segments: number): MeshData {
  const rings = profile.length;
  const pos: number[] = [];
  const nrm: number[] = [];
  const tan: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < rings; i++) {
    const [r, y] = profile[i]!;
    const prev = profile[Math.max(0, i - 1)]!;
    const next = profile[Math.min(rings - 1, i + 1)]!;
    const dr = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dr, dy) || 1;
    // Outward normal of the profile curve (dy, -dr) rotated about Y.
    const nr = dy / len;
    const ny = -dr / len;
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      pos.push(r * c, y, r * sn);
      nrm.push(nr * c, ny, nr * sn);
      tan.push(-sn, 0, c, 1);
      uv.push(s / segments, i / (rings - 1));
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let s = 0; s < segments; s++) {
      const a = i * (segments + 1) + s;
      const b = a + segments + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  let maxR = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [r, y] of profile) {
    maxR = Math.max(maxR, r);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    tangents: new Float32Array(tan),
    uvs: new Float32Array(uv),
    indices: new Uint32Array(idx),
    groups: [{ material: 0, start: 0, count: idx.length }],
    bounds: { min: [-maxR, minY, -maxR], max: [maxR, maxY, maxR] },
  };
}

/** Capsule-sized hull (base radius 1.95 m, 3.3 m tall): blunt heat shield, conical side, docking tunnel. */
function capsuleMesh(): MeshData {
  const p: [number, number][] = [[0, 0]];
  // Heat shield: spherical cap of radius 4.7 m.
  for (let i = 1; i <= 8; i++) {
    const r = (1.9 * i) / 8;
    p.push([r, 4.7 - Math.sqrt(4.7 * 4.7 - r * r)]);
  }
  p.push([1.96, 0.46], [1.93, 0.56]);
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    p.push([1.93 + (0.62 - 1.93) * t, 0.56 + (2.95 - 0.56) * t]);
  }
  p.push([0.5, 3.05], [0.5, 3.3], [0.0, 3.32]);
  return lathe(p, 48);
}

/** Beach and seabed: 128 x 128 cells over size x size m, rising from -13 m offshore to +3.5 m inland (north). */
function beachMesh(size: number, cells: number, height: (x: number, y: number) => number): MeshData {
  const n = cells + 1;
  const pos = new Float32Array(n * n * 3);
  const nrm = new Float32Array(n * n * 3);
  const tan = new Float32Array(n * n * 4);
  const uv = new Float32Array(n * n * 2);
  const step = size / cells;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -size / 2 + i * step;
      const y = -size / 2 + j * step;
      const k = j * n + i;
      const h = height(x, y);
      pos.set([x, y, h], k * 3);
      const hx = (height(x + 0.5, y) - height(x - 0.5, y)) / 1;
      const hy = (height(x, y + 0.5) - height(x, y - 0.5)) / 1;
      const l = Math.hypot(hx, hy, 1);
      nrm.set([-hx / l, -hy / l, 1 / l], k * 3);
      tan.set([1, 0, hx, 1], k * 4);
      uv.set([x / 8, y / 8], k * 2);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * n + i;
      idx.push(a, a + 1, a + n + 1, a, a + n + 1, a + n);
    }
  }
  return { positions: pos, normals: nrm, tangents: tan, uvs: uv, indices: new Uint32Array(idx), groups: [{ material: 0, start: 0, count: idx.length }], bounds: { min: [-size / 2, -size / 2, -14], max: [size / 2, size / 2, 6] } };
}

/**
 * Flat annulus in the site's ENU plane (z = 0 at its own origin), inner / outer radius in m: the stray water
 * fragments of the hand-over check (a terrain defect seen in the integrated app: sheet fragments left inside
 * fadeStart at the seabed's altitude, request terrain-render-cs-1).
 */
function annulusMesh(inner: number, outer: number, rings: number, segments: number): MeshData {
  const pos: number[] = [];
  const nrm: number[] = [];
  const tan: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const r = inner * (outer / inner) ** (i / rings);
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      pos.push(r * Math.cos(a), r * Math.sin(a), 0);
      nrm.push(0, 0, 1);
      tan.push(1, 0, 0, 1);
      uv.push(r * Math.cos(a) / 100, r * Math.sin(a) / 100);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let s = 0; s < segments; s++) {
      const a = i * (segments + 1) + s;
      const b = a + segments + 1;
      // Counter-clockwise seen from above (+Z): radial first, then around.
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    tangents: new Float32Array(tan),
    uvs: new Float32Array(uv),
    indices: new Uint32Array(idx),
    groups: [{ material: 0, start: 0, count: idx.length }],
    bounds: { min: [-outer, -outer, -1], max: [outer, outer, 1] },
  };
}

/** Value noise for the beach relief and the sand texture (deterministic). */
function noise2(x: number, y: number, seed: number, period = 0): number {
  const h = (a0: number, b0: number): number => {
    // With a period the lattice wraps, so a texture made of it tiles without a seam.
    const a = period > 0 ? ((a0 % period) + period) % period : a0;
    const b = period > 0 ? ((b0 % period) + period) % period : b0;
    let v = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(seed, 2147483647);
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = h(ix, iy) + (h(ix + 1, iy) - h(ix, iy)) * ux;
  const b = h(ix, iy + 1) + (h(ix + 1, iy + 1) - h(ix, iy + 1)) * ux;
  return a + (b - a) * uy;
}

export function beachHeight(x: number, y: number): number {
  const shelf = -13 + 16.5 / (1 + Math.exp(-(y - 40) / 55));
  const ripples = 0.25 * Math.sin(y * 0.35 + 2 * noise2(x * 0.02, y * 0.02, 3)) * (1 - 1 / (1 + Math.exp(-(y - 30) / 20)));
  const dunes = (noise2(x * 0.012, y * 0.012, 1) - 0.5) * 2.2 + (noise2(x * 0.05, y * 0.05, 2) - 0.5) * 0.6;
  return shelf + ripples + dunes * (0.4 + 0.6 / (1 + Math.exp(-(y - 60) / 30)));
}

function sandTexture(size = 256): { width: number; height: number; data: Uint8Array<ArrayBuffer> } {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const n = 0.55 * noise2(i / 8, j / 8, 5, size / 8) + 0.3 * noise2(i / 4, j / 4, 6, size / 4) + 0.15 * noise2(i, j, 7, size);
      const o = (j * size + i) * 4;
      // sRGB-encoded sand: pale calcareous (0.62, 0.55, 0.42) linear-ish with grain variation.
      data[o] = Math.round(200 + 40 * (n - 0.5));
      data[o + 1] = Math.round(186 + 38 * (n - 0.5));
      data[o + 2] = Math.round(158 + 34 * (n - 0.5));
      data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

export interface LabProps extends RenderFeature {
  beach: boolean;
  submerged: boolean;
  /** Where the submerged test object is: ENU offset from the site and depth of its centre (m). */
  submergedAt: { east: number; north: number; depth: number };
  markers: { east: number; north: number }[];
  /** Plane of the marker line, for specs: body-fixed centres of the markers drawn in the last frame. */
  lastMarkerDirs: Vec3[];
  /**
   * Stray WATER-material fragments inside fadeStart: an annulus of water material 150 m below sea level, 200 m to
   * 4 km around the site (in front of the LabPlanet seabed at 200 m), as a defective terrain would leave them.
   */
  strayWater: boolean;
}

export function createLabPropsFeature(world: OceanLabWorld, defs: DefLibrary): LabProps {
  let ctx: RenderContext;
  let batch: MeshBatch;
  let beach: ModelHandle;
  let capsule: ModelHandle;
  let ball: ModelHandle;
  let marker: ModelHandle;
  let stray: ModelHandle;
  const props: LabProps = {
    id: 'lab-props',
    order: -10,
    beach: false,
    submerged: false,
    submergedAt: { east: 0, north: 318, depth: 1.25 },
    markers: [],
    lastMarkerDirs: [],
    strayWater: false,
    init(c) {
      ctx = c;
      const meshes = coreOf(c).meshes;
      meshes.registerProceduralTexture('lab-ocean-sand', sandTexture());
      batch = meshes.createBatch('lab-props');
      beach = meshes.createModel({
        name: 'lab-beach',
        lods: [beachMesh(900, 180, beachHeight)],
        materials: [{ name: 'sand', shading: 'terrain', baseColor: [1, 1, 1], metallic: 0, roughness: 0.85, textures: { baseColor: 'lab-ocean-sand' }, uvScale: [1, 1] }],
      });
      capsule = meshes.createModel({
        name: 'lab-capsule',
        lods: [capsuleMesh()],
        materials: [{ name: 'hull', shading: 'standard', baseColor: [0.62, 0.62, 0.6], metallic: 0, roughness: 0.45 }],
      });
      ball = meshes.createModel({ name: 'lab-ball', lods: [sphereMesh(0.8, 48, 24)], materials: [{ name: 'yellow', shading: 'standard', baseColor: [0.75, 0.55, 0.05], metallic: 0, roughness: 0.4 }] });
      marker = meshes.createModel({ name: 'lab-marker', lods: [sphereMesh(0.1, 24, 12)], materials: [{ name: 'orange', shading: 'standard', baseColor: [0.9, 0.22, 0.03], metallic: 0, roughness: 0.35 }] });
      // Imagery-like deep-ocean colour, as the sheet would carry it.
      stray = meshes.createModel({ name: 'lab-stray-water', lods: [annulusMesh(200, 4000, 48, 256)], materials: [{ name: 'stray-sheet', shading: 'water', baseColor: [0.02, 0.05, 0.09], metallic: 0, roughness: 0.02 }] });
    },
    prepare(frame: FrameContext) {
      batch.begin(frame);
      const site = world.site;
      const body = frame.bodyPose(site.bodyId);
      const def = defs.bodies[site.bodyId]!;
      const sitePose = enuPose(site, body, def.radius);
      if (props.beach) batch.add(beach, instanceInFrame(sitePose, { x: 0, y: 250, z: 0 }, null, { bodyFixed: true }));
      if (props.strayWater) batch.add(stray, instanceInFrame(sitePose, { x: 0, y: 0, z: -150 }, null, { bodyFixed: true }));
      if (props.submerged) {
        const d = offsetDir(site, props.submergedAt.east, props.submergedAt.north, def.radius);
        batch.add(ball, instanceInFrame(bodyPoseParent(body), v3.scale(d, def.radius - props.submergedAt.depth), null, { bodyFixed: true }));
      }
      props.lastMarkerDirs = [];
      for (const m of props.markers) {
        const d = offsetDir(site, m.east, m.north, def.radius);
        const h = waterHeight(defs, site.bodyId, d, frame.snapshot.ut);
        const ph = waterHeight(defs, site.bodyId, d, frame.prevSnapshot.ut);
        const parent = bodyPoseParent(body);
        const inst = instanceInFrame(parent, v3.scale(d, def.radius + h), null, { bodyFixed: false });
        inst.prevOriginRelCam = v3.add(body.prevCenterRelCam, quat.rotate(body.prevQFixedToRoot, v3.scale(d, def.radius + ph)));
        batch.add(marker, inst);
        props.lastMarkerDirs.push(d);
      }
      const v = world.floating ? frame.vesselPose(frame.snapshot.activeVesselId) : undefined;
      if (v) batch.add(capsule, instanceInFrame(v, { x: 0, y: 0, z: 0 }, null, { bodyFixed: false }));
      batch.finish();
    },
    drawGBuffer(_frame, pass) {
      batch.drawGBuffer(pass);
    },
    drawShadow(_frame, pass, cascade) {
      batch.drawShadow(pass, cascade);
    },
    isIdle: () => coreOf(ctx).meshes.isIdle(),
  };
  return props;
}

const bodyPoseParent = (b: FrameContext['bodies'][number]): ParentPose => ({ originRelCam: b.centerRelCam, q: b.qFixedToRoot, prevOriginRelCam: b.prevCenterRelCam, prevQ: b.prevQFixedToRoot });

/** Site ENU frame (+X east, +Y north, +Z up) at sea level as a parent pose. */
function enuPose(site: LabSite, body: FrameContext['bodies'][number], radius: number): ParentPose {
  const dir = siteDir(site);
  const { east, north, up } = enuAt(quat.identity(), dir);
  const qEnu: Quat = quat.fromBasis(east, north, up);
  const pos = v3.scale(dir, radius);
  return {
    originRelCam: v3.add(body.centerRelCam, quat.rotate(body.qFixedToRoot, pos)),
    q: quat.mul(body.qFixedToRoot, qEnu),
    prevOriginRelCam: v3.add(body.prevCenterRelCam, quat.rotate(body.prevQFixedToRoot, pos)),
    prevQ: quat.mul(body.prevQFixedToRoot, qEnu),
  };
}
