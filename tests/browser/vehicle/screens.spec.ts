/**
 * Reviewed screenshots of the vehicle and the launch complex (out/screens/vehicle/*.png). Every view is
 * rendered by the real vessel and site features in the lab; each image is asserted to be a real image
 * and the page to be free of errors. The pictures themselves are judged by eye (hand-off, "Screenshots").
 *
 * Camera: eye= / at= are in the frame of the focused vessel with its nose (+Y) up. On the pad the vessel's
 * -Z looks east (toward the umbilical tower) and +X south.
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, test, type PageLog } from '../harness';
import { openLab, shot } from './lab';

interface View {
  name: string;
  query: string;
  /** Runs in the page before the picture is taken. */
  setup?: () => void;
  /** Lower bound on the lit share of the frame (space views are mostly black). */
  minNonBlack?: number;
}

const SPACE = 'scene=lowOrbit&planet=0';
const SUN_SPACE = 'sunv=0.7,0.25,0.55';
const PAD = 'scene=pad&sun=205,40';
const MOON = 'scene=lunarSurface&sun=110,16';

async function take(page: Page, pageLog: PageLog, views: View[]): Promise<void> {
  for (const v of views) {
    await openLab(page, v.query);
    await assertDiscreteGpu(page);
    if (v.setup) await page.evaluate(v.setup);
    const s = await shot(page, v.name);
    assertRealImage(s.stats, v.name, { minNonBlack: v.minNonBlack ?? 0.5, minStd: 6, minBuckets: 30 });
    await expectNoErrors(page, pageLog);
  }
}

test.describe('vehicle and pad screenshots', () => {
  test.setTimeout(8 * 60_000);

  test('full stack on the pad: 300 m, tower at 15 m, engine section', async ({ page, pageLog }) => {
    await take(page, pageLog, [
      { name: 'pad-stack-300m', query: `${PAD}&eye=200,-99,220&at=0,-58,0&fov=30` },
      { name: 'pad-stack-tower-15m', query: `${PAD}&eye=5,-62,-19.5&at=0,-55,0&fov=72` },
      { name: 'pad-stack-tower-15m-up', query: `${PAD}&eye=4,-30,-19.5&at=0,-8,0&fov=72` },
      { name: 'pad-engine-section', query: `${PAD}&eye=10.5,-99.6,-6&at=0,-98.7,0&fov=50` },
      { name: 'pad-hold-down-clamp', query: `${PAD}&eye=8.5,-99.4,8.2&at=4.2,-98.4,4.2&fov=45` },
    ]);
    const stats = await page.evaluate(() => ({ ...window.__veh!.vehicle.stats }));
    expect(stats.vessels).toBe(1);
    expect(stats.instances).toBeGreaterThan(100);
  });

  test('launch complex overview at noon and at night with floodlights', async ({ page, pageLog }) => {
    await take(page, pageLog, [
      { name: 'site-overview-noon', query: 'scene=pad&sun=175,68&eye=250,-15,330&at=-40,-112,-20&fov=42' },
      { name: 'site-tank-farm', query: 'scene=pad&sun=175,68&eye=175,-112,285&at=195,-112,255&fov=60' },
      { name: 'site-overview-night', query: 'scene=pad&sun=290,-28&env=night&eye=250,-15,330&at=-40,-112,-20&fov=42', minNonBlack: 0.02 },
      { name: 'site-pad-night', query: 'scene=pad&sun=290,-28&env=night&eye=120,-100,150&at=0,-70,0&fov=40', minNonBlack: 0.02 },
    ]);
    const site = await page.evaluate(() => ({ ...window.__veh!.site!.stats, night: window.__veh!.site!.state('ka-lae-lc1')!.night }));
    expect(site.night).toBe(1);
    expect(site.lights).toBeGreaterThan(3);
  });

  test('each stage alone in space, lit by the sun and the probe', async ({ page, pageLog }) => {
    await take(page, pageLog, [
      { name: 'stage-m1-space', query: `${SPACE}&stage=1&stages=1&coast=2&hold=1&solo=1&focus=interstage-1&${SUN_SPACE}&eye=48,-20,30&at=0,-21,0&fov=48`, minNonBlack: 0.03 },
      { name: 'stage-m1-aft-space', query: `${SPACE}&stage=1&stages=1&coast=2&hold=1&solo=1&focus=interstage-1&sunv=0.5,-0.6,0.6&eye=9,-52,8&at=0,-41,0&fov=50`, minNonBlack: 0.05 },
      { name: 'stage-m2-space', query: `${SPACE}&stage=3&stages=1&coast=2&hold=1&solo=1&focus=interstage-2&${SUN_SPACE}&eye=40,-14,26&at=0,-15,0&fov=48`, minNonBlack: 0.03 },
      { name: 'stage-m2-aft-space', query: `${SPACE}&stage=3&stages=1&coast=2&hold=1&solo=1&focus=interstage-2&sunv=0.5,-0.6,0.6&eye=10,-43,9&at=0,-32,0&fov=50`, minNonBlack: 0.05 },
      { name: 'stage-m3-space', query: `${SPACE}&stage=4&stages=1&coast=2&hold=1&solo=1&focus=payload-adapter&${SUN_SPACE}&eye=17,-4,11&at=0,-5,0&fov=45`, minNonBlack: 0.03 },
      { name: 'stage-lander-space', query: `${SPACE}&stage=5&${SUN_SPACE}&eye=13,-2,8&at=0,-3.6,0&fov=45`, minNonBlack: 0.03 },
      { name: 'stage-ascent-space', query: `${SPACE}&stage=7&${SUN_SPACE}&eye=8.5,0.5,5.5&at=0,-1.4,0&fov=45`, minNonBlack: 0.03 },
      { name: 'stage-capsule-space', query: `${SPACE}&stage=8&${SUN_SPACE}&eye=5,2.6,4.2&at=0,1.1,0&fov=45`, minNonBlack: 0.03 },
      { name: 'interstage-interior', query: `${SPACE}&stage=1&stages=1&coast=2&hold=1&solo=1&focus=interstage-1&sunv=0.35,0.85,0.4&eye=3.4,8.5,4.2&at=0,-1.6,0&fov=60`, minNonBlack: 0.1 },
    ]);
  });

  test('lander: legs stowed and deployed on a ground slab, insulation and foot pad close-ups', async ({ page, pageLog }) => {
    await take(page, pageLog, [
      { name: 'lander-stowed', query: `${MOON}&stage=5&eye=13,-2.5,10&at=0,-4.4,0&fov=45`, minNonBlack: 0.2 },
      { name: 'lander-deployed', query: `${MOON}&stage=6&eye=14,-3,11&at=0,-4.8,0&fov=45`, minNonBlack: 0.2 },
      { name: 'lander-mli-closeup', query: `${MOON}&stage=6&eye=1.9,-5.9,5.3&at=0.3,-6.3,2.9&fov=40`, minNonBlack: 0.2 },
      { name: 'lander-foot-pad', query: `${MOON}&stage=6&eye=6.7,-7.9,7.1&at=4.8,-8.75,4.8&fov=40`, minNonBlack: 0.2 },
      { name: 'lander-lights', query: 'scene=lunarSurface&sun=110,-20&env=void&stage=6&eye=14,-3,11&at=0,-5.5,0&fov=45', setup: () => void window.__veh!.sim.setAll('light', { on: true }), minNonBlack: 0.01 },
    ]);
    const lit = await page.evaluate(() => window.__veh!.vehicle.stats.lights);
    expect(lit).toBeGreaterThan(0);
  });

  test('materials: brushed steel and clear-coated paint close-ups', async ({ page, pageLog }) => {
    await take(page, pageLog, [
      { name: 'closeup-brushed-steel', query: `${PAD}&eye=7.2,-18.3,7.4&at=2.2,-18.9,2.4&fov=32` },
      { name: 'closeup-clearcoat-paint', query: `${SPACE}&stage=1&stages=1&coast=2&hold=1&solo=1&focus=interstage-1&sunv=0.75,0.1,0.65&eye=8,-18,7&at=3.1,-18.6,3.2&fov=32`, minNonBlack: 0.2 },
      { name: 'closeup-foam', query: `${PAD}&eye=8,-38,8&at=3.1,-38.6,3.2&fov=32` },
    ]);
  });

  test('capsule: heat shield pristine and charred, windows, hatch', async ({ page, pageLog }) => {
    const shield = `${SPACE}&stage=8&sunv=0.5,-0.7,0.5&eye=3.3,-3.4,3.1&at=0,-0.1,0&fov=45`;
    await take(page, pageLog, [
      { name: 'capsule-heat-shield-pristine', query: shield, minNonBlack: 0.1 },
      { name: 'capsule-heat-shield-charred', query: shield, setup: () => void window.__veh!.sim.setAll('heatShield', { ablatorFraction: 0.58 }), minNonBlack: 0.05 },
      { name: 'capsule-charred-back-shell', query: `${SPACE}&stage=8&sunv=0.6,0.3,0.7&eye=4.4,2.2,4.2&at=0,1.0,0&fov=45`, setup: () => void window.__veh!.sim.setAll('heatShield', { ablatorFraction: 0.58 }), minNonBlack: 0.05 },
      { name: 'capsule-windows', query: `${SPACE}&stage=8&sunv=0.4,0.5,0.8&eye=0.25,2.7,3.5&at=0,1.45,1.0&fov=36`, minNonBlack: 0.2 },
      { name: 'capsule-hatch', query: `${SPACE}&stage=8&sunv=0.9,0.35,-0.25&eye=1.0,1.8,-3.4&at=0,1.2,-1.2&fov=40`, minNonBlack: 0.2 },
    ]);
  });

  test('fairing petal inside and outside, launch escape system', async ({ page, pageLog }) => {
    const petal = `${SPACE}&stage=2&stages=1&coast=2&hold=1&solo=1&focus=panel0`;
    await take(page, pageLog, [
      { name: 'fairing-petal-outside', query: `${petal}&sunv=0.6,0.3,0.7&eye=9.5,5,9.5&at=2.3,4.7,2.3&fov=50`, minNonBlack: 0.05 },
      // (A sun below the local horizon is eclipsed by the planet even when the lab does not draw it: these
      // directions are on the day side for the petal's attitude 2 s after separation.)
      { name: 'fairing-petal-inside', query: `${petal}&sunv=-0.4,0.8,-0.45&eye=-3.4,6.5,-3.4&at=2.3,4.9,2.3&fov=70`, minNonBlack: 0.15 },
      { name: 'les', query: `${SPACE}&stage=1&${SUN_SPACE}&eye=8.5,6.5,6&at=0,4.4,0&fov=45`, minNonBlack: 0.02 },
      { name: 'les-motor-closeup', query: `${SPACE}&stage=1&${SUN_SPACE}&eye=3.2,7.6,2.6&at=0,7.4,0&fov=40`, minNonBlack: 0.02 },
    ]);
  });
});
