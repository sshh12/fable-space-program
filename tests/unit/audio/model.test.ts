import { beforeAll, describe, expect, it } from 'vitest';
import { parseAudioConfig, type AudioConfig } from '@/audio/config';
import { gainToDb } from '@/audio/mapping';
import { SoundModel, type ModelOutput } from '@/audio/model';
import type { AudioFrame } from '@/core/contracts/audio';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimEventType } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { withLabParts } from '../../../labs/audio/labVehicle';
import { baseSnapshot, compose, externalAt, frames, labEngines, listener, makeEvent, SEA_LEVEL, seatOf, steadyEngines, type ListenerSpec } from '../../../labs/audio/scenes';
import { eventsScript, modeScript, steadyScript } from '../../../labs/audio/scripts';

let lib: DefLibrary;
let cfg: AudioConfig;
beforeAll(async () => {
  lib = withLabParts(await loadDefs(fsDefSource()));
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

describe('engine clusters', () => {
  it('nine same-profile engines are ONE voice whose level is the power sum', () => {
    const out = steady(externalAt(80));
    const boosters = out.engines.filter((e) => e.profileId === 'engine.methalox-booster');
    expect(boosters).toHaveLength(1);
    expect(boosters[0]!.engines).toBe(9);
    expect(boosters[0]!.running).toBe(9);
    const p = cfg.engines.profiles['engine.methalox-booster']!;
    const single = cfg.engines.level.levelDb + p.efficiencyDb + 10 * Math.log10(p.refThrust / cfg.engines.level.refThrust);
    // Spooled for 10 s with tau 1.2 s: throttleActual is 1 - e^(-10/1.2) of full; thrust at sea-level Isp.
    const thrustPerEngine = 4.174e6 * (327 / 350);
    expect(boosters[0]!.levelDb).toBeCloseTo(single + 10 * p.throttleExponent * Math.log10(thrustPerEngine / p.refThrust) + 10 * Math.log10(9), 1);
  });

  it('ignition of a cluster gives one transient, offset by the ignition age', () => {
    const base = baseSnapshot(lib, 'pad');
    const e = labEngines('booster');
    const m = new SoundModel(cfg, lib);
    const l = externalAt(100);
    let transients = 0;
    let offset = -1;
    let last = 0;
    for (let t = 0; t < 2; t += DT) {
      if (Math.abs(t - 0.5) < DT / 2) e.activate((p) => p.def === 'lab-atlas-9m');
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

  it('level rises at least 12 dB from 10 % to 100 % throttle', () => {
    const lo = steady(externalAt(80), { throttle: 0.1 }).engines.find((e) => e.running > 0)!;
    const hi = steady(externalAt(80), { throttle: 1 }).engines.find((e) => e.running > 0)!;
    expect(hi.levelDb - lo.levelDb).toBeGreaterThanOrEqual(12);
    expect(gainToDb(hi.core.gain) - gainToDb(lo.core.gain)).toBeGreaterThanOrEqual(12);
  });
});

describe('two propagation paths', () => {
  it('vacuum: an external listener gets exactly zero airborne sound from everything', () => {
    const out = steady({ ...externalAt(40), pressure: 0 }, { nozzle: 0 });
    for (const v of out.engines) expect(v.paths.air.gain).toBe(0);
    expect(out.aero.paths.air.gain).toBe(0);
    expect(out.reentry.paths.air.gain).toBe(0);
    for (const v of out.engines) expect(v.crackle.gain).toBe(0);
  });

  it('vacuum: the cabin keeps the structure-borne engine path, heavily low-passed', () => {
    const out = steady({ kind: 'interior', mode: 'cockpit', position: seatOf('tli'), pressure: 0 }, { stack: 'tli', nozzle: 0 });
    const v = out.engines.find((e) => e.running > 0)!;
    expect(v.paths.air.gain).toBe(0);
    expect(v.paths.body.gain).toBeGreaterThan(0);
    expect(v.paths.body.cutoff).toBeLessThan(400);
  });

  it('an external camera near the vessel hears a faint structure-borne share, a distant one none', () => {
    const near = steady({ ...externalAt(40), pressure: 0 }, { nozzle: 0 }).engines.find((e) => e.running > 0)!;
    const far = steady({ ...externalAt(3000), pressure: 0 }, { nozzle: 0 }).engines.find((e) => e.running > 0)!;
    expect(near.paths.body.gain).toBeGreaterThan(0);
    expect(gainToDb(near.paths.body.gain)).toBeLessThan(-20);
    expect(far.paths.body.gain).toBe(0);
  });

  it('distance: delay = d / c and the level drops with distance', () => {
    const a = steady(externalAt(50, { height: 0 }));
    const b = steady(externalAt(2000, { height: 0 }));
    const va = a.engines.find((e) => e.running > 0)!;
    const vb = b.engines.find((e) => e.running > 0)!;
    expect(vb.paths.air.delay - va.paths.air.delay).toBeCloseTo((2000 - 50) / 340, 1);
    expect(gainToDb(va.paths.air.gain) - gainToDb(vb.paths.air.gain)).toBeGreaterThan(25);
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

describe('listener kind, not mode', () => {
  it('an unknown mode of kind external yields bit-identical targets to the chase camera', () => {
    const a = run(modeScript(lib, 'chase').frame, 6).map((o) => JSON.stringify(o));
    const b = run(modeScript(lib, 'eva-third-person').frame, 6).map((o) => JSON.stringify(o));
    expect(b).toEqual(a);
  });
  it("kind 'map' is an outside listener", () => {
    const m = steady({ ...externalAt(80), kind: 'map' });
    const c = steady(externalAt(80));
    expect(JSON.stringify(m)).toEqual(JSON.stringify(c));
    expect(m.interior).toBe(false);
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
    const l = listener({ kind: 'interior', mode: 'cockpit', position: seatOf('capsule'), pressure: 0 }, base.activeVesselId);
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
    const l = listener({ kind: 'interior', mode: 'cockpit', position: seatOf('capsule'), pressure: 0 }, base.activeVesselId);
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
      const f = frames({ base, listen: () => ({ kind: 'interior', mode: 'cockpit', position: seatOf('capsule'), pressure: 30000 }), state: () => ({ gLoad: g }) });
      return run(f, 30).flatMap((o) => o.oneShots).filter((o) => o.cause === 'creak').length;
    };
    expect(creaksAt(1)).toBe(0);
    const low = creaksAt(3);
    const high = creaksAt(7);
    expect(high).toBeGreaterThan(low);
    expect(creaksAt(7)).toBe(high);
    expect(steady(externalAt(50)).cabin.ambience).toBe(0);
    expect(steady({ kind: 'interior', mode: 'cockpit', position: seatOf('booster'), pressure: SEA_LEVEL }).cabin.ambience).toBeGreaterThan(0);
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
    const parts = steadyEngines('lander', 1).parts(SEA_LEVEL).map((p) => ({ ...p, def: p.def === 'lab-lyra-d' ? 'no-such-part' : p.def }));
    const m = new SoundModel(cfg, lib);
    const l = listener(externalAt(30), base.activeVesselId);
    const a = m.update({ snapshot: compose(base, { parts }, 0, 0), listener: l, realDt: DT, warpFactor: 1, paused: false });
    const b = m.update({ snapshot: compose(base, { parts }, DT, 1), listener: l, realDt: DT, warpFactor: 1, paused: false });
    expect(a.problems.length).toBe(1);
    expect(a.problems[0]).toContain('no-such-part');
    expect(b.problems).toHaveLength(0);
  });
});
