/**
 * createCockpitFeature: the capsule interior as ordinary scene geometry in the one scene, drawn wherever a
 * vessel whose vehicle names a cockpit layout carries its command part.
 *
 *  - init: builds every layout's interior, bakes its occlusion on the GPU (occlusion.ts), loads the detail
 *    textures (public/assets/cockpit, baked by tools/cockpit/bake-textures.ts);
 *  - prepare: picks the cockpit vessel, places the interior in the command part's frame (float64 ->
 *    camera-relative), selects the detail level (inside / outside near / outside far), evaluates the
 *    instruments, the cabin light sources and the crew-experience effects, uploads the uniforms;
 *  - compute: paints the MFD pages that are due (15 Hz, staggered) into 'ui.mfd', renders the cabin's sun
 *    map (sunmap.ts), the per-frame ambient pass and the cabin probe (probe.ts: the lit cabin as a cube map
 *    for reflections and bounce light);
 *  - drawShadow: the interior is a MOVING caster in every-frame cascades only (cascade 0 is vessel-anchored
 *    in cockpit view), drawn with its window openings closed: the cockpit lights its cabin itself;
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
import { buildCockpitModel, displayVertices, meshBvh, meshPositions, sunRange, type CockpitModel, type LodName } from './build';
import { ATLAS_HEIGHT, ATLAS_WIDTH, seatFrames } from './cabin/context';
import { createCockpitControls, type CockpitControlsImpl } from './controls';
import { MfdDisplays } from './displays';
import { controlStates, instrumentSource, updateMemory, type ControlState, type InstrumentMemory } from './instruments';
import { cockpitLayouts, DETAIL_KINDS, MAX_WINDOWS } from './layout';
import { CabinProbe, PROBE_DEPTH_FORMAT, PROBE_FORMAT } from './probe';
import { cabinSources, coveredWindows, floodLuminance, glassTransmittance, MAX_CABIN_POLYS, type CabinPoly } from './lighting';
import { VERTEX_STRIDE } from './mesh';
import { insideDistance, mouldOf } from './mould';
import { bakeOcclusion, OCC_STRIDE, occlusionAt, occlusionSources, type VertexOcclusion } from './occlusion';
import {
  AMBIENT_SCENE_BINDING,
  AMBIENT_VEC4S,
  AMBIENT_WGSL,
  BALL_WGSL,
  CABIN,
  CABIN_CHUNK,
  CABIN_DECLS,
  CABIN_HEADER_FLOATS,
  CABIN_POLY_FLOATS,
  CABIN_SCENE_BINDING,
  CABIN_UNIFORM_FLOATS,
  CONTROL_FLOATS,
  DISPLAY_WGSL,
  GLASS_WGSL,
  INTERIOR_DECAL_ENTRY,
  INTERIOR_DEPTH_ENTRY,
  INTERIOR_WGSL,
  MATERIAL_FLOATS,
  MAX_MATERIALS,
  PROBE_SCALE,
  PROBE_WINDOW_WGSL,
  SHADOW_WGSL,
  TUNNEL_WGSL,
} from './shaders';
import { boundingRadius, CabinSunMap, sunMapLayout, sunTileUniform, type SunMapLayout } from './sunmap';

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
  /** Whether that vessel is the active one (else lamps and readouts that only the HUD's values carry are dark). */
  vesselActive: boolean;
  lod: LodName | null;
  inside: boolean;
  triangles: number;
  shadowTriangles: number;
  polys: number;
  patches: number;
  /** Whether the sun reaches the cabin this frame (the cabin sun map was rendered). */
  sunLit: boolean;
  /** Windows another part of the vessel covers this frame (they let nothing in). */
  covered: string[];
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
  /** The baked occlusion stream of a layout (tests read it back). */
  occlusion(layout: string): GPUBuffer | undefined;
  /**
   * Diagnostic view of the interior (0 = the picture): 1 material ids, 2 the sun through the window
   * apertures, 3 that times the cabin sun map, 4 probe reflection, 5 direct light of the polygon sources,
   * 6 bounce light, 7 sunlight, 8 emission, 9 face normals, 10 baked ambient occlusion, 11 albedo.
   */
  setDebugView(view: number): void;
}

interface GpuModel {
  model: CockpitModel;
  vertex: GPUBuffer;
  index: GPUBuffer;
  occlusion: GPUBuffer;
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
  /** The window openings as the cabin probe draws them (pane layout; the pane index is the window's). */
  probeWindows: GPUBuffer;
  probeWindowCount: number;
  group: GPUBindGroup | null;
  /** The same group with a black cube in the probe's place: bound while the probe itself is rendered. */
  probeGroup: GPUBindGroup | null;
  /** The probe's coefficient pass writing into the ambient buffer. */
  shGroup: GPUBindGroup | null;
  /** The probe's centre (part frame) and the cabin's parallax proxy (CabinFrame.proxy). */
  probeCentre: Vec3;
  proxy: [number, number, number, number];
  groupVersion: number;
  /** The ambient pass's group (cabin uniform, displays, output, scene sets) and its resource version. */
  ambientGroup: GPUBindGroup | null;
  ambientVersion: number;
  shadowGroup: GPUBindGroup;
  sunGroup: GPUBindGroup;
  /** Sphere the cabin sun map covers (part frame). */
  sunCentre: Vec3;
  sunRadius: number;
  /** Occlusion record at the front of the attitude ball, and the windows' apertures (4 vec4 each). */
  ballOcc: Float32Array;
  apertures: Float32Array;
  cabinData: Float32Array<ArrayBuffer>;
  controlData: Float32Array<ArrayBuffer>;
  prevControls: ControlState[] | null;
  memory: InstrumentMemory;
}

/** The detail texture arrays and their layers (public/assets/cockpit/detail.json). */
interface DetailTextures {
  n: GPUTexture;
  m: GPUTexture;
  layers: Record<string, { index: number; tile: number }>;
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
  let decals: Tracked<GPURenderPipeline>;
  let shadow: Tracked<GPURenderPipeline>;
  let display: Tracked<GPURenderPipeline>;
  let ballPipe: Tracked<GPURenderPipeline>;
  let glassMul: Tracked<GPURenderPipeline>;
  let glassAdd: Tracked<GPURenderPipeline>;
  let tunnelPipe: Tracked<GPURenderPipeline>;
  let tunnelBuffer: GPUBuffer;
  let tunnelGroup: GPUBindGroup;
  let sunMap: CabinSunMap;
  let probe: CabinProbe;
  let interiorProbe: Tracked<GPURenderPipeline>;
  let displayProbe: Tracked<GPURenderPipeline>;
  let windowProbe: Tracked<GPURenderPipeline>;
  let lastProbeModel: GpuModel | null = null;
  let detail: DetailTextures;
  let displays: MfdDisplays | null = null;
  let navballVersion = -1;

  // Per-frame state.
  let active: { gm: GpuModel; lod: LodName; vessel: VesselSnapshot; interiorView: boolean; centre: Vec3; sun: SunMapLayout | null } | null = null;
  let clock = 0;
  let gFiltered = 1;
  let tunnel = 0;
  let prevVib: Vec3 = v3.zero();
  let lastLod: LodName | null = null;
  let lastStates: ControlState[] = [];
  let debugView = 0;
  const st: CockpitFrameStats = { active: false, layout: null, vesselId: null, vesselActive: false, lod: null, inside: false, triangles: 0, shadowTriangles: 0, polys: 0, patches: 0, sunLit: false, covered: [], tunnel: 0, vibration: 0, displayBrightness: 0, prepareMs: 0 };

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
    occlusion: (id) => models.get(id)?.occlusion,
    stats: () => ({ ...st }),
    controlStates: () => lastStates,
    setDebugView(view) {
      debugView = view;
    },

    async init(c) {
      ctx = c;
      const device = c.device;
      const core = coreOf(c);
      core.shaders.register('cockpit_cabin', CABIN_CHUNK);
      scene = createSceneBindings(c, 1, CABIN_SCENE_BINDING, ['env', 'atmosphereLuts', 'transparency']);
      ambientScene = createSceneBindings(c, 1, AMBIENT_SCENE_BINDING, ['env', 'atmosphereLuts', 'cloudShadow']);
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
          { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
          { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
          { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
          { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
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
      const vtx = (attrs: [number, GPUVertexFormat, number][], stride: number): GPUVertexBufferLayout => ({ arrayStride: stride, attributes: attrs.map(([shaderLocation, format, offset]) => ({ shaderLocation, format, offset })) });
      const interiorLayout: GPUVertexBufferLayout[] = [
        vtx(
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
        ),
        // The baked occlusion stream (occlusion.ts): six records of four bytes.
        vtx(
          [
            [7, 'unorm8x4', 0],
            [8, 'unorm8x4', 4],
            [9, 'unorm8x4', 8],
            [10, 'unorm8x4', 12],
            [11, 'unorm8x4', 16],
            [12, 'unorm8x4', 20],
          ],
          OCC_STRIDE,
        ),
      ];
      // Label decals blend into RT0 and RT5 by their ink (alpha), keeping the face's alpha (AO) and the other targets.
      const decalBlend: GPUBlendState = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
      const decalTargets = gbufferTargets.map((t, i): GPUColorTargetState => (i === 0 || i === 5 ? { ...t, blend: decalBlend } : { ...t, writeMask: 0 }));
      const gpipe = (label: string, code: string, buffers: GPUVertexBufferLayout[], pass: 'single' | 'depth' | 'shade' | 'decal' = 'single'): Tracked<GPURenderPipeline> =>
        core.shaders.tracked(() => {
          const module = c.shaders.createModule(label, code);
          return device.createRenderPipeline({
            label,
            layout: plLayout,
            // The depth pre-pass reads positions and controls only.
            vertex: pass === 'depth' ? { module, entryPoint: 'vsDepth', buffers: [vtx([[0, 'float32x3', 0], [6, 'uint16x2', 44]], VERTEX_STRIDE)] } : { module, entryPoint: 'vs', buffers },
            fragment:
              pass === 'depth'
                ? { module, entryPoint: INTERIOR_DEPTH_ENTRY, targets: gbufferTargets.map((x) => ({ ...x, writeMask: 0 })) }
                : pass === 'decal'
                  ? { module, entryPoint: INTERIOR_DECAL_ENTRY, targets: decalTargets }
                  : { module, entryPoint: 'fs', targets: gbufferTargets },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            // The interior is drawn twice: depth first, then shaded where its depth won (no overdraw shading);
            // the labels last, over their faces (lifted off them), without writing depth.
            depthStencil:
              pass === 'shade'
                ? { ...gbufferDepth, depthWriteEnabled: false, depthCompare: 'equal' }
                : pass === 'decal'
                  ? { ...gbufferDepth, depthWriteEnabled: false, depthCompare: 'greater-equal' }
                  : gbufferDepth,
          });
        });
      interiorDepth = gpipe('cockpit.interiorDepth', INTERIOR_WGSL(decls), interiorLayout, 'depth');
      interior = gpipe('cockpit.interior', INTERIOR_WGSL(decls), interiorLayout, 'shade');
      decals = gpipe('cockpit.labels', INTERIOR_WGSL(decls), interiorLayout, 'decal');
      display = gpipe('cockpit.display', DISPLAY_WGSL(decls), [vtx([[0, 'float32x3', 0], [1, 'float32x3', 12], [2, 'float32x2', 24], [3, 'float32', 32]], 36)]);
      ballPipe = gpipe('cockpit.ball', BALL_WGSL(decls), [vtx([[0, 'float32x3', 0], [1, 'float32x3', 12], [2, 'float32x2', 24]], 32)]);
      shadow = core.shaders.tracked(() => {
        const module = c.shaders.createModule('cockpit.shadow', SHADOW_WGSL);
        return device.createRenderPipeline({
          label: 'cockpit.shadow',
          layout: device.createPipelineLayout({ label: 'cockpit.shadow', bindGroupLayouts: [c.frameBindGroupLayout, core.shadowPassLayout, shadowLayout] }),
          vertex: { module, entryPoint: 'vs', buffers: [vtx([[0, 'float32x3', 0], [6, 'uint16x2', 44]], VERTEX_STRIDE)] },
          primitive: { topology: 'triangle-list', cullMode: 'none', unclippedDepth: true },
          depthStencil: { format: RENDER_FORMATS.shadow, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
        });
      });
      const glassBuffers = [vtx([[0, 'float32x3', 0], [1, 'float32x3', 12], [2, 'float32x2', 24], [3, 'float32x2', 32]], PANE_FLOATS * 4)];
      // The cabin probe: the interior, the displays and the window openings into one face of the cube.
      probe = new CabinProbe(device, Math.max(32, ...layoutIds.map((id) => cockpitLayouts(defs)[id]!.transport.probeSize)), (label, code) => c.shaders.createModule(label, code), (desc) => core.createTextureChecked(desc));
      const probeLayout = device.createPipelineLayout({ label: 'cockpit.probe', bindGroupLayouts: [c.frameBindGroupLayout, layout, probe.faceLayout] });
      const probePipe = (label: string, code: string, vertexEntry: string, fragmentEntry: string, buffers: GPUVertexBufferLayout[]): Tracked<GPURenderPipeline> =>
        core.shaders.tracked(() => {
          const module = c.shaders.createModule(label, code);
          return device.createRenderPipeline({
            label,
            layout: probeLayout,
            vertex: { module, entryPoint: vertexEntry, buffers },
            fragment: { module, entryPoint: fragmentEntry, targets: [{ format: PROBE_FORMAT }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: PROBE_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
          });
        });
      interiorProbe = probePipe('cockpit.probe.interior', INTERIOR_WGSL(decls), 'vsProbe', 'fsProbe', interiorLayout);
      displayProbe = probePipe('cockpit.probe.display', DISPLAY_WGSL(decls), 'vsProbe', 'fsProbe', [vtx([[0, 'float32x3', 0], [1, 'float32x3', 12], [2, 'float32x2', 24], [3, 'float32', 32]], 36)]);
      windowProbe = probePipe('cockpit.probe.window', PROBE_WINDOW_WGSL(decls), 'vs', 'fs', [vtx([[0, 'float32x3', 0], [3, 'float32x2', 32]], PANE_FLOATS * 4)]);
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
      const all = layoutIds.map((id) => cockpitLayouts(defs)[id]!);
      if (first) {
        displays = new MfdDisplays(device, Math.max(1, ...all.map((l) => l.console.displays.length)), first.displays.width, first.displays.height, first.displays.rateHz, opts.mfdPainter, defs, c.perf);
        c.resources.publish('ui.mfd', displays.view);
        controls.onChange((d) => displays?.markDirty(d));
      }
      if (c.resources.version('ui.navball') === 0) c.resources.publish('ui.navball', opts.navball.view);
      sunMap = new CabinSunMap(device, Math.max(256, ...all.map((l) => l.transport.sunMapSize)), (label, code) => c.shaders.createModule(label, code), (desc) => core.createTextureChecked(desc));
      detail = await loadDetailTextures(c);
      for (const id of layoutIds) models.set(id, uploadModel(c, buildCockpitModel(defs, id), detail, sunMap));
      // Compile now so that shader errors surface before the first frame.
      ambientPipe.get();
      interiorDepth.get();
      interior.get();
      decals.get();
      display.get();
      ballPipe.get();
      shadow.get();
      glassMul.get();
      glassAdd.get();
      tunnelPipe.get();
      interiorProbe.get();
      displayProbe.get();
      windowProbe.get();
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
      const src = instrumentSource(frame.snapshot, vessel);
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
        const bf = exp.vibration.buffet;
        const buffet = 1 + bf.peak * Math.exp(-(((vessel.aero.mach - bf.mach) / bf.width) ** 2));
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
      // The g the crew of THIS vessel feels: the HUD's value when it is the active vessel.
      const g = src.active ? frame.snapshot.readouts.gLoad : vessel.gLoad;
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
      updateMemory(gm.memory, frame.snapshot, vessel.id);
      const seats = new Map(seatFrames(model.mould).map((s) => [s.id, { R: s.R, U: s.U, L: s.L }]));
      const states = controlStates(model.controls, src, defs, model.layout.alarms, clock, gm.memory, (id) => seats.get(id)!, (i) => floodLuminance(model, i));
      writeControls(ctx, gm, states);
      lastStates = states;

      // ---- cabin light
      const vesselPos = v3.add(vessel.rRoot, quat.rotate(vessel.q, part.localPos));
      const sunVis = frame.sun.illuminance > 0 ? sunVisibilityAt(vesselPos, frame.snapshot, defs) : 0;
      const sunPart = quat.rotateInv(q, frame.sun.dirRoot);
      const lightsOn = src.active && frame.snapshot.readouts.lightsOn;
      // Windows another part of this vessel covers (the boost cover on the pad): they let nothing in.
      const covered = coveredWindows(
        model.windows.map((w) => w.id),
        vessel.parts.filter((x) => x.instanceId !== part.instanceId).map((x) => x.def),
        defs as unknown as Parameters<typeof coveredWindows>[2],
      );
      st.covered = model.windows.filter((_, i) => covered[i]).map((w) => w.id);
      const sources = cabinSources(model, sunVis > 0 ? { dirPart: sunPart, illuminance: frame.sun.illuminance * sunVis, color: frame.sun.color } : null, lightsOn, covered);
      st.polys = sources.polys.length;
      st.patches = sources.polys.filter((x) => x.kind === 1).length;
      // The sun reaches the cabin when it shines and some open window faces it: then the cabin's sun map is drawn.
      const sun = sunVis > 0 ? sunMapLayout(sunPart, model.windows.map((w) => w.aperture), gm.sunCentre, gm.sunRadius, covered) : null;
      const sunLit = sun !== null;
      st.sunLit = sunLit;
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
        sunPart,
        sunAngularRadius: frame.sun.angularRadius,
        sunIllum: frame.sun.illuminance * sunVis,
        sunColor: frame.sun.color,
        sun,
        sunMapSize: sunMap.size,
        sunTileUv: sun ? sunMap.tileUv(sun.perSide) : 1,
        bodyIndex,
        rBody,
        mu,
        sunFlux: sources.sunFlux,
        lampFlux: sources.lampFlux,
        plasma: vessel.aero.plasmaIntensity,
        time: clock,
        camPart,
        inside,
        debugView,
        covered,
      });
      ctx.device.queue.writeBuffer(gm.cabin, 0, gm.cabinData);
      if (tunnel > 0.001) ctx.device.queue.writeBuffer(tunnelBuffer, 0, new Float32Array([tunnel, frame.displaySize[0] / frame.displaySize[1], tn.maxDarken, 0]));

      // ---- the lit cabin seen from outside: its light spills through the panes onto the window wells and the
      // hull around them (a local light in each well; the cabin itself is lit by the cockpit's own shader).
      if (!inside && lightsOn && sources.lampFlux > 0) {
        const rho = model.layout.lighting.cabinAlbedo;
        const area = model.layout.lighting.cabinArea;
        // Mean cabin luminance under the lamps (integrating sphere), and what a pane sends outward.
        const cabinL = ((sources.lampFlux / area) * (1 + rho / (1 - rho)) * rho) / Math.PI;
        const T = glassTransmittance(model);
        const tint = model.floods[0]?.color ?? [1, 1, 1];
        const r = mat3.fromQuat(q);
        for (const w of model.windows) {
          if (frame.lights.length >= 16) break;
          const p = v3.addScaled(w.centre, w.inward, -model.mould.wallThickness * 0.45);
          const I = cabinL * w.area;
          frame.lights.push({
            kind: 'point',
            posRelCam: { x: r[0] * p.x + r[1] * p.y + r[2] * p.z + origin.x, y: r[3] * p.x + r[4] * p.y + r[5] * p.z + origin.y, z: r[6] * p.x + r[7] * p.y + r[8] * p.z + origin.z },
            intensity: [I * T[0] * tint[0], I * T[1] * tint[1], I * T[2] * tint[2]],
            range: 0.7,
          });
        }
      }

      // ---- bind group (rebuilt when a shared resource is re-published)
      const nv = ctx.resources.version('ui.navball');
      const ver = scene.version() + nv * 7919 + ctx.resources.version('ui.mfd') * 104729;
      if (!gm.group || gm.groupVersion !== ver || nv !== navballVersion) {
        navballVersion = nv;
        gm.groupVersion = ver;
        const cabinGroup = (cube: GPUTextureView): GPUBindGroup =>
          ctx.device.createBindGroup({
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
              { binding: 7, resource: sunMap.view },
              { binding: 8, resource: detail.n.createView({ dimension: '2d-array' }) },
              { binding: 9, resource: detail.m.createView({ dimension: '2d-array' }) },
              { binding: 10, resource: cube },
              ...scene.entries(),
            ],
          });
        gm.group = cabinGroup(probe.view);
        gm.probeGroup = cabinGroup(probe.blackView);
      }
      gm.shGroup ??= probe.shGroup(ambientBuf);
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
      active = { gm, lod, vessel, interiorView, centre, sun };
      st.active = true;
      st.layout = model.layoutId;
      st.vesselId = vessel.id;
      st.vesselActive = src.active;
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
      const gm = active.gm;
      if (active.sun) {
        // The cabin's sun map: the interior's occluders at the drawn detail level (not the enclosure), into
        // the tile of every window the sun enters.
        const ranges = [gm.model.mesh.ranges[sunRange(active.lod)]!];
        sunMap.render(encoder, active.sun, gm.sunGroup, gm.vertex, gm.index, ranges, ctx.perf.gpuPass('cockpit.sunMap') as GPURenderPassTimestampWrites | undefined);
      }
      // After the display mips: the ambient pass reads their means.
      const ts = ctx.perf.gpuPass('cockpit.ambient') as GPUComputePassTimestampWrites | undefined;
      const pass = encoder.beginComputePass({ label: 'cockpit.ambient', ...(ts ? { timestampWrites: ts } : {}) });
      pass.setPipeline(ambientPipe.get());
      pass.setBindGroup(0, frame.frameBindGroup);
      pass.setBindGroup(1, gm.ambientGroup!);
      pass.dispatchWorkgroups(1);
      pass.end();
      // The cabin probe, after the sources of this frame are known: the reduced detail level from the
      // cabin's centre (the far level when that is what is drawn).
      if (gm.probeGroup && gm.shGroup) {
        if (lastProbeModel !== gm) probe.reset();
        lastProbeModel = gm;
        const range = gm.model.mesh.ranges[active.lod === 'lod0' ? 'lod1' : active.lod]!;
        probe.render(encoder, {
          frameGroup: frame.frameBindGroup,
          cabinGroup: gm.probeGroup,
          centre: gm.probeCentre,
          shGroup: gm.shGroup,
          timestamps: { render: ctx.perf.gpuPass('cockpit.probe') as GPURenderPassTimestampWrites | undefined, filter: ctx.perf.gpuPass('cockpit.probeFilter') as GPUComputePassTimestampWrites | undefined },
          draw: (p) => {
            p.setPipeline(interiorProbe.get());
            p.setVertexBuffer(0, gm.vertex);
            p.setVertexBuffer(1, gm.occlusion);
            p.setIndexBuffer(gm.index, 'uint32');
            p.drawIndexed(range.count, 1, range.start);
            p.setPipeline(displayProbe.get());
            p.setVertexBuffer(0, gm.display);
            p.draw(gm.displayCount);
            p.setPipeline(windowProbe.get());
            p.setVertexBuffer(0, gm.probeWindows);
            p.draw(gm.probeWindowCount);
          },
        });
      }
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
      // The closed shell (the far detail level with its window openings plugged): nothing of the core's sun
      // enters the cabin, whose light is the cockpit's own; exterior receivers see a solid capsule.
      pass.setPipeline(shadow.get());
      pass.setBindGroup(2, gm.shadowGroup);
      pass.setVertexBuffer(0, gm.vertex);
      pass.setIndexBuffer(gm.index, 'uint32');
      for (const range of [gm.model.mesh.ranges.lod2!, gm.model.mesh.ranges.plugs!]) {
        pass.drawIndexed(range.count, 1, range.start);
        st.shadowTriangles += range.count / 3;
      }
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
      pass.setVertexBuffer(1, gm.occlusion);
      pass.setPipeline(interior.get());
      pass.drawIndexed(range.count, 1, range.start);
      const labels = gm.model.mesh.ranges.labels!;
      if (active.lod === 'lod0' && labels.count > 0) {
        pass.setPipeline(decals.get());
        pass.drawIndexed(labels.count, 1, labels.start);
      }
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
        for (const b of [gm.vertex, gm.index, gm.occlusion, gm.display, gm.ball, gm.glass, gm.probeWindows, gm.cabin, gm.controls, gm.materials]) b.destroy();
        gm.atlas.destroy();
      }
      displays?.dispose();
      sunMap?.dispose();
      probe?.dispose();
      detail?.n.destroy();
      detail?.m.destroy();
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

/** The detail texture arrays (two vertical strips of square layers) and their manifest. */
async function loadDetailTextures(ctx: RenderContext): Promise<DetailTextures> {
  const core = coreOf(ctx);
  const base = `${ctx.assetsUrl}/cockpit`;
  const fetchOk = async (url: string): Promise<Response> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cockpit: ${url}: HTTP ${res.status}`);
    return res;
  };
  const manifest = (await (await fetchOk(`${base}/detail.json`)).json()) as { size: number; layers: { name: string; tile: number }[] };
  const load = async (file: string): Promise<GPUTexture> => {
    const bitmap = await createImageBitmap(await (await fetchOk(`${base}/${file}`)).blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const S = manifest.size;
    if (bitmap.width !== S || bitmap.height !== S * manifest.layers.length) throw new Error(`cockpit: ${file} is ${bitmap.width} x ${bitmap.height}, expected ${S} x ${S * manifest.layers.length}`);
    const tex = core.createTextureChecked({
      label: `cockpit.${file}`,
      format: 'rgba8unorm',
      size: [S, S, manifest.layers.length],
      mipLevelCount: mipCount(S, S),
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    for (let k = 0; k < manifest.layers.length; k++) {
      ctx.device.queue.copyExternalImageToTexture({ source: bitmap, origin: [0, k * S] }, { texture: tex, origin: [0, 0, k], premultipliedAlpha: false }, [S, S]);
    }
    bitmap.close();
    core.mips.generate(tex);
    return tex;
  };
  const [n, m] = await Promise.all([load('detail-n.png'), load('detail-m.png')]);
  const layers: DetailTextures['layers'] = {};
  manifest.layers.forEach((l, index) => (layers[l.name] = { index, tile: l.tile }));
  return { n, m, layers };
}

/** Pack an occlusion record as the shader's occUnpack reads it (four vec4). */
function packOcclusion(o: VertexOcclusion): Float32Array {
  const w = (i: number): number => o.windows[i] ?? 0;
  const d = (i: number): number => o.displays[i] ?? 0;
  const f = (i: number): number => o.floods[i] ?? 0;
  return new Float32Array([o.ao, o.flood, w(0), w(1), w(2), w(3), w(4), w(5), w(6), w(7), d(0), d(1), d(2), d(3), 0, 0, f(0), f(1), f(2), f(3), f(4), f(5), f(6), f(7)]);
}

function uploadModel(ctx: RenderContext, model: CockpitModel, detail: DetailTextures, sunMap: CabinSunMap): GpuModel {
  const device = ctx.device;
  const core = coreOf(ctx);
  const id = model.layoutId;
  const mesh = model.mesh;
  // STORAGE: the occlusion bake reads the vertices.
  const vertex = buffer(device, `cockpit.${id}.vertices`, new Uint8Array(mesh.vertices), GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
  const index = buffer(device, `cockpit.${id}.indices`, mesh.indices as Uint32Array<ArrayBuffer>, GPUBufferUsage.INDEX);
  const positions = meshPositions(mesh);
  const occlusion = bakeOcclusion(device, model, vertex, { lod0: model.bvh, lod1: meshBvh(mesh, 'lod1', positions), lod2: meshBvh(mesh, 'lod2', positions) }, (label, code) => ctx.shaders.createModule(label, code));

  // Display screens: two triangles each, uv (0,0) top-left.
  const dv = displayVertices(model);
  const display = buffer(device, `cockpit.${id}.displays`, dv, GPUBufferUsage.VERTEX);

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
  const sources = occlusionSources(model);
  const ballOcc = packOcclusion(occlusionAt(model, model.bvh, sources, v3.addScaled(nb.frame.o, nb.frame.n, R + 0.003), nb.frame.n, 0));

  // Glass: every window pane, the display cover glasses and the attitude indicator's cover glass.
  const gv: number[] = [];
  const panes: { first: number; count: number; centre: Vec3 }[] = [];
  // Last vertex attribute: (window index + 1 on a window's cabin-side pane, else 0; reflectance relative to
  // bare glass): 1 for the windows and the attitude indicator, the coated cover glass's for the displays.
  const fan = (out: number[], centre: Vec3, outline: Vec3[], n: Vec3, ux: Vec3, uy: Vec3, index: number, reflectance: number): void => {
    const uvOf = (p: Vec3): [number, number] => [v3.dot(v3.sub(p, centre), ux), v3.dot(v3.sub(p, centre), uy)];
    for (let i = 0; i < outline.length; i++) {
      for (const p of [centre, outline[i]!, outline[(i + 1) % outline.length]!]) {
        const [u, w] = uvOf(p);
        out.push(p.x, p.y, p.z, n.x, n.y, n.z, u, w, index, reflectance);
      }
    }
  };
  const pushPane = (centre: Vec3, outline: Vec3[], n: Vec3, ux: Vec3, uy: Vec3, reflectance = 1, tag = 0): void => {
    const firstV = gv.length / PANE_FLOATS;
    fan(gv, centre, outline, n, ux, uy, tag, reflectance);
    panes.push({ first: firstV, count: gv.length / PANE_FLOATS - firstV, centre });
  };
  // The window openings for the cabin probe: each window's cabin-side pane, tagged with the window's index.
  const pw: number[] = [];
  model.windows.forEach((w, wi) => {
    w.panes.forEach((pane, k) => {
      const centre = pane.outline.reduce((s, p) => v3.add(s, v3.scale(p, 1 / pane.outline.length)), v3.zero());
      pushPane(centre, pane.outline, pane.frame.n, pane.frame.x, pane.frame.y, 1, k === w.panes.length - 1 ? wi + 1 : 0);
      if (k === w.panes.length - 1) fan(pw, centre, pane.outline, pane.frame.n, pane.frame.x, pane.frame.y, wi, 1);
    });
  });
  const probeWindows = buffer(device, `cockpit.${id}.probeWindows`, new Float32Array(pw), GPUBufferUsage.VERTEX);
  for (const d of model.displays) {
    const f = d.frame;
    const c = v3.addScaled(f.o, f.n, 0.0025);
    const hw = d.width / 2 + 0.002;
    const hh = d.height / 2 + 0.002;
    const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([a, b]) => v3.add(c, v3.add(v3.scale(f.x, a!), v3.scale(f.y, b!))));
    pushPane(c, pts, f.n, f.x, f.y, model.layout.windows.coverGlass.reflectance);
  }
  {
    const f = nb.frame;
    // A domed cover glass (a cap of a sphere over the window): its image of the cabin slides and stretches
    // as the eye moves, which a flat pane's does not.
    const c = v3.addScaled(f.o, f.n, R + 0.004);
    const rim = R * 1.12;
    const Rc = rim * 3.2;
    const zRim = Math.sqrt(Rc * Rc - rim * rim);
    const rings = 5;
    const segs = 36;
    const vert = (k: number, i: number): number[] => {
      const r = (rim * k) / rings;
      const a = (i / segs) * 2 * Math.PI;
      const z = Math.sqrt(Rc * Rc - r * r);
      const radial = v3.add(v3.scale(f.x, Math.cos(a)), v3.scale(f.y, Math.sin(a)));
      const p = v3.add(c, v3.add(v3.scale(radial, r), v3.scale(f.n, z - zRim)));
      const n = v3.normalize(v3.add(v3.scale(radial, r), v3.scale(f.n, z)));
      return [p.x, p.y, p.z, n.x, n.y, n.z, Math.cos(a) * r, Math.sin(a) * r, 0, 0.95];
    };
    const firstV = gv.length / PANE_FLOATS;
    for (let k = 0; k < rings; k++) {
      for (let i = 0; i < segs; i++) {
        gv.push(...vert(k, i), ...vert(k + 1, i), ...vert(k + 1, i + 1));
        if (k > 0) gv.push(...vert(k, i), ...vert(k + 1, i + 1), ...vert(k, i + 1));
      }
    }
    panes.push({ first: firstV, count: gv.length / PANE_FLOATS - firstV, centre: c });
  }
  const glass = buffer(device, `cockpit.${id}.glass`, new Float32Array(gv), GPUBufferUsage.VERTEX);

  // Materials (MATERIAL_FLOATS each; Material in CABIN_CHUNK).
  const mats = new Float32Array(MAX_MATERIALS * MATERIAL_FLOATS);
  model.materialNames.forEach((name, i) => {
    const m = model.layout.materials[name]!;
    const kind = m.detail && m.detail !== 'none' ? DETAIL_KINDS[m.detail] : null;
    const layer = kind ? detail.layers[kind.layer] : undefined;
    if (kind && !layer) throw new Error(`cockpit ${id}: material "${name}": no detail layer "${kind.layer}" in public/assets/cockpit/detail.json`);
    const wear = m.wear ?? { amount: 0, albedo: m.albedo, metallic: m.metallic ?? 0 };
    mats.set(
      [
        m.albedo[0], m.albedo[1], m.albedo[2], m.roughness,
        m.metallic ?? 0, m.shading === 'cloth' ? 1 : 0, m.anisotropy ?? 0, m.clearcoat ?? 0,
        kind?.pattern ?? 0, m.detailStrength ?? 1, m.translucency ?? 0, layer ? layer.index + 1 : 0,
        layer?.tile ?? 1, wear.amount, m.grime ?? 0, m.variation ?? 0,
        wear.albedo[0], wear.albedo[1], wear.albedo[2], wear.metallic,
      ],
      i * MATERIAL_FLOATS,
    );
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
      { binding: 0, resource: { buffer: cabin, offset: 0, size: (CABIN.probe + 1) * 16 } },
      { binding: 1, resource: { buffer: controls } },
    ],
  });

  // The windows' apertures for the sun (WindowMeta.aperture): four vec4 per window.
  const apertures = new Float32Array(16 * MAX_WINDOWS);
  model.windows.forEach((w, i) => {
    const a = w.aperture;
    apertures.set([a.centre.x, a.centre.y, a.centre.z, a.hw, a.inward.x, a.inward.y, a.inward.z, a.hh, a.t.x, a.t.y, a.t.z, a.rc, a.g.x, a.g.y, a.g.z, a.innerDepth], i * 16);
  });
  const b = mesh.bounds;
  const sunCentre = v3.scale(v3.add(b.min, b.max), 0.5);
  // The probe sits in the open middle of the cabin: between the crew's heads and the console.
  const seats = seatFrames(model.mould);
  const probeCentre = seats.reduce((s, x) => v3.add(s, v3.scale(v3.addScaled(x.eye, x.L, 0.28), 1 / seats.length)), v3.zero());
  // Its parallax proxy: the inner cone (radius = a - b y) between the floor and the tunnel joint.
  const mo = mouldOf(model.mould);
  const yTop = mo.tunnelJoinY - 1e-3;
  const slope = (mo.innerRadius(mo.floorY) - mo.innerRadius(yTop)) / (yTop - mo.floorY);
  const proxy: [number, number, number, number] = [mo.innerRadius(mo.floorY) + slope * mo.floorY, slope, mo.floorY, mo.tunnelJoinY];
  return {
    model,
    vertex,
    index,
    occlusion,
    display,
    displayCount: dv.length / 9,
    ball,
    ballCount: bv.length / 8,
    glass,
    panes,
    probeWindows,
    probeWindowCount: pw.length / PANE_FLOATS,
    probeGroup: null,
    shGroup: null,
    probeCentre,
    proxy,
    cabin,
    controls,
    materials,
    atlas,
    group: null,
    groupVersion: -1,
    ambientGroup: null,
    ambientVersion: -1,
    shadowGroup,
    sunGroup: sunMap.group(controls),
    sunCentre,
    sunRadius: boundingRadius(mesh.vertices, mesh.vertexCount, sunCentre) + model.layout.transport.sunMapMargin,
    ballOcc,
    apertures,
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
  sunPart: Vec3;
  sunAngularRadius: number;
  sunIllum: number;
  sunColor: [number, number, number];
  /** The cabin sun map's transform this frame (null: the sun does not reach the cabin). */
  sun: SunMapLayout | null;
  sunMapSize: number;
  /** Size of one tile of the sun map in atlas uv. */
  sunTileUv: number;
  bodyIndex: number;
  rBody: number;
  mu: number;
  sunFlux: number;
  lampFlux: number;
  plasma: number;
  time: number;
  camPart: Vec3;
  inside: boolean;
  debugView: number;
  /** Per window: covered by another part of the vessel (lets nothing in). */
  covered: readonly boolean[];
}

function writeCabin(gm: GpuModel, f: CabinFrameInput): void {
  const d = gm.cabinData;
  const u = new Uint32Array(d.buffer);
  const L = gm.model.layout;
  const at = (slot: number, values: ArrayLike<number>): void => d.set(values, slot * 4);
  const rows = (q: Quat, o: Vec3, slot: number): void => {
    const r = mat3.fromQuat(q);
    at(slot, [r[0], r[1], r[2], o.x, r[3], r[4], r[5], o.y, r[6], r[7], r[8], o.z]);
  };
  rows(f.q, f.origin, CABIN.m);
  rows(f.prevQ, f.prevOrigin, CABIN.q);
  at(CABIN.sun, [f.sunDirRoot.x, f.sunDirRoot.y, f.sunDirRoot.z, f.sunIllum]);
  at(CABIN.sunColor, [f.sunColor[0], f.sunColor[1], f.sunColor[2], f.bodyIndex]);
  at(CABIN.atmo, [f.rBody, f.mu, L.lighting.fdaiLighting, f.sunAngularRadius]);
  const rho = L.lighting.cabinAlbedo;
  at(CABIN.bounce, [rho / (L.lighting.cabinArea * (1 - rho)), rho * f.sunFlux, f.lampFlux, rho]);
  const lc = L.lighting.legendColor;
  at(CABIN.legend, [lc[0] * L.lighting.legendLuminance, lc[1] * L.lighting.legendLuminance, lc[2] * L.lighting.legendLuminance, f.time]);
  const pl = L.lighting.plasmaLuminance * Math.max(0, f.plasma) ** 1.5;
  // The shock layer's glow wanders between the layout's lavender-pink and a salmon (the air's nitrogen and
  // oxygen lines against the ablator's sodium and carbon).
  const salmon = 0.35 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 1.7 * f.time));
  const pc = [L.lighting.plasmaColor[0] * (1 - salmon) + 1.0 * salmon, L.lighting.plasmaColor[1] * (1 - salmon) + 0.5 * salmon, L.lighting.plasmaColor[2] * (1 - salmon) + 0.4 * salmon];
  at(CABIN.plasma, [pc[0]! * pl, pc[1]! * pl, pc[2]! * pl, f.plasma]);
  at(CABIN.display, [L.lighting.displayLuminance, L.lighting.displayMinBrightness, L.lighting.displayFullAmbient, L.displays.pixelStructure[0]]);
  const windows = gm.model.windows.length;
  const polys = Math.min(MAX_CABIN_POLYS, f.sources.length);
  u.set([polys, windows, gm.model.displays.length, f.inside ? 1 : 0], CABIN.counts * 4);
  d.fill(0, CABIN.sunTiles * 4, (CABIN.sunTiles + 3 * MAX_WINDOWS) * 4);
  if (f.sun) {
    at(CABIN.sunL, f.sun.l);
    at(CABIN.sunMap, [f.sunTileUv, f.sun.range, f.sunMapSize, 1]);
    for (const t of f.sun.tiles) at(CABIN.sunTiles + 3 * t.window, sunTileUniform(t, f.sunTileUv));
  } else at(CABIN.sunMap, [1, 1, f.sunMapSize, 0]);
  at(CABIN.probe, [gm.probeCentre.x, gm.probeCentre.y, gm.probeCentre.z, 1 / PROBE_SCALE]);
  at(CABIN.proxy, gm.proxy);
  at(CABIN.sunPart, [f.sunPart.x, f.sunPart.y, f.sunPart.z, 2 * Math.tan(f.sunAngularRadius)]);
  const T = glassTransmittance(gm.model);
  const n = L.windows.panes.length;
  const per = T.map((x) => x ** (1 / n));
  at(CABIN.misc, [(T[0] + T[1] + T[2]) / 3, L.windows.dust, L.windows.scratches, L.windows.ior]);
  at(CABIN.tint, [per[0]!, per[1]!, per[2]!, 0]);
  at(CABIN.view, [f.camPart.x, f.camPart.y, f.camPart.z, f.inside ? 1 : 0]);
  at(CABIN.glare, [L.windows.coverGlass.reflectance, L.windows.coverGlass.roughness, L.displays.pixelStructure[1], f.debugView]);
  at(CABIN.ballOcc, gm.ballOcc);
  at(CABIN.glassSun, [T[0], T[1], T[2], n]);
  at(CABIN.apertures, gm.apertures);
  // A covered window's aperture is shut (half height 0: the shaders skip it).
  f.covered.forEach((c, i) => {
    if (c) d[CABIN.apertures * 4 + 16 * i + 7] = 0;
  });
  const r = mat3.fromQuat(f.q);
  const toRoot = (p: Vec3): Vec3 => ({ x: r[0] * p.x + r[1] * p.y + r[2] * p.z + f.origin.x, y: r[3] * p.x + r[4] * p.y + r[5] * p.z + f.origin.y, z: r[6] * p.x + r[7] * p.y + r[8] * p.z + f.origin.z });
  const dirRoot = (p: Vec3): Vec3 => ({ x: r[0] * p.x + r[1] * p.y + r[2] * p.z, y: r[3] * p.x + r[4] * p.y + r[5] * p.z, z: r[6] * p.x + r[7] * p.y + r[8] * p.z });
  for (let k = 0; k < polys; k++) {
    const P = f.sources[k]!;
    const o = CABIN_HEADER_FLOATS + k * CABIN_POLY_FLOATS;
    const c = P.corners.map(toRoot);
    // A window's share of the entry plasma: the shock layer streams and flickers (a few to some fifteen
    // hertz), each window sees its own part of it.
    const t = f.time;
    // A window's well: its depth (outer mould line to the bezel's inner edge) over the opening's mean width.
    const ap = P.kind === 0 ? gm.model.windows[P.index]?.aperture : undefined;
    const wellRatio = ap ? ap.innerDepth / Math.sqrt(4 * ap.hw * ap.hh) : 0;
    const share = P.kind === 0 ? 0.62 + 0.14 * Math.sin(2 * Math.PI * 4.1 * t + 0.6 * k) + 0.14 * Math.sin(2 * Math.PI * 7.3 * t + 1.7 * k) + 0.1 * Math.sin(2 * Math.PI * 11.9 * t + 2.9 * k) : 0;
    d.set([c[0]!.x, c[0]!.y, c[0]!.z, P.kind, c[1]!.x, c[1]!.y, c[1]!.z, P.index, c[2]!.x, c[2]!.y, c[2]!.z, share, c[3]!.x, c[3]!.y, c[3]!.z, wellRatio], o);
    const nn = dirRoot(P.normal);
    d.set([P.radiance[0], P.radiance[1], P.radiance[2], P.area, nn.x, nn.y, nn.z, P.on ? 1 : 0], o + 16);
  }
}
