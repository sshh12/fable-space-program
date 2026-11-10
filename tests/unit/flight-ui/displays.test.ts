import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import {
  buildMfdPage,
  describeLandingTarget,
  describeResources,
  describeStages,
  describeWarp,
  formatBearing,
  formatCountdown,
  formatDuration,
  formatLength,
  formatMet,
  formatNumber,
  formatSignedRange,
  formatUt,
  landingTargetRows,
  MFD_PAGES,
  NBSP,
} from '@/ui';
import { WARP_LEVELS } from '@/core/contracts/defs';
import { labVehicleParts, tagLabVehicle, withLabVehicle } from '../../../labs/flight-ui/labVehicle';

let defs: DefLibrary;
beforeAll(async () => {
  defs = withLabVehicle(await loadDefs(fsDefSource()));
});

const snap = (scene: FakeScene): SimSnapshot => {
  const sim = createFakeSim(defs, { scene, parts: labVehicleParts(defs) });
  for (let i = 0; i < 30; i++) sim.advance(1 / 60);
  return tagLabVehicle(sim.snapshot());
};

const n = (s: string): string => s.replaceAll(NBSP, ' ');

describe('formatters', () => {
  it('formats lengths with SI prefixes and grouping', () => {
    expect(n(formatLength(12.34))).toBe('12.3 m');
    expect(n(formatLength(8765.4))).toBe('8 765 m');
    expect(n(formatLength(12_345))).toBe('12.35 km');
    expect(n(formatLength(12_345, 'altitude'))).toBe('12 345 m');
    expect(n(formatLength(2_298_300))).toBe('2 298.3 km');
    expect(n(formatLength(384_400_000))).toBe('384.4 Mm');
    expect(n(formatLength(-6_360_200))).toBe('−6 360.2 km');
    expect(n(formatLength(2e9))).toBe('200.0 Mm'.replace('200.0 Mm', '2 000.0 Mm'));
    expect(n(formatLength(2e10))).toBe('20.000 Gm');
  });

  it('formats durations, countdowns, MET and UT', () => {
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(n(formatDuration(3 * 86400 + 4 * 3600 + 5 * 60 + 6))).toBe('3d 04:05');
    expect(n(formatCountdown(600))).toBe('T− 10:00');
    expect(n(formatCountdown(-12))).toBe('T+ 0:12');
    expect(n(formatMet(3725))).toBe('T+ 01:02:05');
    expect(formatUt(0)).toBe('2000-01-01 12:00:00 UTC');
    expect(formatUt(86400 + 3661)).toBe('2000-01-02 13:01:01 UTC');
  });

  it('spells out signs of ranges and normalises bearings', () => {
    expect(n(formatSignedRange(12_300, 'ahead', 'behind'))).toBe('12.30 km ahead');
    expect(n(formatSignedRange(-450, 'right', 'left'))).toBe('450 m left');
    expect(formatSignedRange(0.2, 'ahead', 'behind')).toBe('on track');
    expect(formatBearing(-3)).toBe('357°');
    expect(formatBearing(45.4)).toBe('045°');
    expect(formatBearing(359.7)).toBe('000°');
    expect(n(formatNumber(-0.0001, 2))).toBe('0.00');
  });
});

describe('display models', () => {
  it('describes the lunar landing target of the FakeSim lunar scenes', () => {
    for (const scene of ['lunarOrbit', 'lunarSurface'] as const) {
      const s = snap(scene);
      const lt = s.readouts.landingTarget!;
      const view = describeLandingTarget(s)!;
      expect(view.name).toBe('Tranquility Base');
      expect(view.kindLabel).toBe('Landing target');
      expect(view.distance).toBe(formatLength(lt.distance));
      expect(view.bearing).toBe(formatBearing(lt.bearingDeg));
      expect(view.predicted).toBeNull();
      const rows = landingTargetRows(view);
      expect(rows.map((r) => r[0])).toEqual(['Distance', 'Bearing', 'Down-range', 'Cross-range', 'Predicted arrival']);
      if (scene === 'lunarOrbit') {
        expect(view.downRange).toMatch(/ (ahead|behind)$/);
        expect(view.crossRange).toMatch(/ (left|right)$/);
      } else {
        expect(view.downRange).toBe('no ground track');
      }
    }
  });

  it('labels a predicted impact and a predicted entry point', () => {
    const s = snap('lunarOrbit');
    const lt = s.readouts.landingTarget!;
    const withImpact = { ...s, readouts: { ...s.readouts, landingTarget: { ...lt, predicted: { kind: 'impact' as const, ut: s.ut + 100, latitude: 0, longitude: 0, missDistance: 1234, missBearingDeg: 90 } } } };
    const v = describeLandingTarget(withImpact)!;
    expect(landingTargetRows(v)[4]).toEqual(['Impact miss', `1${NBSP}234${NBSP}m · 090°`]);
    const withEntry = { ...s, readouts: { ...s.readouts, landingTarget: { ...lt, predicted: { kind: 'entry' as const, ut: s.ut + 100, latitude: 0, longitude: 0, missDistance: 12, missBearingDeg: 271 } } } };
    expect(landingTargetRows(describeLandingTarget(withEntry)!)[4]![0]).toBe('Entry point miss');
  });

  it('MFD landing and entry pages carry exactly the landing-target rows of the HUD panel', () => {
    for (const scene of ['lunarOrbit', 'lunarSurface', 'reentry'] as const) {
      const s = snap(scene);
      const rows = landingTargetRows(describeLandingTarget(s)!);
      for (const page of ['landing', 'entry'] as const) {
        const m = buildMfdPage(page, s, defs);
        expect(m.section!.rows.map((r) => [r.label, r.value])).toEqual(rows);
      }
    }
  });

  it('builds every MFD page for every scene', () => {
    for (const scene of ['pad', 'ascent', 'lowOrbit', 'translunar', 'lunarOrbit', 'lunarSurface', 'reentry', 'chutes'] as const) {
      const s = snap(scene);
      for (const page of MFD_PAGES) {
        const m = buildMfdPage(page, s, defs);
        expect(m.rows.length).toBeGreaterThan(0);
        for (const r of [...m.rows, ...(m.section?.rows ?? [])]) expect(r.value).not.toMatch(/NaN|undefined/);
      }
    }
  });

  it('aggregates resources per stage group in vehicle order', () => {
    const sim = createFakeSim(defs, { scene: 'lowOrbit', parts: labVehicleParts(defs, { upper: 0.25 }, ['upper', 'lander', 'capsule']) });
    const groups = describeResources(tagLabVehicle(sim.snapshot()), defs);
    expect(groups.map((g) => g.label)).toEqual(['M-2 upper stage', 'Lander', 'Capsule']);
    expect(groups[0]!.bars.map((b) => b.name)).toEqual(['RP-1', 'Liquid oxygen']);
    expect(groups[0]!.bars[0]!.fraction).toBeCloseTo(0.25, 9);
    // Without a vehicle definition, everything is one group under the vessel name.
    const untagged = describeResources(sim.snapshot(), defs);
    expect(untagged.map((g) => g.label)).toEqual(['Fake vessel']);
  });

  it('describes stages and the warp limit', () => {
    const sim = createFakeSim(defs, { scene: 'ascent' });
    sim.commands.stage();
    const s = sim.snapshot();
    const st = describeStages(s);
    expect(st.tiles[0]!.fired).toBe(true);
    expect(st.tiles[1]!.next).toBe(true);
    const w = describeWarp(s, WARP_LEVELS);
    expect(w.limit).toMatch(/^Limited to ×4: /);
  });
});
