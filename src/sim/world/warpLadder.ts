/**
 * The warp ladder of the single-clock host (ARCHITECTURE section 3, `WARP_LEVELS`; v1's warp rules): the
 * highest level the pilot's situation admits, why, and the next event that bounds it. Levels 0-3 are
 * physics warp (more steps), the rest rails warp. The host asks before it advances; the rules are v1's.
 */
import { MAX_PHYSICS_WARP_INDEX, WARP_LEVELS } from '@/core/contracts/defs';
import type { TimeLimitKind, TimeView } from '@/core/contracts/net';
import type { Patch, SimSnapshot } from '@/core/contracts/sim';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import type { BodyDef } from '@/core/contracts/defs';
import type { BodySystem } from '../bodies/bodySystem';
import { lookAheadWarpIndex, maxWarpIndexForAltitude, nextWarpEvent, warpFactor, type WarpEvent } from '../orbit/warp';
import type { ManeuverNode } from '@/core/contracts/sim';
import { WARP_CLAMP_RADAR_ALTITUDE } from '../island/terrainPolicy';
import { radarAltitude, structureOf } from '../vessel';
import { privateClockView } from '../view/snapshot';
import type { World } from './sim';

/** Inertial body rate above which rails warp is refused, rad/s. */
export const ROTATION_WARP_LIMIT = 0.5 * DEG;

const RAILS_REFUSED = 'Cannot warp on rails while under acceleration, in an atmosphere or near terrain';
const ROTATING_REFUSED = 'Cannot warp while rotating';

/** What the ladder is told about the pilot's vessel when it is asked. */
export interface LadderSubject {
  /** The vessel is gone. */
  gone: boolean;
  /** Something in the island must be integrated. */
  mustIntegrate: boolean;
  held: boolean;
  /** Body rate, rad/s, and whether a rails advance is already under way (a turning vessel then keeps its rate). */
  rate: number;
  railsWarpActive: boolean;
  ut: number;
  bodyId: string;
  bodyDef: BodyDef;
  bodyRadius: number;
  /** Centre-of-mass state about the body. */
  com: { r: Vec3; v: Vec3 };
  patches: readonly Patch[];
  /** The nodes with their burn times; asked only when the ladder looks ahead along the trajectory. */
  nodes(): { node: ManeuverNode; burnTime: number | null }[];
  /** Times at which an armed altitude rule would be passed on the current conic. */
  alarms(): number[];
  /** The earliest lead time of a node ahead (what a held vessel's warp looks out for). */
  nodeEvent(): WarpEvent | null;
  /** Below the terrain rule's radar altitude with terrain data that is not final yet. */
  terrainLoading: boolean;
}

export class WarpLadder {
  index = 0;
  max = MAX_PHYSICS_WARP_INDEX;
  limitedBy: string | null = null;
  /** What kind of limit `limitedBy` is (TimeView.limitedBy.kind): set where the sentence is chosen. */
  limitKind: TimeLimitKind | null = null;
  event: WarpEvent | null = null;
  terrainClampActive = false;

  constructor(private readonly system: BodySystem) {}

  /** The clock blocks of a snapshot for a pilot alone on this ladder's private clock, at `tick`; `onRails`: the last advance was a rails advance. */
  blocks(tick: number, onRails: boolean): { time: TimeView; warp: SimSnapshot['warp'] } {
    const rate = warpFactor(this.index);
    return {
      // One private clock nobody else is on: the pilot's tick is the live tick.
      time: privateClockView(tick, rate, warpFactor(this.max), this.limitedBy === null ? null : { kind: this.limitKind ?? 'event', text: this.limitedBy }),
      warp: { index: this.index, factor: rate, maxIndex: this.max, limitedBy: this.limitedBy, onRails },
    };
  }

  /** `refresh` with what the host's state says of the pilot's vessel, its plan and its terrain. */
  refreshFor(w: World): void {
    const a = w.view.focus();
    const v = a.vessel;
    const base = w.frames.base(a.bodyId);
    const subject = w.view.subject();
    const com = subject.com;
    const present = w.view.present;
    // Terrain rule: 1x below 300 m radar altitude until final data is resident.
    const terrainLoading =
      present && v.hold === null && base.hasTerrain && v.groundClearance < WARP_CLAMP_RADAR_ALTITUDE + structureOf(v).boundingRadius && radarAltitude(v, w.view.envOf(a)) < WARP_CLAMP_RADAR_ALTITUDE && !w.island.terrainFinalUnder(v.id);
    this.refresh({
      gone: !present,
      mustIntegrate: present && w.mustIntegrate(),
      held: v.hold !== null,
      rate: v3.len(v.w),
      railsWarpActive: w.railsWarpActive,
      ut: w.ut,
      bodyId: a.bodyId,
      bodyDef: base.def,
      bodyRadius: base.info.radius,
      com,
      patches: w.plan.patches.current,
      nodes: () => w.plan.nodes.map((node) => ({ node, burnTime: w.plan.burnTimeFor(subject, node) })),
      alarms: () => w.mission.altitudeAlarms(a, com),
      nodeEvent: () => w.plan.nodeEvent(subject),
      terrainLoading,
    });
  }

  /** Recompute the highest allowed level, why, and the next warp-limiting event. */
  refresh(s: LadderSubject): void {
    let max = WARP_LEVELS.length - 1;
    let limitedBy: string | null = null;
    let kind: TimeLimitKind | null = null;
    let event: WarpEvent | null = null;
    if (s.gone) {
      max = MAX_PHYSICS_WARP_INDEX;
      limitedBy = 'No vessel';
      kind = 'physics';
    } else if (s.mustIntegrate) {
      max = MAX_PHYSICS_WARP_INDEX;
      limitedBy = RAILS_REFUSED;
      kind = 'physics';
    } else if (!s.held && s.rate > ROTATION_WARP_LIMIT && !s.railsWarpActive) {
      max = MAX_PHYSICS_WARP_INDEX;
      limitedBy = ROTATING_REFUSED;
      kind = 'physics';
    } else if (s.held) {
      // Landed: any level; the only events are node lead times.
      event = s.nodeEvent();
      const la = lookAheadWarpIndex(s.ut, event);
      if (la < max) {
        max = Math.max(la, MAX_PHYSICS_WARP_INDEX);
        limitedBy = 'Maneuver node ahead';
        kind = 'event';
      }
    } else {
      const alt = v3.len(s.com.r) - s.bodyRadius;
      let idx = maxWarpIndexForAltitude(s.bodyDef, alt);
      if (idx < max) {
        limitedBy = 'Altitude too low for a higher warp level';
        kind = 'altitude';
      }
      const nodes = s.nodes();
      const alarms = s.alarms();
      const eventFor = (level: number): WarpEvent | null =>
        nextWarpEvent({ system: this.system, ut: s.ut, bodyId: s.bodyId, r: s.com.r, v: s.com.v, patches: s.patches as Patch[], nodes, warpIndex: level, alarms });
      // The look-ahead depends on the level: step down until a level is admissible. The crossing of a
      // level's own altitude-limit shell is an event for that level alone - the next level down has its
      // own, lower shell - so it costs one level; every other event bounds all levels alike.
      for (let guard = 0; guard < WARP_LEVELS.length && idx > MAX_PHYSICS_WARP_INDEX; guard++) {
        const ev = eventFor(idx);
        const la = lookAheadWarpIndex(s.ut, ev);
        if (la >= idx) break;
        idx = ev !== null && ev.kind === 'altitudeLimit' ? idx - 1 : Math.max(la, MAX_PHYSICS_WARP_INDEX);
        limitedBy = describeEvent(ev);
        kind = ev !== null && ev.kind === 'altitudeLimit' ? 'altitude' : 'event';
      }
      max = idx;
      event = eventFor(Math.min(this.index, max));
    }
    // Terrain rule: 1x below the clamp's radar altitude until final data is resident.
    this.terrainClampActive = false;
    if (s.terrainLoading) {
      max = 0;
      limitedBy = 'Terrain data loading';
      kind = 'physics';
      this.terrainClampActive = true;
    }
    this.max = max;
    this.limitedBy = limitedBy;
    this.limitKind = limitedBy === null ? null : (kind ?? 'event');
    this.event = event;
  }
}

function describeEvent(ev: WarpEvent | null): string {
  if (!ev) return 'Event ahead';
  switch (ev.kind) {
    case 'soiChange':
      return 'Sphere of influence change ahead';
    case 'atmosphere':
      return 'Atmosphere entry ahead';
    case 'terrainProximity':
      return 'Terrain ahead';
    case 'impact':
      return 'Impact ahead';
    case 'node':
      return 'Maneuver node ahead';
    case 'altitudeLimit':
      return 'Altitude too low for this warp level';
    default:
      return 'Event ahead';
  }
}
