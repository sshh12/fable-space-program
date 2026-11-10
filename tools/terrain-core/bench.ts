/**
 * Timing benchmark of the height authority (single thread):
 *   npx tsx tools/terrain-core/bench.ts            synthetic fixture tile sets
 *   npx tsx tools/terrain-core/bench.ts --real     data/tiles (moon and earth, when baked)
 * Reports the acceptance timings: analytic heightAt at lambdaMin 100 m (budget 3 us), cached collision
 * query (0.5 us), first collision query in a fresh area (0.2 ms), bakeGeometry + bakeNormalMaterial per tile
 * (12 ms). Numbers measured while other processes load the machine are provisional (PACKAGE_RULES 16).
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DefLibrary } from '../../src/core/contracts/defs';
import { dirToTile, latLonToDir, tileUvToDir } from '../../src/core/geo/cubeSphere';
import { Prng } from '../../src/core/math/hash';
import { DEG } from '../../src/core/math/scalar';
import type { Vec3 } from '../../src/core/math/vec3';
import { fsDefSource } from '../../src/core/defs/fsSource';
import { loadDefs } from '../../src/core/defs/loader';
import { createFsTileSource } from '../../src/terrain/fsTileSource';
import { createTerrainProvider, type TerrainAuthority } from '../../src/terrain/provider';
import { FIXTURE_POINTS, fixtureDefs, syntheticTileRoot } from './fixtures';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const real = process.argv.includes('--real');

function stats(xs: number[]): { median: number; p99: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)]!, p99: s[Math.floor(s.length * 0.99)]!, max: s[s.length - 1]! };
}

async function benchBody(tp: TerrainAuthority, body: string, centre: Vec3, R: number, label: string): Promise<void> {
  const rng = new Prng(42);
  await tp.ensureLoaded(body, centre, 3000, 'bench');
  const pts: Vec3[] = [];
  for (let i = 0; i < 20000; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(0, 2500) / R;
    const e = { x: -centre.y, y: centre.x, z: 0 };
    const l = Math.hypot(e.x, e.y) || 1;
    const ex = { x: e.x / l, y: e.y / l, z: 0 };
    const ey = { x: centre.y * ex.z - centre.z * ex.y, y: centre.z * ex.x - centre.x * ex.z, z: centre.x * ex.y - centre.y * ex.x };
    const x = centre.x + (Math.cos(a) * ex.x + Math.sin(a) * ey.x) * d;
    const y = centre.y + (Math.cos(a) * ex.y + Math.sin(a) * ey.y) * d;
    const z = centre.z + (Math.cos(a) * ex.z + Math.sin(a) * ey.z) * d;
    const m = Math.hypot(x, y, z);
    pts.push({ x: x / m, y: y / m, z: z / m });
  }
  // Analytic at lambdaMin 100 m.
  for (let r = 0; r < 2; r++) for (const p of pts) tp.heightAt(body, p, 100);
  let t0 = performance.now();
  let acc = 0;
  for (let r = 0; r < 5; r++) for (const p of pts) acc += tp.heightAt(body, p, 100);
  const analytic = ((performance.now() - t0) * 1000) / (5 * pts.length);
  // First collision queries in fresh areas (each point of a fresh grid far apart), after a warm-up.
  const fresh: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const p = pts[i]!;
    const q = performance.now();
    acc += tp.heightAt(body, p);
    const dt = performance.now() - q;
    if (i >= 200) fresh.push(dt * 1000);
  }
  // Cached collision queries around one point.
  const near: Vec3[] = [];
  for (let i = 0; i < 4096; i++) {
    const p = pts[i % 64]!;
    near.push(p);
  }
  for (const p of near) acc += tp.heightAt(body, p);
  t0 = performance.now();
  for (let r = 0; r < 50; r++) for (const p of near) acc += tp.heightAt(body, p);
  const cached = ((performance.now() - t0) * 1000) / (50 * near.length);
  // Bakes at several levels around the centre.
  const bakeRows: string[] = [];
  const maxLevel = body === 'moon' ? 18 : 20;
  for (const level of [6, 10, 13, 16, maxLevel]) {
    const key = dirToTile(centre, level).key;
    await tp.prepareTile(body, key);
    tp.bakeGeometry(body, key);
    tp.bakeNormalMaterial(body, key);
    const tg: number[] = [];
    const tn: number[] = [];
    const tb: number[] = [];
    for (let r = 0; r < 5; r++) {
      let q = performance.now();
      tp.bakeGeometry(body, key);
      tg.push(performance.now() - q);
      q = performance.now();
      tp.bakeNormalMaterial(body, key);
      tn.push(performance.now() - q);
      q = performance.now();
      tp.bakeTile(body, key);
      tb.push(performance.now() - q);
    }
    const g = stats(tg).median;
    const n = stats(tn).median;
    const b = stats(tb).median;
    bakeRows.push(`    L${level}: geometry ${g.toFixed(2)} ms + normalMaterial ${n.toFixed(2)} ms = ${(g + n).toFixed(2)} ms; bakeTile ${b.toFixed(2)} ms`);
  }
  const f = stats(fresh);
  console.log(`${label} (${body})`);
  console.log(`  analytic heightAt(lambdaMin = 100 m): ${analytic.toFixed(3)} us/query (budget 3 us)`);
  console.log(`  cached collision query: ${cached.toFixed(3)} us/query (budget 0.5 us)`);
  console.log(`  first collision query in a fresh area: median ${f.median.toFixed(1)} us, p99 ${f.p99.toFixed(1)} us, max ${f.max.toFixed(1)} us (budget 200 us)`);
  console.log('  bakes (median of 5, single thread):');
  for (const r of bakeRows) console.log(r);
  if (acc === 42) console.log('');
}

async function main(): Promise<void> {
  const load = os.loadavg();
  console.log(`machine: ${os.cpus()[0]?.model} x${os.cpus().length}, node ${process.version}, loadavg ${load.map((x) => x.toFixed(2)).join(' ')}`);
  if (real) {
    const root = path.join(repo, 'data/tiles');
    const defs: DefLibrary = await loadDefs(fsDefSource(path.join(repo, 'data/defs')));
    const bodies = ['moon', 'earth'].filter((b) => existsSync(path.join(root, defs.bodies[b]!.terrain!.tileset, 'manifest.json')));
    const tp = await createTerrainProvider(defs, createFsTileSource(root), { bodies });
    if (bodies.includes('moon')) await benchBody(tp, 'moon', latLonToDir(0.674 * DEG, 23.473 * DEG), defs.bodies['moon']!.radius, 'real Moon, Tranquility');
    if (bodies.includes('earth')) {
      const s = Object.values(defs.sites).find((x) => x.bodyId === 'earth')!;
      await benchBody(tp, 'earth', latLonToDir(s.location.latDeg * DEG, s.location.lonDeg * DEG), defs.bodies['earth']!.radius, `real Earth, ${s.id}`);
    }
    return;
  }
  const root = await syntheticTileRoot();
  const tp = await createTerrainProvider(await fixtureDefs(repo), createFsTileSource(root));
  await benchBody(tp, 'moon', FIXTURE_POINTS.moonGlobal, 1737400, 'fixture Moon, global-only area');
  await benchBody(tp, 'moon', FIXTURE_POINTS.moonDeep, 1737400, 'fixture Moon, deepest region');
  await benchBody(tp, 'earth', tileUvToDir(dirToTile(FIXTURE_POINTS.padDir, 5).key, 0.2, 0.7), 6371000, 'fixture Earth, regional land');
}

await main();
