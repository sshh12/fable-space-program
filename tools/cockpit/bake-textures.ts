/**
 * Bakes the cockpit's tileable detail textures into public/assets/cockpit/:
 *
 *   node tools/dev/heavy.mjs --class=bake -- npx tsx tools/cockpit/bake-textures.ts
 *
 * Two vertical strips of 512 x 512 layers, read by src/render/cockpit/feature.ts into texture arrays:
 *   detail-n.png  r, g = tangent-space normal x, y (+y along v), b = cavity (micro occlusion), a = 1
 *   detail-m.png  r = albedo factor / 2, g = roughness offset + 0.5, b = wear mask (where paint chips first
 *                 on an edge), a = grime mask (where dirt collects)
 * and detail.json naming the layers and their tile sizes in metres (the materials' `detail` kinds map to
 * these layers, src/render/cockpit/layout.ts DETAIL_KINDS).
 *
 * Purely procedural and deterministic: no network, no API key, no spend.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { Field, clamp, fbm, hash, mod, ridged, smooth, vnoise, worley } from '../vehicle/texlib';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'assets', 'cockpit');
const S = 512;

interface Layer {
  name: string;
  /** Tile size, m. */
  tile: number;
  /** Height field in metres (for the normal map), cavity 0..1, and the four mask channels. */
  height: Field;
  cavity: Field;
  albedo: Field;
  rough: Field;
  wear: Field;
  grime: Field;
}

const F = (f: (u: number, v: number, x: number, y: number) => number): Field => Field.from(S, S, f);

/** Cavity of a height field: how far each texel lies below its surroundings (blurred over `radius` texels). */
function cavityOf(h: Field, radius: number, strength: number): Field {
  const tmp = new Field(S, S);
  const blur = new Field(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += h.at(x + k, y);
      tmp.data[y * S + x] = s / (2 * radius + 1);
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += tmp.at(x, y + k);
      blur.data[y * S + x] = s / (2 * radius + 1);
    }
  }
  return F((_u, _v, x, y) => clamp(1 - Math.max(0, blur.at(x, y) - h.at(x, y)) * strength, 0.35, 1));
}

/** Short straight-ish scratches: a periodic field of thin lines in random cells (0..1 depth). */
function scratches(u: number, v: number, cells: number, density: number, seed: number): number {
  let best = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = Math.floor(u * cells) + i;
      const cy = Math.floor(v * cells) + j;
      const hx = mod(cx, cells);
      const hy = mod(cy, cells);
      if (hash(hx, hy, seed) > density) continue;
      const ang = hash(hx, hy, seed + 1) * Math.PI;
      const len = 0.4 + 1.6 * hash(hx, hy, seed + 2);
      const px = (cx + hash(hx, hy, seed + 3)) / cells;
      const py = (cy + hash(hx, hy, seed + 4)) / cells;
      const dx = (u - px) * cells;
      const dy = (v - py) * cells;
      const along = dx * Math.cos(ang) + dy * Math.sin(ang);
      const across = -dx * Math.sin(ang) + dy * Math.cos(ang) - 0.08 * along * along * (hash(hx, hy, seed + 5) - 0.5);
      const w = 0.012 + 0.02 * hash(hx, hy, seed + 6);
      const line = smooth(w, 0, Math.abs(across)) * smooth(len, len * 0.6, Math.abs(along));
      best = Math.max(best, line * (0.4 + 0.6 * hash(hx, hy, seed + 7)));
    }
  }
  return best;
}

/** Chip mask: irregular blobs (Worley cells broken up by noise), high where paint lets go first. */
function chips(u: number, v: number, cells: number, seed: number): number {
  const c = worley(u, v, cells, cells, seed, 1);
  const n = fbm(u, v, cells * 2, cells * 2, 3, seed + 1);
  return clamp(1 - c.f1 * 1.6 + (n - 0.5) * 0.9 + (c.id - 0.5) * 0.5);
}

const layers: Layer[] = [];

// ---- painted aluminium panels (tile 0.5 m): orange peel, sanding marks, scuffs, chips, grime
{
  const peel = F((u, v) => 0.000012 * fbm(u, v, 160, 160, 3, 11) + 0.000006 * fbm(u, v, 40, 40, 2, 12));
  const scr = F((u, v) => scratches(u, v, 48, 0.12, 13));
  const height = F((u, v, x, y) => peel.at(x, y) - 0.000015 * scr.at(x, y));
  layers.push({
    name: 'paint',
    tile: 0.5,
    height,
    cavity: cavityOf(height, 2, 900),
    albedo: F((u, v, x, y) => 0.5 * (1 + 0.05 * (fbm(u, v, 5, 5, 4, 14) - 0.5) + 0.05 * Math.pow(ridged(u, v, 4, 4, 3, 15), 5) + 0.06 * scr.at(x, y))),
    rough: F((u, v, x, y) => 0.5 + 0.06 * (fbm(u, v, 9, 9, 3, 16) - 0.5) - 0.18 * Math.pow(ridged(u, v, 4, 4, 3, 15), 4) - 0.1 * scr.at(x, y)),
    wear: F((u, v) => chips(u, v, 22, 17)),
    grime: F((u, v) => clamp(smooth(0.35, 0.8, fbm(u, v, 6, 6, 5, 18)) * (0.6 + 0.4 * fbm(u, v, 30, 30, 2, 19)))),
  });
}

// ---- brushed aluminium (tile 0.4 m): grain along u, a few deeper scratches, handling smudges
{
  const grain = F((u, v) => {
    const w = v + 0.004 * (fbm(u, v, 2, 2, 2, 31) - 0.5);
    return 0.5 * vnoise(u * 3, w * 256, 3, 256, 32) + 0.3 * vnoise(u * 2, w * 128, 2, 128, 33) + 0.2 * vnoise(u * 6, w * 64, 6, 64, 34);
  });
  const scr = F((u, v) => scratches(u, v, 32, 0.08, 35));
  const height = F((_u, _v, x, y) => 0.000004 * grain.at(x, y) - 0.000008 * scr.at(x, y));
  layers.push({
    name: 'brushed',
    tile: 0.4,
    height,
    cavity: cavityOf(height, 1, 1500),
    albedo: F((u, v, x, y) => 0.5 * (1 + 0.04 * (grain.at(x, y) - 0.5) - 0.04 * (fbm(u, v, 4, 4, 3, 36) - 0.5))),
    rough: F((u, v, x, y) => 0.5 + 0.12 * (grain.at(x, y) - 0.5) + 0.12 * smooth(0.55, 0.85, fbm(u, v, 5, 5, 4, 37)) + 0.08 * scr.at(x, y)),
    wear: F((u, v) => chips(u, v, 18, 38)),
    grime: F((u, v) => smooth(0.4, 0.85, fbm(u, v, 5, 5, 5, 39))),
  });
}

// ---- couch fabric (tile 0.12 m): 2/2 twill (diagonal ribs about 1.9 mm apart), fibre noise, pilling, stains
{
  const ribs = 64;
  const twill = F((u, v) => {
    const d = (u + v) * ribs;
    const rib = 0.5 + 0.5 * Math.cos(2 * Math.PI * d);
    const yarn = vnoise(u * 256, v * 256, 256, 256, 41);
    return rib * 0.8 + yarn * 0.2;
  });
  const height = F((u, v, x, y) => 0.00012 * twill.at(x, y) + 0.0003 * (fbm(u, v, 3, 3, 3, 42) - 0.5));
  layers.push({
    name: 'fabric',
    tile: 0.12,
    height,
    cavity: cavityOf(height, 1, 1200),
    albedo: F((u, v, x, y) => 0.5 * (0.9 + 0.12 * twill.at(x, y) + 0.08 * (fbm(u, v, 12, 12, 3, 43) - 0.5) + 0.1 * Math.pow(vnoise(u * 128, v * 128, 128, 128, 44), 6))),
    rough: F((u, v) => 0.5 - 0.12 * smooth(0.55, 0.9, fbm(u, v, 3, 3, 3, 45))),
    wear: F((u, v) => fbm(u, v, 4, 4, 3, 46)),
    grime: F((u, v) => smooth(0.45, 0.85, fbm(u, v, 3, 3, 5, 47))),
  });
}

// ---- insulation blanket cover (tile 0.2 m): plain weave and the crumple of a sewn blanket
{
  const weave = F((u, v) => {
    const a = Math.cos(2 * Math.PI * u * 128);
    const b = Math.cos(2 * Math.PI * v * 128);
    return 0.5 + 0.25 * a * Math.sign(b) + 0.25 * b * Math.sign(a);
  });
  const crumple = F((u, v) => ridged(u, v, 3, 3, 4, 51, 0.55) * 0.7 + fbm(u, v, 7, 7, 3, 52) * 0.3);
  const height = F((_u, _v, x, y) => 0.00005 * weave.at(x, y) + 0.0012 * crumple.at(x, y));
  layers.push({
    name: 'nomex',
    tile: 0.2,
    height,
    cavity: cavityOf(height, 4, 220),
    albedo: F((u, v, x, y) => 0.5 * (0.94 + 0.06 * weave.at(x, y) + 0.06 * (fbm(u, v, 2, 2, 3, 53) - 0.5) - 0.05 * crumple.at(x, y))),
    rough: F((_u, _v, x, y) => 0.5 + 0.05 * (weave.at(x, y) - 0.5)),
    wear: F((u, v) => fbm(u, v, 4, 4, 3, 54)),
    grime: F((u, v) => smooth(0.4, 0.85, fbm(u, v, 3, 3, 5, 55))),
  });
}

// ---- webbing (tile 0.1 m): herringbone twill across the strap
{
  const hb = F((u, v) => {
    const band = Math.floor(v * 40);
    const dir = band % 2 === 0 ? 1 : -1;
    const d = (u * 96 + dir * v * 96 * 0.5) % 1;
    return 0.5 + 0.5 * Math.cos(2 * Math.PI * d) * 0.8 + 0.2 * vnoise(u * 256, v * 256, 256, 256, 61);
  });
  const height = F((_u, _v, x, y) => 0.00008 * hb.at(x, y));
  layers.push({
    name: 'webbing',
    tile: 0.1,
    height,
    cavity: cavityOf(height, 1, 2000),
    albedo: F((u, v, x, y) => 0.5 * (0.9 + 0.15 * hb.at(x, y) + 0.06 * (fbm(u, v, 4, 4, 3, 62) - 0.5))),
    rough: F((_u, _v, x, y) => 0.5 - 0.08 * hb.at(x, y)),
    wear: F((u, v) => fbm(u, v, 4, 4, 3, 63)),
    grime: F((u, v) => smooth(0.45, 0.9, fbm(u, v, 3, 3, 4, 64))),
  });
}

// ---- velcro loops (tile 0.06 m): dense random fuzz
{
  const fuzz = F((u, v) => 0.6 * vnoise(u * 256, v * 256, 256, 256, 71) + 0.4 * vnoise(u * 128, v * 128, 128, 128, 72));
  const height = F((_u, _v, x, y) => 0.0002 * fuzz.at(x, y));
  layers.push({
    name: 'velcro',
    tile: 0.06,
    height,
    cavity: cavityOf(height, 1, 1500),
    albedo: F((_u, _v, x, y) => 0.5 * (0.8 + 0.35 * fuzz.at(x, y))),
    rough: F(() => 0.5),
    wear: F((u, v) => fbm(u, v, 4, 4, 3, 73)),
    grime: F((u, v) => smooth(0.4, 0.9, fbm(u, v, 3, 3, 4, 74))),
  });
}

// ---- rubber and soft plastic (tile 0.15 m): fine stipple, shiny where rubbed, dust in the grain
{
  const stipple = F((u, v) => fbm(u, v, 128, 128, 2, 81));
  const height = F((u, v, x, y) => 0.00002 * stipple.at(x, y) + 0.00002 * fbm(u, v, 16, 16, 3, 82));
  layers.push({
    name: 'rubber',
    tile: 0.15,
    height,
    cavity: cavityOf(height, 1, 3000),
    albedo: F((u, v) => 0.5 * (1 + 0.1 * (fbm(u, v, 4, 4, 3, 83) - 0.5))),
    rough: F((u, v, x, y) => 0.5 + 0.05 * (stipple.at(x, y) - 0.5) - 0.2 * smooth(0.6, 0.9, fbm(u, v, 3, 3, 3, 84))),
    wear: F((u, v) => chips(u, v, 14, 85)),
    grime: F((u, v) => smooth(0.4, 0.85, fbm(u, v, 4, 4, 4, 86))),
  });
}

// ---- powder coat and black anodising (tile 0.15 m): fine sparkle grain, chips down to bare metal
{
  const grain = F((u, v) => fbm(u, v, 192, 192, 2, 91));
  const height = F((u, v, x, y) => 0.000008 * grain.at(x, y) + 0.00001 * fbm(u, v, 24, 24, 2, 92));
  layers.push({
    name: 'cast',
    tile: 0.15,
    height,
    cavity: cavityOf(height, 1, 3000),
    albedo: F((u, v, x, y) => 0.5 * (1 + 0.12 * (grain.at(x, y) - 0.5) + 0.06 * (fbm(u, v, 3, 3, 3, 93) - 0.5))),
    rough: F((u, v, x, y) => 0.5 + 0.06 * (grain.at(x, y) - 0.5) - 0.1 * smooth(0.6, 0.9, fbm(u, v, 3, 3, 3, 94))),
    wear: F((u, v) => chips(u, v, 26, 95)),
    grime: F((u, v) => smooth(0.4, 0.85, fbm(u, v, 4, 4, 4, 96))),
  });
}

// ---- encode
function strip(pixel: (l: Layer, x: number, y: number) => [number, number, number, number]): Buffer {
  const png = new PNG({ width: S, height: S * layers.length, colorType: 6 });
  layers.forEach((l, k) => {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const c = pixel(l, x, y);
        const o = ((k * S + y) * S + x) * 4;
        for (let i = 0; i < 4; i++) png.data[o + i] = Math.round(clamp(c[i]!) * 255);
      }
    }
  });
  return PNG.sync.write(png, { colorType: 6, deflateLevel: 9 });
}

const normalPixel = (l: Layer, x: number, y: number): [number, number, number, number] => {
  // Slopes in metres per metre: height differences over the texel size.
  const texel = l.tile / S;
  const dx = (l.height.at(x + 1, y) - l.height.at(x - 1, y)) / (2 * texel);
  const dy = (l.height.at(x, y + 1) - l.height.at(x, y - 1)) / (2 * texel);
  const len = Math.hypot(dx, dy, 1);
  return [0.5 - (0.5 * dx) / len, 0.5 - (0.5 * dy) / len, l.cavity.at(x, y), 1];
};
const maskPixel = (l: Layer, x: number, y: number): [number, number, number, number] => [l.albedo.at(x, y), l.rough.at(x, y), l.wear.at(x, y), l.grime.at(x, y)];

fs.mkdirSync(outDir, { recursive: true });
const n = strip(normalPixel);
const m = strip(maskPixel);
fs.writeFileSync(path.join(outDir, 'detail-n.png'), n);
fs.writeFileSync(path.join(outDir, 'detail-m.png'), m);
const manifest = { size: S, layers: layers.map((l) => ({ name: l.name, tile: l.tile })) };
fs.writeFileSync(path.join(outDir, 'detail.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`detail-n.png ${(n.length / 1024).toFixed(0)} KiB, detail-m.png ${(m.length / 1024).toFixed(0)} KiB, ${layers.length} layers of ${S}^2`);
