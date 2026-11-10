#!/usr/bin/env node
/**
 * Generates the source recordings listed in tools/audio/prompts.json with the ElevenLabs sound-effects
 * API (POST /v1/sound-generation) and records every take in tools/audio/manifest.json.
 *
 *   node tools/audio/generate.mjs                 generate everything that is missing
 *   node tools/audio/generate.mjs --only id,id    restrict to some ids
 *   node tools/audio/generate.mjs --force id      regenerate one id (the previous raw file is kept as .prev)
 *   node tools/audio/generate.mjs --dry-run       list what would be generated and the credit estimate
 *   node tools/audio/generate.mjs --max-credits N refuse to start when the estimate exceeds N (default 20000)
 *
 * Idempotent: an id is skipped when its raw file exists in data/cache/audio/elevenlabs/ or when the
 * manifest already records a take of the same prompt whose processed assets exist in public/assets/audio/.
 * The API key is read from .env inside this process only and is never printed or written.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readEnvKey, repoRoot } from './env.mjs';

const API = 'https://api.elevenlabs.io/v1/sound-generation';
const CREDITS_PER_SECOND_ESTIMATE = 40;
const promptsFile = path.join(repoRoot, 'tools', 'audio', 'prompts.json');
const manifestFile = path.join(repoRoot, 'tools', 'audio', 'manifest.json');
const rawDir = path.join(repoRoot, 'data', 'cache', 'audio', 'elevenlabs');
const assetsDir = path.join(repoRoot, 'public', 'assets', 'audio');

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = argValue('--only')?.split(',').filter(Boolean) ?? null;
const force = new Set(argValue('--force')?.split(',').filter(Boolean) ?? []);
const dryRun = args.includes('--dry-run');
const maxCredits = Number(argValue('--max-credits') ?? 20000);

const prompts = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { generator: 'elevenlabs sound-generation', takes: {} };

const EXT = (format) => (format.startsWith('pcm_') ? 'pcm' : format.startsWith('opus_') ? 'ogg' : format.startsWith('mp3_') ? 'mp3' : format.startsWith('wav_') ? 'wav' : 'bin');

function promptHash(sound, model, influence) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ prompt: sound.prompt, duration: sound.duration, loop: !!sound.loop, model, influence }))
    .digest('hex')
    .slice(0, 16);
}

function processedOutputsExist(sound) {
  if (sound.kind === 'multi') {
    for (let i = 1; i <= sound.split.count; i++) if (!fs.existsSync(path.join(assetsDir, `${sound.id}-${i}.flac`))) return false;
    return true;
  }
  return fs.existsSync(path.join(assetsDir, `${sound.id}.flac`));
}

function rawPathFor(id) {
  if (!fs.existsSync(rawDir)) return null;
  const hit = fs.readdirSync(rawDir).find((f) => f.startsWith(`${id}.`) && !f.endsWith('.prev'));
  return hit ? path.join(rawDir, hit) : null;
}

function writeManifest() {
  const tmp = `${manifestFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, manifestFile);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generate(sound, key) {
  const model = sound.model ?? prompts.model;
  const influence = sound.promptInfluence ?? prompts.promptInfluence;
  const body = { text: sound.prompt, duration_seconds: sound.duration, prompt_influence: influence, model_id: model, loop: !!sound.loop };
  const formats = manifest.outputFormat ? [manifest.outputFormat] : prompts.outputFormats;
  let lastError = '';
  for (const format of formats) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${API}?output_format=${encodeURIComponent(format)}`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: '*/*' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const bytes = Buffer.from(await res.arrayBuffer());
        fs.mkdirSync(rawDir, { recursive: true });
        const file = path.join(rawDir, `${sound.id}.${EXT(format)}`);
        fs.writeFileSync(file, bytes);
        manifest.outputFormat = format;
        manifest.takes[sound.id] = {
          prompt: sound.prompt,
          model,
          durationSeconds: sound.duration,
          loop: !!sound.loop,
          promptInfluence: influence,
          seed: null,
          seedNote: 'the sound-generation API takes no seed; this take is identified by rawSha256',
          take: (manifest.takes[sound.id]?.take ?? 0) + 1,
          promptHash: promptHash(sound, model, influence),
          outputFormat: format,
          rawFile: path.relative(repoRoot, file).replace(/\\/g, '/'),
          rawBytes: bytes.length,
          rawSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          requestId: res.headers.get('request-id') ?? res.headers.get('x-request-id') ?? null,
          characterCost: res.headers.get('character-cost') ?? res.headers.get('x-character-cost') ?? null,
          generatedAt: new Date().toISOString(),
        };
        writeManifest();
        return;
      }
      const text = (await res.text()).slice(0, 300);
      lastError = `HTTP ${res.status} ${text}`;
      if (res.status === 429 || res.status >= 500) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      break; // 4xx for this format: try the next format
    }
    if (!/HTTP (401|403|422|400)/.test(lastError)) break;
  }
  throw new Error(`${sound.id}: generation failed (${lastError})`);
}

const todo = [];
for (const sound of prompts.sounds) {
  if (only && !only.includes(sound.id)) continue;
  const model = sound.model ?? prompts.model;
  const influence = sound.promptInfluence ?? prompts.promptInfluence;
  if (!force.has(sound.id)) {
    if (rawPathFor(sound.id)) continue;
    const take = manifest.takes[sound.id];
    if (take && take.promptHash === promptHash(sound, model, influence) && processedOutputsExist(sound)) continue;
  } else {
    const prev = rawPathFor(sound.id);
    if (prev && !dryRun) fs.renameSync(prev, `${prev}.prev`);
  }
  todo.push(sound);
}

const estimate = todo.reduce((s, x) => s + CREDITS_PER_SECOND_ESTIMATE * x.duration, 0);
console.log(`generate: ${todo.length} sound(s) to generate, estimated ${estimate} credits (${CREDITS_PER_SECOND_ESTIMATE}/s upper bound)`);
for (const s of todo) console.log(`  ${s.id} (${s.duration} s${s.loop ? ', loop' : ''})`);
if (dryRun || todo.length === 0) process.exit(0);
if (estimate > maxCredits) {
  console.error(`generate: estimate ${estimate} exceeds --max-credits ${maxCredits}; nothing generated`);
  process.exit(1);
}

const key = readEnvKey('ELEVENLABS_API_KEY');
const failures = [];
const queue = todo.slice();
async function worker() {
  for (;;) {
    const sound = queue.shift();
    if (!sound) return;
    try {
      await generate(sound, key);
      console.log(`  ok ${sound.id}`);
    } catch (e) {
      failures.push(e.message);
      console.error(`  FAILED ${e.message}`);
    }
  }
}
await Promise.all([worker(), worker(), worker()]);
if (failures.length > 0) {
  console.error(`generate: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`generate: done (output format ${manifest.outputFormat})`);
