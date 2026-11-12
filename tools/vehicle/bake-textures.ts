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
import { Field, Image, cavity, clamp, fbm, hash, mix, mod, normalMap, ridged, smooth, srgb, vnoise, worley } from './texlib';

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
    // (The decimetre-scale waviness is kept faint: a sprayed and cured aerospace coat is level, and markings,
    // which cannot carry this map, must not show as rectangles with a straighter highlight.)
    const h = Field.from(S, S, (u, v) => 0.00009 * fbm(u, v, 96, 96, 2, 11) + 0.00006 * fbm(u, v, 12, 12, 3, 12));
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

  // Brushed sheet, tile 1.6 m, grain along u. The finish is tens of thousands of separate scratches: each a
  // stroke of finite length, a degree or two off the brushing direction, with its own depth and width. No
  // scratch runs the width of the tile, so there are no rows for the anisotropic highlight to magnify, and
  // the relief is deep enough to fill the normal map's eight bits (the old map held two values).
  brushed() {
    const S = 1024;
    const T = 1.6;
    const h = new Field(S, S);
    const cut = (i: number, d: number): void => {
      h.data[i] = h.data[i]! - d;
    };
    const stroke = (x0: number, y0: number, len: number, slope: number, depth: number, wide: boolean): void => {
      for (let i = 0; i < len; i++) {
        // Fade in and out over the ends of the stroke.
        const e = Math.min(1, i / 6, (len - 1 - i) / 6);
        const y = y0 + slope * i;
        const yi = Math.floor(y);
        const f = y - yi;
        const x = mod(Math.round(x0 + i), S);
        cut(mod(yi, S) * S + x, depth * e * (1 - f));
        cut(mod(yi + 1, S) * S + x, depth * e * f);
        if (wide) cut(mod(yi + 2, S) * S + x, depth * e * 0.5);
      }
    };
    // Three populations: the dense fine grain, longer medium scratches, a few deep handling scratches.
    for (let k = 0; k < 120000; k++) stroke(hash(k, 1, 301) * S, hash(k, 2, 301) * S, 14 + hash(k, 3, 301) * 70, (hash(k, 4, 301) - 0.5) * 0.05, 0.00002 + 0.00005 * hash(k, 5, 301), false);
    for (let k = 0; k < 9000; k++) stroke(hash(k, 1, 302) * S, hash(k, 2, 302) * S, 80 + hash(k, 3, 302) * 260, (hash(k, 4, 302) - 0.5) * 0.035, 0.00006 + 0.00009 * hash(k, 5, 302), hash(k, 6, 302) < 0.3);
    for (let k = 0; k < 160; k++) stroke(hash(k, 1, 303) * S, hash(k, 2, 303) * S, 60 + hash(k, 3, 303) * 200, (hash(k, 4, 303) - 0.5) * 0.5, 0.00012 + 0.0001 * hash(k, 5, 303), false);
    const [lo, hi] = h.range();
    save('brushed_n', normalMap(h, T, 1));
    save(
      'brushed_orm',
      orm(S, S, (u, v, x, y) => {
        // Deeper scratches scatter more; a soft cloudiness from handling at decimetre scale.
        const g = (h.at(x, y) - lo) / (hi - lo);
        return [1, clamp(0.72 + 0.2 * (1 - g) + 0.1 * (fbm(u, v, 9, 9, 3, 304) - 0.5)), 1];
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
      // Oxide colours on a hot nickel alloy are faint: a bronze cast near the hot end, a dull violet-blue
      // further out, all within a tenth of the bare metal's grey.
      [0.0, rgb(132, 128, 122)],
      [0.3, rgb(138, 128, 112)],
      [0.46, rgb(134, 118, 100)],
      [0.6, rgb(122, 108, 110)],
      [0.74, rgb(108, 108, 120)],
      [0.88, rgb(116, 120, 128)],
      [1.0, rgb(126, 130, 133)],
    ];
    save(
      'heat_albedo',
      Image.from(S, S, (u, v) => {
        // Bands across the flow (constant v) broken up by noise: the tint follows temperature along the part.
        const band = 0.5 + 0.5 * Math.sin(2 * Math.PI * (v + 0.1 * fbm(u, v, 3, 2, 3, 61)));
        const t = clamp(0.12 + 0.8 * band * (0.8 + 0.25 * fbm(u, v, 4, 3, 4, 62)));
        let c = ramp[ramp.length - 1]![1];
        for (let i = 0; i + 1 < ramp.length; i++) {
          if (t <= ramp[i + 1]![0]) {
            c = lerp3(ramp[i]![1], ramp[i + 1]![1], (t - ramp[i]![0]) / (ramp[i + 1]![0] - ramp[i]![0]));
            break;
          }
        }
        return tint(c, 0.94 + 0.06 * fbm(u, v, 40, 40, 2, 63));
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

  // Spray-on foam insulation, tile 9.6 m: popcorn skin over irregular spray lumps, the machined ribbing of
  // the spray passes round the tank (a rib every 5 cm, grouped in passes of about 0.45 m), and tone that
  // drifts over metres: foam darkens with age and sun, in soft patches and in long streaks down the tank
  // where condensate ran. Nothing in the tile is a distinct object: a close-out patch that repeats every
  // 9.6 m is seen as a pattern at once, so close-outs, ramps and stains with an outline are geometry and
  // material bands of the stage, placed where the hardware is.
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
    // Ribs left by the trimming tool: 192 per tile (5 cm), wandering a little with the pass.
    const rib = (u: number, v: number): number => 0.5 + 0.5 * Math.sin(2 * Math.PI * (v * 192 + 0.6 * fbm(u, v, 6, 24, 2, 94)));
    const pop = Field.from(S, S, (u, v) => 1 - smooth(0.0, 0.55, worley(u, v, 480, 480, 82).f1));
    const h = Field.from(S, S, (u, v, x, y) => 0.0026 * pop.at(x, y) + 0.005 * fbm(u, v, 80, 80, 3, 83) + 0.008 * lump(u, v) + 0.004 * pass(u, v) + 0.0022 * rib(u, v) + 0.012 * fbm(u, v, 9, 9, 2, 84));
    save('foam_n', normalMap(h, T, 0.9));
    const ao = cavity(h, 3, 160);
    save(
      'foam_orm',
      orm(S, S, (u, v, x, y) => [ao.at(x, y), clamp(0.9 + 0.1 * fbm(u, v, 120, 120, 2, 85)), 1]),
    );
    // The same foam under a sprayed top coat: the paint fills the popcorn and softens the lumps; what is left
    // is the ribbing and a shallow waviness.
    const hFine = Field.from(S, S, (u, v, x, y) => 0.0006 * pop.at(x, y) + 0.0016 * lump(u, v) + 0.0012 * rib(u, v) + 0.002 * pass(u, v) + 0.005 * fbm(u, v, 9, 9, 2, 84));
    save('foamfine_n', normalMap(hFine, T, 0.9));
    const tone = (u: number, v: number): number => {
      // Age mottling over metres, a slow drift along the tank, the passes, and streaks down the tank (v).
      const age = fbm(u, v, 3, 3, 4, 86) - 0.5;
      const drift = fbm(u, v, 1, 2, 2, 87) - 0.5;
      const streak = fbm(u, v, 40, 2, 3, 95) - 0.5;
      return 1 + 0.2 * age + 0.1 * drift + 0.1 * streak - 0.03 * (1 - pass(u, v));
    };
    const fresh = rgb(216, 150, 78);
    const aged = rgb(170, 100, 48);
    save(
      'foam_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const c = lerp3(fresh, aged, clamp(0.3 + 1.6 * (1 - tone(u, v))));
        return tint(c, (0.87 + 0.13 * fbm(u, v, 440, 440, 2, 88)) * (0.74 + 0.26 * ao.at(x, y)) * (0.97 + 0.03 * rib(u, v)));
      }),
    );
    // Under a white top coat: an off-white that has yellowed unevenly and carries faint grey run marks.
    save(
      'foamwhite_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const yellow = clamp(0.35 + 1.8 * (1 - tone(u, v)));
        const c = lerp3(rgb(234, 233, 228), rgb(224, 218, 200), yellow * 0.5);
        return tint(c, (0.96 + 0.04 * fbm(u, v, 440, 440, 2, 88)) * (0.9 + 0.1 * ao.at(x, y)));
      }),
    );
  },

  // Rime on cryogenic lines and hoses, tile 4.8 m: a granular white coat, runnels where melt water has
  // scored it, lumps where it has built up, and streaks where it is thin and the metal under it greys it.
  frost() {
    const S = 1024;
    const runnel = (u: number, v: number): number => Math.pow(ridged(u + 0.01 * fbm(u, v, 6, 6, 2, 601), v, 46, 2, 3, 602, 0.5), 2);
    const thin = (u: number, v: number): number => smooth(0.52, 0.72, fbm(u + 0.008 * fbm(u, v, 8, 8, 2, 603), v, 30, 1.5, 3, 604));
    const h = Field.from(S, S, (u, v) => 0.0006 * fbm(u, v, 300, 300, 2, 605) + 0.002 * fbm(u, v, 40, 40, 3, 606) - 0.0022 * runnel(u, v) - 0.0018 * thin(u, v) + 0.004 * fbm(u, v, 7, 7, 3, 607));
    save('frost_n', normalMap(h, 4.8, 1));
    const ao = cavity(h, 3, 500);
    save(
      'frost_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const t = thin(u, v);
        const k = (0.93 + 0.04 * fbm(u, v, 9, 9, 3, 608) + 0.02 * fbm(u, v, 200, 200, 1, 609)) * (1 - 0.055 * t - 0.03 * runnel(u, v)) * (0.93 + 0.07 * ao.at(x, y));
        return [k * 0.975, k * 0.99, k * 1.0];
      }),
    );
    save('frost_orm', orm(S, S, (u, v, x, y) => [ao.at(x, y), clamp(0.9 + 0.1 * fbm(u, v, 120, 120, 2, 610) - 0.08 * thin(u, v)), 1]));
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
        const base = lerp3(rgb(176, 150, 118), rgb(206, 184, 152), c.id);
        const gap = smooth(0.12, 0.0, c.f2 - c.f1);
        return tint(lerp3(base, rgb(112, 92, 70), gap * 0.6), (0.9 + 0.1 * fbm(u, v, 4, 4, 3, 93)) * (0.8 + 0.2 * ao.at(x, y)));
      }),
    );
    save('cork_orm', orm(S, S, (_u, _v, x, y) => [ao.at(x, y), 1, 1]));
  },

  // Ablative heat shield, ONE picture of the whole face (not a tile): u, v = 0.5 + x / D, 0.5 + z / D of the
  // capsule's own axes, D = 1.04 shield diameters (the mesh's UVs are planar, not the lathe's polar ones, so
  // blocks are blocks and not rings and wedges). Blocks about 0.30 x 0.27 m in a third bond inside 0.86 R,
  // one ring of shoulder blocks outside it, filled seams, a fine honeycomb grain.
  //   shield_*      as built: grey-tan blocks, darker filled seams.
  //   shieldchar_*  after an entry: char that streams away from the stagnation point (off centre, toward
  //                 the windward side) in streaks, ash-grey where heating was highest, pale pits where char
  //                 has spalled, seams eroded into dark grooves.
  //   shield_glow   emission pattern during the entry (emissive map, scaled by the feature with the
  //                 surface temperature): brightest at the stagnation point and along the windward
  //                 shoulder, falling to a dull red on the lee side, seams and streaks brighter.
  shield() {
    const S = 2048;
    const D = 1.04;
    // Stagnation point, in units of the shield radius (windward = +x of the texture).
    const SX = 0.3;
    const SZ = 0.05;
    interface At {
      /** Radius (1 = the shield's rim), distance to the nearest seam (in units of the radius). */
      r: number;
      seam: number;
      id: number;
      x: number;
      z: number;
    }
    const at = (u: number, v: number): At => {
      const x = (u - 0.5) * 2 * D;
      const z = (v - 0.5) * 2 * D;
      const r = Math.hypot(x, z);
      if (r > 0.86) {
        // Shoulder ring: 40 blocks round.
        const a = (Math.atan2(z, x) / (2 * Math.PI) + 1) * 40;
        const i = Math.floor(a);
        const f = a - i;
        return { r, seam: Math.min(Math.min(f, 1 - f) * ((2 * Math.PI * r) / 40), r - 0.86), id: hash(i, 77, 401), x, z };
      }
      // Blocks 0.30 x 0.27 m (in units of the 2 m radius), every row shifted by a third against the last.
      const bw = 0.15;
      const bh = 0.135;
      const j = Math.floor(z / bh + 100);
      const xx = x / bw + mod(j, 3) / 3 + 100;
      const i = Math.floor(xx);
      const fx = xx - i;
      const fz = z / bh + 100 - j;
      return { r, seam: Math.min(Math.min(fx, 1 - fx) * bw, Math.min(fz, 1 - fz) * bh, 0.86 - r), id: hash(i, j, 402), x, z };
    };
    const cells = Field.from(S, S, (u, v) => {
      const c = worley(u, v * 0.866, 230, 200, 403, 0.15);
      return clamp((c.f2 - c.f1) * 3);
    });
    const hNew = Field.from(S, S, (u, v, x, y) => {
      const q = at(u, v);
      return -0.0024 * smooth(0.0034, 0.001, q.seam) + 0.0004 * cells.at(x, y) + 0.0009 * fbm(u, v, 90, 90, 3, 404) + (q.id - 0.5) * 0.0006;
    });
    // One texel is 2.3 mm on a 4.5 m shield.
    save('shield_n', normalMap(hNew, 4.7, 1));
    const aoNew = cavity(hNew, 3, 400);
    save(
      'shield_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const q = at(u, v);
        const base = lerp3(rgb(106, 99, 88), rgb(124, 116, 103), q.id);
        const seam = smooth(0.003, 0.001, q.seam);
        const c = lerp3(tint(base, 0.93 + 0.07 * cells.at(x, y)), rgb(52, 49, 45), seam * 0.85);
        return tint(c, (0.92 + 0.08 * fbm(u, v, 14, 14, 4, 405)) * (0.8 + 0.2 * aoNew.at(x, y)));
      }),
    );
    save('shield_orm', orm(S, S, (u, v, x, y) => [aoNew.at(x, y), clamp(0.9 + 0.1 * fbm(u, v, 60, 60, 2, 406)), 1]));

    // ---- flow from the stagnation point
    const flow = (q: At): { d: number; streak: number; lee: number } => {
      const dx = q.x - SX;
      const dz = q.z - SZ;
      const d = Math.hypot(dx, dz);
      const ang = Math.atan2(dz, dx) / (2 * Math.PI) + 0.5;
      // Streaks are functions of the direction from the stagnation point: three widths, sharper further out.
      const st = 0.5 * vnoise(ang * 46, d * 1.2, 46, 4096, 407) + 0.3 * vnoise(ang * 150, d * 2.5, 150, 4096, 408) + 0.2 * vnoise(ang * 420, d * 5, 420, 4096, 409);
      // Lee side: away from the windward (+x) rim.
      return { d, streak: st, lee: clamp(0.5 - 0.5 * q.x) };
    };
    const pit = Field.from(S, S, (u, v) => {
      const c = worley(u, v, 150, 150, 410, 1);
      return c.id < 0.2 ? smooth(0.42, 0.12, c.f1) * (0.4 + 0.6 * c.id2) : 0;
    });
    const craze = Field.from(S, S, (u, v) => {
      const c = worley(u + 0.004 * fbm(u, v, 60, 60, 2, 411), v, 260, 260, 412, 1);
      return smooth(0.1, 0.02, c.f2 - c.f1);
    });
    const hChar = Field.from(S, S, (u, v, x, y) => {
      const q = at(u, v);
      const f = flow(q);
      return -0.004 * smooth(0.006, 0.0015, q.seam) - 0.0022 * pit.at(x, y) - 0.0007 * craze.at(x, y) + 0.0016 * f.streak * smooth(0.1, 0.6, f.d) + 0.0012 * fbm(u, v, 120, 120, 3, 413);
    });
    save('shieldchar_n', normalMap(hChar, 4.7, 1));
    const aoChar = cavity(hChar, 3, 300);
    save(
      'shieldchar_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const q = at(u, v);
        const f = flow(q);
        // Char: near black-brown; ash where heating was highest (round the stagnation point and on the
        // windward shoulder); streaks of both downstream.
        const ash = clamp(smooth(0.75, 0.1, f.d) * 0.75 + 0.5 * smooth(0.78, 0.98, q.r) * (1 - f.lee)) * (0.55 + 0.9 * (fbm(u, v, 9, 9, 4, 414) - 0.25));
        const streak = smooth(0.42, 0.75, f.streak) * smooth(0.12, 0.5, f.d);
        let c = lerp3(rgb(46, 40, 35), rgb(92, 86, 80), clamp(ash));
        c = lerp3(c, rgb(30, 26, 23), streak * 0.75);
        c = lerp3(c, rgb(118, 108, 96), smooth(0.7, 0.9, f.streak) * smooth(0.25, 0.7, f.d) * 0.45);
        // Spalled pits show the pale virgin material; seams are burnt out.
        c = lerp3(c, rgb(156, 138, 112), clamp(pit.at(x, y) * 1.3) * (0.35 + 0.65 * q.id));
        c = lerp3(c, rgb(16, 14, 13), smooth(0.0055, 0.0015, q.seam) * 0.9);
        c = lerp3(c, rgb(24, 21, 19), craze.at(x, y) * 0.35);
        return tint(c, (0.86 + 0.14 * fbm(u, v, 200, 200, 2, 415)) * (0.7 + 0.3 * aoChar.at(x, y)));
      }),
    );
    save('shieldchar_orm', orm(S, S, (u, v, x, y) => [aoChar.at(x, y), clamp(0.86 + 0.14 * fbm(u, v, 60, 60, 2, 416) - 0.1 * craze.at(x, y)), 1]));

    // ---- emission pattern, linear 0..1 (stored sRGB like every emissive map)
    const G = 1024;
    save(
      'shield_glow',
      Image.from(G, G, (u, v) => {
        const q = at(u, v);
        const f = flow(q);
        // Convective heating: highest at the stagnation point, a second maximum on the windward shoulder
        // where the boundary layer is thinnest, lowest on the lee side.
        let heat = 0.3 + 0.7 * Math.exp(-((f.d / 0.62) ** 2)) + 0.55 * smooth(0.8, 0.97, q.r) * (1 - 0.8 * f.lee) - 0.22 * f.lee * smooth(0.2, 1, q.r);
        heat *= 0.82 + 0.36 * f.streak * smooth(0.1, 0.5, f.d);
        heat *= 1 + 0.45 * smooth(0.006, 0.002, q.seam);
        heat *= 0.9 + 0.2 * fbm(u, v, 70, 70, 3, 417);
        heat = clamp(heat * 0.8) * smooth(1.02, 0.985, q.r);
        // Colour follows the local temperature: dull red where it is coolest, then orange, then a light orange
        // (the tone curve takes the hottest region on to yellow-white when the instance scale is high).
        const c = heat < 0.5 ? lerp3([0.6, 0.06, 0.008], [1, 0.3, 0.045], heat / 0.5) : lerp3([1, 0.3, 0.045], [1, 0.56, 0.2], (heat - 0.5) / 0.5);
        const e = Math.pow(heat, 2.2);
        return [srgb(c[0] * e), srgb(c[1] * e), srgb(c[2] * e)];
      }),
    );
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

  // Multi-layer insulation, tile 1.2 m. A blanket is a loose film: pillows and sags tens of centimetres
  // across, long sharp creases that run for decimetres and radiate from where the film is pinned, and a fine
  // crinkle that is far too small to see from where a lander is looked at. The first two are the height field
  // (creases are ridges of a stretched ridged fractal, warped so that no two run parallel); the crinkle is
  // NOT in the normal map: a field of sub-pixel mirrors flips every pixel between the sun, the sky and the
  // ground and the blanket turns into black-and-white static. Its effect on the highlight, a wider lobe, is
  // carried by the roughness instead, so the film keeps a broad streaky sheen at any distance.
  mli() {
    const S = 1024;
    const T = 1.2;
    // The film is crumpled, not embossed: straight folds of finite length, each a ridge or a valley with flat
    // flanks (a tent across it, tapering at its ends), laid over one another. Where folds cross, the flanks
    // meet in more creases, so the surface is a mosaic of flat facets of every size between sharp crease
    // lines, which is what turns a highlight into the long glints and dark folds of the photographs. Two
    // families: long hanging folds of 30-90 cm mostly along v, and fewer, gentler short ones of 10-30 cm (a
    // dense crinkle of mirror facets turns into black-and-white static from a few metres).
    const folds = new Field(S, S);
    const crest = new Field(S, S);
    const fold = (k: number, seed: number, lMin: number, lMax: number, wMin: number, wMax: number, aMin: number, aMax: number, hang: number): void => {
      const r = (q: number): number => hash(k, q, seed);
      const cu = r(1);
      const cv = r(2);
      const L = (lMin + (lMax - lMin) * r(3)) / T;
      const w = (wMin + (wMax - wMin) * r(4)) / T;
      const amp = (aMin + (aMax - aMin) * r(5)) * (r(6) < 0.55 ? 1 : -1);
      const ang = r(7) < hang ? Math.PI / 2 + (r(8) - 0.5) * 0.9 : r(8) * Math.PI;
      const du = Math.cos(ang);
      const dv = Math.sin(ang);
      const ext = L / 2 + w;
      const x0 = Math.floor((cu - ext) * S);
      const x1 = Math.ceil((cu + ext) * S);
      const y0 = Math.floor((cv - ext) * S);
      const y1 = Math.ceil((cv + ext) * S);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const pu = (x + 0.5) / S - cu;
          const pv = (y + 0.5) / S - cv;
          const along = pu * du + pv * dv;
          const across = -pu * dv + pv * du;
          if (Math.abs(across) >= w || Math.abs(along) >= L / 2) continue;
          const t = Math.abs(along) / (L / 2);
          const env = 1 - t * t * t;
          const i = mod(y, S) * S + mod(x, S);
          folds.data[i] = folds.data[i]! + amp * env * (1 - Math.abs(across) / w);
          if (amp > 0) crest.data[i] = Math.max(crest.data[i]!, env * smooth(0.25, 0, Math.abs(across) / w));
        }
      }
    };
    for (let k = 0; k < 95; k++) fold(k, 131, 0.3, 0.9, 0.06, 0.18, 0.005, 0.012, 0.7);
    for (let k = 0; k < 240; k++) fold(k, 132, 0.1, 0.3, 0.02, 0.06, 0.0008, 0.0022, 0.3);
    // A broad sag between the stand-off buttons under it.
    const h = Field.from(S, S, (u, v, x, y) => 0.006 * fbm(u, v, 3, 3, 2, 125) + folds.at(x, y));
    const creaseA = (_u: number, _v: number, x: number, y: number): number => crest.at(x, y);
    save('mli_n', normalMap(h, T, 1));
    // The aluminised (silver) film is the same blanket laid flatter: at full slope its facets flip between the
    // black sky and the sunlit ground and the panel turns into a black-and-white mosaic from a few metres.
    save('mlisilver_n', normalMap(h, T, 0.45));
    const ao = cavity(h, 6, 90);
    const [lo, hi] = h.range();
    save(
      'mli_orm',
      orm(S, S, (u, v, x, y) => {
        const c = clamp(creaseA(u, v, x, y) * 0.9);
        // Film between the folds is the smoothest; fold crests are scuffed; the unresolved crinkle varies by patch.
        return [clamp(0.72 + 0.28 * ao.at(x, y)), clamp(0.8 + 0.14 * c + 0.12 * (fbm(u, v, 10, 10, 3, 127) - 0.5)), 1];
      }),
    );
    // Amber polyimide over its aluminised back: yellow-gold on the crests, a deep orange where the film
    // folds away into the pillows' valleys.
    save(
      'mligold_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const t = clamp((h.at(x, y) - lo) / (hi - lo));
        // (The film is one colour; its depth of tint varies only a little with how it lies.)
        const c = lerp3(rgb(224, 128, 38), rgb(250, 190, 96), 0.3 + 0.4 * smooth(0.15, 0.85, t));
        return tint(c, (0.9 + 0.1 * fbm(u, v, 40, 40, 2, 128)) * (0.82 + 0.18 * ao.at(x, y)));
      }),
    );
  },

  // Capsule back shell, tile 1.44 m: 8 x 8 thermal tiles in a running bond, each closed out with aluminised
  // polyimide tape. What shows is the tape: a silver film with a faint thin-film colour that differs from
  // tile to tile (cyan to a warm rose), drawn tight over each tile so that the tile edges are soft creases,
  // lapped over its neighbour along one edge, with an occasional wrinkle and a dark vent plug in every
  // fourth tile. Joints are 1.5 mm wide and filled flush: they live in the normal, occlusion and roughness
  // maps and change the albedo by less than a tenth, so from a few metres the shell is one silver surface.
  shell() {
    const S = 2048;
    const N = 8;
    interface Cell {
      e: number;
      fu: number;
      fv: number;
      i: number;
      j: number;
      id: number;
    }
    const cellOf = (u: number, v: number): Cell => {
      const j = Math.floor(v * N);
      const uu = u * N + (mod(j, 2) === 1 ? 0.5 : 0);
      const i = Math.floor(uu);
      const fu = uu - i;
      const fv = v * N - j;
      const ii = mod(i, N);
      return { e: Math.min(fu, 1 - fu, fv, 1 - fv), fu, fv, i: ii, j, id: hash(ii, j, 501) };
    };
    /** Vent plug: every fourth tile, at the tile centre, 9 mm across. */
    const plug = (c: Cell): number => (mod(c.i + 2 * c.j, 4) === 0 ? smooth(0.03, 0.022, Math.hypot(c.fu - 0.5, c.fv - 0.5)) : 0);
    /** A wrinkle across a third of the tiles: a thin straight ridge at the tile's own angle. */
    const wrinkle = (c: Cell): number => {
      if (hash(c.i, c.j, 502) > 0.34) return 0;
      const a = hash(c.i, c.j, 503) * Math.PI;
      const d = (c.fu - 0.5) * Math.cos(a) + (c.fv - 0.5) * Math.sin(a) - (hash(c.i, c.j, 504) - 0.5) * 0.4;
      const along = -(c.fu - 0.5) * Math.sin(a) + (c.fv - 0.5) * Math.cos(a);
      return smooth(0.022, 0.0, Math.abs(d)) * smooth(0.42, 0.2, Math.abs(along)) * smooth(0.02, 0.1, c.e);
    };
    const h = Field.from(S, S, (u, v) => {
      const c = cellOf(u, v);
      // Tape drawn over the tile: flat on top, rolling off into the joint over the last 6 % of the tile.
      const roll = smooth(0.0, 0.06, c.e);
      const lap = c.fu < 0.085 ? 0.00012 : 0;
      return 0.0007 * roll - 0.0005 * smooth(0.0085, 0.003, c.e) + lap + 0.00035 * wrinkle(c) - 0.0006 * plug(c) + 0.00005 * fbm(u, v, 200, 200, 2, 505) + 0.00018 * fbm(u, v, 24, 24, 2, 506) + (c.id - 0.5) * 0.0002;
    });
    save('shell_n', normalMap(h, 1.44, 1));
    const ao = cavity(h, 2, 900);
    save(
      'shell_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const c = cellOf(u, v);
        // Thin-film tint: drifts over the shell, and steps a little from tile to tile.
        const film = clamp(fbm(u, v, 3, 3, 3, 507) + 0.12 * (c.id - 0.5));
        const base = lerp3(rgb(200, 220, 226), rgb(224, 218, 220), smooth(0.25, 0.8, film));
        let k = 0.9 + 0.022 * hash(c.i, c.j, 508) + 0.02 * fbm(u, v, 60, 60, 2, 509);
        k *= 1 - 0.08 * smooth(0.012, 0.003, c.e);
        k *= 0.96 + 0.04 * ao.at(x, y);
        const col = tint(base, k);
        return lerp3(col, rgb(52, 50, 48), plug(c) * 0.9);
      }),
    );
    save(
      'shell_orm',
      orm(S, S, (u, v, x, y) => {
        const c = cellOf(u, v);
        const joint = smooth(0.012, 0.003, c.e);
        return [clamp(ao.at(x, y) * (1 - 0.25 * joint)), clamp(0.78 + 0.16 * c.id + 0.2 * joint + 0.25 * plug(c) + 0.06 * (fbm(u, v, 50, 50, 2, 510) - 0.5)), clamp(1 - 0.8 * plug(c) - 0.3 * joint)];
      }),
    );
  },

  // Steel deck plate of the launch mount, tile 7.2 m: painted plates 2.4 x 1.2 m in a running bond, welded
  // seams, a bolt row inside every long edge, raised anti-slip lugs, paint worn to primer and rust along
  // the seams, rust runs from the bolts, soot mottling. (Large stains and the blast scorch are mesh weights.)
  deck() {
    const S = 2048;
    const NX = 3;
    const NY = 6;
    interface Cell {
      eu: number;
      ev: number;
      fu: number;
      fv: number;
      id: number;
    }
    const cellOf = (u: number, v: number): Cell => {
      const j = Math.floor(v * NY);
      const uu = u * NX + (mod(j, 2) === 1 ? 0.5 : 0);
      const i = Math.floor(uu);
      const fu = uu - i;
      const fv = v * NY - j;
      // Distances to the plate edges in metres.
      return { eu: Math.min(fu, 1 - fu) * 2.4, ev: Math.min(fv, 1 - fv) * 1.2, fu, fv, id: hash(mod(i, NX), j, 521) };
    };
    const boltAt = (c: Cell): number => {
      // Bolts every 0.3 m, 6 cm inside the long edges.
      if (Math.abs(c.ev - 0.06) > 0.02) return 0;
      const t = mod(c.fu * 8, 1) - 0.5;
      return smooth(0.02, 0.012, Math.hypot(t * 0.3, c.ev - 0.06));
    };
    // Anti-slip lugs: short bars on a 4 cm diamond lattice, alternating between the two diagonals.
    const tread = (u: number, v: number): number => {
      const a = mod((u + v) * 90, 1) - 0.5;
      const b = mod((u - v) * 90, 1) - 0.5;
      return Math.max(smooth(0.34, 0.2, Math.abs(a)) * smooth(0.1, 0.04, Math.abs(b)), 0);
    };
    const h = Field.from(S, S, (u, v) => {
      const c = cellOf(u, v);
      const e = Math.min(c.eu, c.ev);
      // Weld bead standing proud along every seam, plates slightly dished.
      return 0.004 * smooth(0.028, 0.006, e) * (0.7 + 0.6 * fbm(u, v, 300, 300, 1, 522)) + 0.0045 * boltAt(c) + 0.0014 * tread(u, v) + 0.003 * fbm(u, v, 12, 12, 3, 523) + (c.id - 0.5) * 0.002;
    });
    save('deck_n', normalMap(h, 7.2, 1));
    const ao = cavity(h, 3, 200);
    const rustAt = (u: number, v: number, c: Cell): number => {
      const e = Math.min(c.eu, c.ev);
      const seam = smooth(0.14, 0.02, e) * smooth(0.42, 0.62, fbm(u, v, 30, 30, 3, 524));
      // Runs away from the bolt rows.
      const run = smooth(0.5, 0.75, fbm(u, v, 90, 6, 2, 525)) * smooth(0.5, 0.1, c.ev) * 0.7;
      const bloom = smooth(0.68, 0.8, fbm(u, v, 16, 16, 4, 526));
      return clamp(seam + run + bloom * 0.8);
    };
    save(
      'deck_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const c = cellOf(u, v);
        const paint = tint(rgb(104, 110, 114), 0.86 + 0.2 * c.id + 0.1 * (fbm(u, v, 24, 24, 3, 527) - 0.5));
        const rust = lerp3(rgb(98, 58, 34), rgb(60, 36, 24), fbm(u, v, 80, 80, 2, 528));
        let col = lerp3(paint, rust, rustAt(u, v, c) * 0.85);
        // Bare, polished lugs where boots and wheels have worn the paint off.
        col = lerp3(col, rgb(150, 150, 148), tread(u, v) * 0.35 * smooth(0.4, 0.7, fbm(u, v, 7, 7, 3, 529)));
        col = lerp3(col, rgb(40, 38, 36), smooth(0.012, 0.004, Math.min(c.eu, c.ev)) * 0.6);
        return tint(col, (0.86 + 0.14 * fbm(u, v, 200, 200, 2, 530)) * (0.72 + 0.28 * ao.at(x, y)));
      }),
    );
    save(
      'deck_orm',
      orm(S, S, (u, v, x, y) => {
        const c = cellOf(u, v);
        return [ao.at(x, y), clamp(0.72 + 0.28 * rustAt(u, v, c) + 0.1 * (fbm(u, v, 40, 40, 2, 531) - 0.5)), 1];
      }),
    );
  },

  // Asphalt of the service roads, tile 6 m: dark binder, exposed aggregate, tar-sealed cracks, a paler tone
  // where the surface has weathered.
  asphalt() {
    const S = 1024;
    const stone = Field.from(S, S, (u, v) => {
      const c = worley(u, v, 300, 300, 541, 1);
      return smooth(0.5, 0.2, c.f1) * c.id;
    });
    // Cracks in a road run across it (thermal) and along it (at the edge of a paving pass), as single wandering
    // lines that were sealed with a band of tar: no network of polygons.
    const lines: { across: boolean; at: number; from: number; to: number; w: number; k: number; slope: number }[] = [];
    for (let k = 0; k < 4; k++) {
      const r = (q: number): number => hash(k, q, 549);
      const len = 0.3 + 0.55 * r(3);
      lines.push({ across: k < 3, at: r(1), from: r(2), to: r(2) + len, w: 0.0016 + 0.0022 * r(4), k, slope: (r(5) - 0.5) * 0.25 });
    }
    const crack = (u: number, v: number): number => {
      let c = 0;
      for (const l of lines) {
        const a = l.across ? u : v;
        const b = l.across ? v : u;
        // Position along the line (wrapped into [from, from + 1)) and the line's wander across.
        const t = mod(a - l.from, 1);
        if (t > l.to - l.from) continue;
        const end = smooth(0, 0.04, t) * smooth(l.to - l.from, l.to - l.from - 0.04, t);
        const off = l.slope * t + 0.05 * (fbm(a, l.k * 0.37, 4, 1, 3, 542 + l.k) - 0.5) + 0.006 * (fbm(a, l.k * 0.61, 40, 1, 2, 543 + l.k) - 0.5);
        let d = Math.abs(mod(b - l.at - off + 0.5, 1) - 0.5);
        d = d / l.w;
        c = Math.max(c, end * smooth(1, 0.35, d));
      }
      return c;
    };
    const h = Field.from(S, S, (u, v, x, y) => 0.004 * stone.at(x, y) + 0.006 * fbm(u, v, 20, 20, 3, 546) + 0.002 * crack(u, v));
    save('asphalt_n', normalMap(h, 6, 0.8));
    const ao = cavity(h, 2, 120);
    save(
      'asphalt_albedo',
      Image.from(S, S, (u, v, x, y) => {
        const k = 0.2 + 0.07 * fbm(u, v, 5, 5, 4, 547) + 0.09 * stone.at(x, y) + 0.03 * fbm(u, v, 300, 300, 1, 548);
        const c = mix(k, 0.07, crack(u, v));
        const t = c * (0.8 + 0.2 * ao.at(x, y));
        return [t * 1.0, t * 0.99, t * 0.97];
      }),
    );
    save('asphalt_orm', orm(S, S, (u, v, x, y) => [ao.at(x, y), clamp(0.9 + 0.1 * stone.at(x, y) - 0.25 * crack(u, v)), 1]));
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
      // Alpha is the steel (1) and the opening (0): the material cuts the openings out (request vehicle-pad-4),
      // so the sky and the structure show through the grating.
      Image.from(S, S, (u, v) => {
        const k = mix(0.045, 0.62 + 0.08 * fbm(u, v, 20, 20, 2, 141), bar(u, v));
        return [k * 0.97, k * 0.985, k];
      }).alpha((u, v) => bar(u, v)),
    );
    save('grate_orm', orm(S, S, (u, v) => [clamp(0.25 + 0.75 * bar(u, v)), 0.9, bar(u, v)]));
  },

  // Chain-link fence fabric, tile 0.6 m: twelve 50 mm diamonds of 3.5 mm galvanised wire, woven (the wires
  // of the two directions pass over and under each other at the knuckles).
  chainlink() {
    const S = 512;
    const N = 12;
    const wire = (u: number, v: number): { k: number; over: number } => {
      const a = Math.abs(mod((u + v) * N, 1) - 0.5);
      const b = Math.abs(mod((u - v) * N, 1) - 0.5);
      const wa = smooth(0.445, 0.47, a);
      const wb = smooth(0.445, 0.47, b);
      return { k: Math.max(wa, wb), over: wa > wb ? 1 : 0.8 };
    };
    const h = Field.from(S, S, (u, v) => {
      const w = wire(u, v);
      return 0.004 * w.k * w.over;
    });
    save('chainlink_n', normalMap(h, 0.6, 0.6));
    save(
      'chainlink_albedo',
      Image.from(S, S, (u, v) => {
        const w = wire(u, v);
        const k = (0.34 + 0.08 * fbm(u, v, 30, 30, 2, 191)) * w.over;
        return [k * 0.97, k * 0.985, k];
      }).alpha((u, v) => wire(u, v).k),
    );
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
    const h = Field.from(S, S, (u0, v0) => {
      // The stitch lines wander: a hand-sewn blanket is not a printed lattice, and its pillows differ in loft.
      const u = u0 + 0.012 * (fbm(u0, v0, 5, 5, 3, 173) - 0.5);
      const v = v0 + 0.012 * (fbm(u0, v0, 5, 5, 3, 174) - 0.5);
      const a = Math.abs(Math.sin(Math.PI * (u + v) * 4));
      const b = Math.abs(Math.sin(Math.PI * (u - v) * 4));
      const pillow = Math.pow(a * b, 0.45) * (0.6 + 0.8 * fbm(u0, v0, 8, 8, 2, 175));
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
