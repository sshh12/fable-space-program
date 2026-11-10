import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

// The first navigation of a run compiles the page through Vite; on a loaded machine that alone can take a minute.
test.describe.configure({ timeout: 600_000 });

test('mesh system: procedural and URL textures (with mips), LOD pick by projected size with cross-fade', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?sun=180,60&hud=0&ev=15&paused=1');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
    const t = window.__rc!.stand!.texturedPlanes;
    window.__rc!.lookAt([(t.procedural[0] + t.url[0]) / 2, t.procedural[1], 0], 0, 89.9, 6);
  });
  // isIdle() covers the texture download and decode.
  await waitIdle(page, 12);
  const tex = await page.evaluate(async () => {
    const lab = window.__lab!;
    const rc = window.__rc!;
    const img = await lab.renderer.readHdrPixels('hdr');
    const at = (enu: [number, number, number]): number => {
      const p = rc.projectSitePoint(enu)!;
      return img.data[(Math.round(p.y) * img.width + Math.round(p.x)) * 4 + 1]!;
    };
    // Square (i, j) of the 8 x 8 checker on a 2 m plane: centre at (-1 + 0.25 (i + 0.5), -1 + 0.25 (j + 0.5)).
    const square = (c: [number, number, number], i: number, j: number): number => at([c[0] - 1 + 0.25 * (i + 0.5), c[1] - 1 + 0.25 * (j + 0.5), 0.02]);
    const t = rc.stand!.texturedPlanes;
    return {
      proc: { light: [square(t.procedural, 0, 0), square(t.procedural, 1, 1), square(t.procedural, 6, 2)], dark: [square(t.procedural, 1, 0), square(t.procedural, 0, 1), square(t.procedural, 5, 2)] },
      url: { light: [square(t.url, 0, 0), square(t.url, 1, 1), square(t.url, 6, 2)], dark: [square(t.url, 1, 0), square(t.url, 0, 1), square(t.url, 5, 2)] },
    };
  });
  await saveScreenshot(page, 'render-core', 'mesh-textures');
  for (const set of [tex.proc, tex.url]) {
    for (const l of set.light) for (const d of set.dark) expect(l).toBeGreaterThan(8 * d);
    // Same square colour everywhere: the pattern is where the UVs say it is.
    expect(Math.max(...set.light) / Math.min(...set.light)).toBeLessThan(1.05);
  }
  // sRGB decoding: 220 / 255 -> 0.716 linear (procedural), 200 / 255 -> 0.578 (PNG green channel).
  expect(tex.url.light[0]! / tex.proc.light[0]!).toBeCloseTo(0.578 / 0.716, 1);
  await expectNoErrors(page, pageLog);

  // LOD: three dense spheres (130,320 triangles; second LOD 960 triangles below 40 px, cross-fade +-15 %).
  await openPage(page, '/labs/render-core/?sun=180,60&hud=0&paused=1&stand=dense&tris=390000&planet=0');
  await page.evaluate(() => window.__test!.setDeterministic(true));
  const statsAt = async (distance: number): Promise<{ instances: number; triangles: number }> => {
    await page.evaluate((d) => window.__rc!.lookAt([0, 9, 0.6], 180, 20, d), distance);
    await page.evaluate(() => window.__test!.waitFrames(4));
    return page.evaluate(() => ({ ...window.__rc!.stand!.batch().stats }));
  };
  const slab = 12;
  const near = await statsAt(5); // about 260 px: LOD 0
  const band = await statsAt(33); // about 39 px: inside the cross-fade band, both LODs drawn
  await saveScreenshot(page, 'render-core', 'mesh-lod-crossfade');
  const far = await statsAt(60); // about 22 px: LOD 1
  expect(near).toEqual({ instances: 4, triangles: slab + 3 * 130320, shadowTriangles: expect.any(Number) });
  expect(band.instances).toBe(7);
  expect(band.triangles).toBe(slab + 3 * (130320 + 960));
  expect(far.instances).toBe(4);
  expect(far.triangles).toBe(slab + 3 * 960);
  await expectNoErrors(page, pageLog);
});

test("LabPlanet: ocean-coloured texels are water, and inside 'ocean.nearField' the seabed is drawn 30 m below instead", async ({ page, pageLog }) => {
  // 100 m above open ocean, looking straight down.
  await openPage(page, '/labs/render-core/?stand=0&maps=ocean&probe=inputs&body=earth&lat=0&lon=0&alt=100&pitch=-90&hud=0&paused=1&ev=14&sun=120,50&site=0,0');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
  });
  await waitIdle(page, 10);
  const probe = (): Promise<{ centreZ: number; cornerZ: number; centre: number[]; corner: number[] }> =>
    page.evaluate(async () => {
      const lab = window.__lab!;
      await window.__test!.waitFrames(4);
      const d = await lab.renderer.readDepth();
      const img = await lab.renderer.readHdrPixels('hdr');
      const z = (x: number, y: number): number => 0.05 / d.data[y * d.width + x]!;
      const c = (x: number, y: number): number[] => [0, 1, 2].map((k) => img.data[(y * img.width + x) * 4 + k]!);
      const cx = d.width >> 1;
      const cy = d.height >> 1;
      return { centreZ: z(cx, cy), cornerZ: z(8, 8), centre: c(cx, cy), corner: c(8, 8) };
    });
  const water = await probe();
  expect(water.centreZ).toBeGreaterThan(99.5);
  expect(water.centreZ).toBeLessThan(100.5);
  // Water: dark, blue-dominant body colour plus a little sky-less specular.
  expect(water.centre[2]).toBeGreaterThan(water.centre[0]!);
  await saveScreenshot(page, 'render-core', 'labplanet-water');

  // The ocean feature claims everything within 120 m of the eye: the centre (100 m) becomes seabed 30 m
  // lower, the corner of the view (about 154 m away) stays the far water sheet.
  await page.evaluate(() => window.__rc!.probes.inputs.setNearField({ fadeStart: 120, fadeEnd: 400 }));
  const near = await probe();
  expect(near.centreZ).toBeGreaterThan(129.5);
  expect(near.centreZ).toBeLessThan(130.5);
  expect(near.cornerZ).toBeCloseTo(water.cornerZ, 2);
  expect(near.corner[2]).toBeCloseTo(water.corner[2]!, 4);
  // Seabed: sand-coloured terrain, far brighter than the water was and red >= blue.
  expect(near.centre[0]).toBeGreaterThan(3 * water.centre[0]!);
  expect(near.centre[0]).toBeGreaterThan(near.centre[2]!);
  await saveScreenshot(page, 'render-core', 'labplanet-near-field-seabed');

  await page.evaluate(() => window.__rc!.probes.inputs.setNearField(null));
  const back = await probe();
  expect(back.centreZ).toBeCloseTo(water.centreZ, 2);
  await expectNoErrors(page, pageLog);
});
