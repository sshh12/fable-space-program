/**
 * Presentation interpolation (ARCHITECTURE section 1 row 23, section 5): Sim.advance() accumulates real
 * time into whole 1/120 s steps and snapshot() places vessels at the presentation time, so that motion
 * is uniform at 60, 144 and 240 Hz alike; peek() and the headless path are never interpolated.
 *
 * What is asserted for every frame rate:
 *  - simUt - ut is in [0, PHYSICS_DT) and the presentation time advances by exactly one frame per frame;
 *  - a vessel in powered flight is drawn on the straight line between its last two step states at the
 *    presentation fraction (compared with a twin simulation driven by step(), to 1e-6 of the frame's
 *    displacement), its attitude on the slerp between them, and its per-frame displacement changes only
 *    by the physical acceleration (no beat between frame rate and step rate);
 *  - a landed vessel rides the rotating body at the presentation time: uniform per-frame displacement to
 *    1e-6 relative;
 *  - the state after the frames equals the state after the same number of step() calls (hash).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { PHYSICS_DT } from '@/core/contracts/defs';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { quat, type Quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import type { DiagnosedSession } from '../../../tools/sim/realWorld';
import { active, controls, flatTerrain, loadLibrary, makeSim } from './helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: 21.62, moon: 0 });
});

const RATES = [60, 144, 240];

/** The third-stage stack in the parking orbit, burning: a vessel in powered flight. */
async function burningStack(): Promise<DiagnosedSession> {
  const sim = await makeSim(defs, 'qa-leo', terrain);
  sim.commands.setSasEnabled(true);
  sim.setControls(controls({ throttle: 1, pitch: 0.3 }));
  for (let i = 0; i < 360; i++) sim.step();
  return sim;
}

describe('presentation interpolation', () => {
  for (const hz of RATES) {
    it(`powered flight at ${hz} Hz: snapshots lie on the interpolated step states`, async () => {
      const sim = await burningStack();
      const twin = await burningStack();
      expect(sim.stateHash()).toBe(twin.stateHash());
      expect(active(sim.peek()).thrust).toBeGreaterThan(5e5);
      const tick0 = sim.peek().tick;
      const frameDt = 1 / hz;
      // Twin state per step: [r, q] by tick offset.
      const states: { r: Vec3; q: Quat }[] = [{ r: active(twin.peek()).r, q: active(twin.peek()).q }];
      const stateAt = (n: number): { r: Vec3; q: Quat } => {
        while (states.length <= n) {
          twin.step();
          const v = active(twin.peek());
          states.push({ r: v.r, q: v.q });
        }
        return states[n]!;
      };
      const frames = 300;
      let prevUt = NaN;
      let prevR: Vec3 | null = null;
      const disp: number[] = [];
      let worstPos = 0;
      let worstAtt = 0;
      for (let k = 1; k <= frames; k++) {
        sim.advance(frameDt);
        const s = sim.snapshot();
        const v = active(s);
        const n = s.tick - tick0;
        // Lag of the presentation behind the sim state, known exactly from the frame and step counts.
        const lag = n * PHYSICS_DT - k * frameDt;
        expect(lag).toBeGreaterThanOrEqual(-1e-12);
        expect(lag).toBeLessThan(PHYSICS_DT);
        expect(s.simUt - s.ut).toBeGreaterThanOrEqual(0);
        expect(s.simUt - s.ut).toBeLessThan(PHYSICS_DT);
        expect(s.simUt - s.ut).toBeCloseTo(lag, 6);
        if (!Number.isNaN(prevUt)) expect(s.ut - prevUt).toBeCloseTo(frameDt, 6);
        prevUt = s.ut;
        const alpha = 1 - lag / PHYSICS_DT;
        const a = stateAt(n - 1);
        const b = stateAt(n);
        const expected = v3.lerp(a.r, b.r, alpha);
        const stepLength = v3.dist(a.r, b.r);
        worstPos = Math.max(worstPos, v3.dist(v.r, expected) / (stepLength * (frameDt / PHYSICS_DT)));
        worstAtt = Math.max(worstAtt, quat.angleBetween(v.q, quat.slerp(a.q, b.q, alpha)));
        if (prevR) disp.push(v3.dist(v.r, prevR));
        prevR = v.r;
      }
      expect(worstPos).toBeLessThan(1e-6);
      expect(worstAtt).toBeLessThan(1e-6);
      // Per-frame displacement: about 7.8 km/s x frame, changing smoothly with the burn. Without the
      // interpolation a 144 Hz display would alternate between zero and one step of travel.
      const mean = disp.reduce((x, y) => x + y, 0) / disp.length;
      expect(mean).toBeGreaterThan(7000 * frameDt);
      let worstJump = 0;
      let worstCurve = 0;
      for (let i = 1; i < disp.length - 1; i++) {
        worstJump = Math.max(worstJump, Math.abs(disp[i]! - disp[i - 1]!) / mean);
        worstCurve = Math.max(worstCurve, Math.abs(disp[i + 1]! - 2 * disp[i]! + disp[i - 1]!) / mean);
      }
      // The speed changes by a few 1e-5 per frame under 1.3 g; the chord error of the linear interpolation
      // (a dt^2 / 8 = 0.1 mm) is all that the second difference shows.
      expect(worstJump).toBeLessThan(1e-4);
      expect(worstCurve).toBeLessThan(2e-5);
      // The final state equals the same number of step() calls.
      const n = sim.peek().tick - tick0;
      stateAt(n);
      while (twin.peek().tick - tick0 < n) twin.step();
      expect(twin.peek().tick).toBe(sim.peek().tick);
      expect(sim.stateHash()).toBe(twin.stateHash());
      // peek() is never interpolated.
      const p = sim.peek();
      expect(p.ut).toBe(p.simUt);
      expect(v3.dist(active(p).r, stateAt(n).r)).toBe(0);
    });

    it(`a landed vessel at ${hz} Hz: uniform per-frame displacement to 1e-6`, async () => {
      const sim = await makeSim(defs, 'lunar-direct', terrain);
      const frameDt = 1 / hz;
      const frames = 240;
      let prevR: Vec3 | null = null;
      const disp: number[] = [];
      for (let k = 0; k < frames; k++) {
        sim.advance(frameDt);
        const s = sim.snapshot();
        const v = active(s);
        expect(v.translationMode).toBe('landed');
        expect(s.simUt - s.ut).toBeGreaterThanOrEqual(0);
        expect(s.simUt - s.ut).toBeLessThan(PHYSICS_DT);
        if (prevR) disp.push(v3.dist(v.rRoot, prevR));
        prevR = v.rRoot;
        // The vessel stands still on the body it rides: its body-fixed position is constant.
        const earth = s.bodies.find((b) => b.id === 'earth')!;
        const fixed = quat.rotateInv(earth.qFixedToRoot, v.r);
        if (k === 0) expect(v3.len(fixed)).toBeGreaterThan(6.3e6);
      }
      const mean = disp.reduce((x, y) => x + y, 0) / disp.length;
      // 439 m/s of Earth rotation at the pad.
      expect(mean / frameDt).toBeGreaterThan(437);
      expect(mean / frameDt).toBeLessThan(441);
      let worst = 0;
      for (const d of disp) worst = Math.max(worst, Math.abs(d - mean) / mean);
      expect(worst).toBeLessThan(1e-6);
    });
  }

  it('a coasting vessel on rails is presented uniformly too', async () => {
    const sim = await makeSim(defs, 'qa-leo', terrain);
    const frameDt = 1 / 144;
    let prevR: Vec3 | null = null;
    const disp: number[] = [];
    for (let k = 0; k < 300; k++) {
      sim.advance(frameDt);
      const v = active(sim.snapshot());
      expect(v.translationMode).toBe('rails');
      if (prevR) disp.push(v3.dist(v.r, prevR));
      prevR = v.r;
    }
    const mean = disp.reduce((x, y) => x + y, 0) / disp.length;
    // The speed drifts slowly along the (slightly eccentric) orbit; frame to frame the displacement is smooth.
    let worst = 0;
    for (let i = 1; i < disp.length - 1; i++) worst = Math.max(worst, Math.abs(disp[i + 1]! - 2 * disp[i]! + disp[i - 1]!) / mean);
    expect(worst).toBeLessThan(1e-6);
    expect(Math.abs(disp[disp.length - 1]! - disp[0]!) / mean).toBeLessThan(1e-4);
  });

  it('surplus real time is dropped, never integrated with a bigger step', async () => {
    const sim = await makeSim(defs, 'qa-leo', terrain);
    const t0 = sim.peek().simUt;
    const tick0 = sim.peek().tick;
    // A 0.5 s hitch at 1x: at most 16 steps are run.
    sim.advance(0.5);
    const s = sim.peek();
    expect(s.tick - tick0).toBe(16);
    expect(s.simUt - t0).toBeCloseTo(16 * PHYSICS_DT, 6);
    // At 4x physics warp four times as many steps fit into a frame.
    sim.commands.setWarpLevel(3);
    const tick1 = sim.peek().tick;
    sim.advance(1 / 60);
    expect(sim.peek().tick - tick1).toBe(8);
  });

  it('control ticks arrive every fourth step and before each rails advance', async () => {
    const sim = await makeSim(defs, 'qa-leo', terrain);
    const ticksAt: number[] = [];
    for (let k = 0; k < 30; k++) sim.advance(1 / 60, () => ticksAt.push(sim.peek().tick));
    // 30 frames at 60 Hz = 60 steps: a tick before steps 0, 4, 8, ...
    expect(ticksAt.length).toBe(15);
    for (let i = 1; i < ticksAt.length; i++) expect(ticksAt[i]! - ticksAt[i - 1]!).toBe(4);
    // On rails: one tick per frame.
    sim.commands.setWarpLevel(5);
    let calls = 0;
    const before = sim.peek().tick;
    for (let k = 0; k < 10; k++) sim.advance(1 / 60, () => calls++);
    expect(calls).toBe(10);
    expect(sim.peek().tick - before).toBe(10);
    expect(sim.peek().warp.onRails).toBe(true);
  });
});
