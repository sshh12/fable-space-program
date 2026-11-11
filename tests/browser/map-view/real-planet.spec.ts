/**
 * The map overlay over the REAL renderer: the map feature is mounted into the integration lab (every render
 * package in the tree: terrain, atmosphere and clouds, ocean, sky) and photographed where legibility is
 * hardest: the lit Earth with its clouds and bright limb, the terminator and night side, the real Moon, the
 * translunar overview, and the node editor over the planet. Screenshots: out/screens/map-view/real-*.png.
 *
 * The page is the integration lab (core-support's); this spec adds the map from outside, through the lab's
 * public handle (window.__integration.app: GPU, definitions, renderer, camera) and the map's public factory,
 * exactly as the app shell would.
 */
import type { Page } from '@playwright/test';
import { assertRealImage, expect, saveScreenshot, test } from '../harness';
import { expectClean, freeze, openIntegration, settle } from '../integration/helpers';

test.describe.configure({ timeout: 600_000 });

interface MapHandle {
  view: { setActive(on: boolean): void; selectNode(id: string | null): void; describe(): { kind: string; id: string; x: number; y: number; visible: boolean }[] };
}
declare global {
  interface Window {
    __realMap?: MapHandle;
  }
}

/** Mount the map feature into the integration lab and switch it on. */
async function mountMap(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const app = window.__integration!.app;
    const url = '/src/map/index.ts';
    const mod = (await import(/* @vite-ignore */ url)) as { createMapView(gpu: unknown, defs: unknown): { view: MapHandle['view'] & { setActive(on: boolean): void }; feature: unknown } };
    const { view, feature } = mod.createMapView(app.gpu, app.defs);
    await app.renderer.addFeature(feature as Parameters<typeof app.renderer.addFeature>[0]);
    view.setActive(true);
    window.__realMap = { view };
  });
}

/**
 * Put the lab camera where the map lab's orbit camera would be: `dist` m from the focus body along the
 * direction given by yaw / pitch (ROOT axes), looking at it, 50 degree field of view, map camera kind.
 */
async function orbitView(page: Page, focusBodyId: string | null, dir: 'default' | 'sun' | { yaw: number; pitch: number }, dist: number): Promise<void> {
  await page.evaluate(
    async ([bodyId, d, distance]) => {
      const app = window.__integration!.app;
      const url = '/src/map/testing/camera.ts';
      const cam = (await import(/* @vite-ignore */ url)) as { orbitCamera(focus: unknown, yaw: number, pitch: number, distance: number): { positionRoot: { x: number; y: number; z: number }; qViewToRoot: unknown } };
      const s = app.snapshot();
      const active = s.vessels.find((v) => v.id === s.activeVesselId)!;
      const body = s.bodies.find((b) => b.id === (bodyId ?? active.bodyId))!;
      const norm = (v: { x: number; y: number; z: number }) => {
        const l = Math.hypot(v.x, v.y, v.z);
        return { x: v.x / l, y: v.y / l, z: v.z / l };
      };
      let yaw: number;
      let pitch: number;
      if (d === 'default') {
        // The map lab's default: above the orbit plane, leaning toward the vessel.
        const W = s.patches.current[0]!.conic.W;
        const r = norm(active.r);
        const v = norm({ x: 0.8 * W.x + 0.6 * r.x, y: 0.8 * W.y + 0.6 * r.y, z: 0.8 * W.z + 0.6 * r.z });
        yaw = Math.atan2(v.y, v.x);
        pitch = Math.asin(v.z);
      } else if (d === 'sun') {
        // Over the day side, 35 degrees off the sun line so limb, terminator and clouds share the frame.
        const sdir = body.sunDir;
        yaw = Math.atan2(sdir.y, sdir.x) + 0.6;
        pitch = Math.asin(Math.max(-1, Math.min(1, sdir.z))) + 0.15;
      } else {
        yaw = d.yaw;
        pitch = d.pitch;
      }
      const c = cam.orbitCamera(body.rRoot, yaw, pitch, distance);
      // The lab's own camera placement (if any) would move the camera back every frame.
      window.__integration!.release();
      app.camera.settings.kind = 'map';
      app.camera.settings.fovY = (50 * Math.PI) / 180;
      app.camera.spec = { type: 'free', positionRoot: c.positionRoot, qViewToRoot: c.qViewToRoot } as typeof app.camera.spec;
    },
    [focusBodyId, dir, dist] as const,
  );
}

/** `minNonBlack`: the overview is black space with two specks and thin lines. */
async function shoot(page: Page, name: string, minNonBlack = 0.01): Promise<void> {
  await settle(page, 10);
  const shot = await saveScreenshot(page, 'map-view', name);
  assertRealImage(shot.stats, name, { minNonBlack, minStd: 2, minBuckets: 20 });
}

/** Open the lab on a scene, let it settle, then mount the map. */
async function openWithMap(page: Page, scene: string): Promise<Awaited<ReturnType<typeof openIntegration>>> {
  const info = await openIntegration(page, `scene=${scene}&hud=0&paused=1`);
  await freeze(page);
  await settle(page, 6);
  await mountMap(page);
  return info;
}

test('real renderer, low Earth orbit: day side, limb, terminator, night side, zones and labels; then the node editor', async ({ page, pageLog }) => {
  const info = await openWithMap(page, 'lowOrbit');
  await orbitView(page, null, 'default', 2.4e7);
  await shoot(page, 'real-lowOrbit');
  await orbitView(page, null, 'sun', 1.4e7);
  await shoot(page, 'real-lowOrbit-dayside');
  // A planned burn with the gizmo and the panel over the planet.
  await page.evaluate(() => {
    const app = window.__integration!.app;
    const s = app.snapshot();
    const id = app.sim.commands.addNode(s.ut + 1500);
    app.sim.commands.setNode(id, { dv: { prograde: 420, normal: 60, radial: -40 } });
    window.__realMap!.view.selectNode(id);
  });
  await orbitView(page, null, 'default', 2.4e7);
  await shoot(page, 'real-lowOrbit-node');
  await expect(page.locator('[data-map-panel]')).toBeVisible();
  await expectClean(page, pageLog, info);
});

test('real renderer, translunar overview and the Moon close up', async ({ page, pageLog }) => {
  const info = await openWithMap(page, 'translunar');
  const moonOrbitView = await page.evaluate(() => {
    const s = window.__integration!.app.snapshot();
    const moon = s.bodies.find((b) => b.orbit !== null)!;
    const W = moon.orbit!.W;
    return { yaw: Math.atan2(W.y, W.x), pitch: Math.asin(W.z) - 0.35, moon: moon.id };
  });
  await orbitView(page, null, { yaw: moonOrbitView.yaw, pitch: moonOrbitView.pitch }, 1.25e9);
  await shoot(page, 'real-translunar', 0.002);
  await expectClean(page, pageLog, info);

  const lunar = await openWithMap(page, 'lunarOrbit');
  await orbitView(page, null, 'default', 7e6);
  await shoot(page, 'real-lunarOrbit');
  await expectClean(page, pageLog, lunar);
});
