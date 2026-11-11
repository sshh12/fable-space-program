/**
 * Check (g): THE SUMMED GPU BUDGET of ARCHITECTURE 17.1, at every checkpoint for which a scene exists, with
 * every render package that is in the tree, in perf attribution mode (each feature hook in its own pass)
 * at 1440p internal resolution with the governor off (qualityScale 1, render scale 1), under the GPU lock.
 *
 * Output: out/core-support/budget.json and budget.md (the table of the hand-off): measured p99 GPU ms per
 * package against the sum of its lines, per pass, and the frame total against 11 ms.
 *
 * Method (docs/handoff/render-core.md 4.1): an RTX 5090 with only part of the game's frame to render clocks
 * down and every pass reads 2-5 times too long. While packages are missing, a ballast pass (feature
 * lab-heavy) fills the frame up to about 9 ms of GPU work; its own time is excluded from every sum.
 *
 * Asserted: each loaded package stays within the sum of its lines, and the frame within 11 ms once every
 * package is loaded. Lines of packages that are not loaded are reported as "absent".
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

/**
 * Lab query of each checkpoint: the FakeSim scene with the real vehicle as it flies that part of the mission
 * (the lab stages it), the throttle, and the chase camera (yaw, pitch in degrees, distance in metres).
 */
const SCENES: Record<Checkpoint, { query: string; cockpit?: boolean }> = {
  // Engines lit and clamps released on the pad: the whole stack, the site, the deluge and the plume.
  'pad lift-off': { query: 'scene=pad&stage=1&throttle=1&orbit=35,8,160' },
  'ascent 10-40 km': { query: 'scene=ascent&throttle=1&orbit=200,-20,180' },
  LEO: { query: 'scene=lowOrbit&orbit=30,15,60' },
  'LEO cockpit': { query: 'scene=lowOrbit', cockpit: true },
  'lunar descent': { query: 'scene=lunarSurface&throttle=0.4&orbit=40,12,45' },
  reentry: { query: 'scene=reentry&orbit=160,10,30' },
  splashdown: { query: 'scene=chutes&orbit=30,5,60' },
};

interface Row {
  checkpoint: Checkpoint;
  loaded: FeaturePackage[];
  /** p99 GPU ms per package (its feature ids summed), 'core' and 'ui'. */
  measured: Record<string, number>;
  /** Budget per package at this checkpoint (sum of its lines). */
  budget: Record<string, number>;
  frame: { p50: number; p99: number; withoutBallast: number };
  ballastMs: number;
  passes: Record<string, { p50: number; p99: number; mean: number }>;
  qualityScale: number;
  renderScale: number;
}

for (const [index, checkpoint] of CHECKPOINTS.entries()) {
  test(`summed GPU budget: ${checkpoint}`, async ({ page, pageLog }) => {
    test.setTimeout(40 * 60_000);
    let info!: LabInfo;
    const row = await withGpuLock(async (): Promise<Row> => {
      const scene = SCENES[checkpoint];
      info = await openIntegration(page, `${scene.query}&hud=0&perf=features&scale=1&governor=off&ballast=1`);
      if (scene.cockpit) expect(await page.evaluate(() => window.__integration!.sitInCockpit(8, 2)), 'the vehicle has a cockpit seat to sit in').toBe(true);
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
      const m = await page.evaluate(async () => {
        await window.__test!.waitFrames(90);
        window.__test!.resetPerf();
        await window.__test!.waitFrames(330);
        const lab = window.__integration!;
        return { perf: window.__test!.perf()!, passes: lab.app.renderer.passStats(), packageOf: lab.packageOf };
      });

      const measured: Record<string, number> = {};
      for (const [id, v] of Object.entries(m.perf.features)) {
        if (id.startsWith('lab-')) continue; // backdrop and ballast are not part of the game's frame
        const pkg = id === 'core' ? 'core' : (m.packageOf[id] ?? `unattributed:${id}`);
        measured[pkg] = (measured[pkg] ?? 0) + v.gpuMs;
      }
      // The navball texture is rendered by the lab outside the frame graph: its line (0.05 ms) is proven by
      // tests/browser/flight-ui/hud.perf.spec.ts (0.008 ms) and the map overlay's by map-view.perf.spec.ts.
      const budget: Record<string, number> = {};
      for (const l of LINES) budget[l.pkg] = (budget[l.pkg] ?? 0) + l.ms[index]!;
      const ballastMs = (m.passes['lab-heavy.burn']?.p50 ?? 0) + (m.passes['lab-heavy.tail']?.p50 ?? 0);
      const labMs = Object.entries(m.perf.features)
        .filter(([id]) => id.startsWith('lab-'))
        .reduce((a, [, v]) => a + v.gpuMs, 0);
      return {
        checkpoint,
        loaded: info.loaded,
        measured,
        budget,
        frame: { p50: m.perf.gpu.p50, p99: m.perf.gpu.p99, withoutBallast: m.perf.gpu.p99 - labMs },
        ballastMs,
        passes: m.passes,
        qualityScale: m.perf.qualityScale,
        renderScale: m.perf.renderScale,
      };
    });
    writeTable(row);
    console.log(`[budget ${checkpoint}] loaded ${row.loaded.join(', ') || 'none'}; ${Object.entries(row.measured).map(([k, v]) => `${k} ${v.toFixed(3)} / ${(row.budget[k] ?? 0).toFixed(2)}`).join(', ')}; frame p99 ${row.frame.withoutBallast.toFixed(2)} ms without the ballast (${row.ballastMs.toFixed(1)} ms)`);

    expect(row.qualityScale).toBe(1);
    expect(row.renderScale).toBe(1);
    const over: string[] = [];
    for (const [pkg, ms] of Object.entries(row.measured)) {
      const limit = row.budget[pkg];
      if (limit === undefined) over.push(`${pkg}: ${ms.toFixed(3)} ms has no line in the table`);
      else if (ms > limit + 1e-9) over.push(`${pkg} (${pkg in PACKAGE_OWNER ? PACKAGE_OWNER[pkg as FeaturePackage] : pkg}): ${ms.toFixed(3)} ms against ${limit.toFixed(2)} ms`);
    }
    const all: FeaturePackage[] = ['terrain', 'vehicle', 'cockpit', 'ocean', 'sky', 'atmosphere', 'vfx'];
    if (all.every((p) => row.loaded.includes(p)) && row.frame.withoutBallast > FRAME_BUDGET_MS) over.push(`frame: ${row.frame.withoutBallast.toFixed(2)} ms against ${FRAME_BUDGET_MS} ms`);
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
    kept = JSON.parse(fs.readFileSync(path.join(dir, 'budget.json'), 'utf8')) as Row[];
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
        const limit = (r.budget[p] ?? 0).toFixed(2);
        if (p === 'ui') return `0.008 (own spec) / ${limit}`;
        const present = p === 'core' || r.loaded.includes(p as FeaturePackage);
        if (!present) return `absent / ${limit}`;
        const ms = r.measured[p] ?? 0;
        return `${ms > (r.budget[p] ?? 0) ? '**' : ''}${ms.toFixed(3)}${ms > (r.budget[p] ?? 0) ? '**' : ''} / ${limit}`;
      });
      return `| ${p}${p in PACKAGE_OWNER ? ` (${PACKAGE_OWNER[p as FeaturePackage]})` : ''} | ${cells.join(' | ')} |`;
    })
    .join('\n');
  const sum = `| **Frame p99 without the ballast** (budget ${FRAME_BUDGET_MS}) | ${rows.map((r) => `${r.frame.withoutBallast.toFixed(2)} (ballast ${r.ballastMs.toFixed(1)})`).join(' | ')} |`;
  fs.writeFileSync(path.join(dir, 'budget.md'), `Measured p99 GPU ms / budget, 2560 x 1440 internal, qualityScale 1, attribution mode.\n\n${head}\n${body}\n${sum}\n`);
  record('budget', { rows: rows.map((r) => ({ checkpoint: r.checkpoint, loaded: r.loaded, measured: r.measured, budget: r.budget, frame: r.frame, ballastMs: r.ballastMs })) });
}
