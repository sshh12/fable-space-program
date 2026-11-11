/**
 * Round-3 visual close-out (the round-2 critics' lists were not produced; the work list is the package owner's
 * own review of the round-2 pictures, docs/handoff/map-view.md "Visual close-out, round 3"): the map's
 * interface follows the flight HUD's unit at every resolution (labels, icons, gizmo, panel, drags), nothing
 * is anchored under a HUD panel, debris orbits a few pixels across are left out also when drawn in bulk, and
 * lengths are written in the HUD's units.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PointerState } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraState } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { v3 } from '@/core/math/vec3';
import { ORBIT_MIN_SPAN_PX } from '@/map/constants';
import { MapController } from '@/map/controller';
import { ICON } from '@/map/drawList';
import { uiScale } from '@/map/projection';
import { lookAtCamera, orbitCamera } from '@/map/testing/camera';
import { createSyntheticFixture } from '@/map/testing/syntheticSnapshots';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

const pointer = (p: Partial<PointerState> = {}): PointerState => ({ x: -100, y: -100, dx: 0, dy: 0, buttons: 0, pressed: false, released: false, doubleClick: false, wheel: 0, shift: false, ctrl: false, alt: false, overUi: false, ...p });

/** A low-orbit FakeSim rig at a CSS size and device pixel ratio, with a selected node (prograde 0). */
function rig(css: [number, number], dpr: number) {
  const sim = createFakeSim(defs, { scene: 'lowOrbit' });
  let snap: SimSnapshot = sim.snapshot();
  const W = snap.patches.current[0]!.conic.W;
  const body = snap.bodies.find((b) => b.id === snap.vessels[0]!.bodyId)!;
  const camera: CameraState = lookAtCamera(v3.add(body.rRoot, v3.scale(W, 3e7)), body.rRoot, (50 * Math.PI) / 180, v3.normalize(snap.vessels[0]!.r));
  const t = { now: 1000 };
  const map = new MapController(defs, { now: () => t.now });
  map.setActive(true);
  const device: [number, number] = [css[0] * dpr, css[1] * dpr];
  const frame = (p: PointerState): void => {
    map.update(snap, camera, sim.commands, p, css);
    snap = sim.snapshot();
    map.frame(snap, camera, device);
    t.now += 16;
  };
  frame(pointer());
  const id = sim.commands.addNode(snap.ut + 1500);
  map.selectNode(id);
  frame(pointer());
  frame(pointer());
  return { sim, map, frame, id, get snap() { return snap; } };
}

describe('interface scale follows the flight HUD (min(1vh, 0.5625vw) relative to 720p)', () => {
  it('uiScale: 1 at 720p, 1.5 at 1080p, 3 at 4K CSS, floored at 0.8, in steps of 1/16 (the HUD unit within 1/32)', () => {
    expect(uiScale(1280, 720)).toBe(1);
    expect(uiScale(1920, 1080)).toBe(1.5);
    expect(uiScale(3840, 2160)).toBe(3);
    expect(uiScale(2560, 1080)).toBe(1.5); // ultrawide: the height decides, as for the HUD
    expect(uiScale(1000, 700)).toBe(0.8125); // floored at 0.8 (the HUD would be 0.78), then quantised
    for (const [w, h] of [[1366, 768], [1600, 900], [2560, 1440], [1440, 900], [1280, 1024]] as const) {
      const u = uiScale(w, h);
      expect(u * 16).toBe(Math.round(u * 16));
      expect(Math.abs(u - Math.min(h, 0.5625 * w) / 720)).toBeLessThanOrEqual(1 / 32 + 1e-12);
    }
  });

  it('at 1920 x 1080 CSS px (device pixel ratio 2) the gizmo, icons and labels are 1.5 times their 720p size, describe() stays in CSS px', () => {
    const small = rig([1280, 720], 1);
    const big = rig([1920, 1080], 2);
    const s0 = small.map.currentScene!;
    const s1 = big.map.currentScene!;
    expect(s0.proj.pxScale).toBe(1);
    expect(s1.proj.pxScale).toBe(3); // device px per interface px: 2 (dpr) x 1.5 (interface)
    expect(s1.proj.cssScale).toBe(2);
    // the same camera: the node sits at the same place relative to the frame
    const n0 = s0.nodes[0]!;
    const n1 = s1.nodes[0]!;
    expect(n1.x / 3840).toBeCloseTo(n0.x / 1280, 6);
    // handle distances and radii in device px: 3x (2 x 1.5)
    const h0 = small.map.handleLayout(n0, s0);
    const h1 = big.map.handleLayout(n1, s1);
    for (let i = 0; i < h0.length; i++) {
      const d0 = Math.hypot(h0[i]!.x - n0.x, h0[i]!.y - n0.y);
      const d1 = Math.hypot(h1[i]!.x - n1.x, h1[i]!.y - n1.y);
      expect(d1 / d0).toBeCloseTo(3, 6);
    }
    // the label line height and the line widths follow
    const l0 = s0.lines.find((l) => l.id === 'current/0')!;
    const l1 = s1.lines.find((l) => l.id === 'current/0')!;
    expect(l1.width / l0.width).toBeCloseTo(3, 9);
    const list = big.map.frame(big.snap, s1.camera, [3840, 2160])!;
    const vessel = list.icons[0].find((i) => i.shape === ICON.vessel)!;
    expect(vessel.hx).toBeCloseTo(9.5 * 3, 9);
    expect(list.texts[0].length).toBeGreaterThan(0);
    // describe() in CSS px of the 1920 x 1080 canvas
    const d = big.map.describe().find((e) => e.kind === 'node')!;
    expect(d.x).toBeCloseTo(n1.x / 2, 9);
    expect(d.y).toBeCloseTo(n1.y / 2, 9);
    // the panel is laid out at the same scale (its CSS sizes times 1.5)
    expect(big.map.panelState()!.scale).toBe(1.5);
    expect(small.map.panelState()!.scale).toBe(1);
  });

  it('a handle dragged at 1080p stays under the pointer, and 100 interface px (150 CSS px) add 10 m/s', () => {
    const r = rig([1920, 1080], 1);
    const scene = r.map.currentScene!;
    const node = scene.nodes[0]!;
    const h = r.map.handleLayout(node, scene).find((x) => x.name === 'prograde')!;
    let x = h.x;
    let y = h.y;
    r.frame(pointer({ x, y, pressed: true, buttons: 1 }));
    for (let i = 0; i < 10; i++) {
      const dx = h.dx * 15;
      const dy = h.dy * 15;
      x += dx;
      y += dy;
      r.frame(pointer({ x, y, dx, dy, buttons: 1 }));
    }
    const sc = r.map.currentScene!;
    const now = r.map.handleLayout(sc.nodes[0]!, sc).find((q) => q.name === 'prograde')!;
    expect(Math.hypot(now.x - x, now.y - y)).toBeLessThan(1e-6);
    r.frame(pointer({ x, y, released: true }));
    expect(r.snap.nodes.find((n) => n.id === r.id)!.dv.prograde).toBeCloseTo(10, 9);
  });
});

describe('nothing is anchored under the HUD', () => {
  it('a vessel or surface target under a HUD panel has no icon and no label set beside the panel', () => {
    const s = createFakeSim(defs, { scene: 'lowOrbit' }).snapshot();
    const earth = s.bodies.find((b) => b.id === s.vessels[0]!.bodyId)!;
    const map = new MapController(defs);
    map.setActive(true);
    const cam = orbitCamera(earth.rRoot, 0.8, 0.6, 2.4e7);
    const name = s.vessels[0]!.name;
    let list = map.frame(s, cam, [1280, 720])!;
    const v = map.currentScene!.vessels.find((x) => x.active)!;
    expect(list.texts[0].some((t) => t.text === name)).toBe(true);
    expect(list.icons[0].some((i) => i.shape === ICON.vessel)).toBe(true);
    map.setObstacles([{ x: v.x - 30, y: v.y - 20, width: 60, height: 40 }]);
    list = map.frame(s, cam, [1280, 720])!;
    expect(list.texts[0].some((t) => t.text === name)).toBe(false);
    expect(list.icons[0].some((i) => i.shape === ICON.vessel)).toBe(false);
    // the surface targets too
    const targets = map.currentScene!.targets.filter((t) => t.front && t.hidden < 0.5 && t.x > 0 && t.x < 1280 && t.y > 0 && t.y < 720);
    expect(targets.length).toBeGreaterThan(0);
    map.setObstacles(targets.map((t) => ({ x: t.x - 12, y: t.y - 24, width: 24, height: 36 })));
    list = map.frame(s, cam, [1280, 720])!;
    for (const t of targets) expect(list.texts[0].some((x) => x.text === t.target.name), t.target.name).toBe(false);
    expect(list.icons[0].some((i) => i.shape === ICON.pad || i.shape === ICON.zone || i.shape === ICON.pin)).toBe(false);
  });
});

describe('debris orbits drawn in bulk', () => {
  it('a debris orbit under 60 px across is left out also with setDebrisOrbits(true); at the close-up they are drawn', () => {
    const fx = createSyntheticFixture(defs);
    const s = fx.snapshot;
    const earth = s.bodies.find((b) => b.id === fx.rootId)!;
    const map = new MapController(defs);
    map.setActive(true);
    map.setDebrisOrbits(true);
    map.frame(s, orbitCamera(earth.rRoot, 0.7, 0.5, 8.2e8), [1280, 720]);
    const overview = map.currentScene!.lines.filter((l) => l.kind === 'debrisOrbit');
    for (const l of overview) expect(l.span).toBeGreaterThanOrEqual(ORBIT_MIN_SPAN_PX);
    map.frame(s, orbitCamera(earth.rRoot, 0.7, 0.5, 9e7), [1280, 720]);
    expect(map.currentScene!.lines.filter((l) => l.kind === 'debrisOrbit').length).toBeGreaterThan(10);
  });
});
