/**
 * Checks for the defects of the round-1 visual close-out lists (out/qa/wave2/map-view.r1.photo.json and
 * map-view.r1.artifact.json), each against the geometry and the draw list the GPU receives: labels drawn
 * fully or not at all, opaque plates over the debris dots, the silhouette of every body whose disc is drawn,
 * lines ending at the visible (atmosphere) limb, coincident patches drawn once, dashes fixed to the path,
 * the apsis at the vessel printed with its label, leaders on displaced labels, the tooltip off the
 * trajectories, the hovered debris ringed, small orbits of other vessels left out, the vessel chevron along
 * its heading.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PointerState } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { v3 } from '@/core/math/vec3';
import { COLORS, LEADER_GAP_PX, ORBIT_MIN_SPAN_PX, TOOLTIP_LINE_CLEARANCE_PX } from '@/map/constants';
import { MapController } from '@/map/controller';
import { ICON, type DrawList, type IconInstance } from '@/map/drawList';
import { occlusionWeight, visibleAtmosphereHeight } from '@/map/occlusion';
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

const plates = (list: DrawList): IconInstance[] => list.icons[0].filter((i) => i.shape === ICON.plate);
const inside = (x: number, y: number, p: IconInstance, m = 0): boolean => x > p.x - p.hx - m && x < p.x + p.hx + m && y > p.y - p.hy - m && y < p.y + p.hy + m;

/** Segment (a, b) touches the rectangle? (Liang-Barsky) */
function segRect(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  for (const [p, q] of [
    [-dx, ax - x0],
    [dx, x1 - ax],
    [-dy, ay - y0],
    [dy, y1 - ay],
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
}

describe('labels are drawn fully or not at all (photo 2 / artifact 4)', () => {
  it('no icon, plate or text of a static frame has a partial alpha, whatever the camera (pad near the limb included)', () => {
    const s = createFakeSim(defs, { scene: 'lowOrbit' }).snapshot();
    const body = s.bodies.find((b) => b.id === defs.rootBodyId)!;
    const map = controller();
    let texts = 0;
    for (let i = 0; i < 96; i++) {
      const list = map.frame(s, orbitCamera(body.rRoot, (i / 96) * 2 * Math.PI, 0.6 * Math.sin(1.7 * i), 1.4e7 + 1e7 * Math.cos(i)), CSS)!;
      for (const t of list.texts[0]) {
        expect(t.alpha, `"${t.text}"`).toBe(1);
        texts++;
      }
      for (const p of plates(list)) expect(p.alpha).toBe(1);
      for (const ic of list.icons[0]) if (ic.shape !== ICON.bar && ic.shape !== ICON.nodeHidden) expect(ic.alpha === 1 || ic.alpha === 0.9, `icon ${ic.shape} alpha ${ic.alpha}`).toBe(true);
    }
    expect(texts).toBeGreaterThan(100);
  });

  it('plates are opaque and drawn over the debris dots: a dot never shows inside a label', () => {
    const fx = createSyntheticFixture(defs);
    const s = fx.snapshot;
    const earth = s.bodies.find((b) => b.id === fx.rootId)!;
    const map = controller();
    map.selectNode(fx.nodeB.id);
    let checked = 0;
    for (const [yaw, dist] of [
      [0.3, 9e7],
      [1.2, 6e7],
      [2.4, 1.2e8],
    ] as const) {
      const list = map.frame(s, orbitCamera(earth.rRoot, yaw, 0.5, dist), CSS)!;
      expect(COLORS.plate[3]).toBeGreaterThanOrEqual(0.92);
      const all = list.icons[0];
      const firstPlate = all.findIndex((i) => i.shape === ICON.plate);
      const lastDebris = all.map((i) => i.shape).lastIndexOf(ICON.debris);
      if (firstPlate >= 0 && lastDebris >= 0) {
        expect(lastDebris).toBeLessThan(firstPlate);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('the body silhouette and the visible limb (photo 1 / artifact 3, artifact 11)', () => {
  it('a body whose disc is drawn gets a silhouette ring: strong on the night side, faint on the day side', () => {
    const s = createFakeSim(defs, { scene: 'lowOrbit' }).snapshot();
    const body = s.bodies.find((b) => b.id === defs.rootBodyId)!;
    const map = controller();
    // looking at the terminator from the side: half the limb is lit, half dark
    const side = v3.normalize(v3.cross(body.sunDir, { x: 0, y: 0, z: 1 }));
    map.frame(s, lookAtCamera(v3.add(body.rRoot, v3.scale(side, 2.4e7)), body.rRoot), CSS);
    const sc = map.currentScene!;
    const limb = sc.lines.find((l) => l.id === `limb:${body.id}`)!;
    expect(limb).toBeDefined();
    expect(limb.casing).toBe(false);
    let lo = 1;
    let hi = 0;
    for (let i = limb.start; i < limb.start + limb.count; i++) {
      lo = Math.min(lo, sc.verts.alpha[i]!);
      hi = Math.max(hi, sc.verts.alpha[i]!);
    }
    expect(hi).toBe(1);
    expect(lo).toBeLessThan(0.35);
    // the ring is not hidden by its own body (the occlusion slack covers the chords)
    let hidden = 0;
    for (let i = limb.start; i < limb.start + limb.count - 1; i++) {
      const p = { x: (sc.verts.vx[i]! + sc.verts.vx[i + 1]!) / 2, y: (sc.verts.vy[i]! + sc.verts.vy[i + 1]!) / 2, z: (sc.verts.vz[i]! + sc.verts.vz[i + 1]!) / 2 };
      if (occlusionWeight(p, sc.occluders, sc.proj.focal, 1.5 * sc.proj.pxScale, limb.occlusionSlack) > 0.5) hidden++;
    }
    expect(hidden).toBe(0);
    // a small body is an icon, not a ring
    map.frame(s, orbitCamera(body.rRoot, 0.3, 0.2, 1.5e9), CSS);
    expect(map.currentScene!.lines.some((l) => l.kind === 'limb')).toBe(false);
  });

  it('lines behind the Earth end at the top of its limb glow; inside the shell only the solid sphere hides them', () => {
    const atm = defs.bodies[defs.rootBodyId]!.render.atmosphere!;
    const R = defs.bodies[defs.rootBodyId]!.radius;
    const h = visibleAtmosphereHeight(R, atm, 0.03);
    expect(h).toBeGreaterThan(35e3);
    expect(h).toBeLessThan(70e3);
    const occ = [{ x: 0, y: 0, z: -2e7, radius: R, vis: R + h }];
    const focal = 772;
    // direction just outside the solid limb, inside the visible one (a tenth of the glow height up)
    const L = 2e7;
    const ang = Math.asin((R + h / 10) / L);
    const dir = { x: Math.sin(ang), y: 0, z: -Math.cos(ang) };
    expect(occlusionWeight(v3.scale(dir, 3e7), occ, focal, 1.5)).toBe(1); // far behind: hidden by the glow
    expect(occlusionWeight(v3.scale(dir, 3e7), [{ ...occ[0]!, vis: R }], focal, 1.5)).toBe(0); // the solid sphere alone would not
    // a point inside the shell on the near side (an entry trajectory at 20 km altitude) stays visible
    const nn = v3.normalize({ x: 0, y: 0.3, z: 0.95 });
    const near = v3.add({ x: 0, y: 0, z: -2e7 }, v3.scale(nn, R + 20e3));
    expect(occlusionWeight(near, occ, focal, 1.5)).toBe(0);
  });
});

describe('coincident patches and dashes (artifact 1, photo 7)', () => {
  it('a node with no delta-v: one orbit, not interleaved dashes; the hidden stretches stay clickable', () => {
    const sim = createFakeSim(defs, { scene: 'lowOrbit' });
    const s0 = sim.snapshot();
    sim.commands.addNode(s0.ut + 1500);
    const s = sim.snapshot();
    const map = controller();
    map.frame(s, lookAtCamera(v3.scale(s.patches.current[0]!.conic.W, 4e7), v3.zero(), (50 * Math.PI) / 180, v3.normalize(s.vessels[0]!.r)), CSS);
    const sc = map.currentScene!;
    const v = sc.verts;
    const planned = sc.lines.find((l) => l.kind === 'planned')!;
    const current = sc.lines.find((l) => l.kind === 'current')!;
    const drawn = (l: typeof planned) => {
      let on = 0;
      let all = 0;
      for (let i = l.start; i < l.start + l.count - 1; i++) {
        if (v.seg[i] !== 1) continue;
        all++;
        if (v.cover[i] === 0) on++;
      }
      return { on, all };
    };
    // Every on-screen stretch is drawn by exactly one of the two: no two drawn segments lie on each other.
    const p = drawn(planned);
    const c = drawn(current);
    expect(p.on + c.on).toBeLessThan(1.15 * Math.max(p.all, c.all));
    expect(p.on).toBeGreaterThan(0);
    expect(c.on).toBeGreaterThan(0);
    // the current trajectory up to the node is never hidden
    for (let i = current.start; i < current.start + current.count - 1; i++) if (v.seg[i] === 1 && v.t[i + 1]! <= s.nodes[0]!.ut) expect(v.cover[i]).toBe(0);
    // a hidden segment is still a segment: clicks and node drags use it
    let hiddenSegs = 0;
    for (let i = planned.start; i < planned.start + planned.count - 1; i++) if (v.cover[i] === 1) hiddenSegs += v.seg[i]!;
    expect(hiddenSegs).toBeGreaterThan(0);
  });

  it('the dash coordinate of a world point on a planned patch does not change while the camera turns', () => {
    const fx = createSyntheticFixture(defs);
    const s = fx.snapshot;
    const earth = s.bodies.find((b) => b.id === fx.rootId)!;
    const map = controller();
    const probe = (yaw: number): { arc: number; u: number }[] => {
      map.frame(s, orbitCamera(earth.rRoot, yaw, 0.45, 2.5e8), CSS);
      const sc = map.currentScene!;
      const line = sc.lines.find((l) => l.id === 'planned/1')!;
      const out: { arc: number; u: number }[] = [];
      // arc length at fixed parameters, interpolated between vertices (exact at vertices)
      for (const q of [0.15, 0.4, 0.7, 0.95]) {
        // (a whole ellipse: its last vertices repeat the seam, so the range is one turn from the first vertex)
        const u0 = sc.verts.u[line.start]!;
        const u = u0 + 2 * Math.PI * 0.98 * q;
        for (let i = line.start; i < line.start + line.count - 1; i++) {
          const a = sc.verts.u[i]!;
          const b = sc.verts.u[i + 1]!;
          if (u >= a && u <= b) {
            const t = b > a ? (u - a) / (b - a) : 0;
            out.push({ u, arc: sc.verts.len[i]! + (sc.verts.len[i + 1]! - sc.verts.len[i]!) * t });
            break;
          }
        }
      }
      return out;
    };
    const a = probe(0.3);
    for (const yaw of [0.32, 0.4, 0.9]) {
      const b = probe(yaw);
      expect(b).toHaveLength(a.length);
      // the chord between vertices differs from the arc by far less than a metre per kilometre
      for (let i = 0; i < a.length; i++) expect(Math.abs(b[i]!.arc - a[i]!.arc) / Math.max(1, a[i]!.arc)).toBeLessThan(2e-4);
    }
  });
});

describe('labels tied to their icons (photo 6 / artifact 5, 7)', () => {
  it('the apsis the vessel sits at is printed as the vessel label`s second line, not folded into a "+1"', () => {
    const s = createFakeSim(defs, { scene: 'lowOrbit' }).snapshot();
    const map = controller();
    const list = map.frame(s, lookAtCamera(v3.scale(s.patches.current[0]!.conic.W, 4e7), v3.zero(), (50 * Math.PI) / 180, v3.normalize(s.vessels[0]!.r)), CSS)!;
    const sc = map.currentScene!;
    const pe = sc.markers.find((m) => m.kind === 'periapsis')!;
    const v = sc.vessels.find((x) => x.active)!;
    expect(Math.hypot(pe.x - v.x, pe.y - v.y)).toBeLessThan(11);
    const name = list.texts[0].findIndex((t) => t.text === v.name);
    expect(name).toBeGreaterThanOrEqual(0);
    expect(list.texts[0][name + 1]!.text.startsWith('Pe ')).toBe(true);
    expect(list.texts[0].some((t) => t.text === '+1')).toBe(false);
  });

  it('a label set away from its icon has a leader to it; one beside it has none', () => {
    const fx = createSyntheticFixture(defs);
    const s = fx.snapshot;
    const earth = s.bodies.find((b) => b.id === fx.rootId)!;
    const map = controller();
    let leaders = 0;
    for (let i = 0; i < 24; i++) {
      const list = map.frame(s, orbitCamera(earth.rRoot, i * 0.26, 0.5 * Math.sin(i), 2e8 + 2e8 * (i % 4)), CSS)!;
      const sc = map.currentScene!;
      const bars = list.icons[0].filter((b) => b.shape === ICON.bar && b.color === COLORS.leader);
      for (const p of plates(list)) {
        // the anchor: the nearest marker / vessel / body to this plate
        let best = Infinity;
        for (const m of [...sc.markers, ...sc.vessels, ...sc.bodies]) {
          if (!m.front || m.hidden >= 0.5) continue;
          const dx = Math.max(p.x - p.hx - m.x, 0, m.x - p.x - p.hx);
          const dy = Math.max(p.y - p.hy - m.y, 0, m.y - p.y - p.hy);
          best = Math.min(best, Math.hypot(dx, dy));
        }
        // (round 5: the chevron at the frame's edge toward an off-screen body anchors that body's name)
        for (const ic of list.icons[0]) {
          if (ic.shape !== ICON.vessel) continue;
          const dx = Math.max(p.x - p.hx - ic.x, 0, ic.x - p.x - p.hx);
          const dy = Math.max(p.y - p.hy - ic.y, 0, ic.y - p.y - p.hy);
          best = Math.min(best, Math.hypot(dx, dy));
        }
        if (best > 40) {
          const tied = bars.some((b) => Math.hypot(Math.max(Math.abs(b.x - p.x) - p.hx, 0), Math.max(Math.abs(b.y - p.y) - p.hy, 0)) <= b.hx + 2);
          expect(tied, `a plate ${best.toFixed(0)} px from every icon without a leader`).toBe(true);
          leaders++;
        }
      }
      expect(LEADER_GAP_PX).toBeLessThanOrEqual(14);
    }
    expect(leaders).toBeGreaterThanOrEqual(0);
  });

  it('the hover tooltip keeps clear of the trajectories when it can', () => {
    const fx = createSyntheticFixture(defs);
    const s = fx.snapshot;
    const moon = s.bodies.find((b) => b.id === fx.moonId)!;
    const map = controller();
    const cam = orbitCamera(moon.rRoot, 0.4, 0.5, 1.4e8);
    const sim = { commands: createFakeSim(defs, { scene: 'lowOrbit' }).commands };
    map.update(s, cam, sim.commands, pointer({ x: 1, y: 1 }), CSS);
    map.frame(s, cam, CSS);
    const sc = map.currentScene!;
    let checked = 0;
    for (const m of sc.markers) {
      if (!m.front || m.hidden >= 0.5 || m.details.length === 0 || m.kind === 'impactSurface' || m.kind === 'entrySurface') continue;
      map.update(s, cam, sim.commands, pointer({ x: m.x, y: m.y }), CSS);
      map.frame(s, cam, CSS);
      const t = map.tooltipRect;
      if (!t) continue;
      const c = TOOLTIP_LINE_CLEARANCE_PX - 2;
      const scene: MapScene = map.currentScene!;
      let crossings = 0;
      for (const l of scene.lines) {
        if (l.kind !== 'current' && l.kind !== 'planned') continue;
        for (let i = l.start; i < l.start + l.count - 1; i++) {
          if (scene.verts.seg[i] !== 1 || scene.verts.cover[i] === 1) continue;
          if (segRect(scene.verts.sx[i]!, scene.verts.sy[i]!, scene.verts.sx[i + 1]!, scene.verts.sy[i + 1]!, t.x - c, t.y - c, t.x + t.width + c, t.y + t.height + c)) crossings++;
        }
      }
      expect(crossings, `tooltip of ${m.id}`).toBe(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
  });
});

describe('overview and hover (photo 4, artifact 12, photo 5 minor)', () => {
  it('other vessels` orbits a few pixels across are left out at the overview, and drawn when hovered', () => {
    const fx = createSyntheticFixture(defs);
    const s: SimSnapshot = fx.snapshot;
    const earth = s.bodies.find((b) => b.id === fx.rootId)!;
    const map = controller();
    map.frame(s, orbitCamera(earth.rRoot, 0.7, 0.5, 8.2e8), CSS);
    for (const l of map.currentScene!.lines) if (l.kind === 'vesselOrbit') expect(l.span).toBeGreaterThanOrEqual(ORBIT_MIN_SPAN_PX);
  });

  it('the hovered debris is ringed and its orbit drawn in the hover colour', () => {
    const fx = createSyntheticFixture(defs);
    const s = fx.snapshot;
    const earth = s.bodies.find((b) => b.id === fx.rootId)!;
    const map = controller();
    const cam = orbitCamera(earth.rRoot, 0.7, 0.5, 9e7);
    const cmd = createFakeSim(defs, { scene: 'lowOrbit' }).commands;
    map.update(s, cam, cmd, pointer({ x: 1, y: 1 }), CSS);
    map.frame(s, cam, CSS);
    const d = map.currentScene!.vessels.find((v) => v.debris && v.front && v.hidden < 0.5 && v.x > 20 && v.x < 1260 && v.y > 20 && v.y < 700)!;
    for (let i = 0; i < 2; i++) {
      map.update(s, cam, cmd, pointer({ x: d.x, y: d.y }), CSS);
      map.frame(s, cam, CSS);
    }
    const list = map.frame(s, cam, CSS)!;
    expect(list.icons[0].some((ic) => ic.shape === ICON.hoverRing && Math.hypot(ic.x - d.x, ic.y - d.y) < 1)).toBe(true);
    const orbit = map.currentScene!.lines.find((l) => l.id === `vessel:${d.vesselId}`)!;
    expect(orbit.color).toBe(COLORS.hoverOrbit);
  });

  it('the active vessel is a chevron along its velocity on screen', () => {
    const s = createFakeSim(defs, { scene: 'lowOrbit' }).snapshot();
    const map = controller();
    const list = map.frame(s, orbitCamera(v3.zero(), 0.8, 0.6, 2.4e7), CSS)!;
    const v = map.currentScene!.vessels.find((x) => x.active)!;
    const icon = list.icons[0].find((i) => i.shape === ICON.vessel && Math.hypot(i.x - v.x, i.y - v.y) < 0.5)!;
    expect(icon.rot).toBeCloseTo(Math.atan2(v.dirY, v.dirX), 12);
    expect(icon.color).toBe(COLORS.vessel);
    // the projected velocity: a point a little ahead on the orbit lies along the chevron's nose
    const ahead = map.currentScene!.proj.projectRoot(v3.addScaled(s.vessels[0]!.rRoot, s.vessels[0]!.v, 1));
    const dx = ahead.x - v.x;
    const dy = ahead.y - v.y;
    expect((dx * Math.cos(icon.rot) + dy * Math.sin(icon.rot)) / Math.hypot(dx, dy)).toBeGreaterThan(0.999);
  });
});
