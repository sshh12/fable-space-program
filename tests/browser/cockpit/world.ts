/**
 * The cockpit's acceptance views over the REAL world, as recipes for the integration lab (labs/integration:
 * terrain, ocean, sky, atmosphere and clouds, the vehicle's exterior, vfx and the cockpit together, on the
 * baked tiles): where the sun stands, whether the floods are on, where the camera is. world.spec.ts shoots
 * them and asserts what each picture must show; the probe spec of the visual rounds shoots variations.
 *
 * The camera and the sun are placed through the lab's handle (window.__integration) and, where a view needs
 * the head off the head rest or a camera outside a window, by a free camera computed in the page from the
 * snapshot and the cabin model (the lab is paused, so the vessel stands still).
 */
import type { Page } from '@playwright/test';
import { waitIdle } from '../harness';

/**
 * A point of the cabin (part frame): relative to the commander's eye in the seat's axes (right, head-up,
 * forward), on a window's axis `out` metres outside its centre, `out` metres from a window's centre square
 * to the capsule's long axis (the horizon when the capsule stands upright), the centre of a display, on the
 * line from a cabin point out through a window's centre (`out` metres beyond it: the way the sun comes in,
 * reversed; the window id 'sun' is the window the lab let the sun in through), or given directly.
 */
export type PointSpec = { seat: [number, number, number] } | { window: string; out: number } | { horizon: string; out: number; drop?: number } | { display: number } | { through: string; from: PointSpec; out: number } | { p: [number, number, number] };

export interface Recipe {
  /**
   * Sun: onto a cabin point through the window the lab finds (the one through which the sun then stands
   * highest) or through a named window, a direction in the vessel frame, behind the body (night), or the
   * scene's own.
   */
  sun?: { onto: PointSpec; through?: string } | { ves: [number, number, number] } | 'eclipse';
  lights?: boolean;
  /** Camera: the seat's own view turned by yaw / pitch, or a free camera. */
  seat?: { yaw: number; pitch: number };
  free?: { kind: 'interior' | 'external'; eye: PointSpec; look: PointSpec; up?: 'seat' | 'nose' };
  /**
   * The view aimed at the window through which the body below shows most (the lab picks it), the eye moved
   * this share of the way from the seat to the window (0 = in the seat; leaning to the window the Earth
   * fills more of the frame and the renderer's interior metering weighs it, request cockpit-7).
   */
  windowBelow?: number;
  fovDeg: number;
}

export interface Placed {
  ok: boolean;
  why: string;
  layout: string | null;
}

/** Runs in the page: place the sun, the lights and the camera of one view. Returns what it found. */
export async function applyRecipe(page: Page, recipe: Recipe): Promise<Placed> {
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
    // The window the lab let the sun in through ('sun' as a window id below).
    let sunWindow: string | null = null;
    const point = (p: unknown): V => {
      const q = p as { seat?: number[]; window?: string; horizon?: string; out?: number; drop?: number; display?: number; p?: number[]; through?: string; from?: unknown };
      if (q.horizon) {
        const w = model.windows.find((x) => x.id === q.horizon)!;
        return add(add(w.centre, scale(norm({ x: -w.inward.x, y: 0, z: -w.inward.z }), q.out ?? 0)), { x: 0, y: -(q.drop ?? 0), z: 0 });
      }
      if (q.through) {
        const w = model.windows.find((x) => x.id === (q.through === 'sun' ? sunWindow : q.through)) ?? model.windows[0]!;
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
    else if (r.sun && 'onto' in r.sun && r.sun.through) {
      // Along the line from the cabin point out through that window's centre (part frame -> vessel frame).
      const w = model.windows.find((x) => x.id === (r.sun as { through: string }).through)!;
      lab.setSunInVesselFrame(norm(qrot(part.localRot as Q, sub(w.centre, point(r.sun.onto)))));
      sunWindow = w.id;
    } else if (r.sun && 'onto' in r.sun) sunWindow = lab.sunThroughWindowOnto(point(r.sun.onto))?.window ?? null;
    // ---- lights
    if (r.lights !== undefined && r.lights !== snap.readouts.lightsOn) app.sim.commands.toggleLights();
    // ---- camera
    if (r.windowBelow !== undefined) {
      if (!lab.sitAtWindowBelow(r.windowBelow)) return { ok: false, why: 'no window toward the body below', layout: vehicle.cockpit ?? null };
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
export async function settleWorld(page: Page): Promise<void> {
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

export interface WorldReport {
  loaded: string[];
  problems: string[];
  errors: string[];
  lightsOn: boolean;
  plasma: number;
  ev100: number;
  stats: { active: boolean; lod: string | null; inside: boolean; sunLit: boolean; covered?: string[] };
  /** Render-target pixel of every cabin window's centre in the last frame (null: behind the camera), by window id. */
  windows: Record<string, { x: number; y: number } | null>;
  /** Size of the render target those pixels refer to. */
  renderSize: [number, number];
}

/** What the lab loaded, the cabin's state and where the windows are on screen. */
export async function worldReport(page: Page): Promise<WorldReport> {
  return page.evaluate(() => {
    const lab = window.__integration!;
    const app = lab.app;
    const snap = app.snapshot();
    const vessel = snap.vessels.find((v) => v.id === snap.activeVesselId)!;
    const vehicle = Object.values(app.defs.vehicles).find((d) => d.cockpit && vessel.parts.some((p) => p.instanceId === d.cameras.cockpit.part));
    const part = vessel.parts.find((p) => p.instanceId === vehicle?.cameras.cockpit.part);
    type V = { x: number; y: number; z: number };
    type Q = { x: number; y: number; z: number; w: number };
    type Model = { windows: { id: string; centre: V }[] };
    const f = (lab.handles['cockpit.createCockpitFeature'] as { feature?: { stats(): { active: boolean; lod: string | null; inside: boolean; sunLit: boolean; covered?: string[] }; model(id: string): Model | undefined } } | undefined)?.feature;
    const windows: Record<string, { x: number; y: number } | null> = {};
    const fc = app.renderer.frameContext;
    const model = vehicle?.cockpit ? f?.model(vehicle.cockpit) : undefined;
    if (fc && model && part) {
      const qrot = (q: Q, v: V): V => {
        const tx = 2 * (q.y * v.z - q.z * v.y);
        const ty = 2 * (q.z * v.x - q.x * v.z);
        const tz = 2 * (q.x * v.y - q.y * v.x);
        return { x: v.x + q.w * tx + q.y * tz - q.z * ty, y: v.y + q.w * ty + q.z * tx - q.x * tz, z: v.z + q.w * tz + q.x * ty - q.y * tx };
      };
      const cam = app.cameraState().positionRoot as V;
      const view = fc.view as ArrayLike<number>;
      const proj = fc.projUnjittered as ArrayLike<number>;
      const mul = (m: ArrayLike<number>, v: number[]): number[] => [0, 1, 2, 3].map((r) => m[r]! * v[0]! + m[4 + r]! * v[1]! + m[8 + r]! * v[2]! + m[12 + r]! * v[3]!);
      for (const w of model.windows) {
        const a = qrot(part.localRot as Q, w.centre);
        const b = qrot(vessel.q as Q, { x: a.x + part.localPos.x, y: a.y + part.localPos.y, z: a.z + part.localPos.z });
        const rel = [b.x + vessel.rRoot.x - cam.x, b.y + vessel.rRoot.y - cam.y, b.z + vessel.rRoot.z - cam.z, 1];
        const c = mul(proj, mul(view, rel));
        windows[w.id] = c[3]! > 0 ? { x: (0.5 + (0.5 * c[0]!) / c[3]!) * fc.renderSize[0]!, y: (0.5 - (0.5 * c[1]!) / c[3]!) * fc.renderSize[1]! } : null;
      }
    }
    return {
      loaded: [...lab.loaded],
      problems: lab.problems.filter((p) => p.startsWith('cockpit')),
      errors: window.__test!.errors.filter((e) => /cockpit/i.test(e)),
      lightsOn: snap.readouts.lightsOn,
      plasma: vessel.aero.plasmaIntensity,
      ev100: window.__lab!.renderer.exposureInfo().ev100,
      stats: f?.stats() ?? { active: false, lod: null, inside: false, sunLit: false },
      windows,
      renderSize: fc ? [fc.renderSize[0]!, fc.renderSize[1]!] : [1, 1],
    };
  });
}

/** What a picture must show, measured on the saved PNG (world.spec.ts). */
export interface WorldChecks {
  /** The frame may be dark (a lower floor for the share of non-black pixels). */
  dark?: boolean;
  /** At most this share of the pixels exactly black. */
  maxBlack?: number;
  /** These windows' panes (a patch round their centre) are brighter than the frame's median: something glows or shines outside. */
  litPanes?: string[];
  /** The patch round this window's centre is neutral: blue / red of its median within 10 % of 1. */
  neutralPane?: string;
  /** What this window shows keeps its colour: the patch round its centre is not burnt out (median under 245). */
  unclippedPane?: string;
}

export interface WorldView {
  name: string;
  query: string;
  recipe: Recipe;
  checks: WorldChecks;
}

export const WORLD_VIEWS: WorldView[] = [
  // On the pad at noon, the whole stack under the capsule, looking up through the commander's forward window
  // (the one the boost cover has a port over; the others are covered): the head lifted off the head rest,
  // 45 cm from the pane, the window and its frame in view, the sky, a cloud and the escape tower's rigging
  // through it. (The open sky is not lit geometry: the interior meter cannot weigh it, so it stays bright.)
  {
    name: 'world-pad-noon-forward-window',
    query: 'scene=pad',
    recipe: { sun: { ves: [0.08, 0.9, 0.43] }, lights: true, free: { kind: 'interior', eye: { through: 'fwd-left', from: { seat: [0, 0, 0] }, out: -0.45 }, look: { through: 'fwd-left', from: { seat: [0, 0, 0] }, out: 20 } }, fovDeg: 70 },
    checks: { litPanes: ['fwd-left'] },
  },
  // Low orbit, windows toward the Earth: the head three quarters of the way to the window, the window and
  // its frame in view with the Earth filling it (four tenths of the frame and more: the interior meter exposes
  // for what is outside, cockpit-7, and the frame reads by the Earth's light on its inner edge); the sun
  // through another window on the console.
  { name: 'world-leo-earth-side-window', query: 'scene=lowOrbit&roll=180', recipe: { sun: { onto: { display: 0 } }, windowBelow: 0.82, fovDeg: 60 }, checks: { maxBlack: 0.3 } },
  { name: 'world-leo-sun-patch-console', query: 'scene=lowOrbit&roll=180', recipe: { sun: { onto: { display: 0 }, through: 'side-right' }, seat: { yaw: 8, pitch: 2 }, fovDeg: 70 }, checks: {} },
  // The night side: the sun behind the Earth, nothing toggled: the cabin under its floods at their standby
  // level and its displays (what a player sees who has touched nothing).
  { name: 'world-night-displays-floods', query: 'scene=lowOrbit&roll=180', recipe: { sun: 'eclipse', seat: { yaw: 20, pitch: -2 }, fovDeg: 70 }, checks: { dark: true, maxBlack: 0.25 } },
  // The climb with the engines at full thrust: the plume's lights stay outside the hull, the pages read
  // (request app-integration-5).
  { name: 'world-ascent-plume-displays', query: 'scene=ascent&throttle=1', recipe: { seat: { yaw: 22, pitch: -2 }, fovDeg: 70 }, checks: {} },
  // Entry: the shock layer outside the windows, the floods on.
  { name: 'world-reentry-plasma', query: 'scene=reentry', recipe: { lights: true, seat: { yaw: 16, pitch: 40 }, fovDeg: 70 }, checks: { dark: true, litPanes: ['fwd-left', 'fwd-right'] } },
  // On the lunar surface, the sun 30 degrees up and off to the side of the window's axis, the floods on:
  // the head 38 cm from the side window, looking 10 degrees above the horizon (the window's axis points 32
  // degrees up: further down the well's own walls fill it), the capsule upright (head-up along its nose): the
  // sunlit ground blown out below black sky and the cabin readable under its floods, as in the LM photograph
  // AS11-36-5390.
  {
    name: 'world-moon-horizon',
    query: 'scene=lunarSurface',
    recipe: { sun: { ves: [-0.5, 0.5, 0.7] }, lights: true, free: { kind: 'interior', eye: { through: 'side-left', from: { seat: [0, 0, 0] }, out: -0.38 }, look: { horizon: 'side-left', out: 10, drop: -1.8 }, up: 'nose' }, fovDeg: 62 },
    checks: { dark: true, maxBlack: 0.3 },
  },
  // From outside: looking in through a forward window by day (the sun's way in) and on the night side.
  { name: 'world-chase-window-sun', query: 'scene=lowOrbit&roll=180', recipe: { sun: { onto: { display: 0 }, through: 'side-right' }, free: { kind: 'external', eye: { through: 'sun', from: { display: 0 }, out: 0.9 }, look: { display: 0 } }, fovDeg: 40 }, checks: {} },
  { name: 'world-chase-window-night', query: 'scene=lowOrbit&roll=180', recipe: { sun: 'eclipse', lights: true, free: { kind: 'external', eye: { through: 'fwd-left', from: { seat: [0.1, -0.1, 0.3] }, out: 1.0 }, look: { seat: [0.1, -0.1, 0.3] } }, fovDeg: 50 }, checks: { dark: true } },
];
