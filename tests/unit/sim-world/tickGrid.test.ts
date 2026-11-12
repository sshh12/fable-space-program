/**
 * The tick grid (docs/ARCHITECTURE.md section 3, MIGRATION_V2 step 3.1): the clock is a whole tick of
 * 1/120 s. Every scenario starts on a tick, every rails advance lands on a tick (the first one at or after
 * the requested instant or the next event), an event keeps its own float instant inside the tick, a vessel
 * leaves rails at a grid tick by an exact Kepler evaluation, and the real-time loop carries the rest of a
 * tick as presentation lag, so the presented time is continuous at any frame rate.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { PHYSICS_DT } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { v3 } from '@/core/math/vec3';
import { ceilTick, floorTick, isTickInstant, nearestTick, snapToTick, tickOfInstant, TICKS_PER_SECOND, utOfTick } from '@/sim/clock';
import { makeOrbit, propagate } from '@/sim/orbit';
import { repoRoot } from '../../../tools/sim/realWorld';
import { active, comState, flatTerrain, loadLibrary, makeSim, orbitScenario } from './helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: -100, moon: 0 });
});

const onGrid = (s: SimSnapshot): boolean => isTickInstant(s.simUt);

describe('tick helpers', () => {
  it('convert between ticks and instants at mission epochs without losing a tick', () => {
    expect(TICKS_PER_SECOND * PHYSICS_DT).toBe(1);
    for (const tick of [0, 1, 119, 120, 112588898261, 112588898262, 2 ** 40 + 7]) {
      const ut = utOfTick(tick);
      expect(isTickInstant(ut)).toBe(true);
      expect(tickOfInstant(ut, 'test')).toBe(tick);
      expect(nearestTick(ut)).toBe(tick);
      expect(ceilTick(ut)).toBe(tick);
      expect(floorTick(ut)).toBe(tick);
      // An instant inside the tick interval belongs to the tick after it (ceil) and the tick before it (floor).
      const inside = ut + 0.4 * PHYSICS_DT;
      expect(ceilTick(inside)).toBe(tick + 1);
      expect(floorTick(inside)).toBe(tick);
    }
    expect(isTickInstant(938240818.839663)).toBe(false);
    expect(snapToTick(938240818.839663)).toBe(938240818.8416667);
    expect(() => tickOfInstant(938240818.839663, 'scenarios/x.json: startUt')).toThrow(/scenarios\/x\.json: startUt.*not a whole tick/);
  });
});

describe('scenario starts', () => {
  it('every scenario of the library starts on a whole tick, and the mission at the tick of tools/sim/start-time.json', async () => {
    const ids = Object.keys(defs.scenarios).sort();
    expect(ids.length).toBeGreaterThanOrEqual(9);
    for (const id of ids) expect(isTickInstant(defs.scenarios[id]!.startUt), `${id}: startUt ${defs.scenarios[id]!.startUt}`).toBe(true);
    const st = JSON.parse(await fs.readFile(path.join(repoRoot, 'tools', 'sim', 'start-time.json'), 'utf8')) as { startUt: number; startTick: number };
    expect(utOfTick(st.startTick)).toBe(st.startUt);
    expect(defs.scenarios['lunar-direct']!.startUt).toBe(st.startUt);
  });

  it('a scenario whose start is off the grid is refused by name', async () => {
    const sc = { ...orbitScenario(defs.scenarios['lunar-direct']!, 't-off-grid', 'earth', 200000, 300000, 4), startUt: 938240818.839663 };
    await expect(makeSim(defs, sc, terrain)).rejects.toThrow(/scenarios\/t-off-grid\.json: startUt/);
  });

  it('the clock of a session is its start tick plus one tick per step', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-steps', 'earth', 200000, 300000, 4), terrain);
    const tick0 = tickOfInstant(sim.peek().simUt, 'start');
    for (let i = 1; i <= 500; i++) {
      sim.step();
      expect(sim.peek().simUt).toBe(utOfTick(tick0 + i));
    }
  });
});

describe('rails landings', () => {
  it('a requested instant inside a tick is reached at the first whole tick at or after it', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-land', 'earth', 300000, 400000, 4), terrain);
    const s0 = sim.peek();
    const c0 = comState(active(s0));
    const orbit = makeOrbit('earth', defs.bodies['earth']!.mu, c0.r, c0.v, s0.simUt);
    let ut = s0.simUt;
    // Arbitrary float requests: irrational multiples of a second, a fraction of a tick, exactly a tick.
    for (const dt of [Math.PI, 1e-4, Math.E * 10, PHYSICS_DT, 0.5 * PHYSICS_DT, 123.456789, 1 / 60, 5 / 144]) {
      const request = ut + dt;
      const reached = sim.advanceRails(request);
      expect(isTickInstant(reached), `landing after a request of ${dt} s`).toBe(true);
      expect(reached).toBe(sim.peek().simUt);
      expect(nearestTick(reached)).toBe(ceilTick(request));
      expect(reached - request).toBeGreaterThan(-1e-5);
      expect(reached - request).toBeLessThan(PHYSICS_DT);
      // The state is the conic evaluated at the landing tick.
      expect(v3.dist(comState(active(sim.peek())).r, propagate(orbit, reached).r)).toBeLessThan(1e-4);
      ut = reached;
    }
    expect(sim.advanceRails(ut)).toBe(ut);
    expect(sim.advanceRails(ut - 5)).toBe(ut);
  });

  it('a sphere-of-influence change is handed over at its own float instant and the advance lands on the tick that holds it', async () => {
    const sim = await makeSim(defs, 'qa-translunar', terrain);
    const s0 = sim.peek();
    expect(active(s0).bodyId).toBe('earth');
    const c0 = comState(active(s0));
    const orbit = makeOrbit('earth', defs.bodies['earth']!.mu, c0.r, c0.v, s0.simUt);
    let landings = 0;
    let soi: { ut: number; landing: number } | null = null;
    for (let guard = 0; guard < 2000 && soi === null; guard++) {
      const before = sim.peek().simUt;
      const reached = sim.advanceRails(Math.min(sim.nextEventUt, before + 20000));
      if (!(reached > before)) {
        sim.step();
        continue;
      }
      landings++;
      const s = sim.peek();
      expect(onGrid(s)).toBe(true);
      const ev = s.events.find((e) => e.type === 'soiChange');
      if (ev) soi = { ut: ev.ut, landing: reached };
    }
    expect(landings).toBeGreaterThan(3);
    expect(soi).not.toBeNull();
    const s1 = sim.peek();
    expect(active(s1).bodyId).toBe('moon');
    // The event instant is a float second inside the tick the advance landed on.
    expect(isTickInstant(soi!.ut)).toBe(false);
    expect(nearestTick(soi!.landing)).toBe(ceilTick(soi!.ut));
    expect(soi!.landing - soi!.ut).toBeGreaterThanOrEqual(0);
    expect(soi!.landing - soi!.ut).toBeLessThan(PHYSICS_DT);
    // Continuity through the hand-over: the Earth conic at the landing tick, seen from the Moon, is where the vessel is.
    const earth = s1.bodies.find((b) => b.id === 'earth')!;
    const moon = s1.bodies.find((b) => b.id === 'moon')!;
    const onEarthConic = v3.sub(v3.add(earth.rRoot, propagate(orbit, s1.simUt).r), moon.rRoot);
    expect(v3.dist(comState(active(s1)).r, onEarthConic)).toBeLessThan(0.05);
  });

  it('a vessel leaves rails for the atmosphere at a grid tick, by an exact Kepler evaluation there', async () => {
    const sim = await makeSim(defs, 'qa-entry', terrain);
    const s0 = sim.peek();
    const c0 = comState(active(s0));
    const orbit = makeOrbit('earth', defs.bodies['earth']!.mu, c0.r, c0.v, s0.simUt);
    const simTop = defs.bodies['earth']!.atmosphere!.simTop;
    let reached = s0.simUt;
    for (let guard = 0; guard < 200 && !sim.needsIntegration; guard++) {
      const before = reached;
      reached = sim.advanceRails(Math.min(sim.nextEventUt, before + 600));
      expect(isTickInstant(reached)).toBe(true);
      if (!(reached > before)) break;
    }
    expect(sim.needsIntegration).toBe(true);
    const s1 = sim.peek();
    expect(onGrid(s1)).toBe(true);
    const c1 = comState(active(s1));
    // Less than one tick below the top of the simulated atmosphere, exactly on the conic.
    const alt = v3.len(c1.r) - defs.bodies['earth']!.radius;
    expect(alt).toBeLessThanOrEqual(simTop);
    expect(simTop - alt).toBeLessThan(v3.len(c1.v) * PHYSICS_DT);
    expect(v3.dist(c1.r, propagate(orbit, s1.simUt).r)).toBeLessThan(1e-4);
    expect(v3.dist(c1.v, propagate(orbit, s1.simUt).v)).toBeLessThan(1e-7);
    // Stepping from here stays on the grid.
    for (let i = 0; i < 8; i++) sim.step();
    expect(sim.peek().simUt).toBe(utOfTick(nearestTick(s1.simUt) + 8));
  });

  it('the debug time change lands on the nearest tick', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-setut', 'earth', 300000, 400000, 4), terrain);
    const t = sim.peek().simUt + 1234.5678;
    sim.debug.setUt(t);
    expect(sim.peek().simUt).toBe(snapToTick(t));
    sim.step();
    expect(sim.peek().simUt).toBe(utOfTick(nearestTick(t) + 1));
  });
});

describe('the real-time loop on rails', () => {
  it('lands on ticks at any frame rate while the presented time advances by exactly the warped frame time', async () => {
    for (const hz of [60, 144, 240, 37.3]) {
      const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, `t-frames-${hz}`, 'earth', 300000, 400000, 4), terrain);
      expect(sim.commands.setWarpLevel(4).ok).toBe(true);
      const factor = sim.peek().warp.factor;
      expect(factor).toBe(5);
      const frame = 1 / hz;
      const first = sim.snapshot();
      let presented = first.ut;
      let ticksBefore = nearestTick(first.simUt);
      let total = 0;
      const perFrame = new Set<number>();
      for (let i = 0; i < 400; i++) {
        sim.advance(frame);
        const s = sim.snapshot();
        expect(onGrid(s)).toBe(true);
        expect(s.warp.onRails).toBe(true);
        // Presentation: continuous, behind the state by less than a tick.
        expect(s.simUt - s.ut).toBeGreaterThanOrEqual(-1e-6);
        expect(s.simUt - s.ut).toBeLessThan(PHYSICS_DT + 1e-6);
        expect(Math.abs(s.ut - presented - frame * factor)).toBeLessThan(2e-6);
        presented = s.ut;
        const ticks = nearestTick(s.simUt);
        perFrame.add(ticks - ticksBefore);
        total += ticks - ticksBefore;
        ticksBefore = ticks;
      }
      // No drift: the state has moved on by the warped time, to within a tick.
      expect(Math.abs(total - 400 * frame * factor * TICKS_PER_SECOND)).toBeLessThanOrEqual(1);
      // At 60 Hz every frame is the same whole number of ticks; elsewhere the count alternates around the mean.
      if (hz === 60) expect([...perFrame]).toEqual([10]);
      else expect(perFrame.size).toBeGreaterThan(1);
    }
  });
});
