/**
 * Author the QA scenarios under data/defs/scenarios from one nominal flight of `lunar-direct`: the pilot
 * flies the mission headless and the vehicle's state is captured at eight points. Each scenario places
 * the correct vehicle configuration (stagesAlreadyFired) at the captured BCI state at the captured time,
 * so body positions, lighting and the trajectory are those of the real mission. Propellant tanks of the
 * remaining stages are full (ScenarioDef has no field for resource amounts).
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/captureScenarios.ts [--check]
 *
 * --check flies and compares with the files on disk without writing (exit code 1 on a difference).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ScenarioDef, ScenarioStart } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import { timeSincePeriapsis } from '@/core/math/conic';
import { conicStateAt } from '@/pilot/math';
import { flyMission } from './flyMission';
import { repoRoot } from './realWorld';

interface Capture {
  id: string;
  name: string;
  /** True when this tick is the one to capture. */
  when: (s: SimSnapshot, phase: string, state: CaptureState) => boolean;
  stagesAlreadyFired: number;
  attitude: 'prograde' | 'retrograde' | 'radialOut';
  /** 'landed' = a landed start at the scenario's landing target instead of a state vector. */
  landed?: boolean;
  /** Take the state this many seconds before the 122 km entry interface of the current conic instead of the tick's own. */
  beforeInterface?: number;
}

interface CaptureState {
  phaseStartUt: number;
  phase: string;
  milestoneUt: Map<string, number>;
}

const since = (st: CaptureState, s: SimSnapshot): number => s.simUt - st.phaseStartUt;

const EARTH_RADIUS = 6371000;

const CAPTURES: Capture[] = [
  {
    id: 'qa-leo',
    name: 'QA: parking orbit (third stage and lander stack)',
    when: (s, phase, st) => phase === 'parkingCoast' && since(st, s) > 600,
    stagesAlreadyFired: 4,
    attitude: 'prograde',
  },
  {
    id: 'qa-translunar',
    name: 'QA: translunar coast (lander stack)',
    when: (s, phase, st) => phase === 'coastToMoon' && since(st, s) > 6 * 3600,
    stagesAlreadyFired: 5,
    attitude: 'prograde',
  },
  {
    id: 'qa-lunar-orbit',
    name: 'QA: 100 km lunar orbit (lander stack)',
    when: (s, phase, st) => phase === 'lunarOrbit' && since(st, s) > 1,
    stagesAlreadyFired: 5,
    attitude: 'prograde',
  },
  {
    id: 'qa-powered-descent',
    name: 'QA: descent orbit, 15 km perilune up-range of the landing target',
    when: (s, phase) => phase === 'pdiCoast' && s.readouts.landingTarget !== null && s.readouts.landingTarget.downRange > 0 && s.readouts.landingTarget.downRange < 1.6e6 && s.readouts.altitudeAsl < 40000,
    stagesAlreadyFired: 6,
    attitude: 'retrograde',
  },
  {
    id: 'qa-lunar-surface',
    name: 'QA: landed at the Tranquillity target',
    when: (_s, phase) => phase === 'surface',
    stagesAlreadyFired: 6,
    attitude: 'radialOut',
    landed: true,
  },
  {
    id: 'qa-trans-earth',
    name: 'QA: trans-Earth coast (ascent stage and capsule)',
    when: (s, phase, st) => phase === 'transEarth' && st.milestoneUt.has('EARTH_PERIGEE_TARGETED') && s.simUt - st.milestoneUt.get('EARTH_PERIGEE_TARGETED')! > 12 * 3600 && s.nodes.length === 0,
    stagesAlreadyFired: 7,
    attitude: 'prograde',
  },
  {
    id: 'qa-entry',
    name: 'QA: capsule five minutes before the entry interface',
    // Any tick of the coast to the atmosphere: the state five minutes before the 122 km interface is taken from the conic.
    when: (s, phase) => phase === 'entry' && s.readouts.altitudeAsl > 300000 && s.patches.current[0]?.endReason === 'atmosphere',
    stagesAlreadyFired: 8,
    attitude: 'retrograde',
    beforeInterface: 300,
  },
  {
    id: 'qa-drogues',
    name: 'QA: capsule under drogues at 7 km over the recovery zone',
    when: (s, _phase, st) => st.milestoneUt.has('DROGUE_DEPLOY') && s.readouts.altitudeAsl <= 7000,
    stagesAlreadyFired: 9,
    attitude: 'retrograde',
  },
];

/** State on the current conic `lead` seconds before it comes down through the 122 km entry interface. */
function stateBeforeInterface(s: SimSnapshot, lead: number): { ut: number; r: [number, number, number]; v: [number, number, number] } {
  const patch = s.patches.current[0]!;
  const c = patch.conic;
  const rInterface = EARTH_RADIUS + 122000;
  const nu = -Math.acos(Math.max(-1, Math.min(1, (c.p / rInterface - 1) / c.e)));
  let tInterface = c.tPeriapsis + timeSincePeriapsis(c, nu);
  if (c.period !== null) while (tInterface < s.simUt) tInterface += c.period;
  const ut = tInterface - lead;
  const st = conicStateAt(c, ut);
  return { ut, r: [st.r.x, st.r.y, st.r.z], v: [st.v.x, st.v.y, st.v.z] };
}

const check = process.argv.includes('--check');
const base = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/defs/scenarios/lunar-direct.json'), 'utf8')) as ScenarioDef;
const done = new Map<string, ScenarioDef>();
const st: CaptureState = { phaseStartUt: 0, phase: '', milestoneUt: new Map() };
let pilotPhase = '';

const res = await flyMission({
  quiet: true,
  onTick: (s) => {
    for (const m of s.milestones) if (!st.milestoneUt.has(m.id)) st.milestoneUt.set(m.id, m.ut);
    if (pilotPhase !== st.phase) {
      st.phase = pilotPhase;
      st.phaseStartUt = s.simUt;
    }
    for (const c of CAPTURES) {
      if (done.has(c.id) || !c.when(s, st.phase, st)) continue;
      const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
      let start: ScenarioStart;
      if (c.landed) {
        const t = s.surfaceTargets.find((x) => x.kind === 'landing')!;
        start = { kind: 'landed', bodyId: t.bodyId, latDeg: base.suggestedLanding!.latDeg, lonDeg: base.suggestedLanding!.lonDeg };
      } else start = { kind: 'state', bodyId: v.bodyId, r: [v.r.x, v.r.y, v.r.z], v: [v.v.x, v.v.y, v.v.z], attitude: c.attitude };
      let startUt = s.simUt;
      if (c.beforeInterface !== undefined) {
        const st0 = stateBeforeInterface(s, c.beforeInterface);
        startUt = st0.ut;
        start = { kind: 'state', bodyId: v.bodyId, r: st0.r, v: st0.v, attitude: c.attitude };
      }
      done.set(c.id, {
        id: c.id,
        name: c.name,
        vehicle: base.vehicle,
        site: base.site,
        startUt,
        start,
        stagesAlreadyFired: c.stagesAlreadyFired,
        target: base.target,
        suggestedLanding: base.suggestedLanding,
        milestones: [],
      });
    }
  },
  phaseProbe: (phase) => {
    pilotPhase = phase;
  },
});
if (res.run.reason !== 'done') throw new Error(`the nominal flight did not finish: ${res.run.reason} ${res.run.failure ?? ''}`);
let differ = false;
for (const c of CAPTURES) {
  const sc = done.get(c.id);
  if (!sc) throw new Error(`capture point "${c.id}" was never reached`);
  const file = path.join(repoRoot, 'data/defs/scenarios', `${c.id}.json`);
  const text = `${JSON.stringify(sc, null, 2)}\n`;
  if (check) {
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (old !== text) {
      differ = true;
      console.log(`${c.id}: differs from the file on disk`);
    } else console.log(`${c.id}: up to date`);
  } else {
    fs.writeFileSync(file, text);
    console.log(`${c.id}: written (ut ${sc.startUt.toFixed(3)}, ${sc.start.kind}, ${sc.stagesAlreadyFired} stages fired)`);
  }
}
if (differ) process.exit(1);
