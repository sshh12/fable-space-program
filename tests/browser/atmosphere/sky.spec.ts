import { expect, expectNoErrors, test } from '../harness';
import { luminance, openLab, PAD, probe, setScene, settle, shot } from './lab';

test.describe('clear sky from the pad', () => {
  test('noon: deep blue zenith, pale horizon, aerial perspective on the relief', async ({ page, pageLog }) => {
    await openLab(page, 'clouds=0');
    await setScene(page, { ...PAD, alt: 30, headingDeg: 35, pitchDeg: 12 }, { azDeg: 160, elDeg: 62 });
    await settle(page);
    const s = await shot(page, 'pad-noon');
    expect(s.stats.fractionNonBlack).toBeGreaterThan(0.9);
    // Blue sky: blue above red well above the horizon, and brighter towards the horizon.
    const high = await probe(page, 0.5, 0.08);
    const low = await probe(page, 0.2, 0.42);
    expect(high[2]).toBeGreaterThan(high[0] * 2);
    expect(luminance(low)).toBeGreaterThan(luminance(high));
    await expectNoErrors(page, pageLog);
  });
});
