/**
 * Records `viewReference.json` (see viewReference.ts). It ran once, on the World of the tag
 * `post-tighten-2026-11-24`, and REFUSES to overwrite the recording: the reference is what the view
 * builders of island-core are compared against.
 *
 *   npx tsx tests/unit/sim-world/viewReference.record.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary } from './helpers';
import { driveAll, type ViewReference } from './viewReference';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'viewReference.json');
if (fs.existsSync(file)) {
  console.log('viewReference.json: already recorded, left alone');
} else {
  const defs = await loadLibrary();
  const a = await driveAll(defs);
  const b = await driveAll(defs);
  const ref: ViewReference = { note: 'Snapshot blocks of the wave-3 World at 200 states (tests/unit/sim-world/viewReference.ts). Never re-recorded.', samples: a };
  const text = `${JSON.stringify(ref, null, 1)}\n`;
  if (text !== `${JSON.stringify({ ...ref, samples: b }, null, 1)}\n`) throw new Error('viewReference: two drives differ; it is not deterministic and was not recorded');
  fs.writeFileSync(file, text);
  const multi = a.filter((s) => s.vessels > 1).length;
  console.log(`viewReference.json: ${a.length} samples recorded, ${multi} with more than one vessel, ${a.filter((s) => s.kind === 'snapshot').length} presentation snapshots`);
}
