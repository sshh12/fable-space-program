/**
 * The render-core test stand: a ground slab fixed to a body with a PBR material sweep (dielectric, metal,
 * anisotropic and clearcoat rows), shadow casters (tower, thin pole, floating bar), emissive and hot
 * objects, a translucent cloth panel, a white Lambert card and a vessel-sized cylinder. Everything is
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
  /** Extra copies of a dense sphere to reach a triangle budget (perf lab). */
  heavyTriangles?: number;
  /** Size of the slab, m. */
  slabSize?: number;
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
  triangles(): number;
}

export function createStandFeature(options: StandOptions): StandFeature {
  let ctx: RenderContext;
  let batch: MeshBatch;
  const placed: Placed[] = [];
  let vesselProbe = false;
  const upright = quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2);
  const whiteCard = { pos: [-9, 6, 0.02] as Vec3Tuple, albedo: 0.8 };

  const model = (name: string, mesh: ModelData['lods'][number], material: PbrMaterialDef): ModelHandle => coreOf(ctx).meshes.createModel({ name, lods: [mesh], materials: [material] });

  return {
    id: options.id ?? 'lab-stand',
    whiteCard,
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
      placed.push({ model: model('slab', boxMesh(size, size, 1), { name: 'slab', shading: 'terrain', baseColor: [0.32, 0.31, 0.3], roughness: 0.9, metallic: 0 }), pos: [0, 0, -0.5], rot: null });
      // White Lambert card lying on the slab.
      placed.push({ model: model('card', planeMesh(4, 4), { name: 'card', shading: 'terrain', baseColor: [whiteCard.albedo, whiteCard.albedo, whiteCard.albedo], roughness: 1, metallic: 0 }), pos: whiteCard.pos, rot: null });

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

      // Emissive objects: a lit panel (20,000 cd/m^2), a dim one (300 cd/m^2) and a hot sphere (1500 K black body).
      placed.push({ model: model('lamp', boxMesh(1.2, 0.1, 0.8), mat('lamp', [0.02, 0.02, 0.02], 0.4, 0, { emissive: [20000, 9000, 2500] })), pos: [8.5, 1, 1], rot: null });
      placed.push({ model: model('lampDim', boxMesh(1.2, 0.1, 0.8), mat('lampDim', [0.02, 0.02, 0.02], 0.4, 0, { emissive: [80, 240, 300] })), pos: [8.5, 3, 1], rot: null });
      placed.push({ model: model('hot', sphere, mat('hot', [0.05, 0.05, 0.05], 0.8, 0)), pos: [8.5, 5, 0.5], rot: null, temperature: 1500 });

      // Translucent cloth panel standing up (double sided, back-lit when the sun is behind it).
      placed.push({
        model: model('cloth', planeMesh(3, 2, 8), { name: 'cloth', shading: 'cloth', baseColor: [0.9, 0.42, 0.1], roughness: 0.8, metallic: 0, translucency: 0.6, doubleSided: true }),
        pos: [-9, 0, 1.55],
        rot: quat.fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2),
      });

      if (options.vesselSizedObject !== false) {
        placed.push({ model: model('stack', cylinderMesh(2, 40, 64), mat('stack', [0.85, 0.85, 0.86], 0.45, 0, { clearcoat: 0.3, clearcoatRoughness: 0.2 })), pos: [0, 28, 20], rot: upright });
      }

      if (options.heavyTriangles) {
        // Dense spheres (about 131k triangles each) in a block behind the sweep, to load the G-buffer and shadow passes.
        const dense = sphereMesh(0.6, 362, 181);
        const tris = dense.indices.length / 3;
        const count = Math.ceil(options.heavyTriangles / tris);
        const m = model('dense', dense, mat('dense', [0.5, 0.55, 0.6], 0.5, 0));
        const cols = Math.ceil(Math.sqrt(count));
        for (let i = 0; i < count; i++) placed.push({ model: m, pos: [(i % cols) * 1.5 - (cols - 1) * 0.75, 9 + Math.floor(i / cols) * 1.5, 0.6], rot: null });
      }
    },

    prepare(frame: FrameContext) {
      const site = sitePoseOf(options.site, frame, options.defs);
      const active = frame.vesselPose(frame.snapshot.activeVesselId);
      const vesselParent: ParentPose | null = active ? { originRelCam: active.originRelCam, q: active.q, prevOriginRelCam: active.prevOriginRelCam, prevQ: active.prevQ } : null;
      batch.begin(frame);
      for (const p of placed) {
        batch.add(p.model, instanceInFrame(site, v3.fromTuple(p.pos), p.rot, { bodyFixed: true, scale: p.scale, temperature: p.temperature }));
      }
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
