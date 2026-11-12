import { describe, expect, it } from 'vitest';
import type { SimEvent, SimSnapshot } from '@/core/contracts/sim';
import { createPictureStops, type PictureStop } from './pictureStops';

/** A snapshot with only what the stops read. */
function snap(ut: number, over: { milestones?: [string, number][]; events?: Partial<SimEvent>[]; radar?: number; vertical?: number; heat?: number; g?: number; bodyId?: string } = {}): SimSnapshot {
  return {
    ut,
    activeVesselId: 'ship',
    vessels: [{ id: 'ship', bodyId: over.bodyId ?? 'home' }],
    milestones: (over.milestones ?? []).map(([id, t]) => ({ id, ut: t, data: {} })),
    events: over.events ?? [],
    readouts: { altitudeRadar: over.radar ?? 1e6, verticalSpeed: over.vertical ?? 0, heatFlux: over.heat ?? 0, gLoad: over.g ?? 0, dynamicPressure: 0 },
  } as unknown as SimSnapshot;
}

describe('picture stops', () => {
  it('fires a milestone stop in the frame the record appears and once only', () => {
    const stops = createPictureStops();
    stops.set([{ id: 'liftoff', trigger: { milestone: 'UP' } }]);
    expect(stops.check(snap(10))).toBeNull();
    expect(stops.check(snap(11, { milestones: [['UP', 10.98]] }))).toEqual({ id: 'liftoff', ut: 11, triggerUt: 10.98 });
    expect(stops.check(snap(12, { milestones: [['UP', 10.98]] }))).toBeNull();
    expect(stops.pending()).toEqual([]);
    expect(stops.fired().map((f) => f.id)).toEqual(['liftoff']);
  });

  it('waits `seconds` of simulation time after the trigger, in the first frame at or past it', () => {
    const stops = createPictureStops();
    stops.set([{ id: 'later', trigger: { milestone: 'UP' }, seconds: 3 }]);
    expect(stops.check(snap(100, { milestones: [['UP', 100]] }))).toBeNull();
    expect(stops.check(snap(102.9, { milestones: [['UP', 100]] }))).toBeNull();
    // A warped frame steps past the moment: the stop is the first frame at or after it.
    expect(stops.check(snap(103.4, { milestones: [['UP', 100]] }))).toEqual({ id: 'later', ut: 103.4, triggerUt: 100 });
  });

  it('takes an event from the one snapshot that carries it, of the active vessel only when asked', () => {
    const stops = createPictureStops();
    stops.set([
      { id: 'splash+0.2', trigger: { event: 'splash', active: true }, seconds: 0.2 },
      { id: 'splash+1', trigger: { event: 'splash', active: true }, seconds: 1 },
    ]);
    // Debris splashes first: not the active vessel.
    expect(stops.check(snap(50, { events: [{ type: 'splash', ut: 49.99, vesselId: 'debris' }] }))).toBeNull();
    expect(stops.check(snap(60, { events: [{ type: 'splash', ut: 59.99, vesselId: 'ship' }] }))).toBeNull();
    // The event is gone from the next snapshots; the stops remember its time.
    expect(stops.check(snap(60.1))).toBeNull();
    expect(stops.check(snap(60.2))?.id).toBe('splash+0.2');
    expect(stops.check(snap(60.5))).toBeNull();
    expect(stops.check(snap(61))).toEqual({ id: 'splash+1', ut: 61, triggerUt: 59.99 });
  });

  it('matches event fields and counts occurrences', () => {
    const stops = createPictureStops();
    stops.set([
      { id: 'on-land', trigger: { event: 'touchdown', match: { surface: 'land' } } },
      { id: 'second-drop', trigger: { event: 'decoupled', occurrence: 2 } },
    ]);
    expect(stops.check(snap(1, { events: [{ type: 'touchdown', ut: 1, vesselId: 'ship', surface: 'water' } as Partial<SimEvent>] }))).toBeNull();
    expect(stops.check(snap(2, { events: [{ type: 'decoupled', ut: 2, vesselId: 'ship' }] }))).toBeNull();
    expect(stops.check(snap(3, { events: [{ type: 'decoupled', ut: 3, vesselId: 'ship' }] }))?.id).toBe('second-drop');
    expect(stops.check(snap(4, { events: [{ type: 'touchdown', ut: 4, vesselId: 'ship', surface: 'land' } as Partial<SimEvent>] }))?.id).toBe('on-land');
  });

  it('fires one stop per frame, the earliest due first, and keeps the other for the next frame', () => {
    const stops = createPictureStops();
    stops.set([
      { id: 'b', trigger: { milestone: 'M' }, seconds: 0.5 },
      { id: 'a', trigger: { milestone: 'M' } },
    ]);
    const s = snap(21, { milestones: [['M', 20]] });
    expect(stops.check(s)?.id).toBe('a');
    expect(stops.pending()).toEqual(['b']);
    expect(stops.check(snap(21.02, { milestones: [['M', 20]] }))?.id).toBe('b');
  });

  it('sees a low radar altitude only while coming down, and only at the named body', () => {
    const stops = createPictureStops();
    stops.set([{ id: 'thirty', trigger: { radarBelow: 30, bodyId: 'moon' } }]);
    expect(stops.check(snap(1, { radar: 20, vertical: -2, bodyId: 'home' }))).toBeNull();
    expect(stops.check(snap(2, { radar: 20, vertical: 3, bodyId: 'moon' }))).toBeNull();
    expect(stops.check(snap(3, { radar: 35, vertical: -2, bodyId: 'moon' }))).toBeNull();
    expect(stops.check(snap(4, { radar: 29, vertical: -2, bodyId: 'moon' }))).toEqual({ id: 'thirty', ut: 4, triggerUt: 4 });
  });

  it('finds the frame just past a peak that reached the floor', () => {
    const stops = createPictureStops();
    stops.set([{ id: 'hot', trigger: { peak: 'heatFlux', floor: 500, drop: 0.05 } }]);
    // A small bump below the floor does not count.
    for (const [t, q] of [[1, 100], [2, 300], [3, 200]] as const) expect(stops.check(snap(t, { heat: q }))).toBeNull();
    for (const [t, q] of [[4, 600], [5, 900], [6, 1000], [7, 980]] as const) expect(stops.check(snap(t, { heat: q }))).toBeNull();
    expect(stops.check(snap(8, { heat: 940 }))).toEqual({ id: 'hot', ut: 8, triggerUt: 8 });
  });

  it('looks for a trigger only once the milestone named in `after` is on record', () => {
    const stops = createPictureStops();
    stops.set([{ id: 'entry-load', trigger: { peak: 'gLoad', floor: 3, drop: 0.05 }, after: 'ENTRY' }]);
    // The ascent pulls 4 g and falls off at staging: not this stop's peak.
    for (const [t, g] of [[1, 2], [2, 4], [3, 1]] as const) expect(stops.check(snap(t, { g }))).toBeNull();
    // After the milestone the maximum starts over: 5 g, then past it.
    const entry: [string, number][] = [['ENTRY', 10]];
    for (const [t, g] of [[10, 0.5], [11, 3.5], [12, 5]] as const) expect(stops.check(snap(t, { g, milestones: entry }))).toBeNull();
    expect(stops.check(snap(13, { g: 4.6, milestones: entry }))).toEqual({ id: 'entry-load', ut: 13, triggerUt: 13 });
  });

  it('keeps what has fired when the list is replaced, and refuses two stops of one name', () => {
    const stops = createPictureStops();
    const list: PictureStop[] = [{ id: 'x', trigger: { milestone: 'M' } }, { id: 'y', trigger: { milestone: 'N' } }];
    stops.set(list);
    expect(stops.check(snap(1, { milestones: [['M', 1]] }))?.id).toBe('x');
    stops.set(list);
    expect(stops.pending()).toEqual(['y']);
    expect(() => stops.set([list[0]!, list[0]!])).toThrow(/two stops/);
  });
});
