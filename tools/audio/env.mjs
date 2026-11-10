/**
 * Reads a single key from the repository's .env for the audio build tools. The value is returned to the
 * caller only; it is never printed, logged or written anywhere. Build-time use only (never import this
 * from src/ or public/).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readEnvKey(name) {
  const envPath = path.join(repoRoot, '.env');
  if (!fs.existsSync(envPath)) throw new Error(`.env not found at the repository root (needed for ${name})`);
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (key !== name) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value === '') break;
    return value;
  }
  throw new Error(`${name} is not set in .env`);
}
