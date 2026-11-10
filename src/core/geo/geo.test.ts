import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEG, Prng, v3 } from '../math';
import {
  childTiles,
  CUBE_FACES,
  dirToFaceSt,
  dirToLatLon,
  dirToTile,
  faceStToDir,
  latLonToDir,
  meanTileSize,
  parentTile,
  parseTileKey,
  tileKeyString,
  tilePath,
  tileUvToDir,
  type FaceId,
} from './cubeSphere';
import { oceanSwellHeight } from './oceanSwell';
import {
  chooseHeightScale,
  decodeFrt1,
  decodeTileFile,
  deflateZlib,
  encodeFrt1Height,
  encodeFrt1U8,
  HEIGHT_TILE_STORED,
} from './tileCodec';

describe('cube sphere', () => {
  it('face bases are right-handed with U x V = N', () => {
    for (const f of CUBE_FACES) {
      const n = v3.cross(v3.fromTuple([...f.u]), v3.fromTuple([...f.v]));
      expect(v3.equalsApprox(n, v3.fromTuple([...f.n]), 0)).toBe(true);
    }
  });
  it('equatorial faces have U east and V north', () => {
    for (const face of [0, 1, 2, 3] as FaceId[]) {
      const c = dirToLatLon(faceStToDir(face, 0, 0));
      const e = dirToLatLon(faceStToDir(face, 0.1, 0));
      const n = dirToLatLon(faceStToDir(face, 0, 0.1));
      expect(n.lat).toBeGreaterThan(c.lat);
      const dLon = Math.atan2(Math.sin(e.lon - c.lon), Math.cos(e.lon - c.lon));
      expect(dLon).toBeGreaterThan(0);
    }
  });
  it('dir <-> face (s, t) round trip over the sphere', () => {
    const rng = new Prng(1);
    for (let i = 0; i < 2000; i++) {
      const d = v3.normalize(v3.new(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)));
      const { face, s, t } = dirToFaceSt(d);
      expect(Math.abs(s)).toBeLessThanOrEqual(1 + 1e-12);
      expect(Math.abs(t)).toBeLessThanOrEqual(1 + 1e-12);
      expect(v3.dist(faceStToDir(face, s, t), d)).toBeLessThan(1e-14);
    }
  });
  it('tiles: containing tile, uv, hierarchy and keys', () => {
    const d = latLonToDir(19.1 * DEG, -155.5 * DEG);
    const { key, u, v } = dirToTile(d, 12);
    expect(v3.dist(tileUvToDir(key, u, v), d)).toBeLessThan(1e-13);
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
    const parent = parentTile(key)!;
    expect(childTiles(parent).some((c) => c.x === key.x && c.y === key.y)).toBe(true);
    expect(dirToTile(d, 11).key).toEqual(parent);
    expect(parseTileKey(tileKeyString(key))).toEqual(key);
    expect(tilePath('earth', 'height', key, 'hgt')).toBe(`earth/height/${key.face}/12/${key.x}/${key.y}.hgt`);
    expect(parentTile({ face: 0, level: 0, x: 0, y: 0 })).toBeNull();
  });
  it('shared tile edges coincide exactly (crack-free by construction)', () => {
    const a = { face: 2 as FaceId, level: 5, x: 7, y: 9 };
    const b = { face: 2 as FaceId, level: 5, x: 8, y: 9 };
    for (const v of [0, 0.25, 1]) expect(tileUvToDir(a, 1, v)).toEqual(tileUvToDir(b, 0, v));
  });
  it('lat/lon conventions', () => {
    expect(v3.equalsApprox(latLonToDir(0, 0), v3.unitX(), 1e-15)).toBe(true);
    expect(v3.equalsApprox(latLonToDir(0, 90 * DEG), v3.unitY(), 1e-15)).toBe(true);
    expect(v3.equalsApprox(latLonToDir(90 * DEG, 0), v3.unitZ(), 1e-15)).toBe(true);
    const ll = dirToLatLon(latLonToDir(-33 * DEG, 151 * DEG));
    expect(ll.lat).toBeCloseTo(-33 * DEG, 12);
    expect(ll.lon).toBeCloseTo(151 * DEG, 12);
    expect(meanTileSize(6371000, 0)).toBeCloseTo(10007543.4, 0);
  });
});

describe('FRT1 tile codec', () => {
  const n = HEIGHT_TILE_STORED;
  const synth = (scale: number): Float32Array => {
    const h = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        h[j * n + i] = Math.round((1000 * Math.sin(i * 0.05) * Math.cos(j * 0.07) + 3 * i - 2 * j) / scale) * scale;
      }
    }
    return h;
  };
  it('round-trips heights exactly at the chosen scale', () => {
    const src = synth(0.125);
    const tile = decodeFrt1(encodeFrt1Height(src, n, n, 0.125));
    if (tile.kind !== 'height') throw new Error('wrong kind');
    expect(tile.width).toBe(n);
    expect(tile.border).toBe(1);
    expect(tile.scale).toBe(0.125);
    let maxErr = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < src.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(tile.heights[i]! - src[i]!));
      lo = Math.min(lo, src[i]!);
      hi = Math.max(hi, src[i]!);
    }
    expect(maxErr).toBe(0);
    expect(tile.hMin).toBe(lo);
    expect(tile.hMax).toBe(hi);
  });
  it('coarsens the scale when the range does not fit int16', () => {
    expect(chooseHeightScale(-11000, 8850, 0.5)).toBe(0.5);
    expect(chooseHeightScale(-5000, 4200, 0.0625)).toBe(0.25);
    const h = new Float32Array(4).fill(0);
    h[3] = 9000;
    const tile = decodeFrt1(encodeFrt1Height(h, 2, 2, 0.0625, 0));
    if (tile.kind !== 'height') throw new Error('wrong kind');
    expect(tile.scale).toBe(0.25);
    expect(tile.heights[3]).toBe(9000);
  });
  it('quantises to the nearest count', () => {
    const tile = decodeFrt1(encodeFrt1Height([0.3, -0.3, 100.26, 7], 2, 2, 0.5, 0));
    if (tile.kind !== 'height') throw new Error('wrong kind');
    expect([...tile.heights]).toEqual([0.5, -0.5, 100.5, 7]);
  });
  it('round-trips u8 rasters and survives zlib', async () => {
    const data = new Uint8Array(256 * 256);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff;
    const file = await deflateZlib(encodeFrt1U8(data, 256, 256));
    const tile = await decodeTileFile(file);
    if (tile.kind !== 'u8') throw new Error('wrong kind');
    expect(tile.channels).toBe(1);
    expect(tile.data).toEqual(data);
  });
  it('decodes the tile written by the Python bake library (tools/bake/golden/py_sample.hgt)', async () => {
    const file = path.resolve(process.cwd(), 'tools/bake/golden/py_sample.hgt');
    const tile = await decodeTileFile(new Uint8Array(readFileSync(file)));
    if (tile.kind !== 'height') throw new Error('wrong kind');
    expect([tile.width, tile.height, tile.border, tile.scale]).toEqual([n, n, 1, 0.125]);
    const expected = synth(0.125);
    let maxErr = 0;
    for (let i = 0; i < expected.length; i++) maxErr = Math.max(maxErr, Math.abs(tile.heights[i]! - expected[i]!));
    expect(maxErr).toBe(0);
  });
  it('rejects malformed input', () => {
    expect(() => decodeFrt1(new Uint8Array(8))).toThrow(/truncated/);
    const bad = encodeFrt1U8(new Uint8Array(4), 2, 2);
    bad[0] = 0;
    expect(() => decodeFrt1(bad)).toThrow(/magic/);
    expect(() => encodeFrt1Height([0, 1], 2, 1, 0.3)).toThrow(/power of two/);
  });
});

describe('ocean swell', () => {
  const swell = [
    { dir: [0.36, 0.48, 0.8] as [number, number, number], wavelength: 180, amplitude: 0.45, phase: 0 },
    { dir: [-0.6, 0.64, 0.48] as [number, number, number], wavelength: 95, amplitude: 0.3, phase: 1.3 },
  ];
  it('is bounded by the sum of amplitudes and varies in space and time', () => {
    const n = latLonToDir(18 * DEG, -168 * DEG);
    const samples: number[] = [];
    for (let t = 0; t < 60; t += 0.5) samples.push(oceanSwellHeight(swell, 9.81, 6371000, n, t));
    expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(0.75 + 1e-9);
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.5);
    const n2 = latLonToDir(18 * DEG, -168 * DEG + 20 / 6371000);
    expect(oceanSwellHeight(swell, 9.81, 6371000, n2, 0)).not.toBe(oceanSwellHeight(swell, 9.81, 6371000, n, 0));
  });
  it('fades out where the wave vector is vertical', () => {
    const d = swell[0]!.dir;
    expect(oceanSwellHeight([swell[0]!], 9.81, 6371000, { x: d[0], y: d[1], z: d[2] }, 3)).toBe(0);
  });
});
