/** Scratch diagnostics for the app integration (not committed). */
import { assertDiscreteGpu, openPage, test, waitIdle } from '../harness';

test.setTimeout(15 * 60_000);

test('probe: terrain CPU per frame at the pad (720p, idle)', async ({ page }) => {
  await openPage(page, '/?capture=0&mute=1', { timeoutMs: 240_000 });
  await assertDiscreteGpu(page);
  await waitIdle(page, 30, 240_000);
  const r = await page.evaluate(async () => {
    const rows: Record<string, number>[] = [];
    for (let i = 0; i < 240; i++) {
      await window.__test!.waitFrames(1);
      rows.push({ ...window.__app!.terrainStats().cpu });
    }
    const keys = Object.keys(rows[0]!);
    const out: Record<string, string> = {};
    for (const k of keys) {
      const v = rows.map((x) => x[k]!).sort((a, b) => a - b);
      out[k] = `p50 ${v[120]!.toFixed(2)} p95 ${v[228]!.toFixed(2)} max ${v[239]!.toFixed(2)}`;
    }
    const cpu = window.__app!.cpu();
    return { terrain: out, frame: cpu.frame, render: cpu.stages.render, perf: window.__test!.perf()!.features };
  });
  console.log(JSON.stringify(r, null, 1));
});
