/**
 * The generic ascent pilot (fleet-data scope D; the base of bots): flies ANY vehicle from a pad into a low orbit
 * of 185-250 km using only the vehicle's capabilities (data) and the snapshot, staging by hand through
 * PlayerCommands, as a player does.
 *
 *   'pad'         throttle up, SAS on, fire the first stage (ignition; the clamps let go when the thrust is enough)
 *   'vertical'    straight up until clear of the pad
 *   'turn'        the lift-off stage flies a pitch programme by height (the mission pilot's nominal programme)
 *                 along the horizontal velocity, never more than a couple of degrees off the airflow while the
 *                 dynamic pressure is high, the throttle held under `maxG`
 *   'upper'       every later stage flies closed loop: the pitch that brings the vertical speed to the climb that
 *                 reaches the target altitude (ascentSinPitch), until the periapsis is up
 *   'orbit'       engines off; optionally fire the next separation (the payload leaves the launcher) and watch
 *                 it go; done
 * Staging: a stage that burns out (no thrust some seconds after it was lit) is followed by the next one; a stage
 * the capabilities show without delta-v (a fairing, a tower, a nose cap) is fired early, once the air is thin.
 */
import type { VehicleCapabilities } from '@/core/contracts/vehicle';
import { v3 } from '@/core/math/vec3';
import { ascentSinPitch, NOMINAL_PITCH_PROGRAMME, programmePitch } from '../guidance';
import { above, deg, GenericPilot, horizontalOf } from './common';

export interface AscentOptions {
  /** Altitude the trajectory is steered to, m (default 205 km). */
  targetAltitude?: number;
  /** Engines off once the periapsis is at least this, m (default 185 km). */
  cutoffPeriapsis?: number;
  /** Largest acceleration flown, in g (default 4). */
  maxG?: number;
  /** In orbit, fire the next stage when it is a separation without delta-v of its own or the payload's first burn (default false). */
  separateInOrbit?: boolean;
  /** Seconds to watch after the separation in orbit (default 35). */
  watchAfterSeparation?: number;
  /**
   * Lift off from the ground of an airless body with the engines that are lit (nothing to stage first): straight
   * up, then the closed loop at once (default false: a pad start through the atmosphere).
   */
  fromSurface?: boolean;
}

/** A stage is burnt out when there is no thrust this long after it was fired (its engines light after their delays). */
const BURNOUT_GRACE = 7;
/** Pure jettisons wait for thin air: dynamic pressure under this (Pa) and above this altitude (m). */
const JETTISON_Q = 400;
const JETTISON_ALTITUDE = 55000;
/** Above this dynamic pressure (Pa) the nose stays within MAX_AOA of the airflow. */
const HIGH_Q = 6000;
const MAX_AOA = deg(2);
/** From the ground of an airless body: straight up this high (m) before the closed loop steers. */
const SURFACE_CLEAR_HEIGHT = 150;

export class AscentPilot extends GenericPilot {
  private h0 = 0;
  private readonly targetAltitude: number;
  private readonly cutoffPeriapsis: number;
  private readonly maxG: number;
  private readonly separateInOrbit: boolean;
  private readonly watch: number;
  private readonly fromSurface: boolean;
  /** The highest dynamic pressure seen, Pa, and the largest q x angle of attack, Pa rad. */
  maxQ = 0;
  maxQAlpha = 0;
  /** Stage indices fired, with the time. */
  readonly firings: { stage: number; ut: number; label: string }[] = [];
  orbitUt: number | null = null;
  separationUt: number | null = null;

  constructor(caps: VehicleCapabilities, options: AscentOptions = {}) {
    super(caps);
    this.targetAltitude = options.targetAltitude ?? 205000;
    this.cutoffPeriapsis = options.cutoffPeriapsis ?? 185000;
    this.maxG = options.maxG ?? 4;
    this.separateInOrbit = options.separateInOrbit ?? false;
    this.watch = options.watchAfterSeparation ?? 35;
    this.fromSurface = options.fromSurface ?? false;
  }

  protected start(): void {
    this.h0 = this.rd.altitudeAsl;
    // The stack may start part fired (a scenario's stagesAlreadyFired): the next stage is the craft's.
    this.staged = (this.v.crafts.find((c) => c.id === this.v.helm.craftId) ?? this.v.crafts[0])?.staging.nextStage ?? 0;
    if (this.fromSurface) this.go('vertical', 120);
    else this.go('pad', 60);
  }

  private stage(why: string): boolean {
    const i = this.staged;
    const ok = this.fireStage(why);
    if (ok) this.firings.push({ stage: i, ut: this.ut, label: this.stageCap(i)?.label ?? '' });
    return ok;
  }

  /** True when the next stage is a jettison (no delta-v of its own) with more stages after it. */
  private nextIsJettison(): boolean {
    const next = this.stageCap(this.staged);
    return next !== null && next.deltaVVac === 0 && this.stageCap(this.staged + 1) !== null;
  }

  private burntOut(): boolean {
    return this.sinceStaging > BURNOUT_GRACE && this.rd.thrust <= 0;
  }

  /** The next stage that makes thrust (index), or -1. */
  private nextPropulsive(): number {
    for (let i = this.staged; i < this.caps.stages.length; i++) if (this.caps.stages[i]!.deltaVVac > 0) return i;
    return -1;
  }

  protected tick(): void {
    const q = this.rd.dynamicPressure;
    this.maxQ = Math.max(this.maxQ, q);
    this.maxQAlpha = Math.max(this.maxQAlpha, q * Math.abs(this.rd.angleOfAttack));
    const { up } = this.horizon();
    const heading = horizontalOf(this.v.v, up, this.horizon().east);
    switch (this.phase) {
      case 'pad': {
        this.ensureSas(true);
        this.out.throttle = 1;
        if (this.staged === 0) this.stage('lift-off');
        this.pointAt(up, { dorsal: above(Math.PI / 2 + Math.PI / 2, heading, up) });
        if (this.v.situation !== 'prelaunch') this.go('vertical', 120);
        return;
      }
      case 'vertical': {
        this.out.throttle = this.limitedLever(this.maxG);
        this.pointAt(up, { dorsal: v3.neg(heading) });
        if (this.fromSurface) {
          this.out.throttle = 1;
          if (this.rd.altitudeAsl - this.h0 > SURFACE_CLEAR_HEIGHT) this.go('upper', 1800);
        } else if (this.rd.altitudeAsl - this.h0 > NOMINAL_PITCH_PROGRAMME.startHeight && this.rd.verticalSpeed > 20) this.go('turn', 600);
        return;
      }
      case 'turn': {
        this.out.throttle = this.limitedLever(this.maxG);
        const pitch = programmePitch(NOMINAL_PITCH_PROGRAMME, this.rd.altitudeAsl - this.h0);
        let dir = above(pitch, heading, up);
        if (q > HIGH_Q) dir = this.withinAirflow(dir);
        this.pointAt(dir, { dorsal: above(pitch + Math.PI / 2, heading, up) });
        if (this.nextIsJettison() && q < JETTISON_Q && this.rd.altitudeAsl > JETTISON_ALTITUDE) this.stage('jettison in thin air');
        else if (this.burntOut()) {
          if (this.nextPropulsive() < 0) return this.fail('the lift-off stage burnt out and no stage makes thrust');
          this.out.throttle = 0;
          this.stage('burn-out');
          this.go('upper', 1800);
        }
        return;
      }
      case 'upper': {
        this.upper(heading, up);
        return;
      }
      case 'orbit': {
        this.out.throttle = 0;
        this.ensureSas(true);
        if (this.separationUt !== null) {
          if (this.ut - this.separationUt >= this.watch) this.finish('separated and watched');
          return;
        }
        if (this.separateInOrbit && this.stageCap(this.staged) !== null && this.phaseTime > 3) {
          if (this.stage('separation in orbit')) this.separationUt = this.ut;
          return;
        }
        if (!this.separateInOrbit) this.finish(`in orbit: periapsis ${(this.rd.periapsisAltitude / 1000).toFixed(1)} km, apoapsis ${(this.rd.apoapsisAltitude / 1000).toFixed(1)} km`);
        return;
      }
    }
  }

  /** The nose no further than MAX_AOA from the airflow. */
  private withinAirflow(dir: ReturnType<typeof above>): ReturnType<typeof above> {
    const air = this.surfaceVelocity();
    if (v3.len(air) < 50) return dir;
    const pro = v3.normalize(air);
    const angle = v3.angle(dir, pro);
    if (angle <= MAX_AOA) return dir;
    const axis = v3.normalize(v3.reject(dir, pro));
    return v3.normalize(v3.add(v3.scale(pro, Math.cos(MAX_AOA)), v3.scale(axis, Math.sin(MAX_AOA))));
  }

  private upper(heading: ReturnType<typeof above>, up: ReturnType<typeof above>): void {
    if (this.rd.periapsisAltitude >= this.cutoffPeriapsis) {
      this.out.throttle = 0;
      this.orbitUt = this.ut;
      this.go('orbit', 600, `orbit: periapsis ${(this.rd.periapsisAltitude / 1000).toFixed(1)} km, apoapsis ${(this.rd.apoapsisAltitude / 1000).toFixed(1)} km`);
      return;
    }
    const q = this.rd.dynamicPressure;
    const r = v3.len(this.v.r);
    const mu = this.muOfBody();
    const sinPitch = ascentSinPitch({ mu, r, h: this.rd.altitudeAsl, hTarget: this.targetAltitude, vr: this.rd.verticalSpeed, vh: this.rd.horizontalSpeed, thrustAccel: this.thrustAccel(), tauH: 90, tauV: 12, vrMin: -60, vrMax: 450, sinMin: -0.3, sinMax: 0.92 });
    let dir = above(Math.asin(sinPitch), heading, up);
    if (q > HIGH_Q) dir = this.withinAirflow(dir);
    this.pointAt(dir, { dorsal: above(Math.asin(sinPitch) + Math.PI / 2, heading, up) });
    // Close to the orbit, gently: the periapsis rises fast at orbital speed.
    const short = this.cutoffPeriapsis - this.rd.periapsisAltitude;
    const near = this.rd.altitudeAsl > 0.6 * this.targetAltitude && short < 60000 ? Math.max(0.25, short / 60000) : 1;
    this.out.throttle = Math.min(this.limitedLever(this.maxG), near);
    if (this.nextIsJettison() && q < JETTISON_Q && this.rd.altitudeAsl > JETTISON_ALTITUDE) {
      this.stage('jettison in thin air');
      return;
    }
    if (this.burntOut()) {
      if (this.nextPropulsive() < 0) return this.fail(`out of stages before orbit (periapsis ${(this.rd.periapsisAltitude / 1000).toFixed(1)} km)`);
      this.out.throttle = 0;
      this.stage('burn-out');
    }
  }

  /** The SOI body's gravitational parameter: the conic of the vessel's current trajectory carries it. */
  private muOfBody(): number {
    const patch = this.s.patches.current[0];
    if (!patch) {
      this.fail('the snapshot has no current trajectory');
      return 0;
    }
    return patch.conic.mu;
  }
}

export function createAscentPilot(caps: VehicleCapabilities, options: AscentOptions = {}): AscentPilot {
  return new AscentPilot(caps, options);
}
