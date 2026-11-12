#!/usr/bin/env node
/**
 * `npm run stack`: the one-command local stack (ARCHITECTURE 16.4), lead-owned entry.
 *
 *   npm run stack -- [options] -- <command>   take the ONE stack slot, bring the stack up, run <command> with
 *                                             STACK_URL, STACK_ENDPOINTS and STACK_STATE set, bring it down
 *   npm run stack -- [options]                the same without a command: stays in the foreground until interrupted
 *   npm run stack -- status                   what runs, with its memory (takes no slot)
 *   npm run stack -- down                     clean up after a launcher that died (takes no slot)
 *
 * This script only wraps the launcher, deploy/local/stack.mjs (written by the `platform-delivery` package),
 * in the heavy-job gate:
 *
 *   node tools/dev/heavy.mjs --class=stack -- node deploy/local/stack.mjs [options] [-- <command>]
 *
 * The launcher is the wrapped command, so the slot is held for exactly as long as a stack is up; there is no
 * background mode, and a second `npm run stack` waits for the first to finish. `status` and `down` talk to
 * a running or dead stack and therefore do not wait for the slot.
 *
 * Options are the launcher's (--shape, --rules, --fresh, --db, --page, --profile, --compose; STACK_NAME in
 * the environment names the state directory data/stack/<name>).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const launcher = path.join(repoRoot, 'deploy', 'local', 'stack.mjs');
const args = process.argv.slice(2);

if (!fs.existsSync(launcher)) {
  console.error(
    'stack: the launcher deploy/local/stack.mjs does not exist yet. It is written by the platform-delivery package (wave 3);\n' +
      '       this script will run it as: node tools/dev/heavy.mjs --class=stack -- node deploy/local/stack.mjs [options] [-- <command>]',
  );
  process.exit(3);
}

const direct = args[0] === 'status' || args[0] === 'down';
const argv = direct
  ? [launcher, ...args]
  : [path.join(repoRoot, 'tools', 'dev', 'heavy.mjs'), '--class=stack', `--label=stack ${process.env.STACK_NAME ?? ''} ${args.join(' ')}`.trim().slice(0, 120), '--', 'node', 'deploy/local/stack.mjs', ...args];
const res = spawnSync(process.execPath, argv, { cwd: repoRoot, stdio: 'inherit' });
process.exit(res.status ?? 1);
