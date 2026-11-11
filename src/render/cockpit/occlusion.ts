/**
 * Baked occlusion of the interior, per vertex: how much of the cabin's own light reaches each vertex past the
 * interior's geometry. Computed once when the feature initialises, on the GPU (one invocation per vertex,
 * rays against the BVH of that detail level, bvh.ts), into a second vertex stream of 16 bytes:
 *
 *   byte 0       ambient occlusion: cosine-weighted hemisphere visibility within `transport.aoDistance`
 *                (the cabin's inter-reflected light, sun-patch bounce)
 *   byte 1       flood light visibility: the floods' unoccluded irradiance at the vertex that is not
 *                blocked, over all of it (they switch together with the lights)
 *   bytes 2..9   visibility of each window opening (MAX_WINDOWS slots; window order of the model)
 *   bytes 10..13 visibility of each display (MAX_DISPLAYS slots)
 *   bytes 14..15 zero
 *
 * Source visibility weights each sample point by its form-factor kernel cos_r cos_e / d^2, so a source seen
 * at grazing incidence counts for little. `occlusionAt` is the same computation on the CPU (unit tests, and
 * the browser spec compares it with the GPU result).
 */
import { v3, type Vec3 } from '@/core/math';
import { bvhRay, type Bvh } from './bvh';
import type { CockpitModel } from './build';
import { MAX_DISPLAYS, MAX_WINDOWS } from './layout';
import { windowQuad } from './lighting';
import { VERTEX_STRIDE } from './mesh';

export const OCC_STRIDE = 16;
export const MAX_FLOODS = 8;
/** Offset of the ray start along the vertex normal, and how far short of a source sample rays stop (m). */
const RAY_LIFT = 0.002;
const SOURCE_STOP = 0.012;
/** Window samples are spread over this fraction of the area-equivalent quad (inside the rounded corners). */
const WINDOW_SPREAD = 0.85;

/** A light-emitting quad: corners, unit normal facing the cabin, and its weight (floods: lumens). */
export interface OccSource {
  c: [Vec3, Vec3, Vec3, Vec3];
  n: Vec3;
  weight: number;
}

export interface OccSources {
  windows: OccSource[];
  displays: OccSource[];
  floods: OccSource[];
}

export function occlusionSources(model: CockpitModel): OccSources {
  const windows = model.windows.map((w): OccSource => {
    const q = windowQuad(w);
    const c = q.corners.map((p) => v3.lerp(q.centre, p, WINDOW_SPREAD)) as [Vec3, Vec3, Vec3, Vec3];
    return { c, n: v3.neg(q.outward), weight: 1 };
  });
  const displays = model.displays.map((d): OccSource => {
    const f = d.frame;
    const at = (a: number, b: number): Vec3 => v3.add(f.o, v3.add(v3.scale(f.x, a), v3.scale(f.y, b)));
    const hw = d.width / 2;
    const hh = d.height / 2;
    return { c: [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)], n: f.n, weight: 1 };
  });
  const floods = model.floods.map((f): OccSource => {
    const along = v3.normalize(v3.sub(f.p1, f.p0));
    const across = v3.scale(v3.normalize(v3.cross(f.n, along)), 0.018);
    return { c: [v3.sub(f.p0, across), v3.sub(f.p1, across), v3.add(f.p1, across), v3.add(f.p0, across)], n: f.n, weight: f.lumens };
  });
  if (windows.length > MAX_WINDOWS || displays.length > MAX_DISPLAYS || floods.length > MAX_FLOODS) throw new Error(`cockpit ${model.layoutId}: more windows, displays or floods than occlusion slots`);
  return { windows, displays, floods };
}

/** PCG hash (the same in occlusion WGSL). */
export function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** Orthonormal basis around a unit normal (Duff et al. 2017; the same in WGSL). */
function basis(n: Vec3): [Vec3, Vec3] {
  const sign = n.z >= 0 ? 1 : -1;
  const a = -1 / (sign + n.z);
  const b = n.x * n.y * a;
  return [
    { x: 1 + sign * n.x * n.x * a, y: sign * b, z: -sign * n.x },
    { x: b, y: sign + n.y * n.y * a, z: -n.y },
  ];
}

const fract = (x: number): number => x - Math.floor(x);
const GOLDEN = 0.6180339887;

/** Point k of `count` stratified samples on a quad (bilinear), rotated by `rot`. */
function quadSample(c: [Vec3, Vec3, Vec3, Vec3], k: number, count: number, rot: number): Vec3 {
  const s = (k + 0.5) / count;
  const t = fract(k * GOLDEN + rot);
  return v3.lerp(v3.lerp(c[0], c[1], s), v3.lerp(c[3], c[2], s), t);
}

/** Visibility of a set of sources from p (normal n): sum of unblocked kernel weights over the total. */
function sourceVisibility(bvh: Bvh, p: Vec3, n: Vec3, sources: OccSource[], rays: number, rot: number): number {
  let total = 0;
  let seen = 0;
  const o = v3.addScaled(p, n, RAY_LIFT);
  for (const src of sources) {
    for (let k = 0; k < rays; k++) {
      const q = quadSample(src.c, k, rays, rot);
      const d = v3.sub(q, o);
      const dist = v3.len(d);
      if (dist < 1e-4) continue;
      const dir = v3.scale(d, 1 / dist);
      const w = Math.max(0, v3.dot(n, dir)) * Math.max(0, -v3.dot(src.n, dir)) * src.weight / (dist * dist);
      if (w <= 0) continue;
      total += w;
      if (!bvhRay(bvh, o, dir, 0, dist - SOURCE_STOP, true)) seen += w;
    }
  }
  return total > 0 ? seen / total : 1;
}

export interface VertexOcclusion {
  ao: number;
  flood: number;
  windows: number[];
  displays: number[];
}

/** The bake of one vertex on the CPU (position p, unit normal n, vertex index for the sample rotation). */
export function occlusionAt(model: CockpitModel, bvh: Bvh, sources: OccSources, p: Vec3, n: Vec3, index: number): VertexOcclusion {
  const t = model.layout.transport;
  const rot = pcg(index) / 4294967296;
  const [tx, ty] = basis(n);
  const o = v3.addScaled(p, n, RAY_LIFT);
  let open = 0;
  for (let k = 0; k < t.aoRays; k++) {
    const u1 = (k + 0.5) / t.aoRays;
    const phi = 2 * Math.PI * fract(k * GOLDEN + rot);
    const r = Math.sqrt(u1);
    const dir = v3.add(v3.add(v3.scale(tx, r * Math.cos(phi)), v3.scale(ty, r * Math.sin(phi))), v3.scale(n, Math.sqrt(1 - u1)));
    if (!bvhRay(bvh, o, dir, 0, t.aoDistance, true)) open++;
  }
  return {
    ao: open / t.aoRays,
    flood: sourceVisibility(bvh, p, n, sources.floods, t.sourceRays, rot),
    windows: sources.windows.map((w) => sourceVisibility(bvh, p, n, [w], t.sourceRays, rot)),
    displays: sources.displays.map((d) => sourceVisibility(bvh, p, n, [d], t.sourceRays, rot)),
  };
}

/** Position and unit normal of mesh vertex i as the GPU bake reads them (float32 position, snorm16 normal). */
export function bakeVertex(model: CockpitModel, i: number): { p: Vec3; n: Vec3 } {
  const f32 = new Float32Array(model.mesh.vertices, i * VERTEX_STRIDE, 3);
  const i16 = new Int16Array(model.mesh.vertices, i * VERTEX_STRIDE + 12, 3);
  const sn = (x: number): number => Math.max(-1, x / 32767);
  return { p: { x: f32[0]!, y: f32[1]!, z: f32[2]! }, n: v3.normalize({ x: sn(i16[0]!), y: sn(i16[1]!), z: sn(i16[2]!) }) };
}

/** Unpacked bytes of one vertex's occlusion record (as the shader reads them). */
export function unpackOcclusion(words: Uint32Array, vertex: number, windows: number, displays: number): VertexOcclusion {
  const byte = (k: number): number => ((words[vertex * 4 + (k >> 2)]! >>> ((k & 3) * 8)) & 255) / 255;
  return {
    ao: byte(0),
    flood: byte(1),
    windows: Array.from({ length: windows }, (_, i) => byte(2 + i)),
    displays: Array.from({ length: displays }, (_, i) => byte(2 + MAX_WINDOWS + i)),
  };
}

/** Sources in the bake's uniform: 20 quads of 5 vec4 (corners, normal + weight). */
const QUAD_FLOATS = 20;
const PARAM_HEADER_FLOATS = 12;
export const BAKE_PARAM_FLOATS = PARAM_HEADER_FLOATS + (MAX_WINDOWS + MAX_DISPLAYS + MAX_FLOODS) * QUAD_FLOATS;

export const OCCLUSION_WGSL = /* wgsl */ `
struct Node { bmin: vec3f, a: u32, bmax: vec3f, count: u32 }
struct Quad { c0: vec4f, c1: vec4f, c2: vec4f, c3: vec4f, n: vec4f }
struct Params {
  range: vec4u,      // x = first vertex, y = vertex count, z = windows, w = displays
  counts: vec4u,     // x = floods, y = AO rays, z = rays per source
  misc: vec4f,       // x = AO distance
  windows: array<Quad, ${MAX_WINDOWS}>,
  displays: array<Quad, ${MAX_DISPLAYS}>,
  floods: array<Quad, ${MAX_FLOODS}>,
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> nodes: array<Node>;
@group(0) @binding(2) var<storage, read> tris: array<vec4f>;
@group(0) @binding(3) var<storage, read> verts: array<u32>;
@group(0) @binding(4) var<storage, read_write> outOcc: array<u32>;

const RAY_LIFT = ${RAY_LIFT};
const SOURCE_STOP = ${SOURCE_STOP};
const GOLDEN = 0.6180339887;
const PI = 3.14159265358979;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

/// Any hit of o + t d with 0 < t < tMax (d unit length).
fn occluded(o: vec3f, d: vec3f, tMax: f32) -> bool {
  let inv = vec3f(1.0) / select(d, vec3f(1e-30), abs(d) < vec3f(1e-30));
  var stack: array<u32, 48>;
  var sp = 1u;
  stack[0] = 0u;
  loop {
    if (sp == 0u) { break; }
    sp -= 1u;
    let node = nodes[stack[sp]];
    let t0 = (node.bmin - o) * inv;
    let t1 = (node.bmax - o) * inv;
    let tn = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), max(min(t0.z, t1.z), 0.0));
    let tf = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), min(max(t0.z, t1.z), tMax));
    if (tn > tf) { continue; }
    if (node.count == 0u) {
      if (sp + 2u <= 48u) {
        stack[sp] = node.a;
        stack[sp + 1u] = node.a + 1u;
        sp += 2u;
      }
      continue;
    }
    for (var t = node.a; t < node.a + node.count; t++) {
      let a = tris[t * 3u].xyz;
      let e1 = tris[t * 3u + 1u].xyz - a;
      let e2 = tris[t * 3u + 2u].xyz - a;
      let pv = cross(d, e2);
      let det = dot(e1, pv);
      if (abs(det) < 1e-14) { continue; }
      let inv_det = 1.0 / det;
      let sv = o - a;
      let u = dot(sv, pv) * inv_det;
      if (u < 0.0 || u > 1.0) { continue; }
      let qv = cross(sv, e1);
      let v = dot(d, qv) * inv_det;
      if (v < 0.0 || u + v > 1.0) { continue; }
      let tt = dot(e2, qv) * inv_det;
      if (tt > 0.0 && tt < tMax) { return true; }
    }
  }
  return false;
}

fn quadSample(q: Quad, k: u32, count: u32, rot: f32) -> vec3f {
  let s = (f32(k) + 0.5) / f32(count);
  let t = fract(f32(k) * GOLDEN + rot);
  return mix(mix(q.c0.xyz, q.c1.xyz, s), mix(q.c3.xyz, q.c2.xyz, s), t);
}

/// Unblocked and total kernel weight of one source seen from p (normal n).
fn sourceWeights(q: Quad, p: vec3f, n: vec3f, rays: u32, rot: f32) -> vec2f {
  var acc = vec2f(0.0);
  let o = p + n * RAY_LIFT;
  for (var k = 0u; k < rays; k++) {
    let d = quadSample(q, k, rays, rot) - o;
    let dist = length(d);
    if (dist < 1e-4) { continue; }
    let dir = d / dist;
    let w = max(dot(n, dir), 0.0) * max(-dot(q.n.xyz, dir), 0.0) * q.n.w / (dist * dist);
    if (w <= 0.0) { continue; }
    acc.y += w;
    if (!occluded(o, dir, dist - SOURCE_STOP)) { acc.x += w; }
  }
  return acc;
}
fn ratio(a: vec2f) -> f32 { return select(1.0, a.x / a.y, a.y > 0.0); }
fn byteOf(x: f32) -> u32 { return u32(clamp(x, 0.0, 1.0) * 255.0 + 0.5); }

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= P.range.y) { return; }
  let index = P.range.x + gid.x;
  // Mesh vertex: 12 words; position f32 x3 at word 0, normal snorm16 x4 at words 3..4.
  let w = index * 12u;
  let p = vec3f(bitcast<f32>(verts[w]), bitcast<f32>(verts[w + 1u]), bitcast<f32>(verts[w + 2u]));
  let nxy = unpack2x16snorm(verts[w + 3u]);
  let nzw = unpack2x16snorm(verts[w + 4u]);
  let n = normalize(vec3f(nxy, nzw.x));
  let rot = f32(pcg(index)) / 4294967296.0;
  let sgn = select(-1.0, 1.0, n.z >= 0.0);
  let ba = -1.0 / (sgn + n.z);
  let bb = n.x * n.y * ba;
  let tx = vec3f(1.0 + sgn * n.x * n.x * ba, sgn * bb, -sgn * n.x);
  let ty = vec3f(bb, sgn + n.y * n.y * ba, -n.y);
  let o = p + n * RAY_LIFT;
  var open = 0u;
  let aoRays = P.counts.y;
  for (var k = 0u; k < aoRays; k++) {
    let u1 = (f32(k) + 0.5) / f32(aoRays);
    let phi = 2.0 * PI * fract(f32(k) * GOLDEN + rot);
    let r = sqrt(u1);
    let dir = tx * (r * cos(phi)) + ty * (r * sin(phi)) + n * sqrt(1.0 - u1);
    if (!occluded(o, dir, P.misc.x)) { open += 1u; }
  }
  var bytes: array<u32, 16>;
  bytes[0] = byteOf(f32(open) / f32(aoRays));
  var fl = vec2f(0.0);
  for (var i = 0u; i < P.counts.x; i++) { fl += sourceWeights(P.floods[i], p, n, P.counts.z, rot); }
  bytes[1] = byteOf(ratio(fl));
  for (var i = 0u; i < ${MAX_WINDOWS}u; i++) {
    bytes[2u + i] = select(0u, byteOf(ratio(sourceWeights(P.windows[i], p, n, P.counts.z, rot))), i < P.range.z);
  }
  for (var i = 0u; i < ${MAX_DISPLAYS}u; i++) {
    bytes[2u + ${MAX_WINDOWS}u + i] = select(0u, byteOf(ratio(sourceWeights(P.displays[i], p, n, P.counts.z, rot))), i < P.range.w);
  }
  for (var k = 0u; k < 4u; k++) {
    outOcc[index * 4u + k] = bytes[k * 4u] | (bytes[k * 4u + 1u] << 8u) | (bytes[k * 4u + 2u] << 16u) | (bytes[k * 4u + 3u] << 24u);
  }
}
`;

/** The bake's uniform data for the vertices [first, first + count) of a model. */
export function bakeParams(model: CockpitModel, sources: OccSources, first: number, count: number): Float32Array<ArrayBuffer> {
  const t = model.layout.transport;
  const d = new Float32Array(BAKE_PARAM_FLOATS);
  const u = new Uint32Array(d.buffer);
  u.set([first, count, sources.windows.length, sources.displays.length, sources.floods.length, t.aoRays, t.sourceRays, 0], 0);
  d[8] = t.aoDistance;
  const put = (slot: number, s: OccSource): void => {
    const o = PARAM_HEADER_FLOATS + slot * QUAD_FLOATS;
    s.c.forEach((p, k) => d.set([p.x, p.y, p.z, 0], o + k * 4));
    d.set([s.n.x, s.n.y, s.n.z, s.weight], o + 16);
  };
  sources.windows.forEach((s, i) => put(i, s));
  sources.displays.forEach((s, i) => put(MAX_WINDOWS + i, s));
  sources.floods.forEach((s, i) => put(MAX_WINDOWS + MAX_DISPLAYS + i, s));
  return d;
}

/**
 * Bake every detail level of a model on the GPU: returns the occlusion vertex stream (STORAGE | VERTEX,
 * OCC_STRIDE bytes per vertex). `bvhs` holds the BVH of each detail level's triangles, `vertex` the mesh's
 * vertex buffer (with STORAGE usage).
 */
export function bakeOcclusion(device: GPUDevice, model: CockpitModel, vertex: GPUBuffer, bvhs: Record<string, Bvh>, createModule: (label: string, code: string) => GPUShaderModule): GPUBuffer {
  const sources = occlusionSources(model);
  // COPY_SRC: tests read the bake back and compare it with occlusionAt.
  const out = device.createBuffer({ label: `cockpit.${model.layoutId}.occlusion`, size: Math.max(16, model.mesh.vertexCount * OCC_STRIDE), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC });
  const pipeline = device.createComputePipeline({ label: 'cockpit.occlusionBake', layout: 'auto', compute: { module: createModule('cockpit.occlusionBake', OCCLUSION_WGSL), entryPoint: 'main' } });
  const temp: GPUBuffer[] = [];
  const enc = device.createCommandEncoder({ label: 'cockpit.occlusionBake' });
  for (const [lod, range] of Object.entries(model.mesh.vertexRanges)) {
    const bvh = bvhs[lod];
    if (!bvh || range.count === 0) continue;
    const params = bakeParams(model, sources, range.start, range.count);
    const mk = (label: string, data: ArrayBufferView<ArrayBuffer>, usage: GPUBufferUsageFlags): GPUBuffer => {
      const b = device.createBuffer({ label, size: Math.max(16, Math.ceil(data.byteLength / 16) * 16), usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, data);
      temp.push(b);
      return b;
    };
    const pBuf = mk(`cockpit.occlusionBake.params.${lod}`, params, GPUBufferUsage.UNIFORM);
    const nBuf = mk(`cockpit.occlusionBake.nodes.${lod}`, new Uint8Array(bvh.nodes), GPUBufferUsage.STORAGE);
    const tBuf = mk(`cockpit.occlusionBake.tris.${lod}`, bvh.tris, GPUBufferUsage.STORAGE);
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: pBuf } },
        { binding: 1, resource: { buffer: nBuf } },
        { binding: 2, resource: { buffer: tBuf } },
        { binding: 3, resource: { buffer: vertex } },
        { binding: 4, resource: { buffer: out } },
      ],
    });
    const pass = enc.beginComputePass({ label: `cockpit.occlusionBake.${lod}` });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(range.count / 64));
    pass.end();
  }
  device.queue.submit([enc.finish()]);
  void device.queue.onSubmittedWorkDone().then(() => temp.forEach((b) => b.destroy()));
  return out;
}
