/**
 * GPU side of the wave cascades: uploads the initial spectra once, then per frame (only while waves are drawn)
 * evolves them, runs the inverse FFTs, assembles displacement / derivatives into texture arrays (one layer per
 * cascade, then the long-wave normals layer LONG_LAYER; full mip chain) and keeps the previous frame's
 * displacement for motion vectors. Published as 'ocean.displacement' and 'ocean.derivatives'.
 */
import type { RenderContext } from '@/core/contracts/render';
import { coreOf } from '@/render/core';
import type { OceanCascadeSet } from './cascades';
import type { OceanTunables } from './params';
import { CASCADE_MIPS, FFT_LAYERS, FFT_SIZE } from './spectrum';
import { FFT_COLUMNS_WGSL, FFT_MIP_WGSL, FFT_ROWS_WGSL, FFT_SPECTRUM_WGSL } from './shaders/fftWgsl';

export class OceanFft {
  readonly disp: GPUTexture;
  readonly dispPrev: GPUTexture;
  readonly deriv: GPUTexture;
  readonly dispView: GPUTextureView;
  readonly dispPrevView: GPUTextureView;
  readonly derivView: GPUTextureView;
  private readonly params: GPUBuffer;
  private readonly paramData = new Float32Array(12);
  private readonly h0: GPUBuffer;
  private readonly omega: GPUBuffer;
  private readonly work: GPUBuffer;
  private readonly spectrumPipe: GPUComputePipeline;
  private readonly rowsPipe: GPUComputePipeline;
  private readonly colsPipe: GPUComputePipeline;
  private readonly mipPipe: GPUComputePipeline;
  private readonly spectrumGroup: GPUBindGroup;
  private readonly rowsGroup: GPUBindGroup;
  private readonly colsGroup: GPUBindGroup;
  private readonly mipGroups: GPUBindGroup[];
  private primed = false;
  /** Layers updated by the latest update. */
  private mask = 0;

  constructor(
    private readonly ctx: RenderContext,
    readonly cascades: OceanCascadeSet,
    private readonly tunables: OceanTunables,
  ) {
    const device = ctx.device;
    const core = coreOf(ctx);
    const n = FFT_SIZE;
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const texDesc = (label: string): GPUTextureDescriptor => ({ label, format: 'rgba16float', size: [n, n, FFT_LAYERS], mipLevelCount: CASCADE_MIPS, usage });
    this.disp = core.createTextureChecked(texDesc('ocean.displacement'));
    this.dispPrev = core.createTextureChecked(texDesc('ocean.displacementPrev'));
    this.deriv = core.createTextureChecked(texDesc('ocean.derivatives'));
    const arr = (t: GPUTexture): GPUTextureView => t.createView({ dimension: '2d-array' });
    this.dispView = arr(this.disp);
    this.dispPrevView = arr(this.dispPrev);
    this.derivView = arr(this.deriv);

    // Initial spectra and quantised dispersion indices, one block per layer (the cascades, then the long waves).
    const layers = [...cascades.spectra, cascades.long];
    const h0 = new Float32Array(FFT_LAYERS * n * n * 4);
    const om = new Float32Array(FFT_LAYERS * n * n);
    layers.forEach((s, c) => {
      h0.set(s.h0, c * n * n * 4);
      om.set(s.omegaIndex, c * n * n);
    });
    this.h0 = device.createBuffer({ label: 'ocean.h0', size: h0.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.h0, 0, h0);
    this.omega = device.createBuffer({ label: 'ocean.omegaIndex', size: om.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.omega, 0, om);
    this.work = device.createBuffer({ label: 'ocean.fftWork', size: FFT_LAYERS * 4 * n * n * 8, usage: GPUBufferUsage.STORAGE });
    this.params = device.createBuffer({ label: 'ocean.fftParams', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const C = GPUShaderStage.COMPUTE;
    const storageTex = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } });
    const sampledTex = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: C, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } });
    const spectrumLayout = device.createBindGroupLayout({
      label: 'ocean.fft.spectrum',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: C, buffer: { type: 'storage' } },
      ],
    });
    const rowsLayout = device.createBindGroupLayout({ label: 'ocean.fft.rows', entries: [{ binding: 0, visibility: C, buffer: { type: 'uniform' } }, { binding: 3, visibility: C, buffer: { type: 'storage' } }] });
    const colsLayout = device.createBindGroupLayout({
      label: 'ocean.fft.columns',
      entries: [{ binding: 0, visibility: C, buffer: { type: 'uniform' } }, { binding: 3, visibility: C, buffer: { type: 'storage' } }, storageTex(4), storageTex(5)],
    });
    const mipLayout = device.createBindGroupLayout({ label: 'ocean.fft.mip', entries: [sampledTex(0), sampledTex(1), storageTex(2), storageTex(3), { binding: 4, visibility: C, buffer: { type: 'uniform' } }] });
    const pipe = (label: string, code: string, entry: string, layout: GPUBindGroupLayout): GPUComputePipeline =>
      device.createComputePipeline({ label, layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module: ctx.shaders.createModule(label, code), entryPoint: entry } });
    this.spectrumPipe = pipe('ocean.fft.spectrum', FFT_SPECTRUM_WGSL, 'spectrum', spectrumLayout);
    this.rowsPipe = pipe('ocean.fft.rows', FFT_ROWS_WGSL, 'rows', rowsLayout);
    this.colsPipe = pipe('ocean.fft.columns', FFT_COLUMNS_WGSL, 'columns', colsLayout);
    this.mipPipe = pipe('ocean.fft.mip', FFT_MIP_WGSL, 'mip', mipLayout);

    this.spectrumGroup = device.createBindGroup({
      label: 'ocean.fft.spectrum',
      layout: spectrumLayout,
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.h0 } },
        { binding: 2, resource: { buffer: this.omega } },
        { binding: 3, resource: { buffer: this.work } },
      ],
    });
    this.rowsGroup = device.createBindGroup({ label: 'ocean.fft.rows', layout: rowsLayout, entries: [{ binding: 0, resource: { buffer: this.params } }, { binding: 3, resource: { buffer: this.work } }] });
    const level = (t: GPUTexture, mip: number): GPUTextureView => t.createView({ dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1 });
    this.colsGroup = device.createBindGroup({
      label: 'ocean.fft.columns',
      layout: colsLayout,
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 3, resource: { buffer: this.work } },
        { binding: 4, resource: level(this.disp, 0) },
        { binding: 5, resource: level(this.deriv, 0) },
      ],
    });
    this.mipGroups = [];
    for (let m = 1; m < CASCADE_MIPS; m++) {
      this.mipGroups.push(
        device.createBindGroup({
          label: `ocean.fft.mip${m}`,
          layout: mipLayout,
          entries: [
            { binding: 0, resource: level(this.disp, m - 1) },
            { binding: 1, resource: level(this.deriv, m - 1) },
            { binding: 2, resource: level(this.disp, m) },
            { binding: 3, resource: level(this.deriv, m) },
            { binding: 4, resource: { buffer: this.params } },
          ],
        }),
      );
    }
    // Layer c's patch length at [4 + c], the fifth layer's at [8].
    layers.forEach((sp, c) => {
      this.paramData[c < 4 ? 4 + c : 8] = sp.band.length;
    });
  }

  /** The near field switched off: the next update starts a new history (no stale previous frame). */
  reset(): void {
    this.primed = false;
  }

  /**
   * Evolve to time tau = frac(t / T) (prepared in float64 by the caller). Only the layers in `mask` (bit c =
   * layer c) are updated: a layer no pixel can resolve this frame keeps its old content and is not sampled (the
   * shaders give it amplitude 0); one that comes back starts a new history (reset). Records into `encoder`;
   * `timestamp` is the core's timestampWrites for the pass.
   */
  update(encoder: GPUCommandEncoder, tau: number, mask: number, timestamp: GPUComputePassTimestampWrites | undefined): void {
    if ((mask & ~this.mask) !== 0) this.primed = false;
    this.mask = mask;
    const device = this.ctx.device;
    const n = FFT_SIZE;
    // The previous frame's displacement (all mips) for motion vectors.
    if (this.primed) for (let m = 0; m < CASCADE_MIPS; m++) encoder.copyTextureToTexture({ texture: this.disp, mipLevel: m }, { texture: this.dispPrev, mipLevel: m }, [n >> m, n >> m, FFT_LAYERS]);
    const p = this.paramData;
    p[0] = tau;
    p[1] = this.tunables.choppiness;
    p[10] = mask;
    device.queue.writeBuffer(this.params, 0, p);
    const pass = encoder.beginComputePass({ label: 'ocean.fft', timestampWrites: timestamp });
    pass.setPipeline(this.spectrumPipe);
    pass.setBindGroup(0, this.spectrumGroup);
    pass.dispatchWorkgroups(n / 16, n / 16, FFT_LAYERS);
    pass.setPipeline(this.rowsPipe);
    pass.setBindGroup(0, this.rowsGroup);
    pass.dispatchWorkgroups(n, FFT_LAYERS);
    pass.setPipeline(this.colsPipe);
    pass.setBindGroup(0, this.colsGroup);
    pass.dispatchWorkgroups(n, FFT_LAYERS);
    pass.setPipeline(this.mipPipe);
    for (let m = 1; m < CASCADE_MIPS; m++) {
      pass.setBindGroup(0, this.mipGroups[m - 1]!);
      const size = n >> m;
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), FFT_LAYERS);
    }
    pass.end();
    if (!this.primed) {
      for (let m = 0; m < CASCADE_MIPS; m++) encoder.copyTextureToTexture({ texture: this.disp, mipLevel: m }, { texture: this.dispPrev, mipLevel: m }, [n >> m, n >> m, FFT_LAYERS]);
      this.primed = true;
    }
  }

  dispose(): void {
    for (const t of [this.disp, this.dispPrev, this.deriv]) t.destroy();
    for (const b of [this.h0, this.omega, this.work, this.params]) b.destroy();
  }
}
