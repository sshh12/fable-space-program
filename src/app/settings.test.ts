/**
 * The scenario the game opens when none is asked for (`defaultScenario`): the first mission scenario in id
 * order whose vehicle can be shown. The library holds vehicles whose models are not authored yet
 * (src/core/access/presentable.ts), and their scenarios sort before the lunar mission's: a page opened without
 * `?scenario=` must not start on a vehicle that is not drawn.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { firstPresentableVehicleId, isPresentableVehicle } from '@/core/access/presentable';
import type { DefLibrary, ScenarioDef } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { defaultScenario, isMissionScenario, resolveScenario } from './settings';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

/** The library with these scenarios only: copies of a mission scenario of the repository, each on its vehicle. */
function withScenarios(scenarios: Record<string, { vehicle: string; mission: boolean }>): DefLibrary {
  const mission = Object.values(defs.scenarios).find(isMissionScenario)!;
  const out: Record<string, ScenarioDef> = {};
  for (const [id, s] of Object.entries(scenarios)) out[id] = { ...mission, id, vehicle: s.vehicle, milestones: s.mission ? mission.milestones : [] };
  return { ...defs, scenarios: out };
}

describe('the scenario the game opens when none is asked for', () => {
  it('is a mission scenario of the repository that flies a presentable vehicle', () => {
    const id = defaultScenario(defs);
    const scenario = defs.scenarios[id]!;
    expect(isMissionScenario(scenario), id).toBe(true);
    expect(isPresentableVehicle(defs, scenario.vehicle), `${id} flies ${scenario.vehicle}`).toBe(true);
    expect(resolveScenario(defs, null)).toBe(id);
    // The mission scenarios before it in id order fly vehicles that cannot be shown yet (none = nothing was passed over).
    const before = Object.keys(defs.scenarios).sort().filter((s) => s < id && isMissionScenario(defs.scenarios[s]!));
    for (const s of before) expect(isPresentableVehicle(defs, defs.scenarios[s]!.vehicle), s).toBe(false);
    console.log(`default scenario: ${id} (${scenario.vehicle}); mission scenarios passed over: ${before.join(', ') || 'none'}`);
  });

  it('passes over a mission scenario whose vehicle cannot be shown, in id order', () => {
    const shown = firstPresentableVehicleId(defs)!;
    // A vehicle that cannot be shown: here one the library does not hold (a vehicle with a part without a
    // visual gets the same answer of `isPresentableVehicle`: tests/unit/fakes/presentable.test.ts).
    const hidden = 'not-in-the-library';
    const pick = (scenarios: Record<string, { vehicle: string; mission: boolean }>): string => defaultScenario(withScenarios(scenarios));
    expect(pick({ 'a-first': { vehicle: hidden, mission: true }, 'b-second': { vehicle: shown, mission: true }, 'c-third': { vehicle: shown, mission: true } })).toBe('b-second');
    // A scenario that is no mission proof is not the default, whatever it flies.
    expect(pick({ 'a-first': { vehicle: shown, mission: false }, 'b-second': { vehicle: hidden, mission: true }, 'c-third': { vehicle: shown, mission: true } })).toBe('c-third');
    // No mission scenario flies a presentable vehicle: the first mission scenario, as before; no mission at all: the first scenario.
    expect(pick({ 'a-first': { vehicle: shown, mission: false }, 'b-second': { vehicle: hidden, mission: true } })).toBe('b-second');
    expect(pick({ 'b-second': { vehicle: hidden, mission: false }, 'a-first': { vehicle: shown, mission: false } })).toBe('a-first');
    // Asked for by name, a scenario is opened whatever it flies.
    expect(resolveScenario(withScenarios({ 'a-first': { vehicle: hidden, mission: true }, 'b-second': { vehicle: shown, mission: true } }), 'a-first')).toBe('a-first');
  });

  it('with the visual of one of its parts gone, the vehicle of the default scenario is passed over like any other', () => {
    const id = defaultScenario(defs);
    const vehicle = defs.scenarios[id]!.vehicle;
    const part = Object.values(defs.parts).find((p) => p.visual !== null && !isPresentableVehicle({ ...defs, parts: { ...defs.parts, [p.id]: { ...p, visual: null } } }, vehicle))!;
    const stripped: DefLibrary = { ...defs, parts: { ...defs.parts, [part.id]: { ...part, visual: null } } };
    expect(isPresentableVehicle(stripped, vehicle)).toBe(false);
    const next = defaultScenario(stripped);
    // Another mission scenario on a vehicle that can still be shown, or (none left) the first mission scenario in id order.
    const missions = Object.keys(stripped.scenarios).sort().filter((s) => isMissionScenario(stripped.scenarios[s]!));
    const presentable = missions.filter((s) => isPresentableVehicle(stripped, stripped.scenarios[s]!.vehicle));
    expect(next).toBe(presentable[0] ?? missions[0]);
    if (presentable.length > 0) expect(stripped.scenarios[next]!.vehicle).not.toBe(vehicle);
  });
});
