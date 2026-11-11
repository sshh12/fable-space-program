/**
 * Lab-only backdrop for the map view: each body as an analytically ray-traced, Lambert-shaded sphere with an
 * anti-aliased limb (camera-relative float32 centres, so it is stable at any distance), the star as an
 * emissive disc, on a black sky. It stands in for the real renderer so the overlay can be exercised alone;
 * tests/browser/map-view/real-planet.spec.ts shows the overlay over the real renderer.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraState } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { mat3 } from '@/core/math/mat';

const MAX_SPHERES = 8;

const WGSL = /* wgsl */ `
struct Sphere { centre: vec4f, color: vec4f, sun: vec4f };
struct U {
  viewToRoot: mat3x3f,
  screen: vec4f,      // width, height, focal px, sphere count
  spheres: array<Sphere, ${MAX_SPHERES}>,
};
@group(0) @binding(0) var<uniform> u: U;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn toSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let d = normalize(vec3f((pos.x - u.screen.x * 0.5) / u.screen.z, -(pos.y - u.screen.y * 0.5) / u.screen.z, -1.0));
  let dir = normalize(u.viewToRoot * d);
  let pixel = 1.0 / u.screen.z; // angular size of a pixel at the centre (rad)
  var best = 3.4e38;
  var col = vec3f(0.006, 0.008, 0.012);
  let n = u32(u.screen.w);
  for (var i = 0u; i < n; i++) {
    let s = u.spheres[i];
    let c = s.centre.xyz;
    let R = s.centre.w;
    let tc = dot(dir, c);
    if (tc <= 0.0) { continue; }
    let dperp = length(cross(dir, c));
    // analytic coverage of the limb: distance from the silhouette in pixels (one pixel wide ramp)
    let cover = clamp((R - dperp) / (tc * pixel) + 0.5, 0.0, 1.0);
    if (cover <= 0.0) { continue; }
    let dp = min(dperp, R * 0.999999);
    let t = tc - sqrt((R - dp) * (R + dp));
    if (t <= 0.0 || t >= best) { continue; }
    best = t;
    var shaded: vec3f;
    if (s.color.w > 0.5) {
      shaded = s.color.rgb;
    } else {
      let nrm = normalize(dir * t - c);
      let lit = max(dot(nrm, s.sun.xyz), 0.0);
      let rim = pow(1.0 - max(dot(nrm, -dir), 0.0), 3.0) * 0.08;
      shaded = toSrgb(s.color.rgb * (lit * 1.6 + 0.035) + vec3f(rim * 0.4, rim * 0.5, rim * 0.7) * lit);
    }
    col = mix(col, shaded, cover);
  }
  return vec4f(col, 1.0);
}
`;

export class Backdrop {
  private readonly pipeline: GPURenderPipeline;
  private readonly buffer: GPUBuffer;
  private readonly group: GPUBindGroup;
  private readonly data = new Float32Array(12 + 4 + MAX_SPHERES * 12);

  constructor(
    private readonly device: GPUDevice,
    format: GPUTextureFormat,
    private readonly defs: DefLibrary,
  ) {
    const module = device.createShaderModule({ label: 'mapLab.backdrop', code: WGSL });
    this.pipeline = device.createRenderPipeline({
      label: 'mapLab.backdrop',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.buffer = device.createBuffer({ size: this.data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.group = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.buffer } }] });
  }

  draw(encoder: GPUCommandEncoder, view: GPUTextureView, snapshot: SimSnapshot, camera: CameraState, width: number, height: number): void {
    const d = this.data;
    d.fill(0);
    d.set(mat3.toGpu(mat3.fromQuat(camera.qViewToRoot)), 0);
    const focal = height / 2 / Math.tan(camera.fovY / 2);
    let n = 0;
    for (const b of snapshot.bodies) {
      const def = this.defs.bodies[b.id];
      if (!def || n >= MAX_SPHERES) continue;
      const o = 16 + n * 12;
      // camera-relative centre computed in float64, narrowed only here
      d[o] = b.rRoot.x - camera.positionRoot.x;
      d[o + 1] = b.rRoot.y - camera.positionRoot.y;
      d[o + 2] = b.rRoot.z - camera.positionRoot.z;
      d[o + 3] = def.radius;
      const emissive = def.emission !== null;
      const c = emissive ? [1.0, 0.96, 0.86] : def.render.meanColor;
      d.set([c[0]!, c[1]!, c[2]!, emissive ? 1 : 0], o + 4);
      d.set([b.sunDir.x, b.sunDir.y, b.sunDir.z, 0], o + 8);
      n++;
    }
    d.set([width, height, focal, n], 12);
    this.device.queue.writeBuffer(this.buffer, 0, d);
    const pass = encoder.beginRenderPass({
      label: 'mapLab.backdrop',
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.draw(3);
    pass.end();
  }
}
