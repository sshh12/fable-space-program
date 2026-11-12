import { describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { VesselSnapshot } from '@/core/contracts/sim';
import { seatName } from './seat';

/** Definitions with one vehicle, its capsule part and (optionally) a cockpit layout section with a seat label. */
function defs(label?: string): DefLibrary {
  return {
    bodies: {},
    rootBodyId: '',
    sites: {},
    resources: {},
    parts: { capsule: { id: 'capsule', modules: [{ type: 'command', seats: [{ id: 'cdr' }, { id: 'plt' }] }] } },
    vehicles: {
      craft: { id: 'craft', cockpit: 'cabin', cameras: { cockpit: { part: 'capsule-1', seat: 'cdr' } }, crew: [{ seat: 'cdr', name: 'Ilse Marwen' }] },
    },
    scenarios: {},
    sections: label === undefined ? {} : { 'visuals/cockpits/cabin': { couches: { seats: { plt: { label } } } } },
  } as unknown as DefLibrary;
}

const vessel = { id: 'v', vehicleId: 'craft', parts: [{ instanceId: 'capsule-1', def: 'capsule' }] } as unknown as VesselSnapshot;

describe('seatName', () => {
  it("is the cockpit layout's label where the layout has one", () => {
    expect(seatName(defs('Pilot, centre couch'), vessel, 'plt')).toBe('Pilot, centre couch');
  });

  it('is the crew member the vehicle puts in the seat where the layout has no label', () => {
    expect(seatName(defs(), vessel, 'cdr')).toBe('Ilse Marwen');
    expect(seatName(defs('Pilot, centre couch'), vessel, 'cdr')).toBe('Ilse Marwen');
  });

  it('is the seat id where nothing names it, and for a vessel without a known vehicle', () => {
    expect(seatName(defs(), vessel, 'plt')).toBe('plt');
    expect(seatName(defs(), { ...vessel, vehicleId: 'unknown', parts: [] } as unknown as VesselSnapshot, 'ms')).toBe('ms');
  });
});
