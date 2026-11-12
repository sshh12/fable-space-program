#!/usr/bin/env node
/**
 * Repository scan for unfinished work (lead-owned; PACKAGE_RULES rule 2: no placeholders, stubs, TODOs or
 * silent fallbacks). Fails when a tracked or untracked (not ignored) source or data file contains one of
 * the words
 *
 *     TODO   FIXME   stub   placeholder
 *
 * outside the allow-list tools/dev/check-stubs.allow.json. How a line is read:
 *  - `stub` and `placeholder` (with their plurals; stubbed, stubbing) count in any case and INSIDE
 *    identifiers: a line is split into identifier words (camelCase, snake_case, digits), so `stubSession`,
 *    `isPlaceholder`, `FAKE_STUB` and `placeholderMesh` are found and `stubborn` is not;
 *  - `TODO` and `FIXME` count as written anywhere, and in any case inside a comment (`// todo: ...`).
 * The allow-list holds the legitimate uses. The allow-list holds the legitimate uses, each with its reason: the
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
 * Allow-list entries: { "path": <file, a directory ending in "/", or "*" for any file>, "word"?: <one of the four, default
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

const WORD_NAMES = ['TODO', 'FIXME', 'stub', 'placeholder'];
const STUB_WORDS = new Set(['stub', 'stubs', 'stubbed', 'stubbing']);
const PLACEHOLDER_WORDS = new Set(['placeholder', 'placeholders']);

/** The words of a line's identifiers, lower-cased: fooBarBaz, foo_bar, FOO_BAR and HTTPServer2 are split. */
function identifierWords(line) {
  const words = [];
  for (const token of line.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    for (const w of token.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []) words.push(w.toLowerCase());
  }
  return words;
}

/** The comment part of each line of a file ('' where a line has none): line comments (two slashes, or a hash in scripts), HTML comments and block comments. */
function commentParts(file, lines) {
  const out = [];
  if (/\.json$/i.test(file)) return lines.map(() => '');
  if (/\.(py|sh|ya?ml|toml|ps1|dockerfile)$/i.test(file) || /(^|\/)Dockerfile$/.test(file)) {
    // Hash comments only (in these languages // and /* are operators or paths).
    for (const line of lines) out.push(/(^|\s)#(.*)$/.exec(line)?.[2] ?? '');
    return out;
  }
  // C-like and HTML: a comment opener counts only at the start of a line or after white space or
  // punctuation, so a glob ('src/**/*.ts'), a URL or a regular expression does not open one.
  const OPEN_BLOCK = /(^|[\s;,{}()])\/\*/;
  const OPEN_LINE = /(^|[\s;,{}()])\/\//;
  let inBlock = false;
  for (const line of lines) {
    let text = '';
    let rest = line;
    if (inBlock) {
      const end = rest.indexOf('*/');
      if (end < 0) {
        out.push(rest);
        continue;
      }
      text += rest.slice(0, end);
      rest = rest.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const block = OPEN_BLOCK.exec(rest);
      const lineComment = OPEN_LINE.exec(rest);
      if (block && (!lineComment || block.index < lineComment.index)) {
        const start = block.index + block[0].length;
        const end = rest.indexOf('*/', start);
        if (end < 0) {
          text += ` ${rest.slice(start)}`;
          inBlock = true;
          break;
        }
        text += ` ${rest.slice(start, end)}`;
        rest = rest.slice(end + 2);
        continue;
      }
      if (lineComment) text += ` ${rest.slice(lineComment.index + lineComment[0].length)}`;
      break;
    }
    const html = /<!--(.*?)(-->|$)/.exec(line);
    if (html) text += ` ${html[1]}`;
    out.push(text);
  }
  return out;
}

/** The words of the scan that a line contains. */
function wordsIn(line, comment) {
  const found = [];
  if (/\bTODO\b/.test(line) || /\btodo\b/i.test(comment)) found.push('TODO');
  if (/\bFIXME\b/.test(line) || /\bfixme\b/i.test(comment)) found.push('FIXME');
  const words = identifierWords(line);
  if (words.some((w) => STUB_WORDS.has(w))) found.push('stub');
  if (words.some((w) => PLACEHOLDER_WORDS.has(w))) found.push('placeholder');
  return found;
}

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
    const comments = commentParts(file, lines);
    for (let i = 0; i < lines.length; i++) {
      for (const word of wordsIn(lines[i], comments[i])) findings.push({ file, line: i + 1, word, text: lines[i].trim().slice(0, 200) });
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
        (a.path === '*' || (a.path.endsWith('/') ? f.file.startsWith(a.path) : f.file === a.path)) &&
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
    if (a.word !== undefined && !WORD_NAMES.includes(a.word)) throw new Error(`allow-list entry has an unknown "word": ${JSON.stringify(a)}`);
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
