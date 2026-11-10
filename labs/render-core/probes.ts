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
 *   ridge    a 300 km body-fixed ridge on the moon-sized body (terminator shadow from far away)
 *
 * Markers are 16 x 16 px squares in the top-left corner of the render target: marker k covers
 * x = 8 + 24 k .. 24 + 24 k, y = 8 .. 24.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import { RENDER_FORMATS, type FrameContext, type RenderContext, type RenderFeature, type ShadowCascadeView } from '@/core/contracts/render';
import { quat, v3, type Vec3 } from '@/core/math';
import { boxMesh, coreOf, instanceInFrame, type CoreApi, type ManagedTarget, type MeshBatch, type ModelHandle, type SceneBindings, type Tracked } from '@/render/core';
import type { LabApp } from '@/render/core/lab';
import { sitePoseOf, type Site } from './world';

export const MARKER = { size: 16, y: 8, x: (k: number): number => 8 + 24 * k };
/** Depth written by the hooks probe at marker 0: changes every frame so stale copies are detected. */
export const markerDepth = (frameIndex: number): number => 0.25 + 0.5 * ((frameIndex * 0.37) % 1);

export interface CascadeLogEntry {
  frame: number;
  index: number;
  everyFrame: boolean;
  fit: string;
  anchor: string;
  texelSize: number;
}

export interface Probes {
  features: RenderFeature[];
  attach(app: LabApp): void;
  /** `<featureId>.<hook>` in call order for the last completed frame (order probe). */
  hookLog(): string[];
  cascadeLog(): CascadeLogEntry[];
  clearCascadeLog(): void;
  /** Cascades in which a MOVING caster was asked to draw although the cascade is not every-frame (must stay empty). */
  movingCasterViolations(): number;
  setCloudLayer(on: boolean): void;
  setVolume(on: boolean): void;
  /** Projected centre (render px) and radius (px) of the fog sphere in the last frame. */
  volumeScreen(): { x: number; y: number; radius: number } | null;
  setHeavy(iterations: number): void;
  heavyIterations(): number;
}

const scissorMarker = (pass: GPURenderPassEncoder, k: number): void => pass.setScissorRect(MARKER.x(k), MARKER.y, MARKER.size, MARKER.size);

export function createProbes(query: URLSearchParams, site: Site, defs: DefLibrary): Probes {
  const names = new Set((query.get('probe') ?? '').split(',').filter(Boolean));
  const features: RenderFeature[] = [];
  let app: LabApp | null = null;
  let hookLogCurrent: string[] = [];
  let hookLogLast: string[] = [];
  const cascadeLog: CascadeLogEntry[] = [];
  let violations = 0;
  let cloudLayer = false;
  let volumeOn = true;
  let volumeScreen: { x: number; y: number; radius: number } | null = null;
  let heavyIterations = Number(query.get('heavy') ?? 0);

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
        cascadeLog.push({ frame: frame.frameIndex, index: c.index, everyFrame: c.everyFrame, fit: c.fit, anchor: `${c.anchor.kind}:${c.anchor.id}`, texelSize: c.texelSize });
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
        fullRect(pass, frame);
      },
      drawWater(frame, pass) {
        pass.setPipeline(P.water!.get());
        pass.setBindGroup(1, group());
        scissorMarker(pass, 1);
        pass.draw(3);
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
    let published = false;
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
        // Publish (or withdraw) a synthetic cloud layer: transmittance 0.02 at 20 m over the LEFT half of the screen.
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
        depth = ctx.device.createTexture({ format: 'r32float', size: [w, h], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        const s = new Uint16Array(w * h * 4);
        const d = new Float32Array(w * h);
        const one = 0x3c00;
        const t002 = 0x251f; // 0.02 as float16
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const left = x < w / 2;
            s[(y * w + x) * 4 + 3] = left ? t002 : one;
            d[y * w + x] = left ? 20 : 3.0e38;
          }
        }
        ctx.device.queue.writeTexture({ texture: screen }, s, { bytesPerRow: w * 8 }, [w, h]);
        ctx.device.queue.writeTexture({ texture: depth }, d, { bytesPerRow: w * 4 }, [w, h]);
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

  return {
    features,
    attach(a) {
      app = a;
    },
    hookLog: () => hookLogLast,
    cascadeLog: () => cascadeLog.slice(),
    clearCascadeLog: () => {
      cascadeLog.length = 0;
    },
    movingCasterViolations: () => violations,
    setCloudLayer(on) {
      cloudLayer = on;
    },
    setVolume(on) {
      volumeOn = on;
    },
    volumeScreen: () => volumeScreen,
    setHeavy(n) {
      heavyIterations = n;
    },
    heavyIterations: () => heavyIterations,
  };
}
