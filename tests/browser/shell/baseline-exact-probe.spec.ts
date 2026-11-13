/**
 * WHAT MOVES in a checkpoint that is not frame-exact, or that differs from load to load (the lead's
 * diagnostic; never part of a gate).
 *
 * The reference images require two consecutive frame-exact captures of a checkpoint to be identical to the
 * bit (baselineLogic.ts). A checkpoint that fails that is a finding against the element that still changes
 * while every feature reports idle. This probe names the place: it opens the checkpoint as the recorder
 * does, takes several frame-exact captures, and for each consecutive pair prints how many pixels differ,
 * by how much and WHERE (a box, the grid cells, sample pixels with both values), and writes a picture with
 * the differing pixels marked. It also prints each capture's difference from the LAST one, which tells a
 * state that is still converging (the differences shrink) from one that cycles (they do not).
 *
 * With BASELINE_EXACT_LOADS above 1 it does the same from that many fresh loads and compares the last
 * capture of each load with the last capture of the first: what a checkpoint's tolerance is made of.
 *
 *   BASELINE_EXACT_PROBE=leo-night[,name...] node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baseline-exact-probe.spec.ts --project=functional
 *
 *   BASELINE_EXACT_CAPTURES=6   captures per load (default 6, at least 2)
 *   BASELINE_EXACT_LOADS=1      fresh loads (default 1)
 *   BASELINE_EXACT_FRAMES=128   frames per capture instead of the checkpoint's own (does a longer capture settle it?)
 *   BASELINE_EXACT_QUERY="&x=1" appended to the checkpoint's page (to test a suspicion: a feature off, an exposure pinned)
 *   BASELINE_EXACT_TAG=ev12     a tag for the files of this run
 *
 * Files: out/screens/baselines/<name>.probe[-tag].first.png, .last.png, .marks-<i>.png for each pair
 * (i, i + 1) of the first load that differs, and .load-<n>.png for each later load that differs from the
 * first (the first capture dimmed, a magenta square around every differing pixel). It records nothing and
 * compares with no reference; it only fails when the checkpoint cannot be opened. It is also the way to
 * LOOK at a framing before it is recorded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeDifferenceMap, differenceMap, markDifferences } from '../exactProbe';
import { assertDiscreteGpu, captureDeterministic, openPage, readBaselineManifest, runBaselineSteps, test } from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifest = readBaselineManifest();
const names = (process.env.BASELINE_EXACT_PROBE ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
const captures = Math.max(2, Number(process.env.BASELINE_EXACT_CAPTURES ?? 6));
const loads = Math.max(1, Number(process.env.BASELINE_EXACT_LOADS ?? 1));
const framesOverride = process.env.BASELINE_EXACT_FRAMES ? Number(process.env.BASELINE_EXACT_FRAMES) : null;
const extraQuery = process.env.BASELINE_EXACT_QUERY ?? '';
const tag = process.env.BASELINE_EXACT_TAG ? `-${process.env.BASELINE_EXACT_TAG}` : '';
const [width, height] = manifest.viewport;

test.use({ viewport: { width, height }, deviceScaleFactor: 1 });

test.describe('reference images: what moves in a checkpoint', () => {
  test.skip(names.length === 0, 'a diagnostic: BASELINE_EXACT_PROBE=<checkpoint>[,<checkpoint>...]');
  for (const name of names) {
    test(`probe ${name}`, async ({ page }) => {
      test.setTimeout(30 * 60_000);
      // The manifest as it is now, not as it was when the file was loaded: a framing is tried here before it is recorded.
      const entry = readBaselineManifest().checkpoints[name];
      if (!entry || entry.page === null) throw new Error(`"${name}" is not a framed checkpoint of the manifest`);
      const frames = framesOverride ?? entry.frames;
      const dir = path.join(repoRoot, 'out', 'screens', 'baselines');
      fs.mkdirSync(dir, { recursive: true });
      const base = path.join(dir, `${name}.probe${tag}`);
      console.log(`[exact probe] ${name}${extraQuery ? ` with ${extraQuery}` : ''}: ${loads} load(s), ${captures} captures of ${frames} frames each`);
      let firstLoadLast: Buffer | null = null;
      for (let load = 1; load <= loads; load++) {
        if (load > 1) await page.goto('about:blank');
        await openPage(page, `${entry.page}${extraQuery}`, { timeoutMs: 180_000 });
        await assertDiscreteGpu(page);
        await runBaselineSteps(page, entry.setup ?? []);
        const shots: Buffer[] = [];
        for (let k = 0; k < captures; k++) shots.push(await captureDeterministic(page, frames, 180_000));
        const last = shots[shots.length - 1]!;
        if (load === 1) {
          fs.writeFileSync(`${base}.first.png`, shots[0]!);
          fs.writeFileSync(`${base}.last.png`, last);
        }
        for (let k = 0; k + 1 < shots.length; k++) {
          const pair = differenceMap(shots[k]!, shots[k + 1]!);
          const toLast = differenceMap(shots[k]!, last);
          console.log(`[exact probe] ${name}: load ${load}, capture ${k + 1} against ${k + 2}: ${describeDifferenceMap(pair)}`);
          console.log(`[exact probe] ${name}: load ${load}, capture ${k + 1} against the last: ${toLast.differingPixels} pixels, up to ${toLast.maxAbs} level(s)`);
          if (load === 1 && pair.differingPixels > 0) fs.writeFileSync(`${base}.marks-${k + 1}.png`, markDifferences(shots[k]!, shots[k + 1]!));
        }
        if (firstLoadLast === null) firstLoadLast = last;
        else {
          const across = differenceMap(firstLoadLast, last);
          console.log(`[exact probe] ${name}: load 1 against load ${load} (the last capture of each): ${describeDifferenceMap(across)}`);
          if (across.differingPixels > 0) fs.writeFileSync(`${base}.load-${load}.png`, markDifferences(firstLoadLast, last));
        }
      }
    });
  }
});
