/** Shared fixtures for the cockpit unit tests: the definition library and the built Kestrel interior. */
import type { DefLibrary } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { buildCockpitModel, type CockpitModel } from '@/render/cockpit/build';

let defs: Promise<DefLibrary> | null = null;
const models = new Map<string, CockpitModel>();

export function testDefs(): Promise<DefLibrary> {
  defs ??= loadDefs(fsDefSource());
  return defs;
}

/** The interior of the cockpit layout of every vehicle that has one (built once per test file). */
export async function testModel(layoutId = 'kestrel'): Promise<CockpitModel> {
  let m = models.get(layoutId);
  if (!m) {
    m = buildCockpitModel(await testDefs(), layoutId);
    models.set(layoutId, m);
  }
  return m;
}

/** Positions of the vertices of one index range (deduplicated by vertex index). */
export function rangeVertices(model: CockpitModel, range: string): Set<number> {
  const r = model.mesh.ranges[range]!;
  const out = new Set<number>();
  for (let i = r.start; i < r.start + r.count; i++) out.add(model.mesh.indices[i]!);
  return out;
}

export function vertexPosition(model: CockpitModel, i: number): { x: number; y: number; z: number } {
  const f = new Float32Array(model.mesh.vertices, i * 48, 3);
  return { x: f[0]!, y: f[1]!, z: f[2]! };
}
