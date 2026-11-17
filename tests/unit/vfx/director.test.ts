/**
 * The part an event names (`findEventPart`) and the effects the director starts at it, with two vessels of
 * one vehicle in the snapshot. They carry the same instance ids, and an event of a vessel of one craft names
 * its part by instance id: the effect belongs to the vessel the event names (or to a vessel it made),
 * whichever of the two vehicles the snapshot lists first.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { FrameContext } from '@/core/contracts/render';
import type { PartSnapshot, SimEvent, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { findEventPart, partKey } from '@/core/access/snapshotAccess';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { loadVfxData, type VfxData } from '@/render/vfx';
import { EffectDirector } from '@/render/vfx/director';
import type { DomainFrame } from '@/render/vfx/domain';
import { assembleVessel, vesselPartSnapshots } from '@/sim/vessel/public';

let defs: DefLibrary;
let data: VfxData;
let base: SimSnapshot;

beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
  data = loadVfxData(defs);
  base = createFakeSim(defs, { scene: 'pad' }).peek();
});

/** The two vehicles stand this far apart (m, along ROOT x): no part of one is within a kilometre of the other. */
const APART = 5000;
/** A stack is 100 m long: an effect of a vessel is within this distance of its origin. */
const NEAR = 150;

/** A vessel `id` of the given parts at `x`, as one craft of its own (`craftId`; `parent` for a piece). */
const vesselAt = (id: string, x: number, parts: PartSnapshot[], craftId: string, parent: string | null = null): VesselSnapshot => ({
  ...base.vessels[0]!,
  id,
  parts,
  crafts: [{ ...base.vessels[0]!.crafts![0]!, id: craftId, parent }],
  q: quat.identity(),
  rRoot: { x, y: 0, z: 0 },
  vRoot: v3.zero(),
});

/** The whole stack of the library's first vehicle: a launched craft `craft-<id>` in a vessel `id`. */
const stackAt = (id: string, x: number): VesselSnapshot => {
  const craftId = `craft-${id}`;
  const parts = vesselPartSnapshots(assembleVessel(defs, Object.keys(defs.vehicles)[0]!, { craft: { craftId, ownerId: null, name: id, joinedTick: 0 } }));
  return vesselAt(id, x, parts, craftId);
};

const snapshotOf = (vessels: VesselSnapshot[], events: SimEvent[] = []): SimSnapshot => ({ ...base, vessels, events, activeVesselId: vessels[0]!.id });

/** What the director reads of a frame: the snapshot, the eye at the ROOT origin and the vessels where the snapshot has them. */
const frameOf = (snapshot: SimSnapshot): FrameContext =>
  ({
    snapshot,
    camera: { positionRoot: v3.zero() },
    qualityScale: 1,
    vesselPose: (id: string) => {
      const v = snapshot.vessels.find((x) => x.id === id);
      return v ? { id, originRelCam: v.rRoot, q: v.q, prevOriginRelCam: v.rRoot, prevQ: v.q } : undefined;
    },
  }) as unknown as FrameContext;

/** A space domain at the ROOT origin, at rest: domain coordinates are ROOT coordinates. */
const domainOf = (bodyId: string): DomainFrame => ({
  state: { kind: 'space', bodyId, origin: { x: 0, y: 7e6, z: 0 }, velocity: v3.zero() },
  rebase: null,
  reset: false,
  originRoot: v3.zero(),
  velocityRoot: v3.zero(),
  q: quat.identity(),
  up: { x: 0, y: 1, z: 0 },
  gravity: 0,
  altitude: 6e5,
});

/** Where the effects of one snapshot's events start: the x of every emitter and flash. */
const effectsAt = (snapshot: SimSnapshot): number[] => {
  const director = new EffectDirector(defs, data);
  const out = director.update(frameOf(snapshot), domainOf(snapshot.vessels[0]!.bodyId), [], 0, 1 / 60);
  return [...out.emitters.map((e) => e.pos.x), ...director.flashes.map((f) => f.pos.x)];
};

const withModule = (vessel: VesselSnapshot, type: string): PartSnapshot => {
  const part = vessel.parts.find((p) => defs.parts[p.def]!.modules.some((m) => m.type === type));
  if (!part) throw new Error(`the stack has no part with a ${type} module`);
  return part;
};

/** Both orders in which a snapshot can list the first vehicle's vessel and the vessels of the second. */
const bothOrders = (first: VesselSnapshot, second: VesselSnapshot[]): VesselSnapshot[][] => [
  [first, ...second],
  [...second, first],
];

describe('the part an event names, with two vessels of one vehicle in the snapshot', () => {
  it('is the part of the vessel the event names, in either order of the snapshot; without the event, the first in the snapshot as before', () => {
    const a = stackAt('A', 0);
    const b = stackAt('B', APART);
    const id = withModule(a, 'decoupler').instanceId;
    expect(withModule(b, 'decoupler').instanceId).toBe(id);
    for (const vessels of bothOrders(a, [b])) {
      const snap = snapshotOf(vessels);
      expect(findEventPart(snap, id, { vesselId: 'B' })?.vessel.id).toBe('B');
      expect(findEventPart(snap, id, { vesselId: 'A', newVesselIds: [] })?.vessel.id).toBe('A');
      // A caller with nothing but the id gets the first match of the snapshot.
      expect(findEventPart(snap, id)?.vessel.id).toBe(vessels[0]!.id);
    }
  });

  it('is found in a vessel the event made, after its own; an instance id is not looked for in a vessel the event does not name', () => {
    const a = stackAt('A', 0);
    const whole = stackAt('B', APART);
    const decoupler = withModule(whole, 'decoupler');
    // The decoupler of B left with the stage B dropped: a piece, a craft and a vessel of its own.
    const b = { ...whole, parts: whole.parts.filter((p) => p !== decoupler) };
    const stage = vesselAt('B-stage', APART + 300, [{ ...decoupler, craftId: 'craft-B.stage' }], 'craft-B.stage', 'craft-B');
    for (const vessels of bothOrders(a, [b, stage])) {
      const snap = snapshotOf(vessels);
      expect(findEventPart(snap, decoupler.instanceId, { vesselId: 'B', newVesselIds: ['B-stage'] })?.vessel.id).toBe('B-stage');
      // The event names neither the stage nor A: the part of that instance id in A is not B's.
      expect(findEventPart(snap, decoupler.instanceId, { vesselId: 'B' })).toBeNull();
      expect(findEventPart(snap, decoupler.instanceId, { vesselId: 'B', newVesselIds: ['gone'] })).toBeNull();
      expect(findEventPart(snap, decoupler.instanceId, { vesselId: 'gone' })).toBeNull();
      // A part key is unique in the snapshot: it is found wherever the part is, through its line of descent.
      expect(findEventPart(snap, partKey('craft-B', decoupler.instanceId), { vesselId: 'B' })?.vessel.id).toBe('B-stage');
      expect(findEventPart(snap, partKey('craft-A', decoupler.instanceId), { vesselId: 'B' })?.vessel.id).toBe('A');
      expect(findEventPart(snap, partKey('craft-B', decoupler.instanceId))?.vessel.id).toBe('B-stage');
    }
  });
});

describe('the effects of an event, with two vessels of one vehicle in the snapshot', () => {
  const expectAllNear = (xs: number[], x: number): void => {
    expect(xs.length).toBeGreaterThan(0);
    for (const at of xs) expect(Math.abs(at - x)).toBeLessThan(NEAR);
  };

  it('a staging puff starts at the decoupler of the vessel that staged, also when the decoupler left with the stage', () => {
    const a = stackAt('A', 0);
    const b = stackAt('B', APART);
    const decoupler = withModule(b, 'decoupler');
    for (const vessels of bothOrders(a, [b])) {
      expectAllNear(effectsAt(snapshotOf(vessels, [{ type: 'decoupled', ut: 0, vesselId: 'B', partId: decoupler.instanceId, newVesselIds: [] }])), APART);
      expectAllNear(effectsAt(snapshotOf(vessels, [{ type: 'decoupled', ut: 0, vesselId: 'A', partId: decoupler.instanceId, newVesselIds: [] }])), 0);
    }
    const kept = { ...b, parts: b.parts.filter((p) => p !== decoupler) };
    const stage = vesselAt('B-stage', APART + 300, [{ ...decoupler, craftId: 'craft-B.stage' }], 'craft-B.stage', 'craft-B');
    for (const vessels of bothOrders(a, [kept, stage])) {
      expectAllNear(effectsAt(snapshotOf(vessels, [{ type: 'decoupled', ut: 0, vesselId: 'B', partId: decoupler.instanceId, newVesselIds: ['B-stage'] }])), APART + 300);
    }
  });

  it('a parachute puff starts at the vessel that deployed', () => {
    const a = stackAt('A', 0);
    const b = stackAt('B', APART);
    const chutePart = withModule(b, 'parachute');
    const chute = defs.parts[chutePart.def]!.modules.find((m) => m.type === 'parachute');
    if (chute?.type !== 'parachute') throw new Error('expected a parachute module');
    for (const vessels of bothOrders(a, [b])) {
      expectAllNear(effectsAt(snapshotOf(vessels, [{ type: 'chuteDeployed', ut: 0, vesselId: 'B', partId: chutePart.instanceId, mode: chute.mode }])), APART);
      expectAllNear(effectsAt(snapshotOf(vessels, [{ type: 'chuteDeployed', ut: 0, vesselId: 'A', partId: chutePart.instanceId, mode: chute.mode }])), 0);
    }
  });

  it('a fairing puff starts at the first petal of the vessel that jettisoned, not at the fairing the other vehicle still carries', () => {
    const a = stackAt('A', 0);
    const whole = stackAt('B', APART);
    const fairing = withModule(whole, 'fairing');
    expect(withModule(a, 'fairing').instanceId).toBe(fairing.instanceId);
    // B's fairing is gone from the snapshot: two petals replaced it, a vessel and a craft each, with ids of their own.
    const b = { ...whole, parts: whole.parts.filter((p) => p !== fairing) };
    const petal = (index: number): VesselSnapshot => {
      const craftId = `craft-B.petal${index}`;
      const part: PartSnapshot = { ...fairing, instanceId: `petal${index}`, craftId, panel: { index, count: 2, of: fairing.instanceId } };
      return vesselAt(`B-petal-${index}`, APART + 400 + 50 * index, [part], craftId, 'craft-B');
    };
    const petals = [petal(1), petal(0)];
    const event: SimEvent = { type: 'fairingJettisoned', ut: 0, vesselId: 'B', partId: fairing.instanceId, newVesselIds: petals.map((p) => p.id) };
    for (const vessels of bothOrders(a, [b, ...petals])) expectAllNear(effectsAt(snapshotOf(vessels, [event])), APART + 400);
  });
});
