/**
 * Closest approaches between two conic chains (ARCHITECTURE 8.4, 21; PlanningService.closestApproaches,
 * `Marker` kind 'targetApproach'): the own planned (or current) chain against a target's committed-then-
 * forecast chain, across sphere-of-influence changes of either.
 *
 * Both chains are sequences of patches (each an exact conic over [tStart, tEnd] about its body). Over the span
 * they share, the separation D(t) = |r_target(t) - r_own(t)| is continuous (patched conics hand a state over
 * unchanged at an SOI change), and so is the function the search works on. The span is cut at every patch
 * boundary of either chain; each piece is sampled with a step of at most the shorter of the two conics'
 * periods / samplesPerPeriod (an open conic: its piece / samplesPerPeriod), and every sampled local minimum of
 * D (and every sign change of the range rate from closing to opening) is refined by golden section to
 * `tolerance` seconds. The results are the minima in time order, the first `count` of them.
 *
 * Precision: the separation is taken in the own body's frame; when the two are about different bodies the
 * offset between the bodies goes through their lowest common ancestor (BodySystem.stateRelative), never
 * through the system root.
 */
import type { Marker, Patch } from '../../core/contracts/sim';
import { v3, type Vec3 } from '../../core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';
import { propagate, type Orbit } from './kepler';
import { patchOrbit, type PatchWithOrbit } from './patches';
import { goldenMin } from './roots';

/** One closest approach of two chains (the contract's `ClosestApproach`, session.ts). */
export interface ChainApproach {
  ut: number;
  /** Separation, m, and relative speed, m/s, at `ut`. */
  distance: number;
  relSpeed: number;
  /** Where each is: SOI body and BCI position. */
  self: { bodyId: string; r: Vec3 };
  target: { bodyId: string; r: Vec3 };
  /** True when the target's part of the pair lies on its forecast (after `targetHeadUt`). */
  onForecast: boolean;
}

export interface ChainApproachOptions {
  /** Approaches returned, in time order (default 3). */
  count?: number;
  /** Search span start and length, s (default: the chains' common span). */
  fromUt?: number;
  horizon?: number;
  /** Distance samples per period of the faster conic (default 64). */
  samplesPerPeriod?: number;
  /** Time tolerance of the golden-section refinement, s (default 1e-3). */
  tolerance?: number;
  /** Universe time of the target's head: approaches after it are on its forecast (default: none, all committed). */
  targetHeadUt?: number;
  /** Largest number of samples one search takes (default 200,000). */
  maxSamples?: number;
}

/** A chain of patches with their orbits, for repeated evaluation. */
export interface ChainEval {
  readonly items: readonly { patch: Patch; orbit: Orbit }[];
  readonly tStart: number;
  readonly tEnd: number;
  /** Index of the patch holding t (the last one whose tStart <= t), or -1 outside the chain. */
  indexAt(t: number): number;
}

/** Chain evaluator over a patch list (Patch items are rebuilt with patchOrbit; PatchWithOrbit items keep their orbit). */
export function chainOf(patches: readonly (Patch | PatchWithOrbit)[]): ChainEval {
  const items = patches.map((p) => ('orbit' in p ? { patch: p.patch, orbit: p.orbit } : { patch: p, orbit: patchOrbit(p) }));
  const tStart = items.length ? items[0]!.patch.tStart : Infinity;
  const tEnd = items.length ? items[items.length - 1]!.patch.tEnd : -Infinity;
  return {
    items,
    tStart,
    tEnd,
    indexAt(t: number): number {
      if (!(t >= tStart && t <= tEnd)) return -1;
      let lo = 0;
      let hi = items.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (items[mid]!.patch.tStart <= t) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
  };
}

/**
 * The own chain a plan is judged on: the current patches up to the first planned patch, then the planned
 * ones (when there is a plan), so the chain starts now and follows the nodes.
 */
export function ownChain(current: readonly (Patch | PatchWithOrbit)[], planned: readonly (Patch | PatchWithOrbit)[]): (Patch | PatchWithOrbit)[] {
  const p0 = planned[0];
  if (!p0) return current.slice();
  const t0 = ('orbit' in p0 ? p0.patch : p0).tStart;
  const out: (Patch | PatchWithOrbit)[] = [];
  for (const c of current) {
    const cp = 'orbit' in c ? c.patch : c;
    if (cp.tStart >= t0) break;
    out.push(c);
  }
  return out.concat(planned);
}

interface Pair {
  t: number;
  d: number;
  rel: Vec3;
  relV: Vec3;
  ownBody: string;
  ownR: Vec3;
  tgtBody: string;
  tgtR: Vec3;
}

/** Closest approaches between the own chain and the target chain (see the module comment). */
export function chainClosestApproaches(
  system: BodySystem,
  own: readonly (Patch | PatchWithOrbit)[],
  target: readonly (Patch | PatchWithOrbit)[],
  opts: ChainApproachOptions = {},
): ChainApproach[] {
  const a = chainOf(own);
  const b = chainOf(target);
  const count = opts.count ?? 3;
  const perPeriod = opts.samplesPerPeriod ?? 64;
  const tol = opts.tolerance ?? 1e-3;
  const maxSamples = opts.maxSamples ?? 200000;
  const t0 = Math.max(a.tStart, b.tStart, opts.fromUt ?? -Infinity);
  let t1 = Math.min(a.tEnd, b.tEnd);
  if (opts.horizon !== undefined) t1 = Math.min(t1, t0 + opts.horizon);
  if (!(t1 > t0) || count <= 0) return [];

  let ia = a.indexAt(t0);
  let ib = b.indexAt(t0);
  const evalPair = (t: number): Pair => {
    // keep the cached indices when t stays in their patches (the search walks forward)
    if (!(ia >= 0 && t >= a.items[ia]!.patch.tStart && t <= a.items[ia]!.patch.tEnd)) ia = a.indexAt(t);
    if (!(ib >= 0 && t >= b.items[ib]!.patch.tStart && t <= b.items[ib]!.patch.tEnd)) ib = b.indexAt(t);
    const pa = a.items[ia]!;
    const pb = b.items[ib]!;
    const sa = propagate(pa.orbit, t);
    const sb = propagate(pb.orbit, t);
    let rel: Vec3;
    let relV: Vec3;
    if (pa.patch.bodyId === pb.patch.bodyId) {
      rel = v3.sub(sb.r, sa.r);
      relV = v3.sub(sb.v, sa.v);
    } else {
      const off = system.stateRelative(pb.patch.bodyId, pa.patch.bodyId, t);
      rel = v3.add(off.r, v3.sub(sb.r, sa.r));
      relV = v3.add(off.v, v3.sub(sb.v, sa.v));
    }
    return { t, d: v3.len(rel), rel, relV, ownBody: pa.patch.bodyId, ownR: sa.r, tgtBody: pb.patch.bodyId, tgtR: sb.r };
  };
  const D = (t: number): number => evalPair(t).d;
  // the range rate times the range: negative closing, positive opening
  const rangeRate = (p: Pair): number => v3.dot(p.rel, p.relV);

  // Piece boundaries: every patch boundary of either chain inside (t0, t1).
  const cuts = new Set<number>([t0, t1]);
  for (const it of a.items) for (const t of [it.patch.tStart, it.patch.tEnd]) if (t > t0 && t < t1) cuts.add(t);
  for (const it of b.items) for (const t of [it.patch.tStart, it.patch.tEnd]) if (t > t0 && t < t1) cuts.add(t);
  const bounds = [...cuts].sort((x, y) => x - y);

  // Samples: per piece, a step of the shorter period / perPeriod.
  const ts: number[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const s0 = bounds[k]!;
    const s1 = bounds[k + 1]!;
    const mid = (s0 + s1) / 2;
    const pa = a.items[a.indexAt(mid)]!;
    const pb = b.items[b.indexAt(mid)]!;
    const shortest = Math.min(pa.orbit.period ?? Infinity, pb.orbit.period ?? Infinity);
    const span = s1 - s0;
    const n = Math.max(2, Number.isFinite(shortest) ? Math.ceil((perPeriod * span) / shortest) : perPeriod);
    for (let i = 0; i < n; i++) ts.push(s0 + (span * i) / n);
    if (ts.length > maxSamples) break;
  }
  ts.push(t1);

  const out: ChainApproach[] = [];
  const seen: number[] = [];
  const pairs = ts.map((t) => evalPair(t));
  const push = (lo: number, hi: number): void => {
    const m = goldenMin(D, lo, hi, tol);
    // an approach found twice (by the sample minimum and by the range-rate sign change) is one approach
    if (seen.some((s) => Math.abs(s - m.x) <= 10 * tol)) return;
    seen.push(m.x);
    const p = evalPair(m.x);
    out.push({
      ut: m.x,
      distance: p.d,
      relSpeed: v3.len(p.relV),
      self: { bodyId: p.ownBody, r: v3.clone(p.ownR) },
      target: { bodyId: p.tgtBody, r: v3.clone(p.tgtR) },
      onForecast: opts.targetHeadUt !== undefined && m.x > opts.targetHeadUt,
    });
  };
  for (let i = 0; i < pairs.length && out.length < count; i++) {
    const p = pairs[i]!;
    const prev = pairs[i - 1];
    const next = pairs[i + 1];
    // the span's first and last instants: a minimum there is where the chains begin or end, not an approach
    if (!prev || !next) continue;
    const sampleMin = p.d < prev.d && p.d <= next.d;
    const turning = rangeRate(prev) < 0 && rangeRate(p) >= 0;
    if (sampleMin) push(prev.t, next.t);
    else if (turning) push(prev.t, p.t);
  }
  out.sort((x, y) => x.ut - y.ut);
  return out.slice(0, count);
}

/**
 * The 'targetApproach' markers of a set of approaches (the contract's pair marker: own position on the own
 * patch, the target's position and body, separation and relative speed).
 */
export function targetApproachMarkers(approaches: readonly ChainApproach[], otherVesselId: string): Marker[] {
  return approaches.map((c) => ({
    kind: 'targetApproach',
    ut: c.ut,
    bodyId: c.self.bodyId,
    r: v3.clone(c.self.r),
    value: c.distance,
    otherVesselId,
    otherBodyId: c.target.bodyId,
    otherR: v3.clone(c.target.r),
    relSpeed: c.relSpeed,
    onForecast: c.onForecast,
  }));
}
