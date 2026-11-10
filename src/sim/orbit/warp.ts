/**
 * Time-warp maths as pure functions (docs/research/sim-design.md section 5). The world applies the
 * results (it also knows mustIntegrate, rotation and control-input rules); nothing here has state.
 *
 *  - Altitude caps: rails level i (i > MAX_PHYSICS_WARP_INDEX) needs altitude >= warpAltitudeLimits[i - 4].
 *  - Event look-ahead: the allowed level is the largest w with (tEvent - ut) / factor(w) >= 4 s of real
 *    time; for an SOI change the look-ahead never drops below 50x (the change itself is processed exactly
 *    when the rails advance is clamped to it).
 *  - nextWarpEvent: earliest of SOI change, atmosphere entry, terrain proximity (shell at max elevation
 *    + 1000 m), impact, node lead time (node.ut - burnTime/2 - lead) for nodes any number of revolutions
 *    ahead, the analytic crossing of the current level's altitude-limit shell, and caller alarms.
 */
import { MAX_PHYSICS_WARP_INDEX, WARP_LEVELS, type BodyDef } from '../../core/contracts/defs';
import type { ManeuverNode, Patch } from '../../core/contracts/sim';
import { v3, type Vec3 } from '../../core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { atmosphereEntryTime, nextRadiusCrossing } from './events';
import { makeOrbit } from './kepler';

/** Real seconds the look-ahead keeps between the warp step and the event. */
export const WARP_LOOKAHEAD_REAL_SECONDS = 4;
/** Lead time before a node's burn start that limits warp, s. */
export const NODE_WARP_LEAD = 30;
/** Height above the body's maximum elevation below which terrain proximity forces integration, m. */
export const TERRAIN_PROXIMITY_MARGIN = 1000;
/** Index of the 50x level: the lowest the look-ahead drops to for an SOI change. */
export const SOI_CHANGE_MIN_WARP_INDEX = WARP_LEVELS.indexOf(50);

export const warpFactor = (index: number): number => WARP_LEVELS[Math.max(0, Math.min(WARP_LEVELS.length - 1, Math.round(index)))]!;

/** Highest warp index allowed by the body's altitude limits at `altitude` (physics levels always allowed). */
export function maxWarpIndexForAltitude(body: BodyDef, altitude: number): number {
  let idx = MAX_PHYSICS_WARP_INDEX;
  for (let i = MAX_PHYSICS_WARP_INDEX + 1; i < WARP_LEVELS.length; i++) {
    const lim = body.warpAltitudeLimits[i - MAX_PHYSICS_WARP_INDEX - 1];
    if (lim === undefined || !(altitude >= lim)) break;
    idx = i;
  }
  return idx;
}

/** Altitude limit (m) of a rails warp level, or null for physics levels. */
export function warpAltitudeLimit(body: BodyDef, index: number): number | null {
  if (index <= MAX_PHYSICS_WARP_INDEX) return null;
  const lim = body.warpAltitudeLimits[index - MAX_PHYSICS_WARP_INDEX - 1];
  return lim === undefined ? Infinity : lim;
}

export type WarpEventKind = 'soiChange' | 'atmosphere' | 'terrainProximity' | 'impact' | 'node' | 'altitudeLimit' | 'alarm';

export interface WarpEvent {
  ut: number;
  kind: WarpEventKind;
  /** Node id for 'node' events. */
  nodeId?: string;
}

/** Largest warp index whose step leaves at least 4 s of real time before the event (index 0 always allowed). */
export function lookAheadWarpIndex(ut: number, event: WarpEvent | null): number {
  if (!event) return WARP_LEVELS.length - 1;
  const remaining = event.ut - ut;
  let idx = 0;
  for (let i = 1; i < WARP_LEVELS.length; i++) {
    if (remaining / WARP_LEVELS[i]! >= WARP_LOOKAHEAD_REAL_SECONDS) idx = i;
  }
  if (event.kind === 'soiChange') idx = Math.max(idx, SOI_CHANGE_MIN_WARP_INDEX);
  return idx;
}

/** Rails advance target for one frame: ut + realDt x factor, never past the event. */
export function railsAdvanceTarget(ut: number, realDt: number, warpIndex: number, eventUt: number | null): number {
  const target = ut + Math.max(0, realDt) * warpFactor(warpIndex);
  return eventUt !== null && eventUt >= ut ? Math.min(target, eventUt) : target;
}

export interface NextWarpEventInput {
  system: BodySystem;
  ut: number;
  /** Current state in BCI(bodyId). */
  bodyId: string;
  r: Vec3;
  v: Vec3;
  /** The current (node-free) predicted patches; their SOI changes and impact are events. */
  patches: readonly Patch[];
  /** Maneuver nodes with their burn-time estimates (null = no engine: lead from node.ut). */
  nodes?: readonly { node: ManeuverNode; burnTime: number | null }[];
  /** Warp level whose altitude-limit shell crossing is folded in (rails levels only). */
  warpIndex: number;
  nodeLeadTime?: number;
  /** Extra scenario/world alarm times. */
  alarms?: readonly number[];
}

/** Earliest warp-limiting event strictly after ut (events already due are reported at ut). Null if none. */
export function nextWarpEvent(input: NextWarpEventInput): WarpEvent | null {
  const { system, ut, bodyId, r, v } = input;
  const body = system.body(bodyId);
  const def = body.def;
  const found: { best: WarpEvent | null } = { best: null };
  const consider = (t: number | null, kind: WarpEventKind, nodeId?: string): void => {
    if (t === null || !Number.isFinite(t)) return;
    const tt = Math.max(ut, t);
    if (!found.best || tt < found.best.ut) found.best = nodeId === undefined ? { ut: tt, kind } : { ut: tt, kind, nodeId };
  };
  for (const p of input.patches) {
    if (p.tEnd < ut) continue;
    if (p.endReason === 'soiExit' || p.endReason === 'soiEnter') {
      consider(p.tEnd, 'soiChange');
      break;
    }
    if (p.endReason === 'impact') {
      consider(p.tEnd, 'impact');
      break;
    }
    if (p.endReason === 'atmosphere') break;
  }
  const radial = v3.len(r);
  const o = makeOrbit(bodyId, body.mu, r, v, ut);
  consider(atmosphereEntryTime(system, o, ut), 'atmosphere');
  if (def.terrain) {
    const shell = body.radius + def.terrain.maxElevation + TERRAIN_PROXIMITY_MARGIN;
    if (radial > shell) consider(nextRadiusCrossing(o, shell, -1, ut), 'terrainProximity');
  }
  const lim = warpAltitudeLimit(def, input.warpIndex);
  if (lim !== null && Number.isFinite(lim)) {
    const R = body.radius + lim;
    if (radial < R) consider(ut, 'altitudeLimit');
    else consider(nextRadiusCrossing(o, R, -1, ut), 'altitudeLimit');
  }
  const lead = input.nodeLeadTime ?? NODE_WARP_LEAD;
  for (const { node, burnTime } of input.nodes ?? []) {
    if (node.ut <= ut) continue;
    consider(node.ut - (burnTime ?? 0) / 2 - lead, 'node', node.id);
  }
  for (const a of input.alarms ?? []) if (a > ut) consider(a, 'alarm');
  return found.best;
}
