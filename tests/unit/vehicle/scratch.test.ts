import { it } from 'vitest';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { boundingCylinder, checkMesh } from '@/render/vehicle/geom/validate';
import { generatePart } from '@/render/vehicle/parts';

it('scratch', async () => {
  const defs = await loadDefs(fsDefSource());
  for (const id of (process.env.PARTS ?? 'meridian-m1').split(',')) {
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
});
