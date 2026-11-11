/**
 * createSkyFeature: the sky as seen from anywhere in the system, photometrically.
 *
 *   drawBackground   Milky Way cube (rgb9e5, luminanceScale), analytic solar disc with limb darkening, catalogue
 *                    stars as Gaussian PSFs (all at depth == 0, additive, in ROOT = J2000 axes)
 *   compute          the live environment probe at the active vessel ('env.probeCube', 'env.sh9'; probe.ts)
 *   preTransparent   visible fraction of the solar disc for the flare ('scene.depth', 'clouds.screen')
 *   drawTransparent  distant bodies under 6 px as PSF impostors cross-faded over their geometry, lens flare
 *
 * Nothing here has a brightness knob: star, Milky Way, sun and impostor luminances follow from the data and
 * the frame's exposure. See docs/handoff/sky-lighting.md.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import { RENDER_FORMATS, type FrameContext, type RenderContext, type RenderFeature } from '@/core/contracts/render';
import { STAR_RECORD_FLOATS, type SkyManifest } from '@/core/contracts/sky';
import { mat4, quat, v3, type Mat4, type Vec3, type Vec3Tuple } from '@/core/math';
import { MAX_BODIES, coreOf, createSceneBindings, discVisibleFraction, type SceneBindings, type Tracked } from '@/render/core';
import { BLADES, BLADE_COUNT, GHOSTS, GHOST_CLIP_RADIUS, SPIKE_COUNT, STARBURST, STREAKS, STREAK_COUNT, bladeAngle, coneNdcBounds, flareNormalisation, ghostFrame, ghostLateral, ghostSupport, hoodTransmission, ndcDirection, spikeAmplitude, type FlareView } from './flare';
import {
  farBodyDiscIntegral,
  farBodyLuneSum,
  IMPOSTOR_KERNEL_CUT,
  IMPOSTOR_NORMALISE_MAX_SAMPLES,
  luneSampleCount,
  hapkeSingleScattering,
  impostorKernelPx,
  impostorLune,
  impostorWeight,
  impostorWingShare,
  lambertPhase,
  litWidthPx,
  pixelSolidAngle,
  starImageRadius,
  starWing,
  visibleFaceAlbedo,
  STAR_PSF_SIGMA_PX,
  STAR_QUAD_SIGMAS,
  type FarBodyShading,
} from './photometry';
import { EnvironmentProbe, type ProbeState } from './probe';
import { BACKGROUND_FS, FLARE_VIS_CS, FLARE_WGSL, IMPOSTOR_WGSL, STARS_WGSL } from './shaders';
import { faceFileBytes, faceMipLayout, parseStarCatalogue, rgb9e5LuminanceHalf, validateSkyManifest, type StarCatalogue } from './skyData';

export interface SkyParts {
  stars: boolean;
  milkyWay: boolean;
  sun: boolean;
  impostors: boolean;
  probe: boolean;
  flare: boolean;
}

export interface SkyFeatureOptions extends Partial<SkyParts> {
  /** Feature id (prefix of its passes and perf rows), default 'sky'. */
  id?: string;
  order?: number;
  /**
   * Albedo of bodies in the environment probe: the albedoLowRes global map of the body's tile set where one is
   * baked (default), or BodyDef.render.meanColor everywhere (labs compare the probe with a CPU reference).
   */
  probeAlbedo?: 'tileset' | 'meanColor';
  /**
   * Largest face size (texels) of the Milky Way cube kept in VRAM (default MILKY_WAY_FACE_SIZE): finer mips of
   * the baked chain are not uploaded. 1024 keeps the sky within its 0.1 GB line of ARCHITECTURE 17; the baked
   * 2048 costs 134 MB instead of 34 MB.
   */
  milkyWayFaceSize?: number;
  /**
   * Keep the next finer baked level as a luminance-only detail layer (r16float, default true): with the default
   * face size the faint stars keep the baked 2048 resolution (their colour comes from the 1024 level) for 50 MB
   * instead of the 100 MB of the full-colour level. No effect when the finest level is already uploaded.
   */
  milkyWayDetail?: boolean;
}

/** Default largest Milky Way face size in VRAM (texels): 0.088 deg per texel at the face centre. */
export const MILKY_WAY_FACE_SIZE = 1024;

export interface ImpostorInfo {
  bodyId: string;
  /** Projected diameter (render px), weight of the far image against the geometry, illuminance at the camera (lux). */
  diameterPx: number;
  weight: number;
  illuminance: number;
  /** Width of the sunlit part along the sun line (render px) and the sigma of the image's kernel (px). */
  litWidthPx: number;
  kernelPx: number;
}

export interface FlareStateInfo {
  /**
   * Visible fraction of the solar disc (depth samples on screen, body spheres off screen), cloud transmittance at
   * the sun, 1 when the sun centre is in view, the lens hood's transmission (1 inside the frame).
   */
  visible: number;
  cloud: number;
  inView: number;
  hood: number;
  transmittance: Vec3Tuple;
}

export interface SkyStatus {
  manifest: SkyManifest | null;
  starsLoaded: boolean;
  milkyWayLoaded: boolean;
  /** Face size of the Milky Way cube in VRAM (texels; 0 until loaded), and of its luminance detail layer (0 = none). */
  milkyWayFaceSize: number;
  milkyWayDetailSize: number;
  error: string | null;
  /** Whether the flare was drawn in the last frame. */
  flareDrawn: boolean;
}

export interface SkyFeature extends RenderFeature {
  /** Components, all on by default (labs switch them for A/B readbacks). */
  readonly parts: SkyParts;
  status(): SkyStatus;
  stars(): StarCatalogue | null;
  impostors(): ImpostorInfo[];
  probe(): ProbeState;
  readProbeSh(): Promise<number[][]>;
  readProbeFace(face: number, mip?: number): Promise<{ size: number; data: Float32Array }>;
  readFlareState(): Promise<FlareStateInfo>;
}

const ADDITIVE: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
const PREMULTIPLIED: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
const SKY_UNIFORM_FLOATS = 20;
const MAX_IMPOSTORS = 16;
/** Floats per Impostor of IMPOSTOR_WGSL (8 vec4). */
const IMPOSTOR_STRIDE = 32;
const IMPOSTOR_FLOATS = 4 + MAX_IMPOSTORS * IMPOSTOR_STRIDE;
interface FarBody {
  shading: FarBodyShading;
  /** Phase-integrated radiance of the disc per lux and unit radius^2 (rgb), for `phase` (rad) and `albedo`. */
  reference: Vec3Tuple;
  phase: number;
  albedo: Vec3Tuple;
}
const smooth01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const FLARE_TERMS = 1 + GHOSTS.length;
/** FlareUniforms of FLARE_WGSL: count, sun, halo, rays, lines, the blades (2 vec4 each), the streaks (1 vec4 each), the ghosts (6 vec4 each). */
const FLARE_HEAD_FLOATS = 20;
const FLARE_GHOST_STRIDE = 24;
const FLARE_FLOATS = FLARE_HEAD_FLOATS + BLADE_COUNT * 8 + STREAK_COUNT * 4 + GHOSTS.length * FLARE_GHOST_STRIDE;

const luma = (c: Readonly<Vec3Tuple>): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Clip x, y, w of a direction (w = 0 in homogeneous coordinates) under a column-major matrix. */
export function clipOfDirection(m: Mat4, d: Vec3): [number, number, number] {
  return [m[0]! * d.x + m[4]! * d.y + m[8]! * d.z, m[1]! * d.x + m[5]! * d.y + m[9]! * d.z, m[3]! * d.x + m[7]! * d.y + m[11]! * d.z];
}

export function createSkyFeature(options: SkyFeatureOptions = {}): SkyFeature {
  const id = options.id ?? 'sky';
  const parts: SkyParts = {
    stars: options.stars ?? true,
    milkyWay: options.milkyWay ?? true,
    sun: options.sun ?? true,
    impostors: options.impostors ?? true,
    probe: options.probe ?? true,
    flare: options.flare ?? true,
  };
  let ctx: RenderContext;
  let defs: DefLibrary;
  let device: GPUDevice;
  const status: SkyStatus = { manifest: null, starsLoaded: false, milkyWayLoaded: false, milkyWayFaceSize: 0, milkyWayDetailSize: 0, error: null, flareDrawn: false };
  let pendingLoads = 0;
  let catalogue: StarCatalogue | null = null;

  // Background (group 1: sky uniform + Milky Way cube).
  let skyLayout: GPUBindGroupLayout;
  let skyBuf: GPUBuffer;
  const skyData = new Float32Array(SKY_UNIFORM_FLOATS);
  let skyGroup: GPUBindGroup;
  let blankCube: GPUTextureView;
  let milkyWay: GPUTextureView | null = null;
  let milkyWayTex: GPUTexture | null = null;
  let milkyWayDetail: GPUTextureView | null = null;
  let milkyWayDetailTex: GPUTexture | null = null;
  let backgroundPipeline: Tracked<GPURenderPipeline>;
  let starPipeline: Tracked<GPURenderPipeline>;
  let starBuffer: GPUBuffer | null = null;

  // Transparent stage (group 1: transparency + scene depth; group 2: own data).
  let transBindings: SceneBindings;
  let transLayout: GPUBindGroupLayout;
  let transGroup: GPUBindGroup | null = null;
  let transVersion = -1;
  let impostorLayout: GPUBindGroupLayout;
  let impostorBuf: GPUBuffer;
  let impostorGroup: GPUBindGroup;
  const impostorData = new ArrayBuffer(IMPOSTOR_FLOATS * 4);
  let impostorPipeline: Tracked<GPURenderPipeline>;
  let impostorList: ImpostorInfo[] = [];
  const farBodies = new Map<string, FarBody>();

  // Flare.
  let flareLayout: GPUBindGroupLayout;
  let flareBuf: GPUBuffer;
  let flareGroup: GPUBindGroup;
  const flareData = new ArrayBuffer(FLARE_FLOATS * 4);
  let flareState: GPUBuffer;
  let flarePipeline: Tracked<GPURenderPipeline>;
  let visBindings: SceneBindings;
  let visSceneLayout: GPUBindGroupLayout;
  let visSceneGroup: GPUBindGroup | null = null;
  let visVersion = -1;
  let visLayout: GPUBindGroupLayout;
  let visBuf: GPUBuffer;
  let visGroup: GPUBindGroup;
  let visPipeline: Tracked<GPUComputePipeline>;
  let flareThisFrame = false;
  let flareHood = 0;

  let probe: EnvironmentProbe;
  let probeThisFrame = false;

  const fail = (what: string, e: unknown): void => {
    const msg = `${id}: ${what}: ${e instanceof Error ? e.message : String(e)}`;
    status.error = msg;
    coreOf(ctx).reportError(msg);
  };

  const rebuildSkyGroup = (): void => {
    skyGroup = device.createBindGroup({
      label: `${id}.sky`,
      layout: skyLayout,
      entries: [
        { binding: 0, resource: { buffer: skyBuf } },
        { binding: 1, resource: milkyWay ?? blankCube },
        { binding: 2, resource: milkyWayDetail ?? blankCube },
      ],
    });
  };

  async function loadSky(): Promise<void> {
    const base = ctx.skyUrl;
    const res = await fetch(`${base}/manifest.json`);
    if (!res.ok) throw new Error(`${base}/manifest.json: HTTP ${res.status}`);
    const manifest = validateSkyManifest(await res.json());
    status.manifest = manifest;

    const sres = await fetch(`${base}/${manifest.stars.file}`);
    if (!sres.ok) throw new Error(`${base}/${manifest.stars.file}: HTTP ${sres.status}`);
    catalogue = parseStarCatalogue(await sres.arrayBuffer(), manifest.stars.count);
    starBuffer = device.createBuffer({ label: `${id}.stars`, size: catalogue.records.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(starBuffer, 0, catalogue.records);
    status.starsLoaded = true;

    const mw = manifest.milkyWay;
    // Mips of the baked chain finer than the VRAM face-size limit are skipped (each level halves the face).
    const limit = options.milkyWayFaceSize ?? MILKY_WAY_FACE_SIZE;
    let skip = 0;
    while (mw.faceSize >> skip > limit && skip < mw.mipLevels - 1) skip++;
    const faceSize = mw.faceSize >> skip;
    const tex = coreOf(ctx).createTextureChecked({
      label: `${id}.milkyWay`,
      format: 'rgb9e5ufloat',
      size: [faceSize, faceSize, 6],
      mipLevelCount: mw.mipLevels - skip,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // The level just finer than the colour chain is kept as luminance (r16float): half the bytes of its rgb9e5 texels.
    const detailSize = skip > 0 && (options.milkyWayDetail ?? true) ? faceSize * 2 : 0;
    const detail = detailSize
      ? coreOf(ctx).createTextureChecked({ label: `${id}.milkyWayDetail`, format: 'r16float', size: [detailSize, detailSize, 6], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
      : null;
    const layout = faceMipLayout(mw.faceSize, mw.mipLevels);
    const bytes = faceFileBytes(mw.faceSize, mw.mipLevels);
    // One face at a time: 22 MB of transient memory instead of 134 MB.
    for (let face = 0; face < 6; face++) {
      const fres = await fetch(`${base}/${mw.files[face]}`);
      if (!fres.ok) throw new Error(`${base}/${mw.files[face]}: HTTP ${fres.status}`);
      const data = await fres.arrayBuffer();
      if (data.byteLength !== bytes) throw new Error(`${mw.files[face]}: ${data.byteLength} bytes, expected ${bytes} (full mip chain of ${mw.faceSize}^2 rgb9e5)`);
      for (let l = skip; l < mw.mipLevels; l++) {
        const { offset, size } = layout[l]!;
        device.queue.writeTexture({ texture: tex, mipLevel: l - skip, origin: [0, 0, face] }, data, { offset, bytesPerRow: size * 4, rowsPerImage: size }, [size, size, 1]);
      }
      if (detail) {
        const { offset, size } = layout[skip - 1]!;
        const half = rgb9e5LuminanceHalf(new Uint32Array(data, offset, size * size));
        device.queue.writeTexture({ texture: detail, origin: [0, 0, face] }, half, { bytesPerRow: size * 2, rowsPerImage: size }, [size, size, 1]);
      }
    }
    milkyWayTex = tex;
    milkyWay = tex.createView({ dimension: 'cube' });
    status.milkyWayLoaded = true;
    status.milkyWayFaceSize = faceSize;
    if (detail) {
      milkyWayDetailTex = detail;
      milkyWayDetail = detail.createView({ dimension: 'cube' });
      status.milkyWayDetailSize = detailSize;
    }
    rebuildSkyGroup();
    probe.setMilkyWay(milkyWay, mw.luminanceScale, faceSize);
  }

  const prepareSky = (frame: FrameContext, tanX: number, tanY: number): void => {
    const [w, h] = frame.renderSize;
    const d = skyData;
    d.fill(0);
    d.set([status.manifest?.milkyWay.luminanceScale ?? 0, parts.milkyWay && milkyWay ? 1 : 0, parts.sun ? 1 : 0, parts.stars && starBuffer ? 1 : 0], 0);
    const star = defs.bodies[frame.sun.bodyId];
    const u = star?.emission?.limbDarkening ?? [0, 0, 0];
    d.set([u[0], u[1], u[2], 1 / (Math.PI * Math.sin(Math.max(frame.sun.angularRadius, 1e-9)) ** 2)], 4);
    // Scintillation: only inside an atmosphere (the camera below the top of the nearest atmosphere body's shell).
    let inside = false;
    for (const pose of frame.bodies) {
      const def = defs.bodies[pose.id];
      const atm = def?.render.atmosphere;
      // Inside the shell: between half a radius below the datum (sea floor, caves) and the top of the atmosphere.
      if (!def || !atm || pose.cameraAltitude >= atm.topAltitude || pose.cameraAltitude < -0.5 * def.radius) continue;
      const r = v3.len(pose.centerRelCam);
      const up = v3.scale(pose.centerRelCam, -1 / r);
      d.set([1, pose.cameraAltitude, atm.rayleighScaleHeight, r / atm.rayleighScaleHeight], 8);
      d.set([up.x, up.y, up.z, frame.realTime], 12);
      inside = true;
      break;
    }
    if (!inside) d.set([0, 0, 1, 1], 8);
    // px.w: angle of a texel of the detail layer at a face centre (0 = no detail layer).
    d.set([pixelSolidAngle(tanX, tanY, w, h), STAR_QUAD_SIGMAS * STAR_PSF_SIGMA_PX, (2 * tanY) / h, milkyWayDetail ? 2 / status.milkyWayDetailSize : 0], 16);
    device.queue.writeBuffer(skyBuf, 0, d);
  };

  /** Lambert albedo of a body's far image: 1.5 p gives the sphere the geometric albedo p (the render core's planetshine formula), coloured by meanColor. */
  const lambertAlbedoOf = (bodyId: string): Vec3Tuple | null => {
    const r = defs.bodies[bodyId]?.render;
    if (!r) return null;
    const l = Math.max(luma(r.meanColor), 1e-6);
    return [(1.5 * r.geometricAlbedo * r.meanColor[0]) / l, (1.5 * r.geometricAlbedo * r.meanColor[1]) / l, (1.5 * r.geometricAlbedo * r.meanColor[2]) / l];
  };

  /**
   * Photometric function of a body's far image and the phase-integrated radiance of its disc per lux and unit
   * radius^2. A regolith body is rendered with its Hapke function and its albedo map: the far image uses the same
   * function with the mean albedo of the face it shows (`albedo`: from the albedoLowRes map where one is loaded,
   * else the body's mean colour); any other body is the Lambert sphere of its geometric albedo. The Hapke reference
   * is a quadrature (1,152 evaluations), repeated only when the phase angle or the albedo has changed.
   */
  const farBodyOf = (bodyId: string, phase: number, albedo: Vec3Tuple | null): FarBody | null => {
    const def = defs.bodies[bodyId];
    const lambertAlbedo = lambertAlbedoOf(bodyId);
    if (!def || !lambertAlbedo) return null;
    const params = def.render.surface?.brdf === 'hapke' ? def.render.surface.hapke : undefined;
    if (!params) {
      const k = (2 / 3) * lambertPhase(phase);
      return { shading: { lambertAlbedo, hapke: null }, reference: [lambertAlbedo[0] * k, lambertAlbedo[1] * k, lambertAlbedo[2] * k], phase, albedo: lambertAlbedo };
    }
    const a = albedo ?? def.render.meanColor;
    const known = farBodies.get(bodyId);
    if (known && Math.abs(known.phase - phase) < 1e-5 && Math.abs(known.albedo[0] - a[0]) + Math.abs(known.albedo[1] - a[1]) + Math.abs(known.albedo[2] - a[2]) < 1e-5) return known;
    const shading: FarBodyShading = { lambertAlbedo, hapke: { w: [hapkeSingleScattering(a[0], params), hapkeSingleScattering(a[1], params), hapkeSingleScattering(a[2], params)], params } };
    const far: FarBody = { shading, reference: farBodyDiscIntegral(shading, phase, 24, 16), phase, albedo: [a[0], a[1], a[2]] };
    farBodies.set(bodyId, far);
    return far;
  };

  const prepareImpostors = (frame: FrameContext, tanX: number, tanY: number, forward: { x: number; y: number; z: number }): void => {
    impostorList = [];
    const u32 = new Uint32Array(impostorData);
    const f32 = new Float32Array(impostorData);
    f32.fill(0);
    if (!parts.impostors) return;
    const [, h] = frame.renderSize;
    const pxAngle = (2 * tanY) / h;
    // The hand-over is decided in display pixels: dynamic resolution must not switch the representation.
    const displayScale = frame.displaySize[1] / h;
    const s = frame.snapshot;
    const emission = defs.bodies[frame.sun.bodyId]?.emission;
    if (!emission) return;
    const camUp = { x: frame.view[1]!, y: frame.view[5]!, z: frame.view[9]! };
    let n = 0;
    for (const pose of frame.bodies) {
      if (n >= MAX_IMPOSTORS) break;
      if (pose.id === frame.sun.bodyId) continue;
      const def = defs.bodies[pose.id];
      const snap = s.bodies.find((b) => b.id === pose.id);
      if (!def || !snap) continue;
      const dist = v3.len(pose.centerRelCam);
      const R = def.radius;
      if (dist < 4 * R) continue;
      const dir = v3.scale(pose.centerRelCam, 1 / dist);
      const cosOff = v3.dot(dir, forward);
      if (cosOff < 0.05) continue;
      const diameterPx = (2 * Math.asin(R / dist)) / (pxAngle * cosOff ** 1.5);
      const phase = v3.angle(snap.sunDir, v3.neg(dir));
      const weight = impostorWeight(diameterPx * displayScale, phase);
      if (weight <= 0) continue;
      // The face the body shows: mean albedo of its sunlit, visible part (body-fixed directions to the camera and the sun).
      const grid = probe.albedoGrid(pose.id);
      const face = grid ? visibleFaceAlbedo(grid, quat.rotateInv(pose.qFixedToRoot, v3.neg(dir)), quat.rotateInv(pose.qFixedToRoot, snap.sunDir)) : null;
      const far = farBodyOf(pose.id, phase, face);
      if (!far) continue;
      // Sun at the body: illuminance, angular size, and eclipses by the other bodies.
      const eSun = emission.illuminance * (emission.refDistance / snap.sunDistance) ** 2;
      const rs = Math.asin(Math.min(1, emission.radius / snap.sunDistance));
      let vis = 1;
      for (const o of s.bodies) {
        if (o.id === pose.id || o.id === s.starId) continue;
        const od = defs.bodies[o.id];
        if (!od) continue;
        const to = v3.sub(o.rRoot, snap.rRoot);
        vis *= discVisibleFraction(rs, Math.asin(Math.min(1, od.radius / v3.len(to))), v3.angle(to, snap.sunDir));
      }
      const light: Vec3Tuple = [frame.sun.color[0] * eSun * vis, frame.sun.color[1] * eSun * vis, frame.sun.color[2] * eSun * vis];
      const ref = far.reference;
      const flux: Vec3Tuple = [light[0] * ref[0], light[1] * ref[1], light[2] * ref[2]];
      const radiusPx = 0.5 * diameterPx;
      // Illuminance at the camera (lux): the disc's radiance integral x its solid angle per unit radius^2.
      const e = luma(flux) * Math.asin(R / dist) ** 2;
      // Image plane at the body: x right, y up; the sun's direction in it orients the sample grid.
      const up = v3.normalize(v3.sub(camUp, v3.scale(dir, v3.dot(camUp, dir))));
      const right = v3.cross(dir, up);
      const sx = v3.dot(snap.sunDir, right);
      const sy = v3.dot(snap.sunDir, up);
      const sl = Math.hypot(sx, sy);
      const axis = sl > 1e-9 ? [sx / sl, sy / sl] : [1, 0];
      const share = impostorWingShare(diameterPx);
      const sigma = impostorKernelPx(diameterPx);
      const lune = impostorLune(diameterPx, phase);
      const wingRadius = share > 0 ? starImageRadius(luma(flux) * radiusPx * radiusPx * frame.exposure * weight, share) : 0;
      const wing = share > 0 ? starWing(wingRadius, share) : { amp: 0, floor: 0 };
      const hp = far.shading.hapke;
      // Radiance of a sample per unit of its photometric term, and for Hapke the terms that depend on the phase angle only.
      const k = hp ? 1 / (4 * Math.PI) : 1 / Math.PI;
      const albedo = hp ? hp.w : far.shading.lambertAlbedo;
      const cg = Math.cos(phase);
      const surge = hp ? (1 + hp.params.b0 / (1 + Math.tan(phase / 2) / hp.params.hS)) * (1 + hp.params.bP * cg + hp.params.cP * (1.5 * cg * cg - 0.5)) : 0;
      // A coarse grid's midpoint sum is normalised to the reference integral; its light's centre places the wings.
      let norm = 1;
      let photocentre = 0;
      if (luneSampleCount(diameterPx, phase) <= IMPOSTOR_NORMALISE_MAX_SAMPLES) {
        const grid = farBodyLuneSum(far.shading, diameterPx, phase);
        const gridLuma = luma([light[0] * grid.sum[0], light[1] * grid.sum[1], light[2] * grid.sum[2]]);
        if (gridLuma > 0) norm = luma(flux) / gridLuma;
        photocentre = grid.centre * radiusPx;
      }
      const o = 4 + n * IMPOSTOR_STRIDE;
      f32.set(
        [
          ...[pose.centerRelCam.x, pose.centerRelCam.y, pose.centerRelCam.z, R],
          ...[axis[0]!, axis[1]!, phase, weight],
          ...[light[0] * albedo[0] * k, light[1] * albedo[1] * k, light[2] * albedo[2] * k, hp ? 1 : 0],
          ...(hp ? [Math.sqrt(1 - hp.w[0]), Math.sqrt(1 - hp.w[1]), Math.sqrt(1 - hp.w[2]), surge] : [1, 1, 1, 0]),
          ...[flux[0], flux[1], flux[2], share],
          ...[radiusPx, Math.max(radiusPx + IMPOSTOR_KERNEL_CUT * sigma + 1, wingRadius), dist - 1.5 * R, sigma],
          // Over the geometry the image replaces the whole disc of a small body and only the sunlit part of a larger one.
          ...[lune.rows, lune.cols, smooth01((diameterPx - 6) / 6), norm],
          ...[wing.amp, wing.floor, wingRadius, photocentre],
        ],
        o,
      );
      impostorList.push({ bodyId: pose.id, diameterPx, weight, illuminance: e, litWidthPx: litWidthPx(diameterPx, phase), kernelPx: sigma });
      n++;
    }
    u32[0] = n;
    device.queue.writeBuffer(impostorBuf, 0, impostorData);
  };

  const prepareFlare = (frame: FrameContext, tanX: number, tanY: number): void => {
    flareThisFrame = false;
    flareHood = 0;
    if (!parts.flare || frame.camera.kind === 'interior' || frame.sun.illuminance <= 0) return;
    const [cx, cy, cw] = clipOfDirection(mat4.mul(frame.projUnjittered, frame.view), frame.sun.dirRoot);
    if (cw <= 0) return;
    const sx = cx / cw;
    const sy = cy / cw;
    // A sun outside the frame still lights the lens through the hood (flare.ts hoodTransmission); NDC x tan = image-plane tangent.
    const hood = hoodTransmission(Math.max(0, (Math.abs(sx) - 1) * tanX), Math.max(0, (Math.abs(sy) - 1) * tanY));
    if (hood <= 0) return;
    flareHood = hood;
    // Profiles normalised over the sphere outside the disc (numeric integrals; depend on the sun's size).
    const flareNorm = flareNormalisation(frame.sun.angularRadius);
    const view: FlareView = {
      right: { x: frame.view[0]!, y: frame.view[4]!, z: frame.view[8]! },
      up: { x: frame.view[1]!, y: frame.view[5]!, z: frame.view[9]! },
      forward: { x: -frame.view[2]!, y: -frame.view[6]!, z: -frame.view[10]! },
      tanX,
      tanY,
    };
    // Ghost bounds grow by 1.5 px: the jitter moves the profile on screen by up to half a pixel.
    const [w, h] = frame.renderSize;
    const mx = 3 / w;
    const my = 3 / h;
    const u = new Uint32Array(flareData);
    const f = new Float32Array(flareData);
    f.fill(0);
    u[0] = FLARE_TERMS;
    const rs = frame.sun.angularRadius;
    const gf = ghostFrame(view, [sx, sy], rs);
    const lateral = ghostLateral(gf.offAxis);
    const halo = STARBURST.haloEnergy * flareNorm.halo;
    f.set([hood, STARBURST.haloAngle, gf.axis[0], gf.axis[1]], 4);
    f.set([STARBURST.haloTint[0] * halo, STARBURST.haloTint[1] * halo, STARBURST.haloTint[2] * halo, 0], 8);
    f.set([STARBURST.rayKnee, STARBURST.rayEnergy * flareNorm.rays, STARBURST.rayDiscSigma * rs, STARBURST.streakEnergy * flareNorm.streaks], 12);
    f.set([STARBURST.fringeDepth, (2 * Math.PI) / STARBURST.fringePeriod, STARBURST.streakFan, 1 / STARBURST.fringeReach], 16);
    BLADES.forEach((b, i) => {
      const a = bladeAngle(i);
      // Blade i owns rays 2i (its first) and 2i + BLADE_COUNT.
      f.set([Math.sin(a), Math.cos(a), b.angle, 0, b.length, b.fan, spikeAmplitude(2 * i), spikeAmplitude((2 * i + BLADE_COUNT) % SPIKE_COUNT)], FLARE_HEAD_FLOATS + i * 8);
    });
    STREAKS.forEach((st, i) => f.set([st.azimuth, st.amplitude, st.length, 0], FLARE_HEAD_FLOATS + BLADE_COUNT * 8 + i * 4));
    GHOSTS.forEach((g, i) => {
      const gx = sx * g.k;
      const gy = sy * g.k;
      const support = ghostSupport(g, rs);
      const blur = g.blur * rs;
      const [x0, y0, x1, y1] = coneNdcBounds(view, ndcDirection(view, gx, gy), support);
      f.set(
        [
          ...[gx, gy, g.radius, g.flip],
          ...[g.tint[0], g.tint[1], g.tint[2], g.energy * flareNorm.ghosts[i]!],
          ...[blur, g.round, g.rim, (g.gradient * lateral) / g.radius],
          ...[g.chroma * lateral, g.vignette * gf.offAxis * g.radius, GHOST_CLIP_RADIUS * g.radius + 2 * blur, support],
          ...[g.aspect, g.hollow, g.bite * g.radius, g.biteShift * g.radius],
          ...[x0 - mx, y0 - my, x1 + mx, y1 + my],
        ],
        FLARE_HEAD_FLOATS + BLADE_COUNT * 8 + STREAK_COUNT * 4 + i * FLARE_GHOST_STRIDE,
      );
    });
    device.queue.writeBuffer(flareBuf, 0, flareData);
    // Transmittance towards the sun at the camera: the nearest frame body with an atmosphere shell around the camera.
    const vis = new Float32Array([-1, 0, 0, 0]);
    for (let i = 0; i < Math.min(MAX_BODIES, frame.bodies.length); i++) {
      const pose = frame.bodies[i]!;
      const atm = defs.bodies[pose.id]?.render.atmosphere;
      if (!atm) continue;
      const r = v3.len(pose.centerRelCam);
      vis.set([i, r, v3.dot(v3.scale(pose.centerRelCam, -1 / r), pose.sunDir)], 0);
      break;
    }
    device.queue.writeBuffer(visBuf, 0, vis);
    flareThisFrame = true;
  };

  const sceneGroupFor = (bindings: SceneBindings, layout: GPUBindGroupLayout, cur: GPUBindGroup | null, version: number): [GPUBindGroup, number] => {
    const v = bindings.version();
    if (cur && v === version) return [cur, version];
    return [device.createBindGroup({ label: `${id}.scene`, layout, entries: bindings.entries() }), v];
  };

  const readStorage = async (buffer: GPUBuffer, bytes: number): Promise<Float32Array> => {
    const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return out;
  };

  const feature: SkyFeature = {
    id,
    order: options.order ?? 0,
    parts,

    init(c) {
      ctx = c;
      defs = c.defs;
      device = c.device;
      const core = coreOf(c);
      const V = GPUShaderStage.VERTEX;
      const F = GPUShaderStage.FRAGMENT;

      skyLayout = device.createBindGroupLayout({
        label: `${id}.sky`,
        entries: [
          { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
          { binding: 1, visibility: F, texture: { sampleType: 'float', viewDimension: 'cube' } },
          { binding: 2, visibility: F, texture: { sampleType: 'float', viewDimension: 'cube' } },
        ],
      });
      skyBuf = device.createBuffer({ label: `${id}.sky`, size: SKY_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      blankCube = core.createTextureChecked({ label: `${id}.noCube`, format: 'rgba16float', size: [1, 1, 6], usage: GPUTextureUsage.TEXTURE_BINDING }).createView({ dimension: 'cube' });
      rebuildSkyGroup();
      const depthEqual: GPUDepthStencilState = { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'equal' };
      backgroundPipeline = core.fullscreenPipeline({ label: `${id}.background`, fragment: BACKGROUND_FS, layouts: [skyLayout], targets: [{ format: RENDER_FORMATS.hdr, blend: ADDITIVE }], depthStencil: depthEqual });
      starPipeline = core.shaders.tracked(() => {
        const module = core.shaders.createModule(`${id}.stars`, STARS_WGSL);
        return device.createRenderPipeline({
          label: `${id}.stars`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [c.frameBindGroupLayout, skyLayout] }),
          vertex: {
            module,
            entryPoint: 'vs',
            buffers: [
              {
                arrayStride: STAR_RECORD_FLOATS * 4,
                stepMode: 'instance',
                attributes: [
                  { shaderLocation: 0, offset: 0, format: 'float32x4' },
                  { shaderLocation: 1, offset: 16, format: 'float32x4' },
                ],
              },
            ],
          },
          fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: ADDITIVE }] },
          primitive: { topology: 'triangle-strip' },
          depthStencil: depthEqual,
        });
      });

      // Transparent stage.
      transBindings = createSceneBindings(c, 1, 0, ['transparency', 'sceneDepth']);
      transLayout = device.createBindGroupLayout({ label: `${id}.transparent`, entries: transBindings.layoutEntries });
      impostorLayout = device.createBindGroupLayout({ label: `${id}.impostors`, entries: [{ binding: 0, visibility: V | F, buffer: { type: 'uniform' } }] });
      impostorBuf = device.createBuffer({ label: `${id}.impostors`, size: IMPOSTOR_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      impostorGroup = device.createBindGroup({ label: `${id}.impostors`, layout: impostorLayout, entries: [{ binding: 0, resource: { buffer: impostorBuf } }] });
      const depthTransparent: GPUDepthStencilState = { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' };
      impostorPipeline = core.shaders.tracked(() => {
        const module = core.shaders.createModule(`${id}.impostors`, IMPOSTOR_WGSL(transBindings.wgsl));
        return device.createRenderPipeline({
          label: `${id}.impostors`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [c.frameBindGroupLayout, transLayout, impostorLayout] }),
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: PREMULTIPLIED }] },
          primitive: { topology: 'triangle-strip' },
          depthStencil: depthTransparent,
        });
      });

      flareLayout = device.createBindGroupLayout({
        label: `${id}.flare`,
        entries: [
          { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
          { binding: 1, visibility: V | F, buffer: { type: 'read-only-storage' } },
        ],
      });
      flareBuf = device.createBuffer({ label: `${id}.flare`, size: FLARE_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      flareState = device.createBuffer({ label: `${id}.flareState`, size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      flareGroup = device.createBindGroup({
        label: `${id}.flare`,
        layout: flareLayout,
        entries: [
          { binding: 0, resource: { buffer: flareBuf } },
          { binding: 1, resource: { buffer: flareState } },
        ],
      });
      flarePipeline = core.shaders.tracked(() => {
        const module = core.shaders.createModule(`${id}.flare`, FLARE_WGSL(transBindings.wgsl));
        return device.createRenderPipeline({
          label: `${id}.flare`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [c.frameBindGroupLayout, transLayout, flareLayout] }),
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: RENDER_FORMATS.hdr, blend: PREMULTIPLIED }] },
          primitive: { topology: 'triangle-strip' },
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
        });
      });
      visBindings = createSceneBindings(c, 1, 0, ['sceneDepth', 'transparency', 'atmosphereLuts']);
      visSceneLayout = device.createBindGroupLayout({ label: `${id}.flareVisScene`, entries: visBindings.layoutEntries });
      visLayout = device.createBindGroupLayout({
        label: `${id}.flareVis`,
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        ],
      });
      visBuf = device.createBuffer({ label: `${id}.flareVis`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      visGroup = device.createBindGroup({
        label: `${id}.flareVis`,
        layout: visLayout,
        entries: [
          { binding: 0, resource: { buffer: visBuf } },
          { binding: 1, resource: { buffer: flareState } },
        ],
      });
      visPipeline = core.shaders.tracked(() =>
        device.createComputePipeline({
          label: `${id}.flareVis`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [c.frameBindGroupLayout, visSceneLayout, visLayout] }),
          compute: { module: core.shaders.createModule(`${id}.flareVis`, FLARE_VIS_CS(visBindings.wgsl)), entryPoint: 'main' },
        }),
      );
      for (const p of [backgroundPipeline, starPipeline, impostorPipeline, flarePipeline]) p.get();
      visPipeline.get();

      probe = new EnvironmentProbe(c, id, blankCube);
      if (parts.probe && (options.probeAlbedo ?? 'tileset') === 'tileset') probe.loadAlbedoMaps(defs);

      pendingLoads++;
      loadSky()
        .catch((e: unknown) => fail('sky data', e))
        .finally(() => pendingLoads--);
    },

    prepare(frame) {
      const tanY = Math.tan(frame.camera.fovY / 2);
      const tanX = tanY * (frame.renderSize[0] / frame.renderSize[1]);
      const forward = { x: -frame.view[2]!, y: -frame.view[6]!, z: -frame.view[10]! };
      prepareSky(frame, tanX, tanY);
      prepareImpostors(frame, tanX, tanY, forward);
      prepareFlare(frame, tanX, tanY);
      probeThisFrame = parts.probe && probe.prepare(frame, defs);
    },

    compute(frame, encoder) {
      if (probeThisFrame) probe.encode(frame, encoder);
    },

    drawBackground(frame, pass) {
      pass.setBindGroup(1, skyGroup);
      if ((parts.milkyWay && milkyWay) || parts.sun) {
        pass.setPipeline(backgroundPipeline.get());
        pass.draw(3);
      }
      if (parts.stars && starBuffer && catalogue) {
        pass.setPipeline(starPipeline.get());
        pass.setVertexBuffer(0, starBuffer);
        pass.draw(4, catalogue.count);
      }
    },

    preTransparent(frame, encoder) {
      status.flareDrawn = flareThisFrame;
      if (!flareThisFrame) return;
      [visSceneGroup, visVersion] = sceneGroupFor(visBindings, visSceneLayout, visSceneGroup, visVersion);
      const pass = encoder.beginComputePass({ label: `${id}.flareVis`, timestampWrites: ctx.perf.gpuPass(`${id}.flareVis`) as GPUComputePassTimestampWrites | undefined });
      pass.setPipeline(visPipeline.get());
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setBindGroup(1, visSceneGroup);
      pass.setBindGroup(2, visGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
    },

    drawTransparent(_frame, pass) {
      if (impostorList.length === 0 && !flareThisFrame) return;
      [transGroup, transVersion] = sceneGroupFor(transBindings, transLayout, transGroup, transVersion);
      pass.setBindGroup(1, transGroup);
      if (impostorList.length > 0) {
        pass.setPipeline(impostorPipeline.get());
        pass.setBindGroup(2, impostorGroup);
        pass.draw(4, impostorList.length);
      }
      if (flareThisFrame) {
        pass.setPipeline(flarePipeline.get());
        pass.setBindGroup(2, flareGroup);
        pass.draw(4, FLARE_TERMS);
      }
    },

    isIdle: () => pendingLoads === 0 && (!parts.probe || probe.isIdle()),

    dispose() {
      milkyWayTex?.destroy();
      milkyWayDetailTex?.destroy();
      starBuffer?.destroy();
      for (const b of [skyBuf, impostorBuf, flareBuf, flareState, visBuf]) b.destroy();
      probe.dispose();
    },

    status: () => ({ ...status }),
    stars: () => catalogue,
    impostors: () => impostorList.map((i) => ({ ...i })),
    probe: () => probe.info(),
    readProbeSh: () => probe.readSh(),
    readProbeFace: (face, mip = 0) => probe.readFace(face, mip),
    async readFlareState() {
      const hood = flareHood;
      const f = await readStorage(flareState, 32);
      return { visible: f[0]!, cloud: f[1]!, inView: f[2]!, hood, transmittance: [f[4]!, f[5]!, f[6]!] };
    },
  };
  return feature;
}
