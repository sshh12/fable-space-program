#!/usr/bin/env node
/**
 * Blocking helper for the change-request queue in docs/requests/ (see docs/requests/README.md). Lead-owned.
 *
 * Maintainer side (the package that owns the shared code during a wave):
 *   node tools/dev/wait-requests.mjs --open [--until <file>[,<file>...]] [--timeout 540]
 *     returns as soon as at least one request has `Status: open`, printing `OPEN <path>` per request;
 *     prints `ALL_DONE` when no request is open AND every --until file exists (the other packages' hand-offs);
 *     prints `TIMEOUT` after --timeout seconds with nothing to do.
 *
 * Requester side:
 *   node tools/dev/wait-requests.mjs --resolved docs/requests/<package>-<n>.md [--timeout 540]
 *     returns when that request is no longer open, printing its status line; `TIMEOUT` otherwise.
 *
 * Always exits 0 (the printed keyword is the result) so it can be used inside agent tool calls; run it with
 * a tool timeout a little above --timeout. Polls the working tree, so requests are visible as soon as the
 * file is written, before any commit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.join(repoRoot, 'docs', 'requests');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? '') : null;
};
const timeoutS = Number(flag('--timeout') ?? 540);
const until = (flag('--until') ?? '').split(',').filter((s) => s !== '');
const resolvedOf = flag('--resolved');
const wantOpen = args.includes('--open');

if (!wantOpen && !resolvedOf) {
  console.error('usage: wait-requests --open [--until a,b] [--timeout s]   |   wait-requests --resolved <request.md> [--timeout s]');
  process.exit(2);
}

/** First `Status:` line of a request file, lower-cased keyword and the full line. */
function readStatus(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const m = /^Status:\s*(\w+)(.*)$/im.exec(text);
  return m ? { keyword: m[1].toLowerCase(), line: m[0].trim() } : { keyword: 'open', line: 'Status: open (no status line found)' };
}

function openRequests() {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.md') && n.toLowerCase() !== 'readme.md')
    .sort()
    .filter((n) => readStatus(path.join(dir, n))?.keyword === 'open')
    .map((n) => `docs/requests/${n}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + timeoutS * 1000;

for (;;) {
  if (resolvedOf) {
    const st = readStatus(path.resolve(repoRoot, resolvedOf));
    if (st && st.keyword !== 'open') {
      console.log(st.line);
      break;
    }
  } else {
    const open = openRequests();
    if (open.length > 0) {
      for (const o of open) console.log(`OPEN ${o}`);
      break;
    }
    if (until.length > 0 && until.every((f) => fs.existsSync(path.resolve(repoRoot, f)))) {
      console.log('ALL_DONE');
      break;
    }
  }
  if (Date.now() >= deadline) {
    console.log('TIMEOUT');
    break;
  }
  await sleep(5000);
}
