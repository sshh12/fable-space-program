/**
 * Reference images of ARCHITECTURE 31.3: recording (the lead's act) and the self-check of what is recorded.
 *
 * RECORD (the lead, on the visually signed-off tree, immediately before sub-wave 3.2):
 *
 *   BASELINE_RECORD="<who, when, why>" node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baselines.record.spec.ts --project=functional
 *
 * records every checkpoint of tests/browser/baselines.manifest.json that has a page (BASELINE_ONLY=a,b
 * limits it to the named ones; a checkpoint that is already recorded is re-recorded only when it is named
 * there): two fresh loads, the first capture into data/baselines/<name>.png, the tolerance three times the
 * difference between the two (at least the manifest's floor), the note into the manifest. The lead then
 * LOOKS at every PNG, commits the manifest and keeps a copy of data/baselines outside the working tree.
 * A checkpoint whose `page` is null is framed first (the lab parameters are in labs/integration/main.ts).
 *
 * SELF-CHECK (without BASELINE_RECORD; part of the functional project): every recorded checkpoint is
 * captured once more, from a fresh load, and must compare clean against its own reference. Skipped while
 * nothing is recorded or data/baselines is not on this machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDiscreteGpu, describeComparison, expectBaseline, openPage, readBaselineManifest, recordBaseline, test } from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifest = readBaselineManifest();
const note = process.env.BASELINE_RECORD ?? '';
const only = (process.env.BASELINE_ONLY ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
const [width, height] = manifest.viewport;

test.use({ viewport: { width, height }, deviceScaleFactor: 1 });

test.describe('reference images: record', () => {
  test.skip(note === '', 'recording is the lead\'s act: BASELINE_RECORD="<signed note>"');
  for (const [name, c] of Object.entries(manifest.checkpoints)) {
    const wanted = only.length > 0 ? only.includes(name) : c.status !== 'recorded';
    if (!wanted) continue;
    test(`record ${name}`, async ({ page }) => {
      test.setTimeout(15 * 60_000);
      test.skip(c.page === null, `${name} has no page yet: frame it in the manifest first (${c.what})`);
      const { entry, selfDifference } = await recordBaseline(
        page,
        name,
        async (p) => {
          await openPage(p, c.page!, { timeoutMs: 180_000 });
          await assertDiscreteGpu(p);
        },
        { note },
      );
      console.log(`[baseline] ${name}: recorded ${entry.file} (${entry.width} x ${entry.height}, sha256 ${entry.sha256!.slice(0, 16)}); two recordings differ by mean ${selfDifference.meanAbs.toFixed(5)}, p99.9 ${selfDifference.p999}; tolerance mean ${entry.tolerance!.meanAbs.toFixed(5)}, p99.9 ${entry.tolerance!.p999}`);
    });
  }
});

test.describe('reference images: every recorded checkpoint compares clean against itself', () => {
  test.skip(note !== '', 'not while recording');
  const recorded = Object.entries(manifest.checkpoints).filter(([, c]) => c.status === 'recorded');
  const present = fs.existsSync(path.join(repoRoot, manifest.dir));
  test('the recorded set', async ({ page }) => {
    test.skip(recorded.length === 0, 'no checkpoint is recorded yet (the lead records the set before sub-wave 3.2)');
    test.skip(!present, `${manifest.dir} is not on this machine`);
    test.setTimeout(recorded.length * 5 * 60_000);
    for (const [name, c] of recorded) {
      await openPage(page, c.page!, { timeoutMs: 180_000 });
      await assertDiscreteGpu(page);
      const result = await expectBaseline(page, name);
      console.log(`[baseline] ${describeComparison(result)}`);
      await page.goto('about:blank');
    }
  });
});
