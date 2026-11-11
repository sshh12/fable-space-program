/**
 * The cloud tunables are per-body data: the renderer must stay sound across the range that
 * resolveCloudParams accepts, not only at the shipped values. A uniform overcast map (coverage 1) seen
 * from 25 km is rendered with one tunable changed at a time and checked for
 *
 *   energy     no NaN, no negative, nothing above HDR_MAX in the target
 *   spikes     no pixel brighter than a white surface in full sunlight could be (the view looks away from
 *              the sun: nothing in it scatters forward), and none far brighter than everything around it
 *   coverage   the overcast stays overcast (mean cloud transmittance of the frame)
 *
 * Screenshots: tunables-<set>.png.
 */
import { expect, expectNoErrors, test } from '../harness';
import { openLab, PAD, setScene, settle, shot } from './lab';

const SETS: { name: string; cp: string }[] = [
  { name: 'shipped', cp: '' },
  { name: 'thin-low-layer', cp: 'lowThicknessM:600' },
  { name: 'thick-low-layer', cp: 'lowThicknessM:3200' },
  { name: 'thin-extinction', cp: 'lowExtinction:0.012;deepExtinction:0.01' },
  { name: 'dense-extinction', cp: 'lowExtinction:0.15' },
  { name: 'no-top-relief', cp: 'topReliefM:0' },
  { name: 'deep-top-relief', cp: 'topReliefM:2000' },
  { name: 'no-erosion-hard-edges', cp: 'detailErosion:0;lowEdgeSoftness:0.03' },
  { name: 'strong-erosion-soft-edges', cp: 'detailErosion:0.45;lowEdgeSoftness:0.6' },
  { name: 'coarse-steps', cp: 'stepFactor:0.05;stepMinM:200;stepMaxM:3000' },
  { name: 'strong-density-variation', cp: 'lowDensityVariation:3;lowThinDensity:0.02' },
];

for (const set of SETS) {
  test(`overcast from 25 km with ${set.name}`, async ({ page, pageLog }) => {
    test.setTimeout(120_000);
    await openLab(page, `cover=1,1.8&sky=0${set.cp ? `&cp=${set.cp}` : ''}`);
    await page.evaluate(() => window.__atmo!.app.renderer.setExposureOverride(14.6));
    await setScene(page, { ...PAD, alt: 25_000, headingDeg: 70, pitchDeg: -23.9, fovDeg: 30 }, { azDeg: 195, elDeg: 50 });
    await settle(page, 48);
    await shot(page, `tunables-${set.name}`);
    const r = await page.evaluate(async () => {
      const lab = window.__atmo!;
      const [w, h] = lab.app.renderer.frameContext!.renderSize;
      const px = await lab.readLuminance({ x: 0, y: 0, width: w, height: h });
      const lum = new Float32Array(w * h);
      const exposure = lab.app.renderer.exposureInfo().exposure;
      // Luminance of a perfectly white diffuse surface facing the sun, cd/m^2.
      const white = lab.app.renderer.frameContext!.sun.illuminance / Math.PI;
      let bad = 0;
      let max = 0;
      let tooBright = 0;
      for (let i = 0; i < w * h; i++) {
        const r0 = px.data[i * 4]!;
        const g0 = px.data[i * 4 + 1]!;
        const b0 = px.data[i * 4 + 2]!;
        if (!Number.isFinite(r0 + g0 + b0) || r0 < 0 || g0 < 0 || b0 < 0) bad++;
        lum[i] = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;
        max = Math.max(max, r0, g0, b0);
        if (lum[i]! > 1.5 * white) tooBright++;
      }
      // A spike: more than twice the brightest of its eight neighbours, and brighter than a lit cloud can be dim.
      let spikes = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const v = lum[y * w + x]!;
          if (v < 200) continue;
          let around = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx !== 0 || dy !== 0) around = Math.max(around, lum[(y + dy) * w + x + dx]!);
          if (v > 2 * around) spikes++;
        }
      }
      const buffers = await lab.feature.debug.clouds()!.readBuffers();
      let t = 0;
      for (let i = 0; i < buffers.width * buffers.height; i++) t += buffers.radiance[i * 4 + 3]!;
      return { bad, max, preExposedMax: max * exposure, white, tooBright, spikes, transmittance: t / (buffers.width * buffers.height), hdrMax: 60000 };
    });
    console.log(
      `[tunables] ${set.name}: mean cloud transmittance ${r.transmittance.toFixed(4)}, brightest pixel ${r.max.toFixed(0)} cd/m^2 (a white surface in the sun: ${r.white.toFixed(0)}), ` +
        `pixels above 1.5 x white ${r.tooBright}, isolated spikes ${r.spikes}, bad pixels ${r.bad}`,
    );
    expect(r.bad).toBe(0);
    expect(r.preExposedMax).toBeLessThanOrEqual(r.hdrMax * 1.001);
    expect(r.tooBright).toBe(0);
    expect(r.spikes).toBe(0);
    expect(r.transmittance).toBeLessThan(0.03);
    await expectNoErrors(page, pageLog);
  });
}
