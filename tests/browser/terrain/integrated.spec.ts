import { assertDiscreteGpu, expect, openPage, saveScreenshot, test, waitIdle } from '../harness';
import { PAD } from './util';

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

const VIEWS: IntegratedView[] = [
  { name: 'apron-eye', lat: PAD.lat - 0.0009, lon: PAD.lon, alt: PAD_ELEVATION + 1.7, heading: 2, pitch: -6 },
  { name: 'off-apron-eye', lat: PAD.lat + 0.0022, lon: PAD.lon + 0.0012, alt: PAD_ELEVATION + 1.7, heading: 20, pitch: -12 },
  { name: 'ground-close', lat: PAD.lat + 0.0022, lon: PAD.lon + 0.0012, alt: PAD_ELEVATION + 1.7, heading: 20, pitch: -50, fov: 35 },
  { name: '30m', lat: PAD.lat - 0.0016, lon: PAD.lon - 0.0012, alt: PAD_ELEVATION + 30, heading: 40, pitch: -22 },
  { name: '200m', lat: PAD.lat + 0.001, lon: PAD.lon + 0.0085, alt: 200, heading: 30, pitch: -20 },
  { name: '1km', lat: PAD.lat - 0.004, lon: PAD.lon - 0.004, alt: 1000, heading: 45, pitch: -35 },
];

test('the ground around the pad with sky, atmosphere and ocean (integration lab)', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  for (const v of VIEWS) {
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
    expect(s.stats.fractionNonBlack).toBeGreaterThan(0.9);
  }
});
