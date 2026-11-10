/** Re-asserts tools/sim/start-time.json with the exported constraint checks (src/sim/nav/startWindow.ts). */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import { DEG } from '../../../src/core/math/scalar';
import type { BodySystem } from '../../../src/sim/bodies/bodySystem';
import { checkStartConstraints, START_CONSTRAINT_DEFAULTS, type StartConstraintOptions, type StartLaunchKind, type SurfacePoint } from '../../../src/sim/nav/startWindow';
import { loadWorld, repoRoot } from './fixtures';

interface StartTimeFile {
  startUt: number;
  site: { id: string; bodyId: string; latDeg: number; lonDeg: number; padElevation: number };
  targetBodyId: string;
  landing: { bodyId: string; latDeg: number; lonDeg: number };
  launch: { opportunityUt: number; launchAzimuthDeg: number };
  padSun: { elevationDeg: number };
  landingSun: { minDeg: number; maxDeg: number };
  search: { from: string; to: string; searchExtended: boolean; nearMissesInRequestedRange?: { startUt: number }[] };
  constraints: {
    launchKind: StartLaunchKind;
    padSunElevationDeg: [number, number];
    landingWindowDays: [number, number];
    landingSunElevationDeg: [number, number];
  };
  otherLaunchKinds: {
    results: { launchKind: StartLaunchKind; solutionsInRequestedRange: number; chosen: { startUt: number; ascending: boolean } | null; solutions: { startUt: number; ascending: boolean }[] }[];
  };
}

/** The constraint values the file was generated with (defaults unless the tool was run with overrides). */
const optionsOf = (s: StartTimeFile, launchKind: StartLaunchKind = s.constraints.launchKind): StartConstraintOptions => ({
  launchKind,
  padSunElevationDeg: s.constraints.padSunElevationDeg,
  landingWindow: [s.constraints.landingWindowDays[0] * 86400, s.constraints.landingWindowDays[1] * 86400],
  landingSunElevationDeg: s.constraints.landingSunElevationDeg,
});
const J2000_MS = Date.UTC(2000, 0, 1, 12);
const utOfIso = (s: string): number => (Date.parse(s) - J2000_MS) / 1000;

let defs: DefLibrary;
let sys: BodySystem;
let st: StartTimeFile;
let site: SurfacePoint;
let landing: { bodyId: string; latitude: number; longitude: number };

beforeAll(async () => {
  ({ defs, system: sys } = await loadWorld());
  st = JSON.parse(await fs.readFile(path.join(repoRoot, 'tools', 'sim', 'start-time.json'), 'utf8')) as StartTimeFile;
  site = { bodyId: st.site.bodyId, latitude: st.site.latDeg * DEG, longitude: st.site.lonDeg * DEG, elevation: st.site.padElevation };
  landing = { bodyId: st.landing.bodyId, latitude: st.landing.latDeg * DEG, longitude: st.landing.lonDeg * DEG };
});

describe('scenario start time', () => {
  it('records the site coordinates of the definitions it was computed for', () => {
    const def = defs.sites[st.site.id]!;
    expect(def).toBeDefined();
    expect(st.site.latDeg).toBe(def.location.latDeg);
    expect(st.site.lonDeg).toBe(def.location.lonDeg);
    expect(st.site.bodyId).toBe(def.bodyId);
    if (typeof def.location.padElevation === 'number') expect(st.site.padElevation).toBe(def.location.padElevation);
  });

  it('satisfies the three constraints (launch 600 +/- 30 s, pad Sun 10-35 deg rising, landing Sun 5-35 deg rising and lit)', () => {
    const r = checkStartConstraints(sys, site, st.targetBodyId, landing, st.startUt, optionsOf(st));
    expect(r.launch.ok).toBe(true);
    expect(Math.abs(r.launch.delay! - 600)).toBeLessThanOrEqual(30);
    expect(r.padSun.ok).toBe(true);
    expect(r.landingSun.ok).toBe(true);
    expect(r.ok).toBe(true);
    // the recorded angles are what the check computes
    expect(r.launch.crossingUt).toBeCloseTo(st.launch.opportunityUt, 3);
    expect(r.launch.launchAzimuthDeg!).toBeCloseTo(st.launch.launchAzimuthDeg, 3);
    expect(r.padSun.elevationDeg).toBeCloseTo(st.padSun.elevationDeg, 3);
    expect(r.landingSun.minDeg).toBeCloseTo(st.landingSun.minDeg, 3);
    expect(r.landingSun.maxDeg).toBeCloseTo(st.landingSun.maxDeg, 3);
  });

  it('the checks reject a start that misses the window and the recorded near misses', () => {
    expect(checkStartConstraints(sys, site, st.targetBodyId, landing, st.startUt + 3 * 3600, optionsOf(st)).launch.ok).toBe(false);
    expect(checkStartConstraints(sys, site, st.targetBodyId, landing, st.startUt + 86164.0905, optionsOf(st)).ok).toBe(false);
    for (const m of st.search.nearMissesInRequestedRange ?? []) {
      const r = checkStartConstraints(sys, site, st.targetBodyId, landing, m.startUt, optionsOf(st));
      expect(r.launch.ok).toBe(true);
      expect(r.ok).toBe(false);
    }
  });

  it('the recorded launch kind is honoured: ascending = northbound crossing, the other kinds as recorded', () => {
    const asc = checkStartConstraints(sys, site, st.targetBodyId, landing, st.startUt, optionsOf(st));
    if (st.constraints.launchKind === 'ascending') expect(asc.launch.ascending).toBe(true);
    if (st.constraints.launchKind === 'descending') expect(asc.launch.ascending).toBe(false);
    // the default is the brief's definition, and an explicit undefined keeps it
    expect(START_CONSTRAINT_DEFAULTS.launchKind).toBe('ascending');
    const und = checkStartConstraints(sys, site, st.targetBodyId, landing, st.startUt, { ...optionsOf(st), launchKind: undefined });
    expect(und.launch.ascending).toBe(true);
    // every solution recorded for another launch kind passes the checks with that kind, inside the requested range
    const from = utOfIso(st.search.from);
    const to = utOfIso(st.search.to);
    for (const alt of st.otherLaunchKinds.results) {
      expect(alt.solutions).toHaveLength(Math.min(12, alt.solutionsInRequestedRange));
      for (const s of alt.solutions) {
        const r = checkStartConstraints(sys, site, st.targetBodyId, landing, s.startUt, optionsOf(st, alt.launchKind));
        expect(r.ok).toBe(true);
        expect(r.launch.ascending).toBe(s.ascending);
        expect(r.launch.delay!).toBeCloseTo(600, 6);
        expect(s.startUt).toBeGreaterThanOrEqual(from);
        expect(s.startUt).toBeLessThan(to);
        if (alt.launchKind === 'ascending') expect(s.ascending).toBe(true);
        if (alt.launchKind === 'descending') expect(s.ascending).toBe(false);
      }
      if (alt.chosen) expect(alt.solutions.map((s) => s.startUt)).toContain(alt.chosen.startUt);
    }
  });
});
