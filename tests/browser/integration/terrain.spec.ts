/**
 * Checks (d) and (e) with the real terrain renderer on the real baked tiles.
 *
 * (d) Coverage edges: fly across the boundary of the regional coverage of both bodies at 5 km and 50 km
 *     above the ground, looking straight down with the boundary running vertically through the image, and
 *     look for a line along it in geometry (scene depth), shading (lit image) and imagery (G-buffer albedo).
 *     Measure: the signed difference between neighbouring pixel columns, MEDIAN over all rows. Terrain
 *     texture has no preferred sign and a coastline or a ridge crosses a column in a few rows only; a line
 *     along the boundary is the same step in every row.
 * (e) Image decode: a coastal albedo tile ON THE GPU (read back from the terrain's tile pool) equals a
 *     reference decode of the same file, land included (a premultiplied or colour-converted decode darkens
 *     it), and its land reaches the G-buffer undarkened (the water mask is decoded by the tile codec).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { TileLayerManifest, TileManifest, TileRect } from '../../../src/core/contracts/terrain';
import { dirToLatLon, dirToTile, latLonToDir, tileUvToDir, type TileKey } from '../../../src/core/geo/cubeSphere';
import { decodeTileFile } from '../../../src/core/geo/tileCodec';
import { v3, type Vec3 } from '../../../src/core/math/vec3';
import { expect, test } from '../harness';
import { expectClean, freeze, openIntegration, record, repoRoot, requireFeatures, save, settle } from './helpers';

test.describe.configure({ timeout: 30 * 60_000 });

const RAD = 180 / Math.PI;
const manifestOf = (tileset: string): TileManifest => JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'tiles', tileset, 'manifest.json'), 'utf8')) as TileManifest;

interface EdgePoint {
  level: number;
  side: 'x0' | 'y1';
  latDeg: number;
  lonDeg: number;
  /** Bearing (deg clockwise from north) of the boundary line at the point. */
  bearingDeg: number;
  /** Unit vector (body-fixed) across the boundary, pointing out of the coverage. */
  outward: Vec3;
  dir: Vec3;
}

/** Midpoint of the low-x edge and of the high-y edge of the coverage rectangle of `level`. */
function edgePoints(layer: TileLayerManifest, level: number): EdgePoint[] {
  const rect: TileRect | undefined = layer.coverage[String(level)]?.[0];
  if (!rect) return [];
  const out: EdgePoint[] = [];
  const mk = (side: 'x0' | 'y1'): void => {
    const xm = Math.floor((rect.x0 + rect.x1) / 2);
    const ym = Math.floor((rect.y0 + rect.y1) / 2);
    const key: TileKey = side === 'x0' ? { face: rect.face, level, x: rect.x0, y: ym } : { face: rect.face, level, x: xm, y: rect.y1 };
    const at = (a: number, across: number): Vec3 => (side === 'x0' ? tileUvToDir(key, across, a) : tileUvToDir(key, a, 1 + across));
    const dir = at(0.5, 0);
    const along = v3.normalize(v3.sub(at(0.75, 0), at(0.25, 0)));
    const outward = v3.normalize(v3.reject(v3.sub(at(0.5, side === 'x0' ? -0.2 : 0.2), dir), dir));
    const east = v3.normalize(v3.cross({ x: 0, y: 0, z: 1 }, dir));
    const north = v3.cross(dir, east);
    const ll = dirToLatLon(dir);
    out.push({ level, side, latDeg: ll.lat * RAD, lonDeg: ll.lon * RAD, bearingDeg: Math.atan2(v3.dot(along, east), v3.dot(along, north)) * RAD, outward, dir });
  };
  mk('x0');
  mk('y1');
  return out;
}

interface ColumnSteps {
  /** Per column x: median over the rows of value(x + 1, y) - value(x, y), relative to the image mean. */
  shading: number[];
  imagery: number[];
  geometry: number[];
  width: number;
}

/** Column-step profiles of the frame on screen: lit image, G-buffer albedo and scene distance. */
async function columnSteps(page: Page): Promise<ColumnSteps> {
  return page.evaluate(async () => {
    const lab = window.__integration!;
    const r = lab.app.renderer;
    const profile = (w: number, h: number, value: (x: number, y: number) => number): number[] => {
      let mean = 0;
      for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) mean += Math.abs(value(x, y));
      mean /= Math.ceil(h / 4) * Math.ceil(w / 4);
      const out: number[] = [];
      const column = new Float64Array(h);
      for (let x = 0; x + 1 < w; x++) {
        for (let y = 0; y < h; y++) column[y] = value(x + 1, y) - value(x, y);
        column.sort();
        out.push((0.5 * (column[(h - 1) >> 1]! + column[h >> 1]!)) / (mean || 1));
      }
      return out;
    };
    const luma = (img: { width: number; data: Float32Array }) => (x: number, y: number): number => {
      const o = (y * img.width + x) * 4;
      return 0.2126 * img.data[o]! + 0.7152 * img.data[o + 1]! + 0.0722 * img.data[o + 2]!;
    };
    await window.__test!.waitFrames(3);
    const lit = await r.readHdrPixels('hdr');
    const depth = await r.readDepth();
    lab.showGBuffer('albedo');
    await window.__test!.waitFrames(3);
    const albedo = await r.readHdrPixels('hdr');
    lab.showGBuffer(null);
    await window.__test!.waitFrames(2);
    return {
      width: lit.width,
      shading: profile(lit.width, lit.height, luma(lit)),
      imagery: profile(albedo.width, albedo.height, luma(albedo)),
      // Distance along the view axis (the view looks straight down: height above the surface).
      geometry: profile(depth.width, depth.height, (x, y) => 0.05 / Math.max(depth.data[y * depth.width + x]!, 1e-30)),
    };
  });
}

/** Largest column step within `half` columns of `column`, in units of the profile's median absolute step. */
function lineStrength(profile: number[], column: number, half = 4): { strength: number; step: number; median: number } {
  const abs = profile.map(Math.abs);
  const sorted = [...abs].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1]!;
  let step = 0;
  for (let x = Math.max(0, Math.round(column) - half); x <= Math.min(profile.length - 1, Math.round(column) + half); x++) step = Math.max(step, abs[x]!);
  return { strength: step / (median || 1e-12), step, median };
}

for (const [bodyId, tileset] of [
  ['earth', 'earth'],
  ['moon', 'moon'],
] as const) {
  test(`(d) no line along the regional coverage boundary of ${bodyId} at 5 km and 50 km (geometry, shading, imagery)`, async ({ page, pageLog }) => {
    // The terrain and the sky's light alone: clouds, their shadows and the sea's glitter are not the
    // terrain's lines (a cloud over the boundary is a column step of its own).
    const info = await openIntegration(page, `features=terrain,sky&scene=${bodyId === 'earth' ? 'lowOrbit' : 'lunarOrbit'}&paused=1&hud=0&governor=off&ev=${bodyId === 'earth' ? 14.5 : 13.5}`);
    requireFeatures(test, info, ['terrain']);
    await freeze(page);
    const height = manifestOf(tileset).layers['height']!;
    const levels = Object.keys(height.coverage)
      .map(Number)
      .sort((a, b) => a - b);
    const deepest = levels[levels.length - 1]!;
    const coarsest = levels[0]!;
    // 5 km: a pixel is about 8 m, the two deepest levels are on screen. 50 km: 80 m, the two coarsest regional levels.
    const cases = [
      { height: 5_000, levels: [deepest, deepest - 1] },
      { height: 50_000, levels: [coarsest + 1, coarsest] },
    ];
    const results: { height: number; level: number; side: string; offset: number; shading: number; imagery: number; geometry: number; steps: [number, number, number] }[] = [];
    for (const c of cases) {
      for (const level of c.levels) {
        for (const e of edgePoints(height, level)) {
          await page.evaluate(([b, lat, lon]) => window.__integration!.setSun({ bodyId: b as string, latDeg: lat as number, lonDeg: lon as number, alt: 0 }, 110, 30), [bodyId, e.latDeg, e.lonDeg]);
          // Three camera positions across the boundary: it runs at 25 %, 50 % and 75 % of the image width.
          const viewWidth = 2 * c.height * Math.tan((30 * Math.PI) / 180) * (1280 / 720);
          const radius = manifestOf(tileset).radius;
          for (const offset of [-0.25, 0, 0.25]) {
            const centre = v3.normalize(v3.addScaled(e.dir, e.outward, (offset * viewWidth) / radius));
            const ll = dirToLatLon(centre);
            await page.evaluate(([b, lat, lon, h, heading]) => window.__integration!.aboveGround(b as string, lat as number, lon as number, h as number, heading as number, -90), [bodyId, ll.lat * RAD, ll.lon * RAD, c.height, e.bearingDeg]);
            await settle(page, 6);
            const column = await page.evaluate(([b, lat, lon]) => window.__integration!.groundHeight(b as string, lat as number, lon as number).then((g) => window.__integration!.project(b as string, lat as number, lon as number, g)), [bodyId, e.latDeg, e.lonDeg]);
            expect(column, 'the boundary point is in front of the camera').not.toBeNull();
            expect(column!.x).toBeGreaterThan(40);
            expect(column!.x).toBeLessThan(1240);
            const p = await columnSteps(page);
            const s = lineStrength(p.shading, column!.x);
            const i = lineStrength(p.imagery, column!.x);
            const g = lineStrength(p.geometry, column!.x);
            results.push({ height: c.height, level, side: e.side, offset, shading: s.strength, imagery: i.strength, geometry: g.strength, steps: [s.step, i.step, g.step] });
            if (offset === 0) await save(page, `coverage-edge-${bodyId}-${c.height / 1000}km-L${level}-${e.side}`);
          }
        }
      }
    }
    const worst = (k: 'shading' | 'imagery' | 'geometry'): number => Math.max(...results.map((r) => r[k]));
    console.log(`(d) ${bodyId}: ${results.length} views; worst line strength (boundary step / median column step): shading ${worst('shading').toFixed(1)}, imagery ${worst('imagery').toFixed(1)}, geometry ${worst('geometry').toFixed(1)}`);
    record(`d.coverageEdge.${bodyId}`, { loaded: info.loaded, views: results.length, worst: { shading: worst('shading'), imagery: worst('imagery'), geometry: worst('geometry') }, results });
    // A line is a step that stands out of the column statistics AND can be seen: more than 8 times the
    // median column step and more than 2 % of the image mean (shading, imagery: a straight step of 1 % is
    // at the limit of what an eye finds on a smooth field, and the ground is not smooth) / 0.05 % of the
    // height (geometry: 2.5 m from 5 km, a quarter of a pixel's parallax).
    const lines = results.filter((r) => (r.shading > 8 && r.steps[0] > 0.02) || (r.imagery > 8 && r.steps[1] > 0.02) || (r.geometry > 8 && r.steps[2] > 0.0005));
    const largest = (k: 0 | 1 | 2): number => Math.max(...results.map((r) => r.steps[k]));
    console.log(`(d) ${bodyId}: largest step along the boundary, relative to the image mean: shading ${(100 * largest(0)).toFixed(2)} %, imagery ${(100 * largest(1)).toFixed(2)} %, geometry ${(100 * largest(2)).toFixed(4)} % of the height`);
    expect(lines, 'views with a line along the coverage boundary').toEqual([]);
    await expectClean(page, pageLog, info);
  });
}

test('(e) image decode: the land of a coastal albedo tile is in the G-buffer undarkened', async ({ page, pageLog }) => {
  const defs = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'sites', 'ka-lae-lc1.location.json'), 'utf8')) as { latDeg?: number; lonDeg?: number; location?: { latDeg: number; lonDeg: number } };
  const lat = defs.location?.latDeg ?? defs.latDeg ?? 18.987556;
  const lon = defs.location?.lonDeg ?? defs.lonDeg ?? -155.603239;
  const manifest = manifestOf('earth');
  const level = manifest.layers['albedo']!.globalMaxLevel;
  const { key } = dirToTile(latLonToDir(lat / RAD, lon / RAD), level);
  // 190 km above the tile centre a 720p pixel is about one texel of the deepest global level (305 m).
  const centre = dirToLatLon(tileUvToDir(key, 0.5, 0.5));
  const info = await openIntegration(page, `scene=lowOrbit&paused=1&hud=0&ev=14.5&without=atmosphere,ocean,vfx&body=earth&lat=${centre.lat * RAD}&lon=${centre.lon * RAD}&alt=190000&pitch=-90`);
  requireFeatures(test, info, ['terrain']);
  await freeze(page);
  await settle(page, 12);

  // Reference: the tile file decoded in the page without premultiplication or colour conversion, and the
  // water mask decoded by the tile codec. Sample points on a 24 x 24 grid inside the tile.
  const mask = await decodeTileFile(new Uint8Array(fs.readFileSync(path.join(repoRoot, 'data', 'tiles', 'earth', 'watermask', String(key.face), String(key.level), String(key.x), `${key.y}.${manifest.layers['watermask']!.ext}`))));
  if (mask.kind !== 'u8') throw new Error('the watermask tile is not a byte tile');
  const N = 24;
  const points: { u: number; v: number; latDeg: number; lonDeg: number; water: number }[] = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N;
      const v = (j + 0.5) / N;
      const ll = dirToLatLon(tileUvToDir(key, u, v));
      const m = mask.data[Math.min(255, Math.floor(v * 256)) * 256 + Math.min(255, Math.floor(u * 256))]!;
      points.push({ u, v, latDeg: ll.lat * RAD, lonDeg: ll.lon * RAD, water: m / 255 });
    }
  }
  const url = `/tiles/earth/albedo/${key.face}/${key.level}/${key.x}/${key.y}.${manifest.layers['albedo']!.ext}`;

  // 1. The tile in the terrain's GPU pool against the reference decode, texel by texel.
  const pool = await page.evaluate(
    async ([lat, lon, level, ext]) => {
      const lab = window.__integration!;
      const terrain = lab.handles['terrain.createTerrainFeature'] as { debug: { readyTileAt(b: string, lat: number, lon: number, maxLevel?: number): { face: number; level: number; x: number; y: number } | null; readTile(b: string, k: unknown): Promise<{ albedo: Uint8Array | null }> } };
      const k = terrain.debug.readyTileAt('earth', lat as number, lon as number, level as number);
      if (!k) return null;
      const gpu = (await terrain.debug.readTile('earth', k)).albedo;
      if (!gpu) return { key: k, gpu: null, ref: null };
      const blob = await (await fetch(`/tiles/earth/albedo/${k.face}/${k.level}/${k.x}/${k.y}.${ext as string}`)).blob();
      const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const c2d = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { colorSpace: 'srgb' })!;
      c2d.drawImage(bitmap, 0, 0);
      return { key: k, size: bitmap.width, gpu: Array.from(gpu), ref: Array.from(c2d.getImageData(0, 0, bitmap.width, bitmap.height).data) };
    },
    [centre.lat * RAD, centre.lon * RAD, level, manifest.layers['albedo']!.ext] as const,
  );
  expect(pool, 'a READY terrain tile over the coast').not.toBeNull();
  expect(pool!.gpu, `tile ${JSON.stringify(pool!.key)} carries imagery on the GPU`).not.toBeNull();
  const pk = pool!.key;
  const poolMask = await decodeTileFile(new Uint8Array(fs.readFileSync(path.join(repoRoot, 'data', 'tiles', 'earth', 'watermask', String(pk.face), String(pk.level), String(pk.x), `${pk.y}.${manifest.layers['watermask']!.ext}`))));
  if (poolMask.kind !== 'u8') throw new Error('the watermask tile is not a byte tile');
  const size = pool!.size!;
  expect(pool!.gpu!.length).toBe(size * size * 4);
  const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lumaOf = (d: number[], o: number): number => 0.2126 * toLinear(d[o]! / 255) + 0.7152 * toLinear(d[o + 1]! / 255) + 0.0722 * toLinear(d[o + 2]! / 255);
  let landTexels = 0;
  let worstByte = 0;
  let gpuLand = 0;
  let refLand = 0;
  for (let i = 0; i < size * size; i++) {
    if (poolMask.data[i]! > 25) continue; // water
    landTexels++;
    for (let c = 0; c < 3; c++) worstByte = Math.max(worstByte, Math.abs(pool!.gpu![i * 4 + c]! - pool!.ref![i * 4 + c]!));
    gpuLand += lumaOf(pool!.gpu!, i * 4);
    refLand += lumaOf(pool!.ref!, i * 4);
  }
  console.log(`(e) tile ${pk.face}/${pk.level}/${pk.x}/${pk.y} in the terrain's GPU pool against the reference decode: ${landTexels} land texels of ${size * size}, largest byte difference ${worstByte}, land luminance GPU / reference ${(gpuLand / refLand).toFixed(4)}`);
  record('e.imageDecode.pool', { tile: pk, landTexels, worstByte, ratio: gpuLand / refLand });
  expect(landTexels, 'the tile is coastal: it has land').toBeGreaterThan(500);
  expect(landTexels, 'the tile is coastal: it has water').toBeLessThan(size * size - 500);
  expect(worstByte, 'largest difference of a land texel between the GPU tile and the reference decode (8-bit)').toBeLessThanOrEqual(1);
  expect(Math.abs(gpuLand / refLand - 1)).toBeLessThan(0.002);

  // 2. The same land in the G-buffer.
  const measured = await page.evaluate(
    async ([tileUrl, pts]) => {
      const lab = window.__integration!;
      const blob = await (await fetch(tileUrl as string)).blob();
      const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const c2d = canvas.getContext('2d', { colorSpace: 'srgb' })!;
      c2d.drawImage(bitmap, 0, 0);
      const ref = c2d.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      lab.showGBuffer('albedo');
      await window.__test!.waitFrames(3);
      const img = await lab.app.renderer.readHdrPixels('hdr');
      lab.showGBuffer('material');
      await window.__test!.waitFrames(3);
      const mat = await lab.app.renderer.readHdrPixels('hdr');
      lab.showGBuffer(null);
      const out: { ref: number; gpu: number; id: number; onScreen: boolean }[] = [];
      for (const p of pts as { u: number; v: number; latDeg: number; lonDeg: number }[]) {
        // Reference: mean of the 5 x 5 texels around the point (rows increase with v).
        const tx = Math.min(bitmap.width - 3, Math.max(2, Math.floor(p.u * bitmap.width)));
        const ty = Math.min(bitmap.height - 3, Math.max(2, Math.floor(p.v * bitmap.height)));
        let r = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const o = ((ty + dy) * bitmap.width + tx + dx) * 4;
            r += 0.2126 * toLinear(ref[o]! / 255) + 0.7152 * toLinear(ref[o + 1]! / 255) + 0.0722 * toLinear(ref[o + 2]! / 255);
          }
        }
        const s = lab.project('earth', p.latDeg, p.lonDeg, 0);
        const sx = s ? Math.round(s.x) : -1;
        const sy = s ? Math.round(s.y) : -1;
        const onScreen = sx >= 3 && sy >= 3 && sx < img.width - 3 && sy < img.height - 3;
        let g = 0;
        if (onScreen) {
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const o = ((sy + dy) * img.width + sx + dx) * 4;
              g += 0.2126 * img.data[o]! + 0.7152 * img.data[o + 1]! + 0.0722 * img.data[o + 2]!;
            }
          }
        }
        out.push({ ref: r / 25, gpu: g / 25, id: onScreen ? Math.round(mat.data[(sy * mat.width + sx) * 4 + 1]!) : -1, onScreen });
      }
      return out;
    },
    [url, points] as const,
  );
  await save(page, 'image-decode-coastal-tile');
  // Land points: the mask says land at the point and the G-buffer has a terrain material there.
  const land = measured.map((m, k) => ({ ...m, water: points[k]!.water })).filter((m) => m.onScreen && m.water < 0.1 && m.id === 1 && m.ref > 0.004);
  const ratios = land.map((m) => m.gpu / m.ref).sort((a, b) => a - b);
  const median = ratios[ratios.length >> 1] ?? 0;
  const low = ratios[Math.floor(ratios.length * 0.1)] ?? 0;
  const meanRef = land.reduce((a, m) => a + m.ref, 0) / Math.max(1, land.length);
  const meanGpu = land.reduce((a, m) => a + m.gpu, 0) / Math.max(1, land.length);
  let cov = 0;
  let varRef = 0;
  let varGpu = 0;
  for (const m of land) {
    cov += (m.ref - meanRef) * (m.gpu - meanGpu);
    varRef += (m.ref - meanRef) ** 2;
    varGpu += (m.gpu - meanGpu) ** 2;
  }
  const correlation = cov / Math.sqrt(varRef * varGpu || 1);
  console.log(`(e) coastal tile ${key.face}/${key.level}/${key.x}/${key.y}: ${land.length} land points of ${points.length}; G-buffer / reference luminance median ${median.toFixed(3)}, 10th percentile ${low.toFixed(3)}, correlation ${correlation.toFixed(3)}`);
  record('e.imageDecode', { loaded: info.loaded, tile: key, landPoints: land.length, median, p10: low, correlation });
  expect(land.length).toBeGreaterThan(20);
  // A premultiplied or colour-converted decode darkens land (to nothing where alpha is 0): the land the
  // renderer shades from is the decoded colour, give or take its detail modulation around the imagery.
  expect(median).toBeGreaterThan(0.8);
  expect(median).toBeLessThan(1.25);
  expect(low).toBeGreaterThan(0.5);
  expect(correlation).toBeGreaterThan(0.7);
  await expectClean(page, pageLog, info);
});
