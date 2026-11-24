/**
 * The generic interplanetary transfer pilot (ARCHITECTURE 8.4, 31.4; used by the acceptance flights and by
 * bots). From a parking orbit about the origin it plans with maneuver nodes as a player does in the map view
 * and flies every burn through the FlightSession (PlayerCommands and ControlInputs only):
 *
 *   1. window: the Hohmann phase angle of the target's planet against the origin from the bodies in the snapshot;
 *      rails warp until the window;
 *   2. departure: a node at the ejection point of the parking orbit with the ejection delta-v, refined by a compass
 *      search over its time and its prograde and normal delta-v on the predicted patches (an encounter with the
 *      planet at the wanted periapsis altitude; failing an encounter, the closest approach);
 *   3. correction: after leaving the origin's sphere, one node that refines the arrival periapsis;
 *   4. at the planet: for a moon of the planet, a correction that makes the encounter with the moon;
 *   5. capture: a retrograde node at the periapsis about the target into a bound ellipse (apoapsis a share of the
 *      target's sphere of influence).
 * The pilot reads the snapshot and the definitions only; the burns are flown by PilotCore (SAS maneuver hold,
 * throttle to the remaining delta-v, staging on flame-out).
 */
import type { DefLibrary, ScenarioDef } from '@/core/contracts/defs';
import type { Patch, SimSnapshot } from '@/core/contracts/sim';
import { v3 } from '@/core/math/vec3';
import { PilotCore, type PilotLogEntry } from '../core';
import { compassSearch, type Budget, type NodeVars, type Plan } from '../planner';
import { captureDeltaV, ejectionDeltaV, ejectionPoint, hohmann, meanOrbit, phaseAngle, relativeTo, timeToDirection, timeToWindow } from './transferMath';

export interface TransferPilotOptions {
  /** The body to reach a bound orbit about: a body about the origin's parent, or a moon of one. */
  targetId: string;
  /** Wanted periapsis altitude about the target, m (default: TransferPilot.defaultPeriapsisAltitude). */
  periapsisAltitude?: number;
  /** Apoapsis of the capture ellipse as a share of the target's sphere of influence (default 0.3). */
  captureApoapsisShare?: number;
  /** Delay after leaving the origin's sphere before the correction, s (default 5 days). */
  correctionDelay?: number;
  onLog?: (e: PilotLogEntry) => void;
}

/** A window passed by less than this phase (rad) is taken at once (5 deg: days for Mars, the node search absorbs it). */
export const WINDOW_PASSED_TOLERANCE = (5 * Math.PI) / 180;

/** Cost of a patch list for an arrival at `bodyId` with periapsis radius `rp`: km of periapsis error, or the closest approach plus a penalty. */
function arrivalCost(patches: readonly Patch[], bodyId: string, parentId: string, rp: number, radius: number): number {
  for (const p of patches) {
    if (p.bodyId !== bodyId) continue;
    const peri = p.markers.find((m) => m.kind === 'periapsis');
    const imp = p.markers.find((m) => m.kind === 'impact');
    if (peri) return Math.abs(v3.len(peri.r) - rp) / 1000;
    if (imp) return (rp - radius) / 1000 + 1;
    return 1e3;
  }
  let best = Infinity;
  for (const p of patches) {
    if (p.bodyId !== parentId) continue;
    for (const m of p.markers) if (m.kind === 'closestApproach' && m.value !== undefined) best = Math.min(best, m.value);
  }
  return Number.isFinite(best) ? 1e4 + best / 1000 : 1e9;
}

export class TransferPilot extends PilotCore {
  readonly targetId: string;
  /** The target's planet (the target itself when it orbits the origin's parent). */
  readonly planetId: string;
  private originId = '';
  private starId = '';
  private readonly opts: TransferPilotOptions;
  private windowUt = NaN;
  private departedUt = NaN;
  private corrected = false;
  private moonCorrected = false;
  /** Delta-v of every burn flown, m/s (planned), by label. */
  get flown(): Readonly<Record<string, number>> {
    return this.dvFlown;
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

  private periapsisRadius(bodyId: string): number {
    const b = this.defs.bodies[bodyId]!;
    const alt = bodyId === this.targetId && this.opts.periapsisAltitude !== undefined ? this.opts.periapsisAltitude : TransferPilot.defaultPeriapsisAltitude(this.defs, bodyId);
    return (b.shape ? b.shape.equatorialRadius : b.radius) + alt;
  }

  protected start(): void {
    this.originId = this.v.bodyId;
    const origin = this.defs.bodies[this.originId]!;
    this.starId = origin.parent ?? '';
    if (!this.starId || this.defs.bodies[this.planetId]!.parent !== this.starId) {
      this.fail(`the target's planet ${this.planetId} does not orbit the origin's parent ${this.starId}`);
      return;
    }
    this.cmd.setTarget({ kind: 'body', id: this.planetId });
    const w = this.nextWindow();
    this.windowUt = this.s.simUt + w.wait;
    this.go('window', Infinity, `window in ${(w.wait / 86400).toFixed(1)} d (Hohmann phase ${((w.phase * 180) / Math.PI).toFixed(1)} deg, transfer ${(w.tof / 86400).toFixed(0)} d)`);
  }

  /**
   * The next window from the bodies in the snapshot: the wait until the phase angle is the Hohmann one. The mean
   * motions make it an estimate that converges as the window nears (it is recomputed every tick of the wait); a
   * window passed by less than WINDOW_PASSED_TOLERANCE of phase is taken now (the node search absorbs it).
   */
  private nextWindow(): { wait: number; phase: number; tof: number } {
    const O = this.bodySnap(this.originId);
    const P = this.bodySnap(this.planetId);
    const S = this.bodySnap(this.starId);
    const muS = this.defs.bodies[this.starId]!.mu;
    const mo = meanOrbit(O, S, muS);
    const mp = meanOrbit(P, S, muS);
    const h = hohmann(muS, v3.len(relativeTo(O, S).r), mp.a);
    const now = phaseAngle(O, P, S);
    const rate = mp.n - mo.n;
    // phase still to go before the window (negative: passed)
    const ahead = Math.atan2(Math.sin(rate < 0 ? now - h.phase : h.phase - now), Math.cos(now - h.phase));
    const wait = ahead < 0 && ahead > -WINDOW_PASSED_TOLERANCE ? 0 : timeToWindow(now, h.phase, mo.n, mp.n);
    return { wait, phase: h.phase, tof: h.tof };
  }

  protected tick(): void {
    const s = this.s;
    switch (this.phase) {
      case 'window': {
        const lead = (this.rd.period ?? 5400) + 1800;
        // the estimate converges as the window nears
        if (this.windowUt - s.simUt < 30 * 86400) this.windowUt = s.simUt + this.nextWindow().wait;
        const left = this.windowUt - lead - s.simUt;
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
          if (!this.corrected && s.simUt - this.departedUt > (this.opts.correctionDelay ?? 5 * 86400)) {
            this.corrected = true;
            this.planCorrection('correction', this.planetId, this.starId);
            return;
          }
          const next = this.soiChangeUt(s.patches.current);
          this.warpFor(Math.max(60, (next ?? s.simUt + 30 * 86400) - s.simUt) - 120);
          return;
        }
        if (this.v.bodyId === this.planetId && this.planetId !== this.targetId) {
          if (!this.moonCorrected) {
            this.moonCorrected = true;
            this.cmd.setTarget({ kind: 'body', id: this.targetId });
            this.planCorrection('moon-correction', this.targetId, this.planetId);
            return;
          }
          const next = this.soiChangeUt(s.patches.current);
          if (next !== null) this.warpFor(next - s.simUt - 60);
          else this.fail(`no encounter with ${this.targetId} after the correction`);
          return;
        }
        if (this.v.bodyId === this.targetId) {
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

  /** Time of the first SOI change on a patch list (null when none). */
  private soiChangeUt(patches: readonly Patch[]): number | null {
    for (const p of patches) if (p.endReason === 'soiExit' || p.endReason === 'soiEnter') return p.tEnd;
    return null;
  }

  private planDeparture(): void {
    const s = this.s;
    const O = this.bodySnap(this.originId);
    const S = this.bodySnap(this.starId);
    const P = this.bodySnap(this.planetId);
    const muO = this.defs.bodies[this.originId]!.mu;
    const muS = this.defs.bodies[this.starId]!.mu;
    const h = hohmann(muS, v3.len(relativeTo(O, S).r), meanOrbit(P, S, muS).a);
    const rPark = v3.len(this.v.r);
    const vinf = Math.abs(h.vInfDepart);
    const dv = ejectionDeltaV(muO, rPark, vinf);
    const vO = relativeTo(O, S).v;
    const asymptote = h.vInfDepart >= 0 ? vO : v3.neg(vO);
    const hPark = v3.normalize(v3.cross(this.v.r, this.v.v));
    const dir = ejectionPoint(muO, rPark, vinf, asymptote, hPark);
    const ut = s.simUt + 600 + timeToDirection(muO, this.v.r, this.v.v, dir);
    const rp = this.periapsisRadius(this.planetId);
    const R = this.defs.bodies[this.planetId]!.radius;
    const planet = this.planetId;
    const star = this.starId;
    this.note(`departure: ${dv.toFixed(0)} m/s at T+${(ut - s.simUt).toFixed(0)} s (excess ${vinf.toFixed(0)} m/s)`);
    this.beginManeuver({
      label: 'departure',
      initial: { ut, prograde: dv, normal: 0, radial: 0 },
      plan: (budget: Budget): Plan =>
        (function* (): Plan {
          const r = yield* compassSearch(
            { ut, prograde: dv, normal: 0, radial: 0 },
            {
              vars: [
                { key: 'prograde', steps: [40, 10, 2, 0.5, 0.1, 0.02] },
                { key: 'ut', steps: [240, 60, 15, 4, 1, 0.25] },
                { key: 'normal', steps: [80, 20, 5, 1, 0.25, 0.05] },
              ],
              cost: (snap: SimSnapshot) => arrivalCost(snap.patches.planned, planet, star, rp, R),
              tolerance: 5,
            },
            budget,
          );
          return r.best;
        })(),
      reject: (snap) => (arrivalCost(snap.patches.planned, planet, star, rp, R) >= 1e4 ? 'no encounter with the planet' : null),
      describe: (snap) => `arrival cost ${arrivalCost(snap.patches.planned, planet, star, rp, R).toFixed(1)} km`,
      timeout: ut - s.simUt + 7200,
      then: () => {
        this.departedUt = this.s.simUt;
        this.go('cruise');
      },
    });
  }

  private planCorrection(label: string, bodyId: string, parentId: string): void {
    const s = this.s;
    const rp = this.periapsisRadius(bodyId);
    const R = this.defs.bodies[bodyId]!.radius;
    const before = arrivalCost(s.patches.current, bodyId, parentId, rp, R);
    this.note(`${label}: arrival cost before ${before.toFixed(1)} km`);
    const ut = s.simUt + 900;
    const start: NodeVars = { ut, prograde: 0, normal: 0, radial: 0 };
    this.beginManeuver({
      label,
      initial: start,
      plan: (budget: Budget): Plan =>
        (function* (): Plan {
          const r = yield* compassSearch(
            start,
            {
              vars: [
                { key: 'prograde', steps: [20, 5, 1, 0.25, 0.05, 0.01] },
                { key: 'normal', steps: [20, 5, 1, 0.25, 0.05, 0.01] },
                { key: 'radial', steps: [20, 5, 1, 0.25, 0.05, 0.01] },
              ],
              cost: (snap: SimSnapshot) => arrivalCost(snap.patches.planned, bodyId, parentId, rp, R),
              tolerance: 2,
            },
            budget,
          );
          return r.best;
        })(),
      reject: (snap) => (arrivalCost(snap.patches.planned, bodyId, parentId, rp, R) >= 1e4 ? `no encounter with ${bodyId}` : null),
      describe: (snap) => `arrival cost ${arrivalCost(snap.patches.planned, bodyId, parentId, rp, R).toFixed(1)} km`,
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
    const soi = this.bodySnap(this.targetId).soiRadius ?? 10 * target.radius;
    const rp = v3.len(peri.r);
    const ra = Math.max(rp * 1.01, (this.opts.captureApoapsisShare ?? 0.3) * soi);
    const aHyp = p.conic.a;
    const dv = aHyp < 0 ? captureDeltaV(target.mu, aHyp, rp, ra) : 0;
    this.note(`capture: ${dv.toFixed(0)} m/s retrograde at periapsis ${(rp / 1000 - target.radius / 1000).toFixed(1)} km`);
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
