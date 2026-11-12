/**
 * The sound model over the mission's entry (labs/audio/entry.ts: the real Sim's capsule on the nominal lunar
 * return, entry interface to splashdown, recorded by tools/audio/entryProfile.ts). The mission video had the
 * game fall silent right after the plasma phase, while the capsule was still hypersonic and decelerating at
 * several g: for a chase camera the boundary-layer noise had no path (outside the Mach cone, thin air, no
 * structure-borne share) and the roar followed the glow alone.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAudioConfig, type AudioConfig } from '@/audio/config';
import { dbToGain, entryLoad, gainToDb } from '@/audio/mapping';
import { SoundModel, type ModelOutput } from '@/audio/model';
import type { DefLibrary } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { ENTRY_PROFILE, entryStateAt, missionEntryScript, type EntryState } from '../../../labs/audio/entry';

let lib: DefLibrary;
let cfg: AudioConfig;
beforeAll(async () => {
  lib = await loadDefs(fsDefSource());
  cfg = parseAudioConfig(lib);
});

/** The model's targets one second into the entry timeline started at `from`. */
function at(from: number, kind: 'interior' | 'external'): ModelOutput {
  const s = missionEntryScript(lib, { from, duration: 2, kind });
  const m = new SoundModel(cfg, lib);
  let out = m.update(s.frame(0, 0));
  for (let t = 1 / 60; t < 1; t += 1 / 60) out = m.update(s.frame(t, 1 / 60));
  return out;
}

/**
 * Level of the continuous flight sounds, dB: each layer's gain times its path gains and its bus gain, summed
 * as amplitudes (the layers are broadband noise of comparable level; the offline spec measures the real thing).
 * `aero` = the boundary-layer voice alone, `total` = with the entry voice.
 */
function flightDb(o: ModelOutput, kind: 'interior' | 'external'): { aero: number; total: number } {
  const bus = (b: 'aero' | 'reentry'): number => dbToGain(kind === 'interior' ? cfg.mix.buses[b].interiorGainDb : cfg.mix.buses[b].gainDb);
  const aero = (o.aero.wind.gain + o.aero.noise.gain + o.aero.buffet.gain) * (o.aero.paths.air.gain + o.aero.paths.body.gain) * bus('aero');
  const reentry = (o.reentry.roar.gain + o.reentry.rumble.gain + o.reentry.hiss.gain) * (o.reentry.paths.air.gain + o.reentry.paths.body.gain) * bus('reentry');
  return { aero: gainToDb(aero), total: gainToDb(aero + reentry) };
}

const drogues = (): number => ENTRY_PROFILE.marks['DROGUES']!;
const times = (step: number): number[] => {
  const out: number[] = [];
  for (let t = 10; t < drogues() - 5; t += step) out.push(t);
  return out;
};

describe('the recorded entry', () => {
  it('is the mission entry: 10.5 km/s at the interface, a heat pulse, a loft, a second dip, drogues near 7 km', () => {
    const p = ENTRY_PROFILE;
    expect(p.samples.length).toBeGreaterThan(1500);
    expect(entryStateAt(p, p.marks['ENTRY']!).speed).toBeGreaterThan(10000);
    const states = times(5).map((t) => entryStateAt(p, t));
    expect(Math.max(...states.map((s) => s.plasma))).toBe(1);
    expect(Math.max(...states.map((s) => s.gLoad))).toBeGreaterThan(4);
    expect(Math.max(...states.map((s) => s.q))).toBeGreaterThan(15000);
    // After the heat pulse: hypersonic, several g, and almost no glow (what the sound must not depend on).
    const dip = states.filter((s) => s.t > 380 && s.plasma < 0.1 && s.mach > 8 && s.gLoad > 3);
    expect(dip.length).toBeGreaterThan(3);
    expect(entryStateAt(p, drogues()).altitude).toBeLessThan(9000);
  });
});

describe('sound through the entry', () => {
  for (const kind of ['external', 'interior'] as const) {
    const rows = (): { t: number; s: EntryState; aero: number; total: number }[] => times(10).map((t) => ({ t, s: entryStateAt(ENTRY_PROFILE, t + 1), ...flightDb(at(t, kind), kind) }));
    const label = (r: { t: number; s: EntryState }): string => `t ${r.t} s, ${(r.s.altitude / 1000).toFixed(1)} km, Mach ${r.s.mach.toFixed(1)}, q ${r.s.q.toFixed(0)} Pa, plasma ${r.s.plasma.toFixed(2)}`;

    it(`${kind}: never silent while the air loads the capsule (q >= 300 Pa), down to the drogues`, () => {
      const loaded = rows().filter((r) => r.s.q >= 300);
      expect(loaded.length).toBeGreaterThan(60);
      for (const r of loaded) expect(r.total, label(r)).toBeGreaterThan(-60);
    });

    it(`${kind}: the level follows the aerodynamic load, not the glow, from Mach 30 to Mach 0.5`, () => {
      const all = rows();
      // The heat pulse: full plasma at the largest dynamic pressure.
      const pulse = all.filter((r) => r.s.plasma > 0.95).reduce((a, b) => (b.s.q > a.s.q ? b : a));
      const loaded = all.filter((r) => r.s.q >= 5000);
      expect(loaded.length).toBeGreaterThan(20);
      expect(Math.min(...loaded.map((r) => r.s.mach))).toBeLessThan(1);
      for (const r of loaded) {
        const byLoad = 20 * Math.log10(r.s.q / pulse.s.q);
        // The wind is 20 log10(q) all the way down (more where the air carries it to the camera as well).
        expect(r.aero - pulse.aero, `wind, ${label(r)}`).toBeGreaterThan(byLoad - 1);
        // Hypersonic: the whole entry sound follows q, whatever is left of the glow (0.02 to 0.09 in the second dip).
        if (r.s.mach >= 8) expect(r.total - pulse.total, `entry, ${label(r)}`).toBeGreaterThan(byLoad - 3);
      }
      const dip = loaded.filter((r) => r.t > 380 && r.s.mach >= 8 && r.s.plasma < 0.1);
      expect(dip.length).toBeGreaterThan(5);
      expect(Math.max(...dip.map((r) => r.s.gLoad))).toBeGreaterThan(3);
    });

    it(`${kind}: the loft between the two dips is quiet (q under 600 Pa), and louder again in the second dip`, () => {
      const all = rows();
      const peak = Math.max(...all.filter((r) => r.s.plasma > 0.95).map((r) => r.total));
      const loft = all.filter((r) => r.t > 200 && r.t < 340 && r.s.q < 600);
      expect(loft.length).toBeGreaterThan(3);
      for (const r of loft) expect(peak - r.total, label(r)).toBeGreaterThan(20);
      const dip = all.filter((r) => r.t > 400 && r.t < 470);
      expect(Math.max(...dip.map((r) => r.total))).toBeGreaterThan(Math.max(...loft.map((r) => r.total)) + 15);
    });
  }

  it('a chase camera riding with the capsule hears it through the structure while it is outside the Mach cone', () => {
    const o = at(540, 'external');
    const s: EntryState = entryStateAt(ENTRY_PROFILE, 541);
    expect(s.mach).toBeGreaterThan(4);
    expect(o.aero.paths.air.gain).toBe(0);
    expect(o.aero.paths.body.gain).toBeCloseTo(dbToGain(cfg.environment.aero.bodyGainDb + cfg.mix.propagation.attach.gainDb), 6);
    expect(o.aero.wind.gain).toBeGreaterThan(0.1);
  });

  it('the roar and the rumble follow the hypersonic load after the glow has faded; hiss and crackle stay with the plasma', () => {
    const o = at(440, 'interior');
    const s = entryStateAt(ENTRY_PROFILE, 441);
    expect(s.plasma).toBeLessThan(0.06);
    const load = entryLoad(s.q, s.mach, cfg.environment.reentry.load);
    expect(load).toBeGreaterThan(0.5);
    expect(o.reentry.roar.gain).toBeCloseTo(dbToGain(cfg.environment.reentry.roar.gainDb) * load, 2);
    expect(o.reentry.rumble.gain).toBeGreaterThan(0.2);
    expect(o.reentry.hiss.gain).toBeLessThan(0.01);
    expect(o.reentry.crackle.gain).toBeLessThan(0.02);
  });

  it('subsonic under the drogues there is no entry roar, and in vacuum there is nothing', () => {
    const low = at(drogues() + 10, 'external');
    expect(low.reentry.roar.gain).toBe(0);
    expect(low.reentry.rumble.gain).toBe(0);
    const s = missionEntryScript(lib, { from: 0, duration: 1, kind: 'external' });
    const m = new SoundModel(cfg, lib);
    const f = s.frame(0, 0);
    f.snapshot.vessels[0]!.aero.q = 0;
    f.snapshot.vessels[0]!.aero.plasmaIntensity = 0;
    const o = m.update(f);
    expect(o.aero.paths.body.gain).toBe(0);
    expect(o.aero.wind.gain).toBe(0);
    expect(o.reentry.roar.gain).toBe(0);
  });
});
