/**
 * Reference images of ARCHITECTURE 31.3: recording (the lead's act) and the self-check of what is recorded.
 *
 * WHEN (lead decision of 2026-11-12): the references are recorded on the tree AS IT STANDS before sub-wave
 * 3.2, not on a visually signed-off tree. Their job is to be the regression gate of the presentation sweep,
 * a refactor that must not move a pixel. The visual close-out goes on after the sweep; every change that is
 * meant to move pixels (the display curve of request ocean-10, a visual fix) re-records the checkpoints it
 * touches with a lead note, as ARCHITECTURE 31.3 allows.
 *
 * RECORD, every checkpoint in ONE gate run:
 *
 *   BASELINE_RECORD="<who, when, why>" node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baselines.record.spec.ts --project=functional
 *
 * records every checkpoint of tests/browser/baselines.manifest.json that is not recorded yet (BASELINE_ONLY=a,b
 * limits it to the named ones; a checkpoint that is already recorded is re-recorded only when it is named
 * there). Per checkpoint: three fresh loads, each opened with openCheckpoint (its page, then its setup
 * steps) and captured under the FIRST-CAPTURE RULE (request core-7): a lead-in frame-exact capture that is
 * thrown away, then two that must be identical to the bit; the second is the load's capture. A checkpoint
 * that is not frame-exact FAILS as such, with the number of differing pixels, and nothing is recorded for
 * it. The first load's capture goes into data/baselines/<name>.png, the tolerance is three times the largest
 * difference between any two loads (at least the manifest's floor), the note goes into the manifest. A
 * checkpoint whose loads are one picture to the bit is marked `exact` (lead decision of 2026-11-12): a
 * comparison of it passes only when NO pixel differs. One whose loads differ is compared within its
 * tolerance and must carry `notExact` in the manifest: the reason in one line and the request to the owner
 * (the lead writes it; tools/dev/baseline-logic.test.ts fails on the tracked manifest until it is there).
 * The lead then LOOKS at every PNG (a baseline of a broken picture is worthless), commits the manifest and
 * keeps a copy of data/baselines outside the working tree.
 *
 * SELF-CHECK, which is also THE GATE of a refactor that must not move a pixel (without BASELINE_RECORD;
 * part of the functional project): every recorded checkpoint (BASELINE_ONLY=a,b: the named ones) is opened
 * once more, from a fresh load, and must compare clean against its own reference. Every one is compared,
 * whatever the one before it did; the test fails at the end with the list of those that differ or are not
 * frame-exact. Skipped while nothing is recorded or data/baselines is not on this machine.
 *
 * AN EXACT CHECKPOINT GETS UP TO THREE LOADS (BASELINE_EXACT_TRIES) and passes when one of them is its
 * reference to the bit. The reason is a finding of 2026-11-16 (request lead-9): on one and the same tree a
 * picture with the far sea under the horizon ends, about one load in eight, with a thin line of that sea
 * drawn differently; with some nine such pictures in the set, a run that asked every first load to match
 * failed two times in three with nothing changed. A change in the code moves every load, so it still
 * fails; a load that was another state is printed as OTHER STATE and listed at the end, for the lead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareToBaseline, describeComparison, expect, openCheckpoint, readBaselineManifest, recordBaseline, test } from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifest = readBaselineManifest();
const note = process.env.BASELINE_RECORD ?? '';
const only = (process.env.BASELINE_ONLY ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
const [width, height] = manifest.viewport;
/** Fresh loads an exact checkpoint gets in the self-check before it counts as moved (BASELINE_EXACT_TRIES; 1 = the first load decides). */
const EXACT_TRIES = Math.max(1, Number(process.env.BASELINE_EXACT_TRIES ?? 3));

test.use({ viewport: { width, height }, deviceScaleFactor: 1 });

test.describe('reference images: record', () => {
  test.skip(note === '', 'recording is the lead\'s act: BASELINE_RECORD="<signed note>"');
  for (const [name, c] of Object.entries(manifest.checkpoints)) {
    const wanted = only.length > 0 ? only.includes(name) : c.status !== 'recorded';
    if (!wanted) continue;
    test(`record ${name}`, async ({ page }) => {
      test.setTimeout(15 * 60_000);
      const { entry, selfDifference, loads, leadInDifferingPixels } = await recordBaseline(
        page,
        name,
        async (p) => {
          await openCheckpoint(p, name);
        },
        { note },
      );
      console.log(`[baseline] ${name}: the discarded lead-in capture of each load differed from the capture used in ${leadInDifferingPixels.join(', ')} pixels (request core-7)`);
      console.log(`[baseline] ${name}: recorded ${entry.file} (${entry.width} x ${entry.height}, sha256 ${entry.sha256!.slice(0, 16)}); ${loads} loads differ by at most mean ${selfDifference.meanAbs.toFixed(5)}, p99.9 ${selfDifference.p999}; tolerance mean ${entry.tolerance!.meanAbs.toFixed(5)}, p99.9 ${entry.tolerance!.p999}`);
      if (entry.exact) console.log(`[baseline] ${name}: EXACT: the ${loads} loads are one picture; a comparison passes only when no pixel differs`);
      else {
        const why = entry.notExact?.reason.trim() ? `"${entry.notExact.reason}" (request ${entry.notExact.request})` : 'NO REASON IS WRITTEN YET: the lead names the element and its owner\'s request in the manifest ("notExact") before the manifest is committed';
        console.log(`[baseline] ${name}: NOT EXACT: ${selfDifference.maxAbs === 0 ? 'these loads agree, but the manifest says the picture has another state on other loads' : `the loads differ by up to ${selfDifference.maxAbs} level(s) in ${(selfDifference.differingFraction * 100).toFixed(3)} % of the pixels`}; compared within its tolerance; ${why}`);
      }
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
    const chosen = recorded.filter(([name]) => only.length === 0 || only.includes(name));
    test.skip(chosen.length === 0, `BASELINE_ONLY names no recorded checkpoint (${only.join(', ')})`);
    test.setTimeout(chosen.length * 5 * 60_000);
    // Every chosen checkpoint is compared, whatever the one before it did: the run ends with the whole list
    // of the pictures that moved, not with the first of them.
    //
    // An EXACT checkpoint gets up to EXACT_TRIES fresh loads and passes when one of them is the reference to
    // the bit. A few pictures have more than one state on one and the same tree (the far sea under the
    // horizon: about one load in eight, request lead-9); a change in the code moves every load. A load that
    // was another state is printed and listed at the end as OTHER STATE: it does not fail the run, and it is
    // reported to the lead. A checkpoint that is compared within a tolerance gets one load.
    const failed: string[] = [];
    const otherStates: string[] = [];
    for (const [name, c] of chosen) {
      const tries = c.exact ? EXACT_TRIES : 1;
      const earlier: string[] = [];
      for (let attempt = 1; attempt <= tries; attempt++) {
        let done = true;
        try {
          await openCheckpoint(page, name);
          const result = await compareToBaseline(page, name);
          if (result.pass) {
            console.log(`[baseline] same${attempt > 1 ? ` on load ${attempt}` : ''}: ${describeComparison(result)}`);
            if (earlier.length > 0) otherStates.push(`${name}: the reference on load ${attempt}; before it ${earlier.join(' | ')}`);
          } else if (attempt < tries) {
            console.log(`[baseline] OTHER STATE OR MOVED (load ${attempt} of ${tries}, loading again): ${describeComparison(result)}`);
            earlier.push(`load ${attempt}: ${Math.round(result.differingFraction * result.width * result.height)} pixels by up to ${result.maxAbs} level(s)`);
            done = false;
          } else {
            console.log(`[baseline] DIFFERS${tries > 1 ? ` on every one of ${tries} loads` : ''}: ${describeComparison(result)}`);
            failed.push(`${describeComparison(result)}${tries > 1 ? ` (and on the ${tries - 1} load(s) before: ${earlier.join(' | ')})` : ''}. Re-recording needs a note signed by the lead.`);
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.log(`[baseline] FAILED: ${name}: ${message}`);
          failed.push(`${name}: ${message}`);
        }
        await page.goto('about:blank');
        if (done) break;
      }
    }
    for (const o of otherStates) console.log(`[baseline] OTHER STATE, to be reported to the lead (a picture with more than one state on this tree): ${o}`);
    expect(failed, `${failed.length} of ${chosen.length} reference images do not compare clean`).toEqual([]);
  });
});
