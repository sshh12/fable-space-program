/**
 * GPU tables of the atmosphere feature and the compute passes that fill them:
 *   transmittance 256 x 64 x layers   'atmosphere.transmittanceLut'   (static: rebuilt when the body data change)
 *   multi-scattering 32 x 32 x layers  private                         (static)
 *   sky irradiance 64 x 16 x layers    'atmosphere.skyIrradianceLut'   (rebuilt when the sun's illuminance changes)
 *   sky view 192 x 108                 'atmosphere.skyViewLut'         (every frame, around the camera)
 *   aerial perspective 32^3            'atmosphere.aerialPerspective'  (every frame, camera frustum)
 * One layer per frame body WITH an atmosphere, in frame-body order (the layer index the render core puts in
 * BodyUniform.fixedX.w).
 */
import type { FrameContext, RenderContext } from '@/core/contracts/render';
import { coreOf, type Tracked } from '@/render/core';
import { AERIAL_SIZE, MULTISCATTER_LUT_SIZE, SKY_IRRADIANCE_LUT_SIZE, SKY_VIEW_LUT_SIZE, TRANSMITTANCE_LUT_SIZE } from './math';
import { AERIAL_COMPUTE_WGSL, MULTISCATTER_COMPUTE_WGSL, SKY_IRRADIANCE_COMPUTE_WGSL, SKY_VIEW_COMPUTE_WGSL, TRANSMITTANCE_COMPUTE_WGSL } from './shaders/luts';

const FORMAT: GPUTextureFormat = 'rgba16float';
const STORAGE = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;

interface ComputeStage {
  layout: GPUBindGroupLayout;
  pipeline: Tracked<GPUComputePipeline>;
  group: GPUBindGroup | null;
}

export interface TableInputs {
  /** The feature's uniform buffer (group 1, binding 0 of every pass). */
  uniforms: GPUBuffer;
  /** Cloud shadow map and coverage map for the sun term of the aerial volume (neutral textures when there are no clouds). */
  shadowMap: GPUTextureView;
  coverageMap: GPUTextureView;
}

export class AtmosphereTables {
  private readonly device: GPUDevice;
  private layers = 0;
  private transmittance: GPUTexture | null = null;
  private multiScatter: GPUTexture | null = null;
  private irradiance: GPUTexture | null = null;
  private readonly skyView: GPUTexture;
  private readonly aerial: GPUTexture;
  transmittanceView: GPUTextureView | null = null;
  multiScatterView: GPUTextureView | null = null;
  irradianceView: GPUTextureView | null = null;
  readonly skyViewView: GPUTextureView;
  readonly aerialView: GPUTextureView;
  /** Neutral stand-ins published while no atmosphere body is in range. */
  readonly neutralSkyView: GPUTextureView;
  readonly neutralAerial: GPUTextureView;

  private readonly stages: Record<'transmittance' | 'multiScatter' | 'irradiance' | 'skyView' | 'aerial', ComputeStage>;
  private staticSignature = '';
  private irradianceSun = -1;
  private staticDirty = true;
  private irradianceDirty = true;
  private inputs: TableInputs | null = null;
  private inputsKey = '';
  /** Bumped whenever the table textures were re-created (bind groups that reference them must be rebuilt). */
  version = 0;

  constructor(private readonly ctx: RenderContext) {
    const device = (this.device = ctx.device);
    const core = coreOf(ctx);
    this.skyView = core.createTextureChecked({ label: 'atmosphere.skyView', format: FORMAT, size: [SKY_VIEW_LUT_SIZE[0], SKY_VIEW_LUT_SIZE[1]], usage: STORAGE });
    this.skyViewView = this.skyView.createView();
    this.aerial = core.createTextureChecked({ label: 'atmosphere.aerial', format: FORMAT, dimension: '3d', size: [AERIAL_SIZE, AERIAL_SIZE, AERIAL_SIZE], usage: STORAGE });
    this.aerialView = this.aerial.createView();

    const neutral = (label: string, dimension: GPUTextureDimension, texel: number[]): GPUTextureView => {
      const t = device.createTexture({ label, format: FORMAT, dimension, size: [1, 1, 1], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture: t }, new Uint16Array(texel), {}, [1, 1, 1]);
      return t.createView();
    };
    const ONE = 0x3c00;
    this.neutralSkyView = neutral('atmosphere.skyView.neutral', '2d', [0, 0, 0, ONE]);
    this.neutralAerial = neutral('atmosphere.aerial.neutral', '3d', [0, 0, 0, ONE]);

    const uniform: GPUBindGroupLayoutEntry = { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } };
    const sampled = (binding: number, viewDimension: GPUTextureViewDimension): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension } });
    const storage = (binding: number, viewDimension: GPUTextureViewDimension): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: FORMAT, viewDimension } });
    const stage = (label: string, wgsl: string, entries: GPUBindGroupLayoutEntry[]): ComputeStage => {
      const layout = device.createBindGroupLayout({ label, entries });
      const pipeline = core.shaders.tracked(() =>
        device.createComputePipeline({
          label,
          layout: device.createPipelineLayout({ label, bindGroupLayouts: [ctx.frameBindGroupLayout, layout] }),
          compute: { module: ctx.shaders.createModule(label, wgsl), entryPoint: 'main' },
        }),
      );
      pipeline.get();
      return { layout, pipeline, group: null };
    };
    this.stages = {
      transmittance: stage('atmosphere.transmittance', TRANSMITTANCE_COMPUTE_WGSL, [uniform, storage(1, '2d-array')]),
      multiScatter: stage('atmosphere.multiScatter', MULTISCATTER_COMPUTE_WGSL, [uniform, sampled(1, '2d-array'), storage(2, '2d-array')]),
      irradiance: stage('atmosphere.irradiance', SKY_IRRADIANCE_COMPUTE_WGSL, [uniform, sampled(1, '2d-array'), sampled(2, '2d-array'), storage(3, '2d-array')]),
      skyView: stage('atmosphere.skyView', SKY_VIEW_COMPUTE_WGSL, [uniform, sampled(1, '2d-array'), sampled(2, '2d-array'), storage(3, '2d')]),
      aerial: stage('atmosphere.aerial', AERIAL_COMPUTE_WGSL, [uniform, sampled(1, '2d-array'), sampled(2, '2d-array'), sampled(3, '2d'), sampled(4, '2d'), storage(5, '3d')]),
    };
  }

  /** True once the static tables hold data for the current bodies. */
  get ready(): boolean {
    return this.layers > 0 && !this.staticDirty && !this.irradianceDirty;
  }

  /** Force the static tables to be rebuilt on the next frame (tunables edited at run time). */
  invalidate(): void {
    this.staticSignature = '';
  }

  /**
   * Declare the table layers for this frame. `signature` identifies the atmosphere data of every layer
   * (static tables are rebuilt when it changes); `sunIlluminance` is the illuminance at the camera, lux.
   */
  configure(layers: number, signature: string, sunIlluminance: number, inputs: TableInputs): void {
    const core = coreOf(this.ctx);
    if (layers !== this.layers) {
      this.transmittance?.destroy();
      this.multiScatter?.destroy();
      this.irradiance?.destroy();
      this.layers = layers;
      this.transmittance = this.multiScatter = this.irradiance = null;
      this.transmittanceView = this.multiScatterView = this.irradianceView = null;
      if (layers > 0) {
        const make = (label: string, size: readonly [number, number]): GPUTexture => core.createTextureChecked({ label, format: FORMAT, size: [size[0], size[1], layers], usage: STORAGE });
        this.transmittance = make('atmosphere.transmittance', TRANSMITTANCE_LUT_SIZE);
        this.multiScatter = make('atmosphere.multiScatter', MULTISCATTER_LUT_SIZE);
        this.irradiance = make('atmosphere.irradiance', SKY_IRRADIANCE_LUT_SIZE);
        this.transmittanceView = this.transmittance.createView({ dimension: '2d-array' });
        this.multiScatterView = this.multiScatter.createView({ dimension: '2d-array' });
        this.irradianceView = this.irradiance.createView({ dimension: '2d-array' });
      }
      this.staticSignature = '';
      this.version++;
      this.inputsKey = '';
    }
    if (signature !== this.staticSignature) {
      this.staticSignature = signature;
      this.staticDirty = true;
      this.irradianceDirty = true;
    }
    if (this.irradianceSun < 0 || Math.abs(sunIlluminance - this.irradianceSun) > 1e-3 * this.irradianceSun) {
      this.irradianceSun = sunIlluminance;
      this.irradianceDirty = true;
    }
    const key = `${this.version}`;
    if (this.inputs?.uniforms !== inputs.uniforms || this.inputs.shadowMap !== inputs.shadowMap || this.inputs.coverageMap !== inputs.coverageMap || key !== this.inputsKey) {
      this.inputs = inputs;
      this.inputsKey = key;
      for (const s of Object.values(this.stages)) s.group = null;
    }
  }

  private group(name: keyof AtmosphereTables['stages']): GPUBindGroup {
    const s = this.stages[name];
    if (s.group) return s.group;
    const i = this.inputs!;
    const u: GPUBindGroupEntry = { binding: 0, resource: { buffer: i.uniforms } };
    const t = this.transmittanceView!;
    const m = this.multiScatterView!;
    const entries: Record<typeof name, GPUBindGroupEntry[]> = {
      transmittance: [u, { binding: 1, resource: t }],
      multiScatter: [u, { binding: 1, resource: t }, { binding: 2, resource: m }],
      irradiance: [u, { binding: 1, resource: t }, { binding: 2, resource: m }, { binding: 3, resource: this.irradianceView! }],
      skyView: [u, { binding: 1, resource: t }, { binding: 2, resource: m }, { binding: 3, resource: this.skyViewView }],
      aerial: [u, { binding: 1, resource: t }, { binding: 2, resource: m }, { binding: 3, resource: i.shadowMap }, { binding: 4, resource: i.coverageMap }, { binding: 5, resource: this.aerialView }],
    };
    s.group = this.device.createBindGroup({ label: `atmosphere.${name}`, layout: s.layout, entries: entries[name] });
    return s.group;
  }

  /**
   * Encode the table passes of this frame: the static tables when they are stale, and (when `perFrame`)
   * the sky-view table and the aerial-perspective volume.
   */
  encode(frame: FrameContext, encoder: GPUCommandEncoder, perFrame: boolean): void {
    if (this.layers === 0) return;
    const perf = this.ctx.perf;
    const run = (pass: GPUComputePassEncoder, name: keyof AtmosphereTables['stages'], x: number, y: number, z: number): void => {
      pass.setPipeline(this.stages[name].pipeline.get());
      pass.setBindGroup(1, this.group(name));
      pass.dispatchWorkgroups(Math.ceil(x / 8), Math.ceil(y / 8), z);
    };
    if (this.staticDirty || this.irradianceDirty) {
      const pass = encoder.beginComputePass({ label: 'atmosphere.tables', timestampWrites: perf.gpuPass('atmosphere.tables') as GPUComputePassTimestampWrites | undefined });
      pass.setBindGroup(0, frame.frameBindGroup);
      if (this.staticDirty) {
        run(pass, 'transmittance', TRANSMITTANCE_LUT_SIZE[0], TRANSMITTANCE_LUT_SIZE[1], this.layers);
        run(pass, 'multiScatter', MULTISCATTER_LUT_SIZE[0], MULTISCATTER_LUT_SIZE[1], this.layers);
      }
      run(pass, 'irradiance', SKY_IRRADIANCE_LUT_SIZE[0], SKY_IRRADIANCE_LUT_SIZE[1], this.layers);
      pass.end();
      this.staticDirty = false;
      this.irradianceDirty = false;
    }
    if (perFrame) {
      const pass = encoder.beginComputePass({ label: 'atmosphere.skyAerial', timestampWrites: perf.gpuPass('atmosphere.skyAerial') as GPUComputePassTimestampWrites | undefined });
      pass.setBindGroup(0, frame.frameBindGroup);
      run(pass, 'skyView', SKY_VIEW_LUT_SIZE[0], SKY_VIEW_LUT_SIZE[1], 1);
      run(pass, 'aerial', AERIAL_SIZE, AERIAL_SIZE, 1);
      pass.end();
    }
  }

  /** Textures for test readbacks. */
  textures(): { transmittance: GPUTexture | null; multiScatter: GPUTexture | null; irradiance: GPUTexture | null; skyView: GPUTexture; aerial: GPUTexture } {
    return { transmittance: this.transmittance, multiScatter: this.multiScatter, irradiance: this.irradiance, skyView: this.skyView, aerial: this.aerial };
  }

  dispose(): void {
    this.transmittance?.destroy();
    this.multiScatter?.destroy();
    this.irradiance?.destroy();
    this.skyView.destroy();
    this.aerial.destroy();
  }
}
