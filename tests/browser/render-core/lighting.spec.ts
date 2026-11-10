import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

// The first navigation of a run compiles the page through Vite; on a loaded machine that alone can take a minute.
test.describe.configure({ timeout: 600_000 });

test('a sun-lit white Lambert surface reads back E x albedo / pi x exposure within 10 %', async ({ page, pageLog }) => {
  // Sun 60 deg above the horizon, exposure fixed at EV100 15, camera straight above the white card.
  await openPage(page, '/labs/render-core/?sun=180,60&hud=0&ev=15&paused=1');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__rc!.lookAt(window.__rc!.stand!.whiteCard.pos, 0, 89.9, 6);
  });
  await waitIdle(page, 12);
  const r = await page.evaluate(async () => {
    const lab = window.__lab!;
    const f = lab.renderer.frameContext!;
    const [w, h] = f.renderSize;
    const px = await lab.renderer.readHdrPixels('hdr', { x: (w >> 1) - 16, y: (h >> 1) - 16, width: 32, height: 32 });
    let sum = 0;
    let min = Infinity;
    let max = 0;
    for (let i = 0; i < px.data.length; i += 4) {
      const l = 0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!;
      sum += l;
      min = Math.min(min, l);
      max = Math.max(max, l);
    }
    const c = f.sun.color;
    const eLum = f.sun.illuminance * (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
    const stats = await lab.renderer.readHdrStats();
    return { mean: sum / (px.data.length / 4), min, max, illuminance: f.sun.illuminance, eLum, exposure: f.exposure, ev100: f.ev100, albedo: window.__rc!.stand!.whiteCard.albedo, nan: stats.nanPixels };
  });
  expect(r.ev100).toBe(15);
  expect(r.illuminance).toBeGreaterThan(120000);
  const expected = ((r.eLum * r.albedo) / Math.PI) * Math.sin((60 * Math.PI) / 180) * r.exposure;
  console.log(`white card: measured ${r.mean.toFixed(5)} (min ${r.min.toFixed(5)}, max ${r.max.toFixed(5)}), expected ${expected.toFixed(5)}, ratio ${(r.mean / expected).toFixed(4)}`);
  expect(r.mean / expected).toBeGreaterThan(0.9);
  expect(r.mean / expected).toBeLessThan(1.1);
  // Uniformly lit: no shadow acne, no contact-shadow or AO speckle on a flat open surface.
  expect(r.min / r.mean).toBeGreaterThan(0.97);
  expect(r.nan).toBe(0);
  await saveScreenshot(page, 'render-core', 'lighting-white-card');
  await expectNoErrors(page, pageLog);
});

test('material sweep: dielectric, metal, anisotropic and clearcoat rows; emissive objects', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?sun=215,38&hud=0&paused=1&fov=40');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__rc!.lookAt([0, 2.4, 0.4], 180, 32, 11);
  });
  await waitIdle(page, 40);
  const shot = await saveScreenshot(page, 'render-core', 'lighting-material-sweep');
  assertRealImage(shot.stats, 'material sweep', { minNonBlack: 0.5, minStd: 20, minBuckets: 150 });
  await page.evaluate(() => window.__rc!.lookAt([8.5, 3, 0.6], 150, 25, 5));
  await waitIdle(page, 40);
  const em = await saveScreenshot(page, 'render-core', 'lighting-emissive');
  assertRealImage(em.stats, 'emissive', { minNonBlack: 0.3, minStd: 15, minBuckets: 80 });
  expect((await page.evaluate(() => window.__test!.hdrStats())).nanPixels).toBe(0);
  await expectNoErrors(page, pageLog);
});

test('every default SharedResource works with no feature present, and a brdf chunk can be overridden at run time', async ({ page, pageLog }) => {
  // No feature at all: the frame graph, lighting, shadows and post run on defaults only.
  await openPage(page, '/labs/render-core/?planet=0&stand=0&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 10);
  const empty = await page.evaluate(async () => ({ stats: await window.__test!.hdrStats(), features: window.__lab!.renderer.featureOrder(), perf: window.__test!.perf()! }));
  expect(empty.features).toEqual([]);
  expect(empty.stats.nanPixels).toBe(0);
  expect(empty.stats.maxLuminance).toBe(0);
  expect(Object.keys(empty.perf.passes)).toEqual(expect.arrayContaining(['core.gbuffer', 'core.lighting', 'core.taa', 'core.tonemap']));
  await expectNoErrors(page, pageLog);

  // Stand on the slab (MATERIAL_TERRAIN): replace brdf_terrain with a chunk that returns pure red light.
  await openPage(page, '/labs/render-core/?sun=180,60&hud=0&ev=15&paused=1');
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__rc!.lookAt([12, -12, 0], 0, 89.9, 6);
  });
  await waitIdle(page, 8);
  const centre = async (): Promise<number[]> =>
    page.evaluate(async () => {
      const lab = window.__lab!;
      await window.__test!.waitFrames(4);
      const [w, h] = lab.renderer.frameContext!.renderSize;
      const px = await lab.renderer.readHdrPixels('hdr', { x: w >> 1, y: h >> 1, width: 1, height: 1 });
      return [px.data[0]!, px.data[1]!, px.data[2]!];
    });
  const before = await centre();
  expect(before[1]).toBeGreaterThan(0.05);
  expect(Math.abs(before[0]! - before[1]!)).toBeLessThan(0.3 * before[1]!);
  await page.evaluate(() =>
    window.__rc!.overrideTerrainBrdf(`
      fn brdfTerrainDirect(s: Surface, l: vec3f) -> vec3f { return vec3f(0.25 / PI, 0.0, 0.0) * saturate(dot(s.n, l)); }
      fn brdfTerrainAmbient(s: Surface, a: AmbientInput) -> vec3f { return vec3f(0.0); }
    `),
  );
  await waitIdle(page, 6);
  const red = await centre();
  expect(red[0]).toBeGreaterThan(0.05);
  expect(red[1]).toBe(0);
  expect(red[2]).toBe(0);
  await saveScreenshot(page, 'render-core', 'lighting-brdf-override');
  await page.evaluate(() => window.__rc!.overrideTerrainBrdf(null));
  await waitIdle(page, 6);
  const after = await centre();
  expect(after[1]).toBeCloseTo(before[1]!, 3);
  await expectNoErrors(page, pageLog);
});

test('lighting inputs: transmittance, cloud shadows, sky irradiance, probe SH and cube, local lights match hand calculations', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?sun=180,60&hud=0&ev=15&paused=1&probe=inputs');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
    window.__rc!.lookAt(window.__rc!.stand!.whiteCard.pos, 0, 89.9, 6);
  });
  await waitIdle(page, 12);
  /** Mean colour at the centre of the HDR target after a few frames. */
  const centre = (): Promise<number[]> =>
    page.evaluate(async () => {
      const lab = window.__lab!;
      await window.__test!.waitFrames(6);
      const [w, h] = lab.renderer.frameContext!.renderSize;
      const px = await lab.renderer.readHdrPixels('hdr', { x: (w >> 1) - 2, y: (h >> 1) - 2, width: 4, height: 4 });
      const m = [0, 0, 0];
      for (let i = 0; i < px.data.length; i += 4) for (let c = 0; c < 3; c++) m[c]! += px.data[i + c]! / 16;
      return m;
    });
  const exposure = await page.evaluate(() => window.__lab!.renderer.frameContext!.exposure);
  const muS = Math.sin((60 * Math.PI) / 180);
  const albedo = 0.8;
  const base = await centre();
  const g = (v: number[]): number => v[1]!;

  // Atmosphere transmittance: sunlight x 0.5.
  await page.evaluate(() => window.__rc!.probes.inputs.setTransmittance(0.5));
  expect(g(await centre()) / g(base)).toBeCloseTo(0.5, 2);
  await page.evaluate(() => window.__rc!.probes.inputs.setTransmittance(null));

  // Far cloud shadow from the coverage map: exp(-coverage x tau / mu_s).
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudFar({ coverage: 1, opticalDepth: 1 }));
  expect(g(await centre()) / g(base)).toBeCloseTo(Math.exp(-1 / muS), 2);
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudFar(null));

  // Near cloud shadow map (takes over from the far term inside its footprint): exp(-map x scale / mu_s).
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudNear({ opticalDepth: 0.5 }));
  expect(g(await centre()) / g(base)).toBeCloseTo(Math.exp(-0.5 / muS), 2);
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudNear(null));
  expect(g(await centre())).toBeCloseTo(g(base), 4);

  // Sky irradiance on a horizontal Lambert surface: + albedo x E / pi.
  await page.evaluate(() => window.__rc!.probes.inputs.setSkyIrradiance(20000));
  const sky = g(await centre()) - g(base);
  console.log(`sky irradiance 20,000 lux adds ${sky.toFixed(5)} (expected ${(((albedo * 20000) / Math.PI) * exposure).toFixed(5)})`);
  expect(sky / (((albedo * 20000) / Math.PI) * exposure)).toBeGreaterThan(0.9);
  expect(sky / (((albedo * 20000) / Math.PI) * exposure)).toBeLessThan(1.05);
  await page.evaluate(() => window.__rc!.probes.inputs.setSkyIrradiance(null));

  // A point light of 1e6 cd, 4 m above the card: E = I / d^2, smooth window (1 - (d / range)^4)^2 with range = 4 d.
  await page.evaluate(() => {
    const c = window.__rc!.stand!.whiteCard.pos;
    window.__rc!.probes.inputs.setPointLight({ intensity: 1e6, height: 4, at: [c[0], c[1]] });
  });
  const lit = g(await centre()) - g(base);
  const expectLight = ((albedo * (1e6 / 16)) / Math.PI) * (1 - (1 / 16) ** 2) ** 2 * exposure;
  console.log(`point light adds ${lit.toFixed(5)} (expected ${expectLight.toFixed(5)})`);
  expect(lit / expectLight).toBeGreaterThan(0.95);
  expect(lit / expectLight).toBeLessThan(1.08);
  await page.evaluate(() => window.__rc!.probes.inputs.setPointLight(null));

  // Environment probe on standard materials. Top of the step (rough dielectric, albedo 0.5 in green):
  // constant irradiance of 30,000 lux -> + albedo x E / pi (plus a small specular term; the cube is black).
  await page.evaluate(() => window.__rc!.lookAt([6, -5, 0.4], 0, 89.9, 5));
  const stepBase = await centre();
  await page.evaluate(() => window.__rc!.probes.inputs.setEnvIrradiance(30000));
  const stepAmb = g(await centre()) - g(stepBase);
  const expectAmb = ((0.5 * 30000) / Math.PI) * exposure;
  console.log(`env.sh9 30,000 lux adds ${stepAmb.toFixed(5)} on the step (expected about ${expectAmb.toFixed(5)})`);
  expect(stepAmb / expectAmb).toBeGreaterThan(0.85);
  expect(stepAmb / expectAmb).toBeLessThan(1.1);
  await page.evaluate(() => window.__rc!.probes.inputs.setEnvIrradiance(null));

  // Prefiltered cube on the most polished gold sphere, seen from straight above: the mirror reflection of a
  // uniform 10,000 cd/m^2 environment is 10,000 x F0 (gold: 1.0, 0.77, 0.34), minus a little roughness loss.
  await page.evaluate(() => window.__rc!.lookAt([-4.55, 1.6, 1.0], 0, 89.9, 3));
  const sphereBase = await centre();
  await page.evaluate(() => window.__rc!.probes.inputs.setEnvRadiance(10000));
  const refl = (await centre()).map((v, i) => v - sphereBase[i]!);
  console.log(`env.probeCube 10,000 cd/m^2 reflects ${refl.map((v) => (v / exposure).toFixed(0)).join(', ')} cd/m^2 off polished gold`);
  expect(refl[0]! / (10000 * exposure)).toBeGreaterThan(0.85);
  expect(refl[0]! / (10000 * exposure)).toBeLessThan(1.1);
  expect(refl[1]! / refl[0]!).toBeGreaterThan(0.7);
  expect(refl[1]! / refl[0]!).toBeLessThan(0.85);
  expect(refl[2]! / refl[0]!).toBeGreaterThan(0.28);
  expect(refl[2]! / refl[0]!).toBeLessThan(0.45);
  await page.evaluate(() => window.__rc!.probes.inputs.setEnvRadiance(null));
  await expectNoErrors(page, pageLog);
});
