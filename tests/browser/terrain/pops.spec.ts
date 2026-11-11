import type { Page } from '@playwright/test';
import { expect, expectNoErrors, test } from '../harness';
import { LUNAR_SITE, PAD, openLab, settle, shot } from './util';

/**
 * LOD pop detector: scripted camera paths with the simulation frozen, one rendered frame per step. Every
 * frame is taken from the canvas as presented (half resolution) and compared with the previous one, as
 * a whole and in a 16 x 9 grid of blocks. A pop (a tile that appears
 * with other geometry, normals or colour than what it replaces; a shadow cascade that switches) is a
 * single frame in which a block changes much more than in the frames around it; a morph or a fade-in is
 * spread over twenty frames and does not stand out.
 *
 * Paths fall exponentially, 0.5 % of the height per frame, so the image zooms at a constant rate and the
 * difference between frames is nearly constant along a path: that is the baseline a spike is measured
 * against. Criteria (8-bit levels, mean over RGB):
 *   - BLOCK spike: a block's difference above SPIKE_FACTOR x the median of the same block over the 20
 *     frames around it + SPIKE_FLOOR. The control run (the same descent with geomorphing and fade-ins
 *     switched off) sets the scale: there, a tile that switches level changes its block by 5-25 levels in
 *     one frame against 0.5-6 around it (the worst at 9 x its local median after the floor); with morphing
 *     the worst block of the same descent stays below 2 x.
 *   - FRAME limit: the whole-image difference stays below ABS_LIMIT. It is dominated by the camera motion
 *     (1-10 levels, largest over the long crater shadows of the lunar morning from orbit), so this is a
 *     sanity bound, not the pop criterion.
 * The same paths are flown again with every tile delayed by 500 ms between the worker and the upload.
 */
const ABS_LIMIT = 16;
const SPIKE_FACTOR = 2.5;
const SPIKE_FLOOR = 1.5;
const BLOCKS = 16 * 9;

interface PathResult {
  diffs: number[];
  blocks: number[];
  queue: number[];
  deepest: number[];
}

interface Spike {
  frame: number;
  block: number;
  diff: number;
  local: number;
}

function analyse(r: PathResult): { max: number; median: number; worst: number; spikes: Spike[]; spikeFrames: number } {
  const sorted = [...r.diffs].sort((a, b) => a - b);
  const frames = r.diffs.length;
  const spikes: Spike[] = [];
  let worst = 0;
  const window: number[] = [];
  for (let b = 0; b < BLOCKS; b++) {
    for (let i = 0; i < frames; i++) {
      window.length = 0;
      for (let j = Math.max(0, i - 10); j < Math.min(frames, i + 11); j++) window.push(r.blocks[j * BLOCKS + b]!);
      window.sort((p, q) => p - q);
      const local = window[window.length >> 1]!;
      const d = r.blocks[i * BLOCKS + b]!;
      worst = Math.max(worst, (d - SPIKE_FLOOR) / Math.max(local, 0.05));
      if (d > SPIKE_FACTOR * local + SPIKE_FLOOR) spikes.push({ frame: i, block: b, diff: d, local });
    }
  }
  spikes.sort((p, q) => q.diff - q.local * SPIKE_FACTOR - (p.diff - p.local * SPIKE_FACTOR));
  return { max: sorted[frames - 1]!, median: sorted[frames >> 1]!, worst, spikes, spikeFrames: new Set(spikes.map((s) => s.frame)).size };
}

interface PathCase {
  name: string;
  body: 'earth' | 'moon';
  lat: number;
  lon: number;
  from: number;
  to: number;
  agl: boolean;
  heading: number;
  pitchFrom: number;
  pitchTo: number;
  sun: string;
  fov?: number;
  /** The path must cross a change of the deepest level drawn (else it tests no LOD transition). */
  levelChange?: boolean;
}

const rate = 0.005;
const framesFor = (from: number, to: number): number => Math.ceil(Math.log(from / to) / rate);

const CASES: PathCase[] = [
  { name: 'earth-descent', body: 'earth', lat: PAD.lat, lon: PAD.lon - 0.003, from: 400e3, to: 2, agl: true, heading: 20, pitchFrom: -75, pitchTo: -12, sun: '105,31' },
  { name: 'moon-descent', body: 'moon', ...LUNAR_SITE, from: 400e3, to: 2, agl: true, heading: 280, pitchFrom: -75, pitchTo: -12, sun: '92,11' },
  // Towards the terminator region under a low sun (8 degrees: long shadows), through the hand-over from the
  // whole-body shadow cascade to the camera-fitted cascades (they join at about 1,500 km) and through the
  // first level change below the relief floor (level 3 to 4 at about 650 km with this field of view at the
  // 720 lines the spec renders).
  { name: 'moon-approach', body: 'moon', lat: -20, lon: 60, from: 20_000e3, to: 450e3, agl: false, heading: 0, pitchFrom: -89.9, pitchTo: -89.9, sun: '90,8', fov: 40, levelChange: true },
];

async function fly(page: Page, c: PathCase): Promise<PathResult> {
  return page.evaluate(
    ([c, frames]) => window.__terrain!.flyPath({ bodyId: c.body, latDeg: c.lat, lonDeg: c.lon, from: c.from, to: c.to, agl: c.agl, headingDeg: c.heading, pitchFromDeg: c.pitchFrom, pitchToDeg: c.pitchTo, frames }),
    [c, framesFor(c.from, c.to)] as const,
  );
}

function queryOf(c: PathCase, extra: Record<string, string | number> = {}): Record<string, string | number> {
  const q: Record<string, string | number> = { scene: c.body === 'moon' ? 'lunarOrbit' : 'lowOrbit', paused: 1, deterministic: 1, body: c.body, lat: c.lat, lon: c.lon, alt: c.from, heading: c.heading, pitch: c.pitchFrom, sun: c.sun, ...extra };
  if (c.fov) q.fov = c.fov;
  return q;
}

const describeSpikes = (r: PathResult, spikes: Spike[]): string =>
  spikes
    .slice(0, 8)
    .map((s) => ` [frame ${s.frame} block ${s.block % 16},${Math.floor(s.block / 16)}: ${s.diff.toFixed(2)} vs ${s.local.toFixed(2)}, level ${r.deepest[s.frame]}, queue ${r.queue[s.frame]}]`)
    .join('');

test('the detector sees pops: a descent with geomorphing and fade-ins switched off', async ({ page, pageLog }) => {
  test.setTimeout(15 * 60_000);
  const c = CASES[1]!;
  await openLab(page, queryOf(c, { morph: 0 }));
  await settle(page, 30);
  const r = await fly(page, c);
  const a = analyse(r);
  console.log(`control (no morph), ${c.name}: ${a.spikes.length} block spikes in ${a.spikeFrames} frames, worst (block - floor) / local median ${a.worst.toFixed(2)};${describeSpikes(r, a.spikes)}`);
  // Measured: 5 block spikes in 5 frames, the worst block at 4.2 x its local median (25.3 against 6.1
  // levels); the same descent with morphing stays at 1.9 x. (With the smoother ground of the first material
  // sets the frames around a pop changed less: 15 spikes, the worst at 9 x.)
  expect(a.spikeFrames).toBeGreaterThanOrEqual(4);
  expect(a.worst).toBeGreaterThan(3.2);
  await expectNoErrors(page, pageLog);
});

for (const c of CASES) {
  for (const delay of [0, 500]) {
    test(`no LOD pops: ${c.name}${delay ? ', streaming delayed by 500 ms' : ''}`, async ({ page, pageLog }) => {
      test.setTimeout(15 * 60_000);
      await openLab(page, queryOf(c, delay ? { delay } : {}));
      await settle(page, 30);
      const r = await fly(page, c);
      const a = analyse(r);
      console.log(
        `${c.name}${delay ? ' +500 ms' : ''}: ${r.diffs.length} frames, whole-frame difference median ${a.median.toFixed(2)}, max ${a.max.toFixed(2)}; ` +
          `${a.spikes.length} block spike(s) in ${a.spikeFrames} frame(s), worst (block - floor) / local median ${a.worst.toFixed(2)};${describeSpikes(r, a.spikes)} ` +
          `largest queue ${Math.max(...r.queue)}, deepest level ${Math.max(...r.deepest)}`,
      );
      // The profile along the path (every 60th frame), for the record.
      console.log(`  profile: ${r.diffs.filter((_, i) => i % 60 === 0).map((d) => d.toFixed(2)).join(' ')}`);
      await shot(page, `pops-${c.name}${delay ? '-delayed' : ''}-end`);
      // The path exercises what it is there for: levels change along it.
      const levels = new Set(r.deepest);
      console.log(`  deepest level along the path: ${Math.min(...levels)}..${Math.max(...levels)}, first change at frame ${r.deepest.findIndex((l) => l !== r.deepest[0])} of ${r.deepest.length}`);
      expect(levels.size, 'distinct deepest levels along the path').toBeGreaterThan(c.levelChange ? 1 : 3);
      expect(a.max, 'largest whole-frame difference').toBeLessThan(ABS_LIMIT);
      expect(a.spikes.length, 'single-frame block spikes').toBe(0);
      await expectNoErrors(page, pageLog);
    });
  }
}
