/**
 * LOD observers of vessels near a surface (src/camera/listener.ts): the point where the vessel meets the
 * ground and the radius of its footprint, from the envelope cylinders of its parts in their attitude.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLodObservers, OBSERVER_FOOTPRINT_MARGIN, vesselComRoot, vesselGroundObserver } from '@/camera';
import type { DefLibrary, PartDef } from '@/core/contracts/defs';
import type { CameraState } from '@/core/contracts/render';
import type { PartSnapshot, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';

let defs: DefLibrary;
let base: SimSnapshot;

beforeAll(async () => {
  const lib = await loadDefs(fsDefSource());
  const some = Object.values(lib.parts)[0]!;
  const part = (radius: number, yMin: number, yMax: number): PartDef => ({ ...some, bounds: { radius, yMin, yMax } });
  // A 44 m stack: a 40 m tank of 2.5 m radius on a 4 m engine section of 3 m radius.
  defs = { ...lib, parts: { ...lib.parts, 'test-tank': part(2.5, -20, 20), 'test-engines': part(3, -2, 2) } };
  base = createFakeSim(lib, { scene: 'pad' }).snapshot();
});

function stack(q = base.vessels[0]!.q): VesselSnapshot {
  const v = base.vessels[0]!;
  const like = v.parts[0]!;
  const parts: PartSnapshot[] = [
    { ...like, instanceId: 'tank', def: 'test-tank', localPos: { x: 0, y: 0, z: 0 }, localRot: quat.identity() },
    { ...like, instanceId: 'engines', def: 'test-engines', localPos: { x: 0, y: -22, z: 0 }, localRot: quat.identity() },
  ];
  return { ...v, q, parts, comLocal: { x: 0, y: -4, z: 0 }, boundingRadius: 25 };
}

describe('vessel ground observer', () => {
  it('a stack standing on the pad: at its foot, with the footprint of its base', () => {
    const v = stack();
    const up = v3.normalize(v.r);
    // The FakeSim's pad vessel stands nose up.
    expect(v3.dot(quat.rotate(v.q, v3.unitY()), up)).toBeGreaterThan(0.999);
    const o = vesselGroundObserver(defs, v);
    const com = vesselComRoot(v);
    // The lowest point is the bottom of the engine section: 24 m below the origin, 20 m below the centre of mass.
    expect(v3.dist(o.positionRoot, v3.addScaled(com, up, -20))).toBeLessThan(0.05);
    expect(o.radiusBias).toBeCloseTo(3 + OBSERVER_FOOTPRINT_MARGIN, 1);
    // The bounding sphere it replaces reached 25 m in every direction.
    expect(o.radiusBias).toBeLessThan(v.boundingRadius / 4);
  });

  it('the same stack lying on its side: the footprint is its length', () => {
    const upright = stack();
    const up = v3.normalize(upright.r);
    const side = v3.anyOrthogonal(up);
    const v = stack(quat.mul(quat.fromAxisAngle(side, Math.PI / 2), upright.q));
    expect(Math.abs(v3.dot(quat.rotate(v.q, v3.unitY()), up))).toBeLessThan(1e-6);
    const o = vesselGroundObserver(defs, v);
    const com = vesselComRoot(v);
    // Lowest point: the radius of the widest part below the axis; lateral reach: 20 m of stack beyond the centre of mass, capped by the bounding sphere.
    expect(v3.dot(v3.sub(com, o.positionRoot), up)).toBeCloseTo(3, 1);
    expect(o.radiusBias).toBe(v.boundingRadius);
    const shorter = { ...v, boundingRadius: 60 };
    expect(vesselGroundObserver(defs, shorter).radiusBias).toBeCloseTo(24 + OBSERVER_FOOTPRINT_MARGIN, 1);
  });

  it('parts without an envelope keep the bounding sphere about the centre of mass', () => {
    const v = { ...stack(), parts: stack().parts.map((p) => ({ ...p, def: 'no-such-part' })) };
    const o = vesselGroundObserver(defs, v);
    expect(o.positionRoot).toEqual(vesselComRoot(v));
    expect(o.radiusBias).toBe(v.boundingRadius);
  });

  it('buildLodObservers lists the camera and the vessel at its foot', () => {
    const v = stack();
    const s: SimSnapshot = { ...base, vessels: [v], readouts: { ...base.readouts, altitudeRadar: 0 } };
    const camera = { positionRoot: v3.addScaled(v.rRoot, v3.normalize(v.r), 100), kind: 'external' } as unknown as CameraState;
    const list = buildLodObservers(defs, s, camera);
    expect(list.length).toBe(2);
    expect(list[0]).toEqual({ positionRoot: camera.positionRoot, radiusBias: 0 });
    expect(list[1]).toEqual(vesselGroundObserver(defs, v));
    // Above 2 km the vessel is not an observer.
    const high: SimSnapshot = { ...s, readouts: { ...s.readouts, altitudeRadar: 2500 } };
    expect(buildLodObservers(defs, high, camera).length).toBe(1);
  });
});
