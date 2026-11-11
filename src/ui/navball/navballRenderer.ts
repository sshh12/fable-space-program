/**
 * NavballRenderer: the navball as a real textured 3-D sphere rendered with WebGPU (src/core/contracts/ui.ts).
 *
 *   const navball = createNavballRenderer(gpu);
 *   navball.render(encoder, snapshot);           // 512 x 512 rgba8unorm texture `navball.view` ('ui.navball')
 *   navball.renderTo(encoder, state, view, fmt, px) // the same ball into another target (the HUD canvas)
 *
 * Texture contents: sRGB-encoded colour, premultiplied by coverage; alpha = coverage of the ball. The ball
 * texture is fixed in the local horizon frame and rotated by NavballState.qVesselToHorizon; every marker of
 * NavballMarkers on the visible hemisphere is drawn as a crisp icon at its orthographic projection
 * (navballMath.projectMarker), fading toward the limb and clipped to the ball, with the fixed vessel reticle
 * drawn last, on top (its open centre and thin outline let a marker held on the nose show through).
 *
 * The shared texture carries soft shading only (the cockpit relights it as the albedo of its instrument ball);
 * `renderTo` with `instrument: true` draws the HUD's lit instrument look (navballShader.ts).
 */
import type { GpuHandle } from '@/core/gpu/device';
import type { PerfRecorder } from '@/core/contracts/render';
import type { NavballMarkers, NavballState, SimSnapshot } from '@/core/contracts/sim';
import type { NavballRenderer } from '@/core/contracts/ui';
import type { Vec3 } from '@/core/math/vec3';
import type { MarkerIconName } from '../icons';
import { ATLAS_LAYOUT, ATLAS_SIZE, drawMarkerAtlas, type AtlasEntry } from './markerAtlas';
import { BALL_RADIUS_FRACTION, BALL_TEXTURE_SIZE, limbFade, MARKER_HALF_SIZE } from './navballMath';
import { NAVBALL_WGSL } from './navballShader';
import { buildMipChain, drawBallTextures } from './navballTexture';

export const NAVBALL_TEXTURE_SIZE = 512;
export const NAVBALL_FORMAT: GPUTextureFormat = 'rgba8unorm';
const MAX_MARKERS = 16;
const RETICLE_HALF_SIZE = 0.2;

/** Draw order: radial and normal markers below, prograde / retrograde and the lift vector on top. */
const MARKER_ORDER: (keyof NavballMarkers & MarkerIconName)[] = ['radialOut', 'radialIn', 'normal', 'antinormal', 'target', 'antiTarget', 'maneuver', 'retrograde', 'prograde', 'liftVector'];

export interface MarkerInstance {
  name: AtlasEntry;
  /** Normalised ball coordinates (+y up). */
  sx: number;
  sy: number;
  halfSize: number;
  alpha: number;
}

/**
 * Marker quads for a navball state (visible hemisphere only), in draw order. The fixed reticle comes last, on
 * top: like the aircraft symbol of an ADI it is never covered, and its open centre and thin outline keep a
 * marker held on the nose (SAS prograde hold) readable under it. Pure: also used by the tests.
 */
export function markerInstances(markers: NavballMarkers): MarkerInstance[] {
  const out: MarkerInstance[] = [];
  for (const name of MARKER_ORDER) {
    if (out.length >= MAX_MARKERS - 1) break;
    const d: Vec3 | null = markers[name];
    if (!d) continue;
    const alpha = limbFade(d.y);
    if (alpha <= 0) continue;
    out.push({ name, sx: d.x, sy: d.z, halfSize: MARKER_HALF_SIZE, alpha });
  }
  out.push({ name: 'reticle', sx: 0, sy: 0, halfSize: RETICLE_HALF_SIZE, alpha: 1 });
  return out;
}

export interface NavballRendererOptions {
  /** GPU timestamps: passes 'ui.navball' (the shared texture) and 'ui.navball.hud' (renderTo). */
  perf?: Pick<PerfRecorder, 'gpuPass'>;
}

export interface NavballRendererImpl extends NavballRenderer {
  readonly texture: GPUTexture;
  /** Markers drawn by the most recent render (normalised ball coordinates). */
  readonly lastMarkers: readonly MarkerInstance[];
  /** Render a NavballState into the shared 512 x 512 texture. */
  renderState(encoder: GPUCommandEncoder, state: NavballState): void;
  /**
   * Render the same ball into another square target (e.g. the HUD canvas) at its native resolution.
   * `radiusFraction` (default BALL_RADIUS_FRACTION) leaves room for a bezel; `instrument` selects the lit
   * HUD look (window reflection, deep shading, contact shadow) instead of the shared texture's soft shading.
   */
  renderTo(encoder: GPUCommandEncoder, state: NavballState, target: GPUTextureView, format: GPUTextureFormat, sizePx: number, opts?: NavballTargetOptions): void;
  dispose(): void;
}

export interface NavballTargetOptions {
  /** Radius of the ball as a fraction of half the target (default BALL_RADIUS_FRACTION). */
  radiusFraction?: number;
  /** Part of the ball's radius that is drawn (default 1): a bezel lip covers the rest (HUD_BALL_LIP). */
  lip?: number;
  instrument?: boolean;
}

interface Pipelines {
  ball: GPURenderPipeline;
  marker: GPURenderPipeline;
}

export function createNavballRenderer(gpu: GpuHandle, opts: NavballRendererOptions = {}): NavballRendererImpl {
  const device = gpu.device;
  const module = device.createShaderModule({ label: 'ui.navball', code: NAVBALL_WGSL });

  // Ball textures (equirectangular, full mip chains drawn on the CPU once): the painted ball and the same ball
  // with its lettering; the shader shows the lettering per label (navballShader.ts).
  const ballTextures = drawBallTextures();
  const upload = (canvas: OffscreenCanvas, label: string): GPUTexture => {
    const levels = buildMipChain(canvas);
    const tex = device.createTexture({
      label,
      size: BALL_TEXTURE_SIZE,
      mipLevelCount: levels.length,
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    levels.forEach((c, mipLevel) => device.queue.copyExternalImageToTexture({ source: c }, { texture: tex, mipLevel }, [c.width, c.height]));
    return tex;
  };
  const ballTex = upload(ballTextures.base, 'ui.navball.ballTexture');
  const labelTex = upload(ballTextures.labelled, 'ui.navball.ballTexture.labelled');
  const labelLayout = ballTextures.layout;

  const atlasLevels = drawMarkerAtlas();
  const atlasTex = device.createTexture({
    label: 'ui.navball.markerAtlas',
    size: ATLAS_SIZE,
    mipLevelCount: atlasLevels.length,
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  atlasLevels.forEach((c, mipLevel) =>
    device.queue.copyExternalImageToTexture({ source: c }, { texture: atlasTex, mipLevel, premultipliedAlpha: true }, [c.width, c.height]),
  );

  const sampler = device.createSampler({
    label: 'ui.navball.sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'clamp-to-edge',
    maxAnisotropy: 8,
  });

  const target = device.createTexture({
    label: 'ui.navball',
    size: [NAVBALL_TEXTURE_SIZE, NAVBALL_TEXTURE_SIZE],
    format: NAVBALL_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  const view = target.createView();

  const layout = device.createBindGroupLayout({
    label: 'ui.navball',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ label: 'ui.navball', bindGroupLayouts: [layout] });

  const BALL_BYTES = 80;
  const MARKER_BYTES = 16 + MAX_MARKERS * 32;
  const markerBuf = device.createBuffer({ label: 'ui.navball.markers', size: MARKER_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const markerData = new ArrayBuffer(MARKER_BYTES);
  const markerF32 = new Float32Array(markerData);
  const markerU32 = new Uint32Array(markerData);

  /** One ball uniform + bind group per render target (sizes differ). */
  interface Slot {
    buf: GPUBuffer;
    bind: GPUBindGroup;
    /** Bytes last written to the buffer (meaningful once `valid`). */
    data: Float32Array;
    valid: boolean;
  }
  const makeSlot = (label: string): Slot => {
    const buf = device.createBuffer({ label, size: BALL_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bind = device.createBindGroup({
      label,
      layout,
      entries: [
        { binding: 0, resource: { buffer: buf } },
        { binding: 1, resource: ballTex.createView() },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: markerBuf } },
        { binding: 4, resource: atlasTex.createView() },
        { binding: 5, resource: labelTex.createView() },
      ],
    });
    return { buf, bind, data: new Float32Array(BALL_BYTES / 4), valid: false };
  };
  const shared = makeSlot('ui.navball.uniforms');
  const hudSlot = makeSlot('ui.navball.hud.uniforms');

  const pipelines = new Map<GPUTextureFormat, Pipelines>();
  const pipelinesFor = (format: GPUTextureFormat): Pipelines => {
    let p = pipelines.get(format);
    if (p) return p;
    const blend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    p = {
      ball: device.createRenderPipeline({
        label: `ui.navball.ball.${format}`,
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vsBall' },
        fragment: { module, entryPoint: 'fsBall', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      }),
      marker: device.createRenderPipeline({
        label: `ui.navball.marker.${format}`,
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vsMarker' },
        fragment: { module, entryPoint: 'fsMarker', targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list' },
      }),
    };
    pipelines.set(format, p);
    return p;
  };
  pipelinesFor(NAVBALL_FORMAT);

  // Per-frame work is kept to plain float writes: no strings, no temporary arrays, each marker set processed once
  // per NavballState.markers object (render + renderTo of one state share it), and a uniform buffer is only
  // written when its bytes change.
  const ballScratch = new Float32Array(BALL_BYTES / 4);
  const markerScratch = new Float32Array(MARKER_BYTES / 4);
  const markerScratchU32 = new Uint32Array(markerScratch.buffer);
  let markerSource: NavballMarkers | null = null;
  let markerCount = 0;
  let markerBytesValid = false;

  const putMarker = (i: number, name: AtlasEntry, sx: number, sy: number, halfSize: number, alpha: number): void => {
    const r = ATLAS_LAYOUT[name];
    const o = 4 + i * 8;
    markerScratch[o] = sx;
    markerScratch[o + 1] = sy;
    markerScratch[o + 2] = halfSize;
    markerScratch[o + 3] = alpha;
    markerScratch[o + 4] = r[0];
    markerScratch[o + 5] = r[1];
    markerScratch[o + 6] = r[2];
    markerScratch[o + 7] = r[3];
  };

  /** Same instances and order as markerInstances() (reticle last), written straight into the uniform layout. */
  const updateMarkers = (markers: NavballMarkers): number => {
    if (markers === markerSource) return markerCount;
    markerSource = markers;
    let count = 0;
    for (const name of MARKER_ORDER) {
      if (count >= MAX_MARKERS - 1) break;
      const d = markers[name];
      if (!d) continue;
      const alpha = limbFade(d.y);
      if (alpha <= 0) continue;
      putMarker(count++, name, d.x, d.z, MARKER_HALF_SIZE, alpha);
    }
    putMarker(count++, 'reticle', 0, 0, RETICLE_HALF_SIZE, 1);
    markerScratchU32[0] = count;
    const used = 4 + count * 8;
    let same = markerBytesValid && markerU32[0] === count;
    for (let i = 4; same && i < used; i++) same = markerF32[i] === markerScratch[i];
    if (!same) {
      markerF32.set(markerScratch.subarray(0, used));
      device.queue.writeBuffer(markerBuf, 0, markerData, 0, used * 4);
      markerBytesValid = true;
    }
    markerCount = count;
    return count;
  };

  const writeState = (slot: Slot, state: NavballState, sizePx: number, radiusFraction = BALL_RADIUS_FRACTION, look = 0, lip = 1): number => {
    const { x, y, z, w } = state.qVesselToHorizon;
    const b = ballScratch;
    // mat3.fromQuat, row by row, each padded to a vec4.
    b[0] = 1 - 2 * (y * y + z * z);
    b[1] = 2 * (x * y - w * z);
    b[2] = 2 * (x * z + w * y);
    b[4] = 2 * (x * y + w * z);
    b[5] = 1 - 2 * (x * x + z * z);
    b[6] = 2 * (y * z - w * x);
    b[8] = 2 * (x * z - w * y);
    b[9] = 2 * (y * z + w * x);
    b[10] = 1 - 2 * (x * x + y * y);
    b[12] = radiusFraction;
    b[13] = sizePx;
    b[14] = look;
    b[15] = lip;
    b[16] = labelLayout.headingHalfW;
    b[17] = labelLayout.headingHalfH;
    b[18] = labelLayout.numeralHalfW;
    b[19] = labelLayout.numeralHalfH;
    const d = slot.data;
    let same = slot.valid;
    for (let i = 0; same && i < BALL_BYTES / 4; i++) same = d[i] === b[i];
    if (!same) {
      d.set(b);
      device.queue.writeBuffer(slot.buf, 0, d);
      slot.valid = true;
    }
    return updateMarkers(state.markers);
  };

  const draw = (encoder: GPUCommandEncoder, slot: Slot, count: number, targetView: GPUTextureView, format: GPUTextureFormat, passName: string): void => {
    const p = pipelinesFor(format);
    const timestampWrites = opts.perf?.gpuPass(passName) as GPURenderPassTimestampWrites | undefined;
    const pass = encoder.beginRenderPass({
      label: passName,
      colorAttachments: [{ view: targetView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    pass.setBindGroup(0, slot.bind);
    pass.setPipeline(p.ball);
    pass.draw(3);
    pass.setPipeline(p.marker);
    pass.draw(6, count);
    pass.end();
  };

  const renderState = (encoder: GPUCommandEncoder, state: NavballState): void => {
    const count = writeState(shared, state, NAVBALL_TEXTURE_SIZE);
    draw(encoder, shared, count, view, NAVBALL_FORMAT, 'ui.navball');
  };

  return {
    view,
    texture: target,
    get lastMarkers() {
      return markerSource ? markerInstances(markerSource).slice(0, MAX_MARKERS) : [];
    },
    render(encoder: GPUCommandEncoder, snapshot: SimSnapshot) {
      renderState(encoder, snapshot.navball);
    },
    renderState,
    renderTo(encoder, state, targetView, format, sizePx, o) {
      const count = writeState(hudSlot, state, sizePx, o?.radiusFraction ?? BALL_RADIUS_FRACTION, o?.instrument ? 1 : 0, o?.lip ?? 1);
      draw(encoder, hudSlot, count, targetView, format, 'ui.navball.hud');
    },
    dispose() {
      target.destroy();
      ballTex.destroy();
      labelTex.destroy();
      atlasTex.destroy();
      shared.buf.destroy();
      hudSlot.buf.destroy();
      markerBuf.destroy();
    },
  };
}
