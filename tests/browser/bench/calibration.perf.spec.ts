/**
 * The calibration on the reference GPU (capability-settings acceptance; ARCHITECTURE 24, frontend-ux 14), in
 * the bench lab (labs/bench: the real renderer with every package, the real session, the four shots of
 * data/defs/render/quality.json) at 2560 x 1440, under the GPU lock:
 *  - before a calibration the page runs on the seed preset of the adapter class hint, and the calibration
 *    refuses to start while the shots' data is not resident;
 *  - after the warm-up (the shots' data streamed in, what each fetched recorded as its needs) it finishes in
 *    under 30 s and chooses Ultra;
 *  - with the slow-GPU ballast it chooses a lower profile that then holds the frame budget in the
 *    confirmation shot.
 * Output: out/capability-settings/calibration.json (the results, the shots' measurements, the needs, the CPU
 * probe) and a picture of every shot at the chosen profile (looked at). With NEEDS_RECORD=1 the needs recorded
 * here are written into data/defs/render/quality.json (the reference machine's list; the lead's or this
 * package's act); without it, at least 90 % of this run's requests must be in that list.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/bench/calibration.perf.spec.ts --project=perf
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { parseQualityTable, type CalibrationResult, type ShotNeeds } from '@/bench';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, withGpuLock } from '../harness';

test.use({ viewport: { width: 2560, height: 1440 } });
test.setTimeout(20 * 60_000);

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'out', 'capability-settings');
const TABLE = path.join(ROOT, 'data', 'defs', 'render', 'quality.json');
const table = (): ReturnType<typeof parseQualityTable> => parseQualityTable(JSON.parse(fs.readFileSync(TABLE, 'utf8')));
const DATA = /^\/(tiles|sky|assets)\//;

/**
 * Every data request of the page (workers included) from its first load on, by shot: what it loaded before the
 * first shot and while it opened and settled each shot in turn (a path counts for the first shot that asked for
 * it). Started before the page is opened; `done()` visits the shots and returns the lists.
 */
function needsRecorder(page: Page): { done(): Promise<ShotNeeds[]> } {
  const order = table().shots.map((s) => s.id);
  const by = new Map<string, Map<string, number>>(order.map((id) => [id, new Map()]));
  let current = order[0]!;
  const seen = new Set<string>();
  const pending: Promise<void>[] = [];
  page.on('requestfinished', (req) => {
    const p = new URL(req.url()).pathname;
    if (!DATA.test(p) || seen.has(p)) return;
    seen.add(p);
    const bucket = by.get(current)!;
    // Only what arrived: a probe that found nothing (404) is not a need.
    pending.push(
      (async () => {
        const res = await req.response();
        if (!res || !res.ok()) return;
        bucket.set(p, (await req.sizes().catch(() => ({ responseBodySize: 0 }))).responseBodySize);
      })(),
    );
  });
  return {
    async done() {
      await page.exposeFunction('__benchShotStarts', (id: string) => void (current = id));
      await page.evaluate(() => window.__bench!.visitShots((id) => void (window as unknown as { __benchShotStarts(id: string): void }).__benchShotStarts(id)));
      await Promise.all(pending);
      return order.map((id) => {
        const m = by.get(id)!;
        return { shotId: id, paths: [...m.keys()].sort(), bytes: [...m.values()].reduce((a, b) => a + b, 0) };
      });
    },
  };
}

/** NEEDS_RECORD=1: the recorded needs into data/defs/render/quality.json (its `needs` member, one path per line). */
function writeNeeds(needs: ShotNeeds[]): void {
  const text = fs.readFileSync(TABLE, 'utf8');
  const block = `  "needs": [\n${needs.map((n) => `    { "shotId": ${JSON.stringify(n.shotId)}, "bytes": ${n.bytes}, "paths": [\n${n.paths.map((p) => `      ${JSON.stringify(p)}`).join(',\n')}\n    ] }`).join(',\n')}\n  ],\n`;
  const at = text.indexOf('  "needs": [');
  const next = at >= 0 ? text.indexOf('\n  "', at + 5) : -1;
  const out = at >= 0 ? text.slice(0, at) + block + text.slice(next + 1) : text.replace('  "attribution": {', `${block}  "attribution": {`);
  parseQualityTable(JSON.parse(out));
  fs.writeFileSync(TABLE, out);
}
const record: Record<string, unknown> = {};
const save = (): void => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'calibration.json'), JSON.stringify(record, null, 2));
};

async function shots(page: Page, tag: string): Promise<void> {
  for (const id of ['pad-dawn', 'liftoff', 'leo-terminator', 'cockpit']) {
    await page.evaluate((s) => window.__bench!.showShot(s), id);
    await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: 120_000 });
    await page.evaluate(() => window.__test!.waitFrames(90));
    await saveScreenshot(page, 'capability-settings', `bench-${tag}-${id}`);
  }
}

test('the calibration on the reference GPU: seed preset first, refused until resident, then Ultra in under 30 s', async ({ page, pageLog }) => {
  await withGpuLock(async () => {
    const recorder = needsRecorder(page);
    await openPage(page, '/labs/bench/', { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    const seed = await page.evaluate(() => ({ seed: window.__bench!.seed, profile: window.__lab!.renderer.core.quality.profile(), problems: window.__bench!.problems }));
    record['seed'] = seed;
    expect(seed.problems).toEqual([]);
    expect(seed.seed).toBe('high');
    expect(seed.profile?.pixelCap).toBe(2.4);
    expect(Object.values(seed.profile!.levels).every((l) => l === 'high')).toBe(true);
    // Not resident yet: the calibration refuses.
    expect(await page.evaluate(() => window.__bench!.resident())).toBe(false);
    const refused = await page.evaluate(() => window.__bench!.calibrate().then(() => 'ran', (e: Error) => e.name));
    expect(refused).toBe('CalibrationNotReady');

    // Each shot's needs: every data request (workers included) while the page opened and settled it; what the
    // page loaded before the first shot counts for the first.
    const recorded = await recorder.done();
    record['needsRecorded'] = recorded.map((n) => ({ shotId: n.shotId, files: n.paths.length, bytes: n.bytes }));
    if (process.env.NEEDS_RECORD === '1') {
      // The page server serves the library as it was when it started (tools/server/dataPlugin.ts): the list
      // written now is read by the next run.
      writeNeeds(recorded);
      save();
      test.info().annotations.push({ type: 'needs', description: 'recorded into data/defs/render/quality.json; run again without NEEDS_RECORD' });
      return;
    }
    const listed = new Set(table().needs?.flatMap((n) => n.paths) ?? []);
    const all = recorded.flatMap((n) => n.paths);
    const covered = all.filter((p) => listed.has(p)).length / Math.max(1, all.length);
    record['needsCoverage'] = covered;
    console.log(`[bench] needs: ${recorded.map((n) => `${n.shotId} ${n.paths.length} files ${(n.bytes / 1e6).toFixed(1)} MB`).join(', ')}; ${(100 * covered).toFixed(1)} % of this run's requests are in the table`);
    expect(covered).toBeGreaterThanOrEqual(0.9);
    const t0 = Date.now();
    const warm = await page.evaluate(() => window.__bench!.warmUp());
    record['warmUp'] = { s: (Date.now() - t0) / 1000, ...warm };
    expect(warm.failed).toEqual([]);
    expect(await page.evaluate(() => window.__bench!.resident())).toBe(true);
    const cpu: number[] = [];
    for (let i = 0; i < 3; i++) cpu.push(await page.evaluate(() => window.__bench!.cpuProbe()));
    record['cpuProbeMs'] = cpu;
    save();

    const w0 = Date.now();
    const result: CalibrationResult = await page.evaluate(() => window.__bench!.calibrate());
    const wallS = (Date.now() - w0) / 1000;
    record['calibration'] = { wallS, result, progress: await page.evaluate(() => window.__bench!.progress) };
    save();
    console.log(`[bench] calibration ${wallS.toFixed(1)} s: ${result.preset}, predicted worst ${result.predictedWorstMs.toFixed(2)} ms (limit ${result.limitMs.toFixed(2)}), confirm p95 ${result.confirm.measuredP95.toFixed(2)} ms in ${result.confirm.steps} steps, cpuScore ${result.cpuScore}; notes: ${result.notes.join(' | ')}`);
    for (const s of result.shots) console.log(`[bench]   ${s.shotId}: p95 ${s.gpuP95.toFixed(2)} mean ${s.gpuMean.toFixed(2)} cpu p95 ${s.cpuP95.toFixed(2)} ${JSON.stringify(Object.fromEntries(Object.entries(s.groups).map(([k, v]) => [k, Number(v.toFixed(3))])))}`);
    expect(wallS).toBeLessThan(30);
    expect(result.preset).toBe('ultra');
    expect(result.confirm.held).toBe(true);
    expect(result.belowMinimum).toBeNull();
    await shots(page, 'ultra');
    await expectNoErrors(page, pageLog);
  });
});

test('with the slow-GPU ballast the calibration chooses a lower profile that holds the budget', async ({ page, pageLog }) => {
  await withGpuLock(async () => {
    await openPage(page, '/labs/bench/', { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    expect((await page.evaluate(() => window.__bench!.warmUp())).failed).toEqual([]);
    // A ballast of about 7 ms at 2560 x 1440 in the lift-off: the reference GPU then has roughly a third of its speed left.
    const ballast = await page.evaluate(async () => {
      const b = window.__bench!;
      await b.showShot('liftoff');
      const r = window.__lab!.renderer;
      let n = 64;
      let ms = 0;
      for (let round = 0; round < 6; round++) {
        b.setBallast(n);
        r.resetPerf();
        await window.__test!.waitFrames(90);
        ms = r.passStats()['bench-slow-gpu.march']?.p50 ?? 0;
        if (ms > 0) n = Math.max(8, Math.round((n * 7) / ms));
      }
      b.setBallast(n);
      return { iterations: n, ms };
    });
    record['ballast'] = ballast;
    const result: CalibrationResult = await page.evaluate(() => window.__bench!.calibrate());
    record['ballastCalibration'] = result;
    save();
    console.log(`[bench] ballast ${ballast.iterations} iterations (${ballast.ms.toFixed(2)} ms): ${result.preset} at ${result.profile.pixelCap} MP, ${JSON.stringify(result.profile.levels)}, predicted ${result.predictedWorstMs.toFixed(2)} ms, confirm p95 ${result.confirm.measuredP95.toFixed(2)} ms in ${result.confirm.steps} steps`);
    expect(result.preset).not.toBe('ultra');
    expect(result.confirm.held).toBe(true);
    await shots(page, 'ballast');
    await expectNoErrors(page, pageLog);
  });
});
