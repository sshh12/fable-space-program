/**
 * GPU side of the sun shadow cascades: the mapSize^2 x 8 depth array ('shadow.cascades'; 2048 at the Ultra
 * level of the 'shadows' quality setting, src/render/core/quality.ts), the per-frame uniform block
 * ('shadow.uniforms'), and one small pass uniform + bind group per layer (group 1 of every drawShadow
 * pipeline). The float64 planning lives in cascadeMath.ts. `setMapSize` replaces the array (the 'rebuild'
 * of that setting): the pass layout, the pass groups and the uniform buffer stay, the new array is published
 * under the same key (features rebind on its version) and every cascade is rendered again.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import { RENDER_FORMATS, type CameraState, type FrameContext, type ShadowCascadeView, type SharedResources } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { SHADOW_UNIFORM_BYTES } from '../resources';
import { SHADOW_MAX_CASCADES } from '../shaders/chunksLighting';
import { createTextureChecked } from '../util/gpu';
import { CascadeScheduler, type CascadeFrame, type PlanInput } from './cascadeMath';

export interface ShadowPassTarget {
  view: ShadowCascadeView;
  attachment: GPUTextureView;
  bindGroup: GPUBindGroup;
}

export class ShadowSystem {
  readonly passLayout: GPUBindGroupLayout;
  private size: number;
  private readonly scheduler = new CascadeScheduler();
  private texture: GPUTexture | null = null;
  private layerViews: GPUTextureView[] = [];
  private readonly passBuffers: GPUBuffer[] = [];
  private readonly passGroups: GPUBindGroup[] = [];
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new ArrayBuffer(SHADOW_UNIFORM_BYTES);
  private readonly passData = new Float32Array(20);
  private frames: CascadeFrame[] = [];
  /**
   * For A/B pictures of the filter (ShadowUniforms.count.y): 1 = the kernel is not turned per pixel anywhere,
   * 2 = no dithered cross-fade between cascades (the first cascade that covers a point is used). 0 in the game.
   */
  debugFlags = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly resources: SharedResources,
    mapSize: number,
    private readonly reportError: (m: string) => void,
  ) {
    this.size = mapSize;
    this.passLayout = device.createBindGroupLayout({
      label: 'shadow.pass',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    for (let l = 0; l < SHADOW_MAX_CASCADES; l++) {
      const buffer = device.createBuffer({ label: `shadow.pass${l}`, size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.passBuffers.push(buffer);
      this.passGroups.push(device.createBindGroup({ label: `shadow.pass${l}`, layout: this.passLayout, entries: [{ binding: 0, resource: { buffer } }] }));
    }
    this.uniformBuffer = device.createBuffer({ label: 'shadow.uniforms', size: SHADOW_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.allocate();
    resources.publish('shadow.uniforms', this.uniformBuffer);
  }

  /** Side of the cascade array, texels. */
  get mapSize(): number {
    return this.size;
  }

  /** Replace the cascade array by one of another side; every cascade is rendered again from the next frame. */
  setMapSize(mapSize: number): void {
    if (mapSize === this.size) return;
    this.size = mapSize;
    this.allocate();
    this.scheduler.reset();
  }

  /** The depth array, cleared to fully lit (a layer sampled before its first render shadows nothing), its layer views; published. */
  private allocate(): void {
    this.texture?.destroy();
    const texture = createTextureChecked(
      this.device,
      {
        label: 'shadow.cascades',
        format: RENDER_FORMATS.shadow,
        size: [this.size, this.size, SHADOW_MAX_CASCADES],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      },
      this.reportError,
    );
    this.texture = texture;
    this.layerViews = [];
    const enc = this.device.createCommandEncoder({ label: 'shadow.clear' });
    for (let l = 0; l < SHADOW_MAX_CASCADES; l++) {
      const view = texture.createView({ label: `shadow.layer${l}`, dimension: '2d', baseArrayLayer: l, arrayLayerCount: 1 });
      this.layerViews.push(view);
      enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } }).end();
    }
    this.device.queue.submit([enc.finish()]);
    this.resources.publish('shadow.cascades', texture.createView({ label: 'shadow.cascades', dimension: '2d-array' }));
  }

  /** Drop every cascade capture: the next frame renders all of them from nothing (CoreRenderer.renderExact). */
  restart(): void {
    this.scheduler.reset();
  }

  /** Plan this frame's cascades in float64 and upload every matrix. Returns the cascades to RENDER this frame. */
  update(frame: FrameContext, snapshot: SimSnapshot, camera: CameraState, defs: DefLibrary): ShadowPassTarget[] {
    const input: PlanInput = {
      frame: frame.frameIndex,
      bodies: frame.bodies
        .filter((b) => b.id !== snapshot.starId && defs.bodies[b.id])
        .map((b) => {
          const def = defs.bodies[b.id]!;
          return {
            id: b.id,
            radius: def.radius,
            maxElevation: def.terrain?.maxElevation ?? 0,
            minElevation: def.terrain?.minElevation ?? 0,
            hasTerrain: def.terrain !== null,
            centerRelCam: b.centerRelCam,
            qFixedToRoot: b.qFixedToRoot,
            sunDirRoot: b.sunDir,
          };
        }),
      vessels: frame.vessels.map((v, i) => ({ id: v.id, originRelCam: v.originRelCam, q: v.q, boundingRadius: snapshot.vessels[i]?.boundingRadius ?? 10 })),
      insideVesselId: camera.kind === 'interior' ? camera.insideVesselId : null,
      fovY: camera.fovY,
      renderHeight: frame.renderSize[1],
      mapSize: this.size,
      sunDirRoot: frame.sun.dirRoot,
    };
    this.frames = this.scheduler.update(input);

    const u32 = new Uint32Array(this.uniformData, 0, 4);
    const f = new Float32Array(this.uniformData);
    f.fill(0);
    u32[0] = this.frames.length;
    u32[1] = this.debugFlags;
    f[4] = 2 * Math.tan(frame.sun.angularRadius);
    f[5] = 1 / this.size;
    f[6] = this.size;
    f[7] = 0.7;
    const targets: ShadowPassTarget[] = [];
    this.frames.forEach((c, i) => {
      const o = 8 + i * 32;
      const m = c.matrices;
      f.set(m.viewProj, o);
      const zRange = 2 * c.capture.zHalf;
      f.set([c.capture.texelSize, zRange, c.desired.weight, c.capture.texelSizeV], o + 16);
      f.set([m.lightDirRoot.x, m.lightDirRoot.y, m.lightDirRoot.z, c.capture.radius], o + 20);
      f.set([m.axisURoot.x, m.axisURoot.y, m.axisURoot.z, c.layer], o + 24);
      f.set([m.axisVRoot.x, m.axisVRoot.y, m.axisVRoot.z, (c.desired.everyFrame ? 1 : 0) + (c.desired.fit === 'body' ? 2 : 0)], o + 28);
      if (c.render) {
        this.passData.set(m.viewProj, 0);
        this.passData.set([c.capture.texelSize, zRange, c.layer, c.desired.everyFrame ? 1 : 0], 16);
        this.device.queue.writeBuffer(this.passBuffers[c.layer]!, 0, this.passData);
        targets.push({
          view: {
            index: c.layer,
            viewProj: m.viewProj,
            texelSize: c.capture.texelSize,
            texelSizeV: c.capture.texelSizeV,
            farDistance: c.desired.farDistance,
            anchor: c.desired.anchor,
            everyFrame: c.desired.everyFrame,
            fit: c.desired.fit,
          },
          attachment: this.layerViews[c.layer]!,
          bindGroup: this.passGroups[c.layer]!,
        });
      }
    });
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    return targets;
  }

  /** Every cascade of the current frame (rendered or not), in sampling order. */
  current(): readonly CascadeFrame[] {
    return this.frames;
  }
}
