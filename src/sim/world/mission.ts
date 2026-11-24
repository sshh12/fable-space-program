/**
 * What a session observes of its pilot's flight beside flying it: the optional objectives (the milestone
 * rules with the flight record they read), the mission state (failed, the crew) and the lift-off time. It
 * is not hosting: the host tells it what happened, and the objective observer of `src/universe` takes it
 * over with the milestones (MIGRATION_V2 section 5; ARCHITECTURE 7.7).
 */
import type { MilestoneRecord, Patch, SimEvent, SimSnapshot, SurfaceTarget } from '@/core/contracts/sim';
import { v3 } from '@/core/math/vec3';
import { comStateOf } from '../island';
import { buildSurfaceTargets } from '../nav/surfaceTargets';
import { nextRadiusCrossing } from '../orbit/events';
import { makeOrbit } from '../orbit/kepler';
import { helmCraft, radarAltitude, structureOf } from '../vessel';
import { anyEngineBurning } from '../vessel/modules/engine';
import type { PlanSubject } from '../view/planning';
import type { ViewVessel } from '../view/snapshot';
import { MilestoneEvaluator, type MilestoneFrame, type MilestoneHost, type OrbitSummary } from './milestones';
import { FlightRecord } from './record';
import type { World } from './sim';

export class MissionWatch implements MilestoneHost {
  readonly surfaceTargets: SurfaceTarget[];
  readonly milestones: MilestoneEvaluator;
  readonly record: FlightRecord;
  failed = false;
  failureReason: string | null = null;
  crewAlive = true;
  liftoffUt: number | null = null;

  constructor(private readonly w: World) {
    this.surfaceTargets = buildSurfaceTargets(w.defs, w.scenario);
    this.milestones = new MilestoneEvaluator(w.scenario.milestones);
    this.record = new FlightRecord(w.frames, w.terrain, this.surfaceTargets);
  }

  /** The mission block of the snapshot. */
  get state(): SimSnapshot['mission'] {
    return { failed: this.failed, failureReason: this.failureReason, crewAlive: this.crewAlive };
  }

  fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.failureReason = reason;
    this.w.view.push({ type: 'missionFailed', ut: this.w.ut, vesselId: this.w.active.id, reason });
  }

  /** An event of a vessel (`isActive`: of the pilot's): what the objectives and the mission state keep of it. */
  note(ev: SimEvent, isActive: boolean): void {
    switch (ev.type) {
      case 'stageFired':
        if (isActive) {
          this.milestones.noteStageFired(ev.stageIndex);
          this.record.stageFiredUt.set(ev.stageIndex, ev.ut);
        }
        break;
      case 'clampsReleased':
        if (isActive && this.liftoffUt === null) this.liftoffUt = ev.ut;
        break;
      case 'chuteDeployed':
        if (isActive) this.milestones.noteChuteDeployed(ev.mode, this.record.chuteDeployData(this.w.active, this.w.view.focus().bodyId, ev.mode));
        break;
      case 'crewLost':
        this.crewAlive = false;
        this.fail(`Crew lost: ${ev.cause}`);
        break;
      default:
        break;
    }
  }

  /** The pilot's vessel changed its sphere of influence at `ut`; `predictedUt` is what the plan had said. */
  noteSoiChange(fromBodyId: string, toBodyId: string, ut: number, predictedUt: number | null): void {
    if (fromBodyId !== toBodyId) this.milestones.noteSoiChange(fromBodyId, toBodyId, this.w.frames.info(toBodyId).parentId === fromBodyId, ut, predictedUt);
  }

  /**
   * After a physics step (dt > 0) or a rails advance (dt = 0) of the pilot's vessel `a`: the record's peaks, the
   * milestone rules (`full`: also those that read orbit elements and patches), the crew.
   */
  observe(a: ViewVessel, dt: number, full: boolean): void {
    const v = a.vessel;
    const com = comStateOf(v);
    const comRadius = v3.len(com.r);
    const touching = this.record.observe(v, a.bodyId, dt);
    const frame: MilestoneFrame = {
      ut: this.w.ut,
      vesselId: v.id,
      bodyId: a.bodyId,
      // Altitude and vertical speed of the centre of mass (what the read-outs and the records show).
      altitude: comRadius - this.w.frames.info(a.bodyId).radius,
      verticalSpeed: v3.dot(com.v, com.r) / comRadius,
      dynamicPressure: v.aero.q,
      engineBurning: anyEngineBurning(v),
      prelaunch: v.hold === 'clamps',
      restingOnLand: v.hold === 'asleep' || v.hold === 'ground' || (v.surface === 'landed' && v.contact.anyContact && v.contact.waterSubmersion === 0),
      restingOnWater: v.surface === 'splashed',
      touching,
      nextStage: helmCraft(v).nextStage,
      stagePending: (idx: number) => helmCraft(v).pending.some((p) => p.stageIndex === idx),
    };
    if (full) this.w.ensurePatches();
    this.milestones.observe(frame, this, full);
    if (!v.crewAlive && structureOf(v).crew > 0) {
      this.crewAlive = false;
      this.fail('Crew lost');
    }
  }

  /** Times at which an armed altitude-crossing rule would be passed on the current conic (the warp ladder stops for them). */
  altitudeAlarms(a: ViewVessel, com: PlanSubject['com']): number[] {
    const armed = this.milestones.armedAltitudes(a.bodyId);
    if (armed.length === 0) return [];
    const body = this.w.frames.info(a.bodyId);
    const ut = this.w.ut;
    const o = a.orbit ?? makeOrbit(a.bodyId, body.mu, com.r, com.v, ut);
    const out: number[] = [];
    for (const x of armed) {
      const t = nextRadiusCrossing(o, body.radius + x.altitude, x.direction === 'ascending' ? 1 : -1, ut);
      if (t !== null && Number.isFinite(t)) out.push(t);
    }
    return out;
  }

  // ---------------------------------------------------------------------------- milestone host

  standardData(): Record<string, number> {
    const w = this.w;
    const a = w.view.focus();
    return this.record.standardData(a.vessel, a.bodyId, w.view.envOf(a), comStateOf(a.vessel), w.ut, { liftoffUt: this.liftoffUt, incompleteQueries: w.incompleteQueries, terrainWarpClamps: w.terrainWarpClamps, vesselCount: w.roster.length });
  }

  radarAltitude(): number {
    const a = this.w.view.focus();
    return radarAltitude(a.vessel, this.w.view.envOf(a));
  }

  orbit(): OrbitSummary {
    const a = this.w.view.focus();
    const s = comStateOf(a.vessel);
    const body = this.w.frames.info(a.bodyId);
    const o = a.orbit ?? makeOrbit(a.bodyId, body.mu, s.r, s.v, this.w.ut);
    const c = o.conic;
    const rp = c.p / (1 + c.e);
    const closed = o.period !== null;
    return { closed, periapsisAltitude: rp - body.radius, apoapsisAltitude: closed ? 2 / o.alpha - rp - body.radius : Infinity, eccentricity: c.e, inclination: c.inc, period: o.period };
  }

  currentPatches(): readonly Patch[] {
    this.w.ensurePatches();
    return this.w.plan.patches.current;
  }

  bodyRadius(bodyId: string): number {
    return this.w.frames.info(bodyId).radius;
  }

  touchdownData(): Record<string, number> {
    const a = this.w.view.focus();
    return this.record.touchdownData(a.vessel, a.bodyId, this.w.view.envOf(a));
  }

  separatedSince(stageIndex: number): number {
    return this.record.separatedSince(stageIndex);
  }

  vesselsLeftOnSurface(bodyId: string): number {
    const w = this.w;
    let n = 0;
    for (const v of w.roster) {
      if (v === w.active || v.hold === null) continue;
      const e = w.view.entry(v);
      if (e && e.bodyId === bodyId && v3.dist(v.r, w.active.r) < 5000) n++;
    }
    return n;
  }

  emit(record: MilestoneRecord): void {
    this.w.view.push({ type: 'milestone', ut: record.ut, vesselId: this.w.active.id, milestone: record });
  }
}
