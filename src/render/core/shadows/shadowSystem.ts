/**
 * GPU side of the sun shadow cascades: the 2048^2 x 8 depth array ('shadow.cascades'), the per-frame
 * uniform block ('shadow.uniforms'), and one small pass uniform + bind group per layer (group 1 of every
 * drawShadow pipeline). The float64 planning lives in cascadeMath.ts.
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
  readonly mapSize: number;
  readonly passLayout: GPUBindGroupLayout;
  private readonly scheduler = new CascadeScheduler();
  private readonly layerViews: GPUTextureView[] = [];
  private readonly passBuffers: GPUBuffer[] = [];
  private readonly passGroups: GPUBindGroup[] = [];
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new ArrayBuffer(SHADOW_UNIFORM_BYTES);
  private readonly passData = new Float32Array(20);
  private frames: CascadeFrame[] = [];

  constructor(
    private readonly device: GPUDevice,
    resources: SharedResources,
    mapSize: number,
    reportError: (m: string) => void,
  ) {
    this.mapSize = mapSize;
    this.passLayout = device.createBindGroupLayout({
      label: 'shadow.pass',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    const texture = createTextureChecked(
      device,
      {
        label: 'shadow.cascades',
        format: RENDER_FORMATS.shadow,
        size: [mapSize, mapSize, SHADOW_MAX_CASCADES],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      },
      reportError,
    );
    // Start fully lit: a layer that is sampled before its first render must not shadow anything.
    const enc = device.createCommandEncoder({ label: 'shadow.clear' });
    for (let l = 0; l < SHADOW_MAX_CASCADES; l++) {
      const view = texture.createView({ label: `shadow.layer${l}`, dimension: '2d', baseArrayLayer: l, arrayLayerCount: 1 });
      this.layerViews.push(view);
      enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } }).end();
      const buffer = device.createBuffer({ label: `shadow.pass${l}`, size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.passBuffers.push(buffer);
      this.passGroups.push(device.createBindGroup({ label: `shadow.pass${l}`, layout: this.passLayout, entries: [{ binding: 0, resource: { buffer } }] }));
    }
    device.queue.submit([enc.finish()]);
    this.uniformBuffer = device.createBuffer({ label: 'shadow.uniforms', size: SHADOW_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    resources.publish('shadow.cascades', texture.createView({ label: 'shadow.cascades', dimension: '2d-array' }));
    resources.publish('shadow.uniforms', this.uniformBuffer);
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
      mapSize: this.mapSize,
      sunDirRoot: frame.sun.dirRoot,
    };
    this.frames = this.scheduler.update(input);

    const u32 = new Uint32Array(this.uniformData, 0, 4);
    const f = new Float32Array(this.uniformData);
    f.fill(0);
    u32[0] = this.frames.length;
    f[4] = 2 * Math.tan(frame.sun.angularRadius);
    f[5] = 1 / this.mapSize;
    f[6] = this.mapSize;
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
