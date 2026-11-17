/**
 * What the snapshot states so that the presentation reads no vehicle definition by a runtime id and takes
 * no id apart (requests presentation-sweep-2 and -3):
 *   PartSnapshot.panel                       the petal of a jettisoned fairing, as a field
 *   StageInfo.burnLabel, thrustVac, weightFlowVac, actionChutes, chuteEnvelopes
 *   CraftSnapshot.cockpit.crew               the crew by seat
 * They are derived when the snapshot is built, from the definitions the craft was built from. The values must
 * be, to the letter and to the bit, what the flight HUD computed from the vehicle's file before these fields
 * existed: the reference below is that computation (src/ui/model.ts of 2026-11-16: stageBurnLabel,
 * stageActionWords, stageAcceleration, describeChuteEnvelope), written out here against the definitions.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, ParachuteEnvelope, VehicleDef } from '@/core/contracts/defs';
import { describeStages } from '@/core/defs/stageWords';
import { assembleVessel, craftSnapshots, encodeVessel, libraryResolver, splitForStage, stagingInfo, stateHash, vesselPartSnapshots } from '@/sim/vessel';
import { loadLibrary, makeEnv, placeUpright, VEHICLE } from './helpers';

let lib: DefLibrary;
let vehicle: VehicleDef;
beforeAll(async () => {
  lib = await loadLibrary();
  vehicle = lib.vehicles[VEHICLE]!;
});

// ------------------------------------------------------------------ the HUD's computation, as the reference

function hudBurnLabel(index: number): string | null {
  const stage = vehicle.stages[index]!;
  const groups: string[] = [];
  for (const a of stage.actions) {
    if (a.kind !== 'igniteEngines') continue;
    for (const id of a.parts) {
      const g = vehicle.parts.find((p) => p.id === id)?.stageGroup;
      if (g !== undefined && !groups.includes(g)) groups.push(g);
    }
  }
  if (groups.length === 0) return null;
  return groups.map((g) => vehicle.stageGroups.find((x) => x.id === g)?.label ?? g).join(' + ');
}

const ACTION_WORDS: Record<string, string> = {
  igniteengines: 'ignite', shutdownengines: 'shut down', decouple: 'separate', fireseparationmotors: 'sep. motors', jettisonfairing: 'jettison fairing',
  jettisonles: 'jettison tower', deployparachute: 'deploy chute', cutparachute: 'cut chute', deploylegs: 'deploy gear', releaseclamps: 'release clamps', enablercs: 'RCS on',
};
const CHUTE_NAMES = { drogue: 'drogues', main: 'mains' } as const;

/** The words of a stage as the HUD made them from the vehicle's file. */
function hudActionWords(index: number): string {
  const stage = vehicle.stages[index]!;
  let deployed: 'drogue' | 'main' | null = null;
  for (let i = 0; i < index; i++) for (const a of vehicle.stages[i]!.actions) if (a.kind === 'deployParachute') deployed = a.mode;
  const words: string[] = [];
  for (const a of stage.actions) {
    let w: string | undefined;
    if (a.kind === 'deployParachute') w = `deploy ${CHUTE_NAMES[a.mode]}`;
    else if (a.kind === 'cutParachute') w = deployed ? `release ${CHUTE_NAMES[deployed]}` : ACTION_WORDS.cutparachute;
    else w = ACTION_WORDS[a.kind.toLowerCase()];
    if (w !== undefined && !words.includes(w)) words.push(w);
    if (a.kind === 'deployParachute') deployed = a.mode;
  }
  return words.join(' · ');
}

/** The same words from the snapshot's fields alone: what a consumer writes now. */
function wordsFromSnapshot(actionKinds: readonly string[], actionChutes: readonly ('drogue' | 'main' | null)[]): string {
  const words: string[] = [];
  actionKinds.forEach((kind, i) => {
    const chute = actionChutes[i] ?? null;
    let w: string | undefined;
    if (kind === 'deployParachute') w = chute ? `deploy ${CHUTE_NAMES[chute]}` : ACTION_WORDS.deployparachute;
    else if (kind === 'cutParachute') w = chute ? `release ${CHUTE_NAMES[chute]}` : ACTION_WORDS.cutparachute;
    else w = ACTION_WORDS[kind.toLowerCase()];
    if (w !== undefined && !words.includes(w)) words.push(w);
  });
  return words.join(' · ');
}

/** Thrust and the sum of thrust / Isp of the engines a stage ignites, in the HUD's order of summation. */
function hudEngineSums(index: number): { thrust: number; flow: number } {
  let thrust = 0;
  let flow = 0;
  for (const a of vehicle.stages[index]!.actions) {
    if (a.kind !== 'igniteEngines') continue;
    for (const id of a.parts) {
      const def = lib.parts[vehicle.parts.find((p) => p.id === id)?.def ?? ''];
      for (const m of def?.modules ?? []) {
        if (m.type !== 'engine' || m.fixedBurn || !(m.ispVac > 0)) continue;
        thrust += m.thrustVac;
        flow += m.thrustVac / m.ispVac;
      }
    }
  }
  return { thrust, flow };
}

/** The chute a stage deploys first and its envelopes, as the HUD's envelope row read them. */
function hudChute(index: number): { mode: 'drogue' | 'main'; safe: ParachuteEnvelope; destroy: ParachuteEnvelope } | null {
  for (const a of vehicle.stages[index]!.actions) {
    if (a.kind !== 'deployParachute') continue;
    const partDef = lib.parts[vehicle.parts.find((p) => a.parts.includes(p.id))?.def ?? ''];
    const md = partDef?.modules.find((m) => m.type === 'parachute' && m.mode === a.mode);
    return md?.type === 'parachute' ? { mode: a.mode, safe: md.safe, destroy: md.destroy } : null;
  }
  return null;
}

// ----------------------------------------------------------------------------------------------- the tests

describe('StageInfo states what a stage burns and what its chute actions do', () => {
  it('for every stage of the vehicle: the HUD\'s words and sums, to the letter and to the bit', () => {
    const v = assembleVessel(lib, VEHICLE, { craft: { craftId: 'c1' } });
    const env = makeEnv();
    placeUpright(v, env, 120);
    const infos = stagingInfo(v, env);
    expect(infos).toHaveLength(vehicle.stages.length);
    infos.forEach((info, i) => {
      const where = `stage ${i} (${info.label})`;
      expect(info.burnLabel, where).toBe(hudBurnLabel(i));
      expect(info.actionChutes, where).toHaveLength(info.actionKinds.length);
      expect(wordsFromSnapshot(info.actionKinds, info.actionChutes!), where).toBe(hudActionWords(i));
      const sums = hudEngineSums(i);
      // Object.is: the same sum in the same order, not a number that is merely close.
      expect(Object.is(info.thrustVac, sums.thrust), `${where}: thrust ${info.thrustVac} against ${sums.thrust}`).toBe(true);
      expect(Object.is(info.weightFlowVac, sums.flow), `${where}: weight flow ${info.weightFlowVac} against ${sums.flow}`).toBe(true);
      const chute = hudChute(i);
      expect(info.chuteEnvelopes ?? null, where).toEqual(chute ? { safe: chute.safe, destroy: chute.destroy } : null);
    });
  });

  it('says for the lunar stack what the reference images show', () => {
    const v = assembleVessel(lib, VEHICLE, { craft: { craftId: 'c1' } });
    const env = makeEnv();
    placeUpright(v, env, 120);
    const infos = stagingInfo(v, env);
    const byLabel = (label: string): (typeof infos)[number] => infos.find((s) => s.label === label)!;
    // The tile of the stage that burns is titled with what it burns (`sweep-hud-leo`: "Meridian M-3").
    expect(byLabel('M-2 separation').burnLabel).toBe('Meridian M-3');
    expect(byLabel('M-3 separation').burnLabel).toBe('Heron descent stage');
    expect(byLabel('Lunar lift-off').burnLabel).toBe('Heron ascent stage');
    expect(byLabel('Landing gear').burnLabel).toBeNull();
    expect(byLabel('Capsule separation').burnLabel).toBeNull();
    // The two chute stages.
    const drogues = byLabel('Drogues');
    const mains = byLabel('Mains');
    expect(drogues.actionKinds).toEqual(['decouple', 'deployParachute']);
    expect(drogues.actionChutes).toEqual([null, 'drogue']);
    expect(wordsFromSnapshot(drogues.actionKinds, drogues.actionChutes!)).toBe('separate · deploy drogues');
    expect(mains.actionKinds).toEqual(['cutParachute', 'deployParachute']);
    expect(mains.actionChutes).toEqual(['drogue', 'main']);
    expect(wordsFromSnapshot(mains.actionKinds, mains.actionChutes!)).toBe('release drogues · deploy mains');
    expect(drogues.chuteEnvelopes).not.toBeNull();
    expect(mains.chuteEnvelopes).not.toBeNull();
    expect(drogues.chuteEnvelopes).not.toEqual(mains.chuteEnvelopes);
    // A stage with engines has a thrust and a weight flow; the acceleration formula gives a finite figure.
    const m3 = byLabel('M-2 separation');
    expect(m3.thrustVac!).toBeGreaterThan(0);
    expect(m3.weightFlowVac!).toBeGreaterThan(0);
    const ve = (9.80665 * m3.thrustVac!) / m3.weightFlowVac!;
    expect(ve).toBeGreaterThan(2500);
    expect(ve).toBeLessThan(5000);
    expect(byLabel('Landing gear').thrustVac).toBe(0);
    expect(byLabel('Landing gear').weightFlowVac).toBe(0);
  });

  it('stays what it is as the flight goes on: the words are the definitions\', not the vessel\'s state', () => {
    const fresh = assembleVessel(lib, VEHICLE, { craft: { craftId: 'c1' } });
    const late = assembleVessel(lib, VEHICLE, { stagesAlreadyFired: 6, craft: { craftId: 'c2' } });
    const env = makeEnv();
    placeUpright(fresh, env, 120);
    placeUpright(late, env, 120);
    const words = (v: typeof fresh): unknown[] => stagingInfo(v, env).map((s) => [s.burnLabel, s.thrustVac, s.weightFlowVac, s.actionChutes, s.chuteEnvelopes]);
    // Six stages fired and their parts gone: every stage still says what it said on the pad.
    expect(words(late)).toEqual(words(fresh));
  });

  it('is derived, not state: building the snapshot changes neither the saved bytes nor the state hash', () => {
    const v = assembleVessel(lib, VEHICLE, { craft: { craftId: 'c1' } });
    const env = makeEnv();
    placeUpright(v, env, 120);
    const refs = libraryResolver(lib);
    const before = { hash: stateHash(v), bytes: Array.from(encodeVessel(v, { defsHash: 'test', refs })) };
    stagingInfo(v, env);
    craftSnapshots(v, () => stagingInfo(v, env));
    vesselPartSnapshots(v);
    expect(stateHash(v)).toBe(before.hash);
    expect(Array.from(encodeVessel(v, { defsHash: 'test', refs }))).toEqual(before.bytes);
  });
});

describe('describeStages, the one derivation for every producer', () => {
  it('a cut releases what the latest deploy before it put out, and nothing when nothing was deployed', () => {
    const design: VehicleDef = {
      ...vehicle,
      stages: [
        { label: 'Cut first', icon: 'chute', actions: [{ kind: 'cutParachute', parts: [] }] },
        { label: 'Both', icon: 'chute', actions: [{ kind: 'deployParachute', parts: [], mode: 'drogue' }, { kind: 'cutParachute', parts: [] }, { kind: 'deployParachute', parts: [], mode: 'main' }] },
        { label: 'Later', icon: 'chute', actions: [{ kind: 'decouple', part: 'none' }, { kind: 'cutParachute', parts: [] }] },
      ],
    };
    const words = describeStages(design, (id) => lib.parts[id]);
    expect(words.map((w) => w.actionChutes)).toEqual([[null], ['drogue', 'drogue', 'main'], [null, 'main']]);
    // No part is named by these deploy actions: there is no parachute to state envelopes of.
    expect(words.map((w) => w.chuteEnvelopes)).toEqual([null, null, null]);
    expect(words.map((w) => [w.burnLabel, w.thrustVac, w.weightFlowVac])).toEqual([[null, 0, 0], [null, 0, 0], [null, 0, 0]]);
  });

  it('gives the same answer from the library and from the simulation\'s snapshot', () => {
    const v = assembleVessel(lib, VEHICLE, { craft: { craftId: 'c1' } });
    const env = makeEnv();
    placeUpright(v, env, 120);
    const fromLibrary = describeStages(vehicle, (id) => lib.parts[id]);
    const infos = stagingInfo(v, env);
    expect(infos.map((s) => ({ burnLabel: s.burnLabel, thrustVac: s.thrustVac, weightFlowVac: s.weightFlowVac, actionChutes: s.actionChutes, chuteEnvelopes: s.chuteEnvelopes }))).toEqual(fromLibrary);
  });
});

describe('CraftSnapshot.cockpit.crew', () => {
  it('is the crew of the vehicle the craft was built from, by seat', () => {
    const v = assembleVessel(lib, VEHICLE, { craft: { craftId: 'c1' } });
    const [craft] = craftSnapshots(v);
    expect(vehicle.crew.length).toBeGreaterThan(0);
    expect(craft!.cockpit!.crew).toEqual(vehicle.crew.map((m) => ({ seat: m.seat, name: m.name })));
    // Copies: a consumer that changes the list changes nothing of the definition.
    craft!.cockpit!.crew![0]!.name = 'changed';
    expect(craftSnapshots(v)[0]!.cockpit!.crew![0]!.name).toBe(vehicle.crew[0]!.name);
  });
});

describe('PartSnapshot.panel', () => {
  it('is null for every part of the stack', () => {
    const v = assembleVessel(lib, VEHICLE, { craft: { craftId: 'c1' } });
    for (const p of vesselPartSnapshots(v)) expect(p.panel, p.instanceId).toBeNull();
  });

  it('states the petal of a jettisoned fairing: which one, of how many, of which fairing', () => {
    const fairingStage = vehicle.stages.findIndex((s) => s.actions.some((a) => a.kind === 'jettisonFairing'));
    expect(fairingStage).toBeGreaterThanOrEqual(0);
    const v = assembleVessel(lib, VEHICLE, { stagesAlreadyFired: fairingStage, craft: { craftId: 'c1' } });
    // The fairings that stage jettisons, by the instance ids its actions name.
    const named = vehicle.stages[fairingStage]!.actions.flatMap((a) => (a.kind === 'jettisonFairing' ? [a.part] : []));
    const fairings = vesselPartSnapshots(v).filter((p) => named.includes(p.instanceId));
    expect(fairings).toHaveLength(named.length);
    expect(fairings.length).toBeGreaterThan(0);
    const { vessel: after, spawned } = splitForStage(lib, v, fairingStage);
    const petals = spawned.flatMap((s) => vesselPartSnapshots(s).map((part) => ({ part, vessel: s }))).filter((x) => x.part.panel != null);
    expect(petals.length).toBeGreaterThanOrEqual(2);
    for (const fairing of fairings) {
      const mine = petals.filter((x) => x.part.panel!.of === fairing.instanceId);
      expect(mine.length, fairing.instanceId).toBeGreaterThanOrEqual(2);
      // Sectors 0 .. count - 1, each once, every one a vessel of one part whose craft left the stack's craft.
      expect(mine.map((x) => x.part.panel!.index).sort((a, b) => a - b), fairing.instanceId).toEqual(mine.map((_, k) => k));
      for (const x of mine) {
        expect(x.part.panel!.count).toBe(mine.length);
        expect(x.part.def).toBe(fairing.def);
        expect(x.vessel.parts).toHaveLength(1);
        expect(craftSnapshots(x.vessel)[0]!.parent).toBe('c1');
      }
    }
    // Every petal belongs to one of the fairings, and nothing that stayed on the stack is a petal.
    expect(petals.every((x) => fairings.some((f) => f.instanceId === x.part.panel!.of))).toBe(true);
    for (const p of vesselPartSnapshots(after)) expect(p.panel, p.instanceId).toBeNull();
  });
});
