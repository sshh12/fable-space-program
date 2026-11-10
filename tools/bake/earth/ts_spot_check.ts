/**
 * Cross-language spot check of the earth tile set (bake-earth): decodes the tiles listed in
 * out/bake/earth/ts-spot-ref.json (written by tools/bake/earth/verify.py from the Python decoder) through
 * src/core/geo/tileCodec.ts and compares every decoded value with the Python decode (sha256 of the float32
 * heights / u8 bytes, plus header fields and sample values).
 *
 *   npx tsx tools/bake/earth/ts_spot_check.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeTileFile } from '../../../src/core/geo/tileCodec';

interface RefTile {
  path: string;
  kind: 'height' | 'u8';
  width: number;
  height: number;
  scale?: number;
  offset?: number;
  sha256: string;
  samples: { index: number; value: number }[];
}

const repo = resolve(import.meta.dirname, '../../..');
const ref = JSON.parse(readFileSync(join(repo, 'out/bake/earth/ts-spot-ref.json'), 'utf8')) as { tiles: RefTile[] };
let failures = 0;
for (const t of ref.tiles) {
  const file = new Uint8Array(readFileSync(join(repo, 'data/tiles', t.path)));
  const tile = await decodeTileFile(file);
  const problems: string[] = [];
  if (tile.kind !== t.kind) problems.push(`kind ${tile.kind}`);
  if (tile.width !== t.width || tile.height !== t.height) problems.push(`size ${tile.width}x${tile.height}`);
  let bytes: Uint8Array;
  let values: ArrayLike<number>;
  if (tile.kind === 'height') {
    if (tile.scale !== t.scale || tile.offset !== t.offset) problems.push(`scale/offset ${tile.scale}/${tile.offset}`);
    bytes = new Uint8Array(tile.heights.buffer, tile.heights.byteOffset, tile.heights.byteLength);
    values = tile.heights;
  } else {
    bytes = tile.data;
    values = tile.data;
  }
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== t.sha256) problems.push(`sha256 ${sha.slice(0, 12)} != ${t.sha256.slice(0, 12)}`);
  for (const s of t.samples) {
    if (values[s.index] !== s.value) problems.push(`value[${s.index}] ${values[s.index]} != ${s.value}`);
  }
  if (problems.length) failures++;
  console.log(`${problems.length ? 'FAIL' : 'PASS'} ${t.path} (${t.kind} ${t.width}x${t.height})${problems.length ? ': ' + problems.join(', ') : ''}`);
}
console.log(`${ref.tiles.length - failures} of ${ref.tiles.length} tiles decode identically in TypeScript and Python`);
process.exit(failures ? 1 : 0);
