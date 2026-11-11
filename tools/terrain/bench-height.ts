/**
 * Cost of height queries around a point, as the ground cover makes them (a grid per chunk):
 *   npx tsx tools/terrain/bench-height.ts <body> <latDeg> <lonDeg>
 * Prints ms per query of the collision surface (first touch and again) and of the analytic function at
 * several band limits.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsDefSource } from '../../src/core/defs/fsSource';
import { loadDefs } from '../../src/core/defs/loader';
import { latLonToDir } from '../../src/core/geo/cubeSphere';
import { DEG, v3 } from '../../src/core/math';
import { createTerrainProvider } from '../../src/terrain';
import { createFsTileSource } from '../../src/terrain/fsTileSource';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(): Promise<void> {
  const [bodyId = 'earth', latText = '18.981197', lonText = '-155.609964'] = process.argv.slice(2);
  const defs = await loadDefs(fsDefSource(path.join(repoRoot, 'data', 'defs')));
  const provider = await createTerrainProvider(defs, createFsTileSource(path.join(repoRoot, 'data', 'tiles')), { bodies: [bodyId] });
  const R = defs.bodies[bodyId]!.radius;
  const centre = latLonToDir(Number(latText) * DEG, Number(lonText) * DEG);
  await provider.ensureLoaded(bodyId, centre, 400, 'bench');
  const east = v3.normalize(v3.cross({ x: 0, y: 0, z: 1 }, centre));
  const north = v3.cross(centre, east);
  const grid = (offset: number, step: number, n: number): ReturnType<typeof latLonToDir>[] => {
    const out = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out.push(v3.normalize(v3.add(v3.scale(centre, R), v3.add(v3.scale(east, offset + i * step), v3.scale(north, offset + j * step)))));
    return out;
  };
  const time = (label: string, dirs: ReturnType<typeof latLonToDir>[], lambda?: number): void => {
    const t0 = performance.now();
    let sum = 0;
    for (const d of dirs) sum += provider.heightAt(bodyId, d, lambda);
    const dt = performance.now() - t0;
    console.log(`${label}: ${(dt / dirs.length).toFixed(4)} ms per query (${dirs.length} queries, mean height ${(sum / dirs.length).toFixed(2)} m)`);
  };
  time('collision surface, first touch, 2 m grid', grid(-60, 2, 40));
  time('collision surface, again', grid(-60, 2, 40));
  for (const lambda of [0.5, 1, 2, 4, 8, 20]) time(`analytic, lambdaMin ${lambda} m, 2 m grid`, grid(40 + lambda, 2, 40), lambda);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
