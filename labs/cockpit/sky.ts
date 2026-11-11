/**
 * Lab-only sky for the cockpit lab: the cockpit has to be judged with something real outside the windows
 * and with outside light coming in, but the atmosphere-clouds and sky-lighting packages are separate render
 * packages a lab may not import. This stands in for them, physically but simply:
 *
 *  - compositeAtmosphere: single scattering (Rayleigh, Mie, ozone absorption) of the nearest body with an
 *    atmosphere along every view ray up to the scene depth: the scene is multiplied by the transmittance,
 *    then the in-scattered light is added (two passes, no dual-source blending);
 *  - drawBackground: the solar disc with limb darkening;
 *  - an environment probe ('env.probeCube' + 'env.sh9') evaluated on the CPU at the active vessel from the
 *    same model (sky, lit ground of the body's mean colour, the night side black), refreshed when the vessel
 *    or the sun has moved.
 * Never used by the app.
 */
import type { AtmosphereRenderDef, DefLibrary } from '@/core/contracts/defs';
import { RENDER_FORMATS, type FrameContext, type RenderContext, type RenderFeature } from '@/core/contracts/render';
import { v3, type Vec3 } from '@/core/math';
import { coreOf, createSceneBindings, f32ToF16, type SceneBindings, type Tracked } from '@/render/core';
import { loadCockpitLayout } from '@/render/cockpit/layout';

const COMPOSITE_FS = (bindings: string): string => /* wgsl */ `
#include "noise"
${bindings}
fn hitSphere(o: vec3f, d: vec3f, c: vec3f, r: f32) -> vec2f {
  let oc = o - c;
  let b = dot(oc, d);
  let h = b * b - (dot(oc, oc) - r * r);
  if (h < 0.0) { return vec2f(-1.0, -1.0); }
  let s = sqrt(h);
  return vec2f(-b - s, -b + s);
}
struct Out { @location(0) c: vec4f }
fn march(uv: vec2f, depth: f32) -> array<vec3f, 2> {
  var res: array<vec3f, 2>;
  res[0] = vec3f(1.0);
  res[1] = vec3f(0.0);
  let d = normalize(viewRay(uv));
  var tScene = 3.0e9;
  if (depth > 0.0) { tScene = length(positionFromDepth(uv, depth)); }
  for (var i = 0u; i < frame.counts.x; i++) {
    if ((bodyFlags(i) & BODY_FLAG_ATMOSPHERE) == 0u) { continue; }
    let b = frame.bodies[i];
    let R = b.center.w;
    let Rt = b.prevCenter.w;
    let shell = hitSphere(vec3f(0.0), d, b.center.xyz, Rt);
    if (shell.y <= 0.0) { continue; }
    let ground = hitSphere(vec3f(0.0), d, b.center.xyz, R);
    var t0 = max(shell.x, 0.0);
    var t1 = shell.y;
    if (ground.x > 0.0) { t1 = min(t1, ground.x); }
    t1 = min(t1, tScene);
    if (t1 <= t0) { continue; }
    let sunDir = b.sunDir.xyz;
    let mu = dot(d, sunDir);
    let g = b.mie.w;
    let pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
    let pM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
    let N = 28u;
    var tau = vec3f(0.0);
    var L = vec3f(0.0);
    // Samples spaced quadratically: dense near the eye, where the cockpit and the ground are.
    var tPrev = t0;
    for (var k = 0u; k < N; k++) {
      let f = (f32(k) + 0.5) / f32(N);
      let t = t0 + (t1 - t0) * f * f;
      let tNext = t0 + (t1 - t0) * ((f32(k) + 1.0) / f32(N)) * ((f32(k) + 1.0) / f32(N));
      let ds = tNext - tPrev;
      tPrev = tNext;
      let p = d * t - b.center.xyz;
      let r = length(p);
      let h = max(r - R, 0.0);
      let rhoR = exp(-h / b.rayleigh.w);
      let rhoM = exp(-h / b.mie.z);
      let rhoO = max(0.0, 1.0 - abs(h - b.ozone.w) / b.misc.x);
      let ext = b.rayleigh.rgb * rhoR + vec3f(b.mie.x + b.mie.y) * rhoM + b.ozone.rgb * rhoO;
      // Sun transmittance from the sample: 6-step march to the top, zero in the planet's shadow.
      var tSun = vec3f(1.0);
      let up = p / r;
      let sh = hitSphere(p, sunDir, vec3f(0.0), R);
      if (sh.x > 0.0) { tSun = vec3f(0.0); } else {
        let st = hitSphere(p, sunDir, vec3f(0.0), Rt).y;
        var od = vec3f(0.0);
        for (var j = 0u; j < 6u; j++) {
          let q = p + sunDir * (st * (f32(j) + 0.5) / 6.0);
          let hq = max(length(q) - R, 0.0);
          od += (b.rayleigh.rgb * exp(-hq / b.rayleigh.w) + vec3f(b.mie.x + b.mie.y) * exp(-hq / b.mie.z) + b.ozone.rgb * max(0.0, 1.0 - abs(hq - b.ozone.w) / b.misc.x)) * (st / 6.0);
        }
        tSun = exp(-od);
        _ = up;
      }
      let scat = b.rayleigh.rgb * rhoR * pR + vec3f(b.mie.x) * rhoM * pM;
      L += exp(-tau - ext * ds * 0.5) * scat * tSun * ds;
      tau += ext * ds;
    }
    res[0] = res[0] * exp(-tau);
    res[1] = res[1] + L * frame.sunIlluminance.rgb;
  }
  return res;
}
@fragment fn fsMul(in: FullscreenOut) -> Out {
  let depth = textureLoad(sceneDepthTex, vec2i(in.position.xy), 0);
  // The cabin around the eye is not in the haze (and keeps its own light): skip the first metres.
  if (depth > 0.0 && length(positionFromDepth(in.uv, depth)) < 30.0) { return Out(vec4f(1.0)); }
  let r = march(in.uv, depth);
  return Out(vec4f(r[0], 1.0));
}
struct LabPlasma { v: vec4f }   // rgb = shock-layer radiance (cd/m^2), w = intensity
@group(2) @binding(0) var<uniform> plasma: LabPlasma;
@fragment fn fsAdd(in: FullscreenOut) -> Out {
  let depth = textureLoad(sceneDepthTex, vec2i(in.position.xy), 0);
  if (depth > 0.0 && length(positionFromDepth(in.uv, depth)) < 30.0) { return Out(vec4f(0.0)); }
  let r = march(in.uv, depth);
  // Stand-in for the vfx shock layer seen through the windows during entry (the lab has no vfx feature): a
  // lavender-pink sheath at the cockpit layout's window plasma luminance, crossed by fine streaks.
  var glow = vec3f(0.0);
  if (plasma.v.w > 0.0) {
    let d = normalize(viewRay(in.uv));
    let field = valueNoise3(vec3f(d * 3.0 + vec3f(0.0, frame.time.x * 0.8, 0.0)), 7);
    let streak = pow(valueNoise3(vec3f(d.x * 160.0, d.y * 6.0 - frame.time.x * 9.0, d.z * 160.0), 8), 4.0);
    glow = plasma.v.rgb * (0.55 + 0.6 * field + 1.4 * streak);
  }
  return Out(vec4f(writeHdr((r[1] + glow) * frame.exposure.x), 0.0));
}
`;

const SUN_FS = /* wgsl */ `
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let d = normalize(viewRay(in.uv));
  let c = dot(d, frame.sunDir.xyz);
  let ang = acos(clamp(c, -1.0, 1.0));
  let rs = frame.sunDir.w;
  if (ang > rs || frame.misc.y <= 0.0) { return vec4f(0.0); }
  let mu = sqrt(max(0.0, 1.0 - sq(ang / rs)));
  let limb = vec3f(1.0) - vec3f(0.397, 0.503, 0.652) * (1.0 - mu);
  let L = frame.sunIlluminance.rgb / (PI * rs * rs) * limb * frame.misc.y;
  return vec4f(writeHdr(L * frame.exposure.x), 0.0);
}
`;

interface Atmo {
  R: number;
  Rt: number;
  def: AtmosphereRenderDef;
}

function hit(o: Vec3, d: Vec3, r: number): [number, number] | null {
  const b = v3.dot(o, d);
  const h = b * b - (v3.dot(o, o) - r * r);
  if (h < 0) return null;
  const s = Math.sqrt(h);
  return [-b - s, -b + s];
}

/** Radiance (cd/m^2, rgb) arriving at point p (relative to the body centre) from direction d. */
export function skyRadiance(p: Vec3, d: Vec3, sun: Vec3, sunE: [number, number, number], atmo: Atmo | null, R: number, ground: [number, number, number]): [number, number, number] {
  const g = hit(p, d, R);
  let T: [number, number, number] = [1, 1, 1];
  const L: [number, number, number] = [0, 0, 0];
  if (atmo) {
    const a = atmo.def;
    const sh = hit(p, d, atmo.Rt);
    if (sh && sh[1] > 0) {
      const t0 = Math.max(0, sh[0]);
      let t1 = sh[1];
      if (g && g[0] > 0) t1 = Math.min(t1, g[0]);
      const mu = v3.dot(d, sun);
      const pR = (3 / (16 * Math.PI)) * (1 + mu * mu);
      const gg = a.miePhaseG;
      const pM = ((3 / (8 * Math.PI)) * ((1 - gg * gg) * (1 + mu * mu))) / ((2 + gg * gg) * Math.max(1 + gg * gg - 2 * gg * mu, 1e-4) ** 1.5);
      const N = 16;
      const tau = [0, 0, 0];
      for (let k = 0; k < N; k++) {
        const ds = (t1 - t0) / N;
        const q = v3.addScaled(p, d, t0 + (k + 0.5) * ds);
        const h = Math.max(0, v3.len(q) - atmo.R);
        const rR = Math.exp(-h / a.rayleighScaleHeight);
        const rM = Math.exp(-h / a.mieScaleHeight);
        const rO = Math.max(0, 1 - Math.abs(h - a.ozoneCenterAltitude) / a.ozoneHalfWidth);
        let tsun = [1, 1, 1];
        const gs = hit(q, sun, atmo.R);
        if (gs && gs[0] > 0) tsun = [0, 0, 0];
        else {
          const st = hit(q, sun, atmo.Rt)![1];
          const od = [0, 0, 0];
          for (let j = 0; j < 4; j++) {
            const hq = Math.max(0, v3.len(v3.addScaled(q, sun, (st * (j + 0.5)) / 4)) - atmo.R);
            for (let c = 0; c < 3; c++) od[c]! += (a.rayleighScattering[c]! * Math.exp(-hq / a.rayleighScaleHeight) + (a.mieScattering + a.mieAbsorption) * Math.exp(-hq / a.mieScaleHeight) + a.ozoneAbsorption[c]! * Math.max(0, 1 - Math.abs(hq - a.ozoneCenterAltitude) / a.ozoneHalfWidth)) * (st / 4);
          }
          tsun = od.map((x) => Math.exp(-x));
        }
        for (let c = 0; c < 3; c++) {
          const ext = a.rayleighScattering[c]! * rR + (a.mieScattering + a.mieAbsorption) * rM + a.ozoneAbsorption[c]! * rO;
          const sc = a.rayleighScattering[c]! * rR * pR + a.mieScattering * rM * pM;
          L[c]! += Math.exp(-tau[c]! - ext * ds * 0.5) * sc * tsun[c]! * ds * sunE[c]!;
          tau[c]! += ext * ds;
        }
      }
      T = [Math.exp(-tau[0]!), Math.exp(-tau[1]!), Math.exp(-tau[2]!)];
    }
  }
  if (g && g[0] > 0) {
    const q = v3.addScaled(p, d, g[0]);
    const n = v3.normalize(q);
    const cos = Math.max(0, v3.dot(n, sun));
    // Sun at the ground through the atmosphere (straight-down transmittance as a stand-in), plus a sky term.
    const tg = atmo ? Math.exp(-(atmo.def.rayleighScattering[1] * atmo.def.rayleighScaleHeight + atmo.def.mieScattering * atmo.def.mieScaleHeight) / Math.max(cos, 0.1)) : 1;
    const skyE = atmo ? 0.12 * Math.max(0, v3.dot(n, sun) + 0.15) : 0;
    for (let c = 0; c < 3; c++) L[c]! += T[c]! * ground[c]! * sunE[c]! * (cos * tg + skyE) / Math.PI;
  }
  return L;
}

/** Real SH9 irradiance coefficients (cosine lobe convolved) of a cube of radiance samples. */
function sh9(samples: { d: Vec3; L: [number, number, number]; w: number }[]): Float32Array {
  const c = new Float32Array(36);
  const A = [Math.PI, (2 * Math.PI) / 3, (2 * Math.PI) / 3, (2 * Math.PI) / 3, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4];
  for (const s of samples) {
    const { x, y, z } = s.d;
    const Y = [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
    for (let i = 0; i < 9; i++) for (let k = 0; k < 3; k++) c[i * 4 + k]! += Y[i]! * s.L[k]! * s.w * A[i]!;
  }
  return c;
}

/** WebGPU cube face order: +X, -X, +Y, -Y, +Z, -Z; direction of texel (u, v) in [-1, 1]. */
function cubeDir(face: number, u: number, v: number): Vec3 {
  switch (face) {
    case 0:
      return v3.normalize({ x: 1, y: -v, z: -u });
    case 1:
      return v3.normalize({ x: -1, y: -v, z: u });
    case 2:
      return v3.normalize({ x: u, y: 1, z: v });
    case 3:
      return v3.normalize({ x: u, y: -1, z: -v });
    case 4:
      return v3.normalize({ x: u, y: -v, z: 1 });
    default:
      return v3.normalize({ x: -u, y: -v, z: -1 });
  }
}

export function createLabSkyFeature(defs: DefLibrary): RenderFeature & { refreshProbe(): void } {
  // The window plasma of the cockpit layout (luminance at full intensity, colour) for the stand-in glow.
  const cockpitId = Object.values(defs.vehicles).find((x) => x.cockpit)?.cockpit;
  const lighting = cockpitId ? loadCockpitLayout(defs, cockpitId).layout.lighting : null;
  const plasmaL = lighting?.plasmaLuminance ?? 0;
  const plasmaC = lighting?.plasmaColor ?? [1, 1, 1];
  let ctx: RenderContext;
  let mul: Tracked<GPURenderPipeline>;
  let add: Tracked<GPURenderPipeline>;
  let sun: Tracked<GPURenderPipeline>;
  let layout: GPUBindGroupLayout;
  let plasmaLayout: GPUBindGroupLayout;
  let plasmaGroup: GPUBindGroup;
  let plasmaBuf: GPUBuffer;
  let bindings: SceneBindings;
  let group: GPUBindGroup | null = null;
  let version = -1;
  let cube: GPUTexture;
  let sh: GPUBuffer;
  const SIZE = 16;
  let lastKey = '';
  let force = true;

  const updateProbe = (frame: FrameContext): void => {
    const s = frame.snapshot;
    const vessel = s.vessels.find((v) => v.id === s.activeVesselId);
    if (!vessel) return;
    const body = s.bodies.find((b) => b.id === vessel.bodyId)!;
    const def = defs.bodies[body.id]!;
    const sunDir = frame.sun.dirRoot;
    const key = `${body.id}|${(vessel.rRoot.x / 2000) | 0}|${(vessel.rRoot.y / 2000) | 0}|${(vessel.rRoot.z / 2000) | 0}|${sunDir.x.toFixed(3)}|${sunDir.y.toFixed(3)}|${sunDir.z.toFixed(3)}`;
    if (key === lastKey && !force) return;
    lastKey = key;
    force = false;
    const p = v3.sub(vessel.rRoot, body.rRoot);
    const atmoDef = def.render.atmosphere;
    const atmo = atmoDef ? { R: def.radius, Rt: def.radius + atmoDef.topAltitude, def: atmoDef } : null;
    const E = frame.sun.illuminance;
    const sunE: [number, number, number] = [E * frame.sun.color[0], E * frame.sun.color[1], E * frame.sun.color[2]];
    const ground: [number, number, number] = [def.render.meanColor[0], def.render.meanColor[1], def.render.meanColor[2]];
    const samples: { d: Vec3; L: [number, number, number]; w: number }[] = [];
    const levels: Uint16Array[] = [];
    let size = SIZE;
    const base = new Float32Array(SIZE * SIZE * 6 * 4);
    for (let f = 0; f < 6; f++) {
      for (let j = 0; j < SIZE; j++) {
        for (let i = 0; i < SIZE; i++) {
          const u = ((i + 0.5) / SIZE) * 2 - 1;
          const v = ((j + 0.5) / SIZE) * 2 - 1;
          const d = cubeDir(f, u, v);
          const L = skyRadiance(p, d, sunDir, sunE, atmo, def.radius, ground);
          const w = 4 / (SIZE * SIZE) / (1 + u * u + v * v) ** 1.5;
          samples.push({ d, L, w });
          base.set([L[0], L[1], L[2], 1], ((f * SIZE + j) * SIZE + i) * 4);
        }
      }
    }
    // Mips by box filtering (a lab probe: no GGX prefilter).
    let cur = base;
    for (;;) {
      const h = new Uint16Array(cur.length);
      for (let k = 0; k < cur.length; k++) h[k] = f32ToF16(cur[k]!);
      levels.push(h);
      if (size === 1) break;
      const ns = size >> 1;
      const next = new Float32Array(ns * ns * 6 * 4);
      for (let f = 0; f < 6; f++) for (let j = 0; j < ns; j++) for (let i = 0; i < ns; i++) for (let c = 0; c < 4; c++) {
        let s2 = 0;
        for (const [dj, di] of [[0, 0], [0, 1], [1, 0], [1, 1]]) s2 += cur[((f * size + 2 * j + dj!) * size + 2 * i + di!) * 4 + c]!;
        next[((f * ns + j) * ns + i) * 4 + c] = s2 / 4;
      }
      cur = next;
      size = ns;
    }
    levels.forEach((data, mip) => {
      const s2 = SIZE >> mip;
      for (let f = 0; f < 6; f++) {
        ctx.device.queue.writeTexture({ texture: cube, mipLevel: mip, origin: [0, 0, f] }, data.subarray(f * s2 * s2 * 4, (f + 1) * s2 * s2 * 4), { bytesPerRow: s2 * 8, rowsPerImage: s2 }, [s2, s2, 1]);
      }
    });
    ctx.device.queue.writeBuffer(sh, 0, sh9(samples));
  };

  return {
    id: 'lab-sky',
    order: -50,
    refreshProbe() {
      force = true;
    },
    init(c) {
      ctx = c;
      const core = coreOf(c);
      bindings = createSceneBindings(c, 1, 0, ['sceneDepth']);
      layout = c.device.createBindGroupLayout({ label: 'labSky', entries: bindings.layoutEntries });
      plasmaLayout = c.device.createBindGroupLayout({ label: 'labSky.plasma', entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      plasmaBuf = c.device.createBuffer({ label: 'labSky.plasma', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      plasmaGroup = c.device.createBindGroup({ label: 'labSky.plasma', layout: plasmaLayout, entries: [{ binding: 0, resource: { buffer: plasmaBuf } }] });
      const fs = COMPOSITE_FS(bindings.wgsl);
      mul = core.fullscreenPipeline({ label: 'labSky.mul', fragment: fs.replace('fn fsMul', 'fn fs').replace('fn fsAdd', 'fn fsAddUnused'), layouts: [layout, plasmaLayout], targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'zero', dstFactor: 'src', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }] });
      add = core.fullscreenPipeline({ label: 'labSky.add', fragment: fs.replace('fn fsAdd', 'fn fs').replace('fn fsMul', 'fn fsMulUnused'), layouts: [layout, plasmaLayout], targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }] });
      sun = core.fullscreenPipeline({ label: 'labSky.sun', fragment: SUN_FS, targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }], depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'equal' } });
      cube = core.createTextureChecked({ label: 'labSky.probe', format: 'rgba16float', size: [SIZE, SIZE, 6], mipLevelCount: Math.log2(SIZE) + 1, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      sh = c.device.createBuffer({ label: 'labSky.sh9', size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      c.resources.publish('env.probeCube', cube.createView({ dimension: 'cube' }));
      c.resources.publish('env.sh9', sh);
    },
    prepare(frame) {
      updateProbe(frame);
      const v = frame.snapshot.vessels.find((x) => x.id === frame.snapshot.activeVesselId);
      const k = Math.max(0, v?.aero.plasmaIntensity ?? 0);
      const L = plasmaL * k ** 1.5;
      ctx.device.queue.writeBuffer(plasmaBuf, 0, new Float32Array([L * plasmaC[0]!, L * plasmaC[1]!, L * plasmaC[2]!, k]));
    },
    drawBackground(_frame, pass) {
      pass.setPipeline(sun.get());
      pass.draw(3);
    },
    compositeAtmosphere(_frame, encoder, hdr) {
      if (!group || bindings.version() !== version) {
        version = bindings.version();
        group = ctx.device.createBindGroup({ label: 'labSky', layout, entries: bindings.entries() });
      }
      for (const [pipe, name] of [[mul, 'lab-sky.mul'], [add, 'lab-sky.add']] as const) {
        const pass = encoder.beginRenderPass({ label: name, colorAttachments: [{ view: hdr, loadOp: 'load', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass(name) as GPURenderPassTimestampWrites | undefined });
        pass.setBindGroup(0, _frame.frameBindGroup);
        pass.setPipeline(pipe.get());
        pass.setBindGroup(1, group);
        pass.setBindGroup(2, plasmaGroup);
        pass.draw(3);
        pass.end();
      }
    },
  };
}
