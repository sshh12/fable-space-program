/**
 * Lab backdrop (labs only, never shipped): a compact WebGPU ray tracer that draws the FakeSim world well
 * enough to judge cameras and HUD legibility - lit spheres for the bodies at their true sizes and positions
 * with a ground grid near the camera, a crude daytime sky inside an atmosphere, an atmosphere rim from space,
 * stars, the sun disc, and the lab vehicle as stacked cylinders. All geometry is made camera-relative in
 * float64 on the CPU; the shader uses the cancellation-free sphere intersection with the altitude computed
 * in float64, so the ground is stable 60 m below a camera at 6,371 km from the planet centre.
 */
import type { CameraState } from '@/core/contracts/render';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { GpuHandle } from '@/core/gpu/device';
import { mat3 } from '@/core/math/mat';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';

const WGSL = /* wgsl */ `
struct Body {
  centre: vec4f,      // xyz camera-relative centre (m), w radius of the ground sphere (m)
  color: vec4f,       // rgb albedo, w atmosphere (0/1)
  alt: vec4f,         // x camera height above the ground sphere (m, from f64), y grid phase u, z grid phase v, w grid period
  rx: vec4f,          // rows of ROOT -> body-fixed rotation
  ry: vec4f,
  rz: vec4f,
};
struct Cyl { a: vec4f };   // x yMin, y yMax, z radius, w band (0 white, 1 dark)
struct Frame {
  r0: vec4f, r1: vec4f, r2: vec4f,     // view -> ROOT rotation columns as rows of the matrix (we dot with them)
  proj: vec4f,                          // x tan(fov/2) * aspect, y tan(fov/2), z body count, w show vessel
  sun: vec4f,                           // xyz direction, w sun angular radius cosine
  vOrigin: vec4f,                       // vessel origin rel camera, w bright mode (0/1)
  vq0: vec4f, vq1: vec4f, vq2: vec4f,  // rows of VES -> ROOT rotation
  vinfo: vec4f,                         // x cylinder count, y marker (map) 0/1, z height px, w radians per pixel
  bodies: array<Body, 3>,
  cyl: array<Cyl, 10>,
};
@group(0) @binding(0) var<uniform> F: Frame;

struct VOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VOut; o.pos = vec4f(xy, 0.0, 1.0); o.ndc = xy; return o;
}

fn hash3(p: vec3f) -> f32 {
  var q = fract(p * 0.3183099 + vec3f(0.1, 0.2, 0.3));
  q = q * 17.0;
  return fract(q.x * q.y * q.z * (q.x + q.y + q.z));
}
fn srgb(c: vec3f) -> vec3f { return select(1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308)); }

fn stars(d: vec3f) -> vec3f {
  let g = d * 260.0;
  let cell = floor(g);
  let h = hash3(cell);
  if (h < 0.965) { return vec3f(0.0); }
  let c = cell + vec3f(0.5) + (vec3f(hash3(cell + 1.7), hash3(cell + 3.1), hash3(cell + 5.3)) - 0.5) * 0.6;
  let dist = length(g - c);
  let b = pow((h - 0.965) / 0.035, 3.0) * 1.4;
  return vec3f(b) * smoothstep(0.32, 0.0, dist) * mix(vec3f(1.0, 0.85, 0.7), vec3f(0.75, 0.85, 1.0), hash3(cell + 9.0));
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let v = normalize(vec3f(in.ndc.x * F.proj.x, in.ndc.y * F.proj.y, -1.0));
  let d = normalize(vec3f(dot(F.r0.xyz, v), dot(F.r1.xyz, v), dot(F.r2.xyz, v)));
  let sun = F.sun.xyz;
  var col = stars(d);
  let sd = dot(d, sun);
  col += vec3f(1.0, 0.96, 0.88) * smoothstep(F.sun.w - 0.00002, F.sun.w + 0.00002, sd) * 6.0;
  col += vec3f(1.0, 0.9, 0.75) * pow(max(sd, 0.0), 2000.0) * 0.6;
  var tBest = 1e30;
  // Sky inside an atmosphere (lab approximation).
  for (var i = 0u; i < u32(F.proj.z); i++) {
    let b = F.bodies[i];
    if (b.color.w < 0.5) { continue; }
    let h = b.alt.x;
    if (h > 120000.0) { continue; }
    let up = normalize(-b.centre.xyz);
    let el = dot(d, up);
    let sunEl = dot(sun, up);
    let day = smoothstep(-0.12, 0.25, sunEl);
    let thin = exp(-h / 9000.0);
    let zen = vec3f(0.12, 0.32, 0.75);
    let hor = vec3f(0.62, 0.78, 0.95);
    var sky = mix(hor, zen, pow(clamp(el, 0.0, 1.0), 0.45)) * day;
    // Bright mode: a pale, hazy sky (HUD legibility worst case).
    sky = mix(sky, vec3f(1.05, 1.08, 1.12) * day, F.vOrigin.w * 0.8);
    sky += vec3f(1.0, 0.75, 0.45) * pow(max(sd, 0.0), 8.0) * 0.35 * day;
    sky += vec3f(1.0, 0.45, 0.2) * pow(1.0 - abs(el), 6.0) * smoothstep(0.3, 0.0, abs(sunEl)) * 0.4;
    col = mix(col, sky, thin * smoothstep(-0.2, 0.02, el + 0.02));
  }
  // Bodies.
  for (var i = 0u; i < u32(F.proj.z); i++) {
    let b = F.bodies[i];
    let oc = -b.centre.xyz;
    let R = b.centre.w;
    let h = b.alt.x;
    let bb = dot(oc, d);
    let c = h * (2.0 * R + h);
    let disc = bb * bb - c;
    // Atmosphere rim seen from space: a graded limb. The glow follows the lowest height the ray reaches (the
    // camera's own height for a ray climbing away), so it is continuous across the local horizontal, falls off
    // upward with the shrinking path through the shell, and the stars fade out behind it.
    if (b.color.w > 0.5 && h > 50000.0) {
      let closest = select(length(oc), length(oc - d * bb), bb < 0.0);
      if (closest > R * 0.995) {
        let up = normalize(oc);
        let el = max(dot(d, up), 0.0);
        let k = clamp(1.0 - (closest - R) / 90000.0, 0.0, 1.0) * exp(-el / 0.08);
        let lit = clamp(dot(normalize(select(oc, oc - d * bb, bb < 0.0)), sun) * 1.5 + 0.4, 0.0, 1.0);
        let glow = k * k * lit;
        col = col * (1.0 - clamp(glow * 1.6, 0.0, 1.0)) + vec3f(0.3, 0.55, 1.0) * glow * 0.9;
      }
    }
    if (disc <= 0.0 || bb >= 0.0) { continue; }
    let t = c / (-bb + sqrt(disc));
    if (t >= tBest) { continue; }
    tBest = t;
    let p = oc + d * t;
    let n = normalize(p);
    let nf = vec3f(dot(b.rx.xyz, n), dot(b.ry.xyz, n), dot(b.rz.xyz, n));
    let lat = asin(clamp(nf.z, -1.0, 1.0));
    let lon = atan2(nf.y, nf.x);
    var alb = b.color.rgb;
    // Large-scale pattern so rotation and distance read (15 deg graticule, gentle mottling).
    let g = 0.5 - abs(fract(vec2f(lat, lon) * (12.0 / 3.14159265)) - 0.5);
    let grat = smoothstep(0.03, 0.0, min(g.x, g.y));
    let mott = hash3(floor(nf * 40.0)) * 0.12 + hash3(floor(nf * 330.0)) * 0.06;
    alb = alb * (0.9 + mott) + vec3f(0.05) * grat;
    // Ground grid near the camera (period from CPU, phase in f64).
    let local = vec2f(dot(b.rx.xyz, d * t), dot(b.ry.xyz, d * t)) + b.alt.yz;
    let period = b.alt.w;
    let gg = 0.5 - abs(fract(local / period) - 0.5);
    // Line width from the pixel footprint (no derivatives: this runs in non-uniform control flow).
    let fw = t * F.vinfo.w / period / max(abs(dot(d, n)), 0.05);
    let line = 1.0 - smoothstep(0.0, max(fw * 1.5, 0.004), min(gg.x, gg.y));
    alb = mix(alb, alb * 1.35 + vec3f(0.03), line * smoothstep(40000.0, 2000.0, t) * 0.8);
    // Bright mode: a sunlit cloud deck / lit regolith at near-white (about 250 in the frame).
    alb = mix(alb, vec3f(1.12, 1.13, 1.15) * (0.94 + mott * 0.4), F.vOrigin.w);
    let lam = max(dot(n, sun), F.vOrigin.w * 0.85);
    col = alb * (lam * 1.05 + 0.025);
    if (b.color.w > 0.5 && F.vOrigin.w < 0.5) {
      let haze = 1.0 - exp(-t / 120000.0);
      col = mix(col, vec3f(0.55, 0.7, 0.9) * smoothstep(-0.1, 0.3, dot(n, sun)), haze * 0.6);
    }
  }
  // Vessel: stacked cylinders along VES +Y.
  if (F.proj.w > 0.5) {
    let o = -F.vOrigin.xyz;
    let ov = vec3f(dot(F.vq0.xyz, o), dot(F.vq1.xyz, o), dot(F.vq2.xyz, o));
    let dvv = vec3f(dot(F.vq0.xyz, d), dot(F.vq1.xyz, d), dot(F.vq2.xyz, d));
    var tv = 1e30;
    var nv = vec3f(0.0);
    var band = 0.0;
    for (var k = 0u; k < u32(F.vinfo.x); k++) {
      let cy = F.cyl[k].a;
      let a = dvv.x * dvv.x + dvv.z * dvv.z;
      let bq = ov.x * dvv.x + ov.z * dvv.z;
      let cq = ov.x * ov.x + ov.z * ov.z - cy.z * cy.z;
      let dq = bq * bq - a * cq;
      if (dq > 0.0 && a > 1e-9) {
        let t0 = (-bq - sqrt(dq)) / a;
        let y = ov.y + dvv.y * t0;
        if (t0 > 0.0 && y > cy.x && y < cy.y && t0 < tv) { tv = t0; nv = normalize(vec3f(ov.x + dvv.x * t0, 0.0, ov.z + dvv.z * t0)); band = cy.w; }
      }
      for (var s = 0; s < 2; s++) {
        let yc = select(cy.x, cy.y, s == 1);
        if (abs(dvv.y) > 1e-6) {
          let t1 = (yc - ov.y) / dvv.y;
          let q = ov + dvv * t1;
          if (t1 > 0.0 && q.x * q.x + q.z * q.z < cy.z * cy.z && t1 < tv) { tv = t1; nv = vec3f(0.0, select(-1.0, 1.0, s == 1), 0.0); band = cy.w; }
        }
      }
    }
    if (tv < tBest) {
      let nr = vec3f(dot(vec3f(F.vq0.x, F.vq1.x, F.vq2.x), nv), dot(vec3f(F.vq0.y, F.vq1.y, F.vq2.y), nv), dot(vec3f(F.vq0.z, F.vq1.z, F.vq2.z), nv));
      let base = mix(vec3f(0.86, 0.87, 0.88), vec3f(0.12, 0.13, 0.15), band);
      let lam = max(dot(nr, sun), 0.0);
      let hv = normalize(sun - d);
      col = base * (lam * 1.1 + 0.06) + vec3f(pow(max(dot(nr, hv), 0.0), 40.0) * 0.4 * lam);
    }
  }
  if (F.vinfo.y > 0.5) {
    let o = normalize(F.vOrigin.xyz);
    let ang = acos(clamp(dot(o, d), -1.0, 1.0));
    let px = ang / (2.0 * atan(F.proj.y)) * F.vinfo.z;
    col = mix(col, vec3f(1.0, 0.62, 0.2), smoothstep(5.0, 3.5, px));
  }
  let mapped = col / (1.0 + col * 0.15);
  return vec4f(srgb(mapped), 1.0);
}
`;

export interface LabBackdrop {
  render(encoder: GPUCommandEncoder, target: GPUTextureView, snapshot: SimSnapshot, camera: CameraState, sizePx: [number, number]): void;
}

/** Ground elevation used by the lab (and its fake TerrainProvider): constant per body. */
export const LAB_GROUND: Record<string, number> = { earth: 57, moon: 4 };

const BODY_COLORS: Record<string, [number, number, number]> = { earth: [0.09, 0.2, 0.36], moon: [0.32, 0.31, 0.3] };

export function createLabBackdrop(gpu: GpuHandle, defs: DefLibrary, vesselCylinders: () => [number, number, number, number][], opts: { bright?: boolean } = {}): LabBackdrop {
  const bright = opts.bright ? 1 : 0;
  const device = gpu.device;
  const module = device.createShaderModule({ label: 'lab.backdrop', code: WGSL });
  const pipeline = device.createRenderPipeline({ label: 'lab.backdrop', layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: gpu.canvasFormat }] } });
  const BYTES = (3 + 1 + 1 + 1 + 3 + 1) * 16 + 3 * 6 * 16 + 10 * 16;
  const buf = device.createBuffer({ label: 'lab.backdrop', size: BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
  const data = new Float32Array(BYTES / 4);

  return {
    render(encoder, target, s, cam, size) {
      const m = mat3.fromQuat(cam.qViewToRoot);
      const t = Math.tan(cam.fovY / 2);
      const bodies = s.bodies.filter((b) => defs.bodies[b.id]?.emission === null).slice(0, 3);
      const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
      const star = s.bodies.find((b) => b.id === s.starId);
      const sunDir = star ? v3.normalize(v3.sub(star.rRoot, cam.positionRoot)) : v3.unitX();
      const sunCos = Math.cos((0.267 * Math.PI) / 180);
      const vOrigin = v3.sub(v.rRoot, cam.positionRoot);
      const vm = mat3.fromQuat(quat.conj(v.q));
      const cyl = vesselCylinders();
      const isMap = cam.kind === 'map';
      let o = 0;
      const put = (...xs: number[]): void => {
        for (const x of xs) data[o++] = x;
      };
      put(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0);
      put(t * (size[0] / size[1]), t, bodies.length, cam.kind === 'external' ? 1 : 0);
      put(sunDir.x, sunDir.y, sunDir.z, sunCos);
      put(vOrigin.x, vOrigin.y, vOrigin.z, bright);
      put(vm[0], vm[1], vm[2], 0, vm[3], vm[4], vm[5], 0, vm[6], vm[7], vm[8], 0);
      put(cyl.length, isMap ? 1 : 0, size[1], (2 * t) / size[1]);
      for (let i = 0; i < 3; i++) {
        const b = bodies[i];
        if (!b) {
          put(...new Array<number>(24).fill(0));
          continue;
        }
        const def = defs.bodies[b.id]!;
        const R = def.radius + (LAB_GROUND[b.id] ?? 0);
        const rel = v3.sub(b.rRoot, cam.positionRoot);
        const h = v3.len(rel) - R;
        const f = mat3.fromQuat(quat.conj(b.qFixedToRoot));
        const camFixed = quat.rotateInv(b.qFixedToRoot, v3.neg(rel));
        const period = 500;
        const ph = (x: number): number => ((x % period) + period) % period;
        const c = BODY_COLORS[b.id] ?? [def.render.meanColor[0], def.render.meanColor[1], def.render.meanColor[2]];
        put(rel.x, rel.y, rel.z, R, c[0], c[1], c[2], def.atmosphere ? 1 : 0, h, ph(camFixed.x), ph(camFixed.y), period);
        put(f[0], f[1], f[2], 0, f[3], f[4], f[5], 0, f[6], f[7], f[8], 0);
      }
      for (let i = 0; i < 10; i++) {
        const c = cyl[i];
        put(...(c ?? [0, 0, 0, 0]));
      }
      device.queue.writeBuffer(buf, 0, data);
      const pass = encoder.beginRenderPass({ label: 'lab.backdrop', colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
    },
  };
}
