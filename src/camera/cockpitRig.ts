/**
 * Cockpit rig (mode 'cockpit', kind 'interior'): the eye sits at a seat of the active vessel's command part
 * with a cabin (CraftSnapshot.commandPart / .cockpit; `VehicleDef.cameras.cockpit` for a snapshot without
 * craft), resolved every frame through the part's pose (PartSnapshot.localPos/localRot) and the seat of that
 * part's `command` module, so the eye follows the capsule through staging. Which seat (request cockpit-21):
 * the one the player chose with `cycleSeat` while the active vessel stays the same, else the cockpit
 * layout's `camera.defaultSeat`, else the craft's own camera seat. Mouse look rotates about the seat's up and right axes within
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
import { listSections } from '@/core/defs/loader';
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

/** A seat of a command part (`command.seats` of the part's definition, in the part frame). */
export type CockpitSeat = Extract<PartDef['modules'][number], { type: 'command' }>['seats'][number];

/**
 * The seat the cockpit camera sits in: `seatId` if given (a seat the player chose), else the default one
 * (cockpitDefaultSeatId). null: the vessel has no cabin, or the command part has no such seat.
 */
export function findCockpitSeat(defs: DefLibrary, vessel: VesselSnapshot, seatId: string | null = null): { part: PartSnapshot; partDef: PartDef; seat: CockpitSeat; seatId: string; cockpitId: string } | null {
  const host = cockpitHost(defs, vessel);
  if (!host) return null;
  const id = seatId ?? cockpitDefaultSeatId(defs, host);
  const seat = id === null ? undefined : commandSeats(host.partDef).find((s) => s.id === id);
  return seat ? { part: host.part, partDef: host.partDef, seat, seatId: seat.id, cockpitId: host.cockpitId } : null;
}

/** Where a vessel's cockpit view sits: the command part with the cabin, the cabin's layout id and the craft's own camera seat. */
export interface CockpitHost {
  part: PartSnapshot;
  partDef: PartDef;
  /** Cockpit layout id (`visuals/cockpits/<id>`, the cockpit package's data). */
  cockpitId: string;
  /** The craft's own camera seat (CraftSnapshot.cockpit.cameraSeat, or the vehicle's `cameras.cockpit.seat`). */
  cameraSeat: string | null;
}

const commandSeats = (partDef: PartDef): CockpitSeat[] => {
  for (const m of partDef.modules) if (m.type === 'command') return m.seats;
  return [];
};

/**
 * The command part the cockpit camera sits in. A snapshot with craft names it itself (CraftSnapshot.commandPart
 * and .cockpit: the craft at the helm first, then the vessel's other craft with a cabin); one without (hand-built,
 * before the snapshot's tighten step) is resolved through the vehicle's authoring fields as before.
 */
export function cockpitHost(defs: DefLibrary, vessel: VesselSnapshot): CockpitHost | null {
  const crafts = vessel.crafts ?? [];
  const helm = vessel.helm?.craftId;
  for (const craft of [...crafts.filter((c) => c.id === helm), ...crafts.filter((c) => c.id !== helm)]) {
    const cabin = craft.cockpit;
    if (!cabin || cabin.id === null || craft.commandPart === null) continue;
    const part = vessel.parts.find((p) => p.instanceId === craft.commandPart && (p.craftId === undefined || p.craftId === craft.id));
    const partDef = part ? defs.parts[part.def] : undefined;
    if (part && partDef) return { part, partDef, cockpitId: cabin.id, cameraSeat: cabin.cameraSeat };
  }
  const vehicle: VehicleDef | undefined = defs.vehicles[vessel.vehicleId];
  if (!vehicle || vehicle.cockpit === null) return null;
  const ref = vehicle.cameras.cockpit;
  const part = vessel.parts.find((p) => p.instanceId === ref.part);
  const partDef = part ? defs.parts[part.def] : undefined;
  return part && partDef ? { part, partDef, cockpitId: vehicle.cockpit, cameraSeat: ref.seat } : null;
}

/** What the rig reads of a cockpit layout section (`visuals/cockpits/<id>`; the cockpit package owns and validates it). */
interface CockpitLayoutSeats {
  camera?: { defaultSeat?: string };
  mouldLine?: string;
}

const layoutOf = (defs: DefLibrary, host: CockpitHost): CockpitLayoutSeats | undefined => listSections<CockpitLayoutSeats>(defs, 'visuals/cockpits/')[host.cockpitId];

/**
 * The seat the view starts in (request cockpit-21): the cockpit layout's `camera.defaultSeat` (presentation
 * data: which couch the player's eye is at), or the craft's own camera seat when the layout names none.
 */
export function cockpitDefaultSeatId(defs: DefLibrary, host: CockpitHost): string | null {
  return layoutOf(defs, host)?.camera?.defaultSeat ?? host.cameraSeat;
}

/**
 * The seats a player can sit in, in the order `cycleSeat` steps through them: the command part's own seats,
 * in the order of the layout's mould line where it lists them (cdr, plt, ms for the Kestrel).
 */
export function cockpitSeatOrder(defs: DefLibrary, host: CockpitHost): string[] {
  const own = commandSeats(host.partDef).map((s) => s.id);
  const mouldLine = layoutOf(defs, host)?.mouldLine;
  const listed = mouldLine !== undefined && mouldLine in defs.sections ? ((defs.sections[mouldLine] as { seats?: { id: string }[] }).seats ?? []).map((s) => s.id) : [];
  return [...listed.filter((id) => own.includes(id)), ...own.filter((id) => !listed.includes(id))];
}

/** Eye position and seat orientation in the vessel frame (pure function of the snapshot and defs). `seatId`: a seat other than the default. */
export function resolveSeatPose(defs: DefLibrary, vessel: VesselSnapshot, seatId: string | null = null): SeatPose | null {
  const found = findCockpitSeat(defs, vessel, seatId);
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

/** The cockpit rig: the flight camera rig, its look angles, the seat it sits in and the step to the next one. */
export interface CockpitRig extends FlightCameraRig {
  readonly lookYaw: number;
  readonly lookPitch: number;
  /** The seat the eye was at in the last `update` (null before the first one). */
  readonly seatId: string | null;
  /**
   * Step to the next seat of the active vessel's cabin (cockpitSeatOrder, wrapping round) and return the look
   * to the rest view; the choice holds while the active vessel stays the same. Returns the new seat's id,
   * or null if the rig has not seen a vessel with a cabin yet.
   */
  cycleSeat(): string | null;
}

export function createCockpitRig(opts: CockpitRigOptions): CockpitRig {
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
  // The seat the player chose, and the vessel it was chosen in (another vessel starts at its default again).
  let chosenSeat: string | null = null;
  let chosenFor: string | null = null;
  let seen: VesselSnapshot | null = null;
  let seatNow: string | null = null;
  const chosenIn = (vessel: VesselSnapshot): string | null => (chosenFor === vessel.id ? chosenSeat : null);
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
    get seatId() {
      return seatNow;
    },
    isAvailable: (s) => {
      const v = s.vessels.find((x) => x.id === s.activeVesselId);
      return v !== undefined && (resolveSeatPose(defs, v, chosenIn(v)) ?? resolveSeatPose(defs, v)) !== null;
    },
    activate() {
      reset();
    },
    cycleSeat() {
      const host = seen ? cockpitHost(defs, seen) : null;
      if (!seen || !host) return null;
      const order = cockpitSeatOrder(defs, host);
      if (order.length === 0) return null;
      const current = chosenIn(seen) ?? cockpitDefaultSeatId(defs, host);
      chosenSeat = order[(order.indexOf(current ?? '') + 1) % order.length]!;
      chosenFor = seen.id;
      lookYaw = 0;
      lookPitch = restPitch;
      return chosenSeat;
    },
    update(s: SimSnapshot, input: CameraInput, realDt: number): CameraState {
      const vessel = activeVessel(s);
      seen = vessel;
      // A chosen seat the command part no longer has (another craft at the helm) gives way to the default.
      const found = findCockpitSeat(defs, vessel, chosenIn(vessel)) ?? findCockpitSeat(defs, vessel);
      const seat = found ? resolveSeatPose(defs, vessel, found.seatId) : null;
      if (!found || !seat) throw new Error(`cockpit rig: vessel ${vessel.id} (${vessel.vehicleId}) has no cockpit seat; check isAvailable() first`);
      seatNow = found.seatId;
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
