/**
 * createCockpitFeature: the capsule interior as ordinary scene geometry in the one scene, drawn wherever a
 * vessel whose vehicle names a cockpit layout carries its command part.
 *
 *  - prepare: picks the cockpit vessel, places the interior in the command part's frame (float64 ->
 *    camera-relative), selects the detail level (inside / outside near / outside far), evaluates the
 *    instruments, the cabin light sources and the crew-experience effects, uploads the uniforms;
 *  - compute: paints the MFD pages that are due (15 Hz, staggered) into 'ui.mfd';
 *  - drawShadow: the interior is a MOVING caster: every-frame cascades only (cascade 0 is vessel-anchored
 *    in cockpit view, so the sun patches through the windows are crisp);
 *  - drawGBuffer: interior, display screens (MATERIAL_ID.display), the attitude ball;
 *  - drawTransparent (order 100, after plumes and plasma): window panes and cover glass;
 *  - drawOverlay: g-induced tunnel vision when the camera is the interior view.
 */
import type { VehicleDef } from '@/core/contracts/defs';
import { RENDER_FORMATS, type FrameContext, type RenderContext, type RenderFeature, type ShadowCascadeView } from '@/core/contracts/render';
import type { PartSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { CockpitControls, MfdPainter, NavballRenderer } from '@/core/contracts/ui';
import { mat3, quat, v3, type Quat, type Vec3 } from '@/core/math';
import { coreOf, createSceneBindings, MAX_BODIES, mipCount, nearestBody, sunVisibilityAt, type SceneBindings, type Tracked } from '@/render/core';
import { BALL_RADIUS_FRACTION } from '@/ui';
import { paintLabelAtlas } from './atlas';
import { buildCockpitModel, type CockpitModel, type LodName } from './build';
import { ATLAS_HEIGHT, ATLAS_WIDTH, seatFrames } from './cabin/context';
import { createCockpitControls, type CockpitControlsImpl } from './controls';
import { MfdDisplays } from './displays';
import { controlStates, updateMemory, type ControlState, type InstrumentMemory } from './instruments';
import { cockpitLayouts } from './layout';
import { cabinSources, floodLuminance, glassTransmittance, MAX_CABIN_POLYS, type CabinPoly } from './lighting';
import { VERTEX_STRIDE } from './mesh';
import { insideDistance } from './mould';
import { AMBIENT_SCENE_BINDING, AMBIENT_VEC4S, AMBIENT_WGSL, BALL_WGSL, CABIN_CHUNK, CABIN_DECLS, CABIN_SCENE_BINDING, CABIN_HEADER_FLOATS, CABIN_POLY_FLOATS, CABIN_UNIFORM_FLOATS, CONTROL_FLOATS, DISPLAY_WGSL, GLASS_WGSL, INTERIOR_DEPTH_ENTRY, INTERIOR_WGSL, MAX_MATERIALS, SHADOW_WGSL, TUNNEL_WGSL } from './shaders';

export interface CockpitFeatureOptions {
  /** The shared navball renderer; its view is published as 'ui.navball' when nobody else has. */
  navball: NavballRenderer;
  mfdPainter: MfdPainter;
  /** Feature id (default 'cockpit') and transparent order (default 100: after plumes and plasma). */
  id?: string;
  order?: number;
}

export interface CockpitFrameStats {
  active: boolean;
  layout: string | null;
  vesselId: string | null;
  lod: LodName | null;
  inside: boolean;
  triangles: number;
  shadowTriangles: number;
  polys: number;
  patches: number;
  tunnel: number;
  vibration: number;
  displayBrightness: number;
  prepareMs: number;
}

export interface CockpitFeature extends RenderFeature {
  /** Built interiors by layout id (available after init). */
  model(layout: string): CockpitModel | undefined;
  /** What the last prepared frame drew. */
  stats(): CockpitFrameStats;
  readonly displays: MfdDisplays | null;
  /** Per-control state of the last frame (tests). */
  controlStates(): readonly ControlState[];
}

interface GpuModel {
  model: CockpitModel;
  vertex: GPUBuffer;
  index: GPUBuffer;
  display: GPUBuffer;
  displayCount: number;
  ball: GPUBuffer;
  ballCount: number;
  glass: GPUBuffer;
  panes: { first: number; count: number; centre: Vec3 }[];
  cabin: GPUBuffer;
  controls: GPUBuffer;
  materials: GPUBuffer;
  atlas: GPUTexture;
  group: GPUBindGroup | null;
  groupVersion: number;
  /** The ambient pass's group (cabin uniform, displays, output, scene sets) and its resource version. */
  ambientGroup: GPUBindGroup | null;
  ambientVersion: number;
  shadowGroup: GPUBindGroup;
  cabinData: Float32Array<ArrayBuffer>;
  controlData: Float32Array<ArrayBuffer>;
  prevControls: ControlState[] | null;
  memory: InstrumentMemory;
}

const PANE_FLOATS = 10;

export function createCockpitFeature(ctx0: RenderContext, opts: CockpitFeatureOptions): { feature: CockpitFeature; controls: CockpitControls } {
  const defs = ctx0.defs;
  const layoutIds = Object.keys(cockpitLayouts(defs));
  const first = layoutIds[0] ? cockpitLayouts(defs)[layoutIds[0]]! : null;
  const pages = opts.mfdPainter.pages;
  const controls: CockpitControlsImpl = createCockpitControls(pages, first ? first.displays.pages : [pages[0]!, pages[1 % pages.length]!, pages[2 % pages.length]!]);

  let ctx: RenderContext;
  const models = new Map<string, GpuModel>();
  let layout: GPUBindGroupLayout;
  let shadowLayout: GPUBindGroupLayout;
  let tunnelLayout: GPUBindGroupLayout;
  let scene: SceneBindings;
  let ambientScene: SceneBindings;
  let ambientLayout: GPUBindGroupLayout;
  let ambientPipe: Tracked<GPUComputePipeline>;
  /** Output of the ambient pass, read by every cabin pixel (shared by the layouts: one interior is drawn). */
  let ambientBuf: GPUBuffer;
  let interior: Tracked<GPURenderPipeline>;
  let interiorDepth: Tracked<GPURenderPipeline>;
  let shadow: Tracked<GPURenderPipeline>;
  let display: Tracked<GPURenderPipeline>;
  let ballPipe: Tracked<GPURenderPipeline>;
  let glassMul: Tracked<GPURenderPipeline>;
  let glassAdd: Tracked<GPURenderPipeline>;
  let tunnelPipe: Tracked<GPURenderPipeline>;
  let tunnelBuffer: GPUBuffer;
  let tunnelGroup: GPUBindGroup;
  let displays: MfdDisplays | null = null;
  let navballVersion = -1;

  // Per-frame state.
  let active: { gm: GpuModel; lod: LodName; vessel: VesselSnapshot; interiorView: boolean; centre: Vec3 } | null = null;
  let clock = 0;
  let gFiltered = 1;
  let tunnel = 0;
  let prevVib: Vec3 = v3.zero();
  let lastLod: LodName | null = null;
  let lastStates: ControlState[] = [];
  const st: CockpitFrameStats = { active: false, layout: null, vesselId: null, lod: null, inside: false, triangles: 0, shadowTriangles: 0, polys: 0, patches: 0, tunnel: 0, vibration: 0, displayBrightness: 0, prepareMs: 0 };

  const pick = (frame: FrameContext): { gm: GpuModel; vessel: VesselSnapshot; part: PartSnapshot; vehicle: VehicleDef } | null => {
    const s = frame.snapshot;
    const order = [frame.camera.insideVesselId, s.activeVesselId, ...s.vessels.map((v) => v.id)];
    for (const id of order) {
      if (!id) continue;
      const vessel = s.vessels.find((v) => v.id === id);
      if (!vessel) continue;
      const vehicle = defs.vehicles[vessel.vehicleId];
      if (!vehicle?.cockpit) continue;
      const gm = models.get(vehicle.cockpit);
      if (!gm) continue;
      const part = vessel.parts.find((p) => p.instanceId === vehicle.cameras.cockpit.part);
      if (!part) continue;
      return { gm, vessel, part, vehicle };
    }
    return null;
  };

  const feature: CockpitFeature = {
    id: opts.id ?? 'cockpit',
    order: opts.order ?? 100,
    get displays() {
      return displays;
    },
    model: (id) => models.get(id)?.model,
    stats: () => ({ ...st }),
    controlStates: () => lastStates,

    init(c) {
      ctx = c;
      const device = c.device;
      const core = coreOf(c);
      core.shaders.register('cockpit_cabin', CABIN_CHUNK);
      scene = createSceneBindings(c, 1, CABIN_SCENE_BINDING, ['env', 'atmosphereLuts', 'transparency', 'shadow']);
      ambientScene = createSceneBindings(c, 1, AMBIENT_SCENE_BINDING, ['env', 'atmosphereLuts']);
      ambientBuf = device.createBuffer({ label: 'cockpit.ambient', size: AMBIENT_VEC4S * 16, usage: GPUBufferUsage.STORAGE });
      ambientLayout = device.createBindGroupLayout({
        label: 'cockpit.ambient',
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          ...ambientScene.layoutEntries,
        ],
      });
      ambientPipe = core.shaders.tracked(() =>
        device.createComputePipeline({
          label: 'cockpit.ambient',
          layout: device.createPipelineLayout({ label: 'cockpit.ambient', bindGroupLayouts: [c.frameBindGroupLayout, ambientLayout] }),
          compute: { module: c.shaders.createModule('cockpit.ambient', AMBIENT_WGSL(ambientScene.wgsl)), entryPoint: 'main' },
        }),
      );
      const FV = GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX;
      layout = device.createBindGroupLayout({
        label: 'cockpit.cabin',
        entries: [
          { binding: 0, visibility: FV, buffer: { type: 'uniform' } },
          { binding: 1, visibility: FV, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
          { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
          ...scene.layoutEntries,
        ],
      });
      shadowLayout = shadowLayoutFor(c);
      tunnelLayout = device.createBindGroupLayout({ label: 'cockpit.tunnel', entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      const decls = CABIN_DECLS(scene.wgsl);
      const gbufferTargets: GPUColorTargetState[] = [
        { format: RENDER_FORMATS.gbufferAlbedo },
        { format: RENDER_FORMATS.gbufferNormal },
        { format: RENDER_FORMATS.gbufferMaterial },
        { format: RENDER_FORMATS.gbufferVelocity },
        { format: RENDER_FORMATS.gbufferExtra },
        { format: RENDER_FORMATS.hdr },
      ];
      const gbufferDepth: GPUDepthStencilState = { format: RENDER_FORMATS.depth, depthWriteEnabled: true, depthCompare: 'greater' };
      const plLayout = device.createPipelineLayout({ label: 'cockpit', bindGroupLayouts: [c.frameBindGroupLayout, layout] });
      const vtx = (attrs: [number, GPUVertexFormat, number][], stride: number): GPUVertexBufferLayout[] => [{ arrayStride: stride, attributes: attrs.map(([shaderLocation, format, offset]) => ({ shaderLocation, format, offset })) }];
      const interiorLayout = vtx(
        [
          [0, 'float32x3', 0],
          [1, 'snorm16x4', 12],
          [2, 'snorm16x4', 20],
          [3, 'float32x2', 28],
          [4, 'unorm16x2', 36],
          [5, 'uint8x4', 40],
          [6, 'uint16x2', 44],
        ],
        VERTEX_STRIDE,
      );
      const gpipe = (label: string, code: string, buffers: GPUVertexBufferLayout[], pass: 'single' | 'depth' | 'shade' = 'single'): Tracked<GPURenderPipeline> =>
        core.shaders.tracked(() => {
          const module = c.shaders.createModule(label, code);
          return device.createRenderPipeline({
            label,
            layout: plLayout,
            vertex: { module, entryPoint: 'vs', buffers },
            fragment:
              pass === 'depth'
                ? { module, entryPoint: INTERIOR_DEPTH_ENTRY, targets: gbufferTargets.map((x) => ({ ...x, writeMask: 0 })) }
                : { module, entryPoint: 'fs', targets: gbufferTargets },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            // The interior is drawn twice: depth first, then shaded where its depth won (no overdraw shading).
            depthStencil: pass === 'shade' ? { ...gbufferDepth, depthWriteEnabled: false, depthCompare: 'equal' } : gbufferDepth,
          });
        });
      interiorDepth = gpipe('cockpit.interiorDepth', INTERIOR_WGSL(decls), interiorLayout, 'depth');
      interior = gpipe('cockpit.interior', INTERIOR_WGSL(decls), interiorLayout, 'shade');
      display = gpipe('cockpit.display', DISPLAY_WGSL(decls), vtx([[0, 'float32x3', 0], [1, 'float32x3', 12], [2, 'float32x2', 24], [3, 'float32', 32]], 36));
      ballPipe = gpipe('cockpit.ball', BALL_WGSL(decls), vtx([[0, 'float32x3', 0], [1, 'float32x3', 12], [2, 'float32x2', 24]], 32));
      shadow = core.shaders.tracked(() => {
        const module = c.shaders.createModule('cockpit.shadow', SHADOW_WGSL);
        return device.createRenderPipeline({
          label: 'cockpit.shadow',
          layout: device.createPipelineLayout({ label: 'cockpit.shadow', bindGroupLayouts: [c.frameBindGroupLayout, core.shadowPassLayout, shadowLayout] }),
          vertex: { module, entryPoint: 'vs', buffers: vtx([[0, 'float32x3', 0], [6, 'uint16x2', 44]], VERTEX_STRIDE) },
          primitive: { topology: 'triangle-list', cullMode: 'none', unclippedDepth: true },
          depthStencil: { format: RENDER_FORMATS.shadow, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
        });
      });
      const glassBuffers = vtx([[0, 'float32x3', 0], [1, 'float32x3', 12], [2, 'float32x2', 24], [3, 'float32x2', 32]], PANE_FLOATS * 4);
      const glassPipe = (entry: 'fsMultiply' | 'fsAdd'): Tracked<GPURenderPipeline> =>
        core.shaders.tracked(() => {
          const module = c.shaders.createModule('cockpit.glass', GLASS_WGSL(decls));
          const blend: GPUBlendState =
            entry === 'fsMultiply'
              ? { color: { srcFactor: 'zero', dstFactor: 'src', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } }
              : { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
          return device.createRenderPipeline({
            label: `cockpit.glass.${entry}`,
            layout: plLayout,
            vertex: { module, entryPoint: 'vs', buffers: glassBuffers },
            fragment: { module, entryPoint: entry, targets: [{ format: RENDER_FORMATS.hdr, blend }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' },
          });
        });
      glassMul = glassPipe('fsMultiply');
      glassAdd = glassPipe('fsAdd');
      tunnelPipe = core.fullscreenPipeline({
        label: 'cockpit.tunnel',
        fragment: TUNNEL_WGSL,
        targets: [{ format: c.canvasFormat, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }],
        layouts: [tunnelLayout],
      });
      tunnelBuffer = device.createBuffer({ label: 'cockpit.tunnel', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      tunnelGroup = device.createBindGroup({ label: 'cockpit.tunnel', layout: tunnelLayout, entries: [{ binding: 0, resource: { buffer: tunnelBuffer } }] });

      // Displays: one array for every layout (the largest display count).
      const counts = layoutIds.map((id) => cockpitLayouts(defs)[id]!.console.displays.length);
      if (first) {
        displays = new MfdDisplays(device, Math.max(1, ...counts), first.displays.width, first.displays.height, first.displays.rateHz, opts.mfdPainter, defs, c.perf);
        c.resources.publish('ui.mfd', displays.view);
        controls.onChange((d) => displays?.markDirty(d));
      }
      if (c.resources.version('ui.navball') === 0) c.resources.publish('ui.navball', opts.navball.view);
      for (const id of layoutIds) models.set(id, uploadModel(c, buildCockpitModel(defs, id)));
      // Compile now so that shader errors surface before the first frame.
      ambientPipe.get();
      interiorDepth.get();
      interior.get();
      display.get();
      ballPipe.get();
      shadow.get();
      glassMul.get();
      glassAdd.get();
      tunnelPipe.get();
    },

    prepare(frame) {
      const t0 = performance.now();
      active = null;
      st.active = false;
      clock += frame.realDt;
      const p = pick(frame);
      if (!p) {
        st.layout = null;
        st.vesselId = null;
        st.prepareMs = performance.now() - t0;
        return;
      }
      const { gm, vessel, part } = p;
      const model = gm.model;
      const vp = frame.vesselPose(vessel.id);
      if (!vp) return;
      const origin0 = v3.add(vp.originRelCam, quat.rotate(vp.q, part.localPos));
      const q = quat.mul(vp.q, part.localRot);
      const prevOrigin0 = v3.add(vp.prevOriginRelCam, quat.rotate(vp.prevQ, part.localPos));
      const prevQ = quat.mul(vp.prevQ, part.localRot);
      const camPart = quat.rotateInv(q, v3.neg(origin0));
      const inside = insideDistance(model.mould, camPart) > model.mould.wallThickness * 0.5;
      const interiorView = frame.camera.kind === 'interior' && frame.camera.insideVesselId === vessel.id;

      // ---- crew experience: structure-borne vibration (cabin relative to the head) and tunnel vision
      const exp = model.layout.experience;
      let vib = v3.zero();
      if (interiorView && frame.animate) {
        const accel = vessel.thrust / Math.max(vessel.mass, 1);
        const mach = vessel.aero.mach;
        const buffet = 1 + 2 * Math.exp(-(((mach - 1) / 0.25) ** 2));
        const amp = Math.min(exp.vibration.maxAmplitude, exp.vibration.perAccel * accel + exp.vibration.perKpa * (vessel.aero.q / 1000) * buffet);
        if (amp > 1e-6) {
          const fs = exp.vibration.frequencies;
          const w = 1 / Math.sqrt(fs.length);
          const comp = (seed: number): number => fs.reduce((s, f, k) => s + Math.sin(2 * Math.PI * f * clock + seed * (k + 1) * 2.399) * w, 0);
          vib = { x: amp * comp(1), y: amp * comp(2) * 0.6, z: amp * comp(3) };
        }
        st.vibration = amp;
      } else st.vibration = 0;
      const origin = v3.add(origin0, quat.rotate(q, vib));
      const prevOrigin = v3.add(prevOrigin0, quat.rotate(prevQ, prevVib));
      prevVib = vib;
      const tn = exp.tunnel;
      const g = frame.snapshot.readouts.gLoad;
      gFiltered += (g - gFiltered) * Math.min(1, frame.realDt / Math.max(tn.tau, 1e-3));
      const target = interiorView ? Math.max(0, Math.min(1, (gFiltered - tn.onsetG) / Math.max(tn.fullG - tn.onsetG, 1e-3))) : 0;
      tunnel = interiorView ? target * target * (3 - 2 * target) : 0;
      st.tunnel = tunnel;

      // ---- detail level: full inside and close by, reduced outside, far beyond the projected-size threshold
      const dist = v3.len(origin);
      const pxScale = frame.renderSize[1] / (2 * Math.tan(frame.camera.fovY / 2));
      const sizePx = (2 * model.mould.heatShield.maxDiameter) / Math.max(dist, 1e-3) * pxScale * 0.5;
      let lod: LodName = inside || dist < 6 ? 'lod0' : sizePx > model.layout.farLodPixels ? 'lod1' : 'lod2';
      if (lastLod === 'lod0' && !inside && dist < 7) lod = 'lod0';
      lastLod = lod;

      // ---- instruments
      updateMemory(gm.memory, frame.snapshot);
      const seats = new Map(seatFrames(model.mould).map((s) => [s.id, { R: s.R, U: s.U, L: s.L }]));
      const states = controlStates(model.controls, frame.snapshot, defs, clock, gm.memory, (id) => seats.get(id)!, (i) => floodLuminance(model, i));
      writeControls(ctx, gm, states);
      lastStates = states;

      // ---- cabin light
      const vesselPos = v3.add(vessel.rRoot, quat.rotate(vessel.q, part.localPos));
      const sunVis = frame.sun.illuminance > 0 ? sunVisibilityAt(vesselPos, frame.snapshot, defs) : 0;
      const sunPart = quat.rotateInv(q, frame.sun.dirRoot);
      const sources = cabinSources(model, sunVis > 0 ? { dirPart: sunPart, illuminance: frame.sun.illuminance * sunVis, color: frame.sun.color } : null, frame.snapshot.readouts.lightsOn);
      st.polys = sources.polys.length;
      st.patches = sources.polys.filter((x) => x.kind === 1).length;
      const near = nearestBody(vesselPos, frame.snapshot, defs);
      let bodyIndex = -1;
      let rBody = 0;
      let mu = 1;
      if (near && near.def.atmosphere) {
        const idx = frame.bodies.findIndex((b) => b.id === near.body.id);
        if (idx >= 0 && idx < MAX_BODIES) {
          bodyIndex = idx;
          const rel = v3.sub(vesselPos, near.body.rRoot);
          rBody = v3.len(rel);
          mu = v3.dot(v3.scale(rel, 1 / rBody), frame.sun.dirRoot);
        }
      }
      writeCabin(gm, {
        origin,
        q,
        prevOrigin,
        prevQ,
        sources: sources.polys,
        sunDirRoot: frame.sun.dirRoot,
        sunIllum: frame.sun.illuminance * sunVis,
        sunColor: frame.sun.color,
        bodyIndex,
        rBody,
        mu,
        sunFlux: sources.sunFlux,
        lampFlux: sources.lampFlux,
        plasma: vessel.aero.plasmaIntensity,
        time: clock,
        camPart,
        inside,
      });
      ctx.device.queue.writeBuffer(gm.cabin, 0, gm.cabinData);
      if (tunnel > 0.001) ctx.device.queue.writeBuffer(tunnelBuffer, 0, new Float32Array([tunnel, frame.displaySize[0] / frame.displaySize[1], tn.maxDarken, 0]));

      // ---- bind group (rebuilt when a shared resource is re-published)
      const nv = ctx.resources.version('ui.navball');
      const ver = scene.version() + nv * 7919 + ctx.resources.version('ui.mfd') * 104729;
      if (!gm.group || gm.groupVersion !== ver || nv !== navballVersion) {
        navballVersion = nv;
        gm.groupVersion = ver;
        gm.group = ctx.device.createBindGroup({
          label: 'cockpit.cabin',
          layout,
          entries: [
            { binding: 0, resource: { buffer: gm.cabin } },
            { binding: 1, resource: { buffer: gm.controls } },
            { binding: 2, resource: { buffer: gm.materials } },
            { binding: 3, resource: gm.atlas.createView() },
            { binding: 4, resource: ctx.resources.get('ui.mfd') },
            { binding: 5, resource: ctx.resources.get('ui.navball') },
            { binding: 6, resource: { buffer: ambientBuf } },
            ...scene.entries(),
          ],
        });
      }
      const av = ambientScene.version() + ctx.resources.version('ui.mfd') * 104729;
      if (!gm.ambientGroup || gm.ambientVersion !== av) {
        gm.ambientVersion = av;
        gm.ambientGroup = ctx.device.createBindGroup({
          label: 'cockpit.ambient',
          layout: ambientLayout,
          entries: [
            { binding: 0, resource: { buffer: gm.cabin } },
            { binding: 1, resource: ctx.resources.get('ui.mfd') },
            { binding: 2, resource: { buffer: ambientBuf } },
            ...ambientScene.entries(),
          ],
        });
      }
      const centre = v3.add(origin, quat.rotate(q, { x: 0, y: 1.1, z: 0 }));
      active = { gm, lod, vessel, interiorView, centre };
      st.active = true;
      st.layout = model.layoutId;
      st.vesselId = vessel.id;
      st.lod = lod;
      st.inside = inside;
      st.triangles = model.mesh.ranges[lod]!.count / 3;
      st.shadowTriangles = 0;
      st.prepareMs = performance.now() - t0;
    },

    compute(frame, encoder) {
      if (!displays || !active) return;
      const t0 = performance.now();
      displays.update(clock, frame.snapshot, (i) => controls.page(Math.min(i, controls.displayCount - 1)), encoder);
      // After the display mips: the ambient pass reads their means.
      const ts = ctx.perf.gpuPass('cockpit.ambient') as GPUComputePassTimestampWrites | undefined;
      const pass = encoder.beginComputePass({ label: 'cockpit.ambient', ...(ts ? { timestampWrites: ts } : {}) });
      pass.setPipeline(ambientPipe.get());
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setBindGroup(1, active.gm.ambientGroup!);
      pass.dispatchWorkgroups(1);
      pass.end();
      st.prepareMs += performance.now() - t0;
    },

    drawShadow(_frame, pass, cascade: ShadowCascadeView) {
      if (!active || !cascade.everyFrame) return;
      const m = cascade.viewProj;
      const c = active.centre;
      const r = 2.2;
      const scaleU = Math.hypot(m[0]!, m[4]!, m[8]!);
      const scaleV = Math.hypot(m[1]!, m[5]!, m[9]!);
      if (Math.abs(m[0]! * c.x + m[4]! * c.y + m[8]! * c.z + m[12]!) > 1 + r * scaleU) return;
      if (Math.abs(m[1]! * c.x + m[5]! * c.y + m[9]! * c.z + m[13]!) > 1 + r * scaleV) return;
      const gm = active.gm;
      const range = gm.model.mesh.ranges[cascade.texelSize < 0.03 && active.lod === 'lod0' ? 'lod0' : active.lod === 'lod2' ? 'lod2' : 'lod1']!;
      pass.setPipeline(shadow.get());
      pass.setBindGroup(2, gm.shadowGroup);
      pass.setVertexBuffer(0, gm.vertex);
      pass.setIndexBuffer(gm.index, 'uint32');
      pass.drawIndexed(range.count, 1, range.start);
      st.shadowTriangles += range.count / 3;
    },

    drawGBuffer(_frame, pass) {
      if (!active?.gm.group) return;
      const gm = active.gm;
      const range = gm.model.mesh.ranges[active.lod]!;
      pass.setBindGroup(1, gm.group);
      pass.setVertexBuffer(0, gm.vertex);
      pass.setIndexBuffer(gm.index, 'uint32');
      pass.setPipeline(interiorDepth.get());
      pass.drawIndexed(range.count, 1, range.start);
      pass.setPipeline(interior.get());
      pass.drawIndexed(range.count, 1, range.start);
      pass.setPipeline(display.get());
      pass.setVertexBuffer(0, gm.display);
      pass.draw(gm.displayCount);
      pass.setPipeline(ballPipe.get());
      pass.setVertexBuffer(0, gm.ball);
      pass.draw(gm.ballCount);
    },

    drawTransparent(_frame, pass) {
      if (!active?.gm.group) return;
      const gm = active.gm;
      pass.setBindGroup(1, gm.group);
      pass.setVertexBuffer(0, gm.glass);
      // Back to front: the farthest pane first.
      const order = gm.panes.map((pn, i) => ({ i, d: v3.dist(toRootPoint(gm, pn.centre), v3.zero()) })).sort((a, b) => b.d - a.d);
      for (const { i } of order) {
        const pn = gm.panes[i]!;
        pass.setPipeline(glassMul.get());
        pass.draw(pn.count, 1, pn.first);
        pass.setPipeline(glassAdd.get());
        pass.draw(pn.count, 1, pn.first);
      }
    },

    drawOverlay(_frame, pass) {
      if (!active?.interiorView || tunnel <= 0.001) return;
      pass.setPipeline(tunnelPipe.get());
      pass.setBindGroup(1, tunnelGroup);
      pass.draw(3);
    },

    isIdle: () => true,

    dispose() {
      for (const gm of models.values()) {
        for (const b of [gm.vertex, gm.index, gm.display, gm.ball, gm.glass, gm.cabin, gm.controls, gm.materials]) b.destroy();
        gm.atlas.destroy();
      }
      displays?.dispose();
      tunnelBuffer?.destroy();
      ambientBuf?.destroy();
    },
  };
  return { feature, controls };
}

/** Camera-relative ROOT position of a part-frame point with this frame's cabin transform. */
function toRootPoint(gm: GpuModel, p: Vec3): Vec3 {
  const d = gm.cabinData;
  return { x: d[0]! * p.x + d[1]! * p.y + d[2]! * p.z + d[3]!, y: d[4]! * p.x + d[5]! * p.y + d[6]! * p.z + d[7]!, z: d[8]! * p.x + d[9]! * p.y + d[10]! * p.z + d[11]! };
}

function buffer(device: GPUDevice, label: string, data: ArrayBufferView<ArrayBuffer>, usage: GPUBufferUsageFlags): GPUBuffer {
  const b = device.createBuffer({ label, size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(b, 0, data);
  return b;
}

function uploadModel(ctx: RenderContext, model: CockpitModel): GpuModel {
  const device = ctx.device;
  const core = coreOf(ctx);
  const id = model.layoutId;
  const vertex = buffer(device, `cockpit.${id}.vertices`, new Uint8Array(model.mesh.vertices), GPUBufferUsage.VERTEX);
  const index = buffer(device, `cockpit.${id}.indices`, model.mesh.indices as Uint32Array<ArrayBuffer>, GPUBufferUsage.INDEX);

  // Display screens: two triangles each, uv (0,0) top-left.
  const dv: number[] = [];
  for (const d of model.displays) {
    const f = d.frame;
    const hw = d.width / 2;
    const hh = d.height / 2;
    const corner = (a: number, b: number, u: number, vv: number): void => {
      const p = v3.add(f.o, v3.add(v3.scale(f.x, a), v3.scale(f.y, b)));
      dv.push(p.x, p.y, p.z, f.n.x, f.n.y, f.n.z, u, vv, d.index);
    };
    corner(-hw, -hh, 0, 1);
    corner(hw, -hh, 1, 1);
    corner(hw, hh, 1, 0);
    corner(-hw, -hh, 0, 1);
    corner(hw, hh, 1, 0);
    corner(-hw, hh, 0, 0);
  }
  const display = buffer(device, `cockpit.${id}.displays`, new Float32Array(dv), GPUBufferUsage.VERTEX);

  // Attitude ball: the front hemisphere, uv = orthographic projection onto the instrument face.
  const bv: number[] = [];
  const nb = model.navball;
  const R = nb.radius;
  const rings = 24;
  const segs = 48;
  const ballPoint = (i: number, j: number): number[] => {
    const theta = (i / rings) * (Math.PI / 2);
    const phi = (j / segs) * 2 * Math.PI;
    const lx = Math.sin(theta) * Math.cos(phi);
    const ly = Math.sin(theta) * Math.sin(phi);
    const lz = Math.cos(theta);
    const f = nb.frame;
    const n = v3.add(v3.add(v3.scale(f.x, lx), v3.scale(f.y, ly)), v3.scale(f.n, lz));
    const p = v3.addScaled(f.o, n, R);
    return [p.x, p.y, p.z, n.x, n.y, n.z, 0.5 + 0.5 * BALL_RADIUS_FRACTION * lx, 0.5 - 0.5 * BALL_RADIUS_FRACTION * ly];
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = ballPoint(i, j);
      const b = ballPoint(i + 1, j);
      const c = ballPoint(i + 1, j + 1);
      const d = ballPoint(i, j + 1);
      bv.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
  const ball = buffer(device, `cockpit.${id}.ball`, new Float32Array(bv), GPUBufferUsage.VERTEX);

  // Glass: every window pane, the display cover glasses and the attitude indicator's cover glass.
  const gv: number[] = [];
  const panes: { first: number; count: number; centre: Vec3 }[] = [];
  // Last vertex attribute: (pane index, reflectance factor): 1 for bare glass, about 1/8 for the displays'
  // anti-reflection coated cover glass.
  const pushPane = (centre: Vec3, outline: Vec3[], n: Vec3, ux: Vec3, uy: Vec3, reflectance = 1): void => {
    const firstV = gv.length / PANE_FLOATS;
    const uvOf = (p: Vec3): [number, number] => [v3.dot(v3.sub(p, centre), ux), v3.dot(v3.sub(p, centre), uy)];
    for (let i = 0; i < outline.length; i++) {
      for (const p of [centre, outline[i]!, outline[(i + 1) % outline.length]!]) {
        const [u, w] = uvOf(p);
        gv.push(p.x, p.y, p.z, n.x, n.y, n.z, u, w, panes.length, reflectance);
      }
    }
    panes.push({ first: firstV, count: gv.length / PANE_FLOATS - firstV, centre });
  };
  for (const w of model.windows) {
    for (const pane of w.panes) {
      const centre = pane.outline.reduce((s, p) => v3.add(s, v3.scale(p, 1 / pane.outline.length)), v3.zero());
      pushPane(centre, pane.outline, pane.frame.n, pane.frame.x, pane.frame.y);
    }
  }
  for (const d of model.displays) {
    const f = d.frame;
    const c = v3.addScaled(f.o, f.n, 0.0025);
    const hw = d.width / 2 + 0.002;
    const hh = d.height / 2 + 0.002;
    const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([a, b]) => v3.add(c, v3.add(v3.scale(f.x, a!), v3.scale(f.y, b!))));
    pushPane(c, pts, f.n, f.x, f.y, 0.12);
  }
  {
    const f = nb.frame;
    const c = v3.addScaled(f.o, f.n, R + 0.004);
    const pts: Vec3[] = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * 2 * Math.PI;
      pts.push(v3.add(c, v3.add(v3.scale(f.x, Math.cos(a) * R * 1.12), v3.scale(f.y, Math.sin(a) * R * 1.12))));
    }
    pushPane(c, pts, f.n, f.x, f.y);
  }
  const glass = buffer(device, `cockpit.${id}.glass`, new Float32Array(gv), GPUBufferUsage.VERTEX);

  // Materials.
  const mats = new Float32Array(MAX_MATERIALS * 12);
  const DETAIL: Record<string, number> = { none: 0, paint: 1, brushed: 2, quilt: 3, weave: 4, webbing: 5, velcro: 6, ribbed: 7, knurl: 8, rubber: 9, cast: 10, foil: 10 };
  model.materialNames.forEach((name, i) => {
    const m = model.layout.materials[name]!;
    mats.set([m.albedo[0], m.albedo[1], m.albedo[2], m.roughness, m.metallic ?? 0, m.shading === 'cloth' ? 1 : 0, m.anisotropy ?? 0, m.clearcoat ?? 0, DETAIL[m.detail ?? 'none'] ?? 0, m.detailStrength ?? 1, m.translucency ?? 0, 0], i * 12);
  });
  const materials = buffer(device, `cockpit.${id}.materials`, mats, GPUBufferUsage.UNIFORM);

  // Label atlas: painted once, single channel, mip-mapped.
  const atlas = core.createTextureChecked({
    label: `cockpit.${id}.labels`,
    format: 'r8unorm',
    size: [ATLAS_WIDTH, ATLAS_HEIGHT],
    mipLevelCount: mipCount(ATLAS_WIDTH, ATLAS_HEIGHT),
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: paintLabelAtlas(model.labels) }, { texture: atlas }, [ATLAS_WIDTH, ATLAS_HEIGHT]);
  core.mips.generate(atlas);

  const cabin = device.createBuffer({ label: `cockpit.${id}.cabin`, size: CABIN_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const controlCount = Math.max(1, model.controls.length);
  const controls = device.createBuffer({ label: `cockpit.${id}.controls`, size: controlCount * CONTROL_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const shadowGroup = device.createBindGroup({
    label: `cockpit.${id}.shadow`,
    layout: shadowLayoutOf.get(ctx) ?? shadowLayoutFor(ctx),
    entries: [
      { binding: 0, resource: { buffer: cabin, offset: 0, size: 48 } },
      { binding: 1, resource: { buffer: controls } },
    ],
  });
  return {
    model,
    vertex,
    index,
    display,
    displayCount: dv.length / 9,
    ball,
    ballCount: bv.length / 8,
    glass,
    panes,
    cabin,
    controls,
    materials,
    atlas,
    group: null,
    groupVersion: -1,
    ambientGroup: null,
    ambientVersion: -1,
    shadowGroup,
    cabinData: new Float32Array(CABIN_UNIFORM_FLOATS),
    controlData: new Float32Array(controlCount * CONTROL_FLOATS),
    prevControls: null,
    memory: { lastStageUt: null },
  };
}

/** The shadow group layout must be the one the shadow pipeline was built with: shared per context. */
const shadowLayoutOf = new WeakMap<RenderContext, GPUBindGroupLayout>();
function shadowLayoutFor(ctx: RenderContext): GPUBindGroupLayout {
  const l = ctx.device.createBindGroupLayout({
    label: 'cockpit.shadow',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  shadowLayoutOf.set(ctx, l);
  return l;
}

function writeControls(ctx: RenderContext, gm: GpuModel, states: ControlState[]): void {
  const d = gm.controlData;
  const u = new Uint32Array(d.buffer);
  const prev = gm.prevControls ?? states;
  gm.model.controls.forEach((c, i) => {
    const s = states[i]!;
    const p = prev[i]!;
    const o = i * CONTROL_FLOATS;
    d.set([c.pivot.x, c.pivot.y, c.pivot.z, 0, s.rot.x, s.rot.y, s.rot.z, s.rot.w, s.offset.x, s.offset.y, s.offset.z, 0], o);
    u[o + 11] = s.mask >>> 0;
    d.set([p.rot.x, p.rot.y, p.rot.z, p.rot.w, p.offset.x, p.offset.y, p.offset.z, 0, s.emit[0], s.emit[1], s.emit[2], s.lit], o + 12);
  });
  gm.prevControls = states;
  if (gm.model.controls.length > 0) ctx.device.queue.writeBuffer(gm.controls, 0, d);
}

interface CabinFrameInput {
  origin: Vec3;
  q: Quat;
  prevOrigin: Vec3;
  prevQ: Quat;
  sources: CabinPoly[];
  sunDirRoot: Vec3;
  sunIllum: number;
  sunColor: [number, number, number];
  bodyIndex: number;
  rBody: number;
  mu: number;
  sunFlux: number;
  lampFlux: number;
  plasma: number;
  time: number;
  camPart: Vec3;
  inside: boolean;
}

function writeCabin(gm: GpuModel, f: CabinFrameInput): void {
  const d = gm.cabinData;
  const u = new Uint32Array(d.buffer);
  const L = gm.model.layout;
  const rows = (q: Quat, o: Vec3, at: number): void => {
    const r = mat3.fromQuat(q);
    d.set([r[0], r[1], r[2], o.x, r[3], r[4], r[5], o.y, r[6], r[7], r[8], o.z], at);
  };
  rows(f.q, f.origin, 0);
  rows(f.prevQ, f.prevOrigin, 12);
  d.set([f.sunDirRoot.x, f.sunDirRoot.y, f.sunDirRoot.z, f.sunIllum], 24);
  d.set([f.sunColor[0], f.sunColor[1], f.sunColor[2], f.bodyIndex], 28);
  d.set([f.rBody, f.mu, 3.0, 0], 32);
  const rho = L.lighting.cabinAlbedo;
  d.set([rho / (L.lighting.cabinArea * (1 - rho)), rho * f.sunFlux, f.lampFlux, rho], 36);
  const lc = L.lighting.legendColor;
  d.set([lc[0] * L.lighting.legendLuminance, lc[1] * L.lighting.legendLuminance, lc[2] * L.lighting.legendLuminance, f.time], 40);
  const pl = L.lighting.plasmaLuminance * Math.max(0, f.plasma) ** 1.5;
  const pc = L.lighting.plasmaColor;
  d.set([pc[0] * pl, pc[1] * pl, pc[2] * pl, f.plasma], 44);
  d.set([L.lighting.displayLuminance, L.lighting.displayMinBrightness, L.lighting.displayFullAmbient, 1], 48);
  const windows = gm.model.windows.length;
  const polys = Math.min(MAX_CABIN_POLYS, f.sources.length);
  u[52] = polys;
  u[53] = windows;
  u[54] = gm.model.displays.length;
  u[55] = f.inside ? 1 : 0;
  d.set([0, 0, 0, 0], 56);
  const T = glassTransmittance(gm.model);
  const n = L.windows.panes.length;
  const per = T.map((x) => x ** (1 / n));
  d.set([(T[0] + T[1] + T[2]) / 3, L.windows.dust, L.windows.scratches, L.windows.ior], 60);
  d.set([per[0]!, per[1]!, per[2]!, 0], 64);
  d.set([f.camPart.x, f.camPart.y, f.camPart.z, f.inside ? 1 : 0], 68);
  const r = mat3.fromQuat(f.q);
  const toRoot = (p: Vec3): Vec3 => ({ x: r[0] * p.x + r[1] * p.y + r[2] * p.z + f.origin.x, y: r[3] * p.x + r[4] * p.y + r[5] * p.z + f.origin.y, z: r[6] * p.x + r[7] * p.y + r[8] * p.z + f.origin.z });
  const dirRoot = (p: Vec3): Vec3 => ({ x: r[0] * p.x + r[1] * p.y + r[2] * p.z, y: r[3] * p.x + r[4] * p.y + r[5] * p.z, z: r[6] * p.x + r[7] * p.y + r[8] * p.z });
  for (let k = 0; k < polys; k++) {
    const P = f.sources[k]!;
    const o = CABIN_HEADER_FLOATS + k * CABIN_POLY_FLOATS;
    const c = P.corners.map(toRoot);
    d.set([c[0]!.x, c[0]!.y, c[0]!.z, P.kind, c[1]!.x, c[1]!.y, c[1]!.z, P.index, c[2]!.x, c[2]!.y, c[2]!.z, 0, c[3]!.x, c[3]!.y, c[3]!.z, 0], o);
    const nn = dirRoot(P.normal);
    d.set([P.radiance[0], P.radiance[1], P.radiance[2], P.area, nn.x, nn.y, nn.z, P.on ? 1 : 0], o + 16);
  }
}

