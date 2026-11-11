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
import { PNG } from 'pngjs';
import { assertRealImage, expect, saveScreenshot, test } from '../harness';
import { expectClean, freeze, openIntegration, settle } from '../integration/helpers';

test.describe.configure({ timeout: 600_000 });

interface SceneLike {
  proj: { cssScale: number };
  lines: { id: string; kind: string; start: number; count: number }[];
  verts: { sx: Float64Array; sy: Float64Array; alpha: Float64Array; seg: Uint8Array };
  bodies: { bodyId: string; ghost: boolean; x: number; y: number; radiusPx: number }[];
}
interface MapHandle {
  view: {
    setActive(on: boolean): void;
    selectNode(id: string | null): void;
    readonly selectedNodeId: string | null;
    describe(): { kind: string; id: string; x: number; y: number; visible: boolean }[];
    setObstacles(rects: { x: number; y: number; width: number; height: number }[]): void;
    controller: { currentScene: SceneLike | null; tooltipRect: { x: number; y: number; width: number; height: number } | null };
  };
}
declare global {
  interface Window {
    __realMap?: MapHandle;
    __realHud?: { rects(): { x: number; y: number; width: number; height: number }[] };
  }
}

/**
 * Mount the flight HUD (src/ui, the flight-ui package's public createHud) over the integration lab, updated
 * every frame with the lab's snapshot and camera (map kind), and hand its panel rectangles (and the navball's
 * box) to the map as obstacles, as the app shell would: the frame the player sees in map view.
 */
async function mountHud(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const app = window.__integration!.app;
    const url = '/src/ui/index.ts';
    type Hud = { mount(el: HTMLElement): void; update(s: unknown, c: unknown, dt: number): void; setVisible(v: boolean): void };
    const ui = (await import(/* @vite-ignore */ url)) as { createHud(o: unknown): Hud; createNavballRenderer(gpu: unknown): unknown };
    const hud = ui.createHud({ defs: app.defs, gpu: app.gpu, navball: ui.createNavballRenderer(app.gpu), dispatch: () => undefined, keyHelp: [] });
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:10';
    document.body.appendChild(host);
    hud.mount(host);
    hud.setVisible(true);
    // The HUD's panels: the selectors of its own coverage check (tests/browser/flight-ui/screens.spec.ts).
    const rects = (): { x: number; y: number; width: number; height: number }[] => {
      const visible = (e: Element): boolean => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const els = [...host.querySelectorAll('.hud .panel, .hud .later, .hud .tile:not(.compact), .hud .pill, .hud .helpbtn, .hud .more, .hud .housing, .hud .prw, .hud .toast, .hud .ball')].filter(visible);
      return els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.left, y: r.top, width: r.width, height: r.height }));
    };
    window.__realHud = { rects };
    let last = performance.now();
    let n = 0;
    const tick = (now: number): void => {
      hud.update(app.snapshot(), app.cameraState(), Math.min(0.1, (now - last) / 1000));
      last = now;
      if (n++ % 10 === 0) window.__realMap?.view.setObstacles(rects());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Map labels, the node panel and the tooltip are clear of every HUD panel (CSS px). */
async function expectClearOfHud(page: Page): Promise<number> {
  const r = await page.evaluate(() => {
    const hud = window.__realHud!.rects();
    const panel = document.querySelector<HTMLElement>('[data-map-panel]');
    const own: { x: number; y: number; width: number; height: number; what: string }[] = [];
    if (panel && panel.style.display !== 'none') {
      const b = panel.getBoundingClientRect();
      own.push({ x: b.left, y: b.top, width: b.width, height: b.height, what: 'node panel' });
    }
    return { hud, own };
  });
  for (const o of r.own) {
    for (const h of r.hud) {
      const ox = Math.min(o.x + o.width, h.x + h.width) - Math.max(o.x, h.x);
      const oy = Math.min(o.y + o.height, h.y + h.height) - Math.max(o.y, h.y);
      expect(ox > 1 && oy > 1, `${o.what} over a HUD panel at ${h.x.toFixed(0)},${h.y.toFixed(0)}`).toBe(false);
    }
  }
  return r.hud.length;
}

/**
 * The silhouette of the body is visible where its night side meets space: on the limb ring's night stretch
 * (vertex alpha 1), the pixel on the limb differs from the sky 8 px further out. Returns the fraction of samples
 * with a visible step (at least 20 of 255 in the brightest channel).
 */
async function nightLimbContrast(page: Page, png: PNG, bodyId: string): Promise<{ samples: number; visible: number }> {
  const pts = await page.evaluate((id) => {
    const sc = window.__realMap!.view.controller.currentScene!;
    const k = sc.proj.cssScale;
    const line = sc.lines.find((l) => l.id === `limb:${id}`);
    const body = sc.bodies.find((b) => b.bodyId === id && !b.ghost);
    if (!line || !body) return [];
    const out: { x: number; y: number; nx: number; ny: number }[] = [];
    for (let i = line.start; i < line.start + line.count; i++) {
      if (sc.verts.alpha[i]! < 0.99 || sc.verts.seg[i] !== 1) continue;
      const x = sc.verts.sx[i]!;
      const y = sc.verts.sy[i]!;
      const l = Math.hypot(x - body.x, y - body.y);
      out.push({ x: x / k, y: y / k, nx: (x - body.x) / l, ny: (y - body.y) / l });
    }
    return out;
  }, bodyId);
  let samples = 0;
  let visible = 0;
  const at = (x: number, y: number): number => {
    const i = (Math.round(y) * png.width + Math.round(x)) * 4;
    return Math.max(png.data[i]!, png.data[i + 1]!, png.data[i + 2]!);
  };
  for (const p of pts) {
    const ox = p.x + p.nx * 8;
    const oy = p.y + p.ny * 8;
    if (p.x < 2 || p.y < 2 || p.x > png.width - 3 || p.y > png.height - 3 || ox < 0 || oy < 0 || ox > png.width - 1 || oy > png.height - 1) continue;
    samples++;
    if (at(p.x, p.y) - at(ox, oy) >= 20) visible++;
  }
  return { samples, visible };
}

/**
 * Mount the map feature into the integration lab and switch it on. As the app shell does, `view.update` runs
 * every frame with the snapshot and camera on screen and the canvas size in CSS px (the pointer at rest), so
 * the map knows the device pixel ratio.
 */
async function mountMap(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const app = window.__integration!.app;
    const url = '/src/map/index.ts';
    type View = MapHandle['view'] & { update(s: unknown, c: unknown, cmd: unknown, p: unknown, size: [number, number]): unknown };
    const mod = (await import(/* @vite-ignore */ url)) as { createMapView(gpu: unknown, defs: unknown): { view: View; feature: unknown } };
    const { view, feature } = mod.createMapView(app.gpu, app.defs);
    await app.renderer.addFeature(feature as Parameters<typeof app.renderer.addFeature>[0]);
    view.setActive(true);
    window.__realMap = { view };
    const rest = { x: -100, y: -100, dx: 0, dy: 0, buttons: 0, pressed: false, released: false, doubleClick: false, wheel: 0, shift: false, ctrl: false, alt: false, overUi: false };
    const tick = (): void => {
      const canvas = document.querySelector('canvas');
      const r = canvas ? canvas.getBoundingClientRect() : { width: innerWidth, height: innerHeight };
      view.update(app.snapshot(), app.cameraState(), app.sim.commands, rest, [r.width, r.height]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Put the lab camera where the map lab's orbit camera would be: `dist` m from the focus body along the
 * direction given by yaw / pitch (ROOT axes), looking at it, 50 degree field of view, map camera kind. With
 * `moonAt` (degrees clockwise from screen up) the camera rolls about its view axis so the focus body's
 * satellite appears in that direction (the player turns the map camera so; the HUD's navball and panels cover
 * the bottom of the frame). `rollDeg` turns the picture about the view axis (space has no up; the map camera
 * may show a body upside down).
 */
async function orbitView(page: Page, focusBodyId: string | null, dir: 'default' | 'sun' | 'side' | { yaw: number; pitch: number; moonAt?: number }, dist: number, rollDeg = 0): Promise<void> {
  await page.evaluate(
    async ([bodyId, d, distance, roll]) => {
      const app = window.__integration!.app;
      const url = '/src/map/testing/camera.ts';
      type Vec = { x: number; y: number; z: number };
      type Cam = { positionRoot: Vec; qViewToRoot: unknown };
      const cam = (await import(/* @vite-ignore */ url)) as { orbitCamera(focus: unknown, yaw: number, pitch: number, distance: number): Cam; lookAtCamera(eye: Vec, target: Vec, fovY: number, upHint: Vec): Cam };
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
      } else if (d === 'side') {
        // Above the orbit plane, leaning across the vessel's track: the vessel sits beside the disc, clear of
        // the HUD's navball at the bottom centre.
        const W = s.patches.current[0]!.conic.W;
        const r = norm(active.r);
        const t = norm({ x: W.y * r.z - W.z * r.y, y: W.z * r.x - W.x * r.z, z: W.x * r.y - W.y * r.x });
        const v = norm({ x: 0.75 * W.x + 0.6 * t.x + 0.2 * r.x, y: 0.75 * W.y + 0.6 * t.y + 0.2 * r.y, z: 0.75 * W.z + 0.6 * t.z + 0.2 * r.z });
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
      let c = cam.orbitCamera(body.rRoot, yaw, pitch, distance);
      const moonAt = typeof d === 'object' ? d.moonAt : undefined;
      const moon = s.bodies.find((b) => b.id !== body.id && b.orbit !== null);
      if (moonAt !== undefined && moon) {
        const o = { x: Math.cos(pitch) * Math.cos(yaw), y: Math.cos(pitch) * Math.sin(yaw), z: Math.sin(pitch) };
        const eye = { x: body.rRoot.x + o.x * distance, y: body.rRoot.y + o.y * distance, z: body.rRoot.z + o.z * distance };
        const m = norm({ x: moon.rRoot.x - body.rRoot.x, y: moon.rRoot.y - body.rRoot.y, z: moon.rRoot.z - body.rRoot.z });
        const k = m.x * o.x + m.y * o.y + m.z * o.z;
        // a: the satellite's direction in the view plane; b = forward x a (screen right when a is up)
        const a = norm({ x: m.x - k * o.x, y: m.y - k * o.y, z: m.z - k * o.z });
        const b = norm({ x: -o.y * a.z + o.z * a.y, y: -o.z * a.x + o.x * a.z, z: -o.x * a.y + o.y * a.x });
        const th = (moonAt * Math.PI) / 180;
        const up = { x: Math.cos(th) * a.x - Math.sin(th) * b.x, y: Math.cos(th) * a.y - Math.sin(th) * b.y, z: Math.cos(th) * a.z - Math.sin(th) * b.z };
        c = cam.lookAtCamera(eye, body.rRoot, (50 * Math.PI) / 180, up);
      } else if (roll !== 0) {
        const o = { x: Math.cos(pitch) * Math.cos(yaw), y: Math.cos(pitch) * Math.sin(yaw), z: Math.sin(pitch) };
        const right = { x: -Math.sin(yaw), y: Math.cos(yaw), z: 0 };
        // the orbit camera's up = right x forward (forward = -o)
        const up0 = { x: -(right.y * o.z - right.z * o.y), y: -(right.z * o.x - right.x * o.z), z: -(right.x * o.y - right.y * o.x) };
        const th = (roll * Math.PI) / 180;
        const up = { x: Math.cos(th) * up0.x + Math.sin(th) * right.x, y: Math.cos(th) * up0.y + Math.sin(th) * right.y, z: Math.cos(th) * up0.z + Math.sin(th) * right.z };
        const eye = { x: body.rRoot.x + o.x * distance, y: body.rRoot.y + o.y * distance, z: body.rRoot.z + o.z * distance };
        c = cam.lookAtCamera(eye, body.rRoot, (50 * Math.PI) / 180, up);
      }
      // The lab's own camera placement (if any) would move the camera back every frame.
      window.__integration!.release();
      app.camera.settings.kind = 'map';
      app.camera.settings.fovY = (50 * Math.PI) / 180;
      app.camera.spec = { type: 'free', positionRoot: c.positionRoot, qViewToRoot: c.qViewToRoot } as typeof app.camera.spec;
    },
    [focusBodyId, dir, dist, rollDeg] as const,
  );
}

/** `minNonBlack`: the overview is black space with two specks and thin lines. */
async function shoot(page: Page, name: string, minNonBlack = 0.01): Promise<PNG> {
  await settle(page, 10);
  const shot = await saveScreenshot(page, 'map-view', name);
  assertRealImage(shot.stats, name, { minNonBlack, minStd: 2, minBuckets: 20 });
  return PNG.sync.read(shot.buffer);
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
  const night = await shoot(page, 'real-lowOrbit');
  // the night side's edge is drawn: the orbit does not start in mid-air
  const earthId = await page.evaluate(() => window.__integration!.app.snapshot().vessels[0]!.bodyId);
  const c = await nightLimbContrast(page, night, earthId);
  console.log(`[real-lowOrbit] night limb: ${c.visible} of ${c.samples} samples a visible step above the sky`);
  expect(c.samples).toBeGreaterThan(10);
  expect(c.visible / c.samples).toBeGreaterThan(0.8);
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
  // The acceptance step of the node panel (accept-panel.png over the lab's sphere) over the real planet: a small
  // burn whose planned Ap sits beside the current one, the panel, the pad and a zone.
  await page.evaluate(() => {
    const app = window.__integration!.app;
    const id = window.__realMap!.view.selectedNodeId!;
    app.sim.commands.setNode(id, { dv: { prograde: 50, normal: 10, radial: 0 } });
  });
  await orbitView(page, null, 'default', 4e7);
  await shoot(page, 'real-lowOrbit-panel');
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
  const moonShot = await shoot(page, 'real-lunarOrbit');
  const moonId = await page.evaluate(() => window.__integration!.app.snapshot().vessels[0]!.bodyId);
  const c = await nightLimbContrast(page, moonShot, moonId);
  console.log(`[real-lunarOrbit] night limb: ${c.visible} of ${c.samples} samples a visible step above the sky`);
  if (c.samples > 10) expect(c.visible / c.samples).toBeGreaterThan(0.8);
  await expectClean(page, pageLog, lunar);
});

/**
 * The frame the player sees in map view: the real renderer, the map, and the flight HUD (src/ui createHud,
 * updated every frame with the map camera) whose panels the map keeps clear of (setObstacles). Low orbit with a
 * planned burn (gizmo, node panel and the HUD's MANEUVER panel together), the translunar overview and lunar
 * orbit at 720p, and the node editor at 1920 x 1080 with device pixel ratio 2 (the glyph atlas at 2x).
 */
for (const [tag, viewport, dpr] of [
  ['720p', { width: 1280, height: 720 }, 1],
  ['4k', { width: 1920, height: 1080 }, 2],
] as const) {
  test.describe(`map view with the flight HUD, ${tag}`, () => {
    test.use({ viewport, deviceScaleFactor: dpr });
    test(`real renderer + HUD: low orbit with a node${tag === '720p' ? ', translunar overview, lunar orbit' : ''}`, async ({ page, pageLog }) => {
      const info = await openWithMap(page, 'lowOrbit');
      await mountHud(page);
      await page.evaluate(() => {
        const app = window.__integration!.app;
        const s = app.snapshot();
        const id = app.sim.commands.addNode(s.ut + 1500);
        app.sim.commands.setNode(id, { dv: { prograde: 420, normal: 60, radial: -40 } });
        window.__realMap!.view.selectNode(id);
      });
      await orbitView(page, null, 'default', 2.4e7);
      await shoot(page, `real-hud-lowOrbit-node-${tag}`);
      await expect(page.locator('[data-map-panel]')).toBeVisible();
      expect(await expectClearOfHud(page)).toBeGreaterThan(3);
      await expectClean(page, pageLog, info);
      if (tag !== '720p') return;

      const tl = await openWithMap(page, 'translunar');
      await mountHud(page);
      const moonOrbitView = await page.evaluate(() => {
        const s = window.__integration!.app.snapshot();
        const moon = s.bodies.find((b) => b.orbit !== null)!;
        const W = moon.orbit!.W;
        // the Moon in the upper right, clear of the navball and the HUD's bottom cluster
        return { yaw: Math.atan2(W.y, W.x), pitch: Math.asin(W.z) - 0.35, moonAt: 45 };
      });
      await orbitView(page, null, moonOrbitView, 1.0e9);
      await shoot(page, 'real-hud-translunar', 0.002);
      await expectClearOfHud(page);
      await expectClean(page, pageLog, tl);

      const lo = await openWithMap(page, 'lunarOrbit');
      await mountHud(page);
      // turned upside down: the landing target, near the sub-camera point, would sit under the HUD's speed plate
      await orbitView(page, null, 'side', 7e6, 180);
      await shoot(page, 'real-hud-lunarOrbit');
      await expectClearOfHud(page);
      await expectClean(page, pageLog, lo);
    });
  });
}
