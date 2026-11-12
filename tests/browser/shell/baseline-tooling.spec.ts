/**
 * The reference-image tooling of tests/browser/harness.ts (ARCHITECTURE 31.3), lead-owned.
 *
 *  1. Always (no browser needed): the difference measure itself, on synthetic images: identical images, a
 *     faint change everywhere, a one-pixel-row change, a size mismatch; and the tracked manifest's shape.
 *  2. With BASELINE_TOOLING_PROOF=1 (the lead's proof, minutes of GPU): on a PROOF manifest under
 *     out/qa/baseline-proof/ (never the tracked one), for the checkpoints named in BASELINE_PROOF_CHECKPOINTS
 *     (default leo-day and translunar-earth): record twice, derive the tolerance, compare a third capture
 *     (must be clean), then change one pixel row of that capture and compare again (must fail), and check
 *     that a modified reference file is refused.
 *
 *   BASELINE_TOOLING_PROOF=1 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baseline-tooling.spec.ts --project=functional
 *
 * Recording the real set into data/baselines is the lead's act, done on the visually signed-off tree with
 * tests/browser/shell/baselines.record.spec.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  assertDiscreteGpu,
  captureDeterministic,
  compareToBaseline,
  describeComparison,
  expect,
  expectBaseline,
  imageDifference,
  openPage,
  readBaselineManifest,
  recordBaseline,
  test,
  type BaselineManifest,
} from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A width x height opaque image painted by `rgb(x, y)`. */
function image(width: number, height: number, rgb: (x: number, y: number) => [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgb(x, y);
      const i = (y * width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** The same image with `delta` added to the red channel of every pixel of row `y`. */
function withRowChanged(buf: Buffer, y: number, delta: number): Buffer {
  const png = PNG.sync.read(buf);
  for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4;
    const v = png.data[i]!;
    png.data[i] = v + delta <= 255 ? v + delta : v - delta;
  }
  return PNG.sync.write(png);
}

test.describe('reference images: the difference measure', () => {
  const W = 1280;
  const H = 720;
  const base = image(W, H, (x, y) => [(x * 7 + y * 3) % 256, (x + y * 5) % 256, (x * 2 + y) % 256]);

  test('identical images differ by nothing', () => {
    const d = imageDifference(base, base);
    expect(d).toMatchObject({ meanAbs: 0, p999: 0, maxAbs: 0, differingFraction: 0, width: W, height: H });
  });

  test('a faint change everywhere moves the mean, by exactly its size', () => {
    const faint = image(W, H, (x, y) => [((x * 7 + y * 3) % 256 < 255 ? ((x * 7 + y * 3) % 256) + 1 : 254), (x + y * 5) % 256, (x * 2 + y) % 256]);
    const d = imageDifference(base, faint);
    expect(d.meanAbs).toBeCloseTo(1 / 3, 6);
    expect(d.p999).toBe(1);
    expect(d.differingFraction).toBe(1);
  });

  test('one changed pixel row of 720 is above the 99.9th percentile, and barely moves the mean', () => {
    const d = imageDifference(base, withRowChanged(base, 360, 40));
    expect(d.differingFraction).toBeCloseTo(1 / H, 9);
    expect(d.p999).toBe(40);
    expect(d.maxAbs).toBe(40);
    expect(d.meanAbs).toBeCloseTo(40 / (3 * H), 6);
    // Half a row (0.069 % of the pixels) is below the percentile and still shows in the maximum and the mean.
    const half = PNG.sync.read(base);
    for (let x = 0; x < W / 2; x++) half.data[(360 * W + x) * 4 + 1] = (half.data[(360 * W + x) * 4 + 1]! + 90) % 256;
    const dh = imageDifference(base, PNG.sync.write(half));
    expect(dh.p999).toBe(0);
    expect(dh.maxAbs).toBeGreaterThan(0);
    expect(dh.meanAbs).toBeGreaterThan(0);
  });

  test('images of different size are refused', () => {
    expect(() => imageDifference(base, image(W, H - 1, () => [0, 0, 0]))).toThrow(/size mismatch/);
  });

  test('the tracked manifest lists the checkpoints of ARCHITECTURE 31.3 and is well formed', () => {
    const m = readBaselineManifest();
    expect(m.dir).toBe('data/baselines');
    expect(m.viewport).toEqual([1280, 720]);
    expect(m.floor.meanAbs).toBeGreaterThan(0);
    expect(m.floor.p999).toBeGreaterThan(0);
    const names = Object.keys(m.checkpoints);
    for (const expected of [
      'pad-noon', 'pad-sunset', 'ascent-cloud-deck', 'ascent-10km', 'ascent-40km', 'leo-day', 'leo-terminator', 'leo-night', 'leo-nadir-day', 'leo-nadir-night',
      'translunar-earth', 'translunar-moon', 'lunar-terminator-20000km', 'lunar-terminator-5000km', 'lunar-orbit-low-sun', 'lunar-touchdown', 'lunar-surface-cockpit',
      'reentry-peak-heating', 'parachute-descent', 'splashdown', 'shoreline', 'ocean-climb-2m', 'ocean-climb-200m', 'ocean-climb-20km', 'ocean-climb-400km',
    ]) expect(names).toContain(expected);
    for (const [name, c] of Object.entries(m.checkpoints)) {
      expect(c.what.length, name).toBeGreaterThan(10);
      expect(c.frames, name).toBeGreaterThanOrEqual(16);
      if (c.page !== null) expect(c.page, name).toMatch(/deterministic=1/);
      if (c.status === 'recorded') {
        expect(c.sha256, name).toMatch(/^[0-9a-f]{64}$/);
        expect(c.tolerance!.meanAbs, name).toBeGreaterThanOrEqual(m.floor.meanAbs);
        expect(c.tolerance!.p999, name).toBeGreaterThanOrEqual(m.floor.p999);
        // At least three times the difference between the two recordings.
        expect(c.tolerance!.meanAbs, name).toBeGreaterThanOrEqual(3 * c.selfDifference!.meanAbs);
        expect(c.tolerance!.p999, name).toBeGreaterThanOrEqual(3 * c.selfDifference!.p999);
        expect(c.recorded!.note.length, name).toBeGreaterThan(8);
        // The file is on this machine and is the recorded one, or the directory is absent (a fresh clone).
        const file = path.join(repoRoot, m.dir, c.file!);
        if (fs.existsSync(path.join(repoRoot, m.dir))) expect(fs.existsSync(file), `${name}: ${c.file} is missing from ${m.dir}`).toBe(true);
      }
    }
  });
});

test.describe('reference images: record twice, compare a third capture, catch one pixel row', () => {
  test.skip(!process.env.BASELINE_TOOLING_PROOF, 'the proof costs minutes of GPU: BASELINE_TOOLING_PROOF=1');
  const proofDir = path.join(repoRoot, 'out', 'qa', 'baseline-proof');
  const manifestFile = path.join(proofDir, 'manifest.json');
  const names = (process.env.BASELINE_PROOF_CHECKPOINTS ?? 'leo-day,translunar-earth').split(',').map((s) => s.trim());

  test.beforeAll(() => {
    fs.mkdirSync(proofDir, { recursive: true });
    const tracked = readBaselineManifest();
    const proof: BaselineManifest = { ...tracked, dir: path.relative(repoRoot, proofDir).replace(/\\/g, '/'), checkpoints: {} };
    for (const n of names) {
      const c = tracked.checkpoints[n];
      if (!c || c.page === null) throw new Error(`proof checkpoint ${n} has no page in the tracked manifest`);
      proof.checkpoints[n] = { what: c.what, page: c.page, frames: c.frames, status: 'pending' };
    }
    fs.writeFileSync(manifestFile, `${JSON.stringify(proof, null, 1)}\n`);
  });

  for (const name of names) {
    test(`${name}`, async ({ page }) => {
      test.setTimeout(15 * 60_000);
      const store = { manifestFile };
      const pageUrl = readBaselineManifest(store).checkpoints[name]!.page!;
      const open = async (p: typeof page): Promise<void> => {
        await openPage(p, pageUrl, { timeoutMs: 180_000 });
        await assertDiscreteGpu(p);
      };

      // Record twice (two fresh loads); the tolerance comes from their difference.
      const { entry, selfDifference } = await recordBaseline(page, name, open, { ...store, note: 'tooling proof by lead-baseline-v2 (not a reference of the game)' });
      console.log(`[baseline proof] ${name}: two recordings differ by mean ${selfDifference.meanAbs.toFixed(5)}, p99.9 ${selfDifference.p999}, max ${selfDifference.maxAbs} (${(selfDifference.differingFraction * 100).toFixed(3)} % of pixels); tolerance mean ${entry.tolerance!.meanAbs.toFixed(5)}, p99.9 ${entry.tolerance!.p999}`);
      expect(entry.tolerance!.meanAbs).toBeGreaterThanOrEqual(3 * selfDifference.meanAbs);
      expect(entry.tolerance!.p999).toBeGreaterThanOrEqual(3 * selfDifference.p999);

      // A third capture, from a third fresh load, compares clean.
      await page.goto('about:blank');
      await open(page);
      const third = await captureDeterministic(page, entry.frames);
      const clean = await expectBaseline(page, name, { ...store, capture: third });
      console.log(`[baseline proof] third capture: ${describeComparison(clean)}`);

      // One pixel row of that capture, changed by 48 levels in red, is caught.
      const planted = withRowChanged(third, Math.floor(entry.height! / 2), 48);
      const caught = await compareToBaseline(page, name, { ...store, capture: planted });
      console.log(`[baseline proof] one row changed: ${describeComparison(caught)}`);
      expect(caught.pass, 'a one-pixel-row change must fail the comparison').toBe(false);
      expect(caught.p999).toBeGreaterThan(entry.tolerance!.p999);
      expect(caught.diffFile !== null && fs.existsSync(caught.diffFile)).toBe(true);
      await expect(expectBaseline(page, name, { ...store, capture: planted })).rejects.toThrow(/reference image differs/);

      // A reference file that is not the recorded one is refused, whatever it shows.
      const file = path.join(proofDir, entry.file!);
      const original = fs.readFileSync(file);
      fs.writeFileSync(file, planted);
      await expect(compareToBaseline(page, name, { ...store, capture: third })).rejects.toThrow(/not the recorded one/);
      fs.writeFileSync(file, original);
      await expectBaseline(page, name, { ...store, capture: third });
    });
  }
});
