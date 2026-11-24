/**
 * `Readouts.target` for a targeted body (the tighten step after sub-wave 3.2): the session states the
 * navigation to it, and the v1 members `targetBodyId` and `targetClosestApproach` are gone. Every number is
 * held against a second computation from the snapshot itself: the range and the range rate from the ROOT
 * positions and velocities of the vessel and the body, the closest approach from the markers of the
 * predicted patches, the relative speed at it from the vis-viva equation of the patch about the target.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { Patch, SimSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { v3 } from '@/core/math/vec3';
import { active, comState, flatTerrain, loadLibrary, makeSim } from './helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: -100, moon: 0 });
});

/** Range and range rate between the active vessel's centre of mass and a body, from ROOT states alone. */
function rangeFromRoot(s: SimSnapshot, bodyId: string): { range: number; rangeRate: number } {
  const v = active(s);
  const body = s.bodies.find((b) => b.id === bodyId)!;
  const own = s.bodies.find((b) => b.id === v.bodyId)!;
  const com = comState(v);
  const d = v3.sub(body.rRoot, v3.add(own.rRoot, com.r));
  const dv = v3.sub(body.vRoot, v3.add(own.vRoot, com.v));
  const range = v3.len(d);
  return { range, rangeRate: v3.dot(d, dv) / range };
}

describe('Readouts.target for a body', () => {
  it('on a translunar coast: the Moon by name, range and range rate to its centre, one closest approach with its speed', async () => {
    const sim = await makeSim(defs, 'qa-translunar', terrain);
    const s = sim.peek();
    const t = s.readouts.target!;
    expect(t).not.toBeNull();
    expect(t.ref).toEqual({ kind: 'body', id: 'moon' });
    expect(t.name).toBe(defs.bodies['moon']!.name);
    expect(t.presence).toBe('solid');
    expect(t.timeOffset).toBe(0);
    // What only a vessel or a port target has.
    expect([t.relVelocity, t.relSpeed, t.lvlh, t.offer]).toEqual([null, null, null, null]);
    expect(s.readouts.docking).toBeNull();
    expect([s.navball.markers.relativePrograde, s.navball.markers.relativeRetrograde]).toEqual([null, null]);
    // Range and range rate: the same numbers from the ROOT states (two routes through float64: 1e-9 relative).
    const fromRoot = rangeFromRoot(s, 'moon');
    expect(Math.abs(t.range - fromRoot.range) / fromRoot.range).toBeLessThan(1e-9);
    expect(Math.abs(t.rangeRate - fromRoot.rangeRate)).toBeLessThan(1e-6 * Math.max(1, Math.abs(fromRoot.rangeRate)));
    expect(t.range).toBeGreaterThan(1e8);
    // The coast closes on the Moon.
    expect(t.rangeRate).toBeLessThan(0);
    // The one number that is stated twice is the same number.
    expect(t.relativeInclination).toBe(s.readouts.targetRelativeInclination);

    // The closest approach: the least distance among the approach markers of the patches and the periapsis
    // markers of the patches about the Moon (what v1's `targetClosestApproach` stated), and nothing else.
    const patches: readonly Patch[] = s.patches.planned.length ? s.patches.planned : s.patches.current;
    let best: { ut: number; distance: number; patch: Patch } | null = null;
    for (const p of patches) {
      for (const m of p.markers) {
        let d: number | null = null;
        if (m.kind === 'closestApproach' && m.value !== undefined && p.bodyId !== 'moon') d = m.value;
        else if (m.kind === 'periapsis' && p.bodyId === 'moon') d = v3.len(m.r);
        if (d !== null && (!best || d < best.distance)) best = { ut: m.ut, distance: d, patch: p };
      }
    }
    expect(best, 'the translunar scenario has an encounter').not.toBeNull();
    expect(t.closestApproaches).toHaveLength(1);
    const ca = t.closestApproaches[0]!;
    expect(ca.ut).toBe(best!.ut);
    expect(ca.distance).toBe(best!.distance);
    // The encounter is a periapsis about the Moon: the speed there is the vis-viva speed of that patch.
    expect(best!.patch.bodyId).toBe('moon');
    const c = best!.patch.conic;
    const rp = c.p / (1 + c.e);
    const visViva = Math.sqrt(c.mu * (2 / rp - 1 / c.a));
    expect(Math.abs(ca.relSpeed - visViva) / visViva).toBeLessThan(1e-9);
    expect(ca.relSpeed).toBeGreaterThan(1500);
    expect(ca.relSpeed).toBeLessThan(3000);
  });

  it('follows the command: no target is null, a body target is that body, and the range changes as the flight goes on', async () => {
    const sim = await makeSim(defs, 'qa-leo', terrain);
    expect(sim.commands.setTarget(null).ok).toBe(true);
    expect(sim.peek().readouts.target).toBeNull();
    expect(sim.peek().readouts.targetRelativeInclination).toBeNull();
    expect(sim.commands.setTarget({ kind: 'body', id: 'moon' }).ok).toBe(true);
    const a = sim.peek();
    expect(a.readouts.target!.ref).toEqual({ kind: 'body', id: 'moon' });
    const fromRoot = rangeFromRoot(a, 'moon');
    expect(Math.abs(a.readouts.target!.range - fromRoot.range) / fromRoot.range).toBeLessThan(1e-9);
    // From low Earth orbit the Moon's orbit plane is a number, and an approach is one entry or none.
    expect(a.readouts.target!.relativeInclination).not.toBeNull();
    expect(a.readouts.target!.closestApproaches.length).toBeLessThanOrEqual(1);
    for (const ca of a.readouts.target!.closestApproaches) {
      expect(ca.distance).toBeGreaterThan(0);
      expect(Number.isFinite(ca.relSpeed) && ca.relSpeed > 0).toBe(true);
    }
    for (let i = 0; i < 240; i++) sim.step();
    const b = sim.peek();
    expect(b.readouts.target!.range).not.toBe(a.readouts.target!.range);
    // The range rate is the rate of the range: two seconds of flight, to a part in ten thousand of the speed scale.
    const measured = (b.readouts.target!.range - a.readouts.target!.range) / (b.simUt - a.simUt);
    const mean = (a.readouts.target!.rangeRate + b.readouts.target!.rangeRate) / 2;
    expect(Math.abs(measured - mean)).toBeLessThan(1);
  });

  it('the body the vessel is about: the range is the distance to its centre', async () => {
    const sim = await makeSim(defs, 'qa-lunar-orbit', terrain);
    expect(sim.commands.setTarget({ kind: 'body', id: 'moon' }).ok).toBe(true);
    const s = sim.peek();
    const v = active(s);
    expect(v.bodyId).toBe('moon');
    const t = s.readouts.target!;
    const com = comState(v);
    expect(Math.abs(t.range - v3.len(com.r)) / t.range).toBeLessThan(1e-12);
    expect(Math.abs(t.rangeRate - v3.dot(com.r, com.v) / v3.len(com.r))).toBeLessThan(1e-9);
    expect(t.relativeInclination).toBeNull();
    expect(t.closestApproaches).toEqual([]);
  });
});
