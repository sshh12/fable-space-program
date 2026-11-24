/**
 * The pilot's seat as the view drives it (ARCHITECTURE 6.3, 7.1 "View"; 7.2 "nothing reaches an island except
 * as a tick-stamped input"). The plan is the view's and is no island state: what the island must know of it
 * travels in the pilot's inputs. The hold direction of a 'maneuver' or target SAS mode goes with the
 * controls, the velocity the prograde / normal / radial holds refer to is the `reference` input (it follows
 * the navball's mode), a flown node ends its SAS mode by a command, and the predicted impact point is a
 * terrain hint. A host calls this around its steps; nothing here advances time.
 */
import { NEUTRAL_CONTROLS, SAS_TARGET_MODES, type ControlInputs, type SasMode } from '@/core/contracts/controls';
import type { TargetRef } from '@/core/contracts/net';
import { PHYSICS_DT } from '@/core/contracts/defs';
import { quat, type Quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import type { InputReceipt, Island, IslandInput } from '../island';
import type { BodyFrames } from '../island/frames';
import type { Vessel } from '../vessel';
import type { Planning } from './planning';
import type { Presenter } from './presenter';
import { comOf } from './snapshot';

type Stamp = 'tick' | 'accountId' | 'seq';
/** An input of the pilot without its stamp (the seat stamps it for the island's tick). */
export type PilotInput = { [K in IslandInput['kind']]: Omit<Extract<IslandInput, { kind: K }>, Stamp> }['controls' | 'reference' | 'command' | 'seat'];

/** What the seat reads of its host. */
export interface SeatHost {
  readonly frames: BodyFrames;
  readonly island: Island;
  readonly plan: Planning;
  readonly view: Presenter;
  /** The pilot's vessel. */
  readonly active: Vessel;
  /** The state a snapshot shows changed. */
  touch(): void;
  /** The plan changed: the limits of the clock must be looked at again. */
  relimit(): void;
  /** A live control input arrived (a host on rails warp leaves it). */
  liveInput(): void;
}

export class PilotSeat {
  constructor(
    private readonly h: SeatHost,
    readonly accountId: string,
  ) {}

  /** Give the seat an input stamped for the island's tick (applied at once). */
  input(i: PilotInput): InputReceipt {
    return this.h.island.applyInput({ ...i, tick: this.h.island.tick, accountId: this.accountId, seq: 0 });
  }

  /** The pilot's continuous controls: latched by the island for the seat. */
  setControls(inputs: ControlInputs): void {
    const h = this.h;
    const before = h.island.seatOf(this.accountId)?.controls ?? NEUTRAL_CONTROLS;
    const p = { ...before, translate: { ...before.translate } };
    const c = inputs;
    const live = (x: number): boolean => Number.isFinite(x) && x !== 0;
    if ((Number.isFinite(c.throttle) && c.throttle > 0) || live(c.pitch) || live(c.yaw) || live(c.roll) || live(c.translate.x) || live(c.translate.y) || live(c.translate.z)) h.liveInput();
    if (!h.view.present) return;
    this.input({ kind: 'controls', vesselId: h.active.id, controls: inputs, sasHold: h.island.seatOf(this.accountId)?.sasHold ?? null });
    const n = h.island.seatOf(this.accountId)!.controls;
    if (p.throttle !== n.throttle || p.pitch !== n.pitch || p.yaw !== n.yaw || p.roll !== n.roll || p.translate.x !== n.translate.x || p.translate.y !== n.translate.y || p.translate.z !== n.translate.z) h.touch();
  }

  /** The hold direction of the 'maneuver' and of the target SAS modes reaches the island with the pilot's controls. */
  private sendHold(): void {
    const h = this.h;
    const seat = h.view.present ? h.island.seatOf(this.accountId) : null;
    if (!seat) return;
    const mode = h.active.sas.mode;
    const hold = mode === 'maneuver' ? h.plan.maneuverHold() : (SAS_TARGET_MODES as readonly SasMode[]).includes(mode) ? h.view.targetHold(mode) : null;
    if (hold !== null || seat.sasHold !== null) this.input({ kind: 'controls', vesselId: h.active.id, controls: seat.controls, sasHold: hold });
  }

  /** The velocity the pilot's holds refer to follows the navball's mode. */
  sendReference(): void {
    const h = this.h;
    if (!h.view.present) return;
    const reference = h.plan.navballMode === 'surface' ? 'surface' : 'orbit';
    if (h.island.seatOf(this.accountId)?.reference !== reference) this.input({ kind: 'reference', vesselId: h.active.id, reference });
  }

  /**
   * Select a target (null = none); the caller has checked that it exists. A SAS target mode and a navball in
   * target mode end with the vessel or port they referred to.
   */
  setTarget(ref: TargetRef | null): void {
    const h = this.h;
    const a = h.view.focus();
    h.plan.setTarget(ref, h.frames.altitudeAt(a.bodyId, comOf(a).r, h.island.ut), h.frames.base(a.bodyId).def.navballSwitchAltitude);
    const mode = h.active.sas.mode;
    const needsPort = mode === 'portAlign' && h.plan.targetCraft?.portId == null;
    if (h.view.present && (SAS_TARGET_MODES as readonly SasMode[]).includes(mode) && (h.plan.targetCraft === null || needsPort)) this.input({ kind: 'command', vesselId: h.active.id, command: { kind: 'sasMode', mode: 'stability' } });
    this.sendReference();
    h.relimit();
    h.touch();
  }

  /** The terrain disc at the predicted impact point of the pilot's vessel (the island does the rest of the terrain work itself). */
  hintImpact(): void {
    const h = this.h;
    const marker = h.view.present && h.active.hold === null ? h.plan.impactMarker() : null;
    if (marker) h.island.hintImpact(h.active.id, marker);
  }

  /** Remove a node: the event of a flown one, the SAS mode that has nothing left to hold. */
  dropNode(id: string, completed: boolean): void {
    const h = this.h;
    if (!h.plan.dropNode(id)) return;
    if (completed) h.view.push({ type: 'nodeCompleted', ut: h.island.ut, vesselId: h.active.id, nodeId: id });
    if (h.plan.nodes.length === 0 && h.view.present && h.active.sas.mode === 'maneuver') this.input({ kind: 'command', vesselId: h.active.id, command: { kind: 'sasMode', mode: 'stability' } });
    h.relimit();
    h.touch();
  }

  /**
   * Before a step of the island: the plan is current, the impact hint is given at a control tick, the hold
   * direction is sent. Returns the attitude the step starts from while a node's burn is being counted down.
   */
  beforeStep(controlTick: boolean): Quat | null {
    const h = this.h;
    h.plan.ensurePatches(h.view.subject());
    if (controlTick) this.hintImpact();
    this.sendHold();
    return h.view.present && h.plan.burn ? quat.clone(h.active.q) : null;
  }

  /** After that step: the burn's remaining delta-v falls by the thrust acceleration of the step. */
  afterStep(qStart: Quat | null): void {
    const a = this.h.active;
    if (qStart && this.h.view.present && a.thrust > 0) this.h.plan.burnStep(quat.rotate(qStart, a.properAccel), PHYSICS_DT);
  }

  /** After any advance, with the pilot's vessel present: the navball's automatic mode, the reference, the node in hand. */
  afterAdvance(): void {
    const h = this.h;
    const a = h.view.focus();
    const alt = h.frames.altitudeAt(a.bodyId, comOf(a).r, h.island.ut);
    h.plan.followAltitude(alt, h.frames.base(a.bodyId).def.navballSwitchAltitude);
    this.sendReference();
    // A targeted vessel that is gone is no target.
    if (h.plan.targetCraft && h.view.target() === null) this.setTarget(null);
    const dropped = h.plan.updateBurn(h.view.subject());
    if (dropped) this.dropNode(dropped.id, dropped.completed);
  }

  /** The pilot's vessel changed frame: the plan starts over about the new body. Returns the instant the plan had predicted for the change, when it had. */
  frameChanged(fromBodyId: string, toBodyId: string): number | null {
    const h = this.h;
    const to = h.frames.info(toBodyId);
    const predicted = h.plan.frameChanged(fromBodyId, toBodyId, v3.len(h.view.focus().r) - to.radius, to.def.navballSwitchAltitude);
    this.sendReference();
    return predicted;
  }
}
