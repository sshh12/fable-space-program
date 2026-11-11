/**
 * Look for isolated spikes in the baked height tiles around a point: samples that stand far above (or
 * below) the median of their 5 x 5 neighbourhood.
 *
 *   npx tsx tools/terrain/scan-spikes.ts <tileset> <latDeg> <lonDeg> <radiusM> [level] [thresholdM]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TileManifest } from '../../src/core/contracts/terrain';
import { layerHasTile } from '../../src/core/contracts/terrain';
import { dirToLatLon, dirToTile, latLonToDir, tileUvToDir, type TileKey } from '../../src/core/geo/cubeSphere';
import { decodeTileFile, HEIGHT_TILE_STORED } from '../../src/core/geo/tileCodec';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEG = Math.PI / 180;

async function main(): Promise<void> {
  const [tileset = 'earth', lat = '18.987556', lon = '-155.603239', radius = '3000', levelArg, thresholdArg] = process.argv.slice(2);
  const root = path.join(repoRoot, 'data', 'tiles', tileset);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as TileManifest;
  const layer = manifest.layers.height!;
  const centre = latLonToDir(Number(lat) * DEG, Number(lon) * DEG);
  const levels = Object.keys(layer.coverage).map(Number);
  const level = levelArg ? Number(levelArg) : Math.max(layer.globalMaxLevel, ...levels);
  const threshold = Number(thresholdArg ?? 30);
  const tileSize = (Math.PI * manifest.radius) / 2 / 2 ** level;
  const span = Math.ceil(Number(radius) / tileSize) + 1;
  const base = dirToTile(centre, level).key;
  const seen = new Set<string>();
  let found = 0;
  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      const key: TileKey = { face: base.face, level, x: base.x + dx, y: base.y + dy };
      if (key.x < 0 || key.y < 0 || key.x >= 2 ** level || key.y >= 2 ** level || !layerHasTile(layer, key)) continue;
      const file = path.join(root, 'height', String(key.face), String(level), String(key.x), `${key.y}.${layer.ext}`);
      const tile = await decodeTileFile(new Uint8Array(fs.readFileSync(file)));
      if (tile.kind !== 'height') continue;
      const n = HEIGHT_TILE_STORED;
      const h = tile.heights;
      for (let j = 2; j < n - 2; j++) {
        for (let i = 2; i < n - 2; i++) {
          const around: number[] = [];
          for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) if (a !== 0 || b !== 0) around.push(h[(j + b) * n + i + a]!);
          around.sort((p, q) => p - q);
          const median = around[12]!;
          const d = h[j * n + i]! - median;
          if (Math.abs(d) < threshold) continue;
          const dir = tileUvToDir(key, (i - 1) / 256, (j - 1) / 256);
          const ll = dirToLatLon(dir);
          const id = `${(ll.lat / DEG).toFixed(5)},${(ll.lon / DEG).toFixed(5)}`;
          if (seen.has(id)) continue;
          seen.add(id);
          if (found++ < 40) console.log(`${key.face}/${level}/${key.x}/${key.y} sample (${i}, ${j}): ${h[j * n + i]!.toFixed(1)} m, neighbourhood median ${median.toFixed(1)} m, at ${id}`);
        }
      }
    }
  }
  console.log(`${found} sample(s) more than ${threshold} m from their neighbourhood median within ${radius} m of ${lat}, ${lon} at level ${level}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
