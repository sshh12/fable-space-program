#!/usr/bin/env node
/**
 * Spectrogram PNGs of WAV files for reviewers who cannot listen: log-frequency axis 20 Hz - 20 kHz,
 * dBFS colour scale, the mono (L + R) / 2 mix, plus a level trace (short-term RMS) underneath.
 *
 *   node tools/audio/spectrogram.mjs out/audio/*.wav        -> out/audio/spectrograms/<name>.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { fft } from './dsp.mjs';
import { repoRoot } from './env.mjs';

const W = 1000;
const H = 300;
const TRACE = 80;
const FMIN = 20;
const FMAX = 20000;
const DB_MIN = -100;
const DB_MAX = -10;

function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAV file`);
  let off = 12;
  let fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 16) throw new Error(`${file}: only 16-bit PCM is supported`);
      const frames = size / (2 * fmt.channels);
      const x = new Float64Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) s += b.readInt16LE(off + 8 + (i * fmt.channels + c) * 2);
        x[i] = s / fmt.channels / 32768;
      }
      return { x, rate: fmt.rate };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error(`${file}: no data chunk`);
}

/** Perceptual colour map (black - purple - red - orange - yellow - white). */
function colour(t) {
  const stops = [
    [0, [0, 0, 4]],
    [0.25, [72, 12, 104]],
    [0.5, [190, 40, 70]],
    [0.75, [250, 140, 20]],
    [0.92, [252, 230, 90]],
    [1, [255, 255, 255]],
  ];
  const v = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    const [t0, c0] = stops[i - 1];
    if (v <= t1) {
      const u = (v - t0) / (t1 - t0);
      return c0.map((c, k) => Math.round(c + (c1[k] - c) * u));
    }
  }
  return [255, 255, 255];
}

function render(file) {
  const { x, rate } = readWav(file);
  const n = 4096;
  const hop = Math.max(1, Math.floor((x.length - n) / W));
  const png = new PNG({ width: W, height: H + TRACE });
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const norm = n / 4; // Hann-windowed full-scale sine -> 0 dBFS
  const traceDb = [];
  for (let col = 0; col < W; col++) {
    const start = col * hop;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const v = x[start + i] ?? 0;
      re[i] = v * win[i];
      ss += v * v;
    }
    traceDb.push(10 * Math.log10(Math.max(1e-12, ss / n)));
    fft(re, im);
    for (let row = 0; row < H; row++) {
      const f0 = FMIN * (FMAX / FMIN) ** ((H - 1 - row) / H);
      const f1 = FMIN * (FMAX / FMIN) ** ((H - row) / H);
      const k0 = Math.max(1, Math.floor((f0 * n) / rate));
      const k1 = Math.max(k0, Math.min(n / 2 - 1, Math.ceil((f1 * n) / rate)));
      let p = 0;
      for (let k = k0; k <= k1; k++) p = Math.max(p, Math.hypot(re[k], im[k]) / norm);
      const db = 20 * Math.log10(Math.max(1e-9, p));
      const [r, g, b] = colour((db - DB_MIN) / (DB_MAX - DB_MIN));
      const o = (row * W + col) * 4;
      png.data[o] = r;
      png.data[o + 1] = g;
      png.data[o + 2] = b;
      png.data[o + 3] = 255;
    }
  }
  // Level trace: short-term RMS from -60 to 0 dBFS, with grid lines every 10 dB.
  for (let row = 0; row < TRACE; row++) {
    for (let col = 0; col < W; col++) {
      const o = ((H + row) * W + col) * 4;
      const levelRow = Math.round(((-traceDb[col]) / 60) * (TRACE - 1));
      const grid = row % Math.round(TRACE / 6) === 0;
      const on = row >= Math.min(TRACE - 1, Math.max(0, levelRow));
      const c = on ? [90, 180, 240] : grid ? [40, 40, 50] : [12, 12, 16];
      png.data[o] = c[0];
      png.data[o + 1] = c[1];
      png.data[o + 2] = c[2];
      png.data[o + 3] = 255;
    }
  }
  // Octave tick marks on the left edge (100 Hz, 1 kHz, 10 kHz brighter).
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const row = Math.round(H - 1 - (H * Math.log(f / FMIN)) / Math.log(FMAX / FMIN));
    const bright = f === 100 || f === 1000 || f === 10000;
    for (let col = 0; col < (bright ? 18 : 8); col++) {
      const o = (row * W + col) * 4;
      png.data[o] = png.data[o + 1] = png.data[o + 2] = 255;
    }
  }
  const outDir = path.join(path.dirname(file), 'spectrograms');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${path.basename(file, '.wav')}.png`);
  fs.writeFileSync(out, PNG.sync.write(png));
  return out;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node tools/audio/spectrogram.mjs <file.wav> [...]');
  process.exit(2);
}
for (const f of files) console.log(path.relative(repoRoot, render(path.resolve(f))));
