/**
 * SharedResources registry with a neutral default for every key, so that every feature (and the core's own
 * lighting) works when nobody has published anything.
 */
import { OCEAN_WETNESS_BYTES, type SharedResourceKey, type SharedResourceMap, type SharedResources } from '@/core/contracts/render';
import { SHADOW_MAX_CASCADES } from './shaders/chunksLighting';
import { createSolidTexture } from './util/gpu';

/** Byte size of the 'shadow.uniforms' buffer: count + settings + 8 cascades x (mat4 + 4 vec4). */
export const SHADOW_UNIFORM_BYTES = 32 + SHADOW_MAX_CASCADES * 128;

export interface CoreSharedResources extends SharedResources {
  /** Restore the default of a key (bumps its version). */
  reset(key: SharedResourceKey): void;
  isDefault(key: SharedResourceKey): boolean;
}

export function createSharedResources(device: GPUDevice): CoreSharedResources {
  const tex2d = (label: string, format: Parameters<typeof createSolidTexture>[2], value: number[]): GPUTextureView =>
    createSolidTexture(device, `default.${label}`, format, value).createView();
  const texArray = (label: string, format: Parameters<typeof createSolidTexture>[2], value: number[]): GPUTextureView =>
    createSolidTexture(device, `default.${label}`, format, value).createView({ dimension: '2d-array' });

  const depthDefault = (label: string, layers: number, array: boolean, clear: number): GPUTextureView => {
    const t = device.createTexture({
      label: `default.${label}`,
      format: 'depth32float',
      size: [1, 1, layers],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const enc = device.createCommandEncoder();
    for (let l = 0; l < layers; l++) {
      enc
        .beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: { view: t.createView({ dimension: '2d', baseArrayLayer: l, arrayLayerCount: 1 }), depthClearValue: clear, depthLoadOp: 'clear', depthStoreOp: 'store' },
        })
        .end();
    }
    device.queue.submit([enc.finish()]);
    return t.createView({ dimension: array ? '2d-array' : '2d' });
  };

  const uniform = (label: string, data: ArrayBufferView<ArrayBuffer>): GPUBuffer => {
    const b = device.createBuffer({ label: `default.${label}`, size: Math.ceil(data.byteLength / 16) * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };

  const nearField = new ArrayBuffer(16);
  new Int32Array(nearField, 0, 1)[0] = -1;

  const defaults: SharedResourceMap = {
    // White transmittance: no atmosphere dims the sun.
    'atmosphere.transmittanceLut': texArray('transmittanceLut', 'rgba16float', [1, 1, 1, 1]),
    'atmosphere.skyViewLut': tex2d('skyViewLut', 'rgba16float', [0, 0, 0, 1]),
    'atmosphere.skyIrradianceLut': texArray('skyIrradianceLut', 'rgba16float', [0, 0, 0, 1]),
    'atmosphere.aerialPerspective': createSolidTexture(device, 'default.aerialPerspective', 'rgba16float', [0, 0, 0, 1], { dimension: '3d' }).createView(),
    'clouds.shadowMap': tex2d('cloudShadowMap', 'r16float', [0]),
    'clouds.coverageMap': tex2d('cloudCoverageMap', 'r8unorm', [0]),
    'clouds.screen': tex2d('cloudsScreen', 'rgba16float', [0, 0, 0, 1]),
    'clouds.depth': tex2d('cloudsDepth', 'r32float', [3.0e38]),
    'env.probeCube': createSolidTexture(device, 'default.envProbeCube', 'rgba16float', [0, 0, 0, 1], { layers: 6 }).createView({ dimension: 'cube' }),
    'env.sh9': uniform('envSh9', new Float32Array(36)),
    'ocean.displacement': texArray('oceanDisplacement', 'rgba16float', [0, 0, 0, 0]),
    'ocean.derivatives': texArray('oceanDerivatives', 'rgba16float', [0, 0, 1, 0]),
    'ocean.nearField': uniform('oceanNearField', new Uint8Array(nearField)),
    // count 0: no vessel at the water.
    'ocean.wetness': uniform('oceanWetness', new Uint8Array(OCEAN_WETNESS_BYTES)),
    'ui.navball': tex2d('navball', 'rgba8unorm', [0, 0, 0, 1]),
    'ui.mfd': texArray('mfd', 'rgba8unorm', [0, 0, 0, 1]),
    'scene.depthOpaque': depthDefault('sceneDepthOpaque', 1, false, 0),
    'scene.depth': depthDefault('sceneDepth', 1, false, 0),
    'scene.depthHalf': tex2d('sceneDepthHalf', 'rg32float', [0, 0]),
    'scene.colorCopy': tex2d('sceneColorCopy', 'rgba16float', [0, 0, 0, 1]),
    'scene.colorCopyTransparent': tex2d('sceneColorCopyTransparent', 'rgba16float', [0, 0, 0, 1]),
    // Before the first frame (and for a consumer without a renderer behind it): all zero. The normal default is
    // a float format like the real target (rg16float); both bind as texture_2d<f32>.
    'gbuffer.albedo': tex2d('gbufferAlbedo', 'rgba8unorm-srgb', [0, 0, 0, 0]),
    'gbuffer.normal': tex2d('gbufferNormal', 'rgba16float', [0, 0, 0, 0]),
    'gbuffer.material': tex2d('gbufferMaterial', 'rgba8unorm', [0, 0, 0, 0]),
    'shadow.cascades': depthDefault('shadowCascades', 1, true, 1),
    // count = 0: sampleSunShadow returns 1.
    'shadow.uniforms': uniform('shadowUniforms', new Float32Array(SHADOW_UNIFORM_BYTES / 4)),
  };

  const current = { ...defaults } as SharedResourceMap;
  const versions = new Map<SharedResourceKey, number>();

  return {
    publish(key, value) {
      if (current[key] === value) return;
      current[key] = value;
      versions.set(key, (versions.get(key) ?? 0) + 1);
    },
    get: (key) => current[key],
    version: (key) => versions.get(key) ?? 0,
    reset(key) {
      (current as unknown as Record<string, unknown>)[key] = defaults[key];
      versions.set(key, (versions.get(key) ?? 0) + 1);
    },
    isDefault: (key) => current[key] === defaults[key],
  };
}
