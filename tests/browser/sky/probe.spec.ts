import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, test, waitIdle } from '../harness';

/**
 * The environment probe against a brute-force integration of the same analytic scene (airless, cloudless,
 * BodyDef mean colours: `probeAlbedo=mean`), and its response to day / night and altitude.
 */
test.describe.configure({ timeout: 600_000 });

/** Wait for `cycles` complete probe cycles from now (the probe follows a sun or vessel change within two). */
async function probeCycles(page: Page, cycles = 3): Promise<void> {
  const start = await page.evaluate(() => window.__sky!.sky!.probe().completed);
  await page.waitForFunction((n) => window.__sky!.sky!.probe().completed >= n, start + cycles, { timeout: 120_000 });
}

interface Measure {
  normals: { name: string; gpu: number; sh: number; brute: number }[];
  shGpu: number[][];
  shCpu: number[][];
}

/** SH irradiance of the published probe and of the CPU reference, and brute-force irradiance, along named normals. */
async function measure(page: Page): Promise<Measure> {
  return page.evaluate(async () => {
    const sky = window.__sky!;
    const shGpu = await sky.sky!.readProbeSh();
    const scene = sky.referenceScene()!;
    const L = (d: { x: number; y: number; z: number }): [number, number, number] => sky.cpu.referenceRadiance(scene, d);
    const shCpu = sky.cpu.projectSh(L, 64);
    // Local frame at the probe: down = towards the nearest body centre.
    const b = scene.bodies.reduce((a, c) => (Math.hypot(c.centre.x, c.centre.y, c.centre.z) - c.radius < Math.hypot(a.centre.x, a.centre.y, a.centre.z) - a.radius ? c : a));
    const l = Math.hypot(b.centre.x, b.centre.y, b.centre.z);
    const down = { x: b.centre.x / l, y: b.centre.y / l, z: b.centre.z / l };
    const ax = Math.abs(down.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    let e1 = { x: down.y * ax.z - down.z * ax.y, y: down.z * ax.x - down.x * ax.z, z: down.x * ax.y - down.y * ax.x };
    const el = Math.hypot(e1.x, e1.y, e1.z);
    e1 = { x: e1.x / el, y: e1.y / el, z: e1.z / el };
    const e2 = { x: down.y * e1.z - down.z * e1.y, y: down.z * e1.x - down.x * e1.z, z: down.x * e1.y - down.y * e1.x };
    const mix = (a: typeof down, ka: number, c: typeof down, kc: number) => {
      const v = { x: a.x * ka + c.x * kc, y: a.y * ka + c.y * kc, z: a.z * ka + c.z * kc };
      const n = Math.hypot(v.x, v.y, v.z);
      return { x: v.x / n, y: v.y / n, z: v.z / n };
    };
    const normals = [
      ['earth-facing', down],
      ['space-facing', mix(down, -1, e1, 0)],
      ['horizontal +e1', e1],
      ['horizontal -e1', mix(e1, -1, e2, 0)],
      ['horizontal +e2', e2],
      ['45 deg down +e1', mix(down, 1, e1, 1)],
      ['45 deg down -e2', mix(down, 1, e2, -1)],
      ['45 deg up +e2', mix(down, -1, e2, 1)],
    ] as const;
    const luma = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    return {
      shGpu,
      shCpu,
      normals: normals.map(([name, n]) => ({
        name,
        gpu: luma(sky.cpu.shIrradiance(shGpu as [number, number, number][], n)),
        sh: luma(sky.cpu.shIrradiance(shCpu, n)),
        brute: luma(sky.cpu.bruteForceIrradiance(L, n, 300)),
      })),
    };
  });
}

test('SH9 irradiance in low orbit matches a brute-force integration of the analytic scene', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=lowOrbit&planet=0&probeAlbedo=mean&hud=0');
  await assertDiscreteGpu(page);
  await page.evaluate(() => window.__sky!.setSunForVessel({ elevationDeg: 40, azimuthDeg: 30 }));
  await waitIdle(page, 4, 300_000);
  await probeCycles(page);
  const m = await measure(page);
  for (const n of m.normals) console.log(`${n.name.padEnd(16)} probe SH ${n.gpu.toFixed(1).padStart(8)} lux   CPU SH ${n.sh.toFixed(1).padStart(8)}   brute force ${n.brute.toFixed(1).padStart(8)}   probe / brute ${(n.gpu / Math.max(n.brute, 1e-9)).toFixed(3)}`);
  const by = (name: string) => m.normals.find((n) => n.name === name)!;
  const down = by('earth-facing');
  const up = by('space-facing');
  // The GPU pipeline (face evaluation, mips, projection, blend) reproduces the CPU projection of the same radiance.
  for (const n of m.normals) if (n.sh > 0.02 * down.sh) expect(Math.abs(n.gpu / n.sh - 1)).toBeLessThan(0.03);
  // SH9 against the exact irradiance: within 10 % wherever the Earth is a significant part of the hemisphere.
  for (const n of m.normals) if (n.brute > 0.1 * down.brute) expect(Math.abs(n.gpu / n.brute - 1)).toBeLessThan(0.1);
  // Earth-facing vs space-facing: the space-facing hemisphere sees no Earth at 200 km (exact irradiance ~0); the SH9
  // band limit leaves a little of the Earth's light there. Both ratios are logged; SH9 keeps the space side below 5 %.
  console.log(`earth/space ratio: brute force ${(down.brute / Math.max(up.brute, 1e-9)).toExponential(2)}, SH9 of the CPU reference ${(down.sh / Math.max(up.sh, 1e-9)).toFixed(1)}, probe ${(down.gpu / Math.max(up.gpu, 1e-9)).toFixed(1)}`);
  expect(up.brute).toBeLessThan(1e-3 * down.brute);
  expect(up.gpu).toBeLessThan(0.05 * down.gpu);
  expect(Math.abs(down.gpu / Math.max(up.gpu, 1e-9) / (down.sh / Math.max(up.sh, 1e-9)) - 1)).toBeLessThan(0.15);
  await expectNoErrors(page, pageLog);
});

test('the probe keeps the ground at a landing site below the datum and through a descent across it', async ({ page, pageLog }) => {
  // The mission's lunar landing site lies 1907.8 m below the Moon's reference radius (moon-tranquility
  // recommendedTarget). The vessel descends over that ground from 2.5 km above the datum to resting on it
  // (origin 3 m above the ground, radar altitude 3 m); the ground-facing irradiance must stay that of the
  // sunlit regolith all the way (the reference-sphere probe lost the ground below the datum: 8.5e-4 lux).
  await openPage(page, '/labs/sky/?scene=lunarSurface&planet=0&probeAlbedo=mean&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  const site = -1907.8;
  const cases = [
    { label: '+30 m over the datum', alt: 30, ground: 0 },
    { label: '+2500 m, site ground', alt: 2500, ground: site },
    { label: '+1000 m, site ground', alt: 1000, ground: site },
    { label: '+1 m, site ground', alt: 1, ground: site },
    { label: '-1 m, site ground', alt: -1, ground: site },
    { label: '-1000 m, site ground', alt: -1000, ground: site },
    { label: 'landed at the site', alt: site + 3, ground: site },
  ];
  const results: { label: string; down: number; brute: number; up: number }[] = [];
  for (const c of cases) {
    await page.evaluate((x) => {
      window.__sky!.setVesselAltitude(x.alt, x.ground);
      window.__sky!.setSunForVessel({ elevationDeg: 35, azimuthDeg: 100 });
      window.__lab!.camera.spec = { type: 'orbit', target: { vesselId: 'active' }, yaw: 0, pitch: 0.3, distance: 8 };
    }, c);
    await probeCycles(page);
    const m = await measure(page);
    const d = m.normals.find((n) => n.name === 'earth-facing')!;
    const u = m.normals.find((n) => n.name === 'space-facing')!;
    results.push({ label: c.label, down: d.gpu, brute: d.brute, up: u.gpu });
    console.log(`${c.label.padEnd(22)} ground-facing irradiance: probe ${d.gpu.toExponential(4)} lux, brute force ${d.brute.toExponential(4)} lux; sky-facing ${u.gpu.toExponential(3)} lux`);
  }
  const ref = results[0]!;
  for (const r of results) {
    expect(Math.abs(r.down / ref.down - 1)).toBeLessThan(0.1);
    expect(Math.abs(r.down / r.brute - 1)).toBeLessThan(0.1);
  }
  // Continuous through the datum (+1 m / -1 m): no step in the bounce light.
  const at = (l: string) => results.find((r) => r.label === l)!;
  expect(Math.abs(at('-1 m, site ground').down / at('+1 m, site ground').down - 1)).toBeLessThan(0.01);
  await expectNoErrors(page, pageLog);
});

test('probe energy responds to the day and night side and to altitude', async ({ page, pageLog }) => {
  await openPage(page, '/labs/sky/?scene=lowOrbit&planet=0&probeAlbedo=mean&hud=0');
  await assertDiscreteGpu(page);
  await waitIdle(page, 4, 300_000);
  const day = { elevationDeg: 60, azimuthDeg: 0 };
  // 200 km, 2000 km and 6000 km (1.94 R): the probe carries the Earth alone. 12,700 km (3.0 R): the render
  // core's planetshine carries half of it (smoothstep 2 R .. 4 R) and the probe the other half; the brute
  // force uses the same weight. At 20,000 km (4.1 R) the Earth is planetshine only and the probe holds the sky.
  const cases = [
    { label: 'day 200 km', alt: 200e3, sun: day },
    { label: 'night 200 km', alt: 200e3, sun: 'night' as const },
    { label: 'day 2000 km', alt: 2000e3, sun: day },
    { label: 'day 6000 km', alt: 6000e3, sun: day },
    { label: 'day 12700 km', alt: 12_742e3, sun: day },
    { label: 'day 20000 km', alt: 20_000e3, sun: day },
  ];
  const results: { label: string; down: number; brute: number; weight: number }[] = [];
  for (const c of cases) {
    await page.evaluate((x) => {
      window.__sky!.setVesselAltitude(x.alt);
      window.__sky!.setSunForVessel(x.sun);
      window.__lab!.camera.spec = { type: 'orbit', target: { vesselId: 'active' }, yaw: 0, pitch: 0.3, distance: 30 };
    }, c);
    await probeCycles(page);
    const m = await measure(page);
    const d = m.normals.find((n) => n.name === 'earth-facing')!;
    const weight = await page.evaluate(() => window.__sky!.referenceScene()!.bodies.reduce((a, b) => (b.radius > a.radius ? b : a)).weight);
    results.push({ label: c.label, down: d.gpu, brute: d.brute, weight });
    console.log(`${c.label.padEnd(14)} earth-facing irradiance: probe ${d.gpu.toExponential(3)} lux, brute force ${d.brute.toExponential(3)} lux (Earth weight in the probe ${weight.toFixed(3)})`);
  }
  const [d200, night, d2k, d6k, d12k, d20k] = results as [(typeof results)[0], (typeof results)[0], (typeof results)[0], (typeof results)[0], (typeof results)[0], (typeof results)[0]];
  expect(night.down).toBeLessThan(1e-3 * d200.down);
  expect(d2k.down).toBeLessThan(d200.down);
  expect(d6k.down).toBeLessThan(d2k.down);
  expect(d12k.down).toBeLessThan(d6k.down);
  for (const r of [d200, d2k, d6k, d12k]) expect(Math.abs(r.down / r.brute - 1)).toBeLessThan(0.1);
  expect(d6k.weight).toBe(1);
  expect(d12k.weight).toBeGreaterThan(0.3);
  expect(d12k.weight).toBeLessThan(0.7);
  expect(d20k.weight).toBe(0);
  expect(d20k.down).toBeLessThan(1e-6 * d200.down);
  await expectNoErrors(page, pageLog);
});
