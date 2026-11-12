/**
 * Public API of the render core. Other packages import ONLY from '@/render/core' (this file) and
 * '@/render/core/lab' (lab pages). docs/RENDER_API.md is the manual.
 */
export { createRenderer, EXACT_METER_FRAMES, EXACT_SETTLE_ROUNDS, SEQUENCE_ALIGN, type CoreRenderer, type ExactInfo, type ExposureInfo, type HdrPixels, type RendererOptions } from './renderer';
export { coreOf, type CoreApi, type FullscreenPipelineDesc, type ManagedTarget, type TemporalFeature } from './coreApi';
export { createSceneBindings, type SceneBindings, type SceneBindingSet } from './sceneBindings';
export type { CoreShaderLibrary, Tracked } from './shaders/library';
export type { CoreSharedResources } from './resources';
export { SHADOW_UNIFORM_BYTES } from './resources';
export { BLUE_NOISE_SIZE, BODY_FLAG, MAX_BODIES, MAX_LIGHTS, SHADOW_SOFTNESS_MAX_M, SHADOW_SOFTNESS_MIN_M, SHINE_PER_RECEIVER, SHINE_RECEIVERS, decodeShadowSoftness, encodeShadowSoftness } from './shaders/chunksFrame';
export { SHADOW_MAX_CASCADES } from './shaders/chunksLighting';
export { BODY_UNIFORM_FLOATS, FRAME_UNIFORM_FLOATS, OFFSET as FRAME_UNIFORM_OFFSET, type CloudShadowFar, type CloudShadowNear, type CloudShadowParams } from './frame/uniforms';
export {
  buildProjection,
  cameraBasis,
  discVisibleFraction,
  halton,
  lambertSpherePhase,
  nearestBody,
  planetshineAt,
  shineVisibleFraction,
  sunAt,
  sunVisibilityAt,
  taaJitter,
  type Projection,
  type ShineLight,
  type SunInfo,
} from './frame/math';
export {
  DEFAULT_LOD_PIXELS,
  INSTANCE_FLOATS,
  LOD_FADE_BAND,
  blackbodyRadiance,
  instanceInFrame,
  type MeshBatch,
  type MeshInstance,
  type MeshSystem,
  type ModelHandle,
  type ModelOptions,
  type ParentPose,
} from './mesh/meshSystem';
export type { ProceduralTexture } from './mesh/textures';
export { boxMesh, cylinderMesh, planeMesh, sphereMesh, triangleCount } from './mesh/primitives';
export { CASCADE_RADII, MAX_CASCADES } from './shadows/cascadeMath';
export { EV_DARK_FLOOR, EV_MAX, EV_MIN, EXPOSURE_K, MID_GREY, exposureFromEv100, ev100ForMidGrey, sunny16Ev } from './post/exposure';
export { DEFAULT_GOVERNOR, type GovernorConfig } from './post/governor';
export { MipGenerator, createSolidTexture, createTextureChecked, f16ToF32, f32ToF16, mipCount, readTexturePixels } from './util/gpu';
