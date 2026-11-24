/**
 * The lunar mission's start on the Sun-rooted library: `checkStartConstraints` passes for lunar-direct's start
 * time (tools/sim/start-time.json) with the staged bodies, and every angle it computes is the one the shipped
 * library gives (the Sun direction at the Earth reproduces v1; the Moon's frozen ellipse is unchanged).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEG } from '../../../src/core/math/scalar';
import { checkStartConstraints, sunAtSurfacePoint, type StartConstraintOptions, type StartLaunchKind, type SurfacePoint } from '../../../src/sim/nav/startWindow';
import { loadShipped, loadStaged, repoRoot, type World } from './fixtures';

interface StartTimeFile {
  startUt: number;
  site: { id: string; bodyId: string; latDeg: number; lonDeg: number; padElevation: number };
  targetBodyId: string;
  landing: { bodyId: string; latDeg: number; lonDeg: number };
  launch: { opportunityUt: number; launchAzimuthDeg: number };
  padSun: { elevationDeg: number };
  landingSun: { minDeg: number; maxDeg: number };
  constraints: { launchKind: StartLaunchKind; padSunElevationDeg: [number, number]; landingWindowDays: [number, number]; landingSunElevationDeg: [number, number] };
}

let staged: World;
let shipped: World;
let st: StartTimeFile;
let site: SurfacePoint;
let landing: { bodyId: string; latitude: number; longitude: number };
let options: StartConstraintOptions;

beforeAll(async () => {
  [staged, shipped] = await Promise.all([loadStaged(), loadShipped()]);
  st = JSON.parse(await fs.readFile(path.join(repoRoot, 'tools', 'sim', 'start-time.json'), 'utf8')) as StartTimeFile;
  site = { bodyId: st.site.bodyId, latitude: st.site.latDeg * DEG, longitude: st.site.lonDeg * DEG, elevation: st.site.padElevation };
  landing = { bodyId: st.landing.bodyId, latitude: st.landing.latDeg * DEG, longitude: st.landing.lonDeg * DEG };
  options = {
    launchKind: st.constraints.launchKind,
    padSunElevationDeg: st.constraints.padSunElevationDeg,
    landingWindow: [st.constraints.landingWindowDays[0] * 86400, st.constraints.landingWindowDays[1] * 86400],
    landingSunElevationDeg: st.constraints.landingSunElevationDeg,
  };
});

describe("lunar-direct's start time on the staged library", () => {
  it('satisfies the three constraints, with the angles recorded in start-time.json', () => {
    const r = checkStartConstraints(staged.system, site, st.targetBodyId, landing, st.startUt, options);
    expect(r.ok).toBe(true);
    expect(r.launch.ok).toBe(true);
    expect(Math.abs(r.launch.delay! - 600)).toBeLessThanOrEqual(30);
    expect(r.launch.crossingUt).toBeCloseTo(st.launch.opportunityUt, 3);
    expect(r.launch.launchAzimuthDeg!).toBeCloseTo(st.launch.launchAzimuthDeg, 3);
    expect(r.padSun.elevationDeg).toBeCloseTo(st.padSun.elevationDeg, 3);
    expect(r.landingSun.minDeg).toBeCloseTo(st.landingSun.minDeg, 3);
    expect(r.landingSun.maxDeg).toBeCloseTo(st.landingSun.maxDeg, 3);
  });

  it('the Sun at the pad and at the landing site is the shipped library’s to rounding over the stay', () => {
    let worstElev = 0;
    let worstVis = 0;
    for (let k = 0; k <= 400; k++) {
      const ut = st.startUt + (k / 400) * 6 * 86400;
      for (const p of [site, { ...landing, elevation: 0 }]) {
        const a = sunAtSurfacePoint(staged.system, p, ut);
        const b = sunAtSurfacePoint(shipped.system, p, ut);
        worstElev = Math.max(worstElev, Math.abs(a.elevation - b.elevation));
        worstVis = Math.max(worstVis, Math.abs(a.visibility - b.visibility));
      }
    }
    expect(worstElev / DEG).toBeLessThan(1e-9);
    expect(worstVis).toBeLessThan(1e-9);
  });
});
