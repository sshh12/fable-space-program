/**
 * The cockpit's acceptance views over the REAL world: the integration lab (labs/integration: terrain,
 * ocean, sky, atmosphere and clouds, the vehicle's exterior, vfx and the cockpit together, on the baked
 * tiles), from the commander's seat, at the exposure the renderer meters itself. Screenshots:
 * out/screens/cockpit/world-*.png. The cockpit lab's own views (views.spec.ts) use stand-ins for everything
 * outside the cabin and are functional evidence only (out/screens/cockpit/lab/).
 *
 * The recipes (sun, lights, camera) and what each picture must show are in world.ts. A view whose
 * preconditions are not met (a package of the scene not loaded, the floods not in the state the recipe
 * asks for) is SKIPPED with the reason, never passed: the picture would not be the one reviewed.
 */
import { PNG } from 'pngjs';
import { assertDiscreteGpu, assertRealImage, expect, openPage, saveScreenshot, test } from '../harness';
import { applyRecipe, settleWorld, WORLD_VIEWS, worldReport, type WorldChecks, type WorldReport } from './world';

test.use({ viewport: { width: 1600, height: 900 } });

const lum = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** Measure the saved picture against the view's checks; returns the failures (empty = all met). */
function measure(buf: Buffer, report: WorldReport, checks: WorldChecks): { failures: string[]; notes: string[] } {
  const png = PNG.sync.read(buf);
  const { width: W, height: H, data } = png;
  const failures: string[] = [];
  const notes: string[] = [];
  const all: number[] = [];
  let black = 0;
  for (let i = 0; i < W * H; i++) {
    const r = data[4 * i]!;
    const g = data[4 * i + 1]!;
    const b = data[4 * i + 2]!;
    if (r === 0 && g === 0 && b === 0) black++;
    if (i % 7 === 0) all.push(lum(r, g, b));
  }
  const frameMedian = median(all);
  notes.push(`frame median ${frameMedian.toFixed(1)}, exactly black ${((100 * black) / (W * H)).toFixed(1)} %`);
  if (checks.maxBlack !== undefined && black / (W * H) > checks.maxBlack) failures.push(`${((100 * black) / (W * H)).toFixed(1)} % of the pixels exactly black (at most ${100 * checks.maxBlack} %)`);
  /** The pane round a window's centre: a 41 x 41 px patch (screenshot pixels). */
  const patch = (id: string): { l: number[]; br: number } | null => {
    const c = report.windows[id];
    if (!c) return null;
    const x0 = Math.round((c.x * W) / report.renderSize[0]);
    const y0 = Math.round((c.y * H) / report.renderSize[1]);
    if (x0 < 20 || y0 < 20 || x0 >= W - 20 || y0 >= H - 20) return null;
    const l: number[] = [];
    const rs: number[] = [];
    const bs: number[] = [];
    for (let y = y0 - 20; y <= y0 + 20; y++) {
      for (let x = x0 - 20; x <= x0 + 20; x++) {
        const k = 4 * (y * W + x);
        l.push(lum(data[k]!, data[k + 1]!, data[k + 2]!));
        rs.push(data[k]!);
        bs.push(data[k + 2]!);
      }
    }
    return { l, br: median(bs) / Math.max(median(rs), 1) };
  };
  for (const id of checks.litPanes ?? []) {
    const p = patch(id);
    if (!p) {
      failures.push(`window ${id} is not in the frame`);
      continue;
    }
    const m = median(p.l);
    notes.push(`pane ${id}: median ${m.toFixed(1)}`);
    if (m <= frameMedian) failures.push(`the pane of ${id} (median ${m.toFixed(1)}) is not brighter than the frame (${frameMedian.toFixed(1)})`);
  }
  if (checks.unclippedPane) {
    const p = patch(checks.unclippedPane);
    if (!p) failures.push(`window ${checks.unclippedPane} is not in the frame`);
    else {
      const m = median(p.l);
      notes.push(`pane ${checks.unclippedPane}: median ${m.toFixed(1)}`);
      if (m >= 245) failures.push(`what the pane of ${checks.unclippedPane} shows is burnt out (median ${m.toFixed(1)})`);
    }
  }
  if (checks.neutralPane) {
    const p = patch(checks.neutralPane);
    if (!p) failures.push(`window ${checks.neutralPane} is not in the frame`);
    else {
      notes.push(`pane ${checks.neutralPane}: blue / red ${p.br.toFixed(3)}`);
      if (Math.abs(p.br - 1) > 0.1) failures.push(`what the pane of ${checks.neutralPane} shows is not neutral: blue / red ${p.br.toFixed(3)}`);
    }
  }
  return { failures, notes };
}

for (const v of WORLD_VIEWS) {
  test(`world screenshot ${v.name}`, async ({ page }) => {
    test.setTimeout(600_000);
    await openPage(page, `/labs/integration/?${v.query}&hud=0&paused=1`, { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    // Every scene package the tree has must be loaded (the lab switches off one that fails to build).
    const info = await page.evaluate(() => ({ available: window.__integration!.available as string[], loaded: window.__integration!.loaded as string[], problems: window.__integration!.problems }));
    const missing = info.available.filter((p) => !info.loaded.includes(p));
    test.skip(missing.length > 0, `the integration lab did not load ${missing.join(', ')}: ${info.problems.join('; ')}`);
    await page.evaluate(() => window.__test!.waitFrames(5));
    const placed = await applyRecipe(page, v.recipe);
    expect(placed.ok, placed.why).toBe(true);
    await settleWorld(page);
    const report = await worldReport(page);
    // Preconditions of the picture: nothing switched off while it settled, the floods as the recipe asks.
    const gone = info.available.filter((p) => !report.loaded.includes(p));
    test.skip(gone.length > 0, `switched off while settling: ${gone.join(', ')}`);
    if (v.recipe.lights !== undefined) expect(report.lightsOn, 'the floods are in the state the recipe asks for').toBe(v.recipe.lights);
    const shot = await saveScreenshot(page, 'cockpit', v.name);
    assertRealImage(shot.stats, v.name, v.checks.dark ? { minNonBlack: 0.05, minStd: 3, minBuckets: 20 } : { minNonBlack: 0.2, minStd: 6, minBuckets: 30 });
    const m = measure(shot.buffer, report, v.checks);
    console.log(`  ${v.name}: ev100 ${report.ev100.toFixed(2)}; plasma ${report.plasma.toFixed(2)}; lod ${report.stats.lod}, inside ${report.stats.inside}, sun in the cabin ${report.stats.sunLit}, covered windows [${(report.stats.covered ?? []).join(', ')}]; ${m.notes.join('; ')}`);
    expect(m.failures, m.failures.join('; ')).toEqual([]);
    // The cockpit drew the frame, at full detail when the eye is in the cabin, and the lab did not switch it off.
    expect(report.stats.active).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.errors).toEqual([]);
    if (v.recipe.seat || v.recipe.windowBelow !== undefined || v.recipe.free?.kind === 'interior') expect(report.stats.inside).toBe(true);
  });
}
