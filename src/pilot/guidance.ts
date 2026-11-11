/**
 * Guidance laws of the mission pilot as pure functions of what the pilot reads from the snapshot
 * (docs/research/sim-design.md 16.2). The pilot turns their output into stick and throttle.
 */
import { v3, type Vec3 } from '@/core/math/vec3';
import { clamp } from './math';

const DEG = Math.PI / 180;

/** Pitch programme of the first stage: pitch above the horizon (rad) at height `h` above the pad. */
export interface PitchProgramme {
  /** Height at which the turn starts, m. */
  startHeight: number;
  /** Height scale of the turn, m. */
  scaleHeight: number;
  exponent: number;
  /** Degrees turned over the programme and the lowest pitch flown, degrees. */
  turnDeg: number;
  floorDeg: number;
  /** Heading error flown on purpose (perturbed runs), degrees. */
  headingBiasDeg: number;
}

export const NOMINAL_PITCH_PROGRAMME: PitchProgramme = { startHeight: 800, scaleHeight: 65000, exponent: 0.6, turnDeg: 68, floorDeg: 22, headingBiasDeg: 0 };
/** A deliberately poor programme: late, steep start, too flat at the end, and off the azimuth. */
export const SLOPPY_PITCH_PROGRAMME: PitchProgramme = { startHeight: 1500, scaleHeight: 52000, exponent: 0.5, turnDeg: 74, floorDeg: 16, headingBiasDeg: 2.5 };

export function programmePitch(p: PitchProgramme, h: number): number {
  if (h <= p.startHeight) return 90 * DEG;
  return Math.max(p.floorDeg, 90 - p.turnDeg * Math.pow((h - p.startHeight) / p.scaleHeight, p.exponent)) * DEG;
}

/**
 * Closed-loop pitch of an upper stage toward a target altitude: the vertical acceleration that brings the
 * vertical speed to (hTarget - h) / tauH, plus what gravity still needs beyond the centrifugal relief.
 * Returns the sine of the thrust elevation.
 */
export function ascentSinPitch(input: {
  mu: number;
  r: number;
  h: number;
  hTarget: number;
  vr: number;
  vh: number;
  thrustAccel: number;
  tauH: number;
  tauV: number;
  vrMin: number;
  vrMax: number;
  sinMin: number;
  sinMax: number;
}): number {
  const vrDes = clamp((input.hTarget - input.h) / input.tauH, input.vrMin, input.vrMax);
  const aV = (vrDes - input.vr) / input.tauV + (input.mu / (input.r * input.r) - (input.vh * input.vh) / input.r);
  if (!(input.thrustAccel > 0)) return input.sinMax;
  return clamp(aV / input.thrustAccel, input.sinMin, input.sinMax);
}

export interface LandingState {
  /** Horizontal distance to the target along the surface, m; unit vectors toward it, to its left, and up (inertial axes). */
  range: number;
  toTarget: Vec3;
  left: Vec3;
  up: Vec3;
  /** Surface-relative velocity components along those axes, m/s. */
  vAlong: number;
  vLeft: number;
  vUp: number;
  /** Height above the ground at the target (lowest point of the vehicle), m. */
  height: number;
  /** Local gravity and distance from the body centre. */
  gravity: number;
  radius: number;
}

export interface LandingCommand {
  /** Wanted thrust acceleration, inertial axes, m/s^2. */
  accel: Vec3;
  /** Time to go of the profile, s. */
  tgo: number;
}

/**
 * Braking guidance: an acceleration that is linear in time and arrives over the target at `gateHeight`
 * with the vertical speed `gateSink` and no horizontal speed (the "E-guidance" law). With the time to go
 * taken as 2 x range / closing speed, the horizontal part is the constant deceleration v^2 / (2 range).
 */
export function brakingGuidance(s: LandingState, gateHeight: number, gateSink: number): LandingCommand {
  const tgo = clamp((2 * s.range) / Math.max(s.vAlong, 1), 6, 4000);
  const ax = (6 * s.range) / (tgo * tgo) - (4 * s.vAlong) / tgo;
  const ay = (-4 * s.vLeft) / tgo;
  const az = (6 * (gateHeight - s.height)) / (tgo * tgo) - (4 * s.vUp + 2 * gateSink) / tgo;
  const gEff = s.gravity - (s.vAlong * s.vAlong + s.vLeft * s.vLeft) / s.radius;
  let up = az + gEff;
  const horiz = Math.hypot(ax, ay);
  // Never spend thrust pushing down hard: at most a shallow dip below the horizon.
  if (up < -0.2 * horiz) up = -0.2 * horiz;
  const accel = v3.add(v3.add(v3.scale(s.toTarget, ax), v3.scale(s.left, ay)), v3.scale(s.up, up));
  return { accel, tgo };
}

/**
 * Approach and terminal descent: horizontal velocity command toward the target (or zero), a sink rate
 * that depends on the height, and the thrust acceleration that follows from both.
 */
export function hoverGuidance(
  s: LandingState,
  opts: { nullPosition: boolean; positionGain: number; maxSpeed: number; velocityGain: number; maxTiltDeg: number; sink: number; sinkGain: number },
): LandingCommand {
  let wantAlong = 0;
  if (opts.nullPosition) wantAlong = Math.min(opts.maxSpeed, s.range * opts.positionGain);
  let ax = (wantAlong - s.vAlong) * opts.velocityGain;
  let ay = -s.vLeft * opts.velocityGain;
  const up = Math.max(0.1 * s.gravity, s.gravity + (opts.sink - s.vUp) * opts.sinkGain);
  const maxHoriz = up * Math.tan(opts.maxTiltDeg * DEG);
  const horiz = Math.hypot(ax, ay);
  if (horiz > maxHoriz) {
    ax *= maxHoriz / horiz;
    ay *= maxHoriz / horiz;
  }
  const accel = v3.add(v3.add(v3.scale(s.toTarget, ax), v3.scale(s.left, ay)), v3.scale(s.up, up));
  return { accel, tgo: 0 };
}

/** Lift-vector rule of the entry (sim-design 16.2, phase 15): lift down while a skip-out threatens, else lift up. */
export function entryLiftUp(verticalSpeed: number, speed: number): boolean {
  if (verticalSpeed > 0 && speed > 7600) return false;
  if (verticalSpeed > -150 && speed > 7900) return false;
  return true;
}
