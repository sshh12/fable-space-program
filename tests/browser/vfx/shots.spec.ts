import fs from 'node:fs';
import { assertDiscreteGpu, expectNoErrors, openPage, saveScreenshot, test, waitIdle } from '../harness';

/**
 * Ad-hoc screenshots of the vfx lab while tuning a look. Skipped unless VFX_SHOTS names a JSON file with a
 * list of shots:
 *
 *   [{ "name": "booster-sl", "url": "/labs/vfx/?scene=engine&engine=atlas-9m", "runTo": 2, "eval": "window.__vfx.scene.controls.throttle(0.5)", "settle": 40 }]
 *
 *   VFX_SHOTS=out/shots.json node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/vfx/shots.spec.ts --project=functional
 *
 * Images land in out/screens/vfx/dev/<name>.png. Width / height of the viewport: optional "size": [w, h].
 * "live": true takes the picture with the noise animated and the temporal filter running on it (what the game
 * shows) instead of the frozen, deterministic frame. A url that does not start with /labs/vfx/ is opened as
 * it is (another lab, e.g. /labs/integration/?scene=reentry&orbit=150,12,22): "runTo" does not apply there.
 */
interface Shot {
  name: string;
  url: string;
  runTo?: number;
  eval?: string;
  settle?: number;
  size?: [number, number];
  live?: boolean;
}

const file = process.env.VFX_SHOTS;
const shots: Shot[] = file && fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Shot[]) : [];

test.describe('vfx lab ad-hoc shots', () => {
  test.skip(shots.length === 0, 'set VFX_SHOTS=<json file> to take ad-hoc screenshots');
  test.describe.configure({ timeout: 600_000 });
  for (const shot of shots) {
    test(`shot ${shot.name}`, async ({ page, pageLog }) => {
      if (shot.size) await page.setViewportSize({ width: shot.size[0], height: shot.size[1] });
      // The vfx lab is opened stopped and stepped to the moment of the picture; another lab runs as its url says.
      const own = shot.url.startsWith('/labs/vfx/');
      await openPage(page, own ? `${shot.url}${shot.url.includes('?') ? '&' : '?'}paused=1&hud=0` : shot.url);
      await assertDiscreteGpu(page);
      if (own) await page.evaluate(() => window.__test!.setDeterministic(true));
      if (shot.runTo !== undefined && shot.url.startsWith('/labs/vfx/')) await page.evaluate((t) => window.__vfx!.runTo(t), shot.runTo);
      if (shot.eval) await page.evaluate(shot.eval);
      if (shot.live || !own) {
        if (own) await page.evaluate(() => window.__test!.setDeterministic(false));
        await page.evaluate((n) => window.__test!.waitFrames(n), shot.settle ?? 90);
      } else await waitIdle(page, shot.settle ?? 40);
      await saveScreenshot(page, 'vfx/dev', shot.name);
      await expectNoErrors(page, pageLog);
    });
  }
});
