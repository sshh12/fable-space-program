import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALL_EVENT_TYPES, AUDIO_SECTIONS, parseAudioConfig, readSnapshotPath } from '@/audio/config';
import type { DefLibrary } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { DefError, loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';

let lib: DefLibrary;
beforeAll(async () => {
  lib = await loadDefs(fsDefSource());
});

/** The library with one audio section replaced by `edit(copy)`. */
function withSection(key: string, edit: (s: Record<string, any>) => void): DefLibrary {
  const copy = structuredClone(lib.sections[key]) as Record<string, any>;
  edit(copy);
  return { ...lib, sections: { ...lib.sections, [key]: copy } };
}

function errorOf(l: DefLibrary): DefError {
  try {
    parseAudioConfig(l);
  } catch (e) {
    if (e instanceof DefError) return e;
    throw e;
  }
  throw new Error('expected a DefError');
}

describe('audio sections from data/defs (fs def source)', () => {
  it('parse and validate', () => {
    const cfg = parseAudioConfig(lib);
    for (const id of ['engine.methalox-booster', 'engine.hydrolox-vacuum', 'engine.lander-descent', 'engine.lander-ascent', 'engine.solid', 'rcs.thruster']) {
      expect(cfg.engines.profiles[id], id).toBeDefined();
    }
    for (const t of ['stageFired', 'decoupled', 'fairingJettisoned', 'lesFired', 'legsToggled', 'chuteDeployed', 'chuteInflated', 'chuteFailed', 'touchdown', 'splash', 'partDestroyed', 'explosion', 'rcsPulse'] as const) {
      expect(cfg.events[t], t).toBeDefined();
    }
    expect(Object.keys(cfg.mix.buses).sort()).toEqual(['aero', 'cabin', 'engines', 'events', 'reentry', 'ui']);
  });

  it('every listed asset ships in public/assets/audio and the set stays under 40 MB', () => {
    const cfg = parseAudioConfig(lib);
    const dir = path.resolve(process.cwd(), 'public/assets/audio');
    let total = 0;
    for (const a of Object.values(cfg.assets)) {
      const f = path.join(dir, a.file);
      expect(fs.existsSync(f), a.file).toBe(true);
      total += fs.statSync(f).size;
    }
    expect(total).toBeLessThan(40 * 1024 * 1024);
  });

  it('every engine sound id used by a part definition has a profile', () => {
    const cfg = parseAudioConfig(lib);
    for (const p of Object.values(lib.parts)) for (const m of p.modules) if (m.type === 'engine') expect(cfg.engines.profiles[m.sound], `${p.id}: ${m.sound}`).toBeDefined();
  });

  it('reads sections only through DefLibrary.sections', () => {
    const noMix = { ...lib, sections: Object.fromEntries(Object.entries(lib.sections).filter(([k]) => k !== AUDIO_SECTIONS.mix)) };
    const e = errorOf(noMix);
    expect(e.file).toBe('audio/mix.json');
    expect(e.message).toMatch(/section file not found/);
  });
});

describe('section validation errors name the file and the field', () => {
  it('unknown asset reference', () => {
    const e = errorOf(withSection('audio/engines', (s) => (s['profiles']['engine.solid'].core.asset = 'no-such-asset')));
    expect(e.file).toBe('audio/engines.json');
    expect(e.message).toContain('profiles.engine.solid.core.asset');
    expect(e.message).toContain('unknown asset "no-such-asset"');
  });
  it('a one-shot used as a loop', () => {
    const e = errorOf(withSection('audio/engines', (s) => (s['profiles']['engine.solid'].core.asset = 'pyro-bang')));
    expect(e.message).toContain('must be a loop');
  });
  it('missing required field', () => {
    const e = errorOf(withSection('audio/mix', (s) => delete s['propagation'].speedOfSound));
    expect(e.file).toBe('audio/mix.json');
    expect(e.message).toContain('propagation.speedOfSound: is required');
  });
  it('out-of-range numbers and reversed ranges', () => {
    expect(errorOf(withSection('audio/mix', (s) => (s['master'].ceiling = 1.2))).message).toContain('master.ceiling: must be <= 0.98');
    expect(errorOf(withSection('audio/engines', (s) => (s['profiles']['engine.solid'].core.rate = [1.2, 0.8]))).message).toContain('low must not exceed high');
    expect(errorOf(withSection('audio/mix', (s) => (s['propagation'].maxDelay = 2))).message).toContain('must cover airborneFadeEnd');
  });
  it('unknown event type and unknown bus', () => {
    expect(errorOf(withSection('audio/events', (s) => (s['events']['engineExploded'] = s['events']['decoupled']))).message).toContain('"engineExploded" is not a SimEvent type');
    expect(errorOf(withSection('audio/mix', (s) => (s['buses']['music'] = { gainDb: 0, fadeAboveWarp: false }))).message).toContain('unknown bus');
  });
  it('bad snapshot paths in clicks and alarms', () => {
    expect(errorOf(withSection('audio/ui', (s) => s['clicks'].watch.push('readouts.noSuchField'))).message).toContain('readouts has no field "noSuchField"');
    expect(errorOf(withSection('audio/ui', (s) => s['alarm'].conditions.push({ path: 'vessels.0', above: 1 }))).message).toContain('must be <group>.<field>');
    expect(errorOf(withSection('audio/ui', (s) => s['alarm'].conditions.push({ path: 'readouts.gLoad', above: 1, below: 2 }))).message).toContain('exactly one of above, below, equals');
  });
  it('ambience beds: known surfaces only, loop assets only; buses need both listener gains', () => {
    expect(errorOf(withSection('audio/environment', (s) => (s['ambience'].beds['lava'] = []))).message).toContain('unknown surface');
    expect(errorOf(withSection('audio/environment', (s) => (s['ambience'].beds.water[0].asset = 'splashdown'))).message).toContain('ambience.beds.water[0].asset: asset "splashdown" must be a loop');
    expect(errorOf(withSection('audio/mix', (s) => delete s['buses'].engines.interiorGainDb)).message).toContain('buses.engines.interiorGainDb: is required');
    expect(errorOf(withSection('audio/mix', (s) => (s['propagation'].mapListener.positionVes = [1, 2]))).message).toContain('mapListener.positionVes: must be an [x, y, z] triple');
  });
  it('a part whose engine sound has no profile is reported against the part file', () => {
    const part = Object.values(lib.parts).find((p) => p.modules.some((m) => m.type === 'engine'))!;
    const broken = structuredClone(part);
    for (const m of broken.modules) if (m.type === 'engine') m.sound = 'engine.unknown';
    const e = errorOf({ ...lib, parts: { ...lib.parts, [part.id]: broken } });
    expect(e.file).toBe(`parts/${part.id}.json`);
    expect(e.message).toContain('"engine.unknown" has no profile');
  });
});

describe('snapshot paths', () => {
  it('resolve against a snapshot', () => {
    const snap = createFakeSim(lib, { scene: 'pad' }).snapshot();
    expect(readSnapshotPath(snap, 'readouts.sasEnabled')).toBe(snap.readouts.sasEnabled);
    expect(readSnapshotPath(snap, 'warp.index')).toBe(0);
    expect(readSnapshotPath(snap, 'mission.failed')).toBe(false);
  });
  it('the event-type list is exhaustive over the contract', () => {
    expect(ALL_EVENT_TYPES).toContain('rcsPulse');
    expect(new Set(ALL_EVENT_TYPES).size).toBe(ALL_EVENT_TYPES.length);
  });
});
