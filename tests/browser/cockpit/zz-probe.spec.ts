/**
 * Working tool of the visual rounds (not part of the acceptance run: it does nothing without COCKPIT_PROBE):
 * shoots a list of cockpit-lab or integration-lab views into a directory outside the tree.
 *   COCKPIT_PROBE = path of a JSON file: [{ "name": "x", "url": "scene=leo&dbg=2" }, { "name": "y", "world": "world-moon-horizon" }, ...]
 *   COCKPIT_PROBE_OUT = directory for the PNGs
 * `world` names a view of world.ts (the integration lab); `url` is a cockpit-lab query.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openPage, test, waitIdle } from '../harness';
import { applyRecipe, settleWorld, WORLD_VIEWS, worldReport, type Recipe } from './world';

test.use({ viewport: { width: 1600, height: 900 } });

interface Probe {
  name: string;
  url?: string;
  world?: string;
  /** Overrides of the world view's query / recipe. */
  query?: string;
  recipe?: Partial<Recipe>;
  frames?: number;
}

const file = process.env.COCKPIT_PROBE;
const probes: Probe[] = file ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Probe[]) : [];
const out = process.env.COCKPIT_PROBE_OUT ?? '';

for (const p of probes) {
  test(`probe ${p.name}`, async ({ page }) => {
    test.setTimeout(600_000);
    fs.mkdirSync(out, { recursive: true });
    if (p.world) {
      const v = WORLD_VIEWS.find((x) => x.name === p.world)!;
      await openPage(page, `/labs/integration/?${p.query ?? v.query}&hud=0&paused=1`, { timeoutMs: 240_000 });
      await page.evaluate(() => window.__test!.waitFrames(5));
      // (A null in the override removes that key of the view's recipe.)
      const merged = Object.fromEntries(Object.entries({ ...v.recipe, ...(p.recipe ?? {}) }).filter(([, x]) => x !== null)) as unknown as Recipe;
      const placed = await applyRecipe(page, merged);
      await settleWorld(page);
      console.log(`  ${p.name}: ${JSON.stringify(placed)} ${JSON.stringify(await worldReport(page))}`);
    } else {
      await openPage(page, `/labs/cockpit/?${p.url}`, { timeoutMs: 120_000 });
      await waitIdle(page, 8);
      await page.evaluate(() => window.__test!.setDeterministic(true));
      await page.waitForFunction(
        async () => {
          await window.__test!.waitFrames(30);
          const e = window.__cockpit!.debug().exposure;
          return Math.abs(e.ev100 - e.targetEv100) < 0.05;
        },
        undefined,
        { timeout: 120_000, polling: 100 },
      );
      await page.evaluate((n) => window.__test!.waitFrames(n), p.frames ?? 60);
      const errors = await page.evaluate(() => window.__test!.errors);
      const e = await page.evaluate(() => window.__cockpit!.debug().exposure);
      console.log(`  ${p.name}: ev100 ${e.ev100.toFixed(2)} errors ${JSON.stringify(errors)}`);
    }
    await page.screenshot({ path: path.join(out, `${p.name}.png`) });
  });
}
