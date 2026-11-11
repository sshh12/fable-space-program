/**
 * Twin of `hexHash` and of the lattice part of `detailPlane` in src/render/terrain/shaders/surface.ts: which
 * three copies of a detail layer a point of a projection plane blends, with which weights and at which
 * texture coordinates. Kept line by line next to the WGSL; the tests use it to show that the picture does not
 * depend on where a tile's origin lies (origins are kept modulo HEX_PERIOD tiling lengths, so two tiles that
 * share an edge may see the same point at plane positions that differ by whole periods).
 */
import { HEX_PERIOD } from '@/render/terrain/shaders/surface';

export interface HexTap {
  /** The lattice vertex the copy belongs to (skewed lattice coordinates). */
  vx: number;
  vy: number;
  /** Sharpened barycentric weight before the height term. */
  weight: number;
  /** Texture coordinate of the copy, modulo 1. */
  u: number;
  v: number;
  /** Rotation of the copy, turns. */
  turns: number;
}

const fract = (x: number): number => x - Math.floor(x);

/** Random numbers of a lattice vertex: texture offset (x, y) and rotation in turns. */
export function hexHash(vx: number, vy: number): [number, number, number] {
  const n = 2 * HEX_PERIOD;
  const j = Math.floor(vy / n);
  const y = vy - n * j;
  let x = (vx + HEX_PERIOD * j) % n;
  if (x < 0) x += n;
  let h = (Math.imul(x, 0x9e3779b1) + Math.imul(y, 0x85ebca77) + 0x165667b1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  h >>>= 0;
  return [(h & 0x3ff) / 1024, ((h >>> 10) & 0x3ff) / 1024, ((h >>> 20) & 0x3ff) / 1024];
}

/**
 * The three copies blended at plane position (sx, sy), in tiling lengths. `aboutVertex` false gives the
 * rotation about the plane's origin instead of the lattice vertex (what the shader must not do).
 */
export function hexTaps(sx: number, sy: number, aboutVertex = true): HexTap[] {
  const skx = 2 * sx - sy;
  const sky = 2 * sy;
  const bx = Math.floor(skx);
  const by = Math.floor(sky);
  const fx = skx - bx;
  const fy = sky - by;
  const tz = 1 - fx - fy;
  const up = tz <= 0 ? 1 : 0;
  const s2 = 2 * up - 1;
  const w = [-tz * s2, up - fy * s2, up - fx * s2].map((x) => x ** 6);
  const sum = w[0]! + w[1]! + w[2]!;
  const out: HexTap[] = [];
  for (let i = 0; i < 3; i++) {
    const vx = bx + (i === 2 ? 1 - up : up);
    const vy = by + (i === 1 ? 1 - up : up);
    const h = hexHash(vx, vy);
    const ang = h[2] * 2 * Math.PI;
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    const qx = aboutVertex ? sx - (0.5 * vx + 0.25 * vy) : sx;
    const qy = aboutVertex ? sy - 0.5 * vy : sy;
    out.push({ vx, vy, weight: w[i]! / sum, u: fract(c * qx - sn * qy + h[0]), v: fract(sn * qx + c * qy + h[1]), turns: h[2] });
  }
  return out;
}
