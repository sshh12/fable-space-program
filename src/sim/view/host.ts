/**
 * How the view reads the vessels a host holds (ARCHITECTURE 7.1 "View"): a member of an island, and an object
 * of the clock outside it (src/sim/island/far.ts). Pure over the state they are given; the host says which
 * vessels there are and in which order.
 */
import { utOfTick } from '../clock';
import type { Departure, FarObject, FarSet, Island, IslandEnv, IslandMember } from '../island';
import { comStateOf, type BodyFrames } from '../island/frames';
import type { PlanSubject } from './planning';
import type { ViewVessel } from './snapshot';

/** A member of an island at the island's tick. An Armed member is on its conic: the snapshot calls its translation 'rails'. */
export function viewOfMember(island: Island, m: IslandMember): ViewVessel {
  return { vessel: m.vessel, bodyId: island.bodyId, tier: 'full', mode: m.mode === 'armed' ? 'rails' : m.mode, orbit: m.orbit, revision: m.revision, env: island.environmentOf(m.vessel.id)!, previous: m.previous, reducedTick: island.tick };
}

/** An object outside the island, brought to `tick` first; null when that showed it is gone. */
export function viewOfFar(frames: BodyFrames, far: FarSet, o: FarObject, tick: number): ViewVessel | null {
  far.sync(o, tick);
  if (o.removed) return null;
  const v = o.vessel;
  return { vessel: v, bodyId: o.bodyId, tier: o.tier, mode: v.hold !== null ? 'landed' : o.tier === 'reduced' ? 'integrated' : 'rails', orbit: o.orbit, revision: o.revision, env: frames.aim(o.env, o.bodyId, v.r, utOfTick(tick)), previous: null, reducedTick: o.reducedTick };
}

/** The planned vessel at the tick, as the planner and the read-outs take it. */
export function planSubject(a: ViewVessel, present: boolean, tick: number, stepCount: number, env: PlanSubject['env']): PlanSubject {
  return { present, vessel: a.vessel, bodyId: a.bodyId, onRails: a.mode === 'rails', com: comStateOf(a.vessel), ut: utOfTick(tick), stepCount, env };
}

/** A vessel that left the island for good (destroyed), as it last was: what stays in view of the pilot's vessel once it is gone. `env` is an environment of the caller's to aim at it. */
export function viewOfDeparted(frames: BodyFrames, env: IslandEnv, d: Departure, tick: number): ViewVessel {
  env.sunDir = d.vessel.sun.dir;
  env.sunVisibility = d.vessel.sun.visibility;
  return { vessel: d.vessel, bodyId: d.bodyId, tier: 'full', mode: 'integrated', orbit: null, revision: d.revision, env: frames.aim(env, d.bodyId, d.vessel.r, utOfTick(tick)), previous: null, reducedTick: tick };
}
