/**
 * Lab-only environment for looking at hardware: an analytic sky / ground / planet radiance model that is
 *  - drawn as the background behind the models (so pad screenshots have a sky to be judged against),
 *  - prefiltered into 'env.probeCube' and projected into 'env.sh9' (what metal reflects and what fills
 *    the shadows), and
 *  - integrated into 'atmosphere.skyIrradianceLut' (ambient light of 'terrain'-shaded surfaces).
 * In the game these resources come from the sky and atmosphere packages; this stand-in never ships.
 * Radiometry is photometric (cd/m^2, lux); the sun itself is not in the environment (it is the
 * directional light).
 */
import type { FrameContext, RenderContext, RenderFeature } from '@/core/contracts/render';
import { RENDER_FORMATS } from '@/core/contracts/render';
import { v3, type Vec3 } from '@/core/math';
import { coreOf, f32ToF16, type Tracked } from '@/render/core';

export type LabEnvKind = 'day' | 'night' | 'orbit' | 'moon' | 'void';

export interface LabEnvOptions {
  kind: LabEnvKind;
  /** Draw the sky behind the models (off in space, where the lab planet and blackness are the backdrop). */
  background?: boolean;
}

const E_SUN = 128000;

/** Environment luminance (cd/m^2, linear sRGB) toward unit direction d. `up` = local vertical, `sun` = unit vector to the sun. */
export function envRadiance(kind: LabEnvKind, d: Vec3, up: Vec3, sun: Vec3, out: [number, number, number]): void {
  const c = v3.dot(d, up);
  const sunEl = v3.dot(sun, up);
  out[0] = out[1] = out[2] = 0;
  if (kind === 'void') return;
  if (kind === 'day' || kind === 'night') {
    // Daylight factor: 1 with the sun high, fading through twilight.
    const day = Math.max(0, Math.min(1, (sunEl + 0.1) / 0.35));
    const k = kind === 'night' ? 0.00002 : 0.03 + 0.97 * day;
    if (c >= 0) {
      const t = Math.pow(c, 0.42);
      const hz = 9500 * k;
      const zn = 3200 * k;
      // Horizon haze is nearly white, the zenith is blue.
      out[0] = hz * 0.96 * (1 - t) + zn * 0.36 * t;
      out[1] = hz * 1.0 * (1 - t) + zn * 0.62 * t;
      out[2] = hz * 1.06 * (1 - t) + zn * 1.55 * t;
      const g = Math.max(0, v3.dot(d, sun));
      const glow = 5200 * k * Math.pow(g, 12) + 1600 * k * Math.pow(g, 3);
      out[0] += glow * 1.05;
      out[1] += glow;
      out[2] += glow * 0.9;
    } else {
      // Ground: sunlit coast of dark lava and scrub, blended into the haze at the horizon.
      const lit = (E_SUN * 0.78 * Math.max(0, sunEl)) / Math.PI + 4500 * k;
      const h = Math.exp(c * 9);
      const hz = 9500 * k;
      out[0] = lit * 0.16 * (1 - h) + hz * 0.96 * h;
      out[1] = lit * 0.145 * (1 - h) + hz * h;
      out[2] = lit * 0.12 * (1 - h) + hz * 1.06 * h;
    }
    return;
  }
  if (kind === 'orbit') {
    // Low orbit: the planet fills everything more than about 15 degrees below the local horizontal.
    const limb = -0.26;
    if (c < limb) {
      const lit = (E_SUN * Math.max(0, 0.15 + 0.85 * sunEl)) / Math.PI;
      const depth = Math.min(1, (limb - c) / 0.5);
      // Ocean and cloud average; brighter and bluer toward the limb.
      out[0] = lit * (0.2 + 0.1 * (1 - depth));
      out[1] = lit * (0.25 + 0.14 * (1 - depth));
      out[2] = lit * (0.33 + 0.25 * (1 - depth));
    } else if (c < limb + 0.03) {
      const lit = (E_SUN * Math.max(0, 0.15 + 0.85 * sunEl)) / Math.PI;
      const a = 1 - (c - limb) / 0.03;
      out[0] = lit * 0.12 * a;
      out[1] = lit * 0.2 * a;
      out[2] = lit * 0.5 * a;
    }
    return;
  }
  // Moon: regolith below the horizon, black sky above.
  if (c < 0) {
    const lit = (E_SUN * 0.11 * Math.max(0, sunEl)) / Math.PI;
    const k = 1 - Math.exp(c * 30);
    out[0] = lit * 1.02 * k;
    out[1] = lit * k;
    out[2] = lit * 0.96 * k;
  }
}

const FACE = 64;
const MIPS = 7;

/** Direction of a cube texel (WebGPU face order +X, -X, +Y, -Y, +Z, -Z). */
function faceDir(face: number, u: number, v: number): Vec3 {
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

const BACKGROUND_FS = /* wgsl */ `
struct LabEnv { up: vec4f, sun: vec4f }   // up.w = kind (0 day, 1 night), sun.w unused
@group(1) @binding(0) var<uniform> env: LabEnv;
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let d = normalize(viewRay(in.uv));
  let c = dot(d, env.up.xyz);
  let sunEl = dot(env.sun.xyz, env.up.xyz);
  let day = clamp((sunEl + 0.1) / 0.35, 0.0, 1.0);
  let k = select(0.03 + 0.97 * day, 0.00002, env.up.w > 0.5);
  var L = vec3f(0.0);
  let hz = 9500.0 * k;
  if (c >= 0.0) {
    let t = pow(c, 0.42);
    let zn = 3200.0 * k;
    L = hz * vec3f(0.96, 1.0, 1.06) * (1.0 - t) + zn * vec3f(0.36, 0.62, 1.55) * t;
    let g = max(dot(d, env.sun.xyz), 0.0);
    L += (5200.0 * k * pow(g, 12.0) + 1600.0 * k * pow(g, 3.0)) * vec3f(1.05, 1.0, 0.9);
  } else {
    let lit = 128000.0 * 0.78 * max(sunEl, 0.0) / PI + 4500.0 * k;
    let h = exp(c * 9.0);
    L = lit * vec3f(0.16, 0.145, 0.12) * (1.0 - h) + hz * vec3f(0.96, 1.0, 1.06) * h;
  }
  return vec4f(writeHdr(L * frame.exposure.x), 1.0);
}
`;

export function createLabEnvFeature(options: LabEnvOptions): RenderFeature & { setKind(kind: LabEnvKind): void } {
  let ctx: RenderContext;
  let kind = options.kind;
  let cube: GPUTexture;
  let sh: GPUBuffer;
  let irr: GPUTexture;
  let uniform: GPUBuffer;
  let group: GPUBindGroup;
  let pipeline: Tracked<GPURenderPipeline> | null = null;
  let lastUp: Vec3 | null = null;
  let lastSun: Vec3 | null = null;
  let lastKind: LabEnvKind | null = null;
  const col: [number, number, number] = [0, 0, 0];

  const rebuild = (up: Vec3, sun: Vec3): void => {
    const device = ctx.device;
    // ---- prefiltered cube: mip m holds a GGX lobe of roughness m / (MIPS - 1) about the reflection vector.
    for (let mip = 0; mip < MIPS; mip++) {
      const n = FACE >> mip;
      const rough = mip / (MIPS - 1);
      const alpha = rough * rough;
      const samples = mip === 0 ? 1 : 40;
      for (let face = 0; face < 6; face++) {
        const data = new Uint16Array(n * n * 4);
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const R = faceDir(face, (2 * (x + 0.5)) / n - 1, (2 * (y + 0.5)) / n - 1);
            let r = 0;
            let g = 0;
            let b = 0;
            let w = 0;
            if (samples === 1) {
              envRadiance(kind, R, up, sun, col);
              r = col[0];
              g = col[1];
              b = col[2];
              w = 1;
            } else {
              const t1 = v3.normalize(v3.anyOrthogonal(R));
              const t2 = v3.cross(R, t1);
              for (let i = 0; i < samples; i++) {
                // Hammersley point -> GGX half vector about R -> reflected sample direction.
                const xi1 = (i + 0.5) / samples;
                let bits = i;
                let xi2 = 0;
                let f = 0.5;
                while (bits > 0) {
                  if (bits & 1) xi2 += f;
                  bits >>= 1;
                  f *= 0.5;
                }
                const cosT = Math.sqrt((1 - xi1) / (1 + (alpha * alpha - 1) * xi1));
                const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
                const ph = 2 * Math.PI * xi2;
                const h = v3.add(v3.add(v3.scale(t1, sinT * Math.cos(ph)), v3.scale(t2, sinT * Math.sin(ph))), v3.scale(R, cosT));
                const l = v3.sub(v3.scale(h, 2 * v3.dot(R, h)), R);
                const nl = v3.dot(R, l);
                if (nl <= 0) continue;
                envRadiance(kind, l, up, sun, col);
                r += col[0] * nl;
                g += col[1] * nl;
                b += col[2] * nl;
                w += nl;
              }
            }
            const o = (y * n + x) * 4;
            data[o] = f32ToF16(r / Math.max(w, 1e-6));
            data[o + 1] = f32ToF16(g / Math.max(w, 1e-6));
            data[o + 2] = f32ToF16(b / Math.max(w, 1e-6));
            data[o + 3] = f32ToF16(1);
          }
        }
        device.queue.writeTexture({ texture: cube, mipLevel: mip, origin: [0, 0, face] }, data, { bytesPerRow: n * 8 }, [n, n, 1]);
      }
    }
    // ---- SH9 irradiance and the horizontal sky illuminance, by quadrature over a Fibonacci sphere.
    const N = 6000;
    const L = new Float64Array(27);
    let skyE = [0, 0, 0];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const z = 1 - (2 * (i + 0.5)) / N;
      const rad = Math.sqrt(1 - z * z);
      const d = { x: rad * Math.cos(golden * i), y: rad * Math.sin(golden * i), z };
      envRadiance(kind, d, up, sun, col);
      const Y = [0.282095, 0.488603 * d.y, 0.488603 * d.z, 0.488603 * d.x, 1.092548 * d.x * d.y, 1.092548 * d.y * d.z, 0.315392 * (3 * d.z * d.z - 1), 1.092548 * d.x * d.z, 0.546274 * (d.x * d.x - d.y * d.y)];
      for (let k = 0; k < 9; k++) for (let c = 0; c < 3; c++) L[k * 3 + c] = L[k * 3 + c]! + col[c]! * Y[k]!;
      const cu = v3.dot(d, up);
      if (cu > 0) skyE = [skyE[0]! + col[0] * cu, skyE[1]! + col[1] * cu, skyE[2]! + col[2] * cu];
    }
    const dOmega = (4 * Math.PI) / N;
    const A = [Math.PI, (2 * Math.PI) / 3, (2 * Math.PI) / 3, (2 * Math.PI) / 3, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4];
    const coeff = new Float32Array(36);
    for (let k = 0; k < 9; k++) for (let c = 0; c < 3; c++) coeff[k * 4 + c] = L[k * 3 + c]! * dOmega * A[k]!;
    device.queue.writeBuffer(sh, 0, coeff);
    const e = new Uint16Array([f32ToF16(skyE[0]! * dOmega), f32ToF16(skyE[1]! * dOmega), f32ToF16(skyE[2]! * dOmega), f32ToF16(1)]);
    device.queue.writeTexture({ texture: irr }, e, {}, [1, 1, 1]);
  };

  const feature: RenderFeature & { setKind(kind: LabEnvKind): void } = {
    id: 'lab-env',
    order: -10,
    setKind(k) {
      kind = k;
    },
    init(c) {
      ctx = c;
      const device = c.device;
      cube = device.createTexture({ label: 'lab-env.cube', format: 'rgba16float', size: [FACE, FACE, 6], mipLevelCount: MIPS, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      sh = device.createBuffer({ label: 'lab-env.sh9', size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      irr = device.createTexture({ label: 'lab-env.skyIrradiance', format: 'rgba16float', size: [1, 1, 1], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      uniform = device.createBuffer({ label: 'lab-env.uniform', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const layout = device.createBindGroupLayout({ label: 'lab-env', entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      group = device.createBindGroup({ label: 'lab-env', layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
      pipeline = coreOf(c).fullscreenPipeline({
        label: 'lab-env.background',
        fragment: BACKGROUND_FS,
        targets: [{ format: RENDER_FORMATS.hdr }],
        layouts: [layout],
        depthStencil: { format: RENDER_FORMATS.depth, depthCompare: 'equal', depthWriteEnabled: false },
      });
      c.resources.publish('env.probeCube', cube.createView({ dimension: 'cube' }));
      c.resources.publish('env.sh9', sh);
      c.resources.publish('atmosphere.skyIrradianceLut', irr.createView({ dimension: '2d-array' }));
    },
    prepare(frame: FrameContext) {
      const snap = frame.snapshot;
      const vessel = snap.vessels.find((v) => v.id === snap.activeVesselId) ?? snap.vessels[0];
      if (!vessel) return;
      const body = snap.bodies.find((b) => b.id === vessel.bodyId)!;
      const up = v3.normalize(v3.sub(vessel.rRoot, body.rRoot));
      const sun = frame.sun.dirRoot;
      if (!lastUp || !lastSun || lastKind !== kind || v3.angle(up, lastUp) > 0.004 || v3.angle(sun, lastSun) > 0.004) {
        rebuild(up, sun);
        lastUp = up;
        lastSun = sun;
        lastKind = kind;
      }
      ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([up.x, up.y, up.z, kind === 'night' ? 1 : 0, sun.x, sun.y, sun.z, 0]));
    },
    drawBackground(_frame, pass) {
      if (!(options.background ?? true) || (kind !== 'day' && kind !== 'night') || !pipeline) return;
      pass.setPipeline(pipeline.get());
      pass.setBindGroup(1, group);
      pass.draw(3);
    },
  };
  return feature;
}
