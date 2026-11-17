/**
 * The chase rig about an assembly and through a dock (src/camera/chaseRig.ts): the limits of several craft
 * come from the bounding radius, never from the distances a craft states for itself, and limits that move past
 * the camera from one frame to the next (a dock, an undock) never step its distance.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CHASE_AUTO_SECONDS, chaseDistanceLimits, createChaseRig, vesselComRoot, type ChaseRig } from '@/camera';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraInput } from '@/core/contracts/render';
import type { CraftSnapshot, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSession } from '@/core/fakes/fakeSession';
import { v3 } from '@/core/math/vec3';
import { LAB_VEHICLE_ID, labVehicleParts, withLabVehicle } from '../../../labs/flight-ui/labVehicle';

let defs: DefLibrary;
beforeAll(async () => {
  defs = withLabVehicle(await loadDefs(fsDefSource()));
});

const IDLE: CameraInput = { yaw: 0, pitch: 0, zoom: 1 };
const DT = 1 / 60;

/** One craft in low orbit: the lab vehicle, whose craft block states 95 m by default, 30 m to 2500 m. */
const alone = (): SimSnapshot => createFakeSession(defs, { scene: 'lowOrbit', vehicleId: LAB_VEHICLE_ID, parts: labVehicleParts(defs) }).snapshot();
const vesselOf = (s: SimSnapshot): VesselSnapshot => s.vessels.find((x) => x.id === s.activeVesselId)!;

/** The same vessel, its id kept, with a second craft aboard and the bounding radius of the two together. */
function docked(s: SimSnapshot, boundingRadius: number, chase?: CraftSnapshot['chase']): SimSnapshot {
  const v = vesselOf(s);
  const own = v.crafts![0]!;
  const craft = chase ? { ...own, chase } : own;
  const assembly: VesselSnapshot = { ...v, boundingRadius, crafts: [craft, { ...craft, id: `${own.id}-guest`, name: 'Guest' }] };
  return { ...s, vessels: s.vessels.map((x) => (x.id === v.id ? assembly : x)) };
}

/** Frames of `input`, with the largest step of the distance between two of them (natural log) and whether it ever went back. */
function run(rig: ChaseRig, s: SimSnapshot, frames: number, input: CameraInput = IDLE): { worst: number; outward: boolean; inward: boolean } {
  let prev = rig.distance;
  let worst = 0;
  let outward = true;
  let inward = true;
  for (let i = 0; i < frames; i++) {
    const c = rig.update(s, input, DT);
    // The distance the rig states is where the eye is.
    expect(v3.dist(c.positionRoot, vesselComRoot(vesselOf(s)))).toBeCloseTo(rig.distance, 6);
    worst = Math.max(worst, Math.abs(Math.log(rig.distance / prev)));
    if (rig.distance < prev) outward = false;
    if (rig.distance > prev) inward = false;
    prev = rig.distance;
  }
  return { worst, outward, inward };
}

describe('chase limits of an assembly', () => {
  it('two docked capsules that each state the 140 m of their launch stack are framed from their radius, not from 140 m', () => {
    const s = docked(alone(), 5, { defaultDistance: 140, minDistance: 30, maxDistance: 2500 });
    const lim = chaseDistanceLimits(defs, vesselOf(s));
    expect(lim).toEqual({ def: 2.4 * 5, min: 1.15 * 5, max: 2500 });
    const rig = createChaseRig({ defs });
    rig.activate(null, s);
    rig.update(s, IDLE, DT);
    expect(rig.distance).toBe(lim.def);
    // The far limit is the larger of 60 radii and what a craft aboard allows.
    expect(chaseDistanceLimits(defs, vesselOf(docked(alone(), 100, { defaultDistance: 140, minDistance: 30, maxDistance: 2500 })))).toEqual({ def: 240, min: 1.15 * 100, max: 6000 });
  });
});

describe('the camera distance through a dock and an undock', () => {
  it('zoomed in to the nearest distance of the lone craft, the camera travels out to the nearest distance of the assembly: no step in the frame of the dock', () => {
    const s1 = alone();
    const lim1 = chaseDistanceLimits(defs, vesselOf(s1));
    const rig = createChaseRig({ defs });
    rig.activate(null, s1);
    run(rig, s1, 200, { yaw: 0, pitch: 0, zoom: 0.5 });
    run(rig, s1, 60);
    const before = rig.distance;
    expect(before).toBeCloseTo(lim1.min, 6);
    const s2 = docked(s1, 2.2 * vesselOf(s1).boundingRadius);
    const lim2 = chaseDistanceLimits(defs, vesselOf(s2));
    expect(lim2.min).toBeGreaterThan(2 * before);
    // The frame of the dock: the limits have moved past the camera, and it has moved by under 2 %.
    const first = run(rig, s2, 1);
    expect(first.worst).toBeGreaterThan(0);
    expect(first.worst).toBeLessThan(0.02);
    expect(rig.distance).toBeLessThan(1.02 * before);
    // From there outward only, at the rate of a separation (CHASE_AUTO_SECONDS), never a snap...
    const travel = run(rig, s2, 3 * 60);
    expect(travel.outward).toBe(true);
    expect(travel.worst).toBeLessThan(0.02);
    // ... most of the way after three time constants, and standing ON the limit in the end.
    expect(Math.log(lim2.min / rig.distance)).toBeLessThan(Math.log(lim2.min / before) * Math.exp(-3 / CHASE_AUTO_SECONDS) * 1.5);
    const rest = run(rig, s2, 12 * 60);
    expect(rest.outward).toBe(true);
    expect(rest.worst).toBeLessThan(0.02);
    expect(rig.distance).toBeCloseTo(lim2.min, 9);
    expect(rig.distance).toBeGreaterThanOrEqual(lim2.min);
    expect(run(rig, s2, 60).worst).toBeLessThan(1e-12);
  });

  it('a camera inside the new limits is not moved by them: it goes over to the framing of the assembly as after a separation', () => {
    const s1 = alone();
    const rig = createChaseRig({ defs });
    rig.activate(null, s1);
    rig.update(s1, IDLE, DT);
    rig.setOrbit(rig.offsets.azimuth, 0.3, 400);
    run(rig, s1, 60);
    expect(rig.distance).toBeCloseTo(400, 6);
    const s2 = docked(s1, 2.2 * vesselOf(s1).boundingRadius);
    const lim2 = chaseDistanceLimits(defs, vesselOf(s2));
    expect(lim2.min).toBeLessThan(400);
    expect(lim2.max).toBeGreaterThan(400);
    expect(run(rig, s2, 1).worst).toBeLessThan(0.02);
    const after = run(rig, s2, 10 * 60);
    expect(after.worst).toBeLessThan(0.04);
    expect(rig.distance).toBeGreaterThanOrEqual(lim2.min);
    expect(rig.distance).toBeLessThanOrEqual(lim2.max);
  });

  it('at an undock the far limit moves in past a camera that was zoomed out on the assembly: it travels in, no step', () => {
    const s1 = alone();
    const lim1 = chaseDistanceLimits(defs, vesselOf(s1));
    const s2 = docked(s1, 2.2 * vesselOf(s1).boundingRadius);
    const lim2 = chaseDistanceLimits(defs, vesselOf(s2));
    expect(lim2.max).toBeGreaterThan(2 * lim1.max);
    const rig = createChaseRig({ defs });
    rig.activate(null, s2);
    rig.update(s2, IDLE, DT);
    rig.setOrbit(rig.offsets.azimuth, 0.3, lim2.max);
    run(rig, s2, 60);
    const before = rig.distance;
    expect(before).toBeCloseTo(lim2.max, 6);
    // (Nearly three times too far: the first frame is the fastest of the way, under 4 % as after a separation.)
    const first = run(rig, s1, 1);
    expect(first.worst).toBeGreaterThan(0);
    expect(first.worst).toBeLessThan(0.04);
    expect(rig.distance).toBeGreaterThan(0.96 * before);
    const travel = run(rig, s1, 15 * 60);
    expect(travel.inward).toBe(true);
    expect(travel.worst).toBeLessThanOrEqual(first.worst);
    expect(rig.distance).toBeCloseTo(lim1.max, 9);
    expect(rig.distance).toBeLessThanOrEqual(lim1.max);
    expect(run(rig, s1, 60).worst).toBeLessThan(1e-12);
  });
});
