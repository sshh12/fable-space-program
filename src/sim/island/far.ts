/**
 * Objects of a clock that are in no island (ARCHITECTURE 6.2, 7.3): a vessel coasting in vacuum is on rails
 * and costs nothing between its events (a passive vessel); a vessel held on a body rides it; debris in an
 * atmosphere is in the REDUCED tier, a point mass stepped at 2 Hz. Each object has its own sphere of
 * influence and crosses it by itself, at its own event instant. Numerics are v1's, unchanged.
 *
 * The host says to which tick the objects are brought (`advanceTo`, `sync`); nothing here reads a clock.
 */
import type { SimEvent } from '@/core/contracts/sim';
import { v3 } from '@/core/math/vec3';
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
  /** Place in the order the objects are advanced in (the host's: the order its vessels came into being). */
  order: number;
}

/** What the far set tells its host. */
export interface FarSink {
  event(e: SimEvent): void;
  /** An object is gone: it burned up, hit the ground, or left through `remove`. `ut` is the instant of the fate. */
  removed(o: FarObject, reason: 'burnedUp' | 'impact', ut: number): void;
}

export class FarSet {
  readonly objects: FarObject[] = [];

  constructor(
    private readonly frames: BodyFrames,
    private readonly sink: FarSink,
  ) {}

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
    const o: FarObject = { vessel, bodyId, tier: 'rails', orbit: null, railsEvent: null, reducedTick: tick, bornTick: from.bornTick, revision: from.revision, controllable: isControllable(vessel), env: new IslandEnv(this.frames.terrain), removed: false, order: from.order };
    o.env.sunDir = vessel.sun.dir;
    o.env.sunVisibility = vessel.sun.visibility;
    if (vessel.hold === null) {
      const base = this.frames.base(bodyId);
      const alt = this.frames.altitudeAt(bodyId, vessel.r, utOfTick(tick));
      const atm = base.def.atmosphere;
      if (atm && alt < atm.simTop) o.tier = 'reduced';
      else if (from.orbit !== null) {
        o.orbit = from.orbit;
        o.railsEvent = from.railsEvent;
      } else this.toRails(o, utOfTick(tick));
    }
    // Objects are advanced in the host's order, whatever the order they left the island in: the events of one advance come out in it.
    let at = this.objects.length;
    while (at > 0 && this.objects[at - 1]!.order > o.order) at--;
    this.objects.splice(at, 0, o);
    return o;
  }

  /** Give a vessel up at `tick` (it enters an island): it is brought to the tick first. Null when it is gone. */
  take(vesselId: string, tick: number): FarObject | null {
    const o = this.find(vesselId);
    if (!o) return null;
    this.sync(o, tick);
    if (o.removed) return null;
    this.objects.splice(this.objects.indexOf(o), 1);
    return o;
  }

  /**
   * A member leaves `island` for the far set at the island's tick (it has parted: ARCHITECTURE 7.3): it goes on
   * from the conic it is on, is held on its body, or enters the reduced tier. `order` as for `add`.
   */
  receive(island: Island, vesselId: string, order: number): FarObject | null {
    const m = island.member(vesselId);
    if (!m) return null;
    const from = { bornTick: m.bornTick, revision: m.revision, orbit: m.orbit, railsEvent: m.railsEvent, order };
    const bodyId = island.bodyId;
    const vessel = island.remove(vesselId, 'left')!;
    return this.add(vessel, bodyId, island.tick, from);
  }

  /** An object enters `island` at `tick` (brought to the tick first), on its conic when it is on one. Null when it is gone or about another body. */
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
      if (o.removed || o.bodyId !== island.bodyId) continue;
      if (!island.reach({ r: o.vessel.r, v: o.vessel.v, radius: structureOf(o.vessel).boundingRadius }).joins) continue;
      this.release(island, o.vessel.id, tick);
      joined++;
    }
    return joined;
  }

  /** Drop the objects that are gone. */
  compact(): void {
    for (let i = this.objects.length - 1; i >= 0; i--) if (this.objects[i]!.removed) this.objects.splice(i, 1);
  }

  /** One tick of the clock for every object: the reduced tier steps when a whole step fits, a coasting object only at its events. */
  step(tickNew: number): void {
    const utNew = utOfTick(tickNew);
    for (let k = 0; k < this.objects.length; k++) {
      const o = this.objects[k]!;
      if (o.removed) continue;
      if (o.tier === 'reduced') this.advanceReduced(o, utNew);
      else if (o.railsEvent && o.railsEvent.ut <= utNew) this.advanceOnRails(o, utNew);
    }
  }

  /** A rails advance of the clock to `tick`: the reduced tier and the objects with an event on the way. */
  advanceTo(tick: number): void {
    const target = utOfTick(tick);
    for (let k = 0; k < this.objects.length; k++) {
      const o = this.objects[k]!;
      if (o.removed) continue;
      if (o.tier === 'reduced') this.advanceReduced(o, target);
      else if (o.vessel.hold === null && o.railsEvent && o.railsEvent.ut <= target) this.advanceOnRails(o, target);
    }
  }

  /** Bring an object to `tick` (whoever reads its state asks first). */
  sync(o: FarObject, tick: number): void {
    if (o.removed) return;
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
        o.tier = 'reduced';
        o.orbit = null;
        o.railsEvent = null;
        o.reducedTick = entryTick;
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
