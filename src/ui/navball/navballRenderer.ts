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
 * (navballMath.projectMarker), fading toward the limb, with the fixed vessel reticle on top.
 */
import type { GpuHandle } from '@/core/gpu/device';
import type { PerfRecorder } from '@/core/contracts/render';
import type { NavballMarkers, NavballState, SimSnapshot } from '@/core/contracts/sim';
import type { NavballRenderer } from '@/core/contracts/ui';
import { mat3 } from '@/core/math/mat';
import type { Vec3 } from '@/core/math/vec3';
import type { MarkerIconName } from '../icons';
import { ATLAS_LAYOUT, ATLAS_SIZE, drawMarkerAtlas, type AtlasEntry } from './markerAtlas';
import { BALL_RADIUS_FRACTION, BALL_TEXTURE_SIZE, limbFade, MARKER_HALF_SIZE } from './navballMath';
import { NAVBALL_WGSL } from './navballShader';
import { buildMipChain, drawBallTexture } from './navballTexture';

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
 * Marker quads for a navball state (visible hemisphere only). The fixed reticle is drawn first so a marker held
 * on the nose (SAS prograde hold) stays visible on top of it. Pure: also used by the tests.
 */
export function markerInstances(markers: NavballMarkers): MarkerInstance[] {
  const out: MarkerInstance[] = [{ name: 'reticle', sx: 0, sy: 0, halfSize: RETICLE_HALF_SIZE, alpha: 1 }];
  for (const name of MARKER_ORDER) {
    const d: Vec3 | null = markers[name];
    if (!d) continue;
    const alpha = limbFade(d.y);
    if (alpha <= 0) continue;
    out.push({ name, sx: d.x, sy: d.z, halfSize: MARKER_HALF_SIZE, alpha });
  }
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
  /** Render the same ball into another square target (e.g. the HUD canvas) at its native resolution. */
  renderTo(encoder: GPUCommandEncoder, state: NavballState, target: GPUTextureView, format: GPUTextureFormat, sizePx: number): void;
  dispose(): void;
}

interface Pipelines {
  ball: GPURenderPipeline;
  marker: GPURenderPipeline;
}

export function createNavballRenderer(gpu: GpuHandle, opts: NavballRendererOptions = {}): NavballRendererImpl {
  const device = gpu.device;
  const module = device.createShaderModule({ label: 'ui.navball', code: NAVBALL_WGSL });

  // Ball texture (equirectangular, full mip chain drawn on the CPU once).
  const ballLevels = buildMipChain(drawBallTexture());
  const ballTex = device.createTexture({
    label: 'ui.navball.ballTexture',
    size: BALL_TEXTURE_SIZE,
    mipLevelCount: ballLevels.length,
    format: 'rgba8unorm-srgb',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  ballLevels.forEach((c, mipLevel) => device.queue.copyExternalImageToTexture({ source: c }, { texture: ballTex, mipLevel }, [c.width, c.height]));

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
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ label: 'ui.navball', bindGroupLayouts: [layout] });

  const BALL_BYTES = 64;
  const MARKER_BYTES = 16 + MAX_MARKERS * 32;
  const markerBuf = device.createBuffer({ label: 'ui.navball.markers', size: MARKER_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const markerData = new ArrayBuffer(MARKER_BYTES);
  const markerF32 = new Float32Array(markerData);
  const markerU32 = new Uint32Array(markerData);

  /** One ball uniform + bind group per render target (sizes differ). */
  interface Slot {
    buf: GPUBuffer;
    bind: GPUBindGroup;
    data: Float32Array;
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
      ],
    });
    return { buf, bind, data: new Float32Array(BALL_BYTES / 4) };
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

  let lastMarkers: MarkerInstance[] = [];
  let lastMarkerKey = '';

  const writeState = (slot: Slot, state: NavballState, sizePx: number): number => {
    const m = mat3.fromQuat(state.qVesselToHorizon);
    const d = slot.data;
    d.set([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, BALL_RADIUS_FRACTION, sizePx, 0, 0]);
    device.queue.writeBuffer(slot.buf, 0, d);
    const inst = markerInstances(state.markers);
    const count = Math.min(MAX_MARKERS, inst.length);
    const key = inst.map((x) => `${x.name}${x.sx},${x.sy},${x.alpha}`).join('|');
    if (key !== lastMarkerKey) {
      markerU32[0] = count;
      for (let i = 0; i < count; i++) {
        const x = inst[i]!;
        const r = ATLAS_LAYOUT[x.name];
        markerF32.set([x.sx, x.sy, x.halfSize, x.alpha, r[0], r[1], r[2], r[3]], 4 + i * 8);
      }
      device.queue.writeBuffer(markerBuf, 0, markerData);
      lastMarkerKey = key;
    }
    lastMarkers = inst;
    return count;
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
      return lastMarkers;
    },
    render(encoder: GPUCommandEncoder, snapshot: SimSnapshot) {
      renderState(encoder, snapshot.navball);
    },
    renderState,
    renderTo(encoder, state, targetView, format, sizePx) {
      const count = writeState(hudSlot, state, sizePx);
      draw(encoder, hudSlot, count, targetView, format, 'ui.navball.hud');
    },
    dispose() {
      target.destroy();
      ballTex.destroy();
      atlasTex.destroy();
      shared.buf.destroy();
      hudSlot.buf.destroy();
      markerBuf.destroy();
    },
  };
}
