/**
 * Writes a ground-cover mesh (src/render/terrain/coverMesh.ts) to a file for tools/terrain/preview_cover.py:
 * uint32 vertex count, uint32 index count, uint32 floats per vertex, uint32 0, then the vertices (float32)
 * and the indices (uint16).
 *
 *   npx tsx tools/terrain/dump-cover.ts <tuft|bush|tree|grove|stone> <variant> <lod> <out.bin>
 */
import { writeFileSync } from 'node:fs';
import { buildCoverMesh, COVER_SHAPES, COVER_VERTEX_FLOATS, type CoverShape } from '../../src/render/terrain/coverMesh';

const [shape, variant, lod, out] = process.argv.slice(2);
if (!shape || !COVER_SHAPES.includes(shape as CoverShape) || variant === undefined || lod === undefined || !out) {
  console.error('usage: dump-cover.ts <shape> <variant> <lod> <out.bin>');
  process.exit(1);
}
const m = buildCoverMesh(shape as CoverShape, Number(variant), Number(lod));
const header = new Uint32Array([m.vertices.length / COVER_VERTEX_FLOATS, m.indices.length, COVER_VERTEX_FLOATS, 0]);
writeFileSync(out, Buffer.concat([Buffer.from(header.buffer), Buffer.from(m.vertices.buffer), Buffer.from(m.indices.buffer)]));
console.log(`${shape} ${variant} lod ${lod}: ${header[0]} vertices, ${m.indices.length / 3} triangles -> ${out}`);
