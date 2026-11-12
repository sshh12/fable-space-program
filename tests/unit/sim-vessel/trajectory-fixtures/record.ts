/**
 * Records the six trajectory fixtures (fixtures.ts) into this directory. It ran once, on the tick-grid tree
 * (MIGRATION_V2 step 3.2), and REFUSES to overwrite a recording: the fixtures are never re-recorded. A new
 * fixture (a name without a file) can be added by running it again.
 *
 *   npx tsx tests/unit/sim-vessel/trajectory-fixtures/record.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary } from '../helpers';
import { FIXTURE_NAMES, flyFixture } from './fixtures';

const dir = path.dirname(fileURLToPath(import.meta.url));
const defs = await loadLibrary();
for (const name of FIXTURE_NAMES) {
  const file = path.join(dir, `${name}.json`);
  if (fs.existsSync(file)) {
    console.log(`${name}: already recorded, left alone`);
    continue;
  }
  const a = flyFixture(defs, name);
  const b = flyFixture(defs, name);
  const text = `${JSON.stringify(a, null, 1)}\n`;
  if (text !== `${JSON.stringify(b, null, 1)}\n`) throw new Error(`${name}: two flights of the fixture differ; it is not deterministic and was not recorded`);
  fs.writeFileSync(file, text);
  const samples = a.runs.reduce((n, r) => n + r.samples.length, 0);
  const vessels = a.runs.reduce((n, r) => n + r.samples[r.samples.length - 1]!.vessels.length, 0);
  console.log(`${name}: recorded ${a.runs.length} run(s), ${a.runs.reduce((n, r) => n + r.steps, 0)} steps, ${samples} samples, ${vessels} vessels, ${a.runs.reduce((n, r) => n + r.events.length, 0)} events (${(text.length / 1024).toFixed(0)} kB)`);
}
