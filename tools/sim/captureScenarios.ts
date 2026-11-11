/**
 * Author the QA scenarios under data/defs/scenarios from one nominal flight of `lunar-direct`: the pilot
 * flies the mission headless and tools/sim/qaScenarios.ts captures the vehicle at eight points (state,
 * time, stages already fired and the resource amounts of every remaining part).
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/captureScenarios.ts [--check]
 *
 * --check flies and compares with the files on disk without writing (exit code 1 on a difference). The
 * mission test makes the same comparison on its own nominal flight, so a change that moves the trajectory
 * fails `npm run test:mission` until this tool has been run again.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ScenarioDef } from '@/core/contracts/defs';
import { flyMission } from './flyMission';
import { ScenarioCapturer, scenarioFileText } from './qaScenarios';
import { loadLibrary, repoRoot } from './realWorld';

const check = process.argv.includes('--check');
const defs = await loadLibrary();
const base = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/defs/scenarios/lunar-direct.json'), 'utf8')) as ScenarioDef;
const capturer = new ScenarioCapturer(base, (bodyId) => defs.bodies[bodyId]!.radius);
let pilotPhase = '';

const res = await flyMission({
  quiet: true,
  onTick: (s) => capturer.onTick(s, pilotPhase),
  phaseProbe: (phase) => {
    pilotPhase = phase;
  },
});
if (res.run.reason !== 'done') throw new Error(`the nominal flight did not finish: ${res.run.reason} ${res.run.failure ?? ''}`);
let differ = false;
for (const sc of capturer.scenarios()) {
  const file = path.join(repoRoot, 'data/defs/scenarios', `${sc.id}.json`);
  const text = scenarioFileText(sc);
  if (check) {
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (old !== text) {
      differ = true;
      console.log(`${sc.id}: differs from the file on disk`);
    } else console.log(`${sc.id}: up to date`);
  } else {
    fs.writeFileSync(file, text);
    const kg = Object.values(sc.resources ?? {}).reduce((n, part) => n + Object.values(part).reduce((a, b) => a + b, 0), 0);
    console.log(`${sc.id}: written (ut ${sc.startUt.toFixed(3)}, ${sc.start.kind}, ${sc.stagesAlreadyFired} stages fired, ${kg.toFixed(0)} kg of resources on board)`);
  }
}
if (differ) process.exit(1);
