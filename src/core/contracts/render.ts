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

/**
 * Name of a camera rig. The three built-in views plus any rig added later (EVA first/third person...).
 * Consumers must NOT switch exhaustively on this: they branch on `ViewKind` and treat unknown modes by
 * their kind.
 */
export type ViewMode = 'cockpit' | 'chase' | 'map' | (string & {});

/** What a view is for presentation purposes: inside a vessel, an external camera, or the map. */
export type ViewKind = 'interior' | 'external' | 'map';

export const RENDER_FORMATS = {
  /** Pre-exposed scene radiance. */
  hdr: 'rgba16float',
  depth: 'depth32float',
  /** G-buffer RT0: base colour rgb (sRGB encoded), a = baked AO / cavity. */
  gbufferAlbedo: 'rgba8unorm-srgb',
  /** G-buffer RT1: octahedral-encoded world (ROOT-axes) normal. */
  gbufferNormal: 'rg16float',
  /** G-buffer RT2: r = perceptual roughness, g = metallic, b = material id / 255, a = material parameter (see MATERIAL_PARAM). */
  gbufferMaterial: 'rgba8unorm',
  /** G-buffer RT3: screen-space velocity in UV units (current - previous). */
  gbufferVelocity: 'rg16float',
  /**
   * G-buffer RT4, used by MATERIAL_ID.standard (every other material writes 0, 0.5, 0, 0):
   * r = tangent angle / 2 pi about the normal, measured in the canonical tangent frame of the gbuffer chunk
   * (`tangentFrame(n)`), g = anisotropy * 0.5 + 0.5, b = clearcoat weight, a = clearcoat perceptual roughness.
   */
  gbufferExtra: 'rgba8unorm',
  /** Sun shadow cascades: standard (non-reversed) orthographic depth. */
  shadow: 'depth32float',
} as const satisfies Record<string, GPUTextureFormat>;

/** Near plane distance in metres (cockpit geometry is centimetres from the eye). */
export const NEAR_PLANE = 0.05;

/**
 * Largest value any feature may write to the pre-exposed HDR target. rgba16float overflows at 65504, and an
 * Inf turns into NaN in bloom and TAA history. Every HDR write goes through the frame chunk's
 * `writeHdr(rgb)` (min with this value, NaN -> 0); the sun disc and mirror glints simply saturate here.
 */
export const HDR_MAX = 60000;

/**
 * Water depth carried in RT2.a for MATERIAL_ID.water: encoded = sqrt(saturate(depth / WATER_DEPTH_ENCODE_MAX)).
 * Gives 3 mm steps at the shoreline and 1.6 m steps at 200 m (deeper water is optically identical).
 * WGSL helpers `encodeWaterDepth` / `decodeWaterDepth` live in the gbuffer chunk; the writer (terrain) and
 * the readers (default and overridden brdf_water) must use them.
 */
export const WATER_DEPTH_ENCODE_MAX = 200;

/** Vessel slots and byte size of the 'ocean.wetness' uniform buffer (count vec4u + slots x 3 vec4f). */
export const OCEAN_WETNESS_SLOTS = 8;
export const OCEAN_WETNESS_BYTES = 16 + OCEAN_WETNESS_SLOTS * 48;

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

/** Meaning of the single material parameter RT2.a for each material id. */
export const MATERIAL_PARAM: Readonly<Record<MaterialIdName, string>> = {
  standard: 'wetness 0..1 (darkens and smooths; 0 for dry hardware)',
  terrain: 'wetness 0..1 (shoreline, deluge)',
  regolith: 'crater freshness / maturity 0..1 (drives the opposition-surge parameters)',
  water: 'encoded water depth (WATER_DEPTH_ENCODE_MAX)',
  cloth: 'thin-surface translucency 0..1 (parachute fabric back-lighting)',
  display: 'display brightness 0..1 (the emitted colour itself is written to the HDR emissive target)',
};

// ------------------------------------------------------------------------------------------------ camera

export interface CameraState {
  mode: ViewMode;
  /** How consumers treat this view (audio mix, exposure metering, HUD layout). */
  kind: ViewKind;
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
  /** Map view: request to focus another body/vessel (from MapUpdateResult.focus or a UI control). */
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
  /** Clearcoat weight and roughness (shading 'standard' only; stored in G-buffer RT4.ba). */
  clearcoat?: number;
  clearcoatRoughness?: number;
  /**
   * -1..1 anisotropy along the mesh tangent (brushed metal, MLI foil); shading 'standard' only. The tangent
   * direction is written to G-buffer RT4.r, so anisotropic GGX is evaluated in the deferred pass.
   */
  anisotropy?: number;
  /** 0..1 thin-surface translucency (shading 'cloth' only; stored in RT2.a). */
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
  /**
   * Camera-frustum aerial-perspective volume, 32 x 32 x 32 rgba16float: rgb = in-scattered luminance between
   * the eye and the froxel (cd/m^2, NOT pre-exposed), a = mean transmittance. Slice <-> distance mapping is
   * `aerialSliceToDistance` / `aerialDistanceToSlice` in the atmosphere_common chunk. Default: rgb 0, a 1.
   * Everything drawn after the atmosphere composite (transparents) applies it through `applyAtmosphere()`.
   */
  'atmosphere.aerialPerspective': GPUTextureView;
  /**
   * Orthographic cloud optical-depth map around the camera for near-field cloud shadows (r = optical depth
   * along the local vertical).
   *
   * PLACEMENT of both cloud shadow maps is not a shared resource: it is CPU data that changes every frame
   * (the near map follows the camera), so the publishing feature passes it to the render core in `prepare`,
   * every frame, with `coreOf(ctx).setCloudShadowParams({ near, far })` (src/render/core public API, types
   * `CloudShadowNear` / `CloudShadowFar`; docs/RENDER_API.md section 7). The core writes it into the frame
   * uniforms (`cloudNear0..2`, `cloudFar`) after all `prepare` hooks; `null` switches a term off, which is
   * also the default. This is the only path: there is no 'clouds.shadowParams' key.
   */
  'clouds.shadowMap': GPUTextureView;
  /**
   * Global cloud coverage (equirect, row 0 = north, column 0 = longitude -180 deg, r = coverage) for
   * far-field shadows and the environment probe. Layer radius, optical depth and longitude advection: the
   * `far` member of `setCloudShadowParams` (see 'clouds.shadowMap').
   */
  'clouds.coverageMap': GPUTextureView;
  /**
   * Result of this frame's cloud march at half render resolution, rgba16float: rgb = cloud radiance
   * (pre-exposed, premultiplied), a = transmittance through the clouds. Default: rgb 0, a 1.
   */
  'clouds.screen': GPUTextureView;
  /**
   * Half-resolution r32float: transmittance-weighted mean distance from the eye to the cloud in front of
   * each pixel, metres (3.0e38 where there is none, which is also the default). Transparents farther than
   * this are attenuated by 'clouds.screen'.a inside `applyAtmosphere()`.
   */
  'clouds.depth': GPUTextureView;
  /** 64^2 x 6 rgba16float prefiltered environment cube at the active vessel (luminance, cd/m^2). */
  'env.probeCube': GPUTextureView;
  /** 9 x vec4 SH coefficients of the environment (illuminance), uniform buffer. */
  'env.sh9': GPUBuffer;
  /** Ocean FFT cascades: displacement and slope/Jacobian arrays. */
  'ocean.displacement': GPUTextureView;
  'ocean.derivatives': GPUTextureView;
  /**
   * Hand-over between the far (deferred, G-buffer) sea surface and the near forward wave surface.
   * Uniform buffer, 16 bytes: i32 bodyIndex (index into the frame body list, -1 = no near field),
   * f32 fadeStart, f32 fadeEnd (metres from the eye), f32 reserved. Default: bodyIndex -1, radii 0.
   * Rules (ARCHITECTURE section 10.2): the far-water writer discards its sea-level sheet where the eye
   * distance is below fadeStart; the forward pass draws out to fadeEnd with opacity 1 inside fadeStart
   * falling to 0 at fadeEnd, and with displacement, refraction and shore foam already zero at fadeStart.
   */
  'ocean.nearField': GPUBuffer;
  /**
   * Water at the vessels that float or are entering it, for hull shading (wet line, darkening below the
   * waterline). Uniform buffer of OCEAN_WETNESS_BYTES, published by the ocean feature and refreshed every
   * frame in prepare / compute. WGSL (binding set 'oceanWetness' of the render core declares both structs
   * and `oceanWetness`):
   *
   *   struct OceanVesselWater {
   *     plane: vec4f,   // xyz = point of the physics swell surface (oceanSwellHeight) under the vessel origin,
   *                     //       camera-relative, ROOT axes, m; w = radius (m) of the sphere about that point
   *                     //       inside which the slot applies (the vessel's bounding radius plus a margin);
   *                     //       0 = unused slot
   *     normal: vec4f,  // xyz = unit normal of the swell surface there (ROOT axes, pointing up); w = wet line:
   *                     //       highest level the water has reached on the hull above that plane, m (dries
   *                     //       back towards the current waterline)
   *     params: vec4f,  // x = waterSubmersion 0..1 of the vessel (snapshot), y = seconds since its last splash /
   *                     //       touchdown on water (-1 = none), z = amplitude bound of the render-only chop at
   *                     //       the hull (m), w = drying rate of the wet line (m/s)
   *   }
   *   struct OceanWetness { count: vec4u, vessels: array<OceanVesselWater, 8> }   // count.x = slots in use
   *
   * Slots 0 .. count.x - 1 are in use, the active vessel first when it is at the water; at most
   * OCEAN_WETNESS_SLOTS vessels. A consumer does not need a vessel index: a surface point p (camera-relative)
   * belongs to slot i when length(p - plane.xyz) < plane.w, its height above the water is
   * dot(p - plane.xyz, normal.xyz), and it is wet when that height is below normal.w.
   * Default: count 0, every slot unused.
   */
  'ocean.wetness': GPUBuffer;
  /** 512^2 rgba8 navball render (also used by the cockpit instrument). */
  'ui.navball': GPUTextureView;
  /** Array texture of cockpit multi-function displays. */
  'ui.mfd': GPUTextureView;
  /**
   * Sampleable COPIES of the reversed-Z depth attachment at render resolution (depth32float, bound as
   * texture_depth_2d, read with textureLoad). The live depth attachment itself is never sampled.
   *  - 'scene.depthOpaque': taken after the G-buffer pass (opaque geometry and the far water sheet; no
   *    near-field waves). Valid from deferred lighting to the end of the frame. The ocean reads the seabed here.
   *  - 'scene.depth': taken after drawWater (opaque + near water). Valid in compositeAtmosphere,
   *    preTransparent and drawTransparent; in prepare/compute of the NEXT frame it still holds the previous frame.
   *  - 'scene.depthHalf': half render resolution rg32float built from 'scene.depth': r = farthest (min) and
   *    g = nearest (max) reversed-Z depth of each 2 x 2 block. For half-resolution volumetrics and the
   *    core's depth-aware upsample. Same validity as 'scene.depth'.
   */
  'scene.depthOpaque': GPUTextureView;
  'scene.depth': GPUTextureView;
  'scene.depthHalf': GPUTextureView;
  /**
   * Copies of the pre-exposed HDR target (rgba16float, render resolution), made only when a registered
   * feature lists the key in `RenderFeature.requires`:
   *  - 'scene.colorCopy': after deferred lighting, before drawWater (the lit opaque scene: refraction source for water).
   *  - 'scene.colorCopyTransparent': after preTransparent, before drawTransparent (everything except
   *    transparents: refraction source for glass and heat shimmer).
   */
  'scene.colorCopy': GPUTextureView;
  'scene.colorCopyTransparent': GPUTextureView;
  /**
   * Three G-buffer targets of THIS frame at render resolution, read-only, as the live views (no copy is made:
   * they are attachments of the G-buffer pass and of no later pass):
   *  - 'gbuffer.albedo': RT0 (rgba8unorm-srgb, so a read returns LINEAR colour); a = baked AO / cavity.
   *  - 'gbuffer.normal': RT1, octahedral world normal (`octDecode` of the gbuffer chunk).
   *  - 'gbuffer.material': RT2, r = perceptual roughness, g = metallic, b = material id / 255, a = material
   *    parameter (MATERIAL_PARAM; `decodeWaterDepth` for MATERIAL_ID.water).
   * Valid from deferred lighting to the end of the frame: in drawWater, drawBackground, compositeAtmosphere,
   * preTransparent and drawTransparent. In prepare / compute / drawShadow they still hold the previous frame.
   * NEVER set a bind group that contains them inside drawGBuffer: they are that pass's attachments and WebGPU
   * rejects the pass, even when no draw uses the group. Read with textureLoad at the fragment's pixel.
   * What they hold for water (ARCHITECTURE section 10.2): outside 'ocean.nearField'.fadeStart the far sheet
   * (MATERIAL_ID.water, imagery colour in albedo, encoded depth in material.a, sea-surface normal); inside
   * it the sheet is discarded, so they hold the seabed. This is how the forward water pass shades the band
   * between fadeStart and fadeEnd with exactly the inputs the deferred sheet had.
   * Re-published when the internal resolution changes. Default: 1 x 1, all zero.
   */
  'gbuffer.albedo': GPUTextureView;
  'gbuffer.normal': GPUTextureView;
  'gbuffer.material': GPUTextureView;
  /** Sun shadow cascade array + its uniform buffer (per-frame world-to-shadow matrices, splits). */
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
  /**
   * timestampWrites for a pass named `name` (undefined when timestamp-query is unavailable). Passes that a
   * feature creates itself must be named `<featureId>.<pass>`. Draws a feature makes inside a core-owned
   * pass are attributed by the core (see RENDER_API.md), so PerfSnapshot.features is a complete
   * per-feature breakdown.
   */
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

/**
 * One sun shadow cascade. Cascades are anchored and texel-snapped in a MOVING frame: the body-fixed frame
 * of the body they cover (the ground never moves in it, although it moves 0.4-1.7 km/s in ROOT axes), or
 * the vessel frame for the cockpit cascade. The render core re-derives `viewProj` EVERY frame in float64
 * as captureViewProj x (motion of the anchor frame since capture), so a cascade that is re-rendered only
 * every few frames still lines up with the ground it was rendered from.
 */
export interface ShadowCascadeView {
  index: number;
  /** World (camera-relative, ROOT axes) -> shadow clip, valid for THIS frame. */
  viewProj: Mat4;
  /**
   * World-space size of one shadow texel along u, m: the coarser of the two axes (a staggered camera cascade
   * fitted to its receivers at low sun has finer texels along v). Use it for caster LOD and small-caster
   * culling.
   */
  texelSize: number;
  /** World-space size of one shadow texel along v, m. Equal to `texelSize` for a square cascade, never larger. */
  texelSizeV: number;
  /**
   * Far distance of this cascade from the camera, m (Infinity for a cascade fitted to a whole distant body).
   * Ground inside this distance is inside the map, but the footprint is not always a square of
   * 2 x farDistance around the camera: at low sun it is a band (as wide as before along u, up to 16 times
   * narrower along v, centred on the ground it shadows). Cull casters against `viewProj`
   * (|clip.x|, |clip.y| <= 1 + margin), never by distance from the camera.
   */
  farDistance: number;
  /** Frame the cascade is anchored to. */
  anchor: { kind: 'body' | 'vessel'; id: string };
  /**
   * True when this cascade is re-rendered every frame. Moving casters (vessels, debris, canopies, anything
   * not fixed to the anchor body) draw ONLY into cascades with everyFrame = true; staggered cascades hold
   * body-fixed casters (terrain, rocks, site structures) exclusively.
   */
  everyFrame: boolean;
  /** 'camera': fitted to a slice of the view frustum. 'body': fitted to the sunlit disc of a whole distant body. */
  fit: 'camera' | 'body';
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
  /** Multiply photometric radiance by this before writing to the HDR target (then clamp with writeHdr). */
  exposure: number;
  ev100: number;
  /**
   * GPU load governor, 0.5..1. The core lowers it when the measured GPU frame time approaches the budget
   * (ARCHITECTURE section 17) and raises it back with hysteresis. Features with scalable sample counts
   * (cloud and atmosphere march steps, plume and smoke march steps, particle counts) multiply them by this
   * BEFORE the core resorts to lowering the render resolution. Always 1 during deterministic screenshots.
   */
  qualityScale: number;
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
 * A pluggable piece of the frame. All hooks are optional; the render core calls them in frame-graph order
 * (docs/ARCHITECTURE.md section 10 has the table with attachments and load/store rules):
 *
 *   prepare -> compute -> drawShadow (per re-rendered cascade) -> drawGBuffer
 *     -> [core: copy 'scene.depthOpaque'; AO, contact shadows, deferred lighting; copy 'scene.colorCopy']
 *   -> drawWater
 *     -> [core: copy 'scene.depth', build 'scene.depthHalf']
 *   -> drawBackground -> compositeAtmosphere -> preTransparent
 *     -> [core: copy 'scene.colorCopyTransparent']
 *   -> drawTransparent
 *     -> [core: TAA, bloom, exposure, tonemap]
 *   -> drawOverlay.
 *
 * WebGPU forbids sampling a texture that is an attachment of the current pass, hence the copies: hooks
 * sample the published copies, never the live targets. Features never create their own swap-chain passes
 * and never read another feature's internals; they exchange GPU data only through SharedResources.
 * Within one hook, features run in ascending `order`, ties in registration order.
 */
export interface RenderFeature {
  readonly id: string;
  /** Sort key within each hook (default 0). */
  readonly order?: number;
  /** Optional scene copies this feature samples; the core makes only the copies somebody asks for. */
  readonly requires?: readonly ('scene.colorCopy' | 'scene.colorCopyTransparent')[];
  init(ctx: RenderContext): void | Promise<void>;
  /** CPU work: culling, streaming, uniform uploads, registering lights. */
  prepare?(frame: FrameContext): void;
  /** Compute passes that must run before rasterisation (LUTs, FFT, particle simulation). */
  compute?(frame: FrameContext, encoder: GPUCommandEncoder): void;
  /**
   * Depth-only draw into one cascade (called only for cascades re-rendered this frame). Honour
   * `cascade.everyFrame`: moving casters draw only when it is true.
   */
  drawShadow?(frame: FrameContext, pass: GPURenderPassEncoder, cascade: ShadowCascadeView): void;
  /**
   * Opaque geometry into the G-buffer. Colour targets in this order: RT0 albedo, RT1 normal, RT2 material,
   * RT3 velocity, RT4 extra, then HDR emissive; depth write, compare 'greater'.
   */
  drawGBuffer?(frame: FrameContext, pass: GPURenderPassEncoder): void;
  /**
   * Forward water after deferred lighting. Colour targets: HDR (blending allowed) and RT3 velocity; the
   * depth attachment is writable (compare 'greater-equal'). Sample the seabed from 'scene.depthOpaque' and
   * 'scene.colorCopy', never from the live targets. The G-buffer inputs of the pixel underneath (the far
   * sheet's imagery colour, encoded depth, normal and roughness, or the seabed's) are readable through
   * 'gbuffer.albedo' / 'gbuffer.normal' / 'gbuffer.material', which are not attachments of this pass.
   */
  drawWater?(frame: FrameContext, pass: GPURenderPassEncoder): void;
  /** Sky background where depth == 0 (stars, star disc, distant bodies). HDR target; depth read-only, compare 'equal'. */
  drawBackground?(frame: FrameContext, pass: GPURenderPassEncoder): void;
  /**
   * Atmosphere/cloud march and composite over the lit scene; the feature creates its own passes on
   * `encoder` (half-resolution march targets, then a blend into `hdrTarget`). May sample 'scene.depth' and
   * 'scene.depthHalf'. Publishes 'atmosphere.aerialPerspective', 'clouds.screen' and 'clouds.depth'.
   */
  compositeAtmosphere?(frame: FrameContext, encoder: GPUCommandEncoder, hdrTarget: GPUTextureView): void;
  /**
   * Offscreen work that needs THIS frame's depth before the transparent pass: half-resolution ray-marched
   * volumes (plumes, smoke, plasma), particle lighting. The feature creates its own passes on `encoder`
   * into its own targets and must not touch the HDR target; it composites the result in drawTransparent
   * (core helper: depth-aware upsample from 'scene.depthHalf').
   */
  preTransparent?(frame: FrameContext, encoder: GPUCommandEncoder): void;
  /**
   * Forward transparents and composites of preTransparent results (plumes, plasma, particles, canopies,
   * glass). HDR target with blending (premultiplied, or dual-source where a per-channel transmittance is
   * needed); depth read-only, compare 'greater-equal'. Everything drawn here applies `applyAtmosphere()`
   * (aerial perspective + cloud occlusion), because the atmosphere composite has already happened.
   */
  drawTransparent?(frame: FrameContext, pass: GPURenderPassEncoder): void;
  /**
   * LDR overlay after tonemapping, at display resolution (orbit lines, markers). The pass is the core's
   * tonemap pass onto the canvas: one colour target in `RenderContext.canvasFormat` (the swap chain's own
   * non-sRGB view, canvas `alphaMode: 'opaque'`), no depth attachment, sample count 1. Write
   * display-referred, sRGB-ENCODED values; blend with premultiplied alpha
   * (`src-factor: one, dst-factor: one-minus-src-alpha`). `frame.displaySize` is in device pixels.
   */
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
  /**
   * Per-feature totals (p99 over the window), ms: GPU time of the feature's own passes plus its share of
   * core-owned passes, and CPU time of its hooks. Keys are RenderFeature ids plus 'core'.
   * The budget table in ARCHITECTURE section 17 is enforced against this.
   */
  features: Record<string, { gpuMs: number; cpuMs: number }>;
  /** Current GPU load governor value (FrameContext.qualityScale). */
  qualityScale: number;
  counters: Record<string, number>;
  renderScale: number;
}
