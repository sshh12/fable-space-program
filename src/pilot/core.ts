/**
 * Shared machinery of scripted pilots: the per-tick view of the snapshot, phase bookkeeping with a
 * transition log and timeouts, time-warp requests, manual pointing, and the generic "plan a node, then
 * fly it" routine (docs/research/sim-design.md 16.2, phases 5 and 6).
 *
 * A pilot reads only the SimSnapshot it is handed (what the HUD and the map show) and static definition
 * data, and acts only through ControlInputs and PlayerCommands.
 */
import type { ControlInputs, PlayerCommands, SasMode } from '@/core/contracts/controls';
import { MAX_PHYSICS_WARP_INDEX, WARP_LEVELS, type BodyDef, type DefLibrary, type ScenarioDef } from '@/core/contracts/defs';
import type { BodySnapshot, ManeuverNode, Readouts, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { DEG, G0 } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { AttitudeController, type AttitudeOptions } from './attitude';
import { MAX_PLAN_EVALUATIONS, PlanRunner, type Budget, type NodeVars, type Plan } from './planner';

export interface PilotLogEntry {
  ut: number;
  /** Mission elapsed time, s. */
  met: number;
  phase: string;
  note: string;
}

/** A maneuver: where the node starts, how it is planned, when the plan is good, and what follows. */
export interface ManeuverSpec {
  label: string;
  /** Initial node (time and delta-v) the plan starts from. */
  initial: NodeVars;
  /** The plan; omitted = fly `initial` as it is. */
  plan?: (budget: Budget) => Plan;
  /** Checked on the snapshot that shows the planned node; return a reason to give up, or null. */
  reject?: (s: SimSnapshot) => string | null;
  /** What the planned trajectory achieves, for the log (read from the snapshot that shows the planned node). */
  describe?: (s: SimSnapshot) => string;
  /** A planned delta-v smaller than this is not worth a burn: the node is removed and `then` runs. */
  skipBelow?: number;
  /** Extra cut-off condition during the burn (closed-loop on the predicted outcome). */
  cutoff?: (s: SimSnapshot) => boolean;
  /** Finish the last tenths of a metre per second with RCS translation (default true). */
  trim?: boolean;
  /** Seconds allowed for the whole maneuver from planning to completion (default: time to node + 3600). */
  timeout?: number;
  then: () => void;
}

interface ManeuverState {
  spec: ManeuverSpec;
  nodeId: string;
  runner: PlanRunner | null;
  stage: 'plan' | 'settle' | 'align' | 'coast' | 'burn' | 'tail' | 'trim';
  stageStart: number;
  dvPlanned: number;
  lastDv: number;
  ignitionUt: number;
  noThrustSince: number;
  alignedSince: number;
}

const NEUTRAL = (): ControlInputs => ({ pitch: 0, yaw: 0, roll: 0, translate: { x: 0, y: 0, z: 0 }, throttle: 0 });

export abstract class PilotCore {
  phase = 'init';
  done = false;
  failure: string | null = null;
  readonly log: PilotLogEntry[] = [];
  /** Called for every log entry (tools print it live). */
  onLog: ((e: PilotLogEntry) => void) | null = null;

  protected s!: SimSnapshot;
  protected cmd!: PlayerCommands;
  protected dt = 0;
  protected v!: VesselSnapshot;
  protected rd!: Readouts;
  protected out: ControlInputs = NEUTRAL();
  protected readonly attitude = new AttitudeController();
  protected phaseStart = 0;
  protected phaseTimeout = Infinity;
  private maneuver: ManeuverState | null = null;
  private lastWarpRequest = -1;
  /** Use physics warp (4x) in long integrated phases; it changes pacing only, never the flight. */
  protected physicsWarp = true;

  constructor(
    protected readonly defs: DefLibrary,
    protected readonly scenario: ScenarioDef,
  ) {}

  // ---------------------------------------------------------------------------------------- frame

  update(snapshot: SimSnapshot, commands: PlayerCommands, dt: number): ControlInputs {
    this.s = snapshot;
    this.cmd = commands;
    this.dt = dt;
    this.rd = snapshot.readouts;
    const v = snapshot.vessels.find((x) => x.id === snapshot.activeVesselId);
    this.out = NEUTRAL();
    if (this.done || this.failure !== null) return this.out;
    if (!v) {
      this.fail('the active vessel is gone');
      return this.out;
    }
    this.v = v;
    if (this.phase === 'init') {
      this.phaseStart = snapshot.simUt;
      this.start();
    }
    if (snapshot.simUt - this.phaseStart > this.phaseTimeout) {
      this.fail(`phase "${this.phase}" timed out after ${this.phaseTimeout.toFixed(0)} s`);
      return this.out;
    }
    if (this.maneuver) this.flyManeuver();
    else this.tick();
    if (this.failure !== null) return NEUTRAL();
    return this.out;
  }

  /** First tick: choose the first phase. */
  protected abstract start(): void;
  /** One control tick in the current phase (not called while a maneuver is being planned or flown). */
  protected abstract tick(): void;

  protected get ut(): number {
    return this.s.simUt;
  }

  protected note(text: string): void {
    const e: PilotLogEntry = { ut: this.s.simUt, met: this.rd.met, phase: this.phase, note: text };
    this.log.push(e);
    this.onLog?.(e);
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

  protected get phaseTime(): number {
    return this.s.simUt - this.phaseStart;
  }

  protected bodyDef(id: string): BodyDef {
    return this.defs.bodies[id]!;
  }

  protected bodySnap(id: string): BodySnapshot {
    return this.s.bodies.find((b) => b.id === id)!;
  }

  protected hasMilestone(id: string): boolean {
    return this.s.milestones.some((m) => m.id === id);
  }

  protected node(id: string): ManeuverNode | undefined {
    return this.s.nodes.find((n) => n.id === id);
  }

  /** Nose direction (ROOT axes). */
  protected nose(): Vec3 {
    return quat.rotate(this.v.q, { x: 0, y: 1, z: 0 });
  }

  // ----------------------------------------------------------------------------------------- warp

  /**
   * Ask for the highest warp level that still leaves `margin` real seconds before `remaining` seconds of
   * simulation time have passed (index 0 when that is no rails level). The sim clamps the request.
   */
  protected warpFor(remaining: number, margin = 2): void {
    let idx = 0;
    for (let i = MAX_PHYSICS_WARP_INDEX + 1; i < WARP_LEVELS.length; i++) if (remaining / WARP_LEVELS[i]! >= margin) idx = i;
    this.setWarp(idx);
  }

  protected setWarp(index: number): void {
    const cur = this.s.warp.index;
    // The sim limits rails levels; asking again every tick for a level it just refused would spam commands.
    const want = index > MAX_PHYSICS_WARP_INDEX ? Math.min(index, Math.max(this.s.warp.maxIndex, cur)) : index;
    if (want === cur) return;
    if (want > cur && this.lastWarpRequest === want && this.s.simUt - this.lastWarpUt < 1) return;
    this.lastWarpRequest = want;
    this.lastWarpUt = this.s.simUt;
    this.cmd.setWarpLevel(want);
  }
  private lastWarpUt = -Infinity;

  /** Physics warp for long integrated phases (pacing only). */
  protected cruiseWarp(on: boolean): void {
    const want = on && this.physicsWarp ? MAX_PHYSICS_WARP_INDEX : 0;
    if (this.s.warp.index !== want && (this.s.warp.index <= MAX_PHYSICS_WARP_INDEX || !on)) this.cmd.setWarpLevel(want);
  }

  // --------------------------------------------------------------------------------------- controls

  protected ensureSas(mode: SasMode): void {
    if (!this.rd.sasEnabled) this.cmd.setSasEnabled(true);
    if (this.rd.sasMode !== mode && this.rd.sasModesAvailable.includes(mode)) this.cmd.setSasMode(mode);
  }

  protected ensureRcs(on: boolean): void {
    if (this.rd.rcsEnabled !== on) this.cmd.setRcsEnabled(on);
  }

  /** Fly the nose to `dir` (ROOT axes) by hand; returns the pointing error, rad. */
  protected pointAt(dir: Vec3, opts: AttitudeOptions = {}): number {
    const c = this.attitude.update(this.v.q, this.v.w, dir, this.dt, opts);
    this.out.pitch = c.pitch;
    this.out.yaw = c.yaw;
    this.out.roll = c.roll;
    return c.error;
  }

  /** Thrust and mass flow of the engines that are armed on the vessel now (vacuum values from the part data). */
  protected armedEngines(): { thrust: number; isp: number; minThrottle: number; spoolDown: number } | null {
    let thrust = 0;
    let mdot = 0;
    let minThrottle = 0;
    let spoolDown = 0;
    for (const p of this.v.parts) {
      const def = this.defs.parts[p.def];
      if (!def) continue;
      for (let m = 0; m < p.modules.length; m++) {
        const ms = p.modules[m]!;
        const md = def.modules[m]!;
        if (ms.type !== 'engine' || md.type !== 'engine' || md.fixedBurn || !ms.active || ms.flameout) continue;
        thrust += md.thrustVac;
        mdot += md.thrustVac / (md.ispVac * G0);
        minThrottle = Math.max(minThrottle, md.throttleable ? md.minThrottle : 1);
        spoolDown = Math.max(spoolDown, md.spoolDown);
      }
    }
    return thrust > 0 ? { thrust, isp: thrust / (mdot * G0), minThrottle, spoolDown } : null;
  }

  /** Throttle lever position that gives the thrust fraction `f` of the armed engines (their minimum when below it). */
  protected leverFor(f: number, minThrottle: number): number {
    if (f <= 0) return 0;
    if (minThrottle >= 1) return 1;
    return Math.min(1, Math.max(0.002, (f - minThrottle) / (1 - minThrottle)));
  }

  // -------------------------------------------------------------------------------------- maneuvers

  /** Plan and fly a maneuver; `spec.then` runs when the node is flown (or skipped). */
  protected beginManeuver(spec: ManeuverSpec): void {
    for (const n of this.s.nodes) this.cmd.removeNode(n.id);
    const nodeId = this.cmd.addNode(spec.initial.ut);
    this.cmd.setNode(nodeId, { ut: spec.initial.ut, dv: { prograde: spec.initial.prograde, normal: spec.initial.normal, radial: spec.initial.radial } });
    this.maneuver = {
      spec,
      nodeId,
      runner: null,
      stage: 'plan',
      stageStart: this.s.simUt,
      dvPlanned: 0,
      lastDv: Infinity,
      ignitionUt: NaN,
      noThrustSince: NaN,
      alignedSince: NaN,
    };
    if (spec.plan) {
      const budget: Budget = { left: MAX_PLAN_EVALUATIONS };
      this.maneuver.runner = new PlanRunner(nodeId, spec.plan(budget), budget);
    }
    this.go(`${spec.label}:plan`, spec.timeout ?? Math.max(0, spec.initial.ut - this.s.simUt) + 7200);
    this.cruiseWarp(false);
  }

  /** Delta-v flown per maneuver label (planned minus what was left when the burn ended), m/s. */
  protected readonly dvFlown: Record<string, number> = {};

  private endManeuver(note: string, flown = 0): void {
    const m = this.maneuver!;
    this.maneuver = null;
    this.dvFlown[m.spec.label] = (this.dvFlown[m.spec.label] ?? 0) + flown;
    this.note(note);
    m.spec.then();
  }

  private maneuverStage(m: ManeuverState, stage: ManeuverState['stage']): void {
    m.stage = stage;
    m.stageStart = this.s.simUt;
    this.phase = `${m.spec.label}:${stage}`;
    this.note('enter');
  }

  private flyManeuver(): void {
    const m = this.maneuver!;
    const s = this.s;
    const node = this.node(m.nodeId);
    const nb = this.rd.nodeBurn;
    switch (m.stage) {
      case 'plan': {
        if (s.warp.index !== 0) this.cmd.setWarpLevel(0);
        if (m.runner && !m.runner.step(s, this.cmd)) return;
        if (m.runner && m.runner.result === null) {
          this.fail(`no solution after ${m.runner.evaluations} evaluations`);
          return;
        }
        this.maneuverStage(m, 'settle');
        return;
      }
      case 'settle': {
        // This snapshot shows the planned node.
        if (!node) {
          this.fail('the planned node disappeared');
          return;
        }
        const why = m.spec.reject ? m.spec.reject(s) : null;
        if (why !== null) {
          this.fail(`plan rejected: ${why}`);
          return;
        }
        m.dvPlanned = Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial);
        this.note(
          `planned dv ${m.dvPlanned.toFixed(2)} m/s (pro ${node.dv.prograde.toFixed(2)}, nrm ${node.dv.normal.toFixed(2)}, rad ${node.dv.radial.toFixed(2)}) at T+${(node.ut - s.simUt).toFixed(0)} s, ${m.runner ? m.runner.evaluations : 0} evaluations`,
        );
        if (m.spec.describe) this.note(`plan: ${m.spec.describe(s)}`);
        // Below the simulation's own completion threshold (0.1 m/s) a node cannot be flown at all.
        if (m.dvPlanned < Math.max(m.spec.skipBelow ?? 0, 0.12)) {
          this.cmd.removeNode(m.nodeId);
          this.endManeuver('not worth a burn: skipped');
          return;
        }
        if (nb && nb.insufficientDeltaV) this.note(`warning: the stage holds less delta-v than the ${m.dvPlanned.toFixed(0)} m/s planned`);
        this.maneuverStage(m, 'align');
        return;
      }
      case 'align': {
        if (!node || !nb) {
          this.fail('node lost before the burn');
          return;
        }
        this.ensureSas('maneuver');
        this.ensureRcs(true);
        const marker = s.navball.markers.maneuver;
        const err = marker ? Math.acos(Math.max(-1, Math.min(1, marker.y))) : Math.PI;
        const rate = v3.len(this.v.w);
        const tts = nb.timeToBurnStart ?? node.ut - s.simUt;
        if (err < 1.0 * DEG && rate < 0.3 * DEG) {
          if (Number.isNaN(m.alignedSince)) m.alignedSince = s.simUt;
        } else m.alignedSince = NaN;
        const settled = !Number.isNaN(m.alignedSince) && s.simUt - m.alignedSince > 1.5;
        if (tts <= 0.2 && (err < 5 * DEG || tts < -30)) {
          this.maneuverStage(m, 'burn');
          return;
        }
        if (settled && tts > 45) this.maneuverStage(m, 'coast');
        return;
      }
      case 'coast': {
        if (!node || !nb) {
          this.fail('node lost before the burn');
          return;
        }
        const tts = nb.timeToBurnStart ?? node.ut - s.simUt;
        if (tts > 40) this.warpFor(tts - 32);
        else {
          if (s.warp.index !== 0) this.cmd.setWarpLevel(0);
          this.maneuverStage(m, 'align');
        }
        return;
      }
      case 'burn': {
        if (!node || !nb) {
          // The sim completed the node (remaining delta-v below its threshold).
          this.out.throttle = 0;
          this.maneuverStage(m, 'tail');
          return;
        }
        this.ensureSas('maneuver');
        this.cruiseWarp(nb.dvRemainingMag > 150);
        const eng = this.armedEngines();
        const a = this.rd.mass > 0 && eng ? eng.thrust / this.rd.mass : 0;
        if (Number.isNaN(m.ignitionUt)) m.ignitionUt = s.simUt;
        // Flame-out or nothing armed: the next stage may hold the engine for the rest.
        if (this.rd.thrust <= 0 && s.simUt - m.ignitionUt > 3) {
          if (Number.isNaN(m.noThrustSince)) m.noThrustSince = s.simUt;
          if (s.simUt - m.noThrustSince > 2) {
            if (s.staging.lockout) return;
            const res = this.cmd.stage();
            m.noThrustSince = NaN;
            m.ignitionUt = s.simUt;
            if (!res.ok) {
              this.fail('no thrust and no stage left');
              return;
            }
            this.note('no thrust: next stage fired');
          }
        } else m.noThrustSince = NaN;
        // What the engines still deliver while they spool down from the present thrust.
        const tail = eng && this.rd.mass > 0 ? (this.rd.thrust / this.rd.mass) * eng.spoolDown : 0;
        const rem = nb.dvRemainingMag;
        const passed = rem > m.lastDv + 0.02 && rem < 0.25 * m.dvPlanned;
        m.lastDv = rem;
        // Stop short rather than long: a burn that overshoots completes the node and leaves its sideways
        // error behind, while a few tenths of a metre per second short are finished exactly on the thrusters.
        if (rem <= 1.2 * tail + (m.spec.trim === false ? 0.1 : 0.3) || passed || (m.spec.cutoff && s.simUt - m.ignitionUt > 2 && m.spec.cutoff(s))) {
          this.out.throttle = 0;
          this.maneuverStage(m, 'tail');
          return;
        }
        // Throttle down for the last seconds (as far as the engine's minimum allows).
        const tRemain = a > 0 ? rem / a : Infinity;
        this.out.throttle = eng ? this.leverFor(Math.min(1, tRemain / 2.5), eng.minThrottle) : 1;
        return;
      }
      case 'tail': {
        this.out.throttle = 0;
        this.cruiseWarp(false);
        if (this.rd.thrust > 0 && s.simUt - m.stageStart < 3) return;
        if (!node || !nb) {
          this.ensureSas('stability');
          this.endManeuver(`burn complete (planned ${m.dvPlanned.toFixed(1)} m/s)`, m.dvPlanned);
          return;
        }
        if (m.spec.trim === false || nb.dvRemainingMag < 0.12 || nb.dvRemainingMag > 6) {
          const left = nb.dvRemainingMag;
          this.cmd.removeNode(m.nodeId);
          this.ensureSas('stability');
          this.endManeuver(`burn complete, ${left.toFixed(2)} m/s left untrimmed`, m.dvPlanned - left);
          return;
        }
        this.ensureSas('stability');
        this.ensureRcs(true);
        this.maneuverStage(m, 'trim');
        return;
      }
      case 'trim': {
        if (!node || !nb) {
          this.endManeuver('burn complete (trimmed with RCS)', m.dvPlanned);
          return;
        }
        const marker = s.navball.markers.maneuver;
        const rem = nb.dvRemainingMag;
        if (!marker || s.simUt - m.stageStart > 90 || rem > m.lastDv + 0.5) {
          this.cmd.removeNode(m.nodeId);
          this.endManeuver(`burn complete, ${rem.toFixed(2)} m/s left after the RCS trim`, m.dvPlanned - rem);
          return;
        }
        const k = Math.min(1, rem / 0.4 + 0.15);
        this.out.translate = { x: marker.x * k, y: marker.y * k, z: marker.z * k };
        return;
      }
    }
  }
}
