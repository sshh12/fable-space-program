/**
 * Navigation to vessels and launch windows (src/sim/nav/target.ts, navball.ts, launchWindow.ts): relative state
 * without cancellation, LVLH components, the vessel target readout, the navball's relative markers and target
 * mode, and the launch windows of a pad toward a moon and toward a planet.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { quat } from '../../../src/core/math/quat';
import { DEG } from '../../../src/core/math/scalar';
import { v3 } from '../../../src/core/math/vec3';
import { padLocationOf } from '../../../src/core/defs/sites';
import { computeNavball } from '../../../src/sim/nav/navball';
import { launchWindowsForPad } from '../../../src/sim/nav/launchWindow';
import { lvlhOffset, navballTargetVectors, relativeState, vesselTargetReadout } from '../../../src/sim/nav/target';
import { loadShipped, loadStaged, utOf, type World } from './fixtures';

let shipped: World;
let staged: World;
beforeAll(async () => {
  [shipped, staged] = await Promise.all([loadShipped(), loadStaged()]);
});

describe('relative state and LVLH', () => {
  it('two craft about one body: the difference of their BCI states; about different bodies: through the common ancestor', () => {
    const sys = staged.system;
    const ut = utOf(2031, 1, 1);
    const own = { bodyId: 'earth', r: { x: 6.8e6, y: 0, z: 0 }, v: { x: 0, y: 7660, z: 0 } };
    const tgt = { bodyId: 'earth', r: { x: 6.8e6, y: 100, z: 5 }, v: { x: 0.1, y: 7660, z: 0 } };
    const rel = relativeState(sys, own, tgt, ut);
    expect(rel.r).toEqual({ x: 0, y: 100, z: 5 });
    expect(rel.range).toBeCloseTo(Math.hypot(100, 5), 12);
    // the same target expressed about the Moon: the offset goes Earth -> Moon only (no heliocentric digits lost)
    const m = sys.stateRelParent('moon', ut);
    const tgtMoon = { bodyId: 'moon', r: v3.sub(tgt.r, m.r), v: v3.sub(tgt.v, m.v) };
    const rel2 = relativeState(sys, own, tgtMoon, ut);
    expect(v3.len(v3.sub(rel2.r, rel.r))).toBeLessThan(1e-7);
    expect(v3.len(v3.sub(rel2.v, rel.v))).toBeLessThan(1e-9);
  });

  it('LVLH: a craft 100 m above, 200 m ahead and 30 m north of a target in an equatorial circular orbit', () => {
    const r = 6.8e6;
    const vc = Math.sqrt(3.986004418e14 / r);
    const tgt = { bodyId: 'earth', r: { x: r, y: 0, z: 0 }, v: { x: 0, y: vc, z: 0 } };
    const own = { bodyId: 'earth', r: { x: r + 100, y: 200, z: 30 }, v: tgt.v };
    const l = lvlhOffset(own, tgt)!;
    expect(l.radial).toBeCloseTo(100, 9);
    expect(l.along).toBeCloseTo(200, 9);
    expect(l.cross).toBeCloseTo(30, 9);
    expect(lvlhOffset({ ...own, bodyId: 'moon' }, tgt)).toBeNull();
    expect(lvlhOffset({ ...own, r: { x: 2 * r, y: 0, z: 0 } }, tgt)).toBeNull();
  });

  it('the vessel target readout: range rate negative when closing, relative velocity in the control frame, LVLH, approaches', () => {
    const sys = staged.system;
    const r = 6.8e6;
    const vc = Math.sqrt(3.986004418e14 / r);
    const tgt = { bodyId: 'earth', r: { x: r, y: 1000, z: 0 }, v: { x: 0, y: vc, z: 0 } };
    const own = { bodyId: 'earth', r: { x: r, y: 0, z: 0 }, v: { x: 0, y: vc + 2, z: 0 } };
    // control frame turned 90 deg about Z: own +Y (nose) points along -X of ROOT
    const q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2);
    const t = vesselTargetReadout({
      system: sys,
      ut: 0,
      own,
      qCtlToRoot: q,
      ref: { kind: 'vessel', id: 'craft-b' },
      name: 'B',
      presence: 'solid',
      timeOffset: 0,
      target: tgt,
      closestApproaches: [{ ut: 500, distance: 3, relSpeed: 2 }],
      offer: null,
    });
    expect(t.range).toBeCloseTo(1000, 9);
    expect(t.rangeRate).toBeCloseTo(-2, 9);
    expect(t.relSpeed).toBeCloseTo(2, 12);
    // own moves +Y of ROOT relative to the target: in a frame turned +90 deg about Z that is +X
    expect(t.relVelocity!.x).toBeCloseTo(2, 9);
    expect(t.relativeInclination).toBeCloseTo(0, 12);
    expect(t.lvlh!.along).toBeCloseTo(-1000, 3);
    expect(t.closestApproaches).toHaveLength(1);
  });

  it('navball: relative markers from the relative velocity; in mode target prograde is the relative velocity', () => {
    const sys = staged.system;
    const own = { bodyId: 'earth', r: { x: 6.8e6, y: 0, z: 0 }, v: { x: 0, y: 7660, z: 0 } };
    const tgt = { bodyId: 'earth', r: { x: 6.8e6, y: 50, z: 0 }, v: { x: 0, y: 7660, z: -1 } };
    const nv = navballTargetVectors(sys, own, tgt, 0);
    const base = { q: quat.identity(), r: own.r, v: own.v, qFixedToInertial: quat.identity(), spin: { x: 0, y: 0, z: 7.29e-5 }, targetDir: nv.targetDir, relativeVelocity: nv.relativeVelocity };
    const orbit = computeNavball({ ...base, mode: 'orbit' });
    expect(orbit.markers.relativePrograde!.z).toBeCloseTo(1, 12);
    expect(orbit.markers.relativeRetrograde!.z).toBeCloseTo(-1, 12);
    expect(orbit.markers.prograde.y).toBeCloseTo(1, 12);
    const target = computeNavball({ ...base, mode: 'target' });
    expect(target.markers.prograde.z).toBeCloseTo(1, 12);
    expect(target.markers.normal).toEqual(orbit.markers.normal);
    expect(target.markers.target!.y).toBeCloseTo(1, 12);
    // a body target (no relative velocity): null markers, mode orbit unchanged
    const none = computeNavball({ ...base, relativeVelocity: null, mode: 'orbit' });
    expect(none.markers.relativePrograde).toBeNull();
    expect(none.markers.prograde).toEqual(orbit.markers.prograde);
  });
});

describe('launch windows of a pad', () => {
  it('toward the Moon from the Ka Lae pad: plane crossings, coplanar, both kinds, twice a day at most', () => {
    const sys = shipped.system;
    const site = Object.values(shipped.defs.sites).find((s) => s.bodyId === sys.rootId)!;
    const loc = padLocationOf(site);
    const pad = { bodyId: site.bodyId, latitude: loc.latDeg * DEG, longitude: loc.lonDeg * DEG, elevation: typeof loc.padElevation === 'number' ? loc.padElevation : 0 };
    const moon = sys.body(sys.rootId).childIds[0]!;
    const from = utOf(2029, 9, 24);
    const ws = launchWindowsForPad(sys, pad, moon, from, from + 3 * 86400);
    expect(ws.length).toBeGreaterThanOrEqual(4);
    expect(ws.length).toBeLessThanOrEqual(7);
    for (const w of ws) {
      expect(w.relativeInclination).toBe(0);
      expect(w.azimuthDeg).toBeGreaterThan(60);
      expect(w.azimuthDeg).toBeLessThan(120);
    }
    for (let i = 1; i < ws.length; i++) expect(ws[i]!.ut).toBeGreaterThan(ws[i - 1]!.ut);
  });

  it('toward Mars from the same pad on the staged library: one window per synodic period', () => {
    const sys = staged.system;
    const site = Object.values(staged.defs.sites).find((s) => s.bodyId === 'earth')!;
    const loc = padLocationOf(site);
    const pad = { bodyId: 'earth', latitude: loc.latDeg * DEG, longitude: loc.lonDeg * DEG, elevation: 0 };
    const ws = launchWindowsForPad(sys, pad, 'mars', utOf(2030, 1, 1), utOf(2034, 6, 1));
    expect(ws.length).toBeGreaterThanOrEqual(2);
    for (const w of ws) {
      expect(w.azimuthDeg).toBeGreaterThanOrEqual(0);
      expect(w.azimuthDeg).toBeLessThan(360);
      expect(Number.isFinite(w.phaseAngle)).toBe(true);
    }
    // Phobos: the same windows (its planet's)
    expect(launchWindowsForPad(sys, pad, 'phobos', utOf(2030, 1, 1), utOf(2032, 6, 1)).length).toBeGreaterThanOrEqual(1);
  });
});
