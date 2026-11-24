/**
 * The generic interplanetary transfer pilot (ARCHITECTURE 8.4, 31.4; used by the acceptance flights and by
 * bots). From a parking orbit about the origin it plans with maneuver nodes as a player does in the map view
 * and flies every burn through the FlightSession (PlayerCommands and ControlInputs only):
 *
 *   1. window: a porkchop of Lambert arcs between the origin's and the planet's osculating orbits from the
 *      snapshot (departure burn from the parking orbit plus capture at the planet); rails warp until it;
 *   2. departure: a node at the periapsis of the departure hyperbola whose asymptote is the arc's excess
 *      velocity (on the parking orbit, the point of the smaller burn), refined by a compass search over its
 *      time and its three delta-v components on the predicted patches (an encounter with the planet at the
 *      aim periapsis; failing an encounter, the closest approach);
 *   3. corrections: after leaving the origin's sphere, and again late in the cruise, one node each that refines
 *      the arrival (for a moon of the planet: the encounter with the moon, its closest approach taken from the
 *      planet patch and the moon's orbit as the map shows them);
 *   4. at the planet: for a moon of the planet, a correction that makes the moon's periapsis; at the target, an
 *      approach correction when the periapsis is off;
 *   5. capture: a retrograde node at the periapsis about the target into a bound ellipse (apoapsis a share of the
 *      target's sphere of influence).
 * The pilot reads the snapshot and the definitions only; the burns are flown by PilotCore (SAS maneuver hold,
 * throttle to the remaining delta-v, staging on flame-out).
 */
import type { DefLibrary, ScenarioDef } from '@/core/contracts/defs';
import type { BodySnapshot, Patch, SimSnapshot } from '@/core/contracts/sim';
import { conicRadiusCrossing, timeSincePeriapsis } from '@/core/math/conic';
import { v3, type Vec3 } from '@/core/math/vec3';
import { PilotCore, type PilotLogEntry } from '../core';
import { compassSearch, minNormNewton, type Budget, type NodeVars, type Plan } from '../planner';
import {
  aimDeparture,
  bestWindow,
  bodyStateAt,
  captureDeltaV,
  captureDeltaVFromExcess,
  closestToMoon,
  ejectionBurn,
  ejectionDeltaV,
  ejectionPoint,
  meanOrbit,
  stateOnConic,
  synodic,
  timeToDirection,
  windowArc,
  type WindowArc,
  type WindowSearch,
} from './transferMath';

export interface TransferPilotOptions {
  /** The body to reach a bound orbit about: a body about the origin's parent, or a moon of one. */
  targetId: string;
  /** Wanted periapsis altitude about the target, m (default: TransferPilot.defaultPeriapsisAltitude). */
  periapsisAltitude?: number;
  /** Apoapsis of the capture ellipse as a share of the target's sphere of influence (default 0.3). */
  captureApoapsisShare?: number;
  /** Delay after the departure burn before the first correction, s (default 5 days). */
  correctionDelay?: number;
  /** Departures searched for the window, from the start on, s (default WINDOW_SPAN_SYNODIC_SHARE of the synodic period). */
  windowSpan?: number;
  onLog?: (e: PilotLogEntry) => void;
}

/** Share of the synodic period searched for the window by default (one window, not the next one). */
export const WINDOW_SPAN_SYNODIC_SHARE = 0.8;
/** The late correction is planned this long before the planet's sphere is entered: the larger of the two, s. */
export const LATE_CORRECTION_LEAD = 10 * 86400;
export const LATE_CORRECTION_CRUISE_SHARE = 0.1;
/** A periapsis about the target within this share of the wanted altitude (or 20 km) needs no approach correction. */
export const APPROACH_TOLERANCE_SHARE = 0.1;
/** For a moon target the planet flyby's periapsis is aimed at this share of the moon's orbit radius (tangent to it: the least speed relative to the moon). */
export const MOON_FLYBY_SHARE = 1;

/** The late corrections toward a moon: inside this many moon-orbit radii of the planet, at most this many, each while the moon's sphere is at least this far ahead (s). */
export const MOON_LATE_CORRECTION_RADII = 3;
export const MOON_LATE_CORRECTIONS = 3;
export const MOON_LATE_CORRECTION_MIN_LEAD = 2 * 3600;
/** A correction toward a moon first brings the closest approach to this share of the moon's sphere (then it sets the periapsis). */
export const MOON_AIM_SOI_SHARE = 0.3;

/**
 * The scales of the arrival costs (km): an encounter costs its periapsis error (less than the sphere's radius, under
 * 1e8 km for every body); a plan that meets the planet but not the target moon MOON_MISS + the miss; a plan that
 * misses NO_ENCOUNTER + the closest approach; nothing measurable NOTHING_FOUND. So a miss never beats an encounter.
 */
export const MOON_MISS = 1e8;
/** A moon whose sphere a tangent flyby crosses in less than this (s) is reached by a rendezvous after a capture at the planet. */
export const TINY_MOON_CROSSING = 3600;
/** The rendezvous meets the moon this many of its spheres away, matches its velocity there, then closes in. */
export const RENDEZVOUS_STANDOFF_SOI_SHARE = 2;
/** Closing burns flown at most before the rendezvous gives up (each trims what the last left), and the largest one, m/s. */
export const RENDEZVOUS_CLOSINGS = 4;
export const RENDEZVOUS_CLOSING_MAX = 60;
/** The velocity match is flown only within this many standoffs of the moon; otherwise the phasing is flown again (at most RENDEZVOUS_PHASINGS more times). */
export const RENDEZVOUS_MATCH_STANDOFFS = 10;
export const RENDEZVOUS_PHASINGS = 2;
/** Where in the band between a tiny moon's highest ground and its sphere the orbit is aimed (the thrusters' 0.1 m/s leaves about a kilometre of apoapsis above it). */
export const TINY_ORBIT_BAND_SHARE = 0.35;
/** Trims at most toward the circular orbit about a tiny moon (each takes what the thrusters left of the last). */
export const TINY_ORBIT_TRIMS = 8;
/** The last trim of the meeting is planned this share of the phasing orbit's period before the meeting periapsis. */
export const RENDEZVOUS_FINAL_TRIM_SHARE = 0.25;
/** The phasing orbit's period is at least this share of the moon's (its apoapsis then clears the moon's orbit). */
export const RENDEZVOUS_MIN_PERIOD_SHARE = 1.15;
/** The phasing and its trim are planned this long after the apsis, s. */
export const RENDEZVOUS_APSIS_OFFSET = 60;
export const NO_ENCOUNTER = 1e9;
export const NOTHING_FOUND = 1e12;

/** Cost of a patch list for an arrival at `bodyId` with periapsis radius `rp`: km of periapsis error, or the closest approach plus a penalty. */
function arrivalCost(patches: readonly Patch[], bodyId: string, parentId: string, rp: number, radius: number): number {
  const at = costAtBody(patches, bodyId, rp, radius);
  if (at !== null) return at;
  let best = Infinity;
  for (const p of patches) {
    if (p.bodyId !== parentId) continue;
    for (const m of p.markers) if (m.kind === 'closestApproach' && m.value !== undefined) best = Math.min(best, m.value);
  }
  return Number.isFinite(best) ? NO_ENCOUNTER + best / 1000 : NOTHING_FOUND;
}

/**
 * Periapsis radius of the first patch about `bodyId`: its conic's (the vacuum periapsis, also when the patch ends
 * at an atmosphere entry, an impact or a moon's sphere before reaching it), or null without such a patch.
 */
function periapsisAbout(patches: readonly Patch[], bodyId: string): number | null {
  for (const p of patches) if (p.bodyId === bodyId) return p.conic.p / (1 + p.conic.e);
  return null;
}

/** km of periapsis error about `bodyId` (the conic's periapsis against `rp`), or null without a patch about it. */
function costAtBody(patches: readonly Patch[], bodyId: string, rp: number, _radius: number): number | null {
  const r = periapsisAbout(patches, bodyId);
  return r === null ? null : Math.abs(r - rp) / 1000;
}

/** Signed periapsis error about `bodyId`, km (below `rp` negative; below the surface it stays continuous), or null without a patch about it. */
function signedPeriapsisError(patches: readonly Patch[], bodyId: string, rp: number, _radius: number): number | null {
  const r = periapsisAbout(patches, bodyId);
  return r === null ? null : (r - rp) / 1000;
}

export class TransferPilot extends PilotCore {
  readonly targetId: string;
  /** The target's planet (the target itself when it orbits the origin's parent). */
  readonly planetId: string;
  private originId = '';
  private starId = '';
  private readonly opts: TransferPilotOptions;
  private arc: WindowArc | null = null;
  private departedUt = NaN;
  private corrections = 0;
  private moonCorrected = false;
  private moonLateCorrections = 0;
  /** The rendezvous step for a tiny moon (rendezvousTick), and whether the target is one (decided in the planet's sphere). */
  private rv = 0;
  private closings = 0;
  private phasings = 0;
  private finalTrimmed = false;
  private circularizations = 0;
  private tiny: boolean | null = null;
  private approachCorrected = false;
  /** Delta-v of every burn flown, m/s (planned), by label. */
  get flown(): Readonly<Record<string, number>> {
    return this.dvFlown;
  }
  /** The window the pilot chose (the Lambert arc between the osculating orbits), null before the start. */
  get chosenWindow(): Readonly<WindowArc> | null {
    return this.arc;
  }

  constructor(defs: DefLibrary, scenario: ScenarioDef, opts: TransferPilotOptions) {
    super(defs, scenario);
    this.opts = opts;
    this.targetId = opts.targetId;
    const t = defs.bodies[opts.targetId];
    if (!t || t.parent === null) throw new Error(`transfer pilot: unknown or root target "${opts.targetId}"`);
    const parent = defs.bodies[t.parent]!;
    // a moon's planet is its parent when that parent is not the star
    this.planetId = parent.emission !== null || parent.parent === null ? opts.targetId : t.parent;
    if (opts.onLog) this.onLog = opts.onLog;
  }

  /** Periapsis altitude the pilot aims for about a body: 20 % above its atmosphere top, else 5 % of its radius (at least 20 km, at most 300 km). */
  static defaultPeriapsisAltitude(defs: DefLibrary, bodyId: string): number {
    const b = defs.bodies[bodyId]!;
    if (b.surface === 'none') return 0.2 * b.radius;
    const top = b.atmosphere ? 1.2 * b.atmosphere.simTop : 0;
    return Math.max(top, Math.min(300e3, Math.max(20e3, 0.05 * b.radius)));
  }

  private equatorialRadius(bodyId: string): number {
    const b = this.defs.bodies[bodyId]!;
    return b.shape ? b.shape.equatorialRadius : b.radius;
  }

  private periapsisRadius(bodyId: string): number {
    if (bodyId === this.targetId && this.tiny === true) return this.tinyOrbitRadius();
    const alt = bodyId === this.targetId && this.opts.periapsisAltitude !== undefined ? this.opts.periapsisAltitude : TransferPilot.defaultPeriapsisAltitude(this.defs, bodyId);
    return this.equatorialRadius(bodyId) + alt;
  }

  /** Periapsis radius aimed at about the planet: the target's periapsis, or for a moon a flyby that crosses the moon's orbit. */
  private planetAimRadius(): number {
    if (this.planetId === this.targetId) return this.periapsisRadius(this.planetId);
    const moon = this.bodySnap(this.targetId);
    const a = meanOrbit(moon, this.bodySnap(this.planetId), this.defs.bodies[this.planetId]!.mu).a;
    return Math.max(this.periapsisRadius(this.planetId), MOON_FLYBY_SHARE * a);
  }

  protected start(): void {
    const here = this.v.bodyId;
    if (here === this.planetId || here === this.targetId) {
      // taking over on the way in: a start on the arrival hyperbola, or a flight resumed in the planet's sphere
      this.starId = this.defs.bodies[this.planetId]!.parent ?? '';
      this.departedUt = this.s.simUt;
      this.corrections = 2;
      this.cmd.setTarget({ kind: 'body', id: here });
      this.go('cruise', Infinity, `taking over in the sphere of ${here}`);
      return;
    }
    this.originId = here;
    const origin = this.defs.bodies[this.originId]!;
    this.starId = origin.parent ?? '';
    if (!this.starId || this.defs.bodies[this.planetId]!.parent !== this.starId) {
      this.fail(`the target's planet ${this.planetId} does not orbit the origin's parent ${this.starId}`);
      return;
    }
    this.cmd.setTarget({ kind: 'body', id: this.planetId });
    const arc = bestWindow(this.windowSearch(this.s.simUt + this.departureLead() + 3600));
    if (!arc) {
      this.fail(`no window to ${this.planetId} in the searched span that a periapsis burn on this parking orbit reaches`);
      return;
    }
    this.arc = arc;
    this.go(
      'window',
      Infinity,
      `window in ${((arc.departUt - this.s.simUt) / 86400).toFixed(2)} d: transfer ${(arc.tof / 86400).toFixed(1)} d, excess ${v3.len(arc.vInfDepart).toFixed(0)} m/s out and ${v3.len(arc.vInfArrive).toFixed(0)} m/s in, departure and capture ${arc.cost.toFixed(0)} m/s`,
    );
  }

  /** Time before the departure node at which the plan is made: one parking orbit and half an hour. */
  private departureLead(): number {
    return (this.rd.period ?? 5400) + 1800;
  }

  /** The porkchop of the window, from `fromUt`: departure from the parking orbit plus the arrival at the planet. */
  private windowSearch(fromUt: number): WindowSearch {
    const O = this.bodySnap(this.originId);
    const P = this.bodySnap(this.planetId);
    const S = this.bodySnap(this.starId);
    const muS = this.defs.bodies[this.starId]!.mu;
    const muO = this.defs.bodies[this.originId]!.mu;
    const muP = this.defs.bodies[this.planetId]!.mu;
    const span = this.opts.windowSpan ?? WINDOW_SPAN_SYNODIC_SHARE * synodic(muS, meanOrbit(O, S, muS).a, meanOrbit(P, S, muS).a);
    const rp = this.planetAimRadius();
    let arriveCost: (vinf: number) => number;
    if (this.planetId === this.targetId) {
      const ra = this.captureApoapsis(this.planetId, rp);
      arriveCost = (vinf) => captureDeltaVFromExcess(muP, vinf, rp, ra);
    } else {
      // the speed relative to the moon where the flyby crosses its orbit (what its capture has to take out)
      arriveCost = (vinf) => Math.sqrt(vinf * vinf + (2 * muP) / rp) - Math.sqrt(muP / rp);
    }
    // the departure from THIS parking orbit (its plane is fixed in space): the periapsis burn toward the asymptote
    const r = this.v.r;
    const vel = this.v.v;
    const departCost = (vinf: Vec3): number => ejectionBurn(muO, r, vel, vinf, 0)?.deltaV ?? Infinity;
    return { origin: O, planet: P, parent: S, muParent: muS, departCost, arriveCost, fromUt, toUt: fromUt + span };
  }

  /** Apoapsis radius of the capture ellipse about a body with periapsis rp. */
  private captureApoapsis(bodyId: string, rp: number): number {
    const b = this.defs.bodies[bodyId]!;
    const soi = this.bodySnap(bodyId).soiRadius ?? 10 * b.radius;
    return Math.max(rp * 1.01, (this.opts.captureApoapsisShare ?? 0.3) * soi);
  }

  protected tick(): void {
    const s = this.s;
    switch (this.phase) {
      case 'window': {
        const left = this.arc!.departUt - this.departureLead() - s.simUt;
        if (left > 60) {
          this.warpFor(left);
          return;
        }
        this.setWarp(0);
        this.planDeparture();
        return;
      }
      case 'cruise': {
        if (this.v.bodyId === this.originId) {
          this.warpFor(Math.max(60, (this.soiChangeUt(s.patches.current) ?? s.simUt + 86400) - s.simUt));
          return;
        }
        if (this.v.bodyId === this.starId) {
          const next = this.soiChangeUt(s.patches.current);
          if (this.corrections === 0 && s.simUt - this.departedUt > (this.opts.correctionDelay ?? 5 * 86400)) {
            this.corrections = 1;
            this.planHeliocentricCorrection('correction');
            return;
          }
          const lateLead = next !== null ? Math.max(LATE_CORRECTION_LEAD, LATE_CORRECTION_CRUISE_SHARE * (next - this.departedUt)) : 0;
          if (this.corrections === 1 && next !== null && next - s.simUt < lateLead) {
            this.corrections = 2;
            this.planHeliocentricCorrection('late-correction');
            return;
          }
          const until = next === null ? s.simUt + 30 * 86400 : this.corrections === 1 ? next - lateLead : next;
          this.warpFor(Math.max(60, until - s.simUt) - 120);
          return;
        }
        if (this.v.bodyId === this.planetId && this.planetId !== this.targetId && this.isTinyMoon()) {
          this.rendezvousTick();
          return;
        }
        if (this.v.bodyId === this.planetId && this.planetId !== this.targetId) {
          const cost = (p: readonly Patch[]): number => arrivalCost(p, this.targetId, this.planetId, this.periapsisRadius(this.targetId), this.equatorialRadius(this.targetId));
          if (!this.moonCorrected) {
            // early, at the sphere's edge: the moon on its osculating orbit (the predictor's first closest approach of a long patch is not the pass)
            this.moonCorrected = true;
            this.cmd.setTarget({ kind: 'body', id: this.targetId });
            this.planCorrection('moon-correction', this.targetId, cost, this.moonStages(false), Infinity);
            return;
          }
          const aM = meanOrbit(this.bodySnap(this.targetId), this.body(), this.defs.bodies[this.planetId]!.mu).a;
          const near = v3.len(this.v.r) < MOON_LATE_CORRECTION_RADII * aM;
          const entry = this.soiChangeUt(s.patches.current);
          if (near && this.moonLateCorrections < MOON_LATE_CORRECTIONS && (entry === null || entry - s.simUt > MOON_LATE_CORRECTION_MIN_LEAD)) {
            // late, inside MOON_LATE_CORRECTION_RADII moon orbits: the predictor's closest approach is the pass itself;
            // again (up to MOON_LATE_CORRECTIONS) while a burn left the periapsis off and the moon's sphere is far enough
            const err = signedPeriapsisError(s.patches.current, this.targetId, this.periapsisRadius(this.targetId), this.equatorialRadius(this.targetId));
            if (err === null || Math.abs(err) * 1000 > Math.max(20e3, APPROACH_TOLERANCE_SHARE * (this.periapsisRadius(this.targetId) - this.equatorialRadius(this.targetId)))) {
              this.moonLateCorrections++;
              this.planCorrection(`moon-late-correction-${this.moonLateCorrections}`, this.targetId, cost, this.moonStages(true));
              return;
            }
            this.moonLateCorrections = MOON_LATE_CORRECTIONS;
          }
          const next = this.soiChangeUt(s.patches.current);
          const inbound = this.moonLateCorrections > 0 ? null : this.radiusTime(s.patches.current, MOON_LATE_CORRECTION_RADII * aM);
          if (next !== null || inbound !== null) this.warpFor(Math.min(next ?? Infinity, inbound ?? Infinity) - s.simUt - 60);
          else this.fail(`no encounter with ${this.targetId} after the correction`);
          return;
        }
        if (this.v.bodyId === this.targetId && this.tiny === true) {
          // the closing burn set the periapsis between the ground and the sphere: a circular orbit there
          this.planCapture();
          return;
        }
        if (this.v.bodyId === this.targetId) {
          const rp = this.periapsisRadius(this.targetId);
          const R = this.equatorialRadius(this.targetId);
          const err = costAtBody(s.patches.current, this.targetId, rp, R) ?? Infinity;
          if (!this.approachCorrected && err * 1000 > Math.max(20e3, APPROACH_TOLERANCE_SHARE * (rp - R))) {
            this.approachCorrected = true;
            // best effort: a capture at a periapsis that is off still binds the craft
            this.planCorrection('approach-correction', this.targetId, (p) => arrivalCost(p, this.targetId, '', rp, R), undefined, Infinity);
            return;
          }
          this.planCapture();
          return;
        }
        this.fail(`in the sphere of ${this.v.bodyId}, not on the way to ${this.targetId}`);
        return;
      }
      case 'orbit': {
        if (this.v.bodyId === this.targetId && this.tiny === true && this.circularizations < TINY_ORBIT_TRIMS) {
          // a tiny moon: the orbit must stay between its ground and its sphere; trims toward the circle at the orbit radius
          this.circularizations++;
          const rw = this.tinyOrbitRadius();
          const top = this.defs.bodies[this.targetId]!.radius + (this.defs.bodies[this.targetId]!.terrain?.maxElevation ?? 0);
          const soi = this.moonOrbit().soi;
          const c = s.patches.current[0]!.conic;
          const rp = c.p / (1 + c.e);
          const ra = c.e < 1 ? c.p / (1 - c.e) : Infinity;
          if (rp < top || ra > soi) {
            // above the ground: at the periapsis, the apoapsis down to it (a circle there); below it: both to the orbit radius
            const peri = s.patches.current[0]!.markers.find((m) => m.kind === 'periapsis');
            const atPeri = rp >= top && peri !== undefined && peri.ut > s.simUt + 60;
            const circle = (snap: SimSnapshot): number[] | null => {
              const p = snap.patches.planned.find((q) => q.bodyId === this.targetId && q.afterNodeId !== undefined);
              if (!p || !(p.conic.e < 1)) return null;
              const pr = p.conic.p / (1 + p.conic.e);
              const pa = p.conic.p / (1 - p.conic.e);
              return atPeri ? [(pa - rp) / 1000] : [(pr - rw) / 1000, (pa - rw) / 1000];
            };
            this.note(`about ${this.targetId}: periapsis ${(rp / 1000).toFixed(2)} km, apoapsis ${(ra / 1000).toFixed(2)} km from its centre (ground to ${(top / 1000).toFixed(2)}, sphere ${(soi / 1000).toFixed(2)}): trim to ${(rw / 1000).toFixed(2)} km`);
            this.runCorrection(`circularize-${this.circularizations}`, (snap) => Math.hypot(...(circle(snap) ?? [NOTHING_FOUND])), [circle], Infinity, '', { ut: atPeri ? peri!.ut : s.simUt + 120, tolerance: 0.1, probe: 0.02, then: () => this.go('orbit') });
            return;
          }
        }
        if (this.v.bodyId === this.targetId && this.rd.eccentricity < 1) {
          this.note(`bound about ${this.targetId}: e ${this.rd.eccentricity.toFixed(4)}, periapsis ${(this.rd.periapsisAltitude / 1000).toFixed(2)} km, apoapsis ${(this.rd.apoapsisAltitude / 1000).toFixed(2)} km`);
          this.done = true;
        } else this.fail(`not bound about ${this.targetId} after the capture (body ${this.v.bodyId}, e ${this.rd.eccentricity.toFixed(4)})`);
        return;
      }
    }
  }

  /** The time the first patch next comes in to radius `r` about its body (null when it does not, or is inside). */
  private radiusTime(patches: readonly Patch[], r: number): number | null {
    const p = patches[0];
    if (!p || v3.len(this.v.r) <= r) return null;
    const nu = conicRadiusCrossing(p.conic, r);
    if (nu === null) return null;
    const t = p.conic.tPeriapsis + timeSincePeriapsis(p.conic, -nu);
    return Number.isFinite(t) && t > this.s.simUt ? t : null;
  }

  /** The snapshot of the body the vessel is about. */
  private body(): BodySnapshot {
    return this.bodySnap(this.v.bodyId);
  }

  /** Time of the first SOI change on a patch list (null when none). */
  private soiChangeUt(patches: readonly Patch[]): number | null {
    for (const p of patches) if (p.endReason === 'soiExit' || p.endReason === 'soiEnter') return p.tEnd;
    return null;
  }

  /**
   * Cost of a heliocentric plan: for the planet itself, the arrival cost at the planet; for a moon, km of the
   * periapsis error at the moon when the plan meets it, else 1,000 + the closest approach to the moon in km along
   * the planet patch (MOON_MISS + km), else the arrival cost at the planet (NO_ENCOUNTER + its closest approach).
   */
  private heliocentricCost(patches: readonly Patch[]): number {
    if (this.planetId === this.targetId) return arrivalCost(patches, this.planetId, this.starId, this.planetAimRadius(), this.equatorialRadius(this.planetId));
    const atMoon = costAtBody(patches, this.targetId, this.periapsisRadius(this.targetId), this.equatorialRadius(this.targetId));
    if (atMoon !== null) return atMoon;
    const miss = this.moonMiss(patches);
    if (miss === null) return arrivalCost(patches, this.planetId, this.starId, this.planetAimRadius(), this.equatorialRadius(this.planetId));
    return MOON_MISS + miss / 1000;
  }

  /**
   * Closest approach to the target moon along the planned planet patch (the one after the node, else the first), m:
   * the predictor's closest-approach marker when the moon is the target, else the pilot's own, within three
   * moon-orbit radii of the periapsis, with the moon on its osculating orbit about the planet. Null without a patch
   * about the planet.
   */
  private moonMiss(patches: readonly Patch[], markers = true): number | null {
    const about = patches.filter((p) => p.bodyId === this.planetId);
    const pp = about.find((p) => p.afterNodeId !== undefined) ?? about[0];
    if (!pp) return null;
    // the predictor's own closest approach when the moon is the target (it orbits the patch's body): the ephemeris, not the osculating orbit
    let marked = Infinity;
    if (markers) for (const m of pp.markers) if (m.kind === 'closestApproach' && m.value !== undefined) marked = Math.min(marked, m.value);
    if (Number.isFinite(marked)) return marked;
    const moon = this.bodySnap(this.targetId);
    const planet = this.bodySnap(this.planetId);
    const aM = meanOrbit(moon, planet, this.defs.bodies[this.planetId]!.mu).a;
    let t0 = pp.tStart;
    let t1 = pp.tEnd;
    const nu = conicRadiusCrossing(pp.conic, 3 * aM);
    if (nu !== null) {
      const tp = pp.conic.tPeriapsis;
      const dt = Math.abs(timeSincePeriapsis(pp.conic, nu));
      if (Number.isFinite(dt)) {
        t0 = Math.max(t0, tp - dt);
        t1 = Math.min(t1, tp + dt);
      }
    }
    if (!(t1 > t0)) return null;
    return closestToMoon(pp.conic, t0, t1, moon, planet).distance;
  }

  /**
   * The moon-encounter stage of a correction: the closest approach brought to MOON_AIM_SOI_SHARE of the moon's
   * sphere, km; once the plan meets the moon, its periapsis radius about the moon stands for the closest approach
   * (an impact: negative). Null without a planet patch.
   */
  private moonApproachResidual(patches: readonly Patch[], markers: boolean): number | null {
    const soi = this.bodySnap(this.targetId).soiRadius ?? this.defs.bodies[this.targetId]!.radius * 10;
    const aim = MOON_AIM_SOI_SHARE * soi;
    const inside = signedPeriapsisError(patches, this.targetId, aim, this.equatorialRadius(this.targetId));
    if (inside !== null) return inside;
    const d = this.moonMiss(patches, markers);
    return d === null ? null : (d - aim) / 1000;
  }

  private planDeparture(): void {
    const s = this.s;
    const muO = this.defs.bodies[this.originId]!.mu;
    const prev = this.arc!;
    const arc = windowArc(this.windowSearch(s.simUt), prev.departUt, prev.tof) ?? prev;
    this.arc = arc;
    const period = this.rd.period ?? 5400;
    // aimed through the origin's sphere at the planet's centre at the arrival (the search then sets the periapsis)
    const O = this.bodySnap(this.originId);
    const S = this.bodySnap(this.starId);
    const target = bodyStateAt(this.bodySnap(this.planetId), S, arc.arriveUt).r;
    let nearDt = arc.departUt - s.simUt;
    if (nearDt < 600) nearDt += period;
    const aim = O.soiRadius !== null ? aimDeparture(muO, this.v.r, this.v.v, s.simUt, O.soiRadius, O, S, this.defs.bodies[this.starId]!.mu, target, arc.arriveUt, arc.vInfDepart, nearDt) : null;
    const burn = aim?.burn ?? ejectionBurn(muO, this.v.r, this.v.v, arc.vInfDepart, nearDt);
    let initial: NodeVars;
    if (burn) {
      let dt = burn.dt;
      while (dt < 600) dt += period;
      initial = { ut: s.simUt + dt, prograde: burn.prograde, normal: burn.normal, radial: burn.radial };
      this.note(
        `departure: ${burn.deltaV.toFixed(0)} m/s at T+${dt.toFixed(0)} s (excess ${v3.len(aim?.vInf ?? arc.vInfDepart).toFixed(0)} m/s through the sphere${aim ? `, aim closed to ${aim.residual.toFixed(3)} m/s` : ''}, plane change ${((burn.planeChange * 180) / Math.PI).toFixed(1)} deg)`,
      );
    } else {
      // the asymptote is too far out of the parking plane for a periapsis on it: its projection, then the search
      const vinf = v3.len(arc.vInfDepart);
      const rPark = v3.len(this.v.r);
      const hPark = v3.normalize(v3.cross(this.v.r, this.v.v));
      const dir = ejectionPoint(muO, rPark, vinf, arc.vInfDepart, hPark);
      initial = { ut: s.simUt + 600 + timeToDirection(muO, this.v.r, this.v.v, dir), prograde: ejectionDeltaV(muO, rPark, vinf), normal: 0, radial: 0 };
      this.note(`departure: ${initial.prograde.toFixed(0)} m/s in the parking plane (the asymptote is beyond its reach out of the plane)`);
    }
    const rp = this.planetAimRadius();
    const R = this.equatorialRadius(this.planetId);
    const planet = this.planetId;
    const star = this.starId;
    const cost = (snap: SimSnapshot): number => arrivalCost(snap.patches.planned, planet, star, rp, R);
    this.beginManeuver({
      label: 'departure',
      initial,
      plan: (budget: Budget): Plan =>
        (function* (): Plan {
          const r = yield* compassSearch(
            initial,
            {
              vars: [
                { key: 'prograde', steps: [10, 2, 0.5, 0.1, 0.02] },
                { key: 'ut', steps: [60, 15, 4, 1, 0.25] },
                { key: 'normal', steps: [20, 5, 1, 0.25, 0.05] },
                { key: 'radial', steps: [20, 5, 1, 0.25, 0.05] },
              ],
              cost,
              tolerance: Math.max(5, (0.02 * rp) / 1000),
            },
            budget,
          );
          return r.best;
        })(),
      reject: (snap) => {
        const c = cost(snap);
        return c >= NO_ENCOUNTER ? `no encounter with the planet (closest approach ${c < NOTHING_FOUND ? `${(c - NO_ENCOUNTER).toFixed(0)} km` : 'not found'})` : null;
      },
      describe: (snap) => `arrival cost ${cost(snap).toFixed(1)} km`,
      timeout: initial.ut - s.simUt + 7200,
      then: () => {
        this.departedUt = this.s.simUt;
        this.go('cruise');
      },
    });
  }

  private planHeliocentricCorrection(label: string): void {
    const cost = (snap: SimSnapshot): number => this.heliocentricCost(snap.patches.planned);
    const limit = NO_ENCOUNTER;
    this.note(`${label}: cost before ${this.heliocentricCost(this.s.patches.current).toFixed(1)}`);
    if (this.planetId === this.targetId) {
      const rp = this.planetAimRadius();
      const R = this.equatorialRadius(this.planetId);
      this.runCorrection(label, cost, [(snap) => signedPeriapsisError(snap.patches.planned, this.planetId, rp, R)], limit, `no encounter with ${this.planetId}`);
    } else this.runCorrection(label, cost, this.moonStages(false), limit, `no encounter with ${this.planetId}`);
  }

  /** The two stages of a correction toward the target moon: into its sphere, then the periapsis about it. */
  private moonStages(markers: boolean): ((snap: SimSnapshot) => number | null)[] {
    const rp = this.periapsisRadius(this.targetId);
    const R = this.equatorialRadius(this.targetId);
    return [(snap) => this.moonApproachResidual(snap.patches.planned, markers), (snap) => signedPeriapsisError(snap.patches.planned, this.targetId, rp, R)];
  }

  /** A correction toward `bodyId`; `limit`: the cost at or above which the plan is rejected (Infinity: an early correction that only brings the miss down). */
  private planCorrection(label: string, bodyId: string, costOf: (p: readonly Patch[]) => number, stages?: ((snap: SimSnapshot) => number | null)[], limit = NO_ENCOUNTER): void {
    const rp = this.periapsisRadius(bodyId);
    const R = this.equatorialRadius(bodyId);
    this.note(`${label}: arrival cost before ${costOf(this.s.patches.current).toFixed(1)} km`);
    this.runCorrection(label, (snap) => costOf(snap.patches.planned), stages ?? [(snap) => signedPeriapsisError(snap.patches.planned, bodyId, rp, R)], limit, `no encounter with ${bodyId}`);
  }

  /**
   * A correction node 15 minutes ahead: the smallest burn that removes the error of each stage in turn (Newton on
   * the stage's signed residual with the minimum-norm step, planner.ts `minNormNewton`: for the planet, the
   * periapsis error; for a moon, first the closest approach, then the periapsis about it). When the first stage
   * has nothing to measure yet (no patch about the planet), a compass search on `cost` comes first.
   */
  private runCorrection(
    label: string,
    cost: (snap: SimSnapshot) => number,
    stages: ((snap: SimSnapshot) => number | number[] | null)[],
    limit: number,
    why: string,
    opts: { ut?: number; tolerance?: number; maxDeltaV?: number; initial?: Partial<NodeVars>; probe?: number; then?: () => void } = {},
  ): void {
    const start: NodeVars = { ut: opts.ut ?? this.s.simUt + 900, prograde: 0, normal: 0, radial: 0, ...opts.initial };
    const tolerance = opts.tolerance ?? 2;
    const probe = opts.probe ?? 0.5;
    const vars = [
      { key: 'prograde' as const, probe, maxStep: 200 * probe },
      { key: 'normal' as const, probe, maxStep: 200 * probe },
      { key: 'radial' as const, probe, maxStep: 200 * probe },
    ];
    const asResiduals =
      (f: (snap: SimSnapshot) => number | number[] | null) =>
      (snap: SimSnapshot): number[] | null => {
        const e = f(snap);
        return e === null ? null : Array.isArray(e) ? e : [e];
      };
    this.beginManeuver({
      label,
      initial: start,
      plan: (budget: Budget): Plan =>
        (function* (): Plan {
          let x = start;
          for (let i = 0; i < stages.length; i++) {
            let r = yield* minNormNewton(x, { vars, residuals: asResiduals(stages[i]!), tolerance, maxIterations: 12 }, budget);
            if (!Number.isFinite(r.cost) && i === 0) {
              const c = yield* compassSearch(
                x,
                {
                  vars: [
                    { key: 'prograde', steps: [20, 5, 1, 0.25, 0.05] },
                    { key: 'normal', steps: [20, 5, 1, 0.25, 0.05] },
                    { key: 'radial', steps: [20, 5, 1, 0.25, 0.05] },
                  ],
                  cost,
                  tolerance: 50,
                },
                budget,
              );
              x = c.best;
              r = yield* minNormNewton(x, { vars, residuals: asResiduals(stages[i]!), tolerance, maxIterations: 12 }, budget);
            }
            if (Number.isFinite(r.cost)) x = r.best;
          }
          return x;
        })(),
      reject: (snap) => {
        const n = snap.nodes[0];
        if (opts.maxDeltaV !== undefined && n && Math.hypot(n.dv.prograde, n.dv.normal, n.dv.radial) > opts.maxDeltaV) return `the ${label} burn exceeds ${opts.maxDeltaV} m/s`;
        return cost(snap) >= limit ? `${why} (${stages.map((f, i) => `stage ${i + 1} residual ${JSON.stringify(f(snap))} km`).join(', ')})` : null;
      },
      describe: (snap) => `cost after ${cost(snap).toFixed(1)}`,
      skipBelow: opts.probe !== undefined ? 0.12 : 0.3,
      then: opts.then ?? ((): void => this.go('cruise')),
    });
  }

  /** Capture at the periapsis about `bodyId` (default the target) into its capture ellipse (a tiny moon: a circular orbit there). */
  private planCapture(bodyId = this.targetId, then: () => void = () => this.go('orbit')): void {
    const s = this.s;
    const p = s.patches.current[0];
    const peri = p?.markers.find((m) => m.kind === 'periapsis');
    if (!p || p.bodyId !== bodyId || !peri) {
      this.fail(`no periapsis about ${bodyId} to capture at`);
      return;
    }
    const body = this.defs.bodies[bodyId]!;
    const rp = v3.len(peri.r);
    const ra = bodyId === this.targetId && this.isTinyMoon() ? rp : this.captureApoapsis(bodyId, rp);
    const aHyp = p.conic.a;
    const dv = aHyp < 0 ? captureDeltaV(body.mu, aHyp, rp, ra) : Math.sqrt(body.mu * (2 / rp - 1 / aHyp)) - Math.sqrt(body.mu * (2 / rp - 2 / (rp + ra)));
    this.note(`capture about ${bodyId}: ${dv.toFixed(1)} m/s retrograde at periapsis ${((rp - this.equatorialRadius(bodyId)) / 1000).toFixed(2)} km`);
    if (!(dv > 0.12)) {
      then();
      return;
    }
    this.beginManeuver({
      label: bodyId === this.targetId ? 'capture' : `capture-${bodyId}`,
      initial: { ut: peri.ut, prograde: -dv, normal: 0, radial: 0 },
      trim: bodyId === this.targetId && this.isTinyMoon(),
      timeout: peri.ut - s.simUt + 7200,
      then,
    });
  }

  // ----------------------------------------------------------------------------------- the rendezvous

  /**
   * A tiny moon (a flyby crosses its sphere in less than TINY_MOON_CROSSING at the speed relative to it of a flyby
   * tangent to its orbit) is reached by a rendezvous after a capture at the planet, not by a flyby.
   */
  private isTinyMoon(): boolean {
    if (this.tiny !== null) return this.tiny;
    if (this.planetId === this.targetId) return (this.tiny = false);
    const muP = this.defs.bodies[this.planetId]!.mu;
    const aM = meanOrbit(this.bodySnap(this.targetId), this.bodySnap(this.planetId), muP).a;
    const p0 = this.s.patches.current[0];
    const vinf2 = p0 && p0.bodyId === this.planetId && p0.conic.a < 0 ? -muP / p0.conic.a : 0;
    const vrel = Math.sqrt(vinf2 + (2 * muP) / aM) - Math.sqrt(muP / aM);
    const soi = this.bodySnap(this.targetId).soiRadius ?? 10 * this.defs.bodies[this.targetId]!.radius;
    return (this.tiny = vrel > 0 && (2 * soi) / vrel < TINY_MOON_CROSSING);
  }

  /** The planned (after the node, else the first) patch about the planet. */
  private planetPatch(patches: readonly Patch[]): Patch | null {
    const about = patches.filter((p) => p.bodyId === this.planetId);
    return about.find((p) => p.afterNodeId !== undefined) ?? about[0] ?? null;
  }

  /** The moon's orbit about the planet now (normal and radius), and the standoff of the meeting. */
  private moonOrbit(): { W: Vec3; a: number; standoff: number; soi: number } {
    const M = this.bodySnap(this.targetId);
    const soi = M.soiRadius ?? 10 * this.defs.bodies[this.targetId]!.radius;
    return { W: M.orbit!.W, a: meanOrbit(M, this.bodySnap(this.planetId), this.defs.bodies[this.planetId]!.mu).a, standoff: RENDEZVOUS_STANDOFF_SOI_SHARE * soi, soi };
  }

  /** The radius of the orbit about a tiny moon: TINY_ORBIT_BAND_SHARE of the way from its highest ground to its sphere. */
  private tinyOrbitRadius(): number {
    const d = this.defs.bodies[this.targetId]!;
    const top = d.radius + (d.terrain?.maxElevation ?? 0);
    return top + TINY_ORBIT_BAND_SHARE * (this.moonOrbit().soi - top);
  }

  private rendezvousTick(): void {
    const s = this.s;
    const cur = s.patches.current[0]!;
    const orbit = this.moonOrbit();
    const none = (): number => NOTHING_FOUND;
    switch (this.rv) {
      case 0: {
        // on the hyperbola: the periapsis ON the moon's orbit (its radius, in its plane)
        this.rv = 1;
        this.cmd.setTarget({ kind: 'body', id: this.targetId });
        const onOrbit = (snap: SimSnapshot): number[] | null => {
          const p = this.planetPatch(snap.patches.planned);
          if (!p) return null;
          const rp = p.conic.p / (1 + p.conic.e);
          return [(rp - orbit.a) / 1000, (rp * v3.dot(p.conic.P, orbit.W)) / 1000];
        };
        this.note(`rendezvous: the periapsis on ${this.targetId}'s orbit (${(orbit.a / 1000).toFixed(0)} km)`);
        this.runCorrection('rendezvous-approach', (snap) => Math.hypot(...(onOrbit(snap) ?? [NOTHING_FOUND])), [onOrbit], Infinity, '', { tolerance: 1 });
        return;
      }
      case 1: {
        this.rv = 2;
        this.planCapture(this.planetId, () => this.go('cruise'));
        return;
      }
      case 2: {
        // bound about the planet: at the apoapsis, the moon's plane (the periapsis stays on the moon's orbit)
        const apo = cur.markers.find((m) => m.kind === 'apoapsis');
        if (cur.conic.e >= 1 || !apo) {
          this.fail(`not bound about ${this.planetId} for the rendezvous`);
          return;
        }
        this.rv = 3;
        const e1 = v3.normalize(v3.anyOrthogonal(orbit.W));
        const e2 = v3.cross(orbit.W, e1);
        const plane = (snap: SimSnapshot): number[] | null => {
          const p = this.planetPatch(snap.patches.planned);
          if (!p || p.afterNodeId === undefined) return null;
          const rp = p.conic.p / (1 + p.conic.e);
          const r = [(v3.dot(p.conic.W, e1) * orbit.a) / 1000, (v3.dot(p.conic.W, e2) * orbit.a) / 1000, (rp - orbit.a) / 1000];
          // after a reversal, a term that tells a reversed orbit (normal against the moon's) from a matched one
          if (reversing) r.push(((1 - v3.dot(p.conic.W, orbit.W)) * orbit.a) / 1000);
          return r;
        };
        // an orbit that runs against the moon is reversed at the apoapsis, where that is cheapest (Newton cannot leave it)
        let initial: Partial<NodeVars> = {};
        const reversing = v3.dot(cur.conic.W, orbit.W) < 0;
        if (reversing) {
          const mu = this.defs.bodies[this.planetId]!.mu;
          const ra = cur.conic.p / (1 - cur.conic.e);
          initial = { prograde: -2 * Math.sqrt(mu * (2 / ra - 1 / cur.conic.a)) };
          this.note(`rendezvous: the orbit runs against ${this.targetId}'s: reversed at the apoapsis (${(-initial.prograde!).toFixed(0)} m/s)`);
        }
        this.runCorrection('rendezvous-plane', (snap) => Math.hypot(...(plane(snap) ?? [NOTHING_FOUND])), [plane], Infinity, '', { ut: apo.ut, tolerance: 1, initial });
        return;
      }
      case 3:
      case 4: {
        // 3: phasing AT the next periapsis (it stays on the moon's orbit); 4: its trim at the phasing orbit's apoapsis.
        // Both put the moon STANDOFF ahead of the craft at the periapsis half a revolution or more after the node (the
        // moon on its osculating orbit: smooth, where the predictor's closest approach jumps between minima)
        const at = cur.markers.find((m) => m.kind === (this.rv === 3 ? 'periapsis' : 'apoapsis'));
        if (!at || cur.conic.period === null) {
          this.fail(`no ${this.rv === 3 ? 'periapsis' : 'apoapsis'} for the phasing`);
          return;
        }
        const phasing = this.rv === 3;
        const label = phasing ? 'rendezvous-phasing' : 'rendezvous-trim';
        this.rv++;
        // a minute past the apsis: a node exactly on it gives the predictor no patch after it to measure
        const ut = at.ut + RENDEZVOUS_APSIS_OFFSET;
        const M = this.bodySnap(this.targetId);
        const P = this.bodySnap(this.planetId);
        const phase = (snap: SimSnapshot): number | null => {
          const p = this.planetPatch(snap.patches.planned);
          if (!p || p.conic.period === null) return null;
          // the phasing (just past a periapsis) aims at the periapsis after next; its trim (just past the apoapsis) at the next
          let t = p.conic.tPeriapsis;
          while (t <= ut + (phasing ? 0.5 * p.conic.period : 0)) t += p.conic.period;
          const m = bodyStateAt(M, P, t).r;
          const ang = Math.atan2(v3.dot(v3.cross(p.conic.P, m), orbit.W), v3.dot(p.conic.P, m));
          return (ang * orbit.a - orbit.standoff) / 1000;
        };
        // the phasing's first guess: the period that brings the moon STANDOFF ahead after whole moon periods (Newton's
        // probes on the long capture ellipse would shift the meeting by radians)
        let initial: Partial<NodeVars> = {};
        if (phasing && M.orbit && M.orbit.period !== null) {
          const mu = this.defs.bodies[this.planetId]!.mu;
          const rp = cur.conic.p / (1 + cur.conic.e);
          const m0 = bodyStateAt(M, P, ut).r;
          const theta0 = Math.atan2(v3.dot(v3.cross(cur.conic.P, m0), orbit.W), v3.dot(cur.conic.P, m0));
          const nM = (2 * Math.PI) / M.orbit.period;
          let T = (((orbit.standoff / orbit.a - theta0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / nM;
          while (T < RENDEZVOUS_MIN_PERIOD_SHARE * M.orbit.period) T += M.orbit.period;
          const aPh = Math.cbrt(mu * (T / (2 * Math.PI)) ** 2);
          initial = { prograde: Math.sqrt(mu * (2 / rp - 1 / aPh)) - Math.sqrt(mu * (2 / rp - 1 / cur.conic.a)) };
          this.note(`rendezvous: phasing period ${(T / 3600).toFixed(2)} h (${(T / M.orbit.period).toFixed(2)} of ${this.targetId}'s), ${initial.prograde!.toFixed(1)} m/s`);
        }
        this.runCorrection(label, (snap) => Math.abs(phase(snap) ?? NOTHING_FOUND), [phase], Infinity, '', { ut, tolerance: 0.5, initial });
        return;
      }
      case 5: {
        // a quarter revolution before the meeting, a last trim on the predictor's closest approach (reliable that close;
        // the moon's osculating orbit has drifted from the ephemeris by hundreds of km over the phasing)
        if (!this.finalTrimmed) {
          const peri = cur.markers.find((m) => m.kind === 'periapsis');
          if (!peri || cur.conic.period === null) {
            this.fail('no periapsis for the meeting');
            return;
          }
          const lead = RENDEZVOUS_FINAL_TRIM_SHARE * cur.conic.period;
          if (peri.ut - s.simUt > lead + 900) {
            this.warpFor(peri.ut - lead - s.simUt);
            return;
          }
          this.finalTrimmed = true;
          const meetAt = peri.ut;
          const meet = (snap: SimSnapshot): number | null => {
            const p = this.planetPatch(snap.patches.planned);
            if (!p || p.afterNodeId === undefined) return null;
            let best: number | null = null;
            let dt = Infinity;
            for (const m of p.markers) {
              if (m.kind !== 'closestApproach' || m.value === undefined || Math.abs(m.ut - meetAt) >= dt) continue;
              dt = Math.abs(m.ut - meetAt);
              best = m.value;
            }
            return best === null ? null : (best - orbit.standoff) / 1000;
          };
          this.runCorrection('rendezvous-final-trim', (snap) => Math.abs(meet(snap) ?? NOTHING_FOUND), [meet], Infinity, '', { tolerance: 1, maxDeltaV: RENDEZVOUS_CLOSING_MAX });
          return;
        }
        // the meeting: at the closest approach, match the moon's velocity
        const cas = cur.markers.filter((m) => m.kind === 'closestApproach' && m.value !== undefined);
        if (cas.length === 0 || cur.conic.period === null) {
          this.fail(`no closest approach to ${this.targetId} for the meeting`);
          return;
        }
        const ca = cas.reduce((a, b) => (b.value! < a.value! ? b : a));
        if (ca.value! > RENDEZVOUS_MATCH_STANDOFFS * orbit.standoff) {
          if (++this.phasings > RENDEZVOUS_PHASINGS) {
            this.fail(`the rendezvous does not meet ${this.targetId}: closest approach ${(ca.value! / 1000).toFixed(1)} km after ${this.phasings - 1} phasings`);
            return;
          }
          this.note(`rendezvous: closest approach ${(ca.value! / 1000).toFixed(1)} km, too far for the match: phasing again`);
          this.rv = 3;
          this.finalTrimmed = false;
          return;
        }
        this.rv = 6;
        const craft = stateOnConic(cur.conic, ca.ut);
        const moonV = bodyStateAt(this.bodySnap(this.targetId), this.bodySnap(this.planetId), ca.ut).v;
        const dv = v3.sub(moonV, craft.v);
        const pro = v3.normalize(craft.v);
        const nrm = v3.normalize(v3.cross(craft.r, craft.v));
        const rad = v3.cross(pro, nrm);
        this.note(`rendezvous: closest approach ${(ca.value! / 1000).toFixed(1)} km in ${((ca.ut - s.simUt) / 60).toFixed(0)} min; match ${v3.len(dv).toFixed(1)} m/s`);
        this.beginManeuver({ label: 'rendezvous-match', initial: { ut: ca.ut, prograde: v3.dot(dv, pro), normal: v3.dot(dv, nrm), radial: v3.dot(dv, rad) }, then: () => this.go('cruise') });
        return;
      }
      case 6: {
        // co-orbiting outside the moon's sphere: a closing burn into it, the periapsis at the orbit radius about it
        this.rv = 7;
        this.closings++;
        const rw = this.tinyOrbitRadius();
        const close = (snap: SimSnapshot): number | null => {
          const at = periapsisAbout(snap.patches.planned, this.targetId);
          if (at !== null) return (at - rw) / 1000;
          const p = this.planetPatch(snap.patches.planned);
          let best = Infinity;
          if (p) for (const m of p.markers) if (m.kind === 'closestApproach' && m.value !== undefined) best = Math.min(best, m.value);
          return Number.isFinite(best) ? (best - rw) / 1000 : null;
        };
        this.note(`rendezvous: closing to ${(rw / 1000).toFixed(1)} km about ${this.targetId}`);
        this.runCorrection('rendezvous-closing', (snap) => Math.abs(close(snap) ?? NOTHING_FOUND), [close], Infinity, '', { ut: s.simUt + 120, tolerance: 0.1, maxDeltaV: RENDEZVOUS_CLOSING_MAX });
        return;
      }
      default: {
        // waiting for the entry into the moon's sphere; a closing burn that left it short is flown again
        const next = this.soiChangeUt(s.patches.current);
        if (next !== null) this.warpFor(next - s.simUt - 30);
        else if (this.closings < RENDEZVOUS_CLOSINGS) this.rv = 6;
        else this.fail(`no entry into the sphere of ${this.targetId} after ${this.closings} closing burns`);
      }
    }
  }
}

/** The transfer pilot for a scenario that starts in a parking orbit about the origin. */
export function createTransferPilot(defs: DefLibrary, scenario: ScenarioDef, opts: TransferPilotOptions): TransferPilot {
  return new TransferPilot(defs, scenario, opts);
}
