/**
 * Helpers of the cross-feature specs (labs/integration). A check runs as soon as the packages it needs are
 * loaded in the lab and is skipped, with the reason, while one of them is not in the tree yet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, TestType } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, expect, openPage, saveScreenshot, waitIdle, type PageLog } from '../harness';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type FeaturePackage = 'terrain' | 'vehicle' | 'cockpit' | 'ocean' | 'sky' | 'atmosphere' | 'vfx';

/** Work-package id of each render package (its hand-off note and done marker carry this name). */
export const PACKAGE_OWNER: Record<FeaturePackage, string> = {
  terrain: 'terrain-render',
  vehicle: 'vehicle-pad',
  cockpit: 'cockpit',
  ocean: 'ocean',
  sky: 'sky-lighting',
  atmosphere: 'atmosphere-clouds',
  vfx: 'vfx',
};

export interface LabInfo {
  available: FeaturePackage[];
  loaded: FeaturePackage[];
  problems: string[];
  /** Features the lab switched off because they reported errors while starting up. */
  quarantined: { pkg: FeaturePackage; featureId: string; errors: string[] }[];
  simKind: 'fake' | 'real';
  featureIds: string[];
}

/** Open the integration lab and report what it loaded. */
export async function openIntegration(page: Page, query: string, opts: { timeoutMs?: number } = {}): Promise<LabInfo> {
  await openPage(page, `/labs/integration/?${query}`, { timeoutMs: opts.timeoutMs ?? 120_000 });
  await assertDiscreteGpu(page);
  return page.evaluate(() => {
    const lab = window.__integration!;
    return { available: lab.available, loaded: lab.loaded, problems: lab.problems, quarantined: lab.quarantined, simKind: lab.simKind, featureIds: lab.app.renderer.featureOrder() };
  });
}

/**
 * expectNoErrors for the integration lab: window.__test.errors must be empty, and the console may hold
 * nothing but the errors of features the lab switched off (those are reported through `info.problems`).
 */
export async function expectClean(page: Page, log: PageLog, info: LabInfo): Promise<void> {
  // The lab keeps attributing errors while it runs: read what it has switched off by now.
  await page.evaluate(() => window.__test!.waitFrames(2));
  const now = await page.evaluate(() => ({ quarantined: window.__integration!.quarantined, loaded: window.__integration!.loaded, problems: window.__integration!.problems }));
  info.quarantined = now.quarantined;
  info.problems = now.problems;
  // A delivered package must survive the check; one that is still being written may fall out (logged).
  const lost = info.loaded.filter((p) => !now.loaded.includes(p));
  for (const p of lost) console.log(`  ${p} (${PACKAGE_OWNER[p]}) was switched off during the check: ${now.problems.filter((x) => x.startsWith(`${p}:`)).pop() ?? ''}`);
  expect(lost.filter(delivered), 'delivered packages that were switched off during the check (their errors are in the lab problems)').toEqual([]);
  expect(await page.evaluate(() => window.__test!.errors), 'window.__test.errors').toEqual([]);
  // The console can only be held to "no errors, no warnings" while nothing is switched off: a broken feature
  // leaves warnings behind that name nothing (failed requests, invalid command buffers).
  if (info.quarantined.length > 0) return;
  const excused = info.quarantined.flatMap((q) => q.errors);
  // Chrome repeats a GPU validation error of a switched-off feature as console warnings of its own, which
  // name the feature's labelled objects ("terrain.shadow"), and browsers log failed requests of its assets.
  const names = [...new Set(info.quarantined.flatMap((q) => [q.featureId, q.pkg]))];
  const ofQuarantined = (m: string): boolean => names.some((n) => new RegExp(`(^|[^a-z0-9])${n}([^a-z0-9]|$)`, 'i').test(m));
  const ignored = [/favicon/i, /powerPreference option is currently ignored/];
  const real = log.messages.filter((m) => !ignored.some((re) => re.test(m)) && !excused.some((e) => m.includes(e.slice(0, 80))) && !ofQuarantined(m));
  expect(real, 'console errors and warnings of features that are switched on').toEqual([]);
}

/** Has the owner of a render package delivered (hand-off note or done marker present)? */
export function delivered(pkg: FeaturePackage): boolean {
  const id = PACKAGE_OWNER[pkg];
  return fs.existsSync(path.join(repoRoot, 'docs', 'handoff', `${id}.md`)) || fs.existsSync(path.join(repoRoot, 'out', 'wave2-done', `${id}.done`));
}

/**
 * Skip the running test unless every package in `needs` is loaded. The skip text names what is missing, so
 * the report shows which checks are waiting for which package.
 */
export function requireFeatures(test: TestType<object, object>, info: LabInfo, needs: readonly FeaturePackage[]): void {
  const missing = needs.filter((p) => !info.loaded.includes(p));
  test.skip(missing.length > 0, `waiting for ${missing.map((p) => `${p} (${PACKAGE_OWNER[p]}${info.available.includes(p) ? ': in the tree but not loaded' : ': not in the tree'})`).join(', ')}`);
}

/** Deterministic rendering with frozen noise and no sub-pixel jitter, for frame-to-frame comparisons. */
export async function freeze(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__test!.setDeterministic(true);
    window.__lab!.renderer.setJitter(false);
  });
}

/** Wait until streaming and compilation are idle and `frames` more frames were presented. */
export async function settle(page: Page, frames = 8, timeoutMs = 180_000): Promise<void> {
  await waitIdle(page, frames, timeoutMs);
}

export interface Shot {
  width: number;
  height: number;
  /** rgba, 8 bit. */
  data: Buffer;
}

export async function grab(page: Page): Promise<Shot> {
  const png = PNG.sync.read(await page.screenshot());
  return { width: png.width, height: png.height, data: png.data };
}

/** Screenshot into out/screens/integration/<name>.png (and its pixels). */
export async function save(page: Page, name: string): Promise<Shot> {
  const s = await saveScreenshot(page, 'integration', name);
  const png = PNG.sync.read(s.buffer);
  return { width: png.width, height: png.height, data: png.data };
}

export interface FrameDiff {
  /** Mean absolute difference per channel, 0..255. */
  mean: number;
  /** Largest mean absolute difference over 16 x 16 pixel blocks (a local pop shows here, not in the mean). */
  blockMax: number;
  /** Fraction of pixels whose largest channel difference exceeds 8. */
  changed: number;
  /**
   * The same comparison on the frames averaged over 16 x 16 pixel blocks: mean and largest difference of
   * the block means. Texture that merely decorrelates between two frames (waves, noise) averages out here;
   * a patch that appears, vanishes or changes its brightness does not.
   */
  coarseMean: number;
  coarseMax: number;
}

/** Difference between two frames of equal size. `rect` restricts it (x, y, width, height in pixels). */
export function frameDiff(a: Shot, b: Shot, rect?: { x: number; y: number; width: number; height: number }): FrameDiff {
  if (a.width !== b.width || a.height !== b.height) throw new Error('frameDiff: size mismatch');
  const x0 = rect?.x ?? 0;
  const y0 = rect?.y ?? 0;
  const w = rect?.width ?? a.width;
  const h = rect?.height ?? a.height;
  const B = 16;
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const blockSum = new Float64Array(bw * bh);
  const blockSigned = new Float64Array(bw * bh);
  const blockN = new Uint32Array(bw * bh);
  let sum = 0;
  let changed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((y0 + y) * a.width + x0 + x) * 4;
      const d0 = Math.abs(a.data[o]! - b.data[o]!);
      const d1 = Math.abs(a.data[o + 1]! - b.data[o + 1]!);
      const d2 = Math.abs(a.data[o + 2]! - b.data[o + 2]!);
      const d = (d0 + d1 + d2) / 3;
      const signed = (a.data[o]! - b.data[o]! + a.data[o + 1]! - b.data[o + 1]! + a.data[o + 2]! - b.data[o + 2]!) / 3;
      sum += d;
      if (Math.max(d0, d1, d2) > 8) changed++;
      const k = Math.floor(y / B) * bw + Math.floor(x / B);
      blockSum[k] = blockSum[k]! + d;
      blockSigned[k] = blockSigned[k]! + signed;
      blockN[k] = blockN[k]! + 1;
    }
  }
  let blockMax = 0;
  let coarseSum = 0;
  let coarseMax = 0;
  let blocks = 0;
  for (let k = 0; k < blockSum.length; k++) {
    if (blockN[k]! === 0) continue;
    blockMax = Math.max(blockMax, blockSum[k]! / blockN[k]!);
    const c = Math.abs(blockSigned[k]! / blockN[k]!);
    coarseSum += c;
    coarseMax = Math.max(coarseMax, c);
    blocks++;
  }
  return { mean: sum / (w * h), blockMax, changed: changed / (w * h), coarseMean: coarseSum / Math.max(1, blocks), coarseMax };
}

/**
 * Spikes of a difference series along a smooth camera path: element i is a spike when it exceeds `factor`
 * times the median of its neighbours (window of +-`half` elements, itself excluded) and the absolute
 * `floor`. A path without pops has none; a LOD pop, a ring passing through the view or a shadow jump is
 * one frame (or a few) far above its neighbours.
 */
export function spikes(series: readonly number[], factor: number, floor: number, half = 4): { index: number; value: number; neighbours: number }[] {
  const out: { index: number; value: number; neighbours: number }[] = [];
  for (let i = 0; i < series.length; i++) {
    const around: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(series.length - 1, i + half); j++) if (j !== i) around.push(series[j]!);
    around.sort((p, q) => p - q);
    const median = around[around.length >> 1] ?? 0;
    if (series[i]! > floor && series[i]! > factor * median) out.push({ index: i, value: series[i]!, neighbours: median });
  }
  return out;
}

/** Strength (0..1) of a period-k pattern in a series: how much of its variation repeats every k-th element. */
export function periodStrength(series: readonly number[], k: number): number {
  const n = series.length - (series.length % k);
  if (n < 2 * k) return 0;
  const mean = series.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let total = 0;
  for (let i = 0; i < n; i++) total += (series[i]! - mean) ** 2;
  if (total <= 0) return 0;
  // Variance explained by the phase means.
  let explained = 0;
  for (let p = 0; p < k; p++) {
    let s = 0;
    for (let i = p; i < n; i += k) s += series[i]!;
    const m = s / (n / k);
    explained += (n / k) * (m - mean) ** 2;
  }
  return explained / total;
}

/** Mean luminance (0..255) of a rectangle of a shot. */
export function meanLuma(s: Shot, rect: { x: number; y: number; width: number; height: number }): number {
  let sum = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const o = (y * s.width + x) * 4;
      sum += 0.2126 * s.data[o]! + 0.7152 * s.data[o + 1]! + 0.0722 * s.data[o + 2]!;
    }
  }
  return sum / (rect.width * rect.height);
}

/** Append a result block to out/core-support/integration-results.json (read back by the hand-off). */
export function record(check: string, result: unknown): void {
  const file = path.join(repoRoot, 'out', 'core-support', 'integration-results.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    all = {};
  }
  all[check] = { at: new Date().toISOString(), ...((typeof result === 'object' && result !== null ? result : { value: result }) as object) };
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

// ------------------------------------------------------------------------------------- the real cloud map

/** The baked cloud coverage map of the Earth tile set: equirectangular, row 0 = north, column 0 = longitude -180 deg. */
export interface CoverageMap {
  width: number;
  height: number;
  /** Coverage, 0..255. */
  coverage: Uint8Array;
  /** Cloud top, m. */
  top: Float32Array;
}

let coverageCache: CoverageMap | null | undefined;

/** Decode the coverage map the atmosphere feature loads (null when the tile set has none). */
export function coverageMap(): CoverageMap | null {
  if (coverageCache !== undefined) return coverageCache;
  coverageCache = null;
  const base = path.join(repoRoot, 'data', 'tiles', 'earth');
  const clouds = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'render', 'earth.clouds.json'), 'utf8')) as { coverageMap: string };
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8')) as { globals?: Record<string, { path: string; channels: string[] }> };
  const g = manifest.globals?.[clouds.coverageMap];
  if (!g) return null;
  const png = PNG.sync.read(fs.readFileSync(path.join(base, g.path)));
  const n = png.width * png.height;
  const coverage = new Uint8Array(n);
  const top = new Float32Array(n);
  // Two channels arrive as grey + alpha, colour sources carry them in r and g (as the feature reads them);
  // the second channel is the cloud top in units of 12750 m / 255.
  const second = g.channels.length === 2 ? 3 : 1;
  for (let i = 0; i < n; i++) {
    coverage[i] = png.data[i * 4]!;
    top[i] = png.data[i * 4 + second]! * 50;
  }
  coverageCache = { width: png.width, height: png.height, coverage, top };
  return coverageCache;
}

export interface SkyBox {
  latDeg: number;
  /** Longitude in the MAP (the map drifts over the body: see `mapToFixedLon`). */
  lonMapDeg: number;
  /** Smallest, largest and mean coverage (0..1) and mean cloud top (m) within `halfDeg` of the point. */
  min: number;
  max: number;
  mean: number;
  topM: number;
}

/** Coverage statistics of the map within `halfDeg` degrees of a point (map longitude). */
export function coverageBox(map: CoverageMap, latDeg: number, lonMapDeg: number, halfDeg: number): SkyBox {
  const px = map.width / 360;
  const cx = ((lonMapDeg + 180) / 360) * map.width;
  const cy = ((90 - latDeg) / 180) * map.height;
  const hy = Math.max(1, Math.round(halfDeg * px));
  const hx = Math.max(1, Math.round((halfDeg * px) / Math.max(0.2, Math.cos((latDeg * Math.PI) / 180))));
  let min = 255;
  let max = 0;
  let sum = 0;
  let top = 0;
  let count = 0;
  for (let y = Math.max(0, Math.round(cy - hy)); y <= Math.min(map.height - 1, Math.round(cy + hy)); y += 2) {
    for (let dx = -hx; dx <= hx; dx += 2) {
      const x = (((Math.round(cx) + dx) % map.width) + map.width) % map.width;
      const c = map.coverage[y * map.width + x]!;
      min = Math.min(min, c);
      max = Math.max(max, c);
      sum += c;
      top += map.top[y * map.width + x]!;
      count++;
    }
  }
  return { latDeg, lonMapDeg, min: min / 255, max: max / 255, mean: sum / count / 255, topM: top / count };
}

/**
 * Places of the real cloud map that are overcast (coverage >= 0.95 everywhere within `halfDeg`) or clear
 * (<= 0.02 everywhere), best first, on a 2 degree grid between the given latitudes.
 */
export function findSky(map: CoverageMap, kind: 'overcast' | 'clear', halfDeg: number, maxAbsLatDeg = 55): SkyBox[] {
  const out: SkyBox[] = [];
  for (let lat = -maxAbsLatDeg; lat <= maxAbsLatDeg; lat += 2) {
    for (let lon = -179; lon < 180; lon += 2) {
      const b = coverageBox(map, lat, lon, halfDeg);
      if (kind === 'overcast' ? b.min >= 0.95 : b.max <= 0.02) out.push(b);
    }
  }
  return out.sort((a, b) => (kind === 'overcast' ? b.min - a.min || b.mean - a.mean : a.max - b.max || a.mean - b.mean));
}

/**
 * Body-fixed longitude (deg) at which a map longitude lies when the cloud clock reads `cloudTime` seconds:
 * the map drifts east at `driftMps` (the feature samples it at the body longitude minus the drift angle).
 */
export function mapToFixedLon(lonMapDeg: number, cloudTime: number, driftMps: number, radius: number): number {
  const angle = ((((driftMps / radius) * cloudTime) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const lon = lonMapDeg + (angle * 180) / Math.PI;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export interface CloudClock {
  /** Cloud clock (s) and drift (m/s) the atmosphere feature uses now; null while the page has no cloud system. */
  time: number | null;
  drift: number | null;
}

/**
 * The cloud clock of the running page. The feature owns it (it need not be the simulation time), so a
 * place of the map is always located with the clock the feature reports, never with an assumed one.
 */
export async function cloudClock(page: Page): Promise<CloudClock> {
  const read = (): Promise<CloudClock> =>
    page.evaluate(() => {
      const atmosphere = window.__integration!.handles['atmosphere.createAtmosphereFeature'] as { debug: { clouds(): { time(): number; activeParams(): { coverageDriftMps: number } | null } | null } } | undefined;
      const clouds = atmosphere?.debug.clouds() ?? null;
      return { time: clouds?.time() ?? null, drift: clouds?.activeParams()?.coverageDriftMps ?? null };
    });
  let clock = await read();
  // The coverage map loads after the first frames.
  for (let i = 0; i < 20 && clock.drift === null && (await page.evaluate(() => window.__integration!.loaded.includes('atmosphere'))); i++) {
    await page.evaluate(() => window.__test!.waitFrames(10));
    clock = await read();
  }
  return clock;
}

/** The inverse of `mapToFixedLon`. */
export function fixedToMapLon(lonFixedDeg: number, cloudTime: number, driftMps: number, radius: number): number {
  return lonFixedDeg - (mapToFixedLon(0, cloudTime, driftMps, radius) - 0);
}

// ---------------------------------------------------------------------------------------- air between points

export interface AtmosphereDef {
  rayleighScattering: [number, number, number];
  rayleighScaleHeight: number;
  mieScattering: number;
  mieAbsorption: number;
  mieScaleHeight: number;
  ozoneAbsorption: [number, number, number];
  ozoneCenterAltitude: number;
  ozoneHalfWidth: number;
}

export const earthAtmosphere = (): AtmosphereDef => JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'defs', 'render', 'earth.atmosphere.json'), 'utf8')) as AtmosphereDef;

/**
 * Transmittance (r, g, b) of the air between two points given relative to the body centre (m), from the
 * definitions alone: Rayleigh and Mie extinction with their scale heights, ozone in its tent profile.
 */
export function airTransmittance(a: AtmosphereDef, radius: number, from: readonly [number, number, number], to: readonly [number, number, number]): [number, number, number] {
  const N = 512;
  const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const tau = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const h = Math.hypot(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t) - radius;
    const rayleigh = Math.exp(-h / a.rayleighScaleHeight);
    const mie = (a.mieScattering + a.mieAbsorption) * Math.exp(-h / a.mieScaleHeight);
    const ozone = Math.max(0, 1 - Math.abs(h - a.ozoneCenterAltitude) / a.ozoneHalfWidth);
    for (let c = 0; c < 3; c++) tau[c] = tau[c]! + (a.rayleighScattering[c]! * rayleigh + mie + a.ozoneAbsorption[c]! * ozone) * (len / N);
  }
  return [Math.exp(-tau[0]!), Math.exp(-tau[1]!), Math.exp(-tau[2]!)];
}

