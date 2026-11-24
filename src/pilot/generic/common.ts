/**
 * Shared machinery of the generic pilots (the base of bots): a pilot that flies ANY vehicle from what a player
 * has, the snapshot and the vehicle's capabilities as data (`VehicleCapabilities` of contracts/vehicle.ts,
 * computed by analyzeVehicle and handed over), acting only through PlayerCommands and the stick and throttle.
 * It never reads the definition library or the simulation: what it knows of the vehicle is the capabilities,
 * what it knows of the flight is the snapshot.
 *
 * Here: the phase machine, the active vessel and its body, the local horizon, stick steering by hand
 * (AttitudeController of src/pilot/attitude.ts), staging by hand with the pilot's own count of the stages
 * fired, and a throttle that keeps the acceleration under a limit.
 */
import type { ControlInputs, Pilot, PlayerCommands, SasMode } from '@/core/contracts/controls';
import { MAX_PHYSICS_WARP_INDEX } from '@/core/contracts/defs';
import type { BodySnapshot, Readouts, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { StageCapability, VehicleCapabilities } from '@/core/contracts/vehicle';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { AttitudeController, type AttitudeOptions } from '../attitude';

export const G0 = 9.80665;
const DEG = Math.PI / 180;

export interface PilotNote {
  ut: number;
  met: number;
  phase: string;
  note: string;
}

const neutral = (): ControlInputs => ({ pitch: 0, yaw: 0, roll: 0, translate: { x: 0, y: 0, z: 0 }, throttle: 0 });

/** The local horizon at a position: east, north and up (unit, the frame of `r`), from the body's pole. */
export function horizon(r: Vec3, pole: Vec3): { east: Vec3; north: Vec3; up: Vec3 } {
  const up = v3.normalize(r);
  let east = v3.cross(pole, up);
  east = v3.len(east) > 1e-9 ? v3.normalize(east) : v3.anyOrthogonal(up);
  return { east, north: v3.cross(up, east), up };
}

/** A direction at `pitch` above the horizon toward the horizontal unit direction `heading` (rad). */
export function above(pitch: number, heading: Vec3, up: Vec3): Vec3 {
  return v3.normalize(v3.add(v3.scale(heading, Math.cos(pitch)), v3.scale(up, Math.sin(pitch))));
}

/** The horizontal part of `v` as a unit vector (or `fallback` when it has none). */
export function horizontalOf(v: Vec3, up: Vec3, fallback: Vec3): Vec3 {
  const h = v3.reject(v, up);
  return v3.len(h) > 1e-6 ? v3.normalize(h) : fallback;
}

/**
 * Base of a generic pilot: the phase machine and the instruments. A subclass implements `start` and `tick`;
 * it reads `this.v` (the active vessel), `this.rd` (the read-outs), `this.body` (its SOI body), and writes
 * `this.out` (the stick and the throttle).
 */
export abstract class GenericPilot implements Pilot {
  phase = 'init';
  done = false;
  failure: string | null = null;
  readonly log: PilotNote[] = [];
  onLog: ((n: PilotNote) => void) | null = null;

  protected s!: SimSnapshot;
  protected cmd!: PlayerCommands;
  protected dt = 0;
  protected v!: VesselSnapshot;
  protected rd!: Readouts;
  protected body!: BodySnapshot;
  protected out: ControlInputs = neutral();
  protected readonly attitude = new AttitudeController();
  protected phaseStart = 0;
  protected phaseTimeout = Infinity;
  /** Stages this pilot has fired (index of the next stage of the capabilities). */
  protected staged = 0;
  protected lastStageUt = -Infinity;
  protected lever = 1;

  constructor(protected readonly caps: VehicleCapabilities) {}

  update(snapshot: SimSnapshot, commands: PlayerCommands, dt: number): ControlInputs {
    this.s = snapshot;
    this.cmd = commands;
    this.dt = dt;
    this.rd = snapshot.readouts;
    this.out = neutral();
    if (this.done || this.failure !== null) return this.out;
    const v = snapshot.vessels.find((x) => x.id === snapshot.activeVesselId);
    if (!v) {
      this.fail('the active vessel is gone');
      return this.out;
    }
    this.v = v;
    const body = snapshot.bodies.find((b) => b.id === v.bodyId);
    if (!body) {
      this.fail(`no body "${v.bodyId}" in the snapshot`);
      return this.out;
    }
    this.body = body;
    if (this.phase === 'init') {
      this.phaseStart = snapshot.simUt;
      this.start();
    }
    if (snapshot.simUt - this.phaseStart > this.phaseTimeout) {
      this.fail(`phase "${this.phase}" timed out after ${this.phaseTimeout.toFixed(0)} s`);
      return neutral();
    }
    this.tick();
    return this.failure !== null ? neutral() : this.out;
  }

  protected abstract start(): void;
  protected abstract tick(): void;

  protected get ut(): number {
    return this.s.simUt;
  }

  protected get phaseTime(): number {
    return this.s.simUt - this.phaseStart;
  }

  protected note(text: string): void {
    const n: PilotNote = { ut: this.s.simUt, met: this.rd.met, phase: this.phase, note: text };
    this.log.push(n);
    this.onLog?.(n);
  }

  protected go(phase: string, timeout = Infinity, note = ''): void {
    this.phase = phase;
    this.phaseStart = this.s.simUt;
    this.phaseTimeout = timeout;
    this.attitude.pause();
    this.note(note === '' ? 'enter' : note);
  }

  protected fail(reason: string): void {
    if (this.failure !== null) return;
    this.failure = `${this.phase}: ${reason}`;
    this.note(`FAILURE ${reason}`);
  }

  protected finish(note: string): void {
    this.note(note);
    this.done = true;
  }

  // ----------------------------------------------------------------------------------------- frame

  /** Pole of the SOI body (ROOT axes). */
  protected pole(): Vec3 {
    return quat.rotate(this.body.qFixedToRoot, { x: 0, y: 0, z: 1 });
  }

  protected horizon(): { east: Vec3; north: Vec3; up: Vec3 } {
    return horizon(this.v.r, this.pole());
  }

  /** Velocity relative to the air (the body's rotating frame), ROOT axes. */
  protected surfaceVelocity(): Vec3 {
    return v3.sub(this.v.v, v3.cross(this.body.spinRoot, this.v.r));
  }

  protected nose(): Vec3 {
    return quat.rotate(this.v.q, { x: 0, y: 1, z: 0 });
  }

  /** Acceleration the engines give now, m/s^2 (read-outs). */
  protected thrustAccel(): number {
    return this.rd.mass > 0 ? this.rd.thrust / this.rd.mass : 0;
  }

  // --------------------------------------------------------------------------------------- controls

  /** Fly the nose to `dir` (ROOT axes) by hand; returns the pointing error, rad. */
  protected pointAt(dir: Vec3, opts: AttitudeOptions = {}): number {
    const c = this.attitude.update(this.v.q, this.v.w, dir, this.dt, opts);
    this.out.pitch = c.pitch;
    this.out.yaw = c.yaw;
    this.out.roll = c.roll;
    return c.error;
  }

  protected ensureSas(on: boolean, mode: SasMode = 'stability'): void {
    if (this.rd.sasEnabled !== on) this.cmd.setSasEnabled(on);
    if (on && this.rd.sasMode !== mode && this.rd.sasModesAvailable.includes(mode)) this.cmd.setSasMode(mode);
  }

  protected ensureRcs(on: boolean): void {
    if (this.rd.rcsEnabled !== on) this.cmd.setRcsEnabled(on);
  }

  protected setWarp(index: number): void {
    if (this.s.warp.index !== index) this.cmd.setWarpLevel(Math.min(index, Math.max(this.s.warp.maxIndex, MAX_PHYSICS_WARP_INDEX)));
  }

  /** Throttle lever that keeps the acceleration at or under `limitG` (a slow integrator on the g load). */
  protected limitedLever(limitG: number): number {
    const over = this.rd.gLoad - limitG;
    this.lever = Math.max(0.05, Math.min(1, this.lever - over * 0.6 * this.dt));
    return this.lever;
  }

  // ----------------------------------------------------------------------------------------- stages

  /** The capability of stage `i` (the stack as the hangar shows it), or null past the end. */
  protected stageCap(i: number): StageCapability | null {
    return this.caps.stages[i] ?? null;
  }

  /** Whether the stage stack takes a press now (the craft at the helm is not in its staging lockout). */
  protected canStage(): boolean {
    const helm = this.v.crafts.find((c) => c.id === this.v.helm.craftId) ?? this.v.crafts[0];
    return helm !== undefined && !helm.staging.lockout;
  }

  /** Fire the next stage of the stack (the player's Space); false while the stack is locked out or when refused. */
  protected fireStage(why: string): boolean {
    if (!this.canStage()) return false;
    const r = this.cmd.stage();
    if (!r.ok) {
      this.note(`stage ${this.staged} refused: ${r.reason ?? 'no reason'}`);
      return false;
    }
    this.note(`stage ${this.staged} (${this.stageCap(this.staged)?.label ?? '?'}): ${why}`);
    this.staged++;
    this.lastStageUt = this.ut;
    this.attitude.reset();
    return true;
  }

  /** Seconds since this pilot last fired a stage. */
  protected get sinceStaging(): number {
    return this.ut - this.lastStageUt;
  }
}

export const deg = (x: number): number => x * DEG;
