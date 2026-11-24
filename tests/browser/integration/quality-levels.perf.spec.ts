/**
 * The quality steps, measured and looked at (capability-settings: the table of quality steps of the
 * hand-off; "each feature's predicted cost per level within 25 % of measured on the reference GPU").
 *
 * Six scenes of the integration lab at 2560 x 1440, every package, attribution mode, the governor off, the
 * budget runs' end ballast filling the Ultra frame to about 9 ms (render-core.md 4.1; excluded from every
 * number):
 *  - every scene at the four presets: a picture each (and a 2 x 2 sheet per scene,
 *    out/screens/capability-settings/levels-<scene>.png, looked at) and the GPU per budget package;
 *  - at the lift-off and the splashdown every setting through its levels with everything else at Ultra, and
 *    at the lift-off the pixel caps at Ultra levels: the mean ms of each cost group (src/bench attribution),
 *    from which the cost models' ratios and exponents come.
 * Output: out/capability-settings/levels.json (with RUN_TAG: levels-<tag>.json, for a second run that checks
 * the predictions of the first).
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/quality-levels.perf.spec.ts --project=perf
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type { QualityProfile } from '@/core/contracts/render';
import { passAssigner, parseQualityTable } from '@/bench';
import { expect, test, withGpuLock } from '../harness';
import { expectClean, openIntegration, repoRoot } from './helpers';

test.use({ viewport: { width: 2560, height: 1440 } });
test.setTimeout(60 * 60_000);

const OUT = path.join(repoRoot, 'out', 'capability-settings');
const SCREENS = path.join(repoRoot, 'out', 'screens', 'capability-settings');
const table = parseQualityTable(JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'render', 'quality.json'), 'utf8')));
const PRESETS = ['low', 'medium', 'high', 'ultra'] as const;
const KA_LAE = 'sunsite=earth,18.987556,-155.603239';

interface Scene {
  id: string;
  query: string;
  setup?: (page: Page) => Promise<void>;
  sweep?: string[];
}
const SCENES: Scene[] = [
  { id: 'pad', query: `scene=pad&sun=95,8&${KA_LAE}` },
  { id: 'liftoff', query: `scene=pad&stage=1&throttle=1&sun=95,8&${KA_LAE}`, sweep: ['shadows', 'ambientOcclusion', 'clouds', 'atmosphere', 'terrain', 'effects'] },
  { id: 'leo', query: 'scene=lowOrbit&orbit=120,20,60', setup: async (p) => void (await p.evaluate(() => window.__integration!.setSunInVesselFrame({ x: 0, y: 1, z: 0 }))) },
  { id: 'lunar', query: 'scene=lunarSurface&throttle=0.4&hover=12&sun=100,15&sunsite=moon,0.661471,23.435999&orbit=40,12,45' },
  { id: 'splashdown', query: 'scene=chutes&start=120', sweep: ['clouds', 'atmosphere'] },
  { id: 'cockpit', query: 'sim=real&scenario=qa-leo', setup: async (p) => void (await p.evaluate(() => window.__integration!.sitInCockpit(0, 0))) },
];

interface Measured {
  renderScale: number;
  /** Mean ms per cost group (ballast excluded) and their sum. */
  groups: Record<string, number>;
  meanMs: number;
  /** p99 GPU ms per budget package (features grouped as the budget table does), ballast excluded. */
  packages: Record<string, number>;
}

async function measure(page: Page, profile: QualityProfile, settings: { featureId: string; setting: { id: string } }[]): Promise<Measured> {
  const raw = await page.evaluate(async (p) => {
    const r = window.__lab!.renderer;
    await r.setQuality!(p);
    r.setGovernor(false);
    await window.__test!.waitFrames(60);
    r.resetPerf();
    await window.__test!.waitFrames(240);
    return { stats: r.passStats(), features: window.__perf!.features, renderScale: window.__perf!.renderScale };
  }, profile);
  const assign = passAssigner(settings as never, table.attribution);
  const groups: Record<string, number> = {};
  for (const [name, s] of Object.entries(raw.stats)) {
    const g = assign(name);
    if (g !== null) groups[g] = (groups[g] ?? 0) + s.mean;
  }
  const packages: Record<string, number> = {};
  for (const [id, f] of Object.entries(raw.features)) {
    if (id === 'lab-ballast') continue;
    const pkg = id.startsWith('terrain') ? 'terrain' : id === 'site' ? 'vehicle' : id;
    packages[pkg] = (packages[pkg] ?? 0) + f.gpuMs;
  }
  return { renderScale: raw.renderScale, groups, meanMs: Object.values(groups).reduce((a, b) => a + b, 0), packages };
}

/** Four pictures as one 2 x 2 sheet at half size (box filter). */
function sheet(files: string[], out: string): void {
  const imgs = files.map((f) => PNG.sync.read(fs.readFileSync(f)));
  const w = imgs[0]!.width >> 1;
  const h = imgs[0]!.height >> 1;
  const dst = new PNG({ width: 2 * w, height: 2 * h });
  imgs.forEach((img, k) => {
    const ox = (k % 2) * w;
    const oy = (k >> 1) * h;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 4; c++) {
          const at = (yy: number, xx: number): number => img.data[(yy * img.width + xx) * 4 + c]!;
          const v = (at(2 * y, 2 * x) + at(2 * y, 2 * x + 1) + at(2 * y + 1, 2 * x) + at(2 * y + 1, 2 * x + 1)) / 4;
          dst.data[((oy + y) * 2 * w + ox + x) * 4 + c] = c === 3 ? 255 : v;
        }
  });
  fs.writeFileSync(out, PNG.sync.write(dst));
}

test('the quality steps: pictures and GPU per preset in six scenes, every setting level at the lift-off and the splashdown', async ({ page, pageLog }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SCREENS, { recursive: true });
  const tag = process.env.RUN_TAG ? `-${process.env.RUN_TAG}` : '';
  const result: Record<string, unknown> = { at: new Date().toISOString(), viewport: [2560, 1440], scenes: {} };
  const write = (): void => fs.writeFileSync(path.join(OUT, `levels${tag}.json`), JSON.stringify(result, null, 2));
  await withGpuLock(async () => {
    for (const scene of SCENES) {
      const info = await openIntegration(page, `${scene.query}&hud=0&perf=features&ballast=1&withart=1`, { timeoutMs: 240_000 });
      expect(info.quarantined).toEqual([]);
      await scene.setup?.(page);
      await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: 180_000 });
      const settings = await page.evaluate(() => window.__lab!.renderer.core.quality.settings().map((s) => ({ featureId: s.featureId, setting: { id: s.setting.id } })));
      const ids = settings.map((s) => s.setting.id);
      const preset = (name: (typeof PRESETS)[number]): QualityProfile => ({ pixelCap: table.presets[name].pixelCap, renderScaleMin: table.presets[name].renderScaleMin, targetFps: 60, levels: Object.fromEntries(ids.map((id) => [id, name])) });
      // The ballast fills the Ultra frame to about 9 ms.
      const base = await measure(page, preset('ultra'), settings);
      const iterations = await page.evaluate(async (fill) => {
        const lab = window.__integration!;
        const r = window.__lab!.renderer;
        let n = 64;
        for (let i = 0; i < 5; i++) {
          lab.setBallast(n);
          r.resetPerf();
          await window.__test!.waitFrames(60);
          const ms = r.passStats()['lab-ballast.overlay']?.p50 ?? 0;
          if (ms > 0) n = Math.max(1, Math.round((n * fill) / ms));
        }
        lab.setBallast(n);
        return n;
      }, Math.max(1, 9 - base.meanMs));
      const out: Record<string, unknown> = { ballastIterations: iterations, presets: {}, sweeps: {}, caps: {} };
      const files: string[] = [];
      for (const name of PRESETS) {
        const m = await measure(page, preset(name), settings);
        (out['presets'] as Record<string, Measured>)[name] = m;
        const file = path.join(SCREENS, `levels-${scene.id}-${name}${tag}.png`);
        fs.writeFileSync(file, await page.screenshot());
        files.push(file);
        console.log(`[levels] ${scene.id} ${name}: ${m.meanMs.toFixed(2)} ms mean (scale ${m.renderScale.toFixed(3)}) ${JSON.stringify(Object.fromEntries(Object.entries(m.packages).map(([k, v]) => [k, Number(v.toFixed(2))])))}`);
      }
      sheet(files, path.join(SCREENS, `levels-${scene.id}${tag}.png`));
      for (const id of scene.sweep ?? []) {
        const per: Record<string, Measured> = {};
        for (const level of PRESETS) per[level] = await measure(page, { ...preset('ultra'), levels: { ...preset('ultra').levels, [id]: level } }, settings);
        (out['sweeps'] as Record<string, unknown>)[id] = Object.fromEntries(PRESETS.map((l) => [l, { group: per[l]!.groups[id] ?? 0, meanMs: per[l]!.meanMs }]));
        console.log(`[levels] ${scene.id} ${id}: ${PRESETS.map((l) => `${l} ${(per[l]!.groups[id] ?? 0).toFixed(3)}`).join(', ')}`);
      }
      if (scene.id === 'liftoff') {
        for (const cap of table.solver.pixelCaps) {
          const m = await measure(page, { ...preset('ultra'), pixelCap: cap }, settings);
          (out['caps'] as Record<string, unknown>)[String(cap)] = { renderScale: m.renderScale, groups: m.groups, meanMs: m.meanMs };
          console.log(`[levels] liftoff cap ${cap}: scale ${m.renderScale.toFixed(3)}, mean ${m.meanMs.toFixed(2)} ms, fixed ${(m.groups['fixed'] ?? 0).toFixed(2)}`);
        }
      }
      (result['scenes'] as Record<string, unknown>)[scene.id] = out;
      write();
      await page.evaluate(() => window.__lab!.renderer.setQuality!({ pixelCap: 3.7, renderScaleMin: 0.6, targetFps: 60, levels: {} }));
      await expectClean(page, pageLog, info);
    }
  });
});
