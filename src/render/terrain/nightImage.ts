/**
 * Night-light textures: the 256 x 256 image of a tile with one border texel on every side, copied from the
 * tiles around it (across cube edges and corners too).
 *
 * The lights are sparse points with blooms around them and are drawn far above the resolution of their
 * layer. A filter that only sees one tile cuts every light near a tile edge in half and steps every bloom
 * that crosses it; with the neighbours' edge texels in the texture the reconstruction is the same from both
 * sides of an edge. Pure code (the pixels come through a callback): unit-tested in Node.
 */
import { dirToTile, tileKeyString, tileUvToDir, type TileKey } from '@/core/geo/cubeSphere';
import { IMAGE_TILE_SIZE } from '@/core/geo/tileCodec';

const N = IMAGE_TILE_SIZE;
/** Side of a night-light texture layer, texels. */
export const NIGHT_SIZE = N + 2;

export interface BorderSource {
  key: TileKey;
  x: number;
  y: number;
}

/**
 * The tile of the same level, and its texel, under texel (i, j) of the image of `key` when i or j lies
 * outside 0..255. On the same cube face that is a neighbour's edge texel; beyond the face the direction of
 * the texel centre in this face's own (gnomonic) mapping is looked up on the face it falls on.
 */
export function borderSource(key: TileKey, i: number, j: number): BorderSource {
  const n = 2 ** key.level;
  const dx = i < 0 ? -1 : i >= N ? 1 : 0;
  const dy = j < 0 ? -1 : j >= N ? 1 : 0;
  const x = key.x + dx;
  const y = key.y + dy;
  if (x >= 0 && y >= 0 && x < n && y < n) return { key: { face: key.face, level: key.level, x, y }, x: i - dx * N, y: j - dy * N };
  const t = dirToTile(tileUvToDir(key, (i + 0.5) / N, (j + 0.5) / N), key.level);
  return { key: t.key, x: Math.min(N - 1, Math.floor(t.u * N)), y: Math.min(N - 1, Math.floor(t.v * N)) };
}

/**
 * The bordered image of `key` (NIGHT_SIZE x NIGHT_SIZE bytes, row 0 = border below v = 0). `red(key)`
 * resolves the 256 x 256 red channel of a tile's night image, or null when the tile has none (its border
 * texels then repeat this tile's edge). Returns null when no texel, border included, is brighter than
 * `darkLimit`: most night tiles (open ocean, wilderness) need no texture at all.
 */
export async function buildNightImage(key: TileKey, red: (key: TileKey) => Promise<Uint8Array | null>, darkLimit = 3): Promise<Uint8Array<ArrayBuffer> | null> {
  const own = await red(key);
  if (!own) return null;
  const S = NIGHT_SIZE;
  const out = new Uint8Array(S * S);
  let max = 0;
  for (let j = 0; j < N; j++) out.set(own.subarray(j * N, (j + 1) * N), (j + 1) * S + 1);
  for (let k = 0; k < own.length; k++) if (own[k]! > max) max = own[k]!;
  // Border texels grouped by the tile they come from: (index in out, index in the source, index in own).
  const groups = new Map<string, { key: TileKey; items: number[] }>();
  const clamp = (v: number): number => (v < 0 ? 0 : v >= N ? N - 1 : v);
  const add = (i: number, j: number): void => {
    const s = borderSource(key, i, j);
    const id = tileKeyString(s.key);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { key: s.key, items: [] }));
    g.items.push((j + 1) * S + i + 1, s.y * N + s.x, clamp(j) * N + clamp(i));
  };
  for (let i = -1; i <= N; i++) {
    add(i, -1);
    add(i, N);
  }
  for (let j = 0; j < N; j++) {
    add(-1, j);
    add(N, j);
  }
  await Promise.all(
    [...groups.values()].map(async (g) => {
      const data = await red(g.key);
      for (let k = 0; k < g.items.length; k += 3) {
        const v = data ? data[g.items[k + 1]!]! : own[g.items[k + 2]!]!;
        out[g.items[k]!] = v;
        if (v > max) max = v;
      }
    }),
  );
  return max > darkLimit ? out : null;
}
