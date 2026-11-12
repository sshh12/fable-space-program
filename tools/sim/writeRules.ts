/**
 * Writes the rules documents of data/defs/rules from the contract defaults (MIGRATION_V2 step 3.6;
 * src/core/contracts/net.ts, `UniverseRules`):
 *
 *   default   `DEFAULT_UNIVERSE_RULES` as it is: production (src/core/contracts/net.test.ts holds the file
 *             and the constant equal).
 *   staging   the defaults with lifetimes of minutes, so that expiry can be watched: every timer of the
 *             document that runs on the wall clock (`UNIVERSE_RULE_TIMERS`, base 'wall') is its default
 *             with a day shortened to a minute, and none is shorter than one minute.
 *   local     the defaults under the id `local`: offline play and tests.
 *
 * The documents are data from here on (their owner tunes the files); this tool states where they came from
 * and re-derives them when the contract gains a field.
 *
 * Usage: npx tsx tools/sim/writeRules.ts            write the three files
 *        npx tsx tools/sim/writeRules.ts --check    compare the files with what would be written, exit 1 on a difference
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_UNIVERSE_RULES, UNIVERSE_RULE_TIMERS, type UniverseRules } from '@/core/contracts/net';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RULES_DIR = path.join(repoRoot, 'data', 'defs', 'rules');

/** Staging: a day of a wall-clock timer passes in a minute, and no timer is shorter than this, s. */
export const STAGING_DAY = 60;
export const STAGING_SHORTEST = 60;
const DAY = 86400;

const copy = (rules: UniverseRules): UniverseRules => JSON.parse(JSON.stringify(rules)) as UniverseRules;

/** The paths (`group.field`) of the timers of a rules document that run on the wall clock. */
export function wallTimers(): string[] {
  return Object.keys(UNIVERSE_RULE_TIMERS)
    .filter((p) => UNIVERSE_RULE_TIMERS[p] === 'wall')
    .sort();
}

/** The three documents, by id. */
export function rulesDocuments(): Record<string, UniverseRules> {
  const standard = copy(DEFAULT_UNIVERSE_RULES);
  const staging = copy(DEFAULT_UNIVERSE_RULES);
  staging.id = 'staging';
  for (const p of wallTimers()) {
    const [group, field] = p.split('.') as [string, string];
    const block = (staging as unknown as Record<string, Record<string, unknown>>)[group];
    const seconds = block?.[field];
    if (!block || typeof seconds !== 'number') throw new Error(`writeRules: UNIVERSE_RULE_TIMERS names "${p}", which is not a duration of the default document`);
    block[field] = Math.max(STAGING_SHORTEST, (seconds / DAY) * STAGING_DAY);
  }
  const local = copy(DEFAULT_UNIVERSE_RULES);
  local.id = 'local';
  return { [standard.id]: standard, staging, local };
}

const textOf = (doc: UniverseRules): string => `${JSON.stringify(doc, null, 2)}\n`;

function main(): void {
  const check = process.argv.includes('--check');
  const docs = rulesDocuments();
  let different = 0;
  if (!check) fs.mkdirSync(RULES_DIR, { recursive: true });
  for (const id of Object.keys(docs).sort()) {
    const file = path.join(RULES_DIR, `${id}.json`);
    const text = textOf(docs[id]!);
    if (check) {
      const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      const same = have !== null && JSON.stringify(JSON.parse(have)) === JSON.stringify(docs[id]);
      if (!same) different++;
      console.log(`${path.relative(repoRoot, file)}: ${have === null ? 'missing' : same ? 'as derived' : 'differs from the derivation'}`);
    } else {
      fs.writeFileSync(file, text);
      console.log(`wrote ${path.relative(repoRoot, file)} (version ${docs[id]!.version})`);
    }
  }
  if (check && different > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
