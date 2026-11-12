/**
 * The frame-exact capture of the clouds with every package drawing (request core-4's acceptance): the
 * integration lab's low-orbit page, which is the lead's `leo-day` reference checkpoint
 * (tests/browser/baselines.manifest.json), captured on one page, again on the same page after another
 * history, and on two fresh loads. Asserted: the cloud buffers ('clouds.screen' and the cloud geometry)
 * are the same to the bit in all four, the exposure is the same, and the picture is inside the floor of the
 * reference manifest (mean 0.02, 99.9th percentile 1 level).
 *
 * The test skips itself while ANOTHER feature is busy where the frames of a capture begin (the core then
 * returns the capture as not idle and no picture can be taken: so it was with the terrain until the core
 * asked before the last restart, request atmosphere-clouds-13), and runs as soon as none is. The atmosphere
 * being busy there is a failure.
 *
 * A function, not a spec: `exact.spec.ts` defines the test with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, captureDeterministic, expect, imageDifference, openPage, test } from '../harness';

const FRAMES = 64;
export const INTEGRATED_LEO_DAY = '/labs/integration/?scene=lowOrbit&orbit=30,15,60&hud=0&governor=off&deterministic=1&paused=1';

interface Capture {
  png: Buffer;
  ev100: number;
  /** Hashes of the bits of the two half-resolution cloud buffers. */
  clouds: string;
}

async function capture(page: Page): Promise<Capture> {
  const png = await captureDeterministic(page, FRAMES, 240_000);
  const r = await page.evaluate(async () => {
    const atmosphere = window.__integration!.handles['atmosphere.createAtmosphereFeature'] as {
      debug: { clouds(): { readBuffers(): Promise<{ radiance: Float32Array; geometry: Float32Array }> } | null };
    };
    const buffers = await atmosphere.debug.clouds()!.readBuffers();
    const hash = (a: Float32Array): string => {
      const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
      let h = 2166136261;
      for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i]!, 16777619);
      return (h >>> 0).toString(16).padStart(8, '0');
    };
    return { ev100: window.__lab!.renderer.exposureInfo().ev100, clouds: `${hash(buffers.radiance)}:${hash(buffers.geometry)}` };
  });
  return { png, ...r };
}

export function defineIntegratedExact(): void {
  test('renderExact with every package, low orbit: the cloud buffers to the bit, the picture inside the floor of the references', async ({ page }) => {
    test.setTimeout(900_000);
    await openPage(page, INTEGRATED_LEO_DAY, { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    // Can this page be captured at all? One frame, and who was busy where it began.
    await page.waitForFunction(() => window.__test!.isIdle(), undefined, { timeout: 240_000 });
    const first = await page.evaluate(async () => {
      const held = await window.__test!.renderExact!(1);
      const info = window.__lab!.renderer.exactInfo();
      return { idle: held.idle, busyBefore: info?.busyBefore ?? [], busyAfter: info?.busyAfter ?? [], rounds: info?.rounds ?? 0 };
    });
    expect(first.busyBefore, 'the atmosphere is idle where the frames of a capture begin').not.toContain('atmosphere');
    const others = first.busyBefore.filter((id) => id !== 'atmosphere');
    if (others.length > 0) console.log(`[exact] integrated leo-day: NOT RUN, ${others.join(', ')} busy where the frames of a capture begin (lead-in rounds ${first.rounds}, busy after the frame: ${JSON.stringify(first.busyAfter)}): request atmosphere-clouds-13`);
    test.skip(others.length > 0, `${others.join(', ')} busy where the frames of a capture begin: no capture of this page is idle (request atmosphere-clouds-13)`);
    const a = await capture(page);
    // Another history on the same page: the hold ends, 91 animated frames pass, deterministic again.
    await page.evaluate(() => window.__test!.setDeterministic(false));
    await page.evaluate(() => window.__test!.waitFrames(91));
    await page.evaluate(() => window.__test!.setDeterministic(true));
    const b = await capture(page);
    await openPage(page, INTEGRATED_LEO_DAY, { timeoutMs: 240_000 });
    const c = await capture(page);
    await openPage(page, INTEGRATED_LEO_DAY, { timeoutMs: 240_000 });
    const d = await capture(page);

    const dir = path.join(process.cwd(), 'out', 'screens', 'atmosphere');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'exact-integrated-leo-day.png'), a.png);
    const compared = (
      [
        ['same-page', b],
        ['fresh-load', c],
        ['second-fresh-load', d],
      ] as const
    ).map(([tag, other]) => {
      const diff = imageDifference(a.png, other.png);
      if (diff.maxAbs > 0) fs.writeFileSync(path.join(dir, `exact-integrated-leo-day-${tag}.diff.png`), diff.diff);
      return { tag, ev100: other.ev100, clouds: other.clouds, meanAbs: diff.meanAbs, p999: diff.p999, maxAbs: diff.maxAbs, differing: diff.differingFraction };
    });
    console.log(
      `[exact] integrated leo-day (EV100 ${a.ev100}, cloud buffers ${a.clouds}): ${compared
        .map((x) => `${x.tag}: cloud buffers ${x.clouds === a.clouds ? 'identical' : `DIFFERENT (${x.clouds})`}, picture mean ${x.meanAbs.toFixed(5)}, p99.9 ${x.p999}, max ${x.maxAbs}, ${(100 * x.differing).toFixed(3)} % of pixels, EV100 ${x.ev100}`)
        .join('; ')}`,
    );
    for (const x of compared) {
      expect(x.ev100, `${x.tag}: exposure`).toBe(a.ev100);
      expect(x.clouds, `${x.tag}: the bits of the cloud buffers`).toBe(a.clouds);
      expect(x.meanAbs, `${x.tag}: mean difference of the picture, 8-bit levels`).toBeLessThanOrEqual(0.02);
      expect(x.p999, `${x.tag}: 99.9th percentile of the picture's difference`).toBeLessThanOrEqual(1);
    }
  });
}
