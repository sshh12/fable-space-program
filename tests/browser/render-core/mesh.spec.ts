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

for (const mode of ['sheet', 'fixed'] as const) {
  test(`LabPlanet: ocean-coloured texels are water, and inside 'ocean.nearField' the seabed is drawn instead (${mode === 'sheet' ? 'as deep and as coloured as the sheet it replaces' : 'fixed sand floor 30 m down'})`, async ({ page, pageLog }) => {
    // 100 m above open ocean, looking straight down.
    await openPage(page, `/labs/render-core/?stand=0&maps=ocean&probe=inputs&body=earth&lat=0&lon=0&alt=100&pitch=-90&hud=0&paused=1&ev=14&sun=120,50&site=0,0${mode === 'fixed' ? '&seabed=30' : ''}`);
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
    if (mode === 'sheet') await saveScreenshot(page, 'render-core', 'labplanet-water');

    // The ocean feature claims everything within 120 m of the eye: the centre (100 m) becomes seabed, the
    // corner of the view (about 154 m away) stays the far water sheet.
    await page.evaluate(() => window.__rc!.probes.inputs.setNearField({ fadeStart: 120, fadeEnd: 400 }));
    const near = await probe();
    expect(near.cornerZ).toBeCloseTo(water.cornerZ, 2);
    expect(near.corner[2]).toBeCloseTo(water.corner[2]!, 4);
    if (mode === 'sheet') {
      // The ocean map is dark (deep) water: the sheet encodes the full 200 m (WATER_DEPTH_ENCODE_MAX), so
      // the seabed that replaces it lies 200 m below the surface and carries the map's blue as its albedo.
      expect(near.centreZ).toBeGreaterThan(299.5);
      expect(near.centreZ).toBeLessThan(300.5);
      expect(near.centre[2]).toBeGreaterThan(2 * near.centre[0]!);
      await saveScreenshot(page, 'render-core', 'labplanet-near-field-seabed');
    } else {
      expect(near.centreZ).toBeGreaterThan(129.5);
      expect(near.centreZ).toBeLessThan(130.5);
      // Sand-coloured terrain, far brighter than the water was and red >= blue.
      expect(near.centre[0]).toBeGreaterThan(3 * water.centre[0]!);
      expect(near.centre[0]).toBeGreaterThan(near.centre[2]!);
      await saveScreenshot(page, 'render-core', 'labplanet-near-field-sand');
    }

    await page.evaluate(() => window.__rc!.probes.inputs.setNearField(null));
    const back = await probe();
    expect(back.centreZ).toBeCloseTo(water.centreZ, 2);
    await expectNoErrors(page, pageLog);
  });
}

test("mesh system: 'ocean.wetness' wets a hull below its wet line and nothing above it or outside the slot's radius", async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?probe=inputs&sun=100,40&hud=0&paused=1&ev=14');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
    // The tower (1 x 1 x 8 m at x = -7, y = -4) seen from the east: its sunlit +x face.
    window.__rc!.lookAt([-7, -4, 4], 90, 5, 22);
  });
  await waitIdle(page, 10);
  // Luminance of the tower face at 2 m (below the 3 m wet line), 5 m (above it, inside the slot's 6 m
  // radius) and 7.5 m (outside the radius), and of a point of the slab far from the slot.
  const sample = (): Promise<number[]> =>
    page.evaluate(async () => {
      await window.__test!.waitFrames(4);
      const out: number[] = [];
      for (const p of [[-6.5, -4, 2], [-6.5, -4, 5], [-6.5, -4, 7.5], [-9, 5, 0]] as [number, number, number][]) {
        const px = window.__rc!.projectSitePoint(p)!;
        const img = await window.__lab!.renderer.readHdrPixels('hdr', { x: Math.round(px.x) - 1, y: Math.round(px.y) - 1, width: 3, height: 3 });
        let sum = 0;
        for (let i = 0; i < 9; i++) sum += 0.2126 * img.data[i * 4]! + 0.7152 * img.data[i * 4 + 1]! + 0.0722 * img.data[i * 4 + 2]!;
        out.push(sum / 9);
      }
      return out;
    });
  const dry = await sample();
  for (const v of dry) expect(v).toBeGreaterThan(0.01);
  await page.evaluate(() => window.__rc!.probes.inputs.setOceanWetness({ at: [-7, -4, 0], radius: 6, wetLine: 3 }));
  const wet = await sample();
  await saveScreenshot(page, 'render-core', 'mesh-wet-line');
  console.log(`wet line: below ${(wet[0]! / dry[0]!).toFixed(3)}, above ${(wet[1]! / dry[1]!).toFixed(4)}, outside the radius ${(wet[2]! / dry[2]!).toFixed(4)}, slab ${(wet[3]! / dry[3]!).toFixed(4)} of the dry luminance`);
  // Below the line the surface is wet: a non-metal darkens to about 0.6 of its dry diffuse colour.
  expect(wet[0]! / dry[0]!).toBeGreaterThan(0.5);
  expect(wet[0]! / dry[0]!).toBeLessThan(0.75);
  // Above the line, outside the radius and away from the slot nothing changes.
  expect(wet[1]).toBe(dry[1]);
  expect(wet[2]).toBe(dry[2]);
  expect(wet[3]).toBe(dry[3]);
  // The default resource (no vessel at the water) restores the dry image exactly.
  await page.evaluate(() => window.__rc!.probes.inputs.setOceanWetness(null));
  expect(await sample()).toEqual(dry);
  await expectNoErrors(page, pageLog);
});
