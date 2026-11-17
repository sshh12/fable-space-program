/**
 * The terrain feature's tile-source description (src/render/terrain/tileSourceSpec.ts): the default, the
 * form a worker is handed, and the list of tile sets a source can serve.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TileSourceSpec } from '@/core/contracts/terrain';
import { absoluteTileSourceSpec, fetchTileSourceSpec, listTileSets } from '@/render/terrain/tileSourceSpec';

const PAGE = 'http://127.0.0.1:5173/labs/terrain/?scene=lowOrbit';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces the global fetch by a table of answers; returns the URLs asked, in order. */
function answerFetch(answers: Record<string, { status: number; body?: unknown }>): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    const a = answers[url];
    if (!a) throw new Error(`unexpected request ${url}`);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  }) as unknown as typeof fetch;
  return asked;
}

describe('the tile-source spec of the terrain feature', () => {
  it('defaults to the plain files of the context', () => {
    expect(fetchTileSourceSpec('/tiles')).toEqual({ kind: 'fetch', baseUrl: '/tiles' });
  });

  it('is handed to a worker with absolute URLs, whatever the kind', () => {
    expect(absoluteTileSourceSpec({ kind: 'fetch', baseUrl: '/tiles' }, PAGE)).toEqual({ kind: 'fetch', baseUrl: 'http://127.0.0.1:5173/tiles' });
    expect(absoluteTileSourceSpec({ kind: 'fetch', baseUrl: 'https://cdn.example/t' }, PAGE)).toEqual({ kind: 'fetch', baseUrl: 'https://cdn.example/t' });
    const pack: TileSourceSpec = { kind: 'pack', packListUrl: '/packs.json', cache: { kind: 'opfs', maxBytes: 1 << 30 } };
    expect(absoluteTileSourceSpec(pack, PAGE)).toEqual({ kind: 'pack', packListUrl: 'http://127.0.0.1:5173/packs.json', cache: { kind: 'opfs', maxBytes: 1 << 30 } });
    expect(absoluteTileSourceSpec({ kind: 'pack', packListUrl: 'http://127.0.0.1:47100/packs.json' }, PAGE)).toEqual({ kind: 'pack', packListUrl: 'http://127.0.0.1:47100/packs.json' });
    expect(absoluteTileSourceSpec({ kind: 'fs', root: 'data/tiles' }, PAGE)).toEqual({ kind: 'fs', root: 'data/tiles' });
  });

  it('lists the baked sets of a plain-file server, and says nothing where the server has no list', async () => {
    const asked = answerFetch({ '/tiles/index.json': { status: 200, body: { tilesets: ['earth', 'moon'] } }, '/other/index.json': { status: 404 } });
    expect(await listTileSets({ kind: 'fetch', baseUrl: '/tiles' })).toEqual(['earth', 'moon']);
    expect(await listTileSets({ kind: 'fetch', baseUrl: '/other' })).toBeNull();
    expect(asked).toEqual(['/tiles/index.json', '/other/index.json']);
  });

  it('lists the sets of a pack list, and fails loudly when the list cannot be read', async () => {
    const list = { v: 1, signedDay: null, refreshAfterS: 3600, mirrors: [], sets: { earth: { index: 'a'.repeat(32), indexBytes: 10 }, sky: { index: 'b'.repeat(32), indexBytes: 20 } } };
    answerFetch({ 'http://stack/packs.json': { status: 200, body: list }, 'http://stack/gone.json': { status: 503 } });
    expect(await listTileSets({ kind: 'pack', packListUrl: 'http://stack/packs.json' })).toEqual(['earth', 'sky']);
    await expect(listTileSets({ kind: 'pack', packListUrl: 'http://stack/gone.json' })).rejects.toThrow(/pack list http:\/\/stack\/gone\.json answered HTTP 503/);
  });

  it('refuses a file-system source, which a browser cannot read', async () => {
    await expect(listTileSets({ kind: 'fs', root: 'data/tiles' })).rejects.toThrow(/"fs"/);
  });
});
