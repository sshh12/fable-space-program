#!/usr/bin/env node
/**
 * Repository scan for unfinished work (lead-owned; PACKAGE_RULES rule 2: no placeholders, stubs, TODOs or
 * silent fallbacks). Fails when a tracked or untracked (not ignored) source or data file contains one of
 * the words
 *
 *     TODO   FIXME   stub   placeholder
 *
 * (whole words; `stub` and `placeholder` in any case and with their plurals) outside the allow-list
 * tools/dev/check-stubs.allow.json. The allow-list holds the legitimate uses, each with its reason: the
 * placeholder visuals PROMPT.txt permits for the simple bodies, the HTML `placeholder` attribute, test
 * doubles named stubs by their framework, and sentences that state the rule itself.
 *
 *   node tools/dev/check-stubs.mjs            scan; exit 1 on a finding or on an allow-list entry nothing uses
 *   node tools/dev/check-stubs.mjs --list     print every finding with the entry that allows it
 *
 * Scanned: src/, server/, bots/, deploy/, tools/, labs/, tests/, data/defs/, data/staged/, public/ (text
 * files), index.html and the root configuration. Not scanned: docs/ (it states the rule and quotes
 * requests), binary files, files over 2 MB, and this tool's own files (with its test, which plants the words).
 *
 * Allow-list entries: { "path": <file, or a directory ending in "/">, "word"?: <one of the four, default
 * any>, "contains"?: <text the line must contain>, "except"?: [<path prefixes the entry does not cover>],
 * "standing"?: true, "reason": <why this is not unfinished work> }. An entry that matches nothing is an error (the list must not outlive what it excuses), unless it
 * is "standing": a permission that holds for a whole directory whether or not a file uses it today.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOW_FILE = path.join(repoRoot, 'tools', 'dev', 'check-stubs.allow.json');

const SCAN = ['src/', 'server/', 'bots/', 'deploy/', 'tools/', 'labs/', 'tests/', 'data/defs/', 'data/staged/', 'public/'];
const ROOT_FILES = ['index.html', 'package.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts'];
const SELF = ['tools/dev/check-stubs.mjs', 'tools/dev/check-stubs.allow.json', 'tools/dev/rootConfig.test.ts'];
const TEXT = /\.(ts|tsx|mts|mjs|cjs|js|json|html|css|wgsl|py|md|txt|yml|yaml|toml|sql|sh|ps1|dockerfile)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

const WORDS = [
  ['TODO', /\bTODO\b/],
  ['FIXME', /\bFIXME\b/],
  ['stub', /\bstub(s|bed|bing)?\b/i],
  ['placeholder', /\bplaceholders?\b/i],
];

function listFiles() {
  const res = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) {
    console.error(`check-stubs: git ls-files failed: ${res.stderr}`);
    process.exit(2);
  }
  return res.stdout
    .split('\0')
    .filter((f) => f !== '')
    .filter((f) => (SCAN.some((d) => f.startsWith(d)) || ROOT_FILES.includes(f)) && !SELF.includes(f))
    .filter((f) => TEXT.test(f) || /(^|\/)Dockerfile$/.test(f));
}

/** Every line of the repository that contains one of the words: { file, line, word, text }. */
export function scan(files = listFiles(), read = (f) => fs.readFileSync(path.join(repoRoot, f), 'utf8'), size = (f) => fs.statSync(path.join(repoRoot, f)).size) {
  const findings = [];
  for (const file of files) {
    let text;
    try {
      if (size(file) > MAX_BYTES) continue;
      text = read(file);
    } catch (e) {
      if (e.code === 'ENOENT') continue; // listed by git, deleted in the working tree
      throw e;
    }
    if (text.includes('\0')) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const [word, re] of WORDS) {
        if (re.test(lines[i])) findings.push({ file, line: i + 1, word, text: lines[i].trim().slice(0, 200) });
      }
    }
  }
  return findings;
}

/** Split findings into allowed and not; also report allow-list entries that matched nothing. */
export function judge(findings, allow) {
  const used = new Array(allow.length).fill(false);
  const open = [];
  const allowed = [];
  for (const f of findings) {
    const i = allow.findIndex(
      (a) =>
        (a.path.endsWith('/') ? f.file.startsWith(a.path) : f.file === a.path) &&
        !(a.except ?? []).some((x) => f.file.startsWith(x)) &&
        (a.word === undefined || a.word === f.word) &&
        (a.contains === undefined || f.text.includes(a.contains)),
    );
    if (i < 0) open.push(f);
    else {
      used[i] = true;
      allowed.push({ ...f, reason: allow[i].reason });
    }
  }
  return { open, allowed, stale: allow.filter((a, i) => !used[i] && a.standing !== true) };
}

function loadAllow() {
  const allow = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8'));
  if (!Array.isArray(allow)) throw new Error('check-stubs.allow.json must be an array');
  for (const a of allow) {
    if (typeof a.path !== 'string' || typeof a.reason !== 'string' || a.reason.trim() === '') throw new Error(`allow-list entry needs "path" and "reason": ${JSON.stringify(a)}`);
    if (a.word !== undefined && !WORDS.some(([w]) => w === a.word)) throw new Error(`allow-list entry has an unknown "word": ${JSON.stringify(a)}`);
  }
  return allow;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { open, allowed, stale } = judge(scan(), loadAllow());
  if (process.argv.includes('--list')) {
    for (const f of allowed) console.log(`allowed  ${f.file}:${f.line} [${f.word}] ${f.text}\n         (${f.reason})`);
  }
  for (const f of open) console.error(`${f.file}:${f.line} [${f.word}] ${f.text}`);
  for (const a of stale) console.error(`allow-list entry matches nothing (remove it): ${JSON.stringify(a)}`);
  if (open.length > 0 || stale.length > 0) {
    console.error(`check-stubs: ${open.length} finding(s), ${stale.length} stale allow-list entr${stale.length === 1 ? 'y' : 'ies'}. Finish the work, or state it in the hand-off and remove the marker.`);
    process.exit(1);
  }
  console.log(`check-stubs: OK (${allowed.length} allowed use(s) of the four words)`);
}
