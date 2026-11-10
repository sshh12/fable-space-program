/**
 * Writes the cross-language golden files that tie the Python bake code (tools/bake/common) to the
 * TypeScript contracts in src/core/geo:
 *
 *   tools/bake/golden/cube_vectors.json   direction <-> (face, s, t) <-> tile samples, lat/lon samples
 *   tools/bake/golden/ts_sample.hgt       an FRT1 height tile (zlib) produced by the TS encoder
 *   tools/bake/golden/hash_vectors.json   integer-hash golden values
 *
 * Run with `npm run golden` after any (deliberate, lead-approved) change to those modules, then run
 * `python -I tools/bake/common/test_common.py` and `npm test`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirToFaceSt, dirToLatLon, dirToTile, latLonToDir, tileUvToDir, type FaceId } from '../../src/core/geo/cubeSphere';
import { deflateZlib, encodeFrt1Height, HEIGHT_TILE_STORED } from '../../src/core/geo/tileCodec';
import { hash4, hashU32, Prng } from '../../src/core/math/hash';
import { DEG } from '../../src/core/math/scalar';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bake', 'golden');
fs.mkdirSync(outDir, { recursive: true });

/** Analytic height used by ts_sample.hgt, py_sample.hgt and both test suites. */
export function goldenHeight(i: number, j: number): number {
  return Math.round((1000 * Math.sin(i * 0.05) * Math.cos(j * 0.07) + 3 * i - 2 * j) / 0.125) * 0.125;
}

async function main(): Promise<void> {
  const rng = new Prng(20261109);
  const dirs: unknown[] = [];
  const named: [string, number, number][] = [
    ['launch-site-nominal', 19.1, -155.5],
    ['everest', 27.9881, 86.925],
    ['challenger-deep', 11.35, 142.2],
    ['tranquility-base', 0.67416, 23.47314],
    ['north-pole', 90, 0],
    ['south-pole', -90, 0],
    ['antimeridian', 0, 180],
  ];
  for (const [name, lat, lon] of named) {
    const d = latLonToDir(lat * DEG, lon * DEG);
    const fst = dirToFaceSt(d);
    const tile = dirToTile(d, 12);
    dirs.push({ name, latDeg: lat, lonDeg: lon, dir: [d.x, d.y, d.z], face: fst.face, s: fst.s, t: fst.t, tile12: tile.key, u: tile.u, v: tile.v });
  }
  for (let i = 0; i < 200; i++) {
    const z = rng.range(-1, 1);
    const a = rng.range(-Math.PI, Math.PI);
    const c = Math.sqrt(1 - z * z);
    const d = { x: c * Math.cos(a), y: c * Math.sin(a), z };
    const fst = dirToFaceSt(d);
    const ll = dirToLatLon(d);
    const level = 1 + (i % 14);
    const tile = dirToTile(d, level);
    dirs.push({ name: `random-${i}`, latDeg: ll.lat / DEG, lonDeg: ll.lon / DEG, dir: [d.x, d.y, d.z], face: fst.face, s: fst.s, t: fst.t, level, tile: tile.key, u: tile.u, v: tile.v });
  }
  const tiles: unknown[] = [];
  for (let i = 0; i < 40; i++) {
    const level = i % 13;
    const n = 2 ** level;
    const key = { face: (i % 6) as FaceId, level, x: Math.floor(rng.next() * n), y: Math.floor(rng.next() * n) };
    const samples = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0.5, 0.5],
      [-1 / 256, 0.25],
      [0.75, 257 / 256],
    ].map(([u, v]) => {
      const d = tileUvToDir(key, u!, v!);
      return { u, v, dir: [d.x, d.y, d.z] };
    });
    tiles.push({ key, samples });
  }
  fs.writeFileSync(path.join(outDir, 'cube_vectors.json'), JSON.stringify({ dirs, tiles }, null, 1));

  const n = HEIGHT_TILE_STORED;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = goldenHeight(i, j);
  fs.writeFileSync(path.join(outDir, 'ts_sample.hgt'), await deflateZlib(encodeFrt1Height(heights, n, n, 0.125)));

  const hashes = [0, 1, 2, 12345, 0x7fffffff, 0x80000000, 0xffffffff].map((x) => ({ x, h: hashU32(x) }));
  const hashes4 = [
    [1, 2, 3, 4],
    [-1, 0, 5, 9],
    [100000, -200000, 7, 31],
  ].map(([a, b, c, d]) => ({ a, b, c, d, h: hash4(a!, b!, c!, d!) }));
  fs.writeFileSync(path.join(outDir, 'hash_vectors.json'), JSON.stringify({ hashU32: hashes, hash4: hashes4 }, null, 1));
  console.log(`golden files written to ${outDir}`);
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) void main();
