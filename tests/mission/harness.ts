/**
 * Shared harness of the headless mission tests: the real Sim on the real baked tiles (fs tile source; a
 * missing tile set throws, nothing here ever falls back to synthetic terrain), the scripted pilot (or a
 * recorded input log), and an observer that measures at every control tick what the gates of
 * docs/ARCHITECTURE.md 18.1 need beyond the milestone records:
 *
 *  - clearance between vessels after every separation (the vessel facade's query, through SimWorld);
 *  - terrain residency under the vessel for the whole final descent to the lunar surface;
 *  - one revolution of the parking orbit on rails against Kepler;
 *  - the Moon SOI entry time as it was predicted an hour and more before;
 *  - the 600 s stay on the lunar surface (still landed, not creeping);
 *  - resources never negative, parachutes never failed, no part lost outside staging;
 *  - the wall time of every simulation step in the last 60 s before the lunar touchdown and the splashdown;
 *  - the delta-v left in each stage when it was dropped.
 *
 * The observer only reads `peek()` snapshots, `SimWorld.clearance` and `TerrainProvider.residency`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DefLibrary, ScenarioDef } from '@/core/contracts/defs';
import type { MilestoneRecord, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider, TileSource } from '@/core/contracts/terrain';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { createMissionPilot, replayHeadless, runHeadless, SLOPPY_PITCH_PROGRAMME, type InputLogEntry, type MissionPilotOptions, type PilotLogEntry, type RunContext, type RunResult } from '@/pilot';
import { createSim, type DebrisFate, type SimWorld, type WorldStats } from '@/sim';
import { makeOrbit, propagate, type Orbit } from '@/sim/orbit';
import { scaleEngineThrust } from '../../tools/sim/flyMission';
import { createRealTerrain, delayedSource, loadLibrary, repoRoot, tilesRoot } from '../../tools/sim/realWorld';

export { delayedSource, loadLibrary, repoRoot };

/** Seconds after a separation during which the clearance of the new vessels is followed. */
export const CLEARANCE_WINDOW = 30;
/** The separation springs and motors need this long to open a gap (sim-vessel hand-off: positive within 0.5 s). */
export const CLEARANCE_SETTLE = 0.5;
/** Radar altitude below which the approach to the landing target counts as the final descent, m. */
export const FINAL_DESCENT_ALTITUDE = 2000;
/** Radius of the mission disc about the landing target (the touchdown gate of ARCHITECTURE 18.1), m. */
export const TARGET_DISC_RADIUS = 1500;
export const STEP_WINDOW_SECONDS = 60;
export const SURFACE_STAY_SECONDS = 600;

export interface PairClearance {
  a: string;
  b: string;
  /** Seconds after the separation from which the distance stayed positive. */
  positiveFrom: number;
  /** Smallest distance between CLEARANCE_SETTLE and CLEARANCE_WINDOW after the separation, m. */
  minimum: number;
  samples: number;
}

export interface SeparationRecord {
  ut: number;
  met: number;
  /** `staging.nextStage` when the new vessels appeared (the stage just fired is one less). */
  stagesFired: number;
  newVessels: string[];
  pairs: PairClearance[];
}

export interface StageDrop {
  /** Index of the stage whose delta-v vanished with the staging, its label, and what it could still have delivered. */
  stageIndex: number;
  label: string;
  deltaVLeft: number;
  propellantFractionLeft: number | null;
  met: number;
}

export interface Observations {
  separations: SeparationRecord[];
  /**
   * The final descent (below FINAL_DESCENT_ALTITUDE of radar altitude until first contact), per control tick:
   * ticks on which less than the available data level was resident / the full-detail surface was not final,
   * the lowest resident level of the whole descent (it starts kilometres out, where the regional data is
   * coarser), and the same over the ticks within TARGET_DISC_RADIUS of the landing target, where the
   * deepest level is on offer.
   */
  finalDescent: { ticks: number; notResident: number; notComplete: number; minResidentLevel: number; availableLevel: number; startRadar: number; startDistance: number; discTicks: number; discMinResidentLevel: number; discMinAvailableLevel: number };
  kepler: { checked: boolean; period: number; maxError: number; closureError: number; samples: number };
  /** Predicted Moon SOI entry time as read from the patches at least an hour before the entry; null when never seen. */
  soiPredictedEarlier: number | null;
  surfaceStay: { contactUt: number; observedFor: number; leftEarly: boolean; maxDrift: number; maxTiltDeg: number };
  /** Most negative resource amount seen in the active vessel, kg (0 when none). */
  mostNegativeResource: number;
  chuteFailed: boolean;
  /** Parts destroyed and joints broken on the vessel that was being flown at the time (none in a clean mission). */
  structuralEvents: { met: number; type: string; partId: string }[];
  /** Step wall times, ms, in the last STEP_WINDOW_SECONDS before first contact with the Moon / the sea. */
  stepsBeforeLunarContact: Float32Array | null;
  stepsBeforeSplash: Float32Array | null;
  stageDrops: StageDrop[];
  /** Osculating perigee altitude at the entry interface, m. */
  perigeeAtInterface: number;
  /** Largest tilt from the vertical while floating before the splashdown record, degrees. */
  maxFloatTiltDeg: number;
  peakGAfterInterface: number;
}

const active = (s: SimSnapshot): VesselSnapshot => s.vessels.find((v) => v.id === s.activeVesselId)!;

const comOf = (v: VesselSnapshot): { r: Vec3; v: Vec3 } => ({ r: v3.add(v.r, quat.rotate(v.q, v.comLocal)), v: v3.add(v.v, quat.rotate(v.q, v3.cross(v.w, v.comLocal))) });

/** Unit direction of a vessel in the body-fixed frame of the body it is at. */
function fixedDir(s: SimSnapshot, v: VesselSnapshot): Vec3 {
  const body = s.bodies.find((b) => b.id === v.bodyId)!;
  return v3.normalize(quat.rotateInv(body.qFixedToRoot, v.r));
}

interface Young {
  id: string;
  name: string;
  bornUt: number;
  record: SeparationRecord;
}

interface PairState extends PairClearance {
  bornUt: number;
  lastNonPositive: number;
}

class FlightObserver {
  readonly obs: Observations = {
    separations: [],
    finalDescent: { ticks: 0, notResident: 0, notComplete: 0, minResidentLevel: Infinity, availableLevel: -1, startRadar: NaN, startDistance: NaN, discTicks: 0, discMinResidentLevel: Infinity, discMinAvailableLevel: Infinity },
    kepler: { checked: false, period: NaN, maxError: 0, closureError: NaN, samples: 0 },
    soiPredictedEarlier: null,
    surfaceStay: { contactUt: NaN, observedFor: 0, leftEarly: false, maxDrift: 0, maxTiltDeg: 0 },
    mostNegativeResource: 0,
    chuteFailed: false,
    structuralEvents: [],
    stepsBeforeLunarContact: null,
    stepsBeforeSplash: null,
    stageDrops: [],
    perigeeAtInterface: NaN,
    maxFloatTiltDeg: 0,
    peakGAfterInterface: 0,
  };

  private readonly known = new Set<string>();
  private young: Young[] = [];
  private readonly pairs = new Map<string, PairState>();
  private keplerRef: { ut: number; orbit: Orbit } | null = null;
  private readonly soiSamples: { ut: number; predicted: number }[] = [];
  private surfaceRef: { ut: number; fixed: Vec3; radius: number } | null = null;
  private surfaceDone = false;
  private landedOnTarget = false;
  private splashed = false;
  private prevStages: { dv: number; label: string; fraction: number | null }[] = [];
  private prevNextStage = -1;
  private readonly seenEvents = new Set<string>();
  private interfaceSeen = false;
  private started = false;

  constructor(
    private readonly defs: DefLibrary,
    private readonly scenario: ScenarioDef,
    private readonly sim: SimWorld,
    private readonly terrain: TerrainProvider,
  ) {}

  /** The record of the scenario's first rule of a trigger kind (on a body, when given): looked up by what the rule is, not by a name. */
  private has(s: SimSnapshot, kind: string, bodyId?: string): MilestoneRecord | undefined {
    const rule = this.scenario.milestones.find((m) => m.trigger.kind === kind && (bodyId === undefined || ('bodyId' in m.trigger && m.trigger.bodyId === bodyId)));
    return rule ? s.milestones.find((m) => m.id === rule.id) : undefined;
  }

  onTick(s: SimSnapshot, ctx: RunContext): void {
    const a = active(s);
    const rd = s.readouts;
    if (!this.started) {
      this.started = true;
      for (const v of s.vessels) this.known.add(v.id);
      this.prevNextStage = s.staging.nextStage;
    }
    this.separations(s, a);
    this.events(s, a);
    this.stages(s);
    this.resources(a);
    this.kepler(s, a);
    this.soi(s, a);
    this.descentAndStay(s, a, ctx);
    // Entry and water.
    if (a.bodyId === this.defs.rootBodyId) {
      const entry = this.has(s, 'altitudeCrossing', a.bodyId);
      if (entry && !this.interfaceSeen) {
        this.interfaceSeen = true;
        this.obs.perigeeAtInterface = rd.periapsisAltitude;
      }
      if (this.interfaceSeen && rd.gLoad > this.obs.peakGAfterInterface) this.obs.peakGAfterInterface = rd.gLoad;
      // First touch of the water after the entry (the situation turns 'splashed' once the capsule floats).
      if (this.interfaceSeen && !this.splashed && (a.contact.waterSubmersion > 0 || a.situation === 'splashed')) {
        this.splashed = true;
        this.obs.stepsBeforeSplash = ctx.recentStepMs(STEP_WINDOW_SECONDS);
      }
      if (a.situation === 'splashed') {
        const tilt = (rd.tiltFromVertical * 180) / Math.PI;
        if (tilt > this.obs.maxFloatTiltDeg) this.obs.maxFloatTiltDeg = tilt;
      }
    }
  }

  private separations(s: SimSnapshot, a: VesselSnapshot): void {
    const born: VesselSnapshot[] = [];
    for (const v of s.vessels) {
      if (this.known.has(v.id)) continue;
      this.known.add(v.id);
      born.push(v);
    }
    if (born.length > 0) {
      const record: SeparationRecord = { ut: s.simUt, met: s.readouts.met, stagesFired: s.staging.nextStage, newVessels: born.map((v) => v.name), pairs: [] };
      this.obs.separations.push(record);
      for (const v of born) this.young.push({ id: v.id, name: v.name, bornUt: s.simUt, record });
    }
    if (this.young.length === 0) return;
    this.young = this.young.filter((y) => s.simUt - y.bornUt <= CLEARANCE_WINDOW);
    const seen = new Set<string>();
    for (const y of this.young) {
      for (const o of s.vessels) {
        if (o.id === y.id) continue;
        // A pair is followed when one member is the stack that flies on, or both come from recent separations.
        const other = this.young.find((z) => z.id === o.id);
        if (o.id !== a.id && y.id !== a.id && !other) continue;
        const key = y.id < o.id ? `${y.id}|${o.id}` : `${o.id}|${y.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let p = this.pairs.get(key);
        if (!p) {
          // The pair exists as two bodies from the later of the two separations on.
          const younger = other && other.bornUt > y.bornUt ? other : y;
          p = { a: y.name, b: o.name, positiveFrom: 0, minimum: Infinity, samples: 0, bornUt: younger.bornUt, lastNonPositive: -1 };
          this.pairs.set(key, p);
          younger.record.pairs.push(p);
        }
        const age = s.simUt - p.bornUt;
        if (age > CLEARANCE_WINDOW) continue;
        const d = this.sim.clearance(y.id, o.id);
        if (d === null) continue;
        p.samples++;
        if (!(d > 0)) p.lastNonPositive = age;
        p.positiveFrom = p.lastNonPositive < 0 ? 0 : p.lastNonPositive;
        if (age >= CLEARANCE_SETTLE && d < p.minimum) p.minimum = d;
      }
    }
  }

  /** New events since the last tick (the queue keeps its latest entries; none is drained here). */
  private events(s: SimSnapshot, a: VesselSnapshot): void {
    for (let i = s.events.length - 1; i >= 0; i--) {
      const e = s.events[i]!;
      if (e.ut < s.simUt - 2) break;
      if (e.type !== 'partDestroyed' && e.type !== 'jointBroken' && e.type !== 'chuteFailed') continue;
      const key = `${e.ut}|${e.type}|${e.vesselId}|${e.partId}`;
      if (this.seenEvents.has(key)) continue;
      this.seenEvents.add(key);
      if (e.type === 'chuteFailed') this.obs.chuteFailed = true;
      else if (e.vesselId === a.id) this.obs.structuralEvents.push({ met: s.readouts.met, type: e.type, partId: e.partId });
    }
  }

  private stages(s: SimSnapshot): void {
    const next = s.staging.nextStage;
    const now = s.staging.stages.map((x) => ({ dv: x.deltaVVac, label: x.label, fraction: x.propellantFraction }));
    if (next !== this.prevNextStage) {
      for (let i = 0; i < this.prevStages.length; i++) {
        const before = this.prevStages[i]!;
        const after = now[i];
        // A stage that could still thrust before the staging and cannot any more went overboard with what it had left.
        if (before.dv > 0.5 && (!after || after.dv < 1e-6) && !this.obs.stageDrops.some((d) => d.stageIndex === i)) {
          this.obs.stageDrops.push({ stageIndex: i, label: before.label, deltaVLeft: before.dv, propellantFractionLeft: before.fraction, met: s.readouts.met });
        }
      }
      this.prevNextStage = next;
    }
    this.prevStages = now;
  }

  private resources(a: VesselSnapshot): void {
    for (const p of a.parts) {
      for (const k in p.resources) {
        const amount = p.resources[k]!;
        if (amount < this.obs.mostNegativeResource) this.obs.mostNegativeResource = amount;
      }
      for (const m of p.modules) if (m.type === 'parachute' && m.state === 'failed') this.obs.chuteFailed = true;
    }
  }

  private kepler(s: SimSnapshot, a: VesselSnapshot): void {
    const k = this.obs.kepler;
    if (k.checked || !this.has(s, 'orbit', this.defs.rootBodyId) || a.bodyId !== this.defs.rootBodyId) return;
    if (a.translationMode !== 'rails') {
      this.keplerRef = null;
      k.maxError = 0;
      k.samples = 0;
      return;
    }
    const com = comOf(a);
    if (!this.keplerRef) {
      const orbit = makeOrbit(a.bodyId, this.defs.bodies[a.bodyId]!.mu, com.r, com.v, s.simUt);
      if (orbit.period === null) return;
      this.keplerRef = { ut: s.simUt, orbit };
      k.period = orbit.period;
      return;
    }
    const error = v3.dist(com.r, propagate(this.keplerRef.orbit, s.simUt).r);
    if (error > k.maxError) k.maxError = error;
    k.samples++;
    if (s.simUt - this.keplerRef.ut >= k.period) {
      k.closureError = error;
      k.checked = true;
    }
  }

  private soi(s: SimSnapshot, a: VesselSnapshot): void {
    if (this.scenario.target === null || a.bodyId !== this.defs.rootBodyId) return;
    const first = s.patches.current[0];
    if (!first || first.endReason !== 'soiEnter' || first.nextBodyId !== this.scenario.target) return;
    const last = this.soiSamples[this.soiSamples.length - 1];
    if (!last || Math.abs(last.predicted - first.tEnd) > 1e-3) this.soiSamples.push({ ut: s.simUt, predicted: first.tEnd });
  }

  /** The prediction that stood an hour before `soiUt`. */
  predictedBefore(soiUt: number): number | null {
    let best: number | null = null;
    for (const x of this.soiSamples) if (x.ut <= soiUt - 3600) best = x.predicted;
    return best;
  }

  private descentAndStay(s: SimSnapshot, a: VesselSnapshot, ctx: RunContext): void {
    const target = this.scenario.target;
    if (target === null || a.bodyId !== target) return;
    const rd = s.readouts;
    if (!this.landedOnTarget) {
      if (a.contact.anyContact || a.situation === 'landed') {
        this.landedOnTarget = true;
        this.obs.surfaceStay.contactUt = s.simUt;
        this.obs.stepsBeforeLunarContact = ctx.recentStepMs(STEP_WINDOW_SECONDS);
      } else if (rd.altitudeRadar < FINAL_DESCENT_ALTITUDE) {
        const f = this.obs.finalDescent;
        const distance = rd.landingTarget ? rd.landingTarget.distance : Infinity;
        if (f.ticks === 0) {
          f.startRadar = rd.altitudeRadar;
          f.startDistance = distance;
        }
        const res = this.terrain.residency(a.bodyId, fixedDir(s, a));
        f.ticks++;
        if (res.residentLevel < res.availableLevel) f.notResident++;
        if (!res.complete || !s.terrain.complete) f.notComplete++;
        if (res.residentLevel < f.minResidentLevel) f.minResidentLevel = res.residentLevel;
        f.availableLevel = res.availableLevel;
        if (distance <= TARGET_DISC_RADIUS) {
          f.discTicks++;
          if (res.residentLevel < f.discMinResidentLevel) f.discMinResidentLevel = res.residentLevel;
          if (res.availableLevel < f.discMinAvailableLevel) f.discMinAvailableLevel = res.availableLevel;
        }
      }
      return;
    }
    // On the surface: from the touchdown record on, for SURFACE_STAY_SECONDS.
    if (this.surfaceDone) return;
    // (In a scenario without a touchdown rule: from five seconds after the contact.)
    const hasRule = this.scenario.milestones.some((m) => m.trigger.kind === 'touchdown' && m.trigger.bodyId === target);
    if (hasRule ? !this.has(s, 'touchdown', target) : s.simUt - this.obs.surfaceStay.contactUt < 5) return;
    const fixed = fixedDir(s, a);
    const radius = v3.len(a.r);
    if (!this.surfaceRef) {
      this.surfaceRef = { ut: s.simUt, fixed, radius };
      return;
    }
    const st = this.obs.surfaceStay;
    const t = s.simUt - this.surfaceRef.ut;
    if (a.situation !== 'landed') {
      if (t < SURFACE_STAY_SECONDS) st.leftEarly = true;
      this.surfaceDone = true;
      return;
    }
    if (t > SURFACE_STAY_SECONDS) {
      this.surfaceDone = true;
      return;
    }
    st.observedFor = t;
    const drift = Math.hypot(v3.dist(fixed, this.surfaceRef.fixed) * radius, radius - this.surfaceRef.radius);
    if (drift > st.maxDrift) st.maxDrift = drift;
    const tilt = (rd.tiltFromVertical * 180) / Math.PI;
    if (tilt > st.maxTiltDeg) st.maxTiltDeg = tilt;
  }
}

// ------------------------------------------------------------------------------------------------ flights

export interface FlightSetup {
  scenario?: string;
  launchDelay?: number;
  sloppy?: boolean;
  thrustScale?: number;
  /** Stop when this milestone is recorded (ascent-only runs). */
  untilMilestone?: string;
  maxDays?: number;
  /** Wrap the fs tile source (delayed I/O for the terrain protocol). */
  wrapSource?: (source: TileSource) => TileSource;
  /** Replay this input log instead of flying the pilot. */
  replay?: { inputLog: readonly InputLogEntry[]; ticks: number };
  onLog?: (e: PilotLogEntry) => void;
  /** Called at every control tick of a piloted flight with the snapshot and the pilot's phase. */
  onPilotTick?: (snapshot: SimSnapshot, phase: string) => void;
}

export interface Flight {
  defs: DefLibrary;
  scenario: ScenarioDef;
  sim: SimWorld;
  run: RunResult;
  milestones: MilestoneRecord[];
  /** The pilot's own notes (empty for a replay). */
  report: Record<string, number>;
  log: PilotLogEntry[];
  observations: Observations;
  debris: readonly DebrisFate[];
  world: WorldStats;
  hash: string;
  wallSeconds: number;
  /** Mean wall time of a simulation step, microseconds. */
  meanStepMicroseconds: number;
}

export async function fly(setup: FlightSetup = {}): Promise<Flight> {
  let defs = await loadLibrary();
  if (setup.thrustScale !== undefined && setup.thrustScale !== 1) defs = scaleEngineThrust(defs, setup.thrustScale);
  const terrain = await createRealTerrain(defs, setup.wrapSource ? { wrapSource: setup.wrapSource } : {});
  const sim = createSim(defs, setup.scenario ?? 'lunar-direct', { terrain });
  const scenario = sim.scenario;
  const observer = new FlightObserver(defs, scenario, sim, terrain);
  const common = {
    maxSimTime: (setup.maxDays ?? 14) * 86400,
    clock: () => performance.now(),
    onTick: (s: SimSnapshot, ctx: RunContext) => observer.onTick(s, ctx),
  };
  const t0 = performance.now();
  let run: RunResult;
  let report: Record<string, number> = {};
  let log: PilotLogEntry[] = [];
  if (setup.replay) {
    run = await replayHeadless(sim, setup.replay.inputLog, { ...common, ticks: setup.replay.ticks });
  } else {
    const options: MissionPilotOptions = {};
    if (setup.launchDelay) options.launchDelay = setup.launchDelay;
    if (setup.sloppy) options.pitchProgramme = SLOPPY_PITCH_PROGRAMME;
    if (setup.onLog) options.onLog = setup.onLog;
    const pilot = createMissionPilot(defs, scenario, options);
    const until = setup.untilMilestone;
    const watch = setup.onPilotTick;
    const onTick = watch
      ? (s: SimSnapshot, ctx: RunContext): void => {
          observer.onTick(s, ctx);
          watch(s, pilot.phase);
        }
      : common.onTick;
    run = await runHeadless(sim, pilot, { ...common, onTick, ...(until !== undefined ? { until: (s: SimSnapshot) => s.milestones.some((m) => m.id === until) } : {}) });
    report = pilot.report;
    log = pilot.log;
  }
  const wallSeconds = (performance.now() - t0) / 1000;
  const soi = run.last.milestones.find((m) => m.data['soiUt'] !== undefined && m.data['predictedSoiUt'] !== undefined && scenario.target !== null);
  if (soi) observer.obs.soiPredictedEarlier = observer.predictedBefore(soi.ut);
  return {
    defs,
    scenario,
    sim,
    run,
    milestones: run.last.milestones,
    report,
    log,
    observations: observer.obs,
    debris: sim.debrisLog(),
    world: sim.stats(),
    hash: sim.stateHash(),
    wallSeconds,
    meanStepMicroseconds: (run.stats.stepMs / Math.max(1, run.stats.steps)) * 1000,
  };
}

// ---------------------------------------------------------------------------------------------- utilities

export const milestone = (f: Flight, id: string): MilestoneRecord => {
  const m = f.milestones.find((x) => x.id === id);
  if (!m) throw new Error(`milestone ${id} was not reached (stopped: ${f.run.reason}${f.run.failure ? `, ${f.run.failure}` : ''}; reached: ${f.milestones.map((x) => x.id).join(', ')})`);
  return m;
};

/** Content hashes of the baked tile sets the flight ran on (the golden state hash belongs to them). */
export function tileContentHashes(defs: DefLibrary): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of Object.values(defs.bodies)) {
    if (!b.terrain) continue;
    const manifest = JSON.parse(fs.readFileSync(path.join(tilesRoot, b.terrain.tileset, 'manifest.json'), 'utf8')) as { contentHash?: string };
    out[b.terrain.tileset] = manifest.contentHash ?? 'unknown';
  }
  return out;
}

/** Deepest height-data level the manifest of a tile set offers anywhere (the regional maximum). */
export function deepestDataLevel(tileset: string): number {
  const manifest = JSON.parse(fs.readFileSync(path.join(tilesRoot, tileset, 'manifest.json'), 'utf8')) as { layers: { height: { globalMaxLevel: number; coverage?: Record<string, unknown[]> } } };
  let deepest = manifest.layers.height.globalMaxLevel;
  for (const [level, rects] of Object.entries(manifest.layers.height.coverage ?? {})) if (rects.length > 0) deepest = Math.max(deepest, Number(level));
  return deepest;
}

/** Largest element-wise minimum of two step-time windows of the same step sequence, ms. */
export function reproducibleMaxMs(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let worst = 0;
  for (let i = 1; i <= n; i++) worst = Math.max(worst, Math.min(a[a.length - i]!, b[b.length - i]!));
  return worst;
}

export const maxOf = (a: Float32Array): number => {
  let m = 0;
  for (const x of a) if (x > m) m = x;
  return m;
};

/** Write a JSON record of a flight under out/mission (for the hand-off's mission log; never committed). */
export function writeFlightLog(name: string, data: unknown): string {
  const dir = path.join(repoRoot, 'out', 'mission');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, (_k, v: unknown) => (v instanceof Float32Array ? undefined : v), 1));
  return file;
}
