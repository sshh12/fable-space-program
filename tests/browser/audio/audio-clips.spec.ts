/**
 * Listen-proof: renders the eight 10 s scene clips offline through the real graph and writes them to
 * out/audio/<name>.wav, with peak / RMS / spectral centroid / band levels in out/audio/clips.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, test } from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outDir = path.join(repoRoot, 'out', 'audio');

test('records the listen-proof clips', async ({ page, pageLog }) => {
  test.setTimeout(480_000);
  await openPage(page, '/labs/audio/?scene=pad');
  await assertDiscreteGpu(page);
  await page.waitForFunction(() => window.__audioLab !== undefined);
  const names = await page.evaluate(() => window.__audioLab!.clipNames());
  expect(names).toEqual(['liftoff-pad', 'liftoff-cabin', 'max-q', 'staging', 'vacuum-burn-cabin', 'reentry', 'chute-deploy', 'splashdown']);
  fs.mkdirSync(outDir, { recursive: true });
  const stats: Record<string, unknown> = {};
  for (const name of names) {
    const c = await page.evaluate((n) => window.__audioLab!.clip(n), name);
    fs.writeFileSync(path.join(outDir, `${name}.wav`), Buffer.from(c.wav, 'base64'));
    stats[name] = { ...c.stats, renderMs: Math.round(c.renderMs) };
    expect(c.problems, name).toEqual([]);
    expect(c.stats.durationS, name).toBeCloseTo(10, 2);
    expect(c.stats.peak, name).toBeLessThan(0.98);
    expect(c.stats.rmsDbfs, name).toBeGreaterThan(-50);
  }
  fs.writeFileSync(path.join(outDir, 'clips.json'), JSON.stringify(stats, null, 2));
  await expectNoErrors(page, pageLog);
});
