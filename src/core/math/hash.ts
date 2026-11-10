/**
 * Deterministic integer hashing shared by CPU terrain amplification, rock/crater placement and (bit-identically,
 * in WGSL u32 arithmetic) by GPU shaders. Never use Math.random in simulation or terrain code.
 */

/** PCG-style 32-bit mix. WGSL mirror is given in HASH_WGSL below and must stay bit-identical. */
export function hashU32(x: number): number {
  let h = (Math.imul(x >>> 0, 747796405) + 2891336453) >>> 0;
  h = Math.imul((h >>> ((h >>> 28) + 4)) ^ h, 277803737) >>> 0;
  return ((h >>> 22) ^ h) >>> 0;
}

/** Hash of four integers (lattice coordinates + seed/octave). */
export function hash4(a: number, b: number, c: number, d: number): number {
  return hashU32(((a | 0) ^ hashU32(((b | 0) ^ hashU32(((c | 0) ^ hashU32(d | 0)) >>> 0)) >>> 0)) >>> 0);
}

/** Uniform float in [0, 1) from a 32-bit hash (24-bit mantissa so it is exact in f32 too). */
export const hashToUnit = (h: number): number => (h >>> 8) / 16777216;

/** WGSL source that reproduces hashU32 / hash4 / hashToUnit exactly. Include it instead of re-deriving. */
export const HASH_WGSL = /* wgsl */ `
fn hash_u32(x: u32) -> u32 {
  var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}
fn hash4(a: i32, b: i32, c: i32, d: i32) -> u32 {
  return hash_u32(bitcast<u32>(a) ^ hash_u32(bitcast<u32>(b) ^ hash_u32(bitcast<u32>(c) ^ hash_u32(bitcast<u32>(d)))));
}
fn hash_to_unit(h: u32) -> f32 { return f32(h >> 8u) / 16777216.0; }
`;

/** Small seeded PRNG (xoshiro128**) for tools and tests; deterministic across platforms. */
export class Prng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  constructor(seed: number) {
    this.s0 = hashU32(seed);
    this.s1 = hashU32(this.s0);
    this.s2 = hashU32(this.s1);
    this.s3 = hashU32(this.s2) | 1;
  }
  nextU32(): number {
    const r = Math.imul(this.rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = this.rotl(this.s3, 11);
    return r;
  }
  /** Uniform in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  private rotl(x: number, k: number): number {
    return (x << k) | (x >>> (32 - k));
  }
}
