import fs from 'node:fs';
import { assertDiscreteGpu, expectNoErrors, openPage, saveScreenshot, test } from '../harness';

/**
 * Ad-hoc screenshots of the effects in the GAME itself (src/app with the real sim, the real vehicle and pad),
 * flown by the in-page test pilot: what the player sees, as opposed to the vfx lab with its stand-ins.
 * Skipped unless VFX_APP_SHOTS names a JSON file with a list of runs:
 *
 *   [{ "url": "/?capture=0&pilot=1&hud=0", "steps": [
 *       { "wait": "b.milestones.includes('LIFTOFF') && b.met >= 2" },
 *       { "pause": true }, { "frames": 30 }, { "shot": "app-liftoff-t2" },
 *       { "orbit": [0.6, 0.05, 140] }, { "frames": 30 }, { "shot": "app-liftoff-t2-low" },
 *       { "pause": false } ] }]
 *
 *   VFX_APP_SHOTS=out/app-shots.json node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/vfx/appshots.spec.ts --project=functional
 *
 * Steps: "wait" = a predicate over `b` (window.__app.brief(): met, altitudeAsl, altitudeRadar, milestones,
 * throttle, ...) polled every 50 ms ("timeout" in s, default 300); "pause"; "orbit" = [yaw rad, pitch rad,
 * distance m] of the chase camera; "frames" = presented frames to wait; "shot" = picture into
 * out/screens/vfx/dev/<name>.png; "eval" = an expression whose JSON is printed; "key" = a key press.
 * A url that does not open the game (a lab) is driven by "eval" steps alone (no brief).
 */
interface Step {
  wait?: string;
  timeout?: number;
  pause?: boolean;
  orbit?: [number, number, number];
  frames?: number;
  shot?: string;
  eval?: string;
  key?: string;
  size?: [number, number];
}
interface Run {
  url: string;
  steps: Step[];
}

const file = process.env.VFX_APP_SHOTS;
const runs: Run[] = file && fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Run[]) : [];

test.describe('vfx ad-hoc shots of the game', () => {
  test.skip(runs.length === 0, 'set VFX_APP_SHOTS=<json file> to take pictures of the effects in the game');
  test.describe.configure({ timeout: 30 * 60_000 });
  runs.forEach((run, index) => {
    test(`run ${index}: ${run.url}`, async ({ page, pageLog }) => {
      await openPage(page, run.url, { timeoutMs: 240_000 });
      await assertDiscreteGpu(page);
      for (const step of run.steps) {
        if (step.size) await page.setViewportSize({ width: step.size[0], height: step.size[1] });
        if (step.wait !== undefined) {
          await page.waitForFunction(`(() => { const b = window.__app ? window.__app.brief() : null; return ${step.wait}; })()`, undefined, { polling: 50, timeout: (step.timeout ?? 300) * 1000 });
        }
        if (step.pause !== undefined) await page.evaluate((p) => window.__test!.setPaused(p), step.pause);
        if (step.orbit) await page.evaluate(([yaw, pitch, distance]) => window.__test!.setCameraOrbit(yaw!, pitch!, distance!), step.orbit);
        if (step.key) await page.keyboard.press(step.key);
        if (step.eval !== undefined) {
          const result: unknown = await page.evaluate(step.eval);
          if (result !== undefined && result !== null) console.log(`eval: ${typeof result === 'string' ? result : JSON.stringify(result)}`);
        }
        if (step.frames !== undefined) await page.evaluate((n) => window.__test!.waitFrames(n), step.frames);
        if (step.shot !== undefined) {
          await saveScreenshot(page, 'vfx/dev', step.shot);
          const brief: unknown = await page.evaluate(() => {
            const app = (window as unknown as { __app?: { brief(): unknown } }).__app;
            return app ? app.brief() : null;
          });
          if (brief) {
            const b = brief as { met: number; altitudeRadar: number; altitudeAsl: number; throttle: number; warpFactor: number };
            console.log(`shot ${step.shot}: MET ${b.met.toFixed(2)} s, radar ${b.altitudeRadar.toFixed(1)} m, asl ${b.altitudeAsl.toFixed(0)} m, throttle ${b.throttle.toFixed(2)}, warp ${b.warpFactor}x`);
          }
        }
      }
      await expectNoErrors(page, pageLog);
    });
  });
});
