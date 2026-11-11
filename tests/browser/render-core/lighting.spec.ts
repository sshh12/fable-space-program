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

test('display material: the emitted image is scaled by the brightness parameter and sits behind a glass reflection', async ({ page, pageLog }) => {
  // Sun in the north: the south face of the display panel is in its own shade, so the pixel is the emitter alone.
  await openPage(page, '/labs/render-core/?sun=0,40&hud=0&ev=10&paused=1&probe=inputs');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
    // Head-on, 3 m south of the panel.
    window.__rc!.lookAt(window.__rc!.stand!.display.pos, 180, 0, 3);
  });
  await waitIdle(page, 12);
  const centre = (): Promise<number> =>
    page.evaluate(async () => {
      const lab = window.__lab!;
      await window.__test!.waitFrames(6);
      const [w, h] = lab.renderer.frameContext!.renderSize;
      const px = await lab.renderer.readHdrPixels('hdr', { x: (w >> 1) - 2, y: (h >> 1) - 2, width: 4, height: 4 });
      let g = 0;
      for (let i = 0; i < px.data.length; i += 4) g += px.data[i + 1]! / 16;
      return g;
    });
  const { exposure, luminance } = await page.evaluate(() => ({ exposure: window.__lab!.renderer.frameContext!.exposure, luminance: window.__rc!.stand!.display.emissive[1] }));
  const full = await centre();
  await saveScreenshot(page, 'render-core', 'lighting-display');
  await page.evaluate(() => window.__rc!.stand!.setDisplayBrightness(0.5));
  const half = await centre();
  await page.evaluate(() => window.__rc!.stand!.setDisplayBrightness(0));
  const off = await centre();
  console.log(`display: brightness 1 reads ${(full / exposure).toFixed(1)} cd/m^2 (emitter ${luminance}), brightness 0.5 ${(half / exposure).toFixed(1)}, brightness 0 ${(off / exposure).toFixed(2)}`);
  // Head-on the glass transmits the stated luminance; MATERIAL_PARAM (RT2.a) scales it.
  expect(full / (luminance * exposure)).toBeGreaterThan(0.98);
  expect(full / (luminance * exposure)).toBeLessThan(1.02);
  expect((half - off) / (full - off)).toBeCloseTo(0.5, 2);
  expect(off).toBeLessThan(0.01 * full);
  // Switched off, the panel is a dark glass front: a uniform 10,000 cd/m^2 environment reflects with the
  // dielectric Fresnel factor (F0 0.04 at normal incidence: about 440 cd/m^2 with the split-sum terms).
  await page.evaluate(() => window.__rc!.probes.inputs.setEnvRadiance(10000));
  const reflected = (await centre()) - off;
  console.log(`display glass reflects ${(reflected / exposure).toFixed(0)} cd/m^2 of a 10,000 cd/m^2 environment`);
  expect(reflected / (10000 * exposure)).toBeGreaterThan(0.03);
  expect(reflected / (10000 * exposure)).toBeLessThan(0.06);
  await page.evaluate(() => {
    window.__rc!.probes.inputs.setEnvRadiance(null);
    window.__rc!.stand!.setDisplayBrightness(1);
  });
  // Seen at 75 deg from the normal the emitter fades into the reflection: 1 - (1 - cos 75)^5 = 0.776 of head-on.
  await page.evaluate(() => window.__rc!.lookAt(window.__rc!.stand!.display.pos, 180 + 75, 0, 3));
  const oblique = await centre();
  console.log(`display at 75 deg: ${(oblique / full).toFixed(3)} of the head-on luminance (expected 0.776)`);
  expect(oblique / full).toBeGreaterThan(0.74);
  expect(oblique / full).toBeLessThan(0.81);
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

  // Far cloud shadow from the coverage map (request atmosphere-clouds-6): of the sun's illuminance the share
  // exp(-c x tau / mu_s) arrives at all, exp(-c (1 + 7 c) x tau / mu_s) of it in the beam, the rest from the
  // cloud base. A horizontal matt card in the open receives the two together.
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudFar({ coverage: 0.5, opticalDepth: 1 }));
  const farCard = g(await centre()) / g(base);
  console.log(`far cloud (coverage 0.5, optical depth 1): the card receives ${farCard.toFixed(3)} of the clear value (all light ${Math.exp(-0.5 / muS).toFixed(3)}, beam alone ${Math.exp(-2.25 / muS).toFixed(3)})`);
  expect(farCard / Math.exp(-0.5 / muS)).toBeGreaterThan(0.94);
  expect(farCard / Math.exp(-0.5 / muS)).toBeLessThan(1.06);
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudFar(null));

  // Near cloud shadow map (takes over from the far term inside its footprint), with the layer far above
  // the ground: exp(-map x scale / mu_s).
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudNear({ opticalDepth: 0.5 }));
  expect(g(await centre()) / g(base)).toBeCloseTo(Math.exp(-0.5 / muS), 2);
  // The map is depth-resolved (request atmosphere-clouds-3). The ground INSIDE the layer, a quarter of its
  // depth below the top (top 2 m above the ground, 8 m deep): a quarter of the optical depth above it.
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudNear({ opticalDepth: 0.5, top: 2, thickness: 8 }));
  expect(g(await centre()) / g(base)).toBeCloseTo(Math.exp(-0.125 / muS), 2);
  // The ground ABOVE the layer (top 5 m below it): a cloud underneath casts no shadow upwards.
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudNear({ opticalDepth: 0.5, top: -5, thickness: 8 }));
  expect(g(await centre()) / g(base)).toBeCloseTo(1, 3);
  // A map that tells beam from diffuse light (alpha = beam optical depth / r = 4): the card still receives
  // about exp(-0.5 / mu_s) of the clear value, now mostly from the cloud base.
  const cloudAll = Math.exp(-0.5 / muS);
  const cloudBeam = Math.exp(-2 / muS);
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudNear({ opticalDepth: 0.5, beam: 4 }));
  const nearCard = g(await centre()) / g(base);
  expect(nearCard / cloudAll).toBeGreaterThan(0.94);
  expect(nearCard / cloudAll).toBeLessThan(1.06);
  // Under that cloud about a third of the clear sky is seen: the sky table counts with mix(0.35, 1, beam).
  await page.evaluate(() => window.__rc!.probes.inputs.setSkyIrradiance(20000));
  const skyUnderCloud = g(await centre()) - nearCard * g(base);
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudNear(null));
  const skyClear = g(await centre()) - g(base);
  await page.evaluate(() => window.__rc!.probes.inputs.setSkyIrradiance(null));
  expect(skyUnderCloud / skyClear).toBeCloseTo(0.35 + 0.65 * cloudBeam, 2);
  expect(g(await centre())).toBeCloseTo(g(base), 4);

  // Beam and cloud base apart: the slab in the cast shadow of the tower (sun 60 degrees up in the south, the
  // tower 8 m tall at (-7, -4): its shadow reaches 4.6 m north) against the slab in the sun beside it.
  const lookDown = (x: number, y: number): Promise<void> => page.evaluate(([px, py]) => window.__rc!.lookAt([px!, py!, 0.02], 0, 89.9, 6), [x, y]);
  await lookDown(-5, -1.5);
  await waitIdle(page, 12);
  const slabSun = g(await centre());
  await lookDown(-7, -1.5);
  await waitIdle(page, 12);
  const shadowClear = g(await centre()) / slabSun;
  // A map without the beam channel casts all of its shadow in the beam: nothing reaches the cast shadow.
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudNear({ opticalDepth: 0.5 }));
  const shadowPlain = g(await centre()) / slabSun;
  // With it, the cast shadow is filled by the cloud base: (all - beam) of the clear sunlit value, less the
  // ambient occlusion beside the tower.
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudNear({ opticalDepth: 0.5, beam: 4 }));
  const shadowCloud = g(await centre()) / slabSun;
  await lookDown(-5, -1.5);
  await waitIdle(page, 12);
  const sunCloud = g(await centre()) / slabSun;
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudNear(null));
  console.log(
    `cloud light (optical depth 0.5 as the ground sees it, 4 times that in the beam, sun 60 degrees up): all ${cloudAll.toFixed(3)}, beam ${cloudBeam.toFixed(3)}; card ${nearCard.toFixed(3)} of clear; ` +
      `slab in the sun ${sunCloud.toFixed(3)}, in the tower's cast shadow ${shadowCloud.toFixed(3)} (clear sky ${shadowClear.toFixed(4)}, map without the beam channel ${shadowPlain.toFixed(4)}); sky table under the cloud ${(skyUnderCloud / skyClear).toFixed(3)} of clear`,
  );
  expect(shadowClear).toBeLessThan(0.01);
  expect(shadowPlain).toBeLessThan(0.01);
  expect(shadowCloud).toBeGreaterThan(0.8 * (cloudAll - cloudBeam));
  expect(shadowCloud).toBeLessThan(1.05 * (cloudAll - cloudBeam));
  // The sunlit slab has the beam on top of that: the cast shadow is soft-edged in brightness, 5 to 1 no more.
  expect(sunCloud - shadowCloud).toBeGreaterThan(0.8 * cloudBeam);
  expect(sunCloud - shadowCloud).toBeLessThan(1.3 * cloudBeam);
  await page.evaluate(() => window.__rc!.lookAt(window.__rc!.stand!.whiteCard.pos, 0, 89.9, 6));
  await waitIdle(page, 12);

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
  // The probe already contains the sky (rendering-design 8.3): a standard material must not receive the sky
  // irradiance table on top of env.sh9. Publishing the table changes nothing, with or without the probe.
  const stepEnv = g(await centre());
  await page.evaluate(() => window.__rc!.probes.inputs.setSkyIrradiance(20000));
  const stepEnvSky = g(await centre());
  await page.evaluate(() => window.__rc!.probes.inputs.setEnvIrradiance(null));
  const stepSky = g(await centre());
  await page.evaluate(() => window.__rc!.probes.inputs.setSkyIrradiance(null));
  console.log(`standard material: env.sh9 alone ${stepEnv.toFixed(5)}, env.sh9 + sky table ${stepEnvSky.toFixed(5)}; no ambient ${g(stepBase).toFixed(5)}, sky table alone ${stepSky.toFixed(5)}`);
  expect(Math.abs(stepEnvSky - stepEnv)).toBeLessThan(1e-4 * stepEnv);
  expect(Math.abs(stepSky - g(stepBase))).toBeLessThan(1e-4 * g(stepBase));
  // Under cloud (request atmosphere-clouds-6, addendum) a probe-lit surface takes the cloud base as well:
  // the probe is captured at the camera and does not hold the cloud over this surface. The step's top
  // receives the share exp(-0.5 / mu_s) of its clear value (beam + cloud base), not the beam alone, and of
  // the probe's light it keeps mix(0.35, 1, beam).
  await page.evaluate(() => window.__rc!.probes.inputs.setCloudNear({ opticalDepth: 0.5, beam: 4 }));
  const stepCloud = g(await centre()) / g(stepBase);
  await page.evaluate(() => window.__rc!.probes.inputs.setEnvIrradiance(30000));
  const stepCloudAmb = g(await centre()) - stepCloud * g(stepBase);
  await page.evaluate(() => {
    window.__rc!.probes.inputs.setEnvIrradiance(null);
    window.__rc!.probes.inputs.setCloudNear(null);
  });
  console.log(`standard material under the cloud: ${stepCloud.toFixed(3)} of its clear value (all light ${Math.exp(-0.5 / muS).toFixed(3)}, beam alone ${Math.exp(-2 / muS).toFixed(3)}); the probe's light ${(stepCloudAmb / stepAmb).toFixed(3)} of its clear value`);
  expect(stepCloud / Math.exp(-0.5 / muS)).toBeGreaterThan(0.9);
  expect(stepCloud / Math.exp(-0.5 / muS)).toBeLessThan(1.1);
  expect(stepCloudAmb / stepAmb).toBeCloseTo(0.35 + 0.65 * Math.exp(-2 / muS), 2);

  // The same for cloth: the standing panel (albedo 0.42 in green) seen from the east takes the probe, not the sky table.
  await page.evaluate(() => window.__rc!.lookAt([-9, 0, 1.55], 90, 0, 4));
  const clothBase = g(await centre());
  await page.evaluate(() => window.__rc!.probes.inputs.setSkyIrradiance(20000));
  const clothSky = g(await centre());
  await page.evaluate(() => {
    window.__rc!.probes.inputs.setSkyIrradiance(null);
    window.__rc!.probes.inputs.setEnvIrradiance(30000);
  });
  const clothEnv = g(await centre()) - clothBase;
  await page.evaluate(() => window.__rc!.probes.inputs.setEnvIrradiance(null));
  console.log(`cloth: sky table changes ${(clothSky - clothBase).toExponential(2)}, env.sh9 30,000 lux adds ${clothEnv.toFixed(5)} (expected about ${(((0.42 * 30000) / Math.PI) * exposure).toFixed(5)})`);
  expect(Math.abs(clothSky - clothBase)).toBeLessThan(1e-4 * Math.max(clothBase, 1e-3));
  expect(clothEnv / (((0.42 * 30000) / Math.PI) * exposure)).toBeGreaterThan(0.85);
  expect(clothEnv / (((0.42 * 30000) / Math.PI) * exposure)).toBeLessThan(1.1);

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

test('cloth is shadowed on both sides: a caster between the sun and a back-lit panel darkens it (request cockpit-1)', async ({ page, pageLog }) => {
  // The sun stands behind the tower as seen from the cloth panel (bearing 153.4 deg, 30 deg high): the tower's
  // shadow falls across the middle of the panel; its ends are in the sun.
  await openPage(page, '/labs/render-core/?sun=153.4,30&hud=0&paused=1&ev=14');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
  });
  const at = (yawDeg: number): Promise<{ shadowed: number; lit: number }> =>
    page.evaluate(async (yaw) => {
      window.__rc!.lookAt([-9, 0, 1.55], yaw, 0, 5);
      await window.__test!.waitFrames(6);
      const lum = async (p: [number, number, number]): Promise<number> => {
        const px = window.__rc!.projectSitePoint(p)!;
        const img = await window.__lab!.renderer.readHdrPixels('hdr', { x: Math.round(px.x) - 1, y: Math.round(px.y) - 1, width: 3, height: 3 });
        let sum = 0;
        for (let i = 0; i < 9; i++) sum += 0.2126 * img.data[i * 4]! + 0.7152 * img.data[i * 4 + 1]! + 0.0722 * img.data[i * 4 + 2]!;
        return sum / 9;
      };
      return { shadowed: await lum([-9, 0, 1.55]), lit: await lum([-9, 1.25, 1.55]) };
    }, yawDeg);
  await waitIdle(page, 10);
  // From the east: the face turned to the sun. From the west: the back of the panel, lit through the fabric.
  const front = await at(90);
  const back = await at(270);
  await saveScreenshot(page, 'render-core', 'lighting-cloth-backlit-shadow');
  console.log(`cloth panel: front lit ${front.lit.toFixed(4)}, in the tower's shadow ${front.shadowed.toFixed(4)}; back lit through the fabric ${back.lit.toFixed(4)}, in the shadow ${back.shadowed.toFixed(4)}`);
  expect(front.lit).toBeGreaterThan(0.02);
  expect(front.shadowed).toBeLessThan(0.1 * front.lit);
  // The back is lit through the fabric where the sun reaches the panel, and dark where the tower stands in between.
  expect(back.lit).toBeGreaterThan(0.005);
  expect(back.shadowed).toBeLessThan(0.1 * back.lit);
  await expectNoErrors(page, pageLog);
});

test('planetshine is gated by the baked occlusion: a surface that writes AO 0 receives none (request cockpit-2)', async ({ page, pageLog }) => {
  // Night on the Moon (the sun 25 deg below the horizon of the stand), the Earth in the sky: earthshine only.
  await openPage(page, '/labs/render-core/?scene=lunarSurface&sun=90,-25&hud=0&paused=1&ev=-1');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
    window.__rc!.lookAt([-12, -4, 0.5], 90, 60, 7);
  });
  await waitIdle(page, 10);
  const r = await page.evaluate(async () => {
    await window.__test!.waitFrames(6);
    const lum = async (p: [number, number, number]): Promise<number> => {
      const px = window.__rc!.projectSitePoint(p)!;
      const img = await window.__lab!.renderer.readHdrPixels('hdr', { x: Math.round(px.x) - 2, y: Math.round(px.y) - 2, width: 5, height: 5 });
      let sum = 0;
      for (let i = 0; i < 25; i++) sum += 0.2126 * img.data[i * 4]! + 0.7152 * img.data[i * 4 + 1]! + 0.0722 * img.data[i * 4 + 2]!;
      return sum / 25;
    };
    const earth = window.__rc!.directionAtSite(window.__lab!.defs.rootBodyId);
    // The tops of the two boxes (z = 1).
    return { open: await lum([-12, -3, 1]), closed: await lum([-12, -5, 1]), earthElevation: earth.elDeg, exposure: window.__lab!.renderer.frameContext!.exposure };
  });
  await saveScreenshot(page, 'render-core', 'lighting-planetshine-occlusion');
  console.log(`earthshine (Earth ${r.earthElevation.toFixed(0)} deg above the horizon): open box ${(r.open / r.exposure).toFixed(3)} cd/m^2, box with baked AO 0 ${(r.closed / r.exposure).toFixed(4)} cd/m^2`);
  expect(r.earthElevation).toBeGreaterThan(20);
  // Earthshine of a few lux on a 50 % grey top face: some tenths of a cd/m^2.
  expect(r.open / r.exposure).toBeGreaterThan(0.05);
  expect(r.closed).toBeLessThan(0.02 * r.open);
  await expectNoErrors(page, pageLog);
});

test('planetshine is hidden by the bodies in between: the Moon under a 200 km orbit\'s horizon lights nothing (request sky-lighting-8)', async ({ page, pageLog }) => {
  // The stand 200 km above the Earth, at night (the sun 20 deg below the horizontal, behind the Earth: its limb is
  // 14.2 deg down), twice: under the Moon (35 deg up) and at the antipode of that place (the Moon 35 deg DOWN,
  // behind the Earth). The camera looks level at the white cylinder from the Moon's azimuth, so the surface in
  // the middle of the frame faces the Moon's azimuth and sees it at the same angle (35 deg) in both places.
  await openPage(page, '/labs/render-core/?scene=pad&site=moonview&hud=0&paused=1');
  const view = await page.evaluate(() => ({ lat: window.__rc!.site.latDeg, lon: window.__rc!.site.lonDeg }));
  const measure = async (lat: number, lon: number): Promise<{ moonEl: number; cdm2: number }> => {
    await openPage(page, `/labs/render-core/?scene=pad&site=${lat},${lon},200000&hud=0&paused=1&ev=-4`);
    await assertDiscreteGpu(page);
    await page.evaluate(() => {
      const lab = window.__lab!;
      const root = lab.defs.rootBodyId;
      const moonId = Object.entries(lab.defs.bodies).find(([, b]) => b.parent === root && b.gravityRole === 'attractor')![0];
      const moon = window.__rc!.directionAtSite(moonId);
      window.__test!.setDeterministic(true);
      lab.renderer.setJitter(false);
      window.__rc!.setSun([moon.azDeg + 90, -20]);
      window.__rc!.lookAt([0, 28, 20], moon.azDeg, 0, 12);
    });
    await waitIdle(page, 10);
    return page.evaluate(async () => {
      const lab = window.__lab!;
      await window.__test!.waitFrames(6);
      const root = lab.defs.rootBodyId;
      const moonId = Object.entries(lab.defs.bodies).find(([, b]) => b.parent === root && b.gravityRole === 'attractor')![0];
      const f = lab.renderer.frameContext!;
      const [w, h] = f.renderSize;
      const px = await lab.renderer.readHdrPixels('hdr', { x: (w >> 1) - 3, y: (h >> 1) - 3, width: 7, height: 7 });
      let sum = 0;
      for (let i = 0; i < px.data.length; i += 4) sum += 0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!;
      return { moonEl: window.__rc!.directionAtSite(moonId).elDeg, cdm2: sum / 49 / f.exposure };
    });
  };
  const up = await measure(view.lat, view.lon);
  await saveScreenshot(page, 'render-core', 'lighting-planetshine-moon-up-leo');
  const set = await measure(-view.lat, view.lon + 180);
  await saveScreenshot(page, 'render-core', 'lighting-planetshine-moon-set-leo');
  console.log(`moonlight on a white hull at 200 km, night: Moon ${up.moonEl.toFixed(1)} deg: ${up.cdm2.toExponential(3)} cd/m^2; Moon ${set.moonEl.toFixed(1)} deg (behind the Earth): ${set.cdm2.toExponential(3)} cd/m^2`);
  expect(up.moonEl).toBeGreaterThan(30);
  expect(set.moonEl).toBeLessThan(-30);
  // Moonlight of some hundredths of a lux on the white hull (0.85): of the order of 0.01 cd/m^2.
  expect(up.cdm2).toBeGreaterThan(2e-3);
  // Without the occlusion test the set Moon lit this face at about half of that (its phase is thinner there).
  expect(set.cdm2).toBeLessThan(0.05 * up.cdm2);
  await expectNoErrors(page, pageLog);
});
