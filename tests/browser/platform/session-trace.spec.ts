/**
 * The recorded first session (platform-delivery D8; ARCHITECTURE 10.4, 30): a clean profile opens the game,
 * boots, and the scripted test pilot flies one launch to orbit (lunar-direct to EARTH_ORBIT, at most 12 minutes
 * of wall time). Every request the page makes is recorded with its time, path, status and body size, and the
 * trace is written to docs/capacity/traces/first-session-<date>.json. The trace is the input of:
 *  - the request-count criterion (tests/unit/platform/trace.test.ts replays its tile requests through the pack
 *    source and compares with per-file fetching);
 *  - the bytes of a first session on the bucket path and, replayed in the mirror's slice mode, as bytes
 *    actually transferred (docs/capacity), from which the per-visitor figures are recomputed.
 *
 * It is a recording, not a check: run it on purpose (one GPU slot):
 *   RECORD_SESSION=1 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/platform/session-trace.spec.ts --project=functional
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDiscreteGpu, expect, openPage, saveScreenshot, test } from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LIMIT_MS = 12 * 60_000;

test.skip(!process.env.RECORD_SESSION, 'a recording: set RECORD_SESSION=1');
test.setTimeout(20 * 60_000);

interface Entry {
  t: number;
  path: string;
  status: number;
  bytes: number;
  type: string;
}

test('first session: boot, title data, one launch to orbit; every request recorded', async ({ page }) => {
  const entries: Entry[] = [];
  let t0 = Date.now();
  page.on('requestfinished', async (req) => {
    const u = new URL(req.url());
    if (!u.protocol.startsWith('http')) return;
    const res = await req.response();
    const sizes = await req.sizes().catch(() => ({ responseBodySize: -1 }));
    entries.push({ t: Date.now() - t0, path: u.pathname + (u.search ?? ''), status: res?.status() ?? 0, bytes: sizes.responseBodySize, type: req.resourceType() });
  });
  t0 = Date.now();
  await openPage(page, '/?scenario=lunar-direct&pilot=1&view=chase', { timeoutMs: 240_000 });
  await assertDiscreteGpu(page);
  const bootMs = Date.now() - t0;
  await page
    .waitForFunction(() => (window.__app!.brief() as { milestones: string[] }).milestones.includes('EARTH_ORBIT'), undefined, { polling: 2000, timeout: LIMIT_MS - (Date.now() - t0) })
    .catch(() => undefined);
  const milestones = (await page.evaluate(() => window.__app!.brief() as { milestones: string[] })).milestones;
  await saveScreenshot(page, 'platform', 'first-session-end');
  const reachedOrbit = milestones.includes('EARTH_ORBIT');
  const sum = (f: (e: Entry) => boolean): { requests: number; bytes: number } => ({ requests: entries.filter(f).length, bytes: entries.filter(f).reduce((n, e) => n + Math.max(0, e.bytes), 0) });
  const summary = {
    bootMs,
    wallMs: Date.now() - t0,
    reachedOrbit,
    milestones,
    all: sum(() => true),
    tiles: sum((e) => e.path.startsWith('/tiles/')),
    sky: sum((e) => e.path.startsWith('/sky/')),
    assets: sum((e) => e.path.startsWith('/assets/') || e.path.startsWith('/public/')),
    defs: sum((e) => e.path.startsWith('/defs/')),
    code: sum((e) => /\.(js|ts|css|wgsl|html)(\?|$)/.test(e.path) || e.path === '/' || e.path.startsWith('/@') || e.path.startsWith('/src/') || e.path.startsWith('/node_modules/')),
  };
  console.log(JSON.stringify(summary, null, 1));
  const dir = path.join(repoRoot, 'docs', 'capacity', 'traces');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `first-session-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ recordedAt: new Date().toISOString(), page: '/?scenario=lunar-direct&pilot=1&view=chase', note: 'dev server (plain files); bytes are response body sizes as Chrome received them', summary, entries })}\n`);
  expect(entries.filter((e) => e.path.startsWith('/tiles/')).length).toBeGreaterThan(100);
});
