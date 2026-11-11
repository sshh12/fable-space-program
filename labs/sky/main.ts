/**
 * Sky-lighting lab. One page, configured by query string (plus every camera / renderer parameter of
 * createLabApp: scene=, orbit=, body=, fov=, ev=, perf=features, scale=, governor=off, deterministic=1 ...):
 *
 *   sky=0               no sky feature (A/B against the core alone)
 *   parts=-a,-b         switch sky components off: stars, milkyWay, sun, impostors, probe, flare
 *   probeAlbedo=mean    the probe uses BodyDef.render.meanColor (for the CPU reference)
 *   planet=0            no LabPlanet backdrop;  maps=tileset (default) | none | lambert
 *                       (lambert: a uniform map whose Lambert-sphere geometric albedo is the body's geometricAlbedo)
 *   spheres=1           PBR sphere set at the active vessel (white, grey, black, chrome, gold, copper)
 *   clouds=1            lab stand-in for the cloud renderer: publish the cloud coverage map of the first body with
 *                       clouds, switch on the far cloud term, and draw the layer as a thin translucent shell with
 *                       the probe's cloud model
 *   cloudUnder=1        (with clouds=1) turn the cloud layer about the body's axis so that the cloudiest stretch of
 *                       the active vessel's latitude lies under it (the vessel over a cloud field)
 *   valt=<m>            move the active vessel to this altitude above its body
 *   ground=<m>          (with valt) ground elevation under the vessel relative to the datum: the read-outs' radar
 *                       altitude follows, and a ground cap (regolith, or terrain on a body with an atmosphere) is
 *                       drawn there around the vessel (a landing site below the datum: the LabPlanet sphere is
 *                       above the camera then and not drawn)
 *   mwSize=<n>          largest Milky Way face size in VRAM (SkyFeatureOptions.milkyWayFaceSize; default 1024)
 *   mwDetail=0          no luminance detail layer (SkyFeatureOptions.milkyWayDetail; default on)
 *   night=1             the star behind the vessel's body (vessel in its shadow)
 *   heavy=<n>           GPU ballast iterations (perf specs keep the GPU busy, RENDER_API section 14)
 *   hud=0               no text overlay
 *
 * Specs drive the rest through window.__sky (this page) and window.__lab (the lab app).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { FrameContext, MeshData, RenderContext, RenderFeature } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { TileManifest } from '@/core/contracts/terrain';
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { DEG, mat4, quat, v3, type Vec3 } from '@/core/math';
import { coreOf, createSolidTexture, instanceInFrame, mipCount, sphereMesh, type ManagedTarget, type MeshBatch, type ModelHandle, type Tracked } from '@/render/core';
import { createLabApp, createLabPlanetFeature, lookRotation, type LabApp } from '@/render/core/lab';
import {
  bruteForceIrradiance,
  clipOfDirection,
  createSkyFeature,
  flareRadiance,
  ndcDirection,
  projectSh,
  raDecToDir,
  referenceRadiance,
  shIrradiance,
  starImageRadius,
  starPsf,
  type FlareGeometry,
  type ReferenceScene,
  type SkyFeature,
  type SkyParts,
} from '@/render/sky';
import { withOverrides, type WorldOverrides } from './world';

export interface SkyLab {
  app: LabApp;
  sky: SkyFeature | null;
  defs: DefLibrary;
  /** Pin the star along a ROOT direction (from the root body), or release it. */
  setSunDirection(dir: Vec3 | null): void;
  /**
   * Put the star behind the active vessel's body (the vessel in its shadow), or at `elevationDeg` above its horizon
   * and `azimuthDeg` clockwise from north (or from the camera's horizontal view direction with fromCamera).
   */
  setSunForVessel(mode: 'night' | { elevationDeg: number; azimuthDeg: number; fromCamera?: boolean } | null): void;
  /**
   * Move a body (not the star, not the vessel's own body) so that it stands at `elevationDeg` above the active vessel's
   * horizon and `azimuthDeg` clockwise from north (or from the camera's horizontal view direction), at its own
   * distance from the vessel's body; null puts it back where the sim has it. (The Moon risen or set for a low orbit.)
   */
  setBodyForVessel(bodyId: string, place: { elevationDeg: number; azimuthDeg: number; fromCamera?: boolean } | null): void;
  /** Active vessel `h` m above its body's datum (null = the sim's position), over ground at `groundAltitude` m (default 0 = the datum). */
  setVesselAltitude(h: number | null, groundAltitude?: number): void;
  /** Camera at `position` (ROOT, default the ROOT origin) looking at RA / Dec (deg), north up. */
  lookAtRaDec(raDeg: number, decDeg: number, fovDeg?: number, position?: Vec3, rollDeg?: number): void;
  lookFrom(position: Vec3, forward: Vec3, up?: Vec3, fovDeg?: number): void;
  /** Continuous render-target pixel coordinates (unjittered) of a direction, or null behind the camera. */
  projectDir(dir: Vec3): { x: number; y: number } | null;
  /** Publish an opaque synthetic cloud layer 1 km in front of everything ('clouds.screen' a = 0, 'clouds.depth'). */
  setCloudCover(on: boolean): void;
  setHeavy(n: number): void;
  /** CPU description of the probe scene of the last frame (airless, cloudless; mean colours) for brute-force checks. */
  referenceScene(): ReferenceScene | null;
  /** Flare geometry of the last frame (unjittered camera, sun), the input of cpu.flareRadiance. */
  flareGeometry(): FlareGeometry | null;
  /** CPU reference functions of src/render/sky (brute-force irradiance, SH projection, flare model). */
  cpu: {
    referenceRadiance: typeof referenceRadiance;
    projectSh: typeof projectSh;
    bruteForceIrradiance: typeof bruteForceIrradiance;
    shIrradiance: typeof shIrradiance;
    flareRadiance: typeof flareRadiance;
    ndcDirection: typeof ndcDirection;
    starImageRadius: typeof starImageRadius;
    starPsf: typeof starPsf;
  };
}

declare global {
  interface Window {
    __sky?: SkyLab;
  }
}

const query = new URLSearchParams(location.search);
const scene = (query.get('scene') as FakeScene | null) ?? 'lowOrbit';
const overrides: WorldOverrides = { sunDir: null, vesselAltitude: query.has('valt') ? Number(query.get('valt')) : null, groundAltitude: Number(query.get('ground') ?? 0) };
let heavyIterations = Number(query.get('heavy') ?? 0);

function skyParts(): Partial<SkyParts> {
  const out: Partial<SkyParts> = {};
  for (const p of (query.get('parts') ?? '').split(',').filter(Boolean)) {
    const off = p.startsWith('-');
    out[p.replace(/^[-+]/, '') as keyof SkyParts] = !off;
  }
  return out;
}

/** Uniform sRGB map whose Lambert-sphere geometric albedo (2/3 of the Lambert albedo) is the body's geometricAlbedo. */
function lambertMap(defs: DefLibrary, bodyId: string): { width: number; height: number; data: Uint8Array<ArrayBuffer> } {
  const r = defs.bodies[bodyId]!.render;
  const l = 0.2126 * r.meanColor[0] + 0.7152 * r.meanColor[1] + 0.0722 * r.meanColor[2];
  const k = (1.5 * r.geometricAlbedo) / l;
  const enc = (x: number): number => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  const px = [...r.meanColor.map((c) => enc(Math.min(1, c * k))), 255];
  return { width: 2, height: 1, data: new Uint8Array([...px, ...px]) };
}

/**
 * PBR sphere set 6 m in front of the camera, in a row along its right axis (the lab camera orbits the active
 * vessel, so the spheres sit at the probe position to within metres), drawn through the core mesh system.
 */
function createSpheresFeature(): RenderFeature {
  let batch: MeshBatch;
  const models: ModelHandle[] = [];
  const mats = [
    { name: 'white', shading: 'standard' as const, baseColor: [0.8, 0.8, 0.8] as [number, number, number], metallic: 0, roughness: 0.6 },
    { name: 'grey', shading: 'standard' as const, baseColor: [0.18, 0.18, 0.18] as [number, number, number], metallic: 0, roughness: 0.5 },
    { name: 'black', shading: 'standard' as const, baseColor: [0.03, 0.03, 0.03] as [number, number, number], metallic: 0, roughness: 0.15 },
    { name: 'chrome', shading: 'standard' as const, baseColor: [0.95, 0.94, 0.92] as [number, number, number], metallic: 1, roughness: 0.04 },
    { name: 'gold', shading: 'standard' as const, baseColor: [1.0, 0.77, 0.34] as [number, number, number], metallic: 1, roughness: 0.3 },
    { name: 'copper', shading: 'standard' as const, baseColor: [0.95, 0.64, 0.54] as [number, number, number], metallic: 1, roughness: 0.6 },
  ];
  return {
    id: 'sky-lab-spheres',
    init(c) {
      const meshes = coreOf(c).meshes;
      batch = meshes.createBatch('sky-lab-spheres');
      for (const m of mats) models.push(meshes.createModel({ name: `sphere-${m.name}`, lods: [sphereMesh(0.5, 64, 32)], materials: [m] }));
    },
    prepare(frame) {
      batch.begin(frame);
      // Fixed relative to the camera: no screen motion, origin and previous origin equal.
      const fwd = { x: -frame.view[2]!, y: -frame.view[6]!, z: -frame.view[10]! };
      const right = { x: frame.view[0]!, y: frame.view[4]!, z: frame.view[8]! };
      models.forEach((m, i) => {
        const o = v3.add(v3.scale(fwd, 6), v3.scale(right, (i - 2.5) * Number(query.get('spacing') ?? 1.6)));
        batch.add(m, instanceInFrame({ originRelCam: o, q: quat.identity(), prevOriginRelCam: o, prevQ: quat.identity() }, { x: 0, y: 0, z: 0 }, null, { bodyFixed: false }));
      });
      batch.finish();
    },
    drawGBuffer(_f, pass) {
      batch.drawGBuffer(pass);
    },
    drawShadow(_f, pass, cascade) {
      batch.drawShadow(pass, cascade);
    },
  };
}

/** Angular extent of the lab ground cap (rad): 35 km of the Moon, 127 km of the Earth around the vessel. */
const GROUND_CAP_ANGLE = 0.02;

/**
 * Spherical cap of the UNIT sphere around +Z out to GROUND_CAP_ANGLE, origin at its centre on the surface
 * (scaled to the ground radius per instance: float32 positions stay at millimetres). Rings are spaced
 * geometrically from 1e-7 rad, so the ground under the camera is finely tessellated.
 */
function groundCapMesh(rings = 80, segments = 128): MeshData {
  const alphas = [0];
  const a0 = 1e-7;
  for (let j = 0; j < rings; j++) alphas.push(a0 * (GROUND_CAP_ANGLE / a0) ** (j / (rings - 1)));
  const w = segments + 1;
  const n = alphas.length * w;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const tangents = new Float32Array(n * 4);
  const uvs = new Float32Array(n * 2);
  alphas.forEach((a, j) => {
    for (let i = 0; i <= segments; i++) {
      const ph = (i / segments) * 2 * Math.PI;
      const k = j * w + i;
      const nx = Math.sin(a) * Math.cos(ph);
      const ny = Math.sin(a) * Math.sin(ph);
      positions.set([nx, ny, -2 * Math.sin(a / 2) ** 2], k * 3);
      normals.set([nx, ny, Math.cos(a)], k * 3);
      tangents.set([-Math.sin(ph), Math.cos(ph), 0, 1], k * 4);
      uvs.set([i / segments, j / rings], k * 2);
    }
  });
  // The winding of sphereMesh (outward faces front): the centre ring is degenerate, as a sphere's pole.
  const idx: number[] = [];
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * w + i;
      const c = a + w;
      if (j > 0) idx.push(a, c, a + 1);
      idx.push(a + 1, c, c + 1);
    }
  }
  const s = Math.sin(GROUND_CAP_ANGLE);
  return {
    positions,
    normals,
    tangents,
    uvs,
    indices: new Uint32Array(idx),
    groups: [{ material: 0, start: 0, count: idx.length }],
    bounds: { min: [-s, -s, -2 * Math.sin(GROUND_CAP_ANGLE / 2) ** 2], max: [s, s, 0] },
  };
}

/** The albedoLowRes map of every body with a baked tile set, as pixels (sRGB, equirectangular, row 0 = north, column 0 = 180 W). */
async function loadAlbedoPixels(defs: DefLibrary, tilesUrl: string): Promise<Map<string, ImageData>> {
  const out = new Map<string, ImageData>();
  const index = await fetch(`${tilesUrl}/index.json`, { cache: 'no-cache' });
  if (!index.ok) return out;
  const baked = ((await index.json()) as { tilesets: string[] }).tilesets;
  for (const def of Object.values(defs.bodies)) {
    if (def.emission || !def.terrain || !baked.includes(def.terrain.tileset)) continue;
    const base = `${tilesUrl}/${def.terrain.tileset}`;
    const g = ((await (await fetch(`${base}/manifest.json`)).json()) as TileManifest).globals?.albedoLowRes;
    if (!g) continue;
    const bitmap = await createImageBitmap(await (await fetch(`${base}/${g.path}`)).blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const c2d = canvas.getContext('2d')!;
    c2d.drawImage(bitmap, 0, 0);
    out.set(def.id, c2d.getImageData(0, 0, bitmap.width, bitmap.height));
  }
  return out;
}

/** Linear albedo of a map around the body-fixed unit direction `up`: the mean of 5 x 5 texels (a few km of ground). */
function albedoAt(map: ImageData, up: Vec3): [number, number, number] {
  const lin = (v: number): number => (v <= 0.04045 * 255 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const cx = Math.floor((Math.atan2(up.y, up.x) / (2 * Math.PI) + 0.5) * map.width);
  const cy = Math.floor((0.5 - Math.asin(Math.max(-1, Math.min(1, up.z))) / Math.PI) * map.height);
  const sum = [0, 0, 0];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = (cx + dx + map.width) % map.width;
      const y = Math.max(0, Math.min(map.height - 1, cy + dy));
      for (let c = 0; c < 3; c++) sum[c] = sum[c]! + lin(map.data[(y * map.width + x) * 4 + c]!);
    }
  }
  return [sum[0]! / 25, sum[1]! / 25, sum[2]! / 25];
}

/**
 * Ground under the active vessel at `overrides.groundAltitude` (with valt): a spherical cap of the body at that
 * elevation, body-fixed, regolith on an airless body (terrain on one with an atmosphere), with the albedo the
 * tile set's albedoLowRes map has at the site (what the terrain renderer shows there and what the probe uses;
 * the body's mean colour without a baked map). Lab only: stands for the terrain renderer at a landing site
 * below the datum.
 */
function createGroundCapFeature(defs: DefLibrary, albedo: Map<string, ImageData>): RenderFeature {
  let batch: MeshBatch;
  let meshes: ReturnType<typeof coreOf>['meshes'];
  let mesh: MeshData;
  const models = new Map<string, ModelHandle>();
  return {
    id: 'sky-lab-ground',
    init(c) {
      meshes = coreOf(c).meshes;
      batch = meshes.createBatch('sky-lab-ground');
      mesh = groundCapMesh();
    },
    prepare(frame) {
      batch.begin(frame);
      const s = frame.snapshot;
      const v = s.vessels.find((x) => x.id === s.activeVesselId);
      const pose = v && frame.bodies.find((b) => b.id === v.bodyId);
      const body = v && s.bodies.find((b) => b.id === v.bodyId);
      if (v && pose && body && overrides.vesselAltitude !== null) {
        const up = v3.normalize(quat.rotateInv(body.qFixedToRoot, v3.sub(v.rRoot, body.rRoot)));
        let model = models.get(v.bodyId);
        if (!model) {
          // Created at the first frame with a vessel: the cap takes the map's albedo at the place it stands for.
          const def = defs.bodies[v.bodyId]!;
          const map = albedo.get(v.bodyId);
          const shading = def.render.atmosphere ? ('terrain' as const) : ('regolith' as const);
          model = meshes.createModel({ name: `ground-${def.id}`, lods: [mesh], materials: [{ name: `ground-${def.id}`, shading, baseColor: map ? albedoAt(map, up) : [...def.render.meanColor], metallic: 0, roughness: 1 }] });
          models.set(v.bodyId, model);
        }
        const rg = defs.bodies[v.bodyId]!.radius + overrides.groundAltitude;
        const parent = { originRelCam: pose.centerRelCam, q: pose.qFixedToRoot, prevOriginRelCam: pose.prevCenterRelCam, prevQ: pose.prevQFixedToRoot };
        batch.add(model, instanceInFrame(parent, v3.scale(up, rg), quat.fromTo({ x: 0, y: 0, z: 1 }, up), { scale: rg, bodyFixed: true, castShadow: false }));
      }
      batch.finish();
    },
    drawGBuffer(_f, pass) {
      batch.drawGBuffer(pass);
    },
  };
}

/** GPU ballast: a fullscreen burn in the compute hook (perf specs measure with the GPU as busy as a game frame). */
function createHeavyFeature(): RenderFeature {
  let ctx: RenderContext;
  let pipeline: Tracked<GPURenderPipeline>;
  let target: ManagedTarget;
  let uniform: GPUBuffer;
  let group: GPUBindGroup;
  return {
    id: 'sky-lab-heavy',
    // Encoded after the sky's probe in the compute hook: the tail of a long pass is charged to the next one.
    order: 1000,
    init(c) {
      ctx = c;
      const core = coreOf(c);
      target = core.createTarget('sky-lab-heavy.scratch', 'rgba16float', 1);
      uniform = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const layout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      group = c.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
      pipeline = core.fullscreenPipeline({
        label: 'sky-lab-heavy.burn',
        layouts: [layout],
        fragment: /* wgsl */ `struct HeavyU { v: vec4f }
          @group(1) @binding(0) var<uniform> heavy: HeavyU;
          @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
            var a = vec3f(in.uv, 0.5);
            for (var i = 0; i < i32(heavy.v.x); i++) { a = fract(sin(a.yzx * 12.9898 + a.zxy * 78.233 + f32(i)) * 43758.5453); }
            return vec4f(a, 1.0);
          }`,
        targets: [{ format: 'rgba16float' }],
      });
      pipeline.get();
    },
    prepare() {
      ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([heavyIterations, 0, 0, 0]));
    },
    compute(frame, encoder) {
      if (heavyIterations <= 0) return;
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('sky-lab-heavy.burn') as GPURenderPassTimestampWrites | undefined });
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setPipeline(pipeline.get());
      pass.setBindGroup(1, group);
      pass.draw(3);
      pass.end();
      // The tail of the burn is charged to this empty pass, not to whatever is encoded next.
      encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('sky-lab-heavy.tail') as GPURenderPassTimestampWrites | undefined }).end();
    },
  };
}

/** Vertical optical depth of the lab's cloud layer at full coverage (a lab value: thick stratocumulus). */
const LAB_CLOUD_TAU = 20;

/**
 * What the stand-in cloud shell puts on the screen this frame, estimated on a 16 x 9 grid of view rays with the
 * shell's own model (CPU): the fraction of the frame its sunlit part covers and the mean luminance there (cd/m^2).
 */
function cloudDeckOnScreen(frame: FrameContext, world: CloudWorld, bodyIndex: number, layerRadius: number, longitudeOffset: number): { luminance: number; coverage: number } {
  const pose = frame.bodies[bodyIndex]!;
  const c = pose.centerRelCam;
  const tanY = Math.tan(frame.camera.fovY / 2);
  const tanX = (tanY * frame.renderSize[0]) / frame.renderSize[1];
  const right = { x: frame.view[0]!, y: frame.view[4]!, z: frame.view[8]! };
  const up = { x: frame.view[1]!, y: frame.view[5]!, z: frame.view[9]! };
  const fwd = { x: -frame.view[2]!, y: -frame.view[6]!, z: -frame.view[10]! };
  const outside = v3.len(c) > layerRadius;
  const map = world.pixels;
  let covered = 0;
  let light = 0;
  const nx = 16;
  const ny = 9;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (((i + 0.5) / nx) * 2 - 1) * tanX;
      const y = (1 - ((j + 0.5) / ny) * 2) * tanY;
      const d = v3.normalize(v3.add(fwd, v3.add(v3.scale(right, x), v3.scale(up, y))));
      const b = v3.dot(d, c);
      const det = b * b - v3.lenSq(c) + layerRadius * layerRadius;
      if (det < 0) continue;
      const t = outside ? b - Math.sqrt(det) : b + Math.sqrt(det);
      if (t <= 0) continue;
      const n = v3.normalize(v3.sub(v3.scale(d, t), c));
      const muS = v3.dot(n, pose.sunDir);
      if (muS <= 0) continue;
      const nf = quat.rotateInv(pose.qFixedToRoot, n);
      const u = (((Math.atan2(nf.y, nf.x) + longitudeOffset) / (2 * Math.PI) + 0.5) % 1 + 1) % 1;
      const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, nf.z))) / Math.PI;
      const tau = (map.data[(Math.min(map.height - 1, Math.floor(v * map.height)) * map.width + Math.min(map.width - 1, Math.floor(u * map.width))) * 4]! / 255) * LAB_CLOUD_TAU;
      const alpha = 1 - Math.exp(-tau / Math.max(Math.abs(v3.dot(d, n)), 0.02));
      covered += alpha;
      light += (alpha * frame.sun.illuminance * muS * ((0.15 * tau) / (2 + 0.15 * tau))) / Math.PI;
    }
  }
  return covered > 0 ? { luminance: light / covered, coverage: covered / (nx * ny) } : { luminance: 0, coverage: 0 };
}

interface CloudWorld {
  bodyId: string;
  /** The tile set's cloud coverage map (r = coverage) as decoded, for 'clouds.coverageMap'. */
  coverage: ImageBitmap;
  /** Its pixels (r = coverage), for placing the layer under the vessel. */
  pixels: ImageData;
}

/**
 * Longitude offset (rad) of the cloud layer that puts the cloudiest 12 deg x 12 deg stretch of the latitude band
 * of the body-fixed direction `up` under it (equirectUv of PROBE_FACE_CS: u = (lon + offset) / 2 pi + 0.5).
 */
function cloudOffsetUnder(map: ImageData, up: Vec3): number {
  const row = Math.floor((0.5 - Math.asin(Math.max(-1, Math.min(1, up.z))) / Math.PI) * map.height);
  const half = Math.round((6 / 360) * map.width);
  const band: number[] = [];
  for (let x = 0; x < map.width; x++) {
    let s = 0;
    for (let dy = -half; dy <= half; dy += 4) s += map.data[(Math.max(0, Math.min(map.height - 1, row + dy)) * map.width + x) * 4]!;
    band.push(s);
  }
  let best = 0;
  let bestSum = -1;
  let run = 0;
  for (let x = -half; x <= half; x++) run += band[(x + map.width) % map.width]!;
  for (let x = 0; x < map.width; x++) {
    if (run > bestSum) {
      bestSum = run;
      best = x;
    }
    run += band[(x + half + 1) % map.width]! - band[(x - half + map.width) % map.width]!;
  }
  const lon = Math.atan2(up.y, up.x);
  return ((best + 0.5) / map.width - 0.5) * 2 * Math.PI - lon;
}

async function loadCloudWorld(defs: DefLibrary, tilesUrl: string): Promise<CloudWorld | null> {
  const def = Object.values(defs.bodies).find((b) => b.render.clouds && b.terrain);
  if (!def) return null;
  const base = `${tilesUrl}/${def.terrain!.tileset}`;
  const manifest = (await (await fetch(`${base}/manifest.json`)).json()) as TileManifest;
  const path = manifest.globals[def.render.clouds!.coverageMap]!.path;
  const coverage = await createImageBitmap(await (await fetch(`${base}/${path}`)).blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(coverage.width, coverage.height);
  const c2d = canvas.getContext('2d')!;
  c2d.drawImage(coverage, 0, 0);
  return { bodyId: def.id, coverage, pixels: c2d.getImageData(0, 0, coverage.width, coverage.height) };
}

/**
 * Lab stand-in for the cloud renderer (not a cloud renderer): publishes the coverage map and the far cloud term
 * (the probe and the render core's cloud shadow read them), and draws the layer as a thin shell at its mid
 * height in the transparent stage with the probe's cloud model: radiance R(tau) E_sun mu_s / pi (two-stream
 * conservative reflectance, Lambertian top), the ground behind attenuated by exp(-tau / mu_view).
 */
function createCloudLayerFeature(world: CloudWorld): RenderFeature {
  let ctx: RenderContext;
  let coverageView: GPUTextureView;
  let pipeline: Tracked<GPURenderPipeline>;
  let layout: GPUBindGroupLayout;
  let group: GPUBindGroup | null = null;
  let groupVersion = -1;
  let bindings: ReturnType<ReturnType<typeof coreOf>['createSceneBindings']>;
  let uniform: GPUBuffer;
  let bodyIndex = -1;
  let longitudeOffset: number | null = query.get('cloudUnder') === '1' ? null : 0;
  return {
    id: 'sky-lab-clouds',
    init(c) {
      ctx = c;
      const core = coreOf(c);
      const bmp = world.coverage;
      const tex = core.createTextureChecked({
        label: 'sky-lab.coverage',
        format: 'rgba8unorm',
        size: [bmp.width, bmp.height],
        mipLevelCount: mipCount(bmp.width, bmp.height),
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      c.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [bmp.width, bmp.height]);
      core.mips.generate(tex);
      coverageView = tex.createView();
      c.resources.publish('clouds.coverageMap', coverageView);
      bindings = core.createSceneBindings(1, 0, ['transparency', 'sceneDepth']);
      uniform = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      layout = c.device.createBindGroupLayout({
        entries: [
          ...bindings.layoutEntries,
          { binding: bindings.nextBinding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: bindings.nextBinding + 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ],
      });
      pipeline = core.fullscreenPipeline({
        label: 'sky-lab-clouds.layer',
        layouts: [layout],
        fragment: /* wgsl */ `
          #include "transparency"
          #include "eclipse"
          ${bindings.wgsl}
          @group(1) @binding(${bindings.nextBinding}) var coverageTex: texture_2d<f32>;
          struct LabClouds { v: vec4f }   // x = frame body index
          @group(1) @binding(${bindings.nextBinding + 1}) var<uniform> lab: LabClouds;
          @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
            let bi = u32(lab.v.x);
            let b = frame.bodies[bi];
            let d = normalize(viewRay(in.uv));
            let c = b.center.xyz;
            let rr = frame.cloudFar.y;
            let bq = dot(d, c);
            let det = bq * bq - dot(c, c) + rr * rr;
            if (det < 0.0) { discard; }
            let s = sqrt(det);
            // From outside the shell: the near side; from below it: the exit point.
            let t = select(bq + s, bq - s, length(c) > rr);
            if (t <= 0.0) { discard; }
            let depth = textureLoad(sceneDepthTex, vec2i(in.position.xy), 0);
            if (depth > 0.0 && length(positionFromDepth(in.uv, depth)) < t) { discard; }
            let p = d * t;
            let n = normalize(p - c);
            let nf = rootToFixed(bi, n);
            let uv = vec2f(fract((atan2(nf.y, nf.x) + frame.cloudFar.w) / TWO_PI + 0.5), 0.5 - asin(clamp(nf.z, -1.0, 1.0)) / PI);
            let tau = textureSampleLevel(coverageTex, linearRepeat, uv, 0.0).r * frame.cloudFar.z;
            let g = 0.85;
            let refl = (1.0 - g) * tau / (2.0 + (1.0 - g) * tau);
            let sunDir = b.sunDir.xyz;
            let muS = dot(n, sunDir);
            var L = vec3f(0.0);
            if (muS > 0.0) { L = frame.sunIlluminance.rgb * muS * sunVisibility(p, sunDir) * refl / PI; }
            let alpha = 1.0 - exp(-tau / max(abs(dot(d, n)), 0.02));
            let o = applyAtmosphere(in.uv, t, L * frame.exposure.x, alpha);
            return vec4f(writeHdr(o.rgb), o.a);
          }`,
        targets: [{ format: 'rgba16float', blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }],
        depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' },
      });
      pipeline.get();
    },
    prepare(frame) {
      bodyIndex = frame.bodies.findIndex((b) => b.id === world.bodyId);
      if (bodyIndex >= 4) bodyIndex = -1;
      const def = ctx.defs.bodies[world.bodyId]!;
      const cl = def.render.clouds!;
      if (longitudeOffset === null) {
        // Once, at the first frame with a vessel: the layer is turned so that a cloud field lies under it.
        const s = frame.snapshot;
        const v = s.vessels.find((x) => x.id === s.activeVesselId);
        const body = s.bodies.find((b) => b.id === world.bodyId);
        if (v && body) longitudeOffset = cloudOffsetUnder(world.pixels, v3.normalize(quat.rotateInv(body.qFixedToRoot, v3.sub(v.rRoot, body.rRoot))));
      }
      const layerRadius = def.radius + 0.5 * (cl.bottomAltitude + cl.topAltitude);
      coreOf(ctx).setCloudShadowParams({ far: bodyIndex >= 0 ? { bodyIndex, layerRadius, opticalDepth: LAB_CLOUD_TAU, longitudeOffset: longitudeOffset ?? 0 } : null });
      if (bodyIndex >= 0) {
        // The exposure meter's histogram is taken before the transparent pass, where this stand-in draws its shell:
        // it tells the meter what a cloud renderer's deck would have put there (a sunlit cloud deck sets the
        // exposure of a daylight orbit).
        const deck = cloudDeckOnScreen(frame, world, bodyIndex, layerRadius, longitudeOffset ?? 0);
        if (deck.coverage > 0) coreOf(ctx).addEmissiveHint(deck.luminance, deck.coverage);
      }
      ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([bodyIndex, 0, 0, 0]));
    },
    drawTransparent(_frame, pass) {
      if (bodyIndex < 0) return;
      const v = bindings.version();
      if (!group || v !== groupVersion) {
        groupVersion = v;
        group = ctx.device.createBindGroup({
          layout,
          entries: [...bindings.entries(), { binding: bindings.nextBinding, resource: coverageView }, { binding: bindings.nextBinding + 1, resource: { buffer: uniform } }],
        });
      }
      pass.setPipeline(pipeline.get());
      pass.setBindGroup(1, group);
      pass.draw(3);
    },
  };
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const info = document.getElementById('info') as HTMLDivElement;
  let sky: SkyFeature | null = null;
  let cloudDefaults: { screen: GPUTextureView; depth: GPUTextureView } | null = null;
  const defs = await loadDefs(fetchDefSource());
  const clouds = query.get('clouds') === '1' ? await loadCloudWorld(defs, '/tiles') : null;
  const groundAlbedo = query.has('ground') && query.get('probeAlbedo') !== 'mean' ? await loadAlbedoPixels(defs, '/tiles') : new Map<string, ImageData>();
  const app = await createLabApp({
    canvas,
    name: 'sky',
    scene,
    defs,
    autoReady: false,
    sim: (d) => withOverrides(createFakeSim(d, { scene }), overrides),
    features: (d) => {
      const list: RenderFeature[] = [];
      if (query.get('planet') !== '0') {
        const mode = query.get('maps') ?? 'tileset';
        const maps: NonNullable<Parameters<typeof createLabPlanetFeature>[0]>['maps'] = {};
        for (const b of Object.values(d.bodies)) {
          if (b.emission) continue;
          if (mode === 'none') maps[b.id] = 'none';
          else if (mode === 'lambert') maps[b.id] = lambertMap(d, b.id);
        }
        list.push(createLabPlanetFeature({ maps }));
      }
      if (query.get('spheres') === '1') list.push(createSpheresFeature());
      if (query.has('ground')) list.push(createGroundCapFeature(d, groundAlbedo));
      if (clouds) list.push(createCloudLayerFeature(clouds));
      if (query.has('heavy')) list.push(createHeavyFeature());
      if (query.get('sky') !== '0') {
        sky = createSkyFeature({
          ...skyParts(),
          probeAlbedo: query.get('probeAlbedo') === 'mean' ? 'meanColor' : 'tileset',
          ...(query.has('mwSize') ? { milkyWayFaceSize: Number(query.get('mwSize')) } : {}),
          ...(query.get('mwDetail') === '0' ? { milkyWayDetail: false } : {}),
        });
        list.push(sky);
      }
      return list;
    },
  });
  if (query.get('night') === '1') setSunForVessel('night');

  /** Direction (ROOT) at `elevationDeg` / `azimuthDeg` in the active vessel's horizon frame ('night' = its nadir). */
  function vesselSkyDir(s: SimSnapshot, mode: 'night' | { elevationDeg: number; azimuthDeg: number; fromCamera?: boolean }): Vec3 | null {
    const v = s.vessels.find((x) => x.id === s.activeVesselId);
    if (!v) return null;
    const body = s.bodies.find((b) => b.id === v.bodyId)!;
    const up = v3.normalize(v3.sub(v.rRoot, body.rRoot));
    if (mode === 'night') return v3.neg(up);
    // Azimuth from north, or (fromCamera) from the camera's horizontal view direction, clockwise seen from above.
    const ref = mode.fromCamera ? quat.rotate(app.cameraState().qViewToRoot, { x: 0, y: 0, z: -1 }) : { x: 0, y: 0, z: 1 };
    const north0 = v3.reject(ref, up);
    const north = v3.lenSq(north0) > 1e-12 ? v3.normalize(north0) : v3.normalize(v3.anyOrthogonal(up));
    const east = v3.cross(north, up);
    const az = mode.azimuthDeg * DEG;
    const el = mode.elevationDeg * DEG;
    return v3.normalize(v3.add(v3.scale(v3.add(v3.scale(north, Math.cos(az)), v3.scale(east, Math.sin(az))), Math.cos(el)), v3.scale(up, Math.sin(el))));
  }

  function setSunForVessel(mode: 'night' | { elevationDeg: number; azimuthDeg: number; fromCamera?: boolean } | null): void {
    overrides.sunDir = mode ? (s) => vesselSkyDir(s, mode) : null;
  }

  function setBodyForVessel(bodyId: string, place: { elevationDeg: number; azimuthDeg: number; fromCamera?: boolean } | null): void {
    const dirs = (overrides.bodyDirs ??= {});
    if (place) dirs[bodyId] = (s) => vesselSkyDir(s, place);
    else delete dirs[bodyId];
  }

  const lab: Omit<SkyLab, 'cpu'> = {
    app,
    sky,
    defs: app.defs,
    setSunDirection(dir) {
      overrides.sunDir = dir ? () => dir : null;
    },
    setSunForVessel,
    setBodyForVessel,
    setVesselAltitude(h, groundAltitude = 0) {
      overrides.vesselAltitude = h;
      overrides.groundAltitude = groundAltitude;
    },
    lookAtRaDec(raDeg, decDeg, fovDeg, position = { x: 0, y: 0, z: 0 }, rollDeg = 0) {
      const fwd = raDecToDir(raDeg * DEG, decDeg * DEG);
      let up = v3.reject({ x: 0, y: 0, z: 1 }, fwd);
      if (v3.lenSq(up) < 1e-10) up = { x: 1, y: 0, z: 0 };
      const q0 = lookRotation(fwd, v3.normalize(up));
      app.camera.spec = { type: 'free', positionRoot: position, qViewToRoot: quat.mul(q0, quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, rollDeg * DEG)) };
      if (fovDeg) app.camera.settings.fovY = fovDeg * DEG;
    },
    lookFrom(position, forward, up = { x: 0, y: 0, z: 1 }, fovDeg) {
      app.camera.spec = { type: 'free', positionRoot: position, qViewToRoot: lookRotation(forward, up) };
      if (fovDeg) app.camera.settings.fovY = fovDeg * DEG;
    },
    projectDir(dir) {
      const f = app.renderer.frameContext;
      if (!f) return null;
      const [x, y, w] = clipOfDirection(mat4.mul(f.projUnjittered, f.view), dir);
      if (w <= 0) return null;
      return { x: (0.5 + (0.5 * x) / w) * f.renderSize[0], y: (0.5 - (0.5 * y) / w) * f.renderSize[1] };
    },
    setCloudCover(on) {
      const res = app.renderer.resources;
      if (on) {
        const device = app.renderer.context.device;
        cloudDefaults ??= {
          screen: createSolidTexture(device, 'sky-lab.cloudScreen', 'rgba16float', [0, 0, 0, 0]).createView(),
          depth: createSolidTexture(device, 'sky-lab.cloudDepth', 'r32float', [1000]).createView(),
        };
        res.publish('clouds.screen', cloudDefaults.screen);
        res.publish('clouds.depth', cloudDefaults.depth);
      } else {
        res.reset('clouds.screen');
        res.reset('clouds.depth');
      }
    },
    setHeavy(n) {
      heavyIterations = n;
    },
    referenceScene() {
      const f = app.renderer.frameContext;
      const scene = sky?.probe().scene;
      if (!f || !scene) return null;
      return {
        bodies: scene.bodies.map((b) => {
          const def = app.defs.bodies[b.id]!;
          const snap = f.snapshot.bodies.find((x) => x.id === b.id)!;
          const surface = def.render.surface;
          return { centre: b.centre, radius: b.radius, weight: b.weight, albedo: [...def.render.meanColor], sunDir: snap.sunDir, ...(surface?.brdf === 'hapke' && surface.hapke ? { hapke: surface.hapke } : {}) };
        }),
        sunE: [f.sun.color[0] * f.sun.illuminance, f.sun.color[1] * f.sun.illuminance, f.sun.color[2] * f.sun.illuminance],
        sunRadius: f.sun.angularRadius,
        background: [0, 0, 0],
      };
    },
    flareGeometry() {
      const f = app.renderer.frameContext;
      if (!f) return null;
      const tanY = Math.tan(f.camera.fovY / 2);
      const tanX = (tanY * f.renderSize[0]) / f.renderSize[1];
      const [x, y, w] = clipOfDirection(mat4.mul(f.projUnjittered, f.view), f.sun.dirRoot);
      return {
        view: { right: { x: f.view[0]!, y: f.view[4]!, z: f.view[8]! }, up: { x: f.view[1]!, y: f.view[5]!, z: f.view[9]! }, forward: { x: -f.view[2]!, y: -f.view[6]!, z: -f.view[10]! }, tanX, tanY },
        sun: f.sun.dirRoot,
        sunRadius: f.sun.angularRadius,
        sunNdc: [x / w, y / w],
      };
    },
  };
  window.__sky = { ...lab, cpu: { referenceRadiance, projectSh, bruteForceIrradiance, shIrradiance, flareRadiance, ndcDirection, starImageRadius, starPsf } };

  if (query.get('hud') !== '0') {
    setInterval(() => {
      const p = app.renderer.perfSnapshot();
      const e = app.renderer.exposureInfo();
      const st = sky?.status();
      const pr = sky?.probe();
      info.textContent =
        `sky lab   scene ${scene}   ${p.counters.renderWidth ?? 0} x ${p.counters.renderHeight ?? 0}   gpu ${p.gpu.p50.toFixed(2)} ms   EV100 ${e.ev100.toFixed(2)} (lit ${(e.litFraction * 100).toFixed(2)} %)\n` +
        `stars ${st?.starsLoaded ? 'loaded' : '-'}   milky way ${st?.milkyWayLoaded ? 'loaded' : '-'}   probe cycles ${pr?.completed ?? 0}${pr?.holding ? ' (holding)' : ''}   impostors ${sky?.impostors().length ?? 0}`;
    }, 250);
  }
  await app.testApi.api.waitFrames(3);
  app.testApi.markReady(app.testApi.api.errors.length === 0);
}

boot().catch((err: unknown) => {
  console.error(err);
  window.__test?.errors.push(`lab boot: ${err instanceof Error ? err.message : String(err)}`);
});

