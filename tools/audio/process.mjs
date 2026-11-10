#!/usr/bin/env node
/**
 * Turns the generated source recordings (data/cache/audio/elevenlabs/, see generate.mjs) into the shipped
 * assets under public/assets/audio/ and writes tools/audio/assets-report.json with the measured numbers.
 *
 *   node tools/audio/process.mjs            process every take whose output is missing or out of date
 *   node tools/audio/process.mjs --all      re-process everything
 *
 * Every take is first high-passed at prompts.highpassHz (zero-phase Butterworth: no infrasound, no DC).
 * Per kind (tools/audio/prompts.json):
 *   loop     edge trim, equal-power crossfade into a seamless loop, integrated loudness
 *            normalised to targets.loopLufs (BS.1770-4), sample peak capped at targets.peakDbfs
 *   oneshot  silence trim with short fades, maximum momentary loudness normalised to
 *            targets.oneshotLufs, peak cap
 *   multi    split at silences into <id>-1..n, each processed as a one-shot
 * Output: 48 kHz 16-bit FLAC, mono (stereo for loops marked channels: 2) (TPDF dither), decodable by every browser's decodeAudioData.
 * Idempotent: an output is rebuilt only when its raw file's sha256 or the processing parameters change.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './env.mjs';
import {
  SAMPLE_RATE,
  integratedLufs,
  loopSeam,
  makeLoop,
  maxMomentaryLufs,
  peak,
  highpassZeroPhase,
  rms,
  scale,
  spectralCentroid,
  splitAtSilence,
  toInt16,
  trimOneShot,
} from './dsp.mjs';

const PROCESS_VERSION = 5;
const prompts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tools', 'audio', 'prompts.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tools', 'audio', 'manifest.json'), 'utf8'));
const outDir = path.join(repoRoot, 'public', 'assets', 'audio');
const reportFile = path.join(repoRoot, 'tools', 'audio', 'assets-report.json');
const all = process.argv.includes('--all');
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { assets: {} };

/** Raw take -> channel arrays at 48 kHz. ElevenLabs pcm_48000 output is interleaved stereo s16le. */
function decodeRaw(take) {
  const file = path.join(repoRoot, take.rawFile);
  if (!fs.existsSync(file)) throw new Error(`raw file missing: ${take.rawFile} (run tools/audio/generate.mjs)`);
  if (take.outputFormat.startsWith('pcm_')) {
    const rate = Number(take.outputFormat.split('_')[1]);
    if (rate !== SAMPLE_RATE) throw new Error(`${take.rawFile}: expected ${SAMPLE_RATE} Hz PCM, got ${rate}`);
    const pcm = fs.readFileSync(file);
    const n = pcm.length >> 2;
    const L = new Float64Array(n);
    const R = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = pcm.readInt16LE(i * 4) / 32768;
      R[i] = pcm.readInt16LE(i * 4 + 2) / 32768;
    }
    return [L, R];
  }
  const res = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '2', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  if (res.status !== 0) throw new Error(`ffmpeg decode of ${take.rawFile} failed: ${res.stderr}`);
  const buf = new Float32Array(res.stdout.buffer, res.stdout.byteOffset, res.stdout.length / 4);
  const n = buf.length >> 1;
  const L = new Float64Array(n);
  const R = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = buf[2 * i];
    R[i] = buf[2 * i + 1];
  }
  return [L, R];
}

const mid = ([L, R]) => {
  const m = new Float64Array(L.length);
  for (let i = 0; i < L.length; i++) m[i] = 0.5 * (L[i] + R[i]);
  return m;
};

/** L/R correlation of a stereo take (1 = mono, 0 = decorrelated, < 0 = phase problems in a mono downmix). */
function correlation([L, R]) {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < L.length; i++) {
    lr += L[i] * R[i];
    ll += L[i] * L[i];
    rr += R[i] * R[i];
  }
  return ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 1;
}

function normalise(x, targetLufs, measure) {
  const lufs = measure(x);
  let g = 10 ** ((targetLufs - lufs) / 20);
  const peakCap = 10 ** (prompts.targets.peakDbfs / 20);
  const p = peak(x) * g;
  let limited = false;
  if (p > peakCap) {
    g *= peakCap / p;
    limited = true;
  }
  return { y: scale(x, g), gainDb: 20 * Math.log10(g), sourceLufs: lufs, peakLimited: limited };
}

/** Encode one or two channels (Float64Array each) to 16-bit FLAC. */
function encodeFlac(channels, file, seed) {
  const n = channels[0].length;
  const inter = new Float64Array(n * channels.length);
  for (let c = 0; c < channels.length; c++) for (let i = 0; i < n; i++) inter[i * channels.length + c] = channels[c][i];
  const pcm = toInt16(inter, seed);
  const res = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(channels.length), '-i', '-', '-c:a', 'flac', '-compression_level', '12', '-map_metadata', '-1', file],
    { input: pcm, maxBuffer: 1 << 28 },
  );
  if (res.status !== 0) throw new Error(`ffmpeg flac encode of ${file} failed: ${res.stderr}`);
}

function stats(y, extra) {
  const r = rms(y);
  return {
    durationS: +(y.length / SAMPLE_RATE).toFixed(3),
    peakDbfs: +(20 * Math.log10(peak(y))).toFixed(2),
    rmsDbfs: +(20 * Math.log10(r)).toFixed(2),
    integratedLufs: +integratedLufs(y).toFixed(2),
    maxMomentaryLufs: +maxMomentaryLufs(y).toFixed(2),
    spectralCentroidHz: Math.round(spectralCentroid(y)),
    ...extra,
  };
}

fs.mkdirSync(outDir, { recursive: true });
let built = 0;
let skipped = 0;
for (const sound of prompts.sounds) {
  const take = manifest.takes[sound.id];
  if (!take) throw new Error(`${sound.id}: no take in manifest.json (run tools/audio/generate.mjs)`);
  const paramHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ v: PROCESS_VERSION, kind: sound.kind, channels: sound.channels ?? 1, crossfade: sound.crossfade, split: sound.split, targets: prompts.targets, highpassHz: prompts.highpassHz, raw: take.rawSha256 }))
    .digest('hex')
    .slice(0, 16);
  const outIds = sound.kind === 'multi' ? Array.from({ length: sound.split.count }, (_, i) => `${sound.id}-${i + 1}`) : [sound.id];
  const upToDate = outIds.every((id) => report.assets[id]?.paramHash === paramHash && fs.existsSync(path.join(outDir, `${id}.flac`)));
  if (upToDate && !all) {
    skipped++;
    continue;
  }
  const raw = decodeRaw(take).map((c) => highpassZeroPhase(c, prompts.highpassHz));
  const stereo = (sound.channels ?? 1) === 2;
  if (stereo && sound.kind !== 'loop') throw new Error(`${sound.id}: only loops may be stereo`);
  const corr = correlation(raw);
  const x = mid(raw);
  const results = [];
  if (sound.kind === 'loop') {
    const chans = stereo ? raw.map((c) => makeLoop(c, sound.crossfade)) : [makeLoop(x, sound.crossfade)];
    const lufsMeasure = (c) => (stereo ? integratedLufs(mid(c)) + 10 * Math.log10(2) : integratedLufs(c[0]));
    const lufs = lufsMeasure(chans);
    let g = 10 ** ((prompts.targets.loopLufs - lufs) / 20);
    const p = Math.max(...chans.map(peak)) * g;
    const cap = 10 ** (prompts.targets.peakDbfs / 20);
    const limited = p > cap;
    if (limited) g *= cap / p;
    const out = chans.map((c) => scale(c, g));
    results.push({ id: sound.id, chans: out, extra: { kind: 'loop', channels: out.length, gainDb: +(20 * Math.log10(g)).toFixed(2), peakLimited: limited, seam: loopSeam(out.length === 2 ? mid(out) : out[0]) } });
  } else if (sound.kind === 'oneshot') {
    const n = normalise(trimOneShot(x), prompts.targets.oneshotLufs, maxMomentaryLufs);
    results.push({ id: sound.id, chans: [n.y], extra: { kind: 'oneshot', channels: 1, gainDb: +n.gainDb.toFixed(2), peakLimited: n.peakLimited } });
  } else if (sound.kind === 'multi') {
    const parts = splitAtSilence(x, sound.split);
    parts.forEach((p, i) => {
      const n = normalise(trimOneShot(p, { preRoll: 0.002, fadeIn: 0.001, fadeOut: 0.02 }), prompts.targets.oneshotLufs, maxMomentaryLufs);
      results.push({ id: `${sound.id}-${i + 1}`, chans: [n.y], extra: { kind: 'oneshot', channels: 1, splitFrom: sound.id, gainDb: +n.gainDb.toFixed(2), peakLimited: n.peakLimited } });
    });
  } else throw new Error(`${sound.id}: unknown kind ${sound.kind}`);
  for (const r of results) r.extra.sourceStereoCorrelation = +corr.toFixed(3);
  for (const r of results) {
    const file = path.join(outDir, `${r.id}.flac`);
    encodeFlac(r.chans, file, parseInt(take.rawSha256.slice(0, 8), 16));
    const bytes = fs.statSync(file).size;
    report.assets[r.id] = {
      file: `${r.id}.flac`,
      source: sound.id,
      prompt: take.prompt,
      rawSha256: take.rawSha256,
      paramHash,
      bytes,
      ...stats(r.chans.length === 2 ? mid(r.chans) : r.chans[0], r.extra),
    };
    console.log(`  ${r.id}: ${report.assets[r.id].durationS} s, ${(bytes / 1024).toFixed(0)} KiB, peak ${report.assets[r.id].peakDbfs} dBFS`);
    built++;
  }
}

const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.flac'));
const known = new Set(Object.values(report.assets).map((a) => a.file));
for (const f of files) if (!known.has(f)) console.warn(`  note: ${f} in public/assets/audio is not produced by this pipeline`);
const totalBytes = files.reduce((s, f) => s + fs.statSync(path.join(outDir, f)).size, 0);
report.totalBytes = totalBytes;
report.totalMiB = +(totalBytes / 1048576).toFixed(2);
report.format = 'FLAC, 48 kHz, 16-bit (TPDF dither); mono except loops marked channels: 2';
report.licence =
  'Generated with the ElevenLabs sound-effects API (eleven_text_to_sound_v2) on a paid plan; ElevenLabs terms grant the subscriber commercial use of generated sound effects. No third-party recordings are included.';
report.assets = Object.fromEntries(Object.entries(report.assets).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(`process: ${built} asset(s) built, ${skipped} source(s) up to date, total ${report.totalMiB} MiB in ${files.length} files`);
if (totalBytes > 40 * 1048576) {
  console.error('process: total asset size exceeds the 40 MB budget');
  process.exit(1);
}
