/**
 * CPU budgets: propagate < 2 us per call; predictPatches with a node through an SOI change < 1 ms.
 * Medians of repeated batches (robust against scheduler noise on a shared machine). Wave-1 numbers taken
 * while the data bakes run are provisional (docs/PACKAGE_RULES.md rule 16).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ManeuverNode } from '../../../src/core/contracts/sim';
import { v3, type Vec3 } from '../../../src/core/math/vec3';
import type { BodySystem } from '../../../src/sim/bodies/bodySystem';
import { makeOrbit, propagateInto } from '../../../src/sim/orbit/kepler';
import { predictPatches } from '../../../src/sim/orbit/patches';
import { loadWorld, mainIds, utOf } from './fixtures';

let sys: BodySystem;
let EARTH = '';
let MOON = '';
const T0 = utOf(2028, 3, 1);

beforeAll(async () => {
  ({ system: sys } = await loadWorld());
  ({ root: EARTH, moon: MOON } = mainIds(sys));
});

const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('timings', () => {
  it('propagate under 2 microseconds', () => {
    const mu = sys.body(EARTH).mu;
    const orbits = [
      makeOrbit(EARTH, mu, { x: 6.7e6, y: 0, z: 0 }, { x: 0, y: 7.0e3, z: 2.9e3 }, T0),
      makeOrbit(EARTH, mu, { x: 6.556e6, y: 0, z: 0 }, { x: 0, y: 10.93e3, z: 0 }, T0),
      makeOrbit(EARTH, mu, { x: 6.556e6, y: 0, z: 0 }, { x: 0, y: 12.5e3, z: 1e3 }, T0),
    ];
    const r = { x: 0, y: 0, z: 0 };
    const v = { x: 0, y: 0, z: 0 };
    let sink = 0;
    const N = 20000;
    const batches: number[] = [];
    for (let b = 0; b < 25; b++) {
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        propagateInto(orbits[i % 3]!, T0 + (i * 37.3) % 400000, r, v);
        sink += r.x;
      }
      batches.push(((performance.now() - t0) * 1000) / N);
    }
    expect(Number.isFinite(sink)).toBe(true);
    const us = median(batches.slice(5));
    console.log(`propagate: ${us.toFixed(3)} us/call (median of batches)`);
    expect(us).toBeLessThan(2);
  });

  it('predictPatches with a node through an SOI change under 1 ms', () => {
    const k = sys.body(MOON).kepler!;
    const R = sys.body(EARTH).radius;
    const dir = k.P;
    const rc = R + 185e3;
    const parking = { bodyId: EARTH, r: v3.scale(dir, rc), v: v3.scale(v3.cross(k.normal, dir), Math.sqrt(sys.body(EARTH).mu / rc)) };
    const P = makeOrbit(EARTH, sys.body(EARTH).mu, parking.r, parking.v, T0).period!;
    let nodes: ManeuverNode[] | null = null;
    for (let i = 0; i < 180 && !nodes; i++) {
      const n: ManeuverNode[] = [{ id: 'tli', ut: T0 + 600 + (P * i) / 180, dv: { prograde: 3150, normal: 0, radial: 0 } }];
      const { planned } = predictPatches(sys, parking, T0, n);
      if (planned[0]?.endReason === 'soiEnter' && planned[1]?.markers.some((m) => m.kind === 'periapsis' && m.altitude! > 0)) nodes = n;
    }
    expect(nodes).not.toBeNull();
    const height = (_b: string, d: Vec3): number => 1000 * Math.sin(5 * d.x) * Math.cos(3 * d.y);
    const run = (opts: Parameters<typeof predictPatches>[4]): number => {
      const times: number[] = [];
      for (let i = 0; i < 60; i++) {
        const t0 = performance.now();
        const p = predictPatches(sys, parking, T0, nodes!, opts);
        times.push(performance.now() - t0);
        if (p.planned.length < 2) throw new Error('lost the encounter');
      }
      return median(times.slice(10));
    };
    const plain = run({});
    const withTarget = run({ targetBodyId: MOON, terrainHeight: height });
    console.log(`predictPatches (node + SOI change): ${plain.toFixed(3)} ms; with target + terrain callback: ${withTarget.toFixed(3)} ms`);
    expect(plain).toBeLessThan(1);
    expect(withTarget).toBeLessThan(1);
  });
});
