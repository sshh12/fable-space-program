import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { expect, expectNoErrors, pngDiff, test } from '../harness';
import { openLab, runAndSettle } from './helpers';

test.describe.configure({ timeout: 600_000 });

/** FNV-1a over the bit patterns of the dynamic state of every particle (position, age, velocity, life, colour, size, kind, seed). */
async function particleHash(page: Page): Promise<{ hash: string; alive: number; kinds: number[]; finite: boolean }> {
  return page.evaluate(async () => {
    const pool = await window.__vfx!.feature.debug.readParticles();
    const bits = new Uint32Array(pool.buffer);
    const N = 24;
    let h = 0x811c9dc5;
    let alive = 0;
    let finite = true;
    const kinds = new Array<number>(8).fill(0);
    for (let p = 0; p < pool.length; p += N) {
      if (pool[p + 7]! <= 0) continue; // life: dead slots hold stale data
      alive++;
      kinds[Math.round(pool[p + 14]!)]!++;
      for (let k = 0; k < 16; k++) {
        if (!Number.isFinite(pool[p + k]!)) finite = false;
        h = Math.imul(h ^ bits[p + k]!, 0x01000193) >>> 0;
      }
    }
    return { hash: h.toString(16), alive, kinds, finite };
  });
}

test('particles are deterministic given the same event stream (presentation time frozen)', async ({ page, pageLog }) => {
  // Staging: a decoupling with gas puffs, sparks and ice in a scripted event stream. Lunar: a continuous dust source.
  for (const scene of ['scene=staging', 'scene=lunar&h=8']) {
    const runs: { hash: string; alive: number; kinds: number[]; finite: boolean }[] = [];
    for (const frames of [200, 200, 201]) {
      await openLab(page, scene);
      await page.evaluate((n) => window.__vfx!.renderExact(n, true), frames);
      runs.push(await particleHash(page));
      await expectNoErrors(page, pageLog);
    }
    console.log(`${scene}: ${runs[0]!.alive} particles alive after 200 frames (by kind: ${runs[0]!.kinds.join(' ')}), state hash ${runs[0]!.hash} / ${runs[1]!.hash}; after 201 frames ${runs[2]!.hash}`);
    expect(runs[0]!.alive).toBeGreaterThan(500);
    expect(runs[0]!.finite).toBe(true);
    expect(runs[1]!.hash).toBe(runs[0]!.hash);
    expect(runs[1]!.alive).toBe(runs[0]!.alive);
    // One more frame of the same stream is a different state: the hash is sensitive.
    expect(runs[2]!.hash).not.toBe(runs[0]!.hash);
  }
});

test('the rendered canopy area follows the inflation', async ({ page, pageLog }) => {
  // Two drogues seen from 600 m straight above through a long lens, the capsule's stand-in hidden: pixels nearer
  // than the sea are canopy.
  const count = async (query: string): Promise<number> => {
    await openLab(page, `scene=chutes&chute=drogue&hide=kestrel-capsule,kestrel-apex-cover&${query}`);
    await page.evaluate(() => window.__vfx!.setCamera({ target: { x: 0, y: 0, z: 25 }, yawDeg: 0, pitchDeg: 89.6, distance: 600, fovDeg: 5 }));
    await page.evaluate(() => window.__vfx!.renderExact(3, false));
    const n = await page.evaluate(async () => {
      const d = await window.__lab!.renderer.readDepth();
      let near = 0;
      // Reversed-Z depth = 0.05 / distance: the canopies are within 700 m, the sea is 3 km away.
      for (let i = 0; i < d.data.length; i++) if (d.data[i]! > 0.05 / 1200) near++;
      return near;
    });
    await page.evaluate(() => window.__vfx!.resume());
    await expectNoErrors(page, pageLog);
    return n;
  };
  const none = await count('inflation=0&state=stowed');
  const full = await count('inflation=1');
  expect(none).toBe(0);
  expect(full).toBeGreaterThan(5000);
  const rows: string[] = [];
  let previous = 0;
  for (const inflation of [0.2, 0.4, 0.6, 0.8]) {
    const area = (await count(`inflation=${inflation}`)) / full;
    rows.push(`${inflation}: ${area.toFixed(3)}`);
    expect(area).toBeGreaterThan(previous);
    expect(Math.abs(area - inflation)).toBeLessThan(0.12 * inflation + 0.02);
    previous = area;
  }
  console.log(`canopy area / full area by inflation (full canopies: ${full} px): ${rows.join(', ')}`);
});

test('plume volumes are hidden by this frame\'s geometry: a fast occluder shows no one-frame lag', async ({ page, pageLog }) => {
  await openLab(page, 'scene=engine&engine=atlas-9m&altkm=0&ev=14');
  // A slab 6 m in front of the jet (towards the camera), crossing it at 150 m/s: 2.5 m, about 60 px, per frame.
  await page.evaluate(() => {
    const lab = window.__vfx!;
    const t0 = lab.sim.time;
    lab.props.setOccluder({ size: [8, 14], yawDeg: 0, enu: (t: number) => ({ x: 6 + 150 * (t - t0), y: -6, z: 0 }) });
  });
  const result = await page.evaluate(async () => {
    const lab = window.__vfx!;
    const renderer = lab.app.renderer;
    const throttle = lab.scene.controls!.throttle!;
    const rowOf = async (): Promise<{ data: Float32Array; width: number; y: number }> => {
      const axis = lab.project({ x: 20, y: 0, z: 0 })!;
      const y = Math.round(axis.y);
      const px = await renderer.readHdrPixels('hdr', { x: 0, y, width: renderer.frameContext!.renderSize[0], height: 1 });
      return { data: px.data, width: px.width, y };
    };
    const frames: { covered: number; uncovered: number; signal: number; coveredPx: number; uncoveredPx: number }[] = [];
    let prevLeft = -1;
    for (let k = 0; k < 8; k++) {
      throttle(1);
      await lab.renderExact(1, true);
      const on = await rowOf();
      throttle(0);
      await lab.renderExact(1, false);
      const off = await rowOf();
      const centre = lab.props.occluderEnu()!;
      const left = lab.project({ x: centre.x - 4, y: -6, z: 0 })!.x;
      const right = lab.project({ x: centre.x + 4, y: -6, z: 0 })!.x;
      const diff = (x: number): number => Math.abs(on.data[x * 4]! - off.data[x * 4]!) + Math.abs(on.data[x * 4 + 1]! - off.data[x * 4 + 1]!) + Math.abs(on.data[x * 4 + 2]! - off.data[x * 4 + 2]!);
      let covered = 0;
      let coveredPx = 0;
      for (let x = Math.ceil(left) + 4; x <= Math.floor(right) - 4 && x < on.width; x++) {
        if (x < 0) continue;
        covered = Math.max(covered, diff(x));
        coveredPx++;
      }
      // Where the slab was one frame ago and is no longer: the jet must be back.
      let uncovered = Infinity;
      let uncoveredPx = 0;
      if (prevLeft >= 0) {
        for (let x = Math.ceil(prevLeft) + 4; x <= Math.floor(left) - 4; x++) {
          if (x < 0 || x >= on.width) continue;
          uncovered = Math.min(uncovered, diff(x));
          uncoveredPx++;
        }
      }
      let signal = 0;
      for (let x = 0; x < on.width; x++) signal = Math.max(signal, diff(x));
      frames.push({ covered, uncovered, signal, coveredPx, uncoveredPx });
      prevLeft = left;
    }
    lab.resume();
    return frames;
  });
  console.log(`occluder frames (largest plume signal on covered pixels / smallest on just-uncovered pixels / largest in the row): ${result.map((f) => `${f.covered.toExponential(1)} / ${Number.isFinite(f.uncovered) ? f.uncovered.toFixed(3) : '-'} / ${f.signal.toFixed(2)}`).join('; ')}`);
  const usable = result.filter((f) => f.coveredPx > 40);
  expect(usable.length).toBeGreaterThanOrEqual(4);
  for (const f of usable) {
    expect(f.signal).toBeGreaterThan(0.5);
    // Behind the slab of THIS frame there is no plume at all.
    expect(f.covered).toBeLessThan(0.002 * f.signal);
  }
  const reopened = result.filter((f) => f.uncoveredPx > 20);
  expect(reopened.length).toBeGreaterThanOrEqual(3);
  // ... and where the slab was a frame ago the jet is back at once: every pixel there differs by hundreds of
  // times what leaks through the slab.
  for (const f of reopened) {
    expect(f.uncovered).toBeGreaterThan(1);
    expect(f.uncovered).toBeGreaterThan(300 * Math.max(f.covered, 1e-3));
  }
  await expectNoErrors(page, pageLog);
});

/** Pixel with the largest single-channel difference between two screenshots of the same size. */
function largestDifference(a: Buffer, b: Buffer): { x: number; y: number; diff: number } {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  let best = { x: 0, y: 0, diff: 0 };
  for (let i = 0; i < pa.data.length; i++) {
    if ((i & 3) === 3) continue;
    const d = Math.abs(pa.data[i]! - pb.data[i]!);
    if (d > best.diff) best = { x: (i >> 2) % pa.width, y: Math.floor((i >> 2) / pa.width), diff: d };
  }
  return best;
}

test('half-resolution volumes are temporally stable under a static camera', async ({ page, pageLog }) => {
  // Live noise (not deterministic), effect clock stopped: what changes from frame to frame is march jitter only.
  for (const [name, query, t] of [
    ['engine', 'scene=engine&engine=atlas-9m&altkm=0&ev=14&governor=off&scale=1', null],
    ['pad', 'scene=pad&ev=13.5&governor=off&scale=1', 6.0],
  ] as const) {
    await openLab(page, query);
    if (t !== null) await page.evaluate((x) => window.__vfx!.runTo(x), t);
    await page.evaluate(() => window.__test!.setDeterministic(false));
    await page.evaluate(() => window.__test!.waitFrames(90));
    const shots: Buffer[] = [];
    for (let i = 0; i < 5; i++) {
      shots.push(await page.screenshot());
      await page.evaluate(() => window.__test!.waitFrames(3));
    }
    let mean = 0;
    let max = 0;
    let differing = 0;
    let where = { x: 0, y: 0, diff: 0 };
    for (let i = 1; i < shots.length; i++) {
      const d = pngDiff(shots[i - 1]!, shots[i]!);
      mean = Math.max(mean, d.meanAbsDiff);
      max = Math.max(max, d.maxAbsDiff);
      differing = Math.max(differing, d.differingFraction);
      const w = largestDifference(shots[i - 1]!, shots[i]!);
      if (w.diff > where.diff) where = w;
    }
    console.log(`${name}: frame-to-frame difference with a static camera: mean ${mean.toFixed(3)} / 255, max ${max} / 255 (at pixel ${where.x}, ${where.y}), ${(differing * 100).toFixed(1)} % of the channels differ`);
    expect(mean).toBeLessThan(0.5);
    expect(max).toBeLessThan(60);
    await expectNoErrors(page, pageLog);
  }
});
