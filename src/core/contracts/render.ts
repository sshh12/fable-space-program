/**
 * Renderer contracts. src/render/core implements the frame graph and these interfaces; every other
 * render package (terrain, atmosphere, ocean, sky, vehicle, cockpit, vfx) and the map/HUD overlays plug in
 * as RenderFeatures. Exact WGSL struct layouts and helper APIs are documented by the render core in
 * docs/RENDER_API.md; this file fixes the cross-package shape.
 *
 * World axes on the GPU are the ROOT inertial axes; the origin is the camera eye ("camera-relative").
 * View space: right-handed, +X right, +Y up, camera looks down -Z. Depth is reversed-Z with an infinite
 * far plane (mat4.perspectiveReversedZInfinite): depth = near / distance-along-view-axis, sky = 0.
 * Radiometry is photometric end to end: luminance in cd/m^2 (nits), illuminance in lux, multiplied by
 * FrameContext.exposure before being written to the HDR target ("pre-exposed").
 */
import type { Mat4 } from '../math/mat';
import type { Quat } from '../math/quat';
import type { Vec3, Vec3Tuple } from '../math/vec3';
import type { DefLibrary } from './defs';
import type { SimSnapshot } from './sim';

export type ViewMode = 'cockpit' | 'chase' | 'map';

export const RENDER_FORMATS = {
  /** Pre-exposed scene radiance. */
  hdr: 'rgba16float',
  depth: 'depth32float',
  /** G-buffer RT0: base colour rgb (sRGB encoded), a = baked AO / cavity. */
  gbufferAlbedo: 'rgba8unorm-srgb',
  /** G-buffer RT1: octahedral-encoded world (ROOT-axes) normal. */
  gbufferNormal: 'rg16float',
  /** G-buffer RT2: r = perceptual roughness, g = metallic, b = material id / 255, a = material parameter. */
  gbufferMaterial: 'rgba8unorm',
  /** G-buffer RT3: screen-space velocity in UV units (current - previous). */
  gbufferVelocity: 'rg16float',
  /** Sun shadow cascades: standard (non-reversed) orthographic depth. */
  shadow: 'depth32float',
} as const satisfies Record<string, GPUTextureFormat>;

/** Near plane distance in metres (cockpit geometry is centimetres from the eye). */
export const NEAR_PLANE = 0.05;

/** Values written to G-buffer RT2.b (times 1/255). */
export const MATERIAL_ID = {
  standard: 0,
  terrain: 1,
  regolith: 2,
  water: 3,
  cloth: 4,
  display: 5,
} as const;
export type MaterialIdName = keyof typeof MATERIAL_ID;

// ------------------------------------------------------------------------------------------------ camera

export interface CameraState {
  mode: ViewMode;
  /** Eye position in the ROOT frame, metres, float64. */
  positionRoot: Vec3;
  /** View space -> ROOT orientation. */
  qViewToRoot: Quat;
  /** Vertical field of view, rad. */
  fovY: number;
  /** Vessel whose interior the eye is inside (cockpit view), else null. Drives interior audio and exposure metering. */
  insideVesselId: string | null;
  /** Vessel or body the camera is attached to / orbiting (map focus), for LOD and audio distance. */
  focusVesselId: string | null;
  focusBodyId: string | null;
  /** Exposure compensation in EV, and an optional lower bound on scene exposure (map view keeps night sides legible). */
  exposureCompensation: number;
  minEv100: number | null;
  /** Low ambient fill as a fraction of sun illuminance; non-zero only in map view. */
  fillLight: number;
}

/** Points that force terrain detail (camera, vessels near the ground, later an EVA astronaut). */
export interface LodObserver {
  positionRoot: Vec3;
  /** Metres subtracted from the distance used for LOD selection. */
  radiusBias: number;
}

/** Produces the camera for one view mode. Implemented in src/camera; new modes (EVA) add new rigs. */
export interface CameraRig {
  readonly mode: ViewMode | string;
  /** Called when the rig becomes active; `from` is the camera of the previous rig for a seamless blend. */
  activate(from: CameraState | null, snapshot: SimSnapshot): void;
  update(snapshot: SimSnapshot, input: CameraInput, realDt: number): CameraState;
}

export interface CameraInput {
  /** Orbit/look deltas in radians, zoom as a multiplicative step (> 1 zooms out). */
  yaw: number;
  pitch: number;
  zoom: number;
  /** Map view: request to focus another body/vessel. */
  focusBodyId?: string | null;
  focusVesselId?: string | null;
}

// --------------------------------------------------------------------------------------------- meshes

/** CPU mesh handed to the render core for upload. Right-handed, counter-clockwise front faces, metres. */
export interface MeshData {
  /** xyz per vertex. */
  positions: Float32Array;
  /** Unit normals, xyz per vertex. */
  normals: Float32Array;
  /** Tangent xyz + handedness w per vertex. */
  tangents: Float32Array;
  /** uv per vertex. */
  uvs: Float32Array;
  /** Optional rgba8 per vertex: r = edge wear (curvature), g = baked AO, b = soot/scorch weight, a = frost weight. */
  masks?: Uint8Array;
  indices: Uint32Array;
  /** Index ranges per material. */
  groups: { material: number; start: number; count: number }[];
  bounds: { min: Vec3Tuple; max: Vec3Tuple };
}

export interface PbrMaterialDef {
  name: string;
  shading: MaterialIdName;
  /** Linear-sRGB base colour factor, multiplied with the base colour texture when present. */
  baseColor: Vec3Tuple;
  metallic: number;
  roughness: number;
  /** Emitted luminance, cd/m^2 (before exposure). */
  emissive?: Vec3Tuple;
  clearcoat?: number;
  clearcoatRoughness?: number;
  /** -1..1 anisotropy along the tangent (brushed metal, MLI foil). */
  anisotropy?: number;
  /** 0..1 thin-surface translucency (parachute fabric). */
  translucency?: number;
  doubleSided?: boolean;
  /** Texture URLs (public/assets/**) or ids of procedural textures registered with the render core. */
  textures?: { baseColor?: string; normal?: string; orm?: string; emissive?: string };
  /** Tiling of the textures in uv units. */
  uvScale?: [number, number];
}

/** A drawable model: LOD 0 is the most detailed; all LODs share the material list. */
export interface ModelData {
  name: string;
  lods: MeshData[];
  materials: PbrMaterialDef[];
}

// ------------------------------------------------------------------------------------- shared resources

/**
 * GPU resources that one feature publishes and others consume. The render core owns the registry and
 * provides a neutral default for every key (white / black / empty) so each feature works alone.
 */
export interface SharedResourceMap {
  /** 256x64 rgba16float, Bruneton (r, mu) parameterisation, per atmosphere body index. */
  'atmosphere.transmittanceLut': GPUTextureView;
  /** 192x108 rgba16float sky radiance around the camera (pre-exposure-free, cd/m^2). */
  'atmosphere.skyViewLut': GPUTextureView;
  /** 64x16 rgba16float hemispherical sky illuminance (mu_s, r). */
  'atmosphere.skyIrradianceLut': GPUTextureView;
  /** Orthographic cloud optical-depth map around the camera for near-field cloud shadows. */
  'clouds.shadowMap': GPUTextureView;
  /** Global cloud coverage (equirect) for far-field shadows and the environment probe. */
  'clouds.coverageMap': GPUTextureView;
  /** 64^2 x 6 rgba16float prefiltered environment cube at the active vessel (luminance, cd/m^2). */
  'env.probeCube': GPUTextureView;
  /** 9 x vec4 SH coefficients of the environment (illuminance), uniform buffer. */
  'env.sh9': GPUBuffer;
  /** Ocean FFT cascades: displacement and slope/Jacobian arrays. */
  'ocean.displacement': GPUTextureView;
  'ocean.derivatives': GPUTextureView;
  /** 512^2 rgba8 navball render (also used by the cockpit instrument). */
  'ui.navball': GPUTextureView;
  /** Array texture of cockpit multi-function displays. */
  'ui.mfd': GPUTextureView;
  /** Scene depth of the current frame at render resolution (reversed-Z). */
  'scene.depth': GPUTextureView;
  /** Scene colour copied before transparents (refraction source). */
  'scene.colorCopy': GPUTextureView;
  /** Sun shadow cascade array + its uniform buffer (matrices, splits). */
  'shadow.cascades': GPUTextureView;
  'shadow.uniforms': GPUBuffer;
}
export type SharedResourceKey = keyof SharedResourceMap;

export interface SharedResources {
  publish<K extends SharedResourceKey>(key: K, value: SharedResourceMap[K]): void;
  /** Always returns a usable resource (the default until someone publishes). */
  get<K extends SharedResourceKey>(key: K): SharedResourceMap[K];
  /** Monotonic counter bumped on every publish of `key` (rebuild bind groups when it changes). */
  version(key: SharedResourceKey): number;
}

/** WGSL chunk registry with `#include "name"` expansion and compile-error capture. */
export interface ShaderLibrary {
  register(name: string, wgsl: string): void;
  /** Expand includes and compile; compilation errors are reported to window.__test.errors. */
  createModule(label: string, wgsl: string): GPUShaderModule;
}

export interface PerfRecorder {
  /** timestampWrites for a pass named `name` (undefined when timestamp-query is unavailable). */
  gpuPass(name: string): GPURenderPassTimestampWrites | GPUComputePassTimestampWrites | undefined;
  cpuBegin(name: string): void;
  cpuEnd(name: string): void;
  counter(name: string, value: number): void;
}

export interface QualitySettings {
  /** Internal resolution scale bounds for dynamic resolution (TAAU). */
  renderScaleMin: number;
  renderScaleMax: number;
  /** Target on-screen size of a terrain quad, px. */
  terrainPxPerQuad: number;
  shadowResolution: number;
  cloudSteps: number;
  atmosphereSteps: number;
}

// ----------------------------------------------------------------------------------------- frame context

export interface BodyPose {
  id: string;
  /** Body centre relative to the camera, ROOT axes, float64 (narrow to f32 only after adding local offsets). */
  centerRelCam: Vec3;
  qFixedToRoot: Quat;
  prevCenterRelCam: Vec3;
  prevQFixedToRoot: Quat;
  /** Camera position in the body-fixed frame (float64) and its altitude above the reference radius. */
  cameraFixed: Vec3;
  cameraAltitude: number;
  /** Unit direction to the star in ROOT axes. */
  sunDir: Vec3;
}

export interface VesselPose {
  id: string;
  /** VES origin relative to the camera, ROOT axes, float64; VES -> ROOT orientation; same for the previous frame. */
  originRelCam: Vec3;
  q: Quat;
  prevOriginRelCam: Vec3;
  prevQ: Quat;
}

export interface LocalLight {
  kind: 'point' | 'capsule';
  /** Camera-relative position (and second end point for capsules), ROOT axes. */
  posRelCam: Vec3;
  endRelCam?: Vec3;
  /** Linear-sRGB colour times luminous intensity, cd. */
  intensity: Vec3Tuple;
  /** Influence radius, m. */
  range: number;
}

export interface ShadowCascadeView {
  index: number;
  /** World(camera-relative, ROOT axes) -> shadow clip. */
  viewProj: Mat4;
  /** World-space size of one shadow texel, m. */
  texelSize: number;
  /** Far distance of this cascade from the camera, m. */
  farDistance: number;
}

export interface FrameContext {
  frameIndex: number;
  /** Wall-clock seconds since start and delta for this frame. */
  realTime: number;
  realDt: number;
  snapshot: SimSnapshot;
  prevSnapshot: SimSnapshot;
  camera: CameraState;
  prevCamera: CameraState;
  /** Internal render resolution and final display resolution, px. */
  renderSize: [number, number];
  displaySize: [number, number];
  /** ROOT -> view rotation (no translation: the eye is the origin), and projections with/without TAA jitter. */
  view: Mat4;
  proj: Mat4;
  projUnjittered: Mat4;
  /** proj * view of the previous frame (unjittered), for motion vectors of camera-relative positions. */
  prevViewProj: Mat4;
  /** Camera translation since the previous frame in ROOT axes, float64 (prevEye - eye). */
  prevEyeOffset: Vec3;
  jitterPx: [number, number];
  bodies: BodyPose[];
  vessels: VesselPose[];
  bodyPose(id: string): BodyPose;
  vesselPose(id: string): VesselPose | undefined;
  /** The star as seen from the camera: unit direction (ROOT axes), illuminance (lux), colour, angular radius. */
  sun: { dirRoot: Vec3; illuminance: number; color: Vec3Tuple; angularRadius: number; bodyId: string };
  /** Multiply photometric radiance by this before writing to the HDR target. */
  exposure: number;
  ev100: number;
  observers: LodObserver[];
  /** Lights registered for this frame by features during prepare() (plumes, plasma, cabin lights). */
  lights: LocalLight[];
  /** Bind group 0 (frame uniforms, shared samplers, blue noise); layout in docs/RENDER_API.md. */
  frameBindGroup: GPUBindGroup;
  /** False while a deterministic screenshot is being taken with frozen time (features must not animate noise). */
  animate: boolean;
}

export interface RenderContext {
  device: GPUDevice;
  canvasFormat: GPUTextureFormat;
  defs: DefLibrary;
  resources: SharedResources;
  shaders: ShaderLibrary;
  perf: PerfRecorder;
  quality: QualitySettings;
  frameBindGroupLayout: GPUBindGroupLayout;
  /** Base URLs (no trailing slash) for baked tiles, sky data and static assets. */
  tilesUrl: string;
  skyUrl: string;
  assetsUrl: string;
}

/**
 * A pluggable piece of the frame. All hooks are optional; the render core calls them in frame-graph order:
 *   prepare -> compute -> drawShadow (per cascade) -> drawGBuffer -> [core: AO, deferred lighting] ->
 *   drawWater -> drawBackground -> compositeAtmosphere -> drawTransparent -> [core: TAA, bloom, tonemap] ->
 *   drawOverlay.
 * Features never create their own swap-chain passes and never read another feature's internals; they
 * exchange GPU data only through SharedResources.
 */
export interface RenderFeature {
  readonly id: string;
  init(ctx: RenderContext): void | Promise<void>;
  /** CPU work: culling, streaming, uniform uploads, registering lights. */
  prepare?(frame: FrameContext): void;
  /** Compute passes that must run before rasterisation (LUTs, FFT, particle simulation). */
  compute?(frame: FrameContext, encoder: GPUCommandEncoder): void;
  drawShadow?(frame: FrameContext, pass: GPURenderPassEncoder, cascade: ShadowCascadeView): void;
  /** Opaque geometry into the G-buffer (targets: RENDER_FORMATS gbuffer*, HDR emissive, depth). */
  drawGBuffer?(frame: FrameContext, pass: GPURenderPassEncoder): void;
  /** Forward water/refraction pass after deferred lighting (HDR + depth + velocity). */
  drawWater?(frame: FrameContext, pass: GPURenderPassEncoder): void;
  /** Sky background where depth == 0 (stars, star disc, distant bodies). HDR target. */
  drawBackground?(frame: FrameContext, pass: GPURenderPassEncoder): void;
  /** Atmosphere/cloud march and composite over the lit scene; the feature creates its own passes on `encoder`. */
  compositeAtmosphere?(frame: FrameContext, encoder: GPUCommandEncoder, hdrTarget: GPUTextureView): void;
  /** Forward transparents and volumetrics (plumes, plasma, particles, glass, canopies). HDR target, depth read-only. */
  drawTransparent?(frame: FrameContext, pass: GPURenderPassEncoder): void;
  /** LDR overlay after tonemapping, at display resolution (orbit lines, markers). No depth attachment. */
  drawOverlay?(frame: FrameContext, pass: GPURenderPassEncoder): void;
  /** True when nothing is loading/compiling (used by deterministic screenshots). */
  isIdle?(): boolean;
  dispose?(): void;
}

/** The renderer facade used by the app shell. */
export interface Renderer {
  readonly context: RenderContext;
  addFeature(feature: RenderFeature): Promise<void>;
  resize(displayWidth: number, displayHeight: number): void;
  /** Render one frame. */
  render(snapshot: SimSnapshot, camera: CameraState, observers: LodObserver[], realDt: number): void;
  isIdle(): boolean;
  perfSnapshot(): PerfSnapshot;
  /** Read back the HDR target statistics (tests): max/mean luminance and NaN count. */
  readHdrStats(): Promise<{ maxLuminance: number; meanLuminance: number; nanPixels: number }>;
}

/** window.__perf */
export interface PerfSnapshot {
  /** requestAnimationFrame deltas over the measurement window, ms. */
  raf: { p50: number; p95: number; p99: number; max: number; count: number; over33ms: number };
  /** Main-thread time inside the frame function, ms. */
  cpu: { p50: number; p95: number; p99: number };
  /** Sum of GPU pass times from timestamp queries, ms. */
  gpu: { p50: number; p95: number; p99: number };
  /** Latest per-pass timings, ms. */
  passes: Record<string, { gpuMs: number; cpuMs: number }>;
  counters: Record<string, number>;
  renderScale: number;
}
