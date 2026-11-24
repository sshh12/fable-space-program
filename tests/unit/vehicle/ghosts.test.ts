/**
 * Which vessels the vessel feature shows fading out after they left the snapshot (`departedVessels`): debris
 * that expired does, a vessel that was destroyed does not, and a vessel that docked does not either: its parts
 * are drawn by the vessel that absorbed it, and a fading copy would be the same hardware twice.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { firstPresentableVehicleId } from '@/core/access/presentable';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimEvent, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { partKey } from '@/core/access/snapshotAccess';
import { departedVessels } from '@/render/vehicle/vesselFeature';
import { assembleVessel, vesselPartSnapshots } from '@/sim/vessel/public';

let defs: DefLibrary;
let base: SimSnapshot;

beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
  base = createFakeSim(defs, { scene: 'lowOrbit' }).peek();
});

/** A vessel `id` of one launched craft `craft-<id>` of the library's first presentable vehicle. */
const vesselOf = (id: string): VesselSnapshot => {
  const craftId = `craft-${id}`;
  const parts = vesselPartSnapshots(assembleVessel(defs, firstPresentableVehicleId(defs)!, { craft: { craftId, ownerId: null, name: id, joinedTick: 0 } }));
  return { ...base.vessels[0]!, id, parts, crafts: [{ ...base.vessels[0]!.crafts![0]!, id: craftId, parent: null }] };
};

const snapshotOf = (vessels: VesselSnapshot[], events: SimEvent[] = []): SimSnapshot => ({ ...base, vessels, events, activeVesselId: vessels[0]!.id });

const ids = (vessels: VesselSnapshot[]): string[] => vessels.map((v) => v.id);

describe('the vessels that fade out after they left the snapshot', () => {
  it('a vessel that docked leaves no fading copy: the vessel that absorbed it draws its parts', () => {
    const station = vesselOf('station');
    const tug = vesselOf('tug');
    const before = snapshotOf([station, tug]);
    // Hard dock: the tug's parts and its craft are the station's from this snapshot on, and the tug's id is gone.
    const merged: VesselSnapshot = { ...station, parts: [...station.parts, ...tug.parts], crafts: [...station.crafts!, ...tug.crafts!] };
    const port = (v: VesselSnapshot): string => partKey(v.crafts![0]!.id, v.parts[0]!.instanceId);
    const docked: SimEvent = { type: 'docked', ut: base.ut, vesselId: 'station', partId: port(station), otherPartId: port(tug), absorbedVesselId: 'tug' };
    expect(departedVessels(before, snapshotOf([merged], [docked]))).toEqual([]);
    // The same snapshot without the event (or with the docking of another pair) is a vessel that went away: it fades.
    expect(ids(departedVessels(before, snapshotOf([merged])))).toEqual(['tug']);
    expect(ids(departedVessels(before, snapshotOf([merged], [{ ...docked, absorbedVesselId: 'other' }])))).toEqual(['tug']);
    // Only the vessel the event names as absorbed: debris that expires in the snapshot of a docking still fades.
    const debris = vesselOf('debris');
    expect(ids(departedVessels(snapshotOf([station, tug, debris]), snapshotOf([merged], [docked])))).toEqual(['debris']);
  });

  it('expired debris fades, a destroyed vessel does not, and a vessel still in the snapshot is not looked at', () => {
    const ship = vesselOf('ship');
    const a = vesselOf('a');
    const b = vesselOf('b');
    const c = vesselOf('c');
    const before = snapshotOf([ship, a, b, c]);
    const removed = (vesselId: string, reason: 'expired' | 'impact' | 'burnedUp'): SimEvent => ({ type: 'vesselRemoved', ut: base.ut, vesselId, reason });
    expect(departedVessels(before, before)).toEqual([]);
    expect(ids(departedVessels(before, snapshotOf([ship], [removed('a', 'expired'), removed('b', 'impact'), removed('c', 'burnedUp')])))).toEqual(['a']);
    // A removal without an event (a snapshot a session did not explain) fades as before.
    expect(ids(departedVessels(before, snapshotOf([ship, b])))).toEqual(['a', 'c']);
  });
});
