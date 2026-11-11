/**
 * Volumetric clouds of the atmosphere feature: noise and coverage resources, the quarter-area march with
 * its temporal checkerboard resolve ('clouds.screen', 'clouds.depth'), and the cloud shadows
 * ('clouds.shadowMap' around the camera, 'clouds.coverageMap' beyond) with their placement handed to the
 * render core every frame through coreOf(ctx).setCloudShadowParams.
 */
import type { BodyDef } from '@/core/contracts/defs';
import type { BodyPose, FrameContext, RenderContext } from '@/core/contracts/render';
import type { TileManifest } from '@/core/contracts/terrain';
import { DEG, mat3, quat, v3, type Vec3 } from '@/core/math';
import { coreOf, f16ToF32, readTexturePixels, type CoreApi, type ManagedTarget, type Tracked } from '@/render/core';
import { resolveCloudParams, type CloudParams } from './params';
import type { MarchBody } from './select';
import { FINE_TILE_SIZE, scissorOf } from './select';
import { CLOUD_DENSITY_WGSL, cloudMarchFsWgsl, CLOUD_NOISE_COMPUTE_WGSL, CLOUD_RESOLVE_FS_WGSL, CLOUD_SHADOW_FS_WGSL } from './shaders/clouds';
import type { AtmoUniforms } from './uniforms';

/** Equirectangular coverage map: row 0 = north, column 0 = longitude -180 deg; two bytes per texel (coverage, cloud top / 50 m). */
export interface CoverageImage {
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer>;
}

export interface CloudSystemOptions {
  id: string;
  coverageMaps?: Record<string, CoverageImage>;
}

interface CoverageEntry {
  state: 'loading' | 'ready' | 'absent';
  view: GPUTextureView | null;
  texture: GPUTexture | null;
  width: number;
}

export interface CloudShadowPlacement {
  bodyIndex: number;
  originRelCam: Vec3;
  axisU: Vec3;
  axisV: Vec3;
  /** Unit projection direction (towards the sun). */
  dir: Vec3;
  halfExtent: number;
  opticalDepthScale: number;
}

const BASE_SIZE = 128;
const DETAIL_SIZE = 32;
/** The projection of the shadow map is kept at least this far above the horizon of the map centre. */
const SHADOW_MIN_ELEVATION = 4 * DEG;
/** Below this sun elevation at the map centre the near map is switched off (the ground is unlit). */
const SHADOW_OFF_ELEVATION = -2 * DEG;
const SHADOW_MAX_HALF_EXTENT = 2.5e6;

const mod = (x: number, m: number): number => ((x % m) + m) % m;

/**
 * Histogram-equalise `values` (in [0, 1]) in place, so that their distribution becomes uniform: a
 * threshold at 1 - c then selects exactly the fraction c of the volume.
 */
export function equalise(values: Float32Array): void {
  const bins = 4096;
  const hist = new Float64Array(bins);
  for (let i = 0; i < values.length; i++) hist[Math.min(bins - 1, Math.max(0, Math.floor(values[i]! * bins)))]! += 1;
  const cdf = new Float64Array(bins + 1);
  for (let b = 0; b < bins; b++) cdf[b + 1] = cdf[b]! + hist[b]! / values.length;
  for (let i = 0; i < values.length; i++) {
    const x = Math.min(Math.max(values[i]! * bins, 0), bins - 1e-6);
    const b = Math.floor(x);
    values[i] = cdf[b]! + (cdf[b + 1]! - cdf[b]!) * (x - b);
  }
}

/** 2 x 2 x 2 box filter of an n^3 volume with `channels` interleaved float channels. */
export function downsampleVolume(src: Float32Array, n: number, channels: number): Float32Array {
  const m = n >> 1;
  const out = new Float32Array(m * m * m * channels);
  for (let z = 0; z < m; z++) {
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        for (let c = 0; c < channels; c++) {
          let s = 0;
          for (let k = 0; k < 8; k++) s += src[(((2 * z + (k >> 2)) * n + 2 * y + ((k >> 1) & 1)) * n + 2 * x + (k & 1)) * channels + c]!;
          out[((z * m + y) * m + x) * channels + c] = s / 8;
        }
      }
    }
  }
  return out;
}

/** Standard deviation of one channel of an interleaved volume. */
export function channelStd(data: Float32Array, channels: number, channel: number): number {
  let s = 0;
  let s2 = 0;
  const n = data.length / channels;
  for (let i = 0; i < n; i++) {
    const v = data[i * channels + channel]!;
    s += v;
    s2 += v * v;
  }
  const mean = s / n;
  return Math.sqrt(Math.max(s2 / n - mean * mean, 0));
}

/**
 * The clock the clouds move by: simulation time, but never more than `maxRate` times faster than real time
 * (under time warp the weather does not race), and never backwards. `lastUt` = null on the first frame.
 */
export function advanceCloudClock(cloudTime: number, lastUt: number | null, ut: number, realDt: number, maxRate: number): number {
  if (lastUt === null) return ut;
  return cloudTime + Math.max(0, Math.min(ut - lastUt, realDt * maxRate));
}

export class CloudSystem {
  private readonly ctx: RenderContext;
  private readonly core: CoreApi;
  private readonly device: GPUDevice;
  private readonly id: string;

  // --- noise
  private baseNoise: GPUTextureView;
  private detailNoise: GPUTextureView;
  private noiseReady = false;
  private noiseFade: number[] = [0, 0, 0, 0, 0, 0, 0, 0];

  // --- coverage
  private readonly coverage = new Map<string, CoverageEntry>();
  private readonly neutralCoverage: GPUTextureView;
  private coverageNow: GPUTextureView;
  private tilesets: Promise<string[] | null> | null = null;

  // --- targets
  private readonly quarterColor: ManagedTarget;
  private readonly quarterGeom: ManagedTarget;
  private readonly screen: ManagedTarget;
  private readonly depth: ManagedTarget;
  private readonly historyColor: ManagedTarget;
  private readonly geom: ManagedTarget;
  private readonly historyGeom: ManagedTarget;
  private readonly fineColor: GPUTexture;
  private readonly fineGeom: GPUTexture;
  private readonly fineColorTexView: GPUTextureView;
  private readonly fineGeomTexView: GPUTextureView;
  private shadowTex: GPUTexture;
  private shadowScratch: GPUTexture;
  private shadowTexView: GPUTextureView;
  private shadowScratchView: GPUTextureView;
  private shadowSize = 0;

  // --- pipelines
  private readonly marchLayout: GPUBindGroupLayout;
  private readonly marchFineLayout: GPUBindGroupLayout;
  private readonly resolveLayout: GPUBindGroupLayout;
  private readonly shadowLayout: GPUBindGroupLayout;
  private readonly marchPipeline: Tracked<GPURenderPipeline>;
  private readonly marchFinePipeline: Tracked<GPURenderPipeline>;
  private readonly resolvePipeline: Tracked<GPURenderPipeline>;
  private readonly shadowPipeline: Tracked<GPURenderPipeline>;
  private marchGroup: GPUBindGroup | null = null;
  private marchFineGroup: GPUBindGroup | null = null;
  private resolveGroup: GPUBindGroup | null = null;
  private shadowGroup: GPUBindGroup | null = null;
  private groupKey = '';
  private resourceVersion = 0;

  // --- per-frame state
  private readonly params = new Map<string, CloudParams>();
  private bodyId: string | null = null;
  private current: CloudParams | null = null;
  private cloudTime = 0;
  private lonOffset = 0;
  private lastUt: number | null = null;
  private lastMarchFrame = -10;
  private lastTargetKey = '';
  private lastExposure = 1;
  private historyValid = false;
  /** Checkerboard phase of this frame, 0..3. */
  phase = 0;

  // --- shadow map placement
  private anchorFixed: Vec3 | null = null;
  private anchorBody: string | null = null;
  private shadowHalfExtent = 0;
  private shadowIJ: [number, number] = [0, 0];
  private shadowValid = false;
  private shadowOn = false;
  private placement: CloudShadowPlacement | null = null;

  constructor(
    ctx: RenderContext,
    private readonly uniformBuffer: GPUBuffer,
    private readonly options: CloudSystemOptions,
  ) {
    this.ctx = ctx;
    this.core = coreOf(ctx);
    const device = (this.device = ctx.device);
    const id = (this.id = options.id);
    ctx.shaders.register('atmosphere_cloud_density', CLOUD_DENSITY_WGSL);

    const neutral3d = (label: string): GPUTextureView => {
      const t = device.createTexture({ label, format: 'rgba8unorm', dimension: '3d', size: [1, 1, 1], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture: t }, new Uint8Array([128, 128, 128, 128]), {}, [1, 1, 1]);
      return t.createView();
    };
    this.baseNoise = neutral3d(`${id}.cloudNoise.pending`);
    this.detailNoise = this.baseNoise;
    const cov = device.createTexture({ label: `${id}.coverage.neutral`, format: 'rg8unorm', size: [1, 1], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: cov }, new Uint8Array([0, 0, 0, 0]), {}, [1, 1]);
    this.neutralCoverage = this.coverageNow = cov.createView();

    const RT = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.quarterColor = this.core.createTarget(`${id}.cloud.fresh`, 'rgba16float', 0.25);
    this.quarterGeom = this.core.createTarget(`${id}.cloud.freshGeom`, 'rgba32float', 0.25);
    this.screen = this.core.createTarget(`${id}.cloud.screen`, 'rgba16float', 0.5, RT | GPUTextureUsage.COPY_SRC);
    this.depth = this.core.createTarget(`${id}.cloud.depth`, 'r32float', 0.5);
    this.geom = this.core.createTarget(`${id}.cloud.geom`, 'rgba32float', 0.5, RT | GPUTextureUsage.COPY_SRC);
    this.historyColor = this.core.createTarget(`${id}.cloud.history`, 'rgba16float', 0.5, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    this.historyGeom = this.core.createTarget(`${id}.cloud.historyGeom`, 'rgba32float', 0.5, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    const tile = (label: string, format: GPUTextureFormat): GPUTexture => this.core.createTextureChecked({ label, format, size: [FINE_TILE_SIZE, FINE_TILE_SIZE], usage: RT });
    this.fineColor = tile(`${id}.cloud.fine`, 'rgba16float');
    this.fineGeom = tile(`${id}.cloud.fineGeom`, 'rgba32float');
    this.fineColorTexView = this.fineColor.createView();
    this.fineGeomTexView = this.fineGeom.createView();
    this.shadowTex = this.shadowScratch = null as unknown as GPUTexture;
    this.shadowTexView = this.shadowScratchView = null as unknown as GPUTextureView;
    this.allocateShadow(1024);

    const F = GPUShaderStage.FRAGMENT;
    const tex = (binding: number, sampleType: GPUTextureSampleType = 'float', viewDimension: GPUTextureViewDimension = '2d'): GPUBindGroupLayoutEntry => ({ binding, visibility: F, texture: { sampleType, viewDimension } });
    const uniform: GPUBindGroupLayoutEntry = { binding: 0, visibility: F, buffer: { type: 'uniform' } };
    this.marchLayout = device.createBindGroupLayout({
      label: `${id}.cloudMarch`,
      entries: [uniform, tex(1), tex(2, 'float', '3d'), tex(3, 'float', '3d'), tex(4, 'float', '2d-array'), tex(5, 'float', '2d-array'), tex(6), tex(7, 'unfilterable-float')],
    });
    this.marchFineLayout = device.createBindGroupLayout({
      label: `${id}.cloudMarchFine`,
      entries: [uniform, tex(1), tex(2, 'float', '3d'), tex(3, 'float', '3d'), tex(4, 'float', '2d-array'), tex(5, 'float', '2d-array'), tex(6), tex(7, 'depth')],
    });
    this.resolveLayout = device.createBindGroupLayout({
      label: `${id}.cloudResolve`,
      entries: [uniform, tex(1, 'unfilterable-float'), tex(2, 'unfilterable-float'), tex(3), tex(4, 'unfilterable-float')],
    });
    this.shadowLayout = device.createBindGroupLayout({
      label: `${id}.cloudShadow`,
      entries: [uniform, tex(1), tex(2, 'float', '3d'), tex(3, 'float', '3d'), tex(4, 'unfilterable-float')],
    });
    this.marchPipeline = this.core.fullscreenPipeline({ label: `${id}.cloudMarch`, fragment: cloudMarchFsWgsl(false), layouts: [this.marchLayout], targets: [{ format: 'rgba16float' }, { format: 'rgba32float' }] });
    this.marchFinePipeline = this.core.fullscreenPipeline({ label: `${id}.cloudMarchFine`, fragment: cloudMarchFsWgsl(true), layouts: [this.marchFineLayout], targets: [{ format: 'rgba16float' }, { format: 'rgba32float' }] });
    this.resolvePipeline = this.core.fullscreenPipeline({ label: `${id}.cloudResolve`, fragment: CLOUD_RESOLVE_FS_WGSL, layouts: [this.resolveLayout], targets: [{ format: 'rgba16float' }, { format: 'r32float' }, { format: 'rgba32float' }] });
    this.shadowPipeline = this.core.fullscreenPipeline({ label: `${id}.cloudShadow`, fragment: CLOUD_SHADOW_FS_WGSL, layouts: [this.shadowLayout], targets: [{ format: 'rgba32float' }] });
    this.marchPipeline.get();
    this.marchFinePipeline.get();
    this.resolvePipeline.get();
    this.shadowPipeline.get();

    this.generateNoise().catch((e: unknown) => this.core.reportError(`${id}: cloud noise generation failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  // ------------------------------------------------------------------------------------------ resources

  /** Changes whenever a view handed out by this object was replaced. */
  get version(): number {
    return this.resourceVersion + this.screen.version + this.depth.version + this.geom.version;
  }
  get screenView(): GPUTextureView {
    return this.screen.view;
  }
  get depthView(): GPUTextureView {
    return this.depth.view;
  }
  /** Half-resolution cloud geometry along each ray (begin, end, mean distance; 3.0e38 = none), for the atmosphere march. */
  get geomView(): GPUTextureView {
    return this.geom.view;
  }
  /** Tile targets of the full-resolution cloud march (radiance / transmittance, geometry), texel (0, 0) = `atmo.tile.xy`. */
  get fineColorView(): GPUTextureView {
    return this.fineColorTexView;
  }
  get fineGeomView(): GPUTextureView {
    return this.fineGeomTexView;
  }
  get shadowView(): GPUTextureView {
    return this.shadowTexView;
  }
  get coverageView(): GPUTextureView {
    return this.coverageNow;
  }

  private allocateShadow(size: number): void {
    if (size === this.shadowSize) return;
    if (this.shadowSize > 0) {
      this.shadowTex.destroy();
      this.shadowScratch.destroy();
    }
    this.shadowSize = size;
    const make = (label: string, usage: GPUTextureUsageFlags): GPUTexture => this.core.createTextureChecked({ label, format: 'rgba32float', size: [size, size], usage });
    this.shadowTex = make(`${this.id}.cloudShadow`, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC);
    this.shadowScratch = make(`${this.id}.cloudShadow.scratch`, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
    this.shadowTexView = this.shadowTex.createView();
    this.shadowScratchView = this.shadowScratch.createView();
    this.shadowValid = false;
    this.resourceVersion++;
  }

  /** Generate the two noise volumes on the GPU, equalise their histograms on the CPU and upload them with mips. */
  private async generateNoise(): Promise<void> {
    const device = this.device;
    const layout = device.createBindGroupLayout({
      label: `${this.id}.cloudNoise`,
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const pipeline = device.createComputePipeline({
      label: `${this.id}.cloudNoise`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: this.ctx.shaders.createModule(`${this.id}.cloudNoise`, CLOUD_NOISE_COMPUTE_WGSL), entryPoint: 'main' },
    });
    const f16 = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) f16[i] = f16ToF32(i);

    const generate = async (size: number, kind: number): Promise<Float32Array> => {
      const tex = this.core.createTextureChecked({ label: `${this.id}.cloudNoise.gen${kind}`, format: 'rgba16float', dimension: '3d', size: [size, size, size], usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
      const u = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(u, 0, new Uint32Array([size, kind, 0, 0]));
      const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: { buffer: u } }] });
      const bytesPerRow = size * 8;
      const buffer = device.createBuffer({ size: bytesPerRow * size * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder({ label: `${this.id}.cloudNoise` });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(size / 4, size / 4, size / 4);
      pass.end();
      encoder.copyTextureToBuffer({ texture: tex }, { buffer, bytesPerRow, rowsPerImage: size }, [size, size, size]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const raw = new Uint16Array(buffer.getMappedRange());
      const out = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = f16[raw[i]!]!;
      buffer.unmap();
      buffer.destroy();
      tex.destroy();
      u.destroy();
      return out;
    };

    const upload = (label: string, levels: Float32Array[], size: number): GPUTextureView => {
      const tex = this.core.createTextureChecked({ label, format: 'rgba8unorm', dimension: '3d', size: [size, size, size], mipLevelCount: levels.length, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      let n = size;
      levels.forEach((data, mipLevel) => {
        const bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) bytes[i] = Math.min(255, Math.max(0, Math.round(data[i]! * 255)));
        device.queue.writeTexture({ texture: tex, mipLevel }, bytes, { bytesPerRow: n * 4, rowsPerImage: n }, [n, n, n]);
        n >>= 1;
      });
      return tex.createView();
    };

    const base = await generate(BASE_SIZE, 0);
    // Equalise the shape (r), cell (g) and smooth (b) channels: a threshold then selects an exact volume fraction.
    const voxels = BASE_SIZE ** 3;
    const channel = new Float32Array(voxels);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < voxels; i++) channel[i] = base[i * 4 + c]!;
      equalise(channel);
      for (let i = 0; i < voxels; i++) base[i * 4 + c] = channel[i]!;
    }
    const levels: Float32Array[] = [base];
    for (let n = BASE_SIZE; n > 1; n >>= 1) levels.push(downsampleVolume(levels[levels.length - 1]!, n, 4));
    const std0 = channelStd(base, 4, 0);
    this.noiseFade = levels.map((l) => Math.min(1, Math.max(0, 1 - channelStd(l, 4, 0) / std0)));
    const detailLevels: Float32Array[] = [await generate(DETAIL_SIZE, 1)];
    for (let n = DETAIL_SIZE; n > 1; n >>= 1) detailLevels.push(downsampleVolume(detailLevels[detailLevels.length - 1]!, n, 4));
    this.baseNoise = upload(`${this.id}.cloudNoise.base`, levels, BASE_SIZE);
    this.detailNoise = upload(`${this.id}.cloudNoise.detail`, detailLevels, DETAIL_SIZE);
    this.noiseReady = true;
    this.resourceVersion++;
  }

  /** Share of the shape-noise amplitude lost at each mip level (for tests). */
  noiseFadeTable(): number[] {
    return [...this.noiseFade];
  }

  private paramsFor(def: BodyDef): CloudParams {
    let p = this.params.get(def.id);
    if (!p) {
      const r = resolveCloudParams(def.render.clouds!);
      for (const problem of r.problems) this.core.reportError(`${this.id}: ${def.id}.clouds: ${problem}`);
      p = r.params;
      this.params.set(def.id, p);
    }
    return p;
  }

  /** Re-read the cloud tunables of every body from the definitions (after editing them at run time). */
  invalidateParams(): void {
    this.params.clear();
  }

  private coverageFor(def: BodyDef, params: CloudParams): CoverageEntry {
    let e = this.coverage.get(def.id);
    if (e) return e;
    e = { state: 'loading', view: null, texture: null, width: 1 };
    this.coverage.set(def.id, e);
    const entry = e;
    const supplied = this.options.coverageMaps?.[def.id];
    const done = (texture: GPUTexture | null): void => {
      entry.texture = texture;
      entry.view = texture ? texture.createView() : null;
      entry.width = texture ? texture.width : 1;
      entry.state = texture ? 'ready' : 'absent';
    };
    if (supplied) {
      done(this.coverageFromBytes(def.id, supplied));
    } else {
      this.loadCoverage(def, params).then(done, (err: unknown) => {
        this.core.reportError(`${this.id}: cloud coverage map of ${def.id}: ${err instanceof Error ? err.message : String(err)}`);
        done(null);
      });
    }
    return entry;
  }

  private createCoverageTexture(bodyId: string, width: number, height: number): GPUTexture {
    return this.core.createTextureChecked({
      label: `${this.id}.coverage.${bodyId}`,
      format: 'rg8unorm',
      size: [width, height],
      mipLevelCount: Math.floor(Math.log2(Math.max(width, height))) + 1,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private coverageFromBytes(bodyId: string, image: CoverageImage): GPUTexture {
    const tex = this.createCoverageTexture(bodyId, image.width, image.height);
    this.device.queue.writeTexture({ texture: tex }, image.data, { bytesPerRow: image.width * 2 }, [image.width, image.height]);
    this.core.mips.generate(tex);
    return tex;
  }

  /**
   * The coverage map named by the body's CloudRenderDef, from the globals of its tile set. A tile set that
   * is not baked, or one without that map, means no clouds for the body (null); a map the manifest
   * promises but that cannot be loaded is an error.
   */
  private async loadCoverage(def: BodyDef, params: CloudParams): Promise<GPUTexture | null> {
    const tileset = def.terrain?.tileset;
    if (!tileset) return null;
    this.tilesets ??= fetch(`${this.ctx.tilesUrl}/index.json`, { cache: 'no-cache' }).then(async (r) => (r.ok ? ((await r.json()) as { tilesets: string[] }).tilesets : null));
    const baked = await this.tilesets;
    if (baked && !baked.includes(tileset)) return null;
    const base = `${this.ctx.tilesUrl}/${tileset}`;
    const res = await fetch(`${base}/manifest.json`);
    if (!res.ok) return null;
    const manifest = (await res.json()) as TileManifest;
    const g = manifest.globals?.[params.coverageMap];
    if (!g) return null;
    const img = await fetch(`${base}/${g.path}`);
    if (!img.ok) throw new Error(`${g.path}: HTTP ${img.status}`);
    // Two channels arrive as grey + alpha: never let the decoder premultiply (ARCHITECTURE section 1, row 5).
    const bitmap = await createImageBitmap(await img.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const device = this.device;
    const staging = this.core.createTextureChecked({
      label: `${this.id}.coverage.staging`,
      format: 'rgba8unorm',
      size: [bitmap.width, bitmap.height],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: staging, premultipliedAlpha: false }, [bitmap.width, bitmap.height]);
    const tex = this.createCoverageTexture(def.id, bitmap.width, bitmap.height);
    bitmap.close();
    // rg = (coverage, cloud top): grey + alpha sources carry them in r and a, colour sources in r and g.
    const greyAlpha = g.channels.length === 2;
    const module = device.createShaderModule({
      label: `${this.id}.coverage.pack`,
      code: /* wgsl */ `
        @group(0) @binding(0) var src: texture_2d<f32>;
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
          return vec4f(vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0, 0.0, 1.0);
        }
        @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
          let t = textureLoad(src, vec2i(p.xy), 0);
          return vec4f(t.r, ${greyAlpha ? 't.a' : 't.g'}, 0.0, 1.0);
        }`,
    });
    const pipeline = device.createRenderPipeline({ label: `${this.id}.coverage.pack`, layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rg8unorm' }] } });
    const encoder = device.createCommandEncoder({ label: `${this.id}.coverage.pack` });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: tex.createView({ baseMipLevel: 0, mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: staging.createView() }] }));
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    staging.destroy();
    this.core.mips.generate(tex);
    return tex;
  }

  /** Coverage texture of a body (null until it is loaded), for test readbacks. */
  coverageTexture(bodyId: string): GPUTexture | null {
    return this.coverage.get(bodyId)?.texture ?? null;
  }

  isIdle(): boolean {
    if (!this.noiseReady) return false;
    for (const e of this.coverage.values()) if (e.state === 'loading') return false;
    return true;
  }

  // ------------------------------------------------------------------------------------------- per frame

  /** March steps of a cloud ray this frame. */
  stepBudget(frame: FrameContext): number {
    return Math.max(8, Math.round(this.ctx.quality.cloudSteps * frame.qualityScale));
  }

  /** Switch the cloud terms of the uniform block and of the deferred lighting off. */
  disable(u: AtmoUniforms): void {
    u.set('shadowOrigin', 0, 0, 0, 0);
    u.set('far', 0, 0, 0, 0);
    u.set('cloudShell', 0, 0, 0, 0);
    this.core.setCloudShadowParams({ near: null, far: null });
    this.shadowOn = false;
    this.shadowValid = false;
    this.placement = null;
    this.bodyId = null;
    this.current = null;
  }

  /**
   * Pick the body whose clouds are drawn (the nearest marched atmosphere body that has clouds, a loaded
   * coverage map and ready noise), advance the cloud clock, fill the cloud fields of the uniform block and
   * hand the shadow placement to the render core. Returns its frame body index, or -1.
   */
  prepare(frame: FrameContext, u: AtmoUniforms, marched: readonly MarchBody[]): number {
    this.phase = frame.frameIndex & 3;
    const ut = frame.snapshot.ut;
    let picked: { body: MarchBody; def: BodyDef; params: CloudParams; entry: CoverageEntry } | null = null;
    for (const body of marched) {
      const def = this.ctx.defs.bodies[body.bodyId]!;
      if (!def.render.clouds) continue;
      const params = this.paramsFor(def);
      const entry = this.coverageFor(def, params);
      if (entry.state === 'ready' && this.noiseReady) {
        picked = { body, def, params, entry };
        break;
      }
    }
    if (!picked) {
      this.lastUt = ut;
      return -1;
    }
    const { body, def, params, entry } = picked;
    const pose = frame.bodies[body.bodyIndex]!;

    // Clouds live in simulation time, but never run more than maxTimeRate times faster than real time.
    this.cloudTime = advanceCloudClock(this.cloudTime, this.lastUt, ut, frame.realDt, params.maxTimeRate);
    this.lastUt = ut;

    if (this.bodyId !== def.id) {
      this.bodyId = def.id;
      this.shadowValid = false;
      this.lastMarchFrame = -10;
    }
    this.current = params;
    if (this.coverageNow !== entry.view) {
      this.coverageNow = entry.view!;
      this.resourceVersion++;
    }
    this.allocateShadow(params.shadowMapSize);

    const R = def.radius;
    const coverageAngle = mod((params.coverageDriftMps / R) * this.cloudTime, 2 * Math.PI);
    const noiseAngle = mod(((params.coverageDriftMps + params.noiseDriftMps) / R) * this.cloudTime, 2 * Math.PI);
    const lonOffset = -coverageAngle;
    this.lonOffset = lonOffset;
    const cosN = Math.cos(noiseAngle);
    const sinN = Math.sin(noiseAngle);
    // Camera in the noise frame (body-fixed axes turned by the drift), float64, then modulo each tile.
    const cf = pose.cameraFixed;
    const camNoise = { x: cosN * cf.x + sinN * cf.y, y: cosN * cf.y - sinN * cf.x, z: cf.z };
    const tile = (name: 'noiseBase' | 'noiseDetail' | 'noiseMeso' | 'noiseLarge', size: number): void => u.set(name, mod(camNoise.x, size), mod(camNoise.y, size), mod(camNoise.z, size), 1 / size);
    tile('noiseBase', params.baseNoiseScaleM);
    tile('noiseDetail', params.detailNoiseScaleM);
    tile('noiseMeso', params.mesoscaleScaleM);
    tile('noiseLarge', params.weatherScaleM);
    u.set('noiseRot', cosN, sinN, lonOffset, entry.width);
    u.set('noiseFadeA', this.noiseFade[0]!, this.noiseFade[1]!, this.noiseFade[2]!, this.noiseFade[3]!);
    u.set('noiseFadeB', this.noiseFade[4]!, this.noiseFade[5]!, this.noiseFade[6]!, this.noiseFade[7]!);
    // Wind shear: the noise leans to the east with altitude (east at the camera, in the noise frame).
    let east = v3.cross({ x: 0, y: 0, z: 1 }, camNoise);
    east = v3.lenSq(east) > 1e-6 ? v3.normalize(east) : { x: 1, y: 0, z: 0 };
    u.set('cloudWind', east.x * params.windShear, east.y * params.windShear, east.z * params.windShear, mod(params.detailRiseMps * this.cloudTime, params.detailNoiseScaleM));

    u.set('cloudShell', R + params.bottomAltitude, R + params.topAltitude, params.bottomAltitude, params.topAltitude);
    u.set('cloudLow', params.lowThicknessM, params.lowExtinction, params.lowEdgeSoftness, params.lowCoverageGain);
    u.set('cloudLow2', params.fairWeatherCoverage, params.mesoscaleAmplitude, params.detailErosion, params.detailFadeFootprintM);
    u.set('cloudHigh', params.highThicknessMinM, params.highThicknessMaxM, params.highExtinctionMin, params.highExtinctionMax);
    u.set('cloudHigh2', params.highCoverageStart, params.highCoverageFull, params.deepCoverageStart, params.deepCoverageFull);
    u.set('cloudDeep', params.deepExtinction, params.groundAlbedo, params.ambientScale, params.multiScatterGain);
    u.set('cloudLight', params.diffuseScatter, 0.75 * (1 - params.diffusionG), params.topReliefM, frame.qualityScale);
    u.set('cloudPhase', params.phaseG1, params.phaseG2, params.phaseMix, params.sunReachM);
    const halfH = Math.ceil(frame.renderSize[1] / 2);
    u.set('cloudMarch', params.stepFactor, params.stepMinM, params.stepMaxM, (2 * Math.tan(frame.camera.fovY / 2)) / halfH);

    // Motion of a body-fixed point since the previous frame: prev = p + (Rp R^T - I) p + (cp - Rp R^T c).
    const dm = mat3.fromQuat(quat.mul(pose.prevQFixedToRoot, quat.conj(pose.qFixedToRoot)));
    const t = v3.sub(pose.prevCenterRelCam, mat3.mulVec(dm, pose.centerRelCam));
    u.set('reproj0', dm[0] - 1, dm[1], dm[2], 0);
    u.set('reproj1', dm[3], dm[4] - 1, dm[5], 0);
    u.set('reproj2', dm[6], dm[7], dm[8] - 1, 0);
    u.set('reprojT', t.x, t.y, t.z, 0);

    const targetKey = `${this.screen.version}:${this.historyColor.version}:${this.quarterColor.version}`;
    this.historyValid = this.lastMarchFrame === frame.frameIndex - 1 && targetKey === this.lastTargetKey;
    this.lastTargetKey = targetKey;
    u.set('misc', frame.exposure / this.lastExposure, this.historyValid ? 1 : 0, frame.animate ? 1 : 0, frame.animate ? 0.4 : 1);

    // Cloud shadows for the deferred lighting, the atmosphere march and the clouds themselves.
    const far = { bodyIndex: body.bodyIndex, layerRadius: R + params.bottomAltitude + 0.5 * params.lowThicknessM, opticalDepth: params.farShadowOpticalDepth, longitudeOffset: lonOffset };
    u.set('far', far.layerRadius, far.opticalDepth, far.longitudeOffset, 1);
    this.placement = this.placeShadow(frame, pose, def, params, body.bodyIndex, u);
    this.shadowOn = this.placement !== null;
    const p = this.placement;
    this.core.setCloudShadowParams({
      near: p ? { bodyIndex: p.bodyIndex, originRelCam: p.originRelCam, axisU: p.axisU, axisV: p.axisV, halfExtent: p.halfExtent, opticalDepthScale: p.opticalDepthScale } : null,
      far,
    });
    return body.bodyIndex;
  }

  /**
   * Place the near shadow map. Its texel lattice is anchored at a body-fixed point near the camera (so the
   * clouds do not move through it and incremental refresh stays valid), its plane is perpendicular to the
   * projection direction, and its origin follows the camera in whole texels.
   */
  private placeShadow(frame: FrameContext, pose: BodyPose, def: BodyDef, params: CloudParams, bodyIndex: number, u: AtmoUniforms): CloudShadowPlacement | null {
    const R = def.radius;
    const q = pose.qFixedToRoot;
    const camFixed = pose.cameraFixed;
    const upFixed = v3.normalize(camFixed);
    // Centre the map under the camera, at the cloud base (or at the camera when it is below that).
    const centreFixed = v3.scale(upFixed, R + Math.min(pose.cameraAltitude, params.bottomAltitude));

    const target = Math.min(params.shadowHalfExtentM + params.shadowAltitudeGain * Math.max(pose.cameraAltitude - params.topAltitude, 0), SHADOW_MAX_HALF_EXTENT);
    let full = !this.shadowValid || this.anchorBody !== def.id || !this.anchorFixed;
    if (this.shadowHalfExtent <= 0 || Math.abs(Math.log2(target / this.shadowHalfExtent)) > 0.4) {
      // Extents in steps of sqrt(2) with hysteresis: the texel size changes rarely, and then everything is re-marched.
      this.shadowHalfExtent = params.shadowHalfExtentM * 2 ** (Math.round(2 * Math.log2(target / params.shadowHalfExtentM)) / 2);
      full = true;
    }
    const he = this.shadowHalfExtent;
    const n = params.shadowMapSize;
    const texel = (2 * he) / n;
    if (full || v3.dist(centreFixed, this.anchorFixed!) > 0.5 * he) {
      this.anchorFixed = centreFixed;
      this.anchorBody = def.id;
      this.shadowIJ = [0, 0];
      full = true;
    }
    const anchor = this.anchorFixed!;
    const upA = quat.rotate(q, v3.normalize(anchor));
    const sinE = v3.dot(upA, pose.sunDir);
    if (sinE < Math.sin(SHADOW_OFF_ELEVATION)) {
      u.set('shadowOrigin', 0, 0, 0, 0);
      this.shadowValid = false;
      return null;
    }
    let dir = pose.sunDir;
    if (sinE < Math.sin(SHADOW_MIN_ELEVATION)) {
      let hor = v3.reject(pose.sunDir, upA);
      hor = v3.lenSq(hor) > 1e-12 ? v3.normalize(hor) : v3.anyOrthogonal(upA);
      dir = v3.normalize(v3.add(v3.scale(hor, Math.cos(SHADOW_MIN_ELEVATION)), v3.scale(upA, Math.sin(SHADOW_MIN_ELEVATION))));
    }
    let axisU = v3.cross(quat.rotate(q, { x: 0, y: 0, z: 1 }), dir);
    if (v3.lenSq(axisU) < 1e-6) axisU = v3.cross(quat.rotate(q, { x: 1, y: 0, z: 0 }), dir);
    axisU = v3.normalize(axisU);
    const axisV = v3.cross(dir, axisU);
    const anchorRelCam = v3.add(pose.centerRelCam, quat.rotate(q, anchor));
    const rel = quat.rotate(q, v3.sub(centreFixed, anchor));
    const i0 = Math.round(v3.dot(rel, axisU) / texel);
    const j0 = Math.round(v3.dot(rel, axisV) / texel);
    const shift: [number, number] = [i0 - this.shadowIJ[0], j0 - this.shadowIJ[1]];
    if (Math.abs(shift[0]) >= n / 2 || Math.abs(shift[1]) >= n / 2) full = true;
    this.shadowIJ = [i0, j0];
    const originRelCam = v3.add(anchorRelCam, v3.add(v3.scale(axisU, i0 * texel), v3.scale(axisV, j0 * texel)));
    const scale = Math.max(v3.dot(dir, upA), 0.05);
    u.set('shadowOrigin', originRelCam.x, originRelCam.y, originRelCam.z, he);
    u.set('shadowU', axisU.x, axisU.y, axisU.z, params.shadowSteps);
    u.set('shadowV', axisV.x, axisV.y, axisV.z, scale);
    u.set('shadowL', dir.x, dir.y, dir.z, full ? 0 : 1);
    u.set('shadowShift', shift[0], shift[1], frame.frameIndex & 15, n);
    this.shadowValid = true;
    return { bodyIndex, originRelCam, axisU, axisV, dir, halfExtent: he, opticalDepthScale: scale };
  }

  /** Placement of the near shadow map this frame (null when it is off), for tests and labs. */
  shadowPlacement(): CloudShadowPlacement | null {
    return this.placement;
  }

  /**
   * Longitude offset of the coverage map this frame, rad: the clouds over geographic longitude L are those of
   * the map at longitude L + offset (the map drifts east with the wind).
   */
  coverageLongitudeOffset(): number {
    return this.lonOffset;
  }

  /** Simulation-time clock of the clouds, s. */
  time(): number {
    return this.cloudTime;
  }

  private ensureGroups(tables: { transmittance: GPUTextureView; irradiance: GPUTextureView }): void {
    const key = [
      this.resourceVersion,
      this.quarterColor.version,
      this.screen.version,
      this.historyColor.version,
      this.ctx.resources.version('scene.depthHalf'),
      this.ctx.resources.version('scene.depth'),
      this.ctx.resources.version('atmosphere.transmittanceLut'),
      this.ctx.resources.version('atmosphere.skyIrradianceLut'),
    ].join(':');
    if (key === this.groupKey && this.marchGroup) return;
    this.groupKey = key;
    const u: GPUBindGroupEntry = { binding: 0, resource: { buffer: this.uniformBuffer } };
    this.marchGroup = this.device.createBindGroup({
      label: `${this.id}.cloudMarch`,
      layout: this.marchLayout,
      entries: [
        u,
        { binding: 1, resource: this.coverageNow },
        { binding: 2, resource: this.baseNoise },
        { binding: 3, resource: this.detailNoise },
        { binding: 4, resource: tables.transmittance },
        { binding: 5, resource: tables.irradiance },
        { binding: 6, resource: this.shadowTexView },
        { binding: 7, resource: this.ctx.resources.get('scene.depthHalf') },
      ],
    });
    this.marchFineGroup = this.device.createBindGroup({
      label: `${this.id}.cloudMarchFine`,
      layout: this.marchFineLayout,
      entries: [
        u,
        { binding: 1, resource: this.coverageNow },
        { binding: 2, resource: this.baseNoise },
        { binding: 3, resource: this.detailNoise },
        { binding: 4, resource: tables.transmittance },
        { binding: 5, resource: tables.irradiance },
        { binding: 6, resource: this.shadowTexView },
        { binding: 7, resource: this.ctx.resources.get('scene.depth') },
      ],
    });
    this.resolveGroup = this.device.createBindGroup({
      label: `${this.id}.cloudResolve`,
      layout: this.resolveLayout,
      entries: [u, { binding: 1, resource: this.quarterColor.view }, { binding: 2, resource: this.quarterGeom.view }, { binding: 3, resource: this.historyColor.view }, { binding: 4, resource: this.historyGeom.view }],
    });
    this.shadowGroup = this.device.createBindGroup({
      label: `${this.id}.cloudShadow`,
      layout: this.shadowLayout,
      entries: [u, { binding: 1, resource: this.coverageNow }, { binding: 2, resource: this.baseNoise }, { binding: 3, resource: this.detailNoise }, { binding: 4, resource: this.shadowTexView }],
    });
  }

  /** Compute hook: refresh the near shadow map (a quarter of its texels, or all of them after a re-anchor). */
  compute(frame: FrameContext, encoder: GPUCommandEncoder, on: boolean): void {
    if (!on || !this.shadowOn) return;
    this.ensureGroups({ transmittance: this.ctx.resources.get('atmosphere.transmittanceLut'), irradiance: this.ctx.resources.get('atmosphere.skyIrradianceLut') });
    const pass = encoder.beginRenderPass({
      label: `${this.id}.cloudShadow`,
      colorAttachments: [{ view: this.shadowScratchView, loadOp: 'clear', storeOp: 'store' }],
      timestampWrites: this.ctx.perf.gpuPass(`${this.id}.cloudShadow`) as GPURenderPassTimestampWrites | undefined,
    });
    pass.setBindGroup(0, frame.frameBindGroup);
    pass.setPipeline(this.shadowPipeline.get());
    pass.setBindGroup(1, this.shadowGroup!);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToTexture({ texture: this.shadowScratch }, { texture: this.shadowTex }, [this.shadowSize, this.shadowSize]);
  }

  /** Cloud march (one pixel of every 2 x 2 block of the half-resolution buffers) and the temporal resolve. */
  march(frame: FrameContext, encoder: GPUCommandEncoder, bounds: readonly [number, number, number, number]): void {
    this.ensureGroups({ transmittance: this.ctx.resources.get('atmosphere.transmittanceLut'), irradiance: this.ctx.resources.get('atmosphere.skyIrradianceLut') });
    const neutral: GPUColor = { r: 0, g: 0, b: 0, a: 1 };
    const none: GPUColor = { r: 3.0e38, g: 3.0e38, b: 3.0e38, a: 0 };
    {
      const pass = encoder.beginRenderPass({
        label: `${this.id}.cloudMarch`,
        colorAttachments: [
          { view: this.quarterColor.view, clearValue: neutral, loadOp: 'clear', storeOp: 'store' },
          { view: this.quarterGeom.view, clearValue: none, loadOp: 'clear', storeOp: 'store' },
        ],
        timestampWrites: this.ctx.perf.gpuPass(`${this.id}.cloudMarch`) as GPURenderPassTimestampWrites | undefined,
      });
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setPipeline(this.marchPipeline.get());
      pass.setBindGroup(1, this.marchGroup!);
      pass.setScissorRect(...scissorOf(bounds, this.quarterColor.size[0], this.quarterColor.size[1], 3));
      pass.draw(3);
      pass.end();
    }
    {
      const pass = encoder.beginRenderPass({
        label: `${this.id}.cloudResolve`,
        colorAttachments: [
          { view: this.screen.view, clearValue: neutral, loadOp: 'clear', storeOp: 'store' },
          { view: this.depth.view, clearValue: none, loadOp: 'clear', storeOp: 'store' },
          { view: this.geom.view, clearValue: none, loadOp: 'clear', storeOp: 'store' },
        ],
        timestampWrites: this.ctx.perf.gpuPass(`${this.id}.cloudResolve`) as GPURenderPassTimestampWrites | undefined,
      });
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setPipeline(this.resolvePipeline.get());
      pass.setBindGroup(1, this.resolveGroup!);
      pass.setScissorRect(...scissorOf(bounds, this.screen.size[0], this.screen.size[1], 2));
      pass.draw(3);
      pass.end();
    }
  }

  /**
   * Full-resolution cloud march of the rectangle `atmo.tile` (width x height px) into the tile targets:
   * what the atmosphere march composites while the shells in view fit into the tile. The half-resolution
   * buffers of `march` are still rendered: they are what transparents read.
   */
  marchFine(frame: FrameContext, encoder: GPUCommandEncoder, width: number, height: number): void {
    const pass = encoder.beginRenderPass({
      label: `${this.id}.cloudMarchFine`,
      colorAttachments: [
        { view: this.fineColorTexView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        { view: this.fineGeomTexView, clearValue: { r: 3.0e38, g: 3.0e38, b: 3.0e38, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      timestampWrites: this.ctx.perf.gpuPass(`${this.id}.cloudMarchFine`) as GPURenderPassTimestampWrites | undefined,
    });
    pass.setBindGroup(0, frame.frameBindGroup);
    pass.setPipeline(this.marchFinePipeline.get());
    pass.setBindGroup(1, this.marchFineGroup!);
    pass.setScissorRect(0, 0, width, height);
    pass.draw(3);
    pass.end();
  }

  /** Keep this frame's cloud buffers as the history of the next one. */
  endFrame(frame: FrameContext, encoder: GPUCommandEncoder): void {
    encoder.copyTextureToTexture({ texture: this.screen.texture }, { texture: this.historyColor.texture }, this.screen.size);
    encoder.copyTextureToTexture({ texture: this.geom.texture }, { texture: this.historyGeom.texture }, this.geom.size);
    this.lastMarchFrame = frame.frameIndex;
    this.lastExposure = frame.exposure;
  }

  /**
   * Read the resolved cloud buffers back (tests and diagnosis), half resolution, row 0 first:
   * `radiance` = rgba (pre-exposed, premultiplied radiance; a = transmittance), `geometry` = rgba (distance
   * where the cloud begins, where it ends, its opacity-weighted mean; 3.0e38 = no cloud).
   */
  async readBuffers(): Promise<{ width: number; height: number; radiance: Float32Array; geometry: Float32Array }> {
    const [width, height] = this.screen.size;
    const rect = { x: 0, y: 0, width, height };
    const half = new Uint16Array(await readTexturePixels(this.device, this.screen.texture, rect, 8));
    const radiance = new Float32Array(half.length);
    for (let i = 0; i < half.length; i++) radiance[i] = f16ToF32(half[i]!);
    const geometry = new Float32Array(await readTexturePixels(this.device, this.geom.texture, rect, 16));
    return { width, height, radiance, geometry };
  }

  /** Tunables of the body whose clouds are being drawn. */
  activeParams(): CloudParams | null {
    return this.current;
  }

  dispose(): void {
    for (const t of [this.quarterColor, this.quarterGeom, this.screen, this.depth, this.geom, this.historyColor, this.historyGeom]) t.destroy();
    this.fineColor.destroy();
    this.fineGeom.destroy();
    this.shadowTex.destroy();
    this.shadowScratch.destroy();
    for (const e of this.coverage.values()) e.texture?.destroy();
  }
}
