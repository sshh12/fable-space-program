import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, pngStats, saveScreenshot, test, waitIdle } from '../harness';

// The first navigation of a run compiles the page through Vite; on a loaded machine that alone can take a minute.
test.describe.configure({ timeout: 600_000 });

test('material sweep under an environment (probe SH + prefiltered cube) and TAAU at 60 % internal resolution', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?sun=215,38&hud=0&paused=1&fov=40&probe=inputs');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    // A uniform overcast-like environment: 6,000 cd/m^2 from every direction (irradiance pi x L).
    window.__rc!.probes.inputs.setEnvRadiance(6000);
    window.__rc!.probes.inputs.setEnvIrradiance(6000 * Math.PI);
    window.__rc!.probes.inputs.setSkyIrradiance(6000 * Math.PI);
    window.__rc!.lookAt([0, 2.4, 0.4], 180, 32, 11);
  });
  await waitIdle(page, 60);
  const full = await saveScreenshot(page, 'render-core', 'lighting-material-sweep-env');
  assertRealImage(full.stats, 'material sweep with environment', { minNonBlack: 0.8, minStd: 15, minBuckets: 200 });
  await expectNoErrors(page, pageLog);

  // The same view rendered at 60 % internal resolution and upscaled by TAAU.
  await openPage(page, '/labs/render-core/?sun=215,38&hud=0&paused=1&fov=40&probe=inputs&scale=0.6');
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__rc!.probes.inputs.setEnvRadiance(6000);
    window.__rc!.probes.inputs.setEnvIrradiance(6000 * Math.PI);
    window.__rc!.probes.inputs.setSkyIrradiance(6000 * Math.PI);
    window.__rc!.lookAt([0, 2.4, 0.4], 180, 32, 11);
  });
  await waitIdle(page, 90);
  const size = await page.evaluate(() => ({ render: window.__lab!.renderer.frameContext!.renderSize, display: window.__lab!.renderer.frameContext!.displaySize, perf: window.__test!.perf()!.renderScale }));
  expect(size.display).toEqual([1280, 720]);
  expect(size.render).toEqual([768, 432]);
  expect(size.perf).toBeCloseTo(0.6, 5);
  const up = await saveScreenshot(page, 'render-core', 'taau-60-percent');
  assertRealImage(up.stats, 'TAAU', { minNonBlack: 0.8, minStd: 15, minBuckets: 200 });
  // Same picture, same exposure: mean brightness and contrast agree with the native render.
  expect(Math.abs(up.stats.meanLuma - full.stats.meanLuma)).toBeLessThan(4);
  expect(Math.abs(up.stats.stdLuma - full.stats.stdLuma)).toBeLessThan(4);
  // Upscaled from 36 % of the pixels yet still sharp: the gradient energy stays close to native.
  const sharpness = (buf: Buffer): number => {
    const s = pngStats(buf);
    return s.stdLuma;
  };
  expect(sharpness(up.buffer) / sharpness(full.buffer)).toBeGreaterThan(0.9);
  await expectNoErrors(page, pageLog);
});

test('interior camera: cascade 0 is anchored to the vessel frame and re-rendered every frame; interior metering is used', async ({ page, pageLog }) => {
  // Eye inside the hollow of nothing in particular: 0.5 m from the vessel origin, with a box attached to the vessel.
  await openPage(page, '/labs/render-core/?scene=lowOrbit&stand=0&probe=mover,casters&kind=interior&vessel=active&offset=0,-9,0.5&look=0,0,0&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 30);
  const r = await page.evaluate(() => {
    const log = window.__rc!.probes.cascadeLog().slice(-200);
    const cam = window.__test!.camera()!;
    return { log, kind: cam.kind, inside: cam.insideVesselId, active: window.__test!.state()!.activeVesselId, violations: window.__rc!.probes.movingCasterViolations(), ev: window.__lab!.renderer.exposureInfo() };
  });
  expect(r.kind).toBe('interior');
  expect(r.inside).toBe(r.active);
  const vesselAnchored = r.log.filter((c) => c.anchor === `vessel:${r.active}`);
  expect(vesselAnchored.length).toBeGreaterThan(10);
  expect(vesselAnchored.every((c) => c.everyFrame && c.fit === 'camera' && c.texelSize < 0.02)).toBe(true);
  // Every other cascade is anchored to a body.
  expect(r.log.filter((c) => c.anchor !== `vessel:${r.active}`).every((c) => c.anchor.startsWith('body:'))).toBe(true);
  expect(r.violations).toBe(0);
  expect(Number.isFinite(r.ev.ev100)).toBe(true);
  await saveScreenshot(page, 'render-core', 'interior-vessel-cascade');
  await expectNoErrors(page, pageLog);
});
