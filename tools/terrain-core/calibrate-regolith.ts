/**
 * Calibrates the lunar regolith fBm against the real NAC DTM tiles.
 *
 *   npx tsx tools/terrain-core/calibrate-regolith.ts            report only
 *   npx tsx tools/terrain-core/calibrate-regolith.ts --write    also update data/defs/terrain/moon.amplification.json
 *
 * Target: what the high-resolution data adds above the global level - the residual
 * R = D(full) - D(band limit = data wavelength of the global level g) - measured inside the NAC strip
 * (data/defs/regions/moon-*.json, the "nacDtm" bounds of the region, shrunk by the 300 m feather): RMS of the
 * directional slope (H(p + b/2 e) - H(p - b/2 e)) / b at baselines b = 2, 4, 8 m over random points and
 * azimuths. That residual is exactly what procedural amplification has to supply wherever only the global
 * level exists.
 * Model: the amplification alone (fBm + craters + rocks) at effective level g, unit multifractal factor
 * (mare data), band-limited at two postings of the NAC level (the resolution of the target), same baselines.
 * Fit: regolithSlope1m and hurstMaria by least squares in log RMS slope over the three baselines (crater and
 * rock parameters are literature values and stay fixed).
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TerrainAmplificationDef } from '../../src/core/contracts/defs';
import { latLonToDir } from '../../src/core/geo/cubeSphere';
import { Prng } from '../../src/core/math/hash';
import { DEG } from '../../src/core/math/scalar';
import type { Vec3 } from '../../src/core/math/vec3';
import { fsDefSource } from '../../src/core/defs/fsSource';
import { loadDefs } from '../../src/core/defs/loader';
import { createLunarRegolith } from '../../src/terrain/amplification/lunarRegolith';
import type { AmplificationModel, BodyServices } from '../../src/terrain/amplification/types';
import { createFsTileSource } from '../../src/terrain/fsTileSource';
import { createTerrainProvider } from '../../src/terrain/provider';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASELINES = [2, 4, 8];

export interface SlopeStats {
  baselines: number[];
  rms: number[];
}

/** RMS directional slope of h over random points (dirs) and azimuths at each baseline. */
export function rmsSlopes(h: (d: Vec3) => number, pts: Vec3[], R: number, rng: Prng, baselines = BASELINES): number[] {
  return baselines.map((b) => {
    let s2 = 0;
    for (const p of pts) {
      const a = rng.range(0, Math.PI * 2);
      let ex = { x: -p.y, y: p.x, z: 0 };
      const l = Math.hypot(ex.x, ex.y) || 1;
      ex = { x: ex.x / l, y: ex.y / l, z: 0 };
      const ny = { x: p.y * ex.z - p.z * ex.y, y: p.z * ex.x - p.x * ex.z, z: p.x * ex.y - p.y * ex.x };
      const t = { x: Math.cos(a) * ex.x + Math.sin(a) * ny.x, y: Math.cos(a) * ex.y + Math.sin(a) * ny.y, z: Math.cos(a) * ex.z + Math.sin(a) * ny.z };
      const at = (k: number): Vec3 => {
        const x = p.x + (t.x * k) / R;
        const y = p.y + (t.y * k) / R;
        const z = p.z + (t.z * k) / R;
        const m = Math.hypot(x, y, z);
        return { x: x / m, y: y / m, z: z / m };
      };
      const s = (h(at(b / 2)) - h(at(-b / 2))) / b;
      s2 += s * s;
    }
    return Math.sqrt(s2 / pts.length);
  });
}

/** Points uniformly in a lat/lon box (degrees). */
export function boxPoints(lat0: number, lat1: number, lon0: number, lon1: number, n: number, rng: Prng): Vec3[] {
  return Array.from({ length: n }, () => latLonToDir(rng.range(lat0, lat1) * DEG, rng.range(lon0, lon1) * DEG));
}

/** Lunar model with calibration services: effective level g everywhere, no flattening, no land cover. */
export function calibrationModel(def: TerrainAmplificationDef, R: number, g: number, maxRenderLevel: number): AmplificationModel {
  const services: BodyServices = {
    bodyId: 'calibration',
    radius: R,
    seaLevel: null,
    flattenAt: () => 0,
    effectiveLevelAt: () => g,
    landcoverAt: () => 0,
    dataGeneration: () => 0,
    markIncomplete: () => undefined,
  };
  return createLunarRegolith(def, {
    services,
    globalMaxLevel: g,
    log2FinestLambda: Math.log2((Math.PI * R) / 2 / 2 ** maxRenderLevel / 128),
    lambda0: (Math.PI * R) / 256,
  });
}

/** RMS slopes of the amplification alone at effective level g, unit multifractal factor, band limit lambda. */
export function modelSlopes(def: TerrainAmplificationDef, R: number, g: number, maxRenderLevel: number, lambda: number, pts: Vec3[], seed: number): number[] {
  const model = calibrationModel(def, R, g, maxRenderLevel);
  const m = new Float64Array(model.modulatorCount);
  const log2LambdaData = Math.log2((Math.PI * R) / 256) - g;
  const hurst = def.params['hurstMaria']!;
  const s1 = def.params['regolithSlope1m']!;
  // Data slope equal to the mare reference at the data scale => multifractal factor 1.
  model.modulators({ px: 0, py: 0, pz: 0, E: g, log2LambdaData, dataHeight: 0, dataSlope: s1 * 2 ** (log2LambdaData * (hurst - 1)), landcover: null }, m, 0);
  const lam = new Float64Array([Math.log2(lambda)]);
  const out = new Float64Array(1);
  const h = (d: Vec3): number => {
    out[0] = 0;
    model.add(d.x * R, d.y * R, d.z * R, m, 0, lam, 1, out, Infinity, true);
    return out[0]!;
  };
  return rmsSlopes(h, pts, R, new Prng(seed));
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const ampFile = path.join(repo, 'data/defs/terrain/moon.amplification.json');
  const def = JSON.parse(await fs.readFile(ampFile, 'utf8')) as TerrainAmplificationDef;
  const tiles = path.join(repo, 'data/tiles');
  if (!existsSync(path.join(tiles, 'moon', 'manifest.json'))) {
    console.log('No data/tiles/moon/manifest.json: nothing to calibrate against (the defaults in the amplification file stay).');
    return;
  }
  const defs = await loadDefs(fsDefSource(path.join(repo, 'data/defs')));
  const body = defs.bodies['moon']!;
  const R = body.radius;
  const src = createFsTileSource(tiles);
  const manifest = await src.manifest('moon');
  const hl = manifest.layers['height']!;
  const g = hl.globalMaxLevel;
  const maxLevel = Math.max(...Object.keys(hl.coverage).map(Number));
  // Sample inside the region's recommended mission disc, which the bake guarantees to be 100 % NAC data
  // (missionDiscSourceFraction 1 over 1.5 km).
  const regionsDir = path.join(repo, 'data/defs/regions');
  let centre: { latDeg: number; lonDeg: number } | null = null;
  for (const f of (await fs.readdir(regionsDir)).filter((x) => x.startsWith('moon-') && x.endsWith('.json'))) {
    const r = JSON.parse(await fs.readFile(path.join(regionsDir, f), 'utf8')) as { recommendedTarget?: { latDeg: number; lonDeg: number; criteria?: { missionDiscSourceFraction?: number } } };
    if (r.recommendedTarget && (r.recommendedTarget.criteria?.missionDiscSourceFraction ?? 0) >= 0.999) centre = r.recommendedTarget;
  }
  if (!centre) throw new Error('no data/defs/regions/moon-*.json with a recommendedTarget inside NAC data');
  const dataDefs = { ...defs, bodies: { moon: { ...body, terrain: { ...body.terrain!, amplification: { ...body.terrain!.amplification, model: 'none' } } } } };
  const tp = await createTerrainProvider(dataDefs, src, { bodies: ['moon'], cacheBytes: 1024 * 1024 * 1024 });
  const rng = new Prng(20261109);
  const c = latLonToDir(centre.latDeg * DEG, centre.lonDeg * DEG);
  const pts = discPoints(c, 1400, R, 3000, rng);
  const box = { lat0: centre.latDeg, lat1: centre.latDeg, lon0: centre.lonDeg, lon1: centre.lonDeg };
  const lamG = (Math.PI * R) / 256 / 2 ** g;
  await tp.ensureLoaded('moon', c, 1500, 'calibration');
  const resid = (d: Vec3): number => tp.heightAt('moon', d, 0.01) - tp.heightAt('moon', d, lamG);
  const target = rmsSlopes(resid, pts, R, new Prng(5));
  const full = rmsSlopes((d) => tp.heightAt('moon', d, 0.01), pts, R, new Prng(5));
  const nacPosting = (Math.PI * R) / 2 / 2 ** maxLevel / 256;
  const lambdaCal = 2 * nacPosting;
  console.log(`NAC disc of 1.4 km around ${box.lat0} N ${box.lon0} E, ${pts.length} points, level ${maxLevel} posting ${nacPosting.toFixed(2)} m`);
  console.log(`  data RMS slope at ${BASELINES.join('/')} m: ${full.map((x) => x.toFixed(4)).join(' / ')}`);
  console.log(`  target (data detail above level ${g}): ${target.map((x) => x.toFixed(4)).join(' / ')}`);
  // Fit: crater equilibrium fraction f (crater relief dominates lunar slopes at these scales) on a grid, the
  // fBm amplitude S1 by bisection per f, Hurst exponent on a grid. Prior: the fBm (regolith micro-relief)
  // carries at least FBM_SHARE of the slope variance at 2 m, so the split between craters and regolith is not
  // left to the noise of three nearly equal targets.
  const FBM_SHARE = 0.25;
  const mpts = boxPoints(-20, 20, -60, 60, 3000, new Prng(77));
  let best = { err: Infinity, s1: def.params['regolithSlope1m']!, h: def.params['hurstMaria']!, f: def.params['craterEquilibriumFraction']!, slopes: [0, 0, 0] };
  const trial = (s1: number, h: number, f: number): number[] => {
    const d2: TerrainAmplificationDef = { ...def, params: { ...def.params, regolithSlope1m: s1, hurstMaria: h, craterEquilibriumFraction: f } };
    return modelSlopes(d2, R, g, body.terrain!.maxRenderLevel, lambdaCal, mpts, 9);
  };
  const logErr = (sl: number[]): number => BASELINES.reduce((acc, _b, k) => acc + Math.log(sl[k]! / target[k]!) ** 2, 0);
  for (const f of [0.003, 0.004, 0.005, 0.006, 0.008, 0.01, 0.0125, 0.015, 0.02, 0.03]) {
    const craterOnly = trial(1e-7, 0.9, f);
    if (craterOnly[0]! ** 2 > (1 - FBM_SHARE) * target[0]! ** 2) {
      console.log(`  f ${f}: craters + rocks alone ${craterOnly.map((x) => x.toFixed(4)).join(' / ')} exceed ${(100 * (1 - FBM_SHARE)).toFixed(0)} % of the target variance`);
      continue;
    }
    for (const h of [0.8, 0.85, 0.9, 0.95]) {
      let lo = 0.0005;
      let hi = 0.4;
      for (let it = 0; it < 16; it++) {
        const mid = Math.sqrt(lo * hi);
        const sl = trial(mid, h, f);
        const e = BASELINES.reduce((acc, _b, k) => acc + Math.log(sl[k]! / target[k]!), 0);
        if (e > 0) hi = mid;
        else lo = mid;
      }
      const s1 = Math.sqrt(lo * hi);
      const sl = trial(s1, h, f);
      const err = logErr(sl);
      console.log(`  f ${f} hurst ${h}: regolithSlope1m ${s1.toFixed(4)} -> ${sl.map((x) => x.toFixed(4)).join(' / ')} (log-rms err ${Math.sqrt(err / 3).toFixed(3)}; craters+rocks alone ${craterOnly.map((x) => x.toFixed(4)).join(' / ')})`);
      if (err < best.err) best = { err, s1, h, f, slopes: sl };
    }
  }
  console.log(`  best: craterEquilibriumFraction ${best.f}, hurstMaria ${best.h}, regolithSlope1m ${best.s1.toFixed(4)}; model ${best.slopes.map((x) => x.toFixed(4)).join(' / ')} vs target ${target.map((x) => x.toFixed(4)).join(' / ')}`);
  if (write) {
    def.params['regolithSlope1m'] = Number(best.s1.toFixed(4));
    def.params['hurstMaria'] = best.h;
    def.params['craterEquilibriumFraction'] = best.f;
    BASELINES.forEach((b, k) => {
      def.params[`calibrationTargetRmsSlope${b}m`] = Number(target[k]!.toFixed(4));
    });
    def.params['calibrationLambdaM'] = Number(lambdaCal.toFixed(3));
    await fs.writeFile(ampFile, `${JSON.stringify(def, null, 2)}\n`);
    console.log(`  written to ${path.relative(repo, ampFile)}`);
  }
}

/** Points uniformly in a disc of `radius` m around unit dir c on a sphere of radius R. */
export function discPoints(c: Vec3, radius: number, R: number, n: number, rng: Prng): Vec3[] {
  let ex = { x: -c.y, y: c.x, z: 0 };
  const l = Math.hypot(ex.x, ex.y) || 1;
  ex = { x: ex.x / l, y: ex.y / l, z: 0 };
  const ny = { x: c.y * ex.z - c.z * ex.y, y: c.z * ex.x - c.x * ex.z, z: c.x * ex.y - c.y * ex.x };
  return Array.from({ length: n }, () => {
    const r = radius * Math.sqrt(rng.next());
    const a = rng.range(0, Math.PI * 2);
    const ox = (r * Math.cos(a)) / R;
    const oy = (r * Math.sin(a)) / R;
    const x = c.x + ex.x * ox + ny.x * oy;
    const y = c.y + ex.y * ox + ny.y * oy;
    const z = c.z + ex.z * ox + ny.z * oy;
    const m = Math.hypot(x, y, z);
    return { x: x / m, y: y / m, z: z / m };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
