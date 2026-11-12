/**
 * The two comparisons of mission records (tools/dev/mission-baseline.ts) and the shape of the tracked
 * baseline, tests/mission/baseline-v1.json. Nothing here flies: the comparisons are exercised on the
 * baseline itself and on copies of it changed in stated ways.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  angleDifference,
  compareEnvelope,
  compareExact,
  describeEnvelope,
  describeExact,
  elementsOf,
  ENVELOPE_DA_FLOOR,
  ENVELOPE_DE_FLOOR,
  ENVELOPE_DI_FLOOR,
  ENVELOPE_TIME_FLOOR,
  milestoneDifferences,
  missionTime,
  normaliseRecord,
  parseControls,
  type MissionRecord,
} from './mission-baseline';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseline = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'mission', 'baseline-v1.json'), 'utf8')) as MissionRecord;
const mu = (bodyId: string): number => (JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'bodies', `${bodyId}.json`), 'utf8')) as { mu: number }).mu;

const clone = (r: MissionRecord): MissionRecord => JSON.parse(JSON.stringify(r)) as MissionRecord;
interface Change {
  dt?: number;
  da?: number;
  de?: number;
  di?: number;
  body?: string;
  situation?: string;
}
/**
 * A copy of the record whose named milestone happens `dt` seconds later with its semi-major axis scaled by
 * (1 + da), its eccentricity raised by `de` and its inclination by `di` rad, about `body` in `situation`.
 */
function moved(r: MissionRecord, label: string, changes: Record<string, Change>, startShift = 0): MissionRecord {
  const c = clone(r);
  c.label = label;
  c.startUt += startShift;
  for (const m of c.milestones) {
    const ch = changes[m.id] ?? {};
    m.ut += startShift + (ch.dt ?? 0);
    m.captureUt += startShift + (ch.dt ?? 0);
    m.elements.a *= 1 + (ch.da ?? 0);
    m.elements.e += ch.de ?? 0;
    m.elements.i += ch.di ?? 0;
    if (ch.body !== undefined) m.bodyId = ch.body;
    if (ch.situation !== undefined) m.situation = ch.situation;
  }
  return c;
}

describe('the tracked mission baseline', () => {
  it('is a format-2 record of the 17 milestones with the two comparisons described in it', () => {
    expect(baseline.format).toBe(2);
    expect(baseline.label).toBe('v1');
    expect(baseline.stateHash).toBe('3f3a131cdd88eba7');
    expect(baseline.steps).toBe(593636);
    expect(baseline.milestones.map((m) => m.id)).toEqual([
      'LIFTOFF', 'MAX_Q', 'STAGE_SEP_1', 'FAIRING_JETTISON', 'STAGE_SEP_2', 'EARTH_ORBIT', 'TLI_COMPLETE', 'MOON_SOI_ENTER', 'LUNAR_ORBIT',
      'LUNAR_TOUCHDOWN', 'LUNAR_LIFTOFF', 'MOON_SOI_EXIT', 'EARTH_PERIGEE_TARGETED', 'ENTRY_INTERFACE', 'DROGUE_DEPLOY', 'MAIN_DEPLOY', 'SPLASHDOWN',
    ]);
    expect(baseline.compare.exact).toMatch(/^EXACT/);
    expect(baseline.compare.envelope).toMatch(/^ENVELOPE/);
    expect((baseline as unknown as { tolerances?: unknown }).tolerances).toBeUndefined();
  });

  it('states the capture offset of every milestone: at the event, or at most one control tick after it', () => {
    for (const m of baseline.milestones) {
      expect(m.captureOffset, m.id).toBe(m.captureUt - m.ut);
      expect(m.captureOffset, m.id).toBeGreaterThanOrEqual(0);
      expect(m.captureOffset, m.id).toBeLessThanOrEqual(1 / 30 + 1e-6);
      expect(m.ut - baseline.startUt, m.id).toBeGreaterThan(0);
    }
    // Five are captured one to three physics steps after the event, four of them under thrust or drag.
    expect(baseline.milestones.filter((m) => m.captureOffset > 1e-6).map((m) => m.id)).toEqual(['MAX_Q', 'FAIRING_JETTISON', 'LUNAR_LIFTOFF', 'ENTRY_INTERFACE', 'SPLASHDOWN']);
  });

  it('carries elements that are the elements of its states', () => {
    for (const m of baseline.milestones) {
      const el = elementsOf(mu(m.bodyId), { x: m.r[0], y: m.r[1], z: m.r[2] }, { x: m.v[0], y: m.v[1], z: m.v[2] });
      expect(Math.abs(el.a - m.elements.a) / Math.abs(m.elements.a), `${m.id} a`).toBeLessThan(1e-12);
      expect(Math.abs(el.e - m.elements.e), `${m.id} e`).toBeLessThan(1e-12);
      for (const k of ['i', 'lan', 'argPe'] as const) expect(angleDifference(el[k], m.elements[k]), `${m.id} ${k}`).toBeLessThan(1e-9);
    }
  });
});

describe('angles', () => {
  it('differ the short way round, so a node near zero is as comparable as one near pi', () => {
    expect(angleDifference(0.001, 2 * Math.PI - 0.001)).toBeCloseTo(0.002, 12);
    expect(angleDifference(3, 3 + 1e-7)).toBeCloseTo(1e-7, 12);
    expect(angleDifference(0.0084, 0.0084 + 1e-7)).toBeCloseTo(1e-7, 12);
    expect(angleDifference(-Math.PI, Math.PI)).toBeCloseTo(0, 12);
  });
});

describe('EXACT', () => {
  it('a record equals itself, whatever its label, its elements or its true anomaly say', () => {
    const same = clone(baseline);
    same.label = 'again';
    for (const m of same.milestones) m.elements.nu += 0.5;
    const diffs = compareExact(baseline, same);
    expect(diffs).toEqual([]);
    expect(describeExact(baseline, same, diffs)).toMatch(/all 17 milestones equal/);
  });

  it('one bit of one state is found, with the milestone at which the difference starts', () => {
    const changed = clone(baseline);
    const tli = changed.milestones.findIndex((m) => m.id === 'TLI_COMPLETE');
    changed.milestones[tli]!.r[0] = changed.milestones[tli]!.r[0] * (1 + 2 ** -52);
    for (let k = tli + 1; k < changed.milestones.length; k++) changed.milestones[k]!.ut += 0.25;
    const diffs = compareExact(baseline, changed);
    expect(diffs[0]).toMatchObject({ milestone: 'TLI_COMPLETE', index: tli });
    expect(diffs[0]!.fields.map((f) => f.field)).toEqual(['r[0]']);
    expect(diffs).toHaveLength(changed.milestones.length - tli);
    const text = describeExact(baseline, changed, diffs);
    expect(text).toMatch(/starts at TLI_COMPLETE/);
    expect(text).toMatch(/Equal before it: LIFTOFF, MAX_Q, STAGE_SEP_1, FAIRING_JETTISON, STAGE_SEP_2, EARTH_ORBIT\./);
  });

  it('a changed fact of a milestone and a missing milestone are differences', () => {
    const changed = clone(baseline);
    changed.milestones[0]!.data['mass'] = changed.milestones[0]!.data['mass']! + 1;
    changed.milestones.pop();
    const diffs = compareExact(baseline, changed);
    expect(diffs.map((d) => d.milestone)).toEqual(['LIFTOFF', 'SPLASHDOWN']);
    expect(diffs[0]!.fields[0]!.field).toBe('data.mass');
    expect(diffs[1]!.fields[0]).toMatchObject({ field: 'present', reference: true, candidate: false });
  });
});

describe('ENVELOPE', () => {
  // Controls: the reference code with shifted starts moves like this (the order of what sim-core-v2 measured).
  const controls = [
    moved(baseline, 'control +2 ms', { EARTH_ORBIT: { da: 4.8e-5, de: -4.4e-5, di: 1.7e-7 }, TLI_COMPLETE: { da: 1.6e-3, dt: 0.4 }, LUNAR_TOUCHDOWN: { dt: 47 }, SPLASHDOWN: { dt: 15 } }, 0.002),
    moved(baseline, 'control -3 ms', { EARTH_ORBIT: { da: -2.0e-5, de: 1.4e-7, di: 4.6e-6 }, TLI_COMPLETE: { da: -0.9e-3, dt: -0.2 }, LUNAR_TOUCHDOWN: { dt: -30 }, SPLASHDOWN: { dt: 22 } }, -0.003),
  ];

  it('event time is mission time: a shifted start alone is no difference', () => {
    const shifted = moved(baseline, 'shifted', {}, 0.004);
    for (const d of milestoneDifferences(baseline, shifted)) {
      expect(Math.abs(d.dTime), d.id).toBeLessThan(1e-6);
      expect(d.dA, d.id).toBe(0);
    }
    expect(missionTime(shifted, shifted.milestones[0]!)).toBeCloseTo(missionTime(baseline, baseline.milestones[0]!), 6);
  });

  it('a flight inside twice the spread of the controls passes; the table names every milestone', () => {
    const flight = moved(baseline, 'tick grid', { EARTH_ORBIT: { da: 9.0e-5 }, TLI_COMPLETE: { da: -3.0e-3, dt: 0.7 }, LUNAR_TOUCHDOWN: { dt: -90 }, SPLASHDOWN: { dt: 40 } }, 1 / 240);
    const rows = compareEnvelope(baseline, flight, controls);
    expect(rows.every((r) => r.pass)).toBe(true);
    const touchdown = rows.find((r) => r.id === 'LUNAR_TOUCHDOWN')!;
    expect(touchdown.controlTime).toBeCloseTo(47, 6);
    expect(touchdown.allowedTime).toBeCloseTo(94, 6);
    const tli = rows.find((r) => r.id === 'TLI_COMPLETE')!;
    expect(tli.allowedA).toBeCloseTo(3.2e-3, 9);
    const text = describeEnvelope(rows);
    for (const m of baseline.milestones) expect(text).toContain(m.id);
    expect(text).toMatch(/all 17 milestones about the reference's body in its situation and inside twice the controls' spread in event time, da\/a, e and i/);
  });

  it('a flight outside it fails, and says by how much', () => {
    const late = moved(baseline, 'late', { LUNAR_TOUCHDOWN: { dt: 95 } });
    const rowsLate = compareEnvelope(baseline, late, controls);
    expect(rowsLate.filter((r) => !r.pass).map((r) => r.id)).toEqual(['LUNAR_TOUCHDOWN']);
    expect(rowsLate.find((r) => !r.pass)!.why).toMatch(/event time differs by 95\.000 s, allowed 94\.000 s/);
    const wide = moved(baseline, 'wide', { TLI_COMPLETE: { da: 3.3e-3 } });
    const rowsWide = compareEnvelope(baseline, wide, controls);
    expect(rowsWide.filter((r) => !r.pass).map((r) => r.id)).toEqual(['TLI_COMPLETE']);
    expect(describeEnvelope(rowsWide)).toMatch(/1 of 17 milestones outside \(TLI_COMPLETE\)/);
  });

  it('e and i are judged like the time and da/a, and every reason is named', () => {
    const orbit = (flight: MissionRecord) => compareEnvelope(baseline, flight, controls).find((r) => r.id === 'EARTH_ORBIT')!;
    const inside = orbit(moved(baseline, 'inside', { EARTH_ORBIT: { de: 8.0e-5, di: -9.0e-6 } }));
    expect(inside.controlE).toBeCloseTo(4.4e-5, 12);
    expect(inside.allowedE).toBeCloseTo(8.8e-5, 12);
    expect(inside.controlI).toBeCloseTo(4.6e-6, 12);
    expect(inside.allowedI).toBeCloseTo(9.2e-6, 12);
    expect(inside.pass).toBe(true);
    const round = orbit(moved(baseline, 'rounder', { EARTH_ORBIT: { de: -1.0e-4 } }));
    expect(round.pass).toBe(false);
    expect(round.why).toMatch(/^de -1\.00e-4, allowed 8\.80e-5$/);
    const tilted = orbit(moved(baseline, 'tilted', { EARTH_ORBIT: { di: 1.0e-5 } }));
    expect(tilted.pass).toBe(false);
    expect(tilted.why).toMatch(/^di 1\.00e-5 rad, allowed 9\.20e-6 rad$/);
    // Everything that is outside is named, not only the first.
    const all = orbit(moved(baseline, 'all four', { EARTH_ORBIT: { dt: 5, da: 1e-3, de: 1e-3, di: 1e-3 } }));
    expect(all.why).toMatch(/event time differs by 5\.000 s.*; da\/a 1\.00e-3.*; de 1\.00e-3.*; di 1\.00e-3 rad/);
    // Only the milestone concerned fails.
    expect(compareEnvelope(baseline, moved(baseline, 'tilted', { EARTH_ORBIT: { di: 1.0e-5 } }), controls).filter((r) => !r.pass).map((r) => r.id)).toEqual(['EARTH_ORBIT']);
  });

  it('a flight about another body or in another situation at a milestone fails there, whatever its elements', () => {
    const other = compareEnvelope(baseline, moved(baseline, 'still about the Earth', { LUNAR_ORBIT: { body: 'earth' } }), controls);
    expect(other.filter((r) => !r.pass).map((r) => r.id)).toEqual(['LUNAR_ORBIT']);
    expect(other.find((r) => !r.pass)!.why).toBe('about earth, reference about moon');
    const landed = compareEnvelope(baseline, moved(baseline, 'came down on land', { SPLASHDOWN: { situation: 'landed' } }), controls);
    expect(landed.filter((r) => !r.pass).map((r) => r.id)).toEqual(['SPLASHDOWN']);
    expect(landed.find((r) => !r.pass)!.why).toBe('situation landed, reference splashed');
    expect(describeEnvelope(landed)).toMatch(/SPLASHDOWN .*OUTSIDE: situation landed, reference splashed/);
    // A control that is about another body there leaves the milestone without an envelope: the controls are at fault.
    const strayed = [controls[0]!, moved(controls[1]!, 'control that strayed', { LUNAR_ORBIT: { body: 'earth' } })];
    const rows = compareEnvelope(baseline, baseline, strayed);
    expect(rows.filter((r) => !r.pass).map((r) => r.id)).toEqual(['LUNAR_ORBIT']);
    expect(rows.find((r) => !r.pass)!.why).toMatch(/control flight 2 is about earth, reference about moon here.*controls file is unusable/);
  });

  it('where the controls do not move at all, the floors apply: one control tick and 1e-12', () => {
    const rows = compareEnvelope(baseline, moved(baseline, 'nudged', { MAX_Q: { dt: 0.03, da: 5e-13 } }), controls);
    const maxQ = rows.find((r) => r.id === 'MAX_Q')!;
    expect(maxQ.controlTime).toBeLessThan(1e-6);
    expect(maxQ.allowedTime).toBe(ENVELOPE_TIME_FLOOR);
    expect(maxQ.allowedA).toBe(ENVELOPE_DA_FLOOR);
    expect(maxQ.allowedE).toBe(ENVELOPE_DE_FLOOR);
    expect(maxQ.allowedI).toBe(ENVELOPE_DI_FLOOR);
    expect(maxQ.pass).toBe(true);
    expect(compareEnvelope(baseline, moved(baseline, 'noise', { MAX_Q: { de: 5e-13, di: -5e-13 } }), controls).find((r) => r.id === 'MAX_Q')!.pass).toBe(true);
    expect(compareEnvelope(baseline, moved(baseline, 'off', { MAX_Q: { de: 1e-9 } }), controls).find((r) => r.id === 'MAX_Q')!.pass).toBe(false);
    expect(compareEnvelope(baseline, moved(baseline, 'off', { MAX_Q: { di: 1e-9 } }), controls).find((r) => r.id === 'MAX_Q')!.pass).toBe(false);
    expect(compareEnvelope(baseline, moved(baseline, 'off', { MAX_Q: { dt: 0.05 } }), controls).find((r) => r.id === 'MAX_Q')!.pass).toBe(false);
    expect(compareEnvelope(baseline, moved(baseline, 'off', { MAX_Q: { da: 1e-9 } }), controls).find((r) => r.id === 'MAX_Q')!.pass).toBe(false);
  });

  it('needs two controls, each with every milestone; a flight that misses a milestone fails there', () => {
    expect(() => compareEnvelope(baseline, baseline, [controls[0]!])).toThrow(/at least two control flights/);
    const short = clone(controls[1]!);
    short.milestones.pop();
    const rows = compareEnvelope(baseline, baseline, [controls[0]!, short]);
    expect(rows.find((r) => r.id === 'SPLASHDOWN')!.why).toMatch(/controls file is unusable/);
    const flight = clone(baseline);
    flight.milestones.pop();
    expect(compareEnvelope(baseline, flight, controls).find((r) => r.id === 'SPLASHDOWN')!.why).toBe('the milestone was not reached');
  });

  it('reports angle differences wrapped, never the true anomaly, and the capture offsets of both', () => {
    const flight = clone(baseline);
    const m = flight.milestones.find((x) => x.id === 'LUNAR_ORBIT')!;
    m.elements.lan = (m.elements.lan + 2 * Math.PI - 1e-7) % (2 * Math.PI);
    m.elements.nu += 1;
    m.captureUt += 1 / 120;
    m.captureOffset += 1 / 120;
    const d = milestoneDifferences(baseline, flight).find((x) => x.id === 'LUNAR_ORBIT')!;
    expect(d.dLan).toBeCloseTo(1e-7, 12);
    expect(d.captureOffset[1] - d.captureOffset[0]).toBeCloseTo(1 / 120, 9);
    expect(Object.keys(d).some((k) => /nu/i.test(k))).toBe(false);
    expect(d.dTime).toBe(0);
  });

  it('reads a controls file as an array or as { controls }, and records written before format 2', () => {
    expect(parseControls(controls).map((c) => c.label)).toEqual(['control +2 ms', 'control -3 ms']);
    expect(parseControls({ controls })).toHaveLength(2);
    expect(() => parseControls({ flights: controls })).toThrow(/controls file/);
    const old = clone(baseline) as unknown as Record<string, unknown> & { milestones: Record<string, unknown>[] };
    delete old['format'];
    delete old['label'];
    for (const m of old.milestones) delete m['captureOffset'];
    const read = normaliseRecord(old as unknown as MissionRecord, 'old.json');
    expect(read.label).toBe('old.json');
    expect(read.milestones.map((m) => m.captureOffset)).toEqual(baseline.milestones.map((m) => m.captureOffset));
    expect(compareExact(baseline, read)).toEqual([]);
  });
});
