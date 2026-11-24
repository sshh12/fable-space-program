/**
 * Test drivers of the fleet's acceptance flights beyond the ascent: what a player does with the stick, the
 * throttle, SAS and the stage key, from the snapshot and the vehicle's capabilities only (they are pilots of
 * the generic kind, written for these flights).
 *
 *   EntryPilot      the Kestrel LF from low orbit: de-orbit burn, service module off, entry heat shield first,
 *                   drogues, mains, splashdown
 *   LanderPilot     the Egret from low lunar orbit: brake, descent on a stopping-distance law, legs, touchdown;
 *                   then the generic ascent pilot (fromSurface) back to orbit
 *   DeparturePilot  the Albatross from low Earth orbit: the whole tank in one prograde burn at physics warp 4x
 */
import type { VehicleCapabilities } from '@/core/contracts/vehicle';
import { MAX_PHYSICS_WARP_INDEX } from '@/core/contracts/defs';
import { v3 } from '@/core/math/vec3';
import { AscentPilot, type AscentOptions } from '@/pilot/generic/ascent';
import { G0, GenericPilot } from '@/pilot/generic/common';

/** The Kestrel LF home from low orbit. */
export class EntryPilot extends GenericPilot {
  splashUt: number | null = null;
  /** Speed over the water just before the splash, m/s. */
  splashSpeed = 0;
  /** Periapsis the de-orbit burn aims at, m. */
  constructor(caps: VehicleCapabilities, private readonly entryPeriapsis = 40000) {
    super(caps);
  }

  protected start(): void {
    this.staged = this.v.crafts[0]!.staging.nextStage;
    this.go('align', 300);
  }

  protected tick(): void {
    switch (this.phase) {
      case 'align': {
        this.ensureSas(true, 'retrograde');
        if (this.phaseTime > 40) this.go('deorbit', 900);
        return;
      }
      case 'deorbit': {
        this.ensureSas(true, 'retrograde');
        this.out.throttle = this.rd.periapsisAltitude > this.entryPeriapsis + 20000 ? 1 : 0.3;
        if (this.rd.periapsisAltitude <= this.entryPeriapsis) {
          this.out.throttle = 0;
          this.go('coast', 4000, `periapsis ${(this.rd.periapsisAltitude / 1000).toFixed(1)} km`);
        }
        return;
      }
      case 'coast': {
        this.ensureSas(true, 'retrograde');
        if (this.rd.altitudeAsl < 140000 && this.canStage()) {
          this.fireStage('service module off before the air');
          this.go('entry', 1800);
        }
        return;
      }
      case 'entry': {
        this.ensureSas(true, 'retrograde');
        this.ensureRcs(true);
        if (this.rd.altitudeAsl < 9000 && this.rd.speedSurface < 260 && this.canStage()) {
          this.fireStage('drogues');
          this.go('drogues', 900);
        }
        return;
      }
      case 'drogues': {
        if (this.rd.altitudeAsl < 3500 && this.rd.speedSurface < 95 && this.canStage()) {
          this.fireStage('mains');
          this.go('mains', 900);
        }
        return;
      }
      case 'mains': {
        if (this.v.situation === 'splashed') {
          this.splashUt ??= this.ut;
          if (this.ut - this.splashUt > 8) this.finish(`splashed down at ${this.splashSpeed.toFixed(1)} m/s`);
        } else this.splashSpeed = this.rd.speedSurface;
        return;
      }
    }
  }
}

/** The Egret from low lunar orbit to the surface; then back to orbit with the generic ascent pilot. */
export class LanderPilot extends GenericPilot {
  ascent: AscentPilot | null = null;
  /** Log the descent every 2 s below 6 km (for tuning). */
  trace = false;
  private lastTrace = -1;
  touchdownSpeed: number | null = null;
  landedUt: number | null = null;
  private legs = false;

  constructor(caps: VehicleCapabilities, private readonly ascentOptions: AscentOptions) {
    super(caps);
  }

  protected start(): void {
    this.staged = this.v.crafts[0]!.staging.nextStage;
    this.go('brake', 1200);
  }

  /** Gravity at the vessel from the conic of its trajectory, m/s^2. */
  private gravity(): number {
    const mu = this.s.patches.current[0]?.conic.mu ?? 0;
    const r = v3.len(this.v.r);
    return mu / (r * r);
  }

  protected tick(): void {
    const { up } = this.horizon();
    const vSurf = this.surfaceVelocity();
    const vh = v3.len(v3.reject(vSurf, up));
    const vz = v3.dot(vSurf, up);
    const h = this.rd.altitudeRadar;
    const g = this.gravity();
    switch (this.phase) {
      case 'brake': {
        // Kill the horizontal speed against the motion; let the vessel fall.
        this.ensureSas(false);
        const dir = v3.len(vSurf) > 1 ? v3.normalize(v3.neg(vSurf)) : up;
        const err = this.pointAt(vh > 30 ? v3.normalize(v3.add(v3.normalize(v3.neg(v3.reject(vSurf, up))), v3.scale(up, 0.15))) : dir);
        this.out.throttle = err < 0.1 ? 1 : 0;
        if (vh < 25) this.go('descent', 1200, `horizontal speed ${vh.toFixed(1)} m/s at ${(h / 1000).toFixed(1)} km`);
        return;
      }
      case 'descent': {
        // Thrust along the residual surface velocity's opposite, mostly up; the vertical speed follows a
        // stopping-distance law with 40 % of the available deceleration kept in reserve.
        const accel = this.thrustAccelMax();
        const margin = Math.max(0.5, 0.5 * (accel - g));
        // Near the ground the sink rate also falls linearly with height, to 1.5 m/s at the feet.
        const want = -Math.max(1.5, Math.min(Math.sqrt(2 * margin * Math.max(0, h - 2)), 1.5 + 0.25 * h, 400));
        const lateral = v3.reject(vSurf, up);
        const dir = v3.normalize(v3.sub(v3.scale(up, 1), v3.scale(lateral, 0.05)));
        this.pointAt(dir);
        // Hold the weight, follow the law's own deceleration, and close the error on the sink rate.
        const need = (g + (vz < want ? margin : 0) + (want - vz) * 1.2) / Math.max(accel, 0.1);
        this.out.throttle = Math.max(0, Math.min(1, need));
        if (this.trace && h < 6000 && Math.floor(this.ut) % 2 === 0 && Math.floor(this.ut) !== this.lastTrace) {
          this.lastTrace = Math.floor(this.ut);
          this.note(`h ${h.toFixed(0)} vz ${vz.toFixed(1)} want ${want.toFixed(1)} vh ${vh.toFixed(1)} accel ${accel.toFixed(2)} lever ${this.out.throttle.toFixed(2)} tilt ${(this.rd.tiltFromVertical * 57.3).toFixed(1)}`);
        }
        if (!this.legs && h < 2000 && this.canStage()) {
          this.legs = this.fireStage('landing gear');
        }
        if (this.v.situation === 'landed') {
          this.touchdownSpeed = Math.hypot(vz, vh);
          this.landedUt = this.ut;
          this.out.throttle = 0;
          this.go('landed', 120, `touchdown at ${this.touchdownSpeed.toFixed(2)} m/s`);
        }
        return;
      }
      case 'landed': {
        this.out.throttle = 0;
        this.ensureSas(true);
        if (this.phaseTime > 15) {
          this.ascent = new AscentPilot(this.caps, { ...this.ascentOptions, fromSurface: true });
          this.ascent.onLog = this.onLog;
          this.go('ascent', 1800);
        }
        return;
      }
      case 'ascent': {
        this.out = this.ascent!.update(this.s, this.cmd, this.dt);
        if (this.ascent!.failure) this.fail(`ascent: ${this.ascent!.failure}`);
        else if (this.ascent!.done) this.finish('back in orbit');
        return;
      }
    }
  }

  /** Full-thrust acceleration of the lit engines now: the thrust seen at full lever (the brake burns at full), over the mass now. */
  private thrustAccelMax(): number {
    if (this.rd.throttle >= 0.999 && this.rd.thrust > this.fullThrust * 0.5) this.fullThrust = Math.max(this.fullThrust, this.rd.thrust);
    return this.rd.mass > 0 ? this.fullThrust / this.rd.mass : 0;
  }
  private fullThrust = 0;
}

/** The Albatross's departure: prograde at full throttle until the tanks are dry, at physics warp 4x. */
export class DeparturePilot extends GenericPilot {
  burnStartUt: number | null = null;
  burnEndUt: number | null = null;
  massStart = 0;
  massEnd = 0;
  /** Integrated acceleration of the burn (the delta-v the engines gave), m/s. */
  deltaV = 0;
  maxWarpIndex = 0;

  protected start(): void {
    this.staged = this.v.crafts[0]!.staging.nextStage;
    this.go('align', 300);
  }

  protected tick(): void {
    switch (this.phase) {
      case 'align': {
        this.ensureSas(true, 'prograde');
        if (this.phaseTime > 60) {
          this.massStart = this.rd.mass;
          this.burnStartUt = this.ut;
          this.go('burn', 3600);
        }
        return;
      }
      case 'burn': {
        this.ensureSas(true, 'prograde');
        this.out.throttle = 1;
        this.setWarp(MAX_PHYSICS_WARP_INDEX);
        this.maxWarpIndex = Math.max(this.maxWarpIndex, this.s.warp.index);
        this.deltaV += (this.rd.thrust / Math.max(1, this.rd.mass)) * this.dt;
        if (this.phaseTime > 60 && this.rd.thrust <= 0) {
          this.burnEndUt = this.ut;
          this.massEnd = this.rd.mass;
          this.setWarp(0);
          this.finish(`burn complete: ${(this.burnEndUt - this.burnStartUt!).toFixed(0)} s, ${this.deltaV.toFixed(0)} m/s`);
        }
        return;
      }
    }
  }

  /** The rocket equation over the burn at the engines' vacuum Isp. */
  idealDeltaV(isp: number): number {
    return isp * G0 * Math.log(this.massStart / this.massEnd);
  }
}
