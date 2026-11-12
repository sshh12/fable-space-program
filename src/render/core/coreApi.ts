/**
 * Helpers the render core offers to features beyond the RenderContext contract. Obtain with
 * `coreOf(ctx)` inside `RenderFeature.init`.
 */
import type { RenderContext } from '@/core/contracts/render';
import type { CloudShadowParams } from './frame/uniforms';
import type { MeshSystem } from './mesh/meshSystem';
import type { SceneBindings, SceneBindingSet } from './sceneBindings';
import type { CoreShaderLibrary, Tracked } from './shaders/library';
import type { MipGenerator } from './util/gpu';

/** A render target that follows the internal render resolution (re-created on resize / dynamic resolution). */
export interface ManagedTarget {
  /** Current texture and view; `version` changes whenever they were re-created. */
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly size: [number, number];
  readonly version: number;
  destroy(): void;
}

export interface FullscreenPipelineDesc {
  label: string;
  /**
   * WGSL with a fragment entry point `fs(in: FullscreenOut)`. `#include "frame"` and `#include "fullscreen"`
   * are added automatically; group 0 is the frame group.
   */
  fragment: string;
  targets: GPUColorTargetState[];
  /** Bind group layouts for groups 1.. (group 0 is always the frame layout). */
  layouts?: GPUBindGroupLayout[];
  depthStencil?: GPUDepthStencilState;
}

/**
 * What a feature with accumulation of its own adds to its RenderFeature (request lead-3; RENDER_API section
 * 13, "Frame-exact capture"). The core calls `resetTemporal` when every temporal sequence starts again at
 * its origin (CoreRenderer.renderExact), before the first frame of the restarted sequences: the feature drops
 * its histories (reprojection, accumulation, foam, progressive maps) and restarts its phases (round robins,
 * noise rotations) so that the frames that follow depend on the scene alone, not on the frames before.
 */
export interface TemporalFeature {
  resetTemporal?(): void;
}

export interface CoreApi {
  readonly meshes: MeshSystem;
  readonly shaders: CoreShaderLibrary;
  readonly mips: MipGenerator;
  /** Layout of group 1 in every drawShadow pipeline (the core binds the group; WGSL in chunk "shadow_pass"). */
  readonly shadowPassLayout: GPUBindGroupLayout;
  /** Format of the swap chain / overlay pass, HDR target etc. are in RENDER_FORMATS. */
  reportError(message: string): void;
  /** Binding sets for SharedResources in a feature's own pass group (WGSL + layout entries + entries). */
  createSceneBindings(group: number, firstBinding: number, sets: readonly SceneBindingSet[]): SceneBindings;
  /** A pipeline that draws one fullscreen triangle (draw(3)); rebuilt automatically when an included chunk is replaced. */
  fullscreenPipeline(desc: FullscreenPipelineDesc): Tracked<GPURenderPipeline>;
  /** A target at `scale` x the internal render resolution (0.5 = the size of 'scene.depthHalf'). */
  createTarget(label: string, format: GPUTextureFormat, scale: number, usage?: GPUTextureUsageFlags): ManagedTarget;
  /**
   * Placement of the cloud shadow maps for the deferred sun term. Call every frame from `prepare` or
   * `compute` (the near map follows the camera); pass null to switch a term off. Defaults: both off.
   */
  setCloudShadowParams(params: Partial<CloudShadowParams>): void;
  /** Checked allocation: out-of-memory is reported through window.__test.errors instead of an uncaptured error. */
  createTextureChecked(desc: GPUTextureDescriptor): GPUTexture;
  /**
   * Tell the exposure meter about a bright emitter that is drawn this frame (a plume, a reentry trail or a
   * fireball: the meter's histogram is taken before the transparent pass and holds lit geometry, water and
   * clouds only, so it cannot see it, in front of the sky or of geometry). Call from `prepare`, every frame
   * the emitter is in view; several calls add up. `luminance` is the representative luminance of its
   * visible part in cd/m^2 (not pre-exposed), `coverage` the fraction of the frame it covers.
   * Rule: docs/RENDER_API.md section 13 (under the sun a hint cannot raise the exposure target further
   * than half a stop above sunny 16).
   * `inside` (request cockpit-19): the hint is for an INTERIOR view, from whoever knows the cabin's windows:
   * `luminance` is what the panes show of the emitter, `coverage` the share of the frame those panes cover.
   * It then counts as part of the outside seen through the windows (the cabin is keyed low beside it and the
   * panes are shown at their own exposure, as a sunlit world in them is); exterior and map views ignore it,
   * as an interior view ignores a hint without the flag.
   */
  addEmissiveHint(luminance: number, coverage: number, inside?: boolean): void;
  /**
   * The current frame's place in the temporal sequences: `frame.frameIndex` until the first frame-exact
   * capture, afterwards the frames since the sequences last started (0 in the first frame of a capture and
   * of each metering of its lead-in; the number the frame uniforms carry in `time.z` / `counts.z`). For a
   * phase or a sample sequence computed on the CPU that is NOT `frame.frameIndex` modulo a power of two up
   * to 16: a golden-ratio rotation, a round of 48 frames, a seed. Taken from this it repeats in every
   * capture; taken from the absolute frame index it does not (the capture's first frame index is a
   * multiple of 64, a different one each time). The sequences only ever start at frame indices that are
   * multiples of 16, so `sequenceIndex() & 15` equals `frame.frameIndex & 15`. Call it inside a frame hook.
   */
  sequenceIndex(): number;
}

const registry = new WeakMap<RenderContext, CoreApi>();

export function registerCore(ctx: RenderContext, api: CoreApi): void {
  registry.set(ctx, api);
}

/** The core helper API belonging to a RenderContext created by `createRenderer`. */
export function coreOf(ctx: RenderContext): CoreApi {
  const api = registry.get(ctx);
  if (!api) throw new Error('coreOf: this RenderContext was not created by the render core');
  return api;
}
