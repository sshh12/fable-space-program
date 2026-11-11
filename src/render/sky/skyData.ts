/**
 * The baked sky data (src/core/contracts/sky.ts): manifest validation, star catalogue parsing, the byte layout
 * of the Milky Way cube faces (full mip chains of raw rgb9e5ufloat), and an rgb9e5 decoder for tests.
 * Fetching lives in the feature; everything here is pure so vitest can check it against data/sky.
 */
import { STAR_RECORD_FLOATS, type SkyManifest } from '@/core/contracts/sky';

/** Throws with a precise message when a manifest does not match the contract. */
export function validateSkyManifest(m: unknown): SkyManifest {
  const fail = (why: string): never => {
    throw new Error(`sky manifest: ${why}`);
  };
  if (!m || typeof m !== 'object') fail('not an object');
  const s = m as SkyManifest;
  if (s.formatVersion !== 1) fail(`formatVersion ${String(s.formatVersion)} (expected 1)`);
  if (s.frame !== 'j2000-equatorial') fail(`frame ${String(s.frame)} (expected j2000-equatorial)`);
  const mw = s.milkyWay;
  if (!mw || mw.format !== 'rgb9e5ufloat') fail('milkyWay.format must be rgb9e5ufloat');
  if (!Number.isInteger(mw.faceSize) || mw.faceSize < 1 || (mw.faceSize & (mw.faceSize - 1)) !== 0) fail(`milkyWay.faceSize ${mw.faceSize} is not a power of two`);
  if (mw.mipLevels !== Math.log2(mw.faceSize) + 1) fail(`milkyWay.mipLevels ${mw.mipLevels} is not the full chain of ${mw.faceSize}`);
  if (!Array.isArray(mw.files) || mw.files.length !== 6) fail('milkyWay.files must list six faces');
  if (!(mw.luminanceScale > 0)) fail('milkyWay.luminanceScale must be positive');
  if (!s.stars || s.stars.recordFloats !== STAR_RECORD_FLOATS) fail(`stars.recordFloats must be ${STAR_RECORD_FLOATS}`);
  if (!Number.isInteger(s.stars.count) || s.stars.count < 1) fail('stars.count must be a positive integer');
  return s;
}

/** Byte offset and edge length of every mip level inside one face file (level 0 first, 4 bytes per texel). */
export function faceMipLayout(faceSize: number, mipLevels: number): { offset: number; size: number }[] {
  const out: { offset: number; size: number }[] = [];
  let offset = 0;
  for (let l = 0; l < mipLevels; l++) {
    const size = Math.max(1, faceSize >> l);
    out.push({ offset, size });
    offset += size * size * 4;
  }
  return out;
}

export const faceFileBytes = (faceSize: number, mipLevels: number): number => {
  const l = faceMipLayout(faceSize, mipLevels);
  const last = l[l.length - 1]!;
  return last.offset + last.size * last.size * 4;
};

/** Decode one rgb9e5ufloat texel (R bits 0-8, G 9-17, B 18-26, shared exponent 27-31, bias 15, 9 mantissa bits). */
export function decodeRgb9e5(v: number): [number, number, number] {
  const scale = 2 ** (((v >>> 27) & 31) - 15 - 9);
  return [(v & 511) * scale, ((v >>> 9) & 511) * scale, ((v >>> 18) & 511) * scale];
}

/**
 * Rec. 709 luminance of rgb9e5ufloat texels as IEEE half floats (the texels of an r16float texture): the Milky
 * Way's detail layer, the finest baked level kept as luminance only (2 bytes per texel instead of 4).
 */
export function rgb9e5LuminanceHalf(texels: Uint32Array): Uint16Array {
  const out = new Uint16Array(texels.length);
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  for (let i = 0; i < texels.length; i++) {
    const v = texels[i]!;
    f[0] = (0.2126 * (v & 511) + 0.7152 * ((v >>> 9) & 511) + 0.0722 * ((v >>> 18) & 511)) * 2 ** ((v >>> 27) - 24);
    // float32 -> float16, round to nearest, for a finite value >= 0 (the largest rgb9e5 value, 65408, is below the half maximum).
    const x = u[0]!;
    const e = ((x >>> 23) & 0xff) - 112;
    const m = x & 0x7fffff;
    if (e <= 0) out[i] = e < -10 ? 0 : (((m | 0x800000) >> (1 - e)) + 0x1000) >> 13;
    else out[i] = Math.min(0x7bff, ((e << 10) | (m >> 13)) + ((m >> 12) & 1));
  }
  return out;
}

/** Decode an IEEE half float (tests). */
export function decodeHalf(h: number): number {
  const e = (h >>> 10) & 31;
  const m = h & 1023;
  return e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15);
}

export interface StarCatalogue {
  count: number;
  /** STAR_RECORD_FLOATS floats per star: direction xyz, lux, linear-sRGB colour (luminance 1), V. */
  records: Float32Array;
}

/** Parse stars.f32 and check every record (unit direction, positive lux, finite colour, brightest first). */
export function parseStarCatalogue(bytes: ArrayBuffer, count: number): StarCatalogue {
  if (bytes.byteLength !== count * STAR_RECORD_FLOATS * 4) throw new Error(`star catalogue: ${bytes.byteLength} bytes for ${count} stars (expected ${count * STAR_RECORD_FLOATS * 4})`);
  const records = new Float32Array(bytes);
  let prevLux = Infinity;
  for (let i = 0; i < count; i++) {
    const o = i * STAR_RECORD_FLOATS;
    const len = Math.hypot(records[o]!, records[o + 1]!, records[o + 2]!);
    const lux = records[o + 3]!;
    if (!(Math.abs(len - 1) < 1e-4)) throw new Error(`star catalogue: record ${i} direction length ${len}`);
    if (!(lux > 0) || lux > prevLux * (1 + 1e-6)) throw new Error(`star catalogue: record ${i} illuminance ${lux} (must be positive, brightest first)`);
    for (let c = 4; c < 7; c++) if (!Number.isFinite(records[o + c]!) || records[o + c]! < 0) throw new Error(`star catalogue: record ${i} colour channel ${c - 4} = ${records[o + c]}`);
    prevLux = lux;
  }
  return { count, records };
}
