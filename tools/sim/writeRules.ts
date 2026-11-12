/**
 * Writes the rules files of data/defs/rules (MIGRATION_V2 step 3.6; src/core/contracts/net.ts,
 * `UniverseRules`). A rules file is stored as OVERRIDES of the contract's default document: it states its
 * id, its version and the fields in which it differs; the loader holds the complete document
 * (`completeRules` in src/core/defs/loader.ts). A field the contract gains needs no change here.
 *
 *   default   states nothing but its id and version: production is the default document.
 *   staging   lifetimes of minutes, so that expiry can be watched in a soak: every timer of the document
 *             that runs on the wall clock (`UNIVERSE_RULE_TIMERS`, base 'wall'), THE SWEEP INTERVAL
 *             INCLUDED, is its default with a day shortened to a minute, and no lifetime is shorter than
 *             two sweeps. So debris and wrecks (5 s), the outage threshold (2.5 s), arcs (60 s) and the two
 *             pressure floors (60 s, 180 s) stay apart, and the sweep (24 a second) resolves all of them.
 *             Accounts are kept 90 minutes: a staging identity does not outlive a session.
 *   local     offline play and tests: the time and physics rules of the default, and every retention on
 *             the wall clock at the largest value a number carries exactly (nothing expires in a session
 *             that has no server to expire it; the contract states no smaller bound).
 *
 * The files are data from here on (their owner tunes them); this tool states where they came from.
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

/** Staging: a day of a wall-clock timer passes in this many seconds, and a lifetime is at least this many sweeps. */
export const STAGING_DAY = 60;
export const STAGING_SWEEPS = 2;
/** Local: a retention that never runs out in practice: the largest whole number of seconds a float64 (and JSON) carries exactly. */
export const LOCAL_RETENTION = Number.MAX_SAFE_INTEGER;
const DAY = 86400;

/** A rules file: the id, the version, a note for the reader of the file, and the fields that differ from the default. */
export type RulesFile = { $comment?: string; id: string; version: number } & { [group: string]: unknown };

/** The paths (`group.field`) of the timers of a rules document that run on the wall clock. */
export function wallTimers(): string[] {
  return Object.keys(UNIVERSE_RULE_TIMERS)
    .filter((p) => UNIVERSE_RULE_TIMERS[p] === 'wall')
    .sort();
}

/** The wall-clock timers that are retentions (how long something is kept), as distinct from the sweep's own cadence and the outage threshold. */
export function wallRetentions(): string[] {
  return wallTimers().filter((p) => /Retention$|^expiry\.pressureFloor/.test(p));
}

const defaultOf = (p: string): number => {
  const [group, field] = p.split('.') as [string, string];
  const value = (DEFAULT_UNIVERSE_RULES as unknown as Record<string, Record<string, unknown>>)[group]?.[field];
  if (typeof value !== 'number') throw new Error(`writeRules: UNIVERSE_RULE_TIMERS names "${p}", which is not a duration of the default document`);
  return value;
};

function withOverrides(base: RulesFile, values: Record<string, number>): RulesFile {
  const out: RulesFile = { ...base };
  for (const p of Object.keys(values).sort()) {
    const [group, field] = p.split('.') as [string, string];
    const block = (out[group] ??= {}) as Record<string, number>;
    block[field] = values[p]!;
  }
  return out;
}

/** The three files, by id. */
export function rulesFiles(): Record<string, RulesFile> {
  const version = DEFAULT_UNIVERSE_RULES.version;
  const scale = STAGING_DAY / DAY;
  const sweep = defaultOf('expiry.sweepInterval') * scale;
  const staging: Record<string, number> = {};
  for (const p of wallTimers()) staging[p] = p === 'expiry.sweepInterval' ? sweep : Math.max(STAGING_SWEEPS * sweep, defaultOf(p) * scale);
  const local: Record<string, number> = {};
  for (const p of wallRetentions()) local[p] = LOCAL_RETENTION;
  return {
    default: { id: 'default', version },
    staging: withOverrides(
      {
        $comment:
          'Staging: lifetimes of minutes. Every wall-clock timer, the sweep included, is its default with a day shortened to a minute, and no lifetime is under two sweeps. Staging identities do not outlive a session: an account without ships is deleted after 90 minutes. Derived by tools/sim/writeRules.ts.',
        id: 'staging',
        version,
      },
      staging,
    ),
    local: withOverrides(
      {
        $comment:
          'Local: offline play and tests. The time and physics rules are the default; every retention on the wall clock is the largest value a number carries exactly, so nothing expires. Derived by tools/sim/writeRules.ts.',
        id: 'local',
        version,
      },
      local,
    ),
  };
}

const textOf = (doc: RulesFile): string => `${JSON.stringify(doc, null, 2)}\n`;

function main(): void {
  const check = process.argv.includes('--check');
  const docs = rulesFiles();
  let different = 0;
  if (!check) fs.mkdirSync(RULES_DIR, { recursive: true });
  for (const id of Object.keys(docs).sort()) {
    const file = path.join(RULES_DIR, `${id}.json`);
    if (check) {
      const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      const same = have !== null && JSON.stringify(JSON.parse(have)) === JSON.stringify(docs[id]);
      if (!same) different++;
      console.log(`${path.relative(repoRoot, file)}: ${have === null ? 'missing' : same ? 'as derived' : 'differs from the derivation'}`);
    } else {
      fs.writeFileSync(file, textOf(docs[id]!));
      console.log(`wrote ${path.relative(repoRoot, file)} (version ${docs[id]!.version})`);
    }
  }
  if (check && different > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

/** The type of the complete document a file stands for (for readers of this tool). */
export type { UniverseRules };
