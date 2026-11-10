/**
 * FRT1: the raw raster tile container for every layer that the CPU must decode exactly (heights, class maps).
 * Image layers (albedo, night lights) are ordinary WebP files and never pass through this codec.
 *
 * On disk / on the wire a tile file is a zlib stream (RFC 1950; `DecompressionStream('deflate')`,
 * Python `zlib.compress`) whose inflated content is:
 *
 *   offset size  field
 *   0      4     magic "FRT1"
 *   4      1     kind: 1 = height (int16, delta-predicted), 2 = u8 raster (raw)
 *   5      1     channels (1 for heights, 1..4 for u8)
 *   6      2     width  (u16 LE)   samples per row, including borders
 *   8      2     height (u16 LE)   rows, including borders
 *   10     2     border (u16 LE)   border samples on every side (heights: 1, u8: 0)
 *   12     4     scale  (f32 LE)   metres per count; a power of two (1 for u8)
 *   16     4     offset (f32 LE)   metres; an integer multiple of scale (0 for u8)
 *   20     4     hMin   (f32 LE)   min decoded value over the tile (0 for u8)
 *   24     4     hMax   (f32 LE)   max decoded value over the tile (0 for u8)
 *   28     4     reserved, zero
 *   32     ...   payload
 *
 * kind 1 payload: width*height int16 LE, row-major, row 0 first (row index increases with tile v).
 *   With q[j][i] the signed 16-bit count: stored d[j][i] = q[j][i] - q[j][i-1] for i > 0,
 *   d[j][0] = q[j][0] - q[j-1][0] for j > 0, d[0][0] = q[0][0]; all arithmetic modulo 2^16.
 *   value_m = offset + scale * q.
 * kind 2 payload: width*height*channels bytes, row-major, channels interleaved.
 *
 * Height tiles are vertex-registered: 257 x 257 samples cover the tile exactly (sample (i, j) of the
 * bordered 259 x 259 grid sits at tile u = (i - 1) / 256, v = (j - 1) / 256); edge samples are shared
 * with neighbours and, because scale is a power of two and offset a multiple of it, are bit-identical
 * in both tiles when they use the same scale.
 */
export const FRT1_MAGIC = 0x31545246; // "FRT1" little-endian
export const FRT1_HEADER_BYTES = 32;
export const FRT1_KIND_HEIGHT = 1;
export const FRT1_KIND_U8 = 2;
/** Samples per side of a height tile without border, and with the 1-sample border. */
export const HEIGHT_TILE_CELLS = 256;
export const HEIGHT_TILE_SAMPLES = 257;
export const HEIGHT_TILE_BORDER = 1;
export const HEIGHT_TILE_STORED = 259;
/** Pixels per side of every image / u8 raster tile (cell-registered, no border). */
export const IMAGE_TILE_SIZE = 256;

export interface HeightTile {
  kind: 'height';
  width: number;
  height: number;
  border: number;
  scale: number;
  offset: number;
  hMin: number;
  hMax: number;
  /** Decoded metres above the body's reference radius, row-major, length width*height. */
  heights: Float32Array;
}

export interface U8Tile {
  kind: 'u8';
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

export type RasterTile = HeightTile | U8Tile;

/** Decode an inflated FRT1 buffer. Throws on malformed input. */
export function decodeFrt1(bytes: Uint8Array): RasterTile {
  if (bytes.byteLength < FRT1_HEADER_BYTES) throw new Error('FRT1: truncated header');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== FRT1_MAGIC) throw new Error('FRT1: bad magic');
  const kind = dv.getUint8(4);
  const channels = dv.getUint8(5);
  const width = dv.getUint16(6, true);
  const height = dv.getUint16(8, true);
  const border = dv.getUint16(10, true);
  const n = width * height;
  if (kind === FRT1_KIND_HEIGHT) {
    if (bytes.byteLength < FRT1_HEADER_BYTES + n * 2) throw new Error('FRT1: truncated height payload');
    const scale = dv.getFloat32(12, true);
    const offset = dv.getFloat32(16, true);
    const heights = new Float32Array(n);
    let o = FRT1_HEADER_BYTES;
    let rowStart = 0;
    for (let j = 0; j < height; j++) {
      let q = (rowStart + dv.getInt16(o, true)) << 16 >> 16;
      rowStart = q;
      heights[j * width] = offset + scale * q;
      o += 2;
      for (let i = 1; i < width; i++) {
        q = (q + dv.getInt16(o, true)) << 16 >> 16;
        heights[j * width + i] = offset + scale * q;
        o += 2;
      }
    }
    return {
      kind: 'height',
      width,
      height,
      border,
      scale,
      offset,
      hMin: dv.getFloat32(20, true),
      hMax: dv.getFloat32(24, true),
      heights,
    };
  }
  if (kind === FRT1_KIND_U8) {
    const len = n * channels;
    if (bytes.byteLength < FRT1_HEADER_BYTES + len) throw new Error('FRT1: truncated u8 payload');
    return { kind: 'u8', width, height, channels, data: bytes.slice(FRT1_HEADER_BYTES, FRT1_HEADER_BYTES + len) };
  }
  throw new Error(`FRT1: unknown kind ${kind}`);
}

/**
 * Smallest power-of-two scale >= `preferredScale` for which every value fits the int16 range around the
 * tile's mid value. Bakers call this with the manifest's per-level preferred scale.
 */
export function chooseHeightScale(hMin: number, hMax: number, preferredScale: number): number {
  let scale = preferredScale;
  while ((hMax - hMin) / scale > 65000) scale *= 2;
  return scale;
}

/** Encode metres into an (uninflated) FRT1 height buffer. `scale` must be a power of two. */
export function encodeFrt1Height(
  heights: ArrayLike<number>,
  width: number,
  height: number,
  preferredScale: number,
  border = HEIGHT_TILE_BORDER,
): Uint8Array {
  const n = width * height;
  if (heights.length !== n) throw new Error('FRT1: heights length mismatch');
  if (Math.log2(preferredScale) % 1 !== 0) throw new Error('FRT1: scale must be a power of two');
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const h = heights[i]!;
    if (!Number.isFinite(h)) throw new Error('FRT1: non-finite height');
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  const scale = chooseHeightScale(lo, hi, preferredScale);
  const offsetCounts = Math.round((lo + hi) / 2 / scale);
  const offset = offsetCounts * scale;
  const out = new Uint8Array(FRT1_HEADER_BYTES + n * 2);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, FRT1_MAGIC, true);
  dv.setUint8(4, FRT1_KIND_HEIGHT);
  dv.setUint8(5, 1);
  dv.setUint16(6, width, true);
  dv.setUint16(8, height, true);
  dv.setUint16(10, border, true);
  dv.setFloat32(12, scale, true);
  dv.setFloat32(16, offset, true);
  let o = FRT1_HEADER_BYTES;
  let qMin = Infinity;
  let qMax = -Infinity;
  let rowStart = 0;
  for (let j = 0; j < height; j++) {
    let prev = rowStart;
    for (let i = 0; i < width; i++) {
      const q = Math.round(heights[j * width + i]! / scale) - offsetCounts;
      if (q < -32768 || q > 32767) throw new Error('FRT1: height out of int16 range');
      if (q < qMin) qMin = q;
      if (q > qMax) qMax = q;
      dv.setInt16(o, ((q - prev) << 16) >> 16, true);
      o += 2;
      prev = q;
      if (i === 0) rowStart = q;
    }
  }
  dv.setFloat32(20, offset + scale * qMin, true);
  dv.setFloat32(24, offset + scale * qMax, true);
  return out;
}

/** Encode a u8 raster into an (uninflated) FRT1 buffer. */
export function encodeFrt1U8(data: Uint8Array, width: number, height: number, channels = 1): Uint8Array {
  if (data.length !== width * height * channels) throw new Error('FRT1: u8 length mismatch');
  const out = new Uint8Array(FRT1_HEADER_BYTES + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, FRT1_MAGIC, true);
  dv.setUint8(4, FRT1_KIND_U8);
  dv.setUint8(5, channels);
  dv.setUint16(6, width, true);
  dv.setUint16(8, height, true);
  dv.setUint16(10, 0, true);
  dv.setFloat32(12, 1, true);
  out.set(data, FRT1_HEADER_BYTES);
  return out;
}

async function pipeThrough(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => undefined);
  void writer.close().catch(() => undefined);
  const buf = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buf);
}

/** Inflate a zlib stream (works in browsers, workers and Node >= 18). */
export const inflateZlib = (bytes: Uint8Array): Promise<Uint8Array> => pipeThrough(bytes, new DecompressionStream('deflate'));

/** Deflate to a zlib stream (tools and tests). */
export const deflateZlib = (bytes: Uint8Array): Promise<Uint8Array> => pipeThrough(bytes, new CompressionStream('deflate'));

/** Convenience: inflate + decode a tile file as fetched from the tile root. */
export const decodeTileFile = async (file: Uint8Array): Promise<RasterTile> => decodeFrt1(await inflateZlib(file));
