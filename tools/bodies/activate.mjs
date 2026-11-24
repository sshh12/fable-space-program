#!/usr/bin/env node
/**
 * Activation of the Sun-rooted body library (MIGRATION_V2 step 4.4, package bodies-activation; written by
 * solar-system-sim). Moves the staged definitions into data/defs, re-runs tools/sim/findStartTime and checks
 * that it reproduces tools/sim/start-time.json, runs the start-constraint and solstice checks, and prints what
 * the lead must re-baseline.
 *
 *   node tools/bodies/activate.mjs --dry-run     everything against a temporary copy; data/defs is not touched
 *   node tools/bodies/activate.mjs               the activation itself (data/defs changed; commit it with the
 *                                                re-baselines the output lists)
 *   options: --keep (keep the dry run's temporary layout and print its path), --skip-start-time (no
 *            findStartTime run: about a minute)
 *
 * What moves (the same relative layout, so no $ref changes):
 *   data/staged/bodies/<id>.json and radii.json   -> data/defs/bodies/   (the 32 bodies; earth, moon and sun replaced)
 *   data/staged/terrain/<id>.terrain.json         -> data/defs/terrain/
 *   data/staged/render/**                         -> data/defs/render/   (the giants' maps, albedo means)
 *   data/staged/credits.json                      -> merged into data/defs/visuals/credits.json
 * Not moved: data/staged/sites (the sites live in data/defs/sites, fleet-data's).
 *
 * The checks are TypeScript (tools/bodies/activate-check.ts and tools/sim/findStartTime.ts) and run through
 * tsx (its CLI from node_modules, run by this node). In a dry run findStartTime runs from a temporary repository layout (a copy of the tool, the
 * activated defs copy, and links to src and node_modules), because it reads the defs beside itself.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = new Set(process.argv.slice(2));
for (const a of argv) if (!['--dry-run', '--keep', '--skip-start-time'].includes(a)) throw new Error(`unknown option ${a}`);
const dryRun = argv.has('--dry-run');
const staged = path.join(repo, 'data', 'staged');
const defs = path.join(repo, 'data', 'defs');

const rel = (p) => path.relative(repo, p).split(path.sep).join('/');
const sameBytes = (a, b) => fs.existsSync(b) && Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out.sort();
}

/** The plan: every file copied, with what it does to the target. */
function plan(targetDefs) {
  const moves = [];
  const add = (from, to) => moves.push({ from, to, kind: !fs.existsSync(to) ? 'add' : sameBytes(from, to) ? 'same' : 'replace' });
  for (const f of walk(path.join(staged, 'bodies'))) if (f.endsWith('.json')) add(f, path.join(targetDefs, 'bodies', path.basename(f)));
  for (const f of walk(path.join(staged, 'terrain'))) if (f.endsWith('.json')) add(f, path.join(targetDefs, 'terrain', path.basename(f)));
  for (const f of walk(path.join(staged, 'render'))) add(f, path.join(targetDefs, 'render', path.relative(path.join(staged, 'render'), f)));
  return moves;
}

/** credits.json: the staged entries appended to the live list, an entry already there (same JSON) not twice. */
function mergedCredits(targetDefs) {
  const from = path.join(staged, 'credits.json');
  const to = path.join(targetDefs, 'visuals', 'credits.json');
  if (!fs.existsSync(from)) return null;
  const add = JSON.parse(fs.readFileSync(from, 'utf8'));
  const base = fs.existsSync(to) ? JSON.parse(fs.readFileSync(to, 'utf8')) : null;
  const listOf = (doc) => (Array.isArray(doc) ? doc : Array.isArray(doc?.entries) ? doc.entries : Array.isArray(doc?.credits) ? doc.credits : null);
  const addList = listOf(add);
  if (!addList) throw new Error(`${rel(from)}: expected a list of credit entries (an array, or { entries } / { credits })`);
  if (base === null) return { to, doc: add, added: addList.length };
  const baseList = listOf(base);
  if (!baseList) throw new Error(`${rel(to)}: expected a list of credit entries`);
  const seen = new Set(baseList.map((e) => JSON.stringify(e)));
  const fresh = addList.filter((e) => !seen.has(JSON.stringify(e)));
  const merged = Array.isArray(base) ? [...base, ...fresh] : { ...base, [Array.isArray(base.entries) ? 'entries' : 'credits']: [...baseList, ...fresh] };
  return { to, doc: merged, added: fresh.length };
}

/** Run a TypeScript tool with tsx (its CLI through this node, no shell). */
const TSX = path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
function tsx(args, cwd) {
  const r = spawnSync(process.execPath, [TSX, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function link(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

// ------------------------------------------------------------------------------------------------- main
const work = dryRun ? fs.mkdtempSync(path.join(os.tmpdir(), 'fsp-activate-')) : null;
const layout = work ? path.join(work, 'repo') : repo;
const targetDefs = path.join(layout, 'data', 'defs');
if (work) fs.cpSync(defs, targetDefs, { recursive: true });

const moves = plan(targetDefs);
const credits = mergedCredits(targetDefs);
console.log(`${dryRun ? 'DRY RUN (data/defs is not touched; the activation is applied to a copy)' : 'ACTIVATION'}`);
const counts = moves.reduce((m, x) => ((m[x.kind] = (m[x.kind] ?? 0) + 1), m), {});
console.log(`files: ${moves.length} (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')})`);
for (const m of moves.filter((x) => x.kind === 'replace')) console.log(`  replace data/defs/${path.relative(targetDefs, m.to).split(path.sep).join('/')}  <- ${rel(m.from)}`);
for (const m of moves) {
  fs.mkdirSync(path.dirname(m.to), { recursive: true });
  fs.copyFileSync(m.from, m.to);
}
if (credits) {
  fs.mkdirSync(path.dirname(credits.to), { recursive: true });
  fs.writeFileSync(credits.to, JSON.stringify(credits.doc, null, 2) + '\n');
  console.log(`credits: ${credits.added} entries merged into data/defs/visuals/credits.json`);
}

const failures = [];
// 1. the library loads, the body system accepts it, start constraints, solstices, Sun direction against the shipped library
const check = tsx([path.join(repo, 'tools', 'bodies', 'activate-check.ts'), '--defs', targetDefs, '--reference', defs], repo);
console.log('\nchecks of the activated library (tools/bodies/activate-check.ts):');
console.log(check.out.trim());
if (check.code !== 0) failures.push('activate-check failed');

// 2. findStartTime reproduces start-time.json
if (!argv.has('--skip-start-time')) {
  const recorded = JSON.parse(fs.readFileSync(path.join(repo, 'tools', 'sim', 'start-time.json'), 'utf8'));
  let toolPath = path.join(repo, 'tools', 'sim', 'findStartTime.ts');
  if (work) {
    // findStartTime reads the defs beside itself: a layout with its copy, the activated defs and links to the code
    toolPath = path.join(layout, 'tools', 'sim', 'findStartTime.ts');
    fs.mkdirSync(path.dirname(toolPath), { recursive: true });
    fs.copyFileSync(path.join(repo, 'tools', 'sim', 'findStartTime.ts'), toolPath);
    link(path.join(repo, 'src'), path.join(layout, 'src'));
    link(path.join(repo, 'node_modules'), path.join(layout, 'node_modules'));
    fs.copyFileSync(path.join(repo, 'tsconfig.json'), path.join(layout, 'tsconfig.json'));
  }
  const out = path.join(work ?? os.tmpdir(), `start-time.activated.${process.pid}.json`);
  const c = recorded.constraints;
  const args = [toolPath, '--launch-kind', c.launchKind, '--landing-lat', String(recorded.landing.latDeg), '--landing-lon', String(recorded.landing.lonDeg), '--out', out];
  const fst = tsx(args, layout);
  if (fst.code !== 0 || !fs.existsSync(out)) {
    failures.push('findStartTime failed on the activated library');
    console.log(fst.out.trim().split('\n').slice(-12).join('\n'));
  } else {
    const got = JSON.parse(fs.readFileSync(out, 'utf8'));
    const same = got.startUt === recorded.startUt && got.launch?.opportunityUt !== undefined && Math.abs(got.launch.opportunityUt - recorded.launch.opportunityUt) < 1e-3;
    console.log(`\nfindStartTime on the activated library: startUt ${got.startUt} (recorded ${recorded.startUt}), opportunity ${got.launch?.opportunityUt} (recorded ${recorded.launch?.opportunityUt}): ${same ? 'REPRODUCED' : 'DIFFERS'}`);
    if (!same) failures.push('findStartTime does not reproduce start-time.json: the start is re-derived and the mission re-proven on it (MIGRATION_V2 at 4.4)');
    if (!work) fs.rmSync(out);
  }
}

console.log(`
what the lead must re-baseline after the activation (MIGRATION_V2 principle 5, re-baseline 4; each behind its guard):
  - tests/mission/golden.json: the golden state hash (tolerance 1e-9 relative on positions: the Sun direction at
    the Earth changes by rounding through the inverted Almanac orbit) and tests/mission/trajectory-guard.json, with
    their pins in tools/dev/guard-pins.test.ts;
  - the QA scenarios (tools/sim/qaScenarios.ts re-captures them on the Sun-rooted library);
  - island-core's snapshot reference tests/unit/sim-world/viewReference.json (the bodies block now holds 32 bodies);
  - the sim-orbits tests that state the three-body library (Earth at the root without a sphere of influence, the
    Sun a light-only child on the Almanac formula): tests/unit/sim-orbits/bodies.test.ts and the fixtures' mainIds;
    the shipped behaviour of Earth and Moon is held by tests/unit/solar-system (start time, Sun direction, Horizons);
  - unchanged by design, and checked: the terrain guard (no tile changes), the reference images of Earth and Moon and
    the budget table (the activation package's gates), start-time.json (above).`);

if (work) {
  if (argv.has('--keep')) console.log(`\nthe dry run's layout is kept: ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
}
if (failures.length) {
  console.log(`\nFAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`\n${dryRun ? 'dry run passed: nothing was changed' : 'activated: data/defs holds the Sun-rooted library'}`);
