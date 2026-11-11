/**
 * Generic milestone evaluator (ARCHITECTURE section 1 row 25, section 6; MilestoneTrigger in
 * src/core/contracts/defs.ts).
 *
 * One evaluator arms and fires the rules of ScenarioDef.milestones for the ACTIVE vessel. It knows no
 * milestone id and no mission: a rule is { id, trigger, after? }, every rule fires at most once, and a rule
 * is armed only when all the ids in `after` are already recorded. Each record carries the standard data
 * set of the host (MilestoneHost.standardData) plus the values of its trigger kind.
 *
 * The evaluator keeps the small amount of history its triggers need (previous altitude, peak dynamic
 * pressure, contact and rest timers, which stage-stack entries fired); the world feeds it one `observe`
 * call per physics step or rails advance.
 */
import type { MilestoneRuleDef, MilestoneTrigger } from '@/core/contracts/defs';
import type { MilestoneRecord, Patch } from '@/core/contracts/sim';

/** Dynamic pressure below this never counts as a maximum, Pa. */
const MAX_Q_MIN_PEAK = 1000;
/** The maximum is declared passed once the pressure has fallen to this fraction of the peak. */
const MAX_Q_FALL_FRACTION = 0.85;

/** State of the active vessel that the triggers read. All numbers SI. */
export interface MilestoneFrame {
  ut: number;
  vesselId: string;
  bodyId: string;
  /** Altitude above the reference radius of `bodyId`, m. */
  altitude: number;
  verticalSpeed: number;
  dynamicPressure: number;
  /** Any main engine burning (RCS excluded). */
  engineBurning: boolean;
  /** 'prelaunch' while held by launch clamps. */
  prelaunch: boolean;
  /** Resting on the solid surface (asleep or in contact below the rest speed) / floating at rest. */
  restingOnLand: boolean;
  restingOnWater: boolean;
  /** Any contact probe touching, or any buoyancy volume wet. */
  touching: boolean;
  /** Stage-stack entries fired so far on this vessel and whether delayed actions of a stage are still queued. */
  nextStage: number;
  stagePending(stageIndex: number): boolean;
}

export interface OrbitSummary {
  closed: boolean;
  periapsisAltitude: number;
  apoapsisAltitude: number;
  eccentricity: number;
  inclination: number;
  period: number | null;
}

export interface MilestoneHost {
  /** Standard data set recorded with every milestone. */
  standardData(): Record<string, number>;
  radarAltitude(): number;
  orbit(): OrbitSummary;
  currentPatches(): readonly Patch[];
  bodyRadius(bodyId: string): number;
  /** Values captured at the first contact of the current touchdown and the state of the resting vessel. */
  touchdownData(): Record<string, number>;
  /** Number of vessels that separated from the active vessel since stage `stageIndex` was fired. */
  separatedSince(stageIndex: number): number;
  /** Other vessels resting on the surface of `bodyId` within 500 m of the active vessel. */
  vesselsLeftOnSurface(bodyId: string): number;
  emit(record: MilestoneRecord): void;
}

interface RuleState {
  def: MilestoneRuleDef;
  fired: boolean;
}

interface SoiEvent {
  from: string;
  to: string;
  /** True when `to` is a child of `from` (an SOI was entered); false when the vessel left `from` for its parent. */
  entered: boolean;
  ut: number;
  predictedUt: number | null;
}

interface ChuteEvent {
  mode: 'drogue' | 'main';
  data: Record<string, number>;
}

export class MilestoneEvaluator {
  private readonly rules: RuleState[];
  private readonly recorded = new Set<string>();
  readonly records: MilestoneRecord[] = [];

  // history
  private prevBodyId: string | null = null;
  private prevAltitude = NaN;
  private wasPrelaunch = false;
  private liftoffSeen = false;
  private peakQ = 0;
  private peakQAltitude = 0;
  private peakQUt = 0;
  private maxQPassed = false;
  private restStart = NaN;
  private landedBody: string | null = null;
  private landedSince = NaN;
  private soiEvents: SoiEvent[] = [];
  private chuteEvents: ChuteEvent[] = [];
  private readonly stagesSeen = new Set<number>();

  constructor(defs: readonly MilestoneRuleDef[]) {
    const ids = new Set<string>();
    for (const d of defs) {
      if (ids.has(d.id)) throw new Error(`milestones: duplicate rule id "${d.id}"`);
      ids.add(d.id);
    }
    for (const d of defs) for (const a of d.after ?? []) if (!ids.has(a)) throw new Error(`milestones: rule "${d.id}" waits for unknown id "${a}"`);
    this.rules = defs.map((def) => ({ def, fired: false }));
  }

  /** Feed-in of edge events the world observes on the active vessel. */
  noteStageFired(stageIndex: number): void {
    this.stagesSeen.add(stageIndex);
  }
  noteSoiChange(from: string, to: string, entered: boolean, ut: number, predictedUt: number | null): void {
    this.soiEvents.push({ from, to, entered, ut, predictedUt });
  }
  noteChuteDeployed(mode: 'drogue' | 'main', data: Record<string, number>): void {
    this.chuteEvents.push({ mode, data });
  }

  private armed(r: RuleState): boolean {
    if (r.fired) return false;
    for (const a of r.def.after ?? []) if (!this.recorded.has(a)) return false;
    return true;
  }

  private fire(r: RuleState, host: MilestoneHost, ut: number, extra: Record<string, number>): void {
    r.fired = true;
    this.recorded.add(r.def.id);
    const record: MilestoneRecord = { id: r.def.id, ut, data: { ...host.standardData(), ...extra } };
    this.records.push(record);
    host.emit(record);
  }

  /** Radius-crossing times an armed altitudeCrossing rule on `bodyId` waits for (for the warp look-ahead). */
  armedAltitudes(bodyId: string): { altitude: number; direction: 'ascending' | 'descending' }[] {
    const out: { altitude: number; direction: 'ascending' | 'descending' }[] = [];
    for (const r of this.rules) {
      const t = r.def.trigger;
      if (t.kind === 'altitudeCrossing' && t.bodyId === bodyId && this.armed(r)) out.push({ altitude: t.altitude, direction: t.direction });
    }
    return out;
  }

  /**
   * Evaluate every armed rule against the state after a step or rails advance. `full` = also evaluate the
   * triggers that read orbit elements or predicted patches (the world sets it at control-tick cadence and
   * after rails advances; the edge-triggered kinds are evaluated on every call).
   */
  observe(f: MilestoneFrame, host: MilestoneHost, full: boolean): void {
    const sameBody = this.prevBodyId === f.bodyId;
    // --- history that does not depend on any rule
    if (f.prelaunch) this.wasPrelaunch = true;
    const liftoffNow = this.wasPrelaunch && !f.prelaunch && !this.liftoffSeen;
    if (liftoffNow) this.liftoffSeen = true;
    if (!this.maxQPassed && this.liftoffSeen) {
      if (f.dynamicPressure > this.peakQ) {
        this.peakQ = f.dynamicPressure;
        this.peakQAltitude = f.altitude;
        this.peakQUt = f.ut;
      } else if (this.peakQ > MAX_Q_MIN_PEAK && f.dynamicPressure < MAX_Q_FALL_FRACTION * this.peakQ) this.maxQPassed = true;
    }
    const resting = f.restingOnLand || f.restingOnWater;
    if (resting) {
      if (Number.isNaN(this.restStart)) this.restStart = f.ut;
    } else this.restStart = NaN;
    if (f.restingOnLand && !f.prelaunch) {
      if (this.landedBody !== f.bodyId || Number.isNaN(this.landedSince)) {
        this.landedBody = f.bodyId;
        this.landedSince = f.ut;
      }
    }

    for (const r of this.rules) {
      if (!this.armed(r)) continue;
      const t: MilestoneTrigger = r.def.trigger;
      switch (t.kind) {
        case 'liftoff':
          if (this.liftoffSeen) this.fire(r, host, f.ut, {});
          break;
        case 'maxQ':
          if (this.maxQPassed) this.fire(r, host, f.ut, { peakDynamicPressure: this.peakQ, peakDynamicPressureAltitude: this.peakQAltitude, peakDynamicPressureUt: this.peakQUt });
          break;
        case 'stageFired':
          if ((this.stagesSeen.has(t.stageIndex) || f.nextStage > t.stageIndex) && !f.stagePending(t.stageIndex)) {
            this.fire(r, host, f.ut, { stageIndex: t.stageIndex, vesselsSeparated: host.separatedSince(t.stageIndex) });
          }
          break;
        case 'orbit': {
          if (!full || f.bodyId !== t.bodyId || f.engineBurning || resting || f.touching || f.prelaunch) break;
          const o = host.orbit();
          if (!o.closed || o.periapsisAltitude < t.minPeriapsisAltitude) break;
          if (t.maxApoapsisAltitude !== undefined && o.apoapsisAltitude > t.maxApoapsisAltitude) break;
          if (t.maxEccentricity !== undefined && o.eccentricity > t.maxEccentricity) break;
          this.fire(r, host, f.ut, {
            periapsisAltitude: o.periapsisAltitude,
            apoapsisAltitude: o.apoapsisAltitude,
            eccentricity: o.eccentricity,
            inclinationDeg: (o.inclination * 180) / Math.PI,
            period: o.period ?? -1,
          });
          break;
        }
        case 'encounterPredicted': {
          if (!full || f.engineBurning || f.prelaunch || resting) break;
          const patches = host.currentPatches();
          for (let i = 0; i < patches.length; i++) {
            const p = patches[i]!;
            if (p.endReason !== 'soiEnter' || p.nextBodyId !== t.bodyId) continue;
            const next = patches[i + 1];
            let pe = -1;
            if (next && next.bodyId === t.bodyId) pe = next.conic.p / (1 + next.conic.e) - host.bodyRadius(t.bodyId);
            this.fire(r, host, f.ut, { predictedSoiUt: p.tEnd, predictedPeriapsisAltitude: pe });
            break;
          }
          break;
        }
        case 'soiEnter':
        case 'soiExit': {
          // Entering a body's SOI from its parent, or leaving it for the parent (entering a child is not an exit).
          const ev = this.soiEvents.find((e) => (t.kind === 'soiEnter' ? e.entered && e.to === t.bodyId : !e.entered && e.from === t.bodyId));
          if (ev) {
            this.fire(r, host, ev.ut, {
              soiUt: ev.ut,
              predictedSoiUt: ev.predictedUt ?? -1,
              soiTimeError: ev.predictedUt === null ? -1 : Math.abs(ev.ut - ev.predictedUt),
            });
          }
          break;
        }
        case 'touchdown': {
          if (f.bodyId !== t.bodyId || f.prelaunch || Number.isNaN(this.restStart)) break;
          const kindOk = t.surface === 'any' || (t.surface === 'land' ? f.restingOnLand : f.restingOnWater);
          if (!kindOk || f.ut - this.restStart < t.settleTime) break;
          this.fire(r, host, f.ut, { ...host.touchdownData(), settledFor: f.ut - this.restStart });
          break;
        }
        case 'liftoffFromSurface': {
          if (f.bodyId !== t.bodyId || this.landedBody !== t.bodyId || resting || !f.engineBurning) break;
          if (host.radarAltitude() < t.minAltitude) break;
          this.fire(r, host, f.ut, { surfaceStay: f.ut - this.landedSince, vesselsLeftOnSurface: host.vesselsLeftOnSurface(t.bodyId) });
          break;
        }
        case 'predictedPeriapsis': {
          if (!full || f.engineBurning || f.prelaunch || resting) break;
          const R = host.bodyRadius(t.bodyId);
          for (const p of host.currentPatches()) {
            if (p.bodyId !== t.bodyId) continue;
            const ahead = p.endReason === 'atmosphere' || p.endReason === 'impact' || p.markers.some((m) => m.kind === 'periapsis');
            if (!ahead) continue;
            const pe = p.conic.p / (1 + p.conic.e) - R;
            if (pe >= t.minAltitude && pe <= t.maxAltitude) {
              const entry = p.markers.find((m) => m.kind === 'atmosphereEntry');
              const extra: Record<string, number> = { predictedPeriapsisAltitude: pe };
              if (entry) {
                extra['entryUt'] = entry.ut;
                extra['entrySpeed'] = entry.value ?? -1;
                extra['entryFlightPathAngleDeg'] = ((entry.flightPathAngle ?? 0) * 180) / Math.PI;
                extra['entryLatitudeDeg'] = ((entry.latitude ?? 0) * 180) / Math.PI;
                extra['entryLongitudeDeg'] = ((entry.longitude ?? 0) * 180) / Math.PI;
              }
              this.fire(r, host, f.ut, extra);
            }
            break;
          }
          break;
        }
        case 'altitudeCrossing': {
          if (f.bodyId !== t.bodyId || !sameBody || Number.isNaN(this.prevAltitude)) break;
          const crossed = t.direction === 'ascending' ? this.prevAltitude < t.altitude && f.altitude >= t.altitude : this.prevAltitude > t.altitude && f.altitude <= t.altitude;
          if (crossed) this.fire(r, host, f.ut, { crossingAltitude: t.altitude });
          break;
        }
        case 'chuteDeployed': {
          const ev = this.chuteEvents.find((e) => e.mode === t.mode);
          if (ev) this.fire(r, host, f.ut, ev.data);
          break;
        }
      }
    }
    // Edge events are consumed by the rules armed at the time they happened.
    this.soiEvents.length = 0;
    this.chuteEvents.length = 0;
    if (!resting && f.engineBurning && this.landedBody !== null && !f.touching) {
      // Airborne again under thrust: the stay is over once the lift-off rules have had their chance.
      if (host.radarAltitude() > 1000) this.landedBody = null;
    }
    this.prevBodyId = f.bodyId;
    this.prevAltitude = f.altitude;
  }

  /** Hashable summary of the evaluator state. */
  stateForHash(): unknown[] {
    return [this.records.map((r) => [r.id, r.ut]), this.peakQ, this.liftoffSeen, this.maxQPassed, this.landedBody ?? '', [...this.stagesSeen].sort((a, b) => a - b)];
  }
}
