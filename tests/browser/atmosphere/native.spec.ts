/**
 * The acceptance views at the resolution and in the mode the player sees: 2560 x 1440 internal, noise
 * animated, temporal accumulation running (the deterministic 1280 x 720 captures of screens.spec.ts are
 * the same scenes with the frame's noise frozen). Written as out/screens/atmosphere/native-<view>-1440p.png
 * by every run of the functional suite, so that the pictures a review judges are of the current state.
 *
 * The two modes share one cloud pipeline (the step phase of a cloud ray is a function of the march index
 * in both), so each view is also compared with its deterministic frame: the means agree.
 */
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';
import { PAD, type LabView } from './lab';

test.use({ viewport: { width: 2560, height: 1440 } });

interface Scene {
  name: string;
  query: string;
  view?: LabView;
  sun?: { azDeg: number; elDeg: number };
  space?: { distance: number; phaseDeg: number; fovDeg: number };
  ev: number | null;
}

const NOON = { azDeg: 160, elDeg: 55 };
const SCENES: Scene[] = [
  { name: 'ground-cumulus', query: 'cover=0.4,3', view: { ...PAD, alt: 30, headingDeg: 35, pitchDeg: 14, fovDeg: 70 }, sun: NOON, ev: 14.6 },
  { name: 'ground-cumulus-into-sun', query: 'cover=0.4,3', view: { ...PAD, alt: 30, headingDeg: 170, pitchDeg: 18, fovDeg: 70 }, sun: { azDeg: 160, elDeg: 40 }, ev: 14.6 },
  { name: 'ground-sunset', query: 'cover=0.4,3', view: { ...PAD, alt: 30, headingDeg: 270, pitchDeg: 12, fovDeg: 75 }, sun: { azDeg: 268, elDeg: 3 }, ev: null },
  { name: 'under-deck', query: 'cover=0.9,4', view: { ...PAD, alt: 300, headingDeg: 40, pitchDeg: 10, fovDeg: 70 }, sun: NOON, ev: null },
  { name: 'above-deck', query: 'cover=0.9,4', view: { ...PAD, alt: 6000, headingDeg: 40, pitchDeg: -8, fovDeg: 70 }, sun: { azDeg: 160, elDeg: 35 }, ev: 14.6 },
  { name: 'ascent-10km', query: '', view: { ...PAD, alt: 10000, headingDeg: 35, pitchDeg: 0, fovDeg: 60 }, sun: { azDeg: 160, elDeg: 50 }, ev: 14.6 },
  { name: 'ascent-25km', query: '', view: { ...PAD, alt: 25000, headingDeg: 35, pitchDeg: -2, fovDeg: 60 }, sun: { azDeg: 160, elDeg: 50 }, ev: 14.6 },
  { name: 'leo-day', query: '', view: { ...PAD, alt: 400000, headingDeg: 60, pitchDeg: -35, fovDeg: 60 }, sun: { azDeg: 160, elDeg: 50 }, ev: 14.6 },
  { name: 'leo-low-sun', query: '', view: { ...PAD, alt: 400000, headingDeg: 270, pitchDeg: -25, fovDeg: 60 }, sun: { azDeg: 270, elDeg: 4 }, ev: 13 },
  { name: 'earth-60000km', query: '', space: { distance: 66371000, phaseDeg: 30, fovDeg: 25 }, ev: 14.6 },
];

test('acceptance views at 2560 x 1440, animated', async ({ page, pageLog }) => {
  test.setTimeout(15 * 60_000);
  let opened: string | null = null;
  for (const s of SCENES) {
    if (opened !== s.query) {
      await openPage(page, `/labs/atmosphere/?hud=0&scale=1&governor=off${s.query ? `&${s.query}` : ''}`);
      await assertDiscreteGpu(page);
      opened = s.query;
      expect(await page.evaluate(() => window.__atmo!.app.renderer.frameContext!.renderSize)).toEqual([2560, 1440]);
    }
    const place = async (deterministic: boolean): Promise<number> => {
      await page.evaluate(
        ({ sc, det }) => {
          const lab = window.__atmo!;
          lab.app.renderer.setExposureOverride(sc.ev);
          if (sc.space) lab.viewFromSpace(sc.space.distance, sc.space.phaseDeg, sc.space.fovDeg);
          else {
            lab.setSun(sc.sun!.azDeg, sc.sun!.elDeg, { latDeg: sc.view!.latDeg, lonDeg: sc.view!.lonDeg });
            lab.view(sc.view!);
          }
          window.__test!.setPaused(true);
          window.__test!.setDeterministic(det);
          lab.resetTemporal();
        },
        { sc: s, det: deterministic },
      );
      await waitIdle(page, 96);
      return page.evaluate(async () => {
        const lab = window.__atmo!;
        const [w, h] = lab.app.renderer.frameContext!.renderSize;
        // (A band across the middle of the frame, after the temporal anti-aliasing.)
        const px = await lab.readLuminance({ x: 0, y: Math.floor(h * 0.3), width: w, height: Math.floor(h * 0.4) }, 'resolved');
        let sum = 0;
        for (let i = 0; i < px.data.length; i += 4) sum += 0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!;
        return sum / (px.data.length / 4);
      });
    };
    const frozen = await place(true);
    const animated = await place(false);
    await saveScreenshot(page, 'atmosphere', `native-${s.name}-1440p`);
    console.log(`[native] ${s.name}: mean luminance of the middle band ${animated.toFixed(1)} cd/m^2 animated, ${frozen.toFixed(1)} deterministic (${((animated / frozen - 1) * 100).toFixed(2)} %)`);
    expect(Math.abs(animated / frozen - 1), `${s.name}: animated against deterministic`).toBeLessThan(0.03);
  }
  await expectNoErrors(page, pageLog);
});
