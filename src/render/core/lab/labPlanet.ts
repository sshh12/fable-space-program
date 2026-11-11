/**
 * LabPlanet: an analytically ray-traced sphere per body written to the G-buffer with exact depth, as a
 * precise planet-scale backdrop for labs (NOT terrain: no relief, never used by the app).
 *
 * Albedo comes from the tile set's `albedoLowRes` global map when it exists (else BodyDef.render.meanColor).
 * On bodies with an ocean, ocean-coloured texels become MATERIAL_ID.water with an encoded depth, and the
 * feature honours 'ocean.nearField' the way the real terrain will: where the eye distance is below
 * fadeStart the water is not drawn and a seabed sphere 30 m below sea level is drawn instead.
 */
import { MATERIAL_ID, RENDER_FORMATS, type FrameContext, type RenderContext, type RenderFeature } from '@/core/contracts/render';
import type { TileManifest } from '@/core/contracts/terrain';
import { mat3, quat, v3 } from '@/core/math';
import { coreOf } from '../coreApi';
import type { Tracked } from '../shaders/library';
import { MAX_BODIES } from '../shaders/chunksFrame';
import { createSolidTexture, mipCount } from '../util/gpu';

export interface LabPlanetOptions {
  /** Draw only these bodies (default: every non-star body among the first four of the snapshot). */
  bodies?: string[];
  /**
   * Albedo source per body id: 'tileset' = the `albedoLowRes` global map of the body's tile set (fetched;
   * a tile set that has not been baked yet logs a 404), 'none' = BodyDef.render.meanColor, or an
   * equirectangular rgba8 sRGB image (row 0 = north, column 0 = longitude -180). Bodies not listed use
   * `defaultMap` (default 'tileset').
   */
  maps?: Record<string, 'tileset' | 'none' | { width: number; height: number; data: Uint8Array<ArrayBuffer> }>;
  defaultMap?: 'tileset' | 'none';
  /** Depth of the seabed sphere below sea level, m. */
  seabedDepth?: number;
  /** Feature id (default 'lab-planet') and order. */
  id?: string;
  order?: number;
}

const FS = /* wgsl */ `
#include "gbuffer"
struct LabPlanet {
  // x = frame body index, y = 1 when an albedo map is bound, z = 1 when the body has an ocean, w = surface material id
  info: vec4f,
  // x = seabed depth below sea level (m), y = albedo map width (texels)
  params: vec4f,
  // Motion of a body-fixed point since the previous frame: prev = p + dM * p + t (previous-eye-relative).
  dm0: vec4f,
  dm1: vec4f,
  dm2: vec4f,
  t: vec4f,
}
struct OceanNearField { bodyIndex: i32, fadeStart: f32, fadeEnd: f32, reserved: f32 }
@group(1) @binding(0) var<uniform> planet: LabPlanet;
@group(1) @binding(1) var albedoMap: texture_2d<f32>;
@group(1) @binding(2) var<uniform> oceanNearField: OceanNearField;

struct Out {
  @location(0) albedo: vec4f,
  @location(1) normal: vec2f,
  @location(2) material: vec4f,
  @location(3) velocity: vec2f,
  @location(4) extra: vec4f,
  @location(5) emissive: vec4f,
  @builtin(frag_depth) depth: f32,
}

/// Distance along unit ray d (from the eye) to a sphere of radius rs centred on the body; the eye is at
/// radius r0 = rs + h along 'up'. Cancellation-free near the surface and from lunar distance. -1 = miss.
fn hitSphere(d: vec3f, up: vec3f, r0: f32, h: f32, rs: f32) -> f32 {
  let mu = dot(d, up);
  if (h <= 0.0 || mu >= 0.0) { return -1.0; }
  let c = cross(d, up);
  let disc = rs * rs - r0 * r0 * dot(c, c);
  if (disc < 0.0) { return -1.0; }
  return h * (2.0 * rs + h) / (r0 * -mu + sqrt(disc));
}

@fragment fn fs(in: FullscreenOut) -> Out {
  let bi = u32(planet.info.x);
  let b = frame.bodies[bi];
  let d = normalize(viewRay(in.uv));
  let up = b.cameraUp.xyz;
  let r0 = b.cameraUp.w;
  let R = b.center.w;
  let h = b.sunDir.w;
  var t = hitSphere(d, up, r0, h, R);
  if (t < 0.0) { discard; }
  var p = d * t;
  var n = normalize(p - b.center.xyz);

  // Equirectangular lookup in body-fixed axes (row 0 = north, column 0 = longitude -180).
  var albedo = b.meanColor.rgb;
  if (planet.info.y > 0.5) {
    let nf = rootToFixed(bi, n);
    let uv = vec2f(atan2(nf.y, nf.x) / TWO_PI + 0.5, 0.5 - asin(clamp(nf.z, -1.0, 1.0)) / PI);
    let footprint = t * 2.0 * frame.cameraUp.w * frame.renderSize.w / max(dot(n, -d), 0.05);
    let lod = log2(max(footprint * planet.params.y / (TWO_PI * R), 1.0));
    albedo = textureSampleLevel(albedoMap, linearRepeat, uv, lod).rgb;
  }

  var materialId = u32(planet.info.w);
  var roughness = 0.9;
  var param = 0.0;
  let lum = luminance(albedo);
  let oceanColoured = planet.info.z > 0.5 && planet.info.y > 0.5 && albedo.b > albedo.r * 1.2 && albedo.b >= albedo.g * 0.9 && lum < 0.2;
  if (oceanColoured) {
    if (oceanNearField.bodyIndex == i32(bi) && t < oceanNearField.fadeStart) {
      // Inside the ocean's near field the far water is not drawn: show the seabed for the forward pass to refract.
      let ts = hitSphere(d, up, r0, h + planet.params.x, R - planet.params.x);
      if (ts < 0.0) { discard; }
      t = ts;
      p = d * t;
      n = normalize(p - b.center.xyz);
      albedo = vec3f(0.26, 0.23, 0.18);
      materialId = MATERIAL_TERRAIN;
      param = 1.0;
    } else {
      materialId = MATERIAL_WATER;
      roughness = 0.0;
      // Darker water is deeper: turquoise shelves a few metres, open ocean beyond the encodable range.
      param = encodeWaterDepth(mix(4.0, 400.0, saturate((0.12 - lum) / 0.09)));
    }
  }

  let prev = p + vec3f(dot(planet.dm0.xyz, p), dot(planet.dm1.xyz, p), dot(planet.dm2.xyz, p)) + planet.t.xyz;
  let g = gbufferPack(albedo, 1.0, n, roughness, 0.0, materialId, param,
                      velocityFromClip(frame.viewProjUnjittered * vec4f(p, 1.0), frame.prevViewProj * vec4f(prev, 1.0)), vec3f(0.0));
  var o: Out;
  o.albedo = g.albedo;
  o.normal = g.normal;
  o.material = g.material;
  o.velocity = g.velocity;
  o.extra = g.extra;
  o.emissive = g.emissive;
  o.depth = frame.cameraForward.w / max(t * dot(d, frame.cameraForward.xyz), 1e-6);
  return o;
}
`;

interface PlanetEntry {
  bodyId: string;
  uniform: GPUBuffer;
  data: Float32Array<ArrayBuffer>;
  map: GPUTextureView;
  hasMap: boolean;
  mapWidth: number;
  group: GPUBindGroup | null;
  nearFieldVersion: number;
}

export function createLabPlanetFeature(options: LabPlanetOptions = {}): RenderFeature {
  let ctx: RenderContext;
  let pipeline: Tracked<GPURenderPipeline>;
  let layout: GPUBindGroupLayout;
  const entries = new Map<string, PlanetEntry>();
  let pending = 0;
  const seabedDepth = options.seabedDepth ?? 30;

  // The server's listing of baked tile sets (/tiles/index.json): a tile set that is not there is skipped
  // without requesting its manifest, because Chrome logs a 404 as a console error.
  let tilesets: Promise<string[] | null> | null = null;
  const bakedTilesets = (): Promise<string[] | null> =>
    (tilesets ??= fetch(`${ctx.tilesUrl}/index.json`, { cache: 'no-cache' }).then(async (r) => (r.ok ? ((await r.json()) as { tilesets: string[] }).tilesets : null)));

  const loadMap = async (entry: PlanetEntry, tileset: string): Promise<void> => {
    const base = `${ctx.tilesUrl}/${tileset}`;
    const baked = await bakedTilesets();
    if (baked && !baked.includes(tileset)) return;
    const res = await fetch(`${base}/manifest.json`);
    if (!res.ok) return;
    const manifest = (await res.json()) as TileManifest;
    const g = manifest.globals?.albedoLowRes;
    if (!g) return;
    const img = await fetch(`${base}/${g.path}`);
    if (!img.ok) return;
    const bitmap = await createImageBitmap(await img.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const core = coreOf(ctx);
    const tex = core.createTextureChecked({
      label: `labPlanet.albedo.${entry.bodyId}`,
      format: 'rgba8unorm-srgb',
      size: [bitmap.width, bitmap.height],
      mipLevelCount: mipCount(bitmap.width, bitmap.height),
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    ctx.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: tex }, [bitmap.width, bitmap.height]);
    core.mips.generate(tex);
    entry.map = tex.createView();
    entry.hasMap = true;
    entry.mapWidth = bitmap.width;
    entry.group = null;
    bitmap.close();
  };

  return {
    id: options.id ?? 'lab-planet',
    order: options.order ?? -100,
    init(c) {
      ctx = c;
      const device = c.device;
      layout = device.createBindGroupLayout({
        label: 'labPlanet',
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ],
      });
      pipeline = coreOf(c).fullscreenPipeline({
        label: 'labPlanet',
        fragment: FS,
        layouts: [layout],
        targets: [
          { format: RENDER_FORMATS.gbufferAlbedo },
          { format: RENDER_FORMATS.gbufferNormal },
          { format: RENDER_FORMATS.gbufferMaterial },
          { format: RENDER_FORMATS.gbufferVelocity },
          { format: RENDER_FORMATS.gbufferExtra },
          { format: RENDER_FORMATS.hdr },
        ],
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'greater' },
      });
      pipeline.get();
    },

    prepare(frame: FrameContext) {
      const device = ctx.device;
      const count = Math.min(MAX_BODIES, frame.bodies.length);
      for (let i = 0; i < count; i++) {
        const pose = frame.bodies[i]!;
        const def = ctx.defs.bodies[pose.id];
        if (!def || pose.id === frame.sun.bodyId) continue;
        if (options.bodies && !options.bodies.includes(pose.id)) continue;
        let e = entries.get(pose.id);
        if (!e) {
          e = {
            bodyId: pose.id,
            uniform: device.createBuffer({ label: `labPlanet.${pose.id}`, size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
            data: new Float32Array(24),
            map: createSolidTexture(device, 'labPlanet.noMap', 'rgba8unorm-srgb', [0.5, 0.5, 0.5, 1]).createView(),
            hasMap: false,
            mapWidth: 1,
            group: null,
            nearFieldVersion: -1,
          };
          entries.set(pose.id, e);
          const source = options.maps?.[pose.id] ?? options.defaultMap ?? 'tileset';
          if (typeof source === 'object') {
            const tex = coreOf(ctx).createTextureChecked({
              label: `labPlanet.albedo.${pose.id}`,
              format: 'rgba8unorm-srgb',
              size: [source.width, source.height],
              mipLevelCount: mipCount(source.width, source.height),
              usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            device.queue.writeTexture({ texture: tex }, source.data, { bytesPerRow: source.width * 4 }, [source.width, source.height]);
            coreOf(ctx).mips.generate(tex);
            e.map = tex.createView();
            e.hasMap = true;
            e.mapWidth = source.width;
          } else if (source === 'tileset' && def.terrain) {
            const entry = e;
            pending++;
            loadMap(entry, def.terrain.tileset)
              .catch(() => undefined)
              .finally(() => {
                pending--;
              });
          }
        }
        // prev = Rp R^T (p - c) + cp  =  p + (Rp R^T - I) p + (cp - Rp R^T c), all in float64.
        const m = mat3.mul(mat3.fromQuat(pose.prevQFixedToRoot), mat3.transpose(mat3.fromQuat(pose.qFixedToRoot)));
        const mc = mat3.mulVec(m, pose.centerRelCam);
        const t = v3.sub(pose.prevCenterRelCam, mc);
        const dq = quat.mul(pose.prevQFixedToRoot, quat.conj(pose.qFixedToRoot));
        // (M - I) from the small rotation directly, to keep its tiny entries exact.
        const dm = mat3.fromQuat(dq);
        const surfaceMaterial = def.render.surface?.brdf === 'hapke' ? MATERIAL_ID.regolith : MATERIAL_ID.terrain;
        const d = e.data;
        d.set([i, e.hasMap ? 1 : 0, def.ocean ? 1 : 0, surfaceMaterial], 0);
        d.set([seabedDepth, e.mapWidth, 0, 0], 4);
        d.set([dm[0] - 1, dm[1], dm[2], 0], 8);
        d.set([dm[3], dm[4] - 1, dm[5], 0], 12);
        d.set([dm[6], dm[7], dm[8] - 1, 0], 16);
        d.set([t.x, t.y, t.z, 0], 20);
        device.queue.writeBuffer(e.uniform, 0, d);
        const nfv = ctx.resources.version('ocean.nearField');
        if (!e.group || e.nearFieldVersion !== nfv) {
          e.nearFieldVersion = nfv;
          e.group = device.createBindGroup({
            label: `labPlanet.${pose.id}`,
            layout,
            entries: [
              { binding: 0, resource: { buffer: e.uniform } },
              { binding: 1, resource: e.map },
              { binding: 2, resource: { buffer: ctx.resources.get('ocean.nearField') } },
            ],
          });
        }
      }
    },

    drawGBuffer(frame, pass) {
      pass.setPipeline(pipeline.get());
      for (const pose of frame.bodies) {
        const e = entries.get(pose.id);
        if (!e?.group) continue;
        pass.setBindGroup(1, e.group);
        pass.draw(3);
      }
    },

    isIdle: () => pending === 0,
  };
}
