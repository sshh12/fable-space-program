/**
 * Decodes FRT1 height tiles with the engine's own codec (src/core/geo/tileCodec.ts) and prints, per tile, the
 * header fields and a SHA-256 of the decoded float32 heights, so tools/bake/moon/verify.py can compare them
 * bit for bit with the Python decoder.
 *
 *   npx tsx tools/bake/moon/decode-check.node.ts <tile.hgt> [...]
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeTileFile } from '../../../src/core/geo/tileCodec';

const out: unknown[] = [];
for (const file of process.argv.slice(2)) {
  const t = await decodeTileFile(new Uint8Array(readFileSync(file)));
  if (t.kind !== 'height') throw new Error(`${file}: expected a height tile, got ${t.kind}`);
  const bytes = new Uint8Array(t.heights.buffer, t.heights.byteOffset, t.heights.byteLength);
  out.push({
    file,
    width: t.width,
    height: t.height,
    border: t.border,
    scale: t.scale,
    offset: t.offset,
    hMin: t.hMin,
    hMax: t.hMax,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    first: Array.from(t.heights.subarray(0, 4)),
  });
}
process.stdout.write(`${JSON.stringify(out)}\n`);
