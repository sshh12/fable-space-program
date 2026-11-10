import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_PHYSICS_WARP_INDEX, WARP_LEVELS, type DefLibrary } from '../../../src/core/contracts/defs';
import { Prng } from '../../../src/core/math/hash';
import { v3 } from '../../../src/core/math/vec3';
import type { BodySystem } from '../../../src/sim/bodies/bodySystem';
import { makeOrbit, propagate } from '../../../src/sim/orbit/kepler';
import { predictPatches } from '../../../src/sim/orbit/patches';
import {
  SOI_CHANGE_MIN_WARP_INDEX,
  WARP_LOOKAHEAD_REAL_SECONDS,
  lookAheadWarpIndex,
  maxWarpIndexForAltitude,
  nextWarpEvent,
  railsAdvanceTarget,
  warpAltitudeLimit,
  warpFactor,
  type WarpEventKind,
} from '../../../src/sim/orbit/warp';
import { loadWorld, mainIds, utOf } from './fixtures';

let defs: DefLibrary;
let sys: BodySystem;
let EARTH = '';
let MOON = '';
const T0 = utOf(2028, 4, 2);

beforeAll(async () => {
  ({ defs, system: sys } = await loadWorld());
  ({ root: EARTH, moon: MOON } = mainIds(sys));
});

describe('warp altitude limits', () => {
  it('rails levels follow warpAltitudeLimits; physics levels always allowed', () => {
    const earth = defs.bodies[EARTH]!;
    expect(maxWarpIndexForAltitude(earth, 0)).toBe(MAX_PHYSICS_WARP_INDEX);
    expect(maxWarpIndexForAltitude(earth, 139e3)).toBe(MAX_PHYSICS_WARP_INDEX);
    expect(maxWarpIndexForAltitude(earth, 150e3)).toBe(WARP_LEVELS.indexOf(10));
    expect(maxWarpIndexForAltitude(earth, 200e3)).toBe(WARP_LEVELS.indexOf(50));
    expect(maxWarpIndexForAltitude(earth, 50e6)).toBe(WARP_LEVELS.length - 1);
    const moon = defs.bodies[MOON]!;
    expect(maxWarpIndexForAltitude(moon, 0)).toBe(WARP_LEVELS.indexOf(5));
    expect(maxWarpIndexForAltitude(moon, 4e6)).toBe(WARP_LEVELS.length - 1);
    expect(warpAltitudeLimit(earth, 2)).toBeNull();
    expect(warpAltitudeLimit(earth, 10)).toBe(30e6);
  });
});

describe('event look-ahead', () => {
  it('property: never allows stepping past an event', () => {
    const rng = new Prng(77);
    const kinds: WarpEventKind[] = ['atmosphere', 'terrainProximity', 'impact', 'node', 'altitudeLimit', 'alarm', 'soiChange'];
    for (let i = 0; i < 200000; i++) {
      const ut = rng.range(0, 1e9);
      const remaining = Math.pow(10, rng.range(-3, 7.5));
      const ev = { ut: ut + remaining, kind: kinds[i % kinds.length]! };
      const idx = lookAheadWarpIndex(ut, ev);
      const realDt = rng.range(1e-4, 0.1);
      // the rails advance (clamped) never passes the event
      expect(railsAdvanceTarget(ut, realDt, idx, ev.ut)).toBeLessThanOrEqual(ev.ut);
      if (ev.kind !== 'soiChange' && idx > 0) {
        // ... and the look-ahead alone keeps >= 4 s of real time: even unclamped, a frame cannot pass it
        expect(ut + realDt * warpFactor(idx)).toBeLessThan(ev.ut);
        expect(remaining / warpFactor(idx)).toBeGreaterThanOrEqual(WARP_LOOKAHEAD_REAL_SECONDS);
        // and it is the largest such level
        if (idx < WARP_LEVELS.length - 1) expect(remaining / warpFactor(idx + 1)).toBeLessThan(WARP_LOOKAHEAD_REAL_SECONDS);
      }
      if (ev.kind === 'soiChange') expect(idx).toBeGreaterThanOrEqual(SOI_CHANGE_MIN_WARP_INDEX);
    }
    expect(lookAheadWarpIndex(0, null)).toBe(WARP_LEVELS.length - 1);
  });

  it('a fall from high lunar orbit at 100,000x steps down smoothly and never overshoots', () => {
    const body = sys.body(MOON);
    const R = body.radius;
    const rA = R + 40000e3;
    const rP = R - 100e3; // impact trajectory
    const a = (rA + rP) / 2;
    const vA = Math.sqrt(body.mu * (2 / rA - 1 / a));
    const o = makeOrbit(MOON, body.mu, { x: rA, y: 0, z: 0 }, { x: 0, y: vA, z: 0 }, T0);
    const impactUt = predictPatches(sys, { bodyId: MOON, r: o.r0, v: o.v0 }, T0, []).current[0]!.tEnd;
    let ut = T0;
    let idx = WARP_LEVELS.length - 1;
    const seen = new Set<number>();
    let frames = 0;
    while (ut < impactUt - 1 && frames < 200000) {
      const s = propagate(o, ut);
      const alt = v3.len(s.r) - R;
      const patches = predictPatches(sys, { bodyId: MOON, r: s.r, v: s.v }, ut, []).current;
      const cap = Math.min(WARP_LEVELS.length - 1, maxWarpIndexForAltitude(defs.bodies[MOON]!, alt));
      idx = Math.min(idx, cap);
      const ev = nextWarpEvent({ system: sys, ut, bodyId: MOON, r: s.r, v: s.v, patches, warpIndex: idx });
      expect(ev).not.toBeNull();
      idx = Math.min(idx, lookAheadWarpIndex(ut, ev));
      seen.add(idx);
      if (idx <= MAX_PHYSICS_WARP_INDEX) break; // the world integrates from here (physics warp)
      const target = railsAdvanceTarget(ut, 1 / 60, idx, ev!.ut);
      expect(target).toBeLessThanOrEqual(ev!.ut);
      expect(target).toBeLessThanOrEqual(impactUt);
      // after the step the altitude is still at or above this level's limit
      const lim = warpAltitudeLimit(defs.bodies[MOON]!, idx);
      if (lim !== null) expect(v3.len(propagate(o, target).r) - R).toBeGreaterThanOrEqual(lim - 1e-3);
      if (target === ut) {
        // event reached at this level: the world would drop to physics warp here
        idx = Math.max(0, idx - 1);
        if (idx <= MAX_PHYSICS_WARP_INDEX) break;
      }
      ut = Math.max(ut, target);
      frames++;
    }
    // Every rails level the geometry admits was used on the way down (the whole fall from 40,000 km is too
    // short for 100,000x to keep 4 real seconds of margin), it handed over to physics warp before the
    // terrain-proximity shell (max elevation + 1 km), and it never passed the impact.
    for (const level of [10000, 1000, 100, 50, 10, 5] as const) expect(seen.has(WARP_LEVELS.indexOf(level))).toBe(true);
    expect(idx).toBeLessThanOrEqual(MAX_PHYSICS_WARP_INDEX);
    expect(ut).toBeLessThan(impactUt);
    const finalAlt = v3.len(propagate(o, ut).r) - R;
    expect(finalAlt).toBeGreaterThanOrEqual(defs.bodies[MOON]!.terrain!.maxElevation + 1000 - 1e-3);
    expect(frames).toBeGreaterThan(100);
  });
});
