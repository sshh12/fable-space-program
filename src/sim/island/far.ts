/**
 * Objects of a clock that are in no island (ARCHITECTURE 6.2, 7.3): a vessel coasting in vacuum is on rails
 * and costs nothing between its events (a passive vessel); a vessel held on a body rides it; debris in an
 * atmosphere is in the REDUCED tier, a point mass stepped at 2 Hz. Each object has its own sphere of
 * influence and crosses it by itself, at its own event instant. Numerics are v1's, unchanged.
 *
 * THE REDUCED TIER IS FOR DEBRIS ONLY (`isDebris`, and what the host protects): its model freezes the
 * attitude, lumps every part's temperature into one and removes the piece at the ground whatever it does
 * there. A vessel that is no debris is never given to it: `receive` refuses one that is in the air (it stays
 * in its island, at full fidelity), and one on rails whose conic meets the air WAITS at its entry, at the
 * tick of its entry, for the unattended run its host must give it (`FarSink.needsRun`, `nextRunTick`,
 * `step` / `advanceTo` with the island that takes it).
 *
 * A Reduced piece's state is that of its last half-second step (`FarObject.reducedTick`). Whoever compares
 * it with states of a tick uses `stateAt`; a piece that leaves the tier (`take`, `release`) is first
 * stepped over the rest, so that it is handed over with the state of the tick it is handed over at.
 *
 * The host says to which tick the objects are brought (`advanceTo`, `sync`); nothing here reads a clock.
 */
import type { SimEvent } from '@/core/contracts/sim';
import { v3, type Vec3 } from '@/core/math/vec3';
import { ceilTick, nearestTick, SUN_SAMPLE_TICKS, TICKS_PER_SECOND, utOfTick } from '../clock';
import { propagate, type Orbit } from '../orbit/kepler';
import { isControllable, rideBody, stepVesselReduced, structureOf, type Vessel } from '../vessel';
import { REDUCED_DT, type Island, type IslandMember } from './api';
import { IslandEnv } from './environment';
import { comStateOf, setFromCom, type BodyFrames } from './frames';
import { computeRailsEvent, crossSoi, eventAfterCrossing, orbitOf, railsStateAt, shifted, type RailsEvent } from './rails';

const REDUCED_STEP_TICKS = REDUCED_DT * TICKS_PER_SECOND;

export interface FarObject {
  vessel: Vessel;
  bodyId: string;
  /** 'rails': on its conic, or held on the body; 'reduced': the 2 Hz point mass in an atmosphere. */
  tier: 'rails' | 'reduced';
  /** Orbit of the centre of mass while coasting; null while held or in the reduced tier. */
  orbit: Orbit | null;
  railsEvent: RailsEvent | null;
  /** Tick the reduced-tier state refers to. */
  reducedTick: number;
  bornTick: number;
  revision: number;
  controllable: boolean;
  env: IslandEnv;
  removed: boolean;
  /** A vessel that is no debris met the air: it stands at its entry state (the state at `reducedTick`) until its host takes it into an island. */
  waiting: boolean;
  /** Place in the order the objects are advanced in (the host's: the order its vessels came into being). */
  order: number;
}

/**
 * What the Reduced tier may fly, read off the vessel: nobody can command it (no command authority), nobody
 * is aboard, no chute is open, and it is no assembly of docked craft. The host adds its own reasons
 * (`FarSet.protect`: a vessel some session targets, has selected, or owns a seat on).
 */
export function isDebris(v: Vessel): boolean {
  if (isControllable(v) || v.links.length > 0) return false;
  for (const p of v.parts) {
    for (const m of p.modules) {
      if (m.type === 'command' && m.crew > 0) return false;
      if (m.type === 'parachute' && (m.state === 'reefed' || m.state === 'full')) return false;
    }
  }
  return true;
}

/** What the far set tells its host. */
export interface FarSink {
  event(e: SimEvent): void;
  /** An object is gone: it burned up, hit the ground, or left through `remove`. `ut` is the instant of the fate. */
  removed(o: FarObject, reason: 'burnedUp' | 'impact', ut: number): void;
  /** A vessel that is no debris met the air at `tick` and waits there: it needs an island of its own (an unattended run). */
  needsRun?(o: FarObject, tick: number): void;
}

/** Options of a far set. */
export interface FarOptions {
  /**
   * A host with ONE island cannot give a waiting vessel about another body than its island's a run. With
   * this set the Reduced tier flies such a vessel after all: the single case in which a ship is reduced, and
   * a limit of that host (v1's behaviour). A universe leaves it unset and runs every such vessel.
   */
  reduceUnhosted?: boolean;
}

export class FarSet {
  readonly objects: FarObject[] = [];
  /** The host's own reasons to keep a vessel out of the Reduced tier (it is targeted, selected, owned by a session). */
  protect: (vessel: Vessel) => boolean = () => false;

  constructor(
    private readonly frames: BodyFrames,
    private readonly sink: FarSink,
    private readonly options: FarOptions = {},
  ) {}

  /** The Reduced tier may fly this vessel. */
  reducible(vessel: Vessel): boolean {
    return isDebris(vessel) && !this.protect(vessel);
  }

  private inAir(bodyId: string, r: Vec3, ut: number): boolean {
    const atm = this.frames.base(bodyId).def.atmosphere;
    return atm !== null && atm !== undefined && this.frames.altitudeAt(bodyId, r, ut) < atm.simTop;
  }

  /**
   * The state of an object at `tick`, for a comparison with states of that tick. A Reduced piece is carried
   * on from its last step by its velocity (its own model moves it in whole half seconds; over the rest the
   * difference is metres, against a join distance of a kilometre).
   */
  stateAt(o: FarObject, tick: number): { r: Vec3; v: Vec3 } {
    const v = o.vessel;
    if (o.tier !== 'reduced' || o.reducedTick >= tick) return { r: v.r, v: v.v };
    return { r: v3.addScaled(v.r, v.v, (tick - o.reducedTick) / TICKS_PER_SECOND), v: v.v };
  }

  /** A Reduced piece that leaves the tier is stepped by its own model over the rest of its half second. False when that removed it. */
  private finishReduced(o: FarObject, tick: number): boolean {
    const rest = tick - o.reducedTick;
    if (o.tier !== 'reduced' || rest <= 0) return true;
    const res = stepVesselReduced(o.vessel, this.frames.aim(o.env, o.bodyId, o.vessel.r, utOfTick(o.reducedTick)), rest / TICKS_PER_SECOND);
    o.reducedTick = tick;
    if (res.removed === null) return true;
    this.remove(o, res.removed, utOfTick(tick));
    return false;
  }

  /** The first tick at which a vessel that is no debris meets the air on its conic and needs a run (a rails advance of the clock lands there); Infinity = none. */
  nextRunTick(): number {
    let tick = Infinity;
    for (const o of this.objects) {
      const ev = o.railsEvent;
      if (o.removed || o.waiting || !ev || ev.kind !== 'atmosphere' || this.reducible(o.vessel)) continue;
      tick = Math.min(tick, ceilTick(ev.ut));
    }
    return tick;
  }

  /**
   * The waiting vessels about `island`'s body enter it at `tick` and fly on there at full fidelity,
   * unattended; with `reduceUnhosted` one about another body is given to the Reduced tier. Returns how many
   * entered the island.
   */
  runsInto(island: Island, tick: number): number {
    let entered = 0;
    for (const o of this.objects.slice()) {
      if (o.removed || !o.waiting) continue;
      if (o.bodyId === island.bodyId) {
        this.objects.splice(this.objects.indexOf(o), 1);
        island.add(o.vessel, { bornTick: o.bornTick, revision: o.revision });
        entered++;
      } else if (this.options.reduceUnhosted === true) {
        o.waiting = false;
        o.tier = 'reduced';
      }
    }
    if (entered > 0) island.refreshMargins();
    return entered;
  }

  find(vesselId: string): FarObject | null {
    return this.objects.find((o) => o.vessel.id === vesselId && !o.removed) ?? null;
  }

  /**
   * Take a vessel over at `tick` (it left an island, or it starts outside one). `orbit` and `railsEvent` are
   * the conic it is already on, when it is on one: the object goes on from the same epoch state. Without
   * them a free vessel inside an atmosphere enters the reduced tier and any other goes on rails from its
   * state at the tick.
   */
  add(vessel: Vessel, bodyId: string, tick: number, from: { bornTick: number; revision: number; orbit: Orbit | null; railsEvent: RailsEvent | null; order: number }): FarObject {
    if (!(vessel.mp.mass > 0)) structureOf(vessel);
    const o: FarObject = { vessel, bodyId, tier: 'rails', orbit: null, railsEvent: null, reducedTick: tick, bornTick: from.bornTick, revision: from.revision, controllable: isControllable(vessel), env: new IslandEnv(this.frames.terrain), removed: false, waiting: false, order: from.order };
    o.env.sunDir = vessel.sun.dir;
    o.env.sunVisibility = vessel.sun.visibility;
    if (vessel.hold === null) {
      if (this.inAir(bodyId, vessel.r, utOfTick(tick))) {
        // Debris flies on in the Reduced tier; anything else waits for its run.
        if (this.reducible(vessel)) o.tier = 'reduced';
        else o.waiting = true;
      } else if (from.orbit !== null) {
        o.orbit = from.orbit;
        o.railsEvent = from.railsEvent;
      } else this.toRails(o, utOfTick(tick));
    }
    // Objects are advanced in the host's order, whatever the order they left the island in: the events of one advance come out in it.
    let at = this.objects.length;
    while (at > 0 && this.objects[at - 1]!.order > o.order) at--;
    this.objects.splice(at, 0, o);
    if (o.waiting) this.sink.needsRun?.(o, tick);
    return o;
  }

  /**
   * Give a vessel up at `tick` (it enters an island): it is brought to the tick first, a Reduced piece by a
   * last step of its own model over the rest of its half second. Null when it is gone.
   */
  take(vesselId: string, tick: number): FarObject | null {
    const o = this.find(vesselId);
    if (!o) return null;
    this.sync(o, tick);
    if (o.removed || !this.finishReduced(o, tick)) return null;
    this.objects.splice(this.objects.indexOf(o), 1);
    return o;
  }

  /**
   * A member leaves `island` for the far set at the island's tick (it has parted: ARCHITECTURE 7.3): it goes on
   * from the conic it is on, is held on its body, or enters the reduced tier. `order` as for `add`. Null
   * when there is no such member, and when the far set REFUSES it: a vessel that is no debris, free in the air.
   */
  receive(island: Island, vesselId: string, order: number, unhosted = false): FarObject | null {
    const m = island.member(vesselId);
    if (!m) return null;
    // A free vessel in the air would enter the Reduced tier: only debris may. Anything else stays in its island
    // (`unhosted`: the island itself is given up, so there is nothing to stay in; the vessel then waits for a run).
    if (!unhosted && m.vessel.hold === null && !this.reducible(m.vessel) && this.inAir(island.bodyId, island.stateOf(vesselId)!.r, island.ut)) return null;
    const from = { bornTick: m.bornTick, revision: m.revision, orbit: m.orbit, railsEvent: m.railsEvent, order };
    const bodyId = island.bodyId;
    const vessel = island.remove(vesselId, 'left')!;
    return this.add(vessel, bodyId, island.tick, from);
  }

  /** An object enters `island` at `tick` (brought to the tick first: `take`), on its conic when it is on one. Null when it is gone or about another body. */
  release(island: Island, vesselId: string, tick: number): IslandMember | null {
    const found = this.find(vesselId);
    if (found) this.sync(found, tick);
    if (!found || found.removed || found.bodyId !== island.bodyId) return null;
    const o = this.take(vesselId, tick)!;
    return island.add(o.vessel, { bornTick: o.bornTick, revision: o.revision, conic: o.orbit ? { orbit: o.orbit, event: o.railsEvent } : undefined });
  }

  /**
   * Formation, the joining half (ARCHITECTURE 7.3): every object is brought to `tick`, and one about the
   * island's body inside the join distance of any member (`Island.reach`) enters the island, in the set's
   * order, each seeing the members that joined before it. Returns how many joined.
   */
  joinInto(island: Island, tick: number): number {
    let joined = 0;
    for (const o of this.objects.slice()) {
      if (o.removed) continue;
      this.sync(o, tick);
      if (o.removed || o.waiting || o.bodyId !== island.bodyId) continue;
      // States of one instant: a Reduced piece is read at the tick, not at its last step.
      const at = this.stateAt(o, tick);
      if (!island.reach({ r: at.r, v: at.v, radius: structureOf(o.vessel).boundingRadius }).joins) continue;
      if (this.release(island, o.vessel.id, tick)) joined++;
    }
    return joined;
  }

  /** Drop the objects that are gone. */
  compact(): void {
    for (let i = this.objects.length - 1; i >= 0; i--) if (this.objects[i]!.removed) this.objects.splice(i, 1);
  }

  /** One tick of the clock for every object: the reduced tier steps when a whole step fits, a coasting object only at its events. `host`: the island that takes the vessels that then need a run (`runsInto`). */
  step(tickNew: number, host?: Island): void {
    const utNew = utOfTick(tickNew);
    for (let k = 0; k < this.objects.length; k++) {
      const o = this.objects[k]!;
      if (o.removed || o.waiting) continue;
      if (o.tier === 'reduced') this.advanceReduced(o, utNew);
      else if (o.railsEvent && o.railsEvent.ut <= utNew) this.advanceOnRails(o, utNew);
    }
    if (host) this.runsInto(host, tickNew);
  }

  /** A rails advance of the clock to `tick`: the reduced tier and the objects with an event on the way. */
  advanceTo(tick: number, host?: Island): void {
    const target = utOfTick(tick);
    for (let k = 0; k < this.objects.length; k++) {
      const o = this.objects[k]!;
      if (o.removed || o.waiting) continue;
      if (o.tier === 'reduced') this.advanceReduced(o, target);
      else if (o.vessel.hold === null && o.railsEvent && o.railsEvent.ut <= target) this.advanceOnRails(o, target);
    }
    if (host) this.runsInto(host, tick);
  }

  /** Bring an object to `tick` (whoever reads its state asks first). */
  sync(o: FarObject, tick: number): void {
    if (o.removed || o.waiting) return;
    const ut = utOfTick(tick);
    if (o.tier === 'reduced') this.advanceReduced(o, ut);
    else if (o.vessel.hold !== null) rideBody(o.vessel, this.frames.aim(o.env, o.bodyId, o.vessel.r, ut), 0);
    else this.advanceOnRails(o, ut);
  }

  /** Age of every object at `tick` (they are not stepped: the vessel package only counts the steps it is given). */
  stampAges(tick: number): void {
    for (const o of this.objects) o.vessel.age = (tick - o.bornTick) / TICKS_PER_SECOND;
  }

  /** A time shift of the whole clock by `shiftTicks` to the instant `to` (the host's debug jump): orbits are re-made at the new epoch. */
  shiftClock(shiftTicks: number, from: number, to: number): void {
    for (const o of this.objects) {
      if (o.orbit) {
        const s = propagate(o.orbit, from);
        o.orbit = orbitOf(this.frames, o.bodyId, s, to);
        if (o.railsEvent) o.railsEvent = computeRailsEvent(this.frames, o.bodyId, o.orbit, to);
      }
      o.reducedTick += shiftTicks;
      o.bornTick += shiftTicks;
    }
  }

  private toRails(o: FarObject, ut: number): void {
    o.orbit = orbitOf(this.frames, o.bodyId, comStateOf(o.vessel), ut);
    o.tier = 'rails';
    o.railsEvent = computeRailsEvent(this.frames, o.bodyId, o.orbit, ut);
    o.revision++;
  }

  private refreshSun(o: FarObject, ut: number): void {
    o.vessel.sun = this.frames.sunSample(o.bodyId, o.vessel.r, ut);
    o.env.sunDir = o.vessel.sun.dir;
    o.env.sunVisibility = o.vessel.sun.visibility;
  }

  /** Move a coasting object to `utNew`, processing its events in (now, utNew] exactly at their times. False when it is gone. */
  private advanceOnRails(o: FarObject, utNew: number): boolean {
    const f = this.frames;
    for (let guard = 0; guard < 64; guard++) {
      const ev = o.railsEvent;
      if (!ev || ev.ut > utNew || o.orbit === null) break;
      const s = propagate(o.orbit, ev.ut);
      if (ev.kind === 'soiEnter' || ev.kind === 'soiExit') {
        const from = o.bodyId;
        const x = crossSoi(f, from, { ut: ev.ut, kind: ev.kind, nextBodyId: ev.nextBodyId });
        const t = shifted(s, x);
        o.bodyId = x.to;
        o.orbit = orbitOf(f, x.to, t, ev.ut);
        this.sink.event({ type: 'soiChange', ut: ev.ut, vesselId: o.vessel.id, fromBodyId: from, toBodyId: x.to });
        o.revision++;
        o.railsEvent = eventAfterCrossing(f, x.to, o.orbit, ev.ut);
        continue;
      }
      if (ev.kind === 'atmosphere') {
        // The reduced tier's steps start at the first whole tick at or after the entry.
        const entryTick = Math.min(ceilTick(ev.ut), nearestTick(utNew));
        const at = propagate(o.orbit, utOfTick(entryTick));
        setFromCom(o.vessel, at.r, at.v);
        o.orbit = null;
        o.railsEvent = null;
        o.reducedTick = entryTick;
        if (!this.reducible(o.vessel)) {
          // No debris: it stands here, at this tick's state, until its host has an island fly it.
          o.waiting = true;
          this.sink.needsRun?.(o, entryTick);
          return true;
        }
        o.tier = 'reduced';
        return this.advanceReduced(o, utNew);
      }
      if (ev.kind === 'impact') {
        setFromCom(o.vessel, s.r, s.v);
        this.remove(o, 'impact', ev.ut);
        return false;
      }
      // 'recheck': end of a closed revolution or of the prediction horizon.
      o.railsEvent = computeRailsEvent(f, o.bodyId, o.orbit, ev.ut + 1e-3);
      if (o.railsEvent && o.railsEvent.ut <= ev.ut) o.railsEvent = null;
    }
    if (o.orbit !== null) {
      const s = railsStateAt(o.orbit, utNew);
      setFromCom(o.vessel, s.r, s.v);
    }
    return true;
  }

  private advanceReduced(o: FarObject, utNew: number): boolean {
    const f = this.frames;
    const v = o.vessel;
    const tickNew = nearestTick(utNew);
    while (o.reducedTick + REDUCED_STEP_TICKS <= tickNew) {
      const t = utOfTick(o.reducedTick);
      const env = f.aim(o.env, o.bodyId, v.r, t);
      // The reduced tier samples the sun at a tenth of the rate: at the first of its steps after every tenth sample tick.
      if (o.reducedTick % (SUN_SAMPLE_TICKS * 10) < REDUCED_STEP_TICKS) this.refreshSun(o, t);
      const res = stepVesselReduced(v, env, REDUCED_DT);
      o.reducedTick += REDUCED_STEP_TICKS;
      if (res.removed !== null) {
        this.remove(o, res.removed, utOfTick(o.reducedTick));
        return false;
      }
      // Out of the atmosphere on a coast: Kepler takes over.
      const info = f.info(o.bodyId);
      const alt = f.altitudeAt(o.bodyId, v.r, utOfTick(o.reducedTick));
      const atm = info.def.atmosphere;
      if ((!atm || alt >= atm.simTop) && v3.dot(v.r, v.v) > 0) {
        o.orbit = orbitOf(f, o.bodyId, comStateOf(v), utOfTick(o.reducedTick));
        o.tier = 'rails';
        o.railsEvent = computeRailsEvent(f, o.bodyId, o.orbit, utOfTick(o.reducedTick));
        return this.advanceOnRails(o, utNew);
      }
    }
    return true;
  }

  private remove(o: FarObject, reason: 'burnedUp' | 'impact', ut: number): void {
    if (o.removed) return;
    o.removed = true;
    this.sink.removed(o, reason, ut);
  }
}
