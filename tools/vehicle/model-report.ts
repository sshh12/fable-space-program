/**
 * Model report: triangle counts and mesh checks per part model, and the stack totals per LOD.
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/vehicle/model-report.ts [partId ...]
 *
 * Without part ids it prints the totals of every vehicle and of every launch site; with part ids also the
 * models of those parts (triangles, materials, validity of every LOD, bounding cylinder).
 * A report for a person working on a model, not a test: the acceptance checks are tests/unit/vehicle.
 */
import { fsDefSource } from '../../src/core/defs/fsSource';
import { loadDefs } from '../../src/core/defs/loader';
import { boundingCylinder, checkMesh } from '../../src/render/vehicle/geom/validate';
import { generatePart } from '../../src/render/vehicle/parts';
import { posedTriangles } from '../../src/render/vehicle/parts/assemble';
import { generateStructure } from '../../src/render/vehicle/site';
import { assembleVessel, vesselPartSnapshots } from '../../src/sim/vessel/public';

async function main(): Promise<void> {
  const defs = await loadDefs(fsDefSource());
  for (const id of process.argv.slice(2)) {
    const def = defs.parts[id];
    if (!def) throw new Error(`no part "${id}" in the definition library`);
    const t0 = performance.now();
    const v = generatePart(defs, def);
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
  for (const site of Object.values(defs.sites)) {
    const totals = [0, 0, 0];
    const rows: string[] = [];
    for (const s of site.structures) {
      const v = generateStructure(defs, site, s.model, s.params ?? {}, s);
      const t = [0, 1, 2].map((lod) => Object.values(v.models).reduce((n, m) => n + m.lods[lod]!.indices.length / 3, 0));
      t.forEach((n, i) => (totals[i] = totals[i]! + n));
      rows.push(`  ${s.model.padEnd(30)} ${t.join(' / ')}`);
    }
    console.log(`${site.id}: ${site.structures.length} structures, triangles of all models LOD0 ${totals[0]} LOD1 ${totals[1]} LOD2 ${totals[2]}`);
    console.log(rows.join('\n'));
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
