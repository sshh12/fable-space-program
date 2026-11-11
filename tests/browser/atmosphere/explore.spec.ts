/**
 * Tuning tool, not a test: renders a list of lab scenes described in a JSON file and prints luminance
 * probes, so that atmosphere and cloud tunables can be judged on screenshots quickly.
 *
 *   ATMO_EXPLORE=path/to/scenes.json npx playwright test tests/browser/atmosphere/explore.spec.ts --project=functional
 *
 * scenes.json: [{ "name": "pad", "query": "clouds=0", "view": { "latDeg", "lonDeg", "alt", "headingDeg", "pitchDeg", "fovDeg" },
 *                 "sun": { "azDeg", "elDeg" }, "space": { "distance", "phaseDeg", "fovDeg" }, "ev": 14, "frames": 24,
 *                 "animate": false, "size": [1280, 720], "probes": [[0.5, 0.1]], "eval": "js returning a value" }]
 * Screenshots go to out/screens/atmosphere/explore/<name>.png. Skipped unless ATMO_EXPLORE is set.
 */
import fs from 'node:fs';
import { expectNoErrors, saveScreenshot, test, waitIdle } from '../harness';
import { luminance, openLab, PAD, type LabView } from './lab';

interface Scene {
  name: string;
  query?: string;
  view?: Partial<LabView>;
  sun?: { azDeg: number; elDeg: number; at?: { latDeg: number; lonDeg: number } };
  space?: { distance: number; phaseDeg: number; fovDeg?: number };
  ev?: number;
  frames?: number;
  animate?: boolean;
  size?: [number, number];
  probes?: [number, number][];
  eval?: string;
}

const file = process.env.ATMO_EXPLORE;

test('explore scenes', async ({ page, pageLog }) => {
  test.skip(!file, 'set ATMO_EXPLORE to a scenes file');
  test.setTimeout(30 * 60_000);
  const scenes = JSON.parse(fs.readFileSync(file!, 'utf8')) as Scene[];
  let opened: string | null = null;
  for (const s of scenes) {
    const q = s.query ?? '';
    if (s.size) await page.setViewportSize({ width: s.size[0], height: s.size[1] });
    if (opened !== q) {
      await openLab(page, q);
      opened = q;
    }
    await page.evaluate(
      ({ s: sc, pad }) => {
        const lab = window.__atmo!;
        const r = lab.app.renderer;
        r.setExposureOverride(sc.ev ?? null);
        if (sc.space) {
          lab.viewFromSpace(sc.space.distance, sc.space.phaseDeg, sc.space.fovDeg);
          if (sc.sun) lab.setSun(sc.sun.azDeg, sc.sun.elDeg, sc.sun.at);
        } else {
          const v = { ...pad, alt: 2, headingDeg: 40, pitchDeg: 8, ...sc.view };
          const sun = sc.sun ?? { azDeg: 135, elDeg: 55 };
          lab.setSun(sun.azDeg, sun.elDeg, sun.at ?? { latDeg: v.latDeg, lonDeg: v.lonDeg });
          lab.view(v);
        }
        window.__test!.setPaused(true);
        window.__test!.setDeterministic(!sc.animate);
      },
      { s, pad: PAD },
    );
    await waitIdle(page, s.frames ?? 24);
    const shot = await saveScreenshot(page, 'atmosphere/explore', s.name);
    const info = await page.evaluate(() => {
      const lab = window.__atmo!;
      const e = lab.app.renderer.exposureInfo();
      return { ev: e.ev100, selection: lab.feature.debug.selection(), passes: lab.app.renderer.passStats() };
    });
    const ms = Object.entries(info.passes)
      .filter(([n]) => n.startsWith('atmosphere.'))
      .map(([n, v]) => `${n.slice(11)} ${v.p50.toFixed(3)}`)
      .join(', ');
    console.log(`\n[${s.name}] EV100 ${info.ev.toFixed(2)}  marched ${info.selection.bodies.map((b) => `${b.bodyId} x${b.steps}`).join(', ') || 'none'}  clouds ${info.selection.cloudBodyId ?? 'none'}  mean luma ${shot.stats.meanLuma.toFixed(1)}`);
    console.log(`  passes (p50 ms): ${ms}`);
    for (const [fx, fy] of s.probes ?? []) {
      const c = await page.evaluate(
        async ({ fx: x, fy: y }) => {
          const lab = window.__atmo!;
          const [w, h] = lab.app.renderer.frameContext!.renderSize;
          return lab.probe(x * w, y * h, 2);
        },
        { fx, fy },
      );
      console.log(`  probe (${fx}, ${fy}): rgb ${c.map((v) => v.toPrecision(4)).join(', ')}  L ${luminance(c).toPrecision(4)} cd/m^2`);
    }
    if (s.eval) {
      const result = await page.evaluate(async (code) => {
        const fn = new Function('lab', `return (async () => { ${code} })();`) as (lab: unknown) => Promise<unknown>;
        return fn(window.__atmo);
      }, s.eval);
      console.log(`  eval: ${JSON.stringify(result)}`);
    }
  }
  await expectNoErrors(page, pageLog);
});
