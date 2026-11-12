import { assertDiscreteGpu, expect, openPage, saveScreenshot, test, waitIdle } from '../harness';
import { LUNAR_SITE, PAD } from './util';

test.use({ viewport: { width: 1920, height: 1080 } });

/**
 * The ground around the pad as the game shows it: the terrain together with the sky, the atmosphere and the
 * ocean in core-support's integration lab (labs/integration), at the distances a launch passes through.
 * The terrain lab draws the terrain alone under a stand-in sky; these are the pictures to judge the ground
 * by (out/screens/terrain/integrated-<view>.png). The lab loads whatever packages exist in the tree, so the
 * spec asserts only what the terrain owns: it is loaded, it drew, and it reported no error of its own.
 */
const PAD_ELEVATION = 21.62;

interface IntegratedView {
  name: string;
  lat: number;
  lon: number;
  /** Height above the datum, m (the ground within 450 m of the pad is flat at the pad's elevation). */
  alt: number;
  heading: number;
  pitch: number;
  fov?: number;
}

/**
 * The game's own views of the two surfaces (the lab's default chase camera on the vessel, every package
 * that is in the tree): the stack on the pad and the lander on the Moon, as a player sees the ground.
 */
const GAME_VIEWS: { name: string; scene: string; extra: string }[] = [
  { name: 'game-pad', scene: 'pad', extra: `&sun=105,31&sunsite=earth,${PAD.lat},${PAD.lon}` },
  { name: 'game-lunar-surface', scene: 'lunarSurface', extra: `&sun=92,11&sunsite=moon,${LUNAR_SITE.lat},${LUNAR_SITE.lon}` },
];

/**
 * The views of the ground are exposed as the reference photographs of this coast are (EV100 13.5: "sunny
 * 16" less a stop and a half), not by the lab's meter: a frame filled with lava is metered up another stop
 * and more, to a grey plain under a blown sky, and a photograph of a lava field is not taken that way. At
 * 14.5 (the first choice) the sky stood at 0.18 to 0.23 of white where the photographs have 0.55, and a
 * tenth of a frame of broken lava was under 8 of 255. The game's own views (GAME_VIEWS) keep the meter.
 * The far views (10 km and up) keep it too: sea, cloud and land.
 */
const DAYLIGHT_EV = 13.5;

const VIEWS: IntegratedView[] = [
  { name: 'apron-eye', lat: PAD.lat - 0.0004, lon: PAD.lon + 0.0003, alt: PAD_ELEVATION + 1.7, heading: 2, pitch: -6 },
  { name: 'off-apron-eye', lat: PAD.lat + 0.0022, lon: PAD.lon + 0.0012, alt: PAD_ELEVATION + 1.7, heading: 20, pitch: -12 },
  { name: 'ground-close', lat: PAD.lat + 0.0022, lon: PAD.lon + 0.0012, alt: PAD_ELEVATION + 1.7, heading: 20, pitch: -50, fov: 35 },
  { name: '30m', lat: PAD.lat - 0.0016, lon: PAD.lon - 0.0012, alt: PAD_ELEVATION + 30, heading: 40, pitch: -22 },
  { name: '200m', lat: PAD.lat + 0.001, lon: PAD.lon + 0.0085, alt: 200, heading: 30, pitch: -20 },
  { name: '1km', lat: PAD.lat - 0.004, lon: PAD.lon - 0.004, alt: 1000, heading: 45, pitch: -35 },
  // Where the land cover says grass and trees (ground cover: tussocks, scrub, kiawe), 500 to 700 m from the
  // pad, at eye height and from 120 m; and the broken, stony ground 1 km south-west of it.
  // (Heights of the ground there: 14.84, 21.15, 21.62 and 18.27 m, from the height authority.)
  { name: 'grass-eye', lat: PAD.lat + 0.0041, lon: PAD.lon + 0.0052, alt: 14.84 + 1.7, heading: 320, pitch: -5 },
  { name: 'kiawe-eye', lat: PAD.lat + 0.0062, lon: PAD.lon + 0.0005, alt: 21.15 + 1.7, heading: 70, pitch: -3 },
  { name: 'kiawe-120m', lat: PAD.lat + 0.0035, lon: PAD.lon - 0.001, alt: 21.62 + 120, heading: 15, pitch: -24 },
  { name: 'stony-ground', lat: 18.981197, lon: -155.609964, alt: 18.27 + 1.7, heading: 200, pitch: -8 },
  // The far views of the brief as the game shows them: with atmosphere, clouds' absence aside, and ocean.
  { name: '10km', lat: PAD.lat, lon: PAD.lon, alt: 10e3, heading: 340, pitch: -25 },
  { name: '40km', lat: PAD.lat, lon: PAD.lon, alt: 40e3, heading: 330, pitch: -35 },
  { name: 'leo-hawaii', lat: 17.2, lon: -154.6, alt: 400e3, heading: 340, pitch: -55 },
];

/** INTEGRATED_VIEWS=30m,grass-eye limits the run. */
const only = process.env.INTEGRATED_VIEWS?.split(',').filter(Boolean);

test('the ground around the pad with sky, atmosphere and ocean (integration lab)', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  for (const v of VIEWS) {
    if (only && !only.includes(v.name)) continue;
    const q = new URLSearchParams({
      features: 'terrain,sky,atmosphere,ocean',
      scene: 'pad',
      paused: '1',
      body: 'earth',
      lat: String(v.lat),
      lon: String(v.lon),
      alt: String(v.alt),
      heading: String(v.heading),
      pitch: String(v.pitch),
      sun: '105,31',
      sunsite: `earth,${PAD.lat},${PAD.lon}`,
    });
    if (v.fov) q.set('fov', String(v.fov));
    if (v.alt < 5000) q.set('ev', String(DAYLIGHT_EV));
    await openPage(page, `/labs/integration/?${q.toString()}`, { timeoutMs: 180_000 });
    await assertDiscreteGpu(page);
    await waitIdle(page, 20, 240_000);
    const info = await page.evaluate(() => {
      const lab = (window as unknown as { __integration: { loaded: string[]; problems: string[]; quarantined: { pkg: string; errors: string[] }[] } }).__integration;
      return { loaded: lab.loaded, problems: lab.problems, quarantined: lab.quarantined };
    });
    const s = await saveScreenshot(page, 'terrain', `integrated-${v.name}`);
    console.log(`integrated-${v.name}: loaded ${info.loaded.join(', ')}; mean luma ${s.stats.meanLuma.toFixed(1)}${info.problems.length ? `; lab problems: ${info.problems.join(' | ')}` : ''}`);
    expect(info.loaded).toContain('terrain');
    expect(info.quarantined.filter((x) => x.pkg === 'terrain')).toEqual([]);
    // (Soft: a view that fails it must not keep the views after it from being rendered.)
    expect.soft(s.stats.fractionNonBlack, `integrated-${v.name}: share of the frame that is not black`).toBeGreaterThan(0.9);
  }
});

/**
 * A kiawe from where a player standing among the trees sees it: three metres outside its crown at eye
 * height, the sun behind the camera. The tree is the one nearest to the kiawe-eye view's place (the ground
 * cover says where it stands), so the picture follows the placement instead of hoping for a tree in frame.
 */
test('a kiawe from three metres outside its crown (integration lab)', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  if (only && !only.includes('kiawe-close')) return;
  const at = VIEWS.find((v) => v.name === 'kiawe-eye')!;
  const url = (lat: number, lon: number, alt: number, heading: number, pitch: number): string =>
    `/labs/integration/?${new URLSearchParams({ features: 'terrain,sky,atmosphere,ocean', scene: 'pad', paused: '1', body: 'earth', lat: String(lat), lon: String(lon), alt: String(alt), heading: String(heading), pitch: String(pitch), sun: '105,31', sunsite: `earth,${PAD.lat},${PAD.lon}`, ev: String(DAYLIGHT_EV) }).toString()}`;
  await openPage(page, url(at.lat, at.lon, at.alt, at.heading, at.pitch), { timeoutMs: 180_000 });
  await assertDiscreteGpu(page);
  await waitIdle(page, 20, 240_000);
  const tree = await page.evaluate(
    ([lat, lon]) => {
      const handles = (window as unknown as { __integration: { handles: Record<string, unknown> } }).__integration.handles;
      const terrain = Object.values(handles).find((h) => typeof (h as { debug?: { nearestCover?: unknown } } | null)?.debug?.nearestCover === 'function') as
        | { debug: { nearestCover(b: string, k: string, lat: number, lon: number): { latDeg: number; lonDeg: number; radiusM: number; heightM: number; groundM: number; distanceM: number } | null } }
        | undefined;
      return terrain?.debug.nearestCover('earth', 'kiawe', lat, lon) ?? null;
    },
    [at.lat, at.lon] as const,
  );
  expect(tree, 'a kiawe near the kiawe-eye view').not.toBeNull();
  // The camera stands towards the sun from the tree (azimuth 105 degrees) and looks back at it, a little upwards.
  const stand = tree!.radiusM + 3;
  const az = (105 * Math.PI) / 180;
  const lat = tree!.latDeg + ((stand * Math.cos(az)) / 6371000) * (180 / Math.PI);
  const lon = tree!.lonDeg + ((stand * Math.sin(az)) / (6371000 * Math.cos((tree!.latDeg * Math.PI) / 180))) * (180 / Math.PI);
  await openPage(page, url(lat, lon, tree!.groundM + 1.7, 285, 8), { timeoutMs: 180_000 });
  await waitIdle(page, 20, 240_000);
  const s = await saveScreenshot(page, 'terrain', 'integrated-kiawe-close');
  console.log(`integrated-kiawe-close: a kiawe of radius ${tree!.radiusM.toFixed(1)} m and height ${tree!.heightM.toFixed(1)} m, ${tree!.distanceM.toFixed(0)} m from the kiawe-eye view; camera ${stand.toFixed(1)} m from its trunk; mean luma ${s.stats.meanLuma.toFixed(1)}`);
  expect(s.stats.fractionNonBlack).toBeGreaterThan(0.9);
});

test('the ground under the vessel as the game shows it (integration lab, every package)', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  for (const v of GAME_VIEWS) {
    if (only && !only.includes(v.name)) continue;
    await openPage(page, `/labs/integration/?features=all&scene=${v.scene}&paused=1${v.extra}`, { timeoutMs: 180_000 });
    await assertDiscreteGpu(page);
    await waitIdle(page, 20, 240_000);
    const info = await page.evaluate(() => {
      const lab = (window as unknown as { __integration: { loaded: string[]; quarantined: { pkg: string; errors: string[] }[] } }).__integration;
      return { loaded: lab.loaded, quarantined: lab.quarantined };
    });
    const s = await saveScreenshot(page, 'terrain', `integrated-${v.name}`);
    console.log(`integrated-${v.name}: loaded ${info.loaded.join(', ')}; mean luma ${s.stats.meanLuma.toFixed(1)}`);
    expect(info.loaded).toContain('terrain');
    expect(info.quarantined.filter((x) => x.pkg === 'terrain')).toEqual([]);
  }
});
