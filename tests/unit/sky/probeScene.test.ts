import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { FrameContext } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { v3, type Vec3 } from '@/core/math';
import { planetshineAt } from '@/render/core';
import { bruteForceIrradiance, planetshineWeights, probeGroundSphere, probeSceneOf, projectSh, referenceRadiance, PROBE_MIN_GROUND_HEIGHT, type ReferenceScene } from '@/render/sky/probeScene';
import { shIrradiance } from '@/render/sky/photometry';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

const snap = (scene: 'lowOrbit' | 'lunarSurface' | 'translunar'): SimSnapshot => createFakeSim(defs, { scene }).snapshot();

describe('probe weights against the render core planetshine (no light counted twice)', () => {
  it('low orbit: the Earth is in the probe alone, the Moon is planetshine alone', () => {
    const s = snap('lowOrbit');
    const v = s.vessels[0]!.rRoot;
    const w = planetshineWeights(v, v, s, defs);
    expect(w.has(defs.rootBodyId)).toBe(false);
    const moon = [...w.keys()][0]!;
    expect(w.get(moon)).toBe(1);
    // The core's list for the Earth receiver is exactly that body.
    expect(planetshineAt(s.bodies.find((b) => b.id === defs.rootBodyId)!.rRoot, defs.rootBodyId, s, defs).map((x) => x.bodyId)).toEqual([moon]);
  });

  it('on the lunar surface the Earth is planetshine and the Moon\'s ground is in the probe', () => {
    const s = snap('lunarSurface');
    const v = s.vessels[0]!;
    const w = planetshineWeights(v.rRoot, v.rRoot, s, defs);
    expect(w.has(v.bodyId)).toBe(false);
    expect(w.get(defs.rootBodyId)).toBe(1);
  });

  it('far out (translunar) every body is planetshine and the probe holds the sky only', () => {
    const s = snap('translunar');
    const v = s.vessels[0]!.rRoot;
    const w = planetshineWeights(v, v, s, defs);
    for (const b of s.bodies) if (b.id !== s.starId) expect(w.get(b.id)).toBe(1);
  });
});

describe('probe ground sphere (the active vessel\'s body)', () => {
  const R = 1_737_400;
  it('is the reference sphere in orbit, also over depressions and mountains', () => {
    for (const radar of [100e3, 100e3 + 9000, 100e3 - 5000]) {
      const g = probeGroundSphere(R, R + 100e3, radar);
      expect(g.radius).toBe(R);
      expect(g.height).toBeCloseTo(100e3, 6);
    }
  });
  it('goes through the actual ground below the datum, never closer than PROBE_MIN_GROUND_HEIGHT', () => {
    // Landed at the site 1907.8 m below the datum, origin 3 m above the ground (radar 0 once held, 3 m hovering).
    const landed = probeGroundSphere(R, R - 1904.8, 3);
    expect(landed.radius).toBeCloseTo(R - 1907.8, 6);
    expect(landed.height).toBeCloseTo(3, 6);
    expect(probeGroundSphere(R, R - 1904.8, 0).height).toBeCloseTo(PROBE_MIN_GROUND_HEIGHT, 6);
    // A capsule floating with its origin 0.5 m under the sea surface (radar 0).
    expect(probeGroundSphere(6_371_000, 6_371_000 - 0.5, 0).height).toBeCloseTo(PROBE_MIN_GROUND_HEIGHT, 6);
  });
  it('is continuous through a descent over ground below the datum', () => {
    const ground = -1907.8;
    let prev: { radius: number; height: number } | null = null;
    for (let h = 3000; h >= ground + 3; h -= 0.25) {
      const g = probeGroundSphere(R, R + h, h - ground);
      expect(g.height).toBeGreaterThan(0);
      expect(g.radius).toBeLessThanOrEqual(R);
      expect(g.radius).toBeGreaterThanOrEqual(R + ground - 1e-6);
      if (prev) expect(Math.abs(g.radius - prev.radius)).toBeLessThan(0.25 + 1e-6);
      prev = g;
    }
  });
  it('lights the ground-facing side at a landing site below the datum as just above the datum (CPU reference)', () => {
    const s = snap('lunarSurface');
    const v = s.vessels[0]!;
    const moon = s.bodies.find((b) => b.id === v.bodyId)!;
    const R0 = defs.bodies[v.bodyId]!.radius;
    const up = v3.normalize(v3.sub(v.rRoot, moon.rRoot));
    const north = v3.normalize(v3.anyOrthogonal(up));
    const sunDir = v3.normalize(v3.add(v3.scale(up, Math.sin(0.6)), v3.scale(north, Math.cos(0.6))));
    const irradianceDown = (altitude: number, radar: number): number => {
      const rRoot = v3.addScaled(moon.rRoot, up, R0 + altitude);
      const snapshot: SimSnapshot = { ...s, vessels: s.vessels.map((x) => (x.id === v.id ? { ...x, rRoot } : x)), readouts: { ...s.readouts, altitudeRadar: radar } };
      const frame = { snapshot, camera: { positionRoot: rRoot }, sun: { bodyId: s.starId }, bodies: s.bodies.map((b) => ({ id: b.id, cameraAltitude: v3.dist(rRoot, b.rRoot) - (defs.bodies[b.id]?.radius ?? 0) })) } as unknown as FrameContext;
      const scene = probeSceneOf(frame, defs);
      const ref: ReferenceScene = {
        bodies: scene.bodies.map((b) => ({ centre: b.centre, radius: b.radius, weight: b.weight, albedo: [0.12, 0.12, 0.12], sunDir: b.id === v.bodyId ? sunDir : s.bodies.find((x) => x.id === b.id)!.sunDir })),
        sunE: [130_000, 130_000, 130_000],
        sunRadius: 0.00465,
        background: [0, 0, 0],
      };
      return bruteForceIrradiance((d) => referenceRadiance(ref, d), v3.neg(up), 200)[0];
    };
    const datum = irradianceDown(30, 30);
    const site = irradianceDown(-1904.8, 3);
    expect(datum).toBeGreaterThan(0.12 * 130_000 * Math.sin(0.6) * 0.95);
    expect(Math.abs(site / datum - 1)).toBeLessThan(0.02);
  });
});

describe('CPU reference of the probe', () => {
  it('a sunlit Lambert sphere filling the lower sky: SH9 irradiance facing it within 5 % of the exact integral', () => {
    const scene: ReferenceScene = {
      bodies: [{ centre: { x: 0, y: 0, z: -6_571_000 }, radius: 6_371_000, weight: 1, albedo: [0.3, 0.3, 0.3], sunDir: v3.normalize({ x: 0.3, y: 0, z: 1 }) }],
      sunE: [128_000, 128_000, 128_000],
      sunRadius: 0.00465,
      background: [0, 0, 0],
    };
    const L = (d: Vec3) => referenceRadiance(scene, d);
    const sh = projectSh(L, 48);
    for (const n of [{ x: 0, y: 0, z: -1 }, v3.normalize({ x: 1, y: 0, z: -1 }), v3.normalize({ x: 0, y: 1, z: -0.2 })]) {
      const exact = bruteForceIrradiance(L, n, 300)[0];
      expect(Math.abs(shIrradiance(sh, n)[0] / exact - 1)).toBeLessThan(0.05);
    }
    // Looking straight down at a Lambert sphere of albedo A lit at mu_s: E ~ A E_sun mu_s x (fraction of the sky).
    const down = bruteForceIrradiance(L, { x: 0, y: 0, z: -1 }, 300)[0];
    expect(down).toBeGreaterThan(0.3 * 128_000 * 0.9 * 0.7);
    expect(down).toBeLessThan(0.3 * 128_000);
    // Space-facing: nothing.
    expect(bruteForceIrradiance(L, { x: 0, y: 0, z: 1 }, 200)[0]).toBe(0);
  });
});
