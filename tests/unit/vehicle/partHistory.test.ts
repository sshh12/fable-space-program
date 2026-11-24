/**
 * The state the vessel feature keeps per part (`PartHistory`) and the lineage table under it (`CraftLineage`):
 *
 *  - both are as large as what is drawn: after any number of separations they hold the parts and the craft of
 *    the vessels in the snapshot and of the vessels still fading out, not of everything that ever flew;
 *  - pruning never costs a part that is drawn its state: a part keeps it through every separation, also when
 *    every craft it passed through has been forgotten;
 *  - state asked for by craft and instance id is the state of the part, also for a piece nothing was drawn of.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { presentableVehicles } from '@/core/access/presentable';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CraftSnapshot, PartSnapshot, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { CraftLineage, craftIdOf } from '@/core/access/snapshotAccess';
import { PartHistory } from '@/render/vehicle/partHistory';
import { assembleVessel, splitForStage, vesselPartSnapshots, type Vessel } from '@/sim/vessel/public';

let defs: DefLibrary;
let base: SimSnapshot;

beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
  base = createFakeSim(defs, { scene: 'lowOrbit' }).peek();
});

const craftBlock = (id: string, parent: string | null): CraftSnapshot => ({ ...base.vessels[0]!.crafts![0]!, id, parent });

const part = (instanceId: string, craftId: string): PartSnapshot => ({ ...base.vessels[0]!.parts[0]!, instanceId, craftId });

/** A vessel snapshot of the given parts and craft, on the fake's flight state. */
const vesselOf = (id: string, parts: PartSnapshot[], crafts: CraftSnapshot[]): VesselSnapshot => ({ ...base.vessels[0]!, id, parts, crafts, links: [] });

/** A vessel of one craft: `craftId` (a piece of `parent`, or launched) with parts of the given instance ids. */
const oneCraft = (id: string, craftId: string, parent: string | null, instanceIds: string[]): VesselSnapshot =>
  vesselOf(
    id,
    instanceIds.map((i) => part(i, craftId)),
    [craftBlock(craftId, parent)],
  );

const snapshotOf = (vessels: VesselSnapshot[]): SimSnapshot => ({ ...base, vessels, activeVesselId: vessels[0]!.id });

/** What the feature does when it builds the plans of a snapshot: the state of every part of every vessel. */
const draw = (history: PartHistory, snapshot: SimSnapshot): void => {
  for (const v of snapshot.vessels) for (const p of v.parts) history.of(snapshot, v, p);
};

const partCount = (vessels: readonly VesselSnapshot[]): number => vessels.reduce((n, v) => n + v.parts.length, 0);
const craftCount = (vessels: readonly VesselSnapshot[]): number => new Set(vessels.flatMap((v) => v.parts.map((p) => craftIdOf(v, p)))).size;

describe('the state kept per part', () => {
  it('holds the parts and the craft of the snapshot through every stage of the stack, as the simulation names its craft', () => {
    const vehicle = presentableVehicles(defs)[0]!;
    const pruned = new PartHistory();
    // The same flight without a prune, as the feature kept its state before: every craft that ever was.
    const unpruned = new PartHistory();
    let vessel: Vessel = assembleVessel(defs, vehicle.id);
    const toSnapshot = (pieces: Vessel[]): SimSnapshot =>
      snapshotOf(
        pieces.map((p) =>
          vesselOf(
            p.id,
            vesselPartSnapshots(p),
            p.crafts.map((c) => craftBlock(c.craftId, c.parent)),
          ),
        ),
      );
    const launch = toSnapshot([vessel]);
    draw(pruned, launch);
    draw(unpruned, launch);
    pruned.prune(launch, []);
    expect(pruned.size).toBe(partCount(launch.vessels));
    expect(pruned.crafts).toBe(1);
    let separations = 0;
    for (let stage = 0; stage < vehicle.stages.length; stage++) {
      const res = splitForStage(defs, vessel, stage);
      vessel = res.vessel;
      separations += res.spawned.length;
      // What the stages before dropped has expired: the snapshot holds the ship and what it dropped just now.
      const snapshot = toSnapshot([res.vessel, ...res.spawned]);
      draw(pruned, snapshot);
      draw(unpruned, snapshot);
      pruned.prune(snapshot, []);
      expect(pruned.size, `after stage ${stage}`).toBe(partCount(snapshot.vessels));
      expect(pruned.crafts, `after stage ${stage}`).toBe(craftCount(snapshot.vessels));
    }
    expect(separations).toBeGreaterThan(3);
    expect(unpruned.size).toBeGreaterThan(pruned.size);
    expect(unpruned.crafts).toBeGreaterThanOrEqual(1 + separations);
    expect(pruned.crafts).toBeLessThan(unpruned.crafts);
  });

  it('stays bounded over 500 separations, and a part keeps its state through all of them', () => {
    const history = new PartHistory();
    const unpruned = new PartHistory();
    const ship = oneCraft('ship', 'ship', null, ['core']);
    // A shard is cut off again and again: piece n is a piece of piece n - 1 and takes the shard with it, leaving
    // a part of its own behind in each. A piece is in the snapshot for three steps after it was left.
    let pieces: VesselSnapshot[] = [oneCraft('piece-0', 'piece-0', 'ship', ['shard', 'junk-0'])];
    let snapshot = snapshotOf([ship, ...pieces]);
    const shard = history.of(snapshot, pieces[0]!, pieces[0]!.parts[0]!);
    shard.soot = 0.5;
    let peakParts = 0;
    let peakCrafts = 0;
    for (let n = 1; n <= 500; n++) {
      const left = pieces[pieces.length - 1]!;
      const newest = oneCraft(`piece-${n}`, `piece-${n}`, left.crafts![0]!.id, ['shard', `junk-${n}`]);
      pieces = [...pieces.slice(0, -1), { ...left, parts: left.parts.slice(1) }, newest].slice(-3);
      snapshot = snapshotOf([ship, ...pieces]);
      draw(history, snapshot);
      draw(unpruned, snapshot);
      history.prune(snapshot, []);
      expect(history.size).toBe(partCount(snapshot.vessels));
      expect(history.crafts).toBe(craftCount(snapshot.vessels));
      peakParts = Math.max(peakParts, history.size);
      peakCrafts = Math.max(peakCrafts, history.crafts);
      // The shard is the part it always was: its line of descent is remembered through craft long forgotten.
      expect(history.of(snapshot, newest, newest.parts[0]!)).toBe(shard);
    }
    expect(shard.soot).toBe(0.5);
    expect(peakParts).toBeLessThanOrEqual(5);
    expect(peakCrafts).toBeLessThanOrEqual(4);
    // Without a prune the same flight holds every part and every craft there ever was.
    expect(unpruned.size).toBeGreaterThan(500);
    expect(unpruned.crafts).toBeGreaterThan(500);
  });

  it('keeps the state of a vessel that is fading out, and drops it when the fade is over', () => {
    const history = new PartHistory();
    const ship = oneCraft('ship', 'ship', null, ['capsule', 'tank']);
    const debris = oneCraft('ship~stage', 'ship.stage', 'ship', ['booster', 'engine']);
    const before = snapshotOf([ship, debris]);
    draw(history, before);
    const engine = history.of(before, debris, debris.parts[1]!);
    engine.soot = 1;
    // The debris expired: it is no longer in the snapshot, and the feature still draws it for a second.
    const after = snapshotOf([ship]);
    history.prune(after, [debris]);
    expect(history.size).toBe(4);
    expect(history.crafts).toBe(2);
    expect(history.byId(after, 'ship.stage', 'engine')).toBe(engine);
    history.prune(after, []);
    expect(history.size).toBe(2);
    expect(history.crafts).toBe(1);
    // Seen again (a snapshot that holds it once more), it is a vessel seen for the first time.
    const again = history.of(before, debris, debris.parts[1]!);
    expect(again).not.toBe(engine);
    expect(again.soot).toBe(0);
    expect(again.frost).toBe(-1);
  });

  it('asked by craft and instance id, answers with the state of the part: for a launched craft before its first frame, and for a piece nothing was drawn of', () => {
    const history = new PartHistory();
    // Before the first snapshot: a launched craft is its own line.
    const early = history.byId(null, 'ship', 'tank');
    early.soot = 1;
    const ship = oneCraft('ship', 'ship', null, ['capsule', 'tank']);
    const launch = snapshotOf([ship]);
    expect(history.of(launch, ship, ship.parts[1]!)).toBe(early);
    draw(history, launch);
    history.prune(launch, []);
    expect(history.size).toBe(2);
    // The tank leaves as a piece. Nothing of the piece has been drawn when its state is asked for by its ids:
    // it is the state the tank had as a part of the ship, not a new one under the piece's own id.
    const upper = oneCraft('ship', 'ship', null, ['capsule']);
    const stage = oneCraft('ship~tank', 'ship.tank', 'ship', ['tank']);
    const split = snapshotOf([upper, stage]);
    expect(history.byId(split, 'ship.tank', 'tank')).toBe(early);
    expect(history.size).toBe(2);
    // A craft no snapshot has shown is taken for a launched craft, and nothing is remembered about it ...
    const crafts = history.crafts;
    const unknown = history.byId(split, 'ship.tank.valve', 'valve');
    unknown.soot = 1;
    expect(history.crafts).toBe(crafts);
    expect(history.size).toBe(3);
    // ... so when it shows up as a piece its parts are the parts they were, and what was filed for it goes.
    draw(history, split);
    history.prune(split, []);
    expect(history.size).toBe(2);
    const valve = oneCraft('ship~valve', 'ship.tank.valve', 'ship.tank', ['tank']);
    const later = snapshotOf([upper, valve]);
    expect(history.of(later, valve, valve.parts[0]!)).toBe(early);
    history.prune(later, []);
    expect(history.size).toBe(2);
    expect(history.crafts).toBe(2);
  });
});

describe('the lineage table', () => {
  it('forgets on retain what is not live, keeps the answers of the live, and resolves a forgotten craft afresh', () => {
    const launched = oneCraft('ship', 'ship', null, ['capsule']);
    const stage = oneCraft('ship~tank', 'ship.tank', 'ship', ['tank']);
    const shard = oneCraft('ship~nozzle', 'ship.tank.nozzle', 'ship.tank', ['nozzle']);
    const all = snapshotOf([launched, stage, shard]);
    const lineage = new CraftLineage();
    expect(lineage.size).toBe(0);
    expect(lineage.knows('ship.tank')).toBe(false);
    for (const v of all.vessels) lineage.keyOf(all, v, v.parts[0]!);
    expect(lineage.size).toBe(3);
    expect(lineage.knows('ship.tank')).toBe(true);
    // The stage and the launched craft are forgotten; the shard's answer stays although its line passed through both.
    lineage.retain(new Set(['ship.tank.nozzle']));
    expect(lineage.size).toBe(1);
    expect(lineage.knows('ship.tank')).toBe(false);
    expect(lineage.knows('ship')).toBe(false);
    const later = snapshotOf([shard]);
    expect(lineage.keyOf(later, shard, shard.parts[0]!)).toBe('ship/nozzle');
    // A piece cut from the shard now descends from the launched craft as the shard does.
    const chip = oneCraft('ship~chip', 'ship.tank.nozzle.chip', 'ship.tank.nozzle', ['chip']);
    expect(lineage.keyOf(snapshotOf([shard, chip]), chip, chip.parts[0]!)).toBe('ship/chip');
    // Forgotten and seen again without the craft it left, a craft's line ends at the first craft nobody describes.
    lineage.retain(new Set());
    expect(lineage.size).toBe(0);
    expect(lineage.keyOf(later, shard, shard.parts[0]!)).toBe('ship.tank/nozzle');
    // Retaining a craft the table never resolved adds nothing.
    lineage.retain(new Set(['ship.tank.nozzle', 'never-seen']));
    expect(lineage.size).toBe(1);
  });
});
