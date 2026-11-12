/**
 * Reviewed screenshots of the cockpit interior (out/screens/cockpit): every view the brief lists, from the
 * commander's seat, plus close-ups and the chase camera looking in through a window.
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.use({ viewport: { width: 1600, height: 900 } });

/** Deterministic frames until the exposure has adapted (it moves 0.8 EV/s toward darker scenes) and TAA has converged. */
async function settle(page: Page, frames = 60): Promise<void> {
  await waitIdle(page, 8);
  await page.evaluate(() => window.__test!.setDeterministic(true));
  await page.waitForFunction(
    async () => {
      await window.__test!.waitFrames(30);
      const e = window.__cockpit!.debug().exposure;
      return Math.abs(e.ev100 - e.targetEv100) < 0.05;
    },
    undefined,
    { timeout: 120_000, polling: 100 },
  );
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
}

// Every view is taken at the exposure the renderer meters (no per-shot compensation). The cockpit lab has
// stand-ins for everything outside the cabin: the views whose picture depends on what is outside are
// functional evidence only and go to out/screens/cockpit/lab/; the reviewed pictures are the cabin-only
// views here (close-ups, the look back, the hatch) and the views over the real world of world.spec.ts
// (out/screens/cockpit/world-*.png).
const LAB = 'cockpit/lab';
const shots: { name: string; url: string; dark?: boolean; dir?: string }[] = [
  { name: 'pad-noon-forward-window', url: 'scene=pad', dir: LAB },
  // The window's axis turned toward the horizon ahead: Earth below, the limb and black space above.
  { name: 'leo-earth-side-window', url: 'scene=leo-earth', dark: true, dir: LAB },
  { name: 'leo-sun-patch-console', url: 'scene=leo', dir: LAB },
  { name: 'night-displays-floods', url: 'scene=night', dark: true, dir: LAB },
  { name: 'reentry-plasma', url: 'scene=reentry', dark: true, dir: LAB },
  // Head over the commander's left shoulder, level with the side window: the sunlit ground and the
  // horizon against the black sky (the capsule stands upright, so the window looks out above the horizon).
  { name: 'moon-horizon', url: 'scene=moon&eye=-0.05,-0.12,0.04&aim=horizonL&fov=60', dark: true, dir: LAB },
  // From the cockpit seat (the pilot's centre couch), head raised, looking round at the other couches and
  // down to the hatch, the floods on.
  { name: 'look-back-couches-hatch', url: 'scene=leo&eye=0.2,-0.35,0.4&aim=hatchDoor&fov=80&lights=1' },
  // The side hatch from low between the pilot's and the specialist's couches (it lies beyond the crew's feet).
  { name: 'hatch-mechanism', url: 'scene=leo&at=0.36,0.8,-0.75&aim=hatchDoor&fov=75' },
  // Up the tunnel from the couch: the docking hatch's inner face (round 6: its face was a star of spokes).
  { name: 'look-up-docking-hatch', url: 'scene=leo&look=0,78&fov=70&lights=1' },
  { name: 'closeup-mfd', url: 'scene=leo&aim=mfd0&fov=24' },
  // The attitude indicator under its integral lighting and the floods, out of the sun (the sun patch on the
  // display beside it makes the meter stop the cabin down: the instrument would be shown in the dark).
  { name: 'closeup-fdai', url: 'scene=night&aim=fdai&fov=22' },
  { name: 'closeup-switches', url: 'scene=leo&aim=switches&fov=26' },
  // Looking in from outside: in the Earth's shadow with the floods on, and along the sun's way in by day.
  { name: 'chase-window-night', url: 'scene=night&view=chase&window=fwd-left&distance=0.7&fov=45', dark: true, dir: LAB },
  { name: 'chase-window-sun', url: 'scene=leo&view=chase&window=side-right&target=mfd0&distance=1.2&fov=40', dir: LAB },
];

for (const s of shots) {
  test(`screenshot ${s.name}`, async ({ page, pageLog }) => {
    test.setTimeout(240_000);
    await openPage(page, `/labs/cockpit/?${s.url}`, { timeoutMs: 120_000 });
    await assertDiscreteGpu(page);
    await settle(page);
    const shot = await saveScreenshot(page, s.dir ?? 'cockpit', s.name);
    assertRealImage(shot.stats, s.name, s.dark ? { minNonBlack: 0.05, minStd: 3, minBuckets: 20 } : {});
    const st = await page.evaluate(() => window.__cockpit!.stats());
    expect(st.active).toBe(true);
    await expectNoErrors(page, pageLog);
  });
}
