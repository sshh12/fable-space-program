/**
 * The render root of a session's snapshots (ARCHITECTURE section 3, `SimSnapshot.frame`): the origin of
 * every `...Root` field is the centre of the focus vessel's SOI body. When that body is replaced a new
 * frame epoch starts; the snapshot that carries a new epoch also carries the rebase from the origin of the
 * snapshot before it, and every snapshot describes the origins of the last few epochs in its own frame.
 */
import type { Patch, SimEvent, SimSnapshot } from '@/core/contracts/sim';
import { FRAME_HISTORY_EPOCHS, type FrameEpochOrigin, type FrameRebase } from '@/core/math/frame';
import { v3 } from '@/core/math/vec3';
import type { BodySystem } from '../bodies/bodySystem';

export class RenderRoot {
  epoch = 0;
  /** Body whose centre is the origin now. */
  bodyId: string;
  /** The origins of earlier epochs, newest first. */
  private history: { epoch: number; bodyId: string }[] = [];
  /** Epoch and origin the last drained snapshot carried: the rebase of the next one starts there. */
  private seenEpoch = 0;
  private seenBody: string;
  /** SOI body an event's ROOT position was produced in (the vessel package works in the BCI frame of its body). */
  private readonly eventBody = new WeakMap<SimEvent, string>();
  private shiftedPatches: { source: { current: Patch[]; planned: Patch[] }; bodyId: string; out: { current: Patch[]; planned: Patch[] } } | null = null;

  constructor(
    private readonly system: BodySystem,
    /** 'soiBody': the origin follows the focus; 'rootBody': it is the library's root body and never replaced. */
    private readonly mode: 'soiBody' | 'rootBody',
  ) {
    this.bodyId = system.rootId;
    this.seenBody = system.rootId;
  }

  /** The first frame of a session: its origin is the start vessel's SOI body, with no epoch before it. */
  reset(focusBodyId: string): void {
    this.bodyId = this.mode === 'soiBody' ? focusBodyId : this.system.rootId;
    this.seenBody = this.bodyId;
    this.epoch = 0;
    this.seenEpoch = 0;
    this.history = [];
  }

  /** Keep the origin at the focus vessel's SOI body. True when a new epoch started. */
  follow(focusBodyId: string): boolean {
    if (this.mode !== 'soiBody' || focusBodyId === this.bodyId) return false;
    this.history.unshift({ epoch: this.epoch, bodyId: this.bodyId });
    if (this.history.length > FRAME_HISTORY_EPOCHS) this.history.length = FRAME_HISTORY_EPOCHS;
    this.epoch++;
    this.bodyId = focusBodyId;
    return true;
  }

  get shifted(): boolean {
    return this.bodyId !== this.system.rootId;
  }

  /** The frame block of a snapshot at the presentation time `utP`. */
  describe(utP: number): SimSnapshot['frame'] {
    const relative = (bodyId: string): FrameRebase => {
      const s = this.system.stateRelative(bodyId, this.bodyId, utP);
      return { offset: s.r, velocity: s.v };
    };
    const rebase = this.epoch !== this.seenEpoch ? relative(this.seenBody) : null;
    const previous: FrameEpochOrigin[] = this.history.map((h) => ({ epoch: h.epoch, ...relative(h.bodyId) }));
    return { epoch: this.epoch, origin: { kind: 'body', bodyId: this.bodyId }, rebase, previous };
  }

  /** The rebase is drained like the events: the next snapshot starts from this frame. */
  drain(): void {
    this.seenEpoch = this.epoch;
    this.seenBody = this.bodyId;
  }

  /** Remember the body an event's ROOT position refers to. */
  noteEvent(ev: SimEvent, bodyId: string): void {
    if (ev.type === 'explosion') this.eventBody.set(ev, bodyId);
  }

  /** An event as the snapshot shows it: a ROOT position produced in the BCI frame of its body is moved to the render root. */
  eventInFrame(ev: SimEvent): SimEvent {
    if (ev.type !== 'explosion') return ev;
    const bodyId = this.eventBody.get(ev);
    if (bodyId === undefined || bodyId === this.bodyId) return ev;
    return { ...ev, posRoot: v3.add(ev.posRoot, this.system.stateRelative(bodyId, this.bodyId, ev.ut).r) };
  }

  /**
   * The predicted patches in the render root: `bodyPosAtEnd` is the position of the patch's body at the end
   * of the patch relative to where the frame's origin body is then (zero for a patch about the origin body).
   */
  patchesInFrame(patches: { current: Patch[]; planned: Patch[] }): { current: Patch[]; planned: Patch[] } {
    if (this.bodyId === this.system.rootId) return { current: patches.current, planned: patches.planned };
    const cache = this.shiftedPatches;
    if (cache && cache.source === patches && cache.bodyId === this.bodyId) return { current: cache.out.current, planned: cache.out.planned };
    const move = (p: Patch): Patch => ({ ...p, bodyPosAtEnd: p.bodyId === this.bodyId ? v3.zero() : this.system.stateRelative(p.bodyId, this.bodyId, p.tEnd).r });
    const out = { current: patches.current.map(move), planned: patches.planned.map(move) };
    this.shiftedPatches = { source: patches, bodyId: this.bodyId, out };
    return { current: out.current, planned: out.planned };
  }
}
