/**
 * Vessel interaction, from the snapshot only: damping of the FFT chop around floating or entering vessels
 * (so the drawn waterline follows the physics swell), splash ripples from 'splash' / water 'touchdown'
 * events, the vessel-centred wake / foam accumulation texture, and the 'ocean.wetness' slots for hull shading.
 */
import { OCEAN_WETNESS_BYTES, OCEAN_WETNESS_SLOTS, type FrameContext, type RenderContext } from '@/core/contracts/render';
import type { VesselSnapshot } from '@/core/contracts/sim';
import { oceanSwellHeight } from '@/core/geo/oceanSwell';
import { quat, TWO_PI, v3, type Vec3 } from '@/core/math';
import type { OceanTunables } from './params';
import { chartCoords, chartDir, type ChartReference, type OceanChart } from './nearField';
import { MAX_RIPPLES, MAX_VESSELS } from './shaders/waves';
import type { OceanRippleSource, OceanVesselZone } from './uniforms';

export const WAKE_SIZE = 256;

/** Water surface height above the reference radius exactly as the physics evaluates it (sim/world environment). */
export function physicsWaterHeight(t: OceanTunables, seaLevel: number, dirFixed: Vec3, ut: number): number {
  return seaLevel + oceanSwellHeight(t.swell, t.gravity, t.seaRadius, dirFixed, ut);
}

interface Ripple {
  /** Planet-fixed chart coordinates of the splash, m. */
  x: number;
  y: number;
  ut0: number;
  amplitude: number;
}

interface WetState {
  maxLevel: number;
  lastSplashUt: number;
}

export interface VesselFrame {
  zones: OceanVesselZone[];
  ripples: OceanRippleSource[];
  wake: { x: number; y: number; extent: number; valid: boolean };
  /** Wake sources this frame, in wake texture coordinates (texels): ring around a hull, or a splash disc. */
  wakeSources: { cx: number; cy: number; radius: number; ring: number; amount: number }[];
  /** Integer texel shift of the wake texture since the previous frame. */
  wakeShift: [number, number];
}

const WAKE_WGSL = /* wgsl */ `
struct WakeParams {
  shift: vec4i,           // xy = texel shift since the previous frame, z = source count
  decay: vec4f,           // x = per-frame decay, y = diffusion
  sources: array<vec4f, 16>,   // xy = centre (texels), z = radius (texels), w = amount; ring flag in the next array
  rings: array<vec4f, 16>,     // x = ring width (texels, 0 = filled disc)
}
@group(0) @binding(0) var<uniform> wp: WakeParams;
@group(0) @binding(1) var wakePrev: texture_2d<f32>;
@group(0) @binding(2) var wakeOut: texture_storage_2d<rgba16float, write>;
const WAKE_TAPS = array<vec2i, 5>(vec2i(0, 0), vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1));
@compute @workgroup_size(8, 8, 1)
fn wake(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(wakeOut));
  let p = vec2i(id.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }
  let q = p + wp.shift.xy;
  var v = 0.0;
  var nsum = 0.0;
  for (var k = 0; k < 5; k++) {
    let r = q + WAKE_TAPS[k];
    if (r.x >= 0 && r.y >= 0 && r.x < size.x && r.y < size.y) {
      let w = select(wp.decay.y, 1.0 - 4.0 * wp.decay.y, k == 0);
      v += textureLoad(wakePrev, r, 0).r * w;
      nsum += w;
    }
  }
  v = select(0.0, v / max(nsum, 1e-6), nsum > 0.0) * wp.decay.x;
  for (var i = 0; i < wp.shift.z; i++) {
    let s = wp.sources[i];
    let d = distance(vec2f(p) + 0.5, s.xy);
    let width = wp.rings[i].x;
    var m = 0.0;
    if (width > 0.0) { m = exp(-sq((d - s.z) / width)); } else { m = 1.0 - smoothstep(s.z * 0.6, s.z, d); }
    v = v + (1.0 - v) * saturate(m * s.w);
  }
  textureStore(wakeOut, p, vec4f(saturate(v), 0.0, 0.0, 1.0));
}
fn sq(x: f32) -> f32 { return x * x; }
`;

export class OceanVessels {
  private ripples: Ripple[] = [];
  private wet = new Map<string, WetState>();
  private wakeOrigin: [number, number] | null = null;
  private readonly wakeTex: [GPUTexture, GPUTexture];
  readonly wakeViews: [GPUTextureView, GPUTextureView];
  wakeCurrent = 0;
  private readonly wakePipe: GPUComputePipeline;
  private readonly wakeGroups: [GPUBindGroup, GPUBindGroup];
  private readonly wakeParams: GPUBuffer;
  private readonly wakeData = new ArrayBuffer(32 + 16 * 16 * 2);
  readonly wetness: GPUBuffer;
  private readonly wetData = new ArrayBuffer(OCEAN_WETNESS_BYTES);
  /** Slots filled in 'ocean.wetness' by the latest update. */
  wetSlots = 0;

  constructor(private readonly ctx: RenderContext) {
    const device = ctx.device;
    const mk = (k: number): GPUTexture =>
      device.createTexture({ label: `ocean.wake${k}`, format: 'rgba16float', size: [WAKE_SIZE, WAKE_SIZE], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    this.wakeTex = [mk(0), mk(1)];
    this.wakeViews = [this.wakeTex[0].createView(), this.wakeTex[1].createView()];
    this.wakeParams = device.createBuffer({ label: 'ocean.wakeParams', size: this.wakeData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const C = GPUShaderStage.COMPUTE;
    const layout = device.createBindGroupLayout({
      label: 'ocean.wake',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      ],
    });
    this.wakePipe = device.createComputePipeline({
      label: 'ocean.wake',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: ctx.shaders.createModule('ocean.wake', WAKE_WGSL), entryPoint: 'wake' },
    });
    const group = (k: 0 | 1): GPUBindGroup =>
      device.createBindGroup({
        label: `ocean.wake${k}`,
        layout,
        entries: [
          { binding: 0, resource: { buffer: this.wakeParams } },
          { binding: 1, resource: this.wakeViews[1 - k]! },
          { binding: 2, resource: this.wakeViews[k] },
        ],
      });
    this.wakeGroups = [group(0), group(1)];
    this.wetness = device.createBuffer({ label: 'ocean.wetness', size: OCEAN_WETNESS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.wetness, 0, this.wetData);
  }

  /** Vessels whose hull is in or close to the water of this body, active vessel first. */
  private atWater(frame: FrameContext, t: OceanTunables, seaLevel: number, bodyId: string): { v: VesselSnapshot; dirFixed: Vec3; posFixed: Vec3; height: number; water: number }[] {
    const body = frame.snapshot.bodies.find((b) => b.id === bodyId);
    if (!body) return [];
    const out: { v: VesselSnapshot; dirFixed: Vec3; posFixed: Vec3; height: number; water: number }[] = [];
    for (const v of frame.snapshot.vessels) {
      if (v.bodyId !== bodyId) continue;
      const posFixed = quat.rotateInv(body.qFixedToRoot, v.r);
      const r = v3.len(posFixed);
      const dirFixed = v3.scale(posFixed, 1 / r);
      const water = physicsWaterHeight(t, seaLevel, dirFixed, frame.snapshot.ut);
      const height = r - t.radius - water;
      const reach = Math.max(v.boundingRadius, 0.5) * t.vesselDampingHullRadii;
      if (height > reach && v.contact.waterSubmersion <= 0 && v.situation !== 'splashed') continue;
      out.push({ v, dirFixed, posFixed, height, water });
    }
    out.sort((a, b) => (a.v.id === frame.snapshot.activeVesselId ? -1 : b.v.id === frame.snapshot.activeVesselId ? 1 : a.height - b.height));
    return out;
  }

  /**
   * Per-frame CPU work. `chart` / `ref` describe the near field (null when it is inactive: wetness is still
   * published for vessels at the water, which the mesh system applies at any distance).
   */
  update(frame: FrameContext, t: OceanTunables, seaLevel: number, bodyId: string, chart: OceanChart | null, ref: ChartReference | null): VesselFrame {
    const s = frame.snapshot;
    const dt = Math.max(0, s.ut - frame.prevSnapshot.ut);
    const list = this.atWater(frame, t, seaLevel, bodyId);
    const bodyPose = frame.bodyPose(bodyId);

    // Splash ripples, planet-fixed, from this snapshot's events.
    if (chart) {
      for (const e of s.events) {
        const isWater = e.type === 'splash' || (e.type === 'touchdown' && e.surface === 'water');
        if (!isWater) continue;
        const v = s.vessels.find((x) => x.id === e.vesselId);
        if (!v || v.bodyId !== bodyId) continue;
        const xy = chartCoords(chart, v3.normalize(quat.rotateInv(bodyPose.qFixedToRoot, v3.sub(v.rRoot, s.bodies.find((b) => b.id === bodyId)!.rRoot))));
        if (!xy) continue;
        const speed = e.speed;
        // What the shaders need of an impact, in one number: the hull's radius R0 to the centimetre, and above it
        // (in the third and fourth decimal) the strength of the impact, entry speed / 6 m/s up to 1 (request vfx-9).
        const r0 = Math.round(Math.max(v.boundingRadius, 0.5) * 100) / 100;
        this.ripples.push({ x: xy.x, y: xy.y, ut0: e.ut, amplitude: r0 + 0.0099 * Math.min(1, Math.max(0, speed / 6)) });
        const w = this.wet.get(v.id) ?? { maxLevel: -Infinity, lastSplashUt: e.ut };
        w.lastSplashUt = e.ut;
        w.maxLevel = Math.max(w.maxLevel, v.boundingRadius);
        this.wet.set(v.id, w);
      }
    }
    this.ripples = this.ripples.filter((r) => s.ut - r.ut0 < Math.max(t.rippleLifetime, t.splashFoamTime) && s.ut >= r.ut0).slice(-MAX_RIPPLES);

    // Wetness slots (camera-relative, ROOT axes).
    const wf = new Float32Array(this.wetData);
    const wu = new Uint32Array(this.wetData);
    wf.fill(0);
    let slots = 0;
    for (const w of list) {
      if (slots >= OCEAN_WETNESS_SLOTS) break;
      const v = w.v;
      const up = w.dirFixed;
      const surfFixed = v3.scale(up, t.radius + w.water);
      // Swell normal by central differences of the physics height (1 m baseline) along local east / north.
      let east = v3.cross({ x: 0, y: 0, z: 1 }, up);
      if (v3.lenSq(east) < 1e-12) east = { x: 1, y: 0, z: 0 };
      east = v3.normalize(east);
      const north = v3.cross(up, east);
      const hAt = (de: number, dn: number): number => physicsWaterHeight(t, seaLevel, v3.normalize(v3.add(up, v3.add(v3.scale(east, de / t.seaRadius), v3.scale(north, dn / t.seaRadius)))), s.ut);
      const gx = (hAt(1, 0) - hAt(-1, 0)) / 2;
      const gy = (hAt(0, 1) - hAt(0, -1)) / 2;
      const nFixed = v3.normalize(v3.sub(up, v3.add(v3.scale(east, gx), v3.scale(north, gy))));
      const pose = frame.vesselPose(v.id);
      if (!pose) continue;
      // Water level relative to the vessel origin along the local vertical (negative: origin above the water).
      const level = -w.height;
      const st = this.wet.get(v.id) ?? { maxLevel: -Infinity, lastSplashUt: Number.NaN };
      const chop = 0.05;
      st.maxLevel = Math.max(Number.isFinite(st.maxLevel) ? st.maxLevel - t.wetLineDryingRate * dt : -Infinity, level + chop);
      this.wet.set(v.id, st);
      const plane = v3.add(pose.originRelCam, quat.rotate(bodyPose.qFixedToRoot, v3.sub(surfFixed, w.posFixed)));
      const nRoot = quat.rotate(bodyPose.qFixedToRoot, nFixed);
      const o = 4 + slots * 12;
      wf.set([plane.x, plane.y, plane.z, v.boundingRadius + 2], o);
      wf.set([nRoot.x, nRoot.y, nRoot.z, Math.max(0, st.maxLevel - level)], o + 4);
      wf.set([v.contact.waterSubmersion, Number.isFinite(st.lastSplashUt) ? s.ut - st.lastSplashUt : -1, chop, t.wetLineDryingRate], o + 8);
      slots++;
    }
    wu[0] = slots;
    this.wetSlots = slots;
    for (const id of [...this.wet.keys()]) if (!s.vessels.some((v) => v.id === id)) this.wet.delete(id);
    this.ctx.device.queue.writeBuffer(this.wetness, 0, this.wetData);

    const zones: OceanVesselZone[] = [];
    const ripples: OceanRippleSource[] = [];
    const out: VesselFrame = { zones, ripples, wake: { x: 0, y: 0, extent: t.wakeExtent, valid: false }, wakeSources: [], wakeShift: [0, 0] };
    if (!chart || !ref) {
      this.wakeOrigin = null;
      return out;
    }
    for (const w of list.slice(0, MAX_VESSELS)) {
      const xy = chartCoords(chart, w.dirFixed);
      if (!xy) continue;
      const hull = Math.max(w.v.boundingRadius, 0.5);
      const reach = hull * t.vesselDampingHullRadii;
      // Fully damped at the water, fading out as an entering vessel is still higher than its damping reach.
      const strength = 1 - smooth(hull, reach, w.height);
      // The whole zone of `reach` is damped (the waterline follows the swell there); the chop returns over two more hull radii.
      zones.push({ x: xy.x - ref.x, y: xy.y - ref.y, hullRadius: reach, dampRadius: reach + 2 * hull, strength, wobble: 0.05, boundingRadius: hull, height: w.height });
    }
    for (const r of this.ripples) ripples.push({ x: r.x - ref.x, y: r.y - ref.y, age: s.ut - r.ut0, amplitude: r.amplitude });

    // Wake texture centred on the first vessel at the water (snapped to whole texels, planet-fixed).
    const lead = list[0];
    if (lead) {
      const xy = chartCoords(chart, lead.dirFixed)!;
      const texel = t.wakeExtent / WAKE_SIZE;
      const ox = Math.round(xy.x / texel);
      const oy = Math.round(xy.y / texel);
      if (this.wakeOrigin) out.wakeShift = [ox - this.wakeOrigin[0], oy - this.wakeOrigin[1]];
      else out.wakeShift = [WAKE_SIZE * 4, 0];
      this.wakeOrigin = [ox, oy];
      out.wake = { x: ox * texel - ref.x, y: oy * texel - ref.y, extent: t.wakeExtent, valid: true };
      const centre = (x: number, y: number): [number, number] => [(x - ox * texel) / texel + WAKE_SIZE / 2, (y - oy * texel) / texel + WAKE_SIZE / 2];
      for (const w of list) {
        if (out.wakeSources.length >= 15) break;
        const p = chartCoords(chart, w.dirFixed);
        if (!p) continue;
        const [cx, cy] = centre(p.x, p.y);
        const hull = Math.max(w.v.boundingRadius, 0.5) / texel;
        // A floating hull churns a ring of foam at its waterline in proportion to how much of it is wet.
        const churn = Math.min(1, w.v.contact.waterSubmersion * 2) * Math.min(1, dt * 0.6);
        if (churn > 0) out.wakeSources.push({ cx, cy, radius: hull * 1.02, ring: Math.max(1, hull * 0.12), amount: churn });
      }
      for (const e of s.events) {
        if (!(e.type === 'splash' || (e.type === 'touchdown' && e.surface === 'water'))) continue;
        const v = s.vessels.find((x) => x.id === e.vesselId);
        if (!v || out.wakeSources.length >= 16) continue;
        const p = chartCoords(chart, v3.normalize(quat.rotateInv(bodyPose.qFixedToRoot, v3.sub(v.rRoot, s.bodies.find((b) => b.id === bodyId)!.rRoot))));
        if (!p) continue;
        const [cx, cy] = centre(p.x, p.y);
        out.wakeSources.push({ cx, cy, radius: (Math.max(v.boundingRadius, 0.5) * 2.2) / texel, ring: 0, amount: t.wakeFoamPerSplash });
      }
    } else {
      this.wakeOrigin = null;
    }
    return out;
  }

  /** No ocean body near the camera: no wet slots. */
  clearWetness(): void {
    if (this.wetSlots === 0) return;
    new Uint32Array(this.wetData).fill(0);
    this.wetSlots = 0;
    this.ctx.device.queue.writeBuffer(this.wetness, 0, this.wetData);
  }

  /** Advance the wake texture (only while the near field is active and a vessel is at the water). */
  updateWake(encoder: GPUCommandEncoder, vf: VesselFrame, dt: number, timestamp: GPUComputePassTimestampWrites | undefined): void {
    if (!vf.wake.valid) return;
    const i = new Int32Array(this.wakeData, 0, 4);
    const f = new Float32Array(this.wakeData);
    i[0] = vf.wakeShift[0];
    i[1] = vf.wakeShift[1];
    i[2] = vf.wakeSources.length;
    i[3] = 0;
    // Wake foam lives longer than whitecaps: e-folding time about 25 s, slow spreading.
    f[4] = Math.exp(-dt / 25);
    f[5] = Math.min(0.2, dt * 0.6);
    f[6] = 0;
    f[7] = 0;
    vf.wakeSources.forEach((s, k) => {
      f.set([s.cx, s.cy, s.radius, s.amount], 8 + k * 4);
      f.set([s.ring, 0, 0, 0], 8 + 64 + k * 4);
    });
    this.ctx.device.queue.writeBuffer(this.wakeParams, 0, this.wakeData);
    const k = (1 - this.wakeCurrent) as 0 | 1;
    const pass = encoder.beginComputePass({ label: 'ocean.wake', timestampWrites: timestamp });
    pass.setPipeline(this.wakePipe);
    pass.setBindGroup(0, this.wakeGroups[k]);
    pass.dispatchWorkgroups(WAKE_SIZE / 8, WAKE_SIZE / 8);
    pass.end();
    this.wakeCurrent = k;
  }

  /** Ripple dispersion constants for the shaders. */
  static rippleConstants(t: OceanTunables): { k: number; lifetime: number; groupSpeed: number; omega: number } {
    const k = TWO_PI / t.rippleWavelength;
    const omega = Math.sqrt(t.gravity * k);
    return { k, lifetime: t.rippleLifetime, groupSpeed: (0.5 * omega) / k, omega };
  }

  /** Body-fixed direction of chart coordinates (for tests and tools). */
  static dirOf(chart: OceanChart, x: number, y: number): Vec3 {
    return chartDir(chart, x, y);
  }

  dispose(): void {
    for (const t of this.wakeTex) t.destroy();
    this.wakeParams.destroy();
    this.wetness.destroy();
  }
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
