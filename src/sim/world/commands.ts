/**
 * The pilot's discrete commands and the debug interface of the single-clock host (`PlayerCommands`,
 * `SessionDebug`). A command on the vessel is an input of the pilot's seat, applied by the island at the
 * clock's tick; planning commands are the view's; the warp level is the host's ladder.
 */
import { SAS_MODES, SAS_TARGET_MODES, type CommandResult, type NavballMode, type NodeEdit, type PlayerCommands, type SasMode } from '@/core/contracts/controls';
import { MAX_PHYSICS_WARP_INDEX, WARP_LEVELS } from '@/core/contracts/defs';
import type { TargetRef } from '@/core/contracts/net';
import type { SessionDebug } from '@/core/contracts/session';
import { v3, type Vec3 } from '@/core/math/vec3';
import { nearestTick, utOfTick } from '../clock';
import { computeRailsEvent, orbitOf, type AddOptions, type IslandCommand } from '../island';
import { propagate } from '../orbit/kepler';
import { rideBody, type Vessel } from '../vessel';
import { PILOT_ACCOUNT } from './api';
import type { World } from './sim';

const ok: CommandResult = { ok: true };
const refuse = (reason: string): CommandResult => ({ ok: false, reason });

export function makeCommands(w: World): PlayerCommands {
  /** A command of the seat on the active vessel: applied by the island now. */
  const seat = (command: IslandCommand, fallback: string): CommandResult => {
    if (!w.view.present) return refuse('No vessel');
    const receipt = w.seat.input({ kind: 'command', vesselId: w.active.id, command });
    const outcome = receipt.outcome;
    if (!outcome || !outcome.ok) return refuse(outcome?.reason ?? receipt.reason ?? fallback);
    if (receipt.report) w.absorb(receipt.report, w.ut);
    w.touch();
    return ok;
  };
  const structural = (kind: 'stage' | 'abort', why: string, fallback: string): CommandResult => {
    if (!w.view.present) return refuse('No vessel');
    if (w.ladder.index > MAX_PHYSICS_WARP_INDEX) w.setWarpIndex(0, why);
    const r = seat({ kind }, fallback);
    if (!r.ok) return r;
    w.plan.stageInfoDirty = true;
    w.plan.patchesDirty = true;
    w.warpStamp = -1;
    return ok;
  };
  return {
    stage: (): CommandResult => structural('stage', 'Staging', 'Staging refused'),
    abort: (): CommandResult => structural('abort', 'Abort', 'Abort refused'),
    setSasEnabled: (on: boolean): CommandResult => seat({ kind: 'sas', on }, 'No SAS on this vessel'),
    setSasMode: (mode: SasMode): CommandResult => {
      if (!w.view.present) return refuse('No vessel');
      // The three target modes hold on a vessel or a port, which this session does not have.
      if ((SAS_TARGET_MODES as readonly SasMode[]).includes(mode)) return refuse('No vessel or port target');
      if (!SAS_MODES.includes(mode)) return refuse('Unknown SAS mode');
      if (mode === 'maneuver' && w.plan.nodes.length === 0) return refuse('No maneuver node');
      return seat({ kind: 'sasMode', mode }, 'Unknown SAS mode');
    },
    setRcsEnabled: (on: boolean): CommandResult => seat({ kind: 'rcs', on }, 'No RCS'),
    toggleLegs: (): CommandResult => seat({ kind: 'legs' }, 'No landing legs'),
    toggleLights: (): CommandResult => seat({ kind: 'lights' }, 'No lights'),
    setFineControl: (on: boolean): CommandResult => seat({ kind: 'fineControl', on }, 'No fine control'),
    setNavballMode: (mode: NavballMode): CommandResult => {
      // 'target' shows the velocity relative to a vessel or a port, which this session does not have.
      if (mode === 'target') return refuse('No vessel or port target');
      if (mode !== 'surface' && mode !== 'orbit') return refuse('Unknown navball mode');
      w.plan.navballMode = mode;
      w.seat.sendReference();
      w.touch();
      return ok;
    },
    setWarpLevel: (index: number): CommandResult => {
      if (!Number.isFinite(index)) return refuse('Invalid warp level');
      const want = Math.max(0, Math.min(WARP_LEVELS.length - 1, Math.round(index)));
      if (want <= w.ladder.index) {
        w.setWarpIndex(want, null);
        return ok;
      }
      w.ensurePatches();
      w.warpStamp = -1;
      w.refreshWarp();
      const allowed = Math.min(want, w.ladder.max);
      const reason = allowed < want ? (w.ladder.limitedBy ?? 'Warp limited') : null;
      w.setWarpIndex(Math.max(allowed, w.ladder.index), reason);
      w.warpStamp = -1;
      if (allowed < want) return { ok: allowed > MAX_PHYSICS_WARP_INDEX || want <= MAX_PHYSICS_WARP_INDEX, reason: reason ?? undefined } as CommandResult;
      return ok;
    },
    addNode: (ut: number): string => {
      const id = w.plan.addNode(ut, w.ut);
      w.warpStamp = -1;
      w.touch();
      return id;
    },
    setNode: (id: string, edit: NodeEdit): CommandResult => {
      const why = w.plan.setNode(id, edit);
      if (why !== null) return refuse(why);
      w.warpStamp = -1;
      w.touch();
      return ok;
    },
    removeNode: (id: string): CommandResult => {
      if (!w.plan.nodes.some((n) => n.id === id)) return refuse('No such node');
      w.seat.dropNode(id, false);
      return ok;
    },
    setTarget: (ref: TargetRef | null): CommandResult => {
      // Body targets only in this session. A refused target leaves the one that was selected.
      if (ref !== null && ref.kind !== 'body') return refuse(ref.kind === 'vessel' ? 'Vessel targets are not available in this session' : 'Docking-port targets are not available in this session');
      const bodyId = ref === null ? null : ref.id;
      if (bodyId !== null && !w.defs.bodies[bodyId]) return refuse('Unknown body');
      w.plan.targetBodyId = bodyId;
      w.plan.patchesDirty = true;
      w.touch();
      return ok;
    },
    cycleActiveVessel: (direction: 1 | -1): CommandResult => {
      const list = w.roster.filter((v) => w.island.member(v.id)?.vessel === v && w.controllable(v));
      const i = list.indexOf(w.active);
      if (list.length < 2 || i < 0) return refuse('No other controllable vessel in range');
      w.takeVessel(list[(i + (direction === -1 ? list.length - 1 : 1)) % list.length]!);
      return ok;
    },
  };
}

export function makeDebug(w: World): SessionDebug {
  /**
   * Replace the island by one at `tick` about `bodyId` with the given members (the teleport and the time jump:
   * nothing in a flight does this). The pilot's seat goes with the active vessel.
   */
  const reseat = (tick: number, bodyId: string, members: { vessel: Vessel; options: AddOptions }[]): void => {
    const seat = w.island.seatOf(PILOT_ACCOUNT);
    w.island = w.newIsland(tick, bodyId);
    for (const m of members) w.island.add(m.vessel, m.options);
    if (!w.view.present || !w.island.member(w.active.id)) return;
    w.seat.input({ kind: 'seat', vesselId: w.active.id, aboard: true });
    if (seat) w.seat.input({ kind: 'controls', vesselId: w.active.id, controls: seat.controls, sasHold: seat.sasHold });
    w.seat.sendReference();
    if (w.view.follow()) w.touch();
  };
  return {
    setVesselState: (vesselId: string, bodyId: string, r: Vec3, v: Vec3): void => {
      const vessel = w.roster.find((x) => x.id === vesselId && w.view.entry(x) !== null);
      if (!vessel || !w.defs.bodies[bodyId]) throw new Error('debug.setVesselState: unknown vessel or body');
      w.cheatCounter++;
      // Everything else stays where it is; the vessel is put down at the given state, free unless it is clamped or fixed.
      const here = w.island.bodyId;
      const others = w.island.members.filter((m) => m.vessel !== vessel).map((m) => ({ vessel: m.vessel, options: { bornTick: m.bornTick, revision: m.revision, conic: m.orbit ? { orbit: m.orbit, event: m.railsEvent } : undefined } }));
      const was = w.island.member(vessel.id) ?? w.far.take(vessel.id, w.tick);
      if (!was) throw new Error('debug.setVesselState: unknown vessel or body');
      vessel.r = v3.clone(r);
      vessel.v = v3.clone(v);
      if (vessel.hold !== 'clamps' && vessel.hold !== 'ground') {
        vessel.hold = null;
        vessel.surface = 'none';
      }
      vessel.anchor = null;
      const moved = { vessel, options: { bornTick: was.bornTick, revision: was.revision + 1 } };
      if (vessel === w.active || bodyId === here) {
        const stay = bodyId === here ? others : [];
        if (bodyId !== here) for (const m of w.island.members) if (m.vessel !== vessel) w.far.add(m.vessel, here, w.tick, { bornTick: m.bornTick, revision: m.revision, orbit: m.orbit, railsEvent: m.railsEvent, order: w.orderOf(m.vessel) });
        reseat(w.tick, bodyId, [...stay, moved]);
      } else {
        reseat(w.tick, here, others);
        w.far.add(vessel, bodyId, w.tick, { bornTick: was.bornTick, revision: was.revision + 1, orbit: null, railsEvent: null, order: w.orderOf(vessel) });
      }
      w.plan.patchesDirty = true;
      w.warpStamp = -1;
      w.touch();
    },
    setResource: (vesselId: string, partInstanceId: string, resource: string, kg: number): void => {
      const vessel = w.roster.find((x) => x.id === vesselId && w.view.entry(x) !== null);
      const part = vessel?.parts.find((p) => p.instanceId === partInstanceId);
      const k = part ? (part.def.resources ?? []).findIndex((x) => x.resource === resource) : -1;
      if (!vessel || !part || k < 0 || !Number.isFinite(kg) || kg < 0) throw new Error('debug.setResource: unknown vessel, part or resource');
      w.cheatCounter++;
      part.resources[k] = kg;
      w.plan.stageInfoDirty = true;
      w.touch();
    },
    setUt: (ut: number): void => {
      if (!Number.isFinite(ut)) throw new Error('debug.setUt: invalid time');
      w.cheatCounter++;
      // The clock stays on the tick grid: the time is set to the whole tick nearest to the request.
      const tick = nearestTick(ut);
      const to = utOfTick(tick);
      const from = w.ut;
      const shiftTicks = tick - w.tick;
      const bodyId = w.island.bodyId;
      // Every conic is re-made at the new instant from where the vessel is on it now; ages and plans move with the clock.
      const members = w.island.members.map((m) => {
        const orbit = m.orbit ? orbitOf(w.frames, bodyId, propagate(m.orbit, from), to) : null;
        return { vessel: m.vessel, options: { bornTick: m.bornTick + shiftTicks, revision: m.revision, conic: orbit ? { orbit, event: m.railsEvent ? computeRailsEvent(w.frames, bodyId, orbit, to) : null } : undefined } };
      });
      w.far.shiftClock(shiftTicks, from, to);
      for (const n of w.plan.nodes) n.ut += to - from;
      reseat(tick, bodyId, members);
      for (const m of w.island.members) if (m.vessel.hold !== null) rideBody(m.vessel, w.island.environmentOf(m.vessel.id)!, 0);
      for (const o of w.far.objects) w.far.sync(o, tick);
      w.plan.patchesDirty = true;
      w.warpStamp = -1;
      w.touch();
    },
  };
}
