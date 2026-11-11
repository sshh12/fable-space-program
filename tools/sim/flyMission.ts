/**
 * Fly a scenario headless with the scripted pilot on the real baked terrain and print the flight log:
 * phase transitions, milestones with their numbers, the pilot's report, timings and the state hash.
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/flyMission.ts [--scenario lunar-direct]
 *        [--until-milestone ID] [--until-phase name] [--max-days n] [--launch-delay s] [--sloppy]
 *        [--thrust-scale f] [--quiet] [--json out.json]
 *
 * --thrust-scale multiplies the vacuum and sea-level thrust of every liquid engine (same specific impulse),
 * e.g. 0.97 for the 3 % under-performance run.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DefLibrary } from '@/core/contracts/defs';
import type { MilestoneRecord, SimSnapshot } from '@/core/contracts/sim';
import { createMissionPilot, runHeadless, SLOPPY_PITCH_PROGRAMME, type MissionPilotOptions, type RunResult } from '@/pilot';
import { createSim, type SimWorld } from '@/sim';
import { createRealTerrain, loadLibrary, repoRoot } from './realWorld';

export interface FlightOptions {
  scenario?: string;
  untilMilestone?: string;
  untilPhase?: string;
  maxDays?: number;
  launchDelay?: number;
  sloppy?: boolean;
  thrustScale?: number;
  /** Override of the pilot's departure-plane tilt, degrees (experiments). */
  tiltDeg?: number;
  quiet?: boolean;
  /** Observer at every control tick. */
  onTick?: (snapshot: SimSnapshot, sim: SimWorld) => void;
  /** Told the pilot's phase at every control tick (before onTick). */
  phaseProbe?: (phase: string) => void;
}

export interface FlightResult {
  run: RunResult;
  sim: SimWorld;
  milestones: MilestoneRecord[];
  report: Record<string, number>;
  log: { ut: number; met: number; phase: string; note: string }[];
  wallSeconds: number;
  hash: string;
}

/** A copy of the library with every liquid engine's thrust scaled (the specific impulse is kept). */
export function scaleEngineThrust(defs: DefLibrary, scale: number): DefLibrary {
  const parts: DefLibrary['parts'] = {};
  for (const [id, p] of Object.entries(defs.parts)) {
    parts[id] = {
      ...p,
      modules: p.modules.map((m) => (m.type === 'engine' && !m.fixedBurn ? { ...m, thrustVac: m.thrustVac * scale } : m)),
    };
  }
  return { ...defs, parts };
}

const fmtMet = (met: number): string => {
  const s = Math.floor(met % 60);
  const m = Math.floor(met / 60) % 60;
  const h = Math.floor(met / 3600) % 24;
  const d = Math.floor(met / 86400);
  return `${d}d ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export async function flyMission(opts: FlightOptions = {}): Promise<FlightResult> {
  const scenarioId = opts.scenario ?? 'lunar-direct';
  let defs = await loadLibrary();
  if (opts.thrustScale !== undefined && opts.thrustScale !== 1) defs = scaleEngineThrust(defs, opts.thrustScale);
  const terrain = await createRealTerrain(defs);
  const sim = createSim(defs, scenarioId, { terrain });
  const pilotOptions: MissionPilotOptions = {};
  if (opts.launchDelay) pilotOptions.launchDelay = opts.launchDelay;
  if (opts.sloppy) pilotOptions.pitchProgramme = SLOPPY_PITCH_PROGRAMME;
  if (opts.tiltDeg !== undefined) pilotOptions.returnPlaneTiltDeg = opts.tiltDeg;
  if (!opts.quiet) pilotOptions.onLog = (e) => console.log(`[${fmtMet(e.met)}] ${e.phase}: ${e.note}`);
  const pilot = createMissionPilot(defs, sim.scenario, pilotOptions);
  let seen = 0;
  const t0 = performance.now();
  const run = await runHeadless(sim, pilot, {
    maxSimTime: (opts.maxDays ?? 14) * 86400,
    clock: () => performance.now(),
    until: (s) => (opts.untilMilestone !== undefined && s.milestones.some((m) => m.id === opts.untilMilestone)) || (opts.untilPhase !== undefined && pilot.phase === opts.untilPhase),
    onTick: (s) => {
      while (seen < s.milestones.length) {
        const m = s.milestones[seen++]!;
        if (!opts.quiet) console.log(`[${fmtMet(m.data['met'] ?? 0)}] MILESTONE ${m.id}`);
      }
      opts.phaseProbe?.(pilot.phase);
      opts.onTick?.(s, sim);
    },
  });
  const wallSeconds = (performance.now() - t0) / 1000;
  return { run, sim, milestones: run.last.milestones, report: pilot.report, log: pilot.log, wallSeconds, hash: sim.stateHash() };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('tools/sim/flyMission.ts');
if (invokedDirectly) {
  const o: FlightOptions = {};
  const sc = arg('scenario');
  if (sc !== undefined) o.scenario = sc;
  const um = arg('until-milestone');
  if (um !== undefined) o.untilMilestone = um;
  const up = arg('until-phase');
  if (up !== undefined) o.untilPhase = up;
  const md = arg('max-days');
  if (md !== undefined) o.maxDays = Number(md);
  const ld = arg('launch-delay');
  if (ld !== undefined) o.launchDelay = Number(ld);
  const ts = arg('thrust-scale');
  if (ts !== undefined) o.thrustScale = Number(ts);
  if (flag('sloppy')) o.sloppy = true;
  const tilt = arg('tilt');
  if (tilt !== undefined) o.tiltDeg = Number(tilt);
  if (flag('quiet')) o.quiet = true;
  const res = await flyMission(o);
  const r = res.run;
  console.log(`\nstopped: ${r.reason}${r.failure ? ` (${r.failure})` : ''} after ${(r.simTime / 86400).toFixed(3)} d of simulation time`);
  console.log(`wall ${res.wallSeconds.toFixed(1)} s; ${r.stats.steps} steps (${((r.stats.stepMs / Math.max(1, r.stats.steps)) * 1000).toFixed(1)} us mean, ${r.stats.maxStepMs.toFixed(2)} ms max), ${r.stats.railsAdvances} rails advances, ${r.stats.ticks} control ticks`);
  console.log(`terrain: incompleteQueries ${r.last.terrain.incompleteQueries}; ${JSON.stringify(res.sim.stats())}`);
  console.log(`state hash ${res.hash}`);
  for (const m of res.milestones) {
    const d = m.data;
    const keys = Object.keys(d).filter((k) => !k.startsWith('propellant') && !['ut', 'surfaceGravity', 'vesselCount', 'stagesFired', 'incompleteQueries', 'terrainWarpClamps'].includes(k));
    console.log(`${m.id}: ` + keys.map((k) => `${k}=${Number(d[k]!.toPrecision(7))}`).join(' '));
  }
  console.log('report', JSON.stringify(res.report, null, 1));
  console.log('debris', res.sim.debrisLog().map((f) => `${f.name}: ${f.reason} on ${f.bodyId} at ${f.latitudeDeg.toFixed(2)},${f.longitudeDeg.toFixed(2)} (${(f.distanceFromSite / 1000).toFixed(0)} km from the site)`).join('\n'));
  const json = arg('json');
  if (json !== undefined) {
    const out = path.resolve(repoRoot, json);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ reason: r.reason, failure: r.failure, simTime: r.simTime, wallSeconds: res.wallSeconds, stats: r.stats, hash: res.hash, milestones: res.milestones, report: res.report, log: res.log, debris: res.sim.debrisLog() }, null, 1));
  }
}
