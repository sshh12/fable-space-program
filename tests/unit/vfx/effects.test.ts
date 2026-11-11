/**
 * Canopy geometry, trail ageing, the reentry shape proxy and the effect domain (float64 bookkeeping).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { VesselSnapshot } from '@/core/contracts/sim';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { loadVfxData, type VfxData } from '@/render/vfx';
import { buildCanopyMesh, buildProfileTable, canopyProfile, canopyRadius, clusterAngle, PANEL_COLS, PANEL_ROWS, PROFILE_LEVELS, PROFILE_SAMPLES, profileLevelCoord, profileLevelInflation } from '@/render/vfx/canopyModel';
import { applyRebase, EffectDomain, SURFACE_REBASE } from '@/render/vfx/domain';
import { plasmaColor, reentryProxy } from '@/render/vfx/plasma';
import { contrailFactor, trailRadius, trailState, type TrailNode } from '@/render/vfx/trail';
import { assembleVessel, vesselPartSnapshots } from '@/sim/vessel/public';

let defs: DefLibrary;
let data: VfxData;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
  data = loadVfxData(defs);
});

describe('canopy model', () => {
  it('the projected area follows the inflation (drag area fraction)', () => {
    for (const kind of ['drogue', 'main'] as const) {
      const style = data.parachutes[kind];
      for (const f of [0.08, 0.3, 0.4, 0.75, 1]) {
        const p = canopyProfile(style, f);
        let rMax = 0;
        for (const r of p.r) rMax = Math.max(rMax, r);
        // Area fraction = (projected radius)^2, sampled meridian within 2 %.
        expect(rMax * rMax, `${kind} ${f}`).toBeGreaterThan(f * 0.96);
        expect(rMax * rMax, `${kind} ${f}`).toBeLessThanOrEqual(f * 1.0001);
        expect(p.radius).toBeCloseTo(Math.sqrt(f), 9);
      }
      // Streaming: never thinner than the stream radius.
      expect(canopyRadius(style, 0)).toBe(style.streamRadius);
      expect(canopyProfile(style, 0).radius).toBe(style.streamRadius);
    }
  });

  it('the cloth keeps its length: a reefed canopy is a bulb on a long throat', () => {
    const style = data.parachutes.main;
    const cloth = style.goreLengthRatio * (1 - style.ventFraction);
    for (const f of [0.001, 0.08, 0.3, 1]) {
      const p = canopyProfile(style, f);
      let len = 0;
      for (let i = 1; i < PROFILE_SAMPLES; i++) len += Math.hypot(p.r[i]! - p.r[i - 1]!, p.y[i]! - p.y[i - 1]!);
      expect(len / cloth, `inflation ${f}`).toBeGreaterThan(0.97);
      expect(len / cloth, `inflation ${f}`).toBeLessThan(1.01);
      expect(p.y[PROFILE_SAMPLES - 1]).toBeCloseTo(0, 5);
      expect(p.mouth).toBeLessThanOrEqual(p.radius);
    }
    // Taller and narrower when reefed.
    expect(canopyProfile(style, 0.08).height).toBeGreaterThan(canopyProfile(style, 1).height);
  });

  it('table rows, mesh topology and cluster angle', () => {
    const style = data.parachutes.main;
    const table = buildProfileTable(style);
    expect(table.length).toBe(PROFILE_LEVELS * PROFILE_SAMPLES * 4);
    expect(profileLevelInflation(PROFILE_LEVELS - 1)).toBe(1);
    expect(profileLevelCoord(profileLevelInflation(7))).toBeCloseTo(7 / (PROFILE_LEVELS - 1), 9);
    const mesh = buildCanopyMesh(style);
    expect(mesh.panels).toBe(style.gores * style.rings);
    expect(mesh.indices.length).toBe(mesh.panels * PANEL_COLS * PANEL_ROWS * 6);
    let maxIndex = 0;
    for (const i of mesh.indices) maxIndex = Math.max(maxIndex, i);
    expect(maxIndex).toBe(mesh.vertices.length / 3 - 1);
    // Every ring leaves a slot open above it; the last one ends at the skirt.
    let sMin = 1;
    let sMax = 0;
    for (let v = 0; v < mesh.vertices.length; v += 3) {
      sMin = Math.min(sMin, mesh.vertices[v]!);
      sMax = Math.max(sMax, mesh.vertices[v]!);
    }
    expect(sMin).toBeCloseTo(style.slotFraction / style.rings, 6);
    expect(sMax).toBe(1);
    // Three canopies stand apart, more when they are open; one canopy hangs straight.
    expect(clusterAngle(style, 1, 13, 52)).toBe(0);
    const reefed = clusterAngle(style, 3, 13 * Math.sqrt(0.08), 52);
    const open = clusterAngle(style, 3, 13, 52);
    expect(open).toBeGreaterThan(reefed);
    expect(open).toBeGreaterThan(0.2);
    expect(open).toBeLessThan(0.45);
  });
});

describe('trails', () => {
  const node: TrailNode = { pos: v3.zero(), born: 0, radius0: 10, spread: 14, smoke0: 0.4, contrail0: 3, glow0: 1000, glowLife: 5, glowColor: [1, 1, 1] };
  it('a trail widens and thins; condensation needs a second to form and outlives the smoke', () => {
    const D = data.trail;
    expect(trailRadius(D, node, 0)).toBe(10);
    expect(trailRadius(D, node, 30)).toBeGreaterThan(trailRadius(D, node, 5));
    const [s0, c0, g0] = trailState(D, node, 0);
    expect(s0).toBeCloseTo(0.4, 9);
    expect(c0).toBe(0);
    expect(g0).toBe(1000);
    const [s2, c2] = trailState(D, node, 2);
    expect(s2).toBeLessThan(s0);
    expect(c2).toBeGreaterThan(0.5);
    const [s60, c60, g60] = trailState(D, node, 60);
    expect(c60).toBeGreaterThan(5 * s60);
    expect(g60).toBeLessThan(0.01);
  });
  it('condensation trails form in cold, dense enough air only', () => {
    const D = data.trail;
    expect(contrailFactor(D, 288, 101325)).toBe(0);
    expect(contrailFactor(D, 217, 20000)).toBe(1);
    expect(contrailFactor(D, 217, 500)).toBe(0);
    expect(contrailFactor(D, 250, 1000)).toBe(0);
  });
});

describe('reentry proxy and colour', () => {
  it('the capsule alone: its own radius and length, the nose radius of its heat shield', () => {
    const vehicleId = Object.keys(defs.vehicles)[0]!;
    const parts = vesselPartSnapshots(assembleVessel(defs, vehicleId, { stagesAlreadyFired: 10 }));
    const base = createFakeSim(defs, { scene: 'reentry' }).peek().vessels[0]!;
    const vessel: VesselSnapshot = { ...base, parts };
    const proxy = reentryProxy(defs, vessel, { x: 0, y: 1, z: 0 });
    const capsule = defs.parts[parts[0]!.def]!;
    expect(proxy.radius).toBeCloseTo(capsule.bounds.radius, 6);
    expect(proxy.halfLength).toBeCloseTo((capsule.bounds.yMax - capsule.bounds.yMin) / 2, 6);
    expect(proxy.centreVes.y).toBeCloseTo((capsule.bounds.yMax + capsule.bounds.yMin) / 2, 6);
    let nose = 0;
    for (const s of capsule.thermal.surfaces) nose = Math.max(nose, s.noseRadius);
    expect(proxy.noseRadius).toBeCloseTo(capsule.visual?.reentryShape?.noseRadius ?? nose, 6);
  });
  it('orange when slow, pink in between, white-violet at lunar-return speed', () => {
    const R = data.reentry;
    expect(plasmaColor(R, 0)).toEqual(R.colors[0]);
    expect(plasmaColor(R, R.colorSpeeds[1])).toEqual(R.colors[1]);
    expect(plasmaColor(R, 12000)).toEqual(R.colors[2]);
    const mid = plasmaColor(R, 0.5 * (R.colorSpeeds[0] + R.colorSpeeds[1]));
    expect(mid[2]).toBeGreaterThan(R.colors[0][2]);
    expect(mid[2]).toBeLessThan(R.colors[1][2]);
  });
});

describe('effect domain', () => {
  const rootOf = (frame: ReturnType<EffectDomain['update']>, p: { x: number; y: number; z: number }) => v3.add(frame.originRoot, quat.rotate(frame.q, p));

  it('surface domain below the top of the atmosphere, free-fall domain in orbit', () => {
    const pad = createFakeSim(defs, { scene: 'pad' }).peek();
    const orbit = createFakeSim(defs, { scene: 'lowOrbit' }).peek();
    const lunar = createFakeSim(defs, { scene: 'lunarSurface' }).peek();
    const a = new EffectDomain().update(defs, pad, pad.vessels[0]!, 0);
    expect(a.state.kind).toBe('surface');
    expect(a.reset).toBe(true);
    expect(a.gravity).toBeCloseTo(9.8, 0);
    expect(v3.dist(a.originRoot, pad.vessels[0]!.rRoot)).toBeLessThan(1e-6);
    const b = new EffectDomain().update(defs, orbit, orbit.vessels[0]!, 0);
    expect(b.state.kind).toBe('space');
    expect(b.gravity).toBe(0);
    expect(new EffectDomain().update(defs, lunar, lunar.vessels[0]!, 0).state.kind).toBe('surface');
  });

  it('a re-base moves the origin and leaves every stored point where it was', () => {
    const sim = createFakeSim(defs, { scene: 'ascent' });
    const domain = new EffectDomain();
    let snap = sim.peek();
    const first = domain.update(defs, snap, snap.vessels[0]!, 0);
    // A particle at rest in the air, 40 m east of the origin (domain axes are the body-fixed axes).
    let p = { x: 40, y: -12, z: 7 };
    let v = { x: 3, y: 0, z: -1 };
    const body0 = snap.bodies.find((b) => b.id === first.state.bodyId)!;
    const fixed0 = quat.rotateInv(body0.qFixedToRoot, v3.sub(rootOf(first, p), body0.rRoot));
    let rebases = 0;
    for (let i = 0; i < 300; i++) {
      sim.advance(0.1);
      snap = sim.peek();
      const frame = domain.update(defs, snap, snap.vessels[0]!, 0.1);
      if (frame.rebase) {
        rebases++;
        const r = applyRebase(frame.rebase, p, v);
        p = r.p;
        v = r.v;
      }
      // In the body-fixed frame the point has not moved, whatever the origin did.
      const body = snap.bodies.find((b) => b.id === frame.state.bodyId)!;
      const fixed = quat.rotateInv(body.qFixedToRoot, v3.sub(rootOf(frame, p), body.rRoot));
      expect(v3.dist(fixed, fixed0)).toBeLessThan(1e-3);
      // The origin never falls further behind the vessel than the re-base distance (plus one step of travel).
      expect(v3.dist(frame.originRoot, snap.vessels[0]!.rRoot)).toBeLessThan(SURFACE_REBASE + 100);
      expect(v).toEqual({ x: 3, y: 0, z: -1 });
    }
    // The fake vessel climbs 350 m/s: the origin was re-based several times.
    expect(rebases).toBeGreaterThanOrEqual(2);
  });

  it('surface to space keeps positions and inertial velocities', () => {
    const snap = createFakeSim(defs, { scene: 'pad' }).peek();
    const domain = new EffectDomain();
    const low = domain.update(defs, snap, snap.vessels[0]!, 0);
    const body = snap.bodies.find((b) => b.id === low.state.bodyId)!;
    const p = { x: 100, y: 50, z: -30 };
    const v = { x: 0, y: 0, z: 0 };
    const before = rootOf(low, p);
    // The same vessel, placed 400 km up and moving: the domain becomes a free-fall frame.
    const up = v3.normalize(snap.vessels[0]!.r);
    const high: VesselSnapshot = { ...snap.vessels[0]!, r: v3.scale(up, defs.bodies[body.id]!.radius + 400e3), v: { x: 7000, y: 1000, z: 0 } };
    const frame = domain.update(defs, snap, high, 0);
    expect(frame.state.kind).toBe('space');
    expect(frame.rebase).not.toBeNull();
    const r = applyRebase(frame.rebase!, p, v);
    expect(v3.dist(rootOf(frame, r.p), before)).toBeLessThan(1e-3);
    // A point at rest in the air moves with the rotating body: spin x r, seen from the new frame.
    const inertial = v3.add(r.v, frame.velocityRoot);
    const expected = v3.add(body.vRoot, v3.cross(body.spinRoot, v3.sub(before, body.rRoot)));
    expect(v3.dist(inertial, expected)).toBeLessThan(1e-6);
  });
});
