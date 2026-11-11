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

  // Brushed sheet, tile 0.4 m: the grain runs along u. Each scratch is a line of constant v that only drifts
  // slowly, so the map has no lattice of its own to beat against the pixel grid.
  brushed() {
    const S = 512;
    const grainAt = (u: number, v: number): number => {
      const w = v + 0.003 * (fbm(u, v, 2, 2, 2, 31) - 0.5);
      return 0.45 * vnoise(0.5, w * 256, 1, 256, 32) + 0.3 * vnoise(0.5, w * 128, 1, 128, 33) + 0.25 * vnoise(u * 2, w * 64, 2, 64, 36);
    };
    const grain = Field.from(S, S, grainAt);
    const h = Field.from(S, S, (_u, _v, x, y) => 0.00003 * grain.at(x, y));
    save('brushed_n', normalMap(h, 0.4));
    save(
      'brushed_orm',
      // Only the grain: a 0.4 m tile cannot carry stains without showing its repeat (tone variation is the
      // job of the vertex wear mask).
      orm(S, S, (_u, _v, x, y) => [1, clamp(0.78 + 0.22 * grain.at(x, y)), 1]),
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
      [0.6, rgb(128, 94, 102)],
      [0.74, rgb(98, 100, 128)],
      [0.88, rgb(112, 124, 142)],
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
    save('carbon_n', normalMap(h, 0.25, 0.4));
    save(
      'carbon_albedo',
      Image.from(S, S, (u, v) => {
        const t = tow(u, v);
        const fibre = vnoise(t.across * 9 + (t.warp ? 0 : 40), t.along * 0.7, 4096, 4096, 72);
        // Warp and weft differ little in tone: the weave is a close-up detail and must average to one grey in the mips.
        const k = 0.2 + 0.03 * (t.warp ? 1 : 0.86) + 0.03 * fibre;
        return [k, k, k * 1.03];
      }),
    );
    save(
      'carbon_orm',
      orm(S, S, (u, v) => {
        const t = tow(u, v);
        const edge = Math.abs(2 * t.across - 1);
        return [clamp(1 - 0.2 * smooth(0.75, 1, edge)), clamp(0.9 + 0.1 * edge), 1];
      }),
    );
  },

  // Spray-on foam insulation, tile 9.6 m: popcorn skin over irregular spray lumps, the faint ribbing of the
  // spray passes round the tank, and tone that drifts over metres (foam darkens with age and sun, and no two
  // spray sessions match): soft mottling plus a few irregular hand-sprayed close-out patches. One tile is
  // more than a third of a 9 m tank's girth, so no feature is seen twice at a glance.
  foam() {
    const S = 2048;
    const T = 9.6;
    const lump = (u: number, v: number): number => {
      const c = worley(u + 0.005 * fbm(u, v, 64, 64, 2, 80), v, 88, 104, 81, 1);
      return 1 - smooth(0.0, 0.75, c.f1);
    };
    // Spray passes: bands about 0.45 m high whose edges wander.
    const pass = (u: number, v: number): number => {
      const w = v * 21 + 0.35 * fbm(u, v, 5, 3, 3, 89);
      const f = w - Math.floor(w);
      return smooth(0.0, 0.12, f) * (1 - smooth(0.8, 1.0, f));
    };
    const h = Field.from(S, S, (u, v) => {
      const pop = 1 - smooth(0.0, 0.55, worley(u, v, 480, 480, 82).f1);
      return 0.0032 * pop + 0.006 * fbm(u, v, 80, 80, 3, 83) + 0.009 * lump(u, v) + 0.004 * pass(u, v) + 0.012 * fbm(u, v, 9, 9, 2, 84);
    });
    save('foam_n', normalMap(h, T, 0.9));
    const ao = cavity(h, 3, 160);
    save(
      'foam_orm',
      orm(S, S, (u, v, x, y) => [ao.at(x, y), clamp(0.9 + 0.1 * fbm(u, v, 120, 120, 2, 85)), 1]),
    );
    // Close-out patches: irregular blobs one to two metres across, in a fifth of the cells of a coarse lattice.
    const patch = (u: number, v: number): { k: number; tone: number } => {
      // Cells 2.4 m wide and 1.4 m high: a close-out is sprayed along a flange or a line, not round a point.
      const c = worley(u + 0.05 * (fbm(u, v, 10, 10, 3, 90) - 0.5), v + 0.03 * (fbm(u, v, 14, 14, 3, 91) - 0.5), 4, 7, 92, 0.8);
      if (c.id > 0.16) return { k: 0, tone: 0 };
      const edge = 0.3 + 0.28 * (fbm(u, v, 22, 22, 4, 93) - 0.5);
      return { k: smooth(edge, edge - 0.16, c.f1), tone: c.id2 };
    };
    const tone = (u: number, v: number): number => {
      // Age mottling over metres, a slow drift along the tank, the passes.
      const age = fbm(u, v, 3, 3, 4, 86) - 0.5;
      const drift = fbm(u, v, 1, 2, 2, 87) - 0.5;
      return 1 + 0.2 * age + 0.1 * drift - 0.035 * (1 - pass(u, v));
    };
    const fresh = rgb(216, 150, 78);
    const aged = rgb(170, 100, 48);
    const pale = rgb(228, 176, 108);
    const colour = (u: number, v: number, x: number, y: number): [number, number, number] => {
      const t = tone(u, v);
      let c = lerp3(fresh, aged, clamp(0.3 + 1.6 * (1 - t)));
      const pt = patch(u, v);
      if (pt.k > 0) c = lerp3(c, pt.tone > 0.5 ? pale : aged, pt.k * (0.22 + 0.24 * Math.abs(pt.tone - 0.5)));
      return tint(c, (0.87 + 0.13 * fbm(u, v, 440, 440, 2, 88)) * (0.74 + 0.26 * ao.at(x, y)));
    };
    save('foam_albedo', Image.from(S, S, colour));
    // The same foam under a white top coat: the relief stays, the colour is an off-white that has yellowed unevenly.
    save(
      'foamwhite_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const yellow = clamp(0.35 + 1.8 * (1 - tone(u, v)));
        const c = lerp3(rgb(232, 230, 222), rgb(220, 210, 186), yellow * 0.6);
        return tint(c, (0.94 + 0.06 * fbm(u, v, 440, 440, 2, 88)) * (0.84 + 0.16 * ao.at(x, y)));
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

  // Ceramic tiles, tile 1.44 m: 8 x 8 pillowed tiles in a running bond (every second row is offset by half
  // a tile), each with its own shade; a few are replacements (cleaner, brighter) or have yellowed; gaps vary
  // in width and some carry a gap filler that stands a little proud; a part number is printed in one corner.
  tile() {
    const S = 2048;
    const N = 8;
    interface Cell {
      e: number;
      eu: number;
      ev: number;
      id: number;
      kind: number;
      fu: number;
      fv: number;
      i: number;
      j: number;
    }
    const cellOf = (u: number, v: number): Cell => {
      const j = Math.floor(v * N);
      const uu = u * N + (mod(j, 2) === 1 ? 0.5 : 0);
      const i = Math.floor(uu);
      const fu = uu - i;
      const fv = v * N - j;
      const ii = mod(i, N);
      const eu = Math.min(fu, 1 - fu);
      const ev = Math.min(fv, 1 - fv);
      return { e: Math.min(eu, ev), eu, ev, id: hash(ii, j, 111), kind: hash(ii, j, 114), fu, fv, i: ii, j };
    };
    // Half gap width per tile edge, in tile units (2 to 5 mm of 180 mm).
    const gapOf = (c: Cell): number => 0.007 + 0.009 * hash(c.i, c.j, 115);
    // A filler strip sits in the gap under some tiles.
    const filler = (c: Cell): number => (hash(c.i, c.j, 116) < 0.22 && c.fv < 0.5 ? smooth(gapOf(c) * 0.75, gapOf(c) * 0.3, c.ev) * smooth(0.02, 0.06, c.eu) : 0);
    const h = Field.from(S, S, (u, v) => {
      const c = cellOf(u, v);
      const pillow = Math.pow(Math.sin(Math.PI * c.fu) * Math.sin(Math.PI * c.fv), 0.3);
      const g = gapOf(c);
      return 0.0011 * pillow - 0.0024 * smooth(g, g * 0.4, c.e) + 0.0026 * filler(c) + 0.00028 * fbm(u, v, 160, 160, 2, 112) + (c.id - 0.5) * 0.0011;
    });
    save('tile_n', normalMap(h, 1.44));
    const ao = cavity(h, 3, 220);
    const mark = (c: Cell): number => {
      // Part number: a few short strokes near one corner (about 25 x 6 mm).
      const x = (c.fu - 0.1) / 0.14;
      const y = (c.fv - 0.1) / 0.035;
      if (x < 0 || x > 1 || y < 0 || y > 1) return 0;
      const k = Math.floor(x * 7);
      return hash(k + c.i * 13, c.j, 117) < 0.72 && Math.abs(y - 0.5) < 0.42 && x * 7 - k < 0.62 ? 0.5 : 0;
    };
    save(
      'tile_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const c = cellOf(u, v);
        const g = gapOf(c);
        const gap = smooth(g, g * 0.45, c.e);
        // Shade: most tiles within a few percent of each other, replacements brighter, a few toasted.
        let shade = 0.86 + 0.09 * c.id;
        let warm = 0.012;
        if (c.kind < 0.07) shade = 0.985;
        else if (c.kind > 0.88) {
          shade -= 0.07;
          warm = 0.04;
        }
        shade *= 0.965 + 0.07 * fbm(u, v, 40, 40, 3, 113);
        // Densified edge: a slightly darker rim.
        shade *= 1 - 0.07 * smooth(0.07, 0.02, c.e);
        shade *= 1 - mark(c) * 0.5;
        let k = mix(shade, 0.36, gap);
        k = mix(k, 0.78, filler(c));
        k *= 0.93 + 0.07 * ao.at(x, y);
        return [k * (0.925 + warm), k * 0.925, k * (0.915 - warm)];
      }),
    );
    save(
      'tile_orm',
      orm(S, S, (u, v, x, y) => {
        const c = cellOf(u, v);
        const g = gapOf(c);
        return [ao.at(x, y), clamp(0.8 + 0.16 * c.id + 0.2 * smooth(g * 1.6, g * 0.6, c.e)), 1];
      }),
    );
  },

  // Multi-layer insulation foil, tile 1.1 m. A crumpled film is small flat facets that meet in sharp creases:
  // every facet is a little mirror with its own tilt, which is what makes the blanket glitter in hard light
  // and gives it a broken, streaky sheen from afar. The normal map is built from the facets directly: two
  // scales of facets (about 4 and 10 cm; the film is pulled along u, so they tilt more across it), the
  // blanket's shallow billows between its stitch lines, and the creases themselves as fine grooves. The
  // tilts stay within a few degrees: larger ones flip a facet between the sky and the ground and the
  // blanket breaks up into black and white speckle at any distance where a facet is a pixel.
  mli() {
    const S = 1024;
    const T = 1.1;
    const fine = (u: number, v: number) => worley(u + 0.006 * (fbm(u, v, 40, 40, 2, 121) - 0.5), v, 20, 34, 122, 1);
    const coarse = (u: number, v: number) => worley(u, v + 0.01 * (fbm(u, v, 20, 20, 2, 123) - 0.5), 8, 13, 124, 1);
    // Slopes (dh/du, dh/dv in metres per metre) of the facet a texel lies on.
    const facet = (u: number, v: number): [number, number, number] => {
      const a = fine(u, v);
      const c = coarse(u, v);
      const sx = 0.05 * (a.id - 0.5) + 0.05 * (c.id - 0.5);
      const sy = 0.15 * (a.id2 - 0.5) + 0.14 * (c.id2 - 0.5);
      // Distance to the nearest crease, in fine cells.
      const edge = Math.min(a.f2 - a.f1, (c.f2 - c.f1) * 2.2);
      return [sx, sy, edge];
    };
    const billow = Field.from(S, S, (u, v) => 0.012 * fbm(u, v, 2, 3, 3, 125) + 0.004 * fbm(u, v, 9, 14, 2, 126));
    const crease = Field.from(S, S, (u, v) => -0.0007 * smooth(0.07, 0.0, facet(u, v)[2]));
    const scale = S / T / 2;
    save(
      'mli_n',
      Image.from(S, S, (u, v, x, y) => {
        const [sx, sy] = facet(u, v);
        const dx = sx + (billow.at(x + 1, y) - billow.at(x - 1, y) + crease.at(x + 1, y) - crease.at(x - 1, y)) * scale;
        const dy = sy + (billow.at(x, y + 1) - billow.at(x, y - 1) + crease.at(x, y + 1) - crease.at(x, y - 1)) * scale;
        const l = Math.hypot(dx, dy, 1);
        return [0.5 - (0.5 * dx) / l, 0.5 - (0.5 * dy) / l, 0.5 + 0.5 / l];
      }),
    );
    save(
      'mli_orm',
      orm(S, S, (u, v) => {
        const [, , edge] = facet(u, v);
        const k = smooth(0.0, 0.12, edge);
        // Creases are scuffed and shaded; the facets between them are clean film.
        return [clamp(0.62 + 0.38 * k), clamp(1 - 0.3 * k + 0.08 * (fbm(u, v, 60, 60, 2, 127) - 0.5)), 1];
      }),
    );
  },

  // Hot-dip galvanised steel, tile 0.8 m: zinc spangle.
  galv() {
    const S = 512;
    const sp = (u: number, v: number) => worley(u, v, 26, 26, 131, 1);
    const h = Field.from(S, S, (u, v) => 0.00003 * sp(u, v).id + 0.00015 * fbm(u, v, 24, 24, 3, 132));
    save('galv_n', normalMap(h, 0.8));
    save(
      'galv_albedo',
      Image.from(S, S, (u, v) => {
        const c = sp(u, v);
        const facet = 0.5 + 0.5 * Math.sin(40 * (c.dx * Math.cos(c.id2 * 6.283) + c.dy * Math.sin(c.id2 * 6.283)));
        // Spangle is a close-up detail: from a few metres the sheet is an even dull grey.
        const k = 0.64 + 0.05 * c.id + 0.02 * facet + 0.02 * fbm(u, v, 30, 30, 2, 133);
        const streak = 1 - 0.05 * smooth(0.6, 0.85, fbm(u, v, 40, 3, 2, 134));
        return [k * 0.97 * streak, k * 0.985 * streak, k * streak];
      }),
    );
    save(
      'galv_orm',
      orm(S, S, (u, v) => {
        const c = sp(u, v);
        return [1, clamp(0.88 + 0.12 * c.id2), 0.95];
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

  // Cast-in-place concrete, tile 18 m: sixteen 4.5 m slabs, each poured and finished on its own (tone, trowel
  // direction, mottling), joints, a few hairline cracks. Nothing in it is a distinct stain: stains and
  // weathering larger than a slab are the mesh's grime weights, so no two bays of the apron look alike.
  concrete() {
    const S = 2048;
    const N = 4;
    const joint = (u: number, v: number): number => {
      const a = Math.abs(mod(u * N, 1) - 0.5);
      const b = Math.abs(mod(v * N, 1) - 0.5);
      return smooth(0.4975, 0.4995, Math.max(a, b));
    };
    const crack = (u: number, v: number): number => {
      // Hairline cracks: thin, and only where a low-frequency mask lets them through.
      const c = worley(u + 0.01 * fbm(u, v, 16, 16, 2, 151), v + 0.01 * fbm(u, v, 16, 16, 2, 150), 7, 7, 152, 1);
      return smooth(0.0035, 0.0007, c.f2 - c.f1) * smooth(0.62, 0.74, fbm(u, v, 5, 5, 2, 153)) * 0.7;
    };
    const h = Field.from(S, S, (u, v) => 0.004 * fbm(u, v, 240, 240, 3, 154) + 0.02 * fbm(u, v, 8, 8, 3, 155) - 0.02 * joint(u, v) - 0.008 * crack(u, v));
    save('concrete_n', normalMap(h, 18, 0.8));
    const ao = cavity(h, 2, 60);
    save(
      'concrete_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const si = Math.floor(u * N);
        const sj = Math.floor(v * N);
        const slab = hash(si, sj, 156);
        // Each slab: its own tone, a broom finish along one of the two axes, soft mottling of its own.
        const broom = hash(si, sj, 163) < 0.5 ? fbm(u, v, 12, 700, 2, 164) : fbm(u, v, 700, 12, 2, 165);
        let k = 0.47 + 0.075 * slab + 0.07 * fbm(u + slab * 0.37, v + slab * 0.11, 14, 14, 4, 157) + 0.05 * fbm(u, v, 400, 400, 2, 158) + 0.035 * (broom - 0.5);
        // Edges of a slab are a little darker where water stands in the joint.
        const edge = Math.max(Math.abs(mod(u * N, 1) - 0.5), Math.abs(mod(v * N, 1) - 0.5));
        k *= 1 - 0.06 * smooth(0.44, 0.5, edge);
        k = mix(k, 0.13, Math.max(joint(u, v), crack(u, v) * 0.8));
        k *= 0.85 + 0.15 * ao.at(x, y);
        return [k * 1.0, k * 0.985, k * 0.95];
      }),
    );
    save('concrete_orm', orm(S, S, (u, v, x, y) => [ao.at(x, y), clamp(0.86 + 0.14 * fbm(u, v, 100, 100, 2, 162)), 1]));
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
