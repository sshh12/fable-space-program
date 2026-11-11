import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { v3, type Vec3 } from '@/core/math';
import { planetshineAt } from '@/render/core';
import { bruteForceIrradiance, planetshineWeights, projectSh, referenceRadiance, type ReferenceScene } from '@/render/sky/probeScene';
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
