/**
 * The vehicle and the launch complex as a player sees them: in the integration lab, on the real baked
 * terrain, under the real sky, atmosphere and exposure, with every render package that is in the tree
 * (out/screens/vehicle/game-*.png). The vehicle lab's views (screens.spec.ts) are for geometry and
 * materials close up; these are where the hardware is judged for what it looks like in play: does the
 * complex sit on the ground, does white hardware expose near white, do metals have something to reflect.
 *
 * The pictures are taken live (jitter and noise running, converged by the temporal anti-aliasing).
 */
import type { Page } from '@playwright/test';
import type { IntegrationLab } from '../../../labs/integration/main';
import { assertDiscreteGpu, assertRealImage, expect, openPage, saveScreenshot, test, waitIdle } from '../harness';

interface Site {
  bodyId: string;
  latDeg: number;
  lonDeg: number;
  alt: number;
}

type Lab = Window & { __integration?: IntegrationLab };

async function open(page: Page, query: string): Promise<string[]> {
  await openPage(page, `/labs/integration/?hud=0&governor=off&${query}`, { timeoutMs: 180_000 });
  await assertDiscreteGpu(page);
  return page.evaluate(() => (window as Lab).__integration!.loaded as string[]);
}

async function save(page: Page, name: string, minNonBlack = 0.3): Promise<void> {
  await waitIdle(page, 90, 180_000);
  const s = await saveScreenshot(page, 'vehicle', name);
  assertRealImage(s.stats, name, { minNonBlack, minStd: 6, minBuckets: 30 });
  expect(await page.evaluate(() => window.__test!.errors), 'window.__test.errors').toEqual([]);
}

/** The first launch site of the definition library and a point offset from its pad (east, north, up in m). */
async function padPoints(page: Page, offsets: [number, number, number][]): Promise<{ pad: Site; points: Site[] }> {
  return page.evaluate((list) => {
    const lab = (window as Lab).__integration!;
    const site = Object.values(lab.app.defs.sites)[0]!;
    const body = lab.app.defs.bodies[site.bodyId]!;
    const padAlt = typeof site.location.padElevation === 'number' ? site.location.padElevation : 0;
    const rad = Math.PI / 180;
    const at = (e: number, n: number, u: number): Site => ({
      bodyId: site.bodyId,
      latDeg: site.location.latDeg + n / (body.radius * rad),
      lonDeg: site.location.lonDeg + e / (body.radius * rad * Math.cos(site.location.latDeg * rad)),
      alt: padAlt + u,
    });
    return { pad: at(0, 0, 0), points: list.map(([e, n, u]) => at(e, n, u)) };
  }, offsets);
}

interface PadView {
  name: string;
  /** Eye and target as east / north / up offsets from the pad centre, m. */
  eye: [number, number, number];
  at: [number, number, number];
  fov: number;
  /** Sun azimuth / elevation at the pad, degrees. */
  sun: [number, number];
  minNonBlack?: number;
}

const PAD_VIEWS: PadView[] = [
  { name: 'game-pad-noon-300m', eye: [210, -230, 38], at: [0, 0, 55], fov: 34, sun: [150, 62] },
  { name: 'game-pad-morning-apron', eye: [-70, -95, 9], at: [0, 0, 22], fov: 55, sun: [100, 28] },
  { name: 'game-pad-mount-deck', eye: [13, -17, 26], at: [0, 0, 24], fov: 55, sun: [140, 48] },
  { name: 'game-pad-tower-from-ground', eye: [52, -30, 3], at: [8, 0, 70], fov: 60, sun: [200, 45] },
  { name: 'game-site-tank-farm-low', eye: [-205, -150, 4], at: [-262, -192, 5], fov: 50, sun: [150, 55] },
  { name: 'game-site-crawlerway-low', eye: [-150, -34, 5], at: [-330, 4, 0], fov: 50, sun: [150, 55] },
  { name: 'game-site-aerial', eye: [330, -420, 260], at: [-60, 0, 0], fov: 40, sun: [150, 62] },
  { name: 'game-pad-dusk', eye: [190, -210, 30], at: [0, 0, 55], fov: 36, sun: [285, 3] },
  { name: 'game-pad-night', eye: [150, -170, 26], at: [0, 0, 50], fov: 38, sun: [290, -24], minNonBlack: 0.02 },
];

test.describe('vehicle and launch complex in the integrated game', () => {
  test.setTimeout(12 * 60_000);

  test('launch complex on the real terrain: noon, low sun, dusk, night', async ({ page }) => {
    for (const v of PAD_VIEWS) {
      const loaded = await open(page, `scene=pad&fov=${v.fov}`);
      test.skip(!loaded.includes('vehicle') || !loaded.includes('terrain'), 'needs the terrain and vehicle packages in the integration lab');
      const { pad, points } = await padPoints(page, [v.eye, v.at]);
      await page.evaluate(
        ([p, from, to, az, el]) => {
          const lab = (window as Lab).__integration!;
          lab.setSun(p as Site, az as number, el as number);
          lab.lookFromTo(from as Site, to as Site);
        },
        [pad, points[0]!, points[1]!, v.sun[0], v.sun[1]] as const,
      );
      await save(page, v.name, v.minNonBlack ?? 0.3);
    }
  });

  test('the stack, the lander and the capsule in flight', async ({ page }) => {
    const views: { name: string; query: string; minNonBlack: number }[] = [
      { name: 'game-orbit-stack', query: 'scene=lowOrbit&orbit=35,12,48&fov=40', minNonBlack: 0.2 },
      { name: 'game-orbit-capsule', query: 'scene=lowOrbit&stage=8&orbit=140,18,9&fov=40', minNonBlack: 0.2 },
      { name: 'game-orbit-lander', query: 'scene=lunarOrbit&stage=5&orbit=40,10,22&fov=40', minNonBlack: 0.05 },
      { name: 'game-moon-lander-landed', query: 'scene=lunarSurface&orbit=35,6,19&fov=45', minNonBlack: 0.2 },
      { name: 'game-moon-lander-low-sun', query: 'scene=lunarSurface&orbit=215,4,14&fov=45', minNonBlack: 0.2 },
      { name: 'game-reentry', query: 'scene=reentry&orbit=160,10,16&fov=40', minNonBlack: 0.2 },
    ];
    for (const v of views) {
      const loaded = await open(page, v.query);
      test.skip(!loaded.includes('vehicle'), 'needs the vehicle package in the integration lab');
      await save(page, v.name, v.minNonBlack);
    }
  });
});
