/**
 * The presentation side of a host (ARCHITECTURE 7.1 "View"): how each vessel of the clock is read for the
 * snapshot (a member of the island, an object outside it, the pilot's vessel after it is gone), the event
 * queue in the render frame, the render root, and the snapshot with its peek cache. It reads the host and
 * never changes the simulation; the host tells it what happened to the pilot's vessel.
 */
import type { TimeView } from '@/core/contracts/net';
import type { SimEvent, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import { utOfTick } from '../clock';
import { IslandEnv, type Departure, type FarSet, type Island } from '../island';
import type { BodyFrames } from '../island/frames';
import { vesselClearance, type Vessel } from '../vessel';
import { RenderRoot } from './frame';
import { planSubject, viewOfDeparted, viewOfFar, viewOfMember } from './host';
import type { Planning, PlanSubject } from './planning';
import { buildSnapshot, StageFigures, wreckSnapshot, type SnapshotSource, type ViewVessel } from './snapshot';

/** Pending events kept for consumers that never drain the queue. */
export const MAX_PENDING_EVENTS = 1024;

/** The blocks of a snapshot that are the host's to state: its clock, its scenario, its terrain protocol, its objectives. */
export interface HostBlocks extends Pick<SnapshotSource, 'warp' | 'scenario' | 'surfaceTargets' | 'terrain' | 'milestones' | 'mission' | 'cheatCounter' | 'liftoffUt'> {
  time: TimeView;
}

/** What the presenter reads of its host. */
export interface PresentedHost {
  readonly frames: BodyFrames;
  readonly plan: Planning;
  readonly island: Island;
  readonly far: FarSet;
  /** Every vessel of the clock in the order the snapshot lists them, and those that are gone since the last control tick. */
  readonly roster: readonly Vessel[];
  readonly gone: ReadonlySet<Vessel>;
  /** The pilot's vessel. */
  readonly active: Vessel;
  readonly tick: number;
  readonly stepCount: number;
  readonly revision: number;
  /** Changes whenever the state a snapshot shows may have changed (the peek cache's key). */
  readonly stateSerial: number;
  /** Bring the plan and the clock's limits up to date (called before a snapshot is built). */
  refresh(): void;
  blocks(): HostBlocks;
}

export class Presenter {
  readonly root: RenderRoot;
  private readonly figures: StageFigures;
  /** The pilot's vessel was removed with nothing to take over yet: what it last was, and what is kept in view of it. */
  private lost: ViewVessel | null = null;
  private wreck: VesselSnapshot | null = null;
  private readonly lostEnv: IslandEnv;
  private events: SimEvent[] = [];
  private eventsView: SimEvent[] | null = null;
  private peekCache: SimSnapshot | null = null;
  private peekSerial = -1;

  constructor(
    private readonly h: PresentedHost,
    renderRoot: 'soiBody' | 'rootBody',
  ) {
    this.root = new RenderRoot(h.frames.system, renderRoot);
    this.figures = new StageFigures(h.frames);
    this.lostEnv = new IslandEnv(h.frames.terrain);
  }

  /** The pilot's vessel exists (false once it is gone and nothing has taken over). */
  get present(): boolean {
    return this.lost === null;
  }

  /** A vessel of the roster as the view reads it, brought to the clock's tick; null when it is gone. */
  entry(v: Vessel): ViewVessel | null {
    const h = this.h;
    if (h.gone.has(v)) return null;
    const m = h.island.member(v.id);
    if (m && m.vessel === v) return viewOfMember(h.island, m);
    const o = h.far.find(v.id);
    return o && o.vessel === v ? viewOfFar(h.frames, h.far, o, h.tick) : null;
  }

  /** The pilot's vessel as the view reads it (what it last was once it is gone). */
  focus(): ViewVessel {
    return this.lost ?? this.entry(this.h.active)!;
  }

  subject(): PlanSubject {
    const a = this.focus();
    return planSubject(a, this.present, this.h.tick, this.h.stepCount, () => this.envOf(a));
  }

  /** The step environment of a vessel in view, at the clock's tick. */
  envOf(e: ViewVessel): VesselEnvironment {
    const h = this.h;
    const ut = utOfTick(h.tick);
    if (e === this.lost) return h.frames.aim(this.lostEnv, e.bodyId, e.vessel.r, ut);
    if (h.island.member(e.vessel.id)?.vessel === e.vessel) return h.island.environmentOf(e.vessel.id)!;
    const o = h.far.find(e.vessel.id);
    return o ? h.frames.aim(o.env, o.bodyId, e.vessel.r, ut) : e.env;
  }

  /** Clearance between the part envelopes of two vessels on the same body, m (null when unknown ids or different bodies). */
  clearance(vesselIdA: string, vesselIdB: string): number | null {
    const find = (id: string): ViewVessel | null => {
      const v = this.h.roster.find((x) => x.id === id);
      return v ? this.entry(v) : null;
    };
    const p = find(vesselIdA);
    const q = find(vesselIdB);
    if (!p || !q || p.bodyId !== q.bodyId) return null;
    return vesselClearance(p.vessel, q.vessel);
  }

  // -------------------------------------------------------------------------------- what the host tells

  /** An event into the queue. `bodyId`: the SOI body its positions were produced about (an event of a vessel's step). */
  push(e: SimEvent, bodyId?: string): void {
    if (bodyId !== undefined) this.root.noteEvent(e, bodyId);
    this.events.push(e);
    if (this.events.length > MAX_PENDING_EVENTS) this.events.splice(0, this.events.length - MAX_PENDING_EVENTS);
    this.eventsView = null;
  }

  clearEvents(): void {
    this.events.length = 0;
    this.eventsView = null;
  }

  /** A session starts (again) with the pilot's vessel about `bodyId`: the first frame has its origin there, no epoch before it. */
  reset(bodyId: string): void {
    this.lost = null;
    this.root.reset(bodyId);
  }

  /** The pilot's vessel left the island for good. */
  lose(d: Departure): void {
    this.lost = viewOfDeparted(this.h.frames, this.lostEnv, d, this.h.tick);
  }

  /** Nothing takes the lost vessel's place: its wreck stays in view. */
  keepWreck(): void {
    if (!this.wreck) this.wreck = wreckSnapshot(this.h.frames, this.lost!, utOfTick(this.h.tick));
  }

  /** The pilot has a vessel again. */
  regain(): void {
    this.lost = null;
    this.wreck = null;
  }

  /** The render root follows the pilot's vessel to its SOI body. True when it moved. */
  follow(): boolean {
    return this.root.follow(this.focus().bodyId);
  }

  // ------------------------------------------------------------------------------------------ snapshot

  private build(lag: number): SimSnapshot {
    const h = this.h;
    h.refresh();
    const vessels: ViewVessel[] = [];
    for (const v of h.roster) {
      const e = this.entry(v);
      if (e) vessels.push(e);
    }
    if (!this.eventsView) this.eventsView = this.events.map((ev) => this.root.eventInFrame(ev));
    return buildSnapshot({
      ...h.blocks(),
      frames: h.frames,
      planning: h.plan,
      root: this.root,
      figures: this.figures,
      tick: h.tick,
      lag,
      revision: h.revision,
      vessels,
      focus: this.present ? vessels.find((e) => e.vessel === h.active)! : this.lost!,
      focusPresent: this.present,
      wreck: this.wreck,
      subject: this.subject(),
      envOf: (e) => this.envOf(e),
      events: this.eventsView,
    });
  }

  /** The snapshot at the presentation time, `lag` seconds behind the state; the event queue and the rebase are drained. */
  snapshot(lag: number): SimSnapshot {
    const s = this.build(lag);
    // The rebase is drained like the events: the next snapshot starts from this frame.
    this.root.drain();
    this.events = [];
    this.eventsView = null;
    this.peekCache = null;
    return s;
  }

  /** The snapshot of the state itself; nothing is drained. */
  peek(): SimSnapshot {
    const h = this.h;
    if (this.peekCache && this.peekSerial === h.stateSerial && !h.plan.patchesDirty) return this.peekCache;
    const s = this.build(0);
    this.peekCache = s;
    this.peekSerial = h.stateSerial;
    return s;
  }
}
