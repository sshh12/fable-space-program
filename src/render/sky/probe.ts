/**
 * Live environment probe at the active vessel (rendering-design 8.3): a 64 x 64 x 6 rgba16float cube evaluated
 * analytically, one face per frame, then its mip chain and SH9 projection, then a GGX prefilter of 5 mips one
 * mip per frame. A cycle takes PROBE_CYCLE frames; the published cube ('env.probeCube', cd/m^2, not
 * pre-exposed) and SH ('env.sh9', irradiance coefficients in lux) are blended every frame from the two latest
 * completed probes, so lighting changes as a ramp, never as a step.
 *
 * The sky-view table is evaluated at the camera, so the probe is only re-evaluated while the camera is within
 * PROBE_MAX_CAMERA_OFFSET of the vessel (chase and cockpit views); beyond (map view) it holds its last state.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import type { TileManifest } from '@/core/contracts/terrain';
import { coreOf, createSceneBindings, f16ToF32, mipCount, type SceneBindings, type Tracked } from '@/render/core';
import { albedoGridFromSrgb, type AlbedoGrid } from './photometry';
import { probeSceneOf, type ProbeScene } from './probeScene';
import { PROBE_BLEND_CS, PROBE_DOWN_CS, PROBE_FACE_CS, PROBE_PREFILTER_CS, PROBE_SH_BLEND_CS, PROBE_SH_CS } from './shaders';

export const PROBE_SIZE = 64;
export const PROBE_MIPS = 5;
/** 6 faces, 1 frame for the raw mip chain and SH9, PROBE_MIPS frames of prefiltering. */
export const PROBE_CYCLE = 6 + 1 + PROBE_MIPS;
/** Mip of the raw cube the SH9 projection reads (16 x 16 per face, box-filtered: energy preserving). */
const SH_SOURCE_MIP = 2;
export const PROBE_MAX_CAMERA_OFFSET = 50_000;
const RAW_MIPS = mipCount(PROBE_SIZE, PROBE_SIZE);
const PROBE_UNIFORM_FLOATS = 8 + 4 * 8;

export interface ProbeState {
  /** Completed probe cycles (the published probe exists once this is >= 1). */
  completed: number;
  /** Frame step within the current cycle, 0..PROBE_CYCLE-1. */
  step: number;
  /** True while the camera is too far from the probe position for the sky-view table to apply. */
  holding: boolean;
  /** The scene of the last evaluated face. */
  scene: ProbeScene | null;
  /** Bodies with an albedoLowRes map bound (else their mean colour). */
  albedoMaps: string[];
}

export class EnvironmentProbe {
  private readonly device: GPUDevice;
  private readonly raw: GPUTexture;
  private readonly probes: GPUTexture;
  private readonly out: GPUTexture;
  private readonly shSlots: GPUBuffer;
  private readonly shOut: GPUBuffer;
  private readonly stepBuf: GPUBuffer;
  private readonly probeBuf: GPUBuffer;
  private readonly probeData = new Float32Array(PROBE_UNIFORM_FLOATS);
  private readonly stepData = new ArrayBuffer(32);
  private readonly sceneBindings: SceneBindings;
  private readonly faceLayout: GPUBindGroupLayout;
  private readonly sceneLayout: GPUBindGroupLayout;
  private readonly facePipeline: Tracked<GPUComputePipeline>;
  private readonly downPipeline: GPUComputePipeline;
  private readonly shPipeline: GPUComputePipeline;
  private readonly prefilterPipelines: GPUComputePipeline[];
  private readonly blendPipelines: GPUComputePipeline[];
  private readonly shBlendPipeline: GPUComputePipeline;
  private readonly downGroups: GPUBindGroup[] = [];
  private readonly shGroup: GPUBindGroup;
  private readonly prefilterGroups: GPUBindGroup[] = [];
  private readonly blendGroups: GPUBindGroup[] = [];
  private readonly shBlendGroup: GPUBindGroup;
  private faceGroup: GPUBindGroup | null = null;
  private sceneGroup: GPUBindGroup | null = null;
  private sceneVersion = -1;
  private readonly albedo = new Map<string, { view: GPUTextureView; slot: number }>();
  private readonly albedoGrids = new Map<string, AlbedoGrid>();
  private readonly blank: GPUTextureView;
  private milkyWay: GPUTextureView;
  private milkyWayScale = 0;
  private milkyWayMip = 0;
  private slots = { prev: 0, cur: 0, next: 0 };
  private state: ProbeState = { completed: 0, step: 0, holding: false, scene: null, albedoMaps: [] };
  private pending = 0;
  private published = false;
  /** Data generation (albedo maps, Milky Way) the next probe cycle starts with, and the one the last completed probe used. */
  private dataGeneration = 0;
  private cycleGeneration = -1;
  private completedGeneration = -1;

  constructor(
    private readonly ctx: RenderContext,
    private readonly featureId: string,
    blankCube: GPUTextureView,
  ) {
    const device = (this.device = ctx.device);
    const core = coreOf(ctx);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    this.raw = core.createTextureChecked({ label: `${featureId}.probeRaw`, format: 'rgba16float', size: [PROBE_SIZE, PROBE_SIZE, 6], mipLevelCount: RAW_MIPS, usage });
    this.probes = core.createTextureChecked({ label: `${featureId}.probeSlots`, format: 'rgba16float', size: [PROBE_SIZE, PROBE_SIZE, 18], mipLevelCount: PROBE_MIPS, usage });
    this.out = core.createTextureChecked({ label: `${featureId}.probeCube`, format: 'rgba16float', size: [PROBE_SIZE, PROBE_SIZE, 6], mipLevelCount: PROBE_MIPS, usage: usage | GPUTextureUsage.COPY_SRC });
    this.shSlots = device.createBuffer({ label: `${featureId}.shSlots`, size: 27 * 16, usage: GPUBufferUsage.STORAGE });
    this.shOut = device.createBuffer({ label: `${featureId}.sh9`, size: 9 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.stepBuf = device.createBuffer({ label: `${featureId}.probeStep`, size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.probeBuf = device.createBuffer({ label: `${featureId}.probe`, size: PROBE_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.blank = core.createTextureChecked({ label: `${featureId}.noAlbedo`, format: 'rgba8unorm', size: [1, 1], usage: GPUTextureUsage.TEXTURE_BINDING }).createView();
    this.milkyWay = blankCube;

    // Face evaluation: group 0 frame, group 1 shared resources (LUTs, cloud maps), group 2 probe inputs.
    this.sceneBindings = createSceneBindings(ctx, 1, 0, ['atmosphereLuts', 'cloudShadow']);
    this.sceneLayout = device.createBindGroupLayout({ label: `${featureId}.probeScene`, entries: this.sceneBindings.layoutEntries });
    const C = GPUShaderStage.COMPUTE;
    this.faceLayout = device.createBindGroupLayout({
      label: `${featureId}.probeFace`,
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'uniform' } },
        ...[2, 3, 4, 5].map((binding) => ({ binding, visibility: C, texture: { sampleType: 'float' as const } })),
        { binding: 6, visibility: C, texture: { sampleType: 'float', viewDimension: 'cube' } },
        { binding: 7, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } },
      ],
    });
    const faceLayouts = [ctx.frameBindGroupLayout, this.sceneLayout, this.faceLayout];
    this.facePipeline = core.shaders.tracked(() =>
      device.createComputePipeline({
        label: `${featureId}.probeFace`,
        layout: device.createPipelineLayout({ bindGroupLayouts: faceLayouts }),
        compute: { module: core.shaders.createModule(`${featureId}.probeFace`, PROBE_FACE_CS(this.sceneBindings.wgsl)), entryPoint: 'main' },
      }),
    );
    this.facePipeline.get();

    const tex = (binding: number, viewDimension: GPUTextureViewDimension = '2d-array'): GPUBindGroupLayoutEntry => ({ binding, visibility: C, texture: { sampleType: 'float', viewDimension } });
    const store = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } });
    const ubo = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: C, buffer: { type: 'uniform' } });
    const downLayout = device.createBindGroupLayout({ label: `${featureId}.probeDown`, entries: [tex(0), store(1)] });
    const shLayout = device.createBindGroupLayout({ label: `${featureId}.probeSh`, entries: [tex(0), { binding: 1, visibility: C, buffer: { type: 'storage' } }, ubo(2)] });
    const prefilterLayout = device.createBindGroupLayout({ label: `${featureId}.probePrefilter`, entries: [tex(0, 'cube'), tex(1), store(2), ubo(3), { binding: 4, visibility: C, sampler: { type: 'filtering' } }] });
    const blendLayout = device.createBindGroupLayout({ label: `${featureId}.probeBlend`, entries: [tex(0), store(1), ubo(2)] });
    const shBlendLayout = device.createBindGroupLayout({ label: `${featureId}.probeShBlend`, entries: [{ binding: 0, visibility: C, buffer: { type: 'read-only-storage' } }, { binding: 1, visibility: C, buffer: { type: 'storage' } }, ubo(2)] });
    const pipe = (label: string, code: string, layout: GPUBindGroupLayout, constants?: Record<string, number>): GPUComputePipeline =>
      device.createComputePipeline({
        label: `${featureId}.${label}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: core.shaders.createModule(`${featureId}.${label}`, code), entryPoint: 'main', constants },
      });
    this.downPipeline = pipe('probeDown', PROBE_DOWN_CS, downLayout);
    this.shPipeline = pipe('probeSh', PROBE_SH_CS, shLayout);
    this.prefilterPipelines = Array.from({ length: PROBE_MIPS }, (_, m) => pipe(`probePrefilter${m}`, PROBE_PREFILTER_CS, prefilterLayout, { MIP: m, MIPS: PROBE_MIPS }));
    this.blendPipelines = Array.from({ length: PROBE_MIPS }, (_, m) => pipe(`probeBlend${m}`, PROBE_BLEND_CS, blendLayout, { MIP: m }));
    this.shBlendPipeline = pipe('probeShBlend', PROBE_SH_BLEND_CS, shBlendLayout);

    const mipView = (t: GPUTexture, m: number): GPUTextureView => t.createView({ dimension: '2d-array', baseMipLevel: m, mipLevelCount: 1 });
    for (let m = 1; m < RAW_MIPS; m++) {
      this.downGroups[m] = device.createBindGroup({ layout: downLayout, entries: [{ binding: 0, resource: mipView(this.raw, m - 1) }, { binding: 1, resource: mipView(this.raw, m) }] });
    }
    this.shGroup = device.createBindGroup({
      layout: shLayout,
      entries: [
        { binding: 0, resource: mipView(this.raw, SH_SOURCE_MIP) },
        { binding: 1, resource: { buffer: this.shSlots } },
        { binding: 2, resource: { buffer: this.stepBuf } },
      ],
    });
    const sampler = device.createSampler({ label: `${featureId}.probeSampler`, magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    const rawCube = this.raw.createView({ dimension: 'cube' });
    const rawArray = mipView(this.raw, 0);
    const probesAll = this.probes.createView({ dimension: '2d-array' });
    for (let m = 0; m < PROBE_MIPS; m++) {
      this.prefilterGroups[m] = device.createBindGroup({
        layout: prefilterLayout,
        entries: [
          { binding: 0, resource: rawCube },
          { binding: 1, resource: rawArray },
          { binding: 2, resource: mipView(this.probes, m) },
          { binding: 3, resource: { buffer: this.stepBuf } },
          { binding: 4, resource: sampler },
        ],
      });
      this.blendGroups[m] = device.createBindGroup({
        layout: blendLayout,
        entries: [
          { binding: 0, resource: probesAll },
          { binding: 1, resource: mipView(this.out, m) },
          { binding: 2, resource: { buffer: this.stepBuf } },
        ],
      });
    }
    this.shBlendGroup = device.createBindGroup({
      layout: shBlendLayout,
      entries: [
        { binding: 0, resource: { buffer: this.shSlots } },
        { binding: 1, resource: { buffer: this.shOut } },
        { binding: 2, resource: { buffer: this.stepBuf } },
      ],
    });
  }

  /** Start loading the albedoLowRes map of every body with a baked tile set (meanColor stays for the others). */
  loadAlbedoMaps(defs: DefLibrary): void {
    const ctx = this.ctx;
    const core = coreOf(ctx);
    const bodies = Object.values(defs.bodies).filter((b) => !b.emission && b.terrain);
    if (bodies.length === 0) return;
    this.pending++;
    const run = async (): Promise<void> => {
      // The server lists baked tile sets; a tile set that is not there is not requested (a 404 is a console error).
      const index = await fetch(`${ctx.tilesUrl}/index.json`, { cache: 'no-cache' });
      if (!index.ok) throw new Error(`${ctx.tilesUrl}/index.json: HTTP ${index.status}`);
      const baked = ((await index.json()) as { tilesets: string[] }).tilesets;
      for (const def of bodies) {
        const tileset = def.terrain!.tileset;
        if (!baked.includes(tileset)) continue;
        const base = `${ctx.tilesUrl}/${tileset}`;
        const mres = await fetch(`${base}/manifest.json`);
        if (!mres.ok) throw new Error(`${base}/manifest.json: HTTP ${mres.status}`);
        const g = ((await mres.json()) as TileManifest).globals?.albedoLowRes;
        if (!g) continue;
        const img = await fetch(`${base}/${g.path}`);
        if (!img.ok) throw new Error(`${base}/${g.path}: HTTP ${img.status}`);
        const bitmap = await createImageBitmap(await img.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        const tex = core.createTextureChecked({
          label: `${this.featureId}.albedo.${def.id}`,
          format: 'rgba8unorm-srgb',
          size: [bitmap.width, bitmap.height],
          mipLevelCount: mipCount(bitmap.width, bitmap.height),
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        ctx.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: tex }, [bitmap.width, bitmap.height]);
        core.mips.generate(tex);
        // A coarse copy on the CPU: the far image of the body takes the mean albedo of the face it shows from it.
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const c2d = canvas.getContext('2d', { willReadFrequently: true });
        if (c2d) {
          c2d.drawImage(bitmap, 0, 0);
          this.albedoGrids.set(def.id, albedoGridFromSrgb(c2d.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height));
        }
        bitmap.close();
        if (this.albedo.size < 4) this.albedo.set(def.id, { view: tex.createView(), slot: this.albedo.size });
        this.faceGroup = null;
        this.dataGeneration++;
      }
    };
    run()
      .catch((e: unknown) => core.reportError(`${this.featureId}: albedo maps: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => this.pending--);
  }

  /** Coarse linear-albedo grid of a body's albedoLowRes map, once it is loaded. */
  albedoGrid(bodyId: string): AlbedoGrid | undefined {
    return this.albedoGrids.get(bodyId);
  }

  setMilkyWay(view: GPUTextureView, luminanceScale: number, faceSize: number): void {
    this.milkyWay = view;
    this.milkyWayScale = luminanceScale;
    // The Milky Way mip whose texels are about the size of a probe texel.
    this.milkyWayMip = Math.max(0, Math.log2(faceSize / PROBE_SIZE));
    this.faceGroup = null;
    this.dataGeneration++;
  }

  /** Loading done and the published probe was built from all the data. */
  isIdle(): boolean {
    return this.pending === 0 && (this.state.holding || this.completedGeneration === this.dataGeneration);
  }

  info(): ProbeState {
    return { ...this.state, albedoMaps: [...this.albedo.keys()] };
  }

  dispose(): void {
    for (const t of [this.raw, this.probes, this.out]) t.destroy();
    for (const b of [this.shSlots, this.shOut, this.stepBuf, this.probeBuf]) b.destroy();
  }

  /** CPU part of one frame: pick the cycle step, upload the probe scene. */
  prepare(frame: FrameContext, defs: DefLibrary): boolean {
    const scene = probeSceneOf(frame, defs);
    this.state.holding = scene.cameraOffset > PROBE_MAX_CAMERA_OFFSET;
    if (this.state.holding) return false;
    this.state.scene = scene;
    const st = this.state.step;
    if (st === 0) {
      // Start a cycle: build into a slot that is neither of the two being blended.
      this.slots.next = [0, 1, 2].find((s) => s !== this.slots.prev && s !== this.slots.cur)!;
      this.cycleGeneration = this.dataGeneration;
    }
    const d = this.probeData;
    d.fill(0);
    d.set([scene.relCam.x, scene.relCam.y, scene.relCam.z, scene.bodies.length], 0);
    d.set([this.milkyWayScale, this.milkyWayMip, scene.skyViewBody, 0], 4);
    scene.bodies.slice(0, 4).forEach((b, i) => {
      const o = 8 + i * 8;
      d.set([b.centre.x, b.centre.y, b.centre.z, b.radius], o);
      d.set([b.frameIndex, b.altitude, b.weight, this.albedo.get(b.id)?.slot ?? -1], o + 4);
    });
    this.device.queue.writeBuffer(this.probeBuf, 0, d);
    const u = new Uint32Array(this.stepData, 0, 4);
    const fl = new Float32Array(this.stepData, 16, 4);
    u.set([Math.min(st, 5), this.slots.next * 6, this.slots.prev * 6, this.slots.cur * 6]);
    fl.set([(st + 1) / PROBE_CYCLE, this.slots.next, this.slots.prev, this.slots.cur]);
    this.device.queue.writeBuffer(this.stepBuf, 0, this.stepData);
    return true;
  }

  /** GPU part of one frame (in the compute hook, after prepare returned true). */
  encode(frame: FrameContext, encoder: GPUCommandEncoder): void {
    const device = this.device;
    const v = this.sceneBindings.version();
    if (!this.sceneGroup || v !== this.sceneVersion) {
      this.sceneVersion = v;
      this.sceneGroup = device.createBindGroup({ label: `${this.featureId}.probeScene`, layout: this.sceneLayout, entries: this.sceneBindings.entries() });
    }
    if (!this.faceGroup) {
      const maps = [this.blank, this.blank, this.blank, this.blank];
      for (const { view, slot } of this.albedo.values()) maps[slot] = view;
      this.faceGroup = device.createBindGroup({
        label: `${this.featureId}.probeFace`,
        layout: this.faceLayout,
        entries: [
          { binding: 0, resource: { buffer: this.probeBuf } },
          { binding: 1, resource: { buffer: this.stepBuf } },
          ...maps.map((resource, k) => ({ binding: 2 + k, resource })),
          { binding: 6, resource: this.milkyWay },
          { binding: 7, resource: this.raw.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1 }) },
        ],
      });
    }
    const st = this.state.step;
    // One timed pass per frame, named by the cycle step it runs (perf rows '<id>.probe.face|mips|prefilter';
    // passStats' mean of each is its amortised cost, the sum of the three means the probe's per-frame cost).
    const name = `${this.featureId}.probe.${st < 6 ? 'face' : st === 6 ? 'mips' : 'prefilter'}`;
    const pass = encoder.beginComputePass({ label: name, timestampWrites: this.ctx.perf.gpuPass(name) as GPUComputePassTimestampWrites | undefined });
    const groups = (n: number): number => Math.ceil(n / 8);
    if (st < 6) {
      pass.setPipeline(this.facePipeline.get());
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setBindGroup(1, this.sceneGroup);
      pass.setBindGroup(2, this.faceGroup);
      pass.dispatchWorkgroups(groups(PROBE_SIZE), groups(PROBE_SIZE));
    } else if (st === 6) {
      pass.setPipeline(this.downPipeline);
      for (let m = 1; m < RAW_MIPS; m++) {
        pass.setBindGroup(0, this.downGroups[m]!);
        pass.dispatchWorkgroups(groups(PROBE_SIZE >> m), groups(PROBE_SIZE >> m), 6);
      }
      pass.setPipeline(this.shPipeline);
      pass.setBindGroup(0, this.shGroup);
      pass.dispatchWorkgroups(1);
    } else {
      const m = st - 7;
      pass.setPipeline(this.prefilterPipelines[m]!);
      pass.setBindGroup(0, this.prefilterGroups[m]!);
      pass.dispatchWorkgroups(groups(PROBE_SIZE >> m), groups(PROBE_SIZE >> m), 6);
    }
    if (this.state.completed > 0) {
      for (let m = 0; m < PROBE_MIPS; m++) {
        pass.setPipeline(this.blendPipelines[m]!);
        pass.setBindGroup(0, this.blendGroups[m]!);
        pass.dispatchWorkgroups(groups(PROBE_SIZE >> m), groups(PROBE_SIZE >> m), 6);
      }
      pass.setPipeline(this.shBlendPipeline);
      pass.setBindGroup(0, this.shBlendGroup);
      pass.dispatchWorkgroups(1);
    }
    pass.end();

    if (st === PROBE_CYCLE - 1) {
      // The probe built in this cycle is complete: it becomes the target of the blend.
      this.state.completed++;
      if (this.state.completed === 1) this.slots.prev = this.slots.cur = this.slots.next;
      else {
        this.slots.prev = this.slots.cur;
        this.slots.cur = this.slots.next;
      }
      this.completedGeneration = this.cycleGeneration;
      this.state.step = 0;
      if (!this.published) {
        // First probe: the blend of the next frame writes it (prev = cur), so publish now.
        this.published = true;
        this.ctx.resources.publish('env.probeCube', this.out.createView({ dimension: 'cube' }));
        this.ctx.resources.publish('env.sh9', this.shOut);
      }
    } else {
      this.state.step = st + 1;
    }
  }

  /** Read back the published SH9 irradiance coefficients (9 x rgb, lux). */
  async readSh(): Promise<number[][]> {
    const device = this.device;
    const staging = device.createBuffer({ size: 9 * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(this.shOut, 0, staging, 0, 9 * 16);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return Array.from({ length: 9 }, (_, k) => [f[k * 4]!, f[k * 4 + 1]!, f[k * 4 + 2]!]);
  }

  /** Read back one face of one mip of the published cube as rgba float32 (row 0 = top). */
  async readFace(face: number, mip = 0): Promise<{ size: number; data: Float32Array }> {
    const device = this.device;
    const size = PROBE_SIZE >> mip;
    const bytesPerRow = Math.ceil((size * 8) / 256) * 256;
    const staging = device.createBuffer({ size: bytesPerRow * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.out, mipLevel: mip, origin: [0, 0, face] }, { buffer: staging, bytesPerRow }, [size, size, 1]);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const raw = new Uint16Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    const data = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size * 4; x++) data[y * size * 4 + x] = f16ToF32(raw[(y * bytesPerRow) / 2 + x]!);
    return { size, data };
  }
}
