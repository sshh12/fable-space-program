/**
 * The render root of a session's snapshots (ARCHITECTURE section 3, `SimSnapshot.frame`): the origin of
 * every `...Root` field. It is the centre of the focus vessel's SOI body when that body is a planet or a
 * moon, and the focus island's reference-orbit point where the island integrates offsets from one (the
 * star's sphere of influence), so that ROOT positions near the craft are metres, not astronomical units.
 * When the origin is replaced (another body, a new reference orbit) a new frame epoch starts; the snapshot
 * that carries a new epoch also carries the rebase from the origin of the snapshot before it, and every
 * snapshot describes the origins of the last few epochs in its own frame.
 */
import type { BodySnapshot, Patch, SimEvent, SimSnapshot } from '@/core/contracts/sim';
import { FRAME_HISTORY_EPOCHS, type FrameEpochOrigin, type FrameRebase } from '@/core/math/frame';
import { v3, type Vec3 } from '@/core/math/vec3';
import { utOfTick } from '../clock';
import type { ReferenceOrbit } from '../island';
import type { BodyFrames } from '../island/frames';
import { orbitOf, railsStateAt } from '../island/rails';
import type { Orbit } from '../orbit/kepler';

/** Where the origin is: the centre of a body, or the point of a reference orbit about one (evaluated as the island evaluates it). */
type Origin = { kind: 'body'; bodyId: string } | { kind: 'orbit'; bodyId: string; reference: ReferenceOrbit; orbit: Orbit };

const sameOrigin = (a: Origin, b: Origin): boolean =>
  a.bodyId === b.bodyId && (a.kind === 'body' ? b.kind === 'body' : b.kind === 'orbit' && a.reference.tick === b.reference.tick && v3.dist(a.reference.r0, b.reference.r0) === 0 && v3.dist(a.reference.v0, b.reference.v0) === 0);

export class RenderRoot {
  epoch = 0;
  private origin: Origin;
  /** The origins of earlier epochs, newest first. */
  private history: { epoch: number; origin: Origin }[] = [];
  /** Epoch and origin the last drained snapshot carried: the rebase of the next one starts there. */
  private seenEpoch = 0;
  private seenOrigin: Origin;
  /** The origin an event's ROOT position was produced about (the vessel package works in the frame of its island). */
  private readonly eventOrigin = new WeakMap<SimEvent, Origin>();
  private shiftedPatches: { source: { current: Patch[]; planned: Patch[] }; origin: Origin; out: { current: Patch[]; planned: Patch[] } } | null = null;

  constructor(
    private readonly frames: BodyFrames,
    /** 'soiBody': the origin follows the focus; 'rootBody': it is the library's root body and never replaced. */
    private readonly mode: 'soiBody' | 'rootBody',
  ) {
    this.origin = { kind: 'body', bodyId: frames.system.rootId };
    this.seenOrigin = this.origin;
  }

  /** SOI body the origin is at, or about. */
  get bodyId(): string {
    return this.origin.bodyId;
  }

  private originFor(focusBodyId: string, reference: ReferenceOrbit | null): Origin {
    if (this.mode !== 'soiBody') return { kind: 'body', bodyId: this.frames.system.rootId };
    if (reference === null) return { kind: 'body', bodyId: focusBodyId };
    return { kind: 'orbit', bodyId: focusBodyId, reference, orbit: orbitOf(this.frames, focusBodyId, { r: reference.r0, v: reference.v0 }, utOfTick(reference.tick)) };
  }

  /** The first frame of a session: its origin is at the start vessel (its SOI body, or its island's reference orbit), with no epoch before it. */
  reset(focusBodyId: string, reference: ReferenceOrbit | null = null): void {
    this.origin = this.originFor(focusBodyId, reference);
    this.seenOrigin = this.origin;
    this.epoch = 0;
    this.seenEpoch = 0;
    this.history = [];
  }

  /** Keep the origin at the focus vessel: its SOI body, or its island's reference orbit. True when a new epoch started. */
  follow(focusBodyId: string, reference: ReferenceOrbit | null = null): boolean {
    const next = this.originFor(focusBodyId, reference);
    if (sameOrigin(next, this.origin)) return false;
    this.history.unshift({ epoch: this.epoch, origin: this.origin });
    if (this.history.length > FRAME_HISTORY_EPOCHS) this.history.length = FRAME_HISTORY_EPOCHS;
    this.epoch++;
    this.origin = next;
    return true;
  }

  /** True when the origin is the point of this reference orbit (a member of that island is then given by its offset alone). */
  isAt(reference: ReferenceOrbit | null): boolean {
    const o = this.origin;
    return reference !== null && o.kind === 'orbit' && o.reference.tick === reference.tick && v3.dist(o.reference.r0, reference.r0) === 0 && v3.dist(o.reference.v0, reference.v0) === 0;
  }

  /** Position and velocity of origin `a` in the frame of origin `b` at `ut`. */
  private between(a: Origin, b: Origin, ut: number): FrameRebase {
    const system = this.frames.system;
    if (a.kind === 'body' && b.kind === 'body') {
      const s = system.stateRelative(a.bodyId, b.bodyId, ut);
      return { offset: s.r, velocity: s.v };
    }
    let r = v3.zero();
    let v = v3.zero();
    if (a.bodyId !== b.bodyId) {
      const s = system.stateRelative(a.bodyId, b.bodyId, ut);
      r = s.r;
      v = s.v;
    }
    if (a.kind === 'orbit') {
      const s = railsStateAt(a.orbit, ut);
      r = v3.add(r, s.r);
      v = v3.add(v, s.v);
    }
    if (b.kind === 'orbit') {
      const s = railsStateAt(b.orbit, ut);
      r = v3.sub(r, s.r);
      v = v3.sub(v, s.v);
    }
    return { offset: r, velocity: v };
  }

  /**
   * The origin's state in the frame of the body snapshots (the system's root body) at `utP`; null when the
   * origin is that body's centre and nothing is to be subtracted.
   */
  originIn(bodies: readonly BodySnapshot[], utP: number): { r: Vec3; v: Vec3 } | null {
    const o = this.origin;
    if (o.kind === 'body' && o.bodyId === this.frames.system.rootId) return null;
    const body = bodies.find((b) => b.id === o.bodyId)!;
    if (o.kind === 'body') return { r: v3.clone(body.rRoot), v: v3.clone(body.vRoot) };
    const s = railsStateAt(o.orbit, utP);
    return { r: v3.add(body.rRoot, s.r), v: v3.add(body.vRoot, s.v) };
  }

  /** The frame block of a snapshot at the presentation time `utP`. */
  describe(utP: number): SimSnapshot['frame'] {
    const o = this.origin;
    const rebase = this.epoch !== this.seenEpoch ? this.between(this.seenOrigin, o, utP) : null;
    const previous: FrameEpochOrigin[] = this.history.map((h) => ({ epoch: h.epoch, ...this.between(h.origin, o, utP) }));
    const origin: SimSnapshot['frame']['origin'] =
      o.kind === 'body' ? { kind: 'body', bodyId: o.bodyId } : { kind: 'orbit', bodyId: o.bodyId, r0: v3.clone(o.reference.r0), v0: v3.clone(o.reference.v0), t0: utOfTick(o.reference.tick) };
    return { epoch: this.epoch, origin, rebase, previous };
  }

  /** The rebase is drained like the events: the next snapshot starts from this frame. */
  drain(): void {
    this.seenEpoch = this.epoch;
    this.seenOrigin = this.origin;
  }

  /** Remember what an event's ROOT position refers to: the SOI body of its island, or that island's reference orbit. */
  noteEvent(ev: SimEvent, bodyId: string, reference: ReferenceOrbit | null = null): void {
    if (ev.type !== 'explosion') return;
    this.eventOrigin.set(ev, reference === null ? { kind: 'body', bodyId } : { kind: 'orbit', bodyId, reference, orbit: orbitOf(this.frames, bodyId, { r: reference.r0, v: reference.v0 }, utOfTick(reference.tick)) });
  }

  /** An event as the snapshot shows it: a ROOT position produced in the frame of its island is moved to the render root. */
  eventInFrame(ev: SimEvent): SimEvent {
    if (ev.type !== 'explosion') return ev;
    const from = this.eventOrigin.get(ev);
    if (from === undefined || sameOrigin(from, this.origin)) return ev;
    return { ...ev, posRoot: v3.add(ev.posRoot, this.between(from, this.origin, ev.ut).offset) };
  }

  /**
   * The predicted patches in the render root: `bodyPosAtEnd` is the position of the patch's body at the end
   * of the patch relative to where the frame's origin is then (zero for a patch about the origin body).
   */
  patchesInFrame(patches: { current: Patch[]; planned: Patch[] }): { current: Patch[]; planned: Patch[] } {
    const o = this.origin;
    if (o.kind === 'body' && o.bodyId === this.frames.system.rootId) return { current: patches.current, planned: patches.planned };
    const cache = this.shiftedPatches;
    if (cache && cache.source === patches && sameOrigin(cache.origin, o)) return { current: cache.out.current, planned: cache.out.planned };
    const move = (p: Patch): Patch => ({ ...p, bodyPosAtEnd: o.kind === 'body' && p.bodyId === o.bodyId ? v3.zero() : this.between({ kind: 'body', bodyId: p.bodyId }, o, p.tEnd).offset });
    const out = { current: patches.current.map(move), planned: patches.planned.map(move) };
    this.shiftedPatches = { source: patches, origin: o, out };
    return { current: out.current, planned: out.planned };
  }
}
