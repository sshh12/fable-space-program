/**
 * Check (g): THE SUMMED GPU BUDGET of ARCHITECTURE 17.1, at every checkpoint for which a scene exists, with
 * every render package that is in the tree, in perf attribution mode (each feature hook in its own pass)
 * at 1440p internal resolution with the governor off (qualityScale 1, render scale 1), under the GPU lock.
 *
 * Output: out/core-support/budget.json and budget.md (the table of the hand-off): measured p99 GPU ms per
 * package against the sum of its lines, per pass, and the frame total against 11 ms.
 *
 * Scenes: the FakeSim flies the real vehicle as it is at that point of the mission, standing on the real
 * terrain (the stack on the launch mount with its engines lit, the lander hovering over the landing target
 * under a low sun, the capsule under its canopies at the water), framed so that what the checkpoint is about
 * is in the picture (stack and plume, cabin, plasma sheath). Every picture is saved and looked at.
 *
 * Method (docs/handoff/render-core.md 4.1): an RTX 5090 with only part of the game's frame to render clocks
 * down and every pass reads 2-5 times too long, so a ballast pass (feature lab-heavy) fills the frame up to
 * about 9 ms of GPU work; its own time is excluded from every sum. Timestamp queries of single frames are
 * disturbed by whatever else uses the GPU (another browser, the compositor): one hitch of 2 ms in a window
 * of 240 frames IS that window's p99. Each number is therefore the MEDIAN over six windows of 240 frames of
 * the window's p99 (the way the ocean, atmosphere and vfx specs measure their own lines); the largest
 * window is kept in the JSON.
 *
 * Asserted: each loaded package stays within the sum of its lines, and the frame (the sum of the packages'
 * p99s: an upper bound of the frame's p99) within 11 ms once every package is loaded. A package with no
 * line at a checkpoint (0 ms) is reported, not asserted, while it stays under UNBUDGETED_MS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, withGpuLock } from '../harness';
import { expectClean, openIntegration, PACKAGE_OWNER, record, repoRoot, save, settle, type FeaturePackage, type LabInfo } from './helpers';

test.use({ viewport: { width: 2560, height: 1440 } });

const CHECKPOINTS = ['pad lift-off', 'ascent 10-40 km', 'LEO', 'LEO cockpit', 'lunar descent', 'reentry', 'splashdown'] as const;
type Checkpoint = (typeof CHECKPOINTS)[number];

/** ARCHITECTURE 17.1, one row per line, values per checkpoint in the order of CHECKPOINTS (ms, p99). */
const LINES: { line: string; pkg: FeaturePackage | 'core' | 'ui'; ms: number[] }[] = [
  { line: 'Core fixed (AO, lighting, TAA, bloom, tonemap, copies)', pkg: 'core', ms: [3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0] },
  { line: 'Terrain G-buffer incl. far water sheet', pkg: 'terrain', ms: [1.5, 1.5, 1.5, 1.0, 1.8, 1.2, 1.5] },
  { line: 'Terrain shadow casting (amortised)', pkg: 'terrain', ms: [0.5, 0.5, 0.4, 0.3, 0.6, 0.4, 0.4] },
  { line: 'Rocks, G-buffer + shadow', pkg: 'terrain', ms: [0.15, 0, 0, 0, 0.3, 0, 0] },
  { line: 'Vehicle G-buffer', pkg: 'vehicle', ms: [0.8, 0.8, 0.6, 0.3, 0.5, 0.3, 0.3] },
  { line: 'Vehicle shadows', pkg: 'vehicle', ms: [0.4, 0.4, 0.3, 0.3, 0.3, 0.2, 0.2] },
  { line: 'Site structures, G-buffer + shadow', pkg: 'vehicle', ms: [0.5, 0.1, 0, 0, 0, 0, 0] },
  { line: 'Cockpit interior, glass, displays', pkg: 'cockpit', ms: [0, 0, 0, 1.2, 0, 0, 0] },
  { line: 'Atmosphere LUTs + march + composite + aerial volume', pkg: 'atmosphere', ms: [0.8, 0.9, 0.9, 0.9, 0, 0.9, 0.8] },
  { line: 'Clouds', pkg: 'atmosphere', ms: [0.9, 1.3, 1.3, 1.3, 0, 1.3, 1.2] },
  { line: 'Ocean FFT + near field', pkg: 'ocean', ms: [0.8, 0.3, 0.1, 0.1, 0, 0.1, 0.9] },
  { line: 'Sky background + probe + flare', pkg: 'sky', ms: [0.2, 0.2, 0.3, 0.3, 0.3, 0.2, 0.2] },
  { line: 'Plumes, smoke, particles, plasma, canopies', pkg: 'vfx', ms: [1.3, 1.0, 0.6, 0.6, 0.9, 1.2, 0.9] },
  { line: 'Navball; map overlay in map view', pkg: 'ui', ms: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1] },
];
const FRAME_BUDGET_MS = 11;
/** The navball texture (0.008 ms) and the map overlay (0.012 ms), measured by their own specs: added to the frame sum. */
const UI_MEASURED_MS = 0.02;
/** A package without a line at a checkpoint may cost this much before it is treated as over its (zero) budget. */
const UNBUDGETED_MS = 0.1;
const WINDOWS = 6;
const WINDOW_FRAMES = 240;

const landing = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'scenarios', 'lunar-direct.json'), 'utf8')) as { suggestedLanding: { bodyId: string; latDeg: number; lonDeg: number } }).suggestedLanding;

interface Scene {
  query: string;
  cockpit?: boolean;
  /**
   * Camera on the stack: yaw and pitch (deg), distance (m), and the point looked at, in metres along the
   * vessel's axis from the 'base' (its lowest point), the 'middle' or the 'origin' (the command part).
   */
  stack?: { yaw: number; pitch: number; distance: number; from: 'base' | 'middle' | 'origin'; along: number };
}

/** Lab query and camera of each checkpoint. */
const SCENES: Record<Checkpoint, Scene> = {
  // Engines lit and clamps released on the launch mount: the whole stack, the site, the smoke and the plume.
  'pad lift-off': { query: 'scene=pad&stage=1&throttle=1', stack: { yaw: 35, pitch: 8, distance: 190, from: 'middle', along: 0 } },
  // Climbing from 12 km at 350 m/s: the stack and 150 m of its plume.
  'ascent 10-40 km': { query: 'scene=ascent&start=12000&throttle=1', stack: { yaw: 200, pitch: -4, distance: 280, from: 'base', along: -20 } },
  LEO: { query: 'scene=lowOrbit&orbit=30,15,60' },
  // The commander's seat, looking at the panel (the view the cockpit package measures its own line in).
  'LEO cockpit': { query: 'scene=lowOrbit', cockpit: true },
  // The lander 12 m above the landing target on its descent engine, the sun 15 degrees up.
  'lunar descent': { query: `scene=lunarSurface&throttle=0.4&hover=12&sun=100,15&sunsite=${landing.bodyId},${landing.latDeg},${landing.lonDeg}&orbit=40,12,45` },
  reentry: { query: 'scene=reentry&orbit=160,10,30' },
  // The last 120 m under the three main canopies and the capsule at the water.
  splashdown: { query: 'scene=chutes&start=120', stack: { yaw: 30, pitch: 8, distance: 110, from: 'origin', along: 25 } },
};

interface Spread {
  /** Median, smallest and largest of the windows' values, ms. */
  median: number;
  min: number;
  max: number;
}

interface Row {
  checkpoint: Checkpoint;
  loaded: FeaturePackage[];
  /** p99 GPU ms per package (its feature ids summed), 'core': median over the windows. */
  measured: Record<string, number>;
  spread: Record<string, Spread>;
  /** Budget per package at this checkpoint (sum of its lines). */
  budget: Record<string, number>;
  /**
   * `sum` = the packages' p99s added up plus the UI lines (upper bound of the frame's p99); `typical` = the
   * frame's median GPU time less the lab's own passes.
   */
  frame: { sum: number; typical: number; p50WithBallast: number };
  ballastMs: number;
  /** Per pass: median over the windows of p50, mean and p99, ms. */
  passes: Record<string, { p50: number; p99: number; mean: number }>;
  qualityScale: number;
  renderScale: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : 0.5 * (s[(s.length - 1) >> 1]! + s[s.length >> 1]!);
};

for (const [index, checkpoint] of CHECKPOINTS.entries()) {
  test(`summed GPU budget: ${checkpoint}`, async ({ page, pageLog }) => {
    test.setTimeout(40 * 60_000);
    let info!: LabInfo;
    const row = await withGpuLock(async (): Promise<Row> => {
      const scene = SCENES[checkpoint];
      info = await openIntegration(page, `${scene.query}&hud=0&perf=features&scale=1&governor=off&ballast=1`);
      if (scene.cockpit) expect(await page.evaluate(() => window.__integration!.sitInCockpit(8, 2)), 'the vehicle has a cockpit seat to sit in').toBe(true);
      if (scene.stack) {
        await page.evaluate((c) => {
          const lab = window.__integration!;
          const e = lab.vesselExtent() ?? { yMin: 0, yMax: 0 };
          const from = c.from === 'base' ? e.yMin : c.from === 'middle' ? 0.5 * (e.yMin + e.yMax) : 0;
          lab.orbitVesselPoint(c.yaw, c.pitch, c.distance, from + c.along);
        }, scene.stack);
      }
      await settle(page, 120);
      expect(await page.evaluate(() => window.__lab!.renderer.frameContext!.renderSize)).toEqual([2560, 1440]);
      await save(page, `budget-${checkpoint.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);

      // Fill the frame up to about 9 ms with the ballast when the loaded features leave the GPU idle.
      const base = await page.evaluate(async () => {
        await window.__test!.waitFrames(60);
        window.__test!.resetPerf();
        await window.__test!.waitFrames(120);
        return window.__test!.perf()!.gpu.p50;
      });
      if (base < 8) {
        const perIteration = await page.evaluate(async () => {
          window.__integration!.setBallast(400);
          await window.__test!.waitFrames(90);
          window.__test!.resetPerf();
          await window.__test!.waitFrames(60);
          return (window.__lab!.renderer.passStats()['lab-heavy.burn']?.p50 ?? 0) / 400;
        });
        expect(perIteration).toBeGreaterThan(0);
        await page.evaluate((n) => window.__integration!.setBallast(n), Math.round((9 - Math.min(base, 3)) / perIteration));
      }
      const m = await page.evaluate(
        async ({ windows, frames }) => {
          const lab = window.__integration!;
          const out: { features: Record<string, number>; gpuP50: number; passes: Record<string, { p50: number; p99: number; mean: number }>; qualityScale: number; renderScale: number }[] = [];
          await window.__test!.waitFrames(90);
          for (let w = 0; w < windows; w++) {
            window.__test!.resetPerf();
            await window.__test!.waitFrames(frames);
            const perf = window.__test!.perf()!;
            out.push({
              features: Object.fromEntries(Object.entries(perf.features).map(([id, v]) => [id, v.gpuMs])),
              gpuP50: perf.gpu.p50,
              passes: lab.app.renderer.passStats(),
              qualityScale: perf.qualityScale,
              renderScale: perf.renderScale,
            });
          }
          return { windows: out, packageOf: lab.packageOf };
        },
        { windows: WINDOWS, frames: WINDOW_FRAMES },
      );
      await save(page, `budget-${checkpoint.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-end`);

      // Per window: p99 per package (its feature ids added up), the lab's own passes apart.
      const perWindow = m.windows.map((w) => {
        const pkg: Record<string, number> = {};
        let lab = 0;
        for (const [id, ms] of Object.entries(w.features)) {
          if (id.startsWith('lab-')) continue; // backdrop, ballast and probes are not part of the game's frame
          const p = id === 'core' ? 'core' : (m.packageOf[id] ?? `unattributed:${id}`);
          pkg[p] = (pkg[p] ?? 0) + ms;
        }
        for (const [name, s] of Object.entries(w.passes)) if (name.startsWith('lab-')) lab += s.p50;
        return { pkg, typical: w.gpuP50 - lab };
      });
      const names = [...new Set(perWindow.flatMap((w) => Object.keys(w.pkg)))];
      const measured: Record<string, number> = {};
      const spread: Record<string, Spread> = {};
      for (const p of names) {
        const xs = perWindow.map((w) => w.pkg[p] ?? 0);
        measured[p] = median(xs);
        spread[p] = { median: measured[p]!, min: Math.min(...xs), max: Math.max(...xs) };
      }
      const passNames = [...new Set(m.windows.flatMap((w) => Object.keys(w.passes)))];
      const passes: Row['passes'] = {};
      for (const name of passNames) {
        const of = (k: 'p50' | 'p99' | 'mean'): number => median(m.windows.map((w) => w.passes[name]?.[k] ?? 0));
        passes[name] = { p50: of('p50'), p99: of('p99'), mean: of('mean') };
      }
      const budget: Record<string, number> = {};
      for (const l of LINES) budget[l.pkg] = (budget[l.pkg] ?? 0) + l.ms[index]!;
      return {
        checkpoint,
        loaded: info.loaded,
        measured,
        spread,
        budget,
        frame: {
          sum: Object.values(measured).reduce((a, b) => a + b, 0) + UI_MEASURED_MS,
          typical: median(perWindow.map((w) => w.typical)) + UI_MEASURED_MS,
          p50WithBallast: median(m.windows.map((w) => w.gpuP50)),
        },
        ballastMs: (passes['lab-heavy.burn']?.p50 ?? 0) + (passes['lab-heavy.tail']?.p50 ?? 0),
        passes,
        qualityScale: Math.min(...m.windows.map((w) => w.qualityScale)),
        renderScale: Math.min(...m.windows.map((w) => w.renderScale)),
      };
    });
    writeTable(row);
    console.log(
      `[budget ${checkpoint}] loaded ${row.loaded.join(', ') || 'none'}; ${Object.entries(row.measured)
        .map(([k, v]) => `${k} ${v.toFixed(3)} (${row.spread[k]!.min.toFixed(3)}-${row.spread[k]!.max.toFixed(3)}) / ${(row.budget[k] ?? 0).toFixed(2)}`)
        .join(', ')}; frame: sum of the p99s ${row.frame.sum.toFixed(2)} ms, typical ${row.frame.typical.toFixed(2)} ms (ballast ${row.ballastMs.toFixed(1)} ms)`,
    );

    expect(row.qualityScale).toBe(1);
    expect(row.renderScale).toBe(1);
    const over: string[] = [];
    for (const [pkg, ms] of Object.entries(row.measured)) {
      const limit = row.budget[pkg];
      const owner = pkg in PACKAGE_OWNER ? PACKAGE_OWNER[pkg as FeaturePackage] : pkg;
      if (limit === undefined) over.push(`${pkg}: ${ms.toFixed(3)} ms has no line in the table`);
      else if (limit === 0 ? ms > UNBUDGETED_MS : ms > limit) over.push(`${pkg} (${owner}): ${ms.toFixed(3)} ms against ${limit.toFixed(2)} ms`);
      else if (limit === 0 && ms > 0.005) console.log(`  ${pkg} (${owner}) has no line at this checkpoint and costs ${ms.toFixed(3)} ms`);
    }
    const all: FeaturePackage[] = ['terrain', 'vehicle', 'cockpit', 'ocean', 'sky', 'atmosphere', 'vfx'];
    if (all.every((p) => row.loaded.includes(p)) && row.frame.sum > FRAME_BUDGET_MS) over.push(`frame: ${row.frame.sum.toFixed(2)} ms against ${FRAME_BUDGET_MS} ms`);
    expect(over, `${checkpoint}: over budget`).toEqual([]);
    await expectClean(page, pageLog, info);
  });
}

/**
 * out/core-support/budget.json and budget.md: the row just measured replaces the one of its checkpoint in
 * the file (a failed test restarts the worker, so the table is kept on disk, not in memory).
 */
function writeTable(row: Row): void {
  const dir = path.join(repoRoot, 'out', 'core-support');
  fs.mkdirSync(dir, { recursive: true });
  let kept: Row[] = [];
  try {
    kept = (JSON.parse(fs.readFileSync(path.join(dir, 'budget.json'), 'utf8')) as Row[]).filter((r) => r.spread !== undefined);
  } catch {
    kept = [];
  }
  const rows = CHECKPOINTS.map((c) => (c === row.checkpoint ? row : kept.find((r) => r.checkpoint === c))).filter((r): r is Row => r !== undefined);
  fs.writeFileSync(path.join(dir, 'budget.json'), JSON.stringify(rows, null, 2));
  const pkgs = ['core', 'terrain', 'vehicle', 'cockpit', 'atmosphere', 'ocean', 'sky', 'vfx', 'ui'];
  const head = `| Package (lines of 17.1 summed) | ${rows.map((r) => r.checkpoint).join(' | ')} |\n|---|${rows.map(() => '---').join('|')}|`;
  const body = pkgs
    .map((p) => {
      const cells = rows.map((r) => {
        const limit = r.budget[p] ?? 0;
        if (p === 'ui') return `${UI_MEASURED_MS.toFixed(3)} (own specs) / ${limit.toFixed(2)}`;
        const present = p === 'core' || r.loaded.includes(p as FeaturePackage);
        if (!present) return `absent / ${limit.toFixed(2)}`;
        const ms = r.measured[p] ?? 0;
        const over = limit === 0 ? ms > UNBUDGETED_MS : ms > limit;
        return `${over ? '**' : ''}${ms.toFixed(3)}${over ? '**' : ''} / ${limit.toFixed(2)}`;
      });
      return `| ${p}${p in PACKAGE_OWNER ? ` (${PACKAGE_OWNER[p as FeaturePackage]})` : ''} | ${cells.join(' | ')} |`;
    })
    .join('\n');
  const sum = `| **Sum of the p99s** (budget ${FRAME_BUDGET_MS}) | ${rows.map((r) => `**${r.frame.sum.toFixed(2)}**`).join(' | ')} |`;
  const typical = `| Frame median without the ballast | ${rows.map((r) => r.frame.typical.toFixed(2)).join(' | ')} |`;
  const note = `Measured p99 GPU ms / budget, 2560 x 1440 internal, qualityScale 1, attribution mode, ballast to about 9 ms per frame; each value is the median over ${WINDOWS} windows of ${WINDOW_FRAMES} frames of the window's p99.`;
  fs.writeFileSync(path.join(dir, 'budget.md'), `${note}\n\n${head}\n${body}\n${sum}\n${typical}\n`);
  record('budget', { rows: rows.map((r) => ({ checkpoint: r.checkpoint, loaded: r.loaded, measured: r.measured, spread: r.spread, budget: r.budget, frame: r.frame, ballastMs: r.ballastMs })) });
}
