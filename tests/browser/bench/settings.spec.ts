/**
 * Renderer.setQuality in real Chrome on the integration lab (capability-settings acceptance; `&withart=1`: the
 * library's vehicles without art are left out, request capability-settings-2):
 *  - Ultra is today's picture: a frame-exact capture of the reference checkpoint `pad-noon` is the same to
 *    the bit before any profile, with the Ultra preset applied, and again after Low and back to Ultra;
 *  - every declared setting through every level, then every preset, then back to Ultra: no GPU error and no
 *    leaked texture (live textures counted by label before and after; the counts are printed);
 *  - a 'rebuild' setting (shadows) is applied under the 1 s fade without a reload, and a live one on the
 *    next frame.
 * Pictures: out/screens/capability-settings/settings-*.png (looked at).
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/bench/settings.spec.ts --project=functional
 */
import type { QualityProfile } from '@/core/contracts/render';
import { captureDeterministic, expect, expectNoErrors, imageDifference, openPage, saveScreenshot, assertDiscreteGpu, test } from '../harness';
import { readBaselineManifest } from '../harness';

test.setTimeout(15 * 60_000);

const ULTRA: QualityProfile = { pixelCap: 3.7, renderScaleMin: 0.6, targetFps: 60, levels: {} };

test('Ultra is the picture of before: pad-noon frame-exact with no profile, with Ultra, and after Low and back', async ({ page, pageLog }) => {
  const cp = readBaselineManifest().checkpoints['pad-noon']!;
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPage(page, `${cp.page!}&withart=1`, { timeoutMs: 240_000 });
  await assertDiscreteGpu(page);
  const none = await captureDeterministic(page);
  const ids = await page.evaluate(() => window.__lab!.renderer.core.quality.settings().map((s) => s.setting.id));
  const all = (level: string): QualityProfile => ({ ...ULTRA, levels: Object.fromEntries(ids.map((id) => [id, level])) as QualityProfile['levels'] });
  await page.evaluate((p) => window.__lab!.renderer.setQuality!(p), all('ultra'));
  const ultra = await captureDeterministic(page);
  await page.evaluate((p) => window.__lab!.renderer.setQuality!({ ...p, pixelCap: 0.9, renderScaleMin: 0.5 }), all('low'));
  const low = await captureDeterministic(page);
  await page.evaluate((p) => window.__lab!.renderer.setQuality!(p), all('ultra'));
  const back = await captureDeterministic(page);
  const d1 = imageDifference(none, ultra);
  const d2 = imageDifference(none, back);
  const d3 = imageDifference(none, low);
  console.log(`[settings] pad-noon: Ultra vs none ${d1.differingFraction}, back vs none ${d2.differingFraction}, Low vs none ${d3.differingFraction.toFixed(4)} (mean ${d3.meanAbs.toFixed(3)})`);
  expect(d1.differingFraction).toBe(0);
  expect(d2.differingFraction).toBe(0);
  expect(d3.differingFraction).toBeGreaterThan(0);
  await saveScreenshot(page, 'capability-settings', 'settings-pad-noon-ultra');
  await expectNoErrors(page, pageLog);
});

test('every setting through every level and every preset: no GPU error, no leaked texture; rebuild under the fade', async ({ page, pageLog }) => {
  await page.addInitScript(() => {
    const live = new Map<GPUTexture, string>();
    (window as unknown as { __liveTextures: Map<GPUTexture, string> }).__liveTextures = live;
    const create = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (this: GPUDevice, d: GPUTextureDescriptor) {
      const t = create.call(this, d);
      live.set(t, d.label ?? '(no label)');
      return t;
    };
    const destroy = GPUTexture.prototype.destroy;
    GPUTexture.prototype.destroy = function (this: GPUTexture) {
      live.delete(this);
      return destroy.call(this);
    };
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await openPage(page, '/labs/integration/?scene=pad&sun=95,8&sunsite=earth,18.987556,-155.603239&throttle=1&hud=0&withart=1', { timeoutMs: 240_000 });
  await assertDiscreteGpu(page);
  await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: 180_000 });
  const count = (): Promise<Record<string, number>> =>
    page.evaluate(() => {
      const out: Record<string, number> = {};
      for (const label of (window as unknown as { __liveTextures: Map<GPUTexture, string> }).__liveTextures.values()) out[label] = (out[label] ?? 0) + 1;
      return out;
    });
  const before = await count();
  const settings = await page.evaluate(() => window.__lab!.renderer.core.quality.settings().map((s) => ({ id: s.setting.id, apply: s.setting.apply, levels: s.setting.levels.map((l) => l.name) })));
  expect(settings.map((s) => s.id).sort()).toEqual(['ambientOcclusion', 'atmosphere', 'clouds', 'effects', 'ocean', 'shadows', 'terrain']);
  const steps: string[] = [];
  for (const s of settings) {
    for (const level of s.levels) {
      const t0 = Date.now();
      await page.evaluate(([p]) => window.__lab!.renderer.setQuality!(p), [{ ...ULTRA, levels: { [s.id]: level } }] as const);
      const ms = Date.now() - t0;
      await page.evaluate(() => window.__test!.waitFrames(6));
      steps.push(`${s.id}=${level} ${ms} ms`);
      if (s.apply === 'rebuild' && level !== 'ultra') expect(ms, `${s.id} ${level}: the rebuild runs under the 1 s fade`).toBeGreaterThanOrEqual(900);
    }
  }
  for (const preset of ['low', 'medium', 'high', 'ultra'] as const) {
    const caps = { low: 0.9, medium: 1.6, high: 2.4, ultra: 3.7 };
    await page.evaluate(([p]) => window.__lab!.renderer.setQuality!(p), [{ ...ULTRA, pixelCap: caps[preset], levels: Object.fromEntries(settings.map((s) => [s.id, preset])) }] as const);
    await page.evaluate(() => window.__test!.waitFrames(30));
    await saveScreenshot(page, 'capability-settings', `settings-pad-liftoff-${preset}`);
    const scale = await page.evaluate(() => window.__perf!.renderScale);
    steps.push(`preset ${preset}: render scale ${scale.toFixed(3)}`);
  }
  await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: 180_000 });
  await page.evaluate(() => window.__test!.waitFrames(30));
  const after = await count();
  const diff: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if ((after[k] ?? 0) !== (before[k] ?? 0)) diff[k] = (after[k] ?? 0) - (before[k] ?? 0);
  const total = (c: Record<string, number>): number => Object.values(c).reduce((a, b) => a + b, 0);
  console.log(`[settings] ${steps.join('; ')}`);
  console.log(`[settings] live textures before ${total(before)}, after ${total(after)}; changed labels: ${JSON.stringify(diff)}`);
  expect(diff).toEqual({});
  await expectNoErrors(page, pageLog);
});
