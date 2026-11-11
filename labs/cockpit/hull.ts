/**
 * Lab-only exterior stand-in for the capsule (the vehicle-pad package draws the real exterior; a lab may
 * not import it): the outer mould line with the window wells cut through the wall at the shared openings
 * and the hatch closed except for its window, painted plain white, drawn through the core mesh system as
 * a moving caster. It exists so that the chase-camera view looks into the cabin through a real opening and
 * so that the sun reaches the cabin only through the windows, exactly as it will with the real exterior.
 */
import type { CapsuleMouldLineDef } from '@/core/contracts/defs';
import type { MeshData, ModelData, RenderContext, RenderFeature } from '@/core/contracts/render';
import { quat, v3, type Vec3 } from '@/core/math';
import { coreOf, instanceInFrame, type MeshBatch, type ModelHandle } from '@/render/core';
import { CabinContext } from '@/render/cockpit/cabin/context';
import { coneWall, openingRegions, outerSurface } from '@/render/cockpit/cabin/shell';
import { conePointAt, openingsOf } from '@/render/cockpit/mould';
import { VERTEX_STRIDE } from '@/render/cockpit/mesh';
import type { CockpitLayoutDef } from '@/render/cockpit/layout';

function toMeshData(ctx: CabinContext): MeshData {
  const built = ctx.b.build();
  const n = built.vertexCount;
  const f32 = new Float32Array(built.vertices);
  const i16 = new Int16Array(built.vertices);
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const tangents = new Float32Array(n * 4);
  const uvs = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const o = (i * VERTEX_STRIDE) / 4;
    const o2 = (i * VERTEX_STRIDE) / 2;
    positions.set([f32[o]!, f32[o + 1]!, f32[o + 2]!], i * 3);
    normals.set([i16[o2 + 6]! / 32767, i16[o2 + 7]! / 32767, i16[o2 + 8]! / 32767], i * 3);
    tangents.set([i16[o2 + 10]! / 32767, i16[o2 + 11]! / 32767, i16[o2 + 12]! / 32767, i16[o2 + 13]! >= 0 ? 1 : -1], i * 4);
    uvs.set([f32[o + 7]!, f32[o + 8]!], i * 2);
  }
  return { positions, normals, tangents, uvs, indices: built.indices, groups: [{ material: 0, start: 0, count: built.indices.length }], bounds: { min: [built.bounds.min.x, built.bounds.min.y, built.bounds.min.z], max: [built.bounds.max.x, built.bounds.max.y, built.bounds.max.z] } };
}

export function buildLabHull(layout: CockpitLayoutDef, mould: CapsuleMouldLineDef): ModelData {
  const ctx = new CabinContext(layout, mould);
  const m = ctx.mould;
  const attr = ctx.m('closeout');
  const surface = outerSurface(ctx);
  const regions = openingRegions(ctx, 64, surface, ['window', 'hatchWindow']);
  coneWall(ctx, { surface, regions, y0: 0, y1: mould.cone.yTop, attr, nAz: 144, nY: 24, rings: 4, outward: true });
  // Heat shield: the spherical cap of the profile, and the apex tunnel.
  const shield = mould.profile.filter(([, y]) => y <= 0).map(([r, y]): [number, number] => [r, y]);
  ctx.b.lathe({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, shield, 96, ctx.m('bezel'));
  ctx.b.cylinder({ x: 0, y: mould.apexTunnel.yBottom, z: 0 }, { x: 0, y: 1, z: 0 }, mould.apexTunnel.radius, mould.apexTunnel.yTop - mould.apexTunnel.yBottom, 64, attr, { caps: 'top' });
  // Window wells: the opening carried straight through the wall along its normal.
  for (const o of openingsOf(m).filter((x) => x.kind !== 'hatch')) {
    const outline = o.outline(64);
    const outer = outline.map(([u, v]) => conePointAt(m, o.azDeg, o.y, u, v, 0));
    const inner = outline.map(([u, v]) => conePointAt(m, o.azDeg, o.y, u, v, m.wall));
    const base = ctx.b.vertexCount;
    const c = outer.reduce((s, p) => v3.add(s, v3.scale(p, 1 / outer.length)), v3.zero());
    for (let i = 0; i <= outline.length; i++) {
      const k = i % outline.length;
      const nIn = v3.normalize(v3.sub(c, outer[k]!));
      ctx.b.vertex(outer[k]!, nIn, v3.sub(inner[k]!, outer[k]!), [i * 0.01, 0], ctx.m('bezel'));
      ctx.b.vertex(inner[k]!, nIn, v3.sub(inner[k]!, outer[k]!), [i * 0.01, m.wall], ctx.m('bezel'));
    }
    for (let i = 0; i < outline.length; i++) ctx.b.quad(base + i * 2, base + i * 2 + 2, base + i * 2 + 3, base + i * 2 + 1);
  }
  return { name: 'lab-hull', lods: [toMeshData(ctx)], materials: [{ name: 'backshell', shading: 'standard', baseColor: [0.72, 0.73, 0.72], metallic: 0, roughness: 0.55 }] };
}

/** Draws the stand-in hull on the command part of the cockpit vessel. */
export function createLabHullFeature(model: () => ModelData, partId: string): RenderFeature {
  let batch: MeshBatch;
  let handle: ModelHandle;
  return {
    id: 'lab-hull',
    init(c: RenderContext) {
      const core = coreOf(c);
      batch = core.meshes.createBatch('lab-hull');
      handle = core.meshes.createModel(model());
    },
    prepare(frame) {
      batch.begin(frame);
      const s = frame.snapshot;
      const v = s.vessels.find((x) => x.id === s.activeVesselId);
      const pose = v ? frame.vesselPose(v.id) : undefined;
      const part = v?.parts.find((p) => p.instanceId === partId);
      if (pose && part) batch.add(handle, instanceInFrame(pose, part.localPos as Vec3, part.localRot ?? quat.identity(), { bodyFixed: false }));
      batch.finish();
    },
    drawGBuffer(_f, pass) {
      batch.drawGBuffer(pass);
    },
    drawShadow(_f, pass, cascade) {
      batch.drawShadow(pass, cascade);
    },
  };
}
