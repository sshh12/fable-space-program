/**
 * Hillshaded renders of the height function for visual review (out/terrain-core/*.png):
 *   npx tsx tools/terrain-core/render-hillshade.ts
 *  - the lunar landing region (real Moon tiles when baked, else the fixture) at 20 km, 2 km, 200 m, 20 m;
 *  - across a coverage edge of every regional level of the Moon (real) and of the synthetic sparse set,
 *    with the boundary vertical through the image centre (small red ticks on the top and bottom rows mark it);
 *  - the launch pad (real Earth tiles when baked, else the fixture Earth) at 3 km and 300 m.
 * Each pixel samples H at a band limit of 1.5 pixels (anti-aliased, like a rendered tile at that scale);
 * shading is Lambert with a low sun (azimuth 100 deg, elevation 12 deg) plus a little ambient.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { DefLibrary } from '../../src/core/contracts/defs';
import type { TileManifest } from '../../src/core/contracts/terrain';
import { latLonToDir, tileUvToDir, type FaceId, type TileKey } from '../../src/core/geo/cubeSphere';
import { DEG } from '../../src/core/math/scalar';
import type { Vec3 } from '../../src/core/math/vec3';
import { fsDefSource } from '../../src/core/defs/fsSource';
import { loadDefs } from '../../src/core/defs/loader';
import { createFsTileSource } from '../../src/terrain/fsTileSource';
import { createTerrainProvider, type TerrainAuthority } from '../../src/terrain/provider';
import { FIXTURE_POINTS, fixtureDefs, syntheticTileRoot } from './fixtures';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(repo, 'out/terrain-core');
const SIZE = 512;

interface View {
  name: string;
  body: string;
  centre: Vec3;
  /** Unit tangent of the image x axis (east when omitted). */
  xAxis?: Vec3;
  extent: number;
  /** Mark the vertical centre line (coverage boundary) with ticks. */
  mark?: boolean;
}

function basis(c: Vec3, xAxis?: Vec3): { ex: Vec3; ey: Vec3 } {
  let ex: Vec3 = xAxis ?? { x: -c.y, y: c.x, z: 0 };
  const d = ex.x * c.x + ex.y * c.y + ex.z * c.z;
  ex = { x: ex.x - d * c.x, y: ex.y - d * c.y, z: ex.z - d * c.z };
  const l = Math.hypot(ex.x, ex.y, ex.z) || 1;
  ex = { x: ex.x / l, y: ex.y / l, z: ex.z / l };
  const ey = { x: c.y * ex.z - c.z * ex.y, y: c.z * ex.x - c.x * ex.z, z: c.x * ex.y - c.y * ex.x };
  return { ex, ey };
}

async function render(tp: TerrainAuthority, R: number, v: View): Promise<string> {
  const { ex, ey } = basis(v.centre, v.xAxis);
  const px = v.extent / SIZE;
  const lambda = 1.5 * px;
  await tp.ensureLoaded(v.body, v.centre, v.extent * 0.75, `render-${v.name}`);
  const n = SIZE + 2;
  const h = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const ox = (i - 1 - SIZE / 2 + 0.5) * px;
      const oy = (SIZE / 2 - (j - 1) - 0.5) * px;
      const x = v.centre.x + (ex.x * ox + ey.x * oy) / R;
      const y = v.centre.y + (ex.y * ox + ey.y * oy) / R;
      const z = v.centre.z + (ex.z * ox + ey.z * oy) / R;
      const m = Math.hypot(x, y, z);
      h[j * n + i] = tp.heightAt(v.body, { x: x / m, y: y / m, z: z / m }, lambda);
    }
  }
  // Sun in the local frame: x east-ish (image right), y image up, z up.
  const az = 100 * DEG;
  const el = 12 * DEG;
  const sun = { x: Math.sin(az) * Math.cos(el), y: Math.cos(az) * Math.cos(el), z: Math.sin(el) };
  const png = new PNG({ width: SIZE, height: SIZE });
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of h) {
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      const o = (j + 1) * n + (i + 1);
      const dx = (h[o + 1]! - h[o - 1]!) / (2 * px);
      const dy = (h[o - n]! - h[o + n]!) / (2 * px);
      const nl = Math.hypot(dx, dy, 1);
      const lam = Math.max(0, (-dx * sun.x - dy * sun.y + sun.z) / nl);
      const g = Math.min(255, Math.round(255 * Math.pow(0.04 + 0.96 * lam, 1 / 2.2)));
      const k = 4 * (j * SIZE + i);
      png.data[k] = g;
      png.data[k + 1] = g;
      png.data[k + 2] = g;
      png.data[k + 3] = 255;
      if (v.mark && (j < 6 || j >= SIZE - 6) && Math.abs(i - SIZE / 2) <= 1) {
        png.data[k] = 255;
        png.data[k + 1] = 40;
        png.data[k + 2] = 40;
      }
    }
  }
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${v.name}.png`);
  writeFileSync(file, PNG.sync.write(png));
  return `${path.relative(repo, file)}: ${v.extent} m wide, ${px.toFixed(3)} m/px, heights ${lo.toFixed(1)}..${hi.toFixed(1)} m`;
}

/** A point on the coverage boundary of `level` (middle of the longest boundary edge) and the inward axis. */
function boundaryView(layer: TileManifest['layers'][string], level: number): { p: Vec3; inward: Vec3 } | null {
  const rects = layer.coverage[String(level)];
  if (!rects || rects.length === 0) return null;
  const r = rects[0]!;
  // Middle of the west edge of the first rect (x0), where the neighbour x0 - 1 is outside unless another rect has it.
  const yMid = Math.floor((r.y0 + r.y1) / 2);
  const key: TileKey = { face: r.face as FaceId, level, x: r.x0, y: yMid };
  const p = tileUvToDir(key, 0, 0.5);
  const q = tileUvToDir(key, 0.2, 0.5);
  const t = { x: q.x - p.x, y: q.y - p.y, z: q.z - p.z };
  const l = Math.hypot(t.x, t.y, t.z);
  return { p, inward: { x: t.x / l, y: t.y / l, z: t.z / l } };
}

async function main(): Promise<void> {
  const lines: string[] = [];
  const tiles = path.join(repo, 'data/tiles');
  const realMoon = existsSync(path.join(tiles, 'moon', 'manifest.json'));
  const realEarth = existsSync(path.join(tiles, 'earth', 'manifest.json'));
  const fixRoot = await syntheticTileRoot();
  const fixDefs = await fixtureDefs(repo);
  const fixTp = await createTerrainProvider(fixDefs, createFsTileSource(fixRoot));
  let defs: DefLibrary | null = null;
  if (realMoon || realEarth) defs = await loadDefs(fsDefSource(path.join(repo, 'data/defs')));

  // Lunar landing region.
  if (realMoon && defs) {
    const tp = await createTerrainProvider(defs, createFsTileSource(tiles), { bodies: ['moon'] });
    const R = defs.bodies['moon']!.radius;
    const region = JSON.parse(readFileSync(path.join(repo, 'data/defs/regions/moon-tranquility.json'), 'utf8')) as { recommendedTarget: { latDeg: number; lonDeg: number } };
    const c = latLonToDir(region.recommendedTarget.latDeg * DEG, region.recommendedTarget.lonDeg * DEG);
    for (const e of [20000, 2000, 200, 20]) lines.push(await render(tp, R, { name: `moon-target-${e}m`, body: 'moon', centre: c, extent: e }));
    // A global-only (procedural-heavy) mare area for comparison: 60 km west of the region.
    const g = latLonToDir(0.5 * DEG, 21.5 * DEG);
    for (const e of [2000, 200]) lines.push(await render(tp, R, { name: `moon-global-${e}m`, body: 'moon', centre: g, extent: e }));
    const m = JSON.parse(readFileSync(path.join(tiles, 'moon', 'manifest.json'), 'utf8')) as TileManifest;
    const layer = m.layers['height']!;
    for (const L of Object.keys(layer.coverage).map(Number).sort((a, b) => a - b)) {
      const bv = boundaryView(layer, L);
      if (!bv) continue;
      const tileSize = (Math.PI * R) / 2 / 2 ** L;
      // The blend ring is a quarter tile wide: show 1.5 tile widths across the boundary, and a close-up.
      lines.push(await render(tp, R, { name: `moon-edge-L${L}`, body: 'moon', centre: bv.p, xAxis: bv.inward, extent: 1.5 * tileSize, mark: true }));
      lines.push(await render(tp, R, { name: `moon-edge-L${L}-close`, body: 'moon', centre: bv.p, xAxis: bv.inward, extent: Math.max(50, tileSize / 16), mark: true }));
    }
  } else {
    for (const e of [20000, 2000, 200, 20]) lines.push(await render(fixTp, 1737400, { name: `moon-fixture-${e}m`, body: 'moon', centre: FIXTURE_POINTS.moonDeep, extent: e }));
  }

  // Synthetic sparse set: every regional level, incl. the region straddling the cube edge.
  const fm = JSON.parse(readFileSync(path.join(fixRoot, 'fixture-moon', 'manifest.json'), 'utf8')) as TileManifest;
  for (const L of [3, 4, 5]) {
    const bv = boundaryView(fm.layers['height']!, L);
    if (!bv) continue;
    const ts = (Math.PI * 1737400) / 2 / 2 ** L;
    lines.push(await render(fixTp, 1737400, { name: `fixture-edge-L${L}`, body: 'moon', centre: bv.p, xAxis: bv.inward, extent: 1.5 * ts, mark: true }));
    lines.push(await render(fixTp, 1737400, { name: `fixture-edge-L${L}-close`, body: 'moon', centre: bv.p, xAxis: bv.inward, extent: 2000, mark: true }));
  }
  lines.push(await render(fixTp, 1737400, { name: 'fixture-cube-edge', body: 'moon', centre: FIXTURE_POINTS.moonCubeEdge, extent: 2000 }));

  // Launch pad.
  if (realEarth && defs) {
    const tp = await createTerrainProvider(defs, createFsTileSource(tiles), { bodies: ['earth'] });
    const s = Object.values(defs.sites).find((x) => x.bodyId === 'earth')!;
    const c = latLonToDir(s.location.latDeg * DEG, s.location.lonDeg * DEG);
    for (const e of [3000, 300]) lines.push(await render(tp, defs.bodies['earth']!.radius, { name: `earth-pad-${e}m`, body: 'earth', centre: c, extent: e }));
  } else {
    for (const e of [3000, 300]) lines.push(await render(fixTp, 6371000, { name: `earth-fixture-pad-${e}m`, body: 'earth', centre: FIXTURE_POINTS.padDir, extent: e }));
  }
  for (const l of lines) console.log(l);
}

await main();
