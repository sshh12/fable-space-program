/**
 * Lab-only scenery for the vfx lab (never shipped): stand-in vehicle geometry built from PartDef.bounds, a
 * pad with a launch mount, a moving occluder, a sky backdrop with matching ambient light, and synthetic
 * cloud / aerial-perspective resources for the applyAtmosphere tests.
 */
import type { DefLibrary, PartDef } from '@/core/contracts/defs';
import { RENDER_FORMATS, type FrameContext, type MeshData, type PbrMaterialDef, type RenderContext, type RenderFeature } from '@/core/contracts/render';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, quat, v3, type Quat, type Vec3, type Vec3Tuple } from '@/core/math';
import { boxMesh, coreOf, f32ToF16, instanceInFrame, type ManagedTarget, type MeshBatch, type ModelHandle, type ParentPose, type Tracked } from '@/render/core';
import type { LabSim } from './labSim';

/** Surface of revolution about +Y from a profile of [radius, y] points (bottom to top), closed with flat caps. */
export function latheMesh(profile: [number, number][], segments = 48): MeshData {
  const p: number[] = [];
  const n: number[] = [];
  const t: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const min: Vec3Tuple = [Infinity, Infinity, Infinity];
  const max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
  const vertex = (pos: Vec3Tuple, nrm: Vec3Tuple, tan: Vec3Tuple, u: number, v: number): number => {
    p.push(...pos);
    n.push(...nrm);
    t.push(...tan, 1);
    uv.push(u, v);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, pos[k]!);
      max[k] = Math.max(max[k]!, pos[k]!);
    }
    return p.length / 3 - 1;
  };
  for (let s = 0; s + 1 < profile.length; s++) {
    const [r0, y0] = profile[s]!;
    const [r1, y1] = profile[s + 1]!;
    const len = Math.hypot(r1 - r0, y1 - y0) || 1;
    const nr = (y1 - y0) / len;
    const ny = -(r1 - r0) / len;
    const base = p.length / 3;
    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      const a = u * 2 * Math.PI;
      const c = Math.cos(a);
      const sn = -Math.sin(a);
      vertex([c * r0, y0, sn * r0], [c * nr, ny, sn * nr], [sn, 0, -c], u, 0);
      vertex([c * r1, y1, sn * r1], [c * nr, ny, sn * nr], [sn, 0, -c], u, 1);
    }
    for (let i = 0; i < segments; i++) {
      const a = base + i * 2;
      idx.push(a, a + 3, a + 1, a, a + 2, a + 3);
    }
  }
  for (const end of [0, profile.length - 1]) {
    const [r, y] = profile[end]!;
    if (r < 1e-6) continue;
    const s = end === 0 ? -1 : 1;
    const centre = vertex([0, y, 0], [0, s, 0], [1, 0, 0], 0.5, 0.5);
    const first = p.length / 3;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * 2 * Math.PI;
      vertex([Math.cos(a) * r, y, -Math.sin(a) * r], [0, s, 0], [1, 0, 0], 0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
    }
    for (let i = 0; i < segments; i++) {
      if (s > 0) idx.push(centre, first + i, first + i + 1);
      else idx.push(centre, first + i + 1, first + i);
    }
  }
  return {
    positions: new Float32Array(p),
    normals: new Float32Array(n),
    tangents: new Float32Array(t),
    uvs: new Float32Array(uv),
    indices: new Uint32Array(idx),
    groups: [{ material: 0, start: 0, count: idx.length }],
    bounds: { min, max },
  };
}

const MATERIALS: Record<string, PbrMaterialDef> = {
  paint: { name: 'paint', shading: 'standard', baseColor: [0.78, 0.78, 0.76], metallic: 0, roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.4 },
  metal: { name: 'metal', shading: 'standard', baseColor: [0.32, 0.31, 0.3], metallic: 0.9, roughness: 0.45 },
  foil: { name: 'foil', shading: 'standard', baseColor: [0.75, 0.6, 0.3], metallic: 0.8, roughness: 0.4 },
  shield: { name: 'shield', shading: 'standard', baseColor: [0.16, 0.13, 0.11], metallic: 0, roughness: 0.9 },
  concrete: { name: 'concrete', shading: 'terrain', baseColor: [0.36, 0.35, 0.33], metallic: 0, roughness: 0.95 },
  steel: { name: 'steel', shading: 'standard', baseColor: [0.42, 0.43, 0.45], metallic: 0.6, roughness: 0.6 },
  occluder: { name: 'occluder', shading: 'standard', baseColor: [0.6, 0.1, 0.1], metallic: 0, roughness: 0.8 },
};

function partProfile(def: PartDef): { profile: [number, number][]; material: string } | null {
  const b = def.bounds;
  const h = b.yMax - b.yMin;
  const R = b.radius;
  if (def.modules.some((m) => m.type === 'legs') || def.category === 'chute') return null;
  if (def.modules.some((m) => m.type === 'les')) {
    return { profile: [[R, b.yMin], [R * 0.95, b.yMin + 0.28 * h], [0.24 * R, b.yMin + 0.42 * h], [0.2 * R, b.yMax - 0.5], [0.02, b.yMax]], material: 'paint' };
  }
  if (def.category === 'command') {
    return { profile: [[0.82 * R, b.yMin], [R, b.yMin + 0.14 * h], [0.34 * R, b.yMax]], material: 'shield' };
  }
  if (def.category === 'engine') {
    return { profile: [[R, b.yMin], [0.8 * R, b.yMin + 0.3 * h], [0.42 * R, b.yMin + 0.72 * h], [0.5 * R, b.yMax]], material: 'metal' };
  }
  if (def.modules.some((m) => m.type === 'fairing')) return { profile: [[R, b.yMin], [R, b.yMin + 0.7 * h], [0.62 * R, b.yMax]], material: 'paint' };
  return { profile: [[R, b.yMin], [R, b.yMax]], material: def.category === 'structural' || def.category === 'decoupler' ? 'steel' : 'paint' };
}

export interface LabPropsOptions {
  /** Draw the pad disc and launch mount at the site origin (pad surface = site altitude). */
  pad?: { radius: number; mountHeight: number; trenchHeadingDeg: number } | null;
  /** Hide the stand-in geometry of parts whose def id is listed. */
  hideParts?: string[];
}

export interface LabProps {
  feature: RenderFeature;
  /** A slab (width x height x 0.4 m) whose centre follows `enu(t)` in the site frame; null = off. */
  setOccluder(o: { size: [number, number]; enu: (t: number) => Vec3; yawDeg: number } | null): void;
  /** Current centre of the occluder in the site frame. */
  occluderEnu(): Vec3 | null;
}

export function createLabProps(sim: LabSim, defs: DefLibrary, options: LabPropsOptions = {}): LabProps {
  let ctx: RenderContext;
  let batch: MeshBatch;
  const models = new Map<string, ModelHandle | null>();
  let padModels: { model: ModelHandle; pos: Vec3; rot: Quat | null }[] = [];
  let occluder: { size: [number, number]; enu: (t: number) => Vec3; yawDeg: number } | null = null;
  let occluderModel: ModelHandle | null = null;
  let occluderSize = '';
  let strut: ModelHandle;
  let footPad: ModelHandle;

  const modelFor = (def: PartDef): ModelHandle | null => {
    if (models.has(def.id)) return models.get(def.id)!;
    const spec = options.hideParts?.includes(def.id) ? null : partProfile(def);
    const model = spec ? coreOf(ctx).meshes.createModel({ name: `lab.${def.id}`, lods: [latheMesh(spec.profile)], materials: [MATERIALS[spec.material]!] }) : null;
    models.set(def.id, model);
    return model;
  };

  const sitePose = (frame: FrameContext): ParentPose => {
    const pose = frame.bodyPose(sim.site.bodyId);
    const dir = latLonToDir(sim.site.latDeg * DEG, sim.site.lonDeg * DEG);
    let e = v3.cross(v3.unitZ(), dir);
    e = v3.lenSq(e) < 1e-12 ? v3.unitY() : v3.normalize(e);
    const n = v3.cross(dir, e);
    const qEnuToFixed = quat.fromBasis(e, n, dir);
    const pFixed = v3.scale(dir, defs.bodies[sim.site.bodyId]!.radius + sim.site.alt);
    return {
      originRelCam: v3.add(pose.centerRelCam, quat.rotate(pose.qFixedToRoot, pFixed)),
      q: quat.mul(pose.qFixedToRoot, qEnuToFixed),
      prevOriginRelCam: v3.add(pose.prevCenterRelCam, quat.rotate(pose.prevQFixedToRoot, pFixed)),
      prevQ: quat.mul(pose.prevQFixedToRoot, qEnuToFixed),
    };
  };

  const feature: RenderFeature = {
    id: 'lab-props',
    order: -50,
    init(c) {
      ctx = c;
      const meshes = coreOf(c).meshes;
      batch = meshes.createBatch('lab-props');
      strut = meshes.createModel({ name: 'lab.strut', lods: [latheMesh([[0.09, 0], [0.09, 1]], 12)], materials: [MATERIALS.steel!] });
      footPad = meshes.createModel({ name: 'lab.footPad', lods: [latheMesh([[0.45, -0.08], [0.45, 0.04]], 20)], materials: [MATERIALS.foil!] });
      const pad = options.pad;
      if (pad) {
        const up: Quat = quat.fromAxisAngle(v3.unitX(), Math.PI / 2); // lathe +Y -> ENU +Z
        const disc = meshes.createModel({
          name: 'lab.pad',
          lods: [latheMesh([[pad.radius * 2.2, -Math.max(sim.site.alt, 1) - 2], [pad.radius, 0]], 96)],
          materials: [MATERIALS.concrete!],
        });
        padModels.push({ model: disc, pos: v3.zero(), rot: up });
        const h = pad.mountHeight;
        const pillar = meshes.createModel({ name: 'lab.pillar', lods: [boxMesh(2.6, 2.6, h - 1.2)], materials: [MATERIALS.steel!] });
        const beam = meshes.createModel({ name: 'lab.beam', lods: [boxMesh(18.5, 2.4, 1.6)], materials: [MATERIALS.steel!] });
        for (let k = 0; k < 4; k++) {
          const a = (45 + 90 * k) * DEG;
          padModels.push({ model: pillar, pos: { x: 10.2 * Math.sin(a), y: 10.2 * Math.cos(a), z: (h - 1.2) / 2 }, rot: null });
          const b = 90 * k * DEG;
          padModels.push({ model: beam, pos: { x: 7.3 * Math.sin(b), y: 7.3 * Math.cos(b), z: h - 1.0 }, rot: quat.fromAxisAngle(v3.unitZ(), -b) });
        }
        // Flame deflector under the mount and two trench walls along the trench heading.
        const th = pad.trenchHeadingDeg * DEG;
        const dirE = { x: Math.sin(th), y: Math.cos(th), z: 0 };
        const side = { x: Math.cos(th), y: -Math.sin(th), z: 0 };
        const yaw = quat.fromAxisAngle(v3.unitZ(), -th);
        const deflector = meshes.createModel({ name: 'lab.deflector', lods: [boxMesh(13, 16, 1.2)], materials: [MATERIALS.concrete!] });
        padModels.push({ model: deflector, pos: v3.add(v3.scale(dirE, -3.5), { x: 0, y: 0, z: 4.2 }), rot: quat.mul(yaw, quat.fromAxisAngle(v3.unitX(), -32 * DEG)) });
        const wall = meshes.createModel({ name: 'lab.trenchWall', lods: [boxMesh(1.5, 74, 5)], materials: [MATERIALS.concrete!] });
        for (const s of [-1, 1]) padModels.push({ model: wall, pos: v3.add(v3.add(v3.scale(dirE, 40), v3.scale(side, 9.5 * s)), { x: 0, y: 0, z: 2.5 }), rot: yaw });
      }
    },
    prepare(frame) {
      batch.begin(frame);
      for (const vessel of frame.snapshot.vessels) {
        const pose = frame.vesselPose(vessel.id);
        if (!pose) continue;
        for (const part of vessel.parts) {
          const def = defs.parts[part.def];
          if (!def || part.instanceId.includes('#panel')) continue;
          const model = modelFor(def);
          if (model) batch.add(model, instanceInFrame(pose, part.localPos, part.localRot, { bodyFixed: false }));
          // Landing legs: a strut from each hinge to its foot and a pad there.
          def.modules.forEach((m, mi) => {
            const state = part.modules[mi];
            if (m.type !== 'legs' || state?.type !== 'legs') return;
            const d = state.deploy * state.deploy * (3 - 2 * state.deploy);
            for (const leg of m.legs) {
              const hinge = v3.fromTuple(leg.hinge);
              const foot = v3.lerp(v3.fromTuple(leg.footStowed), v3.fromTuple(leg.footDeployed), d);
              const span = v3.sub(foot, hinge);
              const rot = quat.mul(part.localRot, quat.fromTo(v3.unitY(), v3.normalize(span)));
              batch.add(strut, { ...instanceInFrame(pose, v3.add(part.localPos, quat.rotate(part.localRot, hinge)), rot, { bodyFixed: false }), scale: [1, v3.len(span), 1] });
              batch.add(footPad, instanceInFrame(pose, v3.add(part.localPos, quat.rotate(part.localRot, foot)), part.localRot, { bodyFixed: false }));
            }
          });
        }
      }
      const site = sitePose(frame);
      for (const m of padModels) batch.add(m.model, instanceInFrame(site, m.pos, m.rot, { bodyFixed: true }));
      if (occluder) {
        const key = occluder.size.join('x');
        if (!occluderModel || key !== occluderSize) {
          occluderSize = key;
          occluderModel = coreOf(ctx).meshes.createModel({ name: 'lab.occluder', lods: [boxMesh(occluder.size[0], 0.4, occluder.size[1])], materials: [MATERIALS.occluder!] });
        }
        batch.add(occluderModel, instanceInFrame(site, occluder.enu(sim.time), quat.fromAxisAngle(v3.unitZ(), -occluder.yawDeg * DEG), { bodyFixed: false }));
      }
      batch.finish();
    },
    drawGBuffer(_f, pass) {
      batch.drawGBuffer(pass);
    },
    drawShadow(_f, pass, cascade) {
      batch.drawShadow(pass, cascade);
    },
    isIdle: () => coreOf(ctx).meshes.isIdle(),
  };
  return {
    feature,
    setOccluder(o) {
      occluder = o;
    },
    occluderEnu: () => (occluder ? occluder.enu(sim.time) : null),
  };
}

// --------------------------------------------------------------------------------------------- sky

export interface LabSky {
  feature: RenderFeature;
  /** Synthetic overcast deck `altitude` metres above the site (null = off): published as 'clouds.screen' / 'clouds.depth' and drawn. */
  setOvercast(o: { altitude: number; transmittance: number } | null): void;
  /** Synthetic aerial-perspective volume: transmittance exp(-d / length), in-scatter towards `luminance` (cd/m^2); null = neutral. */
  setHaze(h: { length: number; luminance: Vec3Tuple } | null): void;
}

const SKY_FS = /* wgsl */ `
struct SkyU { zenith: vec4f, horizon: vec4f }
@group(1) @binding(0) var<uniform> sky: SkyU;
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let d = normalize(viewRay(in.uv));
  let bi = nearestBody(vec3f(0.0));
  if (bi < 0) { discard; }
  let b = frame.bodies[bi];
  let h = max(dot(d, b.cameraUp.xyz), 0.0);
  let c = mix(sky.horizon.rgb, sky.zenith.rgb, pow(h, 0.45));
  return vec4f(writeHdr(c * frame.exposure.x), 1.0);
}
`;

const OVERCAST_FS = /* wgsl */ `
struct CloudU { v: vec4f, up: vec4f }   // v: deck height above the camera (m), transmittance, luminance below, luminance above; up: local vertical
@group(1) @binding(0) var<uniform> cloud: CloudU;
@group(1) @binding(1) var depthHalfTex: texture_2d<f32>;
struct O { @location(0) screen: vec4f, @location(1) depth: vec4f }
@fragment fn fs(in: FullscreenOut) -> O {
  let ray = viewRay(in.uv);
  let len = length(ray);
  let d = ray / len;
  let tScene = viewZFromDepth(textureLoad(depthHalfTex, vec2i(in.position.xy), 0).r) * len;
  let mu = dot(d, cloud.up.xyz);
  var o: O;
  o.screen = vec4f(0.0, 0.0, 0.0, 1.0);
  o.depth = vec4f(3.0e38, 0.0, 0.0, 0.0);
  let t = cloud.v.x / mu;
  if (abs(mu) > 1e-4 && t > 0.0 && t < tScene && t < 4.0e5) {
    let lum = select(cloud.v.w, cloud.v.z, cloud.v.x > 0.0);
    o.screen = vec4f(writeHdr(vec3f(lum) * frame.exposure.x * (1.0 - cloud.v.y)), cloud.v.y);
    o.depth = vec4f(t, 0.0, 0.0, 0.0);
  }
  return o;
}
`;

const OVERCAST_BLEND_FS = /* wgsl */ `
@group(1) @binding(0) var screenTex: texture_2d<f32>;
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  return textureSampleLevel(screenTex, linearClamp, in.uv, 0.0);
}
`;

export function createLabSky(sim: LabSim, defs: DefLibrary): LabSky {
  let ctx: RenderContext;
  let skyPipeline: Tracked<GPURenderPipeline>;
  let skyUniform: GPUBuffer;
  let skyGroup: GPUBindGroup;
  let shBuffer: GPUBuffer;
  let irradiance: GPUTexture;
  let overcast: { altitude: number; transmittance: number } | null = null;
  let overcastPublished = false;
  let cloudPipeline: Tracked<GPURenderPipeline>;
  let blendPipeline: Tracked<GPURenderPipeline>;
  let cloudLayout: GPUBindGroupLayout;
  let blendLayout: GPUBindGroupLayout;
  let cloudUniform: GPUBuffer;
  let screen: ManagedTarget;
  let depth: ManagedTarget;
  let cloudGroup: GPUBindGroup | null = null;
  let blendGroup: GPUBindGroup | null = null;
  let cloudVersion = -1;
  let neutralScreen: GPUTextureView;
  let neutralDepth: GPUTextureView;
  let neutralAerial: GPUTextureView;
  let hazeDirty: { length: number; luminance: Vec3Tuple } | null | undefined;
  let day = 0;

  const solid = (format: GPUTextureFormat, data: ArrayBufferView<ArrayBuffer>, dimension: GPUTextureDimension = '2d'): GPUTexture => {
    const tex = ctx.device.createTexture({ label: 'lab-sky.solid', format, dimension, size: [1, 1, 1], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    ctx.device.queue.writeTexture({ texture: tex }, data, {}, [1, 1, 1]);
    return tex;
  };

  const feature: RenderFeature = {
    id: 'lab-sky',
    order: -40,
    init(c) {
      ctx = c;
      const core = coreOf(c);
      const device = c.device;
      skyUniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const skyLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      skyGroup = device.createBindGroup({ layout: skyLayout, entries: [{ binding: 0, resource: { buffer: skyUniform } }] });
      skyPipeline = core.fullscreenPipeline({
        label: 'lab-sky.backdrop',
        fragment: SKY_FS,
        layouts: [skyLayout],
        targets: [{ format: RENDER_FORMATS.hdr }],
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'equal' },
      });
      shBuffer = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      irradiance = device.createTexture({ format: 'rgba16float', size: [1, 1, 1], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      c.resources.publish('env.sh9', shBuffer);
      c.resources.publish('atmosphere.skyIrradianceLut', irradiance.createView({ dimension: '2d-array' }));

      cloudUniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      cloudLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        ],
      });
      blendLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }] });
      cloudPipeline = core.fullscreenPipeline({ label: 'lab-sky.overcast', fragment: OVERCAST_FS, layouts: [cloudLayout], targets: [{ format: 'rgba16float' }, { format: 'r32float' }] });
      blendPipeline = core.fullscreenPipeline({
        label: 'lab-sky.overcastBlend',
        fragment: OVERCAST_BLEND_FS,
        layouts: [blendLayout],
        targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }],
      });
      screen = core.createTarget('lab-sky.cloudScreen', 'rgba16float', 0.5);
      depth = core.createTarget('lab-sky.cloudDepth', 'r32float', 0.5);
      neutralScreen = solid('rgba16float', new Uint16Array([0, 0, 0, f32ToF16(1)])).createView();
      neutralDepth = solid('r32float', new Float32Array([3.0e38])).createView();
      neutralAerial = solid('rgba16float', new Uint16Array([0, 0, 0, f32ToF16(1)]), '3d').createView();
      skyPipeline.get();
    },
    prepare(frame) {
      // Day factor from the sun elevation at the site; ambient light to match the backdrop.
      const body = frame.snapshot.bodies.find((b) => b.id === sim.site.bodyId)!;
      const up = quat.rotate(body.qFixedToRoot, latLonToDir(sim.site.latDeg * DEG, sim.site.lonDeg * DEG));
      const sinEl = v3.dot(up, body.sunDir);
      const hasAir = defs.bodies[sim.site.bodyId]!.atmosphere !== null;
      const cam = frame.bodyPose(sim.site.bodyId).cameraAltitude;
      const thin = hasAir ? Math.exp(-Math.max(cam, 0) / 9000) : 0;
      day = Math.min(1, Math.max(0, (sinEl + 0.08) / 0.3)) * thin;
      const k = day;
      ctx.device.queue.writeBuffer(skyUniform, 0, new Float32Array([420 * k, 1150 * k, 3800 * k, 0, 5200 * k, 6400 * k, 7800 * k, 0]));
      // 'env.sh9': constant irradiance (lux) plus a little more from above; airless bodies get the sunlit ground's bounce.
      const sh = new Float32Array(36);
      const sky: Vec3Tuple = hasAir ? [11000 * k + 0.002, 12500 * k + 0.002, 15000 * k + 0.003] : [1, 1, 1].map(() => 1400 * Math.max(sinEl, 0)) as Vec3Tuple;
      for (let ch = 0; ch < 3; ch++) sh[ch] = sky[ch]! / 0.282095;
      ctx.device.queue.writeBuffer(shBuffer, 0, sh);
      ctx.device.queue.writeTexture({ texture: irradiance }, new Uint16Array([f32ToF16(hasAir ? sky[0] : 0), f32ToF16(hasAir ? sky[1] : 0), f32ToF16(hasAir ? sky[2] : 0), f32ToF16(1)]), {}, [1, 1, 1]);

      if (hazeDirty !== undefined) {
        const h = hazeDirty;
        hazeDirty = undefined;
        if (!h) ctx.resources.publish('atmosphere.aerialPerspective', neutralAerial);
        else {
          const N = 32;
          const data = new Uint16Array(N * N * N * 4);
          for (let z = 0; z < N; z++) {
            const d = 50 * (Math.pow(2, 0.5 * (z + 0.5)) - 1);
            const T = Math.exp(-d / h.length);
            const texel = [f32ToF16(h.luminance[0] * (1 - T)), f32ToF16(h.luminance[1] * (1 - T)), f32ToF16(h.luminance[2] * (1 - T)), f32ToF16(T)];
            for (let i = 0; i < N * N; i++) data.set(texel, (z * N * N + i) * 4);
          }
          const tex = ctx.device.createTexture({ label: 'lab-sky.aerial', format: 'rgba16float', dimension: '3d', size: [N, N, N], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
          ctx.device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: N * 8, rowsPerImage: N }, [N, N, N]);
          ctx.resources.publish('atmosphere.aerialPerspective', tex.createView());
        }
      }
      if (overcast) {
        const camUp = frame.bodyPose(sim.site.bodyId);
        const upCam = v3.normalize(v3.neg(camUp.centerRelCam));
        const below = sim.site.alt + overcast.altitude - camUp.cameraAltitude;
        ctx.device.queue.writeBuffer(cloudUniform, 0, new Float32Array([below, overcast.transmittance, 5200 * day + 0.01, 21000 * day + 0.02, upCam.x, upCam.y, upCam.z, 0]));
      }
    },
    drawBackground(_frame, pass) {
      if (day <= 0) return;
      pass.setPipeline(skyPipeline.get());
      pass.setBindGroup(1, skyGroup);
      pass.draw(3);
    },
    compositeAtmosphere(frame, encoder, hdr) {
      if (!overcast) {
        if (overcastPublished) {
          overcastPublished = false;
          ctx.resources.publish('clouds.screen', neutralScreen);
          ctx.resources.publish('clouds.depth', neutralDepth);
        }
        return;
      }
      const v = screen.version + depth.version + ctx.resources.version('scene.depthHalf');
      if (!cloudGroup || !blendGroup || v !== cloudVersion) {
        cloudVersion = v;
        cloudGroup = ctx.device.createBindGroup({ layout: cloudLayout, entries: [{ binding: 0, resource: { buffer: cloudUniform } }, { binding: 1, resource: ctx.resources.get('scene.depthHalf') }] });
        blendGroup = ctx.device.createBindGroup({ layout: blendLayout, entries: [{ binding: 0, resource: screen.view }] });
      }
      const march = encoder.beginRenderPass({
        colorAttachments: [
          { view: screen.view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
          { view: depth.view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 3.0e38, g: 0, b: 0, a: 0 } },
        ],
        timestampWrites: ctx.perf.gpuPass('lab-sky.overcast') as GPURenderPassTimestampWrites | undefined,
      });
      march.setBindGroup(0, frame.frameBindGroup);
      march.setPipeline(cloudPipeline.get());
      march.setBindGroup(1, cloudGroup);
      march.draw(3);
      march.end();
      const blend = encoder.beginRenderPass({ colorAttachments: [{ view: hdr, loadOp: 'load', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-sky.blend') as GPURenderPassTimestampWrites | undefined });
      blend.setBindGroup(0, frame.frameBindGroup);
      blend.setPipeline(blendPipeline.get());
      blend.setBindGroup(1, blendGroup);
      blend.draw(3);
      blend.end();
      ctx.resources.publish('clouds.screen', screen.view);
      ctx.resources.publish('clouds.depth', depth.view);
      overcastPublished = true;
    },
  };
  return {
    feature,
    setOvercast(o) {
      overcast = o;
    },
    setHaze(h) {
      hazeDirty = h;
    },
  };
}
