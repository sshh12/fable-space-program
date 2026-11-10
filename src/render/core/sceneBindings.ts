/**
 * Ready-made binding sets for SharedResources. maxBindGroups is 4 (frame / pass / material / object), so a
 * feature that needs shadows, atmosphere LUTs or the scene copies puts them in ITS pass group with this
 * helper: it yields the WGSL declarations (with the names the core chunks expect), the layout entries and
 * the bind group entries, and a version that changes when any underlying resource is re-published.
 */
import type { RenderContext, SharedResourceKey } from '@/core/contracts/render';

export type SceneBindingSet =
  | 'shadow'
  | 'transparency'
  | 'sceneDepth'
  | 'sceneDepthOpaque'
  | 'sceneDepthHalf'
  | 'sceneColor'
  | 'sceneColorTransparent'
  | 'atmosphereLuts'
  | 'env'
  | 'cloudShadow'
  | 'oceanNearField';

interface Slot {
  key: SharedResourceKey;
  decl: string;
  layout: Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'>;
  buffer?: boolean;
}

const tex = (sampleType: GPUTextureSampleType, viewDimension: GPUTextureViewDimension = '2d'): Slot['layout'] => ({ texture: { sampleType, viewDimension } });

const SETS: Record<SceneBindingSet, { prelude?: string; slots: Slot[] }> = {
  shadow: {
    slots: [
      { key: 'shadow.cascades', decl: 'var shadowCascades: texture_depth_2d_array;', layout: tex('depth', '2d-array') },
      { key: 'shadow.uniforms', decl: 'var<uniform> shadowU: ShadowUniforms;', layout: { buffer: { type: 'uniform' } }, buffer: true },
    ],
  },
  transparency: {
    slots: [
      { key: 'atmosphere.aerialPerspective', decl: 'var aerialPerspectiveTex: texture_3d<f32>;', layout: tex('float', '3d') },
      { key: 'clouds.screen', decl: 'var cloudsScreenTex: texture_2d<f32>;', layout: tex('float') },
      { key: 'clouds.depth', decl: 'var cloudsDepthTex: texture_2d<f32>;', layout: tex('float') },
    ],
  },
  sceneDepth: { slots: [{ key: 'scene.depth', decl: 'var sceneDepthTex: texture_depth_2d;', layout: tex('depth') }] },
  sceneDepthOpaque: { slots: [{ key: 'scene.depthOpaque', decl: 'var sceneDepthOpaqueTex: texture_depth_2d;', layout: tex('depth') }] },
  sceneDepthHalf: { slots: [{ key: 'scene.depthHalf', decl: 'var sceneDepthHalfTex: texture_2d<f32>;', layout: tex('unfilterable-float') }] },
  sceneColor: { slots: [{ key: 'scene.colorCopy', decl: 'var sceneColorTex: texture_2d<f32>;', layout: tex('float') }] },
  sceneColorTransparent: { slots: [{ key: 'scene.colorCopyTransparent', decl: 'var sceneColorTransparentTex: texture_2d<f32>;', layout: tex('float') }] },
  atmosphereLuts: {
    slots: [
      { key: 'atmosphere.transmittanceLut', decl: 'var transmittanceLut: texture_2d_array<f32>;', layout: tex('float', '2d-array') },
      { key: 'atmosphere.skyIrradianceLut', decl: 'var skyIrradianceLut: texture_2d_array<f32>;', layout: tex('float', '2d-array') },
      { key: 'atmosphere.skyViewLut', decl: 'var skyViewLut: texture_2d<f32>;', layout: tex('float') },
    ],
  },
  env: {
    prelude: 'struct EnvSh9 { c: array<vec4f, 9> }',
    slots: [
      { key: 'env.probeCube', decl: 'var envProbeCube: texture_cube<f32>;', layout: tex('float', 'cube') },
      { key: 'env.sh9', decl: 'var<uniform> envSh9: EnvSh9;', layout: { buffer: { type: 'uniform' } }, buffer: true },
    ],
  },
  cloudShadow: {
    slots: [
      { key: 'clouds.shadowMap', decl: 'var cloudShadowMapTex: texture_2d<f32>;', layout: tex('float') },
      { key: 'clouds.coverageMap', decl: 'var cloudCoverageMapTex: texture_2d<f32>;', layout: tex('float') },
    ],
  },
  oceanNearField: {
    prelude: 'struct OceanNearField { bodyIndex: i32, fadeStart: f32, fadeEnd: f32, reserved: f32 }',
    slots: [{ key: 'ocean.nearField', decl: 'var<uniform> oceanNearField: OceanNearField;', layout: { buffer: { type: 'uniform' } }, buffer: true }],
  },
};

export interface SceneBindings {
  /** WGSL declarations (`@group(g) @binding(n) var ...`) to paste into the module. */
  readonly wgsl: string;
  readonly layoutEntries: GPUBindGroupLayoutEntry[];
  /** First binding index after the ones used here. */
  readonly nextBinding: number;
  /** Current bind group entries (call again when `version()` changes). */
  entries(): GPUBindGroupEntry[];
  /** Sum of the SharedResources versions of every key bound here. */
  version(): number;
}

export function createSceneBindings(ctx: RenderContext, group: number, firstBinding: number, sets: readonly SceneBindingSet[]): SceneBindings {
  const slots: { binding: number; slot: Slot }[] = [];
  const lines: string[] = [];
  let binding = firstBinding;
  for (const name of sets) {
    const set = SETS[name];
    if (set.prelude) lines.push(set.prelude);
    for (const slot of set.slots) {
      lines.push(`@group(${group}) @binding(${binding}) ${slot.decl}`);
      slots.push({ binding, slot });
      binding++;
    }
  }
  const visibility = GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
  return {
    wgsl: lines.join('\n'),
    layoutEntries: slots.map(({ binding: b, slot }) => ({ binding: b, visibility: slot.buffer ? visibility | GPUShaderStage.VERTEX : visibility, ...slot.layout })),
    nextBinding: binding,
    entries: () =>
      slots.map(({ binding: b, slot }) => {
        const r = ctx.resources.get(slot.key);
        return { binding: b, resource: slot.buffer ? { buffer: r as GPUBuffer } : (r as GPUTextureView) };
      }),
    version: () => slots.reduce((s, { slot }) => s + ctx.resources.version(slot.key), 0),
  };
}
