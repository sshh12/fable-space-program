/**
 * Separation clearance (ARCHITECTURE section 1, row 27): vessels do not collide in this simulation, so
 * clean separation is a property of the data - impulses, retro and ullage motors, the evasion burn, the
 * fire-in-the-hole sequence. After each of the ten stage events, flown at the stage's nominal conditions
 * (residual rates up to 1 deg/s, the continuing vessel accelerating), the clearance between every pair of
 * resulting vessels must be positive within 0.5 s of the separation and stay positive for 30 s.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { assembleVessel, splitForStage, vesselClearance, vesselClearanceDetail, type Vessel } from '@/sim/vessel';
import { controls, DT, loadLibrary, runAll, VEHICLE } from './helpers';
import { stageScenario } from './scenarios';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

interface PairLog {
  positiveFrom: number;
  min: number;
  minAt: number;
  parts: string;
}

/** Fly the scenario for 30 s past the separation and log every pair of vessels. */
function flySeparation(index: number): { pairs: Map<string, PairLog>; vessels: Vessel[]; separated: boolean } {
  const s = stageScenario(defs, index);
  const pairs = new Map<string, PairLog>();
  let t0 = s.vessels.length > 1 ? 0 : -1;
  let step = 0;
  const sample = (t: number): void => {
    if (t0 < 0) {
      if (s.vessels.length < 2) return;
      // The spawned vessels were created at the start of the step that just ended.
      t0 = t - DT;
    }
    const since = t - t0;
    step++;
    // Every step for the first second, then every fourth step.
    if (since > 1 && step % 4 !== 0) return;
    for (let i = 0; i < s.vessels.length; i++) {
      for (let j = i + 1; j < s.vessels.length; j++) {
        const d = vesselClearanceDetail(s.vessels[i]!, s.vessels[j]!);
        const key = `${s.vessels[i]!.id} | ${s.vessels[j]!.id}`;
        let log = pairs.get(key);
        if (!log) {
          log = { positiveFrom: d.distance > 0 ? since : Infinity, min: Infinity, minAt: 0, parts: '' };
          pairs.set(key, log);
        }
        if (d.distance > 0) {
          if (!Number.isFinite(log.positiveFrom)) log.positiveFrom = since;
        } else {
          log.positiveFrom = Infinity;
        }
        if (since >= 0.5 && d.distance < log.min) {
          log.min = d.distance;
          log.minAt = since;
          log.parts = `${d.partA} / ${d.partB}`;
        }
      }
    }
  };
  if (t0 === 0) sample(0);
  let elapsed = 0;
  // Run until 30 s after the separation (delayed decouplers fire up to 2 s after the press).
  while (elapsed < 34 && (t0 < 0 || elapsed - t0 < 30.2)) {
    runAll(s.vessels, s.env, 0.25, controls({ throttle: s.throttle }), (t) => sample(elapsed + t));
    elapsed += 0.25;
  }
  return { pairs, vessels: s.vessels, separated: t0 >= 0 };
}

describe('separation clearance for 30 s after every stage event', () => {
  const report: string[] = [];
  for (let index = 0; index < 10; index++) {
    it(`stage ${index + 1}`, () => {
      const { pairs, vessels, separated } = flySeparation(index);
      if (index === 5 || index === 9) {
        // Gear and main-chute stages release nothing.
        expect(vessels).toHaveLength(1);
        expect(separated).toBe(false);
        return;
      }
      expect(separated).toBe(true);
      expect(pairs.size).toBe((vessels.length * (vessels.length - 1)) / 2);
      for (const [key, log] of pairs) {
        report.push(`stage ${index + 1}  ${key}: positive from ${log.positiveFrom.toFixed(3)} s, minimum ${log.min.toFixed(2)} m at ${log.minAt.toFixed(1)} s (${log.parts})`);
        expect(log.positiveFrom, `${key} becomes positive`).toBeLessThanOrEqual(0.5);
        expect(log.min, `${key} stays positive (${log.parts} at ${log.minAt.toFixed(2)} s)`).toBeGreaterThan(0);
      }
    }, 120000);
  }
  it('prints the clearance log', () => {
    console.log(report.join('\n'));
    expect(report.length).toBeGreaterThan(10);
  });
});

describe('clearance query', () => {
  it('is negative for nested parts and symmetric', () => {
    const stack = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 1 });
    // Structural result of M-1 separation: the Vela-2 bells still stand 0.6 m inside the interstage.
    const { vessel, spawned } = splitForStage(defs, stack, 1);
    const m1 = spawned[0]!;
    const d = vesselClearanceDetail(vessel, m1);
    expect(d.distance).toBeLessThan(-0.5);
    expect(d.distance).toBeGreaterThan(-0.7);
    expect(d.partA.startsWith('vela-2-')).toBe(true);
    expect(d.partB).toBe('interstage-1');
    expect(vesselClearance(m1, vessel)).toBeCloseTo(d.distance, 9);
    // Pull the spent stage straight back: the distance is the gap between the bell exits and the interstage rim.
    const back = quat.rotate(m1.q, { x: 0, y: -1, z: 0 });
    m1.r = v3.addScaled(m1.r, back, 10.6);
    expect(vesselClearance(vessel, m1)).toBeCloseTo(10.0, 3);
    // Side by side, axes 20 m apart: the M-2 ullage ring (4.75 m) faces the M-1 retro ring (4.75 m) only after
    // the axial shift, so the closest pair is ring against 9 m stage.
    m1.r = v3.addScaled(m1.r, quat.rotate(m1.q, { x: 1, y: 0, z: 0 }), 20);
    m1.r = v3.addScaled(m1.r, back, -10.6 - 15);
    expect(vesselClearance(vessel, m1)).toBeCloseTo(20 - 4.75 - 4.5, 2);
  });

  it('treats a stowed leg set by its stowed envelope and a fairing panel by its own sector', () => {
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 4 });
    const split = splitForStage(defs, v, 4);
    // Legs stowed: the lander clears the adapter ring it stood on (touching planes, no overlap).
    expect(vesselClearance(split.vessel, split.spawned[0]!)).toBeGreaterThan(-1e-6);
    expect(vesselClearance(split.vessel, split.spawned[0]!)).toBeLessThan(0.05);
    // With the legs down the pads reach below the separation plane.
    const legs = split.vessel.parts.find((p) => p.instanceId === 'landing-legs')!.modules[0]!;
    if (legs.type === 'legs') legs.deploy = 1;
    expect(vesselClearance(split.vessel, split.spawned[0]!)).toBeLessThan(-0.5);

    const s2 = splitForStage(defs, assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 2 }), 2);
    const panels = s2.spawned.filter((x) => x.id.includes('#panel'));
    expect(panels).toHaveLength(4);
    // Opposite panels never touch; neighbours share an edge; all four enclose the lander before they move.
    expect(vesselClearance(panels[0]!, panels[2]!)).toBeGreaterThan(2);
    expect(vesselClearance(panels[0]!, panels[1]!)).toBeLessThan(0.01);
    expect(vesselClearance(panels[0]!, s2.vessel)).toBeLessThan(0);
  });
});
