/**
 * Sky-lighting lab. One page, configured by query string (plus every camera / renderer parameter of
 * createLabApp: scene=, orbit=, body=, fov=, ev=, perf=features, scale=, governor=off, deterministic=1 ...):
 *
 *   sky=0               no sky feature (A/B against the core alone)
 *   parts=-a,-b         switch sky components off: stars, milkyWay, sun, impostors, probe, flare
 *   probeAlbedo=mean    the probe uses BodyDef.render.meanColor (for the CPU reference)
 *   planet=0            no LabPlanet backdrop;  maps=tileset (default) | none | lambert
 *                       (lambert: a uniform map whose Lambert-sphere geometric albedo is the body's geometricAlbedo)
 *   spheres=1           PBR sphere set at the active vessel (white, grey, black, chrome, gold, copper)
 *   clouds=1            lab stand-in for the cloud renderer: publish the cloud coverage map of the first body with
 *                       clouds, switch on the far cloud term, and draw the layer as a thin translucent shell with
 *                       the probe's cloud model
 *   valt=<m>            move the active vessel to this altitude above its body
 *   night=1             the star behind the vessel's body (vessel in its shadow)
 *   heavy=<n>           GPU ballast iterations (perf specs keep the GPU busy, RENDER_API section 14)
 *   hud=0               no text overlay
 *
 * Specs drive the rest through window.__sky (this page) and window.__lab (the lab app).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { RenderContext, RenderFeature } from '@/core/contracts/render';
import type { TileManifest } from '@/core/contracts/terrain';
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { DEG, mat4, quat, v3, type Vec3 } from '@/core/math';
import { coreOf, createSolidTexture, instanceInFrame, mipCount, sphereMesh, type ManagedTarget, type MeshBatch, type ModelHandle, type Tracked } from '@/render/core';
import { createLabApp, createLabPlanetFeature, lookRotation, type LabApp } from '@/render/core/lab';
import { bruteForceIrradiance, clipOfDirection, createSkyFeature, projectSh, raDecToDir, referenceRadiance, shIrradiance, type ReferenceScene, type SkyFeature, type SkyParts } from '@/render/sky';
import { withOverrides, type WorldOverrides } from './world';

export interface SkyLab {
  app: LabApp;
  sky: SkyFeature | null;
  defs: DefLibrary;
  /** Pin the star along a ROOT direction (from the root body), or release it. */
  setSunDirection(dir: Vec3 | null): void;
  /**
   * Put the star behind the active vessel's body (the vessel in its shadow), or at `elevationDeg` above its horizon
   * and `azimuthDeg` clockwise from north (or from the camera's horizontal view direction with fromCamera).
   */
  setSunForVessel(mode: 'night' | { elevationDeg: number; azimuthDeg: number; fromCamera?: boolean } | null): void;
  setVesselAltitude(h: number | null): void;
  /** Camera at `position` (ROOT, default the ROOT origin) looking at RA / Dec (deg), north up. */
  lookAtRaDec(raDeg: number, decDeg: number, fovDeg?: number, position?: Vec3, rollDeg?: number): void;
  lookFrom(position: Vec3, forward: Vec3, up?: Vec3, fovDeg?: number): void;
  /** Continuous render-target pixel coordinates (unjittered) of a direction, or null behind the camera. */
  projectDir(dir: Vec3): { x: number; y: number } | null;
  /** Publish an opaque synthetic cloud layer 1 km in front of everything ('clouds.screen' a = 0, 'clouds.depth'). */
  setCloudCover(on: boolean): void;
  setHeavy(n: number): void;
  /** CPU description of the probe scene of the last frame (airless, cloudless; mean colours) for brute-force checks. */
  referenceScene(): ReferenceScene | null;
  /** CPU reference functions of src/render/sky (brute-force irradiance, SH projection). */
  cpu: { referenceRadiance: typeof referenceRadiance; projectSh: typeof projectSh; bruteForceIrradiance: typeof bruteForceIrradiance; shIrradiance: typeof shIrradiance };
}

declare global {
  interface Window {
    __sky?: SkyLab;
  }
}

const query = new URLSearchParams(location.search);
const scene = (query.get('scene') as FakeScene | null) ?? 'lowOrbit';
const overrides: WorldOverrides = { sunDir: null, vesselAltitude: query.has('valt') ? Number(query.get('valt')) : null };
let heavyIterations = Number(query.get('heavy') ?? 0);

function skyParts(): Partial<SkyParts> {
  const out: Partial<SkyParts> = {};
  for (const p of (query.get('parts') ?? '').split(',').filter(Boolean)) {
    const off = p.startsWith('-');
    out[p.replace(/^[-+]/, '') as keyof SkyParts] = !off;
  }
  return out;
}

/** Uniform sRGB map whose Lambert-sphere geometric albedo (2/3 of the Lambert albedo) is the body's geometricAlbedo. */
function lambertMap(defs: DefLibrary, bodyId: string): { width: number; height: number; data: Uint8Array<ArrayBuffer> } {
  const r = defs.bodies[bodyId]!.render;
  const l = 0.2126 * r.meanColor[0] + 0.7152 * r.meanColor[1] + 0.0722 * r.meanColor[2];
  const k = (1.5 * r.geometricAlbedo) / l;
  const enc = (x: number): number => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  const px = [...r.meanColor.map((c) => enc(Math.min(1, c * k))), 255];
  return { width: 2, height: 1, data: new Uint8Array([...px, ...px]) };
}

/**
 * PBR sphere set 6 m in front of the camera, in a row along its right axis (the lab camera orbits the active
 * vessel, so the spheres sit at the probe position to within metres), drawn through the core mesh system.
 */
function createSpheresFeature(): RenderFeature {
  let batch: MeshBatch;
  const models: ModelHandle[] = [];
  const mats = [
    { name: 'white', shading: 'standard' as const, baseColor: [0.8, 0.8, 0.8] as [number, number, number], metallic: 0, roughness: 0.6 },
    { name: 'grey', shading: 'standard' as const, baseColor: [0.18, 0.18, 0.18] as [number, number, number], metallic: 0, roughness: 0.5 },
    { name: 'black', shading: 'standard' as const, baseColor: [0.03, 0.03, 0.03] as [number, number, number], metallic: 0, roughness: 0.15 },
    { name: 'chrome', shading: 'standard' as const, baseColor: [0.95, 0.94, 0.92] as [number, number, number], metallic: 1, roughness: 0.04 },
    { name: 'gold', shading: 'standard' as const, baseColor: [1.0, 0.77, 0.34] as [number, number, number], metallic: 1, roughness: 0.3 },
    { name: 'copper', shading: 'standard' as const, baseColor: [0.95, 0.64, 0.54] as [number, number, number], metallic: 1, roughness: 0.6 },
  ];
  return {
    id: 'sky-lab-spheres',
    init(c) {
      const meshes = coreOf(c).meshes;
      batch = meshes.createBatch('sky-lab-spheres');
      for (const m of mats) models.push(meshes.createModel({ name: `sphere-${m.name}`, lods: [sphereMesh(0.5, 64, 32)], materials: [m] }));
    },
    prepare(frame) {
      batch.begin(frame);
      // Fixed relative to the camera: no screen motion, origin and previous origin equal.
      const fwd = { x: -frame.view[2]!, y: -frame.view[6]!, z: -frame.view[10]! };
      const right = { x: frame.view[0]!, y: frame.view[4]!, z: frame.view[8]! };
      models.forEach((m, i) => {
        const o = v3.add(v3.scale(fwd, 6), v3.scale(right, (i - 2.5) * Number(query.get('spacing') ?? 1.6)));
        batch.add(m, instanceInFrame({ originRelCam: o, q: quat.identity(), prevOriginRelCam: o, prevQ: quat.identity() }, { x: 0, y: 0, z: 0 }, null, { bodyFixed: false }));
      });
      batch.finish();
    },
    drawGBuffer(_f, pass) {
      batch.drawGBuffer(pass);
    },
    drawShadow(_f, pass, cascade) {
      batch.drawShadow(pass, cascade);
    },
  };
}

/** GPU ballast: a fullscreen burn in the compute hook (perf specs measure with the GPU as busy as a game frame). */
function createHeavyFeature(): RenderFeature {
  let ctx: RenderContext;
  let pipeline: Tracked<GPURenderPipeline>;
  let target: ManagedTarget;
  let uniform: GPUBuffer;
  let group: GPUBindGroup;
  return {
    id: 'sky-lab-heavy',
    init(c) {
      ctx = c;
      const core = coreOf(c);
      target = core.createTarget('sky-lab-heavy.scratch', 'rgba16float', 1);
      uniform = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const layout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      group = c.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
      pipeline = core.fullscreenPipeline({
        label: 'sky-lab-heavy.burn',
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
      ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([heavyIterations, 0, 0, 0]));
    },
    compute(frame, encoder) {
      if (heavyIterations <= 0) return;
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('sky-lab-heavy.burn') as GPURenderPassTimestampWrites | undefined });
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setPipeline(pipeline.get());
      pass.setBindGroup(1, group);
      pass.draw(3);
      pass.end();
      // The tail of the burn is charged to this empty pass, not to whatever is encoded next.
      encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('sky-lab-heavy.tail') as GPURenderPassTimestampWrites | undefined }).end();
    },
  };
}

/** Vertical optical depth of the lab's cloud layer at full coverage (a lab value: thick stratocumulus). */
const LAB_CLOUD_TAU = 20;

interface CloudWorld {
  bodyId: string;
  /** The tile set's cloud coverage map (r = coverage) as decoded, for 'clouds.coverageMap'. */
  coverage: ImageBitmap;
}

async function loadCloudWorld(defs: DefLibrary, tilesUrl: string): Promise<CloudWorld | null> {
  const def = Object.values(defs.bodies).find((b) => b.render.clouds && b.terrain);
  if (!def) return null;
  const base = `${tilesUrl}/${def.terrain!.tileset}`;
  const manifest = (await (await fetch(`${base}/manifest.json`)).json()) as TileManifest;
  const path = manifest.globals[def.render.clouds!.coverageMap]!.path;
  const coverage = await createImageBitmap(await (await fetch(`${base}/${path}`)).blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  return { bodyId: def.id, coverage };
}

/**
 * Lab stand-in for the cloud renderer (not a cloud renderer): publishes the coverage map and the far cloud term
 * (the probe and the render core's cloud shadow read them), and draws the layer as a thin shell at its mid
 * height in the transparent stage with the probe's cloud model: radiance R(tau) E_sun mu_s / pi (two-stream
 * conservative reflectance, Lambertian top), the ground behind attenuated by exp(-tau / mu_view).
 */
function createCloudLayerFeature(world: CloudWorld): RenderFeature {
  let ctx: RenderContext;
  let coverageView: GPUTextureView;
  let pipeline: Tracked<GPURenderPipeline>;
  let layout: GPUBindGroupLayout;
  let group: GPUBindGroup | null = null;
  let groupVersion = -1;
  let bindings: ReturnType<ReturnType<typeof coreOf>['createSceneBindings']>;
  let uniform: GPUBuffer;
  let bodyIndex = -1;
  return {
    id: 'sky-lab-clouds',
    init(c) {
      ctx = c;
      const core = coreOf(c);
      const bmp = world.coverage;
      const tex = core.createTextureChecked({
        label: 'sky-lab.coverage',
        format: 'rgba8unorm',
        size: [bmp.width, bmp.height],
        mipLevelCount: mipCount(bmp.width, bmp.height),
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      c.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [bmp.width, bmp.height]);
      core.mips.generate(tex);
      coverageView = tex.createView();
      c.resources.publish('clouds.coverageMap', coverageView);
      bindings = core.createSceneBindings(1, 0, ['transparency', 'sceneDepth']);
      uniform = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      layout = c.device.createBindGroupLayout({
        entries: [
          ...bindings.layoutEntries,
          { binding: bindings.nextBinding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: bindings.nextBinding + 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ],
      });
      pipeline = core.fullscreenPipeline({
        label: 'sky-lab-clouds.layer',
        layouts: [layout],
        fragment: /* wgsl */ `
          #include "transparency"
          #include "eclipse"
          ${bindings.wgsl}
          @group(1) @binding(${bindings.nextBinding}) var coverageTex: texture_2d<f32>;
          struct LabClouds { v: vec4f }   // x = frame body index
          @group(1) @binding(${bindings.nextBinding + 1}) var<uniform> lab: LabClouds;
          @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
            let bi = u32(lab.v.x);
            let b = frame.bodies[bi];
            let d = normalize(viewRay(in.uv));
            let c = b.center.xyz;
            let rr = frame.cloudFar.y;
            let bq = dot(d, c);
            let det = bq * bq - dot(c, c) + rr * rr;
            if (det < 0.0) { discard; }
            let s = sqrt(det);
            // From outside the shell: the near side; from below it: the exit point.
            let t = select(bq + s, bq - s, length(c) > rr);
            if (t <= 0.0) { discard; }
            let depth = textureLoad(sceneDepthTex, vec2i(in.position.xy), 0);
            if (depth > 0.0 && length(positionFromDepth(in.uv, depth)) < t) { discard; }
            let p = d * t;
            let n = normalize(p - c);
            let nf = rootToFixed(bi, n);
            let uv = vec2f(fract((atan2(nf.y, nf.x) + frame.cloudFar.w) / TWO_PI + 0.5), 0.5 - asin(clamp(nf.z, -1.0, 1.0)) / PI);
            let tau = textureSampleLevel(coverageTex, linearRepeat, uv, 0.0).r * frame.cloudFar.z;
            let g = 0.85;
            let refl = (1.0 - g) * tau / (2.0 + (1.0 - g) * tau);
            let sunDir = b.sunDir.xyz;
            let muS = dot(n, sunDir);
            var L = vec3f(0.0);
            if (muS > 0.0) { L = frame.sunIlluminance.rgb * muS * sunVisibility(p, sunDir) * refl / PI; }
            let alpha = 1.0 - exp(-tau / max(abs(dot(d, n)), 0.02));
            let o = applyAtmosphere(in.uv, t, L * frame.exposure.x, alpha);
            return vec4f(writeHdr(o.rgb), o.a);
          }`,
        targets: [{ format: 'rgba16float', blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }],
        depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' },
      });
      pipeline.get();
    },
    prepare(frame) {
      bodyIndex = frame.bodies.findIndex((b) => b.id === world.bodyId);
      if (bodyIndex >= 4) bodyIndex = -1;
      const def = ctx.defs.bodies[world.bodyId]!;
      const cl = def.render.clouds!;
      coreOf(ctx).setCloudShadowParams({ far: bodyIndex >= 0 ? { bodyIndex, layerRadius: def.radius + 0.5 * (cl.bottomAltitude + cl.topAltitude), opticalDepth: LAB_CLOUD_TAU, longitudeOffset: 0 } : null });
      ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([bodyIndex, 0, 0, 0]));
    },
    drawTransparent(_frame, pass) {
      if (bodyIndex < 0) return;
      const v = bindings.version();
      if (!group || v !== groupVersion) {
        groupVersion = v;
        group = ctx.device.createBindGroup({
          layout,
          entries: [...bindings.entries(), { binding: bindings.nextBinding, resource: coverageView }, { binding: bindings.nextBinding + 1, resource: { buffer: uniform } }],
        });
      }
      pass.setPipeline(pipeline.get());
      pass.setBindGroup(1, group);
      pass.draw(3);
    },
  };
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const info = document.getElementById('info') as HTMLDivElement;
  let sky: SkyFeature | null = null;
  let cloudDefaults: { screen: GPUTextureView; depth: GPUTextureView } | null = null;
  const defs = await loadDefs(fetchDefSource());
  const clouds = query.get('clouds') === '1' ? await loadCloudWorld(defs, '/tiles') : null;
  const app = await createLabApp({
    canvas,
    name: 'sky',
    scene,
    defs,
    autoReady: false,
    sim: (d) => withOverrides(createFakeSim(d, { scene }), overrides),
    features: (d) => {
      const list: RenderFeature[] = [];
      if (query.get('planet') !== '0') {
        const mode = query.get('maps') ?? 'tileset';
        const maps: NonNullable<Parameters<typeof createLabPlanetFeature>[0]>['maps'] = {};
        for (const b of Object.values(d.bodies)) {
          if (b.emission) continue;
          if (mode === 'none') maps[b.id] = 'none';
          else if (mode === 'lambert') maps[b.id] = lambertMap(d, b.id);
        }
        list.push(createLabPlanetFeature({ maps }));
      }
      if (query.get('spheres') === '1') list.push(createSpheresFeature());
      if (clouds) list.push(createCloudLayerFeature(clouds));
      if (query.has('heavy')) list.push(createHeavyFeature());
      if (query.get('sky') !== '0') {
        sky = createSkyFeature({ ...skyParts(), probeAlbedo: query.get('probeAlbedo') === 'mean' ? 'meanColor' : 'tileset' });
        list.push(sky);
      }
      return list;
    },
  });
  if (query.get('night') === '1') setSunForVessel('night');

  function setSunForVessel(mode: 'night' | { elevationDeg: number; azimuthDeg: number; fromCamera?: boolean } | null): void {
    if (!mode) {
      overrides.sunDir = null;
      return;
    }
    overrides.sunDir = (s) => {
      const v = s.vessels.find((x) => x.id === s.activeVesselId);
      if (!v) return null;
      const body = s.bodies.find((b) => b.id === v.bodyId)!;
      const up = v3.normalize(v3.sub(v.rRoot, body.rRoot));
      if (mode === 'night') return v3.neg(up);
      // Azimuth from north, or (fromCamera) from the camera's horizontal view direction, clockwise seen from above.
      const ref = mode.fromCamera ? quat.rotate(app.cameraState().qViewToRoot, { x: 0, y: 0, z: -1 }) : { x: 0, y: 0, z: 1 };
      const north0 = v3.reject(ref, up);
      const north = v3.lenSq(north0) > 1e-12 ? v3.normalize(north0) : v3.normalize(v3.anyOrthogonal(up));
      const east = v3.cross(north, up);
      const az = mode.azimuthDeg * DEG;
      const el = mode.elevationDeg * DEG;
      return v3.normalize(v3.add(v3.scale(v3.add(v3.scale(north, Math.cos(az)), v3.scale(east, Math.sin(az))), Math.cos(el)), v3.scale(up, Math.sin(el))));
    };
  }

  const lab: Omit<SkyLab, 'cpu'> = {
    app,
    sky,
    defs: app.defs,
    setSunDirection(dir) {
      overrides.sunDir = dir ? () => dir : null;
    },
    setSunForVessel,
    setVesselAltitude(h) {
      overrides.vesselAltitude = h;
    },
    lookAtRaDec(raDeg, decDeg, fovDeg, position = { x: 0, y: 0, z: 0 }, rollDeg = 0) {
      const fwd = raDecToDir(raDeg * DEG, decDeg * DEG);
      let up = v3.reject({ x: 0, y: 0, z: 1 }, fwd);
      if (v3.lenSq(up) < 1e-10) up = { x: 1, y: 0, z: 0 };
      const q0 = lookRotation(fwd, v3.normalize(up));
      app.camera.spec = { type: 'free', positionRoot: position, qViewToRoot: quat.mul(q0, quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, rollDeg * DEG)) };
      if (fovDeg) app.camera.settings.fovY = fovDeg * DEG;
    },
    lookFrom(position, forward, up = { x: 0, y: 0, z: 1 }, fovDeg) {
      app.camera.spec = { type: 'free', positionRoot: position, qViewToRoot: lookRotation(forward, up) };
      if (fovDeg) app.camera.settings.fovY = fovDeg * DEG;
    },
    projectDir(dir) {
      const f = app.renderer.frameContext;
      if (!f) return null;
      const [x, y, w] = clipOfDirection(mat4.mul(f.projUnjittered, f.view), dir);
      if (w <= 0) return null;
      return { x: (0.5 + (0.5 * x) / w) * f.renderSize[0], y: (0.5 - (0.5 * y) / w) * f.renderSize[1] };
    },
    setCloudCover(on) {
      const res = app.renderer.resources;
      if (on) {
        const device = app.renderer.context.device;
        cloudDefaults ??= {
          screen: createSolidTexture(device, 'sky-lab.cloudScreen', 'rgba16float', [0, 0, 0, 0]).createView(),
          depth: createSolidTexture(device, 'sky-lab.cloudDepth', 'r32float', [1000]).createView(),
        };
        res.publish('clouds.screen', cloudDefaults.screen);
        res.publish('clouds.depth', cloudDefaults.depth);
      } else {
        res.reset('clouds.screen');
        res.reset('clouds.depth');
      }
    },
    setHeavy(n) {
      heavyIterations = n;
    },
    referenceScene() {
      const f = app.renderer.frameContext;
      const scene = sky?.probe().scene;
      if (!f || !scene) return null;
      return {
        bodies: scene.bodies.map((b) => {
          const def = app.defs.bodies[b.id]!;
          const snap = f.snapshot.bodies.find((x) => x.id === b.id)!;
          return { centre: b.centre, radius: b.radius, weight: b.weight, albedo: [...def.render.meanColor], sunDir: snap.sunDir };
        }),
        sunE: [f.sun.color[0] * f.sun.illuminance, f.sun.color[1] * f.sun.illuminance, f.sun.color[2] * f.sun.illuminance],
        sunRadius: f.sun.angularRadius,
        background: [0, 0, 0],
      };
    },
  };
  window.__sky = { ...lab, cpu: { referenceRadiance, projectSh, bruteForceIrradiance, shIrradiance } };

  if (query.get('hud') !== '0') {
    setInterval(() => {
      const p = app.renderer.perfSnapshot();
      const e = app.renderer.exposureInfo();
      const st = sky?.status();
      const pr = sky?.probe();
      info.textContent =
        `sky lab   scene ${scene}   ${p.counters.renderWidth ?? 0} x ${p.counters.renderHeight ?? 0}   gpu ${p.gpu.p50.toFixed(2)} ms   EV100 ${e.ev100.toFixed(2)} (lit ${(e.litFraction * 100).toFixed(2)} %)\n` +
        `stars ${st?.starsLoaded ? 'loaded' : '-'}   milky way ${st?.milkyWayLoaded ? 'loaded' : '-'}   probe cycles ${pr?.completed ?? 0}${pr?.holding ? ' (holding)' : ''}   impostors ${sky?.impostors().length ?? 0}`;
    }, 250);
  }
  await app.testApi.api.waitFrames(3);
  app.testApi.markReady(app.testApi.api.errors.length === 0);
}

boot().catch((err: unknown) => {
  console.error(err);
  window.__test?.errors.push(`lab boot: ${err instanceof Error ? err.message : String(err)}`);
});

