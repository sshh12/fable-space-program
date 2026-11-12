/**
 * The cockpit in the GAME (src/app: the real simulation, every render feature, the player's cockpit camera
 * rig), not in a lab: what a player sees after pressing C. The cabin must read at the exposure the renderer
 * meters by itself, with the floods as the simulation leaves them (the player has toggled nothing), in the
 * sun, in shadow and at night. Screenshots: out/screens/cockpit/app-*.png.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/app.spec.ts --project=functional
 *
 * The seat view is turned with a mouse drag on the scene (the camera's own binding: 0.005 rad per pixel).
 */
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { assertDiscreteGpu, expect, openPage, saveScreenshot, test, waitIdle } from '../harness';

test.use({ viewport: { width: 1600, height: 900 } });

const BOOT_MS = 300_000;

interface AppView {
  name: string;
  scenario: string;
  /** Look from the seat: degrees to the right and up (mouse drags). */
  yaw?: number;
  pitch?: number;
  /** Toggle the lights command first (the player's "lights" action). */
  lights?: boolean;
  /** The cabin is in the dark apart from its own lamps (a darker picture is right). */
  night?: boolean;
  /** The view is of a window with the sunlit world in it: the cabin round it is keyed low, as in a photograph. */
  window?: boolean;
}

const VIEWS: AppView[] = [
  // Parking orbit, straight from the seat, nothing touched: the picture of the mission run (06-earth-orbit-cockpit).
  { name: 'app-leo-seat', scenario: 'qa-leo' },
  // Along the console to both sides: where its ends meet the hull (request cockpit-lead-1).
  // (Angles are drags from the rig's rest view, which is pitched 20 degrees up since request cockpit-18.)
  { name: 'app-leo-console-left', scenario: 'qa-leo', yaw: -30, pitch: -22 },
  { name: 'app-leo-console-right', scenario: 'qa-leo', yaw: 62, pitch: -16 },
  // The lights action on: the floods at full.
  { name: 'app-leo-seat-floods', scenario: 'qa-leo', lights: true },
  // On the Moon after touchdown (10-lunar-touchdown-cockpit).
  { name: 'app-lunar-surface-seat', scenario: 'qa-lunar-surface' },
  // Out of the window from the seat in orbit: in this scenario's attitude the Earth's limb stands in the
  // commander's side window (the forward windows look into space).
  { name: 'app-leo-window-left', scenario: 'qa-leo', yaw: -58, pitch: -32, window: true },
];

const lum = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function pictureStats(buf: Buffer): { median: number; p10: number; p90: number; black: number; clipped: number } {
  const png = PNG.sync.read(buf);
  const { width: W, height: H, data } = png;
  const l: number[] = [];
  let black = 0;
  let clipped = 0;
  for (let i = 0; i < W * H; i += 3) {
    const v = lum(data[4 * i]!, data[4 * i + 1]!, data[4 * i + 2]!);
    l.push(v);
    if (v < 4) black++;
    if (v > 250) clipped++;
  }
  l.sort((a, b) => a - b);
  const at = (p: number): number => l[Math.min(l.length - 1, Math.floor(p * l.length))]!;
  return { median: at(0.5), p10: at(0.1), p90: at(0.9), black: black / l.length, clipped: clipped / l.length };
}

async function settle(page: Page): Promise<void> {
  await waitIdle(page, 8, BOOT_MS);
  await page.waitForFunction(
    async () => {
      await window.__test!.waitFrames(30);
      const e = window.__app!.exposure();
      return !window.__app!.viewBlending() && Math.abs(e.ev100 - e.targetEv100) < 0.05;
    },
    undefined,
    { timeout: 180_000, polling: 100 },
  );
  await page.evaluate(() => window.__test!.waitFrames(40));
}

for (const v of VIEWS) {
  test(`app cockpit view ${v.name}`, async ({ page }) => {
    test.setTimeout(900_000);
    await openPage(page, `/?scenario=${v.scenario}&view=cockpit&capture=0&mute=1&hud=0`, { timeoutMs: BOOT_MS });
    await assertDiscreteGpu(page);
    await page.evaluate(() => window.__test!.setPaused!(true));
    if (v.lights) await page.evaluate(() => window.__test!.commands!.toggleLights());
    await page.evaluate(() => window.__test!.waitFrames(5));
    if (v.yaw || v.pitch) {
      // A drag on the scene: yaw right = pointer to the right, pitch up = pointer up.
      const dx = Math.round((((v.yaw ?? 0) * Math.PI) / 180) / 0.005);
      const dy = -Math.round((((v.pitch ?? 0) * Math.PI) / 180) / 0.005);
      await page.mouse.move(800, 450);
      await page.mouse.down();
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(800 + (dx * i) / steps, 450 + (dy * i) / steps);
        await page.evaluate(() => window.__test!.waitFrames(2));
      }
      await page.mouse.up();
    }
    await settle(page);
    const info = await page.evaluate(() => {
      const s = window.__test!.state()!;
      const vessel = s.vessels.find((x) => x.id === s.activeVesselId)!;
      return { exposure: window.__app!.exposure(), brief: window.__app!.brief(), lightsOn: s.readouts.lightsOn, parts: vessel.parts.map((p) => p.def), errors: window.__test!.errors };
    });
    const shot = await saveScreenshot(page, 'cockpit', v.name);
    const st = pictureStats(shot.buffer);
    const e = info.exposure;
    console.log(
      `  ${v.name}: ev100 ${e.ev100.toFixed(2)} (prior ${e.evPrior.toFixed(2)}, histogram ${e.evHistogram.toFixed(2)} x ${e.histogramWeight.toFixed(2)}, lit ${e.litFraction.toFixed(3)}, outside ${e.outsideFraction.toFixed(3)} ev ${e.evOutside.toFixed(2)} x ${e.outsideWeight.toFixed(2)}, sun ${e.sunVisibility.toFixed(2)}); ` +
        `lights ${info.lightsOn}; camera ${info.brief.cameraKind}; picture median ${st.median.toFixed(1)} p10 ${st.p10.toFixed(1)} p90 ${st.p90.toFixed(1)} black ${(100 * st.black).toFixed(1)} % clipped ${(100 * st.clipped).toFixed(1)} %; parts ${info.parts.join(',')}`,
    );
    expect(info.brief.cameraKind).toBe('interior');
    expect(info.errors.filter((x) => /cockpit/i.test(x))).toEqual([]);
    // The cabin reads: a player who has touched nothing sees the panel, the blankets and the couches. A frame
    // from the seat is neither a black frame nor a burnt-out one.
    expect(st.median, `${v.name}: the frame's median (0..255)`).toBeGreaterThan(v.night || v.window ? 10 : 22);
    // (A window with black space in it is black where space is: such a view may hold more of it.)
    expect(st.black, `${v.name}: share of the frame below 4 / 255`).toBeLessThan(v.window ? 0.45 : 0.25);
    expect(st.clipped, `${v.name}: share of the frame above 250 / 255`).toBeLessThan(0.2);
  });
}
