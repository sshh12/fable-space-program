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
