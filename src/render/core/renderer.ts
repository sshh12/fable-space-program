/**
 * createRenderer: the frame graph of ARCHITECTURE section 10.0 and the implementations of the Renderer,
 * RenderContext, FrameContext, SharedResources, ShaderLibrary and PerfRecorder contracts.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import {
  NEAR_PLANE,
  RENDER_FORMATS,
  type BodyPose,
  type CameraState,
  type FrameContext,
  type LodObserver,
  type PerfSnapshot,
  type QualitySettings,
  type RenderContext,
  type RenderFeature,
  type Renderer,
  type VesselPose,
} from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { GpuHandle } from '@/core/gpu/device';
import { HASH_WGSL, mat4, v3, type Mat4 } from '@/core/math';
import { registerCore, type CoreApi, type FullscreenPipelineDesc, type ManagedTarget } from './coreApi';
import { atmosphereTransmittanceAlong, buildBodyPoses, buildProjection, buildVesselPoses, cameraBasis, jitterSequenceLength, nearestBody, planetshineAt, sunAt, sunVisibilityAt, taaJitter, type ShineLight } from './frame/math';
import { FRAME_UNIFORM_FLOATS, packFrameUniforms, type CloudShadowParams } from './frame/uniforms';
import { AmbientOcclusion } from './lighting/ao';
import { DeferredLighting } from './lighting/deferred';
import { createMeshSystem, SHADOW_PASS_WGSL } from './mesh/meshSystem';
import { TextureManager } from './mesh/textures';
import { Perf } from './perf';
import { ExposureMeter } from './post/exposureMeter';
import { EV_DARK_FLOOR, exposureFromEv100, type EmissiveHint } from './post/exposure';
import { DEFAULT_GOVERNOR, governorStep, initialGovernorState, type GovernorConfig, type GovernorState } from './post/governor';
import { PostProcess } from './post/postProcess';
import { Tonemap } from './post/tonemap';
import { createSharedResources, type CoreSharedResources } from './resources';
import { createSceneBindings } from './sceneBindings';
import { BLUE_NOISE_SIZE, FRAME_WGSL, FULLSCREEN_WGSL, GBUFFER_WGSL, MAX_BODIES, NOISE_WGSL, SHINE_RECEIVERS } from './shaders/chunksFrame';
import { ATMOSPHERE_COMMON_WGSL, BRDF_REGOLITH_WGSL, BRDF_TERRAIN_WGSL, BRDF_WATER_WGSL, BRDF_WGSL, CLOUD_SHADOW_WGSL, ECLIPSE_WGSL, LOCAL_LIGHTS_WGSL, SHADOWS_WGSL, TRANSPARENCY_WGSL, UPSAMPLE_WGSL } from './shaders/chunksLighting';
import { createShaderLibrary, type CoreShaderLibrary } from './shaders/library';
import { SpotShadows, pickShadowedSpots } from './shadows/spotShadows';
import { ShadowSystem } from './shadows/shadowSystem';
import { createTextureChecked, f16ToF32, generateBlueNoise, MipGenerator, readTexturePixels } from './util/gpu';

export interface RendererOptions {
  quality?: Partial<QualitySettings>;
  tilesUrl?: string;
  skyUrl?: string;
  assetsUrl?: string;
  /** Error sink (shader compile errors, allocation failures). Default: window.__test.errors + console.error. */
  onError?: (message: string) => void;
  /**
   * Perf attribution mode: every feature hook inside a core-owned pass (shadow, gbuffer, water, background,
   * transparent, overlay) runs in its own pass with loadOp 'load', so PerfSnapshot.features is exact.
   */
  perfFeatures?: boolean;
  governor?: Partial<GovernorConfig>;
}

export interface HdrPixels {
  width: number;
  height: number;
  /** rgba float32, row 0 = top. Pre-exposed values as stored in the target. */
  data: Float32Array;
}

export interface ExposureInfo {
  ev100: number;
  targetEv100: number;
  exposure: number;
  litFraction: number;
  histogramWeight: number;
  evPrior: number;
  evHistogram: number;
  /** Interior views (request cockpit-7): share of the frame that is lit geometry beyond the cabin, its exterior EV100, its weight. */
  outsideFraction: number;
  evOutside: number;
  outsideWeight: number;
  sunVisibility: number;
  override: number | null;
}

/** The Renderer contract plus what labs, tests and the app shell need from the core. */
export interface CoreRenderer extends Renderer {
  readonly core: CoreApi;
  readonly resources: CoreSharedResources;
  readonly canvas: HTMLCanvasElement;
  /**
   * Freeze presentation-only animation: `frame.animate` false, the blue-noise offset fixed at [0, 0],
   * qualityScale 1, maximum render scale. With `cycleNoise` the blue-noise offset (`frame.misc.zw`, what
   * `blueNoise()` and a jittered march read) keeps cycling, from the count of frames rendered since this
   * call: a ray-marched volume then gets a new jitter every frame and the temporal resolve averages it, as
   * in the running game, and two runs that render the same number of frames after the call still produce
   * identical pictures. `frame.animate` stays false (features keep their own animated noise frozen).
   */
  setDeterministic(on: boolean, opts?: { cycleNoise?: boolean }): void;
  /** Switch the sub-pixel TAA jitter off / on (off: consecutive frames are pixel-identical, for A/B readbacks). */
  setJitter(enabled: boolean): void;
  /** Force EV100 (null = automatic). */
  setExposureOverride(ev100: number | null): void;
  exposureInfo(): ExposureInfo;
  /** Read back a rectangle of the HDR scene target ('hdr', before TAA) or of the resolved TAA output ('resolved'). */
  readHdrPixels(target?: 'hdr' | 'resolved', rect?: { x: number; y: number; width: number; height: number }): Promise<HdrPixels>;
  readHdrStats(target?: 'hdr' | 'resolved'): Promise<{ maxLuminance: number; meanLuminance: number; nanPixels: number }>;
  /** Read back the reversed-Z scene depth copy ('scene.depth'), row 0 = top. */
  readDepth(): Promise<{ width: number; height: number; data: Float32Array }>;
  resetPerf(): void;
  /** p50 / p99 / mean (amortised over all frames) of every GPU pass over the measurement window, ms. */
  passStats(): Record<string, { p50: number; p99: number; mean: number }>;
  /** Ids of registered features in call order of a hook. */
  featureOrder(): string[];
  readonly frameContext: FrameContext | null;
  dispose(): void;
}

type RasterHook = 'drawShadow' | 'drawGBuffer' | 'drawWater' | 'drawBackground' | 'drawTransparent' | 'drawOverlay';

interface Targets {
  width: number;
  height: number;
  albedo: GPUTexture;
  normal: GPUTexture;
  material: GPUTexture;
  velocity: GPUTexture;
  extra: GPUTexture;
  hdr: GPUTexture;
  hdrAux: GPUTexture;
  depth: GPUTexture;
  depthOpaque: GPUTexture;
  depthCopy: GPUTexture;
  depthHalf: GPUTexture;
  colorCopy: GPUTexture | null;
  colorCopyTransparent: GPUTexture | null;
  views: Record<'albedo' | 'normal' | 'material' | 'velocity' | 'extra' | 'hdr' | 'hdrAux' | 'depth' | 'depthOpaque' | 'depthCopy' | 'depthHalf', GPUTextureView>;
}

const DEFAULT_QUALITY: QualitySettings = {
  renderScaleMin: 0.5,
  renderScaleMax: 1,
  terrainPxPerQuad: 8,
  shadowResolution: 2048,
  cloudSteps: 96,
  atmosphereSteps: 24,
};

const DEPTH_HALF_FS = /* wgsl */ `
@group(1) @binding(0) var depthTex: texture_depth_2d;
struct Out { @location(0) minMax: vec4f }
@fragment fn fs(in: FullscreenOut) -> Out {
  let size = vec2i(textureDimensions(depthTex));
  let p = vec2i(in.position.xy) * 2;
  let a = textureLoad(depthTex, min(p, size - 1), 0);
  let b = textureLoad(depthTex, min(p + vec2i(1, 0), size - 1), 0);
  let c = textureLoad(depthTex, min(p + vec2i(0, 1), size - 1), 0);
  let d = textureLoad(depthTex, min(p + vec2i(1, 1), size - 1), 0);
  // r = farthest (smallest reversed-Z), g = nearest (largest).
  return Out(vec4f(min(min(a, b), min(c, d)), max(max(a, b), max(c, d)), 0.0, 0.0));
}
`;

export async function createRenderer(canvas: HTMLCanvasElement, gpu: GpuHandle, defs: DefLibrary, opts: RendererOptions = {}): Promise<CoreRenderer> {
  const device = gpu.device;
  const reportError =
    opts.onError ??
    ((message: string): void => {
      window.__test?.errors.push(message);
      console.error(`[render-core] ${message}`);
    });
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('render core: the canvas has no WebGPU context');
  context.configure({ device, format: gpu.canvasFormat, alphaMode: 'opaque' });

  // ----------------------------------------------------------------------------------- shader library
  const shaders: CoreShaderLibrary = createShaderLibrary(device, reportError);
  shaders.register('hash', HASH_WGSL);
  shaders.register('frame', FRAME_WGSL);
  shaders.register('fullscreen', FULLSCREEN_WGSL);
  shaders.register('noise', NOISE_WGSL);
  shaders.register('gbuffer', GBUFFER_WGSL);
  shaders.register('brdf', BRDF_WGSL);
  shaders.register('brdf_terrain', BRDF_TERRAIN_WGSL);
  shaders.register('brdf_regolith', BRDF_REGOLITH_WGSL);
  shaders.register('brdf_water', BRDF_WATER_WGSL);
  shaders.register('eclipse', ECLIPSE_WGSL);
  shaders.register('local_lights', LOCAL_LIGHTS_WGSL);
  shaders.register('atmosphere_common', ATMOSPHERE_COMMON_WGSL);
  shaders.register('shadows', SHADOWS_WGSL);
  shaders.register('shadow_pass', SHADOW_PASS_WGSL);
  shaders.register('cloud_shadow', CLOUD_SHADOW_WGSL);
  shaders.register('transparency', TRANSPARENCY_WGSL);
  shaders.register('upsample', UPSAMPLE_WGSL);

  // -------------------------------------------------------------------------------------- bind group 0
  const frameBindGroupLayout = device.createBindGroupLayout({
    label: 'frame',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, sampler: { type: 'non-filtering' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, sampler: { type: 'comparison' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, texture: { sampleType: 'float' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
  const frameUniformData = new ArrayBuffer(FRAME_UNIFORM_FLOATS * 4);
  const frameF32 = new Float32Array(frameUniformData);
  const frameU32 = new Uint32Array(frameUniformData);
  const frameUniformBuffer = device.createBuffer({ label: 'frame.uniforms', size: frameUniformData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const blueNoise = device.createTexture({ label: 'frame.blueNoise', format: 'rgba8unorm', size: [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: blueNoise }, generateBlueNoise(BLUE_NOISE_SIZE, 0x5eed1234), { bytesPerRow: BLUE_NOISE_SIZE * 4 }, [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE]);
  const frameBindGroup = device.createBindGroup({
    label: 'frame',
    layout: frameBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: frameUniformBuffer } },
      { binding: 1, resource: device.createSampler({ label: 'linearClamp', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' }) },
      { binding: 2, resource: device.createSampler({ label: 'linearRepeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' }) },
      { binding: 3, resource: device.createSampler({ label: 'nearestClamp' }) },
      { binding: 4, resource: device.createSampler({ label: 'shadowCompare', magFilter: 'linear', minFilter: 'linear', compare: 'less-equal' }) },
      { binding: 5, resource: blueNoise.createView() },
      { binding: 6, resource: device.createSampler({ label: 'anisoRepeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 }) },
    ],
  });

  // ------------------------------------------------------------------------------------------ context
  const resources = createSharedResources(device);
  const perf = new Perf(device, gpu.hasFeature('timestamp-query'));
  const quality: QualitySettings = { ...DEFAULT_QUALITY, ...opts.quality };
  const ctx: RenderContext = {
    device,
    canvasFormat: gpu.canvasFormat,
    defs,
    resources,
    shaders,
    perf,
    quality,
    frameBindGroupLayout,
    tilesUrl: opts.tilesUrl ?? '/tiles',
    skyUrl: opts.skyUrl ?? '/sky',
    assetsUrl: opts.assetsUrl ?? '/assets',
  };

  const mips = new MipGenerator(device);
  const shadows = new ShadowSystem(device, resources, quality.shadowResolution, reportError);
  // Shadow maps of up to SPOT_SHADOW_MAX spot lights with castShadow (request vehicle-pad-2).
  const spotShadows = new SpotShadows(device, shadows.passLayout, reportError);
  const textures = new TextureManager(device, ctx.assetsUrl, reportError, mips);
  const meshes = createMeshSystem({ device, shaders, frameLayout: frameBindGroupLayout, shadowPassLayout: shadows.passLayout, textures, resources, reportError });

  const managed: { make: () => void; target: { texture: GPUTexture; view: GPUTextureView; size: [number, number]; version: number; alive: boolean } }[] = [];
  let cloudShadow: CloudShadowParams = { near: null, far: null };
  /** Emitters over sky pixels reported by the features in `prepare` (CoreApi.addEmissiveHint), for the next metering. */
  let emissiveHints: EmissiveHint[] = [];
  let targets: Targets | null = null;

  const fullscreenPipeline = (desc: FullscreenPipelineDesc): ReturnType<CoreApi['fullscreenPipeline']> =>
    shaders.tracked(() => {
      const module = shaders.createModule(desc.label, `#include "frame"\n#include "fullscreen"\n${desc.fragment}`);
      return device.createRenderPipeline({
        label: desc.label,
        layout: device.createPipelineLayout({ label: desc.label, bindGroupLayouts: [frameBindGroupLayout, ...(desc.layouts ?? [])] }),
        vertex: { module, entryPoint: 'fullscreenVs' },
        fragment: { module, entryPoint: 'fs', targets: desc.targets },
        primitive: { topology: 'triangle-list' },
        depthStencil: desc.depthStencil,
      });
    });

  const core: CoreApi = {
    meshes,
    shaders,
    mips,
    shadowPassLayout: shadows.passLayout,
    reportError,
    createSceneBindings: (group, first, sets) => createSceneBindings(ctx, group, first, sets),
    fullscreenPipeline,
    createTarget(label, format, scale, usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING): ManagedTarget {
      const t = { texture: null as unknown as GPUTexture, view: null as unknown as GPUTextureView, size: [1, 1] as [number, number], version: 0, alive: true };
      const make = (): void => {
        if (!t.alive) return;
        if (t.version > 0) t.texture.destroy();
        const w = Math.max(1, Math.ceil((targets?.width ?? 1) * scale));
        const h = Math.max(1, Math.ceil((targets?.height ?? 1) * scale));
        t.texture = createTextureChecked(device, { label, format, size: [w, h], usage }, reportError);
        t.view = t.texture.createView();
        t.size = [w, h];
        t.version++;
      };
      make();
      const entry = { make, target: t };
      managed.push(entry);
      return Object.assign(t, {
        destroy(): void {
          t.alive = false;
          t.texture.destroy();
          managed.splice(managed.indexOf(entry), 1);
        },
      });
    },
    setCloudShadowParams(p) {
      cloudShadow = { ...cloudShadow, ...p };
    },
    addEmissiveHint(luminance, coverage) {
      if (Number.isFinite(luminance) && Number.isFinite(coverage) && luminance > 0 && coverage > 0) emissiveHints.push({ luminance, coverage });
    },
    createTextureChecked: (desc) => createTextureChecked(device, desc, reportError),
  };
  registerCore(ctx, core);

  // ------------------------------------------------------------------------------------ core passes
  const snapshotBodyIds: string[] = [];
  let lighting: DeferredLighting | null = null;
  const ao = new AmbientOcclusion(ctx, shaders, core);
  const tonemap = new Tonemap(ctx, shaders);
  const post = new PostProcess(ctx, shaders, core, gpu.hasFeature('rg11b10ufloat-renderable'));
  const meter = new ExposureMeter(ctx, shaders);
  const depthHalfLayout = device.createBindGroupLayout({ label: 'core.depthHalf', entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } }] });
  const depthHalfPipeline = fullscreenPipeline({ label: 'core.depthHalf', fragment: DEPTH_HALF_FS, targets: [{ format: 'rg32float' }], layouts: [depthHalfLayout] });
  let depthHalfGroup: GPUBindGroup | null = null;
  let depthHalfSource: GPUTextureView | null = null;

  // ----------------------------------------------------------------------------------------- features
  const features: RenderFeature[] = [];
  const featureSeq = new Map<RenderFeature, number>();
  let seq = 0;
  const sortFeatures = (): void => {
    features.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || featureSeq.get(a)! - featureSeq.get(b)!);
    perf.setFeatureIds(features.map((f) => f.id));
  };
  const requires = (key: 'scene.colorCopy' | 'scene.colorCopyTransparent' | 'post.reactive'): boolean => features.some((f) => f.requires?.includes(key));

  // ------------------------------------------------------------------------------------------ targets
  let displayW = Math.max(1, canvas.width);
  let displayH = Math.max(1, canvas.height);
  const governorCfg: GovernorConfig = { ...DEFAULT_GOVERNOR, renderScaleMin: quality.renderScaleMin, renderScaleMax: quality.renderScaleMax, ...opts.governor };
  let governor: GovernorState = initialGovernorState(governorCfg);
  let deterministic = false;
  let cycleNoise = false;

  const tex = (label: string, format: GPUTextureFormat, w: number, h: number, usage: GPUTextureUsageFlags): GPUTexture =>
    createTextureChecked(device, { label, format, size: [w, h], usage }, reportError);

  const allocateTargets = (w: number, h: number): void => {
    if (targets && targets.width === w && targets.height === h) return;
    if (targets) {
      for (const t of [targets.albedo, targets.normal, targets.material, targets.velocity, targets.extra, targets.hdr, targets.hdrAux, targets.depth, targets.depthOpaque, targets.depthCopy, targets.depthHalf, targets.colorCopy, targets.colorCopyTransparent]) t?.destroy();
    }
    const RT = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const COPY = GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const t = {
      width: w,
      height: h,
      albedo: tex('gbuffer.albedo', RENDER_FORMATS.gbufferAlbedo, w, h, RT),
      normal: tex('gbuffer.normal', RENDER_FORMATS.gbufferNormal, w, h, RT),
      material: tex('gbuffer.material', RENDER_FORMATS.gbufferMaterial, w, h, RT),
      velocity: tex('gbuffer.velocity', RENDER_FORMATS.gbufferVelocity, w, h, RT),
      extra: tex('gbuffer.extra', RENDER_FORMATS.gbufferExtra, w, h, RT),
      hdr: tex('scene.hdr', RENDER_FORMATS.hdr, w, h, RT | COPY),
      hdrAux: tex('scene.emissive', RENDER_FORMATS.hdr, w, h, RT | COPY),
      depth: tex('scene.depthAttachment', RENDER_FORMATS.depth, w, h, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC),
      depthOpaque: tex('scene.depthOpaque', RENDER_FORMATS.depth, w, h, GPUTextureUsage.TEXTURE_BINDING | COPY),
      depthCopy: tex('scene.depth', RENDER_FORMATS.depth, w, h, GPUTextureUsage.TEXTURE_BINDING | COPY),
      depthHalf: tex('scene.depthHalf', 'rg32float', Math.ceil(w / 2), Math.ceil(h / 2), RT),
      colorCopy: null,
      colorCopyTransparent: null,
    };
    const views = {} as Targets['views'];
    for (const k of ['albedo', 'normal', 'material', 'velocity', 'extra', 'hdr', 'hdrAux', 'depth', 'depthOpaque', 'depthCopy', 'depthHalf'] as const) views[k] = t[k].createView({ label: t[k].label });
    targets = { ...t, views };
    resources.publish('scene.depthOpaque', views.depthOpaque);
    resources.publish('scene.depth', views.depthCopy);
    resources.publish('scene.depthHalf', views.depthHalf);
    // The G-buffer targets no later pass attaches, read-only for features from drawWater on (the forward
    // water reads the far sheet's inputs here). RT3 is an attachment of the water pass and is not published.
    resources.publish('gbuffer.albedo', views.albedo);
    resources.publish('gbuffer.normal', views.normal);
    resources.publish('gbuffer.material', views.material);
    resources.reset('scene.colorCopy');
    resources.reset('scene.colorCopyTransparent');
    reactive?.destroy();
    reactive = null;
    resources.reset('post.reactive');
    for (const m of managed) m.make();
    ao.resize(w, h);
    lighting?.setInputs({ albedo: views.albedo, normal: views.normal, material: views.material, extra: views.extra, emissive: views.hdrAux, ao: ao.view, aoDepth: ao.depthView });
    depthHalfGroup = null;
  };
  const ensureColorCopy = (which: 'colorCopy' | 'colorCopyTransparent'): GPUTexture => {
    const t = targets!;
    if (!t[which]) {
      t[which] = tex(`scene.${which}`, RENDER_FORMATS.hdr, t.width, t.height, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
      resources.publish(which === 'colorCopy' ? 'scene.colorCopy' : 'scene.colorCopyTransparent', t[which].createView());
    }
    return t[which];
  };
  // 'post.reactive': exists only while a feature requires it; cleared at the start of every frame.
  let reactive: GPUTexture | null = null;
  const ensureReactive = (): GPUTextureView => {
    if (!reactive) {
      reactive = tex('post.reactive', 'r8unorm', targets!.width, targets!.height, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
      resources.publish('post.reactive', reactive.createView({ label: 'post.reactive' }));
    }
    return resources.get('post.reactive');
  };
  const renderSizeFor = (scale: number): [number, number] => [Math.max(8, Math.round(displayW * scale)), Math.max(8, Math.round(displayH * scale))];

  // ------------------------------------------------------------------------------------------- state
  let frameIndex = 0;
  let jitterIndex = 0;
  let realTime = 0;
  let prevSnapshot: SimSnapshot | null = null;
  let prevCamera: CameraState | null = null;
  let prevViewProj: Mat4 = mat4.identity();
  let frameContext: FrameContext | null = null;
  let ev100 = EV_DARK_FLOOR;
  /** Exposure the TAA history was written with (0 = none yet). */
  let historyExposure = 0;
  let evInitialised = false;
  let evOverride: number | null = null;
  let disposed = false;
  let historyReset = true;
  let jitterEnabled = true;

  const runCpu = <T>(name: string, fn: () => T): T => {
    perf.cpuBegin(name);
    try {
      return fn();
    } finally {
      perf.cpuEnd(name);
    }
  };

  /**
   * Run one raster hook over all features inside a core-owned pass. Normal mode: one pass. Attribution
   * mode: a clearing pass, then one pass per feature with loadOp 'load'.
   */
  const runRasterHook = (
    encoder: GPUCommandEncoder,
    name: string,
    hook: RasterHook,
    makeDesc: (load: boolean, timestampName: string) => GPURenderPassDescriptor,
    call: (f: RenderFeature, pass: GPURenderPassEncoder) => void,
    attribution: boolean,
    coreDraw?: (pass: GPURenderPassEncoder) => void,
  ): void => {
    const list = features.filter((f) => typeof f[hook] === 'function');
    if (!attribution || list.length === 0) {
      const pass = encoder.beginRenderPass(makeDesc(false, `core.${name}`));
      pass.setBindGroup(0, frameBindGroup);
      coreDraw?.(pass);
      for (const f of list) runCpu(`${f.id}.${name}`, () => call(f, pass));
      pass.end();
      perf.setHookFeatures(name === 'overlay' ? 'core.tonemap' : `core.${name}`, list.map((f) => f.id), Boolean(coreDraw));
      return;
    }
    const first = encoder.beginRenderPass(makeDesc(false, `core.${name}.clear`));
    first.setBindGroup(0, frameBindGroup);
    coreDraw?.(first);
    first.end();
    for (const f of list) {
      const pass = encoder.beginRenderPass(makeDesc(true, `${f.id}.${name}`));
      pass.setBindGroup(0, frameBindGroup);
      runCpu(`${f.id}.${name}`, () => call(f, pass));
      pass.end();
    }
  };

  const litObjectInView = (snapshot: SimSnapshot, camera: CameraState, bodies: BodyPose[], vessels: VesselPose[], renderH: number, aspect: number): boolean => {
    const basis = cameraBasis(camera);
    const tanY = Math.tan(camera.fovY / 2);
    const tanX = tanY * aspect;
    const pxPerRad = renderH / camera.fovY;
    const inFrustum = (c: { x: number; y: number; z: number }, r: number): boolean => {
      const z = v3.dot(c, basis.forward);
      const x = v3.dot(c, basis.right);
      const y = v3.dot(c, basis.up);
      return z > -r && Math.abs(x) < z * tanX + r * Math.hypot(1, tanX) && Math.abs(y) < z * tanY + r * Math.hypot(1, tanY);
    };
    for (const b of bodies) {
      if (b.id === snapshot.starId) continue;
      const def = defs.bodies[b.id];
      if (!def) continue;
      const d = v3.len(b.centerRelCam);
      if (!inFrustum(b.centerRelCam, def.radius)) continue;
      if (b.cameraAltitude < 0.1 * def.radius) {
        // Standing on or flying low over the body: lit when the sun is above (or just below) the local horizon.
        if (v3.dot(v3.scale(b.centerRelCam, -1 / d), b.sunDir) > -0.1) return true;
        continue;
      }
      if (Math.asin(Math.min(1, def.radius / d)) * pxPerRad < 4) continue;
      // Fraction of the visible disc that is sunlit: (1 + cos(phase)) / 2.
      const cosPhase = v3.dot(v3.scale(b.centerRelCam, -1 / d), b.sunDir);
      if ((1 + cosPhase) / 2 > 0.002) return true;
    }
    for (let i = 0; i < vessels.length; i++) {
      const v = vessels[i]!;
      const s = snapshot.vessels[i];
      if (!s || s.sunVisibility <= 0) continue;
      const d = Math.max(v3.len(v.originRelCam), 1e-3);
      if ((s.boundingRadius / d) * pxPerRad >= 2 && inFrustum(v.originRelCam, s.boundingRadius)) return true;
    }
    return false;
  };

  /** True when the point is outside the atmosphere shell of every body (in space). */
  const aboveEveryAtmosphere = (point: { x: number; y: number; z: number }, snapshot: SimSnapshot, d: DefLibrary): boolean => {
    for (const b of snapshot.bodies) {
      const def = d.bodies[b.id];
      if (def?.render.atmosphere && v3.dist(point, b.rRoot) < def.radius + def.render.atmosphere.topAltitude) return false;
    }
    return true;
  };

  const sunInView = (camera: CameraState, dir: { x: number; y: number; z: number }, angularRadius: number, aspect: number): boolean => {
    const basis = cameraBasis(camera);
    const z = v3.dot(dir, basis.forward);
    if (z <= 0) return false;
    const tanY = Math.tan(camera.fovY / 2);
    const m = Math.tan(angularRadius);
    return Math.abs(v3.dot(dir, basis.right)) / z < tanY * aspect + m && Math.abs(v3.dot(dir, basis.up)) / z < tanY + m;
  };

  // ------------------------------------------------------------------------------------------ render
  const render = (snapshot: SimSnapshot, camera: CameraState, observers: LodObserver[], realDt: number): void => {
    if (disposed) return;
    const now = performance.now();
    perf.beginFrame(now);
    perf.cpuBegin('core.render');
    perf.cpuBegin('core.frame');
    if (!prevSnapshot || !prevCamera) {
      prevSnapshot = snapshot;
      prevCamera = camera;
      historyReset = true;
    }
    if (!lighting) {
      snapshotBodyIds.push(...snapshot.bodies.slice(0, MAX_BODIES).map((b) => b.id));
      lighting = new DeferredLighting(ctx, shaders, defs, snapshotBodyIds);
      lighting.setSpotShadows(spotShadows.arrayView, spotShadows.uniform);
    }

    // Governor and dynamic resolution (off while deterministic).
    const gpuMs = perf.takeGpuMs();
    if (deterministic) governor = { ...governor, qualityScale: 1, renderScale: governorCfg.renderScaleMax, cooldown: 0 };
    else governor = governorStep(governor, gpuMs, governorCfg);
    const [rw, rh] = renderSizeFor(governor.renderScale);
    allocateTargets(rw, rh);
    post.resize(displayW, displayH);
    const T = targets!;
    if (context.getConfiguration()?.device !== device) context.configure({ device, format: gpu.canvasFormat, alphaMode: 'opaque' });

    // Camera, jitter, projection.
    const animate = !deterministic;
    if (animate) realTime += realDt;
    const jitterPx: [number, number] = post.temporal && jitterEnabled ? taaJitter(jitterIndex, jitterSequenceLength(rw / displayW)) : [0, 0];
    const projection = buildProjection(camera.fovY, rw, rh, jitterPx);
    const view = mat4.viewRotation(camera.qViewToRoot);
    const basis = cameraBasis(camera);
    const prevEyeOffset = v3.sub(prevCamera.positionRoot, camera.positionRoot);
    const bodies = buildBodyPoses(snapshot, prevSnapshot, camera, prevCamera, defs);
    const vessels = buildVesselPoses(snapshot, prevSnapshot, camera, prevCamera);
    const sun = sunAt(camera.positionRoot, snapshot, defs);
    const sunVisibility = sunVisibilityAt(camera.positionRoot, snapshot, defs, sun);

    // Exposure: meter (histogram from a few frames ago), adapt, or take the override.
    const sunDiscInView = sunVisibility > 0 && sunInView(camera, sun.dirRoot, sun.angularRadius, rw / rh);
    // A camera in space meters with the sun's illuminance AFTER the air between it and the sun (request
    // sky-lighting-10: just over the limb that air leaves a few per cent; what is near the camera is lit by
    // the same light); with the disc in the frame that light is also a floor of the exposure. A camera inside
    // an atmosphere keeps the unattenuated value (its scene is lit through other air than its own line of sight).
    let sunAtCamera = sun.illuminance;
    let sunInFrame: number | undefined;
    if (aboveEveryAtmosphere(camera.positionRoot, snapshot, defs)) {
      const t = atmosphereTransmittanceAlong(camera.positionRoot, sun.dirRoot, snapshot, defs);
      sunAtCamera = sun.illuminance * (0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]);
      if (sunDiscInView) sunInFrame = sunAtCamera * sunVisibility;
    }
    const metering = meter.evaluate({
      sunIlluminance: sunAtCamera,
      sunVisibility,
      // The solar disc itself counts: a camera pointed at the unoccluded sun stops down to the daylight exposure.
      litObjectInView: litObjectInView(snapshot, camera, bodies, vessels, rh, rw / rh) || sunDiscInView,
      ...(sunInFrame !== undefined ? { sunInFrame } : {}),
      kind: camera.kind,
      exposureCompensation: camera.exposureCompensation,
      minEv100: camera.minEv100,
      // What the features reported in the previous frame's prepare (this frame's hooks have not run yet).
      emissive: emissiveHints,
    });
    emissiveHints = [];
    if (evOverride !== null) ev100 = evOverride;
    else if (!evInitialised) ev100 = metering.targetEv100;
    else ev100 = meter.adapt(ev100, metering.targetEv100, Math.min(realDt, 0.1));
    evInitialised = true;
    const exposure = exposureFromEv100(ev100);

    const bodyById = new Map(bodies.map((b) => [b.id, b]));
    const vesselById = new Map(vessels.map((v) => [v.id, v]));
    const frame: FrameContext = {
      frameIndex,
      realTime,
      realDt,
      snapshot,
      prevSnapshot,
      camera,
      prevCamera,
      renderSize: [rw, rh],
      displaySize: [displayW, displayH],
      view,
      proj: projection.proj,
      projUnjittered: projection.projUnjittered,
      prevViewProj,
      prevEyeOffset,
      jitterPx,
      bodies,
      vessels,
      bodyPose(id) {
        const p = bodyById.get(id);
        if (!p) throw new Error(`FrameContext.bodyPose: unknown body "${id}"`);
        return p;
      },
      vesselPose: (id) => vesselById.get(id),
      sun: { dirRoot: sun.dirRoot, illuminance: sun.illuminance, color: sun.color, angularRadius: sun.angularRadius, bodyId: sun.bodyId },
      exposure,
      ev100,
      qualityScale: governor.qualityScale,
      observers,
      lights: [],
      frameBindGroup,
      animate,
    };
    frameContext = frame;
    perf.cpuEnd('core.frame');

    // Shadow cascades are planned before prepare so features can cull against them.
    const shadowTargets = runCpu('core.shadowPlan', () => shadows.update(frame, snapshot, camera, defs));

    for (const f of features) if (f.prepare) runCpu(`${f.id}.prepare`, () => f.prepare!(frame));

    // Frame uniforms are written after prepare (lights and cloud-shadow placement are registered there).
    perf.cpuBegin('core.uniforms');
    const shine: ShineLight[][] = [];
    for (let i = 0; i < Math.min(MAX_BODIES, snapshot.bodies.length); i++) {
      const b = snapshot.bodies[i]!;
      shine.push(b.id === snapshot.starId ? [] : planetshineAt(b.rRoot, b.id, snapshot, defs));
    }
    while (shine.length < SHINE_RECEIVERS - 1) shine.push([]);
    const near = nearestBody(camera.positionRoot, snapshot, defs);
    // Free space at the camera: every body that is far enough for the far-field formula (others fade out).
    shine.push(planetshineAt(camera.positionRoot, near && near.altitude < 0.5 * near.def.radius ? near.body.id : null, snapshot, defs));
    // Spot lights that get a shadow map this frame (after prepare: the features have registered their lights).
    const spotPasses = spotShadows.update(pickShadowedSpots(frame.lights));
    const spotShadowIndex = new Map(spotPasses.map((p) => [p.light, p.index] as const));
    packFrameUniforms(frameF32, frameU32, frame, {
      spotShadowIndex,
      projection,
      prevEyeOffset,
      basis,
      renderScale: governor.renderScale,
      sunVisibility,
      noiseOffset: animate ? [(frameIndex * 37) % BLUE_NOISE_SIZE, (frameIndex * 23) % BLUE_NOISE_SIZE] : cycleNoise ? [(jitterIndex * 37) % BLUE_NOISE_SIZE, (jitterIndex * 23) % BLUE_NOISE_SIZE] : [0, 0],
      cloudShadow,
      shine,
      defs,
      near: NEAR_PLANE,
    });
    device.queue.writeBuffer(frameUniformBuffer, 0, frameUniformData);
    perf.cpuEnd('core.uniforms');

    const attribution = Boolean(opts.perfFeatures) || (!deterministic && frameIndex % 64 === 32);
    const encoder = device.createCommandEncoder({ label: `frame ${frameIndex}` });

    // The reactive mask starts every frame at 0 (features draw into it in compositeAtmosphere / preTransparent).
    if (requires('post.reactive')) {
      encoder.beginRenderPass({ label: 'reactive.clear', colorAttachments: [{ view: ensureReactive(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }], timestampWrites: perf.gpuPass('core.reactive.clear') }).end();
    } else if (reactive) {
      reactive.destroy();
      reactive = null;
      resources.reset('post.reactive');
    }

    // 1. compute
    for (const f of features) if (f.compute) runCpu(`${f.id}.compute`, () => f.compute!(frame, encoder));

    // 2. sun shadow cascades (only those re-rendered this frame)
    for (const st of shadowTargets) {
      runRasterHook(
        encoder,
        'shadow',
        'drawShadow',
        (load, ts) => ({
          label: `shadow.layer${st.view.index}`,
          colorAttachments: [],
          depthStencilAttachment: { view: st.attachment, depthClearValue: 1, depthLoadOp: load ? 'load' : 'clear', depthStoreOp: 'store' },
          timestampWrites: perf.gpuPass(ts),
        }),
        (f, pass) => {
          pass.setBindGroup(1, st.bindGroup);
          f.drawShadow!(frame, pass, st.view);
        },
        attribution,
      );
    }
    // 2a. spot-light shadow maps: the core mesh system's casters (request vehicle-pad-2)
    for (const sp of spotPasses) {
      const pass = encoder.beginRenderPass({
        label: `shadow.spot${sp.index}`,
        colorAttachments: [],
        depthStencilAttachment: { view: sp.attachment, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
        timestampWrites: perf.gpuPass('core.spotShadows'),
      });
      pass.setBindGroup(0, frameBindGroup);
      pass.setBindGroup(1, sp.bindGroup);
      meshes.drawSpotShadows(pass, sp.viewProj, frameIndex);
      pass.end();
    }
    perf.counter('spotShadows', spotPasses.length);
    perf.counter('shadowCascades', shadows.current().length);
    perf.counter('shadowCascadesRendered', shadowTargets.length);

    // 3. G-buffer
    const color = (view_: GPUTextureView, load: boolean, clear: GPUColor = { r: 0, g: 0, b: 0, a: 0 }): GPURenderPassColorAttachment => ({ view: view_, clearValue: clear, loadOp: load ? 'load' : 'clear', storeOp: 'store' });
    runRasterHook(
      encoder,
      'gbuffer',
      'drawGBuffer',
      (load, ts) => ({
        label: 'gbuffer',
        colorAttachments: [color(T.views.albedo, load), color(T.views.normal, load), color(T.views.material, load), color(T.views.velocity, load), color(T.views.extra, load, { r: 0, g: 0.5, b: 0, a: 0 }), color(T.views.hdrAux, load)],
        depthStencilAttachment: { view: T.views.depth, depthClearValue: 0, depthLoadOp: load ? 'load' : 'clear', depthStoreOp: 'store' },
        timestampWrites: perf.gpuPass(ts),
      }),
      (f, pass) => f.drawGBuffer!(frame, pass),
      attribution,
    );

    // 3a. depth -> 'scene.depthOpaque'. Copies run between passes: perf.gpuGap times each as the gap between its
    // neighbours; the frame's sum is reported as 'core.copies'.
    encoder.copyTextureToTexture({ texture: T.depth }, { texture: T.depthOpaque }, [rw, rh]);
    perf.gpuGap('core.copies');

    // 4. AO + contact shadows, deferred lighting
    ao.run(encoder, frame, perf, frameBindGroup, T.views.normal);
    {
      const pass = encoder.beginRenderPass({
        label: 'lighting',
        colorAttachments: [color(T.views.hdr, false)],
        depthStencilAttachment: { view: T.views.depth, depthReadOnly: true },
        timestampWrites: perf.gpuPass('core.lighting'),
      });
      pass.setBindGroup(0, frameBindGroup);
      lighting.draw(pass);
      pass.end();
    }

    // 4a. HDR -> 'scene.colorCopy' (only when a feature requires it)
    if (requires('scene.colorCopy')) {
      encoder.copyTextureToTexture({ texture: T.hdr }, { texture: ensureColorCopy('colorCopy') }, [rw, rh]);
      perf.gpuGap('core.copies');
    }

    // 5. forward water (skipped entirely when no feature draws water)
    const hasWater = features.some((f) => f.drawWater);
    if (hasWater) {
      runRasterHook(
        encoder,
        'water',
        'drawWater',
        (_load, ts) => ({
          label: 'water',
          colorAttachments: [color(T.views.hdr, true), color(T.views.velocity, true)],
          depthStencilAttachment: { view: T.views.depth, depthLoadOp: 'load', depthStoreOp: 'store' },
          timestampWrites: perf.gpuPass(ts),
        }),
        (f, pass) => f.drawWater!(frame, pass),
        attribution,
      );
    }

    // 5a. depth -> 'scene.depth', min/max downsample -> 'scene.depthHalf'
    encoder.copyTextureToTexture({ texture: T.depth }, { texture: T.depthCopy }, [rw, rh]);
    perf.gpuGap('core.copies');
    {
      if (!depthHalfGroup || depthHalfSource !== T.views.depthCopy) {
        depthHalfSource = T.views.depthCopy;
        depthHalfGroup = device.createBindGroup({ label: 'core.depthHalf', layout: depthHalfLayout, entries: [{ binding: 0, resource: T.views.depthCopy }] });
      }
      const pass = encoder.beginRenderPass({ label: 'depthHalf', colorAttachments: [color(T.views.depthHalf, false)], timestampWrites: perf.gpuPass('core.depthHalf') });
      pass.setBindGroup(0, frameBindGroup);
      pass.setPipeline(depthHalfPipeline.get());
      pass.setBindGroup(1, depthHalfGroup);
      pass.draw(3);
      pass.end();
    }

    // 6. background where depth == 0
    if (features.some((f) => f.drawBackground)) {
      runRasterHook(
        encoder,
        'background',
        'drawBackground',
        (_load, ts) => ({
          label: 'background',
          colorAttachments: [color(T.views.hdr, true)],
          depthStencilAttachment: { view: T.views.depth, depthReadOnly: true },
          timestampWrites: perf.gpuPass(ts),
        }),
        (f, pass) => f.drawBackground!(frame, pass),
        attribution,
      );
    }

    // 7. atmosphere + clouds, 8. offscreen transparents (features create their own passes)
    for (const f of features) if (f.compositeAtmosphere) runCpu(`${f.id}.compositeAtmosphere`, () => f.compositeAtmosphere!(frame, encoder, T.views.hdr));
    for (const f of features) if (f.preTransparent) runCpu(`${f.id}.preTransparent`, () => f.preTransparent!(frame, encoder));

    // 8a. HDR -> 'scene.colorCopyTransparent' (only when required)
    if (requires('scene.colorCopyTransparent')) {
      encoder.copyTextureToTexture({ texture: T.hdr }, { texture: ensureColorCopy('colorCopyTransparent') }, [rw, rh]);
      perf.gpuGap('core.copies');
    }

    // 8b. exposure histogram of what is LIT: opaque geometry, water, atmosphere and clouds, before anything
    // that emits in front of them is drawn (a flame over the pad must not stop the camera down: request vfx-4).
    meter.run(encoder, frame, perf, frameBindGroup, T.views.hdr, T.views.depthCopy);

    // 9. transparents
    if (features.some((f) => f.drawTransparent)) {
      runRasterHook(
        encoder,
        'transparent',
        'drawTransparent',
        (_load, ts) => ({
          label: 'transparent',
          colorAttachments: [color(T.views.hdr, true)],
          depthStencilAttachment: { view: T.views.depth, depthReadOnly: true },
          timestampWrites: perf.gpuPass(ts),
        }),
        (f, pass) => f.drawTransparent!(frame, pass),
        attribution,
      );
    }

    // 10. TAA / TAAU, bloom, tonemap; 11. LDR overlay
    const warp = snapshot.warp.factor;
    const viewTurn = 2 * Math.acos(Math.min(1, Math.abs(camera.qViewToRoot.x * prevCamera.qViewToRoot.x + camera.qViewToRoot.y * prevCamera.qViewToRoot.y + camera.qViewToRoot.z * prevCamera.qViewToRoot.z + camera.qViewToRoot.w * prevCamera.qViewToRoot.w)));
    const resolved = post.run(encoder, frame, perf, frameBindGroup, {
      hdr: T.views.hdr,
      velocity: T.views.velocity,
      depth: T.views.depthCopy,
      reset: historyReset,
      // rendering-design 2.4: fast view rotation or high warp halves the history weight.
      historyScale: viewTurn > (2 * Math.PI) / 180 || warp >= 50 ? 0.5 : 1,
      exposureRatio: historyExposure > 0 ? exposure / historyExposure : 1,
      reactive: resources.get('post.reactive'),
    });
    historyExposure = exposure;
    historyReset = false;
    const canvasView = context.getCurrentTexture().createView({ label: 'canvas' });
    runRasterHook(
      encoder,
      'overlay',
      'drawOverlay',
      (load, ts) => ({ label: 'tonemap+overlay', colorAttachments: [color(canvasView, load, { r: 0, g: 0, b: 0, a: 1 })], timestampWrites: perf.gpuPass(ts.replace('core.overlay', 'core.tonemap')) }),
      (f, pass) => f.drawOverlay!(frame, pass),
      attribution,
      (pass) => tonemap.draw(pass, resolved.color, resolved.bloom, { bloomMix: resolved.bloomMix, sharpness: resolved.sharpness, dither: 1 }),
    );

    perf.cpuEnd('core.render');
    perf.counter('renderWidth', rw);
    perf.counter('renderHeight', rh);
    perf.counter('ev100', ev100);
    const after = perf.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    after?.();
    meter.afterSubmit();

    // History for the next frame's motion vectors: unjittered proj * view of this frame.
    prevViewProj = mat4.mul(projection.projUnjittered, view);
    prevSnapshot = snapshot;
    prevCamera = camera;
    frameIndex++;
    jitterIndex = deterministic ? jitterIndex + 1 : frameIndex;
  };

  const perfSnapshot = (): PerfSnapshot => perf.snapshot(governor.qualityScale, governor.renderScale);
  // window.__perf is computed on access (percentiles over the window are not free).
  Object.defineProperty(window, '__perf', { get: perfSnapshot, configurable: true });

  const readHdrPixels: CoreRenderer['readHdrPixels'] = async (target = 'hdr', rect) => {
    const texture = target === 'hdr' ? targets?.hdr : post.resolvedTexture();
    if (!texture) throw new Error('readHdrPixels: nothing has been rendered yet');
    const r = rect ?? { x: 0, y: 0, width: texture.width, height: texture.height };
    const raw = new Uint16Array(await readTexturePixels(device, texture, r, 8));
    const data = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = f16ToF32(raw[i]!);
    return { width: r.width, height: r.height, data };
  };

  const renderer: CoreRenderer = {
    context: ctx,
    core,
    resources,
    canvas,
    get frameContext() {
      return frameContext;
    },
    async addFeature(feature) {
      if (features.some((f) => f.id === feature.id)) throw new Error(`render core: duplicate feature id "${feature.id}"`);
      await feature.init(ctx);
      featureSeq.set(feature, seq++);
      features.push(feature);
      sortFeatures();
    },
    resize(w, h) {
      displayW = Math.max(1, Math.floor(w));
      displayH = Math.max(1, Math.floor(h));
      if (canvas.width !== displayW) canvas.width = displayW;
      if (canvas.height !== displayH) canvas.height = displayH;
      historyReset = true;
    },
    render,
    isIdle() {
      if (shaders.pendingCompilations() > 0 || !meshes.isIdle()) return false;
      return features.every((f) => (f.isIdle ? f.isIdle() : true));
    },
    perfSnapshot,
    readHdrPixels,
    async readHdrStats(target = 'hdr') {
      const px = await readHdrPixels(target);
      let max = 0;
      let sum = 0;
      let nan = 0;
      const d = px.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i]!;
        const g = d[i + 1]!;
        const b = d[i + 2]!;
        if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
          nan++;
          continue;
        }
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (l > max) max = l;
        sum += l;
      }
      return { maxLuminance: max, meanLuminance: sum / Math.max(1, d.length / 4 - nan), nanPixels: nan };
    },
    async readDepth() {
      if (!targets) throw new Error('readDepth: nothing has been rendered yet');
      const { width, height } = targets;
      return { width, height, data: new Float32Array(await readTexturePixels(device, targets.depthCopy, { x: 0, y: 0, width, height }, 4)) };
    },
    setDeterministic(on, o) {
      const cycle = on && Boolean(o?.cycleNoise);
      if (deterministic === on && cycleNoise === cycle) return;
      deterministic = on;
      cycleNoise = cycle;
      jitterIndex = 0;
      historyReset = true;
    },
    setExposureOverride(ev) {
      evOverride = ev;
    },
    setJitter(enabled) {
      jitterEnabled = enabled;
    },
    exposureInfo() {
      const m = meter.last();
      return { ev100, targetEv100: m.targetEv100, exposure: exposureFromEv100(ev100), litFraction: m.litFraction, histogramWeight: m.histogramWeight, evPrior: m.evPrior, evHistogram: m.evHistogram, outsideFraction: m.outsideFraction, evOutside: m.evOutside, outsideWeight: m.outsideWeight, sunVisibility: meter.lastSunVisibility(), override: evOverride };
    },
    resetPerf: () => perf.reset(),
    passStats: () => perf.passStats(),
    featureOrder: () => features.map((f) => f.id),
    dispose() {
      disposed = true;
      for (const f of features) f.dispose?.();
    },
  };

  // Compile the core pipelines now so that shader errors surface before the first frame.
  tonemap.warm();
  ao.warm();
  post.warm();
  meter.warm();
  return renderer;
}
