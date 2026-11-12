/**
 * The trajectory guard at the level of the vessel dynamics (MIGRATION_V2 principle 4): the six fixtures of
 * fixtures.ts are flown again and must equal their recordings BIT FOR BIT: every vessel's position,
 * velocity, attitude, body rate and mass at every sample, and every event at its step. The recordings are
 * never re-recorded; see fixtures.ts for what may be adapted when the vessel model changes (the drivers only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { loadLibrary } from '../helpers';
import { FIXTURE_NAMES, flyFixture, fromBits, type FixtureRecording, type VesselSample } from './fixtures';

const dir = path.dirname(fileURLToPath(import.meta.url));
let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

const FIELDS: (keyof Pick<VesselSample, 'r' | 'v' | 'q' | 'w'>)[] = ['r', 'v', 'q', 'w'];

/** The first difference between a flight and its recording, in words (null when they are equal). */
function firstDifference(recorded: FixtureRecording, flown: FixtureRecording): string | null {
  if (recorded.runs.length !== flown.runs.length) return `${flown.runs.length} runs, recorded ${recorded.runs.length}`;
  for (let k = 0; k < recorded.runs.length; k++) {
    const a = recorded.runs[k]!;
    const b = flown.runs[k]!;
    const where = `${recorded.name} / ${a.label}`;
    if (a.steps !== b.steps) return `${where}: ${b.steps} steps, recorded ${a.steps}`;
    if (a.samples.length !== b.samples.length) return `${where}: ${b.samples.length} samples, recorded ${a.samples.length}`;
    for (let i = 0; i < a.samples.length; i++) {
      const sa = a.samples[i]!;
      const sb = b.samples[i]!;
      if (sa.step !== sb.step) return `${where}: sample ${i} at step ${sb.step}, recorded at step ${sa.step}`;
      if (sa.vessels.length !== sb.vessels.length) return `${where}, step ${sa.step}: ${sb.vessels.length} vessels, recorded ${sa.vessels.length}`;
      for (let n = 0; n < sa.vessels.length; n++) {
        const va = sa.vessels[n]!;
        const vb = sb.vessels[n]!;
        for (const f of FIELDS) {
          for (let c = 0; c < va[f].length; c++) {
            if (va[f][c] !== vb[f][c]) return `${where}, step ${sa.step}, vessel ${n}: ${f}[${c}] = ${fromBits(vb[f][c]!)} (${vb[f][c]}), recorded ${fromBits(va[f][c]!)} (${va[f][c]}); difference ${fromBits(vb[f][c]!) - fromBits(va[f][c]!)}`;
          }
        }
        if (va.mass !== vb.mass) return `${where}, step ${sa.step}, vessel ${n}: mass ${fromBits(vb.mass)}, recorded ${fromBits(va.mass)}`;
        if (va.parts !== vb.parts || va.hold !== vb.hold || va.destroyed !== vb.destroyed) return `${where}, step ${sa.step}, vessel ${n}: ${vb.parts} parts, hold ${vb.hold}, destroyed ${vb.destroyed}; recorded ${va.parts}, ${va.hold}, ${va.destroyed}`;
      }
    }
    for (let i = 0; i < Math.max(a.events.length, b.events.length); i++) {
      if (a.events[i] !== b.events[i]) return `${where}: event ${i} is ${b.events[i] ?? 'missing'}, recorded ${a.events[i] ?? 'none'}`;
    }
  }
  return null;
}

describe('trajectory fixtures (bit-exact)', () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name}: every vessel at every sample and every event equal the recording`, () => {
      const file = path.join(dir, `${name}.json`);
      expect(fs.existsSync(file), `${name}.json is missing: the fixtures are recorded once and kept (record.ts)`).toBe(true);
      const recorded = JSON.parse(fs.readFileSync(file, 'utf8')) as FixtureRecording;
      const flown = flyFixture(defs, name);
      expect(firstDifference(recorded, flown)).toBeNull();
      // And nothing else in the recording differs either (labels, the sample grid).
      expect(JSON.stringify(flown)).toBe(JSON.stringify(recorded));
    });
  }

  it('the comparison finds a difference of one bit', () => {
    const recorded = JSON.parse(fs.readFileSync(path.join(dir, 'staging.json'), 'utf8')) as FixtureRecording;
    const moved = JSON.parse(JSON.stringify(recorded)) as FixtureRecording;
    const sample = moved.runs[1]!.samples[7]!.vessels[2]!;
    const last = sample.v[1]!;
    sample.v[1] = last.slice(0, 15) + (last[15] === '0' ? '1' : '0');
    expect(firstDifference(recorded, moved)).toMatch(/tower and fairing jettison.*vessel 2: v\[1\]/);
    expect(firstDifference(recorded, recorded)).toBeNull();
  });
});
