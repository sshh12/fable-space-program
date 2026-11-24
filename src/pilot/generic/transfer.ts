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

/** Cost of a patch list for an arrival at `bodyId` with periapsis radius `rp`: km of periapsis error, or the closest approach plus a penalty. */
function arrivalCost(patches: readonly Patch[], bodyId: string, parentId: string, rp: number, radius: number): number {
  const at = costAtBody(patches, bodyId, rp, radius);
  if (at !== null) return at;
  let best = Infinity;
  for (const p of patches) {
    if (p.bodyId !== parentId) continue;
    for (const m of p.markers) if (m.kind === 'closestApproach' && m.value !== undefined) best = Math.min(best, m.value);
  }
  return Number.isFinite(best) ? 1e4 + best / 1000 : 1e9;
}

/** km of periapsis error on the first patch about `bodyId` (an impact: the depth below the wanted periapsis), or null without one. */
function costAtBody(patches: readonly Patch[], bodyId: string, rp: number, radius: number): number | null {
  for (const p of patches) {
    if (p.bodyId !== bodyId) continue;
    const peri = p.markers.find((m) => m.kind === 'periapsis');
    const imp = p.markers.find((m) => m.kind === 'impact');
    if (peri) return Math.abs(v3.len(peri.r) - rp) / 1000;
    if (imp) return (rp - radius) / 1000 + 1;
    return 1e3;
  }
  return null;
}

/** Signed periapsis error about `bodyId` on its first patch, km (an impact: below the surface, negative), or null without such a patch. */
function signedPeriapsisError(patches: readonly Patch[], bodyId: string, rp: number, radius: number): number | null {
  for (const p of patches) {
    if (p.bodyId !== bodyId) continue;
    const peri = p.markers.find((m) => m.kind === 'periapsis');
    if (peri) return (v3.len(peri.r) - rp) / 1000;
    if (p.markers.some((m) => m.kind === 'impact')) return -(rp - radius) / 1000 - 1;
    return null;
  }
  return null;
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
        if (this.v.bodyId === this.targetId && this.rd.eccentricity < 1) {
          this.note(`bound about ${this.targetId}: e ${this.rd.eccentricity.toFixed(4)}, periapsis ${(this.rd.periapsisAltitude / 1000).toFixed(1)} km, apoapsis ${(this.rd.apoapsisAltitude / 1000).toFixed(0)} km`);
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
   * the planet patch (the moon on its orbit about the planet), else 1e6 + the closest approach to the planet.
   */
  private heliocentricCost(patches: readonly Patch[]): number {
    if (this.planetId === this.targetId) return arrivalCost(patches, this.planetId, this.starId, this.planetAimRadius(), this.equatorialRadius(this.planetId));
    const atMoon = costAtBody(patches, this.targetId, this.periapsisRadius(this.targetId), this.equatorialRadius(this.targetId));
    if (atMoon !== null) return atMoon;
    const miss = this.moonMiss(patches);
    if (miss === null) return 1e6 + arrivalCost(patches, this.planetId, this.starId, this.planetAimRadius(), this.equatorialRadius(this.planetId));
    return 1e3 + miss / 1000;
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
        return c >= 1e4 ? `no encounter with the planet (closest approach ${c < 1e9 ? `${(c - 1e4).toFixed(0)} km` : 'not found'})` : null;
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
    const limit = this.planetId === this.targetId ? 1e4 : 1e6;
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
  private planCorrection(label: string, bodyId: string, costOf: (p: readonly Patch[]) => number, stages?: ((snap: SimSnapshot) => number | null)[], limit = 1e4): void {
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
  private runCorrection(label: string, cost: (snap: SimSnapshot) => number, stages: ((snap: SimSnapshot) => number | null)[], limit: number, why: string): void {
    const start: NodeVars = { ut: this.s.simUt + 900, prograde: 0, normal: 0, radial: 0 };
    const vars = [
      { key: 'prograde' as const, probe: 0.5, maxStep: 100 },
      { key: 'normal' as const, probe: 0.5, maxStep: 100 },
      { key: 'radial' as const, probe: 0.5, maxStep: 100 },
    ];
    const asResiduals =
      (f: (snap: SimSnapshot) => number | null) =>
      (snap: SimSnapshot): number[] | null => {
        const e = f(snap);
        return e === null ? null : [e];
      };
    this.beginManeuver({
      label,
      initial: start,
      plan: (budget: Budget): Plan =>
        (function* (): Plan {
          let x = start;
          for (let i = 0; i < stages.length; i++) {
            let r = yield* minNormNewton(x, { vars, residuals: asResiduals(stages[i]!), tolerance: 2, maxIterations: 12 }, budget);
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
              r = yield* minNormNewton(x, { vars, residuals: asResiduals(stages[i]!), tolerance: 2, maxIterations: 12 }, budget);
            }
            if (Number.isFinite(r.cost)) x = r.best;
          }
          return x;
        })(),
      reject: (snap) => (cost(snap) >= limit ? `${why} (${stages.map((f, i) => `stage ${i + 1} residual ${f(snap)?.toFixed(1) ?? 'none'} km`).join(', ')})` : null),
      describe: (snap) => `cost after ${cost(snap).toFixed(1)}`,
      skipBelow: 0.3,
      then: () => this.go('cruise'),
    });
  }

  private planCapture(): void {
    const s = this.s;
    const p = s.patches.current[0];
    const peri = p?.markers.find((m) => m.kind === 'periapsis');
    if (!p || p.bodyId !== this.targetId || !peri) {
      this.fail(`no periapsis about ${this.targetId} to capture at`);
      return;
    }
    const target = this.defs.bodies[this.targetId]!;
    const rp = v3.len(peri.r);
    const ra = this.captureApoapsis(this.targetId, rp);
    const aHyp = p.conic.a;
    const dv = aHyp < 0 ? captureDeltaV(target.mu, aHyp, rp, ra) : 0;
    this.note(`capture: ${dv.toFixed(0)} m/s retrograde at periapsis ${(rp / 1000 - this.equatorialRadius(this.targetId) / 1000).toFixed(1)} km`);
    if (!(dv > 0)) {
      this.go('orbit');
      return;
    }
    this.beginManeuver({
      label: 'capture',
      initial: { ut: peri.ut, prograde: -dv, normal: 0, radial: 0 },
      trim: false,
      timeout: peri.ut - s.simUt + 7200,
      then: () => this.go('orbit'),
    });
  }
}

/** The transfer pilot for a scenario that starts in a parking orbit about the origin. */
export function createTransferPilot(defs: DefLibrary, scenario: ScenarioDef, opts: TransferPilotOptions): TransferPilot {
  return new TransferPilot(defs, scenario, opts);
}
