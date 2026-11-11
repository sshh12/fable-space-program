import { beforeAll, describe, expect, it } from 'vitest';
import { parseAudioConfig, type AudioConfig } from '@/audio/config';
import { gainToDb } from '@/audio/mapping';
import { SoundModel, type ModelOutput } from '@/audio/model';
import type { AudioFrame } from '@/core/contracts/audio';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimEventType } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { v3 } from '@/core/math/vec3';
import { LAB_PARTS, LabEngines, placeVehicle } from '../../../labs/audio/labVehicle';
import { baseSnapshot, compose, externalAt, frames, labEngines, listener, makeEvent, SEA_LEVEL, seatOf, steadyEngines, type ListenerSpec, type SceneState } from '../../../labs/audio/scenes';
import { eventsScript, modeScript, steadyScript } from '../../../labs/audio/scripts';

let lib: DefLibrary;
let cfg: AudioConfig;
beforeAll(async () => {
  lib = await loadDefs(fsDefSource());
  cfg = parseAudioConfig(lib);
});

const DT = 1 / 60;
function run(frame: (t: number, dt: number) => AudioFrame, seconds: number): ModelOutput[] {
  const m = new SoundModel(cfg, lib);
  const out: ModelOutput[] = [];
  for (let t = 0; t < seconds; t += DT) out.push(m.update(frame(t, DT)));
  return out;
}

function steady(listen: ListenerSpec, opts: { stack?: 'booster' | 'tli' | 'lander'; throttle?: number; nozzle?: number; warp?: number } = {}): ModelOutput {
  const s = steadyScript(lib, { stack: opts.stack ?? 'booster', throttle: opts.throttle ?? 1, nozzlePressure: opts.nozzle ?? listen.pressure, listener: listen, warpFactor: () => opts.warp ?? 1 });
  return run(s.frame, 0.5).at(-1)!;
}

/** One steady booster frame with scene overrides (aero motion, CoM...) heard by `listen`. */
function boosterWith(listen: ListenerSpec, state: Partial<SceneState>, seconds = 0.5): ModelOutput {
  const base = baseSnapshot(lib, 'pad');
  const parts = steadyEngines(lib, 'booster', 1).parts(state.aero?.pressure ?? SEA_LEVEL);
  return run(frames({ base, listen: () => listen, state: () => ({ parts, aero: { pressure: SEA_LEVEL }, airVelocityVes: v3.zero(), boundingRadius: 55, ...state }) }), seconds).at(-1)!;
}

describe('engine clusters', () => {
  it('nine same-profile engines are ONE voice whose level is the power sum', () => {
    const out = steady(externalAt(80));
    const boosters = out.engines.filter((e) => e.profileId === 'engine.methalox-booster');
    expect(boosters).toHaveLength(1);
    expect(boosters[0]!.engines).toBe(9);
    expect(boosters[0]!.running).toBe(9);
    const p = cfg.engines.profiles['engine.methalox-booster']!;
    const single = cfg.engines.level.levelDb + p.efficiencyDb + 10 * Math.log10(p.refThrust / cfg.engines.level.refThrust);
    // Spooled for 10 s with tau 1.2 s: throttleActual 1 - e^(-10/1.2) of full (lever ~1); thrust at sea-level Isp.
    const m = lib.parts[LAB_PARTS.booster]!.modules.find((x) => x.type === 'engine')!;
    if (m.type !== 'engine') throw new Error('not an engine');
    const thrustPerEngine = m.thrustVac * (m.ispSL / m.ispVac);
    expect(boosters[0]!.levelDb).toBeCloseTo(single + 10 * p.throttleExponent * Math.log10(thrustPerEngine / p.refThrust) + 10 * Math.log10(9), 1);
  });

  it('ignition of a cluster gives one transient, offset by the ignition age', () => {
    const base = baseSnapshot(lib, 'pad');
    const e = labEngines(lib, 'booster');
    const m = new SoundModel(cfg, lib);
    const l = externalAt(100);
    let transients = 0;
    let offset = -1;
    let last = 0;
    for (let t = 0; t < 2; t += DT) {
      if (Math.abs(t - 0.5) < DT / 2) e.activate((p) => p.def === LAB_PARTS.booster);
      e.step(t - last, t >= 0.5 ? 1 : 0);
      last = t;
      const snap = compose(base, { parts: e.parts(SEA_LEVEL), aero: { pressure: SEA_LEVEL } }, t, 0);
      const out = m.update({ snapshot: snap, listener: listener(l, snap.activeVesselId), realDt: DT, warpFactor: 1, paused: false });
      for (const v of out.engines) if (v.ignition) {
        transients++;
        offset = v.ignition.offset;
      }
    }
    expect(transients).toBe(1);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(DT + 1e-9);
  });

  it('the lever (real Atlas-9M, minThrottle 0.5, the sim law) moves the level at least 12 dB from 10 % to 100 %', () => {
    const levels = [0.1, 0.25, 0.5, 0.75, 1].map((lever) => steady(externalAt(80), { throttle: lever }).engines.find((e) => e.running > 0)!);
    for (let i = 1; i < levels.length; i++) expect(levels[i]!.levelDb).toBeGreaterThan(levels[i - 1]!.levelDb);
    expect(levels[4]!.levelDb - levels[0]!.levelDb).toBeGreaterThanOrEqual(12);
    expect(gainToDb(levels[4]!.core.gain) - gainToDb(levels[0]!.core.gain)).toBeGreaterThanOrEqual(12);
    expect(levels[0]!.lever).toBeCloseTo(0.1, 2);
  });

  it('a cluster gets a voice only while it sounds: none before ignition, none after voiceHold past shutdown', () => {
    const base = baseSnapshot(lib, 'pad');
    const e = labEngines(lib, 'booster');
    const m = new SoundModel(cfg, lib);
    const l = listener(externalAt(100), base.activeVesselId);
    const counts: number[] = [];
    let last = 0;
    for (let t = 0; t < 8; t += DT) {
      if (Math.abs(t - 1) < DT / 2) e.activate((p) => p.def === LAB_PARTS.booster);
      if (Math.abs(t - 4) < DT / 2) e.shutdown(() => true);
      e.step(t - last, t >= 1 ? 1 : 0);
      last = t;
      const out = m.update({ snapshot: compose(base, { parts: e.parts(SEA_LEVEL), aero: { pressure: SEA_LEVEL } }, t, 0), listener: l, realDt: DT, warpFactor: 1, paused: false });
      counts.push(out.engines.length);
    }
    const at = (t: number): number => counts[Math.round(t / DT)]!;
    expect(at(0.5)).toBe(0);
    expect(at(2)).toBe(1);
    expect(at(7.9)).toBe(0);
  });

  it('a real vehicle on the pad has no engine voice before anything fires', () => {
    const id = Object.keys(lib.vehicles)[0];
    if (!id) return;
    const v = placeVehicle(lib, id);
    const e = new LabEngines(v.parts, lib.parts);
    const base = baseSnapshot(lib, 'pad');
    const out = run(frames({ base, listen: () => externalAt(100), state: () => ({ parts: e.parts(SEA_LEVEL), aero: { pressure: SEA_LEVEL }, airVelocityVes: v3.zero() }) }), 0.5).at(-1)!;
    expect(out.engines).toHaveLength(0);
  });
});

describe('two propagation paths', () => {
  it('vacuum: an external listener gets exactly zero airborne sound from everything', () => {
    const out = steady({ ...externalAt(40), pressure: 0 }, { nozzle: 0 });
    for (const v of out.engines) expect(v.paths.air.gain).toBe(0);
    expect(out.aero.paths.air.gain).toBe(0);
    expect(out.reentry.paths.air.gain).toBe(0);
    for (const v of out.engines) expect(v.crackle.gain).toBe(0);
    for (const g of Object.values(out.ambience.gains)) expect(g).toBe(0);
  });

  it('vacuum: the cabin keeps the structure-borne engine path, heavily low-passed', () => {
    const out = steady({ kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'tli'), pressure: 0 }, { stack: 'tli', nozzle: 0 });
    const v = out.engines.find((e) => e.running > 0)!;
    expect(v.paths.air.gain).toBe(0);
    expect(v.paths.body.gain).toBeGreaterThan(0);
    expect(v.paths.body.cutoff).toBeLessThan(400);
  });

  it('an external camera near the vessel hears a faint structure-borne share, weaker with distance, none beyond the attach range', () => {
    const range = cfg.mix.propagation.attach.maxDistance;
    const near = steady({ ...externalAt(40), pressure: 0 }, { nozzle: 0 }).engines.find((e) => e.running > 0)!;
    const mid = steady({ ...externalAt(range / 2), pressure: 0 }, { nozzle: 0 }).engines.find((e) => e.running > 0)!;
    const far = steady({ ...externalAt(range + 200), pressure: 0 }, { nozzle: 0 }).engines.find((e) => e.running > 0)!;
    expect(near.paths.body.gain).toBeGreaterThan(0);
    expect(gainToDb(near.paths.body.gain)).toBeLessThan(-20);
    expect(mid.paths.body.gain).toBeGreaterThan(0);
    expect(mid.paths.body.gain).toBeLessThan(near.paths.body.gain);
    expect(far.paths.body.gain).toBe(0);
  });

  it('only a camera attached to the vessel hears the structure-borne share (request audio-1): a ground-fixed camera at the same place hears none', () => {
    const attached = steady({ ...externalAt(40), pressure: 0 }, { nozzle: 0 }).engines.find((e) => e.running > 0)!;
    const fixed = steady({ ...externalAt(40), pressure: 0, attachedVesselId: null }, { nozzle: 0 }).engines.find((e) => e.running > 0)!;
    expect(attached.paths.body.gain).toBeGreaterThan(0);
    expect(fixed.paths.body.gain).toBe(0);
    // In air the ground camera still hears the airborne path exactly as the attached one does.
    const a = steady(externalAt(40)).engines.find((e) => e.running > 0)!;
    const f = steady({ ...externalAt(40), attachedVesselId: null }).engines.find((e) => e.running > 0)!;
    expect(f.paths.air).toEqual(a.paths.air);
    expect(f.paths.body.gain).toBe(0);
  });

  it('the attach share is measured from the bounding sphere about the VES origin, not the centre of mass', () => {
    const prop = cfg.mix.propagation;
    // Listener 150 m from the VES origin (radius 55: 95 m outside the sphere), CoM displaced 60 m towards it.
    const l: ListenerSpec = { kind: 'external', mode: 'chase', position: { x: 150, y: 0, z: 0 }, lookAt: v3.zero(), pressure: 0 };
    const atOrigin = boosterWith(l, { aero: { pressure: 0 } }).engines.find((e) => e.running > 0)!;
    const shifted = boosterWith(l, { aero: { pressure: 0 }, comLocal: { x: 60, y: 0, z: 0 } }).engines.find((e) => e.running > 0)!;
    expect(shifted.paths.body.gain).toBe(atOrigin.paths.body.gain);
    expect(atOrigin.paths.body.gain).toBeGreaterThan(0);
    expect(atOrigin.paths.body.gain).toBeLessThan(dbToGainLocal(prop.attach.gainDb + cfg.engines.profiles['engine.methalox-booster']!.body.gainDb));
  });

  it('distance: delay = d / c and the level drops with distance', () => {
    const a = steady(externalAt(50, { height: 0 }));
    const b = steady(externalAt(2000, { height: 0 }));
    const va = a.engines.find((e) => e.running > 0)!;
    const vb = b.engines.find((e) => e.running > 0)!;
    expect(vb.paths.air.delay - va.paths.air.delay).toBeCloseTo((2000 - 50) / 340, 1);
    expect(gainToDb(va.paths.air.gain) - gainToDb(vb.paths.air.gain)).toBeGreaterThan(25);
  });

  it('above Mach 1 the crew loses the airborne engine roar; the structure-borne path stays', () => {
    const cabin: ListenerSpec = { kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'booster'), pressure: 20000 };
    const fly = (mach: number) => boosterWith(cabin, { aero: { pressure: 20000, mach }, airVelocityVes: { x: 0, y: mach * 340, z: 0 } }, 1).engines.find((e) => e.running > 0)!;
    const sub = fly(0.5);
    const sup = fly(1.5);
    expect(sub.paths.air.gain).toBeGreaterThan(0);
    expect(sup.paths.air.gain).toBe(0);
    expect(sup.paths.body.gain).toBe(sub.paths.body.gain);
    // A chase camera trailing behind (inside the Mach cone) still hears it; one beside the nose does not.
    const trailing = boosterWith({ ...externalAt(90), position: { x: 20, y: -85, z: 20 }, pressure: 20000 }, { aero: { pressure: 20000, mach: 1.5 }, airVelocityVes: { x: 0, y: 510, z: 0 } }, 1);
    const beside = boosterWith({ ...externalAt(90), position: { x: 60, y: 60, z: 0 }, pressure: 20000 }, { aero: { pressure: 20000, mach: 1.5 }, airVelocityVes: { x: 0, y: 510, z: 0 } }, 1);
    expect(trailing.engines.find((e) => e.running > 0)!.paths.air.gain).toBeGreaterThan(0);
    expect(beside.engines.find((e) => e.running > 0)!.paths.air.gain).toBe(0);
  });

  it('cabin: hull path only (air through the hull), events of the own vessel through the structure', () => {
    const s = eventsScript(lib, ['decoupled', 'explosion', 'stageFired'], 0.5);
    const outs = run(s.frame, s.duration);
    const shots = outs.flatMap((o) => o.oneShots);
    const dec = shots.find((o) => o.cause === 'decoupled')!;
    expect(dec.body).not.toBeNull();
    expect(dec.bus).toBe('events');
    const stage = shots.find((o) => o.cause === 'stageFired')!;
    expect(stage.direct).toBe(true);
    const exp = shots.find((o) => o.cause === 'explosion')!;
    expect(exp.body).toBeNull();
    expect(exp.air).not.toBeNull();
  });
});

function dbToGainLocal(db: number): number {
  return 10 ** (db / 20);
}

describe('listener kind, not mode', () => {
  it('an unknown mode of kind external yields bit-identical targets to the chase camera', () => {
    const a = run(modeScript(lib, 'chase').frame, 6).map((o) => JSON.stringify(o));
    const b = run(modeScript(lib, 'eva-third-person').frame, 6).map((o) => JSON.stringify(o));
    expect(b).toEqual(a);
  });
  it("kind 'map' is an outside listener where the last external flight camera was, in the vessel's air", () => {
    const base = baseSnapshot(lib, 'pad');
    const parts = steadyEngines(lib, 'booster', 1).parts(SEA_LEVEL);
    const chase = externalAt(80);
    // The map camera itself: 200 km away, in vacuum.
    const mapCam: ListenerSpec = { kind: 'map', mode: 'map', position: { x: 0, y: 2e5, z: 0 }, pressure: 0 };
    const state = (): Partial<SceneState> => ({ parts, aero: { pressure: SEA_LEVEL }, airVelocityVes: v3.zero() });
    const viaChase = run(frames({ base, listen: (t) => (t < 0.5 ? chase : mapCam), state }), 1).at(-1)!;
    const chaseOnly = run(frames({ base, listen: () => chase, state }), 1).at(-1)!;
    expect(viaChase.interior).toBe(false);
    expect(JSON.stringify(viaChase.engines.map((e) => e.paths))).toEqual(JSON.stringify(chaseOnly.engines.map((e) => e.paths)));
    // Straight into the map: the configured stand-in position, still hearing the stack.
    const direct = run(frames({ base, listen: () => mapCam, state }), 1).at(-1)!;
    const v = direct.engines.find((e) => e.running > 0)!;
    expect(v.paths.air.gain).toBeGreaterThan(0);
    // The nine nozzles are centred on the VES origin's axis at y = 0.
    expect(v.paths.air.delay).toBeCloseTo(v3.len(cfg.mix.propagation.mapListener.positionVes) / 340, 2);
  });
});

describe('surface ambience', () => {
  it('a land bed near the ground, the sea after splashdown, nothing in vacuum or high up', () => {
    const outside = externalAt(30);
    const land = boosterWith(outside, { readouts: { altitudeRadar: 0 } });
    const high = boosterWith(outside, { readouts: { altitudeRadar: 5000 } });
    const sea = boosterWith(outside, { situation: 'splashed', waterSubmersion: 0.4, readouts: { altitudeRadar: 0 } });
    const vac = boosterWith({ ...outside, pressure: 0 }, { aero: { pressure: 0 }, readouts: { altitudeRadar: 0 } });
    const sum = (o: ModelOutput): number => Object.values(o.ambience.gains).reduce((s, x) => s + x, 0);
    expect(land.ambience.gains['ambience-outdoor']).toBeGreaterThan(0);
    expect(land.ambience.gains['ambience-ocean']).toBe(0);
    expect(sea.ambience.gains['ambience-ocean']).toBeGreaterThan(0);
    expect(sum(high)).toBe(0);
    expect(sum(vac)).toBe(0);
    // Inside the floating capsule: the sea through the hull, quieter and darker.
    const cabin = boosterWith({ kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'booster'), pressure: SEA_LEVEL }, { situation: 'splashed', waterSubmersion: 0.4 });
    expect(cabin.ambience.gains['ambience-ocean']!).toBeLessThan(sea.ambience.gains['ambience-ocean']!);
    expect(cabin.ambience.cutoff).toBeLessThan(sea.ambience.cutoff);
  });
});

describe('time warp, rails and pause', () => {
  it('continuous sounds fade above physics warp', () => {
    expect(steady(externalAt(80), { warp: 4 }).continuous).toBe(1);
    expect(steady(externalAt(80), { warp: 10 }).continuous).toBe(0);
  });
  it('events are suppressed on rails and while paused', () => {
    const base = baseSnapshot(lib, 'lowOrbit');
    const m = new SoundModel(cfg, lib);
    const ev = makeEvent('decoupled', base.ut, base.activeVesselId, base);
    const l = listener({ kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'capsule'), pressure: 0 }, base.activeVesselId);
    const onRails = compose(base, { events: [ev], warp: { onRails: true, factor: 1000 } }, 0, 1);
    expect(m.update({ snapshot: onRails, listener: l, realDt: DT, warpFactor: 1000, paused: false }).oneShots.filter((o) => o.cause === 'decoupled')).toHaveLength(0);
    const paused = compose(base, { events: [ev] }, 1, 2);
    expect(m.update({ snapshot: paused, listener: l, realDt: DT, warpFactor: 1, paused: true }).oneShots.filter((o) => o.cause === 'decoupled')).toHaveLength(0);
    const live = compose(base, { events: [{ ...ev, ut: base.ut + 2 }] }, 2, 3);
    expect(m.update({ snapshot: live, listener: l, realDt: DT, warpFactor: 1, paused: false }).oneShots.filter((o) => o.cause === 'decoupled')).toHaveLength(1);
  });
});

describe('events', () => {
  it('every mapped event type requests a one-shot on the events bus', () => {
    const types = Object.keys(cfg.events) as SimEventType[];
    const s = eventsScript(lib, types, 0.5);
    const shots = run(s.frame, s.duration).flatMap((o) => o.oneShots);
    for (const t of types) {
      const hit = shots.filter((o) => o.cause === t);
      expect(hit.length, t).toBeGreaterThan(0);
      expect(hit[0]!.bus, t).toBe('events');
    }
  });
  it('touchdown picks the hard variant and a higher level at higher speed; water touchdown is the splash', () => {
    const base = baseSnapshot(lib, 'lunarSurface');
    const m = new SoundModel(cfg, lib);
    const l = listener({ kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'capsule'), pressure: 0 }, base.activeVesselId);
    const at = (speed: number, i: number, surface = 'land') => {
      const snap = compose(base, { events: [makeEvent('touchdown', base.ut + i, base.activeVesselId, base, { speed, surface })] }, i, i);
      return m.update({ snapshot: snap, listener: l, realDt: 1, warpFactor: 1, paused: false }).oneShots.find((o) => o.cause === 'touchdown');
    };
    const soft = at(1, 1)!;
    const hard = at(6, 2)!;
    expect(soft.asset).toBe('touchdown-soft');
    expect(hard.asset).toBe('touchdown-hard');
    expect(hard.gain).toBeGreaterThan(soft.gain);
    expect(at(6, 3, 'water')).toBeUndefined();
  });
});

describe('cabin and ui', () => {
  it('cabin ambience only for an interior listener; creaks grow with g-load and are reproducible', () => {
    const creaksAt = (g: number): number => {
      const base = baseSnapshot(lib, 'ascent');
      const f = frames({ base, listen: () => ({ kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'capsule'), pressure: 30000 }), state: () => ({ gLoad: g }) });
      return run(f, 30).flatMap((o) => o.oneShots).filter((o) => o.cause === 'creak').length;
    };
    expect(creaksAt(1)).toBe(0);
    const low = creaksAt(3);
    const high = creaksAt(7);
    expect(high).toBeGreaterThan(low);
    expect(creaksAt(7)).toBe(high);
    expect(steady(externalAt(50)).cabin.ambience).toBe(0);
    expect(steady({ kind: 'interior', mode: 'cockpit', position: seatOf(lib, 'booster'), pressure: SEA_LEVEL }).cabin.ambience).toBeGreaterThan(0);
  });
  it('a switch click when a watched readout changes; the master alarm latches for its minimum duration', () => {
    const base = baseSnapshot(lib, 'lowOrbit');
    const f = frames({ base, listen: () => externalAt(30, { pressure: 0 }), state: (t) => ({ readouts: { sasEnabled: t < 1, maxTempFraction: t > 2 && t < 2.2 ? 0.95 : 0.3 } }) });
    const outs = run(f, 6);
    const clicks = outs.flatMap((o) => o.oneShots).filter((o) => o.cause === 'click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.bus).toBe('ui');
    const on = outs.map((o) => o.alarm);
    const first = on.indexOf(true);
    const lastOn = on.lastIndexOf(true);
    expect(first * DT).toBeGreaterThan(2);
    expect((lastOn - first) * DT).toBeGreaterThanOrEqual(cfg.ui.alarm.minDuration - 2 * DT);
    expect(on.at(-1)).toBe(false);
  });
});

describe('robustness', () => {
  it('reports a part without a definition once instead of failing', () => {
    const base = baseSnapshot(lib, 'pad');
    const parts = steadyEngines(lib, 'lander', 1).parts(SEA_LEVEL).map((p) => ({ ...p, def: p.def === LAB_PARTS.descent ? 'no-such-part' : p.def }));
    const m = new SoundModel(cfg, lib);
    const l = listener(externalAt(30), base.activeVesselId);
    const a = m.update({ snapshot: compose(base, { parts }, 0, 0), listener: l, realDt: DT, warpFactor: 1, paused: false });
    const b = m.update({ snapshot: compose(base, { parts }, DT, 1), listener: l, realDt: DT, warpFactor: 1, paused: false });
    expect(a.problems.length).toBe(1);
    expect(a.problems[0]).toContain('no-such-part');
    expect(b.problems).toHaveLength(0);
  });
});
