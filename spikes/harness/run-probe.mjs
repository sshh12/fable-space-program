// Launch-matrix probe: which channel / headless mode / flags give WebGPU on the RTX 5090?
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, chromeArgs, OUT, commandLine, gpuReport } from './lib/harness.mjs';

const server = await startServer();
const only = process.argv[2];
const matrix = [
  { name: 'chrome-headless-noflags', channel: 'chrome', headless: true, args: [] },
  { name: 'chrome-headless-noflags-power-none', channel: 'chrome', headless: true, args: [], query: 'power=none' },
  { name: 'chrome-headless-noflags-power-low', channel: 'chrome', headless: true, args: [], query: 'power=low-power' },
  { name: 'chrome-headless-baseline', channel: 'chrome', headless: true },
  { name: 'chrome-headless-baseline-power-none', channel: 'chrome', headless: true, query: 'power=none' },
  { name: 'chrome-headless-baseline-power-low', channel: 'chrome', headless: true, query: 'power=low-power' },
  { name: 'chrome-headed-noflags', channel: 'chrome', headless: false, args: [] },
  { name: 'chrome-headed-noflags-power-none', channel: 'chrome', headless: false, args: [], query: 'power=none' },
  { name: 'chrome-headed-noflags-power-low', channel: 'chrome', headless: false, args: [], query: 'power=low-power' },
  { name: 'chrome-headed-baseline', channel: 'chrome', headless: false },
  { name: 'msedge-headless-baseline', channel: 'msedge', headless: true },
  { name: 'msedge-headed-baseline', channel: 'msedge', headless: false },
  { name: 'chrome-headless-vulkan', channel: 'chrome', headless: true, args: [...chromeArgs(), '--enable-features=Vulkan', '--use-webgpu-adapter=vulkan'] },
  { name: 'chrome-headless-fallback-adapter', channel: 'chrome', headless: true, query: 'fallback=1' },
  { name: 'bundled-chromium-headless-shell', channel: 'chromium', headless: true },
  { name: 'bundled-chromium-headed', channel: 'chromium', headless: false },
];

const results = [];
for (const m of matrix) {
  if (only && !m.name.includes(only)) continue;
  const r = { name: m.name };
  let b;
  try {
    const t0 = Date.now();
    b = await launch({ channel: m.channel, headless: m.headless, args: m.args });
    r.launchMs = Date.now() - t0;
    r.browserVersion = b.browser.version();
    await b.page.goto(`${server.url}/index.html?${m.query ?? ''}`);
    r.ready = await b.page.evaluate(() => window.__harness.ready);
    Object.assign(r, await b.page.evaluate(() => ({ adapter: window.__harness.adapter, errors: window.__harness.errors, nFeatures: window.__harness.features?.length, preferredCanvasFormat: window.__harness.preferredCanvasFormat, size: window.__harness.size })));
    if (r.ready) {
      await b.page.evaluate(() => window.__harness.waitFrames(30));
      await b.page.evaluate(() => window.__harness.resetStats());
      await b.page.waitForTimeout(1500);
      const s = await b.page.evaluate(() => window.__harness.getStats());
      r.fps = s.fps; r.rafP50 = s.raf?.p50; r.gpuSceneP50 = s.gpuScene?.p50; r.visibility = s.visibility;
    }
    r.cmd = (await commandLine(b.browser)).cmd;
    if (m.name === 'chrome-headless-baseline' || m.name === 'chrome-headed-baseline' || m.name === 'chrome-headless-noflags') {
      fs.writeFileSync(path.join(OUT, `gpu-${m.name}.txt`), await gpuReport(b.browser));
    }
  } catch (e) {
    r.error = String(e.message).split('\n').slice(0, 4).join(' | ');
  } finally {
    await b?.browser.close().catch(() => {});
  }
  results.push(r);
  console.log(JSON.stringify({ name: r.name, ready: r.ready, adapter: r.adapter && `${r.adapter.vendor}/${r.adapter.architecture}/${r.adapter.device}/${r.adapter.description}`, fallback: r.adapter?.isFallbackAdapter, nFeatures: r.nFeatures, fps: r.fps, gpuSceneP50: r.gpuSceneP50, launchMs: r.launchMs, ver: r.browserVersion, error: r.error, errors: r.errors?.length ? r.errors : undefined }));
}
fs.writeFileSync(path.join(OUT, 'probe.json'), JSON.stringify(results, null, 2));
await server.close();
