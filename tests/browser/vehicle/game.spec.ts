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
  // (The cockpit package draws nothing in an outside view and is left out.)
  await openPage(page, `/labs/integration/?hud=0&governor=off&without=cockpit&${query}`, { timeoutMs: 180_000 });
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

/** Structure models that are built on the site's ground survey (they stand off the level areas of the pad shape). */
const SURVEYED_MODELS = ['pad.groundworks', 'pad.fence', 'pad.pipeRun', 'pad.cameraTower', 'pad.vehicle'];

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
  { name: 'game-site-aerial', eye: [330, -520, 330], at: [-90, -10, 0], fov: 44, sun: [150, 62] },
  // The earthworks on the real relief: along the perimeter road on its embankment with the fence beside it,
  // across the fence at the pad, and the gate where the access road and the crawlerway enter.
  { name: 'game-site-perimeter-road', eye: [212, 66, 1.4], at: [196, -110, -1], fov: 55, sun: [150, 55] },
  { name: 'game-site-fence-pad', eye: [246, 96, 2.2], at: [0, 0, 34], fov: 50, sun: [200, 40] },
  { name: 'game-site-gate', eye: [-418, -70, 3.2], at: [-350, -28, 2], fov: 55, sun: [150, 55] },
  { name: 'game-site-farm-road', eye: [-296, -70, 2.4], at: [-272, -170, 3], fov: 55, sun: [120, 40] },
  { name: 'game-pad-dusk', eye: [190, -210, 30], at: [0, 0, 55], fov: 36, sun: [285, 3] },
  { name: 'game-pad-night', eye: [150, -170, 26], at: [0, 0, 50], fov: 38, sun: [290, -24], minNonBlack: 0.02 },
];

test.describe('vehicle and launch complex in the integrated game', () => {
  test.setTimeout(20 * 60_000);

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
      { name: 'game-orbit-capsule', query: 'scene=lowOrbit&stage=8&orbit=35,14,9&fov=40', minNonBlack: 0.2 },
      { name: 'game-orbit-lander', query: 'scene=lunarOrbit&stage=5&orbit=40,10,22&fov=40', minNonBlack: 0.05 },
      { name: 'game-reentry', query: 'scene=reentry&orbit=160,10,16&fov=40', minNonBlack: 0.2 },
      // The flown capsule under its drogues, in the real simulation's state after a lunar-return entry (the
      // shield's ablation history is what scorches the back shell: nothing is set by hand here).
      { name: 'game-chutes-capsule-flown', query: 'sim=real&scenario=qa-drogues&orbit=35,-8,8&fov=40', minNonBlack: 0.2 },
      { name: 'game-chutes-capsule-flown-lee', query: 'sim=real&scenario=qa-drogues&orbit=200,6,9&fov=40', minNonBlack: 0.2 },
    ];
    for (const v of views) {
      const loaded = await open(page, v.query);
      test.skip(!loaded.includes('vehicle'), 'needs the vehicle package in the integration lab');
      await save(page, v.name, v.minNonBlack);
    }
  });

  test('the lander on the real lunar surface, seen from the ground beside it', async ({ page }) => {
    // Stand on the terrain a few metres from the landed vessel, at eye height, and look at a point im metres
    // above the ground under it (the lander stands on its deployed legs: request vehicle-pad-5).
    const views: { name: string; east: number; north: number; height: number; aim: number; sun: [number, number]; fov: number }[] = [
      { name: 'game-moon-lander-landed', east: 13, north: -9, height: 2.2, aim: 4.3, sun: [120, 24], fov: 50 },
      { name: 'game-moon-lander-low-sun', east: -10, north: -12, height: 1.6, aim: 4.3, sun: [250, 8], fov: 50 },
      { name: 'game-moon-lander-foot-pad', east: 6.5, north: -5.5, height: 0.7, aim: 0.4, sun: [120, 24], fov: 38 },
    ];
    for (const v of views) {
      const loaded = await open(page, `scene=lunarSurface&fov=${v.fov}`);
      test.skip(!loaded.includes('vehicle') || !loaded.includes('terrain'), 'needs the terrain and vehicle packages in the integration lab');
      await page.evaluate(
        async ([east, north, height, aim, az, el]) => {
          const lab = (window as Lab).__integration!;
          const snap = lab.app.snapshot();
          const vessel = snap.vessels.find((x) => x.id === snap.activeVesselId)!;
          const body = snap.bodies.find((x) => x.id === vessel.bodyId)!;
          const radius = lab.app.defs.bodies[body.id]!.radius;
          // Vessel position in the body-fixed frame (rotate by the conjugate of qFixedToRoot).
          const q = body.qFixedToRoot;
          const r = vessel.r;
          const tx = 2 * (-q.y * r.z + q.z * r.y);
          const ty = 2 * (-q.z * r.x + q.x * r.z);
          const tz = 2 * (-q.x * r.y + q.y * r.x);
          const f = { x: r.x + q.w * tx + (-q.y * tz + q.z * ty), y: r.y + q.w * ty + (-q.z * tx + q.x * tz), z: r.z + q.w * tz + (-q.x * ty + q.y * tx) };
          const len = Math.hypot(f.x, f.y, f.z);
          const rad = Math.PI / 180;
          const lat = Math.asin(f.z / len) / rad;
          const lon = Math.atan2(f.y, f.x) / rad;
          const at = { bodyId: body.id, latDeg: lat + north! / (radius * rad), lonDeg: lon + east! / (radius * rad * Math.cos(lat * rad)), alt: 0 };
          at.alt = (await lab.groundHeight(at.bodyId, at.latDeg, at.lonDeg)) + height!;
          lab.setSun({ bodyId: body.id, latDeg: lat, lonDeg: lon, alt: 0 }, az!, el!);
          const under = await lab.groundHeight(body.id, lat, lon);
          lab.lookFromTo(at, { bodyId: body.id, latDeg: lat, lonDeg: lon, alt: under + aim! });
        },
        [v.east, v.north, v.height, v.aim, v.sun[0], v.sun[1]] as const,
      );
      // (Half the frame is the black lunar sky.)
      await save(page, v.name, 0.06);
    }
  });

  test('the terrain under every structure of a site is at the height the structure stands at', async ({ page }) => {
    const loaded = await open(page, 'scene=pad');
    test.skip(!loaded.includes('terrain'), 'needs the terrain package in the integration lab');
    // The site feature stands every structure's origin on the pad plane. That is right only where the terrain
    // is flattened to the pad's elevation: measured here on the baked terrain at the origin of every structure
    // that is not built on the ground survey (those are checked against the survey below).
    const gaps = await page.evaluate(async (onSurvey) => {
      const lab = (window as Lab).__integration!;
      const out: { model: string; gap: number }[] = [];
      for (const site of Object.values(lab.app.defs.sites)) {
        const body = lab.app.defs.bodies[site.bodyId]!;
        const rad = Math.PI / 180;
        const padAlt = typeof site.location.padElevation === 'number' ? site.location.padElevation : await lab.groundHeight(site.bodyId, site.location.latDeg, site.location.lonDeg);
        for (const s of site.structures) {
          if (onSurvey.includes(s.model)) continue;
          const lat = site.location.latDeg + s.offsetEnu[1] / (body.radius * rad);
          const lon = site.location.lonDeg + s.offsetEnu[0] / (body.radius * rad * Math.cos(site.location.latDeg * rad));
          out.push({ model: s.model, gap: (await lab.groundHeight(site.bodyId, lat, lon)) - padAlt });
        }
      }
      return out;
    }, SURVEYED_MODELS);
    // Roads, fences, berms and pipe supports stand off the level areas, on the site's ground survey: the live
    // terrain must lie inside the survey's bounds wherever it is sampled (the unit tests hold every earthwork
    // above the upper bound and every foot below the lower one).
    const survey = await page.evaluate(async () => {
      const lab = (window as Lab).__integration!;
      let worst = 0;
      let samples = 0;
      for (const site of Object.values(lab.app.defs.sites)) {
        const sec = lab.app.defs.sections[`visuals/sites/${site.id}`] as { survey?: { step: number; east0: number; north0: number; nx: number; ny: number; hiCm: number[]; loCm: number[] } } | undefined;
        const s = sec?.survey;
        if (!s || typeof site.location.padElevation !== 'number') continue;
        const body = lab.app.defs.bodies[site.bodyId]!;
        const rad = Math.PI / 180;
        const at = (grid: number[], e: number, n: number): number => {
          const fx = Math.max(0, Math.min(s.nx - 1.001, (e - s.east0) / s.step));
          const fy = Math.max(0, Math.min(s.ny - 1.001, (n - s.north0) / s.step));
          const i = Math.floor(fx);
          const j = Math.floor(fy);
          const k = j * s.nx + i;
          return ((grid[k]! * (1 - (fx - i)) + grid[k + 1]! * (fx - i)) * (1 - (fy - j)) + (grid[k + s.nx]! * (1 - (fx - i)) + grid[k + s.nx + 1]! * (fx - i)) * (fy - j)) / 100;
        };
        // A coarse lattice over the whole survey (every 23 m, off the grid's own nodes).
        for (let n = s.north0 + 7; n < s.north0 + (s.ny - 1) * s.step; n += 23) {
          for (let e = s.east0 + 7; e < s.east0 + (s.nx - 1) * s.step; e += 23) {
            const lat = site.location.latDeg + n / (body.radius * rad);
            const lon = site.location.lonDeg + e / (body.radius * rad * Math.cos(site.location.latDeg * rad));
            // (Height over the pad's tangent plane: the sphere falls away by d^2 / 2R.)
            const h = (await lab.groundHeight(site.bodyId, lat, lon)) - site.location.padElevation - (e * e + n * n) / (2 * body.radius);
            worst = Math.max(worst, h - at(s.hiCm, e, n), at(s.loCm, e, n) - h);
            samples++;
          }
        }
      }
      return { worst, samples };
    });
    console.log(`site ground: ${survey.samples} live terrain samples against the ground survey, worst excess over its bounds ${survey.worst.toFixed(3)} m`);
    expect(survey.samples).toBeGreaterThan(200);
    expect(survey.worst).toBeLessThan(0.05);
    const worst = gaps.reduce((a, g) => (Math.abs(g.gap) > Math.abs(a.gap) ? g : a));
    console.log(`site ground: ${gaps.length} structures, largest terrain-to-pad-plane gap ${worst.gap.toFixed(3)} m (${worst.model})`);
    // Slabs and footings reach 0.3 m and more below their plane; the terrain may not fall away by that much.
    expect(Math.abs(worst.gap)).toBeLessThan(0.15);
  });
});
