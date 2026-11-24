/**
 * The view manager when the viewer's seat is left and regained (src/camera/viewManager.ts). Every flight rig
 * follows the active vessel, so without one the map stands in. That map is not the player's choice: when a
 * seat is there again the manager returns to the flight view it had. A map the player chose stays.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createChaseRig, createCockpitRig, createMapRig, createViewManager, type ViewManager } from '@/camera';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraInput, CameraRig } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { labVehicleParts, tagLabVehicle, withLabVehicle } from '../../../labs/flight-ui/labVehicle';

let defs: DefLibrary;
beforeAll(async () => {
  defs = withLabVehicle(await loadDefs(fsDefSource()));
});

const IDLE: CameraInput = { yaw: 0, pitch: 0, zoom: 1 };
const DT = 1 / 60;

/** Seated in a vessel with a cabin (the lab vehicle), in one whose craft state no cabin, and in none. */
const cabin = (): SimSnapshot => tagLabVehicle(createFakeSim(defs, { scene: 'lowOrbit', parts: labVehicleParts(defs) }).snapshot());
const bare = (): SimSnapshot => {
  const s = cabin();
  return { ...s, vessels: s.vessels.map((v) => ({ ...v, ...(v.crafts ? { crafts: v.crafts.map((c) => ({ ...c, cockpit: null })) } : {}) })) };
};
const unseated = (s: SimSnapshot): SimSnapshot => ({ ...s, activeVesselId: null });

const rigs = (): CameraRig[] => [createChaseRig({ defs }), createCockpitRig({ defs }), createMapRig({ defs })];
const frames = (views: ViewManager, s: SimSnapshot, n: number): void => {
  for (let i = 0; i < n; i++) views.update(s, IDLE, DT);
};

describe('the view manager when the seat is left and regained', () => {
  it('stands in with the map while nobody is seated and returns to the flight view it had when a seat is there again', () => {
    const s = cabin();
    const views = createViewManager(rigs(), { defs, initialMode: 'cockpit' });
    frames(views, s, 3);
    expect(views.mode).toBe('cockpit');
    const away = views.update(unseated(s), IDLE, DT);
    expect(views.mode).toBe('map');
    expect(away.camera.kind).toBe('map');
    // Without a seat neither key leaves the map (there is no flight view to go to).
    views.update(unseated(s), IDLE, DT, new Set(['toggleMap'] as const));
    views.update(unseated(s), IDLE, DT, new Set(['cycleCamera'] as const));
    frames(views, unseated(s), 30);
    expect(views.mode).toBe('map');
    // The seat is back: the cockpit again, in that frame, and M goes to the map and returns to it as ever.
    const back = views.update(s, IDLE, DT);
    expect(views.mode).toBe('cockpit');
    expect(back.target.kind).toBe('interior');
    frames(views, s, 60);
    expect(views.camera!.kind).toBe('interior');
    views.update(s, IDLE, DT, new Set(['toggleMap'] as const));
    expect(views.mode).toBe('map');
    frames(views, s, 60);
    expect(views.mode).toBe('map');
    views.update(s, IDLE, DT, new Set(['toggleMap'] as const));
    expect(views.mode).toBe('cockpit');
  });

  it('a session that opens without a seat starts on the map and takes the flight view it was to start in with the first seat', () => {
    const s = cabin();
    for (const initialMode of ['chase', 'cockpit'] as const) {
      const views = createViewManager(rigs(), { defs, initialMode });
      frames(views, unseated(s), 10);
      expect(views.mode).toBe('map');
      views.update(s, IDLE, DT);
      expect(views.mode).toBe(initialMode);
    }
    // Opened on the map by the app's own choice: it stays there.
    const chosen = createViewManager(rigs(), { defs, initialMode: 'map' });
    frames(chosen, unseated(s), 10);
    frames(chosen, s, 10);
    expect(chosen.mode).toBe('map');
  });

  it('stays in a map the player chose: the seat left and regained under it changes nothing', () => {
    const s = cabin();
    const views = createViewManager(rigs(), { defs, initialMode: 'chase' });
    frames(views, s, 3);
    views.update(s, IDLE, DT, new Set(['toggleMap'] as const));
    expect(views.mode).toBe('map');
    frames(views, unseated(s), 30);
    frames(views, s, 30);
    expect(views.mode).toBe('map');
    views.update(s, IDLE, DT, new Set(['toggleMap'] as const));
    expect(views.mode).toBe('chase');
    // And a view set by the app while the map stood in is the app's choice: nothing pulls it back.
    const app = createViewManager(rigs(), { defs, initialMode: 'cockpit' });
    frames(app, s, 3);
    frames(app, unseated(s), 3);
    expect(app.mode).toBe('map');
    app.update(s, IDLE, DT);
    expect(app.setMode('chase', s)).toBe(true);
    frames(app, s, 60);
    expect(app.mode).toBe('chase');
  });

  it('the new seat has no cabin: the view that was the cockpit comes back as another flight view', () => {
    const views = createViewManager(rigs(), { defs, initialMode: 'cockpit' });
    frames(views, cabin(), 3);
    frames(views, unseated(cabin()), 3);
    expect(views.mode).toBe('map');
    views.update(bare(), IDLE, DT);
    expect(views.mode).toBe('chase');
  });

  it('a flight view that stood in for another one is not left by itself (a vessel without a cabin is seen from outside until the player asks)', () => {
    const views = createViewManager(rigs(), { defs, initialMode: 'cockpit' });
    frames(views, cabin(), 3);
    frames(views, bare(), 3);
    expect(views.mode).toBe('chase');
    frames(views, cabin(), 30);
    expect(views.mode).toBe('chase');
    views.update(cabin(), IDLE, DT, new Set(['cycleCamera'] as const));
    expect(views.mode).toBe('cockpit');
  });
});
