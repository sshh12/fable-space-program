/**
 * createOceanFeature: how water is shaded everywhere (the shared `brdf_water` chunk), the FFT wind waves, the
 * near-field forward surface and its hand-over with the terrain's far sheet (ARCHITECTURE 10.2), refraction
 * and foam, vessel interaction, and the 'ocean.wetness' slots. Per-body data only: bodies without an ocean
 * cost nothing, and with the camera higher than fadeEnd above the sea no compute or draw runs at all.
 */
import { RENDER_FORMATS, type FrameContext, type RenderContext, type RenderFeature } from '@/core/contracts/render';
import { oceanSwellHeight } from '@/core/geo/oceanSwell';
import { quat, v3, type Vec3 } from '@/core/math';
import { coreOf, createSceneBindings, MAX_BODIES, type SceneBindings, type Tracked } from '@/render/core';
import { buildCascades, type OceanCascadeSet } from './cascades';
import { OceanFft } from './fft';
import {
  ChartKeeper,
  chartCoords,
  chartReference,
  nearFieldValue,
  packNearField,
  PATCH_CELLS,
  selectPatches,
  sphereOffset,
  type ChartReference,
  type OceanChart,
  type OceanNearFieldValue,
  type SurfacePatch,
} from './nearField';
import { coxMunkVariance, oceanTunables, type OceanTunables } from './params';
import { MAX_SWELL, prepareSwell, swellAmplitudeBound, swellSlopeVariance, type PreparedSwell } from './swell';
import { OCEAN_UNIFORM_BYTES, OCEAN_UNIFORM_VEC4, OCEAN_WAVES_WGSL } from './shaders/waves';
import { buildWaterBrdfWgsl, whitecapCoverage } from './shaders/waterBrdf';
import { READBACK_WGSL, SURFACE_PIPELINE_WGSL } from './shaders/surfaceWgsl';
import { packOceanUniforms, type OceanFrameData } from './uniforms';
import { OceanVessels, type VesselFrame } from './vessels';

export const OCEAN_FEATURE_ID = 'ocean';
/** Debug views of the near-field surface: one shading term each (lab diagnostics). */
export const OCEAN_DEBUG_VIEWS = { none: 0, skyReflection: 1, body: 2, sunSpecular: 3, foam: 4, normal: 5, roughness: 6 } as const;
const MAX_PATCHES = 4096;
const DEPTH_READ_WGSL = /* wgsl */ `
@group(0) @binding(0) var d: texture_depth_2d;
@group(0) @binding(1) var<storage, read> px: array<vec2u>;
@group(0) @binding(2) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&px)) { return; }
  out[id.x] = textureLoad(d, px[id.x], 0);
}
`;
const GRID = PATCH_CELLS + 1;

export interface OceanSurfaceSample {
  /** Total height of the drawn surface above sea level at the query's horizontal position, m. */
  total: number;
  /** Its parts: the shared swell (GPU), the FFT chop, the splash ripples. */
  swell: number;
  fft: number;
  ripple: number;
  /** oceanSwellHeight at the same position and time, float64 on the CPU (the physics surface). */
  swellCpu: number;
  /** Distance between the query and where the solved Lagrangian point lands, m (should be ~0). */
  residual: number;
}

export interface OceanDebug {
  /** The near-field value published this frame. */
  nearField(): OceanNearFieldValue;
  /** Force the near field off (deferred water only) or back to automatic. */
  forceNearFieldOff(off: boolean): void;
  /** Scale the FFT chop (1 = the data; 0 shows the shared swell alone). Debug hook for labs and specs. */
  setChopScale(scale: number): void;
  /** Show one shading term of the near field (OCEAN_DEBUG_VIEWS); 'none' = normal shading. */
  setDebugView(view: keyof typeof OCEAN_DEBUG_VIEWS): void;
  /** Scale the refraction offset (1 = the data). Debug hook for the refraction check. */
  setRefractionScale(scale: number): void;
  /** Switch the direct specular of brdf_water (sun glint) off to isolate it in tests; true restores it. */
  setDirectSpecular(on: boolean): void;

  /** Reversed-Z values of 'scene.depthOpaque' (this frame's opaque depth: the seabed inside fadeStart) at render pixels. */
  readOpaqueDepth(pixels: readonly [number, number][]): Promise<number[]>;
  /** Heights of the displaced surface (what the vertex shader draws, unfiltered) at body-fixed unit directions. */
  sampleSurface(dirsFixed: readonly Vec3[]): Promise<{ ut: number; samples: OceanSurfaceSample[] }>;
  /** Spectrum statistics and frame state for tests and the hand-off. */
  state(): {
    active: boolean;
    bodyId: string | null;
    patches: number;
    cameraHeight: number;
    chartAnchor: Vec3 | null;
    coxMunk: number;
    swellSlopeVariance: number;
    cascades: { length: number; kLow: number; kHigh: number; heightRms: number; slopeVariance: number; residual: number }[];
    subCascadeVariance: number;
    capillaryAmplitude: number;
    vesselZones: number;
    ripples: number;
    wetSlots: number;
  };
}

export type OceanFeature = RenderFeature & { readonly debug: OceanDebug };

interface BodyOcean {
  tunables: OceanTunables;
  cascades: OceanCascadeSet;
  fft: OceanFft | null;
  residual: number[];
  fftHeightRms: number;
  swellVariance: number;
  /** Capillary detail layers (the finest cascade compressed and rotated). */
  detail: { scale: number; angle: number; amplitude: number }[];
}

export function createOceanFeature(options: { id?: string; order?: number } = {}): OceanFeature {
  let ctx: RenderContext;
  let device: GPUDevice;
  const bodies = new Map<string, BodyOcean>();
  const keeper = new ChartKeeper();
  let vessels: OceanVessels;
  let nearFieldBuffer: GPUBuffer;
  const nearFieldData = new ArrayBuffer(16);
  let nearField: OceanNearFieldValue = { bodyIndex: -1, fadeStart: 0, fadeEnd: 0 };
  let forcedOff = false;
  let chopScale = 1;
  let debugView = 0;
  let refractionScale = 1;
  let directSpecular = true;
  let lastFrame: FrameContext | null = null;
  let depthReadLayout: GPUBindGroupLayout;
  let depthReadPipeline: GPUComputePipeline;
  let brdfKey = '';
  let uniformBuffer: GPUBuffer;
  const uniformData = new ArrayBuffer(OCEAN_UNIFORM_BYTES);
  const uniformF = new Float32Array(uniformData);
  const uniformU = new Uint32Array(uniformData);
  let patchBuffer: GPUBuffer;
  const patchData = new Float32Array(MAX_PATCHES * 4);
  let patchCount = 0;
  const patches: SurfacePatch[] = [];
  let gridBuffer: GPUBuffer;
  let indexBuffer: GPUBuffer;
  let indexCount = 0;
  let scene: SceneBindings;
  let sceneLayout: GPUBindGroupLayout;
  let sceneGroup: GPUBindGroup | null = null;
  let sceneVersion = -1;
  let oceanLayout: GPUBindGroupLayout;
  let oceanSampler: GPUSampler;
  const oceanGroups = new Map<string, GPUBindGroup>();
  let pipeline: Tracked<GPURenderPipeline>;
  let readbackLayout: GPUBindGroupLayout;
  let readbackPipeline: Tracked<GPUComputePipeline>;
  let active: { body: BodyOcean; chart: OceanChart; ref: ChartReference; vf: VesselFrame; tau: number; dt: number; cameraHeight: number } | null = null;
  let lastUt = 0;
  let lastWetSlots = 0;
  const swellNow: PreparedSwell = { count: 0, dirK: new Float32Array(MAX_SWELL * 4), ampPhase: new Float32Array(MAX_SWELL * 4) };
  const swellPrev: PreparedSwell = { count: 0, dirK: new Float32Array(MAX_SWELL * 4), ampPhase: new Float32Array(MAX_SWELL * 4) };
  const swellPrevPhase = new Float32Array(MAX_SWELL);
  let disposed = false;

  const frac = (x: number): number => x - Math.floor(x);

  const ensureFft = (b: BodyOcean): OceanFft => {
    if (!b.fft) b.fft = new OceanFft(ctx, b.cascades, b.tunables);
    return b.fft;
  };

  /** The shared chunk with the per-body constants of this frame's body list (re-registered only when it changes). */
  const registerBrdf = (frame: FrameContext | null): void => {
    const list: (OceanTunables | null)[] = [];
    for (let i = 0; i < MAX_BODIES; i++) {
      const id = frame?.bodies[i]?.id;
      list.push(id ? (bodies.get(id)?.tunables ?? null) : null);
    }
    const key = `${list.map((t) => t?.bodyId ?? '-').join(',')}:${directSpecular}`;
    if (key === brdfKey) return;
    brdfKey = key;
    ctx.shaders.register('brdf_water', buildWaterBrdfWgsl(list, { directSpecular }));
  };

  const oceanGroup = (fft: OceanFft): GPUBindGroup => {
    const key = `${fft.disp.label}:${fft.foamCurrent}:${vessels.wakeCurrent}`;
    let g = oceanGroups.get(key);
    if (!g) {
      g = device.createBindGroup({
        label: 'ocean.surface',
        layout: oceanLayout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: patchBuffer } },
          { binding: 2, resource: fft.dispView },
          { binding: 3, resource: fft.dispPrevView },
          { binding: 4, resource: fft.derivView },
          { binding: 5, resource: fft.foamViews[fft.foamCurrent]! },
          { binding: 6, resource: vessels.wakeViews[vessels.wakeCurrent]! },
          { binding: 7, resource: oceanSampler },
        ],
      });
      oceanGroups.set(key, g);
    }
    return g;
  };

  const debug: OceanDebug = {
    nearField: () => ({ ...nearField }),
    forceNearFieldOff(off) {
      forcedOff = off;
    },
    setChopScale(scale) {
      chopScale = scale;
    },
    setDebugView(view) {
      debugView = OCEAN_DEBUG_VIEWS[view];
    },
    setRefractionScale(scale) {
      refractionScale = scale;
    },
    setDirectSpecular(on) {
      directSpecular = on;
      brdfKey = '';
      registerBrdf(lastFrame);
    },
    async readOpaqueDepth(pixels) {
      const n = Math.max(pixels.length, 1);
      const q = new Uint32Array(n * 2);
      pixels.forEach(([x, y], i) => q.set([x, y], i * 2));
      const qb = device.createBuffer({ size: q.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(qb, 0, q);
      const out = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const map = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const group = device.createBindGroup({
        layout: depthReadLayout,
        entries: [
          { binding: 0, resource: ctx.resources.get('scene.depthOpaque') },
          { binding: 1, resource: { buffer: qb } },
          { binding: 2, resource: { buffer: out } },
        ],
      });
      const enc = device.createCommandEncoder({ label: 'ocean.depthRead' });
      const pass = enc.beginComputePass();
      pass.setPipeline(depthReadPipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(n / 64));
      pass.end();
      enc.copyBufferToBuffer(out, 0, map, 0, n * 4);
      device.queue.submit([enc.finish()]);
      await map.mapAsync(GPUMapMode.READ);
      const r = Array.from(new Float32Array(map.getMappedRange().slice(0)));
      for (const b of [qb, out, map]) b.destroy();
      return r.slice(0, pixels.length);
    },
    async sampleSurface(dirsFixed) {
      const a = active;
      if (!a) throw new Error('ocean.sampleSurface: the near field is not active');
      const fft = ensureFft(a.body);
      const n = dirsFixed.length;
      const q = new Float32Array(Math.max(n, 1) * 4);
      dirsFixed.forEach((d, i) => {
        const xy = chartCoords(a.chart, v3.normalize(d));
        if (!xy) throw new Error('ocean.sampleSurface: point outside the chart');
        q[i * 4] = xy.x - a.ref.x;
        q[i * 4 + 1] = xy.y - a.ref.y;
      });
      const qb = device.createBuffer({ size: q.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(qb, 0, q);
      const rb = device.createBuffer({ size: q.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const resB = device.createBuffer({ size: Math.max(n, 1) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const map1 = device.createBuffer({ size: q.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const map2 = device.createBuffer({ size: Math.max(n, 1) * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const group = device.createBindGroup({
        layout: readbackLayout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: qb } },
          { binding: 2, resource: { buffer: rb } },
          { binding: 3, resource: { buffer: resB } },
          { binding: 4, resource: fft.dispView },
          { binding: 5, resource: fft.dispPrevView },
        ],
      });
      const frame = (coreOfFrame as { frameBindGroup: GPUBindGroup | null }).frameBindGroup;
      if (!frame) throw new Error('ocean.sampleSurface: no frame rendered yet');
      const enc = device.createCommandEncoder({ label: 'ocean.readback' });
      const pass = enc.beginComputePass({ label: 'ocean.readback' });
      pass.setPipeline(readbackPipeline.get());
      pass.setBindGroup(0, frame);
      pass.setBindGroup(1, group);
      pass.dispatchWorkgroups(Math.ceil(n / 64));
      pass.end();
      enc.copyBufferToBuffer(rb, 0, map1, 0, q.byteLength);
      enc.copyBufferToBuffer(resB, 0, map2, 0, Math.max(n, 1) * 4);
      device.queue.submit([enc.finish()]);
      await Promise.all([map1.mapAsync(GPUMapMode.READ), map2.mapAsync(GPUMapMode.READ)]);
      const r = new Float32Array(map1.getMappedRange().slice(0));
      const res = new Float32Array(map2.getMappedRange().slice(0));
      for (const b of [qb, rb, resB, map1, map2]) b.destroy();
      const t = a.body.tunables;
      const ut = lastUt;
      const samples = dirsFixed.map((d, i) => ({
        total: r[i * 4]!,
        swell: r[i * 4 + 1]!,
        fft: r[i * 4 + 2]!,
        ripple: r[i * 4 + 3]!,
        swellCpu: oceanSwellHeight(t.swell, t.gravity, t.seaRadius, v3.normalize(d), ut),
        residual: res[i]!,
      }));
      return { ut, samples };
    },
    state() {
      const a = active;
      const b = a?.body ?? [...bodies.values()][0] ?? null;
      const t = b?.tunables;
      const cm = t ? coxMunkVariance(t.windSpeed) : 0;
      const fftVar = b ? b.cascades.spectra.reduce((s, c) => s + c.slopeVariance, 0) : 0;
      return {
        active: a !== null,
        bodyId: a?.body.tunables.bodyId ?? null,
        patches: patchCount,
        cameraHeight: a?.cameraHeight ?? Number.NaN,
        chartAnchor: a ? { ...a.chart.a } : null,
        coxMunk: cm,
        swellSlopeVariance: b?.swellVariance ?? 0,
        cascades: b
          ? b.cascades.spectra.map((c, i) => ({ length: c.band.length, kLow: c.band.kLow, kHigh: c.band.kHigh, heightRms: Math.sqrt(c.heightVariance), slopeVariance: c.slopeVariance, residual: b.residual[i]! }))
          : [],
        subCascadeVariance: Math.max(0, cm - (b?.swellVariance ?? 0) - fftVar),
        capillaryAmplitude: b?.detail[0]?.amplitude ?? 0,
        vesselZones: a?.vf.zones.length ?? 0,
        ripples: a?.vf.ripples.length ?? 0,
        wetSlots: lastWetSlots,
      };
    },
  };
  // The frame bind group of the latest frame (the readback runs outside the frame graph).
  const coreOfFrame: { frameBindGroup: GPUBindGroup | null } = { frameBindGroup: null };

  /** Frustum test of a patch box (chart corner relative to the anchor, size) in camera-relative ROOT space. */
  const makeVisible = (frame: FrameContext, chart: OceanChart, ref: ChartReference, q: (v: Vec3) => Vec3, refRel: Vec3): ((x0: number, y0: number, size: number, zMin: number, zMax: number) => boolean) => {
    const scales = [frame.projUnjittered[0]!, frame.projUnjittered[5]!];
    const view = frame.view;
    return (x0, y0, size, _zMin, zMax) => {
      const off = sphereOffset(chart, ref, x0 + size / 2 - ref.x, y0 + size / 2 - ref.y);
      const c = v3.add(refRel, q(off));
      const vx = view[0]! * c.x + view[4]! * c.y + view[8]! * c.z;
      const vy = view[1]! * c.x + view[5]! * c.y + view[9]! * c.z;
      const vz = view[2]! * c.x + view[6]! * c.y + view[10]! * c.z;
      // Bounding sphere: half diagonal + wave margin + the sphere's sag below the chart plane + a metre.
      const radius = size * 0.7072 + zMax + (size * size) / (8 * chart.radius) + 1;
      const depth = -vz;
      if (depth < -radius) return false;
      // Side planes of the symmetric frustum (|x| s <= depth), distances normalised.
      for (let k = 0; k < 2; k++) {
        const s = scales[k]!;
        const coord = k === 0 ? vx : vy;
        const nrm = Math.hypot(1, s);
        if ((s * coord - depth) / nrm > radius || (-s * coord - depth) / nrm > radius) return false;
      }
      return true;
    };
  };

  const feature: OceanFeature = {
    id: options.id ?? OCEAN_FEATURE_ID,
    order: options.order ?? 0,
    requires: ['scene.colorCopy'],
    debug,

    init(c) {
      ctx = c;
      device = c.device;
      const core = coreOf(c);
      for (const def of Object.values(c.defs.bodies)) {
        const t = oceanTunables(def);
        if (!t) continue;
        const cascades = buildCascades(t);
        const sigma = cascades.spectra.map((s) => Math.sqrt(s.heightVariance));
        // Inside a damping zone the two long cascades vanish and the short ones keep a 3-sigma height under 4 cm.
        const shortSigma = Math.hypot(sigma[2] ?? 0, sigma[3] ?? 0);
        const keep = Math.min(1, 0.04 / Math.max(3 * shortSigma, 1e-9));
        const swellVariance = swellSlopeVariance(t.swell);
        const fftVariance = cascades.spectra.reduce((s, x) => s + x.slopeVariance, 0);
        // The capillary layers carry what Cox-Munk has beyond swell + cascades, less a remainder below any pixel.
        const layerVariance = Math.max(0, coxMunkVariance(t.windSpeed) - swellVariance - fftVariance - t.unresolvedFloor);
        const v3 = cascades.spectra[3]!.slopeVariance;
        const amplitude = v3 > 0 ? Math.sqrt(layerVariance / (2 * v3)) : 0;
        bodies.set(def.id, {
          tunables: t,
          cascades,
          fft: null,
          residual: [0, 0, keep, keep],
          fftHeightRms: Math.hypot(...sigma),
          swellVariance,
          detail: [
            { scale: t.capillaryScale, angle: 0.6435, amplitude },
            { scale: t.capillaryScale * t.capillaryScale, angle: 2.2143, amplitude },
          ],
        });
      }
      c.shaders.register('ocean_waves', OCEAN_WAVES_WGSL);
      registerBrdf(null);

      nearFieldBuffer = device.createBuffer({ label: 'ocean.nearField', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(nearFieldBuffer, 0, packNearField(nearField, nearFieldData));
      c.resources.publish('ocean.nearField', nearFieldBuffer);
      vessels = new OceanVessels(c);
      c.resources.publish('ocean.wetness', vessels.wetness);

      uniformBuffer = device.createBuffer({ label: 'ocean.uniforms', size: OCEAN_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      patchBuffer = device.createBuffer({ label: 'ocean.patches', size: patchData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const grid = new Float32Array(GRID * GRID * 2);
      for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) grid.set([i, j], (j * GRID + i) * 2);
      gridBuffer = device.createBuffer({ label: 'ocean.grid', size: grid.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(gridBuffer, 0, grid);
      const idx = new Uint16Array(PATCH_CELLS * PATCH_CELLS * 6);
      let k = 0;
      for (let j = 0; j < PATCH_CELLS; j++) {
        for (let i = 0; i < PATCH_CELLS; i++) {
          const a = j * GRID + i;
          // One diagonal orientation everywhere: required for the CDLOD morph to reproduce the parent grid.
          idx.set([a, a + 1, a + GRID + 1, a, a + GRID + 1, a + GRID], k);
          k += 6;
        }
      }
      indexCount = idx.length;
      indexBuffer = device.createBuffer({ label: 'ocean.gridIndex', size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(indexBuffer, 0, idx);

      scene = core.createSceneBindings(1, 0, ['shadow', 'atmosphereLuts', 'env', 'cloudShadow', 'sceneDepthOpaque', 'sceneColor', 'gbuffer']);
      // The vertex stage reads the seabed depth (TMA attenuation) from 'scene.depthOpaque' and the G-buffer material.
      const entries = scene.layoutEntries.map((e) => (e.texture ? { ...e, visibility: e.visibility | GPUShaderStage.VERTEX } : e));
      sceneLayout = device.createBindGroupLayout({ label: 'ocean.scene', entries });
      const F = GPUShaderStage.FRAGMENT;
      const V = GPUShaderStage.VERTEX;
      const arr = (binding: number, visibility: number): GPUBindGroupLayoutEntry => ({ binding, visibility, texture: { sampleType: 'float', viewDimension: '2d-array' } });
      oceanLayout = device.createBindGroupLayout({
        label: 'ocean.surface',
        entries: [
          { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
          { binding: 1, visibility: V, buffer: { type: 'read-only-storage' } },
          arr(2, V | F),
          arr(3, V | F),
          arr(4, F),
          arr(5, F),
          { binding: 6, visibility: F, texture: { sampleType: 'float' } },
          { binding: 7, visibility: F, sampler: { type: 'filtering' } },
        ],
      });
      oceanSampler = device.createSampler({ label: 'ocean.sampler', addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 4 });
      const layout = device.createPipelineLayout({ label: 'ocean.surface', bindGroupLayouts: [c.frameBindGroupLayout, sceneLayout, oceanLayout] });
      const blend: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
      pipeline = core.shaders.tracked(() => {
        const module = core.shaders.createModule('ocean.surface', SURFACE_PIPELINE_WGSL(scene.wgsl));
        return device.createRenderPipeline({
          label: 'ocean.surface',
          layout,
          vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] },
          fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend }, { format: RENDER_FORMATS.gbufferVelocity }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'greater-equal' },
        });
      });
      readbackLayout = device.createBindGroupLayout({
        label: 'ocean.readback',
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } },
          { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        ],
      });
      readbackPipeline = core.shaders.tracked(() =>
        device.createComputePipeline({
          label: 'ocean.readback',
          layout: device.createPipelineLayout({ bindGroupLayouts: [c.frameBindGroupLayout, readbackLayout] }),
          compute: { module: core.shaders.createModule('ocean.readback', READBACK_WGSL), entryPoint: 'readback' },
        }),
      );
      depthReadLayout = device.createBindGroupLayout({
        label: 'ocean.depthRead',
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        ],
      });
      depthReadPipeline = device.createComputePipeline({
        label: 'ocean.depthRead',
        layout: device.createPipelineLayout({ bindGroupLayouts: [depthReadLayout] }),
        compute: { module: c.shaders.createModule('ocean.depthRead', DEPTH_READ_WGSL), entryPoint: 'main' },
      });
      // Build the FFT resources of every ocean body up front (no allocation or compile hitch at activation).
      for (const b of bodies.values()) ensureFft(b);
      const first = [...bodies.values()][0];
      if (first?.fft) {
        c.resources.publish('ocean.displacement', first.fft.dispView);
        c.resources.publish('ocean.derivatives', first.fft.derivView);
      }
      pipeline.get();
      readbackPipeline.get();
    },

    prepare(frame) {
      if (disposed) return;
      coreOfFrame.frameBindGroup = frame.frameBindGroup;
      lastFrame = frame;
      registerBrdf(frame);
      lastUt = frame.snapshot.ut;
      // The ocean body: the nearest non-star body, when it has an ocean.
      let bi = -1;
      let best = Infinity;
      const count = Math.min(MAX_BODIES, frame.bodies.length);
      for (let i = 0; i < count; i++) {
        const pose = frame.bodies[i]!;
        if (pose.id === frame.sun.bodyId) continue;
        if (pose.cameraAltitude < best) {
          best = pose.cameraAltitude;
          bi = i;
        }
      }
      const pose = bi >= 0 ? frame.bodies[bi]! : null;
      const body = pose ? (bodies.get(pose.id) ?? null) : null;
      const t = body?.tunables ?? null;
      const camAboveSea = pose && t ? v3.len(pose.cameraFixed) - t.seaRadius : Infinity;
      nearField = forcedOff ? { bodyIndex: -1, fadeStart: t?.fadeStart ?? 0, fadeEnd: t?.fadeEnd ?? 0 } : nearFieldValue(bi, body !== null, camAboveSea, t?.fadeStart ?? 0, t?.fadeEnd ?? 0);
      device.queue.writeBuffer(nearFieldBuffer, 0, packNearField(nearField, nearFieldData));

      const wasActive = active !== null;
      if (nearField.bodyIndex < 0 || !pose || !body || !t) {
        // Wetness is published for vessels at the water even without a near field (the mesh system applies it at any distance).
        if (body && t && pose) vessels.update(frame, t, t.seaRadius - t.radius, pose.id, null, null);
        else vessels.clearWetness();
        lastWetSlots = vessels.wetSlots;
        if (wasActive) for (const b of bodies.values()) b.fft?.reset();
        active = null;
        patchCount = 0;
        return;
      }
      if (!wasActive) body.fft?.reset();

      // Chart and reference point (float64).
      const nadir = v3.normalize(pose.cameraFixed);
      const chart = keeper.update(pose.id, nadir, t.seaRadius, true);
      const ref = chartReference(chart, nadir);
      const cFixed = v3.scale(ref.cHat, t.seaRadius);
      const q = pose.qFixedToRoot;
      const qp = pose.prevQFixedToRoot;
      const refRel = quat.rotate(q, v3.sub(cFixed, pose.cameraFixed));
      const prevCamFixed = quat.rotateInv(qp, v3.neg(pose.prevCenterRelCam));
      const refRelPrev = quat.rotate(qp, v3.sub(cFixed, prevCamFixed));
      const rotCols = (qq: typeof q): number[] => {
        const x = quat.rotate(qq, { x: 1, y: 0, z: 0 });
        const y = quat.rotate(qq, { x: 0, y: 1, z: 0 });
        const z = quat.rotate(qq, { x: 0, y: 0, z: 1 });
        return [x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z];
      };

      const ut = frame.snapshot.ut;
      const prevUt = frame.prevSnapshot.ut;
      const dt = Math.max(0, ut - prevUt);
      prepareSwell(t.swell, t.gravity, t.seaRadius, ref.cHat, ut, swellNow);
      prepareSwell(t.swell, t.gravity, t.seaRadius, ref.cHat, prevUt, swellPrev);
      for (let i = 0; i < MAX_SWELL; i++) swellPrevPhase[i] = swellPrev.ampPhase[i * 4 + 1]!;

      const vf = vessels.update(frame, t, t.seaRadius - t.radius, pose.id, chart, ref);
      lastWetSlots = vessels.wetSlots;
      const rip = OceanVessels.rippleConstants(t);
      const cm = coxMunkVariance(t.windSpeed);
      const fftVar = body.cascades.spectra.reduce((s, c) => s + c.slopeVariance, 0);
      const waveBound = swellAmplitudeBound(t.swell) + 3 * body.fftHeightRms + t.rippleAmplitude * 1.5;
      const tau = frac(ut / t.repeatPeriod);
      const data: OceanFrameData = {
        cHat: ref.cHat,
        seaRadius: t.seaRadius,
        e: chart.e,
        f: chart.f,
        invQR: 1 / (t.seaRadius * ref.qLen),
        cameraHeight: camAboveSea,
        rot: rotCols(q),
        prevRot: rotCols(qp),
        refRel,
        refRelPrev,
        prevValid: true,
        bodyIndex: bi,
        fadeStart: t.fadeStart,
        fadeEnd: t.fadeEnd,
        detailRadius: t.detailFadeFraction * t.fadeStart,
        // The flat band surface sits this much above the sheet: covers the chord sag of the coarsest cells and
        // depth rounding, so the coplanar surfaces never z-fight under 'greater-equal'.
        bandLift: 0.05 + (t.fadeEnd / 48) ** 2 / (8 * t.seaRadius),
        windSpeed: t.windSpeed,
        coxMunk: cm,
        subVariance: Math.max(0, cm - body.swellVariance - fftVar),
        choppiness: t.choppiness,
        tau,
        tauPrev: frac(prevUt / t.repeatPeriod),
        repeatPeriod: t.repeatPeriod,
        dt,
        foamDecay: t.foamDecay,
        foamThreshold: t.foamSigma,
        foamGain: t.foamRampSigma,
        foamAlbedo: t.foamAlbedo,
        shoreFoamDepth: t.shoreFoamDepth,
        refractionDistortion: t.refractionDistortion * refractionScale,
        chromaticOffset: t.chromaticOffset,
        whitecaps: whitecapCoverage(t.windSpeed),
        swell: swellNow,
        swellPrevPhase,
        cascadeOrigin: body.cascades.spectra.map((c) => [frac(ref.x / c.band.length), frac(ref.y / c.band.length)]),
        cascades: body.cascades.spectra,
        cascadeResidual: body.residual,
        vessels: vf.zones,
        ripples: vf.ripples,
        ripple: rip,
        wake: vf.wake,
        seaLevel: t.seaRadius - t.radius,
        waveBound,
        chopScale,
        debugView,
        detail: body.detail.map((l) => {
          // Planet-fixed: rotate and compress the reference's chart coordinates in float64, keep the fraction.
          const c = Math.cos(l.angle);
          const sn = Math.sin(l.angle);
          const L = body.cascades.spectra[3]!.band.length / l.scale;
          return { ...l, origin: [frac((c * ref.x - sn * ref.y) / L), frac((sn * ref.x + c * ref.y) / L)] as [number, number] };
        }),
      };
      if (uniformF.length !== OCEAN_UNIFORM_VEC4 * 4) throw new Error('ocean: uniform size mismatch');
      packOceanUniforms(data, uniformF, uniformU);
      device.queue.writeBuffer(uniformBuffer, 0, uniformData);

      // Surface patches out to fadeEnd, culled against the view.
      const visible = makeVisible(frame, chart, ref, (v) => quat.rotate(q, v), refRel);
      selectPatches({ camX: ref.x, camY: ref.y, camH: camAboveSea, maxDistance: t.fadeEnd, waveMargin: waveBound, visible }, patches);
      patchCount = Math.min(patches.length, MAX_PATCHES);
      if (patches.length > MAX_PATCHES) coreOf(ctx).reportError(`ocean: ${patches.length} surface patches exceed the instance buffer (${MAX_PATCHES})`);
      for (let i = 0; i < patchCount; i++) {
        const p = patches[i]!;
        patchData[i * 4] = p.x0 - ref.x;
        patchData[i * 4 + 1] = p.y0 - ref.y;
        patchData[i * 4 + 2] = p.cell;
        patchData[i * 4 + 3] = p.level;
      }
      if (patchCount > 0) device.queue.writeBuffer(patchBuffer, 0, patchData, 0, patchCount * 4);
      ctx.perf.counter('ocean.patches', patchCount);
      active = { body, chart, ref, vf, tau, dt, cameraHeight: camAboveSea };
      const fft = ensureFft(body);
      ctx.resources.publish('ocean.displacement', fft.dispView);
      ctx.resources.publish('ocean.derivatives', fft.derivView);
    },

    compute(_frame, encoder) {
      const a = active;
      if (!a) return;
      const fft = ensureFft(a.body);
      fft.update(encoder, a.tau, a.dt, ctx.perf.gpuPass('ocean.fft') as GPUComputePassTimestampWrites | undefined);
      vessels.updateWake(encoder, a.vf, a.dt, ctx.perf.gpuPass('ocean.wake') as GPUComputePassTimestampWrites | undefined);
    },

    drawWater(_frame, pass) {
      const a = active;
      if (!a || patchCount === 0) return;
      const v = scene.version();
      if (!sceneGroup || v !== sceneVersion) {
        sceneVersion = v;
        sceneGroup = device.createBindGroup({ label: 'ocean.scene', layout: sceneLayout, entries: scene.entries() });
      }
      pass.setPipeline(pipeline.get());
      pass.setBindGroup(1, sceneGroup);
      pass.setBindGroup(2, oceanGroup(ensureFft(a.body)));
      pass.setVertexBuffer(0, gridBuffer);
      pass.setIndexBuffer(indexBuffer, 'uint16');
      pass.drawIndexed(indexCount, patchCount);
    },

    isIdle: () => coreOf(ctx).shaders.pendingCompilations() === 0,

    dispose() {
      disposed = true;
      for (const b of bodies.values()) b.fft?.dispose();
      vessels.dispose();
      for (const b of [nearFieldBuffer, uniformBuffer, patchBuffer, gridBuffer, indexBuffer]) b.destroy();
    },
  };
  return feature;
}
