/**
 * Which vehicles of a library can be shown (src/core/access/presentable.ts; lead decision of 2026-11-24,
 * requests fleet-data-2 and capability-settings-2): a vehicle is presentable when every one of its parts has
 * a visual definition. On a small library made here (a vehicle with all its models, one with a part that has
 * none, one with a part the library does not know) and on the library of the repository.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, PartDef, VehicleDef } from '@/core/contracts/defs';
import { firstPresentableVehicleId, isPresentableVehicle, isPresentableVessel, partHasVisual, partsWithoutVisual, presentableLibrary, presentableVehicleIds, presentableVehicles } from '@/core/access/presentable';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';

let real: DefLibrary;
beforeAll(async () => {
  real = await loadDefs(fsDefSource());
});

/** A library of the repository's shape with the given parts (true = it has a visual) and vehicles (their part definitions). */
function library(parts: Record<string, boolean>, vehicles: Record<string, string[]>): DefLibrary {
  const withVisual = Object.values(real.parts).find((p) => p.visual !== null)!;
  const partDefs: Record<string, PartDef> = {};
  for (const [id, has] of Object.entries(parts)) partDefs[id] = { ...withVisual, id, visual: has ? withVisual.visual : null };
  const template = Object.values(real.vehicles)[0]!;
  const vehicleDefs: Record<string, VehicleDef> = {};
  for (const [id, defsOfParts] of Object.entries(vehicles)) {
    vehicleDefs[id] = { ...template, id, parts: defsOfParts.map((def, i) => ({ ...template.parts[0]!, id: `p${i}`, def, parent: i === 0 ? null : 'p0' })) };
  }
  return { ...real, parts: partDefs, vehicles: vehicleDefs };
}

describe('presentable vehicles: a function of the definitions', () => {
  const made = (): DefLibrary =>
    library(
      { tank: true, engine: true, probe: false, bus: false },
      { ready: ['tank', 'engine', 'engine'], 'one-missing': ['tank', 'probe', 'engine'], 'none-yet': ['bus', 'probe'], 'unknown-part': ['tank', 'not-in-the-library'], 'also-ready': ['engine'] },
    );

  it('a vehicle is presentable when every one of its parts has a visual definition', () => {
    const defs = made();
    expect(isPresentableVehicle(defs, 'ready')).toBe(true);
    expect(isPresentableVehicle(defs, 'also-ready')).toBe(true);
    expect(isPresentableVehicle(defs, 'one-missing')).toBe(false);
    expect(isPresentableVehicle(defs, 'none-yet')).toBe(false);
    // A part the library does not hold cannot be shown; a vehicle the library does not hold is not presentable.
    expect(isPresentableVehicle(defs, 'unknown-part')).toBe(false);
    expect(isPresentableVehicle(defs, 'no-such-vehicle')).toBe(false);
  });

  it('lists the presentable vehicles in the library order, and the first of them', () => {
    const defs = made();
    expect(presentableVehicleIds(defs)).toEqual(['ready', 'also-ready']);
    expect(presentableVehicles(defs).map((v) => v.id)).toEqual(['ready', 'also-ready']);
    expect(firstPresentableVehicleId(defs)).toBe('ready');
    // The first vehicle of a library need not be presentable: a lab that takes "the first" takes this one.
    const reordered = library({ tank: true, probe: false }, { early: ['probe'], later: ['tank'] });
    expect(Object.keys(reordered.vehicles)[0]).toBe('early');
    expect(firstPresentableVehicleId(reordered)).toBe('later');
    expect(firstPresentableVehicleId(library({ probe: false }, { only: ['probe'] }))).toBeNull();
    expect(presentableVehicleIds(library({ probe: false }, { only: ['probe'] }))).toEqual([]);
  });

  it('names the parts that cannot be shown, each once, in the order they appear', () => {
    const defs = made();
    expect(partHasVisual(defs, 'tank')).toBe(true);
    expect(partHasVisual(defs, 'probe')).toBe(false);
    expect(partHasVisual(defs, 'not-in-the-library')).toBe(false);
    expect(partsWithoutVisual(defs, ['tank', 'probe', 'engine', 'bus', 'probe', 'not-in-the-library'])).toEqual(['probe', 'bus', 'not-in-the-library']);
    expect(partsWithoutVisual(defs, ['tank', 'engine'])).toEqual([]);
    expect(partsWithoutVisual(defs, [])).toEqual([]);
  });

  it('judges a vessel of a snapshot by its own parts', () => {
    const defs = made();
    const vessel = (...parts: string[]): { parts: { def: string }[] } => ({ parts: parts.map((def) => ({ def })) });
    expect(isPresentableVessel(defs, vessel('tank', 'engine'))).toBe(true);
    // A piece that is left of a vehicle with a part without a model is shown when the part went with the other piece.
    expect(isPresentableVessel(defs, vessel('tank', 'probe'))).toBe(false);
    expect(isPresentableVessel(defs, vessel('tank'))).toBe(true);
    expect(isPresentableVessel(defs, vessel('not-in-the-library'))).toBe(false);
    // What a session keeps in view of a destroyed vessel has no parts: nothing to draw, nothing missing.
    expect(isPresentableVessel(defs, vessel())).toBe(true);
  });

  it('gives the library of what can be shown: its presentable vehicles and the scenarios that fly them', () => {
    const defs = made();
    const scenario = Object.values(real.scenarios)[0]!;
    const withScenarios: DefLibrary = { ...defs, scenarios: { a: { ...scenario, id: 'a', vehicle: 'ready' }, b: { ...scenario, id: 'b', vehicle: 'one-missing' }, c: { ...scenario, id: 'c', vehicle: 'also-ready' } } };
    const shown = presentableLibrary(withScenarios);
    expect(Object.keys(shown.vehicles)).toEqual(['ready', 'also-ready']);
    expect(Object.keys(shown.scenarios)).toEqual(['a', 'c']);
    expect(shown.parts).toBe(withScenarios.parts);
    expect(presentableVehicleIds(shown)).toEqual(['ready', 'also-ready']);
  });

  it('is answered from the definitions as they are when asked: another library, another answer', () => {
    const before = library({ tank: true, probe: false }, { v: ['tank', 'probe'] });
    const after = library({ tank: true, probe: true }, { v: ['tank', 'probe'] });
    expect(isPresentableVehicle(before, 'v')).toBe(false);
    expect(isPresentableVehicle(after, 'v')).toBe(true);
  });
});

describe('presentable vehicles: the library of the repository', () => {
  it('the lunar stack is presentable (every reference image shows it)', () => {
    expect(isPresentableVehicle(real, 'meridian-lunar')).toBe(true);
    expect(presentableVehicleIds(real)).toContain('meridian-lunar');
    expect(firstPresentableVehicleId(real)).not.toBeNull();
  });

  it('every vehicle is either presentable, with a visual for each of its parts, or has a part without one', () => {
    const presentable = new Set(presentableVehicleIds(real));
    expect(presentable.size).toBeGreaterThanOrEqual(1);
    // Every part of a presentable vehicle has its visual ...
    for (const vehicle of presentableVehicles(real)) for (const p of vehicle.parts) expect(real.parts[p.def]!.visual, `${vehicle.id}: ${p.def}`).not.toBeNull();
    // ... and a vehicle that is not presentable is flown by a scenario whose vessel has a part without one
    // (the scenarios are how a session comes by such a vessel), or by none.
    const others = Object.keys(real.vehicles).filter((id) => !presentable.has(id));
    for (const id of others) expect(isPresentableVehicle(real, id)).toBe(false);
    expect(Object.keys(presentableLibrary(real).vehicles)).toEqual([...presentable]);
    console.log(`presentable: ${[...presentable].join(', ')}; not yet: ${others.join(', ')}`);
  });
});
