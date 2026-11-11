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
import { cameraBasis, coreOf, f16ToF32, MAX_BODIES, readTexturePixels, type CoreApi, type ManagedTarget, type Tracked } from '@/render/core';
import { CloudSystem, type CoverageImage } from './clouds';
import { AERIAL_SIZE, MULTISCATTER_LUT_SIZE, SKY_IRRADIANCE_LUT_SIZE, SKY_VIEW_LUT_SIZE, TRANSMITTANCE_LUT_SIZE } from './math';
import { atmosphereLayers, scissorOf, selectMarchBodies, type AtmosphereLayer, type MarchSelection } from './select';
import { CLOUD_SHADOW_WGSL, COMPOSITE_BLEND, compositeFsWgsl, MARCH_FS_WGSL } from './shaders/march';
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
  /** What the last frame marched. */
  selection(): { bodies: { bodyId: string; bodyIndex: number; layer: number; steps: number }[]; cloudBodyId: string | null; scissor: [number, number, number, number] | null };
  /** The cloud system (null when clouds are off or no frame body has clouds). */
  clouds(): CloudSystem | null;
}

export interface AtmosphereFeature extends RenderFeature {
  /** Rebuild the static tables on the next frame (after editing atmosphere definitions at run time). */
  invalidate(): void;
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

  const bodyDef = (frame: FrameContext, index: number): BodyDef => ctx.defs.bodies[frame.bodies[index]!.id]!;

  const publish = (): void => {
    const r = ctx.resources;
    if (tables.transmittanceView && tables.irradianceView) {
      r.publish('atmosphere.transmittanceLut', tables.transmittanceView);
      r.publish('atmosphere.skyIrradianceLut', tables.irradianceView);
    }
    r.publish('atmosphere.skyViewLut', active ? tables.skyViewView : tables.neutralSkyView);
    r.publish('atmosphere.aerialPerspective', active ? tables.aerialView : tables.neutralAerial);
    const cloudsOn = active && clouds !== null && cloudBodyIndex >= 0;
    r.publish('clouds.screen', cloudsOn ? clouds!.screenView : neutralCloudScreen);
    r.publish('clouds.depth', cloudsOn ? clouds!.depthView : neutralCloudDepth);
    if (clouds) {
      r.publish('clouds.shadowMap', clouds.shadowView);
      r.publish('clouds.coverageMap', clouds.coverageView);
    }
  };

  const ensureGroups = (): void => {
    const cloudsOn = clouds !== null && cloudBodyIndex >= 0;
    const key = [
      tables.version,
      clouds?.version ?? -1,
      cloudsOn ? 1 : 0,
      ctx.resources.version('scene.depthHalf'),
      ctx.resources.version('scene.depth'),
      ...marchTargets.map((t) => t.version),
    ].join(':');
    if (key === groupKey && marchGroup && compositeGroup) return;
    groupKey = key;
    marchGroup = device.createBindGroup({
      label: `${id}.march`,
      layout: marchLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: tables.transmittanceView! },
        { binding: 2, resource: tables.multiScatterView! },
        { binding: 3, resource: clouds ? clouds.shadowView : neutralShadow },
        { binding: 4, resource: clouds ? clouds.coverageView : neutralCoverage },
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
  };

  const feature: AtmosphereFeature = {
    id,
    order: opts.order ?? 0,

    init(c) {
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
      neutralCloudDepth = solid(`${id}.neutral.cloudDepth`, 'r32float', new Float32Array([3.0e38]));
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
        entries: [tex(0, 'unfilterable-float'), tex(1, 'unfilterable-float'), tex(2, 'unfilterable-float'), tex(3, 'unfilterable-float'), tex(4, 'unfilterable-float'), tex(5, 'depth')],
      });
      marchPipeline = core.fullscreenPipeline({
        label: `${id}.march`,
        fragment: MARCH_FS_WGSL,
        layouts: [marchLayout],
        targets: marchTargets.map(() => ({ format: HALF_FORMAT })),
      });
      marchPipeline.get();

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
      for (const p of compositePipelines) p.get();

      if (opts.clouds !== false) {
        const hasClouds = Object.values(c.defs.bodies).some((b) => b.render.clouds && b.render.atmosphere);
        if (hasClouds) clouds = new CloudSystem(c, uniformBuffer, { id, coverageMaps: opts.coverageMaps });
      }
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
      if (cloudBodyIndex < 0) u.set('misc', 1, 0, frame.animate ? 1 : 0, 1);
      device.queue.writeBuffer(uniformBuffer, 0, u.buffer);

      // Static tables follow the definitions of the layer bodies; the irradiance table also follows the sun.
      signature = layers.map((l) => `${l.bodyId}:${JSON.stringify(bodyDef(frame, l.bodyIndex).render.atmosphere)}:${bodyDef(frame, l.bodyIndex).radius}`).join('|');
      tables.configure(layers.length, signature, frame.sun.illuminance, {
        uniforms: uniformBuffer,
        shadowMap: clouds ? clouds.shadowView : neutralShadow,
        coverageMap: clouds ? clouds.coverageView : neutralCoverage,
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
      // The shells of the selected bodies bound everything this hook draws; elsewhere the buffers keep
      // their neutral clear values and the HDR target is left untouched.
      const halfScissor = scissorOf(bounds, halfW, halfH, 2);
      const fullScissor = scissorOf(bounds, rw, rh, 2);
      lastScissor = fullScissor;
      if (halfScissor[2] === 0 || halfScissor[3] === 0 || fullScissor[2] === 0 || fullScissor[3] === 0) return;

      const cloudsOn = clouds !== null && cloudBodyIndex >= 0;
      if (cloudsOn) clouds!.march(frame, encoder, bounds);
      ensureGroups();

      const clear = (view: GPUTextureView, value: number): GPURenderPassColorAttachment => ({ view, clearValue: { r: value, g: value, b: value, a: 1 }, loadOp: 'clear', storeOp: 'store' });
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
      if (cloudsOn) clouds!.endFrame(frame, encoder);
    },

    isIdle() {
      return (layers.length === 0 || tables.ready) && (clouds ? clouds.isIdle() : true);
    },

    dispose() {
      tables.dispose();
      clouds?.dispose();
      for (const t of marchTargets) t.destroy();
      uniformBuffer.destroy();
    },

    invalidate() {
      tables.invalidate();
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
