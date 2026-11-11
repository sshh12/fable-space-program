/**
 * Assemble a posed part into plain geometry: the same `pose` the vessel feature uses, applied on the CPU.
 * Used by the unit tests (bounds, stack interfaces, triangle budgets) and by the lab's model report.
 */
import type { PartDef } from '@/core/contracts/defs';
import type { ModuleState } from '@/core/contracts/sim';
import type { QuatTuple, Vec3Tuple } from '@/core/math';
import { NEUTRAL_ANIM, type PartAnim, type PartVisual } from './types';

export interface PosedGeometry {
  positions: Float32Array;
  indices: Uint32Array;
}

function rotate(q: QuatTuple, x: number, y: number, z: number): Vec3Tuple {
  const tx = 2 * (q[1] * z - q[2] * y);
  const ty = 2 * (q[2] * x - q[0] * z);
  const tz = 2 * (q[0] * y - q[1] * x);
  return [x + q[3] * tx + (q[1] * tz - q[2] * ty), y + q[3] * ty + (q[2] * tx - q[0] * tz), z + q[3] * tz + (q[0] * ty - q[1] * tx)];
}

export interface PoseRequest {
  def: PartDef;
  modules: readonly ModuleState[];
  panel?: number | null;
  anim?: Partial<PartAnim>;
  /** Models to leave out (e.g. 'glass'). */
  skip?: readonly string[];
}

/** Every draw item of a posed part at one LOD, merged into one index list in the part frame. */
export function posedPart(visual: PartVisual, req: PoseRequest, lod: number): PosedGeometry {
  const chunks: { p: Float32Array; i: Uint32Array }[] = [];
  let nv = 0;
  let ni = 0;
  visual.pose({ def: req.def, modules: req.modules, panel: req.panel ?? null, anim: { ...NEUTRAL_ANIM, ...req.anim } }, (name, pos, rot) => {
    if (req.skip?.includes(name)) return;
    const model = visual.models[name];
    if (!model) throw new Error(`posedPart: part "${req.def.id}" posed an unknown model "${name}"`);
    const mesh = model.lods[Math.min(lod, model.lods.length - 1)]!;
    const src = mesh.positions;
    const p = new Float32Array(src.length);
    for (let k = 0; k < src.length; k += 3) {
      let v: Vec3Tuple = [src[k]!, src[k + 1]!, src[k + 2]!];
      if (rot) v = rotate(rot, v[0], v[1], v[2]);
      if (pos) v = [v[0] + pos[0], v[1] + pos[1], v[2] + pos[2]];
      p[k] = v[0];
      p[k + 1] = v[1];
      p[k + 2] = v[2];
    }
    const idx = new Uint32Array(mesh.indices.length);
    for (let k = 0; k < idx.length; k++) idx[k] = mesh.indices[k]! + nv;
    chunks.push({ p, i: idx });
    nv += p.length / 3;
    ni += idx.length;
  });
  const positions = new Float32Array(nv * 3);
  const indices = new Uint32Array(ni);
  let op = 0;
  let oi = 0;
  for (const c of chunks) {
    positions.set(c.p, op);
    indices.set(c.i, oi);
    op += c.p.length;
    oi += c.i.length;
  }
  return { positions, indices };
}

/** Triangles a posed part submits at one LOD. */
export function posedTriangles(visual: PartVisual, req: PoseRequest, lod: number): number {
  let n = 0;
  visual.pose({ def: req.def, modules: req.modules, panel: req.panel ?? null, anim: { ...NEUTRAL_ANIM, ...req.anim } }, (name) => {
    if (req.skip?.includes(name)) return;
    const model = visual.models[name];
    if (!model) throw new Error(`posedTriangles: part "${req.def.id}" posed an unknown model "${name}"`);
    n += model.lods[Math.min(lod, model.lods.length - 1)]!.indices.length / 3;
  });
  return n;
}

/** Move geometry from a part frame to its parent frame. */
export function transformGeometry(g: PosedGeometry, pos: Vec3Tuple, rot: QuatTuple): PosedGeometry {
  const positions = new Float32Array(g.positions.length);
  for (let k = 0; k < positions.length; k += 3) {
    const v = rotate(rot, g.positions[k]!, g.positions[k + 1]!, g.positions[k + 2]!);
    positions[k] = v[0] + pos[0];
    positions[k + 1] = v[1] + pos[1];
    positions[k + 2] = v[2] + pos[2];
  }
  return { positions, indices: g.indices };
}
