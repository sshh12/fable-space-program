/**
 * Tile sources: manifest caching, unpromised tiles never requested, promised-but-missing tiles reject, the fs
 * source's bounded number of open files.
 */
import fsSync, { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TileManifest } from '../../../src/core/contracts/terrain';
import { createFsTileSource, MAX_OPEN_READS } from '../../../src/terrain/fsTileSource';
import { createFetchTileSource } from '../../../src/terrain/tileSource';
import { FIXTURE_VERSION } from '../../../tools/terrain-core/fixtures';
import { fixtureRoot } from './helpers';

describe('fs tile source', () => {
  it('caches the manifest, returns null for unpromised tiles and bytes for promised ones', async () => {
    const root = await fixtureRoot();
    const src = createFsTileSource(root);
    const m1 = await src.manifest('fixture-moon');
    const m2 = await src.manifest('fixture-moon');
    expect(m1).toBe(m2);
    expect(await src.tile('fixture-moon', 'height', { face: 3, level: 5, x: 0, y: 0 })).toBeNull();
    expect(await src.tile('fixture-moon', 'albedo', { face: 0, level: 0, x: 0, y: 0 })).toBeNull();
    const t = await src.tile('fixture-moon', 'height', { face: 0, level: 5, x: 16, y: 16 });
    expect(t).toBeInstanceOf(Uint8Array);
    expect(t!.byteLength).toBeGreaterThan(100);
  });

  it('queues reads: thousands of concurrent tile requests all resolve with at most MAX_OPEN_READS files open', async () => {
    const root = await fixtureRoot();
    const src = createFsTileSource(root);
    await src.manifest('fixture-moon');
    const real = fsSync.promises.readFile.bind(fsSync.promises);
    let open = 0;
    let maxOpen = 0;
    const spy = vi.spyOn(fsSync.promises, 'readFile').mockImplementation(async (...args: Parameters<typeof fsSync.promises.readFile>) => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      try {
        return await real(...args);
      } finally {
        open--;
      }
    });
    try {
      const keys = [];
      for (let k = 0; k < 4000; k++) keys.push({ face: (k % 6) as 0 | 1 | 2 | 3 | 4 | 5, level: 2, x: k % 4, y: (k >> 2) % 4 });
      const all = await Promise.all(keys.map((key) => src.tile('fixture-moon', 'height', key)));
      expect(all.every((t) => t instanceof Uint8Array && t.byteLength > 100)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(4000);
      expect(maxOpen).toBeLessThanOrEqual(MAX_OPEN_READS);
      expect(maxOpen).toBe(MAX_OPEN_READS);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a promised tile that is missing on disk (a bake bug)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terrain-core-src-'));
    try {
      const m: TileManifest = {
        formatVersion: 1,
        tileset: 'broken',
        radius: 1000,
        mapping: 'gnomonic-cube',
        layers: { height: { encoding: 'frt1-height', ext: 'hgt', globalMaxLevel: 0, coverage: {}, heightScales: [1], sources: [] } },
        globals: {},
        residentHeightLevel: 0,
        attribution: [],
        contentHash: 'x',
      };
      await fs.mkdir(path.join(root, 'broken'), { recursive: true });
      await fs.writeFile(path.join(root, 'broken', 'manifest.json'), JSON.stringify(m));
      await expect(createFsTileSource(root).tile('broken', 'height', { face: 0, level: 0, x: 0, y: 0 })).rejects.toThrow(/promises this tile/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('fetch tile source', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the manifest once, uses the canonical URL scheme with cache busting, never asks for unpromised tiles', async () => {
    const root = await fixtureRoot();
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const rel = url.replace(/^\/tiles\//, '').replace(/\?.*$/, '');
      try {
        const buf = await fs.readFile(path.join(root, rel));
        return new Response(new Uint8Array(buf), { status: 200 });
      } catch {
        return new Response('missing', { status: 404 });
      }
    });
    const src = createFetchTileSource('/tiles/');
    await src.manifest('fixture-moon');
    await src.manifest('fixture-moon');
    expect(urls.filter((u) => u.endsWith('manifest.json'))).toEqual(['/tiles/fixture-moon/manifest.json']);
    expect(await src.tile('fixture-moon', 'height', { face: 3, level: 5, x: 0, y: 0 })).toBeNull();
    expect(urls.length).toBe(1);
    const t = await src.tile('fixture-moon', 'height', { face: 0, level: 5, x: 16, y: 16 });
    expect(t!.byteLength).toBeGreaterThan(100);
    expect(urls[1]).toBe(`/tiles/fixture-moon/height/0/5/16/16.hgt?v=fixture-v${FIXTURE_VERSION}`);
  });

  it('rejects when a promised tile returns an HTTP error', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('manifest.json')) {
        const m: TileManifest = {
          formatVersion: 1,
          tileset: 't',
          radius: 1000,
          mapping: 'gnomonic-cube',
          layers: { height: { encoding: 'frt1-height', ext: 'hgt', globalMaxLevel: 0, coverage: {}, heightScales: [1], sources: [] } },
          globals: {},
          residentHeightLevel: 0,
          attribution: [],
          contentHash: '',
        };
        return new Response(JSON.stringify(m), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    });
    const src = createFetchTileSource('/tiles');
    await expect(src.tile('t', 'height', { face: 0, level: 0, x: 0, y: 0 })).rejects.toThrow(/HTTP 404/);
  });

  it('a failed manifest fetch is retried on the next call', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n++;
      return n === 1 ? new Response('down', { status: 503 }) : new Response('{"formatVersion":1}', { status: 200 });
    });
    const src = createFetchTileSource('/tiles');
    await expect(src.manifest('x')).rejects.toThrow(/503/);
    await expect(src.manifest('x')).rejects.toThrow(/mapping/);
    expect(n).toBe(2);
  });
});
