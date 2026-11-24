/**
 * The page server of a browser run is FROZEN AT THE START OF THE RUN (tests/browser/globalSetup.ts): other
 * agents save files in the same working tree while a run is under way, and a run must not see a tree that
 * is half one state and half another.
 *
 * This spec saves a source file DURING the run and shows that the run does not see it: the module is served
 * as it was at the start, to a request and to a page that imports it. The file is `labs/harness/probe.ts`,
 * which exists for this and which nothing else imports; it is written back in every outcome. The definition
 * files are held the same way (tools/server/dataPlugin.test.ts shows it without touching the library).
 *
 * At the end of the run the harness prints the files that changed under it; this spec's own save is in that
 * list, which is how the warning is seen to work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appUrl, expect, test } from '../harness';

const probeFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'labs', 'harness', 'probe.ts');

test.describe('the page server is frozen at the start of the run', () => {
  test.skip(process.env.FSP_HARNESS_FROZEN !== '1', 'only the server that globalSetup starts is frozen (not a stack page, not E2E_BASE_URL)');

  test('a module saved during the run is served as it was when the run started', async ({ page, request }) => {
    const moduleUrl = appUrl('/labs/harness/probe.ts');
    const original = fs.readFileSync(probeFile, 'utf8');
    expect(original, 'labs/harness/probe.ts is not as committed: restore it').toContain("'as-committed'");
    const before = await (await request.get(moduleUrl)).text();
    expect(before).toContain('as-committed');
    try {
      // Another agent saves the file: the same module now says something else on disk, in its comment and in its code.
      fs.writeFileSync(probeFile, original.replaceAll("'as-committed'", "'saved-during-the-run'"));
      expect(fs.readFileSync(probeFile, 'utf8')).toContain("= 'saved-during-the-run';");
      // The server goes on serving what it transformed at the start, byte for byte...
      const after = await (await request.get(moduleUrl)).text();
      expect(after).toBe(before);
      // ... and a page loaded now, from nothing, runs that module.
      await page.goto(appUrl('/labs/harness/'));
      await page.waitForFunction(() => (globalThis as unknown as { __harnessProbe?: string }).__harnessProbe !== undefined);
      expect(await page.evaluate(() => (globalThis as unknown as { __harnessProbe?: string }).__harnessProbe)).toBe('as-committed');
      // A second load, with the browser's cache out of the way, is the same.
      await page.goto(appUrl(`/labs/harness/?again=${Date.now()}`));
      await page.waitForFunction(() => (globalThis as unknown as { __harnessProbe?: string }).__harnessProbe !== undefined);
      expect(await page.evaluate(() => (globalThis as unknown as { __harnessProbe?: string }).__harnessProbe)).toBe('as-committed');
    } finally {
      fs.writeFileSync(probeFile, original);
    }
    expect(fs.readFileSync(probeFile, 'utf8')).toBe(original);
  });
});
