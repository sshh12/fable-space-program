/**
 * Vehicles that cannot be shown yet (lead decision of 2026-11-24; requests fleet-data-2, capability-settings-2).
 * A vehicle is PRESENTABLE when every one of its parts has a visual definition (src/core/access/presentable.ts).
 * The library holds vehicles whose models are a later package's, and a page that starts the vessel feature must
 * neither build, log nor throw anything for them:
 *
 *  1. with the whole library the lab starts clean (no error, no console line): before the rule the vessel
 *     feature built the models of every vehicle at start-up and reported each part without a visual;
 *  2. a vessel that is not presentable is not drawn, and neither are its plumes nor its cabin; the feature names its vehicle
 *     ONCE in `status()` (with the parts that have no visual) and nothing reaches the console, however many
 *     frames pass. Made in the page with `&novisual=<part>` (the lunar stack with one part's visual taken away
 *     in memory), so the test does not depend on which models the library lacks today;
 *  3. the same for a vehicle of the library that has no models yet, flown as data on the pad, while there is
 *     one (the test says which; none left = nothing to do).
 *
 * Pictures (looked at): out/screens/presentable/*.png.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/presentable.spec.ts --project=functional
 */
import { expect, saveScreenshot, test } from '../harness';
import { expectClean, openIntegration, settle } from './helpers';

test.setTimeout(15 * 60_000);
test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

interface VesselHandle {
  stats: { vessels: number; instances: number; triangles: number; ghosts: number; notShown: number };
  status(): { notPresentable: { vehicleId: string; parts: string[] }[] };
}
interface VfxHandle {
  debug: { stats(): Record<string, number> };
}
interface CockpitHandle {
  feature?: { stats(): { vesselId: string | null; triangles: number } };
}
interface LabPage {
  __integration: {
    app: { snapshot(): { activeVesselId: string; vessels: { id: string; vehicleId: string; parts: { def: string }[] }[] } };
    handles: Record<string, unknown>;
    vehicleIds: { all: string[]; presentable: string[] };
  };
}
interface Read {
  library: { all: string[]; presentable: string[] };
  vessel: { vehicleId: string; partDefs: string[] };
  stats: VesselHandle['stats'];
  status: ReturnType<VesselHandle['status']>;
  plumes: number;
  lights: number;
  /** The vessel whose cabin the cockpit feature draws (null = none), and the cabin's triangles. */
  cabin: { vesselId: string | null; triangles: number } | null;
  activeVesselId: string;
}

test('vehicles that cannot be shown: nothing is built or reported for them at start-up; a vessel of one is not drawn and its vehicle is named once', async ({ page, pageLog }) => {
  const read = (): Promise<Read> =>
    page.evaluate(() => {
      const lab = (window as unknown as LabPage).__integration;
      const feature = lab.handles['vehicle.createVesselVisualFeature'] as VesselHandle;
      const vfx = lab.handles['vfx.createVfxFeature'] as VfxHandle | undefined;
      const snapshot = lab.app.snapshot();
      const active = snapshot.vessels.find((v) => v.id === snapshot.activeVesselId)!;
      const fx = vfx?.debug.stats() ?? {};
      const cockpit = (lab.handles['cockpit.createCockpitFeature'] as CockpitHandle | undefined)?.feature?.stats();
      return {
        library: lab.vehicleIds,
        vessel: { vehicleId: active.vehicleId, partDefs: [...new Set(active.parts.map((p) => p.def))] },
        stats: { ...feature.stats },
        status: feature.status(),
        plumes: fx['plumeInstances'] ?? 0,
        lights: fx['lights'] ?? 0,
        cabin: cockpit ? { vesselId: cockpit.vesselId, triangles: cockpit.triangles } : null,
        activeVesselId: active.id,
      };
    });
  const frames = (n: number): Promise<void> => page.evaluate((k) => window.__test!.waitFrames(k), n);

  // ---- 1. The whole library: the stack in its climb, its engines burning.
  const SCENE = 'scene=ascent&start=8950&throttle=1&hud=0';
  let info = await openIntegration(page, SCENE, { timeoutMs: 240_000 });
  await settle(page, 30, 300_000);
  const whole = await read();
  await saveScreenshot(page, 'presentable', 'whole-library');
  const others = whole.library.all.filter((id) => !whole.library.presentable.includes(id));
  console.log(`library: ${whole.library.all.length} vehicles, presentable: ${whole.library.presentable.join(', ')}; not yet: ${others.join(', ') || 'none'}`);
  console.log(`whole library: ${whole.vessel.vehicleId} drawn with ${whole.stats.instances} instances, ${whole.stats.triangles} triangles, ${whole.plumes} plume instances; status ${JSON.stringify(whole.status)}`);
  expect(whole.library.presentable).toContain(whole.vessel.vehicleId);
  expect(whole.stats.vessels).toBeGreaterThanOrEqual(1);
  expect(whole.stats.instances).toBeGreaterThan(0);
  expect(whole.stats.notShown).toBe(0);
  expect(whole.status.notPresentable).toEqual([]);
  expect(whole.plumes, 'the stack burns in this scene').toBeGreaterThan(0);
  // (The lab loads the cockpit feature: the capsule's cabin is drawn behind its windows.)
  console.log(`whole library: cabin of ${whole.cabin?.vesselId ?? 'no vessel'}, ${whole.cabin?.triangles ?? 0} triangles`);
  expect(whole.cabin?.vesselId, 'the cabin of the stack is drawn').toBe(whole.activeVesselId);
  await expectClean(page, pageLog, info);
  expect(info.problems.filter((p) => p.startsWith('vehicle:') || p.startsWith('vfx:')), 'problems of the vessel and effects packages').toEqual([]);

  // ---- 2. The same page with the visual of one of the stack's parts taken away: the vessel is not presentable.
  const part = whole.vessel.partDefs[0]!;
  // (The vehicle is named: with its visual gone it is no longer the first presentable vehicle the lab would take.)
  info = await openIntegration(page, `${SCENE}&vehicle=${whole.vessel.vehicleId}&novisual=${part}`, { timeoutMs: 240_000 });
  await settle(page, 30, 300_000);
  const hidden = await read();
  await saveScreenshot(page, 'presentable', 'not-presentable');
  console.log(`without the visual of ${part}: ${hidden.stats.vessels} vessels drawn (${hidden.stats.instances} instances), ${hidden.stats.notShown} not shown, ${hidden.plumes} plume instances; status ${JSON.stringify(hidden.status)}`);
  expect(hidden.vessel.vehicleId).toBe(whole.vessel.vehicleId);
  expect(hidden.vessel.partDefs).toEqual(whole.vessel.partDefs);
  expect(hidden.library.presentable).not.toContain(hidden.vessel.vehicleId);
  expect(hidden.stats.vessels).toBe(0);
  expect(hidden.stats.instances).toBe(0);
  expect(hidden.stats.notShown).toBe(1);
  expect(hidden.plumes, 'plumes of a vessel that is not drawn').toBe(0);
  expect(hidden.cabin?.vesselId ?? null, 'the cabin of a vessel that is not drawn').toBeNull();
  expect(hidden.status.notPresentable).toEqual([{ vehicleId: hidden.vessel.vehicleId, parts: [part] }]);
  // Many frames on: still one entry, and nothing in the console or in the page's errors.
  await frames(240);
  const later = await read();
  expect(later.status.notPresentable).toEqual([{ vehicleId: hidden.vessel.vehicleId, parts: [part] }]);
  expect(later.stats.notShown).toBe(1);
  await expectClean(page, pageLog, info);
  expect(info.problems.filter((p) => p.startsWith('vehicle:') || p.startsWith('vfx:')), 'problems of the vessel and effects packages').toEqual([]);

  // ---- 3. A vehicle of the library that has no models yet, as data on the pad (while the library has one).
  if (others.length === 0) {
    console.log('every vehicle of the library is presentable: nothing to fly as data');
    return;
  }
  const vehicleId = others[0]!;
  info = await openIntegration(page, `scene=pad&hud=0&vehicle=${vehicleId}`, { timeoutMs: 240_000 });
  await settle(page, 30, 300_000);
  const data = await read();
  await saveScreenshot(page, 'presentable', 'library-vehicle-without-models');
  console.log(`${vehicleId} on the pad: ${data.stats.vessels} vessels drawn, ${data.stats.notShown} not shown; status ${JSON.stringify(data.status)}`);
  expect(data.vessel.vehicleId).toBe(vehicleId);
  expect(data.stats.vessels).toBe(0);
  expect(data.stats.notShown).toBe(1);
  expect(data.status.notPresentable.map((n) => n.vehicleId)).toEqual([vehicleId]);
  expect(data.status.notPresentable[0]!.parts.length).toBeGreaterThan(0);
  await frames(120);
  expect((await read()).status.notPresentable.map((n) => n.vehicleId)).toEqual([vehicleId]);
  await expectClean(page, pageLog, info);
  expect(info.problems.filter((p) => p.startsWith('vehicle:') || p.startsWith('vfx:')), 'problems of the vessel and effects packages').toEqual([]);
});
