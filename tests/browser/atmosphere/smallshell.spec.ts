/**
 * A planet seen from another world: a disc of 30 to 130 px with its atmosphere and clouds (the brief's
 * "few-pixel shell, still correct"). One half-resolution texel spans hundreds of kilometres there, so the
 * feature marches the shell at full resolution in a tile (FINE_TILE_SIZE); this spec holds the result
 * against the bare backdrop of the same view:
 *
 *   silhouette   nothing is drawn outside the bare planet's disc and nothing is cut out of its daylight side
 *   rows         no alternating bright / dark pixel rows or columns across the disc: the component of period
 *                two lines does not stand out of the detail the picture has at three and four lines
 *
 * for the atmosphere alone and with clouds, at four disc sizes. Screenshots: small-shell-*.png.
 *
 * Self-check of the spec: `ATMO_FINE=0` runs it with the half-resolution march (lab query `fine=0`); it
 * must then fail (polygonal outline, striped rows), which is the defect it was written for.
 */
import type { Page } from '@playwright/test';
import { expect, expectNoErrors, test, waitIdle } from '../harness';
import { openLab, shot } from './lab';

const DISTANCE = 384_400_000;
const PHASE = 60;
const FOVS = [45, 30, 15, 10.5];
const DAY_EV = 14.6;
const HALF_RES = process.env.ATMO_FINE === '0';

interface Disc {
  size: number;
  /** Luminance, row by row, of the size x size square around the centre of the render target. */
  lum: number[];
  /** Radius of the planet's disc in px (from the frame's own geometry), and what was marched. */
  radius: number;
  fine: boolean;
  marched: number;
}

async function capture(page: Page, fovDeg: number, name: string | null): Promise<Disc> {
  await page.evaluate(
    ({ distance, phase, fov, ev }) => {
      const lab = window.__atmo!;
      lab.app.renderer.setExposureOverride(ev);
      lab.viewFromSpace(distance, phase, fov);
      window.__test!.setPaused(true);
      window.__test!.setDeterministic(true);
    },
    { distance: DISTANCE, phase: PHASE, fov: fovDeg, ev: DAY_EV },
  );
  await waitIdle(page, 24);
  if (name) await shot(page, name);
  return page.evaluate(async () => {
    const lab = window.__atmo!;
    const f = lab.app.renderer.frameContext!;
    const body = f.bodies.find((b) => b.id === lab.site.bodyId)!;
    const d = Math.hypot(body.centerRelCam.x, body.centerRelCam.y, body.centerRelCam.z);
    const rb = lab.app.defs.bodies[lab.site.bodyId]!.radius;
    const radius = (Math.tan(Math.asin(rb / d)) / Math.tan(f.camera.fovY / 2)) * (f.renderSize[1] / 2);
    const size = 2 * Math.ceil(radius * 1.35) + 2;
    const x = (f.renderSize[0] >> 1) - (size >> 1);
    const y = (f.renderSize[1] >> 1) - (size >> 1);
    const px = await lab.readLuminance({ x, y, width: size, height: size });
    const lum: number[] = [];
    for (let i = 0; i < size * size; i++) lum.push(0.2126 * px.data[i * 4]! + 0.7152 * px.data[i * 4 + 1]! + 0.0722 * px.data[i * 4 + 2]!);
    const sel = lab.feature.debug.selection();
    return { size, lum, radius, fine: sel.fine, marched: sel.bodies.length };
  });
}

/** Sums of the rows (or columns) of the square inscribed in the disc interior. */
function lineSums(d: Disc, rows: boolean): number[] {
  const c = Math.floor(d.size / 2);
  const sums: number[] = [];
  const half = Math.floor(d.radius * 0.62);
  for (let k = -half; k <= half; k++) {
    let s = 0;
    for (let j = -half; j <= half; j++) s += d.lum[(c + (rows ? k : j)) * d.size + c + (rows ? j : k)]!;
    sums.push(s);
  }
  return sums;
}

/**
 * Amplitude of the component of period `period` lines in a profile, relative to its local mean. Period 2
 * is what a march on a coarser lattice leaves behind (alternating bright and dark lines); periods 3 and 4
 * measure the detail the picture really has at that scale (an image spectrum falls towards the Nyquist
 * frequency, an artefact stands out of it).
 */
function lineAmplitude(sums: number[], period: number): number {
  const f = 1 / period;
  // Response of the local-mean detrending below at this frequency.
  const response = 1 - (1 + Math.cos(2 * Math.PI * f)) / 2;
  let re = 0;
  let im = 0;
  let n = 0;
  for (let i = 1; i < sums.length - 1; i++) {
    const local = (sums[i - 1]! + 2 * sums[i]! + sums[i + 1]!) / 4;
    if (local <= 0) continue;
    const v = sums[i]! / local - 1;
    re += v * Math.cos(2 * Math.PI * f * i);
    im += v * Math.sin(2 * Math.PI * f * i);
    n++;
  }
  return n > 0 ? (2 * Math.hypot(re, im)) / n / response : 0;
}

/** Median of the luminance inside 0.6 of the disc radius (the lit side dominates it at this phase). */
function interiorMedian(d: Disc): number {
  const c = d.size / 2;
  const v: number[] = [];
  for (let y = 0; y < d.size; y++) for (let x = 0; x < d.size; x++) if (Math.hypot(x + 0.5 - c, y + 0.5 - c) < 0.6 * d.radius) v.push(d.lum[y * d.size + x]!);
  v.sort((p, q) => p - q);
  return v[v.length >> 1]!;
}

test.describe('a planet a few dozen pixels across', () => {
  // One worker, in order: the last test compares what the first three rendered.
  test.describe.configure({ mode: 'serial' });
  const discs = new Map<string, Disc>();
  const cases: { key: string; query: string }[] = [
    { key: 'bare', query: 'atmosphere=0' },
    { key: 'air', query: 'clouds=0' },
    { key: 'clouds', query: '' },
  ];

  for (const c of cases) {
    test(`render: ${c.key}`, async ({ page, pageLog }) => {
      test.setTimeout(240_000);
      await openLab(page, [c.query, HALF_RES ? 'fine=0' : ''].filter(Boolean).join('&'));
      for (const fov of FOVS) {
        const d = await capture(page, fov, fov === 30 || fov === 10.5 ? `small-shell-${c.key}-fov${fov}` : null);
        discs.set(`${c.key}:${fov}`, d);
        if (c.key !== 'bare' && !HALF_RES) {
          expect(d.marched, `${c.key} fov ${fov}: the shell is marched`).toBe(1);
          expect(d.fine, `${c.key} fov ${fov}: at full resolution`).toBe(true);
        }
      }
      await expectNoErrors(page, pageLog);
    });
  }

  test('silhouette and row structure against the bare planet', () => {
    test.skip(discs.size < cases.length * FOVS.length, 'needs the three render tests of this file (run the file as a whole)');
    const failures: string[] = [];
    for (const fov of FOVS) {
      const bare = discs.get(`bare:${fov}`)!;
      const litBare = 0.1 * interiorMedian(bare);
      for (const key of ['air', 'clouds']) {
        const d = discs.get(`${key}:${fov}`)!;
        const c = d.size / 2;
        const lit = 0.1 * interiorMedian(d);
        // Silhouette. (1) Nothing is drawn outside the disc: the shell top stands 1.6 % of the radius above
        // the ground, and what glows up there is far below a tenth of the daylight. (2) Nothing is cut out
        // of it: a pixel that is in daylight on the bare planet is not dark with the atmosphere on.
        let outside = 0;
        let holes = 0;
        let litPixels = 0;
        for (let y = 0; y < d.size; y++) {
          for (let x = 0; x < d.size; x++) {
            const r = Math.hypot(x + 0.5 - c, y + 0.5 - c);
            const i = y * d.size + x;
            if (r > d.radius + 1.5 && d.lum[i]! > lit) outside++;
            if (r < d.radius - 1.5 && bare.lum[i]! > litBare) {
              litPixels++;
              if (d.lum[i]! < 0.25 * bare.lum[i]! && d.lum[i]! < lit) holes++;
            }
          }
        }
        const rows = lineSums(d, true);
        const cols = lineSums(d, false);
        const row2 = lineAmplitude(rows, 2);
        const col2 = lineAmplitude(cols, 2);
        const rowRef = Math.max(lineAmplitude(rows, 3), lineAmplitude(rows, 4));
        const colRef = Math.max(lineAmplitude(cols, 3), lineAmplitude(cols, 4));
        console.log(
          `[small shell] ${key}, disc ${(2 * d.radius).toFixed(0)} px (fov ${fov}): ${outside} lit pixels outside the disc, ${holes} holes in ${litPixels} daylight pixels; ` +
            `alternating rows ${(row2 * 100).toFixed(2)} % (detail at 3-4 px ${(rowRef * 100).toFixed(2)} %), columns ${(col2 * 100).toFixed(2)} % (${(colRef * 100).toFixed(2)} %)`,
        );
        if (litPixels < 100) failures.push(`${key} fov ${fov}: only ${litPixels} daylight pixels`);
        if (outside > 0) failures.push(`${key} fov ${fov}: ${outside} lit pixels outside the disc`);
        if (holes > 0) failures.push(`${key} fov ${fov}: ${holes} holes in the daylight side`);
        // The air has no detail of its own: its period-two component must not stand out of what the ground
        // under it has at three and four lines. The clouds do (the coverage map has cells of a pixel's size
        // at this distance, and which of them falls on which line changes with the cloud clock): for them the
        // comparison is a coarse one, and the silhouette checks above are what holds the clouds to the disc.
        const allowed = (ref: number): number => (key === 'air' ? 0.01 + 1.5 * ref : 0.05 + 3 * ref);
        if (row2 > allowed(rowRef)) failures.push(`${key} fov ${fov}: alternating rows ${(row2 * 100).toFixed(2)} % against ${(rowRef * 100).toFixed(2)} % of detail`);
        if (col2 > allowed(colRef)) failures.push(`${key} fov ${fov}: alternating columns ${(col2 * 100).toFixed(2)} % against ${(colRef * 100).toFixed(2)} % of detail`);
      }
    }
    expect(failures).toEqual([]);
  });
});
