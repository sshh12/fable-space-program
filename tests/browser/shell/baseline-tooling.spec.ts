/**
 * The reference-image tooling of tests/browser/harness.ts (ARCHITECTURE 31.3), lead-owned.
 *
 *  1. Always (no browser needed): the difference measure itself, on synthetic images: identical images, a
 *     faint change everywhere, a one-pixel-row change, a size mismatch; and the tracked manifest's shape.
 *  2. With BASELINE_TOOLING_PROOF=1 (the lead's proof, minutes of GPU): on a PROOF manifest under
 *     out/qa/baseline-proof/ (never the tracked one), for the checkpoints named in BASELINE_PROOF_CHECKPOINTS
 *     (default leo-day and translunar-earth): record from three fresh loads with the frame-exact capture
 *     (window.__test.renderExact, request lead-3: until the render core has it this part fails with that
 *     message, and nothing is recorded), derive the tolerance, compare one more capture
 *     (must be clean), then change one pixel row of that capture and compare again (must fail), and check
 *     that a modified reference file is refused.
 *
 *   BASELINE_TOOLING_PROOF=1 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baseline-tooling.spec.ts --project=functional
 *
 * Recording the real set into data/baselines is the lead's act (tests/browser/shell/baselines.record.spec.ts,
 * which says when). The first-capture rule, the setup steps and the manifest's validation need no browser
 * and are unit-tested by tools/dev/baseline-logic.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  captureReference,
  compareToBaseline,
  describeComparison,
  expect,
  expectBaseline,
  imageDifference,
  manifestProblems,
  openCheckpoint,
  readBaselineManifest,
  recordBaseline,
  test,
  type BaselineComparison,
  type BaselineManifest,
} from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// A checkpoint is opened at the manifest's viewport (openCheckpoint refuses any other size).
const [viewportWidth, viewportHeight] = readBaselineManifest().viewport;
test.use({ viewport: { width: viewportWidth, height: viewportHeight }, deviceScaleFactor: 1 });

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

  test('a comparison names what changed around it: tile sets, the Chrome version, the adapter', () => {
    const c: BaselineComparison = {
      name: 'leo-day', meanAbs: 0.5, p999: 9, maxAbs: 40, differingFraction: 0.2, width: W, height: H, tolerance: { meanAbs: 0.02, p999: 1 }, pass: false,
      dataChanged: ['moon d250015b4e1a23f8 -> 597c5d666b132450'],
      environmentChanged: ['chrome 157.0.8103.78 -> 158.0.8200.10', 'adapter nvidia RTX 5090 -> nvidia RTX 5090 (driver 620.10)'],
      actualFile: null, diffFile: null, leadIn: null,
    };
    const text = describeComparison(c);
    expect(text).toContain('SITE DATA CHANGED since the recording: moon d250015b4e1a23f8 -> 597c5d666b132450');
    expect(text).toContain('ENVIRONMENT CHANGED since the recording: chrome 157.0.8103.78 -> 158.0.8200.10, adapter nvidia RTX 5090 -> nvidia RTX 5090 (driver 620.10)');
    expect(describeComparison({ ...c, dataChanged: [], environmentChanged: [] })).not.toMatch(/CHANGED/);
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
    // Every checkpoint is framed and can be captured frame-exactly (the rules are in baselineLogic.ts).
    expect(manifestProblems(m)).toEqual([]);
    for (const [name, c] of Object.entries(m.checkpoints)) {
      expect(c.page, name).not.toBeNull();
      if (c.status === 'recorded') {
        expect(c.sha256, name).toMatch(/^[0-9a-f]{64}$/);
        expect(c.tolerance!.meanAbs, name).toBeGreaterThanOrEqual(m.floor.meanAbs);
        expect(c.tolerance!.p999, name).toBeGreaterThanOrEqual(m.floor.p999);
        // At least three times the largest difference between any two of its loads, of which there are three or more.
        expect(c.loads, name).toBeGreaterThanOrEqual(3);
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

test.describe('reference images: record from three loads, compare one more capture, catch one pixel row', () => {
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
      proof.checkpoints[n] = { what: c.what, page: c.page, frames: c.frames, status: 'pending', ...(c.setup ? { setup: c.setup } : {}) };
    }
    fs.writeFileSync(manifestFile, `${JSON.stringify(proof, null, 1)}\n`);
  });

  for (const name of names) {
    test(`${name}`, async ({ page }) => {
      test.setTimeout(15 * 60_000);
      const store = { manifestFile };
      const open = async (p: typeof page): Promise<void> => {
        await openCheckpoint(p, name, store);
      };

      // Record from three fresh loads; the tolerance comes from the largest difference between any two.
      const { entry, selfDifference, loads } = await recordBaseline(page, name, open, { ...store, note: 'tooling proof by lead-baseline-v2 (not a reference of the game)' });
      expect(loads).toBeGreaterThanOrEqual(3);
      console.log(`[baseline proof] ${name}: ${loads} loads differ by at most mean ${selfDifference.meanAbs.toFixed(5)}, p99.9 ${selfDifference.p999}, max ${selfDifference.maxAbs} (${(selfDifference.differingFraction * 100).toFixed(3)} % of pixels); tolerance mean ${entry.tolerance!.meanAbs.toFixed(5)}, p99.9 ${entry.tolerance!.p999}`);
      expect(entry.tolerance!.meanAbs).toBeGreaterThanOrEqual(3 * selfDifference.meanAbs);
      expect(entry.tolerance!.p999).toBeGreaterThanOrEqual(3 * selfDifference.p999);

      // A third capture, from a third fresh load, compares clean.
      await page.goto('about:blank');
      await open(page);
      const third = (await captureReference(page, entry.frames, name)).image;
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
