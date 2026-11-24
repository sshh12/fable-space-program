/**
 * The snapshot of an island of 64 vessels with a relevance cut of 10 (island-core acceptance, "Measured:
 * snapshot build for 64 vessels with a relevance cut of 10 (budget 1.0 ms)"; ARCHITECTURE 7.2: 64 vessels per
 * island is the performance budget). The cut is `SnapshotSource.relevant`: the ten vessels nearest the focus
 * carry their parts, the other fifty-four are pose-only. The time is printed and judged against the budget
 * with head-room for a machine that is running other jobs (PACKAGE_RULES 16: such a timing is provisional).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { DEFAULT_UNIVERSE_RULES } from '@/core/contracts/net';
import type { SimSnapshot } from '@/core/contracts/sim';
import { v3 } from '@/core/math/vec3';
import { createBodySystem } from '@/sim/bodies/bodySystem';
import { BodyFrames, createIsland, type Island } from '@/sim/island';
import { RenderRoot } from '@/sim/view/frame';
import { planSubject, viewOfMember } from '@/sim/view/host';
import { Planning } from '@/sim/view/planning';
import { buildSnapshot, privateClockView, StageFigures, type ViewVessel } from '@/sim/view/snapshot';
import { loadLibrary, orbiter, PILOT, TICK0 } from '../sim-island/helpers';
import { flatTerrain } from './helpers';

const VESSELS = 64;
const CUT = 10;
/** The budget of the acceptance line, ms, and the factor allowed on a machine under load. */
const BUDGET_MS = 1.0;
const LOAD_FACTOR = 4;

describe('snapshot of an island of 64 vessels with a relevance cut of 10', () => {
  let defs: DefLibrary;
  beforeAll(async () => {
    defs = await loadLibrary();
  });

  /** 64 craft in low orbit, 40 m apart on a line; `stagesFired` says how much of the stack each still is. */
  function build(stagesFired: number): { island: Island; snapshot: () => SimSnapshot; parts: number } {
    const system = createBodySystem(defs);
    const terrain = flatTerrain(defs);
    const frames = new BodyFrames(system, terrain);
    const island = createIsland({ defs, system, terrain, rules: DEFAULT_UNIVERSE_RULES }, { id: 'i-64', tick: TICK0, bodyId: 'earth' });
    const mu = system.body('earth').mu;
    const radius = system.body('earth').radius + 300_000;
    for (let i = 0; i < VESSELS; i++) {
      const id = `craft-${String(i).padStart(2, '0')}`;
      island.add(orbiter(defs, id, stagesFired, mu, radius, { x: 0, y: 40 * i, z: 0 }), i === 0 ? { pilot: PILOT, attended: true } : {});
    }
    for (const m of island.members) island.settle(m.vessel.id);
    island.refreshMargins();
    const planning = new Planning(frames);
    const root = new RenderRoot(system, 'soiBody');
    root.reset('earth');
    const figures = new StageFigures(frames);
    const focusId = island.members[0]!.vessel.id;
    const snapshot = (): SimSnapshot => {
      const vessels: ViewVessel[] = island.members.map((m) => viewOfMember(island, m));
      const focus = vessels.find((e) => e.vessel.id === focusId)!;
      // The relevance cut: the ten vessels nearest the focus (itself included).
      const near = new Set(
        vessels
          .map((e) => ({ e, d: v3.dist(e.vessel.r, focus.vessel.r) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, CUT)
          .map((x) => x.e),
      );
      const subject = planSubject(focus, true, island.tick, 0, () => focus.env);
      planning.ensurePatches(subject);
      return buildSnapshot({
        frames,
        planning,
        root,
        figures,
        tick: island.tick,
        lag: 0,
        revision: 0,
        vessels,
        focus,
        focusPresent: true,
        wreck: null,
        subject,
        envOf: (e) => e.env,
        relevant: (e) => near.has(e),
        time: privateClockView(island.tick, 1, 1, null),
        warp: { index: 0, factor: 1, maxIndex: 0, limitedBy: null, onRails: false },
        scenario: null,
        surfaceTargets: [],
        terrain: { finalAt: () => true, pending: false, incompleteQueries: 0 },
        events: [],
        milestones: [],
        mission: { failed: false, failureReason: null, crewAlive: true },
        cheatCounter: 0,
        liftoffUt: null,
      });
    };
    return { island, snapshot, parts: island.members[0]!.vessel.parts.length };
  }

  for (const [name, stagesFired] of [
    ['the capsule stack', 7],
    ['the whole lunar stack', 0],
  ] as const) {
    it(`${name}: ten vessels with their parts, fifty-four pose-only, inside the budget`, () => {
      const { island, snapshot, parts } = build(stagesFired);
      const first = snapshot();
      expect(first.vessels).toHaveLength(VESSELS);
      const full = first.vessels.filter((v) => v.parts.length > 0);
      expect(full).toHaveLength(CUT);
      expect(full.every((v) => v.parts.length === parts)).toBe(true);
      expect(first.vessels.filter((v) => v.parts.length === 0)).toHaveLength(VESSELS - CUT);
      // Every vessel still has its pose and its craft.
      expect(first.vessels.every((v) => Number.isFinite(v.rRoot.x) && v.crafts.length > 0)).toBe(true);
      // Timed over snapshots of a stepping island (every tenth step, as a client at 12 Hz would take them).
      let total = 0;
      let count = 0;
      let worst = 0;
      for (let k = 0; k < 400; k++) {
        island.step();
        if (k % 10 !== 0) continue;
        const t0 = performance.now();
        snapshot();
        const dt = performance.now() - t0;
        if (k >= 100) {
          total += dt;
          count++;
          worst = Math.max(worst, dt);
        }
      }
      const mean = total / count;
      console.info(`snapshot of ${VESSELS} vessels (${parts} parts each), relevance cut ${CUT}: mean ${mean.toFixed(3)} ms, worst ${worst.toFixed(3)} ms over ${count} snapshots (budget ${BUDGET_MS} ms)`);
      expect(mean).toBeLessThan(BUDGET_MS * LOAD_FACTOR);
    }, 120_000);
  }
});
