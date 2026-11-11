/**
 * Lab-only render features for the atmosphere lab (never used by the app):
 *
 *   sky      photometric sun disc and a procedural star field in drawBackground, so that the attenuation
 *            and reddening of what lies behind the atmosphere can be judged
 *   relief   mountain-like relief meshes on the LabPlanet out to 150 km from the site (aerial perspective)
 *   quads    camera-facing emissive quads: transparent ones drawn in drawTransparent through
 *            applyAtmosphere(), opaque ones in the G-buffer (the reference the transparents must match)
 *   volume   a half-resolution fog sphere marched in preTransparent and composited in drawTransparent
 *            through applyAtmosphere()
 *   heavy    a ballast pass that keeps the GPU as busy as a real frame while budgets are measured
 */
import type { DefLibrary } from '@/core/contracts/defs';
import { RENDER_FORMATS, type FrameContext, type MeshData, type RenderContext, type RenderFeature } from '@/core/contracts/render';
import { hash4, hashToUnit, quat, v3, type Vec3 } from '@/core/math';
import { cameraBasis, coreOf, instanceInFrame, type CoreApi, type ManagedTarget, type MeshBatch, type ModelHandle, type SceneBindings, type Tracked } from '@/render/core';
import { siteAlong, siteFrameFixed, sitePose, type Site } from './world';

// ------------------------------------------------------------------------------------------------- sky

const STAR_COUNT = 5000;

export function createLabSkyFeature(): RenderFeature {
  let ctx: RenderContext;
  let sun: Tracked<GPURenderPipeline>;
  let stars: Tracked<GPURenderPipeline>;
  let starBuffer: GPUBuffer;
  return {
    id: 'lab-sky',
    order: -50,
    init(c) {
      ctx = c;
      const core = coreOf(c);
      const depthStencil: GPUDepthStencilState = { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'equal' };
      sun = core.fullscreenPipeline({
        label: 'lab-sky.sun',
        fragment: /* wgsl */ `
          @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
            let d = normalize(viewRay(in.uv));
            let c = dot(d, frame.sunDir.xyz);
            let rs = frame.sunDir.w;
            let ang = acos(clamp(c, -1.0, 1.0));
            let px = 2.0 * frame.cameraUp.w * frame.renderSize.w;
            let edge = 1.0 - smoothstep(rs - px, rs + px, ang);
            if (edge <= 0.0) { discard; }
            // Mean disc luminance E / (pi sin^2), with linear limb darkening (u = 0.6) normalised to keep the flux.
            let mu = sqrt(max(1.0 - (ang * ang) / (rs * rs), 0.0));
            let limb = (1.0 - 0.6 * (1.0 - mu)) / 0.8;
            let lum = frame.sunIlluminance.rgb / (PI * sin(rs) * sin(rs)) * limb * edge;
            return vec4f(writeHdr(lum * frame.exposure.x), 1.0);
          }`,
        targets: [{ format: RENDER_FORMATS.hdr }],
        depthStencil,
      });
      // Stars: direction + illuminance (lux). Magnitudes follow the naked-eye number counts (N(<m) ~ 10^(0.5 m)).
      const data = new Float32Array(STAR_COUNT * 4);
      for (let i = 0; i < STAR_COUNT; i++) {
        const z = hashToUnit(hash4(i, 1, 0, 77)) * 2 - 1;
        const a = hashToUnit(hash4(i, 2, 0, 77)) * 2 * Math.PI;
        const r = Math.sqrt(Math.max(1 - z * z, 0));
        const lo = 10 ** (0.5 * -1);
        const hi = 10 ** (0.5 * 6.5);
        const m = Math.log10(lo + hashToUnit(hash4(i, 3, 0, 77)) * (hi - lo)) / 0.5;
        data.set([r * Math.cos(a), r * Math.sin(a), z, 2.54e-6 * 10 ** (-0.4 * m)], i * 4);
      }
      starBuffer = c.device.createBuffer({ label: 'lab-sky.stars', size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      c.device.queue.writeBuffer(starBuffer, 0, data);
      stars = core.shaders.tracked(() => {
        const module = c.shaders.createModule(
          'lab-sky.stars',
          /* wgsl */ `
          #include "frame"
          struct V { @builtin(position) position: vec4f, @location(0) offset: vec2f, @location(1) lux: f32 }
          const SIGMA = 0.7;
          @vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) star: vec4f) -> V {
            let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
            var o: V;
            // A direction at infinity: clip z = 0 = the sky depth of the reversed-Z projection.
            let clip = frame.viewProj * vec4f(star.xyz, 0.0);
            o.offset = corner * 3.0;
            o.position = vec4f(clip.xy + o.offset * 2.0 * frame.renderSize.zw * clip.w, 0.0, clip.w);
            o.lux = star.w;
            return o;
          }
          @fragment fn fs(in: V) -> @location(0) vec4f {
            let pixelAngle = 2.0 * frame.cameraUp.w * frame.renderSize.w;
            let peak = in.lux / (pixelAngle * pixelAngle * TWO_PI * SIGMA * SIGMA);
            let lum = peak * exp(-0.5 * dot(in.offset, in.offset) / (SIGMA * SIGMA));
            return vec4f(writeHdr(vec3f(lum * frame.exposure.x)), 1.0);
          }`,
        );
        return c.device.createRenderPipeline({
          label: 'lab-sky.stars',
          layout: c.device.createPipelineLayout({ bindGroupLayouts: [c.frameBindGroupLayout] }),
          vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }] },
          fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }] },
          primitive: { topology: 'triangle-strip' },
          depthStencil,
        });
      });
      sun.get();
      stars.get();
    },
    drawBackground(_frame, pass) {
      pass.setPipeline(stars.get());
      pass.setVertexBuffer(0, starBuffer);
      pass.draw(4, STAR_COUNT);
      pass.setPipeline(sun.get());
      pass.draw(3);
    },
    dispose() {
      starBuffer.destroy();
      void ctx;
    },
  };
}

// ---------------------------------------------------------------------------------------------- relief

/** A unit mountain massif: heights in [0, 1] over [-1, 1]^2 (x east, y north, z up), ridged, falling to 0 at the rim. */
function massifMesh(seed: number, n = 72): MeshData {
  const value = (x: number, y: number, s: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const h = (a: number, b: number): number => hashToUnit(hash4(ix + a, iy + b, s, seed));
    return (h(0, 0) * (1 - ux) + h(1, 0) * ux) * (1 - uy) + (h(0, 1) * (1 - ux) + h(1, 1) * ux) * uy;
  };
  const height = (x: number, y: number): number => {
    let amp = 0.5;
    let f = 1.7;
    let s = 0;
    for (let o = 0; o < 6; o++) {
      s += amp * (1 - Math.abs(2 * value(x * f + 13, y * f + 7, o) - 1));
      amp *= 0.5;
      f *= 2.03;
    }
    const r = Math.hypot(x, y * 1.15);
    const envelope = Math.max(0, 1 - r * r) ** 1.5;
    return envelope * (0.25 + 0.75 * s * s);
  };
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const tangents = new Float32Array(n * n * 4);
  const uvs = new Float32Array(n * n * 2);
  const at = (i: number, j: number): [number, number, number] => {
    const x = (i / (n - 1)) * 2 - 1;
    const y = (j / (n - 1)) * 2 - 1;
    return [x, y, height(x, y)];
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const p = at(i, j);
      positions.set(p, k * 3);
      const e = 2 / (n - 1);
      const dx = (height(p[0] + e, p[1]) - height(p[0] - e, p[1])) / (2 * e);
      const dy = (height(p[0], p[1] + e) - height(p[0], p[1] - e)) / (2 * e);
      const nrm = v3.normalize({ x: -dx, y: -dy, z: 1 });
      normals.set([nrm.x, nrm.y, nrm.z], k * 3);
      const tan = v3.normalize({ x: 1, y: 0, z: dx });
      tangents.set([tan.x, tan.y, tan.z, 1], k * 4);
      uvs.set([i / (n - 1), j / (n - 1)], k * 2);
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let o = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      indices.set([a, a + 1, a + n + 1, a, a + n + 1, a + n], o);
      o += 6;
    }
  }
  return { positions, normals, tangents, uvs, indices, groups: [{ material: 0, start: 0, count: indices.length }], bounds: { min: [-1, -1, 0], max: [1, 1, 1] } };
}

/** Relief placed by great-circle heading (deg) and distance (m) from the site: half width and height in metres. */
export const RELIEF_LAYOUT: readonly { heading: number; distance: number; halfWidth: number; height: number; seed: number }[] = [
  { heading: 20, distance: 4000, halfWidth: 1500, height: 420, seed: 1 },
  { heading: 55, distance: 9000, halfWidth: 3500, height: 900, seed: 2 },
  { heading: 350, distance: 16000, halfWidth: 6000, height: 1500, seed: 3 },
  { heading: 30, distance: 28000, halfWidth: 9000, height: 2300, seed: 4 },
  { heading: 70, distance: 50000, halfWidth: 14000, height: 3200, seed: 5 },
  { heading: 5, distance: 60000, halfWidth: 16000, height: 3600, seed: 6 },
  { heading: 40, distance: 90000, halfWidth: 22000, height: 4300, seed: 7 },
  { heading: 330, distance: 110000, halfWidth: 26000, height: 4600, seed: 8 },
  { heading: 15, distance: 150000, halfWidth: 32000, height: 5200, seed: 9 },
  { heading: 200, distance: 12000, halfWidth: 4500, height: 1100, seed: 10 },
  { heading: 240, distance: 45000, halfWidth: 13000, height: 3000, seed: 11 },
  { heading: 280, distance: 80000, halfWidth: 20000, height: 4000, seed: 12 },
  { heading: 160, distance: 70000, halfWidth: 18000, height: 3800, seed: 13 },
  { heading: 120, distance: 30000, halfWidth: 9000, height: 2200, seed: 14 },
];

export function createLabReliefFeature(site: Site, defs: DefLibrary): RenderFeature {
  let ctx: RenderContext;
  let batch: MeshBatch;
  const models: ModelHandle[] = [];
  const placed = RELIEF_LAYOUT.map((r) => ({ ...r, frame: siteFrameFixed(siteAlong(site, r.heading, r.distance, defs, -0.04 * r.height), defs) }));
  return {
    id: 'lab-relief',
    order: -90,
    init(c) {
      ctx = c;
      const core = coreOf(c);
      batch = core.meshes.createBatch('lab-relief');
      for (let k = 0; k < 4; k++) {
        models.push(
          core.meshes.createModel({
            name: `lab-relief-${k}`,
            lods: [massifMesh(40 + k)],
            materials: [{ name: 'rock', shading: 'terrain', baseColor: [0.16 + 0.03 * k, 0.14 + 0.02 * k, 0.11 + 0.01 * k], metallic: 0, roughness: 0.92 }],
          }),
        );
      }
    },
    prepare(frame) {
      const body = frame.bodyPose(site.bodyId);
      const parent = { originRelCam: body.centerRelCam, q: body.qFixedToRoot, prevOriginRelCam: body.prevCenterRelCam, prevQ: body.prevQFixedToRoot };
      batch.begin(frame);
      placed.forEach((p, i) => {
        batch.add(models[i % models.length]!, instanceInFrame(parent, p.frame.posFixed, p.frame.qEnuToFixed, { bodyFixed: true, scale: [p.halfWidth, p.halfWidth, p.height] }));
      });
      batch.finish();
    },
    drawGBuffer(_frame, pass) {
      batch.drawGBuffer(pass);
    },
    drawShadow(_frame, pass, cascade) {
      batch.drawShadow(pass, cascade);
    },
    isIdle: () => coreOf(ctx).meshes.isIdle(),
  };
}

// ----------------------------------------------------------------------------------------------- quads

export interface LabQuad {
  id: string;
  /** 'transparent': drawTransparent through applyAtmosphere(); 'opaque': emissive G-buffer surface. */
  kind: 'transparent' | 'opaque';
  /** Where: fixed to the view (NDC x, y and distance from the eye), or at a point of the site's ENU frame (m). */
  place: { type: 'view'; ndc: [number, number]; distance: number } | { type: 'site'; enu: [number, number, number] };
  /** Half size, m. */
  halfSize: number;
  /** Emitted luminance, cd/m^2 (linear sRGB), and opacity (transparent quads). */
  luminance: [number, number, number];
  alpha?: number;
}

export interface LabQuads {
  feature: RenderFeature;
  set(quads: LabQuad[]): void;
  /** Render-target pixel of a quad's centre and its distance from the eye in the frame last prepared (null when behind the camera). */
  project(id: string): { x: number; y: number; distance: number } | null;
}

const QUAD_WGSL = /* wgsl */ `
struct QuadU {
  centre: vec4f,   // xyz = centre relative to the camera, w = half size (m)
  right: vec4f,
  up: vec4f,
  colour: vec4f,   // rgb = luminance (cd/m^2), a = opacity
}
@group(1) @binding(0) var<uniform> quad: QuadU;
struct QuadV { @builtin(position) position: vec4f, @location(0) pos: vec3f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> QuadV {
  let corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = corners[vi] * quad.centre.w;
  var o: QuadV;
  o.pos = quad.centre.xyz + quad.right.xyz * c.x + quad.up.xyz * c.y;
  o.position = frame.viewProj * vec4f(o.pos, 1.0);
  return o;
}`;

export function createLabQuads(site: Site, defs: DefLibrary): LabQuads {
  let ctx: RenderContext;
  let core: CoreApi;
  let transparent: Tracked<GPURenderPipeline>;
  let opaque: Tracked<GPURenderPipeline>;
  let quadLayout: GPUBindGroupLayout;
  let transpLayout: GPUBindGroupLayout;
  let transp: SceneBindings;
  let transpGroup: GPUBindGroup | null = null;
  let transpVersion = -1;
  let quads: LabQuad[] = [];
  const slots: { buffer: GPUBuffer; group: GPUBindGroup }[] = [];
  const projected = new Map<string, { x: number; y: number; distance: number } | null>();
  const data = new Float32Array(16);

  const centreOf = (q: LabQuad, frame: FrameContext): Vec3 => {
    const basis = cameraBasis(frame.camera);
    if (q.place.type === 'view') {
      const tanY = Math.tan(frame.camera.fovY / 2);
      const tanX = (tanY * frame.renderSize[0]) / frame.renderSize[1];
      const dir = v3.normalize(v3.add(basis.forward, v3.add(v3.scale(basis.right, q.place.ndc[0] * tanX), v3.scale(basis.up, q.place.ndc[1] * tanY))));
      return v3.scale(dir, q.place.distance);
    }
    const pose = sitePose(site, frame.bodyPose(site.bodyId), defs);
    return v3.add(pose.originRelCam, quat.rotate(pose.q, v3.fromTuple(q.place.enu)));
  };

  const feature: RenderFeature = {
    id: 'lab-quads',
    order: 30,
    init(c) {
      ctx = c;
      core = coreOf(c);
      const device = c.device;
      quadLayout = device.createBindGroupLayout({ label: 'lab-quads', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      transp = core.createSceneBindings(2, 0, ['transparency']);
      transpLayout = device.createBindGroupLayout({ label: 'lab-quads.transparency', entries: transp.layoutEntries });
      transparent = core.shaders.tracked(() => {
        const module = c.shaders.createModule(
          'lab-quads.transparent',
          /* wgsl */ `
          #include "frame"
          #include "transparency"
          ${QUAD_WGSL}
          ${transp.wgsl}
          @fragment fn fs(in: QuadV) -> @location(0) vec4f {
            let uv = in.position.xy * frame.renderSize.zw;
            let a = quad.colour.a;
            let c = applyAtmosphere(uv, length(in.pos), quad.colour.rgb * (frame.exposure.x * a), a);
            return vec4f(writeHdr(c.rgb), c.a);
          }`,
        );
        return device.createRenderPipeline({
          label: 'lab-quads.transparent',
          layout: device.createPipelineLayout({ bindGroupLayouts: [c.frameBindGroupLayout, quadLayout, transpLayout] }),
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' },
        });
      });
      opaque = core.shaders.tracked(() => {
        const module = c.shaders.createModule(
          'lab-quads.opaque',
          /* wgsl */ `
          #include "frame"
          #include "gbuffer"
          ${QUAD_WGSL}
          @fragment fn fs(in: QuadV) -> GBufferOut {
            // A black surface that only emits; its normal is turned away from the sun so that nothing lights it.
            return gbufferPack(vec3f(0.0), 1.0, -frame.sunDir.xyz, 1.0, 0.0, MATERIAL_STANDARD, 0.0, vec2f(0.0), quad.colour.rgb * frame.exposure.x);
          }`,
        );
        return device.createRenderPipeline({
          label: 'lab-quads.opaque',
          layout: device.createPipelineLayout({ bindGroupLayouts: [c.frameBindGroupLayout, quadLayout] }),
          vertex: { module, entryPoint: 'vs' },
          fragment: {
            module,
            entryPoint: 'fs',
            targets: [
              { format: RENDER_FORMATS.gbufferAlbedo },
              { format: RENDER_FORMATS.gbufferNormal },
              { format: RENDER_FORMATS.gbufferMaterial },
              { format: RENDER_FORMATS.gbufferVelocity },
              { format: RENDER_FORMATS.gbufferExtra },
              { format: RENDER_FORMATS.hdr },
            ],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'greater' },
        });
      });
      transparent.get();
      opaque.get();
    },
    prepare(frame) {
      const device = ctx.device;
      const basis = cameraBasis(frame.camera);
      projected.clear();
      quads.forEach((q, i) => {
        if (!slots[i]) {
          const buffer = device.createBuffer({ label: `lab-quads.${i}`, size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
          slots[i] = { buffer, group: device.createBindGroup({ layout: quadLayout, entries: [{ binding: 0, resource: { buffer } }] }) };
        }
        const c = centreOf(q, frame);
        data.set([c.x, c.y, c.z, q.halfSize, basis.right.x, basis.right.y, basis.right.z, 0, basis.up.x, basis.up.y, basis.up.z, 0, q.luminance[0], q.luminance[1], q.luminance[2], q.alpha ?? 1]);
        device.queue.writeBuffer(slots[i]!.buffer, 0, data);
        const z = v3.dot(c, basis.forward);
        if (z <= 0) projected.set(q.id, null);
        else {
          const tanY = Math.tan(frame.camera.fovY / 2);
          const tanX = (tanY * frame.renderSize[0]) / frame.renderSize[1];
          projected.set(q.id, {
            x: (0.5 + (0.5 * v3.dot(c, basis.right)) / (z * tanX)) * frame.renderSize[0],
            y: (0.5 - (0.5 * v3.dot(c, basis.up)) / (z * tanY)) * frame.renderSize[1],
            distance: v3.len(c),
          });
        }
      });
    },
    drawGBuffer(_frame, pass) {
      quads.forEach((q, i) => {
        if (q.kind !== 'opaque' || !slots[i]) return;
        pass.setPipeline(opaque.get());
        pass.setBindGroup(1, slots[i].group);
        pass.draw(6);
      });
    },
    drawTransparent(_frame, pass) {
      const v = transp.version();
      if (!transpGroup || v !== transpVersion) {
        transpVersion = v;
        transpGroup = ctx.device.createBindGroup({ label: 'lab-quads.transparency', layout: transpLayout, entries: transp.entries() });
      }
      quads.forEach((q, i) => {
        if (q.kind !== 'transparent' || !slots[i]) return;
        pass.setPipeline(transparent.get());
        pass.setBindGroup(1, slots[i].group);
        pass.setBindGroup(2, transpGroup!);
        pass.draw(6);
      });
    },
  };
  return {
    feature,
    set(list) {
      quads = list;
    },
    project: (id) => projected.get(id) ?? null,
  };
}

// ---------------------------------------------------------------------------------------------- volume

export interface LabVolume {
  feature: RenderFeature;
  /** Place the fog sphere at a point of the site's ENU frame (m); null hides it. */
  set(v: { enu: [number, number, number]; radius: number; luminance: [number, number, number]; density: number } | null): void;
  project(): { x: number; y: number; radius: number; distance: number } | null;
}

/** A uniform emissive fog sphere marched at half resolution: the pattern every plume and smoke volume follows. */
export function createLabVolume(site: Site, defs: DefLibrary): LabVolume {
  let ctx: RenderContext;
  let core: CoreApi;
  let target: ManagedTarget;
  let uniform: GPUBuffer;
  let marchLayout: GPUBindGroupLayout;
  let compLayout: GPUBindGroupLayout;
  let march: Tracked<GPURenderPipeline>;
  let comp: Tracked<GPURenderPipeline>;
  let transp: SceneBindings;
  let marchGroup: GPUBindGroup | null = null;
  let compGroup: GPUBindGroup | null = null;
  let key = '';
  let volume: Parameters<LabVolume['set']>[0] = null;
  let projected: ReturnType<LabVolume['project']> = null;
  const data = new Float32Array(8);
  const U = /* wgsl */ `struct VolU { centre: vec4f, colour: vec4f }   // centre.w = radius (m); colour.rgb = luminance (cd/m^2), a = extinction per metre
    @group(1) @binding(0) var<uniform> vol: VolU;
    @group(1) @binding(1) var depthHalfTex: texture_2d<f32>;`;
  const feature: RenderFeature = {
    id: 'lab-volume',
    order: 31,
    init(c) {
      ctx = c;
      core = coreOf(c);
      target = core.createTarget('lab-volume.half', 'rgba16float', 0.5);
      uniform = c.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const F = GPUShaderStage.FRAGMENT;
      marchLayout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, buffer: { type: 'uniform' } }, { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float' } }] });
      transp = core.createSceneBindings(1, 4, ['transparency']);
      compLayout = c.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: F, buffer: { type: 'uniform' } },
          { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float' } },
          { binding: 2, visibility: F, texture: { sampleType: 'float' } },
          { binding: 3, visibility: F, texture: { sampleType: 'depth' } },
          ...transp.layoutEntries,
        ],
      });
      march = core.fullscreenPipeline({
        label: 'lab-volume.march',
        layouts: [marchLayout],
        fragment: /* wgsl */ `${U}
          @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
            let ray = viewRay(in.uv);
            let len = length(ray);
            let d = ray / len;
            let tScene = viewZFromDepth(textureLoad(depthHalfTex, vec2i(in.position.xy), 0).r) * len;
            let b = dot(d, vol.centre.xyz);
            let disc = b * b - dot(vol.centre.xyz, vol.centre.xyz) + vol.centre.w * vol.centre.w;
            if (disc <= 0.0) { return vec4f(0.0); }
            let s = sqrt(disc);
            let t0 = max(b - s, 0.0);
            let t1 = min(b + s, tScene);
            if (t1 <= t0) { return vec4f(0.0); }
            let alpha = 1.0 - exp(-(t1 - t0) * vol.colour.a);
            return vec4f(writeHdr(vol.colour.rgb * frame.exposure.x * alpha), alpha);
          }`,
        targets: [{ format: 'rgba16float' }],
      });
      comp = core.fullscreenPipeline({
        label: 'lab-volume.composite',
        layouts: [compLayout],
        fragment: /* wgsl */ `#include "upsample"
          #include "transparency"
          ${U}
          @group(1) @binding(2) var volTex: texture_2d<f32>;
          @group(1) @binding(3) var depthTex: texture_depth_2d;
          ${transp.wgsl}
          @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
            let v = upsampleDepthAware(volTex, depthHalfTex, in.uv, textureLoad(depthTex, vec2i(in.position.xy), 0), false);
            if (v.a <= 0.0) { discard; }
            let c = applyAtmosphere(in.uv, length(vol.centre.xyz), v.rgb, v.a);
            return vec4f(writeHdr(c.rgb), c.a);
          }`,
        targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
      });
      march.get();
      comp.get();
    },
    prepare(frame) {
      projected = null;
      if (!volume) return;
      const pose = sitePose(site, frame.bodyPose(site.bodyId), defs);
      const c = v3.add(pose.originRelCam, quat.rotate(pose.q, v3.fromTuple(volume.enu)));
      data.set([c.x, c.y, c.z, volume.radius, volume.luminance[0], volume.luminance[1], volume.luminance[2], volume.density]);
      ctx.device.queue.writeBuffer(uniform, 0, data);
      const basis = cameraBasis(frame.camera);
      const z = v3.dot(c, basis.forward);
      if (z > 0) {
        const tanY = Math.tan(frame.camera.fovY / 2);
        const tanX = (tanY * frame.renderSize[0]) / frame.renderSize[1];
        projected = {
          x: (0.5 + (0.5 * v3.dot(c, basis.right)) / (z * tanX)) * frame.renderSize[0],
          y: (0.5 - (0.5 * v3.dot(c, basis.up)) / (z * tanY)) * frame.renderSize[1],
          radius: ((volume.radius / z) * frame.renderSize[1]) / (2 * tanY),
          distance: v3.len(c),
        };
      }
    },
    preTransparent(frame, encoder) {
      if (!volume) return;
      const k = [target.version, ctx.resources.version('scene.depthHalf'), ctx.resources.version('scene.depth'), transp.version()].join(':');
      if (k !== key || !marchGroup) {
        key = k;
        marchGroup = ctx.device.createBindGroup({ layout: marchLayout, entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: ctx.resources.get('scene.depthHalf') }] });
        compGroup = ctx.device.createBindGroup({
          layout: compLayout,
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: ctx.resources.get('scene.depthHalf') },
            { binding: 2, resource: target.view },
            { binding: 3, resource: ctx.resources.get('scene.depth') },
            ...transp.entries(),
          ],
        });
      }
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-volume.march') as GPURenderPassTimestampWrites | undefined });
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setPipeline(march.get());
      pass.setBindGroup(1, marchGroup);
      pass.draw(3);
      pass.end();
    },
    drawTransparent(_frame, pass) {
      if (!volume || !compGroup) return;
      pass.setPipeline(comp.get());
      pass.setBindGroup(1, compGroup);
      pass.draw(3);
    },
  };
  return {
    feature,
    set(v) {
      volume = v;
    },
    project: () => projected,
  };
}

// ----------------------------------------------------------------------------------------------- heavy

export interface LabHeavy {
  feature: RenderFeature;
  set(iterations: number): void;
}

/**
 * Ballast: a fullscreen pass whose cost is `iterations`, encoded first in the frame (compute hook) with an
 * empty pass of its own behind it, so that its tail is not charged to the pass that follows.
 */
export function createLabHeavy(initial: number): LabHeavy {
  let ctx: RenderContext;
  let pipeline: Tracked<GPURenderPipeline>;
  let target: ManagedTarget;
  let uniform: GPUBuffer;
  let group: GPUBindGroup;
  let iterations = initial;
  const feature: RenderFeature = {
    id: 'lab-heavy',
    order: -200,
    init(c) {
      ctx = c;
      const core = coreOf(c);
      target = core.createTarget('lab-heavy.scratch', 'rgba16float', 1);
      uniform = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const layout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      group = c.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
      pipeline = core.fullscreenPipeline({
        label: 'lab-heavy.burn',
        layouts: [layout],
        fragment: /* wgsl */ `struct HeavyU { v: vec4f }
          @group(1) @binding(0) var<uniform> heavy: HeavyU;
          @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
            var a = vec3f(in.uv, 0.5);
            for (var i = 0; i < i32(heavy.v.x); i++) { a = fract(sin(a.yzx * 12.9898 + a.zxy * 78.233 + f32(i)) * 43758.5453); }
            return vec4f(a, 1.0);
          }`,
        targets: [{ format: 'rgba16float' }],
      });
      pipeline.get();
    },
    prepare() {
      ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([iterations, 0, 0, 0]));
    },
    compute(frame, encoder) {
      if (iterations <= 0) return;
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-heavy.burn') as GPURenderPassTimestampWrites | undefined });
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setPipeline(pipeline.get());
      pass.setBindGroup(1, group);
      pass.draw(3);
      pass.end();
      encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-heavy.tail') as GPURenderPassTimestampWrites | undefined }).end();
    },
  };
  return {
    feature,
    set(n) {
      iterations = n;
    },
  };
}
