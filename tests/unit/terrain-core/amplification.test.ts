/**
 * Procedural amplification: crater size-frequency statistics, calibrated regolith RMS slope, bounded morph
 * between consecutive render levels, rocks (stable instances, collidable bumps), noise statistics, registry.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { TerrainAmplificationDef } from '../../../src/core/contracts/defs';
import { latLonToDir } from '../../../src/core/geo/cubeSphere';
import { Prng } from '../../../src/core/math/hash';
import { DEG } from '../../../src/core/math/scalar';
import type { Vec3 } from '../../../src/core/math/vec3';
import { createAmplificationModel } from '../../../src/terrain/amplification/registry';
import { lunarCraterParams } from '../../../src/terrain/amplification/lunarRegolith';
import { CraterField, type CraterRecord } from '../../../src/terrain/craters';
import { GradientNoise3, NOISE_GRAD_RMS, NOISE_RMS } from '../../../src/terrain/noise';
import type { TerrainAuthority } from '../../../src/terrain/provider';
import { golombekArea, golombekDensity } from '../../../src/terrain/rocks';
import { shellCellsInCap } from '../../../src/terrain/shellCells';
import { BASELINES, boxPoints, calibrationModel, modelSlopes } from '../../../tools/terrain-core/calibrate-regolith';
import { amplificationDefs, EARTH_R, FIXTURE_POINTS, MOON_R } from '../../../tools/terrain-core/fixtures';
import { angleBetween, fixtureProvider, offset, REPO_ROOT } from './helpers';

const REAL_G = 6;
const MAX_RENDER = 18;

describe('lunar craters', () => {
  let def: TerrainAmplificationDef;
  beforeAll(async () => {
    def = (await amplificationDefs(REPO_ROOT)).moon;
  });

  it('count vs size on a 1 km^2 patch is within 20 % of the equilibrium law', () => {
    const lambda0 = (Math.PI * MOON_R) / 256;
    const field = new CraterField(lunarCraterParams(def, MOON_R, REAL_G, lambda0));
    const f = def.params['craterEquilibriumFraction']!;
    const centre = latLonToDir(-12 * DEG, 77 * DEG);
    // 1 km x 1 km square in the tangent plane.
    let ex = { x: -centre.y, y: centre.x, z: 0 };
    const l = Math.hypot(ex.x, ex.y);
    ex = { x: ex.x / l, y: ex.y / l, z: 0 };
    const ny = { x: centre.y * ex.z - centre.z * ex.y, y: centre.z * ex.x - centre.x * ex.z, z: centre.x * ex.y - centre.y * ex.x };
    const diam: number[] = [];
    for (const c of field.classes) {
      const cells = shellCellsInCap(centre, 720, MOON_R, c.cell, c.shellHalf);
      const list: CraterRecord[] = [];
      for (let k = 0; k < cells.length; k += 3) c.cellCraters(cells[k]!, cells[k + 1]!, cells[k + 2]!, list);
      for (const r of list) {
        const dx = r.cx - centre.x * MOON_R;
        const dy = r.cy - centre.y * MOON_R;
        const dz = r.cz - centre.z * MOON_R;
        const u = dx * ex.x + dy * ex.y + dz * ex.z;
        const v = dx * ny.x + dy * ny.y + dz * ny.z;
        if (Math.abs(u) <= 500 && Math.abs(v) <= 500) diam.push(r.diameter);
      }
    }
    const rows: string[] = [];
    for (const D of [1, 2, 4, 8, 16]) {
      const n = diam.filter((d) => d >= D).length;
      const expected = 1.54 * f * D ** -2 * 1e6;
      rows.push(`N(>${D} m) = ${n} (law ${expected.toFixed(0)})`);
      expect(Math.abs(n - expected) / expected, `D >= ${D} m`).toBeLessThan(0.2);
    }
    console.log(`[craters] 1 km^2: ${rows.join(', ')}`);
  });

  it('freshness is weighted to degraded craters (mean d/D matches the NAC craters near the landing target)', () => {
    const lambda0 = (Math.PI * MOON_R) / 256;
    const field = new CraterField(lunarCraterParams(def, MOON_R, REAL_G, lambda0));
    const c = field.classes.find((x) => x.dLo >= 20)!;
    const cells = shellCellsInCap(latLonToDir(0, 30 * DEG), 80e3, MOON_R, c.cell, c.shellHalf);
    const list: CraterRecord[] = [];
    for (let k = 0; k < cells.length; k += 3) c.cellCraters(cells[k]!, cells[k + 1]!, cells[k + 2]!, list);
    const dD = list.map((r) => r.depth / r.diameter);
    expect(dD.length).toBeGreaterThan(200);
    // The bake's detector (36 NAC craters >= 20 m around the recommended target, bake-moon-sky region file)
    // sees craters with d/D >= ~0.03: mean d/D ~0.07, 2 of 36 deeper than 0.15. Ghost craters below that are
    // invisible to it but present in the model.
    const visible = dD.filter((x) => x >= 0.03);
    const mean = visible.reduce((a, b) => a + b, 0) / visible.length;
    const fresh = dD.filter((x) => x > 0.15).length / dD.length;
    console.log(`[craters] ${dD.length} craters >= 20 m: ${visible.length} with d/D >= 0.03 (mean ${mean.toFixed(3)}), fraction with d/D > 0.15: ${fresh.toFixed(3)}`);
    expect(mean).toBeGreaterThan(0.06);
    expect(mean).toBeLessThan(0.1);
    expect(fresh).toBeLessThan(0.1);
  });
});

describe('regolith RMS slope', () => {
  it('reproduces the NAC-calibrated RMS slope at 2-8 m baselines within 15 %', async () => {
    const def = (await amplificationDefs(REPO_ROOT)).moon;
    const lam = def.params['calibrationLambdaM']!;
    const pts = boxPoints(-20, 20, -60, 60, 3000, new Prng(77));
    const sl = modelSlopes(def, MOON_R, REAL_G, MAX_RENDER, lam, pts, 9);
    const rows = BASELINES.map((b, k) => {
      const target = def.params[`calibrationTargetRmsSlope${b}m`]!;
      expect(Math.abs(sl[k]! / target - 1), `baseline ${b} m`).toBeLessThan(0.15);
      return `${b} m: ${sl[k]!.toFixed(4)} (target ${target})`;
    });
    console.log(`[regolith] RMS slope ${rows.join(', ')}`);
  });
});

describe('bounded morph', () => {
  it('amplification changes by at most one octave amplitude between consecutive render levels', async () => {
    const amp = await amplificationDefs(REPO_ROOT);
    for (const [def, R] of [
      [amp.moon, MOON_R],
      [amp.earth, EARTH_R],
    ] as const) {
      const model = def.model === 'lunar-regolith' ? calibrationModel(def, R, REAL_G, MAX_RENDER) : earthModel(def, R);
      const m = new Float64Array(model.modulatorCount);
      const rng = new Prng(3);
      const log2Ld = Math.log2((Math.PI * R) / 256) - REAL_G;
      let worst = 0;
      for (let i = 0; i < 400; i++) {
        const d = latLonToDir(rng.range(-1, 1) * 60 * DEG, rng.range(-180, 180) * DEG);
        model.modulators({ px: 0, py: 0, pz: 0, E: REAL_G, log2LambdaData: log2Ld, dataHeight: 100, dataSlope: rng.range(0, 0.3), landcover: lcSample(rng) }, m, 0);
        for (let L = 8; L <= 19; L++) {
          const lamL = (Math.PI * R) / 2 / 2 ** L / 32;
          const lams = new Float64Array([Math.log2(lamL), Math.log2(lamL / 2)]);
          const out = new Float64Array(2);
          model.add(d.x * R, d.y * R, d.z * R, m, 0, lams, 2, out, Infinity, true);
          const bound = model.octaveBound(Math.log2(lamL), m, 0);
          const diff = Math.abs(out[0]! - out[1]!);
          worst = Math.max(worst, diff / bound);
          expect(diff, `${def.model} level ${L}`).toBeLessThanOrEqual(bound);
        }
      }
      console.log(`[morph] ${def.model}: max |A(level) - A(level + 1)| / one-octave amplitude = ${worst.toFixed(3)}`);
    }
  });
});

function earthModel(def: TerrainAmplificationDef, R: number): ReturnType<typeof calibrationModel> {
  return createAmplificationModel(def, {
    services: {
      bodyId: 'test',
      radius: R,
      seaLevel: 0,
      flattenAt: () => 0,
      effectiveLevelAt: () => REAL_G,
      landcoverAt: (_x, _y, _z, out) => {
        out.fill(0);
        out[2] = 1;
        return 1;
      },
      dataGeneration: () => 0,
      markIncomplete: () => undefined,
    },
    globalMaxLevel: REAL_G,
    log2FinestLambda: Math.log2((Math.PI * R) / 2 / 2 ** 20 / 128),
    lambda0: (Math.PI * R) / 256,
  });
}

function lcSample(rng: Prng): Float64Array {
  const w = new Float64Array(12);
  const a = Math.floor(rng.next() * 12);
  const b = Math.floor(rng.next() * 12);
  const t = rng.next();
  w[a] = w[a]! + t;
  w[b] = w[b]! + 1 - t;
  return w;
}

describe('rocks', () => {
  let tp: TerrainAuthority;
  const lava = offset(FIXTURE_POINTS.padDir, 3000, 1500, EARTH_R);
  beforeAll(async () => {
    tp = (await fixtureProvider()).tp;
    await tp.ensureLoaded('moon', FIXTURE_POINTS.moonGlobal, 200, 'rocks');
    await tp.ensureLoaded('earth', lava, 200, 'rocks');
  }, 120_000);

  it('Golombek-Rapp: area fraction and number density are consistent', () => {
    for (const k of [0.01, 0.05, 0.2]) {
      // integral over D >= D0 of (pi D^2 / 4) n(D) dD equals F(D0)
      let a = 0;
      const D0 = 0.1;
      for (let D = D0; D < 20; D += 0.0005) a += ((Math.PI * D * D) / 4) * golombekDensity(D + 0.00025, k) * 0.0005;
      expect(a / golombekArea(D0, k)).toBeCloseTo(1, 2);
    }
  });

  it('overlapping queries return the same instances', () => {
    for (const [body, c, R] of [
      ['moon', FIXTURE_POINTS.moonGlobal, MOON_R],
      ['earth', lava, EARTH_R],
    ] as const) {
      const c2 = offset(c, 20, 0, R);
      const a = tp.rocksNear(body, c, 30, 0.05);
      const b = tp.rocksNear(body, c2, 30, 0.05);
      expect(a.length).toBeGreaterThan(10);
      const inBoth = (r: { dir: Vec3 }): boolean => angleBetween(r.dir, c) * R <= 30 && angleBetween(r.dir, c2) * R <= 30;
      const sa = a.filter(inBoth).map((r) => JSON.stringify(r));
      const sb = b.filter(inBoth).map((r) => JSON.stringify(r));
      expect(sa.length).toBeGreaterThan(0);
      expect(new Set(sa)).toEqual(new Set(sb));
      // minRadius filters without changing the instances
      const big = tp.rocksNear(body, c, 30, 0.2).map((r) => JSON.stringify(r));
      for (const s of big) expect(sa.concat(a.map((r) => JSON.stringify(r)))).toContain(s);
    }
  });

  it('collidable rocks raise the height function (and the collision surface); small rocks do not', () => {
    let tested = 0;
    for (const [body, c, R] of [
      ['moon', FIXTURE_POINTS.moonGlobal, MOON_R],
      ['earth', lava, EARTH_R],
    ] as const) {
      const rocks = tp.rocksNear(body, c, 60, 0.05);
      // Rocks are tested in isolation: overlapping footprints add up.
      const isolated = rocks.filter((r) => rocks.every((o) => o === r || angleBetween(o.dir, r.dir) * R > o.radius + r.radius));
      for (const r of isolated) {
        const h = tp.heightAt(body, r.dir, body === 'moon' ? 0.32 : 0.3);
        const bump = h - r.baseHeight;
        if (r.radius >= 0.15) {
          expect(bump).toBeGreaterThan(0.35 * r.radius * 0.99);
          expect(bump).toBeLessThan(0.8 * r.radius * 1.01 + 0.02);
          if (r.radius >= 0.3) expect(tp.heightAt(body, r.dir) - r.baseHeight).toBeGreaterThan(0.1 * r.radius);
          tested++;
        } else expect(Math.abs(bump)).toBeLessThan(0.02);
      }
    }
    expect(tested).toBeGreaterThan(3);
  });

  it('no rocks on the launch pad', () => {
    const rocks = tp.rocksNear('earth', FIXTURE_POINTS.padDir, 460, 0.05);
    for (const r of rocks) expect(angleBetween(r.dir, FIXTURE_POINTS.padDir) * EARTH_R).toBeGreaterThan(450);
  });
});

describe('noise', () => {
  it('re-measured statistics match the normalisation constants', () => {
    const rng = new Prng(99);
    const n = new GradientNoise3(5);
    let s2 = 0;
    let g2 = 0;
    const N = 1 << 16;
    for (let i = 0; i < N; i++) {
      const x = rng.range(-1e5, 1e5);
      const y = rng.range(-1e5, 1e5);
      const z = rng.range(-1e5, 1e5);
      const v = n.value(x, y, z);
      s2 += v * v;
      const h = 1e-4;
      const d = (n.value(x + h, y, z) - n.value(x - h, y, z)) / (2 * h);
      g2 += d * d;
    }
    expect(Math.sqrt(s2 / N) / NOISE_RMS).toBeCloseTo(1, 1);
    expect(Math.sqrt(g2 / N) / NOISE_GRAD_RMS).toBeCloseTo(1, 1);
  });
});

describe('registry', () => {
  it('rejects unknown models and missing parameters with a clear error', async () => {
    const amp = await amplificationDefs(REPO_ROOT);
    const ctx = { services: calibrationServices(), globalMaxLevel: 6, log2FinestLambda: -3, lambda0: 21000 };
    expect(() => createAmplificationModel({ model: 'nope', seed: 1, params: {} }, ctx)).toThrow(/unknown terrain amplification model "nope"/);
    const params = { ...amp.moon.params };
    delete params['hurstMaria'];
    expect(() => createAmplificationModel({ ...amp.moon, params }, ctx)).toThrow(/hurstMaria/);
    expect(createAmplificationModel({ model: 'none', seed: 1, params: {} }, ctx).modulatorCount).toBe(0);
  });
});

function calibrationServices(): Parameters<typeof createAmplificationModel>[1]['services'] {
  return {
    bodyId: 't',
    radius: MOON_R,
    seaLevel: null,
    flattenAt: () => 0,
    effectiveLevelAt: () => 6,
    landcoverAt: () => 0,
    dataGeneration: () => 0,
    markIncomplete: () => undefined,
  };
}
