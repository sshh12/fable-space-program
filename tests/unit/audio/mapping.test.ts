import { beforeAll, describe, expect, it } from 'vitest';
import { parseAudioConfig, type AudioConfig } from '@/audio/config';
import {
  absorptionCutoff,
  attachFactor,
  buffetWeight,
  combineCutoffs,
  continuousAudible,
  crackleFactor,
  creakRate,
  dbToGain,
  distanceGain,
  engineLevelDb,
  eventScaleDb,
  gainToDb,
  pressureCutoff,
  pressureGain,
  propagationDelay,
  structureDb,
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
  it('delay = distance / c for a static source, retarded for a moving one', () => {
    const c = prop().speedOfSound;
    expect(propagationDelay(340, 0, prop())).toBeCloseTo(1, 12);
    expect(propagationDelay(2000, 0, prop()) - propagationDelay(50, 0, prop())).toBeCloseTo(1950 / c, 12);
    // Receding at 100 m/s: the sound now arriving left when the source was closer.
    expect(propagationDelay(1000, 100, prop())).toBeCloseTo(1000 / (c + 100), 12);
    // Doppler playback rate of the delay line stays positive even for supersonic recession.
    const v = 3 * c;
    const dt = 0.01;
    const rate = 1 - (propagationDelay(1000 + v * dt, v, prop()) - propagationDelay(1000, v, prop())) / dt;
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeCloseTo(c / (c + v), 6);
    expect(propagationDelay(1e7, 0, prop())).toBe(prop().maxDelay);
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
});

describe('thrust -> level', () => {
  it('rises 10 * throttleExponent dB per decade of thrust and adds the power sum of a cluster', () => {
    const p = cfg.engines.profiles['engine.methalox-booster']!;
    const full = engineLevelDb(p.refThrust, 1, p, cfg.engines);
    expect(full - engineLevelDb(0.1 * p.refThrust, 1, p, cfg.engines)).toBeCloseTo(10 * p.throttleExponent, 9);
    expect(engineLevelDb(p.refThrust, 9, p, cfg.engines) - full).toBeCloseTo(10 * Math.log10(9), 9);
    expect(engineLevelDb(0, 9, p, cfg.engines)).toBe(-Infinity);
    expect(dbToGain(engineLevelDb(0, 9, p, cfg.engines))).toBe(0);
  });
  it('makes the nine-engine booster cluster far louder than the lander engine', () => {
    const b = cfg.engines.profiles['engine.methalox-booster']!;
    const l = cfg.engines.profiles['engine.lander-descent']!;
    expect(engineLevelDb(b.refThrust, 9, b, cfg.engines) - engineLevelDb(l.refThrust, 1, l, cfg.engines)).toBeGreaterThan(20);
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
