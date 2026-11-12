/**
 * Cockpit rig (mode 'cockpit', kind 'interior'): the eye sits at the seat named by
 * `VehicleDef.cameras.cockpit` ({ part instance id, seat id }), resolved every frame through the active
 * vessel's part pose (PartSnapshot.localPos/localRot) and the seat of that part's `command` module, so the
 * eye follows the capsule through staging. Mouse look rotates about the seat's up and right axes within
 * limits, starting from the rest pitch (`restPitch`: a couch lies on its back and its windows stand above the
 * couch's own line of sight; request cockpit-18); the wheel narrows / widens the field of view. A small head sway follows the proper acceleration
 * (the head lags behind sudden accelerations and settles back; sustained thrust leaves a few millimetres).
 *
 * Poses come from the snapshot as given (already interpolated to presentation time); positions are float64
 * in the ROOT frame.
 */
import type { DefLibrary, PartDef, VehicleDef } from '@/core/contracts/defs';
import type { CameraInput, CameraState } from '@/core/contracts/render';
import type { PartSnapshot, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { quat, type Quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { activeVessel, approach, lookRotation, type FlightCameraRig } from './cameraMath';

export interface CockpitRigOptions {
  defs: DefLibrary;
  /** Default vertical field of view, rad (70 deg). */
  fovY?: number;
  /** Field-of-view range reachable with the wheel, rad. */
  fovRange?: [number, number];
  /** Look limits: |yaw| and pitch up / down, rad. */
  lookLimits?: { yaw: number; up: number; down: number };
  /**
   * Pitch of the view the seat starts with and `activate` returns to, rad up from the seat's look direction
   * (inside the look limits). Default COCKPIT_REST_PITCH; 0: along the couch's own line of sight, as before.
   */
  restPitch?: number;
  /** Head displacement per m/s^2 of transient proper acceleration, m (0.004), and its cap, m (0.05). */
  swayGain?: number;
  swayMax?: number;
}

/** Seat eye point resolved in the vessel frame. */
export interface SeatPose {
  /** Eye position in VES, m. */
  eyeVes: Vec3;
  /** Seat view -> VES rotation (view looks down -Z with +Y up). */
  qViewToVes: Quat;
}

export function findCockpitSeat(defs: DefLibrary, vessel: VesselSnapshot): { vehicle: VehicleDef; part: PartSnapshot; partDef: PartDef; seat: { pos: [number, number, number]; lookDir: [number, number, number]; upDir: [number, number, number] } } | null {
  const vehicle = defs.vehicles[vessel.vehicleId];
  if (!vehicle || vehicle.cockpit === null) return null;
  const ref = vehicle.cameras.cockpit;
  const part = vessel.parts.find((p) => p.instanceId === ref.part);
  if (!part) return null;
  const partDef = defs.parts[part.def];
  if (!partDef) return null;
  for (const m of partDef.modules) {
    if (m.type !== 'command') continue;
    const seat = m.seats.find((s) => s.id === ref.seat);
    if (seat) return { vehicle, part, partDef, seat };
  }
  return null;
}

/** Eye position and seat orientation in the vessel frame (pure function of the snapshot and defs). */
export function resolveSeatPose(defs: DefLibrary, vessel: VesselSnapshot): SeatPose | null {
  const found = findCockpitSeat(defs, vessel);
  if (!found) return null;
  const { part, seat } = found;
  const eyeVes = v3.add(quat.rotate(part.localRot, v3.fromTuple(seat.pos)), part.localPos);
  const look = quat.rotate(part.localRot, v3.normalize(v3.fromTuple(seat.lookDir)));
  const up = quat.rotate(part.localRot, v3.normalize(v3.fromTuple(seat.upDir)));
  return { eyeVes, qViewToVes: lookRotation(look, up) };
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Rest pitch of the seat's view, rad: the forward windows in the upper third of the frame, the displays in its lower half (request cockpit-18). */
export const COCKPIT_REST_PITCH = 20 * DEG;

export function createCockpitRig(opts: CockpitRigOptions): FlightCameraRig & { readonly lookYaw: number; readonly lookPitch: number } {
  const defs = opts.defs;
  const fovDefault = opts.fovY ?? 70 * DEG;
  const [fovMin, fovMax] = opts.fovRange ?? [25 * DEG, 85 * DEG];
  const limits = opts.lookLimits ?? { yaw: 150 * DEG, up: 75 * DEG, down: 60 * DEG };
  const swayGain = opts.swayGain ?? 0.004;
  const swayMax = opts.swayMax ?? 0.05;
  const restPitch = clamp(opts.restPitch ?? COCKPIT_REST_PITCH, -limits.down, limits.up);

  let lookYaw = 0;
  let lookPitch = restPitch;
  let fov = fovDefault;
  // Head sway: low-passed acceleration (what the body has settled into) and a damped spring on the offset.
  let accSlow: Vec3 | null = null;
  let sway = v3.zero();
  let swayVel = v3.zero();

  const reset = (): void => {
    lookYaw = 0;
    lookPitch = restPitch;
    fov = fovDefault;
    accSlow = null;
    sway = v3.zero();
    swayVel = v3.zero();
  };

  const stepSway = (accel: Vec3, dt: number): void => {
    if (accSlow === null) accSlow = v3.clone(accel);
    if (dt <= 0) return;
    accSlow = v3.lerp(accSlow, accel, approach(dt, 1.2));
    // The head lags behind CHANGES of acceleration (transient), plus a tiny sustained seat compression.
    const transient = v3.sub(accel, accSlow);
    let target = v3.add(v3.scale(transient, -swayGain), v3.scale(accSlow, -swayGain * 0.08));
    const len = v3.len(target);
    if (len > swayMax) target = v3.scale(target, swayMax / len);
    // Critically damped spring, omega = 14 rad/s, integrated in small sub-steps for stability.
    const omega = 14;
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const acc = v3.sub(v3.scale(v3.sub(target, sway), omega * omega), v3.scale(swayVel, 2 * omega));
      swayVel = v3.addScaled(swayVel, acc, h);
      sway = v3.addScaled(sway, swayVel, h);
    }
  };

  return {
    mode: 'cockpit',
    kind: 'interior',
    get lookYaw() {
      return lookYaw;
    },
    get lookPitch() {
      return lookPitch;
    },
    isAvailable: (s) => {
      const v = s.vessels.find((x) => x.id === s.activeVesselId);
      return v !== undefined && resolveSeatPose(defs, v) !== null;
    },
    activate() {
      reset();
    },
    update(s: SimSnapshot, input: CameraInput, realDt: number): CameraState {
      const vessel = activeVessel(s);
      const seat = resolveSeatPose(defs, vessel);
      if (!seat) throw new Error(`cockpit rig: vessel ${vessel.id} (${vessel.vehicleId}) has no cockpit seat; check isAvailable() first`);
      lookYaw = clamp(lookYaw + input.yaw, -limits.yaw, limits.yaw);
      lookPitch = clamp(lookPitch + input.pitch, -limits.down, limits.up);
      if (input.zoom > 0 && Number.isFinite(input.zoom)) fov = clamp(fov * input.zoom, fovMin, fovMax);
      stepSway(vessel.properAccel, realDt);

      // Look: yaw right = negative rotation about view +Y, then pitch up = positive rotation about view +X.
      const qLook = quat.mul(quat.fromAxisAngle(v3.unitY(), -lookYaw), quat.fromAxisAngle(v3.unitX(), lookPitch));
      const qViewToVes = quat.mul(seat.qViewToVes, qLook);
      const eyeVes = v3.add(seat.eyeVes, sway);
      return {
        mode: 'cockpit',
        kind: 'interior',
        positionRoot: v3.add(vessel.rRoot, quat.rotate(vessel.q, eyeVes)),
        qViewToRoot: quat.normalize(quat.mul(vessel.q, qViewToVes)),
        fovY: fov,
        insideVesselId: vessel.id,
        focusVesselId: vessel.id,
        focusBodyId: vessel.bodyId,
        exposureCompensation: 0,
        minEv100: null,
        fillLight: 0,
      };
    },
  };
}
