/**
 * WebGPU half of the map overlay: turns a DrawList into buffers and records the draws into the LDR
 * overlay pass (display resolution, no depth attachment, after tonemapping). Float64 geometry is narrowed
 * to camera-relative float32 only here, as the last step.
 */
import type { ShaderLibrary } from '@/core/contracts/render';
import { CASING_PX, COLORS, DASH_ON_PX, DASH_PERIOD_PX, FADE_FLOOR, OCCLUSION_FADE_PX, type Rgba } from '../constants';
import { isBlank, type DrawList, type IconInstance, type TextRun } from '../drawList';
import { GlyphAtlas } from './glyphAtlas';
import { GLYPH_WGSL, ICON_WGSL, LINE_WGSL, MAX_OCCLUDERS } from './shaders';

/** proj (64) + viewport, params, style (48) + bodies (16 per occluder) + visible-limb radii (4 per occluder). */
const UNIFORM_BYTES = 64 + 3 * 16 + MAX_OCCLUDERS * 16 + MAX_OCCLUDERS * 4;
const BODIES_F32 = 28;
const VIS_F32 = BODIES_F32 + 4 * MAX_OCCLUDERS;
/** LinePoint in shaders.ts: pos, phase, color, flags, seglen, slack, phase2, octave, two pad words. */
const POINT_WORDS = 12;
const ICON_BYTES = 36;
const GLYPH_BYTES = 32;

const packColor = (c: Rgba, alpha: number): number => {
  const q = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));
  return (q(c[0]) | (q(c[1]) << 8) | (q(c[2]) << 16) | (q(c[3] * alpha) << 24)) >>> 0;
};

export interface OverlayCounts {
  points: number;
  icons: number;
  glyphs: number;
}

export class OverlayRenderer {
  private readonly device: GPUDevice;
  private readonly uniform: GPUBuffer;
  private readonly uniformData = new ArrayBuffer(UNIFORM_BYTES);
  private readonly uniformF32 = new Float32Array(this.uniformData);
  private readonly linePipeline: GPURenderPipeline;
  /** All casings first, then all cores (same vertex stage and bind group layout). */
  private readonly casingPipeline: GPURenderPipeline;
  private readonly iconPipeline: GPURenderPipeline;
  private readonly glyphPipeline: GPURenderPipeline;
  private pointBuf: GPUBuffer | null = null;
  private pointCap = 0;
  private pointData = new ArrayBuffer(0);
  private pointF32 = new Float32Array(0);
  private pointU32 = new Uint32Array(0);
  private iconBuf: GPUBuffer | null = null;
  private iconCap = 0;
  private iconData = new ArrayBuffer(0);
  private iconF32 = new Float32Array(0);
  private iconU32 = new Uint32Array(0);
  private glyphBuf: GPUBuffer | null = null;
  private glyphCap = 0;
  private glyphData = new ArrayBuffer(0);
  private glyphF32 = new Float32Array(0);
  private glyphU32 = new Uint32Array(0);
  private lineGroup: GPUBindGroup | null = null;
  private iconGroup: GPUBindGroup;
  private glyphGroup: GPUBindGroup | null = null;
  private atlas: GlyphAtlas | null = null;
  // Draw ranges of the last upload.
  private nPoints = 0;
  private icons0 = 0;
  private icons1 = 0;
  private glyphs0 = 0;
  private glyphs1 = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, shaders: ShaderLibrary) {
    this.device = device;
    this.uniform = device.createBuffer({ label: 'map.uniforms', size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const blend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const targets: GPUColorTargetState[] = [{ format, blend }];
    const lineModule = shaders.createModule('map.lines', LINE_WGSL);
    const iconModule = shaders.createModule('map.icons', ICON_WGSL);
    const glyphModule = shaders.createModule('map.glyphs', GLYPH_WGSL);
    // One explicit layout for both line passes, so one bind group serves them.
    const lineLayout = device.createBindGroupLayout({
      label: 'map.lines',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const linePipelineLayout = device.createPipelineLayout({ label: 'map.lines', bindGroupLayouts: [lineLayout] });
    this.casingPipeline = device.createRenderPipeline({
      label: 'map.lineCasings',
      layout: linePipelineLayout,
      vertex: { module: lineModule, entryPoint: 'vsLine' },
      fragment: { module: lineModule, entryPoint: 'fsLineCasing', targets },
      primitive: { topology: 'triangle-list' },
    });
    this.linePipeline = device.createRenderPipeline({
      label: 'map.lines',
      layout: linePipelineLayout,
      vertex: { module: lineModule, entryPoint: 'vsLine' },
      fragment: { module: lineModule, entryPoint: 'fsLineCore', targets },
      primitive: { topology: 'triangle-list' },
    });
    this.iconPipeline = device.createRenderPipeline({
      label: 'map.icons',
      layout: 'auto',
      vertex: {
        module: iconModule,
        entryPoint: 'vsIcon',
        buffers: [
          {
            arrayStride: ICON_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 8, format: 'float32x2' },
              { shaderLocation: 2, offset: 16, format: 'float32' },
              { shaderLocation: 3, offset: 20, format: 'uint32' },
              { shaderLocation: 4, offset: 24, format: 'unorm8x4' },
              { shaderLocation: 5, offset: 28, format: 'float32' },
              { shaderLocation: 6, offset: 32, format: 'float32' },
            ],
          },
        ],
      },
      fragment: { module: iconModule, entryPoint: 'fsIcon', targets },
      primitive: { topology: 'triangle-list' },
    });
    this.glyphPipeline = device.createRenderPipeline({
      label: 'map.glyphs',
      layout: 'auto',
      vertex: {
        module: glyphModule,
        entryPoint: 'vsGlyph',
        buffers: [
          {
            arrayStride: GLYPH_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 8, format: 'float32x2' },
              { shaderLocation: 2, offset: 16, format: 'float32x2' },
              { shaderLocation: 3, offset: 24, format: 'unorm8x4' },
              { shaderLocation: 4, offset: 28, format: 'unorm8x4' },
            ],
          },
        ],
      },
      fragment: { module: glyphModule, entryPoint: 'fsGlyph', targets },
      primitive: { topology: 'triangle-list' },
    });
    this.iconGroup = device.createBindGroup({ layout: this.iconPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uniform } }] });
  }

  /** Text metrics of the atlas for a pixel scale (builds the atlas on first use or when the scale changes). */
  atlasFor(pxScale: number): GlyphAtlas {
    if (!this.atlas || this.atlas.pxScale !== pxScale) {
      this.atlas?.destroy();
      this.atlas = new GlyphAtlas(this.device, pxScale);
      this.glyphGroup = this.device.createBindGroup({
        layout: this.glyphPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: this.atlas.view },
        ],
      });
    }
    return this.atlas;
  }

  /** Write everything the draw list needs into GPU buffers (call before the overlay pass is recorded). */
  upload(list: DrawList): OverlayCounts {
    const scene = list.scene;
    const proj = scene.proj;
    const k = proj.pxScale;
    // Uniforms.
    const f = this.uniformF32;
    f.set(proj.projectionMatrix(), 0);
    f[16] = proj.width;
    f[17] = proj.height;
    f[18] = 1 / proj.width;
    f[19] = 1 / proj.height;
    const nOcc = Math.min(MAX_OCCLUDERS, scene.occluders.length);
    f[20] = k;
    f[21] = proj.focal;
    f[22] = proj.near;
    f[23] = nOcc;
    const period = DASH_PERIOD_PX * k;
    f[24] = OCCLUSION_FADE_PX * k;
    f[25] = period;
    f[26] = DASH_ON_PX * k;
    f[27] = CASING_PX * k;
    for (let i = 0; i < nOcc; i++) {
      const o = scene.occluders[i]!;
      f[BODIES_F32 + 4 * i] = o.x;
      f[BODIES_F32 + 1 + 4 * i] = o.y;
      f[BODIES_F32 + 2 + 4 * i] = o.z;
      f[BODIES_F32 + 3 + 4 * i] = o.radius;
      f[VIS_F32 + i] = o.vis;
    }
    this.device.queue.writeBuffer(this.uniform, 0, this.uniformData);

    // Line points.
    const verts = scene.verts;
    let n = 0;
    for (const l of scene.lines) n += l.count;
    this.ensurePoints(n);
    const pf = this.pointF32;
    const pu = this.pointU32;
    let j = 0;
    for (const l of scene.lines) {
      const style = (l.dashed ? 2 : 0) | (l.casing ? 0 : 8) | (Math.min(65535, Math.round(l.width * 64)) << 16);
      const a = l.color[3] * 255;
      const base = packColor(l.color, 0);
      const end = l.start + l.count;
      for (let s = l.start; s < end; s++) {
        const o = j * POINT_WORDS;
        pf[o] = verts.vx[s]!;
        pf[o + 1] = verts.vy[s]!;
        pf[o + 2] = verts.vz[s]!;
        const len = verts.len[s]!;
        if (l.dashed) {
          // arc length from the node modulo the world periods of the segment's octave and the next (scene.ts)
          const n = verts.oct[s]!;
          const p1 = Math.pow(2, n);
          pf[o + 3] = len - Math.floor(len / p1) * p1;
          pf[o + 8] = len - Math.floor(len / (2 * p1)) * (2 * p1);
          pf[o + 9] = n;
        } else {
          pf[o + 3] = len - Math.floor(len / period) * period;
          pf[o + 8] = 0;
          pf[o + 9] = 0;
        }
        // Fade with time ahead: alpha alone falls toward FADE_FLOOR, the hue is kept (constants.ts).
        const alpha = (a * verts.alpha[s]! * (1 - (1 - FADE_FLOOR) * verts.fade[s]!) + 0.5) | 0;
        pu[o + 4] = (base | (alpha << 24)) >>> 0;
        const drawn = verts.seg[s] === 1 && verts.cover[s] === 0;
        pu[o + 5] = (style | (drawn ? 1 : 0) | (verts.join[s] === 1 ? 4 : 0)) >>> 0;
        pf[o + 6] = drawn ? verts.len[s + 1]! - len : 0;
        pf[o + 7] = l.occlusionSlack;
        j++;
      }
    }
    this.nPoints = n;
    if (n > 0) this.device.queue.writeBuffer(this.pointBuf!, 0, this.pointData, 0, n * POINT_WORDS * 4);

    // Icons (two layers in one buffer).
    const [i0, i1] = list.icons;
    this.ensureIcons(i0.length + i1.length);
    const ivf = this.iconF32;
    const ivu = this.iconU32;
    let ic = 0;
    for (const icon of i0) this.writeIcon(ivf, ivu, ic++, icon);
    for (const icon of i1) this.writeIcon(ivf, ivu, ic++, icon);
    this.icons0 = i0.length;
    this.icons1 = i1.length;
    if (ic > 0) this.device.queue.writeBuffer(this.iconBuf!, 0, this.iconData, 0, ic * ICON_BYTES);

    // Glyphs: halos of a layer first, then its fills, so a halo never covers a neighbouring glyph.
    const atlas = this.atlasFor(k);
    const [t0, t1] = list.texts;
    let chars = 0;
    for (const r of t0) chars += r.text.length;
    for (const r of t1) chars += r.text.length;
    this.ensureGlyphs(2 * chars);
    const gvf = this.glyphF32;
    const gvu = this.glyphU32;
    let g = 0;
    for (const run of t0) g = this.writeRun(gvf, gvu, g, run, atlas, true);
    for (const run of t0) g = this.writeRun(gvf, gvu, g, run, atlas, false);
    this.glyphs0 = g;
    for (const run of t1) g = this.writeRun(gvf, gvu, g, run, atlas, true);
    for (const run of t1) g = this.writeRun(gvf, gvu, g, run, atlas, false);
    this.glyphs1 = g - this.glyphs0;
    if (g > 0) this.device.queue.writeBuffer(this.glyphBuf!, 0, this.glyphData, 0, g * GLYPH_BYTES);
    return { points: n, icons: ic, glyphs: g };
  }

  /** Record the overlay draws into the LDR pass. */
  draw(pass: GPURenderPassEncoder): void {
    if (this.nPoints > 1 && this.lineGroup) {
      // every casing, then every core: a line crossing another never cuts it with its casing
      pass.setPipeline(this.casingPipeline);
      pass.setBindGroup(0, this.lineGroup);
      pass.draw(6, this.nPoints - 1);
      pass.setPipeline(this.linePipeline);
      pass.draw(6, this.nPoints - 1);
    }
    if (this.icons0 > 0) {
      pass.setPipeline(this.iconPipeline);
      pass.setBindGroup(0, this.iconGroup);
      pass.setVertexBuffer(0, this.iconBuf!);
      pass.draw(6, this.icons0, 0, 0);
    }
    if (this.glyphs0 > 0 && this.glyphGroup) {
      pass.setPipeline(this.glyphPipeline);
      pass.setBindGroup(0, this.glyphGroup);
      pass.setVertexBuffer(0, this.glyphBuf!);
      pass.draw(6, this.glyphs0, 0, 0);
    }
    if (this.icons1 > 0) {
      pass.setPipeline(this.iconPipeline);
      pass.setBindGroup(0, this.iconGroup);
      pass.setVertexBuffer(0, this.iconBuf!);
      pass.draw(6, this.icons1, 0, this.icons0);
    }
    if (this.glyphs1 > 0 && this.glyphGroup) {
      pass.setPipeline(this.glyphPipeline);
      pass.setBindGroup(0, this.glyphGroup);
      pass.setVertexBuffer(0, this.glyphBuf!);
      pass.draw(6, this.glyphs1, 0, this.glyphs0);
    }
  }

  dispose(): void {
    this.uniform.destroy();
    this.pointBuf?.destroy();
    this.iconBuf?.destroy();
    this.glyphBuf?.destroy();
    this.atlas?.destroy();
  }

  // --------------------------------------------------------------------------------- internals

  private writeIcon(f: Float32Array, u: Uint32Array, i: number, icon: IconInstance): void {
    const o = i * (ICON_BYTES / 4);
    f[o] = icon.x;
    f[o + 1] = icon.y;
    f[o + 2] = icon.hx;
    f[o + 3] = icon.hy;
    f[o + 4] = icon.rot;
    u[o + 5] = icon.shape;
    u[o + 6] = packColor(icon.color, 1);
    f[o + 7] = icon.alpha;
    f[o + 8] = icon.aux;
  }

  private writeRun(f: Float32Array, u: Uint32Array, g: number, run: TextRun, atlas: GlyphAtlas, halo: boolean): number {
    const m = atlas.margin;
    const x0 = Math.round(run.x) - m;
    const y0 = Math.round(run.y) - m;
    const color = packColor(run.color, halo ? 0 : run.alpha);
    const haloColor = packColor(COLORS.halo, halo ? run.alpha : 0);
    const text = run.text;
    let pen = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const cell = atlas.cell(code);
      const x = x0 + Math.round(pen);
      pen += cell.advance + run.tracking;
      if (isBlank(code)) continue;
      const o = g * (GLYPH_BYTES / 4);
      f[o] = x;
      f[o + 1] = y0;
      f[o + 2] = cell.w;
      f[o + 3] = atlas.cellH;
      f[o + 4] = cell.u;
      f[o + 5] = cell.v;
      u[o + 6] = color;
      u[o + 7] = haloColor;
      g++;
    }
    return g;
  }

  private ensurePoints(n: number): void {
    if (n <= this.pointCap && this.pointBuf) return;
    const cap = Math.max(n, Math.ceil(this.pointCap * 1.5), 8192);
    this.pointBuf?.destroy();
    this.pointBuf = this.device.createBuffer({ label: 'map.linePoints', size: cap * POINT_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.pointData = new ArrayBuffer(cap * POINT_WORDS * 4);
    this.pointF32 = new Float32Array(this.pointData);
    this.pointU32 = new Uint32Array(this.pointData);
    this.pointCap = cap;
    this.lineGroup = this.device.createBindGroup({
      layout: this.linePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: { buffer: this.pointBuf } },
      ],
    });
  }

  private ensureIcons(n: number): void {
    if (n <= this.iconCap && this.iconBuf) return;
    const cap = Math.max(n, Math.ceil(this.iconCap * 1.5), 1024);
    this.iconBuf?.destroy();
    this.iconBuf = this.device.createBuffer({ label: 'map.icons', size: cap * ICON_BYTES, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.iconData = new ArrayBuffer(cap * ICON_BYTES);
    this.iconF32 = new Float32Array(this.iconData);
    this.iconU32 = new Uint32Array(this.iconData);
    this.iconCap = cap;
  }

  private ensureGlyphs(n: number): void {
    if (n <= this.glyphCap && this.glyphBuf) return;
    const cap = Math.max(n, Math.ceil(this.glyphCap * 1.5), 4096);
    this.glyphBuf?.destroy();
    this.glyphBuf = this.device.createBuffer({ label: 'map.glyphs', size: cap * GLYPH_BYTES, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.glyphData = new ArrayBuffer(cap * GLYPH_BYTES);
    this.glyphF32 = new Float32Array(this.glyphData);
    this.glyphU32 = new Uint32Array(this.glyphData);
    this.glyphCap = cap;
  }
}
