/** Shared by the platform lab's page and worker: read tiles and digest them (SHA-256, first 16 hex digits). */
import type { FaceId } from '@/core/geo/cubeSphere';
import type { TileSource } from '@/core/contracts/terrain';

/** [layer, face, level, x, y] */
export type TileReq = [string, number, number, number, number];

export async function digestTiles(src: TileSource, set: string, tiles: TileReq[]): Promise<(string | null)[]> {
  const bytes = await Promise.all(tiles.map(([layer, face, level, x, y]) => src.tile(set, layer, { face: face as FaceId, level, x, y })));
  return Promise.all(
    bytes.map(async (b) => {
      if (!b) return null;
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b)));
      return [...d.subarray(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('');
    }),
  );
}
