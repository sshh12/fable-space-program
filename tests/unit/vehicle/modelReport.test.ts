/**
 * Model report (not an acceptance test): prints triangle counts and mesh checks per part model, and the
 * stack totals per LOD. Run with
 *   PARTS=atlas-9m,vela-2 npx vitest run tests/unit/vehicle/scratch.test.ts --disable-console-intercept
 * (no PARTS = the stack totals only).
 */
import { it } from 'vitest';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { boundingCylinder, checkMesh } from '@/render/vehicle/geom/validate';
import { generatePart } from '@/render/vehicle/parts';
import { posedTriangles } from '@/render/vehicle/parts/assemble';
import { assembleVessel, vesselPartSnapshots } from '@/sim/vessel/public';

it('model report', async () => {
  const defs = await loadDefs(fsDefSource());
  const ids = (process.env.PARTS ?? '').split(',').filter(Boolean);
  for (const id of ids) {
    const t0 = performance.now();
    const v = generatePart(defs, defs.parts[id]!);
    const ms = performance.now() - t0;
    for (const [name, m] of Object.entries(v.models)) {
      console.log(id, name, 'tris', m.lods.map((l) => l.indices.length / 3).join(' / '), 'materials', m.materials.map((x) => x.name).join(','), `${ms.toFixed(0)} ms`);
      m.lods.forEach((l, i) => {
        const r = checkMesh(l);
        console.log('  lod', i, JSON.stringify({ ...r, leaks: r.leaks.slice(0, 6) }), JSON.stringify(boundingCylinder([l])));
      });
    }
  }
  for (const vehicleId of Object.keys(defs.vehicles)) {
    const parts = vesselPartSnapshots(assembleVessel(defs, vehicleId));
    const totals = [0, 0, 0];
    const per = new Map<string, number[]>();
    const cache = new Map<string, ReturnType<typeof generatePart>>();
    const t0 = performance.now();
    for (const p of parts) {
      const def = defs.parts[p.def]!;
      let v = cache.get(p.def);
      if (!v) {
        v = generatePart(defs, def);
        cache.set(p.def, v);
      }
      for (let lod = 0; lod < 3; lod++) {
        const n = posedTriangles(v, { def, modules: p.modules }, lod);
        totals[lod] = totals[lod]! + n;
        const row = per.get(p.def) ?? [0, 0, 0, 0];
        row[lod] = row[lod]! + n;
        if (lod === 0) row[3] = row[3]! + 1;
        per.set(p.def, row);
      }
    }
    console.log(`${vehicleId}: ${parts.length} parts, generated in ${(performance.now() - t0).toFixed(0)} ms, triangles LOD0 ${totals[0]} LOD1 ${totals[1]} LOD2 ${totals[2]}`);
    for (const [id, r] of [...per.entries()].sort((a, b) => b[1][0]! - a[1][0]!)) console.log(`  ${id.padEnd(30)} x${r[3]}  ${r[0]} / ${r[1]} / ${r[2]}`);
  }
});
