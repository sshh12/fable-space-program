/**
 * Record the frames of every transcript's loopback run into its JSON file (the `recorded` section), after
 * checking the run reaches the transcript's stated outcome. Run when the protocol changes on purpose:
 *
 *   npx tsx tests/unit/net/transcripts/record.ts
 *
 * The expected outcome is written by hand in each file (it is the specification); this tool never writes it.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTranscript, runTranscript } from '@/net/testing/transcripts';
import { diff } from '../cases/assert';

const dir = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const full = path.join(dir, file);
  const json = JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>;
  const t = parseTranscript(json);
  const r = runTranscript(t, { link: { kind: 'loopback' } });
  const d = diff(r.outcome, t.expect);
  if (d) {
    console.error(`${file}: the loopback run does not reach the stated outcome: ${d}`);
    failed++;
    continue;
  }
  json.recorded = r.recorded;
  writeFileSync(full, `${JSON.stringify(json, null, 2)}\n`);
  const frames = Object.values(r.recorded).reduce((n, list) => n + list.length, 0);
  console.log(`${file}: ${frames} frames recorded`);
}
if (failed) process.exit(1);
