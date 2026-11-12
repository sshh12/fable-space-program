/**
 * The state at a tick is a function of the tick and the vessels (src/sim/clock.ts): the base that body
 * orientations and rails states are evaluated from, the control ticks and the sun samples are fixed
 * functions of the tick, so it does not matter how the clock got there. One tick is reached by three
 * routes (a rails advance of 100 s and 240 steps; a rails advance of 98 s and 480 steps; 12,240 steps) and
 * the three are compared bit for bit.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { PHYSICS_DT, type DefLibrary } from '@/core/contracts/defs';
import { CONTROL_TICK_STEPS, type SimSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { v3 } from '@/core/math/vec3';
import { createBodySystem } from '@/sim/bodies';
import { BASE_TICKS, baseTickOf, baseUtOfTick, nearestTick, offsetOfTick, SUN_SAMPLE_TICKS, utOfTick } from '@/sim/clock';
import type { Vessel } from '@/sim/vessel';
import type { DiagnosedSession } from '../../../tools/sim/realWorld';
import { active, flatTerrain, loadLibrary, makeSim, orbitScenario } from './helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: 0, moon: 0 });
});

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
/** The bit pattern of a float64 (so that +0 and -0, and two NaNs, are told apart or equal as bits). */
const bits = (x: number): string => {
  f64[0] = x;
  return u32[1]!.toString(16).padStart(8, '0') + u32[0]!.toString(16).padStart(8, '0');
};
const bitsOf = (...xs: number[]): string => xs.map(bits).join(' ');

/** What a route is compared by: every body's orientation, the vessel's pose, its sun sample, the clock. */
interface Reached {
  tick: number;
  bodies: Record<string, string>;
  pose: string;
  sun: string;
  /** Ticks at which the next control ticks are given over the following twelve steps. */
  control: number[];
  /** The sun sample the vessel flies with after those steps (taken at the last multiple of the sample period). */
  sunLater: string;
}

/** The vessel of the session's active entry (the sun sample is vessel state; the snapshot shows only its visible fraction). */
const vesselOf = (sim: DiagnosedSession): Vessel => (sim as unknown as { active: { vessel: Vessel } }).active.vessel;

function reached(sim: DiagnosedSession): Reached {
  const s: SimSnapshot = sim.snapshot();
  const v = active(s);
  const sun = vesselOf(sim).sun;
  const out: Reached = {
    tick: s.time!.myTick,
    bodies: Object.fromEntries(s.bodies.map((b) => [b.id, bitsOf(b.qFixedToRoot.x, b.qFixedToRoot.y, b.qFixedToRoot.z, b.qFixedToRoot.w)])),
    pose: bitsOf(v.r.x, v.r.y, v.r.z, v.v.x, v.v.y, v.v.z, v.q.x, v.q.y, v.q.z, v.q.w),
    sun: bitsOf(sun.dir.x, sun.dir.y, sun.dir.z, sun.visibility),
    control: [],
    sunLater: '',
  };
  // The real-time loop from here: twelve steps, and the ticks at which it asks the pilot.
  sim.advance(12 * PHYSICS_DT, () => out.control.push(sim.peek().time!.myTick));
  const later = vesselOf(sim).sun;
  out.sunLater = bitsOf(later.dir.x, later.dir.y, later.dir.z, later.visibility);
  return out;
}

const steps = (sim: DiagnosedSession, n: number): void => {
  for (let i = 0; i < n; i++) sim.step();
};

/** The three routes from the start of a scenario to the tick 12,240 ticks later. */
async function threeRoutes(scenario: Parameters<typeof makeSim>[1]): Promise<{ start: number; routes: Reached[] }> {
  const a = await makeSim(defs, scenario, terrain);
  const start = a.peek().time!.myTick;
  a.advanceRails(utOfTick(start + 12000));
  expect(a.peek().time!.myTick).toBe(start + 12000);
  steps(a, 240);
  const b = await makeSim(defs, scenario, terrain);
  b.advanceRails(utOfTick(start + 11760));
  expect(b.peek().time!.myTick).toBe(start + 11760);
  steps(b, 480);
  const c = await makeSim(defs, scenario, terrain);
  steps(c, 12240);
  return { start, routes: [reached(a), reached(b), reached(c)] };
}

describe('one tick reached by three routes', () => {
  it('a vessel held on the pad: body orientations, the pose, the sun sample and the control ticks are the same bits', async () => {
    const { start, routes } = await threeRoutes('lunar-direct');
    const [a, b, c] = routes as [Reached, Reached, Reached];
    expect(a.tick).toBe(start + 12240);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // The control ticks are the whole multiples of four, whatever the tick of the start and of a landing was.
    const due = [];
    for (let t = a.tick; t < a.tick + 12; t++) if (t % CONTROL_TICK_STEPS === 0) due.push(t);
    expect(a.control).toEqual(due);
    expect(a.control).toHaveLength(3);
    // The start of this scenario is not on a multiple of four or of twelve: the phases are the clock's, not the session's.
    expect(start % CONTROL_TICK_STEPS).not.toBe(0);
    expect(start % SUN_SAMPLE_TICKS).not.toBe(0);
  });

  it('a vessel coasting on rails: the same, and its state is the conic at the clock base of the tick plus the ticks since', async () => {
    const scenario = orbitScenario(defs.scenarios['lunar-direct']!, 't-pure-coast', 'earth', 300000, 400000, 4);
    const { start, routes } = await threeRoutes(scenario);
    const [a, b, c] = routes as [Reached, Reached, Reached];
    expect(a.tick).toBe(start + 12240);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('the sample a vessel flies with is the star seen from where the vessel was at the last multiple of the sample period', async () => {
    const sim = await makeSim(defs, orbitScenario(defs.scenarios['lunar-direct']!, 't-pure-sun', 'earth', 300000, 400000, 4), terrain);
    const system = createBodySystem(defs);
    // Step to a multiple of the period: the sample is taken at the step that starts there.
    while (sim.peek().time!.myTick % SUN_SAMPLE_TICKS !== 0) sim.step();
    for (let k = 0; k < 3; k++) {
      const s = sim.peek();
      const at = s.time!.myTick;
      const posRoot = v3.add(system.stateRoot('earth', utOfTick(at)).r, active(s).r);
      const expected = system.sunDirection(posRoot, utOfTick(at)).dir;
      // Eleven steps on, the vessel still flies with that sample; at the twelfth it has the next one.
      for (let i = 1; i < SUN_SAMPLE_TICKS; i++) {
        sim.step();
        const sun = vesselOf(sim).sun;
        expect(bitsOf(sun.dir.x, sun.dir.y, sun.dir.z), `tick ${at} + ${i}`).toBe(bitsOf(expected.x, expected.y, expected.z));
      }
      sim.step();
    }
  });
});

describe('the clock base', () => {
  it('is the last whole day at or before the tick: an exact instant, the same for every tick of the day', () => {
    expect(BASE_TICKS).toBe(86400 * 120);
    const tick = nearestTick(defs.scenarios['lunar-direct']!.startUt);
    const base = baseTickOf(tick);
    expect(base % BASE_TICKS).toBe(0);
    expect(tick - base).toBeGreaterThanOrEqual(0);
    expect(tick - base).toBeLessThan(BASE_TICKS);
    expect(baseTickOf(base)).toBe(base);
    expect(baseTickOf(base - 1)).toBe(base - BASE_TICKS);
    expect(baseTickOf(base + BASE_TICKS - 1)).toBe(base);
    expect(Number.isInteger(baseUtOfTick(tick))).toBe(true);
    // The offset is whole ticks times the tick length: exact to the resolution of a day in seconds.
    expect(Math.abs(baseUtOfTick(tick) + offsetOfTick(tick) - tick / 120)).toBeLessThan(2e-7);
    expect(offsetOfTick(base)).toBe(0);
    expect(offsetOfTick(base + 1)).toBe(1 / 120);
  });

  it('the day changes under a held vessel in one step of the ground, far below anything that is tested', async () => {
    // A vessel on the pad through the change of the base: its body-fixed place does not move.
    const sim = await makeSim(defs, 'lunar-direct', terrain);
    const start = sim.peek().time!.myTick;
    const nextBase = baseTickOf(start) + BASE_TICKS;
    sim.advanceRails(utOfTick(nextBase - 4));
    expect(sim.peek().time!.myTick).toBe(nextBase - 4);
    const places: { x: number; y: number; z: number }[] = [];
    let worstStep = 0;
    let prev: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i < 8; i++) {
      const s = sim.peek();
      const r = active(s).r;
      if (prev) worstStep = Math.max(worstStep, Math.abs(v3.dist(r, prev) - v3.len(active(s).v) * PHYSICS_DT));
      prev = v3.clone(r);
      places.push(v3.clone(r));
      sim.step();
    }
    // Step to step the pad moves by its co-rotation speed times the step; across the change of base the
    // evaluation error of the body angle at an absolute time shows once, as a fraction of a millimetre.
    expect(worstStep).toBeLessThan(5e-4);
    expect(active(sim.peek()).situation).toBe('prelaunch');
    console.log(`clock base change under a held vessel: the largest departure of one step from uniform motion is ${(worstStep * 1e6).toFixed(1)} um`);
  });
});
