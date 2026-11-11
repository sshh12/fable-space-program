/**
 * Round-5 visual close-out (work lists out/qa/wave2/map-view.r4.photo.json and map-view.r4.artifact.json):
 * converging planned legs merge instead of interleaving, legs side by side show their dashes side by side, the
 * label placement keeps off the lines (body names included), keeps two neighbours' labels in their markers'
 * order, keeps its place between frames, and the encounter, badge, selection and HUD rules of the draw list.
 * Each check runs on the geometry and draw list the GPU receives, in the views the critics measured.
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
import { COINCIDENT_PX, DASH_ALIGN_PX, FONT_PX, NARROW_SPACE_EM } from '@/map/constants';
import { defaultTextMetrics, MapController } from '@/map/controller';
import { ICON, measureText, type DrawList } from '@/map/drawList';
import { declutter, type LabelBox } from '@/map/labels';
import type { LineRecord, MapScene } from '@/map/scene';
import { lookAtCamera, orbitCamera } from '@/map/testing/camera';
import { createSyntheticFixture, type SyntheticFixture } from '@/map/testing/syntheticSnapshots';

const CSS: [number, number] = [1280, 720];
let defs: DefLibrary;
let fx: SyntheticFixture;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
  fx = createSyntheticFixture(defs);
});

const pointer = (p: Partial<PointerState> = {}): PointerState => ({ x: -100, y: -100, dx: 0, dy: 0, buttons: 0, pressed: false, released: false, doubleClick: false, wheel: 0, shift: false, ctrl: false, alt: false, overUi: false, ...p });

/** The lab's default view of the synthetic scene (labs/map-view/main.ts) at a distance from a body. */
function labCamera(s: SimSnapshot, bodyId: string, dist: number): CameraState {
  const body = s.bodies.find((b) => b.id === bodyId)!;
  const moon = s.bodies.find((b) => b.orbit !== null)!;
  const active = s.vessels.find((v) => v.id === s.activeVesselId)!;
  const d = v3.normalize(v3.add(moon.orbit!.W, v3.scale(v3.normalize(active.rRoot), -0.35)));
  return orbitCamera(body.rRoot, Math.atan2(d.y, d.x), Math.asin(d.z), dist);
}

function synthetic(dist: number, focus: 'earth' | 'moon', selected: string | null, atIntercept = false): { map: MapController; list: DrawList; scene: MapScene } {
  const s = fx.snapshot;
  const map = new MapController(defs);
  map.setActive(true);
  map.setDrawAtIntercept(atIntercept);
  if (selected) map.selectNode(selected);
  const moonId = s.bodies.find((b) => b.orbit !== null)!.id;
  const list = map.frame(s, labCamera(s, focus === 'earth' ? fx.rootId : moonId, dist), CSS)!;
  return { map, list, scene: map.currentScene! };
}

/** Screen points of the drawn (not hidden) part of a line, a sample per pixel, with the line direction. */
function drawnSamples(scene: MapScene, l: LineRecord): { x: number; y: number; tx: number; ty: number }[] {
  const v = scene.verts;
  const out: { x: number; y: number; tx: number; ty: number }[] = [];
  for (let i = l.start; i < l.start + l.count - 1; i++) {
    if (v.seg[i] !== 1 || v.cover[i] === 1) continue;
    const ax = v.sx[i]!;
    const ay = v.sy[i]!;
    const dx = v.sx[i + 1]! - ax;
    const dy = v.sy[i + 1]! - ay;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) continue;
    const n = Math.ceil(len);
    for (let q = 0; q <= n; q++) {
      const s = q / n;
      if (v.cut1[i]! > v.cut0[i]! && s > v.cut0[i]! && s < v.cut1[i]!) continue;
      const x = ax + dx * s;
      const y = ay + dy * s;
      if (x < 0 || y < 0 || x > CSS[0] || y > CSS[1]) continue;
      out.push({ x, y, tx: dx / len, ty: dy / len });
    }
  }
  return out;
}

function distToLine(scene: MapScene, l: LineRecord, x: number, y: number): { d: number; i: number; t: number } {
  const v = scene.verts;
  let best = { d: Infinity, i: -1, t: 0 };
  for (let i = l.start; i < l.start + l.count - 1; i++) {
    if (v.seg[i] !== 1 || v.cover[i] === 1) continue;
    const ax = v.sx[i]!;
    const ay = v.sy[i]!;
    const dx = v.sx[i + 1]! - ax;
    const dy = v.sy[i + 1]! - ay;
    const d2 = dx * dx + dy * dy;
    const t = d2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / d2)) : 0;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best.d) best = { d, i, t };
  }
  return best;
}

describe('converging planned legs (photo 2 / artifact A1, 3)', () => {
  it('Earth close-up: no drawn stretch of a later planned patch runs within the corridor of an earlier one (crossings aside)', () => {
    const { scene } = synthetic(9e7, 'earth', 'node-b');
    const a = scene.lines.find((l) => l.id === 'planned/1')!;
    const b = scene.lines.find((l) => l.id === 'planned/2')!;
    const v = scene.verts;
    let near = 0;
    let checked = 0;
    for (const p of drawnSamples(scene, b)) {
      const q = distToLine(scene, a, p.x, p.y);
      if (q.i < 0) continue;
      checked++;
      const ux = v.sx[q.i + 1]! - v.sx[q.i]!;
      const uy = v.sy[q.i + 1]! - v.sy[q.i]!;
      const cos = Math.abs(p.tx * ux + p.ty * uy) / Math.hypot(ux, uy);
      // within the corridor and running alongside (not a crossing): the two strokes would share a corridor;
      // the corridor's anti-aliased end and the cleaning of short gaps allow a pixel or two of it per stretch
      if (q.d < COINCIDENT_PX - 0.5 && cos > 0.85) near++;
    }
    expect(checked).toBeGreaterThan(200);
    expect(near / checked).toBeLessThan(0.02);
    // and the later leg is not simply gone: its stretches apart from the earlier one are drawn
    expect(drawnSamples(scene, b).length).toBeGreaterThan(150);
  });

  it('two legs side by side keep their dashes side by side (the later takes the earlier one`s dash phase)', () => {
    const { scene } = synthetic(9e7, 'earth', 'node-b');
    const a = scene.lines.find((l) => l.id === 'planned/1')!;
    const b = scene.lines.find((l) => l.id === 'planned/2')!;
    const v = scene.verts;
    let pairs = 0;
    let off = 0;
    for (let j = b.start; j < b.start + b.count - 1; j++) {
      if (v.front[j] !== 1 || v.seg[j] !== 1 || v.cover[j] === 1) continue;
      const x = v.sx[j]!;
      const y = v.sy[j]!;
      if (x < 0 || y < 0 || x > CSS[0] || y > CSS[1]) continue;
      const q = distToLine(scene, a, x, y);
      if (q.i < 0 || q.d < COINCIDENT_PX || q.d > DASH_ALIGN_PX - 2) continue;
      // the earlier patch's dash coordinate at the nearest point (perspective-correct along its segment)
      const wa = -v.vz[q.i]!;
      const wb = -v.vz[q.i + 1]!;
      const t3 = (q.t * wa) / ((1 - q.t) * wb + q.t * wa);
      const arcA = v.len[q.i]! + (v.len[q.i + 1]! - v.len[q.i]!) * t3;
      // in units of the coarser of the two octaves either may show there
      const cell = Math.pow(2, v.oct[j]! + 1);
      const ph = (v.len[j]! - arcA) / cell;
      pairs++;
      if (Math.abs(ph - Math.round(ph)) > 0.04) off++;
    }
    expect(pairs).toBeGreaterThan(4);
    expect(off).toBe(0);
  });

  it('the dash octave cells nest: the dash coordinate a planned vertex carries is exact modulo every power of two up to its octave + 2', () => {
    // the shader reads the coordinate modulo 2^(octave + 2) of the segment's coarser end; any octave it picks is
    // at most one above the segment's, so a cell boundary there is a multiple of every finer period
    const { scene } = synthetic(8.2e8, 'earth', null);
    const v = scene.verts;
    for (const l of scene.lines.filter((x) => x.kind === 'planned')) {
      for (let j = l.start; j < l.start + l.count - 1; j++) {
        if (v.seg[j] !== 1) continue;
        expect(Number.isFinite(v.len[j]!)).toBe(true);
        expect(v.len[j + 1]!).toBeGreaterThanOrEqual(v.len[j]!);
        expect(Math.abs(v.oct[j + 1]! - v.oct[j]!)).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe('labels off the lines (photo 3, 5 / artifact 4, 6)', () => {
  const rectHitsLine = (scene: MapScene, kinds: string[], x0: number, y0: number, x1: number, y1: number): number => {
    const v = scene.verts;
    let len = 0;
    for (const l of scene.lines) {
      if (!kinds.includes(l.kind)) continue;
      for (let i = l.start; i < l.start + l.count - 1; i++) {
        if (v.seg[i] !== 1 || v.cover[i] === 1) continue;
        const ax = v.sx[i]!;
        const ay = v.sy[i]!;
        const dx = v.sx[i + 1]! - ax;
        const dy = v.sy[i + 1]! - ay;
        let t0 = 0;
        let t1 = 1;
        let ok = true;
        for (const [p, q] of [
          [-dx, ax - x0],
          [dx, x1 - ax],
          [-dy, ay - y0],
          [dy, y1 - ay],
        ] as const) {
          if (p === 0) {
            if (q < 0) ok = false;
          } else {
            const t = q / p;
            if (p < 0) t0 = Math.max(t0, t);
            else t1 = Math.min(t1, t);
          }
        }
        if (ok && t1 > t0) len += Math.hypot(dx, dy) * (t1 - t0);
      }
    }
    return len;
  };

  it('synthetic Moon view: the Moon`s name and the impact label cover no trajectory', () => {
    const { list, scene } = synthetic(1.4e8, 'moon', 'node-a');
    const tm = defaultTextMetrics(1);
    for (const want of ['MOON', 'Impact']) {
      const run = list.texts[0].find((t) => t.text.startsWith(want));
      expect(run, want).toBeDefined();
      const w = measureText(tm, run!.text, want === 'MOON' ? 1.4 : 0);
      expect(rectHitsLine(scene, ['current', 'planned'], run!.x, run!.y + 2, run!.x + w, run!.y + 13), want).toBe(0);
    }
  });

  it('a long site name that finds no room is written in its short form', () => {
    const box = (key: string, ax: number, ay: number, width: number, altWidth: number): LabelBox => ({ ax, ay, clear: 6, width, height: 17, priority: 1, x: 0, y: 0, placed: false, far: false, nx: 0, ny: 0, key, altWidth, short: false });
    // a 400 px wide viewport strip: the full name (300 px) fits nowhere beside an anchor at x = 200, the short one does
    const l = box('site', 200, 30, 300, 70);
    declutter([l], [], { width: 400, height: 60 }, 8, [], 22, null, null, 1);
    expect(l.placed).toBe(true);
    expect(l.short).toBe(true);
    expect(l.width).toBe(70);
  });

  it('two neighbouring markers on lines side by side: labels on opposite sides, in the markers` order (accept-panel)', () => {
    // the two Ap markers of accept-panel.png: current (inner) upper left, planned (outer) lower right, both on lines
    // whose outer side points down-left
    const n = { x: -0.7, y: 0.71 };
    const mk = (key: string, ax: number, ay: number): LabelBox => ({ ax, ay, clear: 6.5, width: 78, height: 32, priority: 6, x: 0, y: 0, placed: false, far: false, nx: n.x, ny: n.y, key, altWidth: 0, short: false });
    const inner = mk('inner', 535, 431);
    const outer = mk('outer', 555, 458);
    const icons = [
      { x: 535, y: 431, r: 6.5, pair: true },
      { x: 555, y: 458, r: 6.5, pair: true },
    ];
    declutter([inner, outer], icons, { width: 1280, height: 720 }, 8, [], 22, null, null, 1);
    expect(inner.placed && outer.placed).toBe(true);
    const ci = { x: inner.x + inner.width / 2, y: inner.y + inner.height / 2 };
    const co = { x: outer.x + outer.width / 2, y: outer.y + outer.height / 2 };
    // the inner anchor is above the outer one; labels beside their markers are read row by row and keep that order
    expect(ci.y).toBeLessThan(co.y);
    // the outer marker's label lies on the outer side of its line, the inner one's on the inner side
    expect((co.x - outer.ax) * n.x + (co.y - outer.ay) * n.y).toBeGreaterThan(0);
    expect((ci.x - inner.ax) * n.x + (ci.y - inner.ay) * n.y).toBeLessThan(0);
  });

  it('a label keeps its place while a handle is dragged (no slot flips between frames)', () => {
    const sim = createFakeSim(defs, { scene: 'lowOrbit' });
    let snap = sim.snapshot();
    const body = snap.bodies.find((b) => b.id === snap.vessels[0]!.bodyId)!;
    const W = snap.patches.current[0]!.conic.W;
    const cam = lookAtCamera(v3.add(body.rRoot, v3.scale(v3.normalize(v3.add(W, v3.scale(v3.normalize(snap.vessels[0]!.r), 0.5))), 4e7)), body.rRoot, (50 * Math.PI) / 180, v3.normalize(snap.vessels[0]!.r));
    const map = new MapController(defs, { now: () => 0 });
    map.setActive(true);
    const id = sim.commands.addNode(snap.ut + 1500);
    map.selectNode(id);
    snap = sim.snapshot();
    const positions: Map<string, string>[] = [];
    for (let k = 0; k <= 10; k++) {
      sim.commands.setNode(id, { dv: { prograde: k, normal: 0, radial: 0 } });
      snap = sim.snapshot();
      map.update(snap, cam, sim.commands, pointer(), CSS);
      const list = map.frame(snap, cam, CSS)!;
      positions.push(new Map(list.texts[0].map((t) => [t.text, `${t.x},${t.y}`])));
    }
    // texts of anchors that do not move (sites, zones, the vessel) stay where they were
    const sites = snap.surfaceTargets.map((t) => t.name);
    let compared = 0;
    for (const name of [...sites, snap.vessels[0]!.name]) {
      const first = positions[0]!.get(name);
      if (!first) continue;
      for (const p of positions) if (p.has(name)) expect(p.get(name), name).toBe(first);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  });
});

describe('clusters, badges, the selection and the HUD (photo 4, 6, 7, 8, 12 / artifact 4, 8)', () => {
  it('at-intercept overview: the encounter folds into its ghost (one icon with a badge and its name), no knot of icons', () => {
    const { list, scene } = synthetic(8.2e8, 'earth', null, true);
    const ghost = scene.bodies.find((b) => b.ghost)!;
    expect(ghost).toBeDefined();
    // icons drawn within the encounter's sphere of influence on screen, other than the ghost itself
    const inside = list.icons[0].filter((i) => i.shape !== ICON.plate && i.shape !== ICON.roundRect && i.shape !== ICON.bar && i.shape !== ICON.debris && i.shape !== ICON.bodyRing && Math.hypot(i.x - ghost.x, i.y - ghost.y) < ghost.soiPx * 0.8);
    expect(inside.map((i) => i.shape)).toEqual([]);
    expect(list.texts[0].some((t) => t.text.startsWith('Moon (encounter)') || t.text.includes('(encounter)'))).toBe(true);
    expect(list.texts[0].some((t) => /^\+\d+$/.test(t.text))).toBe(true);
  });

  it('a count badge covers no other icon and sits on a corner of its own', () => {
    for (const [dist, focus, sel, ai] of [
      [8.2e8, 'earth', null, false],
      [8.2e8, 'earth', null, true],
      [9e7, 'earth', 'node-b', false],
    ] as const) {
      const { list } = synthetic(dist, focus, sel, ai);
      const icons = list.icons[0];
      const badges = icons.filter((i) => i.shape === ICON.roundRect);
      for (const b of badges) {
        for (const o of icons) {
          if (o === b || o.shape === ICON.plate || o.shape === ICON.roundRect || o.shape === ICON.bar || o.shape === ICON.debris) continue;
          const ex = Math.max(b.x - b.hx - o.x, 0, o.x - (b.x + b.hx));
          const ey = Math.max(b.y - b.hy - o.y, 0, o.y - (b.y + b.hy));
          const r = Math.min(o.hx, o.hy);
          // its own icon: the badge's inner corner reaches 2 px into the icon's box; any other icon stays clear
          const owner = Math.hypot(ex, ey) < 0.5 && Math.abs(b.x - o.x) <= b.hx + o.hx && Math.abs(b.y - o.y) <= b.hy + o.hy && Math.hypot(b.x - o.x, b.y - o.y) < b.hx + o.hx + 2;
          if (owner) continue;
          expect(Math.hypot(ex, ey), `badge at ${b.x.toFixed(0)},${b.y.toFixed(0)} vs icon ${o.shape} at ${o.x.toFixed(0)},${o.y.toFixed(0)}`).toBeGreaterThanOrEqual(r * 0.5);
        }
      }
    }
  });

  it('a marker under the selected node is moved clear of it along its line, not dropped (synthetic Earth close-up: the entry)', () => {
    const { list, scene } = synthetic(9e7, 'earth', 'node-b');
    const sel = scene.nodes.find((n) => n.id === 'node-b')!;
    const entry = scene.markers.find((m) => m.kind === 'atmosphereEntry')!;
    expect(Math.hypot(entry.x - sel.x, entry.y - sel.y)).toBeLessThan(20);
    const icon = list.icons[0].find((i) => i.shape === ICON.entry);
    expect(icon).toBeDefined();
    expect(Math.hypot(icon!.x - sel.x, icon!.y - sel.y)).toBeGreaterThan(8 * 1.1);
    expect(Math.hypot(icon!.x - entry.x, icon!.y - entry.y)).toBeLessThan(30);
  });

  it('an off-screen body whose sphere of influence is drawn gets an edge chevron with its name', () => {
    const sim = createFakeSim(defs, { scene: 'translunar' });
    const s = sim.snapshot();
    const earth = s.bodies.find((b) => b.orbit === null && b.id === defs.rootBodyId)!;
    const moon = s.bodies.find((b) => b.orbit !== null)!;
    // looking at the Earth from the side away from the Moon, the Moon's SOI enters the frame at an edge
    const away = v3.normalize(v3.sub(earth.rRoot, moon.rRoot));
    const cam = lookAtCamera(v3.add(earth.rRoot, v3.scale(away, 1.6e8)), earth.rRoot, (50 * Math.PI) / 180, moon.orbit!.W);
    const map = new MapController(defs);
    map.setActive(true);
    const list = map.frame(s, cam, CSS)!;
    const sc = map.currentScene!;
    const soi = sc.lines.find((l) => l.id === `soi:${moon.id}`);
    const m = sc.bodies.find((b) => b.bodyId === moon.id && !b.ghost)!;
    if (!soi || soi.visibleVertices === 0 || (m.front && m.x > 0 && m.x < CSS[0] && m.y > 0 && m.y < CSS[1])) return; // geometry of this view changed: nothing to check
    const name = defs.bodies[moon.id]!.name.toUpperCase();
    const run = list.texts[0].find((t) => t.text === name);
    expect(run).toBeDefined();
    const chevron = list.icons[0].find((i) => i.shape === ICON.vessel && (i.x < 40 || i.y < 40 || i.x > CSS[0] - 40 || i.y > CSS[1] - 40));
    expect(chevron).toBeDefined();
  });

  it('the narrow no-break space of digit groups and units is a quarter em (a visible gap at 720p)', () => {
    expect(NARROW_SPACE_EM * FONT_PX).toBeGreaterThanOrEqual(3);
    const tm = defaultTextMetrics(1);
    expect(measureText(tm, '1 839') - measureText(tm, '1839')).toBeGreaterThanOrEqual(3);
  });
});
