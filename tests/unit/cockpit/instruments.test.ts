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
import { bindingState, controlStates, digitMask, instrumentSource, RATE_FULL_SCALE, readoutText, updateMemory, type InstrumentMemory, type InstrumentSource } from '@/render/cockpit/instruments';
import { validateLayout, type AlarmsDef, type CockpitLayoutDef, type ReadoutDef } from '@/render/cockpit/layout';
import { assembleVessel, vesselPartSnapshots } from '@/sim/vessel/public';
import { buildMfdPage, describeFlight, describeOrbit, formatMet, landingTargetRows, describeLandingTarget, MFD_PAGES } from '@/ui';
import { testDefs, testModel } from './helpers';

let defs: DefLibrary;
let vehicleId: string;
let alarms: AlarmsDef;

/** The instruments of the active vessel of a snapshot. */
const act = (s: SimSnapshot): InstrumentSource => instrumentSource(s, s.vessels.find((v) => v.id === s.activeVesselId)!);

beforeAll(async () => {
  defs = await testDefs();
  vehicleId = Object.values(defs.vehicles).find((v) => v.cockpit)!.id;
  alarms = (await testModel()).layout.alarms;
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
    expect(bindingState('sas', act(s), defs, alarms).on).toBe(true);
    expect(bindingState('rcs', act(s), defs, alarms).on).toBe(false);
    expect(bindingState('gear', act(s), defs, alarms)).toEqual({ on: true, index: 0 });
    expect(bindingState('rcs', act(s), defs, alarms).index).toBe(1);
    expect(bindingState('overheat', act(s), defs, alarms).on).toBe(true);
    expect(bindingState('masterAlarm', act(s), defs, alarms).on).toBe(true);
    expect(bindingState('stagingLocked', act(s), defs, alarms).on).toBe(true);
    expect(bindingState('gLimit', act(s), defs, alarms).on).toBe(false);
    // The tower goes with the third staging action: the abort lamp follows the LES module on the vessel.
    expect(bindingState('abortArmed', act(snapshot('pad', 0)), defs, alarms).on).toBe(true);
    expect(bindingState('abortArmed', act(s), defs, alarms).on).toBe(false);
    expect(bindingState('navballMode', act(s), defs, alarms).index).toBe(['surface', 'orbit', 'target'].indexOf(s.navball.mode));
  });

  it('sets every control of the Kestrel interior to a valid state', async () => {
    const model = await testModel();
    const s = snapshot('reentry', 8);
    const mem: InstrumentMemory = { lastStageUt: null };
    const states = controlStates(model.controls, act(s), defs, alarms, 1.25, mem, () => ({ R: v3.unitX(), U: v3.unitZ(), L: v3.unitY() }), () => [100, 100, 100]);
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

  it('describe the vessel the interior belongs to, not the active one', async () => {
    const model = await testModel();
    const base = snapshot('lowOrbit', 4, (x) => ({ ...x, readouts: { ...x.readouts, sasEnabled: true, lightsOn: true, gLoad: 0.5, deltaVTotal: 1234 } }));
    const own = base.vessels.find((v) => v.id === base.activeVesselId)!;
    // A second vessel of the same vehicle, not the active one, pulling 9 g with its own parts.
    const other = { ...own, id: 'other', gLoad: 9 };
    const s = { ...base, vessels: [...base.vessels, other] };
    const src = instrumentSource(s, other);
    expect(src.active).toBe(false);
    // Readout-only facts (the active vessel's SAS, lights, HUD numbers) do not describe the other vessel...
    expect(bindingState('sas', src, defs, alarms).on).toBe(false);
    expect(bindingState('lights', src, defs, alarms).on).toBe(false);
    const dv: ReadoutDef = { label: 'DV', binding: 'deltaV', digits: 4, color: [1, 0, 0], luminance: 100 };
    expect(readoutText(dv, src, { lastStageUt: null })).toBe('    ');
    expect(readoutText(dv, act(s), { lastStageUt: null })).toBe('1234');
    // ...its own g does: the g readout and the g limit follow the vessel's own load.
    const g: ReadoutDef = { label: 'G', binding: 'gLoad', digits: 3, points: [1], color: [1, 0, 0], luminance: 100 };
    expect(readoutText(g, src, { lastStageUt: null })).toBe(' 90');
    expect(readoutText(g, act(s), { lastStageUt: null })).toBe(' 05');
    expect(bindingState('gLimit', src, defs, alarms).on).toBe(true);
    expect(bindingState('gLimit', act(s), defs, alarms).on).toBe(false);
    // Hand controllers rest and floods stay dark on a vessel that is not being flown.
    const flown = { ...s, appliedControls: { ...s.appliedControls, pitch: 1, throttle: 1 } };
    const st = controlStates(model.controls, instrumentSource(flown, other), defs, alarms, 0, { lastStageUt: null }, () => ({ R: v3.unitX(), U: v3.unitZ(), L: v3.unitY() }), () => [100, 100, 100]);
    model.controls.forEach((c, i) => {
      if (c.kind === 'rhc' || c.kind === 'throttle') expect(quat.angleBetween(st[i]!.rot, quat.identity())).toBeLessThan(1e-9);
      if (c.kind === 'flood') expect(st[i]!.lit).toBe(0);
    });
  });

  it('moves the hand controllers with the applied controls', async () => {
    const model = await testModel();
    const base = snapshot('lowOrbit', 4);
    const s = { ...base, appliedControls: { ...base.appliedControls, pitch: 1, roll: 0, yaw: 0, throttle: 1, translate: { x: 1, y: 0, z: 0 } } };
    const axes = { R: v3.unitX(), U: v3.unitZ(), L: v3.unitY() };
    const st = controlStates(model.controls, act(s), defs, alarms, 0, { lastStageUt: null }, () => axes, () => [0, 0, 0]);
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
      const text = readoutText(met, act(s), { lastStageUt: null });
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
    updateMemory(mem, { ...s0, events: [{ type: 'stageFired', ut: s0.ut - 75, vesselId: s0.activeVesselId, stageIndex: 4, label: 'x' }] }, s0.activeVesselId);
    expect(readoutText(evt, act(s0), mem)).toBe('0115');
    const s1 = { ...s0, readouts: { ...s0.readouts, nodeBurn: { nodeId: 'n', dvRemaining: v3.zero(), dvRemainingMag: 10, burnTime: 4, timeToBurnStart: 42, timeToNode: 44, insufficientDeltaV: false } } };
    expect(readoutText(evt, act(s1), mem)).toBe('-042');
  });
});

describe('attitude indicator rate needles', () => {
  it('slides each needle along its scale with the body rate about its axis and stops at full scale', async () => {
    const model = await testModel();
    const needles = model.controls.filter((c) => c.kind === 'needle');
    expect(needles.map((c) => c.key).sort()).toEqual(['fdai:pitch', 'fdai:roll', 'fdai:yaw']);
    const s0 = snapshot('lowOrbit', 4);
    const withRate = (w: { x: number; y: number; z: number }): InstrumentSource => {
      const s = { ...s0, vessels: s0.vessels.map((v) => (v.id === s0.activeVesselId ? { ...v, w } : v)) };
      return instrumentSource(s, s.vessels.find((v) => v.id === s.activeVesselId)!);
    };
    const run = (w: { x: number; y: number; z: number }) => {
      const st = controlStates(model.controls, withRate(w), defs, model.layout.alarms, 0, { lastStageUt: null }, () => ({ R: v3.unitX(), U: v3.unitY(), L: v3.unitZ() }), () => [0, 0, 0]);
      return Object.fromEntries(needles.map((c) => [c.key, v3.dot(st[c.index - 1]!.offset, c.axis)]));
    };
    const rest = run(v3.zero());
    for (const k of Object.keys(rest)) expect(rest[k]).toBeCloseTo(0, 9);
    // Half scale about the roll axis (VES +Y) moves the roll needle alone, by half its travel.
    const half = run({ x: 0, y: RATE_FULL_SCALE / 2, z: 0 });
    const travel = needles.find((c) => c.key === 'fdai:roll')!.travel!;
    expect(half['fdai:roll']).toBeCloseTo(travel / 2, 9);
    expect(half['fdai:pitch']).toBeCloseTo(0, 9);
    expect(half['fdai:yaw']).toBeCloseTo(0, 9);
    // Beyond full scale the needle rests on its stop.
    const fast = run({ x: -10 * RATE_FULL_SCALE, y: 0, z: 3 * RATE_FULL_SCALE });
    expect(fast['fdai:pitch']).toBeCloseTo(-travel, 9);
    expect(fast['fdai:yaw']).toBeCloseTo(travel, 9);
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
      // In flight the page shows the formatter's strings; standing on the ground it shows a dash instead of
      // an orbit, or leaves the rows out (flight-ui, visual rounds 1 and 2).
      if (scene === 'lunarSurface') {
        if (orbit.Apoapsis !== undefined) expect(['—', o.apoapsis]).toContain(orbit.Apoapsis);
        if (orbit.Periapsis !== undefined) expect(['—', o.periapsis]).toContain(orbit.Periapsis);
      } else {
        expect(orbit.Apoapsis).toBe(o.apoapsis);
        expect(orbit.Periapsis).toBe(o.periapsis);
      }
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
