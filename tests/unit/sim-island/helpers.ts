/**
 * Fixtures of the island tests: the real definition library (the shipped one, and the staged Sun-rooted one
 * for flights in the star's sphere of influence), a flat terrain, vessels of `meridian-lunar` placed on
 * orbits, and small driving helpers. Nothing here knows the island's internals: the tests go through
 * `src/sim/island` as a host does.
 */
import type { ControlInputs } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import { DEFAULT_UNIVERSE_RULES } from '@/core/contracts/net';
import type { SimEvent } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { createBodySystem, type BodySystem } from '@/sim/bodies/bodySystem';
import { createIsland, type Island, type IslandDeps, type IslandInput, type StepMode } from '@/sim/island';
import { assembleVessel, seededCraftIds, type Vessel } from '@/sim/vessel';
import { loadLibrary, loadLibraryOver } from '../../../tools/sim/realWorld';
import { flatTerrain } from '../sim-world/helpers';

export { loadLibrary, loadLibraryOver };

export const VEHICLE = 'meridian-lunar';
/** A tick on the grid at a mission epoch (a whole number; 5 past a control tick and a sun sample). */
export const TICK0 = 112_588_900_005;
export const PILOT = 'pilot-a';

export interface Setup {
  defs: DefLibrary;
  system: BodySystem;
  deps: IslandDeps;
}

export function setup(defs: DefLibrary): Setup {
  const system = createBodySystem(defs);
  return { defs, system, deps: { defs, system, terrain: flatTerrain(defs), rules: DEFAULT_UNIVERSE_RULES } };
}

export const controls = (c: Partial<ControlInputs> = {}): ControlInputs => ({ pitch: 0, yaw: 0, roll: 0, translate: { x: 0, y: 0, z: 0 }, throttle: 0, ...c });

/**
 * The vehicle with `stagesFired` stages gone, on a circular orbit of radius `radius` about a body of
 * gravitational parameter `mu`, at `offset` metres from the orbit's point (BCI axes), nose along the track.
 */
export function orbiter(defs: DefLibrary, craftId: string, stagesFired: number, mu: number, radius: number, offset: Vec3 = v3.zero(), dv: Vec3 = v3.zero()): Vessel {
  const vessel = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: stagesFired, craft: { craftId, joinedTick: TICK0, ids: seededCraftIds() } });
  const speed = Math.sqrt(mu / radius);
  vessel.r = v3.add({ x: radius, y: 0, z: 0 }, offset);
  vessel.v = v3.add({ x: 0, y: speed, z: 0 }, dv);
  // VES +Y (the nose) along the velocity, which is BCI +Y here: the identity attitude.
  vessel.q = quat.identity();
  vessel.hold = null;
  vessel.surface = 'none';
  vessel.anchor = null;
  return vessel;
}

export function islandAt(s: Setup, bodyId: string, mode: StepMode = 'authoritative', id = 'i-1'): Island {
  return createIsland(s.deps, { id, tick: TICK0, bodyId, mode });
}

/** An input without its stamp (each member of the union on its own). */
export type Unstamped = IslandInput extends infer I ? (I extends IslandInput ? Omit<I, 'tick' | 'accountId' | 'seq'> : never) : never;

let seq = 0;
/** An input of `PILOT` (or of `accountId`) stamped for `tick`. */
export function input(tick: number, i: Unstamped, accountId = PILOT): IslandInput {
  return { ...i, tick, accountId, seq: seq++ } as IslandInput;
}

/** A vessel blob as an operation carries it. */
export const blob = (bytes: Uint8Array): { encoding: 'raw'; rawLength: number; bytes: Uint8Array } => ({ encoding: 'raw', rawLength: bytes.length, bytes });

/** Step `n` ticks; returns every event. */
export function steps(island: Island, n: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < n; i++) for (const e of island.step().events) out.push(e);
  return out;
}

/** Relative state of two members (b minus a) in the island's frame axes. */
export function relative(island: Island, a: string, b: string): { r: Vec3; v: Vec3 } {
  const x = island.stateOf(a)!;
  const y = island.stateOf(b)!;
  const ma = island.member(a)!.vessel;
  const mb = island.member(b)!.vessel;
  // The members' own states: differences of offsets (or of BCI states about one body), never of states about different origins.
  void x;
  void y;
  return { r: v3.sub(mb.r, ma.r), v: v3.sub(mb.v, ma.v) };
}

/** Events a client must never show before the server's (ARCHITECTURE 6.4). */
export const THRESHOLD_EVENTS: readonly SimEvent['type'][] = ['partDestroyed', 'explosion', 'jointBroken', 'crewLost', 'chuteFailed', 'touchdown', 'splash'];
