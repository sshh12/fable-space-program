/**
 * Shadow maps of spot lights (request vehicle-pad-2, part 2). Up to SPOT_SHADOW_MAX spot lights with
 * `castShadow` get a perspective depth map each, rendered every frame from the core mesh system's casters
 * (vehicles, site structures: everything drawn through mesh batches with `castShadow`); the deferred pass looks
 * them up with a 3 x 3 bilinear PCF. Terrain and features with their own geometry receive these shadows but do
 * not cast into them.
 */
import { RENDER_FORMATS, type LocalLight } from '@/core/contracts/render';
import { v3, type Mat4, type Vec3 } from '@/core/math';
import { createTextureChecked } from '../util/gpu';

export const SPOT_SHADOW_MAX = 2;
export const SPOT_SHADOW_SIZE = 1024;
/** Uniform: viewProj per map (16 floats each), then per map (tan of the half field of view, near, far, unused). */
export const SPOT_SHADOW_UNIFORM_BYTES = SPOT_SHADOW_MAX * 64 + SPOT_SHADOW_MAX * 16;

/**
 * Perspective matrix of a spot light's shadow map: camera-relative ROOT position -> clip, looking along `axis`
 * from `posRelCam`, a square field of view of twice `halfAngle`, depth 0 at `near` .. 1 at `far` (standard Z,
 * as the sun cascades: cleared to 1, compare 'less').
 */
export function spotViewProj(posRelCam: Vec3, axis: Vec3, halfAngle: number, near: number, far: number): Mat4 {
  const a = v3.normalize(axis);
  const helper = Math.abs(a.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const r = v3.normalize(v3.cross(helper, a));
  const u = v3.cross(a, r);
  const f = 1 / Math.tan(halfAngle);
  const A = far / (far - near);
  const B = (-near * far) / (far - near);
  const m = new Float64Array(16);
  const row = (i: number, x: number, y: number, z: number, w: number): void => {
    m[i] = x;
    m[4 + i] = y;
    m[8 + i] = z;
    m[12 + i] = w;
  };
  row(0, f * r.x, f * r.y, f * r.z, -f * v3.dot(r, posRelCam));
  row(1, f * u.x, f * u.y, f * u.z, -f * v3.dot(u, posRelCam));
  row(2, A * a.x, A * a.y, A * a.z, -A * v3.dot(a, posRelCam) + B);
  row(3, a.x, a.y, a.z, -v3.dot(a, posRelCam));
  return m;
}

export interface SpotShadowPass {
  light: LocalLight;
  index: number;
  viewProj: Mat4;
  attachment: GPUTextureView;
  bindGroup: GPUBindGroup;
}

/** Which spot lights get a map this frame: the brightest at the camera among those that ask for one. */
export function pickShadowedSpots(lights: readonly LocalLight[]): LocalLight[] {
  const score = (l: LocalLight): number => (0.2126 * l.intensity[0] + 0.7152 * l.intensity[1] + 0.0722 * l.intensity[2]) / Math.max(v3.dot(l.posRelCam, l.posRelCam), l.range * l.range * 0.01, 1);
  return lights
    .filter((l) => l.kind === 'spot' && l.castShadow === true && l.dirRelCam !== undefined)
    .sort((a, b) => score(b) - score(a))
    .slice(0, SPOT_SHADOW_MAX);
}

export class SpotShadows {
  readonly arrayView: GPUTextureView;
  readonly uniform: GPUBuffer;
  private readonly layerViews: GPUTextureView[] = [];
  private readonly passBuffers: GPUBuffer[] = [];
  private readonly passGroups: GPUBindGroup[] = [];
  private readonly data = new Float32Array(SPOT_SHADOW_UNIFORM_BYTES / 4);
  private readonly passData = new Float32Array(20);

  constructor(
    private readonly device: GPUDevice,
    passLayout: GPUBindGroupLayout,
    reportError: (m: string) => void,
  ) {
    const texture = createTextureChecked(
      device,
      { label: 'shadow.spots', format: RENDER_FORMATS.shadow, size: [SPOT_SHADOW_SIZE, SPOT_SHADOW_SIZE, SPOT_SHADOW_MAX], usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING },
      reportError,
    );
    for (let l = 0; l < SPOT_SHADOW_MAX; l++) {
      this.layerViews.push(texture.createView({ label: `shadow.spot${l}`, dimension: '2d', baseArrayLayer: l, arrayLayerCount: 1 }));
      const buffer = device.createBuffer({ label: `shadow.spotPass${l}`, size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.passBuffers.push(buffer);
      this.passGroups.push(device.createBindGroup({ label: `shadow.spotPass${l}`, layout: passLayout, entries: [{ binding: 0, resource: { buffer } }] }));
    }
    this.arrayView = texture.createView({ label: 'shadow.spots', dimension: '2d-array' });
    this.uniform = device.createBuffer({ label: 'shadow.spotUniforms', size: SPOT_SHADOW_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Plan this frame's maps for the picked lights (index = position in the list) and upload their matrices. */
  update(picked: readonly LocalLight[]): SpotShadowPass[] {
    this.data.fill(0);
    const out: SpotShadowPass[] = [];
    picked.forEach((light, index) => {
      const outer = Math.min(Math.max(light.cone?.[1] ?? Math.PI / 4, 0.02), 1.3);
      const far = Math.max(light.range, 1);
      const near = Math.max(0.05, far * 2e-4);
      const viewProj = spotViewProj(light.posRelCam, light.dirRelCam!, outer, near, far);
      this.data.set(viewProj, index * 16);
      this.data.set([Math.tan(outer), near, far, 0], SPOT_SHADOW_MAX * 16 + index * 4);
      this.passData.fill(0);
      this.passData.set(viewProj, 0);
      // params: texel size at the far end (m, for the mesh system's small-caster rule), depth range (m), layer, every frame.
      this.passData.set([(2 * far * Math.tan(outer)) / SPOT_SHADOW_SIZE, far - near, index, 1], 16);
      this.device.queue.writeBuffer(this.passBuffers[index]!, 0, this.passData);
      out.push({ light, index, viewProj, attachment: this.layerViews[index]!, bindGroup: this.passGroups[index]! });
    });
    this.device.queue.writeBuffer(this.uniform, 0, this.data);
    return out;
  }
}
