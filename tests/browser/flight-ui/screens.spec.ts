import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test, type PageLog } from '../harness';

/**
 * Screenshots of every FakeSim scene with the full flight HUD at 1280 x 720 and 3840 x 2160, plus the
 * cockpit and map views, the key-help overlay, the mission-failed banner and the six MFD pages, saved to
 * out/screens/flight-ui/ for review by eye. Also: the HUD over the backdrop's worst case (a near-white cloud
 * deck / regolith and a pale sky) with a measured label contrast, and the MFD pages at 512 x 384 shown 1 : 1.
 */
const SCENES: [string, string][] = [
  ['pad', 'target=moon'],
  // A powered ascent: throttle and g load in the readouts (lab decoration; the FakeSim coasts).
  ['ascent', 'flight=0.86,2.35'],
  ['lowOrbit', 'node=1'],
  ['translunar', ''],
  ['lunarOrbit', 'predicted=impact'],
  ['lunarSurface', ''],
  ['reentry', 'predicted=entry'],
  ['chutes', ''],
];

async function shoot(page: Page, log: PageLog, url: string, name: string, frames = 30): Promise<Buffer> {
  await openPage(page, url);
  await assertDiscreteGpu(page);
  await page.evaluate((n) => window.__test!.waitFrames(n), frames);
  const shot = await saveScreenshot(page, 'flight-ui', name);
  assertRealImage(shot.stats, name, { minNonBlack: 0.05, minStd: 8, minBuckets: 40 });
  await expectNoErrors(page, log);
  return shot.buffer;
}

const lin = (c: number): number => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const luminance = (r: number, g: number, b: number): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/**
 * WCAG contrast of every visible row label against its panel, measured on the screenshot: the text is the
 * brightest pixel inside the label's box (glyph cores), the plate the median pixel (most of the box).
 */
async function labelContrasts(page: Page, png: Buffer): Promise<{ text: string; ratio: number }[]> {
  const img = PNG.sync.read(png);
  const boxes = await page.locator('.hud .lcol .lbl, .hud .rcol .rn, .hud .lcol .ptitle > span:first-child').evaluateAll((els) =>
    els.filter((e) => e.getClientRects().length > 0 && (e.textContent ?? '').trim().length > 0).map((e) => ({ text: e.textContent!.trim(), r: e.getBoundingClientRect().toJSON() as DOMRect })),
  );
  const out: { text: string; ratio: number }[] = [];
  for (const b of boxes) {
    const lum: number[] = [];
    for (let y = Math.ceil(b.r.top); y < Math.floor(b.r.bottom); y++) {
      for (let x = Math.ceil(b.r.left); x < Math.floor(b.r.right); x++) {
        const i = (y * img.width + x) * 4;
        lum.push(luminance(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!));
      }
    }
    if (lum.length < 20) continue;
    lum.sort((a, c) => a - c);
    const bg = lum[Math.floor(lum.length / 2)]!;
    const fg = lum[lum.length - 1]!;
    out.push({ text: b.text, ratio: (fg + 0.05) / (bg + 0.05) });
  }
  return out;
}

for (const [w, h, tag] of [
  [1280, 720, '720p'],
  [3840, 2160, '4k'],
] as const) {
  test.describe(`flight-ui screenshots ${tag}`, () => {
    test.use({ viewport: { width: w, height: h } });
    for (const [scene, extra] of SCENES) {
      test(`scene ${scene}`, async ({ page, pageLog }) => {
        await shoot(page, pageLog, `/labs/flight-ui/?scene=${scene}${extra ? `&${extra}` : ''}`, `${scene}-${tag}`);
        expect(await page.evaluate(() => window.__test!.page.name)).toBe('flight-ui');
      });
    }
    test('cockpit view', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lowOrbit&view=cockpit', `cockpit-lowOrbit-${tag}`);
    });
    test('map view', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lowOrbit&view=map&node=1', `map-lowOrbit-${tag}`);
    });
    test('key help overlay', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=pad&help=1', `keyhelp-${tag}`);
    });
    test('mission failed banner', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=reentry&failed=1', `failed-${tag}`);
    });
    test('terrain loading notice', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lunarSurface&terrainPending=1', `terrain-pending-${tag}`);
    });
    test('MFD pages', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lunarOrbit&mfd=1&predicted=impact&node=1', `mfd-pages-${tag}`, 10);
    });
    test('MFD pages, landed 400 m from the target (no ground track: north-up scope)', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lunarSurface&mfd=1&targetOffset=400,30', `mfd-pages-hover-${tag}`, 10);
    });
  });
}

test.describe('flight-ui over a near-white backdrop (720p)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  for (const [scene, extra] of [
    ['pad', 'target=moon'],
    ['ascent', 'flight=0.86,2.35'],
    ['reentry', 'predicted=entry'],
    ['lunarSurface', ''],
  ] as const) {
    test(`scene ${scene}: every label keeps 4.5 : 1 against its panel`, async ({ page, pageLog }) => {
      const png = await shoot(page, pageLog, `/labs/flight-ui/?scene=${scene}&backdrop=bright${extra ? `&${extra}` : ''}`, `bright-${scene}-720p`);
      const c = await labelContrasts(page, png);
      expect(c.length).toBeGreaterThan(5);
      for (const x of c) expect(x.ratio, `label "${x.text}"`).toBeGreaterThanOrEqual(4.5);
    });
  }
});

test.describe('flight-ui MFD pages at 512 x 384, 1 : 1', () => {
  test.use({ viewport: { width: 1600, height: 840 } });
  test('lunar orbit with a node and a predicted impact', async ({ page, pageLog }) => {
    await shoot(page, pageLog, '/labs/flight-ui/?scene=lunarOrbit&mfd=native&predicted=impact&node=1', 'mfd-pages-native', 10);
  });
  test('reentry', async ({ page, pageLog }) => {
    await shoot(page, pageLog, '/labs/flight-ui/?scene=reentry&mfd=native&predicted=entry', 'mfd-pages-native-reentry', 10);
  });
});
