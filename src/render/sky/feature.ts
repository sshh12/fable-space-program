/**
 * createSkyFeature: the sky as seen from anywhere in the system, photometrically.
 *
 *   drawBackground   Milky Way cube (rgb9e5, luminanceScale), analytic solar disc with limb darkening, catalogue
 *                    stars as Gaussian PSFs (all at depth == 0, additive, in ROOT = J2000 axes)
 *   compute          the live environment probe at the active vessel ('env.probeCube', 'env.sh9'; probe.ts)
 *   preTransparent   visible fraction of the solar disc for the flare ('scene.depth', 'clouds.screen')
 *   drawTransparent  distant bodies under 6 px as PSF impostors cross-faded over their geometry, lens flare
 *
 * Nothing here has a brightness knob: star, Milky Way, sun and impostor luminances follow from the data and
 * the frame's exposure. See docs/handoff/sky-lighting.md.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import { RENDER_FORMATS, type FrameContext, type RenderContext, type RenderFeature } from '@/core/contracts/render';
import { STAR_RECORD_FLOATS, type SkyManifest } from '@/core/contracts/sky';
import { mat4, v3, type Mat4, type Vec3, type Vec3Tuple } from '@/core/math';
import { MAX_BODIES, coreOf, createSceneBindings, discVisibleFraction, type SceneBindings, type Tracked } from '@/render/core';
import { GHOSTS, STARBURST, STARBURST_MAX_ANGLE, ghostIntegral, haloIntegral, spikeIntegral } from './flare';
import { impostorSigmaPx, impostorWeight, IMPOSTOR_NONE_PX, lambertSphereIlluminance, pixelSolidAngle, STAR_PSF_SIGMA_PX, STAR_QUAD_SIGMAS } from './photometry';
import { EnvironmentProbe, type ProbeState } from './probe';
import { BACKGROUND_FS, FLARE_VIS_CS, FLARE_WGSL, IMPOSTOR_WGSL, STARS_WGSL } from './shaders';
import { faceFileBytes, faceMipLayout, parseStarCatalogue, validateSkyManifest, type StarCatalogue } from './skyData';

export interface SkyParts {
  stars: boolean;
  milkyWay: boolean;
  sun: boolean;
  impostors: boolean;
  probe: boolean;
  flare: boolean;
}

export interface SkyFeatureOptions extends Partial<SkyParts> {
  /** Feature id (prefix of its passes and perf rows), default 'sky'. */
  id?: string;
  order?: number;
  /**
   * Albedo of bodies in the environment probe: the albedoLowRes global map of the body's tile set where one is
   * baked (default), or BodyDef.render.meanColor everywhere (labs compare the probe with a CPU reference).
   */
  probeAlbedo?: 'tileset' | 'meanColor';
}

export interface ImpostorInfo {
  bodyId: string;
  /** Projected diameter (render px), weight of the impostor against the geometry, illuminance at the camera (lux). */
  diameterPx: number;
  weight: number;
  illuminance: number;
  sigmaPx: number;
}

export interface FlareStateInfo {
  /** Visible fraction of the solar disc (depth samples), cloud transmittance at the sun, 1 when the sun centre is in view. */
  visible: number;
  cloud: number;
  inView: number;
  transmittance: Vec3Tuple;
}

export interface SkyStatus {
  manifest: SkyManifest | null;
  starsLoaded: boolean;
  milkyWayLoaded: boolean;
  error: string | null;
  /** Whether the flare was drawn in the last frame. */
  flareDrawn: boolean;
}

export interface SkyFeature extends RenderFeature {
  /** Components, all on by default (labs switch them for A/B readbacks). */
  readonly parts: SkyParts;
  status(): SkyStatus;
  stars(): StarCatalogue | null;
  impostors(): ImpostorInfo[];
  probe(): ProbeState;
  readProbeSh(): Promise<number[][]>;
  readProbeFace(face: number, mip?: number): Promise<{ size: number; data: Float32Array }>;
  readFlareState(): Promise<FlareStateInfo>;
}

const ADDITIVE: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
const PREMULTIPLIED: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
const SKY_UNIFORM_FLOATS = 20;
const MAX_IMPOSTORS = 16;
const IMPOSTOR_FLOATS = 4 + MAX_IMPOSTORS * 12;
const FLARE_TERMS = 1 + GHOSTS.length;
const FLARE_FLOATS = 8 + 8 * 16;

const luma = (c: Readonly<Vec3Tuple>): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Clip x, y, w of a direction (w = 0 in homogeneous coordinates) under a column-major matrix. */
export function clipOfDirection(m: Mat4, d: Vec3): [number, number, number] {
  return [m[0]! * d.x + m[4]! * d.y + m[8]! * d.z, m[1]! * d.x + m[5]! * d.y + m[9]! * d.z, m[3]! * d.x + m[7]! * d.y + m[11]! * d.z];
}

export function createSkyFeature(options: SkyFeatureOptions = {}): SkyFeature {
  const id = options.id ?? 'sky';
  const parts: SkyParts = {
    stars: options.stars ?? true,
    milkyWay: options.milkyWay ?? true,
    sun: options.sun ?? true,
    impostors: options.impostors ?? true,
    probe: options.probe ?? true,
    flare: options.flare ?? true,
  };
  let ctx: RenderContext;
  let defs: DefLibrary;
  let device: GPUDevice;
  const status: SkyStatus = { manifest: null, starsLoaded: false, milkyWayLoaded: false, error: null, flareDrawn: false };
  let pendingLoads = 0;
  let catalogue: StarCatalogue | null = null;

  // Background (group 1: sky uniform + Milky Way cube).
  let skyLayout: GPUBindGroupLayout;
  let skyBuf: GPUBuffer;
  const skyData = new Float32Array(SKY_UNIFORM_FLOATS);
  let skyGroup: GPUBindGroup;
  let blankCube: GPUTextureView;
  let milkyWay: GPUTextureView | null = null;
  let milkyWayTex: GPUTexture | null = null;
  let backgroundPipeline: Tracked<GPURenderPipeline>;
  let starPipeline: Tracked<GPURenderPipeline>;
  let starBuffer: GPUBuffer | null = null;

  // Transparent stage (group 1: transparency + scene depth; group 2: own data).
  let transBindings: SceneBindings;
  let transLayout: GPUBindGroupLayout;
  let transGroup: GPUBindGroup | null = null;
  let transVersion = -1;
  let impostorLayout: GPUBindGroupLayout;
  let impostorBuf: GPUBuffer;
  let impostorGroup: GPUBindGroup;
  const impostorData = new ArrayBuffer(IMPOSTOR_FLOATS * 4);
  let impostorPipeline: Tracked<GPURenderPipeline>;
  let impostorList: ImpostorInfo[] = [];

  // Flare.
  let flareLayout: GPUBindGroupLayout;
  let flareBuf: GPUBuffer;
  let flareGroup: GPUBindGroup;
  const flareData = new ArrayBuffer(FLARE_FLOATS * 4);
  let flareState: GPUBuffer;
  let flarePipeline: Tracked<GPURenderPipeline>;
  let visBindings: SceneBindings;
  let visSceneLayout: GPUBindGroupLayout;
  let visSceneGroup: GPUBindGroup | null = null;
  let visVersion = -1;
  let visLayout: GPUBindGroupLayout;
  let visBuf: GPUBuffer;
  let visGroup: GPUBindGroup;
  let visPipeline: Tracked<GPUComputePipeline>;
  let flareThisFrame = false;
  let flareNorm = { halo: 1, spikes: 1, ghosts: GHOSTS.map(() => 1), sunRadius: -1 };

  let probe: EnvironmentProbe;
  let probeThisFrame = false;

  const fail = (what: string, e: unknown): void => {
    const msg = `${id}: ${what}: ${e instanceof Error ? e.message : String(e)}`;
    status.error = msg;
    coreOf(ctx).reportError(msg);
  };

  const rebuildSkyGroup = (): void => {
    skyGroup = device.createBindGroup({
      label: `${id}.sky`,
      layout: skyLayout,
      entries: [
        { binding: 0, resource: { buffer: skyBuf } },
        { binding: 1, resource: milkyWay ?? blankCube },
      ],
    });
  };

  async function loadSky(): Promise<void> {
    const base = ctx.skyUrl;
    const res = await fetch(`${base}/manifest.json`);
    if (!res.ok) throw new Error(`${base}/manifest.json: HTTP ${res.status}`);
    const manifest = validateSkyManifest(await res.json());
    status.manifest = manifest;

    const sres = await fetch(`${base}/${manifest.stars.file}`);
    if (!sres.ok) throw new Error(`${base}/${manifest.stars.file}: HTTP ${sres.status}`);
    catalogue = parseStarCatalogue(await sres.arrayBuffer(), manifest.stars.count);
    starBuffer = device.createBuffer({ label: `${id}.stars`, size: catalogue.records.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(starBuffer, 0, catalogue.records);
    status.starsLoaded = true;

    const mw = manifest.milkyWay;
    const tex = coreOf(ctx).createTextureChecked({
      label: `${id}.milkyWay`,
      format: 'rgb9e5ufloat',
      size: [mw.faceSize, mw.faceSize, 6],
      mipLevelCount: mw.mipLevels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const layout = faceMipLayout(mw.faceSize, mw.mipLevels);
    const bytes = faceFileBytes(mw.faceSize, mw.mipLevels);
    // One face at a time: 22 MB of transient memory instead of 134 MB.
    for (let face = 0; face < 6; face++) {
      const fres = await fetch(`${base}/${mw.files[face]}`);
      if (!fres.ok) throw new Error(`${base}/${mw.files[face]}: HTTP ${fres.status}`);
      const data = await fres.arrayBuffer();
      if (data.byteLength !== bytes) throw new Error(`${mw.files[face]}: ${data.byteLength} bytes, expected ${bytes} (full mip chain of ${mw.faceSize}^2 rgb9e5)`);
      for (let l = 0; l < mw.mipLevels; l++) {
        const { offset, size } = layout[l]!;
        device.queue.writeTexture({ texture: tex, mipLevel: l, origin: [0, 0, face] }, data, { offset, bytesPerRow: size * 4, rowsPerImage: size }, [size, size, 1]);
      }
    }
    milkyWayTex = tex;
    milkyWay = tex.createView({ dimension: 'cube' });
    status.milkyWayLoaded = true;
    rebuildSkyGroup();
    probe.setMilkyWay(milkyWay, mw.luminanceScale, mw.faceSize);
  }

  /** Normalisation of the flare profiles (numeric integrals over the drawn domain); depends on the sun's size. */
  const normaliseFlare = (sunRadius: number): void => {
    if (Math.abs(sunRadius - flareNorm.sunRadius) < 1e-3 * sunRadius) return;
    flareNorm = {
      halo: 1 / haloIntegral(STARBURST.haloCore, sunRadius),
      spikes: 1 / spikeIntegral(STARBURST.spikeWidth, STARBURST.spikeLength, 1, sunRadius),
      ghosts: GHOSTS.map((g) => 1 / ghostIntegral(g)),
      sunRadius,
    };
  };

  const prepareSky = (frame: FrameContext, tanX: number, tanY: number): void => {
    const [w, h] = frame.renderSize;
    const d = skyData;
    d.fill(0);
    d.set([status.manifest?.milkyWay.luminanceScale ?? 0, parts.milkyWay && milkyWay ? 1 : 0, parts.sun ? 1 : 0, parts.stars && starBuffer ? 1 : 0], 0);
    const star = defs.bodies[frame.sun.bodyId];
    const u = star?.emission?.limbDarkening ?? [0, 0, 0];
    d.set([u[0], u[1], u[2], 1 / (Math.PI * Math.sin(Math.max(frame.sun.angularRadius, 1e-9)) ** 2)], 4);
    // Scintillation: only inside an atmosphere (the camera below the top of the nearest atmosphere body's shell).
    let inside = false;
    for (const pose of frame.bodies) {
      const def = defs.bodies[pose.id];
      const atm = def?.render.atmosphere;
      // Inside the shell: between half a radius below the datum (sea floor, caves) and the top of the atmosphere.
      if (!def || !atm || pose.cameraAltitude >= atm.topAltitude || pose.cameraAltitude < -0.5 * def.radius) continue;
      const r = v3.len(pose.centerRelCam);
      const up = v3.scale(pose.centerRelCam, -1 / r);
      d.set([1, pose.cameraAltitude, atm.rayleighScaleHeight, r / atm.rayleighScaleHeight], 8);
      d.set([up.x, up.y, up.z, frame.realTime], 12);
      inside = true;
      break;
    }
    if (!inside) d.set([0, 0, 1, 1], 8);
    d.set([pixelSolidAngle(tanX, tanY, w, h), STAR_QUAD_SIGMAS * STAR_PSF_SIGMA_PX, (2 * tanY) / h, 0], 16);
    device.queue.writeBuffer(skyBuf, 0, d);
  };

  const prepareImpostors = (frame: FrameContext, tanX: number, tanY: number, forward: { x: number; y: number; z: number }): void => {
    impostorList = [];
    const u32 = new Uint32Array(impostorData);
    const f32 = new Float32Array(impostorData);
    f32.fill(0);
    if (!parts.impostors) return;
    const [w, h] = frame.renderSize;
    const pxAngle = (2 * tanY) / h;
    const omegaAxis = pixelSolidAngle(tanX, tanY, w, h);
    const s = frame.snapshot;
    const emission = defs.bodies[frame.sun.bodyId]?.emission;
    if (!emission) return;
    let n = 0;
    for (const pose of frame.bodies) {
      if (n >= MAX_IMPOSTORS) break;
      if (pose.id === frame.sun.bodyId) continue;
      const def = defs.bodies[pose.id];
      const snap = s.bodies.find((b) => b.id === pose.id);
      if (!def || !snap) continue;
      const dist = v3.len(pose.centerRelCam);
      const R = def.radius;
      if (dist < 4 * R) continue;
      const dir = v3.scale(pose.centerRelCam, 1 / dist);
      const cosOff = v3.dot(dir, forward);
      if (cosOff < 0.05) continue;
      const diameterPx = (2 * Math.asin(R / dist)) / (pxAngle * cosOff ** 1.5);
      if (diameterPx >= IMPOSTOR_NONE_PX) continue;
      const weight = impostorWeight(diameterPx);
      // Sun at the body: illuminance, angular size, and eclipses by the other bodies.
      const eSun = emission.illuminance * (emission.refDistance / snap.sunDistance) ** 2;
      const rs = Math.asin(Math.min(1, emission.radius / snap.sunDistance));
      let vis = 1;
      for (const o of s.bodies) {
        if (o.id === pose.id || o.id === s.starId) continue;
        const od = defs.bodies[o.id];
        if (!od) continue;
        const to = v3.sub(o.rRoot, snap.rRoot);
        vis *= discVisibleFraction(rs, Math.asin(Math.min(1, od.radius / v3.len(to))), v3.angle(to, snap.sunDir));
      }
      const phase = v3.angle(snap.sunDir, v3.neg(dir));
      const e = lambertSphereIlluminance(eSun, def.render.geometricAlbedo, R, dist, phase) * vis;
      const mc = def.render.meanColor;
      const l = Math.max(luma(mc), 1e-6);
      const sigma = impostorSigmaPx(diameterPx);
      const o = 4 + n * 12;
      f32.set([pose.centerRelCam.x, pose.centerRelCam.y, pose.centerRelCam.z, R], o);
      f32.set([(e * mc[0]) / l, (e * mc[1]) / l, (e * mc[2]) / l, weight], o + 4);
      f32.set([sigma, Math.max(STAR_QUAD_SIGMAS * sigma, diameterPx / 2 + 1.5), dist - 1.5 * R, 1 / omegaAxis], o + 8);
      impostorList.push({ bodyId: pose.id, diameterPx, weight, illuminance: e, sigmaPx: sigma });
      n++;
    }
    u32[0] = n;
    device.queue.writeBuffer(impostorBuf, 0, impostorData);
  };

  const prepareFlare = (frame: FrameContext, tanX: number, tanY: number): void => {
    flareThisFrame = false;
    if (!parts.flare || frame.camera.kind === 'interior' || frame.sun.illuminance <= 0) return;
    const [cx, cy, cw] = clipOfDirection(mat4.mul(frame.projUnjittered, frame.view), frame.sun.dirRoot);
    if (cw <= 0) return;
    const sx = cx / cw;
    const sy = cy / cw;
    const rs = frame.sun.angularRadius;
    if (Math.abs(sx) > 1 + Math.tan(rs) / tanX || Math.abs(sy) > 1 + Math.tan(rs) / tanY) return;
    normaliseFlare(rs);
    const u = new Uint32Array(flareData);
    const f = new Float32Array(flareData);
    f.fill(0);
    u[0] = FLARE_TERMS;
    f.set([sx, sy, 0, 0], 4);
    const t = (k: number, a: number[], b: number[], c2: number[], q: number[]): void => f.set([...a, ...b, ...c2, ...q], 8 + k * 16);
    const half = Math.tan(STARBURST_MAX_ANGLE);
    t(0, [0, 0, STARBURST.spikeLength, 0], [...STARBURST.tint, STARBURST.energy], [STARBURST.haloCore, flareNorm.halo, STARBURST.spikeWidth, flareNorm.spikes], [half / tanX, half / tanY, 0, 0]);
    GHOSTS.forEach((g, i) => {
      const extent = Math.tan(g.radius * (1 + g.chroma) * 1.05);
      t(1 + i, [sx * g.k, sy * g.k, g.radius, 1], [...g.tint, g.energy], [g.softness, flareNorm.ghosts[i]!, g.chroma, 0], [extent / tanX, extent / tanY, 0, 0]);
    });
    device.queue.writeBuffer(flareBuf, 0, flareData);
    // Transmittance towards the sun at the camera: the nearest frame body with an atmosphere shell around the camera.
    const vis = new Float32Array([-1, 0, 0, 0]);
    for (let i = 0; i < Math.min(MAX_BODIES, frame.bodies.length); i++) {
      const pose = frame.bodies[i]!;
      const atm = defs.bodies[pose.id]?.render.atmosphere;
      if (!atm) continue;
      const r = v3.len(pose.centerRelCam);
      vis.set([i, r, v3.dot(v3.scale(pose.centerRelCam, -1 / r), pose.sunDir)], 0);
      break;
    }
    device.queue.writeBuffer(visBuf, 0, vis);
    flareThisFrame = true;
  };

  const sceneGroupFor = (bindings: SceneBindings, layout: GPUBindGroupLayout, cur: GPUBindGroup | null, version: number): [GPUBindGroup, number] => {
    const v = bindings.version();
    if (cur && v === version) return [cur, version];
    return [device.createBindGroup({ label: `${id}.scene`, layout, entries: bindings.entries() }), v];
  };

  const readStorage = async (buffer: GPUBuffer, bytes: number): Promise<Float32Array> => {
    const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return out;
  };

  const feature: SkyFeature = {
    id,
    order: options.order ?? 0,
    parts,

    init(c) {
      ctx = c;
      defs = c.defs;
      device = c.device;
      const core = coreOf(c);
      const V = GPUShaderStage.VERTEX;
      const F = GPUShaderStage.FRAGMENT;

      skyLayout = device.createBindGroupLayout({
        label: `${id}.sky`,
        entries: [
          { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
          { binding: 1, visibility: F, texture: { sampleType: 'float', viewDimension: 'cube' } },
        ],
      });
      skyBuf = device.createBuffer({ label: `${id}.sky`, size: SKY_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      blankCube = core.createTextureChecked({ label: `${id}.noCube`, format: 'rgba16float', size: [1, 1, 6], usage: GPUTextureUsage.TEXTURE_BINDING }).createView({ dimension: 'cube' });
      rebuildSkyGroup();
      const depthEqual: GPUDepthStencilState = { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'equal' };
      backgroundPipeline = core.fullscreenPipeline({ label: `${id}.background`, fragment: BACKGROUND_FS, layouts: [skyLayout], targets: [{ format: RENDER_FORMATS.hdr, blend: ADDITIVE }], depthStencil: depthEqual });
      starPipeline = core.shaders.tracked(() => {
        const module = core.shaders.createModule(`${id}.stars`, STARS_WGSL);
        return device.createRenderPipeline({
          label: `${id}.stars`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [c.frameBindGroupLayout, skyLayout] }),
          vertex: {
            module,
            entryPoint: 'vs',
            buffers: [
              {
                arrayStride: STAR_RECORD_FLOATS * 4,
                stepMode: 'instance',
                attributes: [
                  { shaderLocation: 0, offset: 0, format: 'float32x4' },
                  { shaderLocation: 1, offset: 16, format: 'float32x4' },
                ],
              },
            ],
          },
          fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: ADDITIVE }] },
          primitive: { topology: 'triangle-strip' },
          depthStencil: depthEqual,
        });
      });

      // Transparent stage.
      transBindings = createSceneBindings(c, 1, 0, ['transparency', 'sceneDepth']);
      transLayout = device.createBindGroupLayout({ label: `${id}.transparent`, entries: transBindings.layoutEntries });
      impostorLayout = device.createBindGroupLayout({ label: `${id}.impostors`, entries: [{ binding: 0, visibility: V | F, buffer: { type: 'uniform' } }] });
      impostorBuf = device.createBuffer({ label: `${id}.impostors`, size: IMPOSTOR_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      impostorGroup = device.createBindGroup({ label: `${id}.impostors`, layout: impostorLayout, entries: [{ binding: 0, resource: { buffer: impostorBuf } }] });
      const depthTransparent: GPUDepthStencilState = { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' };
      impostorPipeline = core.shaders.tracked(() => {
        const module = core.shaders.createModule(`${id}.impostors`, IMPOSTOR_WGSL(transBindings.wgsl));
        return device.createRenderPipeline({
          label: `${id}.impostors`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [c.frameBindGroupLayout, transLayout, impostorLayout] }),
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: PREMULTIPLIED }] },
          primitive: { topology: 'triangle-strip' },
          depthStencil: depthTransparent,
        });
      });

      flareLayout = device.createBindGroupLayout({
        label: `${id}.flare`,
        entries: [
          { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
          { binding: 1, visibility: V | F, buffer: { type: 'read-only-storage' } },
        ],
      });
      flareBuf = device.createBuffer({ label: `${id}.flare`, size: FLARE_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      flareState = device.createBuffer({ label: `${id}.flareState`, size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      flareGroup = device.createBindGroup({
        label: `${id}.flare`,
        layout: flareLayout,
        entries: [
          { binding: 0, resource: { buffer: flareBuf } },
          { binding: 1, resource: { buffer: flareState } },
        ],
      });
      flarePipeline = core.shaders.tracked(() => {
        const module = core.shaders.createModule(`${id}.flare`, FLARE_WGSL(transBindings.wgsl));
        return device.createRenderPipeline({
          label: `${id}.flare`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [c.frameBindGroupLayout, transLayout, flareLayout] }),
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: PREMULTIPLIED }] },
          primitive: { topology: 'triangle-strip' },
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
        });
      });
      visBindings = createSceneBindings(c, 1, 0, ['sceneDepth', 'transparency', 'atmosphereLuts']);
      visSceneLayout = device.createBindGroupLayout({ label: `${id}.flareVisScene`, entries: visBindings.layoutEntries });
      visLayout = device.createBindGroupLayout({
        label: `${id}.flareVis`,
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        ],
      });
      visBuf = device.createBuffer({ label: `${id}.flareVis`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      visGroup = device.createBindGroup({
        label: `${id}.flareVis`,
        layout: visLayout,
        entries: [
          { binding: 0, resource: { buffer: visBuf } },
          { binding: 1, resource: { buffer: flareState } },
        ],
      });
      visPipeline = core.shaders.tracked(() =>
        device.createComputePipeline({
          label: `${id}.flareVis`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [c.frameBindGroupLayout, visSceneLayout, visLayout] }),
          compute: { module: core.shaders.createModule(`${id}.flareVis`, FLARE_VIS_CS(visBindings.wgsl)), entryPoint: 'main' },
        }),
      );
      for (const p of [backgroundPipeline, starPipeline, impostorPipeline, flarePipeline]) p.get();
      visPipeline.get();

      probe = new EnvironmentProbe(c, id, blankCube);
      if (parts.probe && (options.probeAlbedo ?? 'tileset') === 'tileset') probe.loadAlbedoMaps(defs);

      pendingLoads++;
      loadSky()
        .catch((e: unknown) => fail('sky data', e))
        .finally(() => pendingLoads--);
    },

    prepare(frame) {
      const tanY = Math.tan(frame.camera.fovY / 2);
      const tanX = tanY * (frame.renderSize[0] / frame.renderSize[1]);
      const forward = { x: -frame.view[2]!, y: -frame.view[6]!, z: -frame.view[10]! };
      prepareSky(frame, tanX, tanY);
      prepareImpostors(frame, tanX, tanY, forward);
      prepareFlare(frame, tanX, tanY);
      probeThisFrame = parts.probe && probe.prepare(frame, defs);
    },

    compute(frame, encoder) {
      if (probeThisFrame) probe.encode(frame, encoder);
    },

    drawBackground(frame, pass) {
      pass.setBindGroup(1, skyGroup);
      if ((parts.milkyWay && milkyWay) || parts.sun) {
        pass.setPipeline(backgroundPipeline.get());
        pass.draw(3);
      }
      if (parts.stars && starBuffer && catalogue) {
        pass.setPipeline(starPipeline.get());
        pass.setVertexBuffer(0, starBuffer);
        pass.draw(4, catalogue.count);
      }
    },

    preTransparent(frame, encoder) {
      status.flareDrawn = flareThisFrame;
      if (!flareThisFrame) return;
      [visSceneGroup, visVersion] = sceneGroupFor(visBindings, visSceneLayout, visSceneGroup, visVersion);
      const pass = encoder.beginComputePass({ label: `${id}.flareVis`, timestampWrites: ctx.perf.gpuPass(`${id}.flareVis`) as GPUComputePassTimestampWrites | undefined });
      pass.setPipeline(visPipeline.get());
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setBindGroup(1, visSceneGroup);
      pass.setBindGroup(2, visGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
    },

    drawTransparent(_frame, pass) {
      if (impostorList.length === 0 && !flareThisFrame) return;
      [transGroup, transVersion] = sceneGroupFor(transBindings, transLayout, transGroup, transVersion);
      pass.setBindGroup(1, transGroup);
      if (impostorList.length > 0) {
        pass.setPipeline(impostorPipeline.get());
        pass.setBindGroup(2, impostorGroup);
        pass.draw(4, impostorList.length);
      }
      if (flareThisFrame) {
        pass.setPipeline(flarePipeline.get());
        pass.setBindGroup(2, flareGroup);
        pass.draw(4, FLARE_TERMS);
      }
    },

    isIdle: () => pendingLoads === 0 && (!parts.probe || probe.isIdle()),

    dispose() {
      milkyWayTex?.destroy();
      starBuffer?.destroy();
      for (const b of [skyBuf, impostorBuf, flareBuf, flareState, visBuf]) b.destroy();
      probe.dispose();
    },

    status: () => ({ ...status }),
    stars: () => catalogue,
    impostors: () => impostorList.map((i) => ({ ...i })),
    probe: () => probe.info(),
    readProbeSh: () => probe.readSh(),
    readProbeFace: (face, mip = 0) => probe.readFace(face, mip),
    async readFlareState() {
      const f = await readStorage(flareState, 32);
      return { visible: f[0]!, cloud: f[1]!, inView: f[2]!, transmittance: [f[4]!, f[5]!, f[6]!] };
    },
  };
  return feature;
}
