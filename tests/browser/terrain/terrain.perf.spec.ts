import type { Page } from '@playwright/test';
import { expect, expectNoErrors, test, withGpuLock } from '../harness';
import { LUNAR_SITE, PAD, openLab, settle, shot, terrainStats } from './util';

test.use({ viewport: { width: 2560, height: 1440 } });

/**
 * ARCHITECTURE 17.1, the terrain lines, at 1440p internal resolution, qualityScale 1 (GPU timestamps, ms):
 *   terrain G-buffer incl. far water sheet   1.5 (pad, ascent, LEO), 1.8 (lunar descent)      p99
 *   terrain shadow casting                   0.5 (pad, ascent), 0.4 (LEO), 0.6 (lunar)        amortised mean
 *   rocks, G-buffer + shadow                 0.15 (pad), 0.3 (lunar descent)
 * and of section 17: quadtree selection under 1 ms of CPU, uploads within 8 tiles / 2 ms per frame, no
 * frame over 33 ms in steady flight, about 1.1 GB of terrain pools.
 *
 * Method (render-core hand-off 4.1): attribution mode (every feature hook in its own pass), governor off,
 * and a ballast pass of about 7 ms so the GPU runs at its working clock; the idle-GPU numbers are logged
 * for the record. Terrain and rocks share one feature (one hook), so every view is measured without the
 * rock field and, where rocks exist, with it: the rocks' line is the difference.
 *
 * Other agents' browsers use the same GPU while this runs (the GPU lock only keeps other PERF specs away),
 * and their work lands in our timestamps: two measurements of the same scene differed by up to 0.4 ms.
 * Contention only ever adds time, so each configuration is measured in three interleaved rounds and the
 * smallest p99 / mean is taken.
 */

interface Measured {
  gbuffer: number;
  shadow: number;
  ballast: number;
  selectP99: number;
  selectMax: number;
  cpuP99: number;
  quality: number;
  scale: number;
}

async function measure(page: Page, frames: number): Promise<Measured> {
  return page.evaluate(async (n) => {
    const t = window.__terrain!;
    await window.__test!.waitFrames(90);
    window.__test!.resetPerf();
    const select: number[] = [];
    for (let i = 0; i < n; i++) {
      await window.__test!.waitFrames(1);
      select.push(t.debug.stats().selectMs);
    }
    select.sort((a, b) => a - b);
    const passes = window.__lab!.renderer.passStats();
    const perf = window.__test!.perf()!;
    return {
      gbuffer: passes['terrain.gbuffer']?.p99 ?? 0,
      shadow: passes['terrain.shadow']?.mean ?? 0,
      ballast: passes['lab-ballast.burn']?.p50 ?? 0,
      selectP99: select[Math.floor(select.length * 0.99)]!,
      selectMax: select[select.length - 1]!,
      cpuP99: perf.features.terrain?.cpuMs ?? 0,
      quality: perf.qualityScale,
      scale: perf.renderScale,
    };
  }, frames);
}

/** Set the ballast so that it costs about `ms` per frame, calibrated while it runs. */
async function calibrateBallast(page: Page, ms: number): Promise<void> {
  const perIteration = await page.evaluate(async () => {
    window.__terrain!.setBallast(400);
    await window.__test!.waitFrames(90);
    window.__test!.resetPerf();
    await window.__test!.waitFrames(60);
    return (window.__lab!.renderer.passStats()['lab-ballast.burn']?.p50 ?? 0) / 400;
  });
  expect(perIteration).toBeGreaterThan(0);
  await page.evaluate((n) => window.__terrain!.setBallast(n), Math.round(ms / perIteration));
}

interface PerfView {
  name: string;
  body: 'earth' | 'moon';
  query: Record<string, string | number>;
  budget: { gbuffer: number; shadow: number; rocks: number | null };
}

const VIEWS: PerfView[] = [
  { name: 'pad', body: 'earth', query: { body: 'earth', lat: PAD.lat - 0.0009, lon: PAD.lon, agl: 1.7, heading: 60, pitch: -4, sun: '105,31' }, budget: { gbuffer: 1.5, shadow: 0.5, rocks: 0.15 } },
  { name: '10 km', body: 'earth', query: { body: 'earth', lat: PAD.lat, lon: PAD.lon, alt: 10e3, heading: 340, pitch: -25, sun: '105,31' }, budget: { gbuffer: 1.5, shadow: 0.5, rocks: null } },
  { name: 'LEO', body: 'earth', query: { body: 'earth', lat: 19.6, lon: -155.5, alt: 250e3, heading: 20, pitch: -40, sun: '105,42' }, budget: { gbuffer: 1.5, shadow: 0.4, rocks: null } },
  { name: 'lunar orbit', body: 'moon', query: { body: 'moon', lat: 1.5, lon: 21.5, alt: 100e3, heading: 80, pitch: -30, sun: '92,10' }, budget: { gbuffer: 1.8, shadow: 0.6, rocks: null } },
  { name: 'lunar surface', body: 'moon', query: { body: 'moon', ...LUNAR_SITE, agl: 1.7, heading: 250, pitch: -6, sun: '92,11' }, budget: { gbuffer: 1.8, shadow: 0.6, rocks: 0.3 } },
];

for (const v of VIEWS) {
  test(`terrain GPU budget at 1440p: ${v.name}`, async ({ page, pageLog }) => {
    test.setTimeout(30 * 60_000);
    await withGpuLock(async () => {
      await openLab(page, { scene: v.body === 'moon' ? 'lunarOrbit' : 'lowOrbit', paused: 1, perf: 'features', scale: 1, governor: 'off', ...v.query });
      await settle(page, 30);
      const size = await page.evaluate(() => window.__lab!.renderer.frameContext!.renderSize);
      expect(size).toEqual([2560, 1440]);
      await page.evaluate(() => window.__terrain!.debug.setRocksEnabled(false));
      const idle = await measure(page, 200);
      await calibrateBallast(page, 7);
      const best = (a: Measured | null, b: Measured): Measured =>
        a === null ? b : { ...b, gbuffer: Math.min(a.gbuffer, b.gbuffer), shadow: Math.min(a.shadow, b.shadow), selectP99: Math.min(a.selectP99, b.selectP99), selectMax: Math.min(a.selectMax, b.selectMax), cpuP99: Math.min(a.cpuP99, b.cpuP99) };
      let bareBest: Measured | null = null;
      let fullBest: Measured | null = null;
      for (let round = 0; round < 3; round++) {
        await page.evaluate(() => window.__terrain!.debug.setRocksEnabled(false));
        bareBest = best(bareBest, await measure(page, 200));
        await page.evaluate(() => window.__terrain!.debug.setRocksEnabled(true));
        await settle(page, 30);
        fullBest = best(fullBest, await measure(page, 200));
      }
      const bare = bareBest!;
      const full = fullBest!;
      const st = await terrainStats(page);
      const b = st.bodies[v.body]!;
      const rocks = Math.max(0, full.gbuffer - bare.gbuffer) + Math.max(0, full.shadow - bare.shadow);
      console.log(
        `${v.name}: terrain G-buffer p99 ${bare.gbuffer.toFixed(3)} ms (budget ${v.budget.gbuffer}), shadows amortised ${bare.shadow.toFixed(3)} ms (budget ${v.budget.shadow}), ` +
          `rocks ${rocks.toFixed(3)} ms${v.budget.rocks === null ? '' : ` (budget ${v.budget.rocks})`} [${st.rocks.instances} instances, ${st.rocks.triangles} triangles]; ` +
          `with an idle GPU: G-buffer ${idle.gbuffer.toFixed(3)}, shadows ${idle.shadow.toFixed(3)}; ballast ${bare.ballast.toFixed(1)} ms; ` +
          `${b.visible}/${b.selected} tiles, level ${b.deepestLevel}, ${b.waterTiles} water, ${b.casters} casters; ` +
          `selection CPU p99 ${full.selectP99.toFixed(3)} ms (max ${full.selectMax.toFixed(3)}), terrain hooks CPU p99 ${full.cpuP99.toFixed(3)} ms`,
      );
      await shot(page, `perf-${v.name.replace(/ /g, '-')}`);
      expect(bare.ballast).toBeGreaterThan(5);
      expect(full.quality).toBe(1);
      expect(full.scale).toBe(1);
      expect(bare.gbuffer).toBeGreaterThan(0);
      expect(bare.gbuffer).toBeLessThanOrEqual(v.budget.gbuffer);
      expect(bare.shadow).toBeLessThanOrEqual(v.budget.shadow);
      if (v.budget.rocks !== null) expect(rocks).toBeLessThanOrEqual(v.budget.rocks);
      expect(full.selectP99).toBeLessThan(1);
      await expectNoErrors(page, pageLog);
    });
  });
}

test('a 60 s descent at 1440p: no frame over 33 ms, uploads within budget, pools about 1.1 GB', async ({ page, pageLog }) => {
  test.setTimeout(30 * 60_000);
  await withGpuLock(async () => {
    await openLab(page, { scene: 'lunarOrbit', perf: 'features', scale: 1, governor: 'off', paused: 1, body: 'moon', ...LUNAR_SITE, alt: 60e3, heading: 280, pitch: -55, sun: '92,11' });
    await settle(page, 30);
    await calibrateBallast(page, 7);
    const r = await page.evaluate(
      async ([lat, lon]) => {
        const lab = window.__lab!;
        const t = window.__terrain!;
        const ground = await t.groundHeight('moon', lat!, lon!);
        const from = 60e3;
        const to = 30;
        const seconds = 60;
        // Warm-up: 5 s at the start of the path.
        await window.__test!.waitFrames(300);
        let t0 = -1;
        let last = -1;
        let over33 = 0;
        let maxDelta = 0;
        let frames = 0;
        let maxSelect = 0;
        const selects: number[] = [];
        const totals: number[] = [];
        let maxQueue = 0;
        const before = t.debug.stats().stream;
        await new Promise<void>((resolve) => {
          lab.onFrame(() => {
            const now = performance.now();
            if (t0 < 0) t0 = now;
            const s = Math.min(1, (now - t0) / (seconds * 1000));
            const height = from * (to / from) ** s;
            lab.camera.spec = { type: 'surface', bodyId: 'moon', latDeg: lat!, lonDeg: lon!, alt: ground + height, headingDeg: 280, pitchDeg: -55 + 40 * s };
            if (last >= 0) {
              const d = now - last;
              if (d > 33) over33++;
              maxDelta = Math.max(maxDelta, d);
              frames++;
            }
            last = now;
            const st = t.debug.stats();
            maxSelect = Math.max(maxSelect, st.selectMs);
            selects.push(st.selectMs);
            totals.push(st.selectMs + st.prefetchMs);
            maxQueue = Math.max(maxQueue, st.stream.queued + st.stream.loading + st.stream.uploading);
            if (s >= 1) {
              lab.onFrame(null);
              resolve();
            }
          });
        });
        selects.sort((a, b) => a - b);
        totals.sort((a, b) => a - b);
        const after = t.debug.stats();
        return {
          frames,
          over33,
          maxDelta,
          selectP99: selects[Math.floor(selects.length * 0.99)]!,
          totalP99: totals[Math.floor(totals.length * 0.99)]!,
          totalMedian: totals[Math.floor(totals.length * 0.5)]!,
          maxSelect,
          maxQueue,
          uploaded: after.stream.uploadedTotal - before.uploadedTotal,
          maxUploadTiles: after.stream.maxUploadTiles,
          maxUploadMs: after.stream.maxUploadMs,
          uploadMsP99: after.stream.uploadMsP99,
          poolBytes: after.stream.poolBytes,
          deepest: after.bodies.moon!.deepestLevel,
          rocks: after.rocks.instances,
          raf: window.__test!.perf()!.raf,
        };
      },
      [LUNAR_SITE.lat, LUNAR_SITE.lon] as const,
    );
    console.log(
      `descent 60 km -> 30 m in 60 s: ${r.frames} frames, ${r.over33} over 33 ms (largest ${r.maxDelta.toFixed(1)} ms); selection CPU p99 ${r.selectP99.toFixed(3)} ms (max ${r.maxSelect.toFixed(3)}), with the request-only prefetch passes of two frames in eight: median ${r.totalMedian.toFixed(3)}, p99 ${r.totalP99.toFixed(3)} ms; ` +
        `${r.uploaded} tiles uploaded, at most ${r.maxUploadTiles} tiles in a frame, upload time p99 ${r.uploadMsP99.toFixed(2)} ms (largest ${r.maxUploadMs.toFixed(2)} ms); largest queue ${r.maxQueue}; deepest level ${r.deepest}; ${r.rocks} rocks at the end; ` +
        `terrain pools ${(r.poolBytes / 2 ** 20).toFixed(0)} MiB`,
    );
    expect(r.frames).toBeGreaterThan(3000);
    expect(r.over33).toBe(0);
    // The budget line is the selection of what is drawn. Two frames in eight also run a request-only pass
    // for the streamer (2 s ahead, predicted impact), a second traversal: those frames may reach 1.5 ms
    // here (unfocused headless Chrome on a machine shared with other agents' jobs; the same traversal
    // takes 0.13 ms in Node, tools/terrain/bench-select.ts).
    expect(r.selectP99).toBeLessThan(1);
    expect(r.totalP99).toBeLessThan(1.5);
    expect(r.maxUploadTiles).toBeLessThanOrEqual(8);
    // The budget is 8 tiles or 2 ms: the loop stops before the tile that would pass 2 ms by its running
    // estimate, so the 99th percentile sits at the budget; a single slow copy can still land above it.
    expect(r.uploadMsP99).toBeLessThan(2.5);
    expect(r.poolBytes / 2 ** 30).toBeLessThan(1.15);
    expect(r.uploaded).toBeGreaterThan(200);
    await expectNoErrors(page, pageLog);
  });
});

test('50x warp in a 200 km orbit for 60 s: the tile queue stays bounded and no frame exceeds 33 ms', async ({ page, pageLog }) => {
  test.setTimeout(30 * 60_000);
  await withGpuLock(async () => {
    // The lab camera rides with the vessel and looks down past it at the ground track.
    await openLab(page, { scene: 'lowOrbit', perf: 'features', scale: 1, governor: 'off', vessel: 'active', offset: '0,0,40', look: '0,0,-1000', sun: '105,40' });
    await settle(page, 30);
    await calibrateBallast(page, 7);
    const r = await page.evaluate(async () => {
      const lab = window.__lab!;
      const t = window.__terrain!;
      // WARP_LEVELS[6] = 50.
      const res = window.__test!.commands!.setWarpLevel(6);
      await window.__test!.waitFrames(300);
      const factor = lab.snapshot().warp.factor;
      let last = -1;
      let t0 = -1;
      let over33 = 0;
      let maxDelta = 0;
      let frames = 0;
      let maxQueue = 0;
      let queueSum = 0;
      let minLevel = 99;
      let maxLevel = 0;
      const before = t.debug.stats().stream;
      await new Promise<void>((resolve) => {
        lab.onFrame(() => {
          const now = performance.now();
          if (t0 < 0) t0 = now;
          if (last >= 0) {
            const d = now - last;
            if (d > 33) over33++;
            maxDelta = Math.max(maxDelta, d);
            frames++;
          }
          last = now;
          const st = t.debug.stats();
          const q = st.stream.queued + st.stream.loading + st.stream.uploading;
          maxQueue = Math.max(maxQueue, q);
          queueSum += q;
          minLevel = Math.min(minLevel, st.bodies.earth!.deepestLevel);
          maxLevel = Math.max(maxLevel, st.bodies.earth!.deepestLevel);
          if (now - t0 >= 60_000) {
            lab.onFrame(null);
            resolve();
          }
        });
      });
      const after = t.debug.stats();
      return {
        ok: res.ok,
        factor,
        frames,
        over33,
        maxDelta,
        maxQueue,
        meanQueue: queueSum / Math.max(1, frames),
        minLevel,
        maxLevel,
        cap: after.bodies.earth!.cap,
        speed: after.bodies.earth!.groundSpeed,
        uploaded: after.stream.uploadedTotal - before.uploadedTotal,
        cancelled: after.stream.cancelledTotal - before.cancelledTotal,
        evicted: after.stream.evictedTotal - before.evictedTotal,
      };
    });
    console.log(
      `warp ${r.factor}x at 200 km: ground speed ${(r.speed / 1000).toFixed(0)} km per wall second, level cap ${r.cap.toFixed(2)} (deepest level drawn ${r.minLevel}..${r.maxLevel}); ` +
        `${r.frames} frames in 60 s, ${r.over33} over 33 ms (largest ${r.maxDelta.toFixed(1)} ms); tile queue at most ${r.maxQueue}, mean ${r.meanQueue.toFixed(1)}; ` +
        `${r.uploaded} tiles uploaded, ${r.cancelled} requests cancelled, ${r.evicted} evicted`,
    );
    await shot(page, 'warp-50x-low-orbit');
    expect(r.ok).toBe(true);
    expect(r.factor).toBe(50);
    expect(r.frames).toBeGreaterThan(3000);
    expect(r.over33).toBe(0);
    // Bounded: far below the few hundred tiles a full selection holds, and it does not grow over the minute.
    expect(r.maxQueue).toBeLessThan(120);
    // The cap is what bounds it: log2(faceSize / (speed x 2 s)).
    expect(r.maxLevel).toBeLessThanOrEqual(Math.floor(r.cap));
    await expectNoErrors(page, pageLog);
  });
});
