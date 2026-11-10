import type { Page } from '@playwright/test';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, saveScreenshot, test } from '../harness';

/**
 * Real key presses and mouse input through the binding table, the flight controller and the HUD of the
 * flight-ui lab (FakeSim). Every loop is closed on state with waitForFunction; nothing sleeps.
 */

async function open(page: Page, query: string): Promise<void> {
  await openPage(page, `/labs/flight-ui/?${query}`);
  await assertDiscreteGpu(page);
  await page.evaluate(() => window.__test!.waitFrames(3));
}

const state = (page: Page) => page.evaluate(() => window.__test!.state()!);

test.describe('flight-ui controls', () => {
  test('W / S pitch with the documented signs (W = nose down = -1)', async ({ page, pageLog }) => {
    await open(page, 'scene=lowOrbit');
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.pitch === -1);
    await page.keyboard.up('KeyW');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.pitch === 0);
    await page.keyboard.down('KeyS');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.pitch === 1);
    await page.keyboard.up('KeyS');
    await page.keyboard.down('KeyD');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.yaw === 1);
    await page.keyboard.up('KeyD');
    await page.keyboard.down('KeyQ');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.roll === -1);
    await page.keyboard.up('KeyQ');
    await page.waitForFunction(() => {
      const c = window.__test!.state()!.appliedControls;
      return c.pitch === 0 && c.yaw === 0 && c.roll === 0;
    });
    await expectNoErrors(page, pageLog);
  });

  test('Left Shift ramps the throttle at 0.5 per second and F lowers it', async ({ page, pageLog }) => {
    await open(page, 'scene=lowOrbit');
    await page.keyboard.down('ShiftLeft');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.throttle >= 0.7, undefined, { timeout: 10_000 });
    await page.keyboard.up('ShiftLeft');
    const rise = await page.evaluate(() => window.__flightUi!.frames());
    await page.keyboard.down('KeyF');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.throttle <= 0.15, undefined, { timeout: 10_000 });
    await page.keyboard.up('KeyF');
    const fall = await page.evaluate(() => window.__flightUi!.frames());
    // Rate between two lever positions on the per-frame log (wall-clock timestamps of the frames).
    const rate = (log: { t: number; throttle: number }[], a: number, b: number): number => {
      const up = b > a;
      const i = log.findIndex((f) => (up ? f.throttle >= a : f.throttle <= a));
      const j = log.findIndex((f, k) => k > i && (up ? f.throttle >= b : f.throttle <= b));
      return (log[j]!.throttle - log[i]!.throttle) / ((log[j]!.t - log[i]!.t) / 1000);
    };
    const r1 = rate(rise, 0.1, 0.6);
    const r2 = rate(fall.slice(rise.length - 5), 0.6, 0.2);
    expect(r1).toBeGreaterThan(0.45);
    expect(r1).toBeLessThan(0.55);
    expect(r2).toBeLessThan(-0.45);
    expect(r2).toBeGreaterThan(-0.55);
    // Z = full, X = cut.
    await page.keyboard.press('KeyZ');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.throttle === 1);
    await page.keyboard.press('KeyX');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.throttle === 0);
    await expectNoErrors(page, pageLog);
  });

  test('holding F + W + T together leaves the page alive and responsive', async ({ page, pageLog }) => {
    await open(page, 'scene=lowOrbit');
    const before = await state(page);
    await page.keyboard.down('KeyF');
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyT');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.pitch === -1);
    await page.evaluate(() => window.__test!.waitFrames(20));
    const during = await state(page);
    expect(during.readouts.sasEnabled).toBe(!before.readouts.sasEnabled);
    expect(during.appliedControls.throttle).toBe(0);
    expect(during.tick).toBeGreaterThan(before.tick);
    expect(await page.evaluate(() => window.__flightUi!.heldCodes().sort())).toEqual(['KeyF', 'KeyT', 'KeyW']);
    await page.keyboard.up('KeyT');
    await page.keyboard.up('KeyW');
    await page.keyboard.up('KeyF');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.pitch === 0);
    // Still the same page: T toggled exactly once.
    expect((await state(page)).readouts.sasEnabled).toBe(!before.readouts.sasEnabled);
    expect(await page.evaluate(() => window.__test!.page.name)).toBe('flight-ui');
    await expectNoErrors(page, pageLog);
  });

  test('Space fires stages; T, R, G toggle SAS, RCS and gear', async ({ page, pageLog }) => {
    await open(page, 'scene=pad');
    expect((await state(page)).staging.nextStage).toBe(0);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.__test!.state()!.staging.nextStage === 1);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.__test!.state()!.staging.nextStage === 2);
    const s0 = await state(page);
    await page.keyboard.press('KeyT');
    await page.keyboard.press('KeyR');
    await page.keyboard.press('KeyG');
    await page.waitForFunction(
      (prev) => {
        const r = window.__test!.state()!.readouts;
        return r.sasEnabled !== prev.sas && r.rcsEnabled !== prev.rcs && r.legsDeployed !== prev.legs;
      },
      { sas: s0.readouts.sasEnabled, rcs: s0.readouts.rcsEnabled, legs: s0.readouts.legsDeployed },
    );
    await expectNoErrors(page, pageLog);
  });

  test('Digit2 selects prograde and the reticle converges onto the prograde marker', async ({ page, pageLog }) => {
    await open(page, 'scene=lowOrbit');
    // Yaw away from prograde first.
    await page.keyboard.down('KeyD');
    await page.waitForFunction(() => {
      const m = window.__flightUi!.marker('prograde')!;
      return Math.abs(m.px - 256) > 70;
    });
    await page.keyboard.up('KeyD');
    await page.keyboard.press('Digit2');
    await page.waitForFunction(() => window.__test!.state()!.readouts.sasMode === 'prograde');
    await page.waitForFunction(
      () => {
        const m = window.__flightUi!.marker('prograde')!;
        return m.visible && Math.abs(m.px - 256) < 2 && Math.abs(m.py - 256) < 2;
      },
      undefined,
      { timeout: 20_000 },
    );
    await saveScreenshot(page, 'flight-ui', 'prograde-hold');
    await expectNoErrors(page, pageLog);
  });

  test('Digit9 / Digit0 / Minus emit mfdCycle:0..2 exactly once per press', async ({ page, pageLog }) => {
    await open(page, 'scene=lowOrbit');
    await page.keyboard.press('Digit9');
    await page.keyboard.press('Digit0');
    await page.keyboard.press('Minus');
    await page.waitForFunction(() => window.__flightUi!.actions().includes('mfdCycle:2'));
    const actions = await page.evaluate(() => window.__flightUi!.actions());
    expect(actions.filter((a) => a === 'mfdCycle:0')).toHaveLength(1);
    expect(actions.filter((a) => a === 'mfdCycle:1')).toHaveLength(1);
    expect(actions.filter((a) => a === 'mfdCycle:2')).toHaveLength(1);
    await expectNoErrors(page, pageLog);
  });

  test('period / comma change warp and a refusal shows a notification', async ({ page, pageLog }) => {
    await open(page, 'scene=lowOrbit');
    await page.keyboard.press('Period');
    await page.waitForFunction(() => window.__test!.state()!.warp.index === 1);
    await page.keyboard.press('Period');
    await page.waitForFunction(() => window.__test!.state()!.warp.index === 2);
    await page.keyboard.press('Comma');
    await page.waitForFunction(() => window.__test!.state()!.warp.index === 1);
    await page.keyboard.press('Slash');
    await page.waitForFunction(() => window.__test!.state()!.warp.index === 0);

    // Under acceleration only physics warp is allowed: the fourth step up is refused.
    await open(page, 'scene=ascent');
    // One press per frame at most is guaranteed (InputFrame.pressed is a set): wait for each step.
    for (let i = 1; i <= 3; i++) {
      await page.keyboard.press('Period');
      await page.waitForFunction((n) => window.__test!.state()!.warp.index === n, i);
    }
    await page.keyboard.press('Period');
    await page.waitForFunction(() => window.__flightUi!.notifications().includes('Cannot warp faster here'));
    await expect(page.locator('.hud .toast').filter({ hasText: 'Cannot warp faster here' })).toBeVisible();
    expect((await state(page)).warp.index).toBe(3);
    await saveScreenshot(page, 'flight-ui', 'warp-refused');
    await expectNoErrors(page, pageLog);
  });

  test('clicking SAS buttons, system toggles and the next stage tile works', async ({ page, pageLog }) => {
    await open(page, 'scene=pad');
    await page.locator('.hud .modes button[title^="Hold Retrograde"]').click();
    await page.waitForFunction(() => window.__test!.state()!.readouts.sasMode === 'retrograde');
    // Maneuver hold is disabled without a node.
    await expect(page.locator('.hud .modes button[title^="Hold Maneuver"]')).toHaveAttribute('aria-disabled', 'true');
    await page.locator('.hud .toggles button', { hasText: 'RCS' }).click();
    await page.waitForFunction(() => window.__test!.state()!.readouts.rcsEnabled);
    await page.locator('.hud .tile.next').click();
    await page.waitForFunction(() => window.__test!.state()!.staging.nextStage === 1);
    await page.locator('.hud .tile.next').click();
    await page.waitForFunction(() => window.__test!.state()!.staging.nextStage === 2);
    // Clicking the speed readout toggles the navball mode.
    const mode = (await state(page)).navball.mode;
    await page.locator('.hud .speed').click();
    await page.waitForFunction((m) => window.__test!.state()!.navball.mode !== m, mode);
    await expectNoErrors(page, pageLog);
  });

  test('blur releases every held key', async ({ page, pageLog }) => {
    await open(page, 'scene=lowOrbit');
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.pitch === -1);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.pitch === 0 && window.__flightUi!.heldCodes().length === 0);
    const t0 = (await state(page)).appliedControls.throttle;
    await page.evaluate(() => window.__test!.waitFrames(10));
    expect((await state(page)).appliedControls.throttle).toBe(t0);
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.up('KeyW');
    await expectNoErrors(page, pageLog);
  });

  test('with captureKeyboard on, a real click leaves keyboardLocked a boolean without errors', async ({ page, pageLog }) => {
    await open(page, 'scene=lowOrbit&capture=1');
    expect(await page.evaluate(() => window.__flightUi!.keyboardLocked())).toBe(false);
    await page.mouse.click(640, 300);
    await page.evaluate(() => window.__test!.waitFrames(10));
    const locked = await page.evaluate(() => window.__flightUi!.keyboardLocked());
    expect(typeof locked).toBe('boolean');
    // The HUD shows the matching indicator, and keys still work either way.
    await expect(page.locator(locked ? '.hud .kbok' : '.hud .kbcap')).toBeVisible();
    await page.keyboard.down('KeyS');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.pitch === 1);
    await page.keyboard.up('KeyS');
    await expectNoErrors(page, pageLog);
  });

  test('PointerState edges and doubleClick are produced exactly once', async ({ page, pageLog }) => {
    await open(page, 'scene=lowOrbit');
    const e0 = await page.evaluate(() => window.__flightUi!.pointerEdges());
    await page.mouse.click(700, 300);
    await page.evaluate(() => window.__test!.waitFrames(4));
    const e1 = await page.evaluate(() => window.__flightUi!.pointerEdges());
    expect(e1.pressed - e0.pressed).toBe(1);
    expect(e1.released - e0.released).toBe(1);
    expect(e1.doubleClick - e0.doubleClick).toBe(0);
    await page.mouse.dblclick(700, 300);
    await page.evaluate(() => window.__test!.waitFrames(4));
    const e2 = await page.evaluate(() => window.__flightUi!.pointerEdges());
    expect(e2.pressed - e1.pressed).toBe(2);
    expect(e2.released - e1.released).toBe(2);
    expect(e2.doubleClick - e1.doubleClick).toBe(1);
    // A right-drag orbits the chase camera; the wheel zooms it.
    const cam0 = await page.evaluate(() => window.__test!.camera()!);
    await page.mouse.move(600, 300);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(760, 300, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    await page.mouse.wheel(0, -300);
    await page.evaluate(() => window.__test!.waitFrames(20));
    const cam1 = await page.evaluate(() => window.__test!.camera()!);
    const q0 = cam0.qViewToRoot;
    const q1 = cam1.qViewToRoot;
    const dot = Math.abs(q0.x * q1.x + q0.y * q1.y + q0.z * q1.z + q0.w * q1.w);
    expect(dot).toBeLessThan(0.999);
    await expectNoErrors(page, pageLog);
  });

  test('M and C switch views with a blend; an unknown-mode external rig flows through to the HUD', async ({ page, pageLog }) => {
    await open(page, 'scene=lowOrbit&extraRig=1');
    await page.keyboard.press('KeyC');
    await page.waitForFunction(() => window.__test!.camera()!.kind === 'interior');
    await expect(page.locator('.hud')).toHaveAttribute('data-kind', 'interior');
    await page.keyboard.press('KeyC');
    await page.waitForFunction(() => window.__test!.camera()!.mode === 'lab-orbit-cam');
    expect((await page.evaluate(() => window.__test!.camera()!)).kind).toBe('external');
    await expect(page.locator('.hud')).toHaveAttribute('data-kind', 'external');
    await expect(page.locator('.hud .ball canvas')).toBeVisible();
    await saveScreenshot(page, 'flight-ui', 'extra-rig');
    await page.keyboard.press('KeyM');
    await page.waitForFunction(() => window.__test!.camera()!.kind === 'map');
    await expect(page.locator('.hud')).toHaveAttribute('data-kind', 'map');
    await page.keyboard.press('KeyM');
    await page.waitForFunction(() => window.__test!.camera()!.mode === 'lab-orbit-cam');
    await page.keyboard.press('Backquote');
    await expect(page.locator('.hud .help')).toBeVisible();
    await page.keyboard.press('Backquote');
    await expect(page.locator('.hud .help')).toBeHidden();
    await page.keyboard.press('F2');
    await expect(page.locator('.hud')).toBeHidden();
    await page.keyboard.press('F2');
    await expect(page.locator('.hud')).toBeVisible();
    await expectNoErrors(page, pageLog);
  });

  test('the landing-target panel shows the lunar scenes numbers and matches the MFD landing page', async ({ page, pageLog }) => {
    for (const query of ['scene=lunarOrbit', 'scene=lunarSurface', 'scene=lunarOrbit&predicted=impact', 'scene=reentry&predicted=entry']) {
      await open(page, query);
      await page.evaluate(() => window.__test!.setPaused(true));
      await page.evaluate(() => window.__test!.waitFrames(2));
      const dom = await page.locator('.hud .lt .rows .row').evaluateAll((rows) => rows.map((r) => [r.querySelector('.lbl')!.textContent!, r.querySelector('.val')!.textContent!]));
      const mfd = await page.evaluate(() => window.__flightUi!.mfdSection('landing')!);
      expect(dom).toEqual(mfd.rows.map((r) => [r.label, r.value]));
      const name = await page.locator('.hud .lt .pname').textContent();
      expect(mfd.heading).toContain(name!);
      const s = await state(page);
      const lt = s.readouts.landingTarget!;
      // The numbers are the readout's: distance in km to the shown precision, bearing to the degree.
      const km = Number(dom[0]![1]!.replace(/[ \s]/g, '').replace('km', ''));
      if (dom[0]![1]!.endsWith('km')) expect(Math.abs(km * 1000 - lt.distance)).toBeLessThan(100);
      expect(dom[1]![1]).toBe(`${String(Math.round(((lt.bearingDeg % 360) + 360) % 360) % 360).padStart(3, '0')}°`);
      if (query.includes('impact')) expect(dom[4]![0]).toBe('Impact miss');
      if (query.includes('entry')) expect(dom[4]![0]).toBe('Entry point miss');
      if (query === 'scene=lunarOrbit') expect(await page.locator('.hud .lt .pname').textContent()).toBe('Tranquility Base');
      await expectNoErrors(page, pageLog);
    }
  });

  test('pointer captured by the map: Shift drags never move the throttle', async ({ page, pageLog }) => {
    await open(page, 'scene=lowOrbit');
    await page.evaluate(() => window.__flightUi!.setPointerCaptured(true));
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => window.__test!.state()!.appliedControls.pitch === -1);
    await page.evaluate(() => window.__test!.waitFrames(30));
    expect((await state(page)).appliedControls.throttle).toBe(0);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');
    await page.evaluate(() => window.__flightUi!.setPointerCaptured(false));
    await expectNoErrors(page, pageLog);
  });
});

test.describe('flight-ui navball rendering', () => {
  test('known attitudes render as expected on the GPU texture', async ({ page, pageLog }) => {
    await open(page, 'scene=lowOrbit');
    const centre = 256;
    const R = 0.93 * 256;
    // Heading 090, wings level: sky above, ground below, a horizontal horizon through the centre.
    const level = await page.evaluate(
      ([c, r]) => window.__flightUi!.navballProbe({ pitchDeg: 0, headingDeg: 90, rollDeg: 0 }, [[c + r * 0.17, c - r * 0.45], [c + r * 0.17, c + r * 0.45], [6, 6]], [c - r * 0.6, c + r * 0.6]),
      [centre, R],
    );
    const [sky, ground, outside] = level.pixels;
    expect(sky![2]!).toBeGreaterThan(sky![0]! + 40);
    expect(ground![0]!).toBeGreaterThan(ground![2]! + 40);
    expect(outside![3]).toBe(0);
    expect(Math.abs(level.horizonRows[0]! - level.horizonRows[1]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(level.horizonRows[0]! - centre)).toBeLessThanOrEqual(2);
    // Roll right 30 deg: the right end of the horizon rises (smaller y), by tan(30) of the half-span.
    const rolled = await page.evaluate(([c, r]) => window.__flightUi!.navballProbe({ pitchDeg: 0, headingDeg: 90, rollDeg: 30 }, [], [c - r * 0.5, c + r * 0.5]), [centre, R]);
    const rise = rolled.horizonRows[0]! - rolled.horizonRows[1]!;
    expect(rise).toBeGreaterThan(R * Math.tan((30 * Math.PI) / 180) - 4);
    expect(rise).toBeLessThan(R * Math.tan((30 * Math.PI) / 180) + 4);
    // Nose at the zenith: sky all around the reticle (pitch 90 at its centre); samples between the meridians.
    const up = await page.evaluate(
      ([c, r]) => window.__flightUi!.navballProbe({ pitchDeg: 90, headingDeg: 0, rollDeg: 0 }, [0, 1, 2, 3].map((k) => [c + r * 0.3 * Math.cos(((15 + 90 * k) * Math.PI) / 180), c + r * 0.3 * Math.sin(((15 + 90 * k) * Math.PI) / 180)] as [number, number]), []),
      [centre, R],
    );
    for (const p of up.pixels) expect(p[2]!).toBeGreaterThan(p[0]! + 30);
    await expectNoErrors(page, pageLog);
  });
});
