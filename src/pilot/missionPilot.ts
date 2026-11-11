/**
 * The scripted mission pilot for the lunar direct-ascent mission (docs/research/sim-design.md 16.2,
 * extended with precision landing and recovery-zone targeting): pad, ascent, parking orbit, translunar
 * injection, mid-course corrections, lunar orbit insertion, plane trim, deorbit, powered descent to the
 * scenario's landing target, surface stay, lunar ascent, trans-Earth injection aimed at a recovery zone,
 * corrections, entry on the lift-vector rule, parachutes, splashdown.
 *
 * It flies like a competent player: it reads what the HUD and the map show (SimSnapshot), holds navball
 * markers with the SAS or flies the stick, plans burns by dragging maneuver nodes and watching the
 * predicted patches, and presses the stage button. It never touches the simulation state.
 */
import type { DefLibrary, ScenarioDef } from '@/core/contracts/defs';
import type { Patch, SimSnapshot, SurfaceTarget } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { DEG, RAD, TWO_PI } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { PilotCore, type PilotLogEntry } from './core';
import { ascentSinPitch, brakingGuidance, entryLiftUp, hoverGuidance, NOMINAL_PITCH_PROGRAMME, programmePitch, type LandingState, type PitchProgramme } from './guidance';
import { arc, bearing, bodyStateAt, clamp, dirFromLatLon, directionOf, horizonBasis, periapsisRadius } from './math';
import { compassSearch, minNormNewton, solveRoot, type Budget, type NodeVars, type Plan } from './planner';
import { arrivalPassOver, patchPassOver, predictSplash, sunElevation, zoneMisses, type SplashPrediction, type ZoneMiss } from './targets';

export interface MissionPilotOptions {
  /** Launch this many seconds after the plane crossing (perturbed runs). */
  launchDelay?: number;
  /** Pitch programme of the first stage (default: the nominal one). */
  pitchProgramme?: PitchProgramme;
  /** Minimum stay on the lunar surface, s (default 900). */
  surfaceStay?: number;
  /** Tilt of the departure direction out of the Moon's orbit plane that the lunar ascent sets up, degrees (default 10). */
  returnPlaneTiltDeg?: number;
  /** Use physics warp in long integrated phases (pacing only; default true). */
  physicsWarp?: boolean;
  /** Called for every log line. */
  onLog?: (e: PilotLogEntry) => void;
}

export interface MissionPilot extends PilotCore {
  /** Numbers the pilot noted on the way (delta-v used per maneuver, landing miss, splash prediction...). */
  readonly report: Record<string, number>;
}

// ---- mission parameters (how this pilot chooses to fly; none of them is known to the simulation) -------

const PARKING_ALTITUDE = 185000;
const FAIRING_JETTISON_ALTITUDE = 96000;
const LUNAR_ORBIT_ALTITUDE = 100000;
const DESCENT_PERILUNE_ALTITUDE = 15000;
const LUNAR_ASCENT_TURN_ALTITUDE = 20000;
const RETURN_PERIGEE_ALTITUDE = 45000;
const CAPSULE_SEPARATION_ALTITUDE = 2500000;
const DROGUE_ALTITUDE = 7500;
const MAIN_ALTITUDE = 3200;
/** Height of the braking gate above the ground and the sink rate there. */
const GATE_HEIGHT = 130;
const GATE_SINK = -5;
/** Fraction of the available deceleration the braking burn is started at. */
const BRAKING_IGNITION_FRACTION = 0.9;
/** Radar altitude below which the braking burn is flown at 1x (the landing site streams in and is seen in real time), m. */
const BRAKING_WARP_FLOOR = 4000;
/**
 * Nominal ground distance from the entry point of the predicted trajectory (top of the atmosphere) to
 * splashdown for a 45 km vacuum perigee flown on the lift-vector rule, m, as a function of the compass
 * heading of the entry track: calibrated with tools/sim/entryCorridor.ts (about 3 300 km eastbound, with
 * the Earth's rotation, 2 900 km on a southbound track, less against the rotation; +/- 250 km with the
 * perigee between 40 and 50 km).
 */
export function entryDownRange(heading: number): number {
  return 2900000 + 400000 * Math.sin(heading);
}
/** Nominal trans-Earth injection delta-v the departure search starts from, and its limits, m/s. */
const TEI_NOMINAL_DV = 900;
const TEI_MIN_DV = 835;
const TEI_MAX_DV = 1010;
const TEI_MAX_REVOLUTIONS = 26;
/** Out-of-plane tilt of the departure from the Moon that the lunar ascent sets up, degrees. */
const RETURN_PLANE_TILT = 10;
/** Time from lunar lift-off to the departure that the ascent plane is chosen for, s. */
const DEPARTURE_DELAY = 18 * 3600;
/** Weight of a metre per second against 25 km of splash miss in the first trans-Earth correction. */
const TEC_DV_WEIGHT = 0.5;

type Phase = string;

interface ReturnInfo {
  /** Perigee radius, positive for an eastward (prograde) pass, m. */
  signedPerigee: number;
  splash: SplashPrediction | null;
  misses: ZoneMiss[];
}

class LunarMissionPilot extends PilotCore implements MissionPilot {
  readonly report: Record<string, number> = {};
  private readonly opts: Required<Omit<MissionPilotOptions, 'onLog'>>;
  private readonly rootId: string;
  private readonly moonId: string;

  // ascent
  private launchUt = NaN;
  private launchAzimuth = 90 * DEG;
  private padAltitude = 0;
  private peakThrust = 0;
  private minQAlpha = Infinity;
  private waitUntil = NaN;
  private tliTrims = 0;
  // lunar
  private landingPassUt = NaN;
  private groundOffset = NaN;
  private touchdownUt = NaN;
  private lunarSense = -1;
  private ascentNormal: Vec3 | null = null;
  // return
  private zone: SurfaceTarget | null = null;
  private correctionIndex = 0;

  constructor(defs: DefLibrary, scenario: ScenarioDef, options: MissionPilotOptions) {
    super(defs, scenario);
    this.opts = {
      launchDelay: options.launchDelay ?? 0,
      pitchProgramme: options.pitchProgramme ?? NOMINAL_PITCH_PROGRAMME,
      surfaceStay: options.surfaceStay ?? 900,
      returnPlaneTiltDeg: options.returnPlaneTiltDeg ?? RETURN_PLANE_TILT,
      physicsWarp: options.physicsWarp ?? true,
    };
    this.physicsWarp = this.opts.physicsWarp;
    this.onLog = options.onLog ?? null;
    this.rootId = defs.rootBodyId;
    if (!scenario.target || !defs.bodies[scenario.target]) throw new Error(`createMissionPilot: scenario "${scenario.id}" has no target body`);
    this.moonId = scenario.target;
    const vehicle = defs.vehicles[scenario.vehicle]!;
    for (const p of vehicle.parts) {
      const q = defs.parts[p.def]?.joint.maxQAlpha;
      if (q !== undefined && q < this.minQAlpha) this.minQAlpha = q;
    }
  }

  // ---------------------------------------------------------------------------------------- helpers

  private get rootDef() {
    return this.bodyDef(this.rootId);
  }
  private get moonDef() {
    return this.bodyDef(this.moonId);
  }

  private landingTarget(): SurfaceTarget {
    const t = this.s.surfaceTargets.find((x) => x.kind === 'landing' && x.bodyId === this.moonId);
    if (!t) throw new Error('the scenario has no landing target on the target body');
    return t;
  }

  /** East / north / up at the vessel, inertial axes. */
  private horizon(): { east: Vec3; north: Vec3; up: Vec3 } {
    const b = this.bodySnap(this.v.bodyId);
    const pole = v3.len(b.spinRoot) > 0 ? v3.normalize(b.spinRoot) : { x: 0, y: 0, z: 1 };
    return horizonBasis(this.v.r, pole);
  }

  /** Surface-relative velocity, inertial axes. */
  private surfaceVelocity(): Vec3 {
    const b = this.bodySnap(this.v.bodyId);
    return v3.sub(this.v.v, v3.cross(b.spinRoot, this.v.r));
  }

  private stageFraction(stageIndex: number): number | null {
    return this.s.staging.stages[stageIndex]?.propellantFraction ?? null;
  }

  /** Fraction of the engine propellants left in the tanks of a part (by part instance id prefix). */
  private propellantKg(instanceId: string): number {
    const p = this.v.parts.find((x) => x.instanceId === instanceId);
    if (!p) return 0;
    let kg = 0;
    for (const [res, amount] of Object.entries(p.resources)) if (res !== 'RCSProp' && res !== 'Ablator') kg += amount;
    return kg;
  }

  private warpUntil(ut: number, margin = 2): boolean {
    const remaining = ut - this.ut;
    if (remaining <= 0) {
      if (this.s.warp.index !== 0) this.cmd.setWarpLevel(0);
      return true;
    }
    this.warpFor(remaining, margin);
    return false;
  }

  /** Signed periapsis radius of an arrival at the Moon: positive for a retrograde pass (against the Moon's orbital motion). */
  private signedPerilune(p: Patch): number {
    const moonOrbit = this.bodySnap(this.moonId).orbit;
    const sense = moonOrbit ? Math.sign(v3.dot(p.conic.W, moonOrbit.W)) : 1;
    return (sense * this.lunarSense > 0 ? 1 : -1) * periapsisRadius(p.conic);
  }

  // ------------------------------------------------------------------------------------------ start

  protected start(): void {
    const s = this.s;
    if (this.rd.targetBodyId !== this.moonId) this.cmd.setTarget(this.moonId);
    const v = this.v;
    const next = s.staging.nextStage;
    if (v.situation === 'prelaunch') this.go('prelaunch', 6 * 3600);
    else if (v.bodyId === this.rootId) {
      if (next >= 9) this.go('chutes', 1800);
      else if (next >= 8) this.go('entry', 3 * 3600);
      else if (next >= 7) this.go('transEarth', 8 * 86400);
      else if (next >= 5) this.go('translunar', 6 * 86400);
      else this.go('parkingCoast', 86400);
    } else if (v.situation === 'landed') {
      this.touchdownUt = s.simUt;
      this.go('surface', 4 * 86400);
    } else if (next >= 7) this.go('lunarOrbitReturn', 86400);
    else if (this.rd.periapsisAltitude < 30000 && this.rd.eccentricity < 1) this.go('pdiCoast', 7200);
    else if (this.rd.eccentricity < 0.2) this.go('lunarOrbit', 86400);
    else this.go('moonArrival', 86400);
  }

  // ------------------------------------------------------------------------------------------- tick

  protected tick(): void {
    switch (this.phase as Phase) {
      case 'prelaunch':
        return this.prelaunch();
      case 'ignition':
        return this.ignition();
      case 'vertical':
        return this.vertical();
      case 'pitchProgramme':
        return this.pitchProgramme();
      case 'm1Separation':
        return this.m1Separation();
      case 'm2Ascent':
        return this.m2Ascent();
      case 'seco':
        return this.seco();
      case 'dropM2':
        return this.dropM2();
      case 'parkingCoast':
        return this.parkingCoast();
      case 'postTli':
        return this.postTli();
      case 'translunar':
        return this.translunar();
      case 'coastToMoon':
        return this.coastToMoon();
      case 'moonArrival':
        return this.moonArrival();
      case 'lunarOrbit':
        return this.lunarOrbit();
      case 'pdiCoast':
        return this.pdiCoast();
      case 'braking':
        return this.braking();
      case 'approach':
        return this.approach();
      case 'terminal':
        return this.terminal();
      case 'touchdown':
        return this.touchdownWait();
      case 'surface':
        return this.surface();
      case 'lunarLiftoff':
        return this.lunarLiftoff();
      case 'lunarAscent':
        return this.lunarAscent();
      case 'lunarOrbitReturn':
        return this.lunarOrbitReturn();
      case 'coastFromMoon':
        return this.coastFromMoon();
      case 'transEarth':
        return this.transEarth();
      case 'entryPrep':
        return this.entryPrep();
      case 'entry':
        return this.entry();
      case 'chutes':
        return this.chutes();
      case 'splashdown':
        return this.splashdown();
      default:
        this.fail(`unknown phase "${this.phase}"`);
    }
  }

  // ----------------------------------------------------------------------------------- pad to orbit

  private prelaunch(): void {
    this.ensureSas('stability');
    const lw = this.rd.launchWindow;
    if (Number.isNaN(this.launchUt)) {
      if (lw) {
        this.launchUt = this.ut + lw.timeToPlaneCrossing + this.opts.launchDelay;
        this.launchAzimuth = lw.launchAzimuthDeg * DEG;
      } else this.launchUt = this.ut + 10 + this.opts.launchDelay;
      this.padAltitude = this.rd.altitudeAsl;
      this.note(`launch at T+${(this.launchUt - this.ut).toFixed(1)} s on azimuth ${(this.launchAzimuth * RAD).toFixed(2)} deg`);
    }
    // The clamps let go a fixed time after ignition (the stage's own sequence).
    const stage0 = this.defs.vehicles[this.scenario.vehicle]!.stages[0];
    const release = stage0?.actions.find((a) => a.kind === 'releaseClamps')?.delay ?? 0;
    const remaining = this.launchUt - release - this.ut;
    if (remaining > 20) {
      this.warpFor(remaining - 15);
      return;
    }
    if (this.s.warp.index !== 0) this.cmd.setWarpLevel(0);
    this.out.throttle = 1;
    if (remaining <= 0) {
      const res = this.cmd.stage();
      if (!res.ok) return this.fail(`ignition refused: ${res.reason ?? ''}`);
      this.go('ignition', 30);
    }
  }

  private ignition(): void {
    this.out.throttle = 1;
    if (this.v.situation !== 'prelaunch') {
      this.attitude.reset(0.03);
      this.go('vertical', 120, 'lift-off');
    }
  }

  private vertical(): void {
    this.out.throttle = 1;
    this.cruiseWarp(true);
    const hz = this.horizon();
    const h = this.rd.altitudeAsl - this.padAltitude;
    // After tower clear the ventral side is rolled to the launch azimuth: the dorsal side faces away from it.
    const dorsal = h > 150 ? v3.neg(directionOf(0, this.launchAzimuth, hz)) : null;
    this.pointAt(hz.up, { dorsal, maxRate: 4 * DEG });
    this.peakThrust = Math.max(this.peakThrust, this.rd.thrust);
    if (h > this.opts.pitchProgramme.startHeight) this.go('pitchProgramme', 400);
  }

  private pitchProgramme(): void {
    this.out.throttle = 1;
    this.cruiseWarp(true);
    const prog = this.opts.pitchProgramme;
    const hz = this.horizon();
    const h = this.rd.altitudeAsl - this.padAltitude;
    const az = this.launchAzimuth + prog.headingBiasDeg * DEG;
    let dir = directionOf(programmePitch(prog, h), az, hz);
    // Keep the angle of attack inside the structural q-alpha limit (half of it) while the air is thick.
    const q = this.rd.dynamicPressure;
    const vs = this.surfaceVelocity();
    if (q > 2000 && v3.len(vs) > 50) {
      const pro = v3.normalize(vs);
      const limit = clamp((0.5 * this.minQAlpha) / q, 1.5 * DEG, 30 * DEG);
      const off = v3.angle(pro, dir);
      if (off > limit) dir = v3.normalize(v3.add(v3.scale(pro, Math.sin(off - limit) / Math.sin(off)), v3.scale(dir, Math.sin(limit) / Math.sin(off))));
    }
    this.pointAt(dir, { dorsal: v3.neg(directionOf(0, az, hz)), maxRate: 3 * DEG });
    this.peakThrust = Math.max(this.peakThrust, this.rd.thrust);
    const frac = this.stageFraction(0);
    const depleted = (frac !== null && frac < 0.004) || (this.phaseTime > 30 && this.rd.thrust < 0.2 * this.peakThrust);
    if (depleted && !this.s.staging.lockout) {
      this.report['m1PropellantFractionAtSeparation'] = frac ?? 0;
      const res = this.cmd.stage();
      if (!res.ok) return this.fail(`M-1 separation refused: ${res.reason ?? ''}`);
      this.go('m1Separation', 30, `first stage spent at ${(this.rd.altitudeAsl / 1000).toFixed(1)} km, ${this.rd.speedSurface.toFixed(0)} m/s`);
    }
  }

  private m1Separation(): void {
    this.out.throttle = 1;
    this.cruiseWarp(false);
    const vs = this.surfaceVelocity();
    if (v3.len(vs) > 1) this.pointAt(v3.normalize(vs), { maxRate: 2 * DEG });
    if (this.phaseTime > 2.5 && this.rd.thrust > 1e5) {
      this.attitude.reset(0.03);
      this.go('m2Ascent', 900, 'second stage burning');
    }
  }

  private m2Ascent(): void {
    const body = this.rootDef;
    this.cruiseWarp(true);
    const hz = this.horizon();
    const r = v3.len(this.v.r);
    const h = r - body.radius;
    const vr = this.rd.verticalSpeed;
    const vh = Math.sqrt(Math.max(0, this.rd.speedOrbital * this.rd.speedOrbital - vr * vr));
    const eng = this.armedEngines();
    const aT = eng && this.rd.mass > 0 ? eng.thrust / this.rd.mass : 0;
    // Tower and fairing go once the air is thin enough.
    if (this.s.staging.nextStage === 2 && h > FAIRING_JETTISON_ALTITUDE && !this.s.staging.lockout) {
      this.cmd.stage();
      this.note(`tower and fairing jettisoned at ${(h / 1000).toFixed(1)} km`);
    }
    // An upper stage that runs dry before orbit hands over to the next one.
    if (this.rd.thrust <= 0 && this.phaseTime > 8 && !this.s.staging.lockout && this.s.staging.nextStage <= 3) {
      if (this.s.staging.nextStage === 2) this.cmd.stage();
      else {
        this.report['m2PropellantFractionAtSeparation'] = 0;
        this.cmd.stage();
        this.attitude.reset(0.03);
        this.note('second stage spent before orbit: third stage takes over');
      }
    }
    const sinP = ascentSinPitch({ mu: body.mu, r, h, hTarget: PARKING_ALTITUDE, vr, vh, thrustAccel: aT, tauH: 120, tauV: 20, vrMin: -50, vrMax: 900, sinMin: -0.35, sinMax: 0.75 });
    const cosP = Math.sqrt(1 - sinP * sinP);
    // Horizontal direction: along the horizontal velocity, steered into the target's orbit plane.
    const vHoriz = v3.reject(this.v.v, hz.up);
    let along = v3.len(vHoriz) > 1 ? v3.normalize(vHoriz) : directionOf(0, this.launchAzimuth, hz);
    const moonOrbit = this.bodySnap(this.moonId).orbit;
    if (moonOrbit && aT > 0) {
      const W = moonOrbit.W;
      const z = v3.dot(this.v.r, W);
      const zDot = v3.dot(this.v.v, W);
      const omega = 0.02;
      const aN = -(2 * omega * zDot + omega * omega * z);
      const side = v3.reject(W, hz.up);
      if (v3.len(side) > 1e-6) {
        const sN = clamp(aN / Math.max(aT * cosP, 0.1), -0.2, 0.2);
        along = v3.normalize(v3.add(v3.scale(along, Math.sqrt(1 - sN * sN)), v3.scale(v3.normalize(side), sN)));
      }
    }
    const dir = v3.add(v3.scale(along, cosP), v3.scale(hz.up, sinP));
    this.pointAt(dir, { dorsal: v3.neg(along), maxRate: 3 * DEG });
    // Cut-off: the periapsis is up. Fine control for the last seconds at the engines' minimum.
    const pe = this.rd.periapsisAltitude;
    const ap = this.rd.apoapsisAltitude;
    const target = Math.min(PARKING_ALTITUDE - 5000, h - 3000);
    this.out.throttle = pe > 60000 ? 0.002 : 1;
    if (pe >= target || (pe > 165000 && ap > 300000)) {
      this.out.throttle = 0;
      this.go('seco', 600, `cut-off: ${(pe / 1000).toFixed(1)} x ${(ap / 1000).toFixed(1)} km`);
    }
  }

  private seco(): void {
    this.cruiseWarp(false);
    this.ensureSas('stability');
    if (this.phaseTime < 3) return;
    const pe = this.rd.periapsisAltitude;
    const ap = this.rd.apoapsisAltitude;
    const mu = this.rootDef.mu;
    const R = this.rootDef.radius;
    if (pe >= 162000 && ap <= 385000) {
      this.go('dropM2', 300);
      return;
    }
    // Repair the orbit with one node at an apsis (the generic burn routine flies it).
    if (pe < 162000 && this.rd.timeToApoapsis !== null) {
      const ra = R + ap;
      const vNow = Math.sqrt(mu * (2 / ra - 2 / (ra + R + pe)));
      const vNew = Math.sqrt(mu * (2 / ra - 2 / (ra + R + PARKING_ALTITUDE)));
      this.beginManeuver({
        label: 'raisePeriapsis',
        initial: { ut: this.ut + this.rd.timeToApoapsis, prograde: vNew - vNow, normal: 0, radial: 0 },
        then: () => this.go('seco', 600),
      });
      return;
    }
    if (this.rd.timeToPeriapsis !== null) {
      const rp = R + pe;
      const vNow = Math.sqrt(mu * (2 / rp - 2 / (rp + R + ap)));
      const vNew = Math.sqrt(mu * (2 / rp - 2 / (rp + R + 250000)));
      this.beginManeuver({
        label: 'lowerApoapsis',
        initial: { ut: this.ut + this.rd.timeToPeriapsis, prograde: vNew - vNow, normal: 0, radial: 0 },
        then: () => this.go('seco', 600),
      });
      return;
    }
    this.fail('no orbit after cut-off');
  }

  private dropM2(): void {
    this.ensureSas('stability');
    if (this.s.staging.nextStage === 2 && !this.s.staging.lockout) {
      this.cmd.stage();
      return;
    }
    if (this.s.staging.nextStage === 3 && !this.s.staging.lockout) {
      const f = this.stageFraction(1);
      this.report['m2PropellantFractionAtSeparation'] = f ?? 0;
      this.cmd.stage();
      this.attitude.reset(0.02);
      this.note(`second stage dropped with ${((f ?? 0) * 100).toFixed(1)} % propellant`);
      return;
    }
    if (this.s.staging.nextStage >= 4 && this.reached('EARTH_ORBIT', this.rd.periapsisAltitude > 150000)) {
      this.ensureRcs(true);
      this.waitUntil = this.ut + (this.rd.period ?? 5400) + 120;
      this.go('parkingCoast', 86400, `parking orbit ${(this.rd.periapsisAltitude / 1000).toFixed(1)} x ${(this.rd.apoapsisAltitude / 1000).toFixed(1)} km, plane ${((this.rd.targetRelativeInclination ?? 0) * RAD).toFixed(3)} deg off the target's`);
    }
  }

  private parkingCoast(): void {
    // One full revolution on rails (the parking orbit is checked against Kepler over it), then the departure.
    if (Number.isNaN(this.waitUntil)) this.waitUntil = this.ut + 60;
    if (!this.warpUntil(this.waitUntil)) return;
    this.planTli();
  }

  // ------------------------------------------------------------------------------------- translunar

  /** Cost (km) of a planned arrival at the Moon: distance of the signed perilune radius from the wanted one. */
  private arrivalMiss(patches: readonly Patch[], altitude: number): number {
    const R = this.moonDef.radius;
    const soi = this.bodySnap(this.moonId).soiRadius ?? 0;
    // Only an encounter on the way out counts (before the apogee of the transfer), and only the first one.
    const first = patches[0];
    if (first && first.bodyId === this.moonId) return Math.abs(this.signedPerilune(first) - (R + altitude)) / 1000;
    if (first && first.endReason === 'soiEnter' && first.nextBodyId === this.moonId && !first.markers.some((m) => m.kind === 'apoapsis')) {
      const mp = patches[1];
      if (mp && mp.bodyId === this.moonId) return Math.abs(this.signedPerilune(mp) - (R + altitude)) / 1000;
    }
    let best = Infinity;
    if (first) {
      for (const m of first.markers) {
        if (m.kind === 'apoapsis') break;
        if (m.kind === 'closestApproach' && m.value !== undefined && m.value < best) best = m.value;
      }
    }
    return Number.isFinite(best) ? Math.max(best, soi) / 1000 + 100 : 1e6;
  }

  /** The arrival patch at the Moon of a trajectory (the patch list starts in the Moon's SOI, or enters it first thing). */
  private arrivalPatch(patches: readonly Patch[]): Patch | undefined {
    const first = patches[0];
    if (first && first.bodyId === this.moonId) return first;
    if (first && first.endReason === 'soiEnter' && first.nextBodyId === this.moonId) return patches[1];
    return undefined;
  }

  private planTli(): void {
    const period = this.rd.period ?? 5400;
    const cost = (s: SimSnapshot): number => this.arrivalMiss(s.patches.planned, LUNAR_ORBIT_ALTITUDE + 20000);
    const start: NodeVars = { ut: this.ut + 240, prograde: 3150, normal: 0, radial: 0 };
    const plan = function* (budget: Budget): Plan {
      // Where on the orbit: one sweep of the node round the revolution, then the two handles.
      let best = start;
      let bestCost = Infinity;
      const samples = 40;
      for (let k = 0; k < samples; k++) {
        const cand = { ...start, ut: start.ut + (k * period) / samples };
        budget.left--;
        const c = cost(yield cand);
        if (c < bestCost) {
          bestCost = c;
          best = cand;
        }
      }
      const res = yield* compassSearch(
        best,
        {
          vars: [
            { key: 'ut', steps: [period / 96, 12, 3, 0.6, 0.12] },
            { key: 'prograde', steps: [25, 6, 1.5, 0.3, 0.06] },
          ],
          cost,
          tolerance: 25,
        },
        budget,
      );
      return res.cost < 30000 ? res.best : null;
    };
    this.beginManeuver({
      label: 'tli',
      initial: start,
      plan,
      reject: (s) => (this.arrivalPatch(s.patches.planned) ? null : 'the planned trajectory does not reach the Moon'),
      trim: false,
      then: () => {
        this.report['tliDeltaV'] = this.dvFlown['tli'] ?? 0;
        this.go('postTli', 3600);
      },
    });
    this.markDv('tli');
  }

  // Delta-v bookkeeping from the stage read-out (what the staging panel shows).
  private readonly dvMarks = new Map<string, number>();
  private markDv(key: string): void {
    this.dvMarks.set(key, this.rd.deltaVTotal);
  }
  private dvUsedSince(key: string): number {
    return (this.dvMarks.get(key) ?? this.rd.deltaVTotal) - this.rd.deltaVTotal;
  }

  private postTli(): void {
    this.ensureSas('stability');
    if (this.phaseTime < 5) return;
    const miss = this.arrivalMiss(this.s.patches.current, LUNAR_ORBIT_ALTITUDE);
    const encounter = this.arrivalPatch(this.s.patches.current) !== undefined && miss < 60000;
    if ((!encounter || miss > 2500) && this.s.staging.nextStage <= 4 && this.tliTrims < 2) {
      // The long burn left the transfer a little short or long: the third stage, which is going to be
      // dropped anyway, trims it (finishing on its thrusters) before the lander pays for corrections.
      this.tliTrims++;
      const cost = (s: SimSnapshot): number => this.arrivalMiss(s.patches.planned, LUNAR_ORBIT_ALTITUDE + 20000);
      const start: NodeVars = { ut: this.ut + 150, prograde: 0, normal: 0, radial: 0 };
      this.note(`perilune ${miss.toFixed(0)} km off after the injection: trim on the third stage`);
      this.beginManeuver({
        label: 'tliTrim',
        initial: start,
        plan: function* (budget: Budget): Plan {
          const res = yield* compassSearch(start, { vars: [{ key: 'prograde', steps: [20, 5, 1, 0.2, 0.05, 0.0125] }], cost, tolerance: 300 }, budget);
          return res.cost < 60000 ? res.best : null;
        },
        skipBelow: 0.05,
        then: () => this.go('postTli', 3600),
      });
      return;
    }
    if (!encounter) return this.fail('no lunar encounter after the injection');
    if (this.s.staging.nextStage === 4 && !this.s.staging.lockout) {
      const f = this.stageFraction(3);
      this.report['m3PropellantFractionAtSeparation'] = f ?? 0;
      this.cmd.stage();
      this.attitude.reset(0.05);
      this.note(`third stage dropped with ${((f ?? 0) * 100).toFixed(1)} % propellant`);
      return;
    }
    if (this.s.staging.nextStage >= 5) {
      this.waitUntil = this.ut + 600;
      this.correctionIndex = 0;
      this.go('translunar', 6 * 86400);
    }
  }

  /** Cost of a planned or current lunar arrival: perilune altitude error and cross-track of the landing target, km. */
  private arrivalCost(patches: readonly Patch[]): { cost: number; perilune: number; crossTrack: number; residuals: number[] | null } {
    const R = this.moonDef.radius;
    const mp = this.arrivalPatch(patches);
    if (!mp) return { cost: this.arrivalMiss(patches, LUNAR_ORBIT_ALTITUDE) + 1000, perilune: NaN, crossTrack: NaN, residuals: null };
    const signed = this.signedPerilune(mp);
    const peErr = (signed - (R + LUNAR_ORBIT_ALTITUDE)) / 1000;
    const rp = Math.max(periapsisRadius(mp.conic), R + 10000);
    const periodCirc = TWO_PI * Math.sqrt((rp * rp * rp) / mp.conic.mu);
    const xt = arrivalPassOver(mp.conic, this.bodySnap(this.moonId), R, this.s.simUt, this.landingTarget(), 1.2 * periodCirc).crossTrack / 1000;
    return { cost: Math.hypot(peErr, xt), perilune: periapsisRadius(mp.conic) - R, crossTrack: xt, residuals: [peErr, xt] };
  }

  private planCorrection(label: string, leadTime: number, tolerance: number, then: () => void): void {
    const now = this.arrivalCost(this.s.patches.current);
    this.note(`arrival now: perilune ${(now.perilune / 1000).toFixed(1)} km, landing target ${now.crossTrack.toFixed(1)} km off the ground track`);
    if (now.cost < tolerance) {
      then();
      return;
    }
    const start: NodeVars = { ut: this.ut + leadTime, prograde: 0, normal: 0, radial: 0 };
    const cost = (s: SimSnapshot): number => this.arrivalCost(s.patches.planned).cost;
    const residuals = (s: SimSnapshot): number[] | null => this.arrivalCost(s.patches.planned).residuals;
    this.markDv(label);
    this.beginManeuver({
      label,
      initial: start,
      plan: function* (budget: Budget): Plan {
        // Smallest combined change of the three handles that removes both errors; a compass search polishes
        // (or takes over, should the arrival be too far off for the handles to act smoothly).
        const newton = yield* minNormNewton(
          start,
          {
            vars: [
              { key: 'prograde', probe: 0.1, maxStep: 25 },
              { key: 'radial', probe: 0.1, maxStep: 25 },
              { key: 'normal', probe: 0.1, maxStep: 25 },
            ],
            residuals,
            tolerance: 0.4 * tolerance,
            maxIterations: 12,
          },
          budget,
        );
        if (newton.cost <= 0.4 * tolerance) return newton.best;
        const res = yield* compassSearch(
          newton.best,
          {
            vars: [
              { key: 'radial', steps: [4, 1, 0.25, 0.06, 0.015, 0.004] },
              { key: 'normal', steps: [4, 1, 0.25, 0.06, 0.015, 0.004] },
              { key: 'prograde', steps: [4, 1, 0.25, 0.06, 0.015, 0.004] },
            ],
            cost,
            tolerance: 0.5 * tolerance,
          },
          budget,
        );
        return res.cost < 5000 ? res.best : null;
      },
      skipBelow: 0.05,
      then: () => {
        this.report[`${label}DeltaV`] = this.dvFlown[label] ?? 0;
        then();
      },
    });
  }

  private translunar(): void {
    this.ensureSas('stability');
    if (Number.isNaN(this.waitUntil)) this.waitUntil = this.ut + 30;
    if (!this.warpUntil(this.waitUntil)) return;
    this.planCorrection('mcc1', 180, 3, () => this.go('coastToMoon', 8 * 86400));
  }

  private coastToMoon(): void {
    if (this.v.bodyId === this.moonId) {
      if (this.s.warp.index !== 0) this.cmd.setWarpLevel(0);
      this.waitUntil = this.ut + 120;
      this.correctionIndex = 0;
      this.go('moonArrival', 86400, 'inside the lunar sphere of influence');
      return;
    }
    const first = this.s.patches.current[0];
    if (first && first.endReason === 'soiEnter') this.warpFor(first.tEnd - this.ut + 30, 1);
    else if (!this.s.patches.current.some((p) => p.endReason === 'soiEnter')) this.fail('the lunar encounter was lost');
    else this.warpFor(600, 1);
  }

  private moonArrival(): void {
    this.ensureSas('stability');
    if (Number.isNaN(this.waitUntil)) this.waitUntil = this.ut + 30;
    if (!this.warpUntil(this.waitUntil)) return;
    if (this.correctionIndex === 0) {
      this.correctionIndex = 1;
      this.planCorrection('mcc2', 240, 2, () => {
        this.waitUntil = this.ut + 5;
        this.go('moonArrival', 86400);
      });
      return;
    }
    // Insertion at the perilune: retrograde to a circular orbit.
    const tPe = this.rd.timeToPeriapsis;
    if (tPe === null || tPe < 60) return this.fail('no perilune ahead for the insertion');
    const mu = this.moonDef.mu;
    const R = this.moonDef.radius;
    const rp = R + this.rd.periapsisAltitude;
    const c = this.s.patches.current[0]?.conic;
    const vPeri = c ? Math.sqrt(mu * (2 / rp - 1 / c.a)) : Math.sqrt((2 * mu) / rp);
    const start: NodeVars = { ut: this.ut + tPe, prograde: -(vPeri - Math.sqrt(mu / rp)), normal: 0, radial: 0 };
    const cost = (s: SimSnapshot): number => {
      const p = s.patches.planned[0];
      if (!p || p.bodyId !== this.moonId) return 1e7;
      if (p.conic.period === null) return 1e6 + p.conic.e * 1e3;
      const ra = p.conic.a * (1 + p.conic.e);
      const rpp = p.conic.a * (1 - p.conic.e);
      return (ra - rpp) / 1000 + Math.abs(rpp - rp) / 1000;
    };
    this.markDv('loi');
    this.beginManeuver({
      label: 'loi',
      initial: start,
      plan: function* (budget: Budget): Plan {
        const res = yield* compassSearch(start, { vars: [{ key: 'prograde', steps: [10, 2, 0.5, 0.1] }], cost, tolerance: 1 }, budget);
        return res.cost < 1e5 ? res.best : null;
      },
      then: () => {
        this.report['loiDeltaV'] = this.dvFlown['loi'] ?? 0;
        this.correctionIndex = 0;
        this.go('lunarOrbit', 2 * 86400, `lunar orbit ${(this.rd.periapsisAltitude / 1000).toFixed(1)} x ${(this.rd.apoapsisAltitude / 1000).toFixed(1)} km`);
      },
    });
  }

  // ------------------------------------------------------------------------------- lunar orbit work

  /** The pass over the landing target at least `lead` seconds from now on the orbit of patch `p`. */
  private nextPass(p: Patch, tMin: number) {
    return patchPassOver(p.conic, this.bodySnap(this.moonId), this.moonDef.radius, this.s.simUt, this.landingTarget(), tMin);
  }

  private lunarOrbit(): void {
    this.ensureSas('stability');
    if (this.phaseTime < 3) return;
    const cur = this.s.patches.current[0];
    const period = this.rd.period;
    if (!cur || period === null || cur.bodyId !== this.moonId) return this.fail('not in a closed lunar orbit');
    if (this.correctionIndex === 0) {
      // Circularise if the insertion left the orbit lopsided.
      this.correctionIndex = 1;
      const ap = this.rd.apoapsisAltitude;
      const pe = this.rd.periapsisAltitude;
      if (ap - pe > 12000 && this.rd.timeToApoapsis !== null && this.rd.timeToPeriapsis !== null) {
        const mu = this.moonDef.mu;
        const R = this.moonDef.radius;
        // Burn at the apsis nearer the wanted altitude, bringing the other one to it.
        const atAp = Math.abs(ap - LUNAR_ORBIT_ALTITUDE) < Math.abs(pe - LUNAR_ORBIT_ALTITUDE);
        const rBurn = R + (atAp ? ap : pe);
        const rOther = R + (atAp ? pe : ap);
        const vNow = Math.sqrt(mu * (2 / rBurn - 2 / (rBurn + rOther)));
        const vNew = Math.sqrt(mu / rBurn);
        this.beginManeuver({
          label: 'circularise',
          initial: { ut: this.ut + (atAp ? this.rd.timeToApoapsis : this.rd.timeToPeriapsis), prograde: vNew - vNow, normal: 0, radial: 0 },
          then: () => this.go('lunarOrbit', 2 * 86400),
        });
        return;
      }
    }
    if (this.correctionIndex === 1) {
      // Plane trim: a normal burn three quarters of a revolution before the landing pass.
      this.correctionIndex = 2;
      const pass = this.nextPass(cur, this.ut + 0.75 * period + 500);
      this.landingPassUt = pass.ut;
      this.note(`landing pass in ${((pass.ut - this.ut) / 60).toFixed(1)} min, target ${(pass.crossTrack / 1000).toFixed(2)} km off the ground track`);
      if (Math.abs(pass.crossTrack) > 250) {
        const tPass = pass.ut;
        const start: NodeVars = { ut: tPass - 0.75 * period, prograde: 0, normal: 0, radial: 0 };
        const cost = (s: SimSnapshot): number => {
          const p = s.patches.planned[0];
          if (!p || p.conic.period === null) return 1e6;
          return Math.abs(this.nextPass(p, tPass - 0.3 * period).crossTrack) / 1000;
        };
        this.markDv('planeTrim');
        this.beginManeuver({
          label: 'planeTrim',
          initial: start,
          plan: function* (budget: Budget): Plan {
            const res = yield* compassSearch(start, { vars: [{ key: 'normal', steps: [20, 5, 1.2, 0.3, 0.08, 0.02] }], cost, tolerance: 0.1 }, budget);
            return res.cost < 50 ? res.best : null;
          },
          skipBelow: 0.05,
          then: () => {
            this.report['planeTrimDeltaV'] = this.dvFlown['planeTrim'] ?? 0;
            this.go('lunarOrbit', 2 * 86400);
          },
        });
        return;
      }
    }
    // Deorbit: retrograde half a revolution before the braking point, perilune 15 km up-range of the target.
    const pass = this.nextPass(cur, Number.isNaN(this.landingPassUt) ? this.ut + 0.6 * period + 300 : this.landingPassUt - 0.3 * period);
    this.landingPassUt = pass.ut;
    if (pass.ut - this.ut < 0.56 * period + 120) {
      // Too late for this pass: take the next one.
      this.landingPassUt = pass.ut + period * 0.7;
      this.correctionIndex = 1;
      return;
    }
    this.report['crossTrackBeforeDeorbit'] = pass.crossTrack;
    const R = this.moonDef.radius;
    const mu = this.moonDef.mu;
    const eng = this.armedEngines();
    const aBrake = eng && this.rd.mass > 0 ? (BRAKING_IGNITION_FRACTION * eng.thrust) / this.rd.mass : 4;
    const vPeri = Math.sqrt(mu * (2 / (R + DESCENT_PERILUNE_ALTITUDE) - 2 / (2 * R + DESCENT_PERILUNE_ALTITUDE + this.rd.altitudeAsl)));
    const brakingRange = (vPeri * vPeri) / (2 * aBrake);
    const rNow = R + this.rd.altitudeAsl;
    const vNow = this.rd.speedOrbital;
    const vNew = Math.sqrt(mu * (2 / rNow - 2 / (rNow + R + DESCENT_PERILUNE_ALTITUDE)));
    const targetDir = pass.targetDir;
    const tPass = pass.ut;
    const start: NodeVars = { ut: tPass - (0.5 + brakingRange / (TWO_PI * R)) * period, prograde: vNew - vNow, normal: 0, radial: 0 };
    const cost = (s: SimSnapshot): number => {
      const p = s.patches.planned[0];
      if (!p || p.conic.period === null) return 1e6;
      const pe = p.markers.find((m) => m.kind === 'periapsis');
      if (!pe) return 1e5;
      const alt = v3.len(pe.r) - R;
      const range = arc(v3.normalize(pe.r), targetDir) * R;
      const late = pe.ut > tPass ? 2000 : 0;
      return Math.abs(alt - DESCENT_PERILUNE_ALTITUDE) / 100 + Math.abs(range - brakingRange) / 1000 + late;
    };
    this.markDv('deorbit');
    this.note(`deorbit for a perilune ${(brakingRange / 1000).toFixed(0)} km up-range of the target`);
    this.beginManeuver({
      label: 'deorbit',
      initial: start,
      plan: function* (budget: Budget): Plan {
        const res = yield* compassSearch(
          start,
          {
            vars: [
              { key: 'ut', steps: [60, 15, 4, 1] },
              { key: 'prograde', steps: [2, 0.5, 0.12, 0.03] },
            ],
            cost,
            tolerance: 2,
          },
          budget,
        );
        return res.cost < 400 ? res.best : null;
      },
      then: () => {
        this.report['deorbitDeltaV'] = this.dvFlown['deorbit'] ?? 0;
        this.go('pdiCoast', 3 * 3600, `descent orbit perilune ${(this.rd.periapsisAltitude / 1000).toFixed(1)} km`);
      },
    });
  }

  // ------------------------------------------------------------------------------ powered descent

  /** State of the vehicle relative to the landing target (what the landing panel and the navball show). */
  private landingState(): LandingState {
    const moon = this.bodySnap(this.moonId);
    const t = this.landingTarget();
    const r = this.v.r;
    const radius = v3.len(r);
    const up = v3.scale(r, 1 / radius);
    const dT = quat.rotate(moon.qFixedToRoot, dirFromLatLon(t.latitude, t.longitude));
    let toTarget = v3.reject(dT, up);
    const range = arc(up, dT) * this.moonDef.radius;
    toTarget = v3.len(toTarget) > 1e-9 ? v3.normalize(toTarget) : v3.anyOrthogonal(up);
    const left = v3.cross(up, toTarget);
    const vs = this.surfaceVelocity();
    // Height of the lowest point above the ground: the radar altitude smoothed over the terrain passing below.
    const offset = this.rd.altitudeAsl - this.rd.altitudeRadar;
    if (Number.isNaN(this.groundOffset)) this.groundOffset = offset;
    const tau = range > 3000 ? 12 : 1.5;
    this.groundOffset += (offset - this.groundOffset) * Math.min(1, this.dt / tau);
    const mu = this.moonDef.mu;
    return {
      range,
      toTarget,
      left,
      up,
      vAlong: v3.dot(vs, toTarget),
      vLeft: v3.dot(vs, left),
      vUp: v3.dot(vs, up),
      height: this.rd.altitudeAsl - this.groundOffset,
      gravity: mu / (radius * radius),
      radius,
    };
  }

  /** Point the thrust along `accel` and set the lever for its magnitude. */
  private flyAccel(accel: Vec3, burn: boolean): number {
    const eng = this.armedEngines();
    const mag = v3.len(accel);
    const dir = mag > 1e-6 ? v3.scale(accel, 1 / mag) : this.horizon().up;
    this.pointAt(dir, { maxRate: 10 * DEG });
    const aMax = eng && this.rd.mass > 0 ? eng.thrust / this.rd.mass : 0;
    const frac = aMax > 0 ? mag / aMax : 0;
    if (burn && eng) {
      // Thrust off the wanted line does no good: hold back while the nose is still coming round.
      const err = v3.angle(this.nose(), dir);
      this.out.throttle = this.leverFor(Math.min(1, frac) * (err > 25 * DEG ? 0.3 : 1), eng.minThrottle);
    }
    return frac;
  }

  private pdiCoast(): void {
    this.ensureSas('stability');
    this.ensureRcs(true);
    // Gear down on the way (the stage button, so that the stack moves on to the lift-off entry).
    if (this.s.staging.nextStage === 5 && !this.s.staging.lockout && this.s.warp.index <= 3) {
      this.cmd.stage();
      this.note('landing gear deployed');
    }
    const ls = this.landingState();
    // Far round the Moon the target is beyond the limb: coast on the clock until a few minutes before the pass.
    if (ls.range > 1.2e6 || ls.vAlong <= 0) {
      if (ls.range < 3e5 && ls.vAlong <= 0) return this.fail('the braking point was missed');
      const toPass = Number.isNaN(this.landingPassUt) ? 600 : this.landingPassUt - this.ut - 900;
      this.warpFor(Math.max(toPass, 20));
      return;
    }
    const cmd = brakingGuidance(ls, GATE_HEIGHT, GATE_SINK);
    const eng = this.armedEngines();
    const aMax = eng && this.rd.mass > 0 ? eng.thrust / this.rd.mass : 1;
    const frac = v3.len(cmd.accel) / aMax;
    // Coast on rails until shortly before the braking point, then turn to the braking attitude.
    const ignitionRange = (ls.vAlong * ls.vAlong) / (2 * BRAKING_IGNITION_FRACTION * aMax);
    const timeToIgnition = (ls.range - ignitionRange) / ls.vAlong;
    if (timeToIgnition > 150) {
      this.warpFor(timeToIgnition - 120);
      return;
    }
    // The last two minutes to the ignition point, turning to the braking attitude (physics warp until the last seconds).
    this.waitWarp(timeToIgnition > 10);
    this.flyAccel(cmd.accel, false);
    if (frac >= BRAKING_IGNITION_FRACTION) {
      this.markDv('descent');
      this.go('braking', 1500, `braking from ${(ls.range / 1000).toFixed(1)} km out, ${(this.rd.altitudeAsl / 1000).toFixed(1)} km up, ${ls.vAlong.toFixed(0)} m/s`);
    }
  }

  private braking(): void {
    // Pacing only: the high part of the burn at physics warp, the last kilometres over the ground in real time.
    this.cruiseWarp(this.rd.altitudeRadar > BRAKING_WARP_FLOOR);
    const ls = this.landingState();
    const cmd = brakingGuidance(ls, GATE_HEIGHT, GATE_SINK);
    this.flyAccel(cmd.accel, true);
    if (this.rd.thrust <= 0 && this.phaseTime > 5) return this.fail('descent engine out');
    // The law brakes at v^2 / (2 range) all the way in; hand over to the hover once it is nearly stopped.
    const speed = Math.hypot(ls.vAlong, ls.vLeft);
    if ((speed < 6 && ls.range < 150) || ls.range < 20 || ls.vAlong < 1) {
      this.report['brakingEndRange'] = ls.range;
      this.go('approach', 600, `braking done ${ls.range.toFixed(0)} m from the target at ${ls.height.toFixed(0)} m, ${Math.hypot(ls.vAlong, ls.vLeft).toFixed(1)} m/s over the ground`);
    }
  }

  private approach(): void {
    const ls = this.landingState();
    const h = this.rd.altitudeRadar;
    // Hold about 110 m while the position error is nulled; come down to it if the braking ended high.
    const sink = clamp((110 - h) * 0.25, -8, 3);
    const fast = Math.hypot(ls.vAlong, ls.vLeft) > 6;
    const cmd = hoverGuidance(ls, { nullPosition: true, positionGain: 0.15, maxSpeed: 10, velocityGain: 0.6, maxTiltDeg: fast ? 35 : 18, sink, sinkGain: 0.8 });
    this.flyAccel(cmd.accel, true);
    if (this.rd.thrust <= 0 && this.phaseTime > 3) return this.fail('descent engine out');
    const speed = Math.hypot(ls.vAlong, ls.vLeft);
    if ((ls.range < 6 && speed < 0.6 && h < 140) || h < 60) {
      this.report['approachEndRange'] = ls.range;
      this.go('terminal', 400, `over the target (${ls.range.toFixed(1)} m off) at ${h.toFixed(0)} m`);
    }
  }

  private terminal(): void {
    const ls = this.landingState();
    const h = this.rd.altitudeRadar;
    const sink = -clamp(h / 8, 1.0, 6);
    const cmd = hoverGuidance(ls, { nullPosition: false, positionGain: 0, maxSpeed: 0, velocityGain: 0.8, maxTiltDeg: 10, sink, sinkGain: 0.9 });
    this.flyAccel(cmd.accel, true);
    let feet = 0;
    for (const p of this.v.parts) for (const m of p.modules) if (m.type === 'legs') for (const c of m.contact) if (c) feet++;
    if (feet >= 2 || this.v.contact.anyContact) {
      this.out.throttle = 0;
      this.out.pitch = this.out.yaw = this.out.roll = 0;
      this.report['descentDeltaV'] = this.dvUsedSince('descent');
      this.report['landingMiss'] = ls.range;
      this.report['touchdownSink'] = -ls.vUp;
      this.go('touchdown', 120, `contact ${ls.range.toFixed(1)} m from the target at ${(-ls.vUp).toFixed(2)} m/s`);
    }
  }

  private touchdownWait(): void {
    this.out.throttle = 0;
    if (this.hasMilestone('LUNAR_TOUCHDOWN') || this.v.situation === 'landed') {
      if (this.phaseTime < 8) return;
      this.touchdownUt = this.ut;
      this.report['descentPropellantLeftKg'] = this.propellantKg('descent-stage');
      this.go('surface', 5 * 86400, `landed; ${this.propellantKg('descent-stage').toFixed(0)} kg of descent propellant left`);
    }
  }

  private surface(): void {
    this.out.throttle = 0;
    if (Number.isNaN(this.touchdownUt)) this.touchdownUt = this.ut;
    if (!this.warpUntil(this.touchdownUt + this.opts.surfaceStay)) return;
    if (this.s.staging.lockout) return;
    // Lift-off: the ascent stage fires in the hole and leaves the descent stage behind.
    if (this.s.staging.nextStage === 5) {
      this.cmd.stage();
      return;
    }
    this.ensureSas('stability');
    this.out.throttle = 1;
    const res = this.cmd.stage();
    if (!res.ok) return this.fail(`lift-off refused: ${res.reason ?? ''}`);
    this.attitude.reset(0.3);
    this.chooseAscentPlane();
    this.go('lunarLiftoff', 120, `lift-off after ${(this.ut - this.touchdownUt).toFixed(0)} s on the surface`);
  }

  /**
   * The orbit plane to climb into: the one through the landing site that contains the direction in which
   * the ship has to leave the Moon for home - against the Moon's orbital motion, tilted out of the Moon's
   * orbit plane by RETURN_PLANE_TILT. The tilt costs nothing here and turns the entry ground track on the
   * Earth toward the recovery zones (a return in the Moon's own plane comes down along its northern or
   * southern edge).
   */
  private chooseAscentPlane(): void {
    const moon = this.bodySnap(this.moonId);
    if (!moon.orbit) return;
    const vMoon = bodyStateAt(moon, this.ut + DEPARTURE_DELAY).v;
    const s0 = v3.normalize(v3.neg(vMoon));
    const tilt = this.opts.returnPlaneTiltDeg * DEG;
    const depart = v3.normalize(v3.add(v3.scale(s0, Math.cos(tilt)), v3.scale(moon.orbit.W, Math.sin(tilt))));
    const site = v3.normalize(this.v.r);
    let n = v3.cross(site, depart);
    if (v3.len(n) < 1e-3) return;
    n = v3.normalize(n);
    // Keep the sense of the arrival orbit (retrograde or prograde about the Moon's spin axis).
    const pole = v3.normalize(moon.spinRoot);
    if (v3.dot(n, pole) * this.lunarSense < 0) n = v3.neg(n);
    this.ascentNormal = n;
    const hz = this.horizon();
    const heading = v3.cross(n, hz.up);
    const az = Math.atan2(v3.dot(heading, hz.east), v3.dot(heading, hz.north));
    this.note(`ascent plane for the departure: heading ${((((az * RAD) % 360) + 360) % 360).toFixed(1)} deg`);
  }

  private lunarLiftoff(): void {
    this.out.throttle = 1;
    if (!this.dvMarks.has('lunarAscent') && this.phaseTime > 1.5) this.markDv('lunarAscent');
    const hz = this.horizon();
    this.pointAt(hz.up, { maxRate: 6 * DEG });
    if (this.rd.altitudeRadar > 150) this.go('lunarAscent', 1200);
  }

  private lunarAscent(): void {
    const body = this.moonDef;
    this.cruiseWarp(true);
    const hz = this.horizon();
    const r = v3.len(this.v.r);
    const h = r - body.radius;
    const vr = this.rd.verticalSpeed;
    const vh = Math.sqrt(Math.max(0, this.rd.speedOrbital * this.rd.speedOrbital - vr * vr));
    const eng = this.armedEngines();
    const aT = eng && this.rd.mass > 0 ? eng.thrust / this.rd.mass : 0;
    const sinP = ascentSinPitch({ mu: body.mu, r, h, hTarget: LUNAR_ASCENT_TURN_ALTITUDE + this.padAltitudeMoon(), vr, vh, thrustAccel: aT, tauH: 60, tauV: 12, vrMin: -20, vrMax: 150, sinMin: -0.2, sinMax: 0.95 });
    const cosP = Math.sqrt(1 - sinP * sinP);
    // Into the plane chosen for the departure (westward for a retrograde orbit, the way the arrival came),
    // steering out the distance and the drift from that plane on the way up.
    const n = this.ascentNormal ?? v3.scale(v3.normalize(this.bodySnap(this.moonId).spinRoot), this.lunarSense);
    let along = v3.reject(v3.cross(n, hz.up), hz.up);
    along = v3.len(along) > 1e-6 ? v3.normalize(along) : directionOf(0, this.lunarSense < 0 ? 270 * DEG : 90 * DEG, hz);
    if (aT > 0) {
      const z = v3.dot(this.v.r, n);
      const zDot = v3.dot(this.v.v, n);
      const omega = 0.03;
      const sN = clamp(-(2 * omega * zDot + omega * omega * z) / Math.max(aT * cosP, 0.1), -0.25, 0.25);
      const side = v3.reject(n, hz.up);
      if (v3.len(side) > 1e-6) along = v3.normalize(v3.add(v3.scale(along, Math.sqrt(1 - sN * sN)), v3.scale(v3.normalize(side), sN)));
    }
    const dir = v3.add(v3.scale(along, cosP), v3.scale(hz.up, sinP));
    this.pointAt(dir, { maxRate: 8 * DEG });
    this.out.throttle = 1;
    if (this.rd.thrust <= 0 && this.phaseTime > 5) return this.fail('ascent engine out');
    if (this.rd.apoapsisAltitude >= LUNAR_ORBIT_ALTITUDE) {
      this.out.throttle = 0;
      const mu = body.mu;
      const R = body.radius;
      const ra = R + this.rd.apoapsisAltitude;
      const rp = R + this.rd.periapsisAltitude;
      const vNow = Math.sqrt(mu * (2 / ra - 2 / (ra + rp)));
      const tAp = this.rd.timeToApoapsis ?? 600;
      this.note(`ascent cut-off: ${(this.rd.periapsisAltitude / 1000).toFixed(1)} x ${(this.rd.apoapsisAltitude / 1000).toFixed(1)} km`);
      this.cruiseWarp(false);
      this.beginManeuver({
        label: 'lunarCircularise',
        initial: { ut: this.ut + tAp, prograde: Math.sqrt(mu / ra) - vNow, normal: 0, radial: 0 },
        then: () => {
          this.report['lunarAscentDeltaV'] = this.dvUsedSince('lunarAscent');
          this.correctionIndex = 0;
          this.go('lunarOrbitReturn', 3 * 86400, `back in lunar orbit ${(this.rd.periapsisAltitude / 1000).toFixed(1)} x ${(this.rd.apoapsisAltitude / 1000).toFixed(1)} km`);
        },
      });
    }
  }

  /** Elevation of the landing site above the lunar datum, from the altimeter at touchdown. */
  private padAltitudeMoon(): number {
    return Number.isNaN(this.groundOffset) ? 0 : this.groundOffset;
  }

  // ------------------------------------------------------------------------------------ the way home

  /** What a planned (or current) trajectory does at the Earth: signed perigee radius and the predicted splash point. */
  private returnInfo(patches: readonly Patch[]): ReturnInfo | null {
    const p = patches.find((x) => x.bodyId === this.rootId && (x.endReason === 'atmosphere' || x.endReason === 'impact' || x.markers.some((m) => m.kind === 'periapsis')));
    if (!p) return null;
    // Only the direct fall to the Earth counts: a leg that first climbs to an apogee beyond the Moon comes home days later.
    const apo = p.markers.find((m) => m.kind === 'apoapsis');
    const peri = p.markers.find((m) => m.kind === 'periapsis' || m.kind === 'atmosphereEntry' || m.kind === 'impact');
    if (apo && (!peri || apo.ut < peri.ut) && apo.ut - p.tStart > 3600) return null;
    const R = this.rootDef.radius;
    // Eastward (prograde) returns count positive: the entry then flies with the Earth's rotation.
    const signedPerigee = (p.conic.W.z >= 0 ? 1 : -1) * periapsisRadius(p.conic);
    const splash = predictSplash(patches, this.bodySnap(this.rootId), R, this.rootDef.atmosphere?.simTop ?? 0, this.s.simUt, entryDownRange);
    const misses = splash ? zoneMisses(this.s.surfaceTargets, this.rootId, R, splash.latitude, splash.longitude) : [];
    return { signedPerigee, splash, misses };
  }

  private perigeeResidual(patches: readonly Patch[]): number {
    const info = this.returnInfo(patches);
    if (!info) return NaN;
    return (info.signedPerigee - (this.rootDef.radius + RETURN_PERIGEE_ALTITUDE)) / 1000;
  }

  /** Distance of the predicted splash point of a return from the centre of every recovery zone, nearest (by fraction of the radius) first. */
  private splashMisses(info: ReturnInfo): { zone: SurfaceTarget; miss: number; fraction: number }[] {
    return info.misses.map((m) => ({ zone: m.zone, miss: m.distance, fraction: m.fraction }));
  }

  private lunarOrbitReturn(): void {
    this.ensureSas('stability');
    this.ensureRcs(true);
    if (this.phaseTime < 5) return;
    const period = this.rd.period;
    if (period === null) return this.fail('not in a closed lunar orbit for the return');
    this.planTei(period);
  }

  private planTei(period: number): void {
    const self = this;
    const t0 = this.ut + 300;
    const residual = (s: SimSnapshot): number => self.perigeeResidual(s.patches.planned);
    const info = (s: SimSnapshot): ReturnInfo | null => self.returnInfo(s.patches.planned);
    let chosen: { zone: SurfaceTarget; miss: number; rev: number; sun: number } | null = null;
    const plan = function* (budget: Budget): Plan {
      // 1. Where on the orbit: sweep the node round one revolution and bracket the perigee crossing.
      const samples = 30;
      let prev: { x: number; f: number } | null = null;
      let bracket: { a: { x: number; f: number }; b: { x: number; f: number } } | null = null;
      let near = { x: t0, f: Infinity };
      for (let k = 0; k <= samples && !bracket; k++) {
        const x = t0 + (k * period) / samples;
        budget.left--;
        const f = residual(yield { ut: x, prograde: TEI_NOMINAL_DV, normal: 0, radial: 0 });
        if (Number.isFinite(f)) {
          if (Math.abs(f) < Math.abs(near.f)) near = { x, f };
          if (prev && prev.f * f <= 0 && Math.abs(prev.f) < 4e5 && Math.abs(f) < 4e5) bracket = { a: prev, b: { x, f } };
          prev = { x, f };
        } else prev = null;
      }
      let base: NodeVars = { ut: bracket ? 0.5 * (bracket.a.x + bracket.b.x) : near.x, prograde: TEI_NOMINAL_DV, normal: 0, radial: 0 };
      const firstBracket = bracket;
      // The node time that puts the perigee right for the candidate's delta-v (null: it did not converge).
      const solve = function* (from: NodeVars, iterations: number, known?: typeof firstBracket): Generator<NodeVars, NodeVars | null, SimSnapshot> {
        const res = yield* solveRoot(from, { key: 'ut', residual, firstStep: 3, maxStep: period / 40, tolerance: 25, maxIterations: iterations, ...(known ? { bracket: known } : {}) }, budget);
        return res.cost <= 60 ? res.best : null;
      };
      const first = yield* solve(base, 14, firstBracket);
      if (!first) return null;
      base = first;
      // 2. Which revolution: each one later brings the Earth round by a twelfth of a turn under the entry
      //    point. Take the first one that puts a zone within reach in daylight, else the nearest.
      let best: { vars: NodeVars; zone: SurfaceTarget; miss: number; fraction: number; rev: number; sun: number } | null = null;
      let from = base;
      const score = (x: { fraction: number; sun: number }): number => x.fraction + (x.sun > 2 * DEG ? 0 : 0.35);
      for (let rev = 0; rev < TEI_MAX_REVOLUTIONS && budget.left > 70; rev++) {
        const cand = rev === 0 ? from : yield* solve({ ...from, ut: from.ut + period }, 5);
        if (!cand) {
          from = { ...from, ut: from.ut + period };
          continue;
        }
        from = cand;
        budget.left--;
        const i = info(yield cand);
        if (!i || !i.splash) continue;
        const m = self.splashMisses(i)[0];
        if (!m) continue;
        const sun = sunElevation(self.bodySnap(self.rootId), self.s.simUt, m.zone.latitude, m.zone.longitude, i.splash.entryUt + 900);
        if (!best || score({ fraction: m.fraction, sun }) < score(best)) best = { vars: cand, zone: m.zone, miss: m.miss, fraction: m.fraction, rev, sun };
        if (best.fraction < 0.3 && best.sun > 2 * DEG) break;
      }
      if (!best) return null;
      // 3. Trim the arrival time with the delta-v handle (the node time is re-solved for the perigee each time).
      const zone = best.zone;
      const ringMiss = (i: ReturnInfo | null): number => {
        const m = i ? self.splashMisses(i).find((x) => x.zone.id === zone.id) : undefined;
        return m ? m.miss : Infinity;
      };
      let cur = best.vars;
      let curMiss = best.miss;
      for (const step of [12, 4, 1.5]) {
        for (const dir of [1, -1]) {
          let moved = false;
          while (budget.left > 20 && curMiss > 50000) {
            const trial: NodeVars = { ...cur, prograde: cur.prograde + dir * step };
            if (trial.prograde < TEI_MIN_DV || trial.prograde > TEI_MAX_DV) break;
            const solved = yield* solve(trial, 6);
            if (!solved) break;
            budget.left--;
            const miss = ringMiss(info(yield solved));
            if (!(miss < curMiss)) break;
            cur = solved;
            curMiss = miss;
            moved = true;
          }
          if (moved) break;
        }
      }
      chosen = { zone, miss: curMiss, rev: best.rev, sun: best.sun };
      return cur;
    };
    this.beginManeuver({
      label: 'tei',
      initial: { ut: t0, prograde: TEI_NOMINAL_DV, normal: 0, radial: 0 },
      plan,
      reject: (s) => {
        const c = chosen as { zone: SurfaceTarget; miss: number; rev: number; sun: number } | null;
        if (c && this.zone !== c.zone) {
          this.zone = c.zone;
          this.report['teiRevolutionsWaited'] = c.rev;
          this.report['teiPlannedSplashMiss'] = c.miss;
          this.note(`return aimed at "${c.zone.name}": predicted splash ${(c.miss / 1000).toFixed(0)} km from its centre, departure ${c.rev} revolution(s) on, Sun ${(c.sun * RAD).toFixed(0)} deg up there at arrival`);
        }
        const i = this.returnInfo(s.patches.planned);
        if (!i) return 'the planned trajectory does not return to the Earth';
        if (Math.abs(i.signedPerigee - (this.rootDef.radius + RETURN_PERIGEE_ALTITUDE)) > 400000) return 'no perigee near the atmosphere';
        return null;
      },
      timeout: (TEI_MAX_REVOLUTIONS + 3) * period + 7200,
      then: () => {
        this.report['teiDeltaV'] = this.dvFlown['tei'] ?? 0;
        this.go('coastFromMoon', 3 * 86400);
      },
    });
  }

  private coastFromMoon(): void {
    if (this.v.bodyId === this.rootId) {
      if (this.s.warp.index !== 0) this.cmd.setWarpLevel(0);
      this.waitUntil = this.ut + 300;
      this.correctionIndex = 0;
      this.go('transEarth', 8 * 86400, 'outside the lunar sphere of influence');
      return;
    }
    const first = this.s.patches.current[0];
    if (first && first.endReason === 'soiExit') this.warpFor(first.tEnd - this.ut + 30, 1);
    else if (first && first.conic.period !== null) this.fail('still in lunar orbit after the injection');
    else this.warpFor(600, 1);
  }

  /**
   * What a return trajectory is off by: the vacuum perigee (km) and the predicted splash point from the
   * centre of the chosen zone, east and north (in units of `splashUnit` km).
   */
  private returnCost(patches: readonly Patch[], splashUnit = 100): { cost: number; perigee: number; miss: number; residuals: number[] | null } {
    const i = this.returnInfo(patches);
    const R = this.rootDef.radius;
    if (!i) return { cost: 1e7, perigee: NaN, miss: NaN, residuals: null };
    const peErr = (i.signedPerigee - (R + RETURN_PERIGEE_ALTITUDE)) / 1000;
    if (!i.splash) return { cost: Math.abs(peErr) + 1e4, perigee: Math.abs(i.signedPerigee) - R, miss: NaN, residuals: null };
    if (!this.zone) this.zone = i.misses[0]?.zone ?? null;
    let east = 0;
    let north = 0;
    let miss = 0;
    if (this.zone) {
      const centre = dirFromLatLon(this.zone.latitude, this.zone.longitude);
      const splash = dirFromLatLon(i.splash.latitude, i.splash.longitude);
      miss = arc(centre, splash) * R;
      const brg = bearing(centre, splash);
      east = (miss * Math.sin(brg)) / 1000 / splashUnit;
      north = (miss * Math.cos(brg)) / 1000 / splashUnit;
    }
    return { cost: Math.hypot(peErr, east, north), perigee: Math.abs(i.signedPerigee) - R, miss, residuals: [peErr, east, north] };
  }

  private transEarth(): void {
    this.ensureSas('stability');
    const alt = this.rd.altitudeAsl;
    // Corrections after leaving the Moon, at 150 000 km and at 50 000 km; then the capsule goes its own way.
    const gates = [Infinity, 150e6, 50e6];
    // (Taking over on the way home, e.g. from a QA start: a minute to settle before the first correction.)
    if (Number.isNaN(this.waitUntil)) this.waitUntil = this.ut + 60;
    if (this.correctionIndex < gates.length) {
      if (alt > gates[this.correctionIndex]! || (this.correctionIndex === 0 && !this.warpUntil(this.waitUntil))) {
        this.coastDown(gates[this.correctionIndex]!);
        return;
      }
      const index = this.correctionIndex++;
      const now = this.returnCost(this.s.patches.current, 25);
      this.note(`return now: vacuum perigee ${(now.perigee / 1000).toFixed(1)} km, splash ${(now.miss / 1000).toFixed(0)} km from the centre of "${this.zone?.name ?? '?'}"`);
      const peNow = now.residuals ? Math.abs(now.residuals[0]!) : Infinity;
      // Close in, only the perigee is worth propellant.
      if (index > 0 && peNow < 2.5) return;
      const start: NodeVars = { ut: this.ut + 240, prograde: 0, normal: 0, radial: 0 };
      const perigeeOnly = (s: SimSnapshot): number[] | null => {
        const r = this.returnCost(s.patches.planned, 25).residuals;
        return r ? [r[0]!] : null;
      };
      // Far out the splash point is cheap to move: the first correction puts the perigee right and brings
      // the predicted splash toward the zone centre as far as is worth the delta-v (each metre per second
      // is weighed like TEC_DV_WEIGHT x 25 km of miss, so the entry track is turned but not at any price).
      const withSplash = (s: SimSnapshot, cand: NodeVars): number[] | null => {
        const r = this.returnCost(s.patches.planned, 25).residuals;
        return r ? [r[0]! * 4, r[1]!, r[2]!, TEC_DV_WEIGHT * cand.prograde, TEC_DV_WEIGHT * cand.radial, TEC_DV_WEIGHT * cand.normal] : null;
      };
      const label = `tec${index + 1}`;
      this.beginManeuver({
        label,
        initial: start,
        plan: function* (budget: Budget): Plan {
          let x = start;
          if (index === 0) {
            const shaped = yield* minNormNewton(
              start,
              {
                vars: [
                  { key: 'prograde', probe: 0.05, maxStep: 30 },
                  { key: 'radial', probe: 0.05, maxStep: 30 },
                  { key: 'normal', probe: 0.05, maxStep: 30 },
                ],
                residuals: withSplash,
                tolerance: 0,
                maxIterations: 10,
              },
              budget,
            );
            x = shaped.best;
          }
          // Then the perigee exactly, with the smallest change of the handles.
          const exact = yield* minNormNewton(
            x,
            {
              vars: [
                { key: 'prograde', probe: 0.02, maxStep: 10 },
                { key: 'radial', probe: 0.02, maxStep: 10 },
                { key: 'normal', probe: 0.02, maxStep: 10 },
              ],
              residuals: perigeeOnly,
              tolerance: 0.3,
              maxIterations: 8,
            },
            budget,
          );
          return exact.cost < 30 ? exact.best : null;
        },
        describe: (s) => {
          const c = this.returnCost(s.patches.planned, 25);
          return `vacuum perigee ${(c.perigee / 1000).toFixed(1)} km, splash ${(c.miss / 1000).toFixed(0)} km from the zone centre`;
        },
        skipBelow: 0.03,
        then: () => {
          this.report[`${label}DeltaV`] = this.dvFlown[label] ?? 0;
          this.go('transEarth', 8 * 86400);
        },
      });
      return;
    }
    if (alt > CAPSULE_SEPARATION_ALTITUDE) {
      this.coastDown(CAPSULE_SEPARATION_ALTITUDE);
      return;
    }
    if (this.s.warp.index !== 0) this.cmd.setWarpLevel(0);
    this.go('entryPrep', 3600, `capsule separation coming up at ${(alt / 1000).toFixed(0)} km`);
  }

  /** Warp down toward an altitude on the inbound leg (time from the radial speed, re-estimated every tick). */
  private coastDown(altitude: number): void {
    const vr = this.rd.verticalSpeed;
    const alt = this.rd.altitudeAsl;
    if (!Number.isFinite(altitude)) {
      this.warpFor(120, 1);
      return;
    }
    if (vr >= -1) {
      this.warpFor(3600, 1);
      return;
    }
    // The fall accelerates: half the constant-speed estimate is a safe lower bound far out, and it tightens on the way in.
    this.warpFor(Math.max(0, (alt - altitude) / -vr) * 0.5 + 5, 1);
  }

  private entryPrep(): void {
    // Heat shield forward before the capsule lets go of the service stage.
    this.ensureRcs(true);
    if (this.s.navball.mode !== 'orbit' && this.s.staging.nextStage <= 7) this.cmd.setNavballMode('orbit');
    this.ensureSas('retrograde');
    const marker = this.s.navball.markers.retrograde;
    const err = Math.acos(clamp(marker.y, -1, 1));
    if (this.s.staging.nextStage === 7) {
      if ((err < 3 * DEG && v3.len(this.v.w) < 0.5 * DEG) || this.phaseTime > 240 || this.rd.altitudeAsl < 600000) {
        if (this.s.staging.lockout) return;
        this.report['ascentPropellantLeftKg'] = this.propellantKg('ascent-stage');
        this.cmd.stage();
        this.attitude.reset(0.2);
        this.note(`capsule separated at ${(this.rd.altitudeAsl / 1000).toFixed(0)} km with ${this.propellantKg('ascent-stage').toFixed(0)} kg left in the service stage`);
      }
      return;
    }
    if (this.s.staging.nextStage >= 8 && !this.s.staging.lockout) this.go('entry', 3 * 3600);
  }

  private entry(): void {
    this.ensureRcs(true);
    this.ensureSas('retrograde');
    const alt = this.rd.altitudeAsl;
    // The surface-relative velocity is what the capsule meets the air with.
    if (alt < 400000 && this.s.navball.mode !== 'surface') this.cmd.setNavballMode('surface');
    if (alt > 160000 && this.rd.verticalSpeed < 0) {
      // Coast down to the atmosphere once the capsule points the right way.
      const marker = this.s.navball.markers.retrograde;
      if (Math.acos(clamp(marker.y, -1, 1)) < 3 * DEG && v3.len(this.v.w) < 0.4 * DEG) this.coastDown(150000);
      return;
    }
    // In the atmosphere: roll only. The lift vector goes up, or down while a skip-out threatens.
    const up = this.horizon().up;
    const liftUp = entryLiftUp(this.rd.verticalSpeed, this.rd.speedSurface);
    const lift = this.s.navball.markers.liftVector ?? { x: 0, y: 0, z: -1 };
    // Wanted lift direction in the vessel frame: straight up or straight down, square to the nose.
    const upVes = quat.rotateInv(this.v.q, liftUp ? up : v3.neg(up));
    const want = { x: upVes.x, y: 0, z: upVes.z };
    const have = { x: lift.x, y: 0, z: lift.z };
    if (v3.len(want) > 1e-3 && v3.len(have) > 1e-3) {
      // Rotation about +Y that carries `have` onto `want`.
      const phi = Math.atan2(have.z * want.x - have.x * want.z, have.x * want.x + have.z * want.z);
      const a = this.attitude.alpha[1];
      const wDes = Math.sign(phi) * Math.min(20 * DEG, Math.sqrt(2 * 0.5 * a * Math.abs(phi)), Math.abs(phi) / 1.0);
      this.out.roll = Math.abs(phi) < 1.5 * DEG && Math.abs(this.v.w.y) < 0.5 * DEG ? 0 : clamp((wDes - this.v.w.y) / (a * 0.4), -1, 1);
      this.learnRoll();
    }
    if (this.rd.mach < 0.8 && alt < 40000) {
      this.out.roll = 0;
      this.report['rcsFractionAfterEntry'] = this.rd.rcsFraction ?? 0;
      this.report['ablatorFractionAfterEntry'] = this.rd.ablatorFraction ?? 0;
      this.go('chutes', 1800, `subsonic at ${(alt / 1000).toFixed(1)} km`);
    }
  }

  private prevRollRate = NaN;
  private prevRollCommand = 0;
  /** Learn the roll authority of the capsule from its answer to the roll commands (as the attitude controller does). */
  private learnRoll(): void {
    const w = this.v.w.y;
    if (!Number.isNaN(this.prevRollRate) && Math.abs(this.prevRollCommand) > 0.3 && this.dt > 0) {
      const a = (w - this.prevRollRate) / this.dt / this.prevRollCommand;
      if (a > 0) this.attitude.alpha[1] = clamp(this.attitude.alpha[1] + (a - this.attitude.alpha[1]) * 0.08, 0.004, 4);
    }
    this.prevRollRate = w;
    this.prevRollCommand = this.out.roll;
  }

  private chutes(): void {
    const alt = this.rd.altitudeAsl;
    const next = this.s.staging.nextStage;
    if (next <= 8) {
      this.ensureSas('retrograde');
      if (alt < DROGUE_ALTITUDE && this.rd.chuteEnvelope === 'safe' && !this.s.staging.lockout) {
        this.report['rcsFractionAtDrogues'] = this.rd.rcsFraction ?? 0;
        this.cmd.stage();
        this.note(`drogues at ${alt.toFixed(0)} m, Mach ${this.rd.mach.toFixed(2)}`);
      }
      return;
    }
    // Under canopy the capsule hangs as it will: no more thruster firings.
    if (this.rd.rcsEnabled) this.cmd.setRcsEnabled(false);
    if (this.rd.sasEnabled) this.cmd.setSasEnabled(false);
    if (next === 9) {
      if (alt < MAIN_ALTITUDE && this.rd.speedSurface < 90 && this.rd.chuteEnvelope === 'safe' && !this.s.staging.lockout) {
        this.cmd.stage();
        this.note(`mains at ${alt.toFixed(0)} m, ${this.rd.speedSurface.toFixed(1)} m/s`);
      }
      return;
    }
    this.go('splashdown', 1800);
  }

  private restingSince = NaN;
  private splashdown(): void {
    const resting = this.v.situation === 'splashed' || this.v.situation === 'landed';
    if (!resting) this.restingSince = NaN;
    else if (Number.isNaN(this.restingSince)) this.restingSince = this.ut;
    if (this.reached('SPLASHDOWN', resting && this.ut - this.restingSince >= 30)) {
      this.report['splashLatitudeDeg'] = this.rd.latitude * RAD;
      this.report['splashLongitudeDeg'] = this.rd.longitude * RAD;
      this.note(`splashdown at ${(this.rd.latitude * RAD).toFixed(2)} deg, ${(this.rd.longitude * RAD).toFixed(2)} deg`);
      this.phase = 'done';
      this.done = true;
    }
  }
}

/** The scripted pilot of the lunar direct-ascent mission. */
export function createMissionPilot(defs: DefLibrary, scenario: ScenarioDef, options: MissionPilotOptions = {}): MissionPilot {
  return new LunarMissionPilot(defs, scenario, options);
}
