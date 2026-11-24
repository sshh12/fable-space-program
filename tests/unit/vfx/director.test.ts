/**
 * The part an event names (`findEventPart`) and the effects the director starts at it, with two vessels of
 * one vehicle in the snapshot. They carry the same instance ids, and an event names its part by the part key
 * `craftId/instanceId`: the effect belongs to the vessel that holds the part of that craft (or of a piece
 * that left it), whichever of the two vehicles the snapshot lists first; an instance id alone names nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { firstPresentableVehicleId } from '@/core/access/presentable';
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
  const parts = vesselPartSnapshots(assembleVessel(defs, firstPresentableVehicleId(defs)!, { craft: { craftId, ownerId: null, name: id, joinedTick: 0 } }));
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

/** Where the effects of one update start: the x of every emitter, fireball and flash. */
const startedBy = (director: EffectDirector, snapshot: SimSnapshot): number[] => {
  const flashes = director.flashes.length;
  const out = director.update(frameOf(snapshot), domainOf(snapshot.vessels[0]!.bodyId), [], 0, 1 / 60);
  return [...out.emitters.map((e) => e.pos.x), ...out.fireballs.map((f) => f.pos.x), ...director.flashes.slice(flashes).map((f) => f.pos.x)];
};

/** Where the effects of one snapshot's events start, in the given library (the repository's unless one is given). */
const effectsAt = (snapshot: SimSnapshot, library: DefLibrary = defs): number[] => startedBy(new EffectDirector(library, data), snapshot);

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
  it('is the part of the craft its key names, in either order of the snapshot, with the event and without it; an instance id alone names no part', () => {
    const a = stackAt('A', 0);
    const b = stackAt('B', APART);
    const id = withModule(a, 'decoupler').instanceId;
    expect(withModule(b, 'decoupler').instanceId).toBe(id);
    for (const vessels of bothOrders(a, [b])) {
      const snap = snapshotOf(vessels);
      expect(findEventPart(snap, partKey('craft-B', id), { vesselId: 'B' })?.vessel.id).toBe('B');
      expect(findEventPart(snap, partKey('craft-A', id), { vesselId: 'A', newVesselIds: [] })?.vessel.id).toBe('A');
      // A caller with nothing but the key finds the same part: a part key is unique in the snapshot.
      expect(findEventPart(snap, partKey('craft-B', id))?.vessel.id).toBe('B');
      expect(findEventPart(snap, partKey('craft-A', id))?.vessel.id).toBe('A');
      // The instance id both vehicles carry is no key: it names a part of neither.
      expect(findEventPart(snap, id, { vesselId: 'B' })).toBeNull();
      expect(findEventPart(snap, id)).toBeNull();
      expect(findEventPart(snap, partKey('craft-C', id), { vesselId: 'B' })).toBeNull();
    }
  });

  it('is found in a vessel the event made, after its own, by the key of the craft the part left; the same instance id in the other vehicle is not it', () => {
    const a = stackAt('A', 0);
    const whole = stackAt('B', APART);
    const decoupler = withModule(whole, 'decoupler');
    // The decoupler of B left with the stage B dropped: a piece, a craft and a vessel of its own.
    const b = { ...whole, parts: whole.parts.filter((p) => p !== decoupler) };
    const stage = vesselAt('B-stage', APART + 300, [{ ...decoupler, craftId: 'craft-B.stage' }], 'craft-B.stage', 'craft-B');
    for (const vessels of bothOrders(a, [b, stage])) {
      const snap = snapshotOf(vessels);
      // The event names the part by the craft it was a part of: the piece answers to that key through its line of descent.
      expect(findEventPart(snap, partKey('craft-B', decoupler.instanceId), { vesselId: 'B', newVesselIds: ['B-stage'] })?.vessel.id).toBe('B-stage');
      // A part key is unique in the snapshot: it is found wherever the part is, whichever vessels the event names.
      expect(findEventPart(snap, partKey('craft-B', decoupler.instanceId), { vesselId: 'B' })?.vessel.id).toBe('B-stage');
      expect(findEventPart(snap, partKey('craft-B', decoupler.instanceId), { vesselId: 'B', newVesselIds: ['gone'] })?.vessel.id).toBe('B-stage');
      expect(findEventPart(snap, partKey('craft-B', decoupler.instanceId), { vesselId: 'gone' })?.vessel.id).toBe('B-stage');
      expect(findEventPart(snap, partKey('craft-B', decoupler.instanceId))?.vessel.id).toBe('B-stage');
      // The piece answers to its own key too, and the part of that instance id in A to A's alone.
      expect(findEventPart(snap, partKey('craft-B.stage', decoupler.instanceId), { vesselId: 'B' })?.vessel.id).toBe('B-stage');
      expect(findEventPart(snap, partKey('craft-A', decoupler.instanceId), { vesselId: 'B' })?.vessel.id).toBe('A');
      // The instance id alone is no key.
      expect(findEventPart(snap, decoupler.instanceId, { vesselId: 'B', newVesselIds: ['B-stage'] })).toBeNull();
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
      expectAllNear(effectsAt(snapshotOf(vessels, [{ type: 'decoupled', ut: 0, vesselId: 'B', partId: partKey('craft-B', decoupler.instanceId), newVesselIds: [] }])), APART);
      expectAllNear(effectsAt(snapshotOf(vessels, [{ type: 'decoupled', ut: 0, vesselId: 'A', partId: partKey('craft-A', decoupler.instanceId), newVesselIds: [] }])), 0);
    }
    const kept = { ...b, parts: b.parts.filter((p) => p !== decoupler) };
    const stage = vesselAt('B-stage', APART + 300, [{ ...decoupler, craftId: 'craft-B.stage' }], 'craft-B.stage', 'craft-B');
    for (const vessels of bothOrders(a, [kept, stage])) {
      expectAllNear(effectsAt(snapshotOf(vessels, [{ type: 'decoupled', ut: 0, vesselId: 'B', partId: partKey('craft-B', decoupler.instanceId), newVesselIds: ['B-stage'] }])), APART + 300);
    }
  });

  it('a parachute puff starts at the vessel that deployed', () => {
    const a = stackAt('A', 0);
    const b = stackAt('B', APART);
    const chutePart = withModule(b, 'parachute');
    const chute = defs.parts[chutePart.def]!.modules.find((m) => m.type === 'parachute');
    if (chute?.type !== 'parachute') throw new Error('expected a parachute module');
    for (const vessels of bothOrders(a, [b])) {
      expectAllNear(effectsAt(snapshotOf(vessels, [{ type: 'chuteDeployed', ut: 0, vesselId: 'B', partId: partKey('craft-B', chutePart.instanceId), mode: chute.mode }])), APART);
      expectAllNear(effectsAt(snapshotOf(vessels, [{ type: 'chuteDeployed', ut: 0, vesselId: 'A', partId: partKey('craft-A', chutePart.instanceId), mode: chute.mode }])), 0);
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
    const event: SimEvent = { type: 'fairingJettisoned', ut: 0, vesselId: 'B', partId: partKey('craft-B', fairing.instanceId), newVesselIds: petals.map((p) => p.id) };
    for (const vessels of bothOrders(a, [b, ...petals])) expectAllNear(effectsAt(snapshotOf(vessels, [event])), APART + 400);
  });
});

describe('a vessel that is not presentable (a part of it has no visual definition: src/core/access/presentable.ts)', () => {
  /**
   * The stack B with one of its parts on a definition that has no visual (the part's own definition under
   * another id, without its model), and the library that holds that definition. A stays as it is.
   */
  const withoutModel = (b: VesselSnapshot, keep: PartSnapshot): { library: DefLibrary; hidden: VesselSnapshot } => {
    const lacking = b.parts.find((p) => p !== keep)!;
    const library: DefLibrary = { ...defs, parts: { ...defs.parts, 'no-model': { ...defs.parts[lacking.def]!, id: 'no-model', visual: null } } };
    return { library, hidden: { ...b, parts: b.parts.map((p) => (p === lacking ? { ...p, def: 'no-model' } : p)) } };
  };
  const staged = (id: 'A' | 'B', decoupler: PartSnapshot): SimEvent => ({ type: 'decoupled', ut: 0, vesselId: id, partId: partKey(`craft-${id}`, decoupler.instanceId), newVesselIds: [] });

  it('starts no effect at its events; the vessel that is shown beside it starts its own', () => {
    const a = stackAt('A', 0);
    const b = stackAt('B', APART);
    const decoupler = withModule(b, 'decoupler');
    const { library, hidden } = withoutModel(b, decoupler);
    for (const vessels of bothOrders(a, [hidden])) {
      expect(effectsAt(snapshotOf(vessels, [staged('B', decoupler)]), library)).toEqual([]);
      const ofA = effectsAt(snapshotOf(vessels, [staged('A', decoupler)]), library);
      expect(ofA.length).toBeGreaterThan(0);
      for (const x of ofA) expect(Math.abs(x)).toBeLessThan(NEAR);
    }
    // The same vessel with every model: its staging puff is there (the test above sees a difference).
    expect(effectsAt(snapshotOf([a, b], [staged('B', decoupler)]), library).length).toBeGreaterThan(0);
  });

  it('starts no ablation sparks in a shock layer, and none when it ends: the explosion of a vessel that was never shown is not shown', () => {
    const a = stackAt('A', 0);
    const b = stackAt('B', APART);
    const { library, hidden } = withoutModel(b, withModule(b, 'decoupler'));
    const entering = (v: VesselSnapshot): VesselSnapshot => ({ ...v, vRoot: { x: 0, y: 0, z: 3000 }, aero: { ...v.aero, plasmaIntensity: 1 } });
    // In the shock layer: the vessel with its models sheds sparks, the one without is passed over.
    expect(effectsAt(snapshotOf([a, entering(b)]), library).length).toBeGreaterThan(0);
    expect(effectsAt(snapshotOf([a, entering(hidden)]), library)).toEqual([]);
    // It is destroyed: the snapshot that carries the event holds the vessel no more.
    const blast: SimEvent = { type: 'explosion', ut: 1, vesselId: 'B', posRoot: { x: APART, y: 0, z: 0 }, energy: 1e9 };
    const director = new EffectDirector(library, data);
    expect(startedBy(director, snapshotOf([a, hidden]))).toEqual([]);
    expect(startedBy(director, snapshotOf([a], [blast]))).toEqual([]);
    // The explosion of the vessel that was shown is.
    const shown = new EffectDirector(library, data);
    expect(startedBy(shown, snapshotOf([a, b]))).toEqual([]);
    const at = startedBy(shown, snapshotOf([a], [blast]));
    expect(at.length).toBeGreaterThan(0);
    for (const x of at) expect(Math.abs(x - APART)).toBeLessThan(NEAR);
  });
});
