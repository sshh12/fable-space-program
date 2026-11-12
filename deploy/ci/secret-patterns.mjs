#!/usr/bin/env node
/**
 * The secrets check that works where `.env` is absent (CI). tools/dev/check-secrets.mjs compares every file with
 * the values in this machine's .env; CI has no .env (and must never get one), so there it would compare with
 * nothing. This scan looks instead for the SHAPE of a credential in every tracked file:
 *  - well-known key formats (AWS access key ids, OpenAI, Hugging Face, GitHub, Slack, Stripe tokens, PEM
 *    private keys);
 *  - a long, high-entropy value assigned to a name that says secret, token, password, private key or access
 *    key (JSON, YAML, .env and code assignments).
 * Prints the file and line and the kind of finding, never the value. Exit 1 on any finding.
 *
 *   node deploy/ci/secret-patterns.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KNOWN = [
  ['aws access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['openai key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['hugging face token', /\bhf_[A-Za-z0-9]{30,}\b/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/],
  ['stripe key', /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ['private key', /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
];
const NAMED = /\b([A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*)["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_\-.]{20,})/i;

function entropy(s) {
  const n = new Map();
  for (const ch of s) n.set(ch, (n.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of n.values()) h -= (c / s.length) * Math.log2(c / s.length);
  return h;
}

const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
  .stdout.toString('utf8')
  .split('\0')
  .filter((f) => f && !/\.(png|jpe?g|webp|ktx2|ogg|opus|mp3|wav|bin|hgt|u8|f32|rgb9e5|pack|idx|woff2?|ico|glb)$/i.test(f) && !/(^|\/)package-lock\.json$/.test(f));
const findings = [];
for (const f of files) {
  const abs = path.join(repoRoot, f);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    continue;
  }
  if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [kind, re] of KNOWN) if (re.test(line)) findings.push(`${f}:${i + 1} ${kind}`);
    const m = NAMED.exec(line);
    if (m) {
      const value = m[3];
      // A value with the spread of a random key: long and high-entropy, not an identifier or a sentence.
      if (value.length >= 24 && entropy(value) >= 4.0 && /[0-9]/.test(value) && /[A-Za-z]/.test(value)) findings.push(`${f}:${i + 1} ${m[1]} holds a high-entropy value`);
    }
  });
}
if (findings.length > 0) {
  console.error(`secret-patterns: ${findings.length} finding(s) (values not printed):\n  ${findings.join('\n  ')}`);
  process.exit(1);
}
console.log(`secret-patterns: OK (${files.length} files scanned)`);
