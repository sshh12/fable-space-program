/**
 * Rails equivalence of the tick-grid step (MIGRATION_V2 step 3.1; lead decision in
 * docs/requests/sim-core-v2-1.md, item 2): the Kepler propagator (src/sim/orbit) is untouched by the step,
 * only the instants a rails advance lands on moved to whole ticks. From the state of every coast milestone
 * of the v1 baseline (tests/mission/baseline-v1.json), rails advances to a handful of later instants land on
 * ticks and give the state of the conic evaluated at that tick by the propagator itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, ScenarioDef } from '@/core/contracts/defs';
import { PHYSICS_DT } from '@/core/contracts/defs';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { v3 } from '@/core/math/vec3';
import { ceilTick, isTickInstant, nearestTick, snapToTick } from '@/sim/clock';
import { makeOrbit, propagate } from '@/sim/orbit';
import { repoRoot } from '../../../tools/sim/realWorld';
import { active, comState, flatTerrain, loadLibrary, makeSim } from './helpers';

interface BaselineMilestone {
  id: string;
  captureUt: number;
  bodyId: string;
  situation: string;
  r: [number, number, number];
  v: [number, number, number];
  data: Record<string, number>;
}

/** Milestones of the mission whose state is a coast outside every atmosphere. */
const COAST = ['EARTH_ORBIT', 'TLI_COMPLETE', 'MOON_SOI_ENTER', 'LUNAR_ORBIT', 'MOON_SOI_EXIT', 'EARTH_PERIGEE_TARGETED'];
/** Requested advances, s: inside a tick, irrational, a whole number of ticks, minutes, hours. */
const LEGS = [0.004, Math.PI, 100, 1234.56789, 3 * 3600 + 0.001];

let defs: DefLibrary;
let terrain: TerrainProvider;
let milestones: BaselineMilestone[];
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: -100, moon: 0 });
  milestones = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'mission', 'baseline-v1.json'), 'utf8')) as { milestones: BaselineMilestone[] }).milestones;
});

describe('rails advances from the coast states of the v1 baseline', () => {
  it('land on whole ticks and give the conic evaluated at the landing tick', async () => {
    let worstPosition = 0;
    let worstRelative = 0;
    let worstVelocity = 0;
    let landings = 0;
    for (const id of COAST) {
      const m = milestones.find((x) => x.id === id);
      expect(m, id).toBeDefined();
      const base = defs.scenarios['lunar-direct']!;
      const scenario: ScenarioDef = {
        ...base,
        id: `t-coast-${id.toLowerCase()}`,
        name: id,
        startUt: snapToTick(m!.captureUt),
        start: { kind: 'state', bodyId: m!.bodyId, r: m!.r, v: m!.v, attitude: 'prograde' },
        stagesAlreadyFired: m!.data['stagesFired']!,
        milestones: [],
      };
      const sim = await makeSim(defs, scenario, terrain);
      const s0 = sim.peek();
      expect(active(s0).translationMode, id).toBe('rails');
      const c0 = comState(active(s0));
      const orbit = makeOrbit(m!.bodyId, defs.bodies[m!.bodyId]!.mu, c0.r, c0.v, s0.simUt);
      let ut = s0.simUt;
      for (const leg of LEGS) {
        const request = ut + leg;
        // A leg that would pass the next event of this coast is not flown here (the events have their own tests).
        if (!(sim.nextEventUt > request + 1)) break;
        const reached = sim.advanceRails(request);
        expect(isTickInstant(reached), `${id} +${leg} s`).toBe(true);
        expect(nearestTick(reached)).toBe(ceilTick(request));
        expect(reached - request).toBeLessThan(PHYSICS_DT);
        const c = comState(active(sim.peek()));
        const ref = propagate(orbit, reached);
        const dr = v3.dist(c.r, ref.r);
        worstPosition = Math.max(worstPosition, dr);
        worstRelative = Math.max(worstRelative, dr / v3.len(ref.r));
        worstVelocity = Math.max(worstVelocity, v3.dist(c.v, ref.v));
        landings++;
        ut = reached;
      }
    }
    expect(landings).toBeGreaterThanOrEqual(24);
    // Measured: 0 m and 0 m/s at all 30 landings (the world's rails state IS that evaluation). Against the v1
    // clock asked for the same tick instants from the same six states, 36 of 36 landings were bit-identical
    // in position and velocity (one-off measurement while the v1 clock could be run; docs/handoff/sim-core-v2.md).
    expect(worstPosition).toBeLessThan(1e-6);
    expect(worstRelative).toBeLessThan(1e-13);
    expect(worstVelocity).toBeLessThan(1e-9);
    console.log(`rails equivalence: ${landings} landings from ${COAST.length} coast states; worst ${worstPosition.toExponential(2)} m (${worstRelative.toExponential(2)} of the radius), ${worstVelocity.toExponential(2)} m/s from the conic at the landing tick`);
  });
});
