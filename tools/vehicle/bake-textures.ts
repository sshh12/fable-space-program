/**
 * Bakes the tileable material textures of the vehicle and launch complex into public/assets/vehicle/.
 *
 *   node tools/dev/heavy.mjs --class=bake -- npx tsx tools/vehicle/bake-textures.ts [name ...]
 *
 * Purely procedural and deterministic: no network, no API key. Albedo maps are sRGB, normal maps are
 * tangent space with +Y up in v, ORM maps are R = ambient occlusion, G = roughness factor, B = metallic
 * factor (both factors multiply the material's values, so they stay at or below 1).
 * The tile sizes in metres must match `tile` in src/render/vehicle/materials.ts.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Field, Image, cavity, clamp, fbm, hash, mix, mod, normalMap, ridged, smooth, vnoise, worley } from './texlib';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'assets', 'vehicle');
const only = new Set(process.argv.slice(2));
let totalBytes = 0;

function save(name: string, img: Image): void {
  const bytes = img.save(path.join(outDir, `${name}.png`));
  totalBytes += bytes;
  console.log(`${name}.png  ${img.w}x${img.h}  ${(bytes / 1024).toFixed(0)} KiB`);
}

const orm = (w: number, h: number, f: (u: number, v: number, x: number, y: number) => [number, number, number]): Image => Image.from(w, h, f);
const rgb = (r: number, g: number, b: number): [number, number, number] => [r / 255, g / 255, b / 255];
const tint = (c: [number, number, number], k: number): [number, number, number] => [c[0] * k, c[1] * k, c[2] * k];
const lerp3 = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

const recipes: Record<string, () => void> = {
  // Painted metal, tile 0.6 m: orange peel of the sprayed coat, faint waviness, handling scuffs.
  paint() {
    const S = 512;
    const h = Field.from(S, S, (u, v) => 0.00009 * fbm(u, v, 96, 96, 2, 11) + 0.00016 * fbm(u, v, 12, 12, 3, 12));
    save('paint_n', normalMap(h, 0.6));
    save(
      'paint_orm',
      orm(S, S, (u, v) => {
        const dust = fbm(u, v, 6, 6, 4, 21);
        const scuff = Math.pow(ridged(u, v, 5, 24, 3, 22), 6);
        return [1, clamp(0.8 + 0.2 * dust + 0.25 * scuff), 1];
      }),
    );
  },

  // Brushed sheet, tile 0.4 m: the grain runs along u.
  brushed() {
    const S = 512;
    const grain = Field.from(S, S, (u, v) => fbm(u, v, 3, 220, 3, 31) * 0.6 + 0.4 * vnoise(u * 2, v * 512, 2, 512, 33));
    const h = Field.from(S, S, (u, v, x, y) => 0.000035 * grain.at(x, y) + 0.00012 * fbm(u, v, 3, 3, 2, 34));
    save('brushed_n', normalMap(h, 0.4));
    save(
      'brushed_orm',
      orm(S, S, (u, v, x, y) => {
        const g = grain.at(x, y);
        const stain = fbm(u, v, 4, 4, 4, 35);
        return [1, clamp(0.72 + 0.2 * g + 0.14 * stain), clamp(0.93 + 0.07 * smooth(0.3, 0.6, stain))];
      }),
    );
  },

  // Cast / forged surface, tile 0.3 m: pebbly skin with a few pits.
  cast() {
    const S = 512;
    const pits = Field.from(S, S, (u, v) => smooth(0.16, 0.05, worley(u, v, 40, 40, 41).f1) * hash(Math.floor(u * 40), Math.floor(v * 40), 42));
    const h = Field.from(S, S, (u, v, x, y) => 0.00022 * fbm(u, v, 48, 48, 3, 43) + 0.0004 * fbm(u, v, 8, 8, 3, 44) - 0.0005 * pits.at(x, y));
    save('cast_n', normalMap(h, 0.3));
    const ao = cavity(h, 3, 2500);
    save(
      'cast_orm',
      orm(S, S, (u, v, x, y) => [clamp(ao.at(x, y) * (1 - 0.4 * pits.at(x, y))), clamp(0.82 + 0.18 * fbm(u, v, 24, 24, 3, 45)), clamp(0.9 + 0.1 * fbm(u, v, 5, 5, 3, 46))]),
    );
  },

  // Channel-wall nozzle, tile 0.25 m around: 16 coolant channels per tile running along v, braze fillets between.
  tubewall() {
    const S = 512;
    const h = Field.from(S, S, (u, v) => {
      const t = mod(u * 16, 1);
      const crown = Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2));
      return 0.0016 * crown + 0.00006 * fbm(u, v, 64, 8, 2, 51);
    });
    save('tubewall_n', normalMap(h, 0.25, 0.85));
  },

  // Oxide heat tint on nickel alloy, tile 0.5 x 1 m: straw, bronze, purple and blue patches over bare metal.
  heat() {
    const S = 512;
    const ramp: [number, [number, number, number]][] = [
      [0.0, rgb(150, 146, 140)],
      [0.3, rgb(158, 142, 112)],
      [0.46, rgb(150, 112, 70)],
      [0.6, rgb(118, 72, 96)],
      [0.74, rgb(66, 74, 132)],
      [0.88, rgb(84, 112, 150)],
      [1.0, rgb(128, 136, 142)],
    ];
    save(
      'heat_albedo',
      Image.from(S, S, (u, v) => {
        // Bands across the flow (constant v) broken up by noise: the tint follows temperature along the part.
        const band = 0.5 + 0.5 * Math.sin(2 * Math.PI * (v + 0.18 * fbm(u, v, 3, 2, 3, 61)));
        const t = clamp(0.12 + 0.8 * band * (0.65 + 0.5 * fbm(u, v, 4, 3, 4, 62)));
        let c = ramp[ramp.length - 1]![1];
        for (let i = 0; i + 1 < ramp.length; i++) {
          if (t <= ramp[i + 1]![0]) {
            c = lerp3(ramp[i]![1], ramp[i + 1]![1], (t - ramp[i]![0]) / (ramp[i + 1]![0] - ramp[i]![0]));
            break;
          }
        }
        return tint(c, 0.9 + 0.1 * fbm(u, v, 40, 40, 2, 63));
      }),
    );
  },

  // 2 x 2 twill carbon fabric under resin, tile 0.25 m: 32 tows each way.
  carbon() {
    const S = 512;
    const N = 32;
    const tow = (u: number, v: number): { warp: boolean; across: number; along: number } => {
      const i = Math.floor(u * N);
      const j = Math.floor(v * N);
      const warp = mod(i + j, 4) < 2;
      const fu = u * N - i;
      const fv = v * N - j;
      return warp ? { warp, across: fu, along: fv + j } : { warp, across: fv, along: fu + i };
    };
    const h = Field.from(S, S, (u, v) => {
      const t = tow(u, v);
      return 0.00028 * Math.sqrt(Math.max(0, 1 - (2 * t.across - 1) ** 2)) + 0.00003 * fbm(u, v, 128, 128, 1, 71);
    });
    save('carbon_n', normalMap(h, 0.25, 0.7));
    save(
      'carbon_albedo',
      Image.from(S, S, (u, v) => {
        const t = tow(u, v);
        const fibre = vnoise(t.across * 9 + (t.warp ? 0 : 40), t.along * 0.7, 4096, 4096, 72);
        const k = 0.19 + 0.05 * (t.warp ? 1 : 0.55) + 0.035 * fibre + 0.02 * fbm(u, v, 3, 3, 3, 73);
        return [k, k, k * 1.03];
      }),
    );
    save(
      'carbon_orm',
      orm(S, S, (u, v) => {
        const t = tow(u, v);
        const edge = Math.abs(2 * t.across - 1);
        return [clamp(1 - 0.35 * smooth(0.75, 1, edge)), clamp(0.82 + 0.18 * edge), 1];
      }),
    );
  },

  // Spray-on foam insulation, tile 2.4 m: popcorn skin over irregular spray lumps. Nothing in it is larger
  // than a few decimetres: a bigger feature would show the tile repeat on a 9 m tank (the large-scale tone
  // differences are separate materials on the mesh).
  foam() {
    const S = 1024;
    const lump = (u: number, v: number): number => {
      const c = worley(u + 0.02 * fbm(u, v, 16, 16, 2, 80), v, 22, 26, 81, 1);
      return 1 - smooth(0.0, 0.75, c.f1);
    };
    const h = Field.from(S, S, (u, v) => {
      const pop = 1 - smooth(0.0, 0.55, worley(u, v, 120, 120, 82).f1);
      return 0.0035 * pop + 0.006 * fbm(u, v, 20, 20, 3, 83) + 0.009 * lump(u, v);
    });
    save('foam_n', normalMap(h, 2.4, 0.9));
    const ao = cavity(h, 3, 160);
    save(
      'foam_orm',
      orm(S, S, (u, v, x, y) => [ao.at(x, y), clamp(0.9 + 0.1 * fbm(u, v, 30, 30, 2, 85)), 1]),
    );
    const fresh = rgb(216, 150, 78);
    const aged = rgb(178, 106, 50);
    const pale = rgb(226, 172, 104);
    const colour = (u: number, v: number, x: number, y: number): [number, number, number] => {
      const age = smooth(0.25, 0.8, fbm(u, v, 12, 12, 5, 86));
      const patch = smooth(0.7, 0.78, fbm(u, v, 18, 18, 3, 87));
      let c = lerp3(fresh, aged, age * 0.5);
      c = lerp3(c, pale, patch * 0.3);
      return tint(c, (0.86 + 0.14 * fbm(u, v, 110, 110, 2, 88)) * (0.74 + 0.26 * ao.at(x, y)));
    };
    save('foam_albedo', Image.from(S, S, colour));
    // The same foam under a white top coat: the relief stays, the colour is a slightly yellowed off-white.
    save(
      'foamwhite_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const yellow = smooth(0.35, 0.8, fbm(u, v, 12, 12, 5, 86));
        const c = lerp3(rgb(232, 230, 222), rgb(222, 213, 190), yellow * 0.5);
        return tint(c, (0.94 + 0.06 * fbm(u, v, 110, 110, 2, 88)) * (0.84 + 0.16 * ao.at(x, y)));
      }),
    );
  },

  // Cork ablative sheet, tile 0.7 m: pressed granules.
  cork() {
    const S = 512;
    const cells = (u: number, v: number) => worley(u, v, 90, 90, 91);
    const h = Field.from(S, S, (u, v) => {
      const c = cells(u, v);
      return 0.0012 * smooth(0.0, 0.5, c.f2 - c.f1) * (0.5 + c.id) + 0.0015 * fbm(u, v, 10, 10, 3, 92);
    });
    save('cork_n', normalMap(h, 0.7));
    const ao = cavity(h, 2, 900);
    save(
      'cork_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const c = cells(u, v);
        const base = lerp3(rgb(150, 104, 62), rgb(196, 152, 102), c.id);
        const gap = smooth(0.12, 0.0, c.f2 - c.f1);
        return tint(lerp3(base, rgb(70, 46, 28), gap * 0.8), (0.85 + 0.15 * fbm(u, v, 4, 4, 3, 93)) * (0.7 + 0.3 * ao.at(x, y)));
      }),
    );
    save('cork_orm', orm(S, S, (_u, _v, x, y) => [ao.at(x, y), 1, 1]));
  },

  // Ablative heat-shield blocks, tile 1.2 m: staggered blocks with filled seams over a fine honeycomb.
  ablator() {
    const S = 1024;
    const rows = 3;
    const cols = 3;
    const block = (u: number, v: number): { e: number; id: number } => {
      const j = Math.floor(v * rows);
      const uu = u * cols + (j % 2) * 0.5;
      const i = Math.floor(uu);
      const fu = uu - i;
      const fv = v * rows - j;
      const e = Math.min(fu, 1 - fu, (fv * cols) / rows, ((1 - fv) * cols) / rows);
      return { e, id: hash(mod(i, cols), j, 101) };
    };
    const hex = (u: number, v: number): number => {
      // Distance to the nearest edge of a hexagonal cell lattice, 0 on the cell walls.
      const c = worley(u, v * 0.866, 128, 111, 102, 0.12);
      return clamp((c.f2 - c.f1) * 3);
    };
    const h = Field.from(S, S, (u, v) => {
      const b = block(u, v);
      return -0.004 * smooth(0.018, 0.004, b.e) + 0.0006 * hex(u, v) + 0.0012 * fbm(u, v, 24, 24, 3, 103) + 0.003 * fbm(u, v, 3, 3, 2, 104);
    });
    save('ablator_n', normalMap(h, 1.2));
    const ao = cavity(h, 3, 300);
    save(
      'ablator_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const b = block(u, v);
        const base = lerp3(rgb(156, 143, 112), rgb(178, 164, 132), b.id);
        const seam = smooth(0.016, 0.006, b.e);
        const cell = hex(u, v);
        const c = lerp3(tint(base, 0.86 + 0.14 * cell), rgb(196, 190, 176), seam * 0.85);
        return tint(c, (0.88 + 0.12 * fbm(u, v, 6, 6, 4, 105)) * (0.75 + 0.25 * ao.at(x, y)));
      }),
    );
    save('ablator_orm', orm(S, S, (u, v, x, y) => [ao.at(x, y), clamp(0.9 + 0.1 * fbm(u, v, 40, 40, 2, 106)), 1]));
  },

  // Ceramic tiles, tile 0.72 m: 4 x 4 pillowed tiles with gaps and per-tile shade.
  tile() {
    const S = 1024;
    const N = 4;
    const cellOf = (u: number, v: number): { e: number; id: number; fu: number; fv: number } => {
      const i = Math.floor(u * N);
      const j = Math.floor(v * N);
      const fu = u * N - i;
      const fv = v * N - j;
      return { e: Math.min(fu, 1 - fu, fv, 1 - fv), id: hash(i, j, 111), fu, fv };
    };
    const h = Field.from(S, S, (u, v) => {
      const c = cellOf(u, v);
      const pillow = Math.pow(Math.sin(Math.PI * c.fu) * Math.sin(Math.PI * c.fv), 0.35);
      return 0.0016 * pillow - 0.006 * smooth(0.02, 0.006, c.e) + 0.0003 * fbm(u, v, 80, 80, 2, 112) + (c.id - 0.5) * 0.0012;
    });
    save('tile_n', normalMap(h, 0.72));
    const ao = cavity(h, 3, 220);
    save(
      'tile_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const c = cellOf(u, v);
        const gap = smooth(0.02, 0.008, c.e);
        const shade = 0.86 + 0.12 * c.id + 0.04 * fbm(u, v, 20, 20, 3, 113);
        const edgeWear = 1 - 0.1 * smooth(0.08, 0.02, c.e);
        const k = mix(shade * edgeWear, 0.2, gap) * (0.8 + 0.2 * ao.at(x, y));
        return [k * 0.925, k * 0.925, k * 0.91];
      }),
    );
    save(
      'tile_orm',
      orm(S, S, (u, v, x, y) => {
        const c = cellOf(u, v);
        return [ao.at(x, y), clamp(0.82 + 0.14 * c.id + 0.2 * smooth(0.02, 0.008, c.e)), 1];
      }),
    );
  },

  // Multi-layer insulation foil, tile 1.1 m: sharp creases mostly along u, billowing between tie points.
  mli() {
    // Crumpled foil is faceted: flat patches tilted at random, meeting in sharp creases. Two scales of
    // Worley facets (elongated along u, the direction the blanket was pulled) over a soft billow.
    const S = 1024;
    const warp = (u: number, v: number): [number, number] => [u + 0.02 * (fbm(u, v, 6, 6, 2, 121) - 0.5), v + 0.02 * (fbm(u, v, 6, 6, 2, 122) - 0.5)];
    const gx = new Field(S, S);
    const gy = new Field(S, S);
    const edge = new Field(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const [u, v] = warp((x + 0.5) / S, (y + 0.5) / S);
        const a = worley(u, v, 9, 20, 123, 1);
        const b = worley(u, v, 30, 64, 124, 1);
        const sx = (a.id - 0.5) * 0.34 + (b.id - 0.5) * 0.3;
        const sy = (a.id2 - 0.5) * 0.62 + (b.id2 - 0.5) * 0.5;
        gx.data[y * S + x] = sx;
        gy.data[y * S + x] = sy;
        edge.data[y * S + x] = Math.min(smooth(0, 0.07, a.f2 - a.f1), 0.35 + 0.65 * smooth(0, 0.1, b.f2 - b.f1));
      }
    }
    const billow = Field.from(S, S, (u, v) => 0.014 * fbm(u, v, 3, 3, 2, 125));
    const sB = (S / 1.1) * 0.5;
    save(
      'mli_n',
      Image.from(S, S, (_u, _v, x, y) => {
        // 3 x 3 box filter of the facet slopes keeps the creases sharp but not aliased.
        let dx = 0;
        let dy = 0;
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            dx += gx.at(x + i, y + j);
            dy += gy.at(x + i, y + j);
          }
        }
        dx = dx / 9 + (billow.at(x + 1, y) - billow.at(x - 1, y)) * sB;
        dy = dy / 9 + (billow.at(x, y + 1) - billow.at(x, y - 1)) * sB;
        const l = Math.hypot(dx, dy, 1);
        return [0.5 - (0.5 * dx) / l, 0.5 - (0.5 * dy) / l, 0.5 + 0.5 / l];
      }),
    );
    save(
      'mli_orm',
      orm(S, S, (u, v, x, y) => {
        const e = edge.at(x, y);
        return [clamp(0.55 + 0.45 * e), clamp(1 - 0.28 * e + 0.08 * fbm(u, v, 40, 40, 2, 126)), 1];
      }),
    );
  },

  // Hot-dip galvanised steel, tile 0.8 m: zinc spangle.
  galv() {
    const S = 512;
    const sp = (u: number, v: number) => worley(u, v, 26, 26, 131, 1);
    const h = Field.from(S, S, (u, v) => 0.00012 * sp(u, v).id + 0.0003 * fbm(u, v, 6, 6, 3, 132));
    save('galv_n', normalMap(h, 0.8));
    save(
      'galv_albedo',
      Image.from(S, S, (u, v) => {
        const c = sp(u, v);
        const facet = 0.5 + 0.5 * Math.sin(40 * (c.dx * Math.cos(c.id2 * 6.283) + c.dy * Math.sin(c.id2 * 6.283)));
        const k = 0.6 + 0.16 * c.id + 0.05 * facet + 0.06 * fbm(u, v, 5, 5, 4, 133);
        const streak = 1 - 0.18 * smooth(0.6, 0.85, fbm(u, v, 14, 2, 3, 134));
        return [k * 0.97 * streak, k * 0.985 * streak, k * streak];
      }),
    );
    save(
      'galv_orm',
      orm(S, S, (u, v) => {
        const c = sp(u, v);
        return [1, clamp(0.7 + 0.3 * c.id2), clamp(0.9 + 0.1 * fbm(u, v, 5, 5, 3, 135))];
      }),
    );
  },

  // Bar grating seen as a surface, tile 0.5 m: bearing bars along u every 31 mm, cross rods every 100 mm.
  grate() {
    const S = 512;
    const bar = (u: number, v: number): number => {
      const b = Math.abs(mod(v * 16, 1) - 0.5);
      const rod = Math.abs(mod(u * 5, 1) - 0.5);
      return Math.max(smooth(0.12, 0.07, b), smooth(0.07, 0.04, rod) * 0.85);
    };
    const h = Field.from(S, S, (u, v) => 0.012 * bar(u, v));
    save('grate_n', normalMap(h, 0.5, 0.5));
    save(
      'grate_albedo',
      Image.from(S, S, (u, v) => {
        const k = mix(0.045, 0.62 + 0.08 * fbm(u, v, 20, 20, 2, 141), bar(u, v));
        return [k * 0.97, k * 0.985, k];
      }),
    );
    save('grate_orm', orm(S, S, (u, v) => [clamp(0.25 + 0.75 * bar(u, v)), 0.9, bar(u, v)]));
  },

  // Cast-in-place concrete apron, tile 9 m: 4.5 m slabs, joints, stains, hairline cracks, tyre marks.
  concrete() {
    const S = 1024;
    const joint = (u: number, v: number): number => {
      const a = Math.abs(mod(u * 2, 1) - 0.5);
      const b = Math.abs(mod(v * 2, 1) - 0.5);
      return smooth(0.497, 0.4995, Math.max(a, b));
    };
    const crack = (u: number, v: number): number => {
      // Hairline cracks: thin, and only where a low-frequency mask lets them through.
      const c = worley(u + 0.02 * fbm(u, v, 8, 8, 2, 151), v + 0.02 * fbm(u, v, 8, 8, 2, 150), 4, 4, 152, 1);
      return smooth(0.004, 0.0008, c.f2 - c.f1) * smooth(0.6, 0.72, fbm(u, v, 3, 3, 2, 153)) * 0.7;
    };
    const h = Field.from(S, S, (u, v) => 0.004 * fbm(u, v, 120, 120, 3, 154) + 0.02 * fbm(u, v, 4, 4, 3, 155) - 0.02 * joint(u, v) - 0.008 * crack(u, v));
    save('concrete_n', normalMap(h, 9, 0.8));
    const ao = cavity(h, 2, 60);
    save(
      'concrete_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const slab = hash(Math.floor(u * 2), Math.floor(v * 2), 156);
        let k = 0.5 + 0.05 * slab + 0.1 * fbm(u, v, 6, 6, 5, 157) + 0.06 * fbm(u, v, 200, 200, 2, 158);
        const stain = smooth(0.6, 0.85, fbm(u, v, 4, 7, 5, 159));
        k *= 1 - 0.2 * stain;
        const tyre = smooth(0.8, 0.95, fbm(u, v, 2, 40, 3, 160)) * smooth(0.4, 0.7, fbm(u, v, 2, 2, 2, 161));
        k *= 1 - 0.3 * tyre;
        k = mix(k, 0.13, Math.max(joint(u, v), crack(u, v) * 0.8));
        k *= 0.85 + 0.15 * ao.at(x, y);
        return [k * 1.0, k * 0.985, k * 0.95];
      }),
    );
    save('concrete_orm', orm(S, S, (u, v, x, y) => [ao.at(x, y), clamp(0.86 + 0.14 * fbm(u, v, 50, 50, 2, 162)), 1]));
  },

  // Quilted insulation blanket, tile 0.8 m: 0.2 m diamonds, stitched seams, cloth weave.
  quilt() {
    const S = 512;
    const h = Field.from(S, S, (u, v) => {
      const a = Math.abs(Math.sin(Math.PI * (u + v) * 4));
      const b = Math.abs(Math.sin(Math.PI * (u - v) * 4));
      const pillow = Math.pow(a * b, 0.45);
      const weave = Math.sin(u * S * 0.9) * Math.sin(v * S * 0.9);
      return 0.012 * pillow + 0.00025 * weave + 0.002 * fbm(u, v, 12, 12, 3, 171);
    });
    save('quilt_n', normalMap(h, 0.8));
    const ao = cavity(h, 4, 120);
    save('quilt_orm', orm(S, S, (u, v, x, y) => [clamp(0.45 + 0.55 * ao.at(x, y)), clamp(0.88 + 0.12 * fbm(u, v, 30, 30, 2, 172)), 1]));
  },

  // River rock of the crawlerway, tile 3 m: rounded stones 5 - 9 cm.
  gravel() {
    const S = 1024;
    const st = (u: number, v: number) => worley(u, v, 46, 46, 181, 1);
    const h = Field.from(S, S, (u, v) => {
      const c = st(u, v);
      return 0.03 * Math.sqrt(clamp((c.f2 - c.f1) * 1.6)) * (0.6 + 0.6 * c.id) + 0.004 * fbm(u, v, 200, 200, 2, 182);
    });
    save('gravel_n', normalMap(h, 3, 0.7));
    const ao = cavity(h, 3, 45);
    const tones: [number, number, number][] = [rgb(168, 158, 140), rgb(128, 120, 110), rgb(186, 170, 142), rgb(104, 98, 94), rgb(150, 128, 104)];
    save(
      'gravel_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const c = st(u, v);
        const base = tones[Math.floor(c.id * tones.length) % tones.length]!;
        return tint(base, (0.8 + 0.3 * c.id2) * (0.45 + 0.55 * ao.at(x, y)) * (0.9 + 0.1 * fbm(u, v, 300, 300, 1, 183)));
      }),
    );
    save('gravel_orm', orm(S, S, (_u, _v, x, y) => [ao.at(x, y), 1, 1]));
  },
};

const t0 = Date.now();
for (const [name, bake] of Object.entries(recipes)) {
  if (only.size > 0 && !only.has(name)) continue;
  bake();
}
console.log(`baked ${(totalBytes / 1048576).toFixed(1)} MiB into ${outDir} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
