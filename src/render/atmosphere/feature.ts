/**
 * The atmosphere feature: physically based scattering tables, the unified per-pixel march, volumetric
 * clouds with their shadows, and the buffers that transparents need (aerial-perspective volume, cloud
 * radiance / transmittance / distance). One RenderFeature; everything is driven by BodyDef.render of the
 * bodies in the frame, nothing is specific to one body.
 *
 * Frame:
 *   prepare              pick the atmosphere bodies in range and the cloud body, fill the uniform block,
 *                        place the cloud shadow maps (coreOf(ctx).setCloudShadowParams), publish resources
 *   compute              cloud noise (once), cloud shadow map refresh, static tables when stale,
 *                        sky-view table and aerial-perspective volume
 *   compositeAtmosphere  cloud march + temporal resolve, half-resolution atmosphere march, one blend into HDR
 */
import type { BodyDef } from '@/core/contracts/defs';
import { RENDER_FORMATS, type FrameContext, type RenderContext, type RenderFeature } from '@/core/contracts/render';
import { cameraBasis, coreOf, f16ToF32, MAX_BODIES, readTexturePixels, type CoreApi, type ManagedTarget, type TemporalFeature, type Tracked } from '@/render/core';
import { airglowShows, resolveAirglow, type AirglowLayer } from './airglow';
import { CloudSystem, type CoverageImage } from './clouds';
import { AERIAL_SIZE, MULTISCATTER_LUT_SIZE, SKY_IRRADIANCE_LUT_SIZE, SKY_VIEW_LUT_SIZE, TRANSMITTANCE_LUT_SIZE } from './math';
import { atmosphereLayers, FINE_TILE_SIZE, fitsFineTile, scissorOf, selectMarchBodies, type AtmosphereLayer, type MarchSelection } from './select';
import { CLOUD_SHADOW_WGSL, COMPOSITE_BLEND, compositeFineFsWgsl, compositeFsWgsl, marchFsWgsl } from './shaders/march';
import { ATMOSPHERE_MODEL_WGSL } from './shaders/model';
import { AtmosphereTables } from './tables';
import { ATMO_UNIFORM_BYTES, AtmoUniforms } from './uniforms';

export interface AtmosphereFeatureOptions {
  /** Feature id (prefix of the pass names) and order within each hook. */
  id?: string;
  order?: number;
  /** Draw volumetric clouds on bodies that define them (default true). */
  clouds?: boolean;
  /**
   * March a shell whose screen rectangle fits into the tile (FINE_TILE_SIZE) at full resolution (default
   * true). False keeps the half-resolution march at every distance: an A/B switch for labs and for the
   * spec that proves the difference, never for the app.
   */
  fineTile?: boolean;
  /**
   * Coverage maps supplied by the caller instead of the tile set's global map, by body id (labs and tests):
   * equirectangular, row 0 = north, column 0 = longitude -180 deg, two bytes per texel
   * (coverage 0..255, cloud top in units of 50 m).
   */
  coverageMaps?: Record<string, CoverageImage>;
}

export type AtmosphereTableName = 'transmittance' | 'multiScatter' | 'irradiance' | 'skyView' | 'aerial';

export interface AtmosphereDebug {
  /** Read a table back: rgba float32, layer by layer (aerial: slice by slice), row 0 first. */
  readTable(name: AtmosphereTableName): Promise<{ width: number; height: number; layers: number; data: Float32Array }>;
  /** What the last frame marched; `fine` = at full resolution in the tile (a small shell) instead of at half resolution. */
  selection(): { bodies: { bodyId: string; bodyIndex: number; layer: number; steps: number }[]; cloudBodyId: string | null; scissor: [number, number, number, number] | null; fine: boolean };
  /** The cloud system (null when clouds are off or no frame body has clouds). */
  clouds(): CloudSystem | null;
}

/**
 * What the feature builds or loads once, for a loading screen (request app-integration-11): the static
 * scattering tables of the bodies in the frame (false until the first frame with an atmosphere body has
 * built them, and again while they are rebuilt), the cloud noise volumes, and the cloud coverage maps asked
 * for so far (0 of 0 before the first frame with a cloud body in range; without clouds: noise ready, 0 of 0).
 */
export interface AtmosphereStatus {
  tablesReady: boolean;
  noiseReady: boolean;
  coverage: { loaded: number; total: number };
}

export interface AtmosphereFeature extends RenderFeature, TemporalFeature {
  /** Rebuild the static tables on the next frame (after editing atmosphere definitions at run time). */
  invalidate(): void;
  /**
   * Start everything that is refined over frames again (the core calls it at every restart of the temporal
   * sequences: frame-exact captures, RENDER_API section 13): the clouds' radiance and geometry history, the
   * cloud shadow map (marched whole in the next frame, with its extent and axes chosen from the scene as on
   * a fresh page), the light-change detection, the cloud clock (snapped to simulation time). The frames after
   * it depend on the scene and on their count alone. Starts no work: `isIdle()` is what it was.
   */
  resetTemporal(): void;
  /** Progress of the one-off work (tables, cloud noise, coverage maps). Does not change `isIdle()`. */
  status(): AtmosphereStatus;
  readonly debug: AtmosphereDebug;
}

const HALF_FORMAT: GPUTextureFormat = 'rgba16float';

/**
 * Create the atmosphere / cloud feature. Register it with `renderer.addFeature()`; `init` receives the
 * RenderContext. (A RenderContext passed here instead of options is accepted and ignored, for callers that
 * follow the brief's `createAtmosphereFeature(ctx)` spelling.)
 */
export function createAtmosphereFeature(options: AtmosphereFeatureOptions | RenderContext = {}): AtmosphereFeature {
  const opts: AtmosphereFeatureOptions = 'device' in options ? {} : options;
  const id = opts.id ?? 'atmosphere';

  let ctx: RenderContext;
  let core: CoreApi;
  let device: GPUDevice;
  let tables: AtmosphereTables;
  let clouds: CloudSystem | null = null;
  const uniforms = new AtmoUniforms();
  let uniformBuffer: GPUBuffer;

  let marchTargets: ManagedTarget[] = [];
  let marchLayout: GPUBindGroupLayout;
  let compositeLayout: GPUBindGroupLayout;
  let marchPipeline: Tracked<GPURenderPipeline>;
  let compositePipelines: Tracked<GPURenderPipeline>[] = [];
  let marchGroup: GPUBindGroup | null = null;
  let compositeGroup: GPUBindGroup | null = null;
  let groupKey = '';
  const groupCache = new Map<string, [GPUBindGroup, GPUBindGroup, GPUBindGroup, GPUBindGroup]>();

  // Full-resolution march of a small shell (see marchFsWgsl): tile targets and their own pipelines.
  let fineTargets: GPUTexture[] = [];
  let fineViews: GPUTextureView[] = [];
  let compositeFineLayout: GPUBindGroupLayout;
  let marchFinePipeline: Tracked<GPURenderPipeline>;
  let compositeFinePipelines: Tracked<GPURenderPipeline>[] = [];
  let marchFineGroup: GPUBindGroup | null = null;
  let compositeFineGroup: GPUBindGroup | null = null;
  let fine = false;
  let fullScissor: [number, number, number, number] = [0, 0, 0, 0];

  // Neutral stand-ins for the cloud inputs of the atmosphere passes.
  let neutralCloudScreen: GPUTextureView;
  let neutralCloudDepth: GPUTextureView;
  let neutralCloudGeom: GPUTextureView;
  let neutralShadow: GPUTextureView;
  let neutralCoverage: GPUTextureView;

  let layers: AtmosphereLayer[] = [];
  let selection: MarchSelection = { bodies: [], bounds: null };
  let cloudBodyIndex = -1;
  let lastScissor: [number, number, number, number] | null = null;
  let signature = '';
  let active = false;
  /** Airglow layers by body id (resolved once per definition; problems reported once). */
  const airglow = new Map<string, { signature: string; layers: AirglowLayer[] }>();
  const airglowOf = (def: BodyDef): AirglowLayer[] => {
    const atm = def.render.atmosphere;
    if (!atm) return [];
    const signature = JSON.stringify(atm.airglow ?? null);
    const known = airglow.get(def.id);
    if (known && known.signature === signature) return known.layers;
    const r = resolveAirglow(atm);
    for (const problem of r.problems) core.reportError(`${id}: ${def.id}.atmosphere: ${problem}`);
    airglow.set(def.id, { signature, layers: r.layers });
    return r.layers;
  };

  const bodyDef = (frame: FrameContext, index: number): BodyDef => ctx.defs.bodies[frame.bodies[index]!.id]!;

  const publish = (): void => {
    const r = ctx.resources;
    if (tables.transmittanceView && tables.irradianceView) {
      r.publish('atmosphere.transmittanceLut', tables.transmittanceView);
      r.publish('atmosphere.skyIrradianceLut', tables.irradianceView);
    }
    r.publish('atmosphere.skyViewLut', active ? tables.skyViewView : tables.neutralSkyView);
    r.publish('atmosphere.aerialPerspective', active ? tables.aerialView : tables.neutralAerial);
    r.publish('atmosphere.aerialTransmittance', active ? tables.aerialTransView : tables.neutralAerialTrans);
    const cloudsOn = active && clouds !== null && cloudBodyIndex >= 0;
    r.publish('clouds.screen', cloudsOn ? clouds!.screenView : neutralCloudScreen);
    r.publish('clouds.depth', cloudsOn ? clouds!.depthView : neutralCloudDepth);
    if (clouds) {
      r.publish('clouds.shadowMap', clouds.shadowView);
      r.publish('clouds.coverageMap', clouds.coverageCoreView);
    }
  };

  const ensureGroups = (): void => {
    const cloudsOn = clouds !== null && cloudBodyIndex >= 0;
    const key = [
      tables.version,
      clouds?.version ?? -1,
      clouds?.parity ?? 0,
      cloudsOn ? 1 : 0,
      ctx.resources.version('scene.depthHalf'),
      ctx.resources.version('scene.depth'),
      ...marchTargets.map((t) => t.version),
    ].join(':');
    if (key === groupKey && marchGroup && compositeGroup) return;
    groupKey = key;
    // (The cloud geometry alternates between two targets: two sets of groups are kept, one per parity.)
    const cached = groupCache.get(key);
    if (cached) {
      [marchGroup, compositeGroup, marchFineGroup, compositeFineGroup] = cached;
      return;
    }
    if (groupCache.size >= 2) groupCache.clear();
    marchGroup = device.createBindGroup({
      label: `${id}.march`,
      layout: marchLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: tables.transmittanceView! },
        { binding: 2, resource: tables.multiScatterView! },
        { binding: 3, resource: clouds ? clouds.shadowMomentView : neutralShadow },
        { binding: 4, resource: clouds ? clouds.coverageWideView : neutralCoverage },
        { binding: 5, resource: ctx.resources.get('scene.depthHalf') },
        { binding: 6, resource: cloudsOn ? clouds!.screenView : neutralCloudScreen },
        { binding: 7, resource: cloudsOn ? clouds!.geomView : neutralCloudGeom },
        { binding: 8, resource: ctx.resources.get('scene.depth') },
      ],
    });
    compositeGroup = device.createBindGroup({
      label: `${id}.composite`,
      layout: compositeLayout,
      entries: [
        ...marchTargets.map((t, binding) => ({ binding, resource: t.view })),
        { binding: 4, resource: ctx.resources.get('scene.depthHalf') },
        { binding: 5, resource: ctx.resources.get('scene.depth') },
      ],
    });
    marchFineGroup = device.createBindGroup({
      label: `${id}.marchFine`,
      layout: marchLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: tables.transmittanceView! },
        { binding: 2, resource: tables.multiScatterView! },
        { binding: 3, resource: clouds ? clouds.shadowMomentView : neutralShadow },
        { binding: 4, resource: clouds ? clouds.coverageWideView : neutralCoverage },
        { binding: 5, resource: ctx.resources.get('scene.depthHalf') },
        { binding: 6, resource: cloudsOn ? clouds!.fineColorView : neutralCloudScreen },
        { binding: 7, resource: cloudsOn ? clouds!.fineGeomView : neutralCloudGeom },
        { binding: 8, resource: ctx.resources.get('scene.depth') },
      ],
    });
    compositeFineGroup = device.createBindGroup({
      label: `${id}.compositeFine`,
      layout: compositeFineLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: fineViews[0]! },
        { binding: 2, resource: fineViews[1]! },
      ],
    });
    groupCache.set(key, [marchGroup, compositeGroup, marchFineGroup, compositeFineGroup]);
  };

  const feature: AtmosphereFeature = {
    id,
    order: opts.order ?? 0,

    async init(c) {
      ctx = c;
      core = coreOf(c);
      device = c.device;
      c.shaders.register('atmosphere_model', ATMOSPHERE_MODEL_WGSL);
      c.shaders.register('atmosphere_cloud_shadow', CLOUD_SHADOW_WGSL);

      uniformBuffer = device.createBuffer({ label: `${id}.uniforms`, size: ATMO_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      tables = new AtmosphereTables(c);

      const solid = (label: string, format: GPUTextureFormat, texel: ArrayBufferView<ArrayBuffer>): GPUTextureView => {
        const t = device.createTexture({ label, format, size: [1, 1], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        device.queue.writeTexture({ texture: t }, texel, {}, [1, 1]);
        return t.createView();
      };
      neutralCloudScreen = solid(`${id}.neutral.cloudScreen`, 'rgba16float', new Uint16Array([0, 0, 0, 0x3c00]));
      neutralCloudDepth = solid(`${id}.neutral.cloudDepth`, 'rg32float', new Float32Array([3.0e38, 3.0e38]));
      neutralCloudGeom = solid(`${id}.neutral.cloudGeom`, 'rgba32float', new Float32Array([3.0e38, 3.0e38, 3.0e38, 0]));
      neutralShadow = solid(`${id}.neutral.shadow`, 'rgba16float', new Uint16Array([0, 0, 0, 0]));
      neutralCoverage = solid(`${id}.neutral.coverage`, 'r8unorm', new Uint8Array([0, 0, 0, 0]));

      marchTargets = ['addFar', 'mulFar', 'addNear', 'mulNear'].map((n) => core.createTarget(`${id}.march.${n}`, HALF_FORMAT, 0.5));

      const tex = (binding: number, sampleType: GPUTextureSampleType = 'float', viewDimension: GPUTextureViewDimension = '2d'): GPUBindGroupLayoutEntry => ({
        binding,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType, viewDimension },
      });
      marchLayout = device.createBindGroupLayout({
        label: `${id}.march`,
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          tex(1, 'float', '2d-array'),
          tex(2, 'float', '2d-array'),
          tex(3),
          tex(4),
          tex(5, 'unfilterable-float'),
          tex(6),
          tex(7, 'unfilterable-float'),
          tex(8, 'depth'),
        ],
      });
      compositeLayout = device.createBindGroupLayout({
        label: `${id}.composite`,
        entries: [tex(0), tex(1), tex(2, 'unfilterable-float'), tex(3, 'unfilterable-float'), tex(4, 'unfilterable-float'), tex(5, 'depth')],
      });
      marchPipeline = core.fullscreenPipeline({
        label: `${id}.march`,
        fragment: marchFsWgsl(false),
        layouts: [marchLayout],
        targets: marchTargets.map(() => ({ format: HALF_FORMAT })),
      });
      fineTargets = ['add', 'mul'].map((n) =>
        core.createTextureChecked({ label: `${id}.marchFine.${n}`, format: HALF_FORMAT, size: [FINE_TILE_SIZE, FINE_TILE_SIZE], usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }),
      );
      fineViews = fineTargets.map((t) => t.createView());
      compositeFineLayout = device.createBindGroupLayout({
        label: `${id}.compositeFine`,
        entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }, tex(1, 'unfilterable-float'), tex(2, 'unfilterable-float')],
      });
      marchFinePipeline = core.fullscreenPipeline({
        label: `${id}.marchFine`,
        fragment: marchFsWgsl(true),
        layouts: [marchLayout],
        targets: fineTargets.map(() => ({ format: HALF_FORMAT })),
      });

      // One blend into the HDR target: add + mul x destination. Dual-source blending does it in one draw;
      // without the feature the same result takes a multiply draw followed by an add draw in the same pass.
      const modes: ('dual' | 'mul' | 'add')[] = device.features.has('dual-source-blending') ? ['dual'] : ['mul', 'add'];
      compositePipelines = modes.map((mode) =>
        core.shaders.tracked(() => {
          const module = c.shaders.createModule(`${id}.composite.${mode}`, compositeFsWgsl(mode));
          return device.createRenderPipeline({
            label: `${id}.composite.${mode}`,
            layout: device.createPipelineLayout({ label: `${id}.composite`, bindGroupLayouts: [c.frameBindGroupLayout, compositeLayout] }),
            vertex: { module, entryPoint: 'fullscreenVs' },
            fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: COMPOSITE_BLEND[mode] }] },
            primitive: { topology: 'triangle-list' },
          });
        }),
      );
      compositeFinePipelines = modes.map((mode) =>
        core.shaders.tracked(() => {
          const module = c.shaders.createModule(`${id}.compositeFine.${mode}`, compositeFineFsWgsl(mode));
          return device.createRenderPipeline({
            label: `${id}.compositeFine.${mode}`,
            layout: device.createPipelineLayout({ label: `${id}.compositeFine`, bindGroupLayouts: [c.frameBindGroupLayout, compositeFineLayout] }),
            vertex: { module, entryPoint: 'fullscreenVs' },
            fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: COMPOSITE_BLEND[mode] }] },
            primitive: { topology: 'triangle-list' },
          });
        }),
      );

      if (opts.clouds !== false) {
        const hasClouds = Object.values(c.defs.bodies).some((b) => b.render.clouds && b.render.atmosphere);
        if (hasClouds) clouds = new CloudSystem(c, uniformBuffer, { id, coverageMaps: opts.coverageMaps });
      }
      // Every pipeline of the package is created ahead, off the GPU process's main thread (RENDER_API 17.8):
      // a `get()` where a pass is drawn then costs nothing.
      await core.shaders.warm([marchPipeline, marchFinePipeline, ...compositePipelines, ...compositeFinePipelines, ...tables.pipelines(), ...(clouds ? clouds.pipelines() : [])]);
    },

    prepare(frame) {
      layers = atmosphereLayers(frame.bodies, ctx.defs, MAX_BODIES);
      const basis = cameraBasis(frame.camera);
      const [rw, rh] = frame.renderSize;
      const tanY = Math.tan(frame.camera.fovY / 2);
      selection = selectMarchBodies(layers, frame.bodies, ctx.defs, { ...basis, tanHalfFovX: (tanY * rw) / rh, tanHalfFovY: tanY }, {
        baseSteps: ctx.quality.atmosphereSteps,
        qualityScale: frame.qualityScale,
        renderHeight: rh,
        fovY: frame.camera.fovY,
      });
      active = selection.bodies.length > 0;

      const u = uniforms;
      const b0 = selection.bodies[0];
      const b1 = selection.bodies[1];
      const halfW = Math.ceil(rw / 2);
      const halfH = Math.ceil(rh / 2);
      cloudBodyIndex = active && clouds ? clouds.prepare(frame, u, selection.bodies) : -1;
      if (clouds && cloudBodyIndex < 0) clouds.disable(u);
      if (!clouds) {
        u.set('shadowOrigin', 0, 0, 0, 0);
        u.set('far', 0, 0, 0, 0);
        u.set('cloudShell', 0, 0, 0, 0);
      }
      u.set('bodies', b0 ? b0.bodyIndex : -1, b1 ? b1.bodyIndex : -1, cloudBodyIndex, b0 ? b0.bodyIndex : -1);
      u.set('layers', b0 ? b0.layer : 0, b1 ? b1.layer : 0, layers.length, clouds ? clouds.phase : 0);
      u.set('lutBody', layers[0]?.bodyIndex ?? 0, layers[1]?.bodyIndex ?? 0, layers[2]?.bodyIndex ?? 0, layers[3]?.bodyIndex ?? 0);
      u.set('steps', b0 ? b0.steps : 0, b1 ? b1.steps : 0, 32, clouds ? clouds.stepBudget(frame) : 0);
      u.set('halfSize', halfW, halfH, 1 / halfW, 1 / halfH);
      ([b0, b1] as const).forEach((b, slot) => {
        // (Only where the frame's exposure can show it: see airglowShows.)
        const layersOf = b ? airglowOf(bodyDef(frame, b.bodyIndex)) : [];
        const glow = b && airglowShows(layersOf, bodyDef(frame, b.bodyIndex).radius, frame.exposure) ? layersOf : [];
        const geo = slot === 0 ? 'airglow0' : 'airglow1';
        u.set(geo, glow[0]?.altitude ?? 0, glow[0]?.sigma ?? 0, glow[1]?.altitude ?? 0, glow[1]?.sigma ?? 0);
        for (let l = 0; l < 2; l++) {
          const e = glow[l]?.emission ?? [0, 0, 0];
          u.set(slot === 0 ? (l === 0 ? 'airglow0C0' : 'airglow0C1') : l === 0 ? 'airglow1C0' : 'airglow1C1', e[0], e[1], e[2], 0);
        }
      });
      // The shells of the selected bodies bound everything the composite hook draws. A rectangle that fits
      // into the tile is marched at full resolution there.
      fullScissor = selection.bounds ? scissorOf(selection.bounds, rw, rh, 2) : [0, 0, 0, 0];
      const texelOnBody = b0 ? (Math.max(b0.distance - bodyDef(frame, b0.bodyIndex).radius, 0) * 2 * tanY) / halfH : 0;
      fine = active && opts.fineTile !== false && fitsFineTile(fullScissor, texelOnBody, b0 ? bodyDef(frame, b0.bodyIndex).render.atmosphere!.topAltitude : 0);
      u.set('tile', fullScissor[0], fullScissor[1], fullScissor[2], fullScissor[3]);
      if (cloudBodyIndex < 0) u.set('misc', 1, 0, frame.animate ? 1 : 0, 1);
      device.queue.writeBuffer(uniformBuffer, 0, u.buffer);

      // Static tables follow the definitions of the layer bodies; the irradiance table also follows the sun.
      signature = layers.map((l) => `${l.bodyId}:${JSON.stringify(bodyDef(frame, l.bodyIndex).render.atmosphere)}:${bodyDef(frame, l.bodyIndex).radius}`).join('|');
      tables.configure(layers.length, signature, frame.sun.illuminance, {
        uniforms: uniformBuffer,
        shadowMap: clouds ? clouds.shadowMomentView : neutralShadow,
        coverageMap: clouds ? clouds.coverageView : neutralCoverage,
        coverageWide: clouds ? clouds.coverageWideView : neutralCoverage,
      });
      publish();
    },

    compute(frame, encoder) {
      if (layers.length === 0) return;
      if (clouds) clouds.compute(frame, encoder, cloudBodyIndex >= 0);
      tables.encode(frame, encoder, active);
    },

    compositeAtmosphere(frame, encoder, hdrTarget) {
      if (!active || !tables.transmittanceView) return;
      const [rw, rh] = frame.renderSize;
      const halfW = Math.ceil(rw / 2);
      const halfH = Math.ceil(rh / 2);
      const bounds = selection.bounds!;
      // Outside the rectangle of the shells the buffers keep their neutral clear values and the HDR target
      // is left untouched.
      const halfScissor = scissorOf(bounds, halfW, halfH, 2);
      lastScissor = fullScissor;
      if (halfScissor[2] === 0 || halfScissor[3] === 0 || fullScissor[2] === 0 || fullScissor[3] === 0) return;

      const cloudsOn = clouds !== null && cloudBodyIndex >= 0;
      if (cloudsOn) clouds!.march(frame, encoder, bounds);
      ensureGroups();

      const clear = (view: GPUTextureView, value: number): GPURenderPassColorAttachment => ({ view, clearValue: { r: value, g: value, b: value, a: 1 }, loadOp: 'clear', storeOp: 'store' });
      if (fine) {
        // A small shell: clouds and atmosphere once per full-resolution pixel of its rectangle, composited
        // texel for texel. (The half-resolution cloud buffers above are for the transparents.)
        const [, , tw, th] = fullScissor;
        if (cloudsOn) clouds!.marchFine(frame, encoder, tw, th);
        {
          const pass = encoder.beginRenderPass({
            label: `${id}.march`,
            colorAttachments: [clear(fineViews[0]!, 0), clear(fineViews[1]!, 1)],
            timestampWrites: ctx.perf.gpuPass(`${id}.march`) as GPURenderPassTimestampWrites | undefined,
          });
          pass.setBindGroup(0, frame.frameBindGroup);
          pass.setPipeline(marchFinePipeline.get());
          pass.setBindGroup(1, marchFineGroup!);
          pass.setScissorRect(0, 0, tw, th);
          pass.draw(3);
          pass.end();
        }
        {
          const pass = encoder.beginRenderPass({
            label: `${id}.composite`,
            colorAttachments: [{ view: hdrTarget, loadOp: 'load', storeOp: 'store' }],
            timestampWrites: ctx.perf.gpuPass(`${id}.composite`) as GPURenderPassTimestampWrites | undefined,
          });
          pass.setBindGroup(0, frame.frameBindGroup);
          pass.setBindGroup(1, compositeFineGroup!);
          pass.setScissorRect(...fullScissor);
          for (const p of compositeFinePipelines) {
            pass.setPipeline(p.get());
            pass.draw(3);
          }
          pass.end();
        }
        if (cloudsOn) clouds!.endFrame(frame);
        return;
      }
      {
        const pass = encoder.beginRenderPass({
          label: `${id}.march`,
          colorAttachments: [clear(marchTargets[0]!.view, 0), clear(marchTargets[1]!.view, 1), clear(marchTargets[2]!.view, 0), clear(marchTargets[3]!.view, 1)],
          timestampWrites: ctx.perf.gpuPass(`${id}.march`) as GPURenderPassTimestampWrites | undefined,
        });
        pass.setBindGroup(0, frame.frameBindGroup);
        pass.setPipeline(marchPipeline.get());
        pass.setBindGroup(1, marchGroup!);
        pass.setScissorRect(...halfScissor);
        pass.draw(3);
        pass.end();
      }
      {
        const pass = encoder.beginRenderPass({
          label: `${id}.composite`,
          colorAttachments: [{ view: hdrTarget, loadOp: 'load', storeOp: 'store' }],
          timestampWrites: ctx.perf.gpuPass(`${id}.composite`) as GPURenderPassTimestampWrites | undefined,
        });
        pass.setBindGroup(0, frame.frameBindGroup);
        pass.setBindGroup(1, compositeGroup!);
        pass.setScissorRect(...fullScissor);
        for (const p of compositePipelines) {
          pass.setPipeline(p.get());
          pass.draw(3);
        }
        pass.end();
      }
      if (cloudsOn) clouds!.endFrame(frame);
    },

    isIdle() {
      return (layers.length === 0 || tables.ready) && (clouds ? clouds.isIdle() : true);
    },

    dispose() {
      tables.dispose();
      clouds?.dispose();
      for (const t of marchTargets) t.destroy();
      for (const t of fineTargets) t.destroy();
      uniformBuffer.destroy();
    },

    invalidate() {
      tables.invalidate();
    },

    resetTemporal() {
      clouds?.resetTemporal();
    },

    status() {
      const c = clouds ? clouds.status() : { noiseReady: true, coverage: { loaded: 0, total: 0 } };
      return { tablesReady: tables.ready, noiseReady: c.noiseReady, coverage: c.coverage };
    },

    debug: {
      async readTable(name) {
        const t = tables.textures()[name];
        const sizes: Record<AtmosphereTableName, [number, number]> = {
          transmittance: [TRANSMITTANCE_LUT_SIZE[0], TRANSMITTANCE_LUT_SIZE[1]],
          multiScatter: [MULTISCATTER_LUT_SIZE[0], MULTISCATTER_LUT_SIZE[1]],
          irradiance: [SKY_IRRADIANCE_LUT_SIZE[0], SKY_IRRADIANCE_LUT_SIZE[1]],
          skyView: [SKY_VIEW_LUT_SIZE[0], SKY_VIEW_LUT_SIZE[1]],
          aerial: [AERIAL_SIZE, AERIAL_SIZE],
        };
        const [width, height] = sizes[name];
        if (!t) return { width, height, layers: 0, data: new Float32Array(0) };
        const count = t.depthOrArrayLayers;
        const data = new Float32Array(width * height * 4 * count);
        for (let z = 0; z < count; z++) {
          const raw = new Uint16Array(await readLayer(device, t, width, height, z));
          for (let i = 0; i < raw.length; i++) data[z * width * height * 4 + i] = f16ToF32(raw[i]!);
        }
        return { width, height, layers: count, data };
      },
      selection() {
        return {
          bodies: selection.bodies.map((b) => ({ bodyId: b.bodyId, bodyIndex: b.bodyIndex, layer: b.layer, steps: b.steps })),
          cloudBodyId: cloudBodyIndex >= 0 ? (layers.find((l) => l.bodyIndex === cloudBodyIndex)?.bodyId ?? null) : null,
          scissor: lastScissor,
          fine,
        };
      },
      clouds: () => clouds,
    },
  };
  return feature;
}

/** Read one array layer / depth slice of an rgba16float texture. */
async function readLayer(device: GPUDevice, texture: GPUTexture, width: number, height: number, z: number): Promise<ArrayBuffer> {
  if (z === 0 && texture.depthOrArrayLayers === 1) return readTexturePixels(device, texture, { x: 0, y: 0, width, height }, 8);
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
  const buffer = device.createBuffer({ label: 'atmosphere.readback', size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder({ label: 'atmosphere.readback' });
  encoder.copyTextureToBuffer({ texture, origin: [0, 0, z] }, { buffer, bytesPerRow }, [width, height, 1]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buffer.getMappedRange());
  const out = new Uint8Array(width * height * 8);
  for (let y = 0; y < height; y++) out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + width * 8), y * width * 8);
  buffer.unmap();
  buffer.destroy();
  return out.buffer;
}
