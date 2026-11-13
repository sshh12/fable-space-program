/**
 * The sea under an overcast deck, with every render package (the integration lab on the real tiles, the real
 * atmosphere and clouds, the capsule of the chutes scene at the water): the last picture of the mission.
 *
 * A water surface mirrors the sky above it and lets most of the light in: under a closed deck it cannot be brighter
 * than the deck (visual round 3: the sea of this scene stood at 1.3 to 1.7 times the sky, because brdf_water
 * mirrored the published sky tables as they are, and those hold the sunlit air of a clear day in front of a cloud
 * base of their own model). Asserted here on the linear HDR image: the sea just under the horizon and the near water
 * are darker than the sky just above the horizon, for a high and for a low sun; printed beside it: the same with
 * the mirror as it was (OceanDebug.setCloudMirror(false)), with the ambient and the sun term switched off in turn,
 * and the single terms (debug views), which is how the cause was told from the other candidates.
 *
 * Under a clear sky the new term is exactly nothing: the same scene at a clear place, time standing still, gives
 * the same image with the mirror as it was (band means within 0.2 %).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';
import { cloudClock, coverageBox, coverageMap, findSky, mapToFixedLon, openIntegration, repoRoot, type SkyBox } from '../integration/helpers';

test.describe.configure({ timeout: 25 * 60_000 });
test.use({ viewport: { width: 2560, height: 1440 } });

const EARTH_RADIUS = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'tiles', 'earth', 'manifest.json'), 'utf8')) as { radius: number }).radius;
const CLOUDS = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'render', 'earth.clouds.json'), 'utf8')) as { params: { coverageDriftMps: number } };

/**
 * Open ocean without an island within two degrees (body-fixed degrees): the south-east and the north-east Pacific,
 * the middle of the North and of the South Atlantic, the southern Indian Ocean.
 */
const OPEN_OCEAN: readonly (readonly [latMin: number, latMax: number, lonMin: number, lonMax: number])[] = [
  [-45, -30, -128, -96],
  [-22, -5, -128, -96],
  [26, 45, -170, -135],
  [36, 46, -48, -33],
  [-45, -20, -30, -15],
  [-45, -25, 82, 100],
];
const openOcean = (latDeg: number, lonDeg: number): boolean => OPEN_OCEAN.some(([a, b, c, d]) => latDeg >= a && latDeg <= b && lonDeg >= c && lonDeg <= d);

interface Place {
  latDeg: number;
  lonDeg: number;
  box: SkyBox;
}

/** A place of the wanted sky over the open ocean, for the cloud clock the chutes scene starts with. */
async function findPlace(page: Page, kind: 'overcast' | 'clear'): Promise<Place | null> {
  const map = coverageMap();
  if (!map) return null;
  await openIntegration(page, 'features=atmosphere&scene=chutes&paused=1&hud=0');
  const clock = await cloudClock(page);
  for (const box of findSky(map, kind, kind === 'overcast' ? 1.0 : 2.0, 46)) {
    const lonDeg = mapToFixedLon(box.lonMapDeg, clock.time ?? 0, clock.drift ?? CLOUDS.params.coverageDriftMps, EARTH_RADIUS);
    if (openOcean(box.latDeg, lonDeg)) return { latDeg: box.latDeg, lonDeg, box };
  }
  return null;
}

interface Bands {
  /** Mean linear luminance (pre-exposed) of the sky just above the horizon, the sea just under it and the near water. */
  sky: number;
  sea: number;
  near: number;
  /** Mean linear rgb of the near water. */
  nearRgb: [number, number, number];
  horizonRow: number;
}

type OceanHandle = {
  debug: {
    setCloudMirror(on: boolean): void;
    setProfileSkip(mask: number): void;
    setDebugView(view: string): void;
    readOpaqueDepth(p: [number, number][]): Promise<number[]>;
    nearField(): { bodyIndex: number };
  };
};

/** The horizon in four columns clear of the capsule and its lines (first row with opaque geometry), and the bands about it. */
async function bands(page: Page): Promise<Bands> {
  return page.evaluate(async () => {
    const ocean = (window.__integration?.handles['ocean.createOceanFeature'] ?? window.__ocean!.ocean) as OceanHandle;
    const img = await window.__lab!.renderer.readHdrPixels('hdr');
    const { width: w, height: h, data } = img;
    const cols = [0.04, 0.12, 0.88, 0.96].map((f) => Math.round(f * w));
    const px: [number, number][] = [];
    for (const x of cols) for (let y = 0; y < h; y += 2) px.push([x, y]);
    const depth = await ocean.debug.readOpaqueDepth(px);
    const perCol = Math.ceil(h / 2);
    const rows = cols.map((_, c) => {
      for (let i = 0; i < perCol; i++) if (depth[c * perCol + i]! > 0) return i * 2;
      return -1;
    });
    const horizonRow = Math.round(rows.reduce((a, b) => a + b, 0) / rows.length);
    const mean = (x0: number, x1: number, y0: number, y1: number): [number, number, number, number] => {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * w + x) * 4;
          r += data[o]!;
          g += data[o + 1]!;
          b += data[o + 2]!;
          n++;
        }
      }
      return [r / n, g / n, b / n, (0.2126 * r + 0.7152 * g + 0.0722 * b) / n];
    };
    // Left and right thirds of the frame (the capsule and its parachute lines stand in the middle one).
    const two = (y0: number, y1: number): [number, number, number, number] => {
      const a = mean(0, Math.round(0.3 * w), y0, y1);
      const b = mean(Math.round(0.7 * w), w, y0, y1);
      return [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1]), 0.5 * (a[2] + b[2]), 0.5 * (a[3] + b[3])];
    };
    const sky = two(horizonRow - Math.round(0.05 * h), horizonRow - Math.round(0.012 * h));
    const sea = two(horizonRow + Math.round(0.012 * h), horizonRow + Math.round(0.05 * h));
    const near = two(Math.round(0.84 * h), Math.round(0.97 * h));
    return { sky: sky[3], sea: sea[3], near: near[3], nearRgb: [near[0], near[1], near[2]], horizonRow };
  });
}

const oceanDebug = (page: Page, fn: 'setCloudMirror' | 'setProfileSkip' | 'setDebugView', arg: boolean | number | string): Promise<void> =>
  page.evaluate(
    ([f, a]) => {
      const d = ((window.__integration?.handles['ocean.createOceanFeature'] ?? window.__ocean!.ocean) as OceanHandle).debug as unknown as Record<string, (x: unknown) => void>;
      d[f as string]!(a);
    },
    [fn, arg] as const,
  );

/** The capsule at the water, the camera 26 m off and a little above the swell, the horizon across the frame; the sun behind the camera. */
async function openAtTheWater(page: Page, place: Place, sunElevationDeg: number): Promise<Awaited<ReturnType<typeof openIntegration>>> {
  const info = await openIntegration(page, `scene=chutes&start=40&hud=0&governor=off&scale=1&at=${place.latDeg},${place.lonDeg}&sun=25,${sunElevationDeg}&sunsite=earth,${place.latDeg},${place.lonDeg}`);
  await assertDiscreteGpu(page);
  await page.evaluate(() => window.__test!.waitFrames(420));
  await page.evaluate(() => window.__integration!.orbitVesselPoint(25, 6, 26, 2));
  await page.evaluate(() => window.__test!.waitFrames(90));
  await waitIdle(page, 30, 240_000);
  return info;
}

const fmt = (b: Bands): string => `sky ${b.sky.toExponential(3)}, sea under the horizon ${(b.sea / b.sky).toFixed(3)} x sky, near water ${(b.near / b.sky).toFixed(3)} x sky (rgb ${b.nearRgb.map((v) => (v / b.sky).toFixed(4)).join(' / ')} of the sky)`;

test('overcast: the sea is darker than the deck it lies under', async ({ page, pageLog }) => {
  const place = await findPlace(page, 'overcast');
  expect(place, 'an overcast place over the open ocean in the coverage map').not.toBeNull();
  const report: string[] = [`place ${place!.latDeg}, ${place!.lonDeg.toFixed(2)} (coverage within 1 deg: ${place!.box.min.toFixed(2)} to ${place!.box.max.toFixed(2)})`];
  for (const elevation of [35, 12]) {
    const info = await openAtTheWater(page, place!, elevation);
    test.skip(!info.loaded.includes('ocean') || !info.loaded.includes('atmosphere'), 'the ocean or the atmosphere package is not loaded in the integration lab');
    const active = await page.evaluate(() => (window.__integration!.handles['ocean.createOceanFeature'] as OceanHandle).debug.nearField().bodyIndex);
    expect(active, 'the near field is active: the camera is over the sea').toBeGreaterThanOrEqual(0);
    const shipped = await bands(page);
    expect(shipped.horizonRow, 'the horizon is in the frame').toBeGreaterThan(200);
    expect(shipped.horizonRow).toBeLessThan(1240);
    report.push(`sun ${elevation} deg, shipped: ${fmt(shipped)}`);
    await saveScreenshot(page, 'ocean', `overcast-sea-sun${elevation}`);
    // The single terms of the shipped shading (debug views; fractions of the sky's luminance, sea band / near band).
    for (const view of ['skyReflection', 'body', 'sunSpecular'] as const) {
      await oceanDebug(page, 'setDebugView', view);
      await waitIdle(page, 12);
      const b = await bands(page);
      report.push(`  term ${view}: ${(b.sea / b.sky).toFixed(4)} / ${(b.near / b.sky).toFixed(4)}`);
    }
    await oceanDebug(page, 'setDebugView', 'none');
    // The mirror as it was before round 3, alone and with the ambient or the sun term off.
    await oceanDebug(page, 'setCloudMirror', false);
    await waitIdle(page, 40, 240_000);
    const before = await bands(page);
    report.push(`  mirror as before round 3: ${fmt(before)}`);
    await saveScreenshot(page, 'ocean', `overcast-sea-sun${elevation}-before`);
    await oceanDebug(page, 'setDebugView', 'skyReflection');
    await waitIdle(page, 12);
    const mirrorBefore = await bands(page);
    report.push(`    term skyReflection: ${(mirrorBefore.sea / mirrorBefore.sky).toFixed(4)} / ${(mirrorBefore.near / mirrorBefore.sky).toFixed(4)}`);
    await oceanDebug(page, 'setDebugView', 'none');
    for (const [label, mask] of [
      ['ambient term off', 512],
      ['sun term off', 1024],
      ['cloud lookup off', 256],
    ] as const) {
      await oceanDebug(page, 'setProfileSkip', mask);
      await waitIdle(page, 12);
      const b = await bands(page);
      report.push(`    ${label}: sea ${(b.sea / b.sky).toFixed(3)} x sky, near ${(b.near / b.sky).toFixed(3)} x sky`);
    }
    await oceanDebug(page, 'setProfileSkip', 0);
    await oceanDebug(page, 'setCloudMirror', true);
    await waitIdle(page, 40, 240_000);
    const hdr = await page.evaluate(() => window.__test!.hdrStats());
    expect(hdr.nanPixels).toBe(0);
    console.log(report.join('\n'));
    // Under the deck the sea mirrors the deck and lets most of its light in: never brighter than the sky above it.
    expect(shipped.sea, `sun ${elevation} deg: sea under the horizon against the sky above it`).toBeLessThan(shipped.sky);
    expect(shipped.near, `sun ${elevation} deg: near water against the sky above the horizon`).toBeLessThan(shipped.sky);
    // Grey-green to slate, never beige: under a high sun behind the deck the near water is bluer than it is red.
    if (elevation >= 30) expect(shipped.nearRgb[2], `sun ${elevation} deg: blue against red of the near water`).toBeGreaterThan(shipped.nearRgb[0]);
    // And the fix is what brings it there: the old mirror was brighter.
    expect(before.sea / before.sky, `sun ${elevation} deg: the mirror as it was, against the shipped one (sea under the horizon / sky)`).toBeGreaterThan(shipped.sea / shipped.sky);
    await expectNoErrors(page, pageLog);
  }
  fs.mkdirSync(path.join(repoRoot, 'out', 'ocean'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'out', 'ocean', 'overcast.txt'), `${report.join('\n')}\n`);
});

test('clear sky: the cloud term of the mirror is nothing, the Fresnel ramp stands', async ({ page, pageLog }) => {
  // The ocean lab's sky has no cloud at all (the integration lab's has fair-weather cumulus wherever the map is clear).
  await openPage(page, '/labs/ocean/?preset=midday&governor=off&scale=1');
  await assertDiscreteGpu(page);
  // Time stands still, no jitter: the three frames show the same sea.
  await page.evaluate(() => {
    window.__test!.setPaused(true);
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
    document.body.classList.add('shot');
  });
  await waitIdle(page, 40, 240_000);
  const shipped = await bands(page);
  await oceanDebug(page, 'setCloudMirror', false);
  await waitIdle(page, 40, 240_000);
  const before = await bands(page);
  await oceanDebug(page, 'setCloudMirror', true);
  await waitIdle(page, 40, 240_000);
  const again = await bands(page);
  console.log(`clear sky (ocean lab, midday): shipped ${fmt(shipped)}\n  mirror as before round 3: ${fmt(before)}\n  shipped again: ${fmt(again)}`);
  // The same image (the third frame, shipped again, says what two frames of one shading differ by).
  for (const key of ['sea', 'near'] as const) {
    const noise = Math.abs(again[key] / again.sky - shipped[key] / shipped.sky);
    expect(Math.abs(before[key] / before.sky - shipped[key] / shipped.sky), `${key}: the mirror as it was against the shipped one, under a clear sky`).toBeLessThan(0.002 * (shipped[key] / shipped.sky) + 2 * noise);
  }
  // A clear day's Fresnel ramp: the sea under the horizon well under the sky, the near water far under it.
  expect(shipped.sea).toBeLessThan(0.8 * shipped.sky);
  expect(shipped.near).toBeLessThan(0.4 * shipped.sky);
  expect(shipped.near).toBeLessThan(shipped.sea);
  await expectNoErrors(page, pageLog);
});

test('fair weather with every package: the sea under the sky', async ({ page, pageLog }) => {
  // The clearest open sea of the coverage map (the density model still stands fair-weather cumulus there).
  const map = coverageMap();
  expect(map, 'the coverage map of the tile set').not.toBeNull();
  await openIntegration(page, 'features=atmosphere&scene=chutes&paused=1&hud=0');
  const clock = await cloudClock(page);
  let place: Place | null = null;
  for (const [latMin, latMax, lonMin, lonMax] of OPEN_OCEAN) {
    for (let lat = latMin + 2; lat <= latMax - 2; lat += 2) {
      for (let lon = lonMin + 2; lon <= lonMax - 2; lon += 2) {
        const lonMap = lon - (mapToFixedLon(0, clock.time ?? 0, clock.drift ?? CLOUDS.params.coverageDriftMps, EARTH_RADIUS) - 0);
        const box = coverageBox(map!, lat, ((((lonMap + 180) % 360) + 360) % 360) - 180, 1.0);
        if (!place || box.max < place.box.max) place = { latDeg: lat, lonDeg: lon, box };
      }
    }
  }
  const info = await openAtTheWater(page, place!, 35);
  test.skip(!info.loaded.includes('ocean') || !info.loaded.includes('atmosphere'), 'the ocean or the atmosphere package is not loaded in the integration lab');
  const shipped = await bands(page);
  await saveScreenshot(page, 'ocean', 'fair-weather-sea-sun35');
  await oceanDebug(page, 'setCloudMirror', false);
  await waitIdle(page, 40, 240_000);
  const before = await bands(page);
  await oceanDebug(page, 'setCloudMirror', true);
  console.log(`fair weather at ${place!.latDeg}, ${place!.lonDeg.toFixed(2)} (coverage within 1 deg up to ${place!.box.max.toFixed(2)}): shipped ${fmt(shipped)}\n  mirror as before round 3: ${fmt(before)}`);
  expect(shipped.sea, 'the sea under the horizon against the sky above it').toBeLessThan(shipped.sky);
  expect(shipped.near, 'the near water against the sky above the horizon').toBeLessThan(shipped.sky);
  await expectNoErrors(page, pageLog);
});

