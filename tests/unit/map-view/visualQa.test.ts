/**
 * Checks for the defects of the wave-2 visual QA list (out/qa/wave2/map-view.md), each against the geometry
 * and the draw list the GPU receives: lines cut in float64 where they pass behind the eye (no mirrored chord
 * after the float32 narrowing), gizmo axes kept apart, zone rings continuous to the limb, the selected node's
 * gizmo at full strength, tooltips that never sit on the selected node's panel or handles, labels off the
 * trajectories, clusters that do not hide a small planet, no SOI line from inside, map distance formats.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PointerState } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraState } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { HANDLE_DISTANCE_PX, HANDLE_RADIUS_PX } from '@/map/constants';
import { MapController } from '@/map/controller';
import { ICON, type DrawList } from '@/map/drawList';
import { formatDistance, formatTimeTo } from '@/map/format';
import { GIZMO_MIN_REACH, GIZMO_MIN_SEPARATION, layoutGizmo } from '@/map/gizmo';
import { occlusionWeight } from '@/map/occlusion';
import type { MapScene } from '@/map/scene';
import { lookAtCamera, orbitCamera } from '@/map/testing/camera';
import { createSyntheticFixture } from '@/map/testing/syntheticSnapshots';

const CSS: [number, number] = [1280, 720];
let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

const pointer = (p: Partial<PointerState> = {}): PointerState => ({ x: 0, y: 0, dx: 0, dy: 0, buttons: 0, pressed: false, released: false, doubleClick: false, wheel: 0, shift: false, ctrl: false, alt: false, overUi: false, ...p });

function controller(): MapController {
  const m = new MapController(defs);
  m.setActive(true);
  return m;
}

const f = Math.fround;

describe('lines passing behind the eye (item 1)', () => {
  /**
   * Every drawn segment, narrowed to float32 as the upload does, must have both ends in front of the near
   * plane with a wide margin, and project within a hair of the float64 position (a mirrored end would land
   * on the other side of the screen).
   */
  function checkScene(scene: MapScene): { segments: number; cut: number } {
    const v = scene.verts;
    const p = scene.proj;
    let segments = 0;
    let cut = 0;
    for (const line of scene.lines) {
      for (let i = line.start; i < line.start + line.count - 1; i++) {
        if (v.front[i] !== v.front[i + 1]) cut++;
        if (v.seg[i] !== 1) continue;
        segments++;
        for (const j of [i, i + 1]) {
          const x = f(v.vx[j]!);
          const y = f(v.vy[j]!);
          const z = f(v.vz[j]!);
          const w = f(-z);
          expect(w, `${line.id} vertex ${j}`).toBeGreaterThan(p.near);
          expect(w).toBeGreaterThan(1e-6 * Math.hypot(x, y, z));
          const sx = f(p.cx + f(f(x / w) * p.focal));
          const sy = f(p.cy - f(f(y / w) * p.focal));
          // float32 rounding: a few 1e-7 of the distance from the screen centre (a mirrored end is off by 2x that distance)
          const ref = Math.max(Math.abs(v.sx[j]! - p.cx), Math.abs(v.sy[j]! - p.cy));
          expect(Math.abs(sx - v.sx[j]!), `${line.id} x`).toBeLessThan(0.01 + 1e-5 * ref);
          expect(Math.abs(sy - v.sy[j]!), `${line.id} y`).toBeLessThan(0.01 + 1e-5 * ref);
        }
      }
    }
    return { segments, cut };
  }

  for (const scene of ['lowOrbit', 'translunar'] as const) {
    it(`${scene}: 720 camera orientations at 24,000 km, no drawn segment reaches behind the eye`, () => {
      const s = createFakeSim(defs, { scene }).snapshot();
      const earth = s.bodies.find((b) => b.id === defs.rootBodyId)!.rRoot;
      const map = controller();
      let cuts = 0;
      for (let i = 0; i < 72; i++) {
        for (let j = 0; j < 10; j++) {
          map.frame(s, orbitCamera(earth, (i / 72) * 2 * Math.PI, -1.4 + (j / 9) * 2.8, 2.4e7), CSS);
          const r = checkScene(map.currentScene!);
          expect(r.segments).toBeGreaterThan(0);
          cuts += r.cut;
        }
      }
      // The Moon's orbit surrounds the camera: lines are cut in front of the eye in every view.
      expect(cuts).toBeGreaterThan(700);
    });
  }

  it('the Moon orbit never crosses the Earth disc where it lies behind the Earth', () => {
    const s = createFakeSim(defs, { scene: 'lowOrbit' }).snapshot();
    const earth = s.bodies.find((b) => b.id === defs.rootBodyId)!.rRoot;
    const map = controller();
    for (let i = 0; i < 72; i++) {
      map.frame(s, orbitCamera(earth, (i / 72) * 2 * Math.PI, 0.35, 2.4e7), CSS);
      const scene = map.currentScene!;
      const e = scene.bodies.find((b) => b.bodyId === defs.rootBodyId)!;
      const line = scene.lines.find((l) => l.kind === 'bodyOrbit')!;
      const v = scene.verts;
      for (let k = line.start; k < line.start + line.count - 1; k++) {
        if (v.seg[k] !== 1) continue;
        // sample the drawn segment on screen and in view space; points over the disc must be in front of the Earth
        for (let t = 0; t <= 1; t += 0.125) {
          const x = v.sx[k]! + (v.sx[k + 1]! - v.sx[k]!) * t;
          const y = v.sy[k]! + (v.sy[k + 1]! - v.sy[k]!) * t;
          if (Math.hypot(x - e.x, y - e.y) > e.radiusPx - 2) continue;
          const wa = -v.vz[k]!;
          const wb = -v.vz[k + 1]!;
          const u = (t * wa) / ((1 - t) * wb + t * wa);
          const p: Vec3 = { x: v.vx[k]! + (v.vx[k + 1]! - v.vx[k]!) * u, y: v.vy[k]! + (v.vy[k + 1]! - v.vy[k]!) * u, z: v.vz[k]! + (v.vz[k + 1]! - v.vz[k]!) * u };
          expect(occlusionWeight(p, scene.occluders, scene.proj.focal, 1.5), `yaw step ${i}`).toBe(1);
        }
      }
    }
  });
});

describe('gizmo layout (item 4)', () => {
  /** Screen derivative of the projection along a unit axis at view-space point p (as scene.ts axisScreen). */
  function axisScreen(p: Vec3, a: Vec3): { dx: number; dy: number; extent: number } {
    const dist = v3.len(p);
    const along = v3.dot(a, p) / dist;
    const extent = Math.sqrt(Math.max(0, 1 - along * along));
    const depth = -p.z;
    const dxs = (a.x * depth + p.x * a.z) / (depth * depth);
    const dys = -(a.y * depth + p.y * a.z) / (depth * depth);
    const l = Math.hypot(dxs, dys);
    return l > 0 ? { dx: dxs / l, dy: dys / l, extent } : { dx: 1, dy: 0, extent: 0 };
  }
  const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
    const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(px - ax - (bx - ax) * t, py - ay - (by - ay) * t);
  };

  it('over 4000 node frames and view directions: axis lines 40 degrees apart, handles a diameter apart, none on another bar', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const unit = (): Vec3 => v3.normalize({ x: rnd(), y: rnd(), z: rnd() });
    for (let n = 0; n < 4000; n++) {
      // node frame: random orthonormal triad; node somewhere in front of the eye
      const a = unit();
      const b = v3.normalize(v3.cross(a, unit()));
      const c = v3.cross(a, b);
      // a quarter of the cases look straight down one axis (the top-down view of an orbit)
      const p: Vec3 = n % 4 === 0 ? v3.scale(c, -3e7) : { x: rnd() * 1e7, y: rnd() * 6e6, z: -2e7 - Math.abs(rnd()) * 1e7 };
      const axes = [axisScreen(p, a), axisScreen(p, b), axisScreen(p, c)] as const;
      const out = layoutGizmo(axes);
      for (let i = 0; i < 3; i++) {
        expect(out[i]!.reach).toBeGreaterThanOrEqual(GIZMO_MIN_REACH - 1e-12);
        for (let j = i + 1; j < 3; j++) {
          const cos = Math.abs(out[i]!.dx * out[j]!.dx + out[i]!.dy * out[j]!.dy);
          expect(Math.acos(Math.min(1, cos))).toBeGreaterThan(GIZMO_MIN_SEPARATION - 1e-6);
        }
      }
      // six handle centres (CSS px) and the three bars
      const H = out.flatMap((o) => [1, -1].map((s) => ({ x: s * o.dx * o.reach * HANDLE_DISTANCE_PX, y: s * o.dy * o.reach * HANDLE_DISTANCE_PX, axis: o })));
      for (let i = 0; i < 6; i++) {
        for (let j = i + 1; j < 6; j++) expect(Math.hypot(H[i]!.x - H[j]!.x, H[i]!.y - H[j]!.y)).toBeGreaterThan(2 * HANDLE_RADIUS_PX);
        for (let j = 0; j < 6; j++) {
          if (H[j]!.axis === H[i]!.axis) continue;
          expect(segDist(H[i]!.x, H[i]!.y, 0, 0, H[j]!.x, H[j]!.y)).toBeGreaterThan(HANDLE_RADIUS_PX + 1);
        }
      }
    }
  });

  it('seen from above the orbit, normal and radial handles are on different screen lines', () => {
    const sim = createFakeSim(defs, { scene: 'lowOrbit' });
    const s0 = sim.snapshot();
    const W = s0.patches.current[0]!.conic.W;
    const cam = lookAtCamera(v3.scale(W, 3e7), v3.zero(), (50 * Math.PI) / 180, v3.normalize(s0.vessels[0]!.r));
    const id = sim.commands.addNode(s0.ut + 1500);
    const s = sim.snapshot();
    const map = controller();
    map.selectNode(id);
    map.frame(s, cam, CSS);
    const all = map.describe();
    const h = (name: string) => all.find((e) => e.kind === 'nodeHandle' && e.id === `${id}/${name}`)!;
    const node = all.find((e) => e.kind === 'node' && e.id === id)!;
    const dir = (e: { x: number; y: number }) => Math.atan2(e.y - node.y, e.x - node.x);
    const lineAngle = (a: number, b: number) => {
      const d = Math.abs(a - b) % Math.PI;
      return Math.min(d, Math.PI - d);
    };
    expect(lineAngle(dir(h('normal')), dir(h('radialOut')))).toBeGreaterThan(GIZMO_MIN_SEPARATION - 1e-6);
    expect(lineAngle(dir(h('normal')), dir(h('prograde')))).toBeGreaterThan(GIZMO_MIN_SEPARATION - 1e-6);
  });
});

describe('recovery zones on the sphere (items 5 and 12)', () => {
  it('a zone 75-88 degrees from the sub-camera point is continuous on the visible side and hidden behind the limb', () => {
    const s = createFakeSim(defs, { scene: 'lowOrbit' }).snapshot();
    const zone = s.surfaceTargets.find((t) => t.kind === 'recovery')!;
    const body = s.bodies.find((b) => b.id === zone.bodyId)!;
    const R = defs.bodies[zone.bodyId]!.radius;
    const n = quat.rotate(body.qFixedToRoot, latLonToDir(zone.latitude, zone.longitude));
    const side = v3.normalize(v3.cross(n, { x: 0, y: 0, z: 1 }));
    const map = controller();
    let nearLimb = 0;
    for (const deg of [75, 80, 85, 88]) {
      const a = (deg * Math.PI) / 180;
      const eyeDir = v3.add(v3.scale(n, Math.cos(a)), v3.scale(side, Math.sin(a)));
      map.frame(s, lookAtCamera(v3.addScaled(body.rRoot, eyeDir, 2.2e7), body.rRoot), CSS);
      const scene = map.currentScene!;
      const line = scene.lines.find((l) => l.id === `zone:${zone.id}`)!;
      expect(line.occlusionSlack).toBeGreaterThan(0);
      expect(line.occlusionSlack).toBeLessThan(2e-3 * R);
      const v = scene.verts;
      const c = scene.proj.toView(body.rRoot);
      for (let k = line.start; k < line.start + line.count - 1; k++) {
        if (v.seg[k] !== 1) continue;
        for (let t = 0; t <= 1; t += 1 / 16) {
          const p: Vec3 = { x: v.vx[k]! + (v.vx[k + 1]! - v.vx[k]!) * t, y: v.vy[k]! + (v.vy[k + 1]! - v.vy[k]!) * t, z: v.vz[k]! + (v.vz[k + 1]! - v.vz[k]!) * t };
          // the true circle point under this chord point and whether it faces the eye
          const nrm = v3.normalize(v3.sub(p, c));
          const surf = v3.addScaled(c, nrm, R);
          const facing = v3.dot(nrm, v3.normalize(v3.neg(surf)));
          const w = occlusionWeight(p, scene.occluders, scene.proj.focal, 1.5, line.occlusionSlack);
          if (facing > 0.02) {
            expect(w, `${deg} deg, facing ${facing.toFixed(3)}`).toBe(0);
            if (facing < 0.2) nearLimb++;
          } else if (facing < -0.02) {
            // behind the limb: hidden once it projects more than the 1.5 px soft edge inside the silhouette (plus
            // under half a pixel for the radial slack: the sphere it is tested against is shrunk by the chord depth)
            const L = v3.len(c);
            const inside = (Math.asin(R / L) - Math.acos(v3.dot(c, p) / (L * v3.len(p)))) * scene.proj.focal;
            if (inside > 2) expect(w).toBeGreaterThan(0.99);
          }
        }
      }
    }
    expect(nearLimb).toBeGreaterThan(50);
  });

  it('zone rings are sampled to the trajectory tolerance (0.29 px), not the faint-line one', () => {
    const s = createFakeSim(defs, { scene: 'lowOrbit' }).snapshot();
    const zone = s.surfaceTargets.find((t) => t.kind === 'recovery')!;
    const body = s.bodies.find((b) => b.id === zone.bodyId)!;
    const n = quat.rotate(body.qFixedToRoot, latLonToDir(zone.latitude, zone.longitude));
    const map = controller();
    map.frame(s, lookAtCamera(v3.addScaled(body.rRoot, n, 1.2e7), body.rRoot), CSS);
    const scene = map.currentScene!;
    const line = scene.lines.find((l) => l.id === `zone:${zone.id}`)!;
    const curve = line.curve!;
    const pf = new Float64Array(4);
    const pointAt = (u: number): Vec3 => {
      curve.perifocalWithDerivative(u, pf);
      return { x: curve.ox + curve.px * pf[0]! + curve.qx * pf[1]!, y: curve.oy + curve.py * pf[0]! + curve.qy * pf[1]!, z: curve.oz + curve.pz * pf[0]! + curve.qz * pf[1]! };
    };
    const v = scene.verts;
    let worst = 0;
    for (let k = line.start; k < line.start + line.count - 1; k++) {
      for (let t = 0.125; t < 1; t += 0.125) {
        const u = v.u[k]! + (v.u[k + 1]! - v.u[k]!) * t;
        const q = scene.proj.projectView(pointAt(u));
        // distance of the exact point from the polyline near it
        let d = Infinity;
        for (let m = Math.max(line.start, k - 2); m < Math.min(line.start + line.count - 1, k + 3); m++) {
          const ax = v.sx[m]!;
          const ay = v.sy[m]!;
          const bx = v.sx[m + 1]!;
          const by = v.sy[m + 1]!;
          const tt = Math.max(0, Math.min(1, ((q.x - ax) * (bx - ax) + (q.y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
          d = Math.min(d, Math.hypot(q.x - ax - (bx - ax) * tt, q.y - ay - (by - ay) * tt));
        }
        worst = Math.max(worst, d);
      }
    }
    expect(worst).toBeLessThan(0.31);
  });
});

/** The draw list of a lowOrbit view with a selected node; optionally hover at a point (CSS px). */
function nodeRig(camera: (s: SimSnapshot, nodeRoot: Vec3) => CameraState) {
  const sim = createFakeSim(defs, { scene: 'lowOrbit' });
  const s0 = sim.snapshot();
  const id = sim.commands.addNode(s0.ut + 1500);
  sim.commands.setNode(id, { dv: { prograde: 420, normal: 60, radial: -40 } });
  const s = sim.snapshot();
  const map = controller();
  map.selectNode(id);
  const tmp = new MapController(defs);
  tmp.setActive(true);
  tmp.frame(s, orbitCamera(v3.zero(), 0, 1, 3e7), CSS);
  const node = tmp.currentScene!.nodes.find((n) => n.id === id)!;
  const cam = camera(s, node.root);
  const at = (x: number, y: number): DrawList => {
    map.update(s, cam, sim.commands, pointer({ x, y }), CSS);
    return map.frame(s, cam, CSS)!;
  };
  at(1, 1);
  return { map, id, s, cam, at, sim };
}

describe('the selected node and its gizmo (items 2 and 3)', () => {
  it('a selected node behind the limb keeps its gizmo at full strength and shows a dashed ring', () => {
    const r = nodeRig((s, root) => lookAtCamera(v3.scale(v3.normalize(root), -3e7), v3.zero()));
    const list = r.at(1, 1);
    const scene = r.map.currentScene!;
    const node = scene.nodes.find((n) => n.id === r.id)!;
    expect(node.hidden).toBe(1);
    const handles = list.icons[0].filter((i) => i.shape >= ICON.prograde && i.shape <= ICON.radialIn);
    expect(handles).toHaveLength(6);
    for (const h of handles) expect(h.alpha).toBe(1);
    const bars = list.icons[0].filter((i) => i.shape === ICON.bar && Math.hypot(i.x - node.x, i.y - node.y) < HANDLE_DISTANCE_PX);
    expect(bars.length).toBeGreaterThanOrEqual(6);
    for (const b of bars) expect(b.alpha).toBeGreaterThanOrEqual(0.8);
    const disc = list.icons[0].find((i) => i.x === node.x && i.y === node.y)!;
    expect(disc.shape).toBe(ICON.nodeHidden);
    expect(disc.alpha).toBe(1);
  });

  it('hovering the selected node or a handle shows no tooltip; other tooltips avoid the panel and the handles', () => {
    const r = nodeRig((s) => lookAtCamera(v3.scale(s.patches.current[0]!.conic.W, 3e7), v3.zero(), (50 * Math.PI) / 180, v3.normalize(s.vessels[0]!.r)));
    const scene = r.map.currentScene!;
    const node = scene.nodes.find((n) => n.id === r.id)!;
    expect(r.at(node.x, node.y).icons[1]).toHaveLength(0);
    const handle = r.map.handleLayout(node, scene)[0]!;
    expect(r.at(handle.x, handle.y).icons[1]).toHaveLength(0);
    // Hover every marker in turn: the tooltip never overlaps the panel or a handle.
    const st = r.map.panelState()!;
    const panel = { x0: st.x, y0: st.y, x1: st.x + 236, y1: st.y + 286 };
    const handles = r.map.handleLayout(node, scene);
    let tips = 0;
    for (const m of scene.markers) {
      if (!m.front || m.hidden > 0.5 || m.details.length === 0) continue;
      const list = r.at(m.x, m.y);
      const bg = list.icons[1].find((i) => i.shape === ICON.roundRect);
      if (!bg) continue;
      tips++;
      const t = { x0: bg.x - bg.hx, y0: bg.y - bg.hy, x1: bg.x + bg.hx, y1: bg.y + bg.hy };
      expect(t.x1 <= panel.x0 || t.x0 >= panel.x1 || t.y1 <= panel.y0 || t.y0 >= panel.y1, `tooltip of ${m.id} over the panel`).toBe(true);
      for (const h of handles) expect(h.x < t.x0 - 9 || h.x > t.x1 + 9 || h.y < t.y0 - 9 || h.y > t.y1 + 9, `tooltip of ${m.id} over handle ${h.name}`).toBe(true);
    }
    expect(tips).toBeGreaterThan(0);
  });
});

describe('labels, clusters, SOI (items 6, 7, 10, 18)', () => {
  const segRect = (ax: number, ay: number, bx: number, by: number, r: { x0: number; y0: number; x1: number; y1: number }): boolean => {
    // Liang-Barsky: does the segment touch the rectangle?
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dy = by - ay;
    for (const [p, q] of [
      [-dx, ax - r.x0],
      [dx, r.x1 - ax],
      [-dy, ay - r.y0],
      [dy, r.y1 - ay],
    ] as const) {
      if (p === 0) {
        if (q < 0) return false;
      } else {
        const t = q / p;
        if (p < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
        if (t0 > t1) return false;
      }
    }
    return true;
  };

  it('labels in the low-orbit and translunar views keep off the trajectories', () => {
    for (const scene of ['lowOrbit', 'translunar'] as const) {
      const sim = createFakeSim(defs, { scene });
      const s0 = sim.snapshot();
      const id = sim.commands.addNode(s0.ut + 1500);
      sim.commands.setNode(id, { dv: { prograde: 120 } });
      const s = sim.snapshot();
      const W = s.patches.current[0]!.conic.W;
      const dist = scene === 'lowOrbit' ? 3e7 : 1.25e9;
      const map = controller();
      const list = map.frame(s, lookAtCamera(v3.scale(W, dist), v3.zero(), (50 * Math.PI) / 180, v3.normalize(s.vessels[0]!.r)), CSS)!;
      const sc = map.currentScene!;
      const plates = list.icons[0].filter((i) => i.shape === ICON.plate);
      expect(plates.length).toBeGreaterThan(1);
      const v = sc.verts;
      for (const p of plates) {
        const r = { x0: p.x - p.hx + 1, y0: p.y - p.hy + 1, x1: p.x + p.hx - 1, y1: p.y + p.hy - 1 };
        for (const line of sc.lines) {
          if (line.kind !== 'current' && line.kind !== 'planned') continue;
          for (let k = line.start; k < line.start + line.count - 1; k++) {
            if (v.seg[k] !== 1) continue;
            expect(segRect(v.sx[k]!, v.sy[k]!, v.sx[k + 1]!, v.sy[k + 1]!, r), `${scene}: a label plate at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}) on ${line.id}`).toBe(false);
          }
        }
      }
    }
  });

  it('at the Earth-Moon overview the Earth is named and nothing is drawn over its disc', () => {
    const fx = createSyntheticFixture(defs);
    const s = fx.snapshot;
    const active = s.vessels.find((v) => v.id === s.activeVesselId)!;
    const moon = s.bodies.find((b) => b.id === fx.moonId)!;
    const dir = v3.normalize(v3.add(moon.orbit!.W, v3.scale(v3.normalize(active.rRoot), -0.35)));
    const earth = s.bodies.find((b) => b.id === fx.rootId)!;
    const map = controller();
    const list = map.frame(s, orbitCamera(earth.rRoot, Math.atan2(dir.y, dir.x), Math.asin(dir.z), 1.15e9), CSS)!;
    const e = map.currentScene!.bodies.find((b) => b.bodyId === fx.rootId)!;
    expect(e.radiusPx).toBeLessThan(6);
    const over = list.icons[0].filter((i) => i.shape !== ICON.plate && i.shape !== ICON.bar && i.shape !== ICON.roundRect && Math.hypot(i.x - e.x, i.y - e.y) < e.radiusPx + 3);
    expect(over.map((i) => i.shape)).toEqual(over.length ? [ICON.bodyRing] : []);
    expect(list.texts[0].some((t) => t.text === defs.bodies[fx.rootId]!.name)).toBe(true);
    // the folded icons are listed in the tooltip of the cluster
    const clustered = list.texts[0].find((t) => /^\+\d+$/.test(t.text));
    expect(clustered).toBeDefined();
  });

  it('no SOI line is drawn from inside the sphere', () => {
    const s = createFakeSim(defs, { scene: 'lunarOrbit' }).snapshot();
    const moon = s.bodies.find((b) => b.soiRadius !== null && b.orbit !== null)!;
    const map = controller();
    map.frame(s, orbitCamera(moon.rRoot, 0.3, 0.4, 7e6), CSS);
    expect(map.currentScene!.lines.some((l) => l.id === `soi:${moon.id}`)).toBe(false);
    map.frame(s, orbitCamera(moon.rRoot, 0.3, 0.4, 1.5 * moon.soiRadius!), CSS);
    expect(map.currentScene!.lines.some((l) => l.id === `soi:${moon.id}`)).toBe(true);
  });

  it('surface targets on the visible hemisphere are drawn at full strength', () => {
    const s = createFakeSim(defs, { scene: 'lowOrbit' }).snapshot();
    const body = s.bodies.find((b) => b.id === defs.rootBodyId)!;
    const map = controller();
    let checked = 0;
    for (let i = 0; i < 48; i++) {
      map.frame(s, orbitCamera(body.rRoot, (i / 48) * 2 * Math.PI, 0.5 * Math.sin(i), 1.4e7), CSS);
      const scene = map.currentScene!;
      const c = scene.proj.toView(body.rRoot);
      for (const t of scene.targets) {
        const nrm = v3.normalize(v3.sub(t.view, c));
        const facing = v3.dot(nrm, v3.normalize(v3.neg(t.view)));
        if (facing > 0.02) {
          expect(t.hidden, `${t.id} facing ${facing.toFixed(3)}`).toBe(0);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('formats (item 19)', () => {
  it('distances in km with grouped digits, never megametres; "now" within a second', () => {
    expect(formatDistance(8450)).toBe('8 450 m');
    expect(formatDistance(200e3)).toBe('200.0 km');
    expect(formatDistance(6087.9e3)).toBe('6 087.9 km');
    expect(formatDistance(425.6e6)).toBe('425 600 km');
    expect(formatDistance(358_176_000)).toBe('358 176 km');
    expect(formatTimeTo(0.4)).toBe('now');
    expect(formatTimeTo(-0.4)).toBe('now');
    expect(formatTimeTo(90)).toBe('T-1m 30s');
  });
});
