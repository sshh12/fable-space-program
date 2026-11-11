import { beforeAll, describe, expect, it } from 'vitest';
import { parseAudioConfig, type AudioConfig } from '@/audio/config';
import {
  absorptionCutoff,
  attachFactor,
  buffetWeight,
  combineCutoffs,
  compressorMakeupDb,
  continuousAudible,
  crackleFactor,
  creakRate,
  dbToGain,
  distanceGain,
  engineLevelDb,
  eventScaleDb,
  gainToDb,
  localSoundSpeed,
  pressureCutoff,
  pressureGain,
  retardedDelay,
  structureDb,
  surfaceFactor,
  throttleLever,
  windDb,
} from '@/audio/mapping';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';

let cfg: AudioConfig;
beforeAll(async () => {
  cfg = parseAudioConfig(await loadDefs(fsDefSource()));
});
const prop = (): AudioConfig['mix']['propagation'] => cfg.mix.propagation;

describe('pressure -> airborne gain and cutoff', () => {
  it('is exactly zero in vacuum and unity at sea level', () => {
    expect(pressureGain(0, prop())).toBe(0);
    expect(pressureGain(-5, prop())).toBe(0);
    expect(pressureGain(101325, prop())).toBe(1);
    expect(pressureGain(2e5, prop())).toBe(1);
  });
  it('falls monotonically with altitude-like pressure', () => {
    const ps = [101325, 50000, 20000, 5000, 1000, 100, 10, 1];
    const g = ps.map((p) => pressureGain(p, prop()));
    for (let i = 1; i < g.length; i++) expect(g[i]!).toBeLessThan(g[i - 1]!);
    // (p/p0)^0.6 is 12 dB per decade of pressure: a thousandth of sea level is -36 dB.
    expect(gainToDb(pressureGain(101.325, prop()))).toBeCloseTo(-36, 0);
  });
  it('cutoff falls from the top of the band to its floor as the air thins', () => {
    const [lo, hi] = prop().pressureCutoffHz;
    expect(pressureCutoff(101325, prop())).toBeCloseTo(hi, 6);
    expect(pressureCutoff(0, prop())).toBeCloseTo(lo, 6);
    expect(pressureCutoff(25000, prop())).toBeLessThan(hi);
    expect(pressureCutoff(25000, prop())).toBeGreaterThan(pressureCutoff(2500, prop()));
  });
});

describe('distance -> attenuation, absorption and delay', () => {
  it('is flat inside the near field, inverse-distance beyond it, and silent past the fade', () => {
    expect(distanceGain(5, 30, prop())).toBe(1);
    expect(gainToDb(distanceGain(60, 30, prop()))).toBeCloseTo(-6.02, 2);
    expect(gainToDb(distanceGain(50, 30, prop())) - gainToDb(distanceGain(2000, 30, prop()))).toBeCloseTo(32.04, 1);
    expect(distanceGain(prop().airborneFadeEnd, 30, prop())).toBe(0);
    expect(distanceGain(1e5, 30, prop())).toBe(0);
    const mid = distanceGain((prop().airborneFadeStart + prop().airborneFadeEnd) / 2, 30, prop());
    expect(mid).toBeGreaterThan(0);
  });
  it('air absorption darkens distant sound', () => {
    expect(absorptionCutoff(300, prop())).toBeCloseTo(prop().absorption.refCutoffHz, 6);
    expect(absorptionCutoff(2000, prop())).toBeLessThan(1500);
    expect(absorptionCutoff(10, prop())).toBe(prop().absorption.maxCutoffHz);
  });
  it('combines cutoffs below the smaller of them', () => {
    const c = combineCutoffs(1000, 4000);
    expect(c).toBeLessThan(1000);
    expect(c).toBeGreaterThan(900);
    expect(combineCutoffs(1000)).toBeCloseTo(1000, 9);
  });
  it('retarded delay: d / c for a static source; the exact retarded time for a moving one', () => {
    const c = prop().speedOfSound;
    const max = prop().maxDelay;
    const edge = prop().coneEdge;
    const at = (D: { x: number; y: number; z: number }, V = { x: 0, y: 0, z: 0 }) => retardedDelay(D, V, c, max, edge);
    expect(at({ x: 340, y: 0, z: 0 }).delay).toBeCloseTo(1, 12);
    expect(at({ x: 340, y: 0, z: 0 }).reach).toBe(1);
    expect(at({ x: 0, y: 2000, z: 0 }).delay - at({ x: 0, y: 50, z: 0 }).delay).toBeCloseTo(1950 / c, 12);
    // Source moving at v toward the listener (listener ahead): tau = d / (c - v); away: d / (c + v).
    const v = 100;
    expect(at({ x: 0, y: 1000, z: 0 }, { x: 0, y: v, z: 0 }).delay).toBeCloseTo(1000 / (c - v), 9);
    expect(at({ x: 0, y: -1000, z: 0 }, { x: 0, y: v, z: 0 }).delay).toBeCloseTo(1000 / (c + v), 9);
    // Any geometry: the sound left the source where it was tau ago and travelled c tau.
    const D = { x: 120, y: -40, z: 75 };
    const V = { x: 30, y: 160, z: -20 };
    const tau = at(D, V).delay;
    expect(Math.hypot(D.x + V.x * tau, D.y + V.y * tau, D.z + V.z * tau)).toBeCloseTo(c * tau, 6);
    // Doppler of an approaching source on a static listener: delay-line playback rate c / (c - v).
    const dt = 0.01;
    const rate = 1 - (at({ x: 0, y: 1000 - v * dt, z: 0 }, { x: 0, y: v, z: 0 }).delay - at({ x: 0, y: 1000, z: 0 }, { x: 0, y: v, z: 0 }).delay) / dt;
    expect(rate).toBeCloseTo(c / (c - v), 6);
    // Out of the delay line's reach: no airborne sound.
    expect(at({ x: 1e7, y: 0, z: 0 })).toEqual({ delay: max, reach: 0 });
  });
  it('supersonic sources are heard only inside their Mach cone, behind them', () => {
    const c = prop().speedOfSound;
    const r = (D: { x: number; y: number; z: number }, mach: number) => retardedDelay(D, { x: 0, y: mach * c, z: 0 }, c, prop().maxDelay, prop().coneEdge);
    // A listener riding ahead of the nozzles (the cockpit, a chase camera beside the nose): nothing above Mach 1.
    expect(r({ x: 0, y: 60, z: 0 }, 1.5).reach).toBe(0);
    expect(r({ x: 0, y: 60, z: 0 }, 1.0).reach).toBe(0);
    expect(r({ x: 0, y: 60, z: 0 }, 0.5).reach).toBe(1);
    // Beside the vehicle (90 degrees off the flight path): outside the cone at Mach 1.5.
    expect(r({ x: 60, y: 0, z: 0 }, 1.5).reach).toBe(0);
    // Trailing behind, 20 degrees off the axis: inside the cone (half-angle asin(1/1.5) = 42 degrees).
    const behind = r({ x: 60 * Math.sin(0.35), y: -60 * Math.cos(0.35), z: 0 }, 1.5);
    expect(behind.reach).toBe(1);
    expect(behind.delay).toBeGreaterThan(0);
  });
  it('local speed of sound follows the vessel Mach number when it moves', () => {
    expect(localSoundSpeed(2, 600, prop())).toBe(300);
    expect(localSoundSpeed(0, 0, prop())).toBe(prop().speedOfSound);
  });
});

describe('master dynamics', () => {
  it("knows the DynamicsCompressorNode's automatic makeup gain, so it can be cancelled", () => {
    // Hard knee: the static curve at 0 dBFS is T (1 - 1/R) dB; the node adds 0.6 x its inverse.
    expect(compressorMakeupDb(-4, 0, 20)).toBeCloseTo(0.6 * 4 * (1 - 1 / 20), 9);
    expect(compressorMakeupDb(-30, 0, 3)).toBeCloseTo(0.6 * 30 * (1 - 1 / 3), 9);
    // A soft knee reduces less at 0 dBFS than the hard knee at the knee's end would (and more than none).
    const soft = compressorMakeupDb(-32, 8, 2);
    expect(soft).toBeGreaterThan(0.6 * 24 * (1 - 1 / 2));
    expect(soft).toBeLessThan(0.6 * 32 * (1 - 1 / 2));
  });
});

describe('structure-borne paths', () => {
  it('attenuate along the structure down to a floor', () => {
    expect(structureDb(0, prop())).toBe(-0);
    expect(structureDb(20, prop())).toBeCloseTo(-20 * prop().structure.dbPerMetre, 9);
    expect(structureDb(1e4, prop())).toBe(prop().structure.minDb);
  });
  it('reach an external camera only near the vessel', () => {
    expect(attachFactor(0, prop())).toBe(1);
    expect(attachFactor(prop().attach.fullDistance, prop())).toBe(1);
    expect(attachFactor(prop().attach.maxDistance, prop())).toBe(0);
    const m = attachFactor((prop().attach.fullDistance + prop().attach.maxDistance) / 2, prop());
    expect(m).toBeCloseTo(0.5, 9);
  });
  it('reach a chase camera over the whole zoom range of every vehicle (vacuum is muffled, not mute)', async () => {
    // Only a camera attached to the vessel receives this share (AudioListener.attachedVesselId), so the
    // range follows the chase rigs: full at the default distance, still clearly there halfway out.
    const defs = await loadDefs(fsDefSource());
    const chase = Object.values(defs.vehicles).map((v) => v.cameras.chase);
    expect(chase.length).toBeGreaterThan(0);
    for (const c of chase) {
      expect(attachFactor(c.defaultDistance, prop())).toBeGreaterThan(0.95);
      expect(attachFactor(c.maxDistance / 2, prop())).toBeGreaterThan(0.25);
      expect(attachFactor(c.maxDistance, prop())).toBeLessThan(0.05);
    }
  });
});

describe('thrust and lever -> level', () => {
  it('rises 10 * throttleExponent dB per decade of thrust and adds the power sum of a cluster', () => {
    const p = cfg.engines.profiles['engine.methalox-booster']!;
    const full = engineLevelDb(p.refThrust, 1, 1, p, cfg.engines);
    expect(full - engineLevelDb(0.1 * p.refThrust, 1, 1, p, cfg.engines)).toBeCloseTo(10 * p.throttleExponent, 9);
    expect(engineLevelDb(p.refThrust, 9, 1, p, cfg.engines) - full).toBeCloseTo(10 * Math.log10(9), 9);
    expect(engineLevelDb(0, 9, 1, p, cfg.engines)).toBe(-Infinity);
    expect(dbToGain(engineLevelDb(0, 9, 1, p, cfg.engines))).toBe(0);
  });
  it('drops throttleRangeDb over the throttle range, so the lever is heard on engines that throttle only to 50 %', () => {
    const p = cfg.engines.profiles['engine.methalox-booster']!;
    expect(engineLevelDb(p.refThrust, 1, 1, p, cfg.engines) - engineLevelDb(p.refThrust, 1, 0, p, cfg.engines)).toBeCloseTo(p.throttleRangeDb, 9);
    // The sim's lever law on a minThrottle 0.5 engine: lever 0.1 -> throttleActual 0.55.
    const lever = (l: number): number => throttleLever(0.5 + 0.5 * l, 0.5, true);
    expect(lever(0.1)).toBeCloseTo(0.1, 12);
    const at = (l: number): number => engineLevelDb((0.5 + 0.5 * l) * p.refThrust, 9, lever(l), p, cfg.engines);
    expect(at(1) - at(0.1)).toBeGreaterThanOrEqual(12);
    for (let l = 0.1; l < 1; l += 0.1) expect(at(l + 0.1)).toBeGreaterThan(at(l));
  });
  it('lever: position in the throttle range; 1 for solids and fixed burns, 0 while spooling below the range', () => {
    expect(throttleLever(1, 0.5, true)).toBe(1);
    expect(throttleLever(0.75, 0.5, true)).toBeCloseTo(0.5, 12);
    expect(throttleLever(0.3, 0.5, true)).toBe(0);
    expect(throttleLever(0.4, 1, false)).toBe(1);
    expect(throttleLever(0, 1, false)).toBe(0);
  });
  it('makes the nine-engine booster cluster far louder than the lander engine', () => {
    const b = cfg.engines.profiles['engine.methalox-booster']!;
    const l = cfg.engines.profiles['engine.lander-descent']!;
    expect(engineLevelDb(b.refThrust, 9, 1, b, cfg.engines) - engineLevelDb(l.refThrust, 1, 1, l, cfg.engines)).toBeGreaterThan(20);
  });
  it('has crackle only where there is air at the nozzle', () => {
    expect(crackleFactor(0, 1, prop())).toBe(0);
    expect(crackleFactor(101325, 1, prop())).toBe(1);
    expect(crackleFactor(10132.5, 1, prop())).toBeCloseTo(0.1, 12);
  });
});

describe('aero, reentry, cabin and events', () => {
  it('wind follows 20 log10(q / qRef), capped', () => {
    expect(windDb(0, 30000, 6)).toBe(-Infinity);
    expect(windDb(30000, 30000, 6)).toBeCloseTo(0, 12);
    expect(windDb(3000, 30000, 6)).toBeCloseTo(-20, 9);
    expect(windDb(1e7, 30000, 6)).toBe(6);
  });
  it('transonic buffet peaks at its Mach centre', () => {
    expect(buffetWeight(1, 1, 0.2)).toBe(1);
    expect(buffetWeight(0.5, 1, 0.2)).toBeLessThan(0.05);
    expect(buffetWeight(1.2, 1, 0.2)).toBeCloseTo(Math.exp(-0.5), 12);
  });
  it('surface ambience is full near the ground and gone well above it', () => {
    expect(surfaceFactor(0, 150, 1500)).toBe(1);
    expect(surfaceFactor(150, 150, 1500)).toBe(1);
    expect(surfaceFactor(825, 150, 1500)).toBeCloseTo(0.5, 12);
    expect(surfaceFactor(1500, 150, 1500)).toBe(0);
  });
  it('continuous sounds stop above physics warp', () => {
    expect(continuousAudible(1, 4)).toBe(true);
    expect(continuousAudible(4, 4)).toBe(true);
    expect(continuousAudible(5, 4)).toBe(false);
  });
  it('creaks come faster with g-load, its rate of change and sunlight changes', () => {
    const c = cfg.environment.cabin.creaks;
    expect(creakRate(0, 0, 0, c)).toBe(0);
    expect(creakRate(c.gMin, 0, 0, c)).toBe(0);
    expect(creakRate(c.gMax, 0, 0, c)).toBeCloseTo(c.maxRate, 12);
    expect(creakRate(4, 0, 0, c)).toBeLessThan(creakRate(6, 0, 0, c));
    expect(creakRate(1, 2, 0, c)).toBeCloseTo(2 * c.jerkRate, 12);
    expect(creakRate(0, 0, 0.5, c)).toBeCloseTo(0.5 * c.thermalRate, 12);
  });
  it('scales event levels by speed and clamps', () => {
    const s = { ref: 2.5, exponent: 1, minDb: -18, maxDb: 8 };
    expect(eventScaleDb(2.5, s)).toBeCloseTo(0, 12);
    expect(eventScaleDb(5, s)).toBeCloseTo(6.02, 2);
    expect(eventScaleDb(0, s)).toBe(-18);
    expect(eventScaleDb(1000, s)).toBe(8);
  });
});
