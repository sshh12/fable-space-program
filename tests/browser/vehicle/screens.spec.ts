/**
 * Reviewed screenshots of the vehicle and the launch complex (out/screens/vehicle/*.png). Every view is
 * rendered by the real vessel and site features in the lab; each image is asserted to be a real image
 * and the page to be free of errors. The pictures themselves are judged by eye (hand-off, "Screenshots").
 * State-dependent looks (frost, soot, a hot heat shield, a broken leg) are taken as A / B pairs from one
 * camera, and the pair is asserted to differ where the state should show.
 *
 * Camera: eye= / at= are in the frame of the focused vessel with its nose (+Y) up. On the pad the vessel's
 * -Z looks east (toward the umbilical tower) and +X south.
 */
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
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

async function take(page: Page, pageLog: PageLog, views: View[]): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  for (const v of views) {
    await openLab(page, v.query);
    await assertDiscreteGpu(page);
    if (v.setup) await page.evaluate(v.setup);
    const s = await shot(page, v.name);
    assertRealImage(s.stats, v.name, { minNonBlack: v.minNonBlack ?? 0.5, minStd: 6, minBuckets: 30 });
    await expectNoErrors(page, pageLog);
    out[v.name] = s.buffer;
  }
  return out;
}

/** Share of the pixels of two screenshots whose luma differs by more than `threshold` (0..255). */
function changedShare(a: Buffer, b: Buffer, threshold = 10): number {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  expect([pb.width, pb.height]).toEqual([pa.width, pa.height]);
  let n = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    const la = 0.2126 * pa.data[i]! + 0.7152 * pa.data[i + 1]! + 0.0722 * pa.data[i + 2]!;
    const lb = 0.2126 * pb.data[i]! + 0.7152 * pb.data[i + 1]! + 0.0722 * pb.data[i + 2]!;
    if (Math.abs(la - lb) > threshold) n++;
  }
  return n / (pa.width * pa.height);
}

/** Presentation state of every part of the stack (history the lab does not want to wait for). */
const sootEverything = (): void => {
  const lab = window.__veh!;
  const id = lab.sim.vesselIds[0]!;
  for (const p of lab.sim.partsOf(id)) Object.assign(lab.vehicle.anim(id, p.instanceId), { soot: 1, frost: 0 });
};
const noFrost = (): void => {
  const lab = window.__veh!;
  const id = lab.sim.vesselIds[0]!;
  for (const p of lab.sim.partsOf(id)) lab.vehicle.anim(id, p.instanceId).frost = 0;
};

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

  test('launch complex: overview at noon and at night, tank farm, crew arm, buildings, apron, far view', async ({ page, pageLog }) => {
    await take(page, pageLog, [
      { name: 'site-overview-noon', query: 'scene=pad&sun=175,68&eye=250,-15,330&at=-40,-112,-20&fov=42' },
      { name: 'site-tank-farm', query: 'scene=pad&sun=175,68&eye=175,-112,285&at=195,-112,255&fov=60' },
      { name: 'site-crew-arm', query: `${PAD}&eye=9,3,-12&at=0,1.2,-6&fov=60` },
      { name: 'site-crew-arm-white-room', query: 'scene=pad&sun=140,40&eye=22,10,-34&at=0,2,-12&fov=45' },
      { name: 'site-support-building', query: `${PAD}&eye=-20,-114,40&at=-38,-117,24&fov=50` },
      { name: 'site-apron', query: `${PAD}&eye=-45,-108,70&at=-25,-118,25&fov=55` },
      { name: 'site-far-800m', query: 'scene=pad&sun=175,68&eye=500,-20,600&at=-40,-100,-20&fov=42' },
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

  test('lander: legs stowed, deployed and broken on a ground slab, insulation and foot pad close-ups', async ({ page, pageLog }) => {
    const legs = 'scene=lunarSurface&sun=110,25&stage=6&eye=10,-5,9&at=3,-7,3&fov=45';
    const shots = await take(page, pageLog, [
      { name: 'lander-stowed', query: `${MOON}&stage=5&eye=13,-2.5,10&at=0,-4.4,0&fov=45`, minNonBlack: 0.2 },
      { name: 'lander-deployed', query: `${MOON}&stage=6&eye=14,-3,11&at=0,-4.8,0&fov=45`, minNonBlack: 0.2 },
      // Sun behind the camera: the foil's highlight runs down the tank lobe as a streak broken up by the crinkle.
      { name: 'lander-mli-closeup', query: 'scene=lunarSurface&sun=290,22&stage=6&eye=1.9,-5.9,5.3&at=0.3,-6.3,2.9&fov=40', minNonBlack: 0.2 },
      { name: 'lander-foot-pad', query: `${MOON}&stage=6&eye=6.7,-7.9,7.1&at=4.8,-8.75,4.8&fov=40`, minNonBlack: 0.2 },
      { name: 'lander-leg-intact', query: legs, minNonBlack: 0.2 },
      { name: 'lander-leg-broken', query: legs, setup: () => void window.__veh!.sim.setAll('legs', { broken: [true, false, false, false] }), minNonBlack: 0.2 },
      { name: 'lander-lights', query: 'scene=lunarSurface&sun=110,-20&env=void&stage=6&eye=14,-3,11&at=0,-5.5,0&fov=45', setup: () => void window.__veh!.sim.setAll('light', { on: true }), minNonBlack: 0.01 },
    ]);
    const lit = await page.evaluate(() => window.__veh!.vehicle.stats.lights);
    expect(lit).toBeGreaterThan(0);
    // The broken leg is drawn broken: its strut, piston, pad and their shadows are somewhere else.
    expect(changedShare(shots['lander-leg-intact']!, shots['lander-leg-broken']!)).toBeGreaterThan(0.004);
  });

  test('materials: brushed steel, clear-coated paint and foam close-ups', async ({ page, pageLog }) => {
    await take(page, pageLog, [
      { name: 'closeup-brushed-steel', query: `${PAD}&eye=7.2,-18.3,7.4&at=2.2,-18.9,2.4&fov=32` },
      { name: 'closeup-clearcoat-paint', query: `${SPACE}&stage=1&stages=1&coast=2&hold=1&solo=1&focus=interstage-1&sunv=0.75,0.1,0.65&eye=8,-18,7&at=3.1,-18.6,3.2&fov=32`, minNonBlack: 0.2 },
      { name: 'closeup-foam', query: `${PAD}&eye=8,-38,8&at=3.1,-38.6,3.2&fov=32` },
      { name: 'stage-m2-foam-pad', query: 'scene=pad&site=0&sun=120,35&eye=20,-30,-34&at=0,-36,0&fov=45' },
    ]);
  });

  test('frost on the cryogenic tanks before launch and after it has shed; soot of a burn on the aft end', async ({ page, pageLog }) => {
    const tank = 'scene=pad&site=0&sun=120,35&eye=18,-60,-30&at=0,-66,0&fov=40';
    const line = 'scene=pad&site=0&sun=120,35&eye=8,-78,-12&at=0,-80,0&fov=45';
    const aft = 'scene=pad&site=0&sun=120,35&eye=16,-92,-26&at=0,-95,0&fov=45';
    const engines = 'scene=pad&site=0&sun=120,35&eye=9,-104,-9&at=0,-99.5,0&fov=55';
    const shots = await take(page, pageLog, [
      { name: 'frost-prelaunch', query: tank },
      { name: 'frost-shed', query: tank, setup: noFrost },
      { name: 'frost-line-prelaunch', query: line },
      { name: 'frost-line-shed', query: line, setup: noFrost },
      { name: 'aft-clean', query: aft, setup: noFrost },
      { name: 'aft-sooted', query: aft, setup: sootEverything },
      { name: 'engines-clean', query: engines, setup: noFrost },
      { name: 'engines-sooted', query: engines, setup: sootEverything },
    ]);
    // Frost: a good part of the barrel in view changes; soot: the skin above the skirt and the bell interiors.
    expect(changedShare(shots['frost-prelaunch']!, shots['frost-shed']!)).toBeGreaterThan(0.03);
    expect(changedShare(shots['frost-line-prelaunch']!, shots['frost-line-shed']!)).toBeGreaterThan(0.03);
    expect(changedShare(shots['aft-clean']!, shots['aft-sooted']!)).toBeGreaterThan(0.01);
    expect(changedShare(shots['engines-clean']!, shots['engines-sooted']!)).toBeGreaterThan(0.004);
  });

  test('capsule: heat shield pristine, charred and glowing in entry, windows, hatch', async ({ page, pageLog }) => {
    const shield = `${SPACE}&stage=8&sunv=0.5,-0.7,0.5&eye=3.3,-3.4,3.1&at=0,-0.1,0&fov=45`;
    const entry = `${SPACE}&stage=8&sunv=0.5,-0.2,0.8&eye=4.2,-2.2,3.6&at=0,0.6,0&fov=45`;
    const shots = await take(page, pageLog, [
      { name: 'capsule-heat-shield-pristine', query: shield, minNonBlack: 0.1 },
      { name: 'capsule-heat-shield-charred', query: shield, setup: () => void window.__veh!.sim.setAll('heatShield', { ablatorFraction: 0.58 }), minNonBlack: 0.05 },
      { name: 'capsule-charred-back-shell', query: `${SPACE}&stage=8&sunv=0.6,0.3,0.7&eye=4.4,2.2,4.2&at=0,1.0,0&fov=45`, setup: () => void window.__veh!.sim.setAll('heatShield', { ablatorFraction: 0.58 }), minNonBlack: 0.05 },
      // Entry: the ablating face at 1900 K with the structure behind it cool, as the simulation reports it.
      { name: 'capsule-entry-cold', query: entry, minNonBlack: 0.05 },
      { name: 'capsule-entry-hot-shield', query: entry, setup: () => void window.__veh!.sim.setAll('heatShield', { surfaceTemp: 1900 }), minNonBlack: 0.05 },
      { name: 'capsule-windows', query: `${SPACE}&stage=8&sunv=0.4,0.5,0.8&eye=0.25,2.7,3.5&at=0,1.45,1.0&fov=36`, minNonBlack: 0.2 },
      { name: 'capsule-hatch', query: `${SPACE}&stage=8&sunv=0.9,0.35,-0.25&eye=1.0,1.8,-3.4&at=0,1.2,-1.2&fov=40`, minNonBlack: 0.2 },
    ]);
    expect(changedShare(shots['capsule-entry-cold']!, shots['capsule-entry-hot-shield']!)).toBeGreaterThan(0.02);
  });

  test('fairing petal inside and outside, launch escape system and its boost cover', async ({ page, pageLog }) => {
    const petal = `${SPACE}&stage=2&stages=1&coast=2&hold=1&solo=1&focus=panel0`;
    await take(page, pageLog, [
      { name: 'fairing-petal-outside', query: `${petal}&sunv=0.6,0.3,0.7&eye=9.5,5,9.5&at=2.3,4.7,2.3&fov=50`, minNonBlack: 0.05 },
      // (A sun below the local horizon is eclipsed by the planet even when the lab does not draw it: these
      // directions are on the day side for the petal's attitude 2 s after separation.)
      { name: 'fairing-petal-inside', query: `${petal}&sunv=-0.4,0.8,-0.45&eye=-3.4,6.5,-3.4&at=2.3,4.9,2.3&fov=70`, minNonBlack: 0.15 },
      { name: 'les', query: `${SPACE}&stage=1&${SUN_SPACE}&eye=8.5,6.5,6&at=0,4.4,0&fov=45`, minNonBlack: 0.02 },
      { name: 'les-motor-closeup', query: `${SPACE}&stage=1&${SUN_SPACE}&eye=3.2,7.6,2.6&at=0,7.4,0&fov=40`, minNonBlack: 0.02 },
      { name: 'les-boost-cover-hatch', query: 'scene=pad&site=0&sun=110,45&eye=3.6,1.9,-5.2&at=0,1.0,-1.2&fov=38' },
      { name: 'les-boost-cover-profile', query: 'scene=pad&site=0&sun=110,45&eye=0.5,1.2,-7.5&at=0,1.0,0&fov=38' },
    ]);
  });
});
