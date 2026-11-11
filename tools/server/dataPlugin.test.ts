/** The dev-server data plugin: generated listings, isolation headers, path containment. */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fableDataPlugin, ISOLATION_HEADERS, listTilesets } from './dataPlugin';

type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
  passedOn: boolean;
}

let root: string;
let handler: Handler;
let emitted: Map<string, string>;

function write(rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** One GET through the middleware; resolves when the response ends or the request is passed on. */
function get(url: string): Promise<Reply> {
  return new Promise((resolve) => {
    const reply: Reply = { status: 0, headers: {}, body: '', passedOn: false };
    const chunks: Buffer[] = [];
    const res = {
      writeHead(status: number, headers: Record<string, string>) {
        reply.status = status;
        reply.headers = headers;
        return res;
      },
      write(chunk: Buffer | string) {
        chunks.push(Buffer.from(chunk));
        return true;
      },
      end(chunk?: Buffer | string) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk));
        reply.body = Buffer.concat(chunks).toString('utf8');
        resolve(reply);
      },
      on: () => res,
      once: () => res,
      emit: () => true,
    };
    handler({ url, method: 'GET', headers: {} } as IncomingMessage, res as unknown as ServerResponse, () => {
      reply.passedOn = true;
      resolve(reply);
    });
  });
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-data-plugin-'));
  write('data/tiles/moon/manifest.json', '{"id":"moon"}');
  write('data/tiles/earth/manifest.json', '{"id":"earth"}');
  write('data/tiles/earth/height/0/0/0/0.hgt', 'tile');
  // A bake in progress: tiles on disk, no manifest yet. Not a tile set.
  write('data/tiles/mars/height/0/0/0/0.hgt', 'tile');
  write('data/tiles/stray.json', '{}');
  write('data/defs/bodies/earth.json', '{}');
  write('data/defs/audio/mix.json', '{}');
  write('data/secret.txt', 'outside every mount');
  const plugin = fableDataPlugin(root);
  (plugin.configureServer as unknown as (server: { middlewares: { use(h: Handler): void } }) => void)({ middlewares: { use: (h) => (handler = h) } });
  emitted = new Map();
  (plugin.generateBundle as unknown as (this: { emitFile(f: { fileName: string; source: string | Uint8Array }): void }) => void).call({
    emitFile: (f) => emitted.set(f.fileName, Buffer.from(f.source).toString('utf8')),
  });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('fableDataPlugin', () => {
  it('lists the baked tile sets at /tiles/index.json: directories with a manifest, sorted (request render-core-2)', async () => {
    expect(listTilesets(path.join(root, 'data', 'tiles'))).toEqual(['earth', 'moon']);
    expect(listTilesets(path.join(root, 'data', 'nowhere'))).toEqual([]);
    const r = await get('/tiles/index.json');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ tilesets: ['earth', 'moon'] });
    expect(r.headers['Content-Type']).toContain('application/json');
    for (const [k, v] of Object.entries(ISOLATION_HEADERS)) expect(r.headers[k]).toBe(v);
    // The listing is generated per request: a tile set baked while the server runs appears.
    write('data/tiles/mars/manifest.json', '{"id":"mars"}');
    expect(JSON.parse((await get('/tiles/index.json?x=1')).body)).toEqual({ tilesets: ['earth', 'mars', 'moon'] });
    fs.rmSync(path.join(root, 'data', 'tiles', 'mars', 'manifest.json'));
  });

  it('serves tiles and manifests with isolation headers, 404 for what is not there', async () => {
    const m = await get('/tiles/earth/manifest.json');
    expect(m.status).toBe(200);
    expect(m.body).toBe('{"id":"earth"}');
    for (const [k, v] of Object.entries(ISOLATION_HEADERS)) expect(m.headers[k]).toBe(v);
    expect(m.headers['Cache-Control']).toBe('no-cache');
    const t = await get('/tiles/earth/height/0/0/0/0.hgt?v=abc');
    expect(t.status).toBe(200);
    expect(t.body).toBe('tile');
    expect(t.headers['Cache-Control']).toContain('immutable');
    expect((await get('/tiles/mars/manifest.json')).status).toBe(404);
  });

  it('lists the definitions, refuses paths outside a mount and passes other URLs on', async () => {
    expect(JSON.parse((await get('/defs/index.json')).body)).toEqual({ files: ['audio/mix.json', 'bodies/earth.json'] });
    expect((await get('/tiles/../secret.txt')).status).toBe(403);
    expect((await get('/src/main.ts')).passedOn).toBe(true);
  });

  it('the production build ships the definitions and both listings, never tiles', () => {
    expect(JSON.parse(emitted.get('tiles/index.json')!)).toEqual({ tilesets: ['earth', 'moon'] });
    expect(JSON.parse(emitted.get('defs/index.json')!)).toEqual({ files: ['audio/mix.json', 'bodies/earth.json'] });
    expect(emitted.get('defs/bodies/earth.json')).toBe('{}');
    expect([...emitted.keys()].filter((k) => k.startsWith('tiles/'))).toEqual(['tiles/index.json']);
  });
});
