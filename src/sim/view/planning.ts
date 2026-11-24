/**
 * Planning state of one pilot's vessel, local to the view (ARCHITECTURE 6.3, 7.1 "View"): the selected
 * target, the maneuver nodes, the predicted patches, the bookkeeping of the burn in hand, the stage figures
 * and the navball's mode. Nothing here is simulation state of the island: the island learns of a plan only
 * through the hold direction the pilot's controls carry.
 *
 * The algorithms are v1's `World` planning code, moved here unchanged in numerics.
 */
import type { NavballMode, NodeEdit, SasMode } from '@/core/contracts/controls';
import { SAS_MODES } from '@/core/contracts/controls';
import type { ManeuverNode, NodeBurnInfo, Patch, SimEvent, StageInfo } from '@/core/contracts/sim';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import { G0 } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import type { BodyFrames } from '../island/frames';
import { defaultNavballMode, navballModeAfter } from '../nav/navball';
import { nodeBurnInfo, nodeDeltaVInertial, type BurnEngine } from '../orbit/maneuver';
import { predictPatchesWithOrbits, stateOnPatches, type PatchWithOrbit } from '../orbit/patches';
import type { WarpEvent } from '../orbit/warp';
import { helmCraft, nextLiveStage, stagingInfo, type Vessel } from '../vessel';

/** Patch refresh interval while the vessel is integrated, steps (10 Hz), and the bucket of the stage figures. */
export const PATCH_REFRESH_STEPS = 12;
/** Node burn bookkeeping (sim-design 3.5). */
export const NODE_LOCK_LEAD = 60;
export const NODE_THROTTLE_WINDOW = 300;
export const NODE_COMPLETE_DV = 0.1;

export interface BurnState {
  nodeId: string;
  dv0: Vec3;
  dvRemaining: Vec3;
}

/** The planned vessel as the planner reads it at one instant. */
export interface PlanSubject {
  /** False when the vessel is gone (nothing to plan for). */
  present: boolean;
  vessel: Vessel;
  bodyId: string;
  /** On its conic (mode 'rails'). */
  onRails: boolean;
  /** Centre-of-mass state in BCI of `bodyId`. */
  com: { r: Vec3; v: Vec3 };
  ut: number;
  /** Step count of the session (the refresh cadence of the stage figures). */
  stepCount: number;
  env(): VesselEnvironment;
}

export class Planning {
  nodes: ManeuverNode[] = [];
  private nodeSerial = 0;
  burn: BurnState | null = null;
  targetBodyId: string | null = null;
  navballMode: NavballMode = 'surface';
  prevNavAltitude = 0;

  patchItems: { current: PatchWithOrbit[]; planned: PatchWithOrbit[] } = { current: [], planned: [] };
  patches: { current: Patch[]; planned: Patch[] } = { current: [], planned: [] };
  patchesDirty = true;
  patchRefreshes = 0;
  /** The SOI change predicted when the vessel last went on rails (for the "predicted vs actual" record). */
  soiPrediction: { from: string; to: string; ut: number } | null = null;

  private stageInfo: StageInfo[] = [];
  stageInfoDirty = true;
  private stageInfoStep = -1;
  private stageAcceleration: number[] = [];

  /** Called whenever a prediction ran (the host's warp limits look at the patches). */
  onPatches: () => void = () => undefined;

  constructor(private readonly frames: BodyFrames) {}

  // ------------------------------------------------------------------------------------ navball mode

  resetNavball(altitude: number, switchAltitude: number): void {
    this.navballMode = defaultNavballMode(altitude, switchAltitude);
    this.prevNavAltitude = altitude;
  }

  /** The automatic switch between the surface and the orbit mode by altitude, with hysteresis. */
  followAltitude(altitude: number, switchAltitude: number): void {
    this.navballMode = navballModeAfter(this.navballMode, this.prevNavAltitude, altitude, switchAltitude);
    this.prevNavAltitude = altitude;
  }

  /**
   * The vessel changed frame (another sphere of influence, a new reference orbit) at `altitude` above the new
   * body: the prediction is void and the navball starts from that body's default mode. Returns the instant
   * the plan had predicted for this change, when it had predicted it.
   */
  frameChanged(fromBodyId: string, toBodyId: string, altitude: number, switchAltitude: number): number | null {
    const predicted = this.soiPrediction && this.soiPrediction.from === fromBodyId && this.soiPrediction.to === toBodyId ? this.soiPrediction.ut : null;
    this.soiPrediction = null;
    this.patchesDirty = true;
    this.resetNavball(Math.max(altitude, 0), switchAltitude);
    this.prevNavAltitude = altitude;
    return predicted;
  }

  /** An event of a vessel in view: a change of the part set or of what burns makes the stage figures stale. */
  noteEvent(ev: SimEvent): void {
    switch (ev.type) {
      case 'stageFired':
      case 'engineIgnition':
      case 'engineShutdown':
      case 'decoupled':
      case 'fairingJettisoned':
      case 'partDestroyed':
        this.stageInfoDirty = true;
        break;
      default:
        break;
    }
  }

  // ----------------------------------------------------------------------------------------- patches

  /** Recompute the predicted patches when they are stale. True when a prediction ran. */
  ensurePatches(s: PlanSubject): boolean {
    if (!this.patchesDirty) return false;
    this.patchesDirty = false;
    if (!s.present || s.vessel.hold !== null) {
      this.patchItems = { current: [], planned: [] };
      this.patches = { current: [], planned: [] };
      return false;
    }
    const p = predictPatchesWithOrbits(this.frames.system, { bodyId: s.bodyId, r: s.com.r, v: s.com.v }, s.ut, this.nodes, { targetBodyId: this.targetBodyId, terrainHeight: this.frames.coarseHeight });
    this.patchItems = p;
    this.patches = { current: p.current.map((x) => x.patch), planned: p.planned.map((x) => x.patch) };
    this.patchRefreshes++;
    // Any integrated interval (burn, staging impulse, RCS translation) makes the old prediction void.
    if (!s.onRails) this.soiPrediction = null;
    else {
      const first = this.patches.current[0];
      if (first && (first.endReason === 'soiEnter' || first.endReason === 'soiExit') && first.nextBodyId) {
        if (!this.soiPrediction || this.soiPrediction.from !== first.bodyId || this.soiPrediction.to !== first.nextBodyId) {
          this.soiPrediction = { from: first.bodyId, to: first.nextBodyId, ut: first.tEnd };
        }
      } else this.soiPrediction = null;
    }
    this.onPatches();
    return true;
  }

  /** The predicted impact point of the current trajectory (before any atmosphere entry), for the terrain disc there. */
  impactMarker(): { bodyId: string; latitude: number; longitude: number } | null {
    for (const p of this.patches.current) {
      for (const m of p.markers) {
        if (m.kind === 'impact' && m.latitude !== undefined && m.longitude !== undefined) return { bodyId: p.bodyId, latitude: m.latitude, longitude: m.longitude };
      }
      if (p.endReason === 'atmosphere') return null;
    }
    return null;
  }

  // ------------------------------------------------------------------------------------ stage figures

  stageInfos(s: PlanSubject): StageInfo[] {
    const bucket = s.stepCount - (s.stepCount % PATCH_REFRESH_STEPS);
    if (this.stageInfoDirty || this.stageInfoStep !== bucket) {
      this.stageInfo = s.present ? stagingInfo(s.vessel, s.env()) : [];
      this.stageInfoDirty = false;
      this.stageInfoStep = bucket;
      // Full-throttle acceleration of every stage: what its thrust-to-weight ratio is at any gravity.
      const g = s.present ? this.frames.gravityAt(s.bodyId, s.vessel.r) : 1;
      this.stageAcceleration = this.stageInfo.map((x) => x.twr * g);
    }
    // The cache is refreshed by physics steps and by changes of the vehicle, neither of which happens on a
    // coast: delta-v, burn time and propellant do not change there, the local gravity does. The ratio is
    // restated at the gravity of now on every read (request flight-ui-8).
    if (s.present) {
      const g = this.frames.gravityAt(s.bodyId, s.vessel.r);
      for (let i = 0; i < this.stageInfo.length; i++) this.stageInfo[i]!.twr = this.stageAcceleration[i]! / g;
    }
    return this.stageInfo;
  }

  // ------------------------------------------------------------------------------------------- nodes

  sortedNodes(): ManeuverNode[] {
    return this.nodes.slice().sort((x, y) => x.ut - y.ut || (x.id < y.id ? -1 : 1));
  }

  burnEngine(s: PlanSubject): BurnEngine | null {
    const v = s.vessel;
    let thrust = 0;
    let mdot = 0;
    const add = (ids: readonly string[] | null): void => {
      for (const p of v.parts) {
        if (ids && !ids.includes(p.instanceId)) continue;
        for (let m = 0; m < p.modules.length; m++) {
          const md = p.def.modules[m]!;
          const ms = p.modules[m]!;
          if (md.type !== 'engine' || ms.type !== 'engine' || md.fixedBurn || ms.flameout) continue;
          if (ids === null && !ms.active) continue;
          thrust += md.thrustVac;
          mdot += md.thrustVac / (md.ispVac * G0);
        }
      }
    };
    add(null);
    let owner = -1;
    const craft = helmCraft(v);
    const stages = craft.vehicle.stages;
    if (thrust === 0) {
      for (let k = nextLiveStage(v); k < stages.length && thrust === 0; k++) {
        for (const act of stages[k]!.actions) if (act.kind === 'igniteEngines') add(act.parts);
        if (thrust > 0) owner = k;
      }
    }
    if (!(thrust > 0)) return null;
    const info = this.stageInfos(s);
    let available = 0;
    if (owner >= 0) available = info[owner]?.deltaVVac ?? 0;
    else {
      for (let k = Math.min(craft.nextStage, stages.length) - 1; k >= 0; k--) {
        if ((info[k]?.deltaVVac ?? 0) > 0) {
          available = info[k]!.deltaVVac;
          break;
        }
      }
    }
    return { mass: v.mp.mass, thrust, isp: thrust / (mdot * G0), availableDeltaV: available };
  }

  nodeDv(node: ManeuverNode): Vec3 | null {
    const pre = stateOnPatches(this.patchItems.current, node.ut);
    if (!pre) return null;
    return nodeDeltaVInertial(node.dv, pre.r, pre.v);
  }

  burnTimeFor(s: PlanSubject, node: ManeuverNode): number | null {
    const engine = this.burnEngine(s);
    if (!engine) return null;
    const dv = this.burn && this.burn.nodeId === node.id ? v3.len(this.burn.dvRemaining) : Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial);
    const ve = engine.isp * G0;
    return ((engine.mass - engine.mass * Math.exp(-dv / ve)) * ve) / engine.thrust;
  }

  /** The remaining delta-v of the first node (the burn's own once it is locked), or null. */
  remainingDv(): Vec3 | null {
    const node = this.sortedNodes()[0];
    if (!node) return null;
    return this.burn && this.burn.nodeId === node.id ? this.burn.dvRemaining : this.nodeDv(node);
  }

  /** The direction the 'maneuver' SAS mode holds (unit, inertial axes), or null. */
  maneuverHold(): Vec3 | null {
    const dv = this.remainingDv();
    return dv && v3.len(dv) > 1e-9 ? v3.normalize(dv) : null;
  }

  /**
   * Node burn bookkeeping after an advance: lock the remaining delta-v vector when the burn nears, complete
   * the node when it is flown. Returns the node that was dropped, if one was: `completed` says how.
   */
  updateBurn(s: PlanSubject): { id: string; completed: boolean } | null {
    const node = this.sortedNodes()[0];
    if (!node) {
      this.burn = null;
      return null;
    }
    const v = s.vessel;
    if (this.burn && this.burn.nodeId !== node.id) this.burn = null;
    if (!this.burn) {
      const burnTime = this.burnTimeFor(s, node) ?? 0;
      const near = s.ut >= node.ut - burnTime / 2 - NODE_LOCK_LEAD;
      const throttled = v.throttle > 0 && v.thrust > 0 && Math.abs(node.ut - s.ut) < NODE_THROTTLE_WINDOW;
      if (!(near || throttled)) return null;
      this.ensurePatches(s);
      const dv = this.nodeDv(node);
      if (!dv) return s.ut > node.ut ? { id: node.id, completed: false } : null;
      this.burn = { nodeId: node.id, dv0: v3.clone(dv), dvRemaining: dv };
    }
    const rem = this.burn.dvRemaining;
    const mag = v3.len(rem);
    if (mag < NODE_COMPLETE_DV || (v3.dot(rem, this.burn.dv0) < 0 && v.throttle === 0)) return { id: node.id, completed: true };
    return null;
  }

  /** dvRemaining -= a_thrust dt, with the thrust acceleration of the step in inertial axes. */
  burnStep(a: Vec3, dt: number): void {
    if (!this.burn) return;
    const b = this.burn.dvRemaining;
    b.x -= a.x * dt;
    b.y -= a.y * dt;
    b.z -= a.z * dt;
  }

  /** Remove a node. True when it was there. */
  dropNode(id: string): boolean {
    const i = this.nodes.findIndex((n) => n.id === id);
    if (i < 0) return false;
    this.nodes.splice(i, 1);
    if (this.burn && this.burn.nodeId === id) this.burn = null;
    this.patchesDirty = true;
    return true;
  }

  nodeBurnReadout(s: PlanSubject): NodeBurnInfo | null {
    const node = this.sortedNodes()[0];
    if (!node) return null;
    const dv = this.remainingDv();
    if (!dv) return null;
    return nodeBurnInfo(node, dv, s.ut, this.burnEngine(s));
  }

  /** The earliest lead time of a node ahead (what a landed vessel's warp looks out for). */
  nodeEvent(s: PlanSubject): WarpEvent | null {
    let best: WarpEvent | null = null;
    for (const node of this.nodes) {
      if (node.ut <= s.ut) continue;
      const t = Math.max(s.ut, node.ut - (this.burnTimeFor(s, node) ?? 0) / 2 - 30);
      if (!best || t < best.ut) best = { ut: t, kind: 'node', nodeId: node.id };
    }
    return best;
  }

  sasModesAvailable(): SasMode[] {
    return this.nodes.length > 0 ? SAS_MODES.slice() : SAS_MODES.filter((m) => m !== 'maneuver');
  }

  // ----------------------------------------------------------------------------- planning commands

  addNode(ut: number, now: number): string {
    const id = `node-${++this.nodeSerial}`;
    this.nodes.push({ id, ut: Number.isFinite(ut) ? ut : now, dv: { prograde: 0, normal: 0, radial: 0 } });
    this.patchesDirty = true;
    return id;
  }

  /** Edit a node. Returns why not, or null when it was done. */
  setNode(id: string, edit: NodeEdit): string | null {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) return 'No such node';
    if (edit.ut !== undefined) {
      if (!Number.isFinite(edit.ut)) return 'Invalid node time';
      node.ut = edit.ut;
    }
    if (edit.dv) {
      for (const k of ['prograde', 'normal', 'radial'] as const) {
        const x = edit.dv[k];
        if (x !== undefined) {
          if (!Number.isFinite(x)) return 'Invalid delta-v';
          node.dv[k] = x;
        }
      }
    }
    if (this.burn && this.burn.nodeId === id) this.burn = null;
    this.patchesDirty = true;
    return null;
  }

  /** Forget the plan (the pilot moved to another vessel). */
  clear(): void {
    this.nodes = [];
    this.burn = null;
    this.patchesDirty = true;
    this.stageInfoDirty = true;
  }

  /** The node list and the burn as the session's state hash takes them. */
  hashState(): unknown[] {
    return [this.sortedNodes().map((n) => [n.id, n.ut, n.dv.prograde, n.dv.normal, n.dv.radial]), this.burn ? [this.burn.nodeId, this.burn.dvRemaining.x, this.burn.dvRemaining.y, this.burn.dvRemaining.z] : null];
  }
}
