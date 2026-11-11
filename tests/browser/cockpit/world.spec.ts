/**
 * The cockpit's acceptance views over the REAL world: the integration lab (labs/integration: terrain,
 * ocean, sky, atmosphere and clouds, the vehicle's exterior, vfx and the cockpit together, on the baked
 * tiles), from the commander's seat, at the exposure the renderer meters itself. Screenshots:
 * out/screens/cockpit/world-*.png. The cockpit lab's own views (views.spec.ts) use stand-ins for everything
 * outside the cabin and are functional evidence only.
 *
 * The camera and the sun are placed through the lab's handle (window.__integration) and, where a view needs
 * the head off the head rest or a camera outside a window, by a free camera computed in the page from the
 * snapshot and the cabin model (the lab is paused, so the vessel stands still).
 */
import type { Page } from '@playwright/test';
import { assertDiscreteGpu, assertRealImage, expect, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.use({ viewport: { width: 1600, height: 900 } });

/**
 * A point of the cabin (part frame): relative to the commander's eye in the seat's axes (right, head-up,
 * forward), on a window's axis `out` metres outside its centre, the centre of a display, on the line from
 * a cabin point out through a window's centre (`out` metres beyond it: the way the sun comes in, reversed),
 * or given directly.
 */
type PointSpec = { seat: [number, number, number] } | { window: string; out: number } | { display: number } | { through: string; from: PointSpec; out: number } | { p: [number, number, number] };

interface Recipe {
  /** Sun: through a window onto a cabin point, a direction in the vessel frame, behind the body (night), or the scene's own. */
  sun?: { onto: PointSpec } | { ves: [number, number, number] } | 'eclipse';
  lights?: boolean;
  /** Camera: the seat's own view turned by yaw / pitch, or a free camera. */
  seat?: { yaw: number; pitch: number };
  free?: { kind: 'interior' | 'external'; eye: PointSpec; look: PointSpec; up?: 'seat' | 'nose' };
  /** Seat view aimed at the window through which the body below shows most (the lab picks it). */
  windowBelow?: boolean;
  fovDeg: number;
}

/** Runs in the page: place the sun, the lights and the camera of one view. Returns what it found. */
async function apply(page: Page, recipe: Recipe): Promise<{ ok: boolean; why: string; layout: string | null }> {
  return page.evaluate((r) => {
    type V = { x: number; y: number; z: number };
    type Q = { x: number; y: number; z: number; w: number };
    const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
    const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
    const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k, z: a.z * k });
    const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y + a.z * b.z;
    const cross = (a: V, b: V): V => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
    const norm = (a: V): V => scale(a, 1 / Math.hypot(a.x, a.y, a.z));
    const qmul = (a: Q, b: Q): Q => ({
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    });
    const qrot = (q: Q, v: V): V => {
      const u = { x: q.x, y: q.y, z: q.z };
      const t = scale(cross(u, v), 2);
      return add(add(v, scale(t, q.w)), cross(u, t));
    };
    const qinv = (q: Q): Q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
    /** Quaternion of the rotation whose columns are the unit axes r, u, b. */
    const fromBasis = (rr: V, u: V, b: V): Q => {
      const tr = rr.x + u.y + b.z;
      if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        return { w: s / 4, x: (u.z - b.y) / s, y: (b.x - rr.z) / s, z: (rr.y - u.x) / s };
      }
      if (rr.x > u.y && rr.x > b.z) {
        const s = Math.sqrt(1 + rr.x - u.y - b.z) * 2;
        return { w: (u.z - b.y) / s, x: s / 4, y: (u.x + rr.y) / s, z: (b.x + rr.z) / s };
      }
      if (u.y > b.z) {
        const s = Math.sqrt(1 + u.y - rr.x - b.z) * 2;
        return { w: (b.x - rr.z) / s, x: (u.x + rr.y) / s, y: s / 4, z: (b.y + u.z) / s };
      }
      const s = Math.sqrt(1 + b.z - rr.x - u.y) * 2;
      return { w: (rr.y - u.x) / s, x: (b.x + rr.z) / s, y: (b.y + u.z) / s, z: s / 4 };
    };
    const lab = window.__integration!;
    const app = lab.app;
    const defs = app.defs;
    const snap = app.snapshot();
    const vessel = snap.vessels.find((v) => v.id === snap.activeVesselId)!;
    const vehicle = Object.values(defs.vehicles).find((d) => d.cockpit && vessel.parts.some((p) => p.instanceId === d.cameras.cockpit.part));
    const part = vessel.parts.find((p) => p.instanceId === vehicle?.cameras.cockpit.part);
    type Model = { windows: { id: string; centre: V; inward: V }[]; displays: { frame: { o: V } }[]; mould: { seats: { id: string; pos: number[]; lookDir: number[]; upDir: number[] }[] } };
    const feature = (lab.handles['cockpit.createCockpitFeature'] as { feature?: { model(id: string): Model | undefined } } | undefined)?.feature;
    const model = vehicle?.cockpit ? feature?.model(vehicle.cockpit) : undefined;
    if (!vehicle || !part || !model) return { ok: false, why: 'no cockpit vessel or cabin model', layout: null };
    const seatDef = model.mould.seats.find((s) => s.id === vehicle.cameras.cockpit.seat)!;
    const t3 = (a: number[]): V => ({ x: a[0]!, y: a[1]!, z: a[2]! });
    const L = norm(t3(seatDef.lookDir));
    const U = norm(sub(t3(seatDef.upDir), scale(L, dot(t3(seatDef.upDir), L))));
    const R = cross(L, U);
    const point = (p: unknown): V => {
      const q = p as { seat?: number[]; window?: string; out?: number; display?: number; p?: number[]; through?: string; from?: unknown };
      if (q.through) {
        const w = model.windows.find((x) => x.id === q.through)!;
        return add(w.centre, scale(norm(sub(w.centre, point(q.from))), q.out ?? 0));
      }
      if (q.seat) return add(t3(seatDef.pos), add(add(scale(R, q.seat[0]!), scale(U, q.seat[1]!)), scale(L, q.seat[2]!)));
      if (q.window) {
        const w = model.windows.find((x) => x.id === q.window)!;
        return add(w.centre, scale(w.inward, -(q.out ?? 0)));
      }
      if (q.display !== undefined) return model.displays[q.display]!.frame.o;
      return t3(q.p!);
    };
    const qPart = qmul(vessel.q as Q, part.localRot as Q);
    const toRoot = (p: V): V => add(vessel.rRoot as V, qrot(vessel.q as Q, add(part.localPos as V, qrot(part.localRot as Q, p))));
    // ---- sun
    if (r.sun === 'eclipse') {
      const body = snap.bodies.find((b) => b.id === vessel.bodyId)!;
      lab.setSunInVesselFrame(norm(qrot(qinv(vessel.q as Q), sub(body.rRoot as V, vessel.rRoot as V))));
    } else if (r.sun && 'ves' in r.sun) lab.setSunInVesselFrame(norm(t3(r.sun.ves)));
    else if (r.sun && 'onto' in r.sun) lab.sunThroughWindowOnto(point(r.sun.onto));
    // ---- lights
    if (r.lights !== undefined && r.lights !== snap.readouts.lightsOn) app.sim.commands.toggleLights();
    // ---- camera
    if (r.windowBelow) {
      if (!lab.sitAtWindowBelow()) return { ok: false, why: 'no window toward the body below', layout: vehicle.cockpit ?? null };
    } else if (r.seat) {
      if (!lab.sitInCockpit(r.seat.yaw, r.seat.pitch)) return { ok: false, why: 'no cockpit seat', layout: vehicle.cockpit ?? null };
    } else if (r.free) {
      lab.release();
      const eye = point(r.free.eye);
      const f = norm(qrot(qPart, sub(point(r.free.look), eye)));
      // Up: the seat's head-up direction inside, the capsule's nose outside (unless the view says otherwise).
      const upHint = qrot(qPart, (r.free.up ?? (r.free.kind === 'interior' ? 'seat' : 'nose')) === 'seat' ? U : { x: 0, y: 1, z: 0 });
      const rr = norm(cross(f, upHint));
      const u = cross(rr, f);
      app.camera.spec = { type: 'free', positionRoot: toRoot(eye), qViewToRoot: fromBasis(rr, u, scale(f, -1)) };
      app.camera.settings.kind = r.free.kind;
    }
    app.camera.settings.fovY = (r.fovDeg * Math.PI) / 180;
    return { ok: true, why: '', layout: vehicle.cockpit ?? null };
  }, recipe);
}

/** Frames until the tiles are in, the exposure has adapted and TAA has converged. */
async function settle(page: Page): Promise<void> {
  await waitIdle(page, 8, 300_000);
  await page.evaluate(() => window.__test!.setDeterministic(true));
  await page.waitForFunction(
    async () => {
      await window.__test!.waitFrames(30);
      const e = window.__lab!.renderer.exposureInfo();
      return Math.abs(e.ev100 - e.targetEv100) < 0.05;
    },
    undefined,
    { timeout: 180_000, polling: 100 },
  );
  await page.evaluate(() => window.__test!.waitFrames(60));
}

const SIDE = 'side-left';
const views: { name: string; query: string; recipe: Recipe; dark?: boolean }[] = [
  // On the pad at noon, the whole stack under the capsule, looking up through the forward windows.
  { name: 'world-pad-noon-forward-window', query: 'scene=pad', recipe: { sun: { ves: [0.08, 0.9, 0.43] }, lights: true, seat: { yaw: 18, pitch: 46 }, fovDeg: 70 } },
  // Low orbit, windows toward the Earth: the head turned to the side window the Earth fills, exposed as the
  // renderer meters the cabin; the sun through the opposite window on the console.
  { name: 'world-leo-earth-side-window', query: 'scene=lowOrbit&roll=180', recipe: { sun: { onto: { display: 0 } }, windowBelow: true, fovDeg: 55 } },
  { name: 'world-leo-sun-patch-console', query: 'scene=lowOrbit&roll=180', recipe: { sun: { onto: { display: 0 } }, seat: { yaw: 8, pitch: 2 }, fovDeg: 70 } },
  // The night side: the sun behind the Earth, the cabin under its floods and displays.
  { name: 'world-night-displays-floods', query: 'scene=lowOrbit&roll=180', recipe: { sun: 'eclipse', lights: true, seat: { yaw: 20, pitch: -2 }, fovDeg: 70 }, dark: true },
  // Entry: the shock layer outside the windows, the floods on.
  { name: 'world-reentry-plasma', query: 'scene=reentry', recipe: { lights: true, seat: { yaw: 16, pitch: 40 }, fovDeg: 70 }, dark: true },
  // On the lunar surface: the head at the side window, level with it, the horizon outside.
  // (The capsule stands upright there: the picture is taken head-up along the capsule's nose.)
  { name: 'world-moon-horizon', query: 'scene=lunarSurface', recipe: { free: { kind: 'interior', eye: { seat: [-0.02, -0.12, 0.05] }, look: { window: SIDE, out: 6 }, up: 'nose' }, fovDeg: 52 } },
  // From outside: looking in through a forward window by day (the sun's way in) and on the night side.
  { name: 'world-chase-window-sun', query: 'scene=lowOrbit&roll=180', recipe: { sun: { onto: { display: 0 } }, free: { kind: 'external', eye: { through: 'side-right', from: { display: 0 }, out: 1.0 }, look: { display: 0 } }, fovDeg: 40 } },
  { name: 'world-chase-window-night', query: 'scene=lowOrbit&roll=180', recipe: { sun: 'eclipse', lights: true, free: { kind: 'external', eye: { through: 'fwd-left', from: { seat: [0.1, -0.1, 0.3] }, out: 0.7 }, look: { seat: [0.1, -0.1, 0.3] } }, fovDeg: 45 }, dark: true },
];

for (const v of views) {
  test(`world screenshot ${v.name}`, async ({ page }) => {
    test.setTimeout(600_000);
    await openPage(page, `/labs/integration/?${v.query}&hud=0&paused=1`, { timeoutMs: 240_000 });
    await assertDiscreteGpu(page);
    const info = await page.evaluate(() => ({ loaded: window.__integration!.loaded, problems: window.__integration!.problems }));
    test.skip(!info.loaded.includes('cockpit'), `the integration lab did not load the cockpit: ${info.problems.join('; ')}`);
    await page.evaluate(() => window.__test!.waitFrames(5));
    const placed = await apply(page, v.recipe);
    expect(placed.ok, placed.why).toBe(true);
    await settle(page);
    const shot = await saveScreenshot(page, 'cockpit', v.name);
    assertRealImage(shot.stats, v.name, v.dark ? { minNonBlack: 0.05, minStd: 3, minBuckets: 20 } : { minNonBlack: 0.2, minStd: 6, minBuckets: 30 });
    // The cockpit drew the frame, at full detail when the eye is in the cabin, and the lab did not switch it off.
    const state = await page.evaluate(() => {
      const f = (window.__integration!.handles['cockpit.createCockpitFeature'] as { feature: { stats(): { active: boolean; lod: string | null; inside: boolean } } }).feature;
      return { stats: f.stats(), loaded: window.__integration!.loaded, problems: window.__integration!.problems.filter((p) => p.startsWith('cockpit')), errors: window.__test!.errors.filter((e) => /cockpit/i.test(e)) };
    });
    console.log(`  ${v.name}: loaded ${info.loaded.join(', ')}; lod ${state.stats.lod}, inside ${state.stats.inside}`);
    expect(state.stats.active).toBe(true);
    expect(state.loaded).toContain('cockpit');
    expect(state.problems).toEqual([]);
    expect(state.errors).toEqual([]);
    if (v.recipe.seat || v.recipe.free?.kind === 'interior') expect(state.stats.inside).toBe(true);
  });
}
