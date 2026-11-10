import { beforeAll, describe, expect, it } from 'vitest';
import type { ButtonAction, InputFrame } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { ALL_AXIS_ACTIONS } from './bindings';
import { createFlightController } from './flightController';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

function frame(axes: Partial<InputFrame['axes']> = {}, pressed: ButtonAction[] = []): InputFrame {
  const all = Object.fromEntries(ALL_AXIS_ACTIONS.map((a) => [a, 0])) as Record<(typeof ALL_AXIS_ACTIONS)[number], number>;
  return {
    axes: { ...all, ...axes },
    pressed: new Set(pressed),
    pointer: { x: 0, y: 0, dx: 0, dy: 0, buttons: 0, pressed: false, released: false, doubleClick: false, wheel: 0, shift: false, ctrl: false, alt: false, overUi: false },
    keyboardLocked: false,
  };
}

describe('flight controller', () => {
  it('ignores a held throttle key while the pointer is captured, but attitude still works', () => {
    const sim = createFakeSim(defs, { scene: 'lowOrbit' });
    const c = createFlightController();
    let snap = sim.snapshot();
    for (let i = 0; i < 120; i++) {
      const out = c.update(frame({ throttleRate: 1, pitch: -1, yaw: 1, roll: -1 }), snap, sim.commands, 1 / 60, { view: 'map', pointerCaptured: true });
      sim.setControls(out);
      sim.advance(1 / 60);
      snap = sim.snapshot();
      expect(out.throttle).toBe(0);
      expect(out.pitch).toBe(-1);
      expect(out.yaw).toBe(1);
      expect(out.roll).toBe(-1);
    }
    expect(snap.appliedControls.throttle).toBe(0);
    expect(snap.appliedControls.pitch).toBe(-1);
    // Same for throttle-down with Shift/Ctrl drags: a lever at 0.6 stays at 0.6.
    c.setThrottle(0.6);
    const out = c.update(frame({ throttleRate: -1 }), snap, sim.commands, 0.5, { view: 'map', pointerCaptured: true });
    expect(out.throttle).toBeCloseTo(0.6, 12);
  });

  it('ramps the lever at 0.5 per second when the pointer is free', () => {
    const sim = createFakeSim(defs, { scene: 'lowOrbit' });
    const c = createFlightController();
    const snap = sim.snapshot();
    let out = c.update(frame(), snap, sim.commands, 1 / 60, { view: 'external', pointerCaptured: false });
    expect(out.throttle).toBe(0);
    for (let i = 0; i < 60; i++) out = c.update(frame({ throttleRate: 1 }), snap, sim.commands, 1 / 60, { view: 'external', pointerCaptured: false });
    expect(out.throttle).toBeCloseTo(0.5, 9);
    for (let i = 0; i < 30; i++) out = c.update(frame({ throttleRate: -1 }), snap, sim.commands, 1 / 60, { view: 'external', pointerCaptured: false });
    expect(out.throttle).toBeCloseTo(0.25, 9);
    out = c.update(frame({}, ['throttleFull']), snap, sim.commands, 1 / 60, { view: 'external', pointerCaptured: false });
    expect(out.throttle).toBe(1);
    for (let i = 0; i < 60; i++) out = c.update(frame({ throttleRate: 1 }), snap, sim.commands, 1 / 60, { view: 'external', pointerCaptured: false });
    expect(out.throttle).toBe(1);
    out = c.update(frame({}, ['throttleCut']), snap, sim.commands, 1 / 60, { view: 'external', pointerCaptured: false });
    expect(out.throttle).toBe(0);
  });

  it('turns button actions into PlayerCommands and reports refusals', () => {
    const sim = createFakeSim(defs, { scene: 'ascent' });
    const messages: string[] = [];
    const c = createFlightController({ notify: (m) => messages.push(m) });
    const ctx = { view: 'external' as const, pointerCaptured: false };
    let snap = sim.snapshot();
    const press = (...a: ButtonAction[]): void => {
      sim.setControls(c.update(frame({}, a), snap, sim.commands, 1 / 60, ctx));
      sim.advance(1 / 60);
      snap = sim.snapshot();
    };
    press('stage');
    expect(snap.staging.nextStage).toBe(1);
    press('toggleSas');
    expect(snap.readouts.sasEnabled).toBe(false);
    press('sas:retrograde');
    expect(snap.readouts.sasEnabled).toBe(true);
    expect(snap.readouts.sasMode).toBe('retrograde');
    press('toggleRcs', 'toggleLegs', 'toggleLights', 'toggleFineControl');
    expect(snap.readouts).toMatchObject({ rcsEnabled: true, legsDeployed: true, lightsOn: true, fineControl: true });
    press('toggleNavballMode');
    expect(snap.navball.mode).toBe('orbit');
    // Ascent is under acceleration: physics warp only (index 3). The fourth step up is refused.
    for (let i = 0; i < 4; i++) press('warpUp');
    expect(snap.warp.index).toBe(3);
    expect(messages).toContain('Cannot warp faster here');
    press('warpDown');
    expect(snap.warp.index).toBe(2);
    press('warpStop');
    expect(snap.warp.index).toBe(0);
    press('sas:maneuver');
    expect(messages.some((m) => /maneuver/i.test(m))).toBe(true);
    press('nextVessel');
    expect(messages).toContain('No other controllable vessel');
  });

  it('does not act on view, HUD, pause or cockpit actions', () => {
    const sim = createFakeSim(defs, { scene: 'pad' });
    const c = createFlightController();
    const snap = sim.snapshot();
    const before = sim.stateHash();
    c.update(frame({}, ['toggleMap', 'cycleCamera', 'toggleHud', 'pause', 'mfdCycle:0']), snap, sim.commands, 1 / 60, { view: 'external', pointerCaptured: false });
    expect(sim.stateHash()).toBe(before);
  });
});
