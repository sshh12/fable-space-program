import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test } from '../harness';

/** Reference spec for lab pages: copy the pattern into tests/browser/<your-package>/. */
test('lab template runs the FakeSim and reacts to the controls API', async ({ page, pageLog }) => {
  await openPage(page, '/labs/template/?scene=lowOrbit');
  await assertDiscreteGpu(page);
  expect(await page.evaluate(() => window.__test!.page.kind)).toBe('lab');

  const before = await page.evaluate(() => window.__test!.state()!);
  expect(before.vessels[0]!.bodyId).toBe('earth');
  expect(before.readouts.altitudeAsl).toBeCloseTo(200e3, -2);

  // Drive it exactly like the keyboard layer would: controls + commands, then close the loop on state.
  await page.evaluate(() => {
    window.__test!.setControls({ throttle: 1 });
    window.__test!.commands!.stage();
  });
  await page.waitForFunction(() => window.__test!.state()!.vessels[0]!.thrust > 1.5e6);
  const after = await page.evaluate(() => window.__test!.state()!);
  expect(after.staging.nextStage).toBe(1);
  expect(after.ut).toBeGreaterThan(before.ut);

  const shot = await saveScreenshot(page, 'shell', 'lab-template');
  expect(shot.stats.width).toBe(1280);
  expect(shot.stats.maxLuma).toBeGreaterThan(20);
  await expectNoErrors(page, pageLog);
});
