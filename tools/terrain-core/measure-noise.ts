/**
 * Measures the statistics of the terrain gradient noise (src/terrain/noise.ts) that the amplitude model is
 * normalised by: RMS value, RMS directional derivative per lattice unit, and the maximum |value|.
 *
 *   npx tsx tools/terrain-core/measure-noise.ts
 *
 * The printed numbers are the NOISE_RMS / NOISE_GRAD_RMS / NOISE_MAX constants in noise.ts (the unit test
 * tests/unit/terrain-core/noise.test.ts re-measures them on a smaller sample).
 */
import { Prng } from '../../src/core/math/hash';
import { GradientNoise3 } from '../../src/terrain/noise';

const samples = 1 << 22;
const rng = new Prng(12345);
let s2 = 0;
let g2 = 0;
let maxAbs = 0;
let sAbs = 0;
const h = 1e-4;
for (let k = 0; k < 64; k++) {
  const n = new GradientNoise3(1000 + k);
  const per = samples / 64;
  for (let i = 0; i < per; i++) {
    const x = rng.range(-1e6, 1e6);
    const y = rng.range(-1e6, 1e6);
    const z = rng.range(-1e6, 1e6);
    const v = n.value(x, y, z);
    s2 += v * v;
    sAbs += Math.abs(v);
    if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    // directional derivative along a random unit axis
    const a = rng.range(0, Math.PI * 2);
    const c = rng.range(-1, 1);
    const r = Math.sqrt(1 - c * c);
    const dx = r * Math.cos(a);
    const dy = r * Math.sin(a);
    const dz = c;
    const d = (n.value(x + dx * h, y + dy * h, z + dz * h) - n.value(x - dx * h, y - dy * h, z - dz * h)) / (2 * h);
    g2 += d * d;
  }
}
console.log(JSON.stringify({ samples, rms: Math.sqrt(s2 / samples), meanAbs: sAbs / samples, gradRms: Math.sqrt(g2 / samples), maxAbs }, null, 1));
