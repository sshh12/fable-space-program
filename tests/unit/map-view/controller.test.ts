/**
 * MapController behaviour against FakeSim and synthetic snapshots (no GPU, no DOM): hit-testing, node
 * creation on the right revolution, handle drags with modifiers and the end-stop ramp, node sliding,
 * pointer consumption, focus requests, multi-revolution node placement, surface targets and occlusion.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { PointerState } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraState } from '@/core/contracts/render';
import type { Sim, SimSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { conicPosition, conicTrueAnomaly } from '@/core/math/conic';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { dragDelta, MapController, modifierFactor } from '@/map/controller';
import { occlusionWeight } from '@/map/occlusion';
import { lookAtCamera } from '@/map/testing/camera';
import { trueAnomalyAt } from '@/map/testing/kepler';
import { createSyntheticFixture } from '@/map/testing/syntheticSnapshots';

const CSS: [number, number] = [1280, 720];
let defs: DefLibrary;

const pointer = (p: Partial<PointerState> = {}): PointerState => ({
  x: 0,
  y: 0,
  dx: 0,
  dy: 0,
  buttons: 0,
  pressed: false,
  released: false,
  doubleClick: false,
  wheel: 0,
  shift: false,
  ctrl: false,
  alt: false,
  overUi: false,
  ...p,
});

interface Rig {
  sim: Sim;
  snap: SimSnapshot;
  camera: CameraState;
  map: MapController;
  clock: { t: number };
  /** One app frame: map.update with the on-screen snapshot, then a fresh snapshot (sim time frozen). */
  frame(p: PointerState): ReturnType<MapController['update']>;
}

function rig(scene: 'lowOrbit' | 'translunar' | 'lunarOrbit' = 'lowOrbit', camera?: (s: SimSnapshot) => CameraState): Rig {
  const sim = createFakeSim(defs, { scene });
  const snap = sim.snapshot();
  const W = snap.patches.current[0]!.conic.W;
  const body = snap.bodies.find((b) => b.id === snap.vessels[0]!.bodyId)!;
  const cam = camera ? camera(snap) : lookAtCamera(v3.add(body.rRoot, v3.scale(W, 3e7)), body.rRoot, (50 * Math.PI) / 180, v3.normalize(snap.vessels[0]!.r));
  const clock = { t: 1000 };
  const map = new MapController(defs, { now: () => clock.t });
  map.setActive(true);
  const r: Rig = {
    sim,
    snap,
    camera: cam,
    map,
    clock,
    frame(p) {
      const res = map.update(r.snap, r.camera, sim.commands, p, CSS);
      r.snap = sim.snapshot();
      map.frame(r.snap, r.camera, CSS);
      return res;
    },
  };
  map.frame(snap, cam, CSS);
  return r;
}

const el = (m: MapController, kind: string, id: string) => {
  const e = m.describe().find((x) => x.kind === kind && x.id === id);
  if (!e) throw new Error(`no ${kind} ${id} in describe()`);
  return e;
};

/** Click on the current orbit at a fraction of its sampled vertices; returns the clicked view-space point. */
function clickOrbit(r: Rig, fraction: number): { x: number; y: number } {
  const scene = r.map.currentScene!;
  const line = scene.lines.find((l) => l.id === 'current/0')!;
  const i = line.start + Math.floor(line.count * fraction);
  const x = scene.verts.sx[i]!;
  const y = scene.verts.sy[i]!;
  r.frame(pointer({ x, y, pressed: true, released: true, buttons: 0 }));
  return { x, y };
}

beforeEach(async () => {
  defs ??= await loadDefs(fsDefSource());
});

describe('adding nodes', () => {
  it('a click on the orbit adds a node at the time the vessel passes that point, on the next revolution', () => {
    const r = rig();
    const c = r.snap.patches.current[0]!.conic;
    for (const fraction of [0.2, 0.55, 0.9]) {
      const before = r.snap.nodes.length;
      const at = clickOrbit(r, fraction);
      expect(r.snap.nodes.length).toBe(before + 1);
      const node = r.snap.nodes.find((n) => n.id === r.map.selectedNodeId)!;
      expect(node.ut).toBeGreaterThan(r.snap.ut);
      expect(node.ut).toBeLessThan(r.snap.ut + c.period!);
      // Independent check: where is the vessel at node.ut (Kepler), and does it project onto the click?
      const nu = trueAnomalyAt(c, node.ut);
      const p = r.map.currentScene!.proj.projectRoot(conicPosition(c, nu));
      expect(Math.hypot(p.x - at.x, p.y - at.y)).toBeLessThan(0.5);
    }
  });

  it('a press that turns into a drag does not add a node (it was a camera drag)', () => {
    const r = rig();
    const scene = r.map.currentScene!;
    const line = scene.lines.find((l) => l.id === 'current/0')!;
    const i = line.start + 10;
    const x = scene.verts.sx[i]!;
    const y = scene.verts.sy[i]!;
    expect(r.frame(pointer({ x, y, pressed: true, buttons: 1 })).consumed).toBe(false);
    r.frame(pointer({ x: x + 30, y, dx: 30, buttons: 1 }));
    r.frame(pointer({ x: x + 30, y, released: true }));
    expect(r.snap.nodes).toHaveLength(0);
  });
});

describe('hit-testing', () => {
  it('picks the nearest element within 10 px of its drawn edge', () => {
    const r = rig();
    clickOrbit(r, 0.3);
    const scene = r.map.currentScene!;
    const node = scene.nodes[0]!;
    const handles = r.map.handleLayout(node, scene);
    const pro = handles.find((h) => h.name === 'prograde')!;
    expect(r.map.hitTest(scene, pro.x, pro.y, true)?.type).toBe('handle');
    expect(r.map.hitTest(scene, node.x, node.y, true)?.type).toBe('node');
    // 3 px off the node centre along its orbit: the node, not the line under it
    expect(r.map.hitTest(scene, node.x + 3, node.y, true)?.type).toBe('node');
    // Between node and handle: whichever drawn edge is nearer (8 px node radius, 9 px handle radius)
    const sep = Math.hypot(pro.x - node.x, pro.y - node.y);
    const along = (d: number) => r.map.hitTest(scene, node.x + ((pro.x - node.x) * d) / sep, node.y + ((pro.y - node.y) * d) / sep, false, false);
    expect(sep).toBeGreaterThan(40);
    expect(along(8 + 6)?.type).toBe('node');
    expect(along(sep - 9 - 6)?.type).toBe('handle');
    expect(along(sep / 2 + 0.5 * (8 - 9))).toBeNull(); // equidistant from both edges and more than 10 px from each
    // The vessel icon: inside the tolerance at 9.9 px from its edge, outside at 10.1 px (handles deselected)
    r.map.selectNode(null);
    const v = scene.vessels[0]!;
    const out = v3.normalize({ x: v.x - 640, y: v.y - 360, z: 0 });
    const at = (d: number) => r.map.hitTest(scene, v.x + out.x * (7 + d), v.y + out.y * (7 + d), false, false);
    expect(at(9.9)?.type).toBe('vessel');
    expect(at(10.1)).toBeNull();
  });
});

describe('handle drags', () => {
  it('maps pixels to delta-v: 1 m/s per 10 px, Shift x0.1, Ctrl x10', () => {
    expect(dragDelta(100, 0, 1, 0, 1, modifierFactor({ shift: false, ctrl: false }))).toBeCloseTo(10, 12);
    expect(dragDelta(60, 80, 0.6, 0.8, 1, 1)).toBeCloseTo(10, 12);
    expect(dragDelta(100, 0, 1, 0, -1, 1)).toBeCloseTo(-10, 12);
    expect(dragDelta(0, 100, 1, 0, 1, 1)).toBeCloseTo(0, 12); // perpendicular motion does nothing
    expect(modifierFactor({ shift: true, ctrl: false })).toBe(0.1);
    expect(modifierFactor({ shift: false, ctrl: true })).toBe(10);
  });

  const drag = (r: Rig, name: string, px: number, mods: Partial<PointerState> = {}, steps = 10): void => {
    const scene = r.map.currentScene!;
    const node = scene.nodes.find((n) => n.id === r.map.selectedNodeId)!;
    const h = r.map.handleLayout(node, scene).find((x) => x.name === name)!;
    let x = h.x;
    let y = h.y;
    r.frame(pointer({ x, y, pressed: true, buttons: 1, ...mods }));
    for (let i = 0; i < steps; i++) {
      const dx = (h.dx * px) / steps;
      const dy = (h.dy * px) / steps;
      x += dx;
      y += dy;
      r.clock.t += 16;
      r.frame(pointer({ x, y, dx, dy, buttons: 1, ...mods }));
    }
    r.frame(pointer({ x, y, released: true, ...mods }));
  };

  it('dragging the prograde handle 100 px adds 10 m/s; Shift is ten times finer, Ctrl ten times coarser', () => {
    const r = rig();
    clickOrbit(r, 0.3);
    const id = r.map.selectedNodeId!;
    drag(r, 'prograde', 100);
    expect(r.snap.nodes.find((n) => n.id === id)!.dv.prograde).toBeCloseTo(10, 9);
    drag(r, 'prograde', 100, { shift: true });
    expect(r.snap.nodes.find((n) => n.id === id)!.dv.prograde).toBeCloseTo(11, 9);
    drag(r, 'retrograde', 100, { ctrl: true });
    expect(r.snap.nodes.find((n) => n.id === id)!.dv.prograde).toBeCloseTo(-89, 9);
    drag(r, 'normal', 50);
    drag(r, 'radialIn', 30);
    const dv = r.snap.nodes.find((n) => n.id === id)!.dv;
    expect(dv.normal).toBeCloseTo(5, 9);
    expect(dv.radial).toBeCloseTo(-3, 9);
  });

  it('holding a handle past its end stop ramps the rate up', () => {
    const r = rig();
    clickOrbit(r, 0.3);
    const id = r.map.selectedNodeId!;
    const scene = r.map.currentScene!;
    const node = scene.nodes[0]!;
    const h = r.map.handleLayout(node, scene).find((x) => x.name === 'prograde')!;
    r.frame(pointer({ x: h.x, y: h.y, pressed: true, buttons: 1 }));
    r.frame(pointer({ x: h.x + h.dx * 150, y: h.y + h.dy * 150, dx: h.dx * 150, dy: h.dy * 150, buttons: 1 }));
    const atStop = r.snap.nodes.find((n) => n.id === id)!.dv.prograde;
    expect(atStop).toBeCloseTo(15, 9);
    const values: number[] = [];
    for (let i = 0; i < 120; i++) {
      r.clock.t += 1000 / 60;
      r.frame(pointer({ x: h.x + h.dx * 150, y: h.y + h.dy * 150, buttons: 1 }));
      values.push(r.snap.nodes.find((n) => n.id === id)!.dv.prograde);
    }
    // monotonic, faster later than earlier (ramp), at least the start rate of 2 m/s per second
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    const early = values[30]! - values[0]!;
    const late = values[119]! - values[89]!;
    expect(late).toBeGreaterThan(early * 1.5);
    expect(values[119]! - atStop).toBeGreaterThan(4);
    r.frame(pointer({ x: h.x + h.dx * 150, y: h.y + h.dy * 150, released: true }));
  });

  it('the wheel over a handle nudges by 0.1 m/s', () => {
    const r = rig();
    clickOrbit(r, 0.3);
    const id = r.map.selectedNodeId!;
    const scene = r.map.currentScene!;
    const h = r.map.handleLayout(scene.nodes[0]!, scene).find((x) => x.name === 'normal')!;
    expect(r.frame(pointer({ x: h.x, y: h.y, wheel: 1 })).consumed).toBe(true);
    r.frame(pointer({ x: h.x, y: h.y, wheel: 1 }));
    r.frame(pointer({ x: h.x, y: h.y, wheel: -1, shift: true }));
    expect(r.snap.nodes.find((n) => n.id === id)!.dv.normal).toBeCloseTo(0.19, 9);
  });

  it('consumed stays true for the whole drag, even off the handle, and returns to false after release', () => {
    const r = rig();
    clickOrbit(r, 0.3);
    const scene = r.map.currentScene!;
    const h = r.map.handleLayout(scene.nodes[0]!, scene).find((x) => x.name === 'radialOut')!;
    expect(r.frame(pointer({ x: h.x, y: h.y, pressed: true, buttons: 1 })).consumed).toBe(true);
    const far = { x: 40, y: 700 };
    for (let i = 0; i < 5; i++) expect(r.frame(pointer({ ...far, dx: i === 0 ? far.x - h.x : 0, dy: i === 0 ? far.y - h.y : 0, buttons: 1 })).consumed).toBe(true);
    expect(r.frame(pointer({ ...far, released: true })).consumed).toBe(true);
    expect(r.frame(pointer({ ...far })).consumed).toBe(false);
    // hovering a handle consumes, hovering empty space does not
    expect(r.frame(pointer({ x: h.x, y: h.y })).consumed).toBe(true);
  });
});

describe('sliding a node along its orbit', () => {
  it('moves the node forward in time monotonically as the pointer follows the orbit', () => {
    const r = rig();
    clickOrbit(r, 0.2);
    const id = r.map.selectedNodeId!;
    const scene = r.map.currentScene!;
    const line = scene.lines.find((l) => l.id === 'current/0')!;
    const node = scene.nodes[0]!;
    // vertices of the orbit after the node, in order of motion
    let k = line.start;
    let best = Infinity;
    for (let i = line.start; i < line.start + line.count; i++) {
      const d = Math.hypot(scene.verts.sx[i]! - node.x, scene.verts.sy[i]! - node.y);
      if (d < best) {
        best = d;
        k = i;
      }
    }
    r.frame(pointer({ x: node.x, y: node.y, pressed: true, buttons: 1 }));
    const uts: number[] = [];
    for (let s = 1; s <= 12; s++) {
      const j = Math.min(line.start + line.count - 1, k + s * 2);
      r.frame(pointer({ x: scene.verts.sx[j]! + 2, y: scene.verts.sy[j]!, buttons: 1 }));
      uts.push(r.snap.nodes.find((n) => n.id === id)!.ut);
    }
    r.frame(pointer({ x: scene.verts.sx[k + 24]!, y: scene.verts.sy[k + 24]!, released: true }));
    for (let i = 1; i < uts.length; i++) expect(uts[i]!).toBeGreaterThan(uts[i - 1]!);
  });
});

describe('focus requests', () => {
  it('a double click yields exactly one focus request', () => {
    const r = rig();
    const earth = el(r.map, 'body', r.snap.vessels[0]!.bodyId);
    const at = { x: earth.x, y: earth.y };
    const results = [
      r.frame(pointer({ ...at, pressed: true, released: true })),
      r.frame(pointer({ ...at })),
      r.frame(pointer({ ...at, pressed: true, released: true, doubleClick: true })),
      r.frame(pointer({ ...at })),
      r.frame(pointer({ ...at })),
    ];
    const focus = results.filter((x) => x.focus);
    expect(focus).toHaveLength(1);
    expect(focus[0]!.focus).toEqual({ bodyId: r.snap.vessels[0]!.bodyId });
    const v = el(r.map, 'vessel', r.snap.vessels[0]!.id);
    expect(r.frame(pointer({ x: v.x, y: v.y, doubleClick: true })).focus).toEqual({ vesselId: r.snap.vessels[0]!.id });
  });

  it('a click on another body sets it as target; on the body being orbited it clears the target', () => {
    const r = rig('translunar', (s) => {
      const moon = s.bodies.find((b) => b.id !== s.vessels[0]!.bodyId && b.soiRadius !== null)!;
      return lookAtCamera(v3.add(moon.rRoot, { x: 0, y: 0, z: 2e8 }), moon.rRoot);
    });
    const moonId = r.snap.bodies.find((b) => b.soiRadius !== null)!.id;
    const moon = el(r.map, 'body', moonId);
    r.frame(pointer({ x: moon.x, y: moon.y, pressed: true, released: true }));
    expect(r.snap.readouts.targetBodyId).toBe(moonId);
  });
});

describe('multi-revolution patches', () => {
  it('draws the 2.5-revolution patch as one ellipse with the node at nuEnd modulo 2 pi', () => {
    const fx = createSyntheticFixture(defs);
    const s = fx.snapshot;
    const map = new MapController(defs);
    map.setActive(true);
    const cam = lookAtCamera({ x: 2e8, y: -3e8, z: 9e8 }, { x: 1e8, y: 0, z: 0 });
    map.frame(s, cam, CSS);
    const scene = map.currentScene!;
    const orbit = s.patches.planned[1]!;
    const line = scene.lines.find((l) => l.id === 'planned/1')!;
    const nu0 = line.curve.uToNu(scene.verts.u[line.start]!);
    const nu1 = line.curve.uToNu(scene.verts.u[line.start + line.count - 1]!);
    expect(nu1 - nu0).toBeCloseTo(2 * Math.PI, 9);
    const nodeB = scene.nodes.find((n) => n.id === fx.nodeB.id)!;
    const expected = scene.proj.projectRoot(v3.add(orbit.bodyPosAtEnd, conicPosition(orbit.conic, orbit.nuEnd % (2 * Math.PI))));
    expect(Math.hypot(nodeB.x - expected.x, nodeB.y - expected.y)).toBeLessThan(1e-6);
    expect(nodeB.loc.key).toEqual({ list: 'planned', index: 1 });
    // ... and the node frame is the pre-burn one of that conic
    const nu = conicTrueAnomaly(orbit.conic, nodeB.loc.rBody);
    expect(Math.abs(Math.cos(nu) - Math.cos(orbit.nuEnd))).toBeLessThan(1e-9);
    expect(nodeB.loc.approximateFrame).toBe(false);
  });

  it('at intercept, the encounter is drawn around the body where it was at the SOI entry: the chain is continuous', () => {
    const fx = createSyntheticFixture(defs);
    const s = fx.snapshot;
    const map = new MapController(defs);
    map.setActive(true);
    const cam = lookAtCamera({ x: 2e8, y: -3e8, z: 9e8 }, { x: 1e8, y: 0, z: 0 });
    const ends = () => {
      const scene = map.currentScene!;
      const dep = scene.lines.find((l) => l.id === 'current/0')!;
      const enc = scene.lines.find((l) => l.id === 'current/1')!;
      const v = scene.verts;
      const i = dep.start + dep.count - 1;
      return { gap: Math.hypot(v.sx[i]! - v.sx[enc.start]!, v.sy[i]! - v.sy[enc.start]!), scene };
    };
    map.frame(s, cam, CSS);
    expect(ends().gap).toBeGreaterThan(5); // current-position drawing: the Moon has moved on since the encounter
    map.setDrawAtIntercept(true);
    map.frame(s, cam, CSS);
    const { gap, scene } = ends();
    expect(gap).toBeLessThan(1e-6);
    // The ghost is the Moon's true position at the SOI entry (fixture ephemeris).
    const anchor = scene.ghostAnchors.get(fx.moonId)!;
    expect(v3.dist(anchor, fx.bodyPosition(fx.moonId, s.patches.current[1]!.tStart))).toBeLessThan(1);
    expect(scene.bodies.some((b) => b.id === `${fx.moonId}@intercept`)).toBe(true);
    // Node A (on the encounter patch) and the planned flyby after it share that anchor.
    const nodeA = scene.nodes.find((n) => n.id === fx.nodeA.id)!;
    const flyby = scene.lines.find((l) => l.id === 'planned/0')!;
    expect(Math.hypot(nodeA.x - scene.verts.sx[flyby.start]!, nodeA.y - scene.verts.sy[flyby.start]!)).toBeLessThan(1e-6);
  });

  it('+1 orbit moves a node one period later and delete removes it (panel actions)', () => {
    const r = rig();
    clickOrbit(r, 0.4);
    r.map.frame(r.snap, r.camera, CSS);
    const id = r.map.selectedNodeId!;
    const ut0 = r.snap.nodes[0]!.ut;
    const period = r.snap.patches.current[0]!.conic.period!;
    expect(r.map.panelAction('plusOrbit')).toBe(true);
    r.snap = r.sim.snapshot();
    r.map.frame(r.snap, r.camera, CSS);
    expect(r.snap.nodes[0]!.ut).toBeCloseTo(ut0 + period, 6);
    // the node is still drawn on the orbit (placed from the sim's maneuverNode marker)
    expect(r.map.currentScene!.nodes.map((n) => n.id)).toEqual([id]);
    expect(r.map.panelSetValue('prograde', 25)).toBe(true);
    r.snap = r.sim.snapshot();
    expect(r.snap.nodes[0]!.dv.prograde).toBe(25);
    r.map.frame(r.snap, r.camera, CSS);
    expect(r.map.panelAction('minusOrbit')).toBe(true);
    r.snap = r.sim.snapshot();
    expect(r.snap.nodes[0]!.ut).toBeCloseTo(ut0, 6);
    r.map.frame(r.snap, r.camera, CSS);
    expect(r.map.panelState()!.canMinusOrbit).toBe(false);
    expect(r.map.panelAction('delete')).toBe(true);
    r.snap = r.sim.snapshot();
    expect(r.snap.nodes).toHaveLength(0);
  });
});

describe('surface targets and occlusion', () => {
  it('project to the right pixel on the rotating body and hide on the far side', () => {
    const sim = createFakeSim(defs, { scene: 'lowOrbit' });
    const s = sim.snapshot();
    const site = s.surfaceTargets.find((t) => t.kind === 'site')!;
    const body = s.bodies.find((b) => b.id === site.bodyId)!;
    const R = defs.bodies[site.bodyId]!.radius;
    const dir = quat.rotate(body.qFixedToRoot, latLonToDir(site.latitude, site.longitude));
    const map = new MapController(defs);
    map.setActive(true);
    // Above the site: it is at the screen centre and visible.
    map.frame(s, lookAtCamera(v3.add(body.rRoot, v3.scale(dir, R + 2e7)), body.rRoot), CSS);
    const above = map.describe().find((e) => e.kind === 'surfaceTarget' && e.id === site.id)!;
    expect(above.x).toBeCloseTo(640, 6);
    expect(above.y).toBeCloseTo(360, 6);
    expect(above.visible).toBe(true);
    // An oblique view: matches an independent projection of the body-fixed point.
    const cam = lookAtCamera(v3.add(body.rRoot, v3.scale(v3.normalize(v3.add(dir, { x: 0.3, y: -0.2, z: 0.4 })), 3e7)), body.rRoot);
    map.frame(s, cam, CSS);
    const p = map.currentScene!.proj.projectRoot(v3.add(body.rRoot, v3.scale(dir, R)));
    const oblique = map.describe().find((e) => e.kind === 'surfaceTarget' && e.id === site.id)!;
    expect(Math.hypot(oblique.x - p.x, oblique.y - p.y)).toBeLessThan(1e-9);
    // From the antipode: hidden behind the body.
    map.frame(s, lookAtCamera(v3.sub(body.rRoot, v3.scale(dir, R + 2e7)), body.rRoot), CSS);
    const behind = map.describe().find((e) => e.kind === 'surfaceTarget' && e.id === site.id)!;
    expect(behind.visible).toBe(false);
    expect(map.currentScene!.targets.find((t) => t.id === site.id)!.hidden).toBe(1);
    // Recovery zones are drawn as circles of their radius on the sphere.
    const zone = map.currentScene!.lines.find((l) => l.kind === 'recoveryZone')!;
    expect(zone.count).toBeGreaterThan(8);
  });

  it('markers behind the planet are faded out with a soft limb', () => {
    // Camera in the orbit plane on the vessel's side: apoapsis (opposite the vessel) is behind the Earth.
    const r = rig('lowOrbit', (s) => {
      const v = s.vessels[0]!;
      return lookAtCamera(v3.scale(v3.normalize(v.r), 4e7), v3.zero(), 0.8, s.patches.current[0]!.conic.W);
    });
    const scene = r.map.currentScene!;
    const ap = scene.markers.find((m) => m.kind === 'apoapsis')!;
    const pe = scene.markers.find((m) => m.kind === 'periapsis')!;
    expect(ap.hidden).toBe(1);
    expect(pe.hidden).toBe(0);
    expect(el(r.map, 'marker', ap.id).visible).toBe(false);
    expect(el(r.map, 'marker', pe.id).visible).toBe(true);
    // the soft ramp: points just inside the limb are partially hidden
    const occ = scene.occluders[0]!;
    const L = Math.hypot(occ.x, occ.y, occ.z);
    const alpha = Math.asin(occ.radius / L);
    const centreDir = v3.normalize(occ);
    const side = v3.normalize(v3.cross(centreDir, { x: 0, y: 1, z: 0 }));
    const behindAt = (pxInside: number) => {
      const a = alpha - pxInside / scene.proj.focal;
      const dir = v3.add(v3.scale(centreDir, Math.cos(a)), v3.scale(side, Math.sin(a)));
      return occlusionWeight(v3.scale(dir, L * 1.5), scene.occluders, scene.proj.focal, 6);
    };
    expect(behindAt(-1)).toBe(0); // outside the limb
    expect(behindAt(3)).toBeCloseTo(0.5, 6); // half-way through the 6 px fade
    expect(behindAt(1)).toBeGreaterThan(0);
    expect(behindAt(1)).toBeLessThan(0.5);
    expect(behindAt(7)).toBe(1);
  });
});
