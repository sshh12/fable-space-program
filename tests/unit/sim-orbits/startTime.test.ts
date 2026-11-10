/** Re-asserts tools/sim/start-time.json with the exported constraint checks (src/sim/nav/startWindow.ts). */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import { DEG } from '../../../src/core/math/scalar';
import type { BodySystem } from '../../../src/sim/bodies/bodySystem';
import { checkStartConstraints, type SurfacePoint } from '../../../src/sim/nav/startWindow';
import { loadWorld, repoRoot } from './fixtures';

interface StartTimeFile {
  startUt: number;
  site: { id: string; bodyId: string; latDeg: number; lonDeg: number; padElevation: number };
  targetBodyId: string;
  landing: { bodyId: string; latDeg: number; lonDeg: number };
  launch: { opportunityUt: number; launchAzimuthDeg: number };
  padSun: { elevationDeg: number };
  landingSun: { minDeg: number; maxDeg: number };
  search: { searchExtended: boolean; nearMissesInRequestedRange?: { startUt: number }[] };
}

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
  });

  it('satisfies the three constraints (launch 600 +/- 30 s, pad Sun 10-35 deg rising, landing Sun 5-35 deg rising and lit)', () => {
    const r = checkStartConstraints(sys, site, st.targetBodyId, landing, st.startUt);
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
    expect(checkStartConstraints(sys, site, st.targetBodyId, landing, st.startUt + 3 * 3600).launch.ok).toBe(false);
    expect(checkStartConstraints(sys, site, st.targetBodyId, landing, st.startUt + 86164.0905).ok).toBe(false);
    for (const m of st.search.nearMissesInRequestedRange ?? []) {
      const r = checkStartConstraints(sys, site, st.targetBodyId, landing, m.startUt);
      expect(r.launch.ok).toBe(true);
      expect(r.ok).toBe(false);
    }
  });
});
