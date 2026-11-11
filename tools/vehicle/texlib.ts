/**
 * Small procedural texture toolkit for the vehicle material bake: tileable value noise, fractal sums,
 * periodic Worley cells, height -> normal conversion and PNG output. Deterministic (integer hash, fixed
 * seeds); every generator is periodic over the tile so the textures repeat without seams.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

export const mod = (a: number, n: number): number => ((a % n) + n) % n;
export const clamp = (x: number, lo = 0, hi = 1): number => (x < lo ? lo : x > hi ? hi : x);
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 362437)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Value noise with quintic interpolation, periodic over (px, py) lattice cells. Returns 0..1. */
export function vnoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const x0 = mod(xi, px);
  const x1 = mod(xi + 1, px);
  const y0 = mod(yi, py);
  const y1 = mod(yi + 1, py);
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return mix(mix(a, b, u), mix(c, d, u), v);
}

/** Fractal sum of value noise over the unit tile: `fx`, `fy` base cells per tile. Returns about 0..1. */
export function fbm(u: number, v: number, fx: number, fy: number, octaves: number, seed: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let ax = fx;
  let ay = fy;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(u * ax, v * ay, ax, ay, seed + o * 17);
    norm += amp;
    amp *= gain;
    ax *= 2;
    ay *= 2;
  }
  return sum / norm;
}

/** Ridged fractal (sharp creases): 0..1, 1 on the ridges. */
export function ridged(u: number, v: number, fx: number, fy: number, octaves: number, seed: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let ax = fx;
  let ay = fy;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(2 * vnoise(u * ax, v * ay, ax, ay, seed + o * 31) - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    ax *= 2;
    ay *= 2;
  }
  return sum / norm;
}

export interface Cell {
  /** Distance to the nearest and second nearest feature point, in cells. */
  f1: number;
  f2: number;
  /** Stable random numbers of the nearest cell. */
  id: number;
  id2: number;
  /** Offset from the nearest feature point, in cells. */
  dx: number;
  dy: number;
}

/** Periodic Worley noise on an n x m cell grid over the unit tile. */
export function worley(u: number, v: number, n: number, m: number, seed: number, jitter = 0.9): Cell {
  const x = u * n;
  const y = v * m;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  let id2 = 0;
  let bdx = 0;
  let bdy = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const hx = mod(cx, n);
      const hy = mod(cy, m);
      const px = cx + 0.5 + (hash(hx, hy, seed) - 0.5) * jitter;
      const py = cy + 0.5 + (hash(hx, hy, seed + 7) - 0.5) * jitter;
      const dx = x - px;
      const dy = y - py;
      const d = Math.hypot(dx, dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash(hx, hy, seed + 13);
        id2 = hash(hx, hy, seed + 29);
        bdx = dx;
        bdy = dy;
      } else if (d < f2) f2 = d;
    }
  }
  return { f1, f2, id, id2, dx: bdx, dy: bdy };
}

export class Field {
  readonly data: Float32Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Float32Array(w * h);
  }
  static from(w: number, h: number, f: (u: number, v: number, x: number, y: number) => number): Field {
    const out = new Field(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.data[y * w + x] = f((x + 0.5) / w, (y + 0.5) / h, x, y);
    return out;
  }
  at(x: number, y: number): number {
    return this.data[mod(y, this.h) * this.w + mod(x, this.w)]!;
  }
  range(): [number, number] {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of this.data) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return [lo, hi];
  }
}

export class Image {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8Array(w * h * 4).fill(255);
  }
  /** Fill from a function returning 0..1 channel values (already in the stored encoding). */
  static from(w: number, h: number, f: (u: number, v: number, x: number, y: number) => [number, number, number]): Image {
    const img = new Image(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = f((x + 0.5) / w, (y + 0.5) / h, x, y);
        const o = (y * w + x) * 4;
        img.data[o] = Math.round(clamp(c[0]) * 255);
        img.data[o + 1] = Math.round(clamp(c[1]) * 255);
        img.data[o + 2] = Math.round(clamp(c[2]) * 255);
      }
    }
    return img;
  }
  save(file: string): number {
    const png = new PNG({ width: this.w, height: this.h, colorType: 2, inputColorType: 6, inputHasAlpha: true });
    png.data = Buffer.from(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    const buf = PNG.sync.write(png, { colorType: 2, inputColorType: 6, inputHasAlpha: true, deflateLevel: 9 });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return buf.length;
  }
}

/**
 * Tangent-space normal map (+Y up in v) of a height field. `metresPerTile` and the heights (metres) give
 * true slopes; `gain` exaggerates or softens them.
 */
export function normalMap(height: Field, metresPerTile: number, gain = 1): Image {
  const { w, h } = height;
  const sx = (w / metresPerTile) * 0.5 * gain;
  const sy = (h / metresPerTile) * 0.5 * gain;
  return Image.from(w, h, (_u, _v, x, y) => {
    const dx = (height.at(x + 1, y) - height.at(x - 1, y)) * sx;
    const dy = (height.at(x, y + 1) - height.at(x, y - 1)) * sy;
    const l = Math.hypot(dx, dy, 1);
    return [0.5 - (0.5 * dx) / l, 0.5 - (0.5 * dy) / l, 0.5 + 0.5 / l];
  });
}

/** sRGB encode a linear value 0..1. */
export const srgb = (x: number): number => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

/** Cheap ambient occlusion from a height field: how far a texel sits below its blurred surroundings. */
export function cavity(height: Field, radius: number, strength: number): Field {
  const { w, h } = height;
  // Separable box blur.
  const tmp = new Field(w, h);
  const blur = new Field(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += height.at(x + k, y);
      tmp.data[y * w + x] = s / (2 * radius + 1);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += tmp.at(x, y + k);
      blur.data[y * w + x] = s / (2 * radius + 1);
    }
  }
  return Field.from(w, h, (_u, _v, x, y) => clamp(1 - Math.max(0, blur.at(x, y) - height.at(x, y)) * strength));
}
