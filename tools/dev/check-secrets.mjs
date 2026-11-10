#!/usr/bin/env node
/**
 * Fails if any secret value from .env appears in a file that is tracked by git, is about to be tracked
 * (untracked and not ignored), or is shipped to the browser (public/**, dist/**). Lead-owned.
 *
 *   node tools/dev/check-secrets.mjs        (also part of `npm run check`)
 *
 * Every package whose tools read .env (audio, terrain-render, vehicle-pad, cockpit) runs this before each
 * commit. The secret values themselves are never printed: only the variable name and the offending path.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_BYTES = 64 * 1024 * 1024;

function readSecrets() {
  const envPath = path.join(repoRoot, '.env');
  if (!fs.existsSync(envPath)) return [];
  const out = [];
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    // Short values (flags, ports) cannot be told apart from ordinary text; real keys are long.
    if (value.length >= 12) out.push({ name, needle: Buffer.from(value, 'utf8') });
  }
  return out;
}

function gitFiles() {
  const res = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) return [];
  return res.stdout
    .toString('utf8')
    .split('\0')
    .filter((f) => f !== '');
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(path.relative(repoRoot, p).replace(/\\/g, '/'));
  }
  return out;
}

const secrets = readSecrets();
if (secrets.length === 0) {
  console.log('check-secrets: no .env values to check (nothing to do)');
  process.exit(0);
}

const candidates = new Set([...gitFiles(), ...walk(path.join(repoRoot, 'public'), []), ...walk(path.join(repoRoot, 'dist'), [])]);
candidates.delete('.env');

const hits = [];
let scanned = 0;
for (const rel of candidates) {
  const file = path.join(repoRoot, rel);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    continue;
  }
  if (!st.isFile() || st.size > MAX_BYTES) continue;
  const data = fs.readFileSync(file);
  scanned++;
  for (const s of secrets) if (data.includes(s.needle)) hits.push(`${rel}: contains the value of ${s.name}`);
}

if (hits.length > 0) {
  console.error(`check-secrets: FAILED - ${hits.length} file(s) contain a secret from .env:`);
  for (const h of hits) console.error(`  ${h}`);
  console.error('Remove the value (and rotate the key if the file was ever committed or shipped).');
  process.exit(1);
}
console.log(`check-secrets: OK (${secrets.length} secret(s) checked against ${scanned} tracked, untracked and shipped files)`);
