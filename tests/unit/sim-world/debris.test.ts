/**
 * The vessel list beyond the flown stack: the age of every vessel in every tier, small-fragment expiry,
 * the debris cap (oldest first) and cycling between controllable vessels.
 *
 * The mission vehicle sheds no piece under 50 kg, never more than a dozen pieces and only one crewed
 * vessel, so these rules are driven with small test vehicles built from real part definitions: a capsule
 * that carries rings of jettisonable covers, and two capsules joined by a separator. The active vessel is
 * moved out of the physics bubble with the debug API (these are tests of the world's rules, not flights).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, PartDef, ScenarioDef, VehicleDef, VehiclePartPlacement } from '@/core/contracts/defs';
import { PHYSICS_DT } from '@/core/contracts/defs';
import type { Sim, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import type { SimWorld } from '@/sim';
import { BUBBLE_EXIT_RADIUS, FRAGMENT_LIFETIME, FRAGMENT_MASS, MAX_DEBRIS } from '@/sim/world/sim';
import { active, controls, flatTerrain, loadLibrary, makeSim, orbitScenario } from './helpers';

let defs: DefLibrary;
let terrain: TerrainProvider;
beforeAll(async () => {
  defs = await loadLibrary();
  terrain = flatTerrain(defs, { earth: 21.62, moon: -1900 });
});

const steps = (sim: Sim, seconds: number): void => {
  for (let i = 0; i < Math.round(seconds / PHYSICS_DT); i++) sim.step();
};

const CAPSULE = 'kestrel-capsule';
const COVER = 'kestrel-apex-cover';
/** A cover lighter than the fragment limit (the real one weighs 60 kg). */
const CHIP = 't-chip';

/**
 * A capsule with `batches` of jettisonable pieces round it, one stage per batch. Each piece is a decoupler
 * whose push points away from the capsule; a full ring pushes evenly, so the capsule hardly moves.
 */
function shedVehicle(base: DefLibrary, batches: { def: string; count: number }[]): DefLibrary {
  const mission = base.vehicles[base.scenarios['lunar-direct']!.vehicle]!;
  const chip: PartDef = { ...base.parts[COVER]!, id: CHIP, name: 'Test chip', dryMass: 30, visual: null };
  const parts: VehiclePartPlacement[] = [{ id: 'capsule', def: CAPSULE, parent: null, stageGroup: 'capsule' }];
  const stages: VehicleDef['stages'] = [];
  batches.forEach((b, k) => {
    const ids: string[] = [];
    for (let i = 0; i < b.count; i++) {
      const az = (360 * i) / b.count + 7 * k;
      const a = (az * Math.PI) / 180;
      const id = `piece-${k}-${i}`;
      ids.push(id);
      // rotationDeg [90, az, 0]: the piece's +Y (the direction of its push) turned to +Z, then round the capsule's axis.
      parts.push({ id, def: b.def, parent: 'capsule', position: [3 * Math.sin(a), 0.5 + 0.6 * k, 3 * Math.cos(a)], rotationDeg: [90, az, 0], stageGroup: 'capsule' });
    }
    stages.push({ label: `Shed ${k}`, icon: 'decoupler', actions: ids.map((part) => ({ kind: 'decouple' as const, part })) });
  });
  const vehicle: VehicleDef = { ...mission, id: 't-shed', name: 'Shedding capsule', parts, stageGroups: [{ id: 'capsule', label: 'Capsule' }], stages, abort: [], actionGroups: {}, cockpit: null };
  return { ...base, parts: { ...base.parts, [CHIP]: chip }, vehicles: { ...base.vehicles, [vehicle.id]: vehicle } };
}

/** Two capsules joined by the capsule adapter; the stage button parts them. */
function twinVehicle(base: DefLibrary): DefLibrary {
  const mission = base.vehicles[base.scenarios['lunar-direct']!.vehicle]!;
  const vehicle: VehicleDef = {
    ...mission,
    id: 't-twin',
    name: 'Twin capsules',
    parts: [
      { id: 'capsule-a', def: CAPSULE, parent: null, stageGroup: 'a' },
      { id: 'joint', def: 'heron-capsule-adapter', parent: 'capsule-a', parentNode: 'bottom', node: 'top', stageGroup: 'b' },
      { id: 'capsule-b', def: CAPSULE, parent: 'joint', parentNode: 'bottom', node: 'top', stageGroup: 'b' },
    ],
    stageGroups: [
      { id: 'a', label: 'Capsule A' },
      { id: 'b', label: 'Capsule B' },
    ],
    stages: [{ label: 'Part', icon: 'decoupler', actions: [{ kind: 'decouple', part: 'joint' }] }],
    abort: [],
    actionGroups: {},
    cockpit: null,
  };
  return { ...base, vehicles: { ...base.vehicles, [vehicle.id]: vehicle } };
}

function inOrbit(lib: DefLibrary, vehicle: string, id: string): ScenarioDef {
  return { ...orbitScenario(lib.scenarios['lunar-direct']!, id, 'earth', 300000, 300000, 0), vehicle };
}

/** Move the active vessel `metres` ahead along its orbit (out of the physics bubble of what it left behind). */
function jumpAhead(sim: Sim, metres: number): void {
  const v = active(sim.peek());
  const q = quat.fromAxisAngle(v3.normalize(v3.cross(v.r, v.v)), metres / v3.len(v.r));
  sim.debug.setVesselState(v.id, v.bodyId, quat.rotate(q, v.r), quat.rotate(q, v.v));
}

const others = (s: SimSnapshot): VesselSnapshot[] => s.vessels.filter((v) => v.id !== s.activeVesselId);
const pieceOf = (v: VesselSnapshot): string => v.parts[0]!.instanceId;

describe('vessel age', () => {
  it('is the time the vessel has existed in every tier: stepped, on rails outside the bubble, during rails warp, in the presented frame', async () => {
    const lib = shedVehicle(defs, [{ def: COVER, count: 2 }]);
    const sim = await makeSim(lib, inOrbit(lib, 't-shed', 't-age'), terrain);
    const t0 = sim.peek().simUt;
    expect(active(sim.peek()).age).toBe(0);
    steps(sim, 1);
    expect(sim.commands.stage().ok).toBe(true);
    const born = sim.peek().simUt;
    steps(sim, 3);
    let s = sim.peek();
    expect(others(s)).toHaveLength(2);
    expect(active(s).age).toBeCloseTo(s.simUt - t0, 6);
    for (const d of others(s)) {
      expect(d.tier).toBe('full');
      expect(d.age).toBeCloseTo(3, 6);
    }
    // Out of the bubble the pieces are no longer stepped: their age goes on.
    jumpAhead(sim, 100000);
    steps(sim, 21);
    s = sim.peek();
    for (const d of others(s)) {
      expect(d.tier).toBe('rails');
      expect(d.age).toBeCloseTo(s.simUt - born, 6);
      expect(d.age).toBeCloseTo(24, 6);
    }
    // A rails advance of the whole world.
    const reached = sim.advanceRails(s.simUt + 500);
    expect(reached).toBeCloseTo(s.simUt + 500, 6);
    s = sim.peek();
    for (const d of others(s)) expect(d.age).toBeCloseTo(524, 6);
    expect(active(s).age).toBeCloseTo(s.simUt - t0, 6);
    // The presented frame lies a fraction of a step behind the state: so does the age it shows.
    sim.advance(1 / 144);
    const shown = sim.snapshot();
    expect(shown.simUt - shown.ut).toBeGreaterThan(0);
    for (const d of others(shown)) expect(d.age).toBeCloseTo(shown.ut - born, 6);
    // Moving the clock with the debug API moves no birthday.
    const before = others(sim.peek()).map((d) => d.age);
    sim.debug.setUt(sim.peek().simUt + 1000);
    expect(others(sim.peek()).map((d) => d.age)).toEqual(before);
  });

  it('counts for the pieces left on the ground and for those falling through the air (pad start)', async () => {
    const sim = await makeSim(defs, 'lunar-direct', terrain);
    sim.commands.setSasEnabled(true);
    sim.setControls(controls({ throttle: 1 }));
    sim.commands.stage();
    let released = NaN;
    for (let i = 0; i < 120 * 10 && Number.isNaN(released); i++) {
      sim.step();
      const ev = sim.peek().events.find((e) => e.type === 'clampsReleased');
      if (ev) released = ev.ut;
    }
    expect(Number.isFinite(released)).toBe(true);
    steps(sim, 100);
    const s = sim.peek();
    const clamps = others(s).find((v) => v.parts.some((p) => p.def === 'meridian-launch-clamp'))!;
    // 100 s after lift-off the pad is 27 km and more below: the clamps are a landed vessel outside the bubble.
    expect(clamps.tier).toBe('rails');
    expect(clamps.translationMode).toBe('landed');
    // (The clamps become a vessel of their own in the step that releases them, one step before the event's time.)
    expect(clamps.age).toBeGreaterThan(s.simUt - released - 1e-6);
    expect(clamps.age).toBeLessThan(s.simUt - released + 2 * PHYSICS_DT);
    expect(active(s).age).toBeCloseTo(s.simUt - sim.scenario.startUt, 6);
  });
});

describe('small-fragment expiry', () => {
  it(`an uncontrollable piece under ${FRAGMENT_MASS} kg is removed ${FRAGMENT_LIFETIME} s after it came off, in the bubble or outside it; heavier pieces stay`, async () => {
    for (const leave of [false, true]) {
      const lib = shedVehicle(defs, [
        { def: CHIP, count: 4 },
        { def: COVER, count: 2 },
      ]);
      const sim: SimWorld = await makeSim(lib, inOrbit(lib, 't-shed', 't-expiry'), terrain);
      expect(sim.commands.stage().ok).toBe(true);
      steps(sim, 1);
      expect(sim.commands.stage().ok).toBe(true);
      const born = sim.peek().simUt - 1;
      steps(sim, 4);
      let s = sim.peek();
      expect(others(s)).toHaveLength(6);
      for (const d of others(s)) expect(d.controllable).toBe(false);
      expect(others(s).filter((d) => d.mass < FRAGMENT_MASS)).toHaveLength(4);
      if (leave) {
        jumpAhead(sim, 100000);
        steps(sim, 1);
        for (const d of others(sim.peek())) expect(d.tier).toBe('rails');
      }
      // Just before the lifetime is up every piece is still there...
      steps(sim, born + FRAGMENT_LIFETIME - 0.2 - sim.peek().simUt);
      s = sim.peek();
      expect(others(s)).toHaveLength(6);
      for (const d of others(s).filter((x) => x.mass < FRAGMENT_MASS)) expect(d.age).toBeCloseTo(FRAGMENT_LIFETIME - 0.2, 6);
      // ...and a moment after it the four chips are gone, the two covers are not.
      steps(sim, 0.4);
      s = sim.peek();
      expect(others(s).map(pieceOf).sort()).toEqual(['piece-1-0', 'piece-1-1']);
      for (const d of others(s)) expect(d.age).toBeCloseTo(s.simUt - born - 1, 6);
      const fates = sim.debrisLog();
      expect(fates).toHaveLength(4);
      for (const f of fates) {
        expect(f.reason).toBe('expired');
        // Removed at the first control tick after the lifetime.
        expect(f.ut - born).toBeGreaterThan(FRAGMENT_LIFETIME);
        expect(f.ut - born).toBeLessThan(FRAGMENT_LIFETIME + 5 * PHYSICS_DT);
        expect(s.events.some((e) => e.type === 'vesselRemoved' && e.vesselId === f.vesselId && e.reason === 'expired')).toBe(true);
      }
      // The heavier pieces never expire.
      steps(sim, 120);
      expect(others(sim.peek())).toHaveLength(2);
      expect(sim.peek().mission.failed).toBe(false);
    }
  });
});

describe('debris cap', () => {
  it(`keeps at most ${MAX_DEBRIS} uncontrollable vessels, removing the oldest outside the bubble first`, async () => {
    const lib = shedVehicle(defs, [
      { def: COVER, count: 10 },
      { def: COVER, count: 10 },
      { def: COVER, count: 6 },
    ]);
    const sim: SimWorld = await makeSim(lib, inOrbit(lib, 't-shed', 't-cap'), terrain);
    // First batch, left behind at once (it spends the rest of the test outside the bubble).
    expect(sim.commands.stage().ok).toBe(true);
    steps(sim, 2);
    jumpAhead(sim, 100000);
    steps(sim, 8);
    // Second batch, kept company for half a minute (inside the bubble), then left behind as well.
    expect(sim.commands.stage().ok).toBe(true);
    steps(sim, 30);
    let s = sim.peek();
    expect(others(s)).toHaveLength(20);
    expect(others(s).filter((d) => d.tier === 'rails')).toHaveLength(10);
    jumpAhead(sim, 100000);
    steps(sim, 5);
    s = sim.peek();
    expect(others(s)).toHaveLength(20);
    for (const d of others(s)) expect(d.tier).toBe('rails');
    for (const d of others(s)) expect(d.age).toBeCloseTo(pieceOf(d).startsWith('piece-0-') ? 45 : 35, 6);
    expect(sim.debrisLog()).toHaveLength(0);
    // Third batch: 26 pieces exist, two too many. The six new ones are next to the capsule (never removed
    // from the bubble); of the twenty outside, the two oldest go: pieces of the FIRST batch.
    expect(sim.commands.stage().ok).toBe(true);
    steps(sim, 1);
    s = sim.peek();
    expect(others(s)).toHaveLength(MAX_DEBRIS);
    const fates = sim.debrisLog();
    expect(fates).toHaveLength(2);
    for (const f of fates) {
      expect(f.reason).toBe('limit');
      expect(f.vesselId).toContain('piece-0-');
      expect(s.events.some((e) => e.type === 'vesselRemoved' && e.vesselId === f.vesselId && e.reason === 'limit')).toBe(true);
    }
    expect(others(s).filter((d) => pieceOf(d).startsWith('piece-0-'))).toHaveLength(8);
    expect(others(s).filter((d) => pieceOf(d).startsWith('piece-1-'))).toHaveLength(10);
    expect(others(s).filter((d) => pieceOf(d).startsWith('piece-2-') && d.tier === 'full')).toHaveLength(6);
    // Nothing more is removed while the count is at the cap.
    steps(sim, 30);
    expect(others(sim.peek())).toHaveLength(MAX_DEBRIS);
    expect(sim.debrisLog()).toHaveLength(2);
  });

  it('pieces inside the bubble are never removed for the cap', async () => {
    const lib = shedVehicle(defs, [
      { def: COVER, count: 14 },
      { def: COVER, count: 14 },
    ]);
    const sim: SimWorld = await makeSim(lib, inOrbit(lib, 't-shed', 't-cap-near'), terrain);
    sim.commands.stage();
    steps(sim, 1);
    sim.commands.stage();
    steps(sim, 20);
    const s = sim.peek();
    expect(others(s)).toHaveLength(28);
    for (const d of others(s)) expect(d.tier).toBe('full');
    expect(sim.debrisLog()).toHaveLength(0);
  });
});

describe('vessel cycling', () => {
  it('switches between two controllable vessels in the bubble: the controls, the read-outs and the prediction follow', async () => {
    const lib = twinVehicle(defs);
    const sim = await makeSim(lib, inOrbit(lib, 't-twin', 't-cycle'), terrain);
    // One vessel: nothing to cycle to.
    expect(sim.commands.cycleActiveVessel(1).ok).toBe(false);
    expect(sim.commands.stage().ok).toBe(true);
    steps(sim, 2);
    let s = sim.snapshot();
    expect(s.vessels).toHaveLength(2);
    for (const v of s.vessels) expect(v.controllable).toBe(true);
    const a = s.activeVesselId;
    const b = others(s)[0]!.id;
    const massA = active(s).mass;
    const massB = others(s)[0]!.mass;
    expect(massB).toBeGreaterThan(massA + 50);
    expect(s.readouts.mass).toBeCloseTo(massA, 6);
    // A node planned for the first vessel does not follow the switch.
    sim.commands.addNode(s.simUt + 600);
    expect(sim.peek().nodes).toHaveLength(1);
    const res = sim.commands.cycleActiveVessel(1);
    expect(res.ok).toBe(true);
    s = sim.snapshot();
    expect(s.activeVesselId).toBe(b);
    expect(s.events.some((e) => e.type === 'activeVesselChanged' && e.vesselId === b && e.previousVesselId === a)).toBe(true);
    expect(s.nodes).toHaveLength(0);
    expect(s.readouts.mass).toBeCloseTo(massB, 6);
    expect(s.mission.failed).toBe(false);
    // The prediction is that of the new vessel: its first patch passes through its own centre of mass.
    const vb = active(s);
    const com = v3.add(vb.r, quat.rotate(vb.q, vb.comLocal));
    const c = s.patches.current[0]!.conic;
    expect(s.patches.current[0]!.bodyId).toBe(vb.bodyId);
    expect(Math.abs(v3.dot(v3.normalize(com), c.W))).toBeLessThan(1e-9);
    // The stick moves the vessel that is flown, and only it.
    sim.commands.setSasEnabled(false);
    sim.setControls(controls({ pitch: 1 }));
    steps(sim, 1);
    sim.setControls(controls());
    s = sim.peek();
    const rateB = v3.len(active(s).w);
    const rateA = v3.len(s.vessels.find((v) => v.id === a)!.w);
    expect(rateB).toBeGreaterThan(0.01);
    expect(rateA).toBeLessThan(0.1 * rateB);
    // Round again in either direction (two vessels: both directions lead to the other one).
    expect(sim.commands.cycleActiveVessel(-1).ok).toBe(true);
    expect(sim.peek().activeVesselId).toBe(a);
    expect(sim.peek().readouts.mass).toBeCloseTo(massA, 6);
    expect(sim.commands.cycleActiveVessel(1).ok).toBe(true);
    expect(sim.commands.cycleActiveVessel(1).ok).toBe(true);
    expect(sim.peek().activeVesselId).toBe(a);
    // Controllable vessels are not debris: neither expires, and neither counts as lost.
    steps(sim, FRAGMENT_LIFETIME + 5);
    expect(sim.peek().vessels).toHaveLength(2);
    // Outside the bubble the other vessel cannot be taken over.
    jumpAhead(sim, 4 * BUBBLE_EXIT_RADIUS);
    steps(sim, 1);
    s = sim.peek();
    expect(s.vessels.find((v) => v.id === b)!.tier).toBe('rails');
    const refused = sim.commands.cycleActiveVessel(1);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBeTruthy();
    expect(sim.peek().activeVesselId).toBe(a);
  });
});
