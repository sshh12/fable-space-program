import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

// The first navigation of a run compiles the page through Vite; on a loaded machine that alone can take a minute.
test.describe.configure({ timeout: 600_000 });

/** Centre of the layers probe's panel in the site's ENU frame, m (LAYERS_PANEL in labs/render-core/probes.ts). */
const LAYERS_PANEL: [number, number, number] = [14, 8, 3.2];

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

test('soot and frost lie on the paint, each as a graded density, and the clear coat under them is covered (requests vehicle-pad-1, -7, -11)', async ({ page, pageLog }) => {
  await openPage(page, '/labs/render-core/?probe=inputs,layers&sun=180,40&hud=0&paused=1&ev=13');
  await assertDiscreteGpu(page);
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
  });
  // The panel's sunlit south face from 9 m, square on: 4 m x 6 m of clear-coated grey paint.
  const faceOn = (): Promise<void> => page.evaluate((c) => window.__rc!.lookAt(c, 180, 0, 9), LAYERS_PANEL);
  /** Luminance of the pixels inside the face (a tenth in from its edges), row by row, of the HDR target. */
  const face = (soot: number, frost: number): Promise<{ width: number; height: number; luma: number[] }> =>
    page.evaluate(
      async ([c, s, f]) => {
        const rc = window.__rc!;
        rc.probes.setLayers(s as number, f as number);
        await window.__test!.waitFrames(4);
        const [cx, cy, cz] = c as [number, number, number];
        const corners = [[cx - 1.6, cy - 0.1, cz - 2.4], [cx + 1.6, cy - 0.1, cz + 2.4]].map((p) => rc.projectSitePoint(p as [number, number, number])!);
        const x0 = Math.ceil(Math.min(corners[0]!.x, corners[1]!.x));
        const x1 = Math.floor(Math.max(corners[0]!.x, corners[1]!.x));
        const y0 = Math.ceil(Math.min(corners[0]!.y, corners[1]!.y));
        const y1 = Math.floor(Math.max(corners[0]!.y, corners[1]!.y));
        const img = await window.__lab!.renderer.readHdrPixels('hdr', { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
        const luma: number[] = [];
        for (let i = 0; i < img.width * img.height; i++) luma.push(0.2126 * img.data[i * 4]! + 0.7152 * img.data[i * 4 + 1]! + 0.0722 * img.data[i * 4 + 2]!);
        return { width: img.width, height: img.height, luma };
      },
      [LAYERS_PANEL, soot, frost] as const,
    );
  const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  await faceOn();
  await waitIdle(page, 10);
  const clean = await face(0, 0);
  expect(clean.width * clean.height, 'pixels of the face').toBeGreaterThan(40_000);
  const level = mean(clean.luma);
  // The clean paint is even: no pattern of its own.
  expect(Math.max(...clean.luma) / Math.min(...clean.luma)).toBeLessThan(1.3);

  // Full layers: the soot's brown-black (albedo 0.03 against 0.3) and the frost's white (0.95).
  const sooted = await face(1, 0);
  await saveScreenshot(page, 'render-core', 'mesh-soot-full');
  const frosted = await face(0, 1);
  // Soot is a density (request vehicle-pad-7). A quarter of the weight: a tan veil, the paint shows through.
  const quarter = await face(0.25, 0);
  await saveScreenshot(page, 'render-core', 'mesh-soot-quarter');
  // Half the weight: brown, in streaks along the flow, with no bare paint and no black cut-out in it.
  const half = await face(0.5, 0);
  await saveScreenshot(page, 'render-core', 'mesh-soot-half');
  const halfFrost = await face(0, 0.5);
  await saveScreenshot(page, 'render-core', 'mesh-frost-half');
  // A thin coat (request vehicle-pad-6) is a veil: every pixel hazed, no bare paint between the cells.
  const thinFrost = await face(0, 0.35);
  await saveScreenshot(page, 'render-core', 'mesh-frost-thin');
  const covered = half.luma.filter((v) => v < 0.5 * level).length / half.luma.length;
  // Streaks run along v (up the panel): neighbours differ more across than along.
  let across = 0;
  let along = 0;
  for (let y = 0; y + 1 < half.height; y++) {
    for (let x = 0; x + 1 < half.width; x++) {
      const v = half.luma[y * half.width + x]!;
      across += Math.abs(half.luma[y * half.width + x + 1]! - v);
      along += Math.abs(half.luma[(y + 1) * half.width + x]! - v);
    }
  }
  // Back to none: the image is the clean one, value for value.
  const again = await face(0, 0);

  // The coat. No sun on the face (it stands in the north now), a uniform environment of 4,000 cd/m^2, and the
  // face seen at 80 degrees from its normal: what reaches the eye is the coat's mirror image of the
  // environment (Fresnel about 0.4 there) on the clean paint, and the rough layer alone under soot or frost.
  await page.evaluate((c) => {
    const rc = window.__rc!;
    rc.setSun([0, 40]);
    rc.probes.inputs.setEnvRadiance(4000);
    rc.lookAt(c, 180 + 80, 0, 12);
  }, LAYERS_PANEL);
  await waitIdle(page, 10);
  const grazing = (soot: number, frost: number): Promise<number> =>
    page.evaluate(
      async ([c, s, f]) => {
        const rc = window.__rc!;
        rc.probes.setLayers(s as number, f as number);
        await window.__test!.waitFrames(4);
        const [cx, cy, cz] = c as [number, number, number];
        const p = rc.projectSitePoint([cx, cy - 0.1, cz])!;
        const img = await window.__lab!.renderer.readHdrPixels('hdr', { x: Math.round(p.x) - 2, y: Math.round(p.y) - 30, width: 5, height: 60 });
        let sum = 0;
        for (let i = 0; i < img.width * img.height; i++) sum += 0.2126 * img.data[i * 4]! + 0.7152 * img.data[i * 4 + 1]! + 0.0722 * img.data[i * 4 + 2]!;
        return sum / (img.width * img.height) / window.__lab!.renderer.frameContext!.exposure;
      },
      [LAYERS_PANEL, soot, frost] as const,
    );
  const coatClean = await grazing(0, 0);
  const coatSoot = await grazing(1, 0);
  const coatFrost = await grazing(0, 1);
  await page.evaluate(() => window.__rc!.probes.setLayers(0, 0));

  console.log(
    `soot and frost on clear-coated paint: quarter soot ${(mean(quarter.luma) / level).toFixed(2)} (${(Math.min(...quarter.luma) / level).toFixed(2)} .. ${(Math.max(...quarter.luma) / level).toFixed(2)}), half soot ${(Math.min(...half.luma) / level).toFixed(2)} .. ${(Math.max(...half.luma) / level).toFixed(2)}, full soot ${(Math.min(...sooted.luma) / level).toFixed(3)} .. ${(Math.max(...sooted.luma) / level).toFixed(3)}; ` +
      `full soot ${(mean(sooted.luma) / level).toFixed(3)}, full frost ${(mean(frosted.luma) / level).toFixed(2)} of the clean level; half soot: ${(100 * covered).toFixed(0)} % of the face under half the clean level, ` +
      `mean ${(mean(half.luma) / level).toFixed(2)}, neighbour difference across / along the streaks ${(across / along).toFixed(2)}; half frost mean ${(mean(halfFrost.luma) / level).toFixed(2)}; thin frost (0.35) min ${(Math.min(...thinFrost.luma) / level).toFixed(2)} mean ${(mean(thinFrost.luma) / level).toFixed(2)}; ` +
      `environment mirrored at 80 degrees: clean ${coatClean.toFixed(0)} cd/m^2, sooted ${coatSoot.toFixed(0)}, frosted ${coatFrost.toFixed(0)}`,
  );
  // Thick soot is near black everywhere (its streaks are a third of the density: brown-black to black).
  expect(mean(sooted.luma) / level).toBeLessThan(0.3);
  expect(Math.max(...sooted.luma) / level, 'the lightest pixel under full soot').toBeLessThan(0.45);
  expect(mean(frosted.luma) / level).toBeGreaterThan(2.3);
  // A quarter of the weight is a veil: the paint shows through everywhere, none of it dark, the mean about
  // four fifths. (Where the deposit is thinnest the clear coat it has dulled gives back what the veil takes:
  // those pixels are at the clean level, 1.03 of it measured.)
  expect(Math.max(...quarter.luma) / level, 'the barest pixel under a quarter of the soot').toBeLessThan(1.08);
  expect(Math.min(...quarter.luma) / level, 'the darkest pixel under a quarter of the soot').toBeGreaterThan(0.4);
  expect(mean(quarter.luma) / level).toBeGreaterThan(0.55);
  expect(mean(quarter.luma) / level).toBeLessThan(0.9);
  // Half the weight: between the two, graded: no bare paint, no black, and darker than the quarter everywhere it counts.
  expect(Math.max(...half.luma) / level, 'the barest pixel under half the soot').toBeLessThan(0.8);
  expect(Math.min(...half.luma) / level, 'the darkest pixel under half the soot').toBeGreaterThan(0.12);
  expect(mean(half.luma)).toBeLessThan(mean(quarter.luma));
  expect(mean(half.luma)).toBeGreaterThan(mean(sooted.luma));
  expect(covered, 'share of the face under half the clean level at half weight').toBeGreaterThan(0.05);
  // The streaks run along v (up the panel): neighbours differ more across than along.
  expect(across / along).toBeGreaterThan(1.5);
  expect(mean(halfFrost.luma) / level).toBeGreaterThan(1.3);
  expect(Math.min(...thinFrost.luma) / level, 'the barest pixel under thin frost').toBeGreaterThan(1.3);
  expect(mean(thinFrost.luma)).toBeLessThan(mean(frosted.luma));
  expect(again.luma).toEqual(clean.luma);
  // Under the layer there is no mirror: the clean coat reflects a thousand cd/m^2 and more of the 4,000.
  expect(coatClean).toBeGreaterThan(900);
  expect(coatSoot).toBeLessThan(0.35 * coatClean);
  expect(coatFrost).toBeLessThan(0.75 * coatClean);
  await expectNoErrors(page, pageLog);
});

test('frost is a coat with a thickness (request vehicle-pad-11): it grows with the weight everywhere at once, with no edge that the weight does not have', async ({ page, pageLog }) => {
  /** The sunlit face of the layers panel under frost of the given weights: mean, darkest and brightest pixel against the clean paint, and the 99th percentile of the step between neighbours across the runnels. */
  const measure = async (query: string, tag: string): Promise<Record<string, { mean: number; min: number; max: number; step99: number; bare: number; full: number }>> => {
    await openPage(page, `/labs/render-core/?probe=inputs,layers&sun=180,40&hud=0&paused=1&ev=13${query}`);
    await assertDiscreteGpu(page);
    await page.evaluate((c) => {
      window.__test!.setDeterministic(true);
      window.__lab!.renderer.setJitter(false);
      window.__rc!.lookAt(c, 180, 0, 9);
    }, LAYERS_PANEL);
    await waitIdle(page, 10);
    const face = (frost: number): Promise<{ width: number; height: number; luma: number[] }> =>
      page.evaluate(
        async ([c, f]) => {
          const rc = window.__rc!;
          rc.probes.setLayers(0, f as number);
          await window.__test!.waitFrames(4);
          const [cx, cy, cz] = c as [number, number, number];
          const corners = [[cx - 1.6, cy - 0.1, cz - 2.4], [cx + 1.6, cy - 0.1, cz + 2.4]].map((p) => rc.projectSitePoint(p as [number, number, number])!);
          const x0 = Math.ceil(Math.min(corners[0]!.x, corners[1]!.x));
          const x1 = Math.floor(Math.max(corners[0]!.x, corners[1]!.x));
          const y0 = Math.ceil(Math.min(corners[0]!.y, corners[1]!.y));
          const y1 = Math.floor(Math.max(corners[0]!.y, corners[1]!.y));
          const img = await window.__lab!.renderer.readHdrPixels('hdr', { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
          const luma: number[] = [];
          for (let i = 0; i < img.width * img.height; i++) luma.push(0.2126 * img.data[i * 4]! + 0.7152 * img.data[i * 4 + 1]! + 0.0722 * img.data[i * 4 + 2]!);
          return { width: img.width, height: img.height, luma };
        },
        [LAYERS_PANEL, frost] as const,
      );
    const clean = await face(0);
    const level = clean.luma.reduce((a, b) => a + b, 0) / clean.luma.length;
    const white = await face(1);
    const top = white.luma.reduce((a, b) => a + b, 0) / white.luma.length;
    const out: Record<string, { mean: number; min: number; max: number; step99: number; bare: number; full: number }> = {};
    for (const weight of [0.12, 0.35, 0.5, 0.75, 1]) {
      const f = await face(weight);
      await saveScreenshot(page, 'render-core', `mesh-frost-${tag}-${String(weight).replace('.', '')}`);
      const steps: number[] = [];
      for (let y = 0; y < f.height; y++) for (let x = 0; x + 1 < f.width; x++) steps.push(Math.abs(f.luma[y * f.width + x + 1]! - f.luma[y * f.width + x]!));
      steps.sort((a, b) => a - b);
      out[String(weight)] = {
        mean: f.luma.reduce((a, b) => a + b, 0) / f.luma.length / level,
        min: Math.min(...f.luma) / level,
        max: Math.max(...f.luma) / level,
        // In units of the way from clean paint to the full coat.
        step99: steps[Math.floor(0.99 * (steps.length - 1))]! / (top - level),
        // Share of the face that is (nearly) bare paint, and (nearly) the full coat: a mask has both at once.
        bare: f.luma.filter((v) => v < level + 0.1 * (top - level)).length / f.luma.length,
        full: f.luma.filter((v) => v > level + 0.9 * (top - level)).length / f.luma.length,
      };
    }
    await page.evaluate(() => window.__rc!.probes.setLayers(0, 0));
    await expectNoErrors(page, pageLog);
    return out;
  };
  // (Measured beside the coverage mask it replaced, 2026-11-12 19:05: at weight 0.35 the mask had its darkest
  // pixel at 1.72 and its brightest at 3.23 of the clean level, the full coat's, and 99 % of the steps
  // between neighbours under 0.47 of the way from paint to coat: dashes. The coat: 1.96 .. 2.72 and 0.046.)
  const coat = await measure('', 'coat');
  console.log(
    'frost as a coat: ' +
      ['0.12', '0.35', '0.5', '0.75', '1']
        .map((w) => [w, coat[w]!] as const)
        .map(([w, v]) => `weight ${w}: mean ${v.mean.toFixed(2)} (${v.min.toFixed(2)} .. ${v.max.toFixed(2)}), bare ${(100 * v.bare).toFixed(0)} %, full ${(100 * v.full).toFixed(0)} %, 99 % of the steps between neighbours under ${v.step99.toFixed(3)}`)
        .join('; '),
  );
  // The coat grows with the weight, everywhere at once: brighter with every weight, and at an in-between
  // weight no pixel bare beside pixels of the full coat (the mask's dashes).
  const weights = ['0.12', '0.35', '0.5', '0.75', '1'];
  for (let i = 1; i < weights.length; i++) expect.soft(coat[weights[i]!]!.mean, `weight ${weights[i]}`).toBeGreaterThanOrEqual(coat[weights[i - 1]!]!.mean - 0.01);
  expect.soft(Math.min(coat['0.35']!.bare, coat['0.35']!.full), 'bare paint beside full coat at weight 0.35').toBeLessThan(0.02);
  expect.soft(Math.min(coat['0.5']!.bare, coat['0.5']!.full), 'bare paint beside full coat at weight 0.5').toBeLessThan(0.02);
  // (Measured 2026-11-12: 99 % of the steps between neighbours under 0.046 of the way from paint to full coat, 0.48 with the mask.)
  expect.soft(coat['0.35']!.step99, 'steps between neighbours under a thin coat').toBeLessThan(0.1);
  expect.soft(coat['0.5']!.step99, 'steps between neighbours at half weight').toBeLessThan(0.1);
  // The full coat is the brightest thing on the panel and dead matte; a thin one hazes every pixel.
  expect.soft(coat['1']!.mean).toBeGreaterThan(2.3);
  expect.soft(coat['0.35']!.min, 'the barest pixel under a thin coat').toBeGreaterThan(1.2);
});

test('alpha-tested materials: a bar grating shows the ground through it, casts a dappled shadow and keeps its coverage far away (request vehicle-pad-4)', async ({ page, pageLog }) => {
  /** Mean HDR luminance over the screen box of a ground rectangle (site ENU, z = 0) and its share of red pixels. */
  const box = async (x0: number, x1: number, y0: number, y1: number, z: number): Promise<{ lum: number; red: number; px: number }> =>
    page.evaluate(
      async ({ r }) => {
        const lab = window.__lab!;
        await window.__test!.waitFrames(8);
        const ps = [
          [r.x0, r.y0],
          [r.x1, r.y0],
          [r.x0, r.y1],
          [r.x1, r.y1],
        ].map(([x, y]) => window.__rc!.projectSitePoint([x!, y!, r.z])!);
        const xs = ps.map((p) => p.x);
        const ys = ps.map((p) => p.y);
        // Inner box of the (possibly trapezoidal) projection; east is to the right in every view used here.
        const left = Math.ceil(Math.max(xs[0]!, xs[2]!));
        const right = Math.floor(Math.min(xs[1]!, xs[3]!));
        const top = Math.ceil(Math.min(...ys) + 0.15 * (Math.max(...ys) - Math.min(...ys)));
        const bottom = Math.floor(Math.max(...ys) - 0.15 * (Math.max(...ys) - Math.min(...ys)));
        const img = await lab.renderer.readHdrPixels('hdr', { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) });
        let lum = 0;
        let red = 0;
        const n = img.width * img.height;
        for (let i = 0; i < n; i++) {
          const R = img.data[i * 4]!;
          const G = img.data[i * 4 + 1]!;
          lum += 0.2126 * R + 0.7152 * G + 0.0722 * img.data[i * 4 + 2]!;
          if (R > 2.5 * G) red++;
        }
        return { lum: lum / n, red: red / n, px: n };
      },
      { r: { x0, x1, y0, y1, z } },
    );
  const shoot = async (mode: 'cutout' | 'opaque'): Promise<{ bars: number; farBars: number; shadow: number; open: number }> => {
    await openPage(page, `/labs/render-core/?sun=180,70&hud=0&paused=1&ev=14.6&grating=${mode}`);
    await assertDiscreteGpu(page);
    await page.evaluate(() => {
      window.__test!.setDeterministic(true);
      window.__lab!.renderer.setJitter(false);
      window.__rc!.lookAt(window.__rc!.stand!.grating!.pos, 0, 89.9, 6);
    });
    await waitIdle(page, 12);
    // From above, 6 m: the panel's own pixels against the ground through it.
    const top = await box(12.8, 15.2, -11.2, -8.8, 2);
    await saveScreenshot(page, 'render-core', `mesh-grating-${mode}-top`);
    // 60 m away: the bars are under a pixel; the coverage must stay the panel's solid share.
    await page.evaluate(() => window.__rc!.lookAt(window.__rc!.stand!.grating!.pos, 0, 89.9, 60));
    await waitIdle(page, 12);
    const far = await box(12.8, 15.2, -11.2, -8.8, 2);
    // From the south, under the panel's height: the ground in its shadow (the sun 70 deg up in the south puts it
    // 0.73 m north of the panel) against the sunlit ground east of it.
    await page.evaluate(() => window.__rc!.lookAt([14, -9.3, 0], 180, 12, 3));
    await waitIdle(page, 12);
    const shade = await box(13.5, 14.5, -9.8, -8.8, 0);
    const lit = await box(16.2, 16.8, -9.8, -8.8, 0);
    await saveScreenshot(page, 'render-core', `mesh-grating-${mode}-shadow`);
    const open = await page.evaluate(() => window.__rc!.stand!.grating!.open);
    return { bars: top.red, farBars: far.red, shadow: shade.lum / lit.lum, open };
  };
  const cut = await shoot('cutout');
  const solid = await shoot('opaque');
  console.log(`grating (open share ${cut.open.toFixed(3)}): panel pixels that are bars from 6 m ${cut.bars.toFixed(3)} (opaque ${solid.bars.toFixed(3)}), from 60 m ${cut.farBars.toFixed(3)} (opaque ${solid.farBars.toFixed(3)}); ground in its shadow / sunlit ground ${cut.shadow.toFixed(3)} (opaque ${solid.shadow.toFixed(3)})`);
  // The opaque panel is a plank: all bar colour, and a full shadow.
  expect(solid.bars).toBeGreaterThan(0.95);
  expect(solid.shadow).toBeLessThan(0.3);
  // The cut-out panel: the bars only, near and far (a fixed cut at 0.5 of the mip-averaged alpha would lose it).
  expect(Math.abs(cut.bars - (1 - cut.open))).toBeLessThan(0.08);
  expect(Math.abs(cut.farBars - (1 - cut.open))).toBeLessThan(0.1);
  // Its shadow lets the open share of the sun through (plus the ambient that the opaque one keeps too).
  expect(cut.shadow).toBeGreaterThan(cut.open - 0.12);
  expect(cut.shadow).toBeLessThan(cut.open + 0.1 + solid.shadow);
  await expectNoErrors(page, pageLog);
});
