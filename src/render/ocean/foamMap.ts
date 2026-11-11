/**
 * The foam map: whitecaps of the COMBINED surface, with their history, in camera-centred windows fixed to the sea.
 *
 * Where waves break is decided by all scales together: a steep crest of the dominant wind sea (the long-wave
 * layer) carrying a crest of the 3-25 m chop. Per texel of each level the pass forms the breaking criterion
 *   c = [ wL x conv(long layer) + w0 x conv(cascade 0) + w1 x conv(cascade 1, low-passed to about 2 m) ] + fine part
 * (conv = -div D, the horizontal convergence of a layer in units of its own standard deviation; the fine part,
 * the rest of cascade 1 at a small weight, only makes the edges ragged), normalised to unit variance.
 * Because the smooth part is long-crested and band-limited, its rare excursions above the threshold are bars along
 * the dominant crests a few metres long, not the round specks that the excursions of the short chop alone are.
 *   active   = max(active x e^(-dt / tauA), ramp(c - threshold))     the breaker itself: thick, bright
 *   residual = max(residual x e^(-dt / tauR), active)                 what it leaves behind: thins out into lace
 * The texels are LAGRANGIAN plane coordinates (the surface pass samples with its undisplaced position), so the
 * crest moves through them at its phase speed and the foam it sheds stays on the water and rides the orbital motion.
 *
 * Three levels of FOAM_SIZE^2 texels, 0.25 m, 1 m and 4 m per texel (windows of 128 m, 512 m and 2 km around the
 * camera's nadir), each snapped to its own texel grid in chart coordinates, so the content is fixed to the planet
 * and a moving camera only scrolls it. A texel that scrolls in (or a level that starts: a descending camera) has no
 * history: it takes what the breakers of the last 2.4 s would have left there, looking downwind for the
 * crests that passed over it (FOAM_CREST_SPEED), so a whitecap seen right after a level starts already trails its
 * foam upwind of the crest. A level no pixel can resolve is not updated.
 */
import type { RenderContext } from '@/core/contracts/render';
import { coreOf } from '@/render/core';
import type { OceanCascadeSet } from './cascades';
import type { OceanTunables } from './params';
import { FFT_SIZE, type CascadeSpectrum } from './spectrum';

export const FOAM_LEVELS = 3;
export const FOAM_SIZE = 512;
/** Texel of level 0 (m) and the ratio between levels. */
export const FOAM_TEXEL = 0.25;
export const FOAM_RATIO = 4;
/** Weights of the long-wave layer, cascade 0 and the low-passed cascade 1 in the smooth criterion; of the fine part. */
export const FOAM_WEIGHTS = { long: 0.8, c0: 1.0, c1: 0.9, fine: 0.45 } as const;
/** Width of the low-pass of cascade 1 in the smooth criterion, m. */
export const FOAM_LOWPASS = 2.2;
/** A level is updated while the sharpest pixel of the frame is no larger than this many of its texels. */
export const FOAM_LEVEL_REACH = 2.5;
/**
 * Speed (m/s) at which breaking crests travel downwind: the phase speed of the 5-25 m waves that carry the breaking
 * criterion (sqrt(g lambda / 2 pi) = 2.8-6.2 m/s), used where a texel has no history of its own.
 */
export const FOAM_CREST_SPEED = 4.5;

export const foamTexel = (level: number): number => FOAM_TEXEL * FOAM_RATIO ** level;

export interface FoamLevelFrame {
  /** Plane offset of the centre of texel (0, 0) from the reference point, m. */
  x: number;
  y: number;
  texel: number;
  /** The level holds foam this frame. */
  valid: boolean;
}

export const FOAM_MAP_WGSL = /* wgsl */ `
#include "frame"
struct FoamParams {
  rates: vec4f,     // x = factor on active foam over this frame, y = on residual foam, z = threshold, w = ramp (criterion sigmas)
  weights: vec4f,   // long-wave layer, cascade 0, cascade 1 low-passed, fine part
  misc: vec4f,      // x = mip of cascade 1's low-pass, y = 0, z = threshold drop of the old-foam proxy, w = its density
  sigma: vec4f,     // 1 / standard deviation of the criterion at levels 0..2
  trail: vec4f,     // xy = velocity of the breaking crests (plane axes, m/s), z = decay rate of active foam, w = of residual foam (1/s)
  levels: array<vec4f, ${FOAM_LEVELS}>,   // xy = plane offset of texel (0, 0)'s centre from the reference point (m), z = texel (m), w = 0 no update / 1 new history / 2 with history
  shifts: array<vec4i, ${FOAM_LEVELS}>,   // xy = texels the window moved since the level's previous update
}
@group(1) @binding(0) var<uniform> oceanU: OceanUniforms;
@group(1) @binding(1) var<uniform> fm: FoamParams;
@group(1) @binding(2) var oceanDeriv: texture_2d_array<f32>;
@group(1) @binding(3) var foamPrev: texture_2d_array<f32>;
@group(1) @binding(4) var foamOut: texture_storage_2d_array<rgba16float, write>;
// Declared for the shared chunk; this pass does not read them.
@group(1) @binding(5) var oceanDisp: texture_2d_array<f32>;
@group(1) @binding(6) var oceanDispPrev: texture_2d_array<f32>;
#include "ocean_waves"

/// Convergence -div D of wave layer c at texture coordinate uv and mip lod, in units of its standard deviation.
fn foamConv(c: u32, uv: vec2f, lod: f32, sigma: f32) -> f32 {
  let d = textureSampleLevel(oceanDeriv, linearRepeat, uv, c, lod);
  return -(d.z + d.w) / max(sigma, 1e-6);
}

/// The breaking criterion (criterion sigmas) at plane point p, for a level of texel 'texel' and index 'level'.
fn foamCriterion(p: vec2f, texel: f32, level: u32) -> f32 {
  let lam = oceanU.wind.w;
  // No chop, no breaking: around a vessel the criterion fades with the chop (the waterline follows the swell).
  let amp = oceanAmplitudes(p, 1e4);
  var c = 0.0;
  // The long-wave layer, as the surface pass shades it: two copies rotated apart, half the variance each.
  if (oceanLayerOn(OCEAN_LONG_LAYER) > 0.0) {
    let lw = oceanU.long;
    let sg = lam * sqrt(lw.stats.x);
    for (var k = 0u; k < 2u; k++) {
      let cr = select(oceanU.longRot.xy, oceanU.longRot.zw, k == 1u);
      let rot = mat2x2f(cr.x, cr.y, -cr.y, cr.x);
      let uvl = select(oceanU.longOrigin.xy, oceanU.longOrigin.zw, k == 1u) + (rot * p) * lw.geom.y;
      c += 0.70710678 * fm.weights.x * foamConv(OCEAN_LONG_LAYER, uvl, 0.0, sg);
    }
  }
  let s0 = lam * sqrt(oceanU.cascades[0].stats.x);
  let s1 = lam * sqrt(oceanU.cascades[1].stats.x);
  c += fm.weights.y * amp[0] * foamConv(0u, oceanCascadeUv(0u, p), 0.0, s0);
  let uv1 = oceanCascadeUv(1u, p);
  let low1 = foamConv(1u, uv1, fm.misc.x, s1);
  c += fm.weights.z * amp[1] * low1;
  // Fine part: what the low-pass took from cascade 1, as this level's texel resolves it. (Not cascade 2: its 72.5 m
  // patch would make the thin foam at the edges of every breaker repeat at that period.)
  let lod1 = max(log2(texel * ${FFT_SIZE}.0 * oceanU.cascades[1].geom.y), 0.0);
  c += fm.weights.w * amp[1] * (foamConv(1u, uv1, min(lod1, fm.misc.x), s1) - low1);
  return c * fm.sigma[level] * amp[0];
}

// A texel without history looks for the breaker that passed over it at these ages: every FOAM_TRAIL_STEP s up to
// FOAM_TRAIL_STEPS steps (closer than a breaker is wide, so the trail is a continuous streak, not a string of beads).
const FOAM_TRAIL_STEP = 0.2;
const FOAM_TRAIL_STEPS = 12u;

@compute @workgroup_size(8, 8, 1)
fn foam(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${FOAM_SIZE}u || id.y >= ${FOAM_SIZE}u || id.z >= ${FOAM_LEVELS}u) { return; }
  let lv = fm.levels[id.z];
  if (lv.w < 0.5) { return; }
  let p = lv.xy + vec2f(id.xy) * lv.z;
  let c = foamCriterion(p, lv.z, id.z);
  let fresh = saturate((c - fm.rates.z) / fm.rates.w);
  let src = vec2i(id.xy) + fm.shifts[id.z].xy;
  var breaker = fresh;
  var left = fresh;
  if (lv.w > 1.5 && all(src >= vec2i(0)) && all(src < vec2i(${FOAM_SIZE}))) {
    let prev = textureLoad(foamPrev, src, id.z, 0);
    breaker = max(prev.r * fm.rates.x, fresh);
    left = max(prev.g * fm.rates.y, breaker);
  } else {
    // Without a history (a level starting, a texel scrolling in): what the breakers of the last few seconds would
    // have left here. A crest that breaks now at p + v t passed over p t seconds ago (as it is now: the shape of a
    // breaking crest changes more slowly than it travels), so foam trails behind every breaker, and around it lies
    // the old foam such breakers leave on average.
    left = max(fresh, fm.misc.w * saturate((c - (fm.rates.z - fm.misc.z)) / fm.rates.w));
    for (var k = 1u; k <= FOAM_TRAIL_STEPS; k++) {
      let age = FOAM_TRAIL_STEP * f32(k);
      let was = saturate((foamCriterion(p + fm.trail.xy * age, lv.z, id.z) - fm.rates.z) / fm.rates.w);
      breaker = max(breaker, was * exp(-fm.trail.z * age));
      left = max(left, was * exp(-fm.trail.w * age));
    }
  }
  textureStore(foamOut, vec2i(id.xy), id.z, vec4f(breaker, left, c, 1.0));
}
`;

/** Filtered fraction of a layer's slope (and convergence) variance at a fractional mip level. */
function filtered(sp: CascadeSpectrum, lod: number): number {
  const l = Math.min(Math.max(lod, 0), sp.filteredSlopeFraction.length - 1);
  const i = Math.floor(l);
  const a = sp.filteredSlopeFraction[i] ?? 0;
  const b = sp.filteredSlopeFraction[i + 1] ?? 0;
  return a + (b - a) * (l - i);
}

export class OceanFoamMap {
  readonly views: [GPUTextureView, GPUTextureView];
  /** Index of the texture written by the latest update (the one to sample). */
  current = 0;
  private readonly tex: [GPUTexture, GPUTexture];
  private readonly params: GPUBuffer;
  private readonly data = new ArrayBuffer(80 + FOAM_LEVELS * 32);
  private readonly pipe: GPUComputePipeline;
  private readonly groups: [GPUBindGroup, GPUBindGroup];
  /** Per level: integer texel index of texel (0, 0) in chart coordinates at its last update, or null without content. */
  private readonly origin: ([number, number] | null)[] = Array.from({ length: FOAM_LEVELS }, () => null);
  private chartKey: object | null = null;
  private pending = false;
  private readonly lowLod: number;
  private readonly sigma: number[];

  constructor(
    private readonly ctx: RenderContext,
    cascades: OceanCascadeSet,
    private readonly tunables: OceanTunables,
    uniformBuffer: GPUBuffer,
    derivView: GPUTextureView,
  ) {
    const device = ctx.device;
    const core = coreOf(ctx);
    const mk = (k: number): GPUTexture =>
      core.createTextureChecked({ label: `ocean.foamMap${k}`, format: 'rgba16float', size: [FOAM_SIZE, FOAM_SIZE, FOAM_LEVELS], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    this.tex = [mk(0), mk(1)];
    this.views = [this.tex[0].createView({ dimension: '2d-array' }), this.tex[1].createView({ dimension: '2d-array' })];
    this.params = device.createBuffer({ label: 'ocean.foamParams', size: this.data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const C = GPUShaderStage.COMPUTE;
    const layout = device.createBindGroupLayout({
      label: 'ocean.foamMap',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'uniform' } },
        { binding: 2, visibility: C, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 3, visibility: C, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
        { binding: 4, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } },
      ],
    });
    this.pipe = device.createComputePipeline({
      label: 'ocean.foamMap',
      layout: device.createPipelineLayout({ bindGroupLayouts: [ctx.frameBindGroupLayout, layout] }),
      compute: { module: ctx.shaders.createModule('ocean.foamMap', FOAM_MAP_WGSL), entryPoint: 'foam' },
    });
    const group = (k: 0 | 1): GPUBindGroup =>
      device.createBindGroup({
        label: `ocean.foamMap${k}`,
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: this.params } },
          { binding: 2, resource: derivView },
          { binding: 3, resource: this.views[1 - k]! },
          { binding: 4, resource: this.views[k] },
        ],
      });
    this.groups = [group(0), group(1)];

    // Standard deviation of the criterion per level, from the layers' filtered variances.
    const c1 = cascades.spectra[1]!;
    this.lowLod = Math.max(0, Math.log2((FOAM_LOWPASS * FFT_SIZE) / c1.band.length));
    const W = FOAM_WEIGHTS;
    const low = filtered(c1, this.lowLod);
    this.sigma = Array.from({ length: FOAM_LEVELS }, (_, l) => {
      const t = foamTexel(l);
      const f1 = filtered(c1, Math.min(Math.max(0, Math.log2((t * FFT_SIZE) / c1.band.length)), this.lowLod));
      return Math.sqrt(W.long ** 2 + W.c0 ** 2 + W.c1 ** 2 * low + W.fine ** 2 * Math.max(0, f1 - low));
    });
  }

  /** Nothing is kept: the next update starts every level anew. */
  reset(): void {
    this.origin.fill(null);
  }

  /**
   * Prepare this frame's update. `refX` / `refY`: chart coordinates of the reference point (float64);
   * `chart`: identity of the chart they are in (a new chart starts a new history); `footprint`: the sharpest
   * pixel footprint on the sea this frame (m); `dt`: sim seconds since the previous frame. Returns what the
   * surface pass needs to sample each level.
   */
  prepare(refX: number, refY: number, chart: object, footprint: number, dt: number): FoamLevelFrame[] {
    if (chart !== this.chartKey) {
      this.chartKey = chart;
      this.reset();
    }
    const t = this.tunables;
    const f = new Float32Array(this.data);
    const i = new Int32Array(this.data);
    f.set([Math.exp(-t.foamDecay * dt), Math.exp(-t.foamResidualDecay * dt), t.foamSigma, t.foamRampSigma], 0);
    f.set([FOAM_WEIGHTS.long, FOAM_WEIGHTS.c0, FOAM_WEIGHTS.c1, FOAM_WEIGHTS.fine], 4);
    f.set([this.lowLod, 0, t.foamOldDrop, t.foamOldDensity], 8);
    f.set([1 / this.sigma[0]!, 1 / this.sigma[1]!, 1 / this.sigma[2]!, 0], 12);
    // Breaking crests travel downwind at about the phase speed of the waves that carry the criterion.
    f.set([Math.sin(t.windDir) * FOAM_CREST_SPEED, Math.cos(t.windDir) * FOAM_CREST_SPEED, t.foamDecay, t.foamResidualDecay], 16);
    const out: FoamLevelFrame[] = [];
    let any = false;
    for (let l = 0; l < FOAM_LEVELS; l++) {
      const texel = foamTexel(l);
      const ix = Math.floor(refX / texel) - FOAM_SIZE / 2;
      const iy = Math.floor(refY / texel) - FOAM_SIZE / 2;
      const x = (ix + 0.5) * texel - refX;
      const y = (iy + 0.5) * texel - refY;
      const on = footprint <= FOAM_LEVEL_REACH * texel;
      const prev = this.origin[l]!;
      let mode = 0;
      let sx = 0;
      let sy = 0;
      if (on) {
        mode = 1;
        if (prev) {
          sx = ix - prev[0];
          sy = iy - prev[1];
          if (Math.abs(sx) < FOAM_SIZE && Math.abs(sy) < FOAM_SIZE) mode = 2;
        }
        this.origin[l] = [ix, iy];
        any = true;
      } else {
        this.origin[l] = null;
      }
      f.set([x, y, texel, mode], 20 + l * 4);
      i.set([sx, sy, 0, 0], 20 + FOAM_LEVELS * 4 + l * 4);
      out.push({ x, y, texel, valid: on });
    }
    this.ctx.device.queue.writeBuffer(this.params, 0, this.data);
    this.pending = any;
    return out;
  }

  /** Record the update prepared for this frame (after the FFT: it reads this frame's derivatives). */
  update(encoder: GPUCommandEncoder, frameBindGroup: GPUBindGroup, timestamp: GPUComputePassTimestampWrites | undefined): void {
    if (!this.pending) return;
    this.pending = false;
    const k = (1 - this.current) as 0 | 1;
    const pass = encoder.beginComputePass({ label: 'ocean.foam', timestampWrites: timestamp });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, frameBindGroup);
    pass.setBindGroup(1, this.groups[k]);
    pass.dispatchWorkgroups(FOAM_SIZE / 8, FOAM_SIZE / 8, FOAM_LEVELS);
    pass.end();
    this.current = k;
  }

  dispose(): void {
    for (const t of this.tex) t.destroy();
    this.params.destroy();
  }
}
