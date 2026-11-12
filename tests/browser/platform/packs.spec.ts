/**
 * The pack source in real Chrome against the local stack (platform-delivery acceptance; ARCHITECTURE 10.4):
 * a cross-origin-isolated page reads tiles through the pack source on the main thread and in a worker (CORS,
 * COEP, no dependence on Content-Range), hits the OPFS cache on reload, fails over to the mirror on 429, on a
 * 404 for an indexed object and, after one refresh of the pack list, on a 403; and a terrain hash at fixed
 * points through the pack source equals the terrain guard. Runs INSIDE the stack (page=dev serves the lab):
 *
 *   STACK_NAME=fsp-platform-delivery npm run stack -- -- node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/platform/packs.spec.ts --project=functional
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StackState } from '../../../deploy/local/launcher';
import { directionsOf, HEIGHTS_FILE, type GuardHeights } from '../../unit/terrain-core/terrain-guard';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, test } from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STATE = process.env.STACK_STATE;
test.skip(!STATE, 'runs inside the local stack: npm run stack -- -- ... playwright test tests/browser/platform');
test.describe.configure({ mode: 'serial' });
test.setTimeout(5 * 60_000);

type TileReq = [string, number, number, number, number];
const state = (): StackState => JSON.parse(fs.readFileSync(STATE!, 'utf8')) as StackState;

/** Moon height and albedo, levels 0-4, plus regional height tiles: a few hundred tiles across several packs. */
function moonTiles(): TileReq[] {
  const m = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'tiles', 'moon', 'manifest.json'), 'utf8')) as { layers: Record<string, { coverage: Record<string, { face: number; x0: number; y0: number; x1: number; y1: number }[]> }> };
  const out: TileReq[] = [];
  for (const layer of ['height', 'albedo']) {
    for (let level = 0; level <= 3; level++) for (let face = 0; face < 6; face++) for (let y = 0; y < 2 ** level; y += 2) for (let x = 0; x < 2 ** level; x += 2) out.push([layer, face, level, x, y]);
  }
  for (const lvl of ['9', '12']) {
    const r = m.layers.height!.coverage[lvl]?.[0];
    if (r) for (let i = 0; i < 6; i++) out.push(['height', r.face, Number(lvl), r.x0 + i, r.y0]);
  }
  return out;
}

const ext: Record<string, string> = { height: 'hgt', albedo: 'webp' };
const expected = (tiles: TileReq[]): string[] =>
  tiles.map(([layer, face, level, x, y]) => createHash('sha256').update(fs.readFileSync(path.join(repoRoot, 'data', 'tiles', 'moon', layer, String(face), String(level), String(x), `${y}.${ext[layer]}`))).digest('hex').slice(0, 16));

const standIn = (): string => new URL(state().urls.bucket).origin;
async function faults(body: unknown): Promise<void> {
  const r = await fetch(`${standIn()}/_ctl/faults`, { method: 'POST', body: JSON.stringify(body) });
  expect(r.ok).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await faults({ clear: true });
  await openPage(page, '/labs/platform/');
  await page.waitForFunction(() => window.__platform !== undefined);
});

test('main thread and worker read tiles byte-identical through the pack source, cross-origin isolated', async ({ page, pageLog }) => {
  await assertDiscreteGpu(page);
  const tiles = moonTiles();
  const want = expected(tiles);
  const list = state().urls.packList;
  const main = await page.evaluate(([u, t]) => window.__platform!.readMain(u, 'moon', t, null), [list, tiles] as const);
  expect(main.isolated).toBe(true);
  expect(main.hashes).toEqual(want);
  expect(main.stats.failures).toEqual({});
  expect(main.stats.requests.bucket).toBeGreaterThan(0);
  const worker = await page.evaluate(([u, t]) => window.__platform!.readWorker(u, 'moon', t, null), [list, tiles] as const);
  expect(worker.isolated).toBe(true);
  expect(worker.hashes).toEqual(want);
  console.log(`${tiles.length} tiles: main thread ${main.ms.toFixed(0)} ms in ${main.stats.requests.bucket} bucket requests; worker ${worker.ms.toFixed(0)} ms in ${worker.stats.requests.bucket}`);
  // Content-Range is not exposed by the stand-in (no Access-Control-Expose-Headers): a page cannot read it.
  const cr = await page.evaluate(async (origin) => {
    const listDoc = (await (await fetch(origin)).json()) as { mirrors: { id: string; objects?: Record<string, string> }[] };
    const url = Object.values(listDoc.mirrors.find((m) => m.id === 'bucket')!.objects!)[0]!;
    const r = await fetch(url, { headers: { Range: 'bytes=0-15' } });
    return { status: r.status, contentRange: r.headers.get('content-range'), bytes: (await r.arrayBuffer()).byteLength };
  }, list);
  expect(cr).toEqual({ status: 206, contentRange: null, bytes: 16 });
  await expectNoErrors(page, pageLog);
});

test('the OPFS cache answers every tile after a reload, with no request to a mirror', async ({ page }) => {
  const tiles = moonTiles();
  const list = state().urls.packList;
  await page.evaluate(() => window.__platform!.clearCache());
  const first = await page.evaluate(([u, t]) => window.__platform!.readMain(u, 'moon', t, 200e6), [list, tiles] as const);
  expect(first.stats.fromNetwork).toBeGreaterThan(0);
  await page.reload();
  await page.waitForFunction(() => window.__platform !== undefined);
  const again = await page.evaluate(([u, t]) => window.__platform!.readMain(u, 'moon', t, 200e6), [list, tiles] as const);
  expect(again.hashes).toEqual(expected(tiles));
  expect(again.stats.fromNetwork).toBe(0);
  expect(again.stats.requests.bucket ?? 0).toBe(0);
  expect(again.stats.requests.mirror ?? 0).toBe(0);
  expect(again.stats.fromCache).toBeGreaterThanOrEqual(tiles.length);
  console.log(`reload: ${again.stats.fromCache} reads from OPFS, ${again.stats.requests.packList} pack-list request, 0 tile requests (${again.ms.toFixed(0)} ms; ${first.ms.toFixed(0)} ms cold)`);
});

test('the OPFS cache has one owner across the page and a worker; a truncated entry is a miss and is removed', async ({ page }) => {
  const r = await page.evaluate(() => window.__platform!.opfsOwnership());
  expect(r).toEqual({ mainMode: 'owner', workerMode: 'read-only', workerGot: 1000, workerPutIgnored: true, truncatedMiss: true, truncatedRemoved: true, reopenedMode: 'owner' });
});

test('failover: 429 and a 404 for an indexed object move to the mirror; a 403 refreshes the pack list once', async ({ page }) => {
  const tiles = moonTiles().slice(0, 60);
  const want = expected(tiles);
  const list = state().urls.packList;
  // 429 on every bucket request
  await faults({ add: [{ target: 'bucket', status: 429, count: 100000 }] });
  let r = await page.evaluate(([u, t]) => window.__platform!.readMain(u, 'moon', t, null), [list, tiles] as const);
  expect(r.hashes).toEqual(want);
  expect(r.stats.failures.bucket?.['429']).toBeGreaterThan(0);
  expect(r.stats.requests.mirror).toBeGreaterThan(0);
  // 404 for the moon's index object, which the pack list promises
  await faults({ clear: true });
  const moonIndex = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'packs', 'moon', 'current.json'), 'utf8')) as { index: string }).index;
  await faults({ add: [{ target: 'bucket', status: 404, count: 100000, hash: moonIndex }] });
  r = await page.evaluate(([u, t]) => window.__platform!.readMain(u, 'moon', t, null), [list, tiles] as const);
  expect(r.hashes).toEqual(want);
  expect(r.stats.failures.bucket?.['404']).toBeGreaterThan(0);
  expect(r.stats.requests.mirror).toBeGreaterThan(0);
  // one 403 (an expired signature): the list is fetched again and the bucket serves
  await faults({ clear: true });
  await faults({ add: [{ target: 'bucket', status: 403, count: 1 }] });
  r = await page.evaluate(([u, t]) => window.__platform!.readMain(u, 'moon', t, null), [list, tiles] as const);
  expect(r.hashes).toEqual(want);
  // Seen as a network error in the page (no CORS on the bucket's 403, as on Railway): one refresh, then the bucket.
  expect((r.stats.failures.bucket?.['403'] ?? 0) + (r.stats.failures.bucket?.network ?? 0)).toBe(1);
  expect(r.stats.packListLoads).toBe(2);
  expect(r.stats.requests.mirror ?? 0).toBe(0);
  // a 403 that persists after the refresh: the mirror
  await faults({ clear: true });
  await faults({ add: [{ target: 'bucket', status: 403, count: 2 }] });
  r = await page.evaluate(([u, t]) => window.__platform!.readMain(u, 'moon', t, null), [list, tiles] as const);
  expect(r.hashes).toEqual(want);
  expect(r.stats.packListLoads).toBe(2);
  expect(r.stats.requests.mirror).toBeGreaterThan(0);
  await faults({ clear: true });
});

test('a terrain hash at fixed points through the pack source equals the terrain guard', async ({ page }) => {
  const recorded = JSON.parse(fs.readFileSync(HEIGHTS_FILE, 'utf8')) as GuardHeights;
  const list = state().urls.packList;
  const N = 60;
  for (const bodyId of Object.keys(recorded.bodies).sort()) {
    // The guard records its fixed directions (format 2); the first N points of every body.
    const dirs = directionsOf(recorded.bodies[bodyId]!.directions).slice(0, N);
    const bits = await page.evaluate(([u, b, d]) => window.__platform!.terrainBits(u, b, d, 40), [list, bodyId, dirs] as const);
    const want = recorded.bodies[bodyId]!.collision.slice(0, N * 16);
    expect(bits, bodyId).toBe(want);
    console.log(`${bodyId}: ${N} collision heights through the pack source equal the guard's bits (hash ${createHash('sha256').update(bits).digest('hex').slice(0, 16)})`);
  }
});
