import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, assertRealImage, expect, expectNoErrors, openPage, saveScreenshot, test, type PageLog } from '../harness';

/**
 * Screenshots of every FakeSim scene with the full flight HUD at 1280 x 720 and 3840 x 2160, plus the
 * cockpit and map views, the key-help overlay, the mission-failed banner and the six MFD pages, saved to
 * out/screens/flight-ui/ for review by eye. Also: the HUD over the backdrop's worst case (a near-white cloud
 * deck / regolith and a pale sky) with a measured label contrast and plate uniformity, the coverage budget of
 * the HUD in every external scene, the active stage's tile, views that show markers off the nose, a real roll,
 * the g tube in its amber and red zones with the g-dose bar and the lift-vector marker, and the MFD pages at
 * 512 x 384 shown 1 : 1.
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

/** Largest share of a 16:9 frame the HUD may cover in an external view (plates, tiles, chips and the ball). */
const COVERAGE_BUDGET = 0.2;

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
  const boxes = await page.locator('.hud .lcol .lbl, .hud .rcol .rn, .hud .lcol .ptitle > span:first-child, .hud .rcol .ptitle > span:first-child, .hud .lcol .ut, .hud .lcol .ltline, .hud .rcol .full, .hud .rcol .tile .meta').evaluateAll((els) =>
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

/**
 * Share of the frame the HUD covers, from the layout: every visible plate, tile, pill and read-out chip as its
 * box, and the navball instrument as the disc of its bezel, rasterised into one mask (overlaps count once).
 */
async function hudCoverage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const W = innerWidth;
    const H = innerHeight;
    const mask = new Uint8Array(W * H);
    const visible = (e: Element): boolean => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const boxes = [...document.querySelectorAll('.hud .panel, .hud .later, .hud .tile:not(.compact), .hud .pill, .hud .helpbtn, .hud .more, .hud .nbchips > div, .hud .toast')].filter(visible);
    for (const e of boxes) {
      const r = e.getBoundingClientRect();
      for (let y = Math.max(0, Math.floor(r.top)); y < Math.min(H, Math.ceil(r.bottom)); y++) mask.fill(1, y * W + Math.max(0, Math.floor(r.left)), y * W + Math.min(W, Math.ceil(r.right)));
    }
    const ball = document.querySelector('.hud .ball');
    if (ball && visible(ball)) {
      const r = ball.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const R = (r.width / 2) * 0.985;
      for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
        if (y < 0 || y >= H) continue;
        const half = Math.sqrt(Math.max(0, R * R - (y + 0.5 - cy) * (y + 0.5 - cy)));
        mask.fill(1, y * W + Math.max(0, Math.round(cx - half)), y * W + Math.min(W, Math.round(cx + half)));
      }
    }
    let n = 0;
    for (let i = 0; i < mask.length; i++) n += mask[i]!;
    return n / (W * H);
  });
}

/**
 * Fill of every visible plate along a column of its padding (no text there), below the plate's lit top
 * gradient: the spread in 8-bit levels of the brightest channel. A scene edge behind a plate shows up as spread.
 */
async function plateSpreads(page: Page, png: Buffer): Promise<{ cls: string; spread: number }[]> {
  const img = PNG.sync.read(png);
  const plates = await page.locator('.hud .lcol .panel, .hud .rcol .panel, .hud .later, .hud .tile.next, .hud .tile.active, .hud .bottom .panel').evaluateAll((els) =>
    els.filter((e) => e.getClientRects().length > 0).map((e) => ({ cls: e.className, r: e.getBoundingClientRect().toJSON() as DOMRect })),
  );
  return plates.map((p) => {
    const x = Math.round(p.r.left + 2);
    let lo = 255;
    let hi = 0;
    for (let y = Math.ceil(p.r.top + p.r.height * 0.45); y < Math.floor(p.r.bottom - 4); y++) {
      const i = (y * img.width + x) * 4;
      const v = Math.max(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return { cls: p.cls, spread: hi - lo };
  });
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
        if (tag === '720p') {
          const c = await hudCoverage(page);
          console.log(`HUD coverage ${scene}: ${(c * 100).toFixed(1)} %`);
          expect(c, `${scene}: HUD coverage`).toBeLessThanOrEqual(COVERAGE_BUDGET);
        }
      });
    }
    test('markers off the nose and a 25 degree roll (normal, radial, anti-target, maneuver)', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=lowOrbit&node=1&target=moon&attitude=24,-14,25', `attitude-lowOrbit-${tag}`);
    });
    test('high-g entry: g tube in its red zone, g-dose bar, lift-vector marker, retrograde off the nose', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=reentry&predicted=entry&flight=0,11.2&dose=6.4&lift=35&attitude=-8,10,-18', `entry-highg-${tag}`);
    });
    test('retrograde held on the nose under chutes', async ({ page, pageLog }) => {
      await shoot(page, pageLog, '/labs/flight-ui/?scene=chutes&flight=0,7.4', `retrograde-hold-${tag}`);
    });
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
    test(`scene ${scene}: every label keeps 4.5 : 1 against its panel, no scene edge prints through a plate, the HUD stays in its budget`, async ({ page, pageLog }) => {
      const png = await shoot(page, pageLog, `/labs/flight-ui/?scene=${scene}&backdrop=bright${extra ? `&${extra}` : ''}`, `bright-${scene}-720p`);
      const c = await labelContrasts(page, png);
      expect(c.length).toBeGreaterThanOrEqual(4);
      for (const x of c) expect(x.ratio, `label "${x.text}"`).toBeGreaterThanOrEqual(4.5);
      // A plate over the horizon (sunlit regolith or cloud deck against the sky) keeps one tone.
      const spreads = await plateSpreads(page, png);
      expect(spreads.length).toBeGreaterThan(3);
      for (const p of spreads) expect(p.spread, `plate "${p.cls}" fill spread (8-bit levels)`).toBeLessThanOrEqual(8);
      expect(await hudCoverage(page), `${scene}: HUD coverage`).toBeLessThanOrEqual(COVERAGE_BUDGET);
    });
  }
});

test.describe('flight-ui stage stack (720p)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  test('the burning stage has its own tile with live delta-v, TWR, burn time and propellant', async ({ page, pageLog }) => {
    for (const [scene, extra, number] of [
      ['ascent', 'flight=0.86,2.35', '1'],
      ['lunarOrbit', '', '5'],
    ] as const) {
      await openPage(page, `/labs/flight-ui/?scene=${scene}${extra ? `&${extra}` : ''}`);
      await page.evaluate(() => window.__test!.waitFrames(10));
      const s = await page.evaluate(() => window.__test!.state()!);
      const info = s.staging.stages[Number(number) - 1]!;
      expect(info.fired).toBe(true);
      expect(info.propellantFraction).not.toBeNull();
      const tile = page.locator('.hud .stages .tile.active');
      await expect(tile).toHaveCount(1);
      await expect(tile.locator('.sn')).toHaveText(number);
      await expect(tile.locator('.dv')).toHaveText(/^Δv [\d\s]+\sm\/s$/);
      const dv = Number((await tile.locator('.dv').textContent())!.replace(/[^\d]/g, ''));
      expect(Math.abs(dv - info.deltaVNow)).toBeLessThanOrEqual(1);
      await expect(tile.locator('.meta')).toHaveText(/^TWR [\d.]+\s+[\d:]+$/);
      await expect(tile.locator('.bar.prop')).toBeVisible();
      // The active tile sits under the next stage's tile, at the bottom of the stack.
      const a = (await tile.boundingBox())!;
      const n = (await page.locator('.hud .stages .tile.next').boundingBox())!;
      expect(a.y).toBeGreaterThan(n.y + n.height - 1);
      // The MFD staging strip shows the same stage.
      const rows = await page.evaluate(() => window.__flightUi!.mfdRows('staging'));
      expect(rows.find((r) => r.label === 'Active stage')!.value).toContain(info.label);
      expect(rows.find((r) => r.label === 'Stage Δv')!.value).not.toBe('—');
      await expectNoErrors(page, pageLog);
    }
  });
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
