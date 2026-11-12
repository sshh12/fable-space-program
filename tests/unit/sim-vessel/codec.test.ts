/**
 * The vessel codec (docs/ARCHITECTURE.md 7.2; MIGRATION_V2 step 3.4): exact round trips in every regime
 * with a bit-identical continuation, sizes, the corpus of earlier versions, definitions that changed since
 * a blob was written (the migration registry), unknown and misfitting blocks, embedded designs, assemblies,
 * and the cheap copy for a rollback ring.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, PartDef } from '@/core/contracts/defs';
import {
  captureVessel,
  CODEC_VERSION,
  computeMassProps,
  decodeVessel,
  dockMerge,
  encodeVessel,
  fitResources,
  insertModule,
  libraryResolver,
  MigrationRegistry,
  partFingerprint,
  readHeader,
  restoreVessel,
  stateHash,
  structureOf,
  VesselDecodeError,
  type Vessel,
} from '@/sim/vessel';
import type { CorpusEntry } from './codec-corpus/record';
import { buildScene, flyOn, SCENE_NAMES, type Scene } from './codecScenes';
import { dockingLibrary, ferry, mate, partIndex } from './dockingFixtures';
import { loadLibrary } from './helpers';

const corpusDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codec-corpus');
let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

const encode = (v: Vessel, lib: DefLibrary = defs): Uint8Array => encodeVessel(v, { defsHash: 'test-library', refs: libraryResolver(lib) });
const decode = (bytes: Uint8Array, lib: DefLibrary = defs) => decodeVessel(bytes, { resolver: libraryResolver(lib) });
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const bitsOf = (v: Vessel): number[] => [v.r.x, v.r.y, v.r.z, v.v.x, v.v.y, v.v.z, v.q.x, v.q.y, v.q.z, v.q.w, v.w.x, v.w.y, v.w.z, v.mp.mass];

describe('round trip', () => {
  it('every regime: equal state hash at load, identical bytes on re-encoding, a bit-identical continuation for 6,000 steps', () => {
    const sizes: string[] = [];
    for (const name of SCENE_NAMES) {
      const scene: Scene = buildScene(defs, name);
      const original = scene.vessel;
      const parts = original.parts.length;
      const bytes = encode(original);
      const { vessel: loaded, report } = decode(bytes);
      expect(report).toEqual({ version: CODEC_VERSION, defsHash: 'test-library', unknownBlocks: [], migrated: [], vehicleChanged: [] });
      expect(stateHash(loaded), name).toBe(stateHash(original));
      expect(sameBytes(encode(loaded), bytes), name).toBe(true);
      // The structure cache is not in the blob and holds no state: it is rebuilt and tied to the carried state.
      expect(loaded.struct).toBeNull();
      expect(structureOf(loaded).carried).toBe(loaded.carried);
      const envA = scene.env();
      const envB = scene.env();
      const shedA = flyOn(scene, original, envA, 6000);
      const shedB = flyOn(scene, loaded, envB, 6000);
      expect(shedB, name).toBe(shedA);
      expect(bitsOf(loaded).every((x, i) => Object.is(x, bitsOf(original)[i])), `${name}: position, velocity, attitude, rate and mass after 6,000 steps`).toBe(true);
      expect(stateHash(loaded), `${name}: state hash after 6,000 steps`).toBe(stateHash(original));
      sizes.push(`${name}: ${bytes.length} B for ${parts} parts`);
    }
    console.log(`codec sizes (version ${CODEC_VERSION}): ${sizes.join('; ')}`);
  });

  it('the 38-part stack is under 9 kB', () => {
    const scene = buildScene(defs, 'stack-ascent');
    expect(scene.vessel.parts).toHaveLength(38);
    expect(encode(scene.vessel).length).toBeLessThan(9000);
  });

  it('every float64 comes back bit for bit: NaN, the infinities, the sign of zero, the smallest and the largest', () => {
    const v = buildScene(defs, 'coasting').vessel;
    const odd = [NaN, Infinity, -Infinity, -0, 0, 5e-324, -5e-324, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, 1 / 3, -1e-310, 2 ** 53, -(2 ** 53) + 1, 199, 200, -1, 32767, -32768, 32768, 0.1, 16777217];
    // Planted in fields of every encoding the codec uses: raw vectors, tagged scalars, part arrays, module state.
    odd.forEach((x, i) => {
      const part = v.parts[i % v.parts.length]!;
      part.temps[0] = x;
      v.restTimer = x;
      v.r.x = x;
      v.aero.heatFlux = x;
      part.stress = x;
      if (part.resources.length > 0) part.resources[0] = x;
      const loaded = decode(encode(v)).vessel;
      const back = loaded.parts[i % v.parts.length]!;
      for (const [a, b] of [
        [back.temps[0], x],
        [loaded.restTimer, x],
        [loaded.r.x, x],
        [loaded.aero.heatFlux, x],
        [back.stress, x],
        [back.resources.length > 0 ? back.resources[0] : x, x],
      ] as const) {
        expect(Object.is(a, b), `${String(x)} came back as ${String(a)}`).toBe(true);
      }
    });
    // In module state too (the self-describing form).
    const engine = v.parts.find((p) => p.modules.some((m) => m.type === 'engine'))!;
    const m = engine.modules.find((x) => x.type === 'engine')!;
    if (m.type !== 'engine') throw new Error('no engine');
    m.thrust = -0;
    m.pressureRatio = Infinity;
    m.ignitionAge = NaN;
    const back = decode(encode(v)).vessel.parts.find((p) => p.instanceId === engine.instanceId)!.modules.find((x) => x.type === 'engine')!;
    if (back.type !== 'engine') throw new Error('no engine');
    expect(Object.is(back.thrust, -0)).toBe(true);
    expect(back.pressureRatio).toBe(Infinity);
    expect(Number.isNaN(back.ignitionAge)).toBe(true);
  });

  it('the state hash does not depend on the library hash of the header', () => {
    const v = buildScene(defs, 'coasting').vessel;
    const a = encodeVessel(v, { defsHash: 'library-one' });
    const b = encodeVessel(v, { defsHash: 'another-library' });
    expect(readHeader(a).defsHash).toBe('library-one');
    expect(readHeader(b).defsHash).toBe('another-library');
    expect(sameBytes(a.subarray(readHeader(a).bodyAt), b.subarray(readHeader(b).bodyAt))).toBe(true);
    // And it tells any difference of state: one bit of one tank.
    const before = stateHash(v);
    const tank = v.parts.find((p) => p.resources.length > 0)!;
    tank.resources[0] = tank.resources[0]! * (1 + 2 ** -52);
    expect(stateHash(v)).not.toBe(before);
  });
});

describe('the corpus of earlier blobs', () => {
  it('every blob in the corpus decodes to the state it was written from, whatever version wrote it', () => {
    const list = JSON.parse(fs.readFileSync(path.join(corpusDir, 'corpus.json'), 'utf8')) as CorpusEntry[];
    const versions = new Set(list.map((e) => e.version));
    // The corpus holds the version before the current one and the current one.
    expect(versions.has(CODEC_VERSION - 1)).toBe(true);
    expect(versions.has(CODEC_VERSION)).toBe(true);
    for (const e of list) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(corpusDir, e.file)));
      expect(bytes.length, e.file).toBe(e.bytes);
      const { vessel, report } = decode(bytes);
      expect(report.version, e.file).toBe(e.version);
      expect(report.defsHash, e.file).toBe(e.defsHash);
      expect(report.migrated, `${e.file}: a part definition changed since this blob was written; the change needs an entry in src/sim/vessel/migrations`).toEqual([]);
      expect(vessel.parts.length, e.file).toBe(e.parts);
      expect(stateHash(vessel), e.file).toBe(e.stateHash);
    }
  });

  it('a blob written by the version before flies on exactly as the vessel it was written from', () => {
    const scene = buildScene(defs, 'lander-touchdown-60');
    const old = new Uint8Array(fs.readFileSync(path.join(corpusDir, `lander-touchdown-60.v${CODEC_VERSION - 1}.bin`)));
    expect(readHeader(old).version).toBe(CODEC_VERSION - 1);
    const { vessel: loaded } = decode(old);
    expect(stateHash(loaded)).toBe(stateHash(scene.vessel));
    // The friction anchors of the feet on the slope came through the old layout.
    expect(loaded.carried!.probes.filter((p) => p.hasAnchor).length).toBeGreaterThan(0);
    expect(loaded.carried).toEqual(scene.vessel.carried);
    flyOn(scene, scene.vessel, scene.env(), 6000);
    flyOn(scene, loaded, scene.env(), 6000);
    expect(stateHash(loaded)).toBe(stateHash(scene.vessel));
  });

  it('a version this build does not read is refused by name', () => {
    const bytes = encode(buildScene(defs, 'coasting').vessel);
    const future = bytes.slice();
    future[4] = 77;
    expect(() => decode(future)).toThrow(/codec version 77 is not one this build reads/);
    expect(() => decode(bytes.slice(0, 3))).toThrow(VesselDecodeError);
    const noMagic = bytes.slice();
    noMagic[0] = 0;
    expect(() => decode(noMagic)).toThrow(/not a vessel blob/);
    expect(() => decode(bytes.slice(0, bytes.length - 40))).toThrow(/the data ends inside a value/);
  });
});

describe('definitions that changed since the blob was written', () => {
  /** The library with the descent stage's first tank made smaller and a light added to the capsule. */
  function changedLibrary(): { lib: DefLibrary; stage: PartDef; capsule: PartDef } {
    const oldStage = defs.parts['heron-descent-stage']!;
    const oldCapsule = defs.parts['kestrel-capsule']!;
    const stage: PartDef = { ...oldStage, resources: oldStage.resources!.map((r, k) => (k === 0 ? { ...r, capacity: 1000 } : r)) };
    const light = oldCapsule.modules.find((m) => m.type === 'light')!;
    const capsule: PartDef = { ...oldCapsule, modules: [...oldCapsule.modules, light] };
    return { lib: { ...defs, parts: { ...defs.parts, [stage.id]: stage, [capsule.id]: capsule } }, stage, capsule };
  }

  it('a tank resized and a module added decode through the registry: amounts clamped, the new module neutral, mass recomputed', () => {
    const scene = buildScene(defs, 'lander-touchdown-150');
    const original = scene.vessel;
    const bytes = encode(original);
    const { lib, stage, capsule } = changedLibrary();
    const oldStage = defs.parts['heron-descent-stage']!;
    const oldCapsule = defs.parts['kestrel-capsule']!;
    expect(partFingerprint(stage)).not.toBe(partFingerprint(oldStage));
    expect(partFingerprint(capsule)).not.toBe(partFingerprint(oldCapsule));

    // Without an entry in the registry the blob is refused, naming the part and both fingerprints.
    expect(() => decode(bytes, lib)).toThrow(new RegExp(`definition "(heron-descent-stage|kestrel-capsule)" was [0-9a-f]{16} when this was written and is [0-9a-f]{16} now`));
    try {
      decode(bytes, lib);
    } catch (e) {
      expect(e).toBeInstanceOf(VesselDecodeError);
      expect((e as VesselDecodeError).problem).toBe('fingerprint');
    }

    const migrations = new MigrationRegistry([
      { defId: stage.id, from: partFingerprint(oldStage), to: partFingerprint(stage), describe: 'first tank resized to 1,000 kg', migrate: (saved, def) => fitResources(saved, def) },
      { defId: capsule.id, from: partFingerprint(oldCapsule), to: partFingerprint(capsule), describe: 'a second light added', migrate: (saved, def) => insertModule(saved, def, def.modules.length - 1) },
    ]);
    const { vessel: loaded, report } = decodeVessel(bytes, { resolver: libraryResolver(lib), migrations });
    expect(report.migrated.map((m) => [m.part, m.defId, m.steps])).toEqual([
      ['capsule', 'kestrel-capsule', ['a second light added']],
      ['descent-stage', 'heron-descent-stage', ['first tank resized to 1,000 kg']],
    ]);
    const was = original.parts.find((p) => p.instanceId === 'descent-stage')!;
    const now = loaded.parts.find((p) => p.instanceId === 'descent-stage')!;
    expect(was.resources[0]).toBeGreaterThan(1000);
    expect(now.resources[0]).toBe(1000);
    expect(now.resources.slice(1)).toEqual(was.resources.slice(1));
    expect(now.def).toBe(stage);
    const cap = loaded.parts.find((p) => p.instanceId === 'capsule')!;
    expect(cap.modules).toHaveLength(oldCapsule.modules.length + 1);
    expect(cap.modules[cap.modules.length - 1]).toEqual({ type: 'light', on: false });
    expect(cap.modules.slice(0, -1)).toEqual(original.parts.find((p) => p.instanceId === 'capsule')!.modules);
    // Mass properties are those of the migrated vessel, not the saved ones.
    const mass = loaded.mp.mass;
    expect(mass).toBeLessThan(original.mp.mass - 100);
    computeMassProps(loaded);
    expect(loaded.mp.mass).toBe(mass);
    // Everything else is the saved state, and the vessel flies on.
    expect(loaded.r).toEqual(original.r);
    expect(loaded.q).toEqual(original.q);
    expect(loaded.hold).toBe(original.hold);
    flyOn(scene, loaded, scene.env(), 600);
    expect(loaded.destroyed).toBe(false);
    expect(Number.isFinite(loaded.r.x + loaded.v.x + loaded.q.w)).toBe(true);
  });

  it('a chain of two migrations is run in order; a gap in the chain is a refusal', () => {
    const scene = buildScene(defs, 'coasting');
    const bytes = encode(scene.vessel);
    const old = defs.parts['heron-ascent-stage']!;
    const mid: PartDef = { ...old, resources: old.resources!.map((r, k) => (k === 0 ? { ...r, capacity: 5000 } : r)) };
    const last: PartDef = { ...old, resources: old.resources!.map((r, k) => (k === 0 ? { ...r, capacity: 300 } : r)) };
    const lib: DefLibrary = { ...defs, parts: { ...defs.parts, [last.id]: last } };
    const steps = [
      { defId: old.id, from: partFingerprint(old), to: partFingerprint(mid), describe: 'tank to 5,000 kg', migrate: fitResources },
      { defId: old.id, from: partFingerprint(mid), to: partFingerprint(last), describe: 'tank to 300 kg', migrate: fitResources },
    ];
    const { vessel, report } = decodeVessel(bytes, { resolver: libraryResolver(lib), migrations: new MigrationRegistry(steps) });
    expect(report.migrated[0]!.steps).toEqual(['tank to 5,000 kg', 'tank to 300 kg']);
    expect(vessel.parts.find((p) => p.def === last)!.resources[0]).toBe(300);
    expect(() => decodeVessel(bytes, { resolver: libraryResolver(lib), migrations: new MigrationRegistry([steps[0]!]) })).toThrow(/holds no way from one to the other/);
    expect(() => new MigrationRegistry([steps[0]!, { ...steps[1]!, from: steps[0]!.from }])).toThrow(/two migrations/);
  });

  it('a part or a vehicle the resolver does not know is refused by name; a vehicle whose content changed is reported', () => {
    const scene = buildScene(defs, 'coasting');
    const bytes = encode(scene.vessel);
    const { [scene.vessel.parts[0]!.def.id]: _gone, ...parts } = defs.parts;
    expect(() => decode(bytes, { ...defs, parts })).toThrow(/part definition "kestrel-capsule" is not known/);
    const { [scene.vessel.crafts[0]!.vehicleId]: _vehicle, ...vehicles } = defs.vehicles;
    expect(() => decode(bytes, { ...defs, vehicles })).toThrow(/vehicle "meridian-lunar" \(content [0-9a-f]{16}\) is not known/);
    const renamed = { ...defs.vehicles['meridian-lunar']!, name: 'Meridian (renamed)' };
    const { report } = decode(bytes, { ...defs, vehicles: { ...defs.vehicles, 'meridian-lunar': renamed } });
    expect(report.vehicleChanged).toHaveLength(1);
    expect(report.vehicleChanged[0]).toMatchObject({ craftId: 'meridian-lunar', vehicleId: 'meridian-lunar' });
  });
});

describe('blocks', () => {
  /** The blob with a block of tag 99 added before the end of the body. */
  function withExtraBlock(bytes: Uint8Array, payload: number[]): Uint8Array {
    expect(bytes[bytes.length - 1]).toBe(0);
    const out = new Uint8Array(bytes.length + 2 + payload.length);
    out.set(bytes.subarray(0, bytes.length - 1));
    out.set([99, payload.length, ...payload, 0], bytes.length - 1);
    return out;
  }

  it('a block this build does not know is reported and skipped, not mis-read', () => {
    const v = buildScene(defs, 'lander-touchdown-60').vessel;
    const bytes = encode(v);
    const { vessel, report } = decode(withExtraBlock(bytes, [1, 2, 3, 4, 5, 6, 7]));
    expect(report.unknownBlocks).toEqual([99]);
    expect(stateHash(vessel)).toBe(stateHash(v));
  });

  it('a module block that does not fit the definition is an error naming the part and the module', () => {
    const v = buildScene(defs, 'coasting').vessel;
    const bytes = encode(v);
    // The same blob read against a capsule whose first two modules changed places (same fingerprint would be
    // a new one in a real change; here the registry is told the layouts are the same, so the block check must catch it).
    const old = defs.parts['kestrel-capsule']!;
    const swapped: PartDef = { ...old, modules: [old.modules[1]!, old.modules[0]!, ...old.modules.slice(2)] };
    const lib: DefLibrary = { ...defs, parts: { ...defs.parts, [old.id]: swapped } };
    const lie = new MigrationRegistry([{ defId: old.id, from: partFingerprint(old), to: partFingerprint(swapped), describe: 'claims nothing moved', migrate: (saved) => saved }]);
    expect(() => decodeVessel(bytes, { resolver: libraryResolver(lib), migrations: lie })).toThrow(/part "capsule" \(kestrel-capsule\): the block of module 0 is a "command" state that does not fit the definition's "heatShield" module/);
  });
});

describe('embedded designs and assemblies', () => {
  it('a design that is not in the library travels inside the blob', () => {
    const custom = dockingLibrary(defs);
    const v = ferry(custom, 'ferry-x');
    v.r = { x: 0, y: 6771000, z: 0 };
    v.v = { x: 7670, y: 0, z: 0 };
    // The reader has the parts (the port included) but not the vehicle.
    const reader: DefLibrary = { ...defs, parts: custom.parts };
    expect(reader.vehicles['test-ferry']).toBeUndefined();
    const bytes = encodeVessel(v, { defsHash: 'h', refs: libraryResolver(reader) });
    const { vessel: loaded, report } = decodeVessel(bytes, { resolver: libraryResolver(reader) });
    expect(report.vehicleChanged).toEqual([]);
    expect(loaded.crafts[0]!.vehicle).not.toBe(v.crafts[0]!.vehicle);
    expect(loaded.crafts[0]!.vehicle).toEqual(custom.vehicles['test-ferry']);
    expect(stateHash(loaded, libraryResolver(reader))).toBe(stateHash(v, libraryResolver(reader)));
    // A library that has the design writes a reference instead: a smaller blob.
    expect(encodeVessel(v, { defsHash: 'h', refs: libraryResolver(custom) }).length).toBeLessThan(bytes.length - 500);
    // The embedded craft stages as the original does.
    expect(loaded.crafts[0]!.vehicle.stages.map((s) => s.label)).toEqual(['Engine', 'Service module']);
  });

  it('an assembly round-trips: craft, owners, links, the helm, per-craft stage state', () => {
    const lib = dockingLibrary(defs);
    const a = ferry(lib, 'ferry-a');
    const b = ferry(lib, 'ferry-b');
    a.r = { x: 0, y: 6771000, z: 0 };
    mate(a, partIndex(a, 'ferry-a/port'), b, partIndex(b, 'ferry-b/port'), 0.3);
    a.v = b.v = { x: 7670, y: 0, z: 0 };
    dockMerge(a, b, partIndex(a, 'ferry-a/port'), partIndex(b, 'ferry-b/port'), 4321);
    a.crafts[1]!.nextStage = 1;
    a.crafts[1]!.policy = { lendAttitude: false, lendEngines: true, lendPropellant: false, helm: ['acct-1', 'acct-2'] };
    a.helm = { accountId: 'acct-1', craft: 1, controlPart: partIndex(a, 'ferry-b/capsule') };
    const bytes = encodeVessel(a, { defsHash: 'h', refs: libraryResolver(lib) });
    const { vessel: loaded } = decodeVessel(bytes, { resolver: libraryResolver(lib) });
    expect(loaded.id).toBe('a~ferry-a~4321');
    expect(loaded.crafts.map((c) => [c.craftId, c.ownerId, c.joinedTick, c.nextStage])).toEqual([
      ['ferry-a', 'owner-of-ferry-a', 0, 0],
      ['ferry-b', 'owner-of-ferry-b', 4321, 1],
    ]);
    expect(loaded.crafts[1]!.policy).toEqual(a.crafts[1]!.policy);
    expect(loaded.links).toEqual(a.links);
    expect(loaded.helm).toEqual(a.helm);
    expect(loaded.parts.map((p) => [p.instanceId, p.craft, p.parent])).toEqual(a.parts.map((p) => [p.instanceId, p.craft, p.parent]));
    expect(stateHash(loaded)).toBe(stateHash(a));
  });
});

describe('the cheap copy for a rollback ring', () => {
  it('a capture put back gives the flight that followed it again, bit for bit, without rebuilding the structure', () => {
    for (const name of ['lander-touchdown-60', 'capsule-peak-heating', 'stack-ascent'] as const) {
      const scene = buildScene(defs, name);
      const v = scene.vessel;
      const capture = captureVessel(v);
      const at = stateHash(v);
      const struct = structureOf(v);
      flyOn(scene, v, scene.env(), 300);
      const later = stateHash(v);
      expect(later).not.toBe(at);
      restoreVessel(v, capture);
      expect(stateHash(v), name).toBe(at);
      expect(v.struct, `${name}: the structure cache is kept`).toBe(struct);
      flyOn(scene, v, scene.env(), 300);
      expect(stateHash(v), name).toBe(later);
      // The capture is not consumed.
      restoreVessel(v, capture);
      expect(stateHash(v), name).toBe(at);
    }
  });

  it('a capture from before a staging brings the dropped parts back', () => {
    const scene = buildScene(defs, 'stack-mid-staging');
    const v = scene.vessel;
    const capture = captureVessel(v);
    const at = stateHash(v);
    const parts = v.parts.length;
    const shed = flyOn(scene, v, scene.env(), 600);
    expect(shed).toBeGreaterThan(0);
    expect(v.parts.length).toBeLessThan(parts);
    const later = stateHash(v);
    restoreVessel(v, capture);
    expect(v.parts).toHaveLength(parts);
    expect(stateHash(v)).toBe(at);
    flyOn(scene, v, scene.env(), 600);
    expect(stateHash(v)).toBe(later);
  });
});
