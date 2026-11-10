#!/usr/bin/env node
/**
 * Type-check the whole project but only FAIL on diagnostics inside the given path prefixes.
 * Lets a team verify its own directories while other teams' work in progress is temporarily broken.
 *
 *   npm run typecheck:paths -- src/sim/orbit src/sim/frames tests/unit/orbit
 *
 * Diagnostics elsewhere are summarised (count per top-level area) but do not affect the exit code.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const prefixes = process.argv.slice(2).map((p) => p.replace(/\\/g, '/').replace(/\/+$/, ''));
if (prefixes.length === 0) {
  console.error('usage: typecheck-paths <path-prefix> [...]');
  process.exit(2);
}

const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const res = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', path.join(repoRoot, 'tsconfig.json')], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});
const lines = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.split(/\r?\n/);

const mine = [];
const foreign = new Map();
let current = null;
for (const line of lines) {
  const m = /^(.+?)\((\d+),(\d+)\): (error|warning) TS\d+:/.exec(line);
  if (m) {
    const file = path.relative(repoRoot, path.resolve(repoRoot, m[1])).replace(/\\/g, '/');
    const own = prefixes.some((p) => file === p || file.startsWith(`${p}/`));
    current = own ? mine : null;
    if (own) mine.push(line);
    else {
      const area = file.split('/').slice(0, 2).join('/');
      foreign.set(area, (foreign.get(area) ?? 0) + 1);
    }
  } else if (current && line.startsWith(' ')) {
    current.push(line);
  }
}

if (foreign.size > 0) {
  const summary = [...foreign.entries()].map(([a, n]) => `${a}: ${n}`).join(', ');
  console.log(`(ignored diagnostics outside your paths: ${summary})`);
}
if (mine.length > 0) {
  console.log(mine.join('\n'));
  console.log(`\n${mine.filter((l) => !l.startsWith(' ')).length} error(s) in ${prefixes.join(', ')}`);
  process.exit(1);
}
if (res.status !== 0 && foreign.size === 0) {
  // tsc failed for a reason that is not a file diagnostic (bad config, crash): surface it.
  console.log(lines.join('\n'));
  process.exit(res.status ?? 1);
}
console.log(`typecheck OK for ${prefixes.join(', ')}`);
