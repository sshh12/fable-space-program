/**
 * The render-core test stand: a ground slab fixed to a body with a PBR material sweep (dielectric, metal,
 * anisotropic and clearcoat rows), shadow casters (tower, thin pole, floating bar), emissive and hot
 * objects, a display, a translucent cloth panel, a white Lambert card and a vessel-sized cylinder. Everything is
 * drawn through the core mesh system, body-fixed, so it also exercises the caster rules of the cascades.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { FrameContext, ModelData, PbrMaterialDef, RenderContext, RenderFeature } from '@/core/contracts/render';
import { quat, v3, type Quat, type Vec3Tuple } from '@/core/math';
import { boxMesh, coreOf, cylinderMesh, instanceInFrame, planeMesh, sphereMesh, type MeshBatch, type ModelHandle, type ParentPose } from '@/render/core';
import { sitePoseOf, type Site } from './world';

export interface StandOptions {
  site: Site;
  defs: DefLibrary;
  /** Leave out the big cylinder (default: present). */
  vesselSizedObject?: boolean;
  /** Extra copies of a dense sphere (two LODs) to reach a triangle budget (perf lab, LOD test). */
  heavyTriangles?: number;
  /** Only the slab and the dense spheres (LOD test). */
  denseOnly?: boolean;
  /** Size of the slab, m. */
  slabSize?: number;
  /** PbrMaterialDef.shadowSoftness of the slab (m; request terrain-render-4). Default: none. */
  slabShadowSoftness?: number;
  /**
   * A 3 x 3 m bar-grating panel 2 m above the slab at (14, -10) (request vehicle-pad-4): 'cutout' with
   * `alphaCutoff` 0.5 (bars 4.7 cm wide every 37.5 cm both ways: 77 % open), 'opaque' the same without it.
   * Default: none.
   */
  grating?: 'cutout' | 'opaque';
  id?: string;
}

interface Placed {
  model: ModelHandle;
  pos: Vec3Tuple;
  rot: Quat | null;
  scale?: number | Vec3Tuple;
  temperature?: number;
  /** Parent: the site (body-fixed) or the active vessel (moving caster). */
  onVessel?: boolean;
}

const mat = (name: string, baseColor: Vec3Tuple, roughness: number, metallic: number, extra: Partial<PbrMaterialDef> = {}): PbrMaterialDef => ({
  name,
  shading: 'standard',
  baseColor,
  roughness,
  metallic,
  ...extra,
});

export interface StandFeature extends RenderFeature {
  /** Objects attached to the active vessel instead of the site (moving casters), in VES coordinates. */
  setVesselProbe(on: boolean): void;
  readonly batch: () => MeshBatch;
  /** Site-frame (ENU) centre of the white Lambert card and its albedo, for the HDR readback test. */
  readonly whiteCard: { pos: Vec3Tuple; albedo: number };
  /** Centre (site ENU) of the grating panel when there is one, and its open share. */
  readonly grating: { pos: Vec3Tuple; open: number } | null;
  /** Centres of the two 2 m textured planes: a procedural checker and the same pattern loaded from a PNG URL (8 x 8 squares of 0.25 m). */
  readonly texturedPlanes: { procedural: Vec3Tuple; url: Vec3Tuple };
  /** Centre (site ENU) of the display panel, whose 1.2 x 0.8 m faces look south and north, and its emitted luminance at brightness 1 (cd/m^2). */
  readonly display: { pos: Vec3Tuple; emissive: Vec3Tuple };
  /** MeshInstance.displayBrightness of the display panel (0..1, default 1). */
  setDisplayBrightness(brightness: number): void;
  triangles(): number;
}

export function createStandFeature(options: StandOptions): StandFeature {
  let ctx: RenderContext;
  let batch: MeshBatch;
  const placed: Placed[] = [];
  let vesselProbe = false;
  const upright = quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2);
  const whiteCard = { pos: [-9, 6, 0.02] as Vec3Tuple, albedo: 0.8 };
  const display = { pos: [8.5, -1, 1] as Vec3Tuple, emissive: [400, 400, 400] as Vec3Tuple };
  let displayIndex = -1;
  let displayBrightness = 1;
  const texturedPlanes = { procedural: [-9, -9, 0.02] as Vec3Tuple, url: [-6, -9, 0.02] as Vec3Tuple };

  const model = (name: string, mesh: ModelData['lods'][number], material: PbrMaterialDef): ModelHandle => coreOf(ctx).meshes.createModel({ name, lods: [mesh], materials: [material] });

  /**
   * Dense spheres (130,320 triangles each, with a 960-triangle second LOD that takes over below 40 px) in a
   * block behind the sweep: load for the G-buffer and shadow passes, and the subject of the LOD test.
   */
  const addDense = (triangles: number): void => {
    const dense = sphereMesh(0.6, 362, 181);
    const count = Math.ceil(triangles / (dense.indices.length / 3));
    const m = coreOf(ctx).meshes.createModel(
      { name: 'dense', lods: [dense, sphereMesh(0.6, 32, 16)], materials: [mat('dense', [0.5, 0.55, 0.6], 0.5, 0)] },
      { lodPixels: [40] },
    );
    const cols = Math.ceil(Math.sqrt(count));
    for (let i = 0; i < count; i++) placed.push({ model: m, pos: [(i % cols) * 1.5 - (cols - 1) * 0.75, 9 + Math.floor(i / cols) * 1.5, 0.6], rot: null });
  };

  return {
    id: options.id ?? 'lab-stand',
    whiteCard,
    texturedPlanes,
    display,
    grating: options.grating ? { pos: [14, -10, 2], open: (28 / 32) ** 2 } : null,
    setDisplayBrightness(b) {
      displayBrightness = b;
    },
    batch: () => batch,
    setVesselProbe(on) {
      vesselProbe = on;
    },
    triangles: () => batch.stats.triangles,

    init(c) {
      ctx = c;
      const meshes = coreOf(c).meshes;
      batch = meshes.createBatch('lab-stand');
      const size = options.slabSize ?? 80;

      // Ground slab: terrain shading (Lambert + low GGX), top face at z = 0.
      placed.push({ model: model('slab', boxMesh(size, size, 1), { name: 'slab', shading: 'terrain', baseColor: [0.32, 0.31, 0.3], roughness: 0.9, metallic: 0, ...(options.slabShadowSoftness ? { shadowSoftness: options.slabShadowSoftness } : {}) }), pos: [0, 0, -0.5], rot: null });
      if (options.denseOnly) {
        addDense(Math.max(options.heavyTriangles ?? 0, 1));
        return;
      }
      // White Lambert card lying on the slab.
      placed.push({ model: model('card', planeMesh(4, 4), { name: 'card', shading: 'terrain', baseColor: [whiteCard.albedo, whiteCard.albedo, whiteCard.albedo], roughness: 1, metallic: 0 }), pos: whiteCard.pos, rot: null });

      // Textured planes: a procedural checker registered with the mesh system, and a PNG loaded by URL
      // (public/assets/render/lab-grid.png, relative to RenderContext.assetsUrl). Both get full mip chains.
      const checker = new Uint8Array(64 * 64 * 4);
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const v = ((x >> 3) + (y >> 3)) % 2 === 0 ? 220 : 30;
          checker.set([v, v, v, 255], (y * 64 + x) * 4);
        }
      }
      meshes.registerProceduralTexture('lab-checker', { width: 64, height: 64, data: checker });
      const textured = (name: string, texture: string): PbrMaterialDef => ({ name, shading: 'terrain', baseColor: [1, 1, 1], roughness: 1, metallic: 0, textures: { baseColor: texture } });
      placed.push({ model: model('texProc', planeMesh(2, 2), textured('texProc', 'lab-checker')), pos: texturedPlanes.procedural, rot: null });
      if (options.grating) {
        // 64 x 64 texels, four tiles over the panel: bars 4 texels (4.7 cm) wide every 32 texels (37.5 cm) both ways.
        const g = new Uint8Array(64 * 64 * 4);
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) g.set([255, 255, 255, x % 32 < 4 || y % 32 < 4 ? 255 : 0], (y * 64 + x) * 4);
        meshes.registerProceduralTexture('lab-grating', { width: 64, height: 64, data: g });
        const gm: PbrMaterialDef = { name: `grating-${options.grating}`, shading: 'standard', baseColor: [0.55, 0.06, 0.04], roughness: 0.6, metallic: 0, doubleSided: true, textures: { baseColor: 'lab-grating' }, uvScale: [4, 4], ...(options.grating === 'cutout' ? { alphaCutoff: 0.5 } : {}) };
        placed.push({ model: model('grating', planeMesh(3, 3), gm), pos: [14, -10, 2], rot: null });
      }
      placed.push({ model: model('texUrl', planeMesh(2, 2), textured('texUrl', 'render/lab-grid.png')), pos: texturedPlanes.url, rot: null });

      const sphere = sphereMesh(0.5, 64, 32);
      const n = 8;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const x = (i - (n - 1) / 2) * 1.3;
        // Row 1: dielectric roughness sweep. Row 2: metal roughness sweep.
        placed.push({ model: model(`diel${i}`, sphere, mat(`diel${i}`, [0.7, 0.08, 0.06], 0.05 + 0.95 * t, 0)), pos: [x, 0, 0.5], rot: null });
        placed.push({ model: model(`metal${i}`, sphere, mat(`metal${i}`, [1.0, 0.77, 0.34], 0.05 + 0.95 * t, 1)), pos: [x, 1.6, 0.5], rot: null });
        // Row 3: anisotropic brushed metal, anisotropy -0.9 .. 0.9 along the tangent (around the sphere's Z axis).
        placed.push({ model: model(`aniso${i}`, sphere, mat(`aniso${i}`, [0.91, 0.92, 0.92], 0.35, 1, { anisotropy: -0.9 + 1.8 * t })), pos: [x, 3.2, 0.5], rot: null });
        // Row 4: clearcoat weight 0 .. 1 over a rough dark-blue base.
        placed.push({ model: model(`coat${i}`, sphere, mat(`coat${i}`, [0.03, 0.08, 0.35], 0.65, 0, { clearcoat: t, clearcoatRoughness: 0.04 })), pos: [x, 4.8, 0.5], rot: null });
      }

      // Shadow casters: tower, thin pole (contact hardening along its shadow), floating bar.
      placed.push({ model: model('tower', boxMesh(1, 1, 8), mat('tower', [0.6, 0.6, 0.62], 0.6, 0)), pos: [-7, -4, 4], rot: null });
      placed.push({ model: model('pole', cylinderMesh(0.05, 6, 16), mat('pole', [0.8, 0.8, 0.8], 0.5, 0)), pos: [-3, -5, 3], rot: upright });
      placed.push({ model: model('bar', boxMesh(4, 0.3, 0.3), mat('bar', [0.5, 0.52, 0.2], 0.7, 0)), pos: [2, -5, 3], rot: null });
      placed.push({ model: model('step', boxMesh(2, 2, 0.4), mat('step', [0.55, 0.5, 0.45], 0.8, 0)), pos: [6, -5, 0.2], rot: null });
      // Two equal boxes, one with baked occlusion 1 and one with 0 in its vertex masks (the inside of a closed
      // cabin writes 0): ambient light and planetshine reach the first only.
      const open = boxMesh(1, 1, 1);
      const closed = boxMesh(1, 1, 1);
      closed.masks = new Uint8Array((closed.positions.length / 3) * 4);
      for (let v = 0; v < closed.masks.length; v += 4) closed.masks.set([0, 0, 255, 255], v);
      placed.push({ model: model('aoOpen', open, mat('aoOpen', [0.5, 0.5, 0.5], 0.7, 0)), pos: [-12, -3, 0.5], rot: null });
      placed.push({ model: model('aoClosed', closed, mat('aoClosed', [0.5, 0.5, 0.5], 0.7, 0)), pos: [-12, -5, 0.5], rot: null });

      // Emissive objects: a lit panel (20,000 cd/m^2), a dim one (300 cd/m^2) and a hot sphere (1500 K black body).
      placed.push({ model: model('lamp', boxMesh(1.2, 0.1, 0.8), mat('lamp', [0.02, 0.02, 0.02], 0.4, 0, { emissive: [20000, 9000, 2500] })), pos: [8.5, 1, 1], rot: null });
      placed.push({ model: model('lampDim', boxMesh(1.2, 0.1, 0.8), mat('lampDim', [0.02, 0.02, 0.02], 0.4, 0, { emissive: [80, 240, 300] })), pos: [8.5, 3, 1], rot: null });
      placed.push({ model: model('hot', sphere, mat('hot', [0.05, 0.05, 0.05], 0.8, 0)), pos: [8.5, 5, 0.5], rot: null, temperature: 1500 });
      // A display (MATERIAL_ID.display): a 400 cd/m^2 emitter behind a glass front, facing south (-y) and north.
      displayIndex = placed.length;
      placed.push({
        model: model('display', boxMesh(1.2, 0.1, 0.8), { name: 'display', shading: 'display', baseColor: [0.01, 0.01, 0.012], roughness: 0.05, metallic: 0, emissive: [...display.emissive] }),
        pos: display.pos,
        rot: null,
      });

      // Translucent cloth panel standing up (double sided, back-lit when the sun is behind it).
      placed.push({
        model: model('cloth', planeMesh(3, 2, 8), { name: 'cloth', shading: 'cloth', baseColor: [0.9, 0.42, 0.1], roughness: 0.8, metallic: 0, translucency: 0.6, doubleSided: true }),
        pos: [-9, 0, 1.55],
        rot: quat.fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2),
      });

      if (options.vesselSizedObject !== false) {
        placed.push({ model: model('stack', cylinderMesh(2, 40, 64), mat('stack', [0.85, 0.85, 0.86], 0.45, 0, { clearcoat: 0.3, clearcoatRoughness: 0.2 })), pos: [0, 28, 20], rot: upright });
      }

      if (options.heavyTriangles) addDense(options.heavyTriangles);
    },

    prepare(frame: FrameContext) {
      const site = sitePoseOf(options.site, frame, options.defs);
      const active = frame.vesselPose(frame.snapshot.activeVesselId);
      const vesselParent: ParentPose | null = active ? { originRelCam: active.originRelCam, q: active.q, prevOriginRelCam: active.prevOriginRelCam, prevQ: active.prevQ } : null;
      batch.begin(frame);
      placed.forEach((p, i) => {
        batch.add(p.model, instanceInFrame(site, v3.fromTuple(p.pos), p.rot, { bodyFixed: true, scale: p.scale, temperature: p.temperature, displayBrightness: i === displayIndex ? displayBrightness : undefined }));
      });
      if (vesselProbe && vesselParent) {
        // A moving caster in the vessel frame: must only ever be drawn into every-frame cascades.
        batch.add(placed[placed.length - 1]!.model, instanceInFrame(vesselParent, { x: 0, y: 0, z: 0 }, null, { bodyFixed: false, scale: 3 }));
      }
      batch.finish();
    },
    drawGBuffer(_frame, pass) {
      batch.drawGBuffer(pass);
    },
    drawShadow(_frame, pass, cascade) {
      batch.drawShadow(pass, cascade);
    },
    isIdle: () => coreOf(ctx).meshes.isIdle(),
  };
}
