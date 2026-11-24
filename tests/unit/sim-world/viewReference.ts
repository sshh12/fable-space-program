/**
 * The snapshot reference of the wave-3 World (island-core acceptance: "SimSnapshot from the view equals
 * the wave-3 World's on 200 recorded states").
 *
 * A scripted drive of nine scenarios (the pad of `lunar-direct` and the eight QA captures of the nominal
 * flight) on a flat terrain: thrust, staging, a target, a maneuver node, SAS modes, a frame loop with a
 * fractional frame time (presentation interpolation), rails warp and a rails advance. At 200 states the
 * snapshot is reduced to one hash per BLOCK (numbers by their float64 bits), so a difference names the
 * state and the block. `viewReference.json` was recorded once from the World as it stood at the tag
 * `post-tighten-2026-11-24`, before island-core changed anything (`viewReference.record.ts`).
 */
import type { ControlInputs } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import { StateHasher } from '@/sim/world/stateHash';
import { flatTerrain, makeSim } from './helpers';

export const VIEW_SCENARIOS = ['lunar-direct', 'qa-leo', 'qa-translunar', 'qa-lunar-orbit', 'qa-powered-descent', 'qa-lunar-surface', 'qa-trans-earth', 'qa-entry', 'qa-drogues'] as const;

/** The blocks a state is reduced to, in the order they are compared. */
export const VIEW_BLOCKS = ['clock', 'frame', 'session', 'bodies', 'activeVessel', 'otherVessels', 'controls', 'navball', 'readouts', 'staging', 'patches', 'nodes', 'events', 'milestones'] as const;
export type ViewBlock = (typeof VIEW_BLOCKS)[number];

export interface ViewSample {
  scenario: string;
  /** What the drive had just done. */
  at: string;
  /** 'peek' = the state at the simulation time; 'snapshot' = the presentation snapshot (drains the events). */
  kind: 'peek' | 'snapshot';
  myTick: number;
  vessels: number;
  blocks: Record<ViewBlock, string>;
}

export interface ViewReference {
  note: string;
  samples: ViewSample[];
}

const hashOf = (x: unknown): string => {
  const h = new StateHasher();
  h.any(x);
  return h.hex();
};

/** Events without regard to their order among vessels: sorted by (ut, vessel, type), each hashed whole. */
function eventKeys(s: SimSnapshot): string[] {
  return s.events.map((e) => `${e.ut}|${e.vesselId}|${e.type}|${hashOf(e)}`).sort();
}

export function blocksOf(s: SimSnapshot): Record<ViewBlock, string> {
  const active = s.vessels.find((v) => v.id === s.activeVesselId) ?? null;
  const others = s.vessels.filter((v) => v.id !== s.activeVesselId).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    clock: hashOf([s.ut, s.simUt, s.revision, s.time, s.warp]),
    frame: hashOf(s.frame),
    session: hashOf([s.scenario, s.surfaceTargets, s.terrain, s.mission, s.cheatCounter, s.starId, s.activeVesselId]),
    bodies: hashOf(s.bodies),
    activeVessel: hashOf(active),
    otherVessels: hashOf(others),
    controls: hashOf(s.appliedControls),
    navball: hashOf(s.navball),
    readouts: hashOf(s.readouts),
    staging: hashOf(s.staging),
    patches: hashOf(s.patches),
    nodes: hashOf(s.nodes),
    events: hashOf(eventKeys(s)),
    milestones: hashOf(s.milestones),
  };
}

const controls = (c: Partial<ControlInputs> = {}): ControlInputs => ({ pitch: 0, yaw: 0, roll: 0, translate: { x: 0, y: 0, z: 0 }, throttle: 0, ...c });

/** Samples per scenario; the first scenario takes `extra` more, so that the whole drive has exactly 200. */
const PER_SCENARIO = 22;
const EXTRA_FIRST = 2;

/** Drive one scenario and return its samples. Every call does the same thing: the drive has no input but the library. */
export async function driveScenario(defs: DefLibrary, scenarioId: string, extra: number): Promise<ViewSample[]> {
  const sim = await makeSim(defs, scenarioId, flatTerrain(defs));
  const out: ViewSample[] = [];
  const take = (at: string, kind: 'peek' | 'snapshot'): void => {
    const s = kind === 'peek' ? sim.peek() : sim.snapshot();
    out.push({ scenario: scenarioId, at, kind, myTick: s.time.myTick, vessels: s.vessels.length, blocks: blocksOf(s) });
  };
  const steps = (n: number): void => {
    for (let i = 0; i < n; i++) sim.step();
  };
  const start = sim.peek();
  const bodyId = start.vessels.find((v) => v.id === start.activeVesselId)!.bodyId;
  const otherBody = start.bodies.find((b) => b.id !== bodyId && b.id !== start.starId)?.id ?? null;

  take('start', 'peek'); // 1
  // A frame loop with a frame time that is not a whole number of steps: presentation interpolation.
  sim.commands.setSasEnabled(true);
  sim.setControls(controls({ throttle: 1, pitch: 0.2 }));
  for (let k = 0; k < 4; k++) {
    sim.advance(1 / 60 + 0.003);
    take(`frame ${k}`, 'snapshot'); // 2-5
  }
  sim.commands.stage();
  take('staged', 'peek'); // 6
  steps(30);
  take('staged + 30', 'peek'); // 7
  for (let k = 0; k < 3; k++) {
    sim.advance(0.02);
    take(`after staging, frame ${k}`, 'snapshot'); // 8-10
  }
  // Planning: a target, a node, the maneuver hold.
  if (otherBody) sim.commands.setTarget({ kind: 'body', id: otherBody });
  const node = sim.commands.addNode(sim.peek().simUt + 900);
  sim.commands.setNode(node, { dv: { prograde: 35, normal: -4, radial: 2 } });
  sim.commands.setSasMode('maneuver');
  sim.setControls(controls({ throttle: 0.4, roll: -0.3, translate: { x: 0.5, y: 0, z: -0.5 } }));
  sim.commands.setRcsEnabled(true);
  steps(48);
  take('node, maneuver hold, thrust', 'peek'); // 11
  sim.commands.setSasMode('retrograde');
  sim.commands.setNavballMode('orbit');
  sim.commands.toggleLegs();
  sim.commands.toggleLights();
  steps(36);
  take('retrograde hold', 'peek'); // 12
  // Coast: controls released, then time warp in the frame loop and a rails advance.
  sim.setControls(controls());
  sim.commands.setSasMode('stability');
  steps(240);
  take('coast', 'peek'); // 13
  sim.commands.setWarpLevel(2);
  sim.advance(0.05);
  take('physics warp', 'snapshot'); // 14
  sim.commands.setWarpLevel(6);
  for (let k = 0; k < 3; k++) {
    sim.advance(0.05);
    take(`warp frame ${k}`, 'snapshot'); // 15-17
  }
  sim.advanceRails(sim.peek().simUt + 1800);
  take('rails advance', 'peek'); // 18
  sim.commands.setWarpLevel(0);
  sim.commands.removeNode(node);
  sim.commands.stage();
  steps(12);
  take('second staging', 'peek'); // 19
  sim.commands.cycleActiveVessel(1);
  steps(60);
  take('after cycle', 'snapshot'); // 20
  sim.setControls(controls({ throttle: 1 }));
  steps(120);
  take('thrust again', 'peek'); // 21
  sim.advance(0.031);
  take('last frame', 'snapshot'); // 22
  for (let k = 0; k < extra; k++) {
    steps(600);
    take(`extra ${k}`, 'peek');
  }
  if (out.length !== PER_SCENARIO + extra) throw new Error(`viewReference: the drive of ${scenarioId} took ${out.length} samples`);
  return out;
}

export async function driveAll(defs: DefLibrary): Promise<ViewSample[]> {
  const out: ViewSample[] = [];
  for (let i = 0; i < VIEW_SCENARIOS.length; i++) out.push(...(await driveScenario(defs, VIEW_SCENARIOS[i]!, i === 0 ? EXTRA_FIRST : 0)));
  return out;
}

/** The first difference between two recordings in words, or null when they are equal. `skip` leaves blocks out. */
export function firstDifference(expected: readonly ViewSample[], got: readonly ViewSample[], skip: readonly ViewBlock[] = []): string | null {
  if (expected.length !== got.length) return `${got.length} samples, expected ${expected.length}`;
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]!;
    const g = got[i]!;
    const where = `sample ${i} (${e.scenario}, ${e.at}, ${e.kind})`;
    if (e.myTick !== g.myTick) return `${where}: tick ${g.myTick}, expected ${e.myTick}`;
    for (const b of VIEW_BLOCKS) {
      if (skip.includes(b)) continue;
      if (e.blocks[b] !== g.blocks[b]) return `${where}: block "${b}" differs`;
    }
    if (!skip.includes('otherVessels') && e.vessels !== g.vessels) return `${where}: ${g.vessels} vessels, expected ${e.vessels}`;
  }
  return null;
}
