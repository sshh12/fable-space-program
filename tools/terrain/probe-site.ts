/**
 * What the baked layers hold around a point: land-cover classes, water mask and imagery colour on a grid of
 * the deepest image level, as numbers. Evidence tool for the surface shader's material rules.
 *   npx tsx tools/terrain/probe-site.ts <body> <latDeg> <lonDeg> [halfSizeM = 600] [cells = 13]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { TILE_LAYER, deepestAvailable, type TileManifest } from '../../src/core/contracts/terrain';
import { dirToTile, latLonToDir, tilePath } from '../../src/core/geo/cubeSphere';
import { decodeFrt1 } from '../../src/core/geo/tileCodec';
import { DEG, v3 } from '../../src/core/math';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tiles = path.join(repoRoot, 'data', 'tiles');

function main(): void {
  const [body = 'earth', latText = '18.987556', lonText = '-155.603239', halfText = '600', cellsText = '13'] = process.argv.slice(2);
  const manifest = JSON.parse(readFileSync(path.join(tiles, body, 'manifest.json'), 'utf8')) as TileManifest;
  const radius = manifest.radius;
  const lat = Number(latText) * DEG;
  const lon = Number(lonText) * DEG;
  const half = Number(halfText);
  const cells = Number(cellsText);
  const centre = latLonToDir(lat, lon);
  const east = v3.normalize(v3.cross({ x: 0, y: 0, z: 1 }, centre));
  const north = v3.cross(centre, east);
  const cache = new Map<string, Uint8Array | null>();
  const u8At = (layerName: string, dir: ReturnType<typeof latLonToDir>): number => {
    const layer = manifest.layers[layerName];
    if (!layer) return -1;
    const deepest = Math.max(layer.globalMaxLevel, ...Object.keys(layer.coverage).map(Number));
    const t = dirToTile(dir, deepest);
    const key = deepestAvailable(layer, t.key);
    const at = dirToTile(dir, key.level);
    const file = path.join(tiles, tilePath(body, layerName, key, 'u8'));
    let data = cache.get(file);
    if (data === undefined) {
      try {
        const tile = decodeFrt1(inflateSync(readFileSync(file)));
        data = tile.kind === 'u8' ? tile.data : null;
      } catch {
        data = null;
      }
      cache.set(file, data);
    }
    if (!data) return -1;
    const x = Math.min(255, Math.floor(at.u * 256));
    const y = Math.min(255, Math.floor(at.v * 256));
    return data[y * 256 + x]!;
  };
  const classNames = Object.entries((manifest.layers[TILE_LAYER.landcover] as { classes?: Record<string, number> } | undefined)?.classes ?? {});
  console.log(`${body} ${latText}, ${lonText}: +-${half} m, ${cells} x ${cells} cells (north up, east right)`);
  console.log(`classes: ${classNames.map(([n, i]) => `${i}=${n}`).join(' ')}`);
  const rows: string[] = [];
  const waterRows: string[] = [];
  const hist = new Map<number, number>();
  for (let j = cells - 1; j >= 0; j--) {
    let row = '';
    let wrow = '';
    for (let i = 0; i < cells; i++) {
      const e = ((i + 0.5) / cells * 2 - 1) * half;
      const n = ((j + 0.5) / cells * 2 - 1) * half;
      const dir = v3.normalize(v3.add(v3.scale(centre, radius), v3.add(v3.scale(east, e), v3.scale(north, n))));
      const c = u8At(TILE_LAYER.landcover, dir);
      const w = u8At(TILE_LAYER.watermask, dir);
      hist.set(c, (hist.get(c) ?? 0) + 1);
      row += c < 0 ? ' .' : ` ${c.toString(16)}`;
      wrow += w < 0 ? ' .' : w > 127 ? ' W' : w > 0 ? ' w' : ' -';
    }
    rows.push(row);
    waterRows.push(wrow);
  }
  console.log('land cover:');
  console.log(rows.join('\n'));
  console.log('water mask:');
  console.log(waterRows.join('\n'));
  console.log(`histogram: ${[...hist.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}: ${n}`).join(', ')}`);
  const t = dirToTile(centre, 12);
  console.log(`level-12 tile ${t.key.face}/12/${t.key.x}/${t.key.y} uv ${t.u.toFixed(3)}, ${t.v.toFixed(3)}; albedo file ${tilePath(body, TILE_LAYER.albedo, deepestAvailable(manifest.layers[TILE_LAYER.albedo]!, t.key), 'webp')}`);
}

main();
