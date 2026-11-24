/**
 * Lazy per-body residency of the terrain provider (ARCHITECTURE 10.2, 10.5; MIGRATION_V2 4.1c) on the baked
 * tile sets: a provider over the staged library (27 terrain bodies) with `preload: 'launchSystems'` costs what
 * today's two-body provider costs; a lazy body is loaded by its first ensureLoaded and released after its last
 * slot; a query on a body that is not loaded answers from the datum and says so; every staged body's small
 * pyramid (2 to 6 levels) loads and answers inside its elevation range. Skipped without the baked tiles.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import { fsDefSource } from '../../../src/core/defs/fsSource';
import { loadDefs, overlayDefSource } from '../../../src/core/defs/loader';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider } from '../../../src/terrain/provider';
import { REPO_ROOT } from './helpers';

const TILES = path.join(REPO_ROOT, 'data', 'tiles');
const HAS_ALL = ['earth', 'moon', 'mars', 'phobos', 'deimos', 'titan', 'callisto'].every((id) => existsSync(path.join(TILES, id, 'manifest.json')));

let shipped: DefLibrary;
let staged: DefLibrary;

describe.skipIf(!HAS_ALL)('lazy per-body residency on the baked tile sets', () => {
  beforeAll(async () => {
    shipped = await loadDefs(fsDefSource(path.join(REPO_ROOT, 'data', 'defs')));
    staged = await loadDefs(overlayDefSource(fsDefSource(path.join(REPO_ROOT, 'data', 'defs')), fsDefSource(path.join(REPO_ROOT, 'data', 'staged'))));
  });

  it("a provider with all 27 terrain bodies ('launchSystems') costs within 10 % of today's two-body provider, time and memory", async () => {
    const terrainBodies = Object.keys(staged.bodies).filter((id) => staged.bodies[id]!.terrain !== null);
    expect(terrainBodies.length).toBe(27);
    const measure = async (defs: DefLibrary, opts: Parameters<typeof createTerrainProvider>[2]): Promise<{ ms: number; bytes: number; heap: number; loaded: string[] }> => {
      const runs: { ms: number; bytes: number; heap: number; loaded: string[] }[] = [];
      for (let i = 0; i < 3; i++) {
        const h0 = process.memoryUsage();
        const t0 = performance.now();
        const tp = await createTerrainProvider(defs, createFsTileSource(TILES), opts);
        const ms = performance.now() - t0;
        const h1 = process.memoryUsage();
        runs.push({ ms, bytes: tp.diagnostics().cache.bytes, heap: h1.heapUsed + h1.arrayBuffers - (h0.heapUsed + h0.arrayBuffers), loaded: tp.loadedBodies() });
      }
      runs.sort((a, b) => a.ms - b.ms);
      return runs[1]!;
    };
    const today = await measure(shipped, {});
    const all27 = await measure(staged, { preload: 'launchSystems' });
    if (process.env['SOLAR_SYSTEM_VERBOSE']) {
      console.log(
        `two-body provider (shipped library, default): ${today.ms.toFixed(0)} ms, cache ${(today.bytes / 1048576).toFixed(1)} MiB, heap+buffers ${(today.heap / 1048576).toFixed(1)} MiB, loaded ${today.loaded.join(', ')}\n` +
          `27-body provider (staged library, launchSystems): ${all27.ms.toFixed(0)} ms, cache ${(all27.bytes / 1048576).toFixed(1)} MiB, heap+buffers ${(all27.heap / 1048576).toFixed(1)} MiB, loaded ${all27.loaded.join(', ')}`,
      );
    }
    expect(all27.loaded).toEqual(['earth', 'moon']);
    expect(today.loaded).toEqual(['earth', 'moon']);
    expect(all27.bytes).toBeLessThanOrEqual(today.bytes * 1.1);
    expect(all27.ms).toBeLessThanOrEqual(today.ms * 1.1 + 50);
  });

  it('a lazy body is loaded by its first ensureLoaded and released after its last slot', async () => {
    const tp = await createTerrainProvider(staged, createFsTileSource(TILES), { preload: 'launchSystems' });
    const base = tp.diagnostics().cache.bytes;
    const dir = { x: 0.3, y: 0.5, z: Math.sqrt(1 - 0.34) };
    expect(tp.loadedBodies()).not.toContain('mars');
    // a query before: the datum, flagged
    expect(tp.heightAt('mars', dir, 1000)).toBe(0);
    expect(tp.residency('mars', dir)).toEqual({ residentLevel: -1, availableLevel: -1, effectiveLevel: 0, complete: false });
    expect(tp.diagnostics().unloadedQueries['mars']).toBe(2);
    await tp.ensureLoaded('mars', dir, 2000, 'vessel:a');
    expect(tp.loadedBodies()).toContain('mars');
    expect(tp.diagnostics().residency['mars']).toEqual({ state: 'loaded', holders: ['vessel:a'] });
    const h = tp.heightAt('mars', dir, 1000);
    const range = tp.elevationRange('mars');
    expect(h).toBeGreaterThanOrEqual(range.min);
    expect(h).toBeLessThanOrEqual(range.max);
    expect(tp.residency('mars', dir).complete).toBe(true);
    const loadedBytes = tp.diagnostics().cache.bytes;
    expect(loadedBytes).toBeGreaterThan(base);
    // a second slot holds it too; moving the first away keeps it
    await tp.ensureLoaded('mars', dir, 100, 'impact');
    await tp.ensureLoaded('earth', { x: 1, y: 0, z: 0 }, 100, 'vessel:a');
    expect(tp.loadedBodies()).toContain('mars');
    // the last slot let go: released, every tile of it dropped
    tp.release('impact');
    expect(tp.loadedBodies()).not.toContain('mars');
    expect(tp.diagnostics().residency['mars']!.state).toBe('unloaded');
    expect(tp.cachedTiles().some((k) => k.startsWith('mars/'))).toBe(false);
    // and loaded again by the next request: with the same tiles in, the same heights
    await tp.loadBody('mars', 'probe');
    expect(tp.residency('mars', dir).complete).toBe(false);
    await tp.ensureLoaded('mars', dir, 2000, 'probe');
    expect(tp.heightAt('mars', dir, 1000)).toBe(h);
    // preloaded bodies are never released
    tp.release('vessel:a');
    expect(tp.loadedBodies()).toContain('earth');
  });

  it("every staged body's small pyramid loads, honours its resident level and answers inside its elevation range", async () => {
    const tp = await createTerrainProvider(staged, createFsTileSource(TILES), { preload: 'launchSystems' });
    const lazyIds = tp.bodyIds.filter((id) => !tp.preloadedIds.includes(id));
    expect(lazyIds.length).toBe(25);
    for (const id of lazyIds) {
      if (!existsSync(path.join(TILES, staged.bodies[id]!.terrain!.tileset, 'manifest.json'))) continue;
      await tp.loadBody(id, 'probe');
      const range = tp.elevationRange(id);
      for (const dir of [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 0, z: 1 },
        { x: -0.6, y: 0.64, z: 0.48 },
      ]) {
        const h = tp.heightAt(id, dir, 2000);
        expect(h, id).toBeGreaterThanOrEqual(range.min);
        expect(h, id).toBeLessThanOrEqual(range.max);
        expect(tp.residency(id, dir).residentLevel, id).toBeLessThanOrEqual(staged.bodies[id]!.terrain!.residentLevel ?? 99);
      }
    }
    // one slot moved from body to body: only the last one is still held
    expect(tp.loadedBodies().filter((id) => lazyIds.includes(id))).toHaveLength(1);
  });
});
