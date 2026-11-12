/**
 * From real Chrome under COEP against the DEPLOYED stage 0 (platform-delivery D5): the lab page, cross-origin
 * isolated on the local dev server, reads the deployed pack list from `game`, the Railway bucket by presigned
 * ranges (CORS), and the `shell` mirror's slices through Railway's CDN; time to the first decoded tile on each
 * path; failover from the bucket to the mirror on an expired URL (403, one refresh, then the mirror) and on a
 * 404. Not a stack suite: it measures production, so it runs on purpose with the deployed URLs:
 *
 *   DEPLOYED_GAME=https://game-production-dfc41bff.up.railway.app DEPLOYED_EXPIRED_LIST=out/platform/expired-list.json \
 *     node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/platform/deployed.spec.ts --project=functional
 *
 * DEPLOYED_EXPIRED_LIST is the deployed pack list re-signed eight days in the past, so its bucket URLs answer
 * 403 even after a refresh; beside it, missing-list.json signs keys that do not exist (404). Both are written by
 * `npx tsx deploy/railway/expired-list.ts` (git-ignored out/: the URLs are bearer URLs).
 */
import fs from 'node:fs';
import { expect, openPage, test } from '../harness';

const GAME = process.env.DEPLOYED_GAME;
test.skip(!GAME, 'measures the deployed stage 0: set DEPLOYED_GAME');
test.describe.configure({ mode: 'serial' });
test.setTimeout(5 * 60_000);

type TileReq = [string, number, number, number, number];
const TILES: TileReq[] = [];
for (let face = 0; face < 6; face++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) TILES.push(['albedo', face, 2, x, y]);
const FIRST: TileReq = ['albedo', 0, 3, 5, 2];

interface PackListDoc {
  mirrors: { id: string; mode: string; base?: string; sliceBytes?: number; objects?: Record<string, string> }[];
  sets: Record<string, unknown>;
}

test.beforeEach(async ({ page }) => {
  await openPage(page, '/labs/platform/');
  await page.waitForFunction(() => window.__platform !== undefined && crossOriginIsolated);
});

test('bucket ranges and mirror slices from Chrome under COEP: bytes, time to the first decoded tile, requests', async ({ page }) => {
  const list = (await (await fetch(`${GAME}/packs.json`)).json()) as PackListDoc;
  expect(list.mirrors.map((m) => m.id)).toEqual(['bucket', 'mirror']);
  expect(Object.keys(list.sets)).toContain('moon');
  const only = (id: string): string => JSON.stringify({ ...list, mirrors: list.mirrors.filter((m) => m.id === id) });
  const rows: Record<string, unknown> = {};
  for (const id of ['bucket', 'mirror']) {
    const url = await page.evaluate((j) => window.__platform!.listUrl(j), only(id));
    const first = await page.evaluate(([u, t]) => window.__platform!.firstTile(u, 'moon', t), [url, FIRST] as const);
    const warm = await page.evaluate(([u, t]) => window.__platform!.firstTile(u, 'moon', t), [url, FIRST] as const);
    const many = await page.evaluate(([u, t]) => window.__platform!.readMain(u, 'moon', t, null), [url, TILES] as const);
    expect(many.isolated).toBe(true);
    expect(many.hashes.every((h) => h !== null)).toBe(true);
    expect(many.stats.failures).toEqual({});
    rows[id] = {
      firstDecodedMs: Math.round(first.decodedMs),
      firstBytesMs: Math.round(first.bytesMs),
      secondDecodedMs: Math.round(warm.decodedMs),
      tiles: TILES.length,
      readMs: Math.round(many.ms),
      requests: many.stats.requests[id],
      bytesReceived: many.stats.bytesReceived[id],
      bytesNeeded: many.stats.bytesNeeded,
    };
  }
  // The same object's bytes through both paths are identical.
  const viaBucket = await page.evaluate(([u, t]) => window.__platform!.readMain(u, 'moon', t, null), [await page.evaluate((j) => window.__platform!.listUrl(j), only('bucket')), TILES] as const);
  const viaMirror = await page.evaluate(([u, t]) => window.__platform!.readMain(u, 'moon', t, null), [await page.evaluate((j) => window.__platform!.listUrl(j), only('mirror')), TILES] as const);
  expect(viaMirror.hashes).toEqual(viaBucket.hashes);
  console.log(`DEPLOYED ${JSON.stringify(rows)}`);
  fs.mkdirSync('out/platform', { recursive: true });
  fs.writeFileSync('out/platform/deployed-paths.json', JSON.stringify({ at: new Date().toISOString(), rows }, null, 1));
});

test('failover on the deployed services: an expired bucket URL (403, one refresh, then the mirror) and a 404', async ({ page }) => {
  const expiredFile = process.env.DEPLOYED_EXPIRED_LIST;
  test.skip(!expiredFile, 'needs DEPLOYED_EXPIRED_LIST');
  const expired = fs.readFileSync(expiredFile!, 'utf8');
  let url = await page.evaluate((j) => window.__platform!.listUrl(j), expired);
  let r = await page.evaluate(([u, t]) => window.__platform!.readMain(u, 'moon', t, null), [url, TILES.slice(0, 8)] as const);
  expect(r.hashes.every((h) => h !== null)).toBe(true);
  // The bucket's 403 for an expired URL has no CORS headers: the page sees a network error, refreshes once.
  const refused = (r.stats.failures.bucket?.['403'] ?? 0) + (r.stats.failures.bucket?.network ?? 0);
  expect(refused).toBeGreaterThanOrEqual(2);
  expect(r.stats.packListLoads).toBe(2);
  expect(r.stats.requests.mirror).toBeGreaterThan(0);
  // 404: every bucket URL is validly signed for a key that does not exist.
  const missing = fs.readFileSync(expiredFile!.replace('expired-list', 'missing-list'), 'utf8');
  url = await page.evaluate((j) => window.__platform!.listUrl(j), missing);
  r = await page.evaluate(([u, t]) => window.__platform!.readMain(u, 'moon', t, null), [url, TILES.slice(8, 16)] as const);
  expect(r.hashes.every((h) => h !== null)).toBe(true);
  expect(r.stats.failures.bucket?.['404']).toBeGreaterThan(0);
  expect(r.stats.requests.mirror).toBeGreaterThan(0);
  console.log(`FAILOVER 403 ${JSON.stringify(r.stats.failures)}`);
});
