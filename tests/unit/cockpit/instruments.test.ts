/**
 * Cockpit state and instruments: CockpitControls (page cycling and validation), instrument bindings against
 * snapshots, seven-segment readouts (the mission clock reads the HUD's own seconds), MFD page content equal
 * to the HUD's strings (same display models and formatters), and the layout validator.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { MfdPage } from '@/core/contracts/ui';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { DefError } from '@/core/defs/loader';
import { quat, v3 } from '@/core/math';
import { createCockpitControls } from '@/render/cockpit/controls';
import { bindingState, controlStates, digitMask, readoutText, updateMemory, type InstrumentMemory } from '@/render/cockpit/instruments';
import { validateLayout, type CockpitLayoutDef, type ReadoutDef } from '@/render/cockpit/layout';
import { assembleVessel, vesselPartSnapshots } from '@/sim/vessel/public';
import { buildMfdPage, describeFlight, describeOrbit, formatMet, landingTargetRows, describeLandingTarget, MFD_PAGES } from '@/ui';
import { testDefs, testModel } from './helpers';

let defs: DefLibrary;
let vehicleId: string;

beforeAll(async () => {
  defs = await testDefs();
  vehicleId = Object.values(defs.vehicles).find((v) => v.cockpit)!.id;
});

function snapshot(scene: Parameters<typeof createFakeSim>[1]['scene'], fired: number, edit?: (s: SimSnapshot) => SimSnapshot): SimSnapshot {
  const parts = vesselPartSnapshots(assembleVessel(defs, vehicleId, { stagesAlreadyFired: fired }));
  const sim = createFakeSim(defs, { scene, parts });
  const s = sim.snapshot();
  const tagged = { ...s, vessels: s.vessels.map((v) => ({ ...v, vehicleId })) };
  return edit ? edit(tagged) : tagged;
}

describe('CockpitControls', () => {
  it('cycles every MFD page in order and wraps, per display', () => {
    const c = createCockpitControls(MFD_PAGES, ['flight', 'orbit', 'systems']);
    expect(c.displayCount).toBe(3);
    const seen: MfdPage[] = [c.page(0)];
    for (let i = 0; i < MFD_PAGES.length; i++) {
      c.cyclePage(0);
      seen.push(c.page(0));
    }
    expect(seen.slice(0, MFD_PAGES.length)).toEqual([...MFD_PAGES]);
    expect(seen[MFD_PAGES.length]).toBe(seen[0]);
    expect(c.page(1)).toBe('orbit');
    expect(c.page(2)).toBe('systems');
  });

  it('sets pages, reports changes once, and rejects unknown displays and pages', () => {
    const c = createCockpitControls(MFD_PAGES, ['flight', 'orbit', 'systems']);
    const changes: [number, MfdPage][] = [];
    c.onChange((d, p) => changes.push([d, p]));
    c.setPage(2, 'landing');
    c.setPage(2, 'landing');
    c.cyclePage(1);
    expect(changes).toEqual([
      [2, 'landing'],
      [1, 'systems'],
    ]);
    expect(() => c.setPage(3, 'flight')).toThrow(RangeError);
    expect(() => c.cyclePage(-1)).toThrow(RangeError);
    expect(() => c.setPage(0, 'warp' as MfdPage)).toThrow(RangeError);
  });
});

describe('instrument bindings', () => {
  it('follow the snapshot: switches, lamps and selectors', () => {
    const s = snapshot('lowOrbit', 4, (x) => ({ ...x, readouts: { ...x.readouts, sasEnabled: true, rcsEnabled: false, legsDeployed: true, lightsOn: true, maxTempFraction: 0.9, gLoad: 2 }, staging: { ...x.staging, lockout: true } }));
    expect(bindingState('sas', s, defs).on).toBe(true);
    expect(bindingState('rcs', s, defs).on).toBe(false);
    expect(bindingState('gear', s, defs)).toEqual({ on: true, index: 0 });
    expect(bindingState('rcs', s, defs).index).toBe(1);
    expect(bindingState('overheat', s, defs).on).toBe(true);
    expect(bindingState('masterAlarm', s, defs).on).toBe(true);
    expect(bindingState('stagingLocked', s, defs).on).toBe(true);
    expect(bindingState('gLimit', s, defs).on).toBe(false);
    // The tower goes with the third staging action: the abort lamp follows the LES module on the vessel.
    expect(bindingState('abortArmed', snapshot('pad', 0), defs).on).toBe(true);
    expect(bindingState('abortArmed', s, defs).on).toBe(false);
    expect(bindingState('navballMode', s, defs).index).toBe(['surface', 'orbit', 'target'].indexOf(s.navball.mode));
  });

  it('sets every control of the Kestrel interior to a valid state', async () => {
    const model = await testModel();
    const s = snapshot('reentry', 8);
    const mem: InstrumentMemory = { lastStageUt: null };
    const states = controlStates(model.controls, s, defs, 1.25, mem, () => ({ R: v3.unitX(), U: v3.unitZ(), L: v3.unitY() }), () => [100, 100, 100]);
    expect(states).toHaveLength(model.controls.length);
    for (const st of states) {
      expect(Math.abs(Math.hypot(st.rot.x, st.rot.y, st.rot.z, st.rot.w) - 1)).toBeLessThan(1e-9);
      expect(st.emit.every((x) => Number.isFinite(x) && x >= 0)).toBe(true);
    }
    // Entry: the "LIFT UP" / "COMM BLK" style lamps follow the plasma and the lift vector.
    const lampOn = (binding: string): boolean => model.controls.some((c, i) => c.kind === 'lamp' && c.lamp!.binding === binding && states[i]!.lit === 1);
    expect(lampOn('plasma')).toBe(s.vessels[0]!.aero.plasmaIntensity > 0.2);
    expect(lampOn('liftUp')).toBe(s.readouts.liftVectorUp === true);
  });

  it('moves the hand controllers with the applied controls', async () => {
    const model = await testModel();
    const base = snapshot('lowOrbit', 4);
    const s = { ...base, appliedControls: { ...base.appliedControls, pitch: 1, roll: 0, yaw: 0, throttle: 1, translate: { x: 1, y: 0, z: 0 } } };
    const axes = { R: v3.unitX(), U: v3.unitZ(), L: v3.unitY() };
    const st = controlStates(model.controls, s, defs, 0, { lastStageUt: null }, () => axes, () => [0, 0, 0]);
    const of = (kind: string): number => model.controls.findIndex((c) => c.kind === kind);
    expect(quat.angleBetween(st[of('rhc')]!.rot, quat.identity())).toBeGreaterThan(0.2);
    expect(v3.len(st[of('thc')]!.offset)).toBeCloseTo(0.008, 6);
    expect(quat.angleBetween(st[of('throttle')]!.rot, quat.identity())).toBeGreaterThan(0.5);
  });
});

describe('seven-segment readouts', () => {
  const met: ReadoutDef = { label: 'MET', binding: 'met', digits: 9, colons: [2, 4, 6], color: [1, 0, 0], luminance: 100 };
  it('show the same seconds as the HUD mission clock', () => {
    for (const t of [0, 59.9, 3723.4, 2 * 86400 + 5 * 3600 + 7 * 60 + 9.99, 13.6 * 86400]) {
      const s = snapshot('lowOrbit', 4, (x) => ({ ...x, readouts: { ...x.readouts, met: t } }));
      const text = readoutText(met, s, { lastStageUt: null });
      const hud = formatMet(t);
      // DDD HH MM SS from the readout; the HUD string carries the same fields.
      const d = Number(text.slice(0, 3));
      const h = Number(text.slice(3, 5));
      const m = Number(text.slice(5, 7));
      const sec = Number(text.slice(7, 9));
      expect(d * 86400 + h * 3600 + m * 60 + sec).toBe(Math.floor(t));
      const fields = hud.match(/\d+/g)!.map(Number);
      expect(fields[fields.length - 1]).toBe(sec);
      expect(fields[fields.length - 2]).toBe(m);
    }
  });

  it('light the right segments and separators', () => {
    expect(digitMask(met, '000000008', 8)).toBe(0b1111111);
    expect(digitMask(met, '000000001', 8)).toBe(0b0000110);
    expect(digitMask(met, '000000001', 2) & (1 << 7)).not.toBe(0);
    expect(digitMask(met, '         ', 0)).toBe(0);
  });

  it('count the event timer up from the last staging and down to a planned burn', () => {
    const mem: InstrumentMemory = { lastStageUt: null };
    const evt: ReadoutDef = { label: 'EVT', binding: 'eventTimer', digits: 4, colons: [1], color: [1, 0, 0], luminance: 100 };
    const s0 = snapshot('lowOrbit', 4);
    updateMemory(mem, { ...s0, events: [{ type: 'stageFired', ut: s0.ut - 75, vesselId: s0.activeVesselId, stageIndex: 4, label: 'x' }] });
    expect(readoutText(evt, s0, mem)).toBe('0115');
    const s1 = { ...s0, readouts: { ...s0.readouts, nodeBurn: { nodeId: 'n', dvRemaining: v3.zero(), dvRemainingMag: 10, burnTime: 4, timeToBurnStart: 42, timeToNode: 44, insufficientDeltaV: false } } };
    expect(readoutText(evt, s1, mem)).toBe('-042');
  });
});

describe('MFD content and the HUD', () => {
  it('shows the HUD strings on the flight, orbit and landing pages (one formatter)', () => {
    for (const [scene, fired] of [['ascent', 1], ['lowOrbit', 4], ['lunarSurface', 6]] as const) {
      const s = snapshot(scene, fired);
      const f = describeFlight(s);
      const rows = Object.fromEntries(buildMfdPage('flight', s, defs).rows.map((r) => [r.label, r.value]));
      expect(rows[f.altitudeSource === 'radar' ? 'Radar alt' : 'Altitude']).toBe(f.altitude);
      expect(rows.Vertical).toBe(f.verticalSpeed);
      expect(rows.Heading).toBe(f.heading);
      expect(rows.Pitch).toBe(f.pitch);
      expect(rows.Roll).toBe(f.roll);
      expect(rows.Throttle).toBe(f.throttle);
      expect(rows['G load']).toBe(f.gLoad);
      const o = describeOrbit(s);
      const orbit = Object.fromEntries(buildMfdPage('orbit', s, defs).rows.map((r) => [r.label, r.value]));
      expect(orbit.Apoapsis).toBe(o.apoapsis);
      expect(orbit.Periapsis).toBe(o.periapsis);
      const lt = describeLandingTarget(s);
      const landing = buildMfdPage('landing', s, defs);
      if (lt) expect(landing.section!.rows.map((r) => [r.label, r.value])).toEqual(landingTargetRows(lt));
    }
  });
});

describe('layout validation', () => {
  it('rejects a layout that disagrees with the shared mould line', async () => {
    const model = await testModel();
    const bad = (edit: (l: CockpitLayoutDef) => void): (() => void) => () => {
      const l = structuredClone(model.layout);
      edit(l);
      validateLayout(l, model.mould, 'visuals/cockpits/test.json');
    };
    expect(bad(() => undefined)).not.toThrow();
    expect(bad((l) => delete l.couches.seats.cdr)).toThrow(DefError);
    expect(bad((l) => (l.couches.seats.extra = l.couches.seats.plt!))).toThrow(DefError);
    expect(bad((l) => (l.windows.shades['no-such-window'] = 1))).toThrow(DefError);
    expect(bad((l) => (l.displays.pages = ['flight']))).toThrow(DefError);
    expect(bad((l) => (l.materials.panel!.roughness = 2))).toThrow(DefError);
  });
});
