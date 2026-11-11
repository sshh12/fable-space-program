/**
 * Lab probes of the render core, enabled with ?probe=name[,name...]:
 *
 *   order    three features with different `order` values that log every hook call (frame-graph order)
 *   hooks    one feature that draws a marker in every hook and samples the scene copies (attachments, copies)
 *   volume   a half-resolution fog sphere rendered in preTransparent and composited in drawTransparent
 *   cloud    transparent quads through applyAtmosphere, with a synthetic cloud layer that can be switched on
 *   casters  logs the cascades handed to drawShadow
 *   sun      the solar disc as a background feature (1.9e9 cd/m^2, limb darkened)
 *   heavy    a deliberately expensive fullscreen pass that honours FrameContext.qualityScale
 *   copies   a feature that only requires both colour copies, so all four core copies run (perf spec)
 *   reactive a patch of per-pixel noise (0 or 2) that is new every frame and has no motion vector, and the
 *            'post.reactive' mask over its left half (setReactive)
 *   ridge    a 150 km body-fixed ridge on the moon-sized body (terminator shadow from far away)
 *   flame    an additive transparent rectangle over the middle of the frame (30 % x 30 %), in front of
 *            whatever is there, of a luminance set with setFlame (cd/m^2; 0 = off): an emitter over geometry
 *
 * Markers are 16 x 16 px squares in the top-left corner of the render target: marker k covers
 * x = 8 + 24 k .. 24 + 24 k, y = 8 .. 24.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import { OCEAN_WETNESS_BYTES, RENDER_FORMATS, type FrameContext, type RenderContext, type RenderFeature, type ShadowCascadeView } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { dirToLatLon } from '@/core/geo/cubeSphere';
import { quat, v3, type Vec3 } from '@/core/math';
import { boxMesh, coreOf, createSolidTexture, instanceInFrame, sphereMesh, type CoreApi, type ManagedTarget, type MeshBatch, type ModelHandle, type SceneBindings, type Tracked } from '@/render/core';
import type { LabApp } from '@/render/core/lab';
import { sitePoseOf, type Site } from './world';

export const MARKER = { size: 16, y: 8, x: (k: number): number => 8 + 24 * k };
/**
 * G-buffer inputs the hooks probe writes at marker 8 (a water surface): linear albedo, baked AO, normal
 * (normalised by the shader), perceptual roughness, metallic and the water-depth parameter (encoded value).
 * Markers 9-11 read them back in drawWater through 'gbuffer.albedo' / 'gbuffer.material' / 'gbuffer.normal'.
 */
export const GBUFFER_PROBE = { albedo: [0.25, 0.5, 0.75], ao: 0.5, normal: [0.3, -0.5, 0.8], roughness: 0.6, metallic: 0.2, param: 0.4 } as const;
/** Depth written by the hooks probe at marker 0: changes every frame so stale copies are detected. */
export const markerDepth = (frameIndex: number): number => 0.25 + 0.5 * ((frameIndex * 0.37) % 1);

export interface CascadeLogEntry {
  frame: number;
  index: number;
  everyFrame: boolean;
  fit: string;
  anchor: string;
  texelSize: number;
  texelSizeV: number;
  /** Half extent along u over half extent along v of the footprint (1 = square, above 1 = fitted to its receivers). */
  aspect: number;
}

/** Setters of the `inputs` probe: constant lighting inputs published through SharedResources (null = back to the default). */
export interface LightingInputsProbe {
  /** 'atmosphere.transmittanceLut' filled with one value. */
  setTransmittance(t: number | null): void;
  /** 'atmosphere.skyIrradianceLut' filled with one illuminance (lux on a horizontal surface). */
  setSkyIrradiance(lux: number | null): void;
  /** 'env.sh9' for a constant irradiance (lux) from every direction. */
  setEnvIrradiance(lux: number | null): void;
  /** 'env.probeCube' with one luminance (cd/m^2) in every direction. */
  setEnvRadiance(nits: number | null): void;
  /** 'clouds.coverageMap' with one coverage value and the far cloud-shadow parameters. */
  setCloudFar(v: { coverage: number; opticalDepth: number } | null): void;
  /**
   * 'clouds.shadowMap' over a 200 m square at the site, projected along the local vertical: optical depth
   * `opticalDepth` everywhere, in a layer whose top is `top` metres above the site plane and which is
   * `thickness` metres deep (default: 800 to 1000 m up, far above everything in the lab).
   */
  setCloudNear(v: { opticalDepth: number; top?: number; thickness?: number } | null): void;
  /** One point light (cd, white) `height` metres above the site-frame point `at`. */
  setPointLight(v: { intensity: number; height: number; at: [number, number] } | null): void;
  /** 'ocean.nearField' for the site's body (what the ocean feature will publish). */
  setNearField(v: { fadeStart: number; fadeEnd: number } | null): void;
  /**
   * 'ocean.wetness' with one slot: a level water plane through the site-frame point `at` (m), applying within
   * `radius` of it, whose wet line stands `wetLine` metres above the plane (what the ocean feature publishes
   * for a floating vessel).
   */
  setOceanWetness(v: { at: [number, number, number]; radius: number; wetLine: number } | null): void;
}

export interface Probes {
  features: RenderFeature[];
  inputs: LightingInputsProbe;
  /** Where the ridge probe puts its ridge (on the moon-sized body). */
  ridgeSite: Site;
  attach(app: LabApp): void;
  /** `<featureId>.<hook>` in call order for the last completed frame (order probe). */
  hookLog(): string[];
  cascadeLog(): CascadeLogEntry[];
  clearCascadeLog(): void;
  /** Cascades in which a MOVING caster was asked to draw although the cascade is not every-frame (must stay empty). */
  movingCasterViolations(): number;
  /**
   * The synthetic cloud of the transparency probe over the left half of the screen (transmittance 0.02):
   * `true` = from 18 m to 22 m from the eye, or its span in metres; `false` = none.
   */
  setCloudLayer(on: boolean | { begin: number; end: number }): void;
  setVolume(on: boolean): void;
  /** Projected centre (render px) and radius (px) of the fog sphere in the last frame. */
  volumeScreen(): { x: number; y: number; radius: number } | null;
  setHeavy(iterations: number): void;
  heavyIterations(): number;
  /** Value the reactive probe writes into 'post.reactive' over the left half of its flickering patch. */
  setReactive(value: number): void;
  /** Luminance (cd/m^2) of the flame probe's rectangle; 0 = not drawn. */
  setFlame(luminance: number): void;
}

/** The flame probe's rectangle, as fractions of the render target: x, y, width, height. */
export const FLAME_RECT = { x: 0.35, y: 0.35, width: 0.3, height: 0.3 };

/** Render-target rectangle of the reactive probe's flickering patch; the mask covers its left half. */
export const REACTIVE_PATCH = { x: 400, y: 300, width: 400, height: 100 };

const scissorMarker = (pass: GPURenderPassEncoder, k: number): void => pass.setScissorRect(MARKER.x(k), MARKER.y, MARKER.size, MARKER.size);

export function createProbes(query: URLSearchParams, site: Site, defs: DefLibrary, initial: SimSnapshot): Probes {
  const names = new Set((query.get('probe') ?? '').split(',').filter(Boolean));
  const features: RenderFeature[] = [];
  let app: LabApp | null = null;
  let hookLogCurrent: string[] = [];
  let hookLogLast: string[] = [];
  const cascadeLog: CascadeLogEntry[] = [];
  let violations = 0;
  let cloudLayer: { begin: number; end: number } | null = null;
  let flameLuminance = 0;
  let volumeOn = true;
  let volumeScreen: { x: number; y: number; radius: number } | null = null;
  let heavyIterations = Number(query.get('heavy') ?? 0);
  let reactiveValue = 0;

  // ------------------------------------------------------------------------------------------- order
  if (names.has('order')) {
    const mk = (id: string, order: number, first: boolean): RenderFeature => {
      const log = (hook: string): void => {
        hookLogCurrent.push(`${id}.${hook}`);
      };
      return {
        id,
        order,
        init() {},
        prepare() {
          if (first) {
            hookLogLast = hookLogCurrent;
            hookLogCurrent = [];
          }
          log('prepare');
        },
        compute: () => log('compute'),
        drawShadow: () => log('drawShadow'),
        drawGBuffer: () => log('drawGBuffer'),
        drawWater: () => log('drawWater'),
        drawBackground: () => log('drawBackground'),
        compositeAtmosphere: () => log('compositeAtmosphere'),
        preTransparent: () => log('preTransparent'),
        drawTransparent: () => log('drawTransparent'),
        drawOverlay: () => log('drawOverlay'),
      };
    };
    // Registered b, a, c: the expected call order is a (order -5), then b and c (both 5, registration order).
    features.push(mk('ord-b', 5, false), mk('ord-a', -5, true), mk('ord-c', 5, false));
  }

  // ----------------------------------------------------------------------------------------- casters
  if (names.has('casters')) {
    features.push({
      id: 'lab-casters',
      init() {},
      drawShadow(frame: FrameContext, _pass: GPURenderPassEncoder, c: ShadowCascadeView) {
        cascadeLog.push({ frame: frame.frameIndex, index: c.index, everyFrame: c.everyFrame, fit: c.fit, anchor: `${c.anchor.kind}:${c.anchor.id}`, texelSize: c.texelSize, texelSizeV: c.texelSizeV, aspect: Math.hypot(c.viewProj[1]!, c.viewProj[5]!, c.viewProj[9]!) / Math.hypot(c.viewProj[0]!, c.viewProj[4]!, c.viewProj[8]!) });
        if (cascadeLog.length > 4000) cascadeLog.splice(0, 2000);
      },
    });
  }

  // ------------------------------------------------------------------------------------------- hooks
  if (names.has('hooks')) {
    let ctx: RenderContext;
    let core: CoreApi;
    let uniform: GPUBuffer;
    let sceneB: SceneBindings;
    let sceneLayout: GPUBindGroupLayout;
    let sceneGroup: GPUBindGroup | null = null;
    let sceneVersion = -1;
    let half: ManagedTarget;
    let halfGroup: GPUBindGroup | null = null;
    let halfVersion = -1;
    let halfLayout: GPUBindGroupLayout;
    // The G-buffer set lives in a group of its own: it may never be set inside drawGBuffer.
    let gbufB: SceneBindings;
    let gbufLayout: GPUBindGroupLayout;
    let gbufGroup: GPUBindGroup | null = null;
    let gbufVersion = -1;
    const P: Record<string, Tracked<GPURenderPipeline>> = {};
    const PRELUDE = (b: string): string => /* wgsl */ `
      ${b}
      struct ProbeU { v: vec4f }   // x = marker depth of this frame
      @group(1) @binding(0) var<uniform> probe: ProbeU;
      fn markerCentre(k: i32) -> vec2i { return vec2i(${MARKER.x(0) + MARKER.size / 2} + 24 * k, ${MARKER.y + MARKER.size / 2}); }
    `;
    const group = (): GPUBindGroup => {
      const v = sceneB.version();
      if (!sceneGroup || v !== sceneVersion) {
        sceneVersion = v;
        sceneGroup = ctx.device.createBindGroup({ layout: sceneLayout, entries: [{ binding: 0, resource: { buffer: uniform } }, ...sceneB.entries()] });
      }
      return sceneGroup;
    };
    const fullRect = (pass: GPURenderPassEncoder, frame: FrameContext): void => pass.setScissorRect(0, 0, frame.renderSize[0], frame.renderSize[1]);
    const hdrTarget: GPUColorTargetState = { format: RENDER_FORMATS.hdr };

    features.push({
      id: 'lab-hooks',
      order: 50,
      requires: ['scene.colorCopy', 'scene.colorCopyTransparent'],
      init(c) {
        ctx = c;
        core = coreOf(c);
        uniform = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        sceneB = core.createSceneBindings(1, 1, ['sceneDepthOpaque', 'sceneDepth', 'sceneDepthHalf', 'sceneColor', 'sceneColorTransparent']);
        sceneLayout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }, ...sceneB.layoutEntries] });
        halfLayout = c.device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
          ],
        });
        half = core.createTarget('lab-hooks.half', 'rgba16float', 0.5);
        const pre = PRELUDE(sceneB.wgsl);
        const depthLayouts = [sceneLayout];
        // G-buffer marker: geometry at a known, per-frame depth with emissive 5.
        P.gbuffer = core.fullscreenPipeline({
          label: 'lab-hooks.gbuffer',
          layouts: depthLayouts,
          fragment: /* wgsl */ `#include "gbuffer"
            ${pre}
            struct O { @location(0) a: vec4f, @location(1) n: vec2f, @location(2) m: vec4f, @location(3) v: vec2f, @location(4) e: vec4f, @location(5) em: vec4f, @builtin(frag_depth) d: f32 }
            @fragment fn fs(in: FullscreenOut) -> O {
              let g = gbufferPack(vec3f(0.0), 1.0, vec3f(0.0, 0.0, 1.0), 1.0, 0.0, MATERIAL_STANDARD, 0.0, vec2f(0.0), vec3f(5.0));
              return O(g.albedo, g.normal, g.material, g.velocity, g.extra, g.emissive, probe.v.x);
            }`,
          targets: [RENDER_FORMATS.gbufferAlbedo, RENDER_FORMATS.gbufferNormal, RENDER_FORMATS.gbufferMaterial, RENDER_FORMATS.gbufferVelocity, RENDER_FORMATS.gbufferExtra, RENDER_FORMATS.hdr].map((format) => ({ format })),
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'always' },
        });
        // Water marker: r = |depthOpaque(marker 0) - expected| x 1000, g = colorCopy(marker 0).r; writes depth 1.
        P.water = core.fullscreenPipeline({
          label: 'lab-hooks.water',
          layouts: depthLayouts,
          fragment: /* wgsl */ `${pre}
            struct O { @location(0) c: vec4f, @location(1) v: vec2f, @builtin(frag_depth) d: f32 }
            @fragment fn fs(in: FullscreenOut) -> O {
              let d0 = textureLoad(sceneDepthOpaqueTex, markerCentre(0), 0);
              let c0 = textureLoad(sceneColorTex, markerCentre(0), 0).r;
              return O(vec4f(abs(d0 - probe.v.x) * 1000.0, c0, 1.0, 1.0), vec2f(0.0), 1.0);
            }`,
          targets: [hdrTarget, { format: RENDER_FORMATS.gbufferVelocity }],
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'greater-equal' },
        });
        // Marker 8 (G-buffer): a surface with known inputs (GBUFFER_PROBE), for the 'gbuffer.*' resources.
        P.gbufferKnown = core.fullscreenPipeline({
          label: 'lab-hooks.gbufferKnown',
          layouts: depthLayouts,
          fragment: /* wgsl */ `#include "gbuffer"
            ${pre}
            struct O { @location(0) a: vec4f, @location(1) n: vec2f, @location(2) m: vec4f, @location(3) v: vec2f, @location(4) e: vec4f, @location(5) em: vec4f, @builtin(frag_depth) d: f32 }
            @fragment fn fs(in: FullscreenOut) -> O {
              let g = gbufferPack(vec3f(${GBUFFER_PROBE.albedo.join(', ')}), ${GBUFFER_PROBE.ao}, normalize(vec3f(${GBUFFER_PROBE.normal.join(', ')})), ${GBUFFER_PROBE.roughness}, ${GBUFFER_PROBE.metallic}, MATERIAL_WATER, ${GBUFFER_PROBE.param}, vec2f(0.0), vec3f(0.0));
              return O(g.albedo, g.normal, g.material, g.velocity, g.extra, g.emissive, 0.5);
            }`,
          targets: [RENDER_FORMATS.gbufferAlbedo, RENDER_FORMATS.gbufferNormal, RENDER_FORMATS.gbufferMaterial, RENDER_FORMATS.gbufferVelocity, RENDER_FORMATS.gbufferExtra, RENDER_FORMATS.hdr].map((format) => ({ format })),
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'always' },
        });
        // Markers 9, 10, 11 (drawWater): 'gbuffer.albedo' (linear rgb), 'gbuffer.material' (roughness, id, parameter)
        // and the decoded 'gbuffer.normal' at marker 8, read through the 'gbuffer' binding set.
        gbufB = core.createSceneBindings(1, 0, ['gbuffer']);
        gbufLayout = c.device.createBindGroupLayout({ entries: gbufB.layoutEntries });
        const gbufferRead = (label: string, value: string): Tracked<GPURenderPipeline> =>
          core.fullscreenPipeline({
            label: `lab-hooks.${label}`,
            layouts: [gbufLayout],
            fragment: /* wgsl */ `#include "gbuffer"
              ${gbufB.wgsl}
              struct O { @location(0) c: vec4f, @location(1) v: vec2f, @builtin(frag_depth) d: f32 }
              @fragment fn fs(in: FullscreenOut) -> O {
                let at = vec2i(${MARKER.x(8) + MARKER.size / 2}, ${MARKER.y + MARKER.size / 2});
                return O(vec4f(${value}, 1.0), vec2f(0.0), 1.0);
              }`,
            targets: [hdrTarget, { format: RENDER_FORMATS.gbufferVelocity }],
            depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'greater-equal' },
          });
        P.waterAlbedo = gbufferRead('waterAlbedo', 'textureLoad(gbufferAlbedoTex, at, 0).rgb');
        P.waterMaterial = gbufferRead('waterMaterial', 'vec3f(textureLoad(gbufferMaterialTex, at, 0).r, textureLoad(gbufferMaterialTex, at, 0).b * 255.0, decodeWaterDepth(textureLoad(gbufferMaterialTex, at, 0).a))');
        P.waterNormal = gbufferRead('waterNormal', 'octDecode(textureLoad(gbufferNormalTex, at, 0).xy) * 0.5 + 0.5');
        // Background marker: 7 where depth == 0 only.
        P.background = core.fullscreenPipeline({
          label: 'lab-hooks.background',
          fragment: /* wgsl */ `@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f { return vec4f(7.0, 7.0, 7.0, 1.0); }`,
          targets: [hdrTarget],
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'equal' },
        });
        // Atmosphere-stage marker (own pass): r = error of 'scene.depth' at markers 0 and 1, g / b = 'scene.depthHalf' at marker 1 / 0.
        P.atmosphere = core.fullscreenPipeline({
          label: 'lab-hooks.atmosphere',
          layouts: depthLayouts,
          fragment: /* wgsl */ `${pre}
            @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
              let e0 = abs(textureLoad(sceneDepthTex, markerCentre(0), 0) - probe.v.x);
              let e1 = abs(textureLoad(sceneDepthTex, markerCentre(1), 0) - 1.0);
              let h1 = textureLoad(sceneDepthHalfTex, markerCentre(1) / 2, 0).g;
              let h0 = textureLoad(sceneDepthHalfTex, markerCentre(0) / 2, 0).r;
              return vec4f((e0 + e1) * 1000.0, h1, abs(h0 - probe.v.x) * 1000.0, 1.0);
            }`,
          targets: [hdrTarget],
        });
        // preTransparent: the half-resolution target gets 3 everywhere.
        P.pre = core.fullscreenPipeline({
          label: 'lab-hooks.pre',
          fragment: /* wgsl */ `@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f { return vec4f(3.0, 3.0, 3.0, 1.0); }`,
          targets: [{ format: 'rgba16float' }],
        });
        // Transparent markers: upsampled half-res value; the atmosphere marker seen through 'scene.colorCopyTransparent'.
        P.transparentUp = core.fullscreenPipeline({
          label: 'lab-hooks.transparentUp',
          layouts: [sceneLayout, halfLayout],
          fragment: /* wgsl */ `#include "upsample"
            ${pre}
            @group(2) @binding(0) var halfTex: texture_2d<f32>;
            @group(2) @binding(1) var depthHalfTex: texture_2d<f32>;
            @group(2) @binding(2) var depthTex: texture_depth_2d;
            struct O { @location(0) c: vec4f, @builtin(frag_depth) d: f32 }
            @fragment fn fs(in: FullscreenOut) -> O {
              let d = textureLoad(depthTex, vec2i(in.position.xy), 0);
              return O(upsampleDepthAware(halfTex, depthHalfTex, in.uv, d, false), 1.0);
            }`,
          targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' },
        });
        P.transparentCopy = core.fullscreenPipeline({
          label: 'lab-hooks.transparentCopy',
          layouts: depthLayouts,
          fragment: /* wgsl */ `${pre}
            struct O { @location(0) c: vec4f, @builtin(frag_depth) d: f32 }
            @fragment fn fs(in: FullscreenOut) -> O { return O(vec4f(textureLoad(sceneColorTransparentTex, markerCentre(3), 0).rgb, 1.0), 1.0); }`,
          targets: [hdrTarget],
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' },
        });
        // Depth-tested transparent: 9 at a depth FARTHER than marker 0's geometry (must be rejected there).
        P.transparentDepth = core.fullscreenPipeline({
          label: 'lab-hooks.transparentDepth',
          layouts: depthLayouts,
          fragment: /* wgsl */ `${pre}
            struct O { @location(0) c: vec4f, @builtin(frag_depth) d: f32 }
            @fragment fn fs(in: FullscreenOut) -> O { return O(vec4f(9.0, 9.0, 9.0, 1.0), probe.v.x * 0.5); }`,
          targets: [hdrTarget],
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' },
        });
        P.overlay = core.fullscreenPipeline({
          label: 'lab-hooks.overlay',
          fragment: /* wgsl */ `@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }`,
          targets: [{ format: c.canvasFormat }],
        });
        for (const p of Object.values(P)) p.get();
      },
      prepare(frame) {
        ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([markerDepth(frame.frameIndex), 0, 0, 0]));
      },
      drawGBuffer(frame, pass) {
        pass.setPipeline(P.gbuffer!.get());
        pass.setBindGroup(1, group());
        scissorMarker(pass, 0);
        pass.draw(3);
        pass.setPipeline(P.gbufferKnown!.get());
        scissorMarker(pass, 8);
        pass.draw(3);
        fullRect(pass, frame);
      },
      drawWater(frame, pass) {
        pass.setPipeline(P.water!.get());
        pass.setBindGroup(1, group());
        scissorMarker(pass, 1);
        pass.draw(3);
        const v = gbufB.version();
        if (!gbufGroup || v !== gbufVersion) {
          gbufVersion = v;
          gbufGroup = ctx.device.createBindGroup({ layout: gbufLayout, entries: gbufB.entries() });
        }
        pass.setBindGroup(1, gbufGroup);
        (['waterAlbedo', 'waterMaterial', 'waterNormal'] as const).forEach((name, i) => {
          pass.setPipeline(P[name]!.get());
          scissorMarker(pass, 9 + i);
          pass.draw(3);
        });
        fullRect(pass, frame);
      },
      drawBackground(frame, pass) {
        pass.setPipeline(P.background!.get());
        scissorMarker(pass, 0);
        pass.draw(3);
        scissorMarker(pass, 2);
        pass.draw(3);
        fullRect(pass, frame);
      },
      compositeAtmosphere(frame, encoder, hdrTargetView) {
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: hdrTargetView, loadOp: 'load', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-hooks.atmosphere') });
        pass.setBindGroup(0, frame.frameBindGroup);
        pass.setPipeline(P.atmosphere!.get());
        pass.setBindGroup(1, group());
        scissorMarker(pass, 3);
        pass.draw(3);
        pass.end();
      },
      preTransparent(frame, encoder) {
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: half.view, loadOp: 'clear', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-hooks.pre') });
        pass.setBindGroup(0, frame.frameBindGroup);
        pass.setPipeline(P.pre!.get());
        pass.draw(3);
        pass.end();
      },
      drawTransparent(frame, pass) {
        const v = half.version + ctx.resources.version('scene.depthHalf') + ctx.resources.version('scene.depth');
        if (!halfGroup || v !== halfVersion) {
          halfVersion = v;
          halfGroup = ctx.device.createBindGroup({
            layout: halfLayout,
            entries: [
              { binding: 0, resource: half.view },
              { binding: 1, resource: ctx.resources.get('scene.depthHalf') },
              { binding: 2, resource: ctx.resources.get('scene.depth') },
            ],
          });
        }
        pass.setBindGroup(1, group());
        pass.setPipeline(P.transparentUp!.get());
        pass.setBindGroup(2, halfGroup);
        scissorMarker(pass, 4);
        pass.draw(3);
        pass.setPipeline(P.transparentCopy!.get());
        scissorMarker(pass, 5);
        pass.draw(3);
        pass.setPipeline(P.transparentDepth!.get());
        scissorMarker(pass, 0);
        pass.draw(3);
        scissorMarker(pass, 6);
        pass.draw(3);
        fullRect(pass, frame);
      },
      drawOverlay(frame, pass) {
        pass.setPipeline(P.overlay!.get());
        scissorMarker(pass, 7);
        pass.draw(3);
        pass.setScissorRect(0, 0, frame.displaySize[0], frame.displaySize[1]);
      },
    });
  }

  // ------------------------------------------------------------------------------------------ volume
  if (names.has('volume')) {
    let ctx: RenderContext;
    let core: CoreApi;
    let target: ManagedTarget;
    let uniform: GPUBuffer;
    let marchLayout: GPUBindGroupLayout;
    let compLayout: GPUBindGroupLayout;
    let march: Tracked<GPURenderPipeline>;
    let comp: Tracked<GPURenderPipeline>;
    let transp: SceneBindings;
    let marchGroup: GPUBindGroup | null = null;
    let compGroup: GPUBindGroup | null = null;
    let version = -1;
    const data = new Float32Array(8);
    features.push({
      id: 'lab-volume',
      order: 10,
      init(c) {
        ctx = c;
        core = coreOf(c);
        target = core.createTarget('lab-volume.half', 'rgba16float', 0.5);
        uniform = c.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        marchLayout = c.device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
          ],
        });
        transp = core.createSceneBindings(1, 4, ['transparency']);
        compLayout = c.device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
            ...transp.layoutEntries,
          ],
        });
        const U = /* wgsl */ `struct VolU { centre: vec4f, colour: vec4f }   // centre.xyz camera-relative, centre.w = radius; colour.rgb cd/m^2, a = density per metre
          @group(1) @binding(0) var<uniform> vol: VolU;
          @group(1) @binding(1) var depthHalfTex: texture_2d<f32>;`;
        // Half-resolution march: analytic chord through a uniform sphere, cut at this frame's (farthest) scene depth.
        march = core.fullscreenPipeline({
          label: 'lab-volume.march',
          layouts: [marchLayout],
          fragment: /* wgsl */ `${U}
            @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
              let ray = viewRay(in.uv);
              let len = length(ray);
              let d = ray / len;
              let dh = textureLoad(depthHalfTex, vec2i(in.position.xy), 0).r;
              let tScene = viewZFromDepth(dh) * len;
              let b = dot(d, vol.centre.xyz);
              let disc = b * b - dot(vol.centre.xyz, vol.centre.xyz) + vol.centre.w * vol.centre.w;
              if (disc <= 0.0) { return vec4f(0.0); }
              let s = sqrt(disc);
              let t0 = max(b - s, 0.0);
              let t1 = min(b + s, tScene);
              if (t1 <= t0) { return vec4f(0.0); }
              let alpha = 1.0 - exp(-(t1 - t0) * vol.colour.a);
              return vec4f(writeHdr(vol.colour.rgb * frame.exposure.x * alpha), alpha);
            }`,
          targets: [{ format: 'rgba16float' }],
        });
        comp = core.fullscreenPipeline({
          label: 'lab-volume.composite',
          layouts: [compLayout],
          fragment: /* wgsl */ `#include "upsample"
            #include "transparency"
            ${U}
            @group(1) @binding(2) var volTex: texture_2d<f32>;
            @group(1) @binding(3) var depthTex: texture_depth_2d;
            ${transp.wgsl}
            @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
              let d = textureLoad(depthTex, vec2i(in.position.xy), 0);
              let v = upsampleDepthAware(volTex, depthHalfTex, in.uv, d, false);
              return applyAtmosphere(in.uv, length(vol.centre.xyz), v.rgb, v.a);
            }`,
          targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
        });
        march.get();
        comp.get();
      },
      prepare(frame) {
        // The fog sphere sits 6 m behind the tower as seen from the camera, so the tower must cut it.
        const sitePose = sitePoseOf(site, frame, defs);
        const tower = v3.add(sitePose.originRelCam, quat.rotate(sitePose.q, { x: -7, y: -4, z: 4 }));
        const centre: Vec3 = v3.addScaled(tower, v3.normalize(tower), 6);
        const radius = 2.5;
        data.set([centre.x, centre.y, centre.z, radius, 20000, 26000, 40000, 0.6]);
        ctx.device.queue.writeBuffer(uniform, 0, data);
        const z = v3.len(centre);
        const [w, h] = frame.renderSize;
        const f = frame.projUnjittered[5]!;
        const vx = frame.view[0]! * centre.x + frame.view[4]! * centre.y + frame.view[8]! * centre.z;
        const vy = frame.view[1]! * centre.x + frame.view[5]! * centre.y + frame.view[9]! * centre.z;
        const vz = -(frame.view[2]! * centre.x + frame.view[6]! * centre.y + frame.view[10]! * centre.z);
        volumeScreen = { x: (0.5 + (0.5 * frame.projUnjittered[0]! * vx) / vz) * w, y: (0.5 - (0.5 * f * vy) / vz) * h, radius: ((radius / z) * f * h) / 2 };
      },
      preTransparent(frame, encoder) {
        const v = target.version + ctx.resources.version('scene.depthHalf') + ctx.resources.version('scene.depth') + transp.version();
        if (v !== version || !marchGroup) {
          version = v;
          marchGroup = ctx.device.createBindGroup({
            layout: marchLayout,
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: ctx.resources.get('scene.depthHalf') },
            ],
          });
          compGroup = ctx.device.createBindGroup({
            layout: compLayout,
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: ctx.resources.get('scene.depthHalf') },
              { binding: 2, resource: target.view },
              { binding: 3, resource: ctx.resources.get('scene.depth') },
              ...transp.entries(),
            ],
          });
        }
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-volume.march') });
        pass.setBindGroup(0, frame.frameBindGroup);
        if (volumeOn) {
          pass.setPipeline(march.get());
          pass.setBindGroup(1, marchGroup);
          pass.draw(3);
        }
        pass.end();
      },
      drawTransparent(_frame, pass) {
        if (!volumeOn || !compGroup) return;
        pass.setPipeline(comp.get());
        pass.setBindGroup(1, compGroup);
        pass.draw(3);
      },
    });
  }

  // ------------------------------------------------------------------------------------------- cloud
  if (names.has('cloud')) {
    let ctx: RenderContext;
    let core: CoreApi;
    let pipeline: Tracked<GPURenderPipeline>;
    let layout: GPUBindGroupLayout;
    let transp: SceneBindings;
    let groups: GPUBindGroup[] = [];
    let version = -1;
    const uniforms: GPUBuffer[] = [];
    let screen: GPUTexture | null = null;
    let depth: GPUTexture | null = null;
    let published: { begin: number; end: number } | null = null;
    features.push({
      id: 'lab-cloud',
      order: 20,
      init(c) {
        ctx = c;
        core = coreOf(c);
        transp = core.createSceneBindings(1, 1, ['transparency']);
        layout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }, ...transp.layoutEntries] });
        pipeline = core.fullscreenPipeline({
          label: 'lab-cloud.quad',
          layouts: [layout],
          fragment: /* wgsl */ `#include "transparency"
            struct QuadU { v: vec4f }   // x = distance from the eye (m), y = pre-exposed radiance
            @group(1) @binding(0) var<uniform> quad: QuadU;
            ${transp.wgsl}
            struct O { @location(0) c: vec4f, @builtin(frag_depth) d: f32 }
            @fragment fn fs(in: FullscreenOut) -> O {
              return O(applyAtmosphere(in.uv, quad.v.x, vec3f(quad.v.y), 1.0), 1.0);
            }`,
          targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' },
        });
        pipeline.get();
        // Quad 0: 40 m away (behind the synthetic cloud at 20 m); quad 1: 5 m away (in front of it). Radiance 2.0.
        for (const d of [40, 5]) {
          const b = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
          c.device.queue.writeBuffer(b, 0, new Float32Array([d, 2, 0, 0]));
          uniforms.push(b);
        }
      },
      compositeAtmosphere(frame) {
        // Publish (or withdraw) a synthetic cloud layer: transmittance 0.02 over the LEFT half of the screen,
        // between `begin` and `end` metres from the eye.
        if (cloudLayer === published) return;
        published = cloudLayer;
        if (!cloudLayer) {
          app?.renderer.resources.reset('clouds.screen');
          app?.renderer.resources.reset('clouds.depth');
          return;
        }
        const w = Math.ceil(frame.renderSize[0] / 2);
        const h = Math.ceil(frame.renderSize[1] / 2);
        screen?.destroy();
        depth?.destroy();
        screen = ctx.device.createTexture({ format: 'rgba16float', size: [w, h], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        depth = ctx.device.createTexture({ format: 'rg32float', size: [w, h], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        const s = new Uint16Array(w * h * 4);
        const d = new Float32Array(w * h * 2);
        const one = 0x3c00;
        const t002 = 0x251f; // 0.02 as float16
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const left = x < w / 2;
            s[(y * w + x) * 4 + 3] = left ? t002 : one;
            d[(y * w + x) * 2] = left ? cloudLayer.begin : 3.0e38;
            d[(y * w + x) * 2 + 1] = left ? cloudLayer.end : 3.0e38;
          }
        }
        ctx.device.queue.writeTexture({ texture: screen }, s, { bytesPerRow: w * 8 }, [w, h]);
        ctx.device.queue.writeTexture({ texture: depth }, d, { bytesPerRow: w * 8 }, [w, h]);
        ctx.resources.publish('clouds.screen', screen.createView());
        ctx.resources.publish('clouds.depth', depth.createView());
      },
      drawTransparent(frame, pass) {
        const v = transp.version();
        if (v !== version || groups.length === 0) {
          version = v;
          groups = uniforms.map((b) => ctx.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: b } }, ...transp.entries()] }));
        }
        const [w, h] = frame.renderSize;
        pass.setPipeline(pipeline.get());
        // Two horizontal bands across the middle of the screen, each spanning both halves.
        const x0 = Math.floor(w * 0.25);
        const bw = Math.floor(w * 0.5);
        pass.setBindGroup(1, groups[0]!);
        pass.setScissorRect(x0, Math.floor(h * 0.3), bw, 24);
        pass.draw(3);
        pass.setBindGroup(1, groups[1]!);
        pass.setScissorRect(x0, Math.floor(h * 0.3) + 40, bw, 24);
        pass.draw(3);
        pass.setScissorRect(0, 0, w, h);
      },
    });
  }

  // ------------------------------------------------------------------------------------------- flame
  if (names.has('flame')) {
    let ctx: RenderContext;
    let pipeline: Tracked<GPURenderPipeline>;
    let uniform: GPUBuffer;
    let group: GPUBindGroup;
    features.push({
      id: 'lab-flame',
      order: 30,
      init(c) {
        ctx = c;
        uniform = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const layout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
        group = c.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
        pipeline = coreOf(c).fullscreenPipeline({
          label: 'lab-flame.quad',
          layouts: [layout],
          fragment: /* wgsl */ `struct FlameU { v: vec4f }   // x = luminance, cd/m^2
            @group(1) @binding(0) var<uniform> flame: FlameU;
            @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f { return vec4f(writeHdr(vec3f(flame.v.x * frame.exposure.x)), 0.0); }`,
          targets: [{ format: RENDER_FORMATS.hdr, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }],
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
        });
        pipeline.get();
      },
      prepare() {
        ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([flameLuminance, 0, 0, 0]));
      },
      drawTransparent(frame, pass) {
        if (flameLuminance <= 0) return;
        const [w, h] = frame.renderSize;
        pass.setPipeline(pipeline.get());
        pass.setBindGroup(1, group);
        pass.setScissorRect(Math.floor(w * FLAME_RECT.x), Math.floor(h * FLAME_RECT.y), Math.floor(w * FLAME_RECT.width), Math.floor(h * FLAME_RECT.height));
        pass.draw(3);
        pass.setScissorRect(0, 0, w, h);
      },
    });
  }

  // ------------------------------------------------------------------- moving caster (vessel frame)
  if (names.has('mover')) {
    let batch: MeshBatch;
    let model: ModelHandle;
    features.push({
      id: 'lab-mover',
      init(c) {
        const meshes = coreOf(c).meshes;
        batch = meshes.createBatch('lab-mover');
        model = meshes.createModel({ name: 'mover', lods: [boxMesh(3, 12, 3)], materials: [{ name: 'mover', shading: 'standard', baseColor: [0.8, 0.8, 0.82], roughness: 0.5, metallic: 0 }] });
      },
      prepare(frame) {
        batch.begin(frame);
        const v = frame.vesselPose(frame.snapshot.activeVesselId);
        if (v) batch.add(model, instanceInFrame(v, { x: 0, y: 0, z: 0 }, null, { bodyFixed: false }));
        batch.finish();
      },
      drawGBuffer(_f, pass) {
        batch.drawGBuffer(pass);
      },
      drawShadow(_f, pass, cascade) {
        const before = batch.stats.shadowTriangles;
        batch.drawShadow(pass, cascade);
        if (!cascade.everyFrame && batch.stats.shadowTriangles !== before) violations++;
      },
    });
  }

  // ------------------------------------------------------------------------- ball / mirror (vessel frame)
  if (names.has('ball') || names.has('mirror')) {
    let batch: MeshBatch;
    let white: ModelHandle;
    let mirror: ModelHandle;
    features.push({
      id: 'lab-ball',
      init(c) {
        const meshes = coreOf(c).meshes;
        batch = meshes.createBatch('lab-ball');
        // A white Lambert-like ball (5 m radius) and a mirror-like metal ball (3 m radius, 12 m to starboard).
        white = meshes.createModel({ name: 'ball', lods: [sphereMesh(5, 96, 48)], materials: [{ name: 'ball', shading: 'terrain', baseColor: [0.8, 0.8, 0.8], roughness: 1, metallic: 0 }] });
        mirror = meshes.createModel({ name: 'mirror', lods: [sphereMesh(3, 128, 64)], materials: [{ name: 'mirror', shading: 'standard', baseColor: [0.95, 0.95, 0.95], roughness: 0.02, metallic: 1 }] });
      },
      prepare(frame) {
        batch.begin(frame);
        const v = frame.vesselPose(frame.snapshot.activeVesselId);
        if (v) {
          if (names.has('ball')) batch.add(white, instanceInFrame(v, { x: 0, y: 0, z: 0 }, null, { bodyFixed: false }));
          if (names.has('mirror')) batch.add(mirror, instanceInFrame(v, { x: 12, y: 0, z: 0 }, null, { bodyFixed: false }));
        }
        batch.finish();
      },
      drawGBuffer(_f, pass) {
        batch.drawGBuffer(pass);
      },
      drawShadow(_f, pass, cascade) {
        batch.drawShadow(pass, cascade);
      },
    });
  }

  // ---------------------------------------------------------------------------------------- inputs
  // Publishes constant lighting inputs through SharedResources so specs can check each term of the
  // deferred lighting equation against a hand calculation.
  const inputs: LightingInputsProbe = {
    setTransmittance: () => undefined,
    setSkyIrradiance: () => undefined,
    setEnvIrradiance: () => undefined,
    setEnvRadiance: () => undefined,
    setCloudFar: () => undefined,
    setCloudNear: () => undefined,
    setPointLight: () => undefined,
    setNearField: () => undefined,
    setOceanWetness: () => undefined,
  };
  if (names.has('inputs')) {
    let ctx: RenderContext;
    let cloudFar: { coverage: number; opticalDepth: number } | null = null;
    let cloudNear: { opticalDepth: number; top?: number; thickness?: number } | null = null;
    let light: { intensity: number; height: number; at: [number, number] } | null = null;
    let wetness: { at: [number, number, number]; radius: number; wetLine: number } | null = null;
    let wetnessBuffer: GPUBuffer | null = null;
    const wetnessData = new ArrayBuffer(OCEAN_WETNESS_BYTES);
    const solid = (format: 'rgba16float' | 'r16float' | 'r8unorm', value: number[], opts: { layers?: number } = {}): GPUTexture => createSolidTexture(ctx.device, 'lab-inputs', format, value, opts);
    features.push({
      id: 'lab-inputs',
      init(c) {
        ctx = c;
        inputs.setTransmittance = (t) => {
          if (t === null) app?.renderer.resources.reset('atmosphere.transmittanceLut');
          else c.resources.publish('atmosphere.transmittanceLut', solid('rgba16float', [t, t, t, 1]).createView({ dimension: '2d-array' }));
        };
        inputs.setSkyIrradiance = (lux) => {
          if (lux === null) app?.renderer.resources.reset('atmosphere.skyIrradianceLut');
          else c.resources.publish('atmosphere.skyIrradianceLut', solid('rgba16float', [lux, lux, lux, 1]).createView({ dimension: '2d-array' }));
        };
        inputs.setEnvIrradiance = (lux) => {
          if (lux === null) {
            app?.renderer.resources.reset('env.sh9');
            return;
          }
          // Constant irradiance E in every direction: only the Y00 coefficient, E = c0 x 0.282095.
          const data = new Float32Array(36);
          data.fill(lux / 0.282095, 0, 3);
          const b = c.device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
          c.device.queue.writeBuffer(b, 0, data);
          c.resources.publish('env.sh9', b);
        };
        inputs.setEnvRadiance = (nits) => {
          if (nits === null) app?.renderer.resources.reset('env.probeCube');
          else c.resources.publish('env.probeCube', solid('rgba16float', [nits, nits, nits, 1], { layers: 6 }).createView({ dimension: 'cube' }));
        };
        inputs.setCloudFar = (v) => {
          cloudFar = v;
          if (v) c.resources.publish('clouds.coverageMap', solid('r8unorm', [v.coverage]).createView());
          else app?.renderer.resources.reset('clouds.coverageMap');
        };
        inputs.setCloudNear = (v) => {
          cloudNear = v;
          // r = 1 (times the placement's scale), g = where the cloud begins, b = mean extinction below that.
          if (v) c.resources.publish('clouds.shadowMap', solid('rgba16float', [1, v.top ?? 1000, 1 / (v.thickness ?? 200), 0]).createView());
          else app?.renderer.resources.reset('clouds.shadowMap');
        };
        inputs.setPointLight = (v) => {
          light = v;
        };
        inputs.setNearField = (v) => {
          if (!v) {
            app?.renderer.resources.reset('ocean.nearField');
            return;
          }
          const data = new ArrayBuffer(16);
          new Int32Array(data, 0, 1)[0] = app?.snapshot().bodies.findIndex((b) => b.id === site.bodyId) ?? -1;
          new Float32Array(data, 4, 3).set([v.fadeStart, v.fadeEnd, 0]);
          const b = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
          c.device.queue.writeBuffer(b, 0, data);
          c.resources.publish('ocean.nearField', b);
        };
        inputs.setOceanWetness = (v) => {
          wetness = v;
          if (!v) {
            app?.renderer.resources.reset('ocean.wetness');
            return;
          }
          wetnessBuffer ??= c.device.createBuffer({ label: 'lab-inputs.oceanWetness', size: OCEAN_WETNESS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
          c.resources.publish('ocean.wetness', wetnessBuffer);
        };
      },
      prepare(frame) {
        const core = coreOf(ctx);
        const bodyIndex = frame.bodies.findIndex((b) => b.id === site.bodyId);
        const pose = sitePoseOf(site, frame, defs);
        if (wetness && wetnessBuffer) {
          // Slot 0: the plane point and its normal are camera-relative, so they are rewritten every frame.
          const at = v3.add(pose.originRelCam, quat.rotate(pose.q, v3.fromTuple(wetness.at)));
          const up = quat.rotate(pose.q, { x: 0, y: 0, z: 1 });
          new Uint32Array(wetnessData, 0, 4).set([1, 0, 0, 0]);
          new Float32Array(wetnessData, 16, 12).set([at.x, at.y, at.z, wetness.radius, up.x, up.y, up.z, wetness.wetLine, 1, 0, 0, 0.01]);
          ctx.device.queue.writeBuffer(wetnessBuffer, 0, wetnessData);
        }
        core.setCloudShadowParams({
          far: cloudFar ? { bodyIndex, layerRadius: defs.bodies[site.bodyId]!.radius + 5000, opticalDepth: cloudFar.opticalDepth, longitudeOffset: 0 } : null,
          // A 200 m wide map centred on the site, aligned with east / north.
          near: cloudNear
            ? { bodyIndex, originRelCam: pose.originRelCam, axisU: quat.rotate(pose.q, { x: 1, y: 0, z: 0 }), axisV: quat.rotate(pose.q, { x: 0, y: 1, z: 0 }), halfExtent: 100, opticalDepthScale: cloudNear.opticalDepth }
            : null,
        });
        if (light) {
          frame.lights.push({
            kind: 'point',
            posRelCam: v3.add(pose.originRelCam, quat.rotate(pose.q, { x: light.at[0], y: light.at[1], z: light.height })),
            intensity: [light.intensity, light.intensity, light.intensity],
            range: light.height * 4,
          });
        }
      },
    });
  }

  // --------------------------------------------------------------------------------------------- sun
  if (names.has('sun')) {
    let pipeline: Tracked<GPURenderPipeline>;
    features.push({
      id: 'lab-sun',
      init(c) {
        pipeline = coreOf(c).fullscreenPipeline({
          label: 'lab-sun.disc',
          // Mean luminance E / (pi sin^2(theta_s)) = 1.9e9 cd/m^2 with limb darkening; saturates at HDR_MAX.
          fragment: /* wgsl */ `@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
              let d = normalize(viewRay(in.uv));
              let s = frame.sunDir.xyz;
              let ang = atan2(length(cross(d, s)), dot(d, s));
              let r = ang / frame.sunDir.w;
              if (r >= 1.0) { discard; }
              let limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - r * r, 0.0)));
              let lum = frame.sunIlluminance.rgb / (PI * sq(sin(frame.sunDir.w))) * (limb / 0.8) * frame.misc.y;
              return vec4f(writeHdr(lum * frame.exposure.x), 1.0);
            }`,
          targets: [{ format: RENDER_FORMATS.hdr }],
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'equal' },
        });
        pipeline.get();
      },
      drawBackground(_frame, pass) {
        pass.setPipeline(pipeline.get());
        pass.draw(3);
      },
    });
  }

  // ------------------------------------------------------------------------------------------- heavy
  if (names.has('heavy')) {
    let ctx: RenderContext;
    let pipeline: Tracked<GPURenderPipeline>;
    let target: ManagedTarget;
    let uniform: GPUBuffer;
    let layout: GPUBindGroupLayout;
    let group: GPUBindGroup;
    features.push({
      id: 'lab-heavy',
      init(c) {
        ctx = c;
        const core = coreOf(c);
        target = core.createTarget('lab-heavy.scratch', 'rgba16float', 1);
        uniform = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        layout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
        group = c.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
        // A march whose step count scales with FrameContext.qualityScale, like a real volumetric feature.
        pipeline = core.fullscreenPipeline({
          label: 'lab-heavy.burn',
          layouts: [layout],
          fragment: /* wgsl */ `struct HeavyU { v: vec4f }
            @group(1) @binding(0) var<uniform> heavy: HeavyU;
            @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
              let steps = i32(heavy.v.x * frame.exposure.z);
              var a = vec3f(in.uv, 0.5);
              for (var i = 0; i < steps; i++) { a = fract(sin(a.yzx * 12.9898 + a.zxy * 78.233 + f32(i)) * 43758.5453); }
              return vec4f(a, 1.0);
            }`,
          targets: [{ format: 'rgba16float' }],
        });
        pipeline.get();
      },
      prepare() {
        ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([heavyIterations, 0, 0, 0]));
      },
      // Encoded first in the frame (compute hook), so that the long pass is followed by ordinary passes and not
      // by one of the core's texture copies: the gap that times a copy would pick up the tail of this pass.
      compute(frame, encoder) {
        if (heavyIterations <= 0) return;
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-heavy.burn') });
        pass.setBindGroup(0, frame.frameBindGroup);
        pass.setPipeline(pipeline.get());
        pass.setBindGroup(1, group);
        pass.draw(3);
        pass.end();
        // An empty pass of this feature right behind it: in one frame out of five about 0.23 ms of the burn is
        // still in flight at its end timestamp and is charged to whatever is encoded next (measured on the copy
        // that used to follow, then on the G-buffer pass). The empty pass keeps it away from the core's copies
        // and render passes. It does NOT keep it away from a feature's compute pass: measured per frame in the
        // integration lab, the first compute pass after this one still read about 0.23 ms too long in one frame
        // out of four, whatever was placed in between. A run that measures features with compute passes puts
        // its ballast at the end of the frame instead (labs/integration/ballast.ts).
        encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-heavy.tail') }).end();
      },
    });
  }

  // ---------------------------------------------------------------------------------------- reactive
  if (names.has('reactive')) {
    let ctx: RenderContext;
    let mask: Tracked<GPURenderPipeline>;
    let patch: Tracked<GPURenderPipeline>;
    let uniform: GPUBuffer;
    let group: GPUBindGroup;
    const P = REACTIVE_PATCH;
    features.push({
      id: 'lab-reactive',
      requires: ['post.reactive'],
      init(c) {
        ctx = c;
        const core = coreOf(c);
        uniform = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const layout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
        group = c.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
        const U = /* wgsl */ `struct ReactiveU { v: vec4f }   // x = mask value, y = frame index
          @group(1) @binding(0) var<uniform> ru: ReactiveU;`;
        mask = core.fullscreenPipeline({
          label: 'lab-reactive.mask',
          layouts: [layout],
          fragment: `${U}
            @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f { return vec4f(ru.v.x, 0.0, 0.0, 1.0); }`,
          targets: [{ format: 'r8unorm', blend: { color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' } } }],
        });
        patch = core.fullscreenPipeline({
          label: 'lab-reactive.patch',
          layouts: [layout],
          fragment: `#include "hash"
            ${U}
            @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
              // White noise per pixel and frame: a high-contrast pattern the neighbourhood clip cannot reject.
              let h = hash4(i32(in.position.x), i32(in.position.y), i32(ru.v.y), 77);
              return vec4f(vec3f(select(0.0, 2.0, (h & 1u) == 1u)), 1.0);
            }`,
          targets: [{ format: RENDER_FORMATS.hdr }],
          depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'always' },
        });
      },
      prepare(frame) {
        ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([reactiveValue, frame.frameIndex, 0, 0]));
      },
      preTransparent(frame, encoder) {
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: ctx.resources.get('post.reactive'), loadOp: 'load', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-reactive.mask') });
        pass.setBindGroup(0, frame.frameBindGroup);
        pass.setPipeline(mask.get());
        pass.setBindGroup(1, group);
        pass.setScissorRect(P.x, P.y, P.width / 2, P.height);
        pass.draw(3);
        pass.end();
      },
      drawTransparent(frame, pass) {
        pass.setPipeline(patch.get());
        pass.setBindGroup(1, group);
        pass.setScissorRect(P.x, P.y, P.width, P.height);
        pass.draw(3);
        pass.setScissorRect(0, 0, frame.renderSize[0], frame.renderSize[1]);
      },
    });
  }

  // ------------------------------------------------------------------------------------------ copies
  if (names.has('copies')) features.push({ id: 'lab-copies', requires: ['scene.colorCopy', 'scene.colorCopyTransparent'], init() {} });

  // ------------------------------------------------------------------------------------------- ridge
  const moonId = Object.values(defs.bodies).find((b) => b.parent === defs.rootBodyId && b.gravityRole === 'attractor')?.id ?? defs.rootBodyId;
  const ridgeSite: Site = { bodyId: query.get('ridgeBody') ?? moonId, latDeg: 10, lonDeg: 20, alt: 0 };
  if (query.get('ridge') === 'track') {
    // Under the active vessel's ground track, about 60 s of flight ahead of its starting point.
    const v = initial.vessels.find((x) => x.id === initial.activeVesselId);
    const b = initial.bodies.find((x) => x.id === v?.bodyId);
    if (v && b) {
      const ahead = quat.rotateInv(b.qFixedToRoot, v3.addScaled(v.r, v.v, 60));
      const ll = dirToLatLon(v3.normalize(ahead));
      ridgeSite.bodyId = b.id;
      ridgeSite.latDeg = (ll.lat * 180) / Math.PI;
      ridgeSite.lonDeg = (ll.lon * 180) / Math.PI;
    }
  }
  if (names.has('ridge')) {
    let batch: MeshBatch;
    let model: ModelHandle;
    features.push({
      id: 'lab-ridge',
      init(c) {
        const meshes = coreOf(c).meshes;
        batch = meshes.createBatch('lab-ridge');
        // 150 km long (north-south), 20 km wide, 6 km above the datum: a body-fixed caster for the whole-body cascade.
        model = meshes.createModel({ name: 'ridge', lods: [boxMesh(20e3, 150e3, 12e3)], materials: [{ name: 'ridge', shading: 'regolith', baseColor: [0.14, 0.135, 0.13], roughness: 1, metallic: 0 }] });
      },
      prepare(frame) {
        batch.begin(frame);
        batch.add(model, instanceInFrame(sitePoseOf(ridgeSite, frame, defs), { x: 0, y: 0, z: 0 }, null, { bodyFixed: true }));
        batch.finish();
      },
      drawGBuffer(_f, pass) {
        batch.drawGBuffer(pass);
      },
      drawShadow(_f, pass, cascade) {
        batch.drawShadow(pass, cascade);
      },
    });
  }

  return {
    features,
    inputs,
    ridgeSite,
    attach(a) {
      app = a;
    },
    setReactive(value) {
      reactiveValue = value;
    },
    hookLog: () => hookLogLast,
    cascadeLog: () => cascadeLog.slice(),
    clearCascadeLog: () => {
      cascadeLog.length = 0;
    },
    movingCasterViolations: () => violations,
    setCloudLayer(on) {
      cloudLayer = on === true ? { begin: 18, end: 22 } : on === false ? null : on;
    },
    setVolume(on) {
      volumeOn = on;
    },
    volumeScreen: () => volumeScreen,
    setHeavy(n) {
      heavyIterations = n;
    },
    heavyIterations: () => heavyIterations,
    setFlame(luminance) {
      flameLuminance = Math.max(0, luminance);
    },
  };
}
