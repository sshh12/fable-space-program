/**
 * The menu's camera paths (src/camera/menuRigs.ts): the transit starts at the eye and ends at the chase pose over
 * the pad, its altitude falls monotonically in log space, the hold sits at the hold altitude, the exposure hint
 * reaches the pad's exposure at the end, and the menu eye keeps the sun just behind the limb.
 */
import { describe, expect, it } from 'vitest';
import { holdProgress, menuEye, transitSample, type TransitPlan } from '@/camera/menuRigs';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';

const R = 6_371_000;
const plan: TransitPlan = {
  radius: R,
  padLatDeg: 19,
  padLonDeg: -155.6,
  padHeight: 21.6,
  startFixed: v3.scale(latLonToDir(-5 * DEG, -120 * DEG), R + 800_000),
  endOffsetEnu: v3.new(-60, -160, 60),
  holdAltitude: 3000,
  startEv: 13,
  padEv: 5,
  duration: 10,
};

describe('the transit path', () => {
  it('starts at the eye, ends at the chase pose over the pad, and falls monotonically', () => {
    const a = transitSample(plan, 0);
    expect(v3.len(v3.sub(a.positionFixed, plan.startFixed))).toBeLessThan(1);
    const end = transitSample(plan, 1);
    const pad = v3.scale(latLonToDir(plan.padLatDeg * DEG, plan.padLonDeg * DEG), R + plan.padHeight);
    expect(end.altitude).toBeCloseTo(plan.endOffsetEnu.z, 3);
    expect(v3.len(v3.sub(end.positionFixed, pad))).toBeLessThan(v3.len(plan.endOffsetEnu) * 1.05);
    let prev = Infinity;
    for (let i = 0; i <= 200; i++) {
      const s = transitSample(plan, i / 200);
      expect(s.altitude).toBeLessThanOrEqual(prev + 1e-6);
      prev = s.altitude;
    }
  });

  it('holds at the hold altitude and drifts about the pad without changing its height', () => {
    const u = holdProgress(plan);
    const s = transitSample(plan, u);
    expect(s.altitude / plan.holdAltitude).toBeCloseTo(1, 3);
    const turned = transitSample(plan, u, 30 * DEG);
    expect(turned.altitude).toBeCloseTo(s.altitude, 6);
    expect(v3.len(v3.sub(turned.positionFixed, s.positionFixed))).toBeGreaterThan(0);
  });

  it('walks the exposure from the eye to the pad over the lower path and lands on the pad exposure', () => {
    expect(transitSample(plan, 0).exposureHint.targetEv100).toBeCloseTo(plan.startEv, 6);
    expect(transitSample(plan, 1).exposureHint.targetEv100).toBeCloseTo(plan.padEv, 6);
    expect(transitSample(plan, 0.5).exposureHint.rateEvPerS).toBeGreaterThan(0);
  });
});

describe('the menu eye', () => {
  it('stands at its altitude with the sun just behind the limb', () => {
    const body = { rRoot: v3.zero(), sunDir: v3.new(1, 0, 0), spinRoot: v3.new(0, 0, 7.29e-5) };
    const eye = menuEye(body, R, { altitude: 800_000, sunBehindLimbDeg: 2, t: 0, drift: false });
    expect(v3.len(eye.positionRoot)).toBeCloseTo(R + 800_000, 0);
    const up = v3.normalize(eye.positionRoot);
    const dip = Math.acos(R / (R + 800_000));
    const sunElevation = Math.asin(v3.dot(up, body.sunDir));
    expect(sunElevation).toBeLessThan(-dip);
    expect(sunElevation).toBeGreaterThan(-dip - 3 * DEG);
  });
});
