/**
 * Site ground report: the real terrain height under every structure of every launch site, relative to the
 * pad plane, from the baked tiles (data/tiles) through the terrain provider.
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/vehicle/site-ground.ts [radial]
 *
 * Prints, per structure, the terrain height at its origin and the lowest / highest terrain inside its
 * footprint radius; with `radial` also the terrain profile along eight bearings out to the blend radius.
 * A report for a person placing structures (how deep a skirt must go, where a slab would stand proud); the
 * acceptance check of the same quantity is tests/unit/vehicle/site.test.ts.
 */
import path from 'node:path';
import { fsDefSource } from '../../src/core/defs/fsSource';
import { loadDefs } from '../../src/core/defs/loader';
import { latLonToDir } from '../../src/core/geo/cubeSphere';
import { v3 } from '../../src/core/math';
import { createFsTileSource } from '../../src/terrain/fsTileSource';
import { createTerrainProvider } from '../../src/terrain/provider';

const DEG = Math.PI / 180;

async function main(): Promise<void> {
  const defs = await loadDefs(fsDefSource());
  const terrain = await createTerrainProvider(defs, createFsTileSource(path.resolve('data/tiles')));
  const radial = process.argv.includes('radial');
  for (const site of Object.values(defs.sites)) {
    const body = defs.bodies[site.bodyId]!;
    const up = latLonToDir(site.location.latDeg * DEG, site.location.lonDeg * DEG);
    let east = v3.cross({ x: 0, y: 0, z: 1 }, up);
    east = v3.normalize(east);
    const north = v3.cross(up, east);
    await terrain.ensureLoaded(site.bodyId, up, site.pad.blendRadius + 200, 'site-ground');
    const pad = typeof site.location.padElevation === 'number' ? site.location.padElevation : terrain.heightAt(site.bodyId, up);
    const R = body.radius + pad;
    /** Terrain height above the pad's tangent plane at an east / north offset, m. */
    const above = (e: number, n: number): number => {
      const p = v3.add(v3.scale(up, R), v3.add(v3.scale(east, e), v3.scale(north, n)));
      const dir = v3.normalize(p);
      const h = terrain.heightAt(site.bodyId, dir);
      // Height of the terrain point over the tangent plane (the curvature drop is part of what a structure sees).
      return v3.dot(v3.scale(dir, body.radius + h), up) - R;
    };
    console.log(`site ${site.id}: pad elevation ${pad.toFixed(2)} m, terrain at the centre ${terrain.heightAt(site.bodyId, up).toFixed(2)} m, flat ${site.pad.flatRadius} m, blend ${site.pad.blendRadius} m`);
    if (radial) {
      for (let b = 0; b < 360; b += 45) {
        const row: string[] = [];
        for (const d of [50, 100, 140, 160, 200, 250, 300, 350, 400, 450, 500, 600, 750, 900]) row.push(`${d}:${above(Math.sin(b * DEG) * d, Math.cos(b * DEG) * d).toFixed(2)}`);
        console.log(`  bearing ${String(b).padStart(3)}  ${row.join('  ')}`);
      }
    }
    for (const s of site.structures) {
      const [e, n, u] = s.offsetEnu;
      const p = (s.params ?? {}) as Record<string, unknown>;
      const reach = Math.max(Number(p['radius'] ?? 0), Number(p['length'] ?? 0) / 2, Number(p['width'] ?? 0) / 2, Number(p['size'] ?? 0) / 2, 5);
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * 2 * Math.PI;
        for (const f of [0.5, 1]) {
          const h = above(e + Math.cos(a) * reach * f, n + Math.sin(a) * reach * f);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
      }
      console.log(`  ${s.model.padEnd(20)} at E ${e.toFixed(0).padStart(5)} N ${n.toFixed(0).padStart(5)} y ${u.toFixed(2).padStart(6)}  terrain ${above(e, n).toFixed(2).padStart(7)}  within ${reach.toFixed(0).padStart(4)} m: ${lo.toFixed(2)} .. ${hi.toFixed(2)}`);
    }
  }
}

await main();
