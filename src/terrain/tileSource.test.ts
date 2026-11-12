/**
 * createTileSource(spec): one constructor for every kind of TileSourceSpec (ARCHITECTURE 10.2). The fs and
 * fetch kinds are the existing sources unchanged; the pack kind is packSource.ts (tested in
 * tests/unit/platform/packs.test.ts on every mode).
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syntheticTileRoot } from '../../tools/terrain-core/fixtures';
import { packSet } from '../../tools/pack/packer';
import { localPackList } from '../../tools/pack/localPacks';
import { createFsTileSource } from './fsTileSource';
import { createTileSource } from './tileSource';
import { createTileSource as createNodeTileSource } from './tileSource.node';

let root: string;
let packs: string;
let server: http.Server;
let base: string;

beforeAll(async () => {
  root = await syntheticTileRoot();
  packs = fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-ts-'));
  await packSet({ dir: path.join(root, 'fixture-moon'), set: 'fixture-moon', type: 'tiles', out: packs });
  // A plain HTTP server: /tiles/** from the tile root (the fetch kind), /packs.json and /p/<hash> from the packs.
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/packs.json') {
      const list = localPackList(packs);
      list.mirrors = [{ id: 'local', mode: 'ranges', base: '/p/' }];
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(list));
      return;
    }
    const m = /^\/p\/([0-9a-f]{32})$/.exec(url.pathname);
    if (m) {
      const file = fs.readdirSync(path.join(packs, 'fixture-moon')).find((f) => f.startsWith(m[1]!));
      const buf = fs.readFileSync(path.join(packs, 'fixture-moon', file!));
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
      if (!r) res.writeHead(200).end(buf);
      else res.writeHead(206).end(buf.subarray(Number(r[1]), Number(r[2]) + 1));
      return;
    }
    if (url.pathname.startsWith('/tiles/')) {
      const f = path.join(root, decodeURIComponent(url.pathname.slice('/tiles/'.length)));
      if (fs.existsSync(f)) res.writeHead(200).end(fs.readFileSync(f));
      else res.writeHead(404).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(packs, { recursive: true, force: true });
});

const KEY = { face: 0 as const, level: 2, x: 1, y: 2 };

describe('createTileSource', () => {
  it('fetch, pack and (in Node) fs give the same bytes', async () => {
    const want = await createFsTileSource(root).tile('fixture-moon', 'height', KEY);
    const sources = [
      createTileSource({ kind: 'fetch', baseUrl: `${base}/tiles` }),
      createTileSource({ kind: 'pack', packListUrl: `${base}/packs.json` }),
      createNodeTileSource({ kind: 'fs', root }),
      createNodeTileSource({ kind: 'pack', packListUrl: `${base}/packs.json` }),
    ];
    for (const s of sources) {
      const got = await s.tile('fixture-moon', 'height', KEY);
      expect(Buffer.from(got!).equals(Buffer.from(want!))).toBe(true);
      expect((await s.manifest('fixture-moon')).contentHash).toBe((await createFsTileSource(root).manifest('fixture-moon')).contentHash);
    }
  });

  it('the browser-safe module refuses the fs kind and names the Node module', () => {
    expect(() => createTileSource({ kind: 'fs', root })).toThrow(/tileSource\.node\.ts/);
  });

  it('a pack spec that asks for the OPFS cache fails every read where there is no OPFS (no silent fallback)', async () => {
    const s = createTileSource({ kind: 'pack', packListUrl: `${base}/packs.json`, cache: { kind: 'opfs', maxBytes: 1e8 } });
    await expect(s.tile('fixture-moon', 'height', KEY)).rejects.toThrow(/origin-private file system is not available/);
  });

  it('a tile the manifest does not promise resolves null without a request', async () => {
    const s = createTileSource({ kind: 'pack', packListUrl: `${base}/packs.json` });
    expect(await s.tile('fixture-moon', 'height', { face: 3, level: 9, x: 0, y: 0 })).toBeNull();
    expect(await s.tile('fixture-moon', 'no-such-layer', KEY)).toBeNull();
  });
});
