/**
 * Patched-conic trajectory prediction (docs/research/sim-design.md 3.3-3.6; Patch contract in
 * src/core/contracts/sim.ts).
 *
 * predictPatches returns two lists:
 *  - current: the node-free trajectory from (state, ut). Nodes do not change it; the FIRST future node
 *    is marked on the patch that contains it ('maneuverNode' marker). Multi-revolution rule: a closed
 *    patch with no event ends after one period ('closed', nuEnd = nuStart + 2 pi) - but when the first
 *    node lies further ahead than that (and no event comes first), the same conic is followed to the node
 *    (tEnd = node.ut, endReason 'maneuver', nuEnd unwrapped), however many revolutions that is, and the
 *    list ends there (the node-free continuation is the same conic). The same applies to an open patch
 *    whose node lies beyond the horizon.
 *  - planned: from the first node on: the state on the current trajectory at node.ut plus the node's
 *    delta-v, then every later node applied in time order (each one ends its patch with 'maneuver'); every
 *    planned patch carries `afterNodeId` = the latest node applied. Nodes in the past (ut < start) are
 *    ignored; a node the current trajectory cannot reach (it ends with impact/atmosphere before the node)
 *    leaves `planned` empty.
 *
 * Per patch the earliest of: SOI exit (analytic), atmosphere entry (analytic; ends the list), child SOI
 * entry (sampled, see events.ts), terrain impact (march; ends the list), maneuver node (planned), natural
 * end (one period / horizon). After an SOI transition the crossed boundary is ignored for 1 s (hysteresis).
 */
import type { ManeuverNode, Marker, Patch, PatchEndReason } from '../../core/contracts/sim';
import type { StateVector } from '../../core/contracts/simInternal';
import { conicPosition } from '../../core/math/conic';
import { quat } from '../../core/math/quat';
import { TWO_PI } from '../../core/math/scalar';
import { v3, type Vec3 } from '../../core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { meanAnomalyFromTrue } from './anomaly';
import {
  atmosphereEntryTime,
  closestApproaches,
  findImpact,
  findSoiEntry,
  nextApsisTime,
  soiExitTime,
  timeOfTrueAnomaly,
  type CoarseHeightFn,
} from './events';
import { conicStateAtTime, makeOrbit, NEAR_RADIAL_P, propagate, type Orbit } from './kepler';
import { nodeDeltaVInertial } from './maneuver';
import { nodesVersusPlane } from './relative';

export const DEFAULT_MAX_PATCHES = 8;
/** Prediction horizon for open trajectories, s (60 days). */
export const DEFAULT_HORIZON = 60 * 86400;
/** SOI boundary hysteresis after a transition, s. */
export const SOI_HYSTERESIS = 1;

export interface PredictOptions {
  /** Patches per list (default 8). */
  maxPatches?: number;
  /** Horizon for open trajectories, s from the start of each list and from every applied node (default 60 d). */
  horizon?: number;
  /** Target body: AN/DN and closest-approach markers on patches about the target's parent. */
  targetBodyId?: string | null;
  /** Coarse terrain height for impact prediction; omitted = reference sphere (and sea surface). */
  terrainHeight?: CoarseHeightFn | null;
  /** Distance samples per patch for closest approach (default 64). */
  closestApproachSamples?: number;
}

export interface TrajectoryState {
  bodyId: string;
  /** BCI(bodyId) state. */
  r: Vec3;
  v: Vec3;
}

export interface PredictedPatches {
  current: Patch[];
  planned: Patch[];
}

/** A predicted patch together with the Orbit it was built from (exact propagation along the patch). */
export interface PatchWithOrbit {
  patch: Patch;
  orbit: Orbit;
}

const sortNodes = (nodes: readonly ManeuverNode[]): ManeuverNode[] =>
  nodes.slice().sort((a, b) => a.ut - b.ut || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Unwrapped true anomaly at tEnd for a patch that started at (tStart, nuStart) on orbit `o`. */
function unwrappedNuEnd(o: Orbit, tStart: number, nuStart: number, tEnd: number, rEnd: Vec3): number {
  const c = o.conic;
  const nuE = Math.atan2(v3.dot(rEnd, c.Q), v3.dot(rEnd, c.P));
  if (o.period === null) return nuE;
  const dM = (TWO_PI / o.period) * (tEnd - tStart);
  const Ms = meanAnomalyFromTrue(c.e, nuStart);
  const Me = meanAnomalyFromTrue(c.e, nuE);
  const k = Math.round((Ms + dM - Me) / TWO_PI);
  return nuE + TWO_PI * k;
}

function latLonOf(system: BodySystem, bodyId: string, r: Vec3, ut: number): { latitude: number; longitude: number } {
  const d = quat.rotateInv(system.orientation(bodyId, ut), r);
  return { latitude: Math.atan2(d.z, Math.hypot(d.x, d.y)), longitude: Math.atan2(d.y, d.x) };
}

type Mode = 'current' | 'planned';

interface Hysteresis {
  bodyId: string;
  until: number;
}

interface ChainResult {
  items: PatchWithOrbit[];
}

function runChain(
  system: BodySystem,
  start: TrajectoryState,
  t0: number,
  nodes: readonly ManeuverNode[],
  mode: Mode,
  opts: PredictOptions,
  firstAfterNodeId: string | undefined,
): ChainResult {
  const maxPatches = opts.maxPatches ?? DEFAULT_MAX_PATCHES;
  const horizon = opts.horizon ?? DEFAULT_HORIZON;
  const heightFn = opts.terrainHeight ?? null;
  const targetId = opts.targetBodyId ?? null;
  const items: PatchWithOrbit[] = [];
  let bodyId = start.bodyId;
  let r = v3.clone(start.r);
  let v = v3.clone(start.v);
  let t = t0;
  let after = firstAfterNodeId;
  let nodeIdx = 0;
  let horizonEnd = t0 + horizon;
  let hyst: Hysteresis | null = null;

  while (items.length < maxPatches) {
    if (mode === 'planned') {
      while (nodeIdx < nodes.length && nodes[nodeIdx]!.ut <= t) {
        const n = nodes[nodeIdx]!;
        v = v3.add(v, nodeDeltaVInertial(n.dv, r, v));
        after = n.id;
        horizonEnd = Math.max(horizonEnd, n.ut + horizon);
        nodeIdx++;
      }
    }
    const body = system.body(bodyId);
    const o = makeOrbit(bodyId, body.mu, r, v, t);
    const nextNode = mode === 'planned' ? nodes[nodeIdx] : nodes[0] !== undefined && nodes[0].ut >= t ? nodes[0] : undefined;
    const closed = o.period !== null;

    let tEnd = closed ? t + o.period! : Math.max(horizonEnd, t);
    let reason: PatchEndReason = closed ? 'closed' : 'horizon';
    if (nextNode && nextNode.ut > tEnd) {
      tEnd = nextNode.ut;
      reason = 'maneuver';
    }
    let nextBodyId: string | undefined;

    // SOI exit (analytic)
    if (body.soiRadius !== null) {
      const from = hyst && hyst.bodyId === bodyId ? Math.max(t, hyst.until) : t;
      const tx = soiExitTime(o, body.soiRadius, from);
      if (tx !== null && tx < tEnd) {
        tEnd = tx;
        reason = 'soiExit';
        nextBodyId = body.parentId ?? undefined;
      }
    }
    // atmosphere entry (analytic)
    const ta = atmosphereEntryTime(system, o, t);
    if (ta !== null && ta < tEnd) {
      tEnd = ta;
      reason = 'atmosphere';
      nextBodyId = undefined;
    }
    // node inside the window (planned list only: nodes change the trajectory)
    if (mode === 'planned' && nextNode && nextNode.ut < tEnd) {
      tEnd = nextNode.ut;
      reason = 'maneuver';
      nextBodyId = undefined;
    }
    // child SOI entries
    for (const cid of body.childIds) {
      const from = hyst && hyst.bodyId === cid ? Math.max(t, hyst.until) : t;
      const tc = findSoiEntry(system, o, cid, from, tEnd);
      if (tc !== null && tc < tEnd) {
        tEnd = tc;
        reason = 'soiEnter';
        nextBodyId = cid;
      }
    }
    // terrain impact
    const imp = findImpact(system, o, t, tEnd, heightFn);
    if (imp && imp.t <= tEnd) {
      tEnd = imp.t;
      reason = 'impact';
      nextBodyId = undefined;
    }

    const end = propagate(o, tEnd);
    // A radial trajectory stays on the ray -P: true anomaly pi throughout (see Orbit.conic).
    const nuStart = o.radial ? Math.PI : Math.atan2(v3.dot(r, o.conic.Q), v3.dot(r, o.conic.P));
    const nuEnd = o.radial ? Math.PI : reason === 'closed' ? nuStart + TWO_PI : unwrappedNuEnd(o, t, nuStart, tEnd, end.r);
    const markers = buildMarkers(system, o, t, tEnd, reason, nextBodyId, end, imp?.height ?? null, mode, nextNode, targetId, opts);
    const patch: Patch = {
      bodyId,
      conic: o.conic,
      tStart: t,
      tEnd,
      nuStart,
      nuEnd,
      endReason: reason,
      bodyPosAtEnd: system.stateRoot(bodyId, tEnd).r,
      markers,
    };
    if (nextBodyId !== undefined) patch.nextBodyId = nextBodyId;
    if (after !== undefined) patch.afterNodeId = after;
    items.push({ patch, orbit: o });

    if (reason === 'soiExit') {
      const bs = system.stateRelParent(bodyId, tEnd);
      hyst = { bodyId, until: tEnd + SOI_HYSTERESIS };
      r = v3.add(end.r, bs.r);
      v = v3.add(end.v, bs.v);
      bodyId = nextBodyId!;
    } else if (reason === 'soiEnter') {
      const cs = system.stateRelParent(nextBodyId!, tEnd);
      hyst = { bodyId: nextBodyId!, until: tEnd + SOI_HYSTERESIS };
      r = v3.sub(end.r, cs.r);
      v = v3.sub(end.v, cs.v);
      bodyId = nextBodyId!;
    } else if (reason === 'maneuver' && mode === 'planned') {
      const n = nextNode!;
      r = end.r;
      v = v3.add(end.v, nodeDeltaVInertial(n.dv, end.r, end.v));
      after = n.id;
      horizonEnd = Math.max(horizonEnd, n.ut + horizon);
      nodeIdx++;
    } else break;
    t = tEnd;
  }
  return { items };
}

function buildMarkers(
  system: BodySystem,
  o: Orbit,
  tStart: number,
  tEnd: number,
  reason: PatchEndReason,
  nextBodyId: string | undefined,
  end: StateVector,
  impactHeight: number | null,
  mode: Mode,
  nextNode: ManeuverNode | undefined,
  targetId: string | null,
  opts: PredictOptions,
): Marker[] {
  const bodyId = o.bodyId;
  const body = system.body(bodyId);
  const c = o.conic;
  const R = body.radius;
  const markers: Marker[] = [];
  const eps = 1e-6;

  // apsides
  for (const kind of ['periapsis', 'apoapsis'] as const) {
    const ta = nextApsisTime(o, kind, tStart - eps);
    if (ta !== null && ta <= tEnd) {
      const r = propagate(o, ta).r;
      markers.push({ kind, ut: ta, bodyId, r, altitude: v3.len(r) - R, ...latLonOf(system, bodyId, r, ta) });
    }
  }

  // target plane nodes and closest approach (target orbiting this patch's body)
  if (targetId !== null && targetId !== bodyId) {
    const target = system.body(targetId);
    if (target.parentId === bodyId && target.kepler) {
      const nodes = o.nearRadial ? null : nodesVersusPlane(c, target.kepler.normal);
      if (nodes) {
        for (const [kind, nu] of [
          ['ascendingNode', nodes.nuAscending],
          ['descendingNode', nodes.nuDescending],
        ] as const) {
          const tn = timeOfTrueAnomaly(o, nu, tStart - eps);
          if (tn !== null && tn <= tEnd) markers.push({ kind, ut: tn, bodyId, r: conicPosition(c, nu), value: nodes.relativeInclination });
        }
      }
      if (!(reason === 'soiEnter' && nextBodyId === targetId)) {
        for (const ca of closestApproaches(system, o, targetId, tStart, tEnd, opts.closestApproachSamples ?? 64, 2)) {
          markers.push({ kind: 'closestApproach', ut: ca.t, bodyId, r: ca.r, value: ca.distance });
        }
      }
    }
  }

  // maneuver node
  if (mode === 'current') {
    if (nextNode && nextNode.ut >= tStart && nextNode.ut <= tEnd) {
      markers.push({ kind: 'maneuverNode', ut: nextNode.ut, bodyId, r: propagate(o, nextNode.ut).r, nodeId: nextNode.id });
    }
  } else if (reason === 'maneuver' && nextNode) {
    markers.push({ kind: 'maneuverNode', ut: tEnd, bodyId, r: end.r, nodeId: nextNode.id });
  }

  // end events
  if (reason === 'soiExit') markers.push({ kind: 'soiExit', ut: tEnd, bodyId, r: end.r, altitude: v3.len(end.r) - R });
  else if (reason === 'soiEnter') markers.push({ kind: 'soiEnter', ut: tEnd, bodyId, r: end.r });
  else if (reason === 'impact') {
    markers.push({ kind: 'impact', ut: tEnd, bodyId, r: end.r, altitude: impactHeight ?? v3.len(end.r) - R, value: v3.len(end.v), ...latLonOf(system, bodyId, end.r, tEnd) });
  } else if (reason === 'atmosphere') {
    const rm = v3.len(end.r);
    const vm = v3.len(end.v);
    markers.push({
      kind: 'atmosphereEntry',
      ut: tEnd,
      bodyId,
      r: end.r,
      altitude: rm - R,
      value: vm,
      flightPathAngle: Math.asin(Math.max(-1, Math.min(1, v3.dot(end.r, end.v) / (rm * vm)))),
      vacuumPeriapsisAltitude: c.p / (1 + c.e) - R,
      ...latLonOf(system, bodyId, end.r, tEnd),
    });
  }
  markers.sort((a, b) => a.ut - b.ut);
  return markers;
}

/**
 * Like predictPatches, but each patch comes with the Orbit it was propagated on (for consumers that need
 * exact states along the prediction, e.g. the node pre-burn state or the pilot's searches).
 */
export function predictPatchesWithOrbits(
  system: BodySystem,
  state: TrajectoryState,
  ut: number,
  nodes: readonly ManeuverNode[],
  opts: PredictOptions = {},
): { current: PatchWithOrbit[]; planned: PatchWithOrbit[] } {
  const future = sortNodes(nodes.filter((n) => n.ut >= ut));
  const cur = runChain(system, state, ut, future.slice(0, 1), 'current', opts, undefined).items;
  const first = future[0];
  if (!first) return { current: cur, planned: [] };
  const host = cur.find((p) => first.ut >= p.patch.tStart && first.ut <= p.patch.tEnd);
  if (!host) return { current: cur, planned: [] };
  const s = propagate(host.orbit, first.ut);
  const v = v3.add(s.v, nodeDeltaVInertial(first.dv, s.r, s.v));
  const planned = runChain(system, { bodyId: host.orbit.bodyId, r: s.r, v }, first.ut, future.slice(1), 'planned', opts, first.id).items;
  return { current: cur, planned };
}

/**
 * Predicted patches of a vessel at `state` (BCI of state.bodyId) at time `ut` with maneuver nodes
 * `nodes` (any order; past nodes ignored). See the module comment for the exact semantics.
 */
export function predictPatches(system: BodySystem, state: TrajectoryState, ut: number, nodes: readonly ManeuverNode[], opts: PredictOptions = {}): PredictedPatches {
  const p = predictPatchesWithOrbits(system, state, ut, nodes, opts);
  return { current: p.current.map((x) => x.patch), planned: p.planned.map((x) => x.patch) };
}

/**
 * Orbit of a patch re-built from the contract data alone (conic, nuStart, tStart), for patches received
 * without their Orbit. Ordinary conics: the state at nuStart (exact to rounding). Radial (p = 0) and
 * near-radial conics (p < NEAR_RADIAL_P r at the start, where 1 + e cos nu has lost its digits): the state
 * at tStart from the periapsis passage by conicStateAtTime (error ~ |v| x 1e-7 s). Never throws for a
 * patch produced by predictPatches. Prefer the Orbit from predictPatchesWithOrbits where available.
 */
export function patchOrbit(patch: Patch): Orbit {
  const c = patch.conic;
  const nu = patch.nuStart;
  const cs = Math.cos(nu);
  if (c.p > 0 && 1 + c.e * cs > NEAR_RADIAL_P) {
    const r = conicPosition(c, nu);
    const k = Math.sqrt(c.mu / c.p);
    const v = v3.add(v3.scale(c.P, -Math.sin(nu) * k), v3.scale(c.Q, (c.e + cs) * k));
    return makeOrbit(patch.bodyId, c.mu, r, v, patch.tStart);
  }
  const s = conicStateAtTime(c, patch.tStart);
  return makeOrbit(patch.bodyId, c.mu, s.r, s.v, patch.tStart);
}

/**
 * State at time t on a patch list: the first patch with tStart <= t <= tEnd, propagated there; null when t
 * is outside the predicted span. Pass the PatchWithOrbit items of predictPatchesWithOrbits for states
 * exact to rounding (propagated from each patch's own epoch state, e.g. the node pre-burn state); plain
 * Patch items are re-built by patchOrbit.
 */
export function stateOnPatches(patches: readonly (Patch | PatchWithOrbit)[], t: number): (TrajectoryState & { patchIndex: number }) | null {
  for (let i = 0; i < patches.length; i++) {
    const item = patches[i]!;
    const p = 'orbit' in item ? item.patch : item;
    if (t >= p.tStart && t <= p.tEnd) {
      const s = propagate('orbit' in item ? item.orbit : patchOrbit(p), t);
      return { bodyId: p.bodyId, r: s.r, v: s.v, patchIndex: i };
    }
  }
  return null;
}
