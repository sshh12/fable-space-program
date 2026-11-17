import { describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { VesselSnapshot } from '@/core/contracts/sim';
import { seatName } from './seat';

/** Definitions with a capsule part and (optionally) a cockpit layout section with a seat label; no vehicle: none is read. */
function defs(label?: string): DefLibrary {
  return {
    bodies: {},
    rootBodyId: '',
    sites: {},
    resources: {},
    parts: { capsule: { id: 'capsule', modules: [{ type: 'command', seats: [{ id: 'cdr' }, { id: 'plt' }] }] } },
    vehicles: {},
    scenarios: {},
    sections: label === undefined ? {} : { 'visuals/cockpits/cabin': { couches: { seats: { plt: { label } } } } },
  } as unknown as DefLibrary;
}

/** A vessel of one craft whose command part has the cabin `cabin` and whose craft states its crew, as a session states them. */
const vessel = {
  id: 'v',
  vehicleId: 'craft',
  crafts: [{ id: 'v', vehicleId: 'craft', commandPart: 'capsule-1', cockpit: { id: 'cabin', cameraSeat: 'cdr', sensorMount: null, crew: [{ seat: 'cdr', name: 'Ilse Marwen' }] } }],
  parts: [{ instanceId: 'capsule-1', craftId: 'v', def: 'capsule' }],
} as unknown as VesselSnapshot;

describe('seatName', () => {
  it("is the cockpit layout's label where the layout has one", () => {
    expect(seatName(defs('Pilot, centre couch'), vessel, 'plt')).toBe('Pilot, centre couch');
  });

  it('is the crew member the craft states for the seat where the layout has no label', () => {
    expect(seatName(defs(), vessel, 'cdr')).toBe('Ilse Marwen');
    expect(seatName(defs('Pilot, centre couch'), vessel, 'cdr')).toBe('Ilse Marwen');
  });

  it('is the seat id where nothing names it, and for a vessel without a cabin', () => {
    expect(seatName(defs(), vessel, 'plt')).toBe('plt');
    expect(seatName(defs(), { ...vessel, vehicleId: 'unknown', crafts: [], parts: [] } as unknown as VesselSnapshot, 'ms')).toBe('ms');
    // The craft with the cabin states the crew: the vessel's vehicle id is never looked up.
    const other = { ...vessel, vehicleId: 'unknown' } as unknown as VesselSnapshot;
    expect(seatName(defs(), other, 'cdr')).toBe('Ilse Marwen');
    // A craft that states no crew (a producer older than the field) is named by its seat ids.
    const silent = { ...vessel, crafts: [{ id: 'v', vehicleId: 'craft', commandPart: 'capsule-1', cockpit: { id: 'cabin', cameraSeat: 'cdr', sensorMount: null } }] } as unknown as VesselSnapshot;
    expect(seatName(defs(), silent, 'cdr')).toBe('cdr');
  });
});
