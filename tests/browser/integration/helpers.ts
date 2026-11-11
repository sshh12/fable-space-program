/**
 * Helpers of the cross-feature specs (labs/integration). A check runs as soon as the packages it needs are
 * loaded in the lab and is skipped, with the reason, while one of them is not in the tree yet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, TestType } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, openPage, saveScreenshot, waitIdle } from '../harness';

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
  simKind: 'fake' | 'real';
  featureIds: string[];
}

/** Open the integration lab and report what it loaded. */
export async function openIntegration(page: Page, query: string, opts: { timeoutMs?: number } = {}): Promise<LabInfo> {
  await openPage(page, `/labs/integration/?${query}`, { timeoutMs: opts.timeoutMs ?? 120_000 });
  await assertDiscreteGpu(page);
  return page.evaluate(() => {
    const lab = window.__integration!;
    return { available: lab.available, loaded: lab.loaded, problems: lab.problems, simKind: lab.simKind, featureIds: lab.app.renderer.featureOrder() };
  });
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
      sum += d;
      if (Math.max(d0, d1, d2) > 8) changed++;
      const k = Math.floor(y / B) * bw + Math.floor(x / B);
      blockSum[k] = blockSum[k]! + d;
      blockN[k] = blockN[k]! + 1;
    }
  }
  let blockMax = 0;
  for (let k = 0; k < blockSum.length; k++) if (blockN[k]! > 0) blockMax = Math.max(blockMax, blockSum[k]! / blockN[k]!);
  return { mean: sum / (w * h), blockMax, changed: changed / (w * h) };
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
