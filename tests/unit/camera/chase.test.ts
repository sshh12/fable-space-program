/**
 * Chase rig framing (src/camera/chaseRig.ts): the default view keeps the body of the vessel's sphere of
 * influence in the frame from the pad to deep space, the default distance follows the size of what is left of
 * the vehicle, and the player's yaw, pitch and zoom persist through view switches, staging and spheres of
 * influence.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CHASE_BODY_BLEND_SECONDS,
  CHASE_DISC_ROLL,
  CHASE_DISTANCE_PER_RADIUS,
  CHASE_SUN_OFFSET,
  CHASE_TOWER_CLEAR,
  CHASE_TRENCH_MODELS,
  CHASE_TRENCH_OFFSET,
  chaseAutoDistance,
  chaseDistanceLimits,
  chaseReferenceElevation,
  chaseReferenceRoll,
  chaseTrenchHeading,
  createChaseRig,
  createCockpitRig,
  createMapRig,
  createViewManager,
  vesselComRoot,
  vesselRadiusAboutCom,
  viewForward,
  viewUp,
} from '@/camera';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraInput, CameraState } from '@/core/contracts/render';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { labVehicleParts, tagLabVehicle, withLabVehicle } from '../../../labs/flight-ui/labVehicle';

let defs: DefLibrary;
beforeAll(async () => {
  defs = withLabVehicle(await loadDefs(fsDefSource()));
});

const IDLE: CameraInput = { yaw: 0, pitch: 0, zoom: 1 };
const DT = 1 / 60;
const FOV = 55 * DEG;

const snapshot = (scene: FakeScene): SimSnapshot => tagLabVehicle(createFakeSim(defs, { scene, parts: labVehicleParts(defs) }).snapshot());
const vesselOf = (s: SimSnapshot): VesselSnapshot => s.vessels.find((x) => x.id === s.activeVesselId)!;

/** Where a body is in the camera's frame: angle of its centre from the view axis, its angular radius, and whether it lies below the centre. */
function bodyInFrame(s: SimSnapshot, c: CameraState, bodyId: string): { centre: number; radius: number; below: boolean; nearLimb: number; farLimb: number } {
  const b = s.bodies.find((x) => x.id === bodyId)!;
  const to = v3.sub(b.rRoot, c.positionRoot);
  const d = v3.len(to);
  const dir = v3.scale(to, 1 / d);
  const centre = Math.acos(Math.max(-1, Math.min(1, v3.dot(dir, viewForward(c.qViewToRoot)))));
  const radius = Math.asin(Math.min(1, defs.bodies[bodyId]!.radius / d));
  return { centre, radius, below: v3.dot(dir, viewUp(c.qViewToRoot)) < 0, nearLimb: centre - radius, farLimb: centre + radius };
}

describe('reference elevation and roll', () => {
  const rhoAt = (altitude: number, radius = 6371e3): number => Math.asin(radius / (radius + altitude));
  /** Elevation of the default view, degrees, with the share of the roll that the default view applies. */
  const at = (altitude: number, radius = 6371e3): number => {
    const rho = rhoAt(altitude, radius);
    return chaseReferenceElevation(rho, FOV, 12 * DEG, chaseReferenceRoll(rho) / CHASE_DISC_ROLL) / DEG;
  };

  it('is the view along the horizon near a body and rises over the vehicle with the altitude', () => {
    expect(at(30)).toBe(12);
    expect(at(185e3)).toBe(12);
    // The Moon from 105 km.
    expect(at(105e3, 1737.4e3)).toBe(12);
    expect(at(1000e3)).toBeCloseTo(20.3, 0);
    expect(at(35786e3)).toBeGreaterThan(55);
    expect(at(378000e3)).toBeGreaterThan(65);
    expect(at(378000e3)).toBeLessThan(72);
    // Continuous in the altitude, and never below the view along the horizon.
    let prev = at(1);
    for (let h = 1; h < 1e9; h *= 1.02) {
      const e = at(h);
      expect(e).toBeGreaterThanOrEqual(12);
      expect(Math.abs(e - prev)).toBeLessThan(1.2);
      prev = e;
    }
    // Level (no roll applied: the player's camera) the limb is a third of the half field under the centre at every distance.
    expect(chaseReferenceElevation(1 * DEG, FOV) / DEG).toBeCloseTo(90 - 1 - 0.36 * 27.5, 9);
  });

  it('rolls the default view only for a body that is a disc, and smoothly', () => {
    expect(chaseReferenceRoll(rhoAt(185e3))).toBe(0);
    expect(chaseReferenceRoll(rhoAt(105e3, 1737.4e3))).toBe(0);
    expect(chaseReferenceRoll(rhoAt(10000e3))).toBe(0);
    expect(chaseReferenceRoll(rhoAt(378000e3))).toBe(CHASE_DISC_ROLL);
    expect(chaseReferenceRoll(rhoAt(60000e3, 1737.4e3))).toBe(CHASE_DISC_ROLL);
    let prev = 0;
    for (let rho = 30 * DEG; rho > 0.5 * DEG; rho *= 0.99) {
      const r = chaseReferenceRoll(rho);
      expect(r).toBeGreaterThanOrEqual(prev);
      expect(r - prev).toBeLessThan(2 * DEG);
      prev = r;
    }
  });

  it('keeps the body in the frame at every distance: below the vehicle as a horizon, beside it to the lower left as a disc', () => {
    const half = FOV / 2;
    const halfH = Math.atan((Math.tan(half) * 16) / 9);
    for (let rho = 0.01 * DEG; rho < 89.9 * DEG; rho *= 1.05) {
      const roll = chaseReferenceRoll(rho);
      const e = chaseReferenceElevation(rho, FOV, 12 * DEG, roll / CHASE_DISC_ROLL);
      // The view direction is `e` below the horizontal; the body's centre is straight down: 90 deg - e from the axis.
      const centre = Math.PI / 2 - e;
      const near = centre - rho;
      expect(near, `limb of a body of ${(rho / DEG).toFixed(2)} deg`).toBeLessThan(0.75 * half);
      if (rho < 6 * DEG) {
        // A small disc: whole in the frame, clear of the middle (the vehicle), and not in the bottom middle,
        // where a flight display has its instruments (the bottom 45 % of the half height, a third of the width).
        const x = centre * Math.sin(roll);
        const y = centre * Math.cos(roll);
        expect(y + rho).toBeLessThan(half);
        expect(x + rho).toBeLessThan(halfH);
        expect(near).toBeGreaterThan(0.6 * half);
        expect(x - rho > halfH / 3 || y + rho < 0.45 * half, `disc of ${(rho / DEG).toFixed(2)} deg at ${(x / DEG).toFixed(1)}, ${(y / DEG).toFixed(1)} deg`).toBe(true);
      }
    }
  });
});

describe('default framing of the chase rig', () => {
  const scenes: { scene: FakeScene; body: string }[] = [
    { scene: 'lowOrbit', body: 'earth' },
    { scene: 'translunar', body: 'earth' },
    { scene: 'lunarOrbit', body: 'moon' },
    { scene: 'reentry', body: 'earth' },
  ];
  for (const { scene, body } of scenes) {
    it(`${scene}: the ${body} is in the frame, below the vehicle`, () => {
      const s = snapshot(scene);
      const v = vesselOf(s);
      expect(v.bodyId).toBe(body);
      const rig = createChaseRig({ defs });
      rig.activate(null, s);
      const c = rig.update(s, IDLE, DT);
      const f = bodyInFrame(s, c, body);
      expect(f.below).toBe(true);
      // The near limb is inside the frame with room to spare; from afar the whole disc is, to the lower left.
      expect(f.nearLimb).toBeLessThan(0.75 * (FOV / 2));
      if (f.radius < 4 * DEG) {
        const toBody = v3.normalize(v3.sub(s.bodies.find((b) => b.id === body)!.rRoot, c.positionRoot));
        const x = v3.dot(toBody, quat.rotate(c.qViewToRoot, v3.unitX()));
        const y = v3.dot(toBody, viewUp(c.qViewToRoot));
        expect(x).toBeLessThan(-Math.sin(10 * DEG));
        expect(y).toBeLessThan(0);
        expect(Math.asin(-y) + f.radius).toBeLessThan(FOV / 2);
        expect(rig.roll).toBe(CHASE_DISC_ROLL);
      } else if (f.radius > 20 * DEG) {
        expect(rig.roll).toBe(0);
      }
      // The vehicle is at the centre.
      const toVessel = v3.normalize(v3.sub(vesselComRoot(v), c.positionRoot));
      expect(v3.dot(toVessel, viewForward(c.qViewToRoot))).toBeGreaterThan(1 - 1e-9);
    });
  }

  it('the frame is level with the body in both navball modes (the horizon is horizontal)', () => {
    const fake = createFakeSim(defs, { scene: 'lowOrbit', parts: labVehicleParts(defs) });
    const rig = createChaseRig({ defs });
    for (const mode of ['orbit', 'surface'] as const) {
      fake.commands.setNavballMode(mode);
      const s = tagLabVehicle(fake.snapshot());
      const c = rig.update(s, IDLE, DT);
      const v = vesselOf(s);
      const radial = v3.normalize(v.r);
      const right = quat.rotate(c.qViewToRoot, v3.unitX());
      expect(Math.abs(v3.dot(right, radial))).toBeLessThan(1e-9);
      expect(v3.dot(viewUp(c.qViewToRoot), radial)).toBeGreaterThan(0);
    }
  });
});

/** The part with the smallest envelope (what is left after the last separation). */
function smallestPart(v: VesselSnapshot): VesselSnapshot['parts'][number] {
  const size = (def: string): number => {
    const b = defs.parts[def]?.bounds;
    return b ? Math.hypot(0.5 * (b.yMax - b.yMin), b.radius) : Infinity;
  };
  return v.parts.reduce((a, b) => (size(b.def) < size(a.def) ? b : a));
}

describe('the sun in the default framing (orbit mode)', () => {
  /** Angle of the sun from the view axis, and the angle between the horizontal parts of the eye's offset and of the sun's direction. */
  function sun(s: SimSnapshot, c: CameraState): { fromAxis: number; side: number; horizontal: number } {
    const v = vesselOf(s);
    const dir = s.bodies.find((b) => b.id === v.bodyId)!.sunDir;
    const up = v3.normalize(v.r);
    const eye = v3.normalize(v3.sub(c.positionRoot, vesselComRoot(v)));
    const eh = v3.normalize(v3.reject(eye, up));
    const shRaw = v3.reject(dir, up);
    const sh = v3.normalize(shRaw);
    return { fromAxis: Math.acos(Math.max(-1, Math.min(1, v3.dot(dir, viewForward(c.qViewToRoot))))), side: Math.acos(Math.max(-1, Math.min(1, v3.dot(eh, sh)))), horizontal: v3.len(shRaw) };
  }

  for (const scene of ['lowOrbit', 'translunar', 'lunarOrbit'] as const) {
    it(`${scene}: the eye is on the sunward side and the sun is far outside the frame`, () => {
      const s = snapshot(scene);
      expect(s.navball.mode).toBe('orbit');
      const rig = createChaseRig({ defs });
      rig.activate(null, s);
      const c = rig.update(s, IDLE, DT);
      const g = sun(s, c);
      expect(rig.autoAzimuth).toBe(true);
      if (g.horizontal > 0.2) expect(g.side).toBeCloseTo(CHASE_SUN_OFFSET, 6);
      // Half the frame's diagonal is 48 degrees: the sun is at least 25 degrees outside it.
      expect(g.fromAxis / DEG).toBeGreaterThan(48 + 25);
    });
  }

  it('follows the sun round the orbit until the player turns the camera, then stays where it was put', () => {
    const fake = createFakeSim(defs, { scene: 'lowOrbit', parts: labVehicleParts(defs) });
    const rig = createChaseRig({ defs });
    let s = tagLabVehicle(fake.snapshot());
    rig.activate(null, s);
    let c = rig.update(s, IDLE, DT);
    // A third of an orbit in steps of two seconds (the camera follows at up to 15 degrees a second).
    let worst = 0;
    for (let i = 0; i < 900; i++) {
      fake.advance(2);
      s = tagLabVehicle(fake.snapshot());
      c = rig.update(s, IDLE, 2);
      const g = sun(s, c);
      if (g.horizontal > 0.3) worst = Math.max(worst, Math.abs(g.side - CHASE_SUN_OFFSET));
    }
    expect(worst / DEG).toBeLessThan(12);
    expect(rig.autoAzimuth).toBe(true);
    // The player turns the camera: from now on the azimuth is theirs, fixed to the track.
    rig.update(s, { yaw: 0.4, pitch: 0, zoom: 1 }, DT);
    expect(rig.autoAzimuth).toBe(false);
    const azimuth = rig.offsets.azimuth;
    for (let i = 0; i < 300; i++) {
      fake.advance(2);
      rig.update(tagLabVehicle(fake.snapshot()), IDLE, 2);
    }
    expect(rig.offsets.azimuth).toBe(azimuth);
    rig.resetView();
    rig.update(tagLabVehicle(fake.snapshot()), IDLE, DT);
    expect(rig.autoAzimuth).toBe(true);
  });

  it('on a surface the default azimuth stays where it starts, whatever the sun does', () => {
    const s = snapshot('pad');
    const rig = createChaseRig({ defs });
    rig.activate(null, s);
    rig.update(s, IDLE, DT);
    const a = rig.offsets.azimuth;
    for (let i = 0; i < 120; i++) rig.update(s, IDLE, DT);
    expect(rig.offsets.azimuth).toBe(a);
  });
});

describe('the default view at a launch pad with a flame trench (request vfx-11)', () => {
  /** Compass bearing (rad, clockwise from north) of the horizontal part of a ROOT direction at the vessel, and that part's share. */
  const bearing = (s: SimSnapshot, v: VesselSnapshot, dirRoot: Vec3): { rad: number; share: number } => {
    const body = s.bodies.find((b) => b.id === v.bodyId)!;
    const up = v3.normalize(v.r);
    const east = v3.normalize(v3.cross(quat.rotate(body.qFixedToRoot, v3.unitZ()), up));
    const north = v3.cross(up, east);
    const d = v3.normalize(dirRoot);
    const e = v3.dot(d, east);
    const n = v3.dot(d, north);
    return { rad: Math.atan2(e, n), share: Math.hypot(e, n) };
  };
  const wrap = (a: number): number => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  const siteTrenchDeg = (): number => {
    const site = Object.values(defs.sites)[0]!;
    const structures = site.pads && site.pads.length > 0 ? site.pads[0]!.structures : site.structures;
    return structures.find((x) => CHASE_TRENCH_MODELS.includes(x.model))!.headingDeg;
  };

  it('finds the trench of the pad the vessel stands on, and none where no pad is near', () => {
    const pad = snapshot('pad');
    expect(chaseTrenchHeading(defs, pad, vesselOf(pad))! / DEG).toBeCloseTo(siteTrenchDeg(), 9);
    for (const scene of ['lowOrbit', 'lunarSurface'] as const) {
      const s = snapshot(scene);
      expect(chaseTrenchHeading(defs, s, vesselOf(s))).toBeNull();
    }
  });

  it('stands 70 degrees off the trench axis, clear of the tower side, and of the places that leaves on the one the sun is most behind', () => {
    const s = snapshot('pad');
    const v = vesselOf(s);
    const rig = createChaseRig({ defs, padView: true });
    rig.activate(null, s);
    const c = rig.update(s, IDLE, DT);
    const eye = bearing(s, v, v3.sub(c.positionRoot, vesselComRoot(v)));
    const trench = siteTrenchDeg() * DEG;
    // Off the axis (either end of it) by the offset.
    const offAxis = Math.min(Math.abs(wrap(eye.rad - trench)), Math.abs(wrap(eye.rad - trench - Math.PI)));
    expect(offAxis / DEG).toBeCloseTo(CHASE_TRENCH_OFFSET / DEG, 6);
    // Not on the side of the umbilical tower (the vessel's ventral side).
    const ventral = bearing(s, v, quat.rotate(v.q, v3.new(0, 0, -1)));
    expect(ventral.share).toBeGreaterThan(0.9);
    expect(Math.abs(wrap(eye.rad - ventral.rad))).toBeGreaterThanOrEqual(CHASE_TOWER_CLEAR);
    // Of the places off the axis that are clear of the tower, none has the sun further behind the camera
    // (the rig leans a twentieth towards the vessel's starboard side where the sun does not decide).
    const sun = bearing(s, v, s.bodies.find((b) => b.id === v.bodyId)!.sunDir);
    const behind = (b: number): number => sun.share * Math.cos(b - sun.rad);
    for (const axis of [trench, trench + Math.PI]) {
      for (const side of [-1, 1]) {
        const b = axis + side * CHASE_TRENCH_OFFSET;
        if (Math.abs(wrap(b - ventral.rad)) < CHASE_TOWER_CLEAR) continue;
        expect(behind(eye.rad)).toBeGreaterThanOrEqual(behind(b) - 0.11);
      }
    }
    // The player's yaw wins, and a reset comes back to the pad's view.
    rig.update(s, { yaw: 0.4, pitch: 0, zoom: 1 }, DT);
    expect(rig.autoAzimuth).toBe(false);
    rig.resetView();
    for (let i = 0; i < 400; i++) rig.update(s, IDLE, DT);
    const back = rig.update(s, IDLE, DT);
    expect(Math.abs(wrap(bearing(s, v, v3.sub(back.positionRoot, vesselComRoot(v))).rad - eye.rad))).toBeLessThan(1e-6);
  });

  it('frameBody: false keeps the view from the starboard side of the vessel on the pad', () => {
    const s = snapshot('pad');
    const v = vesselOf(s);
    const rig = createChaseRig({ defs, frameBody: false });
    rig.activate(null, s);
    const c = rig.update(s, IDLE, DT);
    const eye = bearing(s, v, v3.sub(c.positionRoot, vesselComRoot(v)));
    const starboard = bearing(s, v, quat.rotate(v.q, v3.unitX()));
    expect(Math.abs(wrap(eye.rad - starboard.rad))).toBeLessThan(1e-6);
  });
});

describe('options that pin the framing of before', () => {
  it('frameBody: false keeps 12 degrees of elevation at every altitude and the azimuth from the nose', () => {
    const s = snapshot('translunar');
    const v = vesselOf(s);
    const rig = createChaseRig({ defs, frameBody: false });
    rig.activate(null, s);
    const c = rig.update(s, IDLE, DT);
    const eye = v3.normalize(v3.sub(c.positionRoot, vesselComRoot(v)));
    expect(Math.asin(v3.dot(eye, v3.normalize(v.r))) / DEG).toBeCloseTo(12, 6);
    const a = rig.offsets.azimuth;
    for (let i = 0; i < 60; i++) rig.update(s, IDLE, DT);
    expect(rig.offsets.azimuth).toBe(a);
  });

  it('distanceRadii: Infinity keeps the vehicle default for what is left after staging', () => {
    const s = snapshot('lowOrbit');
    const v = vesselOf(s);
    const part = smallestPart(v);
    const alone: VesselSnapshot = { ...v, parts: [{ ...part, localPos: v3.zero() }], comLocal: v3.zero(), boundingRadius: 3 };
    const after: SimSnapshot = { ...s, vessels: s.vessels.map((x) => (x.id === v.id ? alone : x)) };
    const rig = createChaseRig({ defs, distanceRadii: Infinity });
    rig.activate(null, after);
    rig.update(after, IDLE, DT);
    expect(rig.distance).toBe(chaseDistanceLimits(defs, alone).def);
    expect(chaseAutoDistance(defs, alone, Infinity)).toBe(chaseDistanceLimits(defs, alone).def);
  });

  it('startBehindPreviousView: the chase view starts behind where the cockpit looked', () => {
    const s = snapshot('lowOrbit');
    const v = vesselOf(s);
    const rig = createChaseRig({ defs, startBehindPreviousView: true });
    rig.activate(null, s);
    rig.update(s, IDLE, DT);
    const up = v3.normalize(v.r);
    const side = v3.normalize(v3.cross(up, v3.normalize(v.v)));
    // A cockpit looking along the orbit normal, 20 degrees up.
    const look = v3.normalize(v3.add(v3.scale(side, Math.cos(20 * DEG)), v3.scale(up, Math.sin(20 * DEG))));
    const z = v3.neg(look);
    const x = v3.normalize(v3.cross(up, z));
    const from = { kind: 'interior', qViewToRoot: quat.fromBasis(x, v3.cross(z, x), z) } as unknown as CameraState;
    rig.activate(from, s);
    const c = rig.update(s, IDLE, DT);
    const eye = v3.normalize(v3.sub(c.positionRoot, vesselComRoot(v)));
    expect(v3.dot(eye, v3.neg(look))).toBeGreaterThan(1 - 1e-9);
    expect(rig.autoAzimuth).toBe(false);
  });
});

describe('default distance', () => {
  it('follows the size of the vessel: the whole stack at the vehicle default, what is left of it nearer', () => {
    const s = snapshot('lowOrbit');
    const v = vesselOf(s);
    const lim = chaseDistanceLimits(defs, v);
    const r = vesselRadiusAboutCom(defs, v)!;
    expect(r).toBeGreaterThan(1);
    expect(r).toBeLessThanOrEqual(2 * v.boundingRadius);
    expect(chaseAutoDistance(defs, v)).toBe(Math.min(lim.max, Math.max(lim.min, Math.min(lim.def, CHASE_DISTANCE_PER_RADIUS * r))));
    // One part left (a capsule after its last separation), with a bounding radius to match.
    const part = smallestPart(v);
    const alone: VesselSnapshot = { ...v, parts: [{ ...part, localPos: v3.zero() }], comLocal: v3.zero(), boundingRadius: 3 };
    const small = chaseAutoDistance(defs, alone);
    expect(small).toBeLessThan(0.5 * lim.def);
    expect(small).toBeGreaterThanOrEqual(chaseDistanceLimits(defs, alone).min);
    // Placeholder parts: the vehicle's default as before.
    const unknown: VesselSnapshot = { ...v, parts: v.parts.map((p) => ({ ...p, def: 'no-such-part' })) };
    expect(vesselRadiusAboutCom(defs, unknown)).toBeNull();
    expect(chaseAutoDistance(defs, unknown)).toBe(lim.def);
  });

  it('after a separation the camera closes in over a second, and the zoom the player chose stays a factor on it', () => {
    const s = snapshot('lowOrbit');
    const v = vesselOf(s);
    const rig = createChaseRig({ defs });
    rig.activate(null, s);
    rig.update(s, IDLE, DT);
    const before = rig.distance;
    expect(before).toBeCloseTo(chaseAutoDistance(defs, v), 9);
    // The player zooms out by half as much again.
    for (let i = 0; i < 10; i++) rig.update(s, { yaw: 0, pitch: 0, zoom: 1.5 ** 0.1 }, DT);
    for (let i = 0; i < 120; i++) rig.update(s, IDLE, DT);
    expect(rig.distance / before).toBeCloseTo(1.5, 3);
    expect(rig.offsets.zoom).toBeCloseTo(1.5, 6);
    // Staging: one part is left.
    const part = smallestPart(v);
    const alone: VesselSnapshot = { ...v, parts: [{ ...part, localPos: v3.zero() }], comLocal: v3.zero(), boundingRadius: 3 };
    const after: SimSnapshot = { ...s, vessels: s.vessels.map((x) => (x.id === v.id ? alone : x)) };
    const want = Math.max(chaseDistanceLimits(defs, alone).min, 1.5 * chaseAutoDistance(defs, alone));
    let prev = rig.distance;
    let worst = 0;
    for (let i = 0; i < 360; i++) {
      rig.update(after, IDLE, DT);
      worst = Math.max(worst, Math.abs(Math.log(rig.distance / prev)));
      prev = rig.distance;
    }
    expect(rig.distance).toBeCloseTo(want, 1);
    // No snap: under 4 % per frame.
    expect(worst).toBeLessThan(0.04);
    expect(rig.offsets.zoom).toBeCloseTo(1.5, 6);
  });
});

describe("the player's camera persists", () => {
  const place = (s: SimSnapshot, c: CameraState): Vec3 => v3.sub(c.positionRoot, vesselComRoot(vesselOf(s)));

  it('through the cockpit and the map and back: the chase view is where it was left', () => {
    const s = snapshot('lowOrbit');
    const chase = createChaseRig({ defs });
    const vm = createViewManager([chase, createCockpitRig({ defs }), createMapRig({ defs })], { defs });
    vm.update(s, IDLE, DT);
    // The player turns, lowers and zooms the camera.
    for (let i = 0; i < 30; i++) vm.update(s, { yaw: 0.02, pitch: 0.01, zoom: 1.01 }, DT);
    let f = vm.update(s, IDLE, DT);
    for (let i = 0; i < 120; i++) f = vm.update(s, IDLE, DT);
    const left = place(s, f.camera);
    const offsets = { ...chase.offsets };
    expect(Math.abs(offsets.pitch)).toBeGreaterThan(0.2);
    expect(offsets.zoom).toBeGreaterThan(1.2);
    for (const keys of [['cycleCamera', 'cycleCamera'], ['toggleMap', 'toggleMap']] as const) {
      for (const key of keys) {
        vm.update(s, IDLE, DT, new Set([key]));
        for (let i = 0; i < 90; i++) f = vm.update(s, IDLE, DT);
      }
      expect(vm.mode).toBe('chase');
      expect(f.camera.kind).toBe('external');
      expect(chase.offsets).toEqual(offsets);
      expect(v3.dist(place(s, f.camera), left)).toBeLessThan(1e-6 * v3.len(left));
    }
  });

  it('input always wins: pitch and yaw move the camera at once from the default framing, and stay as offsets when the altitude changes', () => {
    const low = snapshot('lowOrbit');
    const rig = createChaseRig({ defs });
    rig.activate(null, low);
    const a = rig.update(low, IDLE, DT);
    const b = rig.update(low, { yaw: 0.3, pitch: -0.2, zoom: 1 }, DT);
    expect(quat.angleBetween(a.qViewToRoot, b.qViewToRoot)).toBeGreaterThan(0.2);
    expect(rig.offsets.pitch).toBeCloseTo(0.2, 9);
    // Far from the body the default view is rolled (the disc beside the vehicle). The player tilts the camera:
    // the elevation moves by what they asked for and stays there while the roll eases out of their view.
    const far = snapshot('translunar');
    const v = vesselOf(far);
    const elevationOf = (c: CameraState): number => Math.asin(v3.dot(v3.normalize(v3.sub(c.positionRoot, vesselComRoot(v))), v3.normalize(v.r)));
    const rig2 = createChaseRig({ defs });
    rig2.activate(null, far);
    const e0 = elevationOf(rig2.update(far, IDLE, DT));
    expect(rig2.roll).toBe(CHASE_DISC_ROLL);
    let c = rig2.update(far, { yaw: 0, pitch: 0.2, zoom: 1 }, DT);
    expect(elevationOf(c)).toBeCloseTo(e0 - 0.2, 6);
    for (let i = 0; i < 600; i++) {
      c = rig2.update(far, IDLE, DT);
      expect(elevationOf(c)).toBeCloseTo(e0 - 0.2, 6);
    }
    expect(rig2.roll).toBe(0);
    // Level again: the camera's right is horizontal.
    expect(Math.abs(v3.dot(quat.rotate(c.qViewToRoot, v3.unitX()), v3.normalize(v.r)))).toBeLessThan(1e-9);
    // And the offset is from the level reference.
    const ref = chaseReferenceElevation(Math.asin(defs.bodies[v.bodyId]!.radius / v3.len(v.r)), FOV);
    expect(rig2.offsets.pitch).toBeCloseTo(e0 - 0.2 - ref, 6);
  });

  it('setOrbit places the camera absolutely and resetView swings back to the default framing', () => {
    const s = snapshot('translunar');
    const v = vesselOf(s);
    const rig = createChaseRig({ defs });
    rig.activate(null, s);
    const def = rig.update(s, IDLE, DT);
    rig.setOrbit(1.1, 20 * DEG, 400);
    const c = rig.update(s, IDLE, DT);
    const rel = v3.sub(c.positionRoot, vesselComRoot(v));
    expect(v3.len(rel)).toBeCloseTo(Math.min(400, chaseDistanceLimits(defs, v).max), 6);
    expect(Math.asin(v3.dot(v3.normalize(rel), v3.normalize(v.r))) / DEG).toBeCloseTo(20, 6);
    rig.resetView();
    let prev = rig.update(s, IDLE, DT);
    let worst = 0;
    let last = prev;
    for (let i = 0; i < 900; i++) {
      last = rig.update(s, IDLE, DT);
      worst = Math.max(worst, quat.angleBetween(prev.qViewToRoot, last.qViewToRoot) / DEG);
      prev = last;
    }
    // A brisk move the player asked for, not a cut.
    expect(worst).toBeLessThan(8);
    expect(quat.angleBetween(last.qViewToRoot, def.qViewToRoot) / DEG).toBeLessThan(0.01);
    expect(rig.offsets.pitch).toBe(0);
    expect(rig.offsets.zoom).toBe(1);
  });
});

describe('sphere-of-influence change', () => {
  it('swings the camera to the new body over a few seconds and ends with it in the frame', () => {
    const s = snapshot('translunar');
    const v = vesselOf(s);
    expect(v.bodyId).toBe('earth');
    const moon = s.bodies.find((b) => b.id === 'moon')!;
    const earth = s.bodies.find((b) => b.id === 'earth')!;
    // The same vessel a moment later, now in the Moon's sphere of influence.
    const inMoon: VesselSnapshot = { ...v, bodyId: 'moon', r: v3.sub(v.rRoot, moon.rRoot), v: v3.sub(v3.add(v.v, earth.vRoot), moon.vRoot) };
    const after: SimSnapshot = { ...s, vessels: s.vessels.map((x) => (x.id === v.id ? inMoon : x)) };
    const rig = createChaseRig({ defs });
    rig.activate(null, s);
    let prev = rig.update(s, IDLE, DT);
    expect(bodyInFrame(s, prev, 'earth').nearLimb).toBeLessThan(0.75 * (FOV / 2));
    let worst = 0;
    let c = prev;
    const frames = Math.round((CHASE_BODY_BLEND_SECONDS + 0.5) / DT);
    for (let i = 0; i < frames; i++) {
      c = rig.update(after, IDLE, DT);
      worst = Math.max(worst, quat.angleBetween(prev.qViewToRoot, c.qViewToRoot) / DEG);
      prev = c;
    }
    // A swing, not a cut: under 3 degrees a frame.
    expect(worst).toBeLessThan(3);
    const f = bodyInFrame(after, c, 'moon');
    expect(f.below).toBe(true);
    expect(f.nearLimb).toBeLessThan(0.75 * (FOV / 2));
    expect(c.focusBodyId).toBe('moon');
  });
});
