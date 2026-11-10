// Extra probes: allocation limits, audio policy without flags, Edge feature diff, 4K screenshot cost, DPR, worker WebGPU.
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, openScene, pngStats, OUT, chromeArgs } from './lib/harness.mjs';
const server = await startServer();
const R = {};
try {
  { // allocation probes
    const b = await launch({});
    await openScene(b.page, server.url, 'grid=8');
    R.extras = await b.page.evaluate(() => window.__harness.probeExtras());
    R.extrasErrors = await b.page.evaluate(() => ({ errors: window.__harness.errors, lost: window.__harness.deviceLost }));
    // 4K screenshots
    await b.page.setViewportSize({ width: 3840, height: 2160 });
    await b.page.evaluate(() => { window.__harness.setTime(3); return window.__harness.waitFrames(4); });
    let t0 = Date.now(); const s4k = await b.page.screenshot({ path: path.join(OUT, 'shot-4k.png') }); R.shot4k = { ms: Date.now() - t0, bytes: s4k.length, ...pngStats(s4k) };
    t0 = Date.now(); const j4k = await b.page.screenshot({ type: 'jpeg', quality: 85 }); R.shot4kJpeg = { ms: Date.now() - t0, bytes: j4k.length };
    t0 = Date.now(); const clip = await b.page.screenshot({ clip: { x: 1600, y: 900, width: 640, height: 360 } }); R.shot4kClip = { ms: Date.now() - t0, ...pngStats(clip) };
    await b.browser.close();
  }
  { // deviceScaleFactor 2
    const b = await launch({ width: 960, height: 540, dpr: 2 });
    const info = await openScene(b.page, server.url, 'grid=48');
    await b.page.evaluate(() => { window.__harness.setTime(3); return window.__harness.waitFrames(4); });
    const s = await b.page.screenshot();
    R.dpr2 = { size: info.size, shot: pngStats(s) };
    await b.browser.close();
  }
  for (const [name, o] of Object.entries({
    audio_noAutoplayFlag_headless: { headless: true, args: chromeArgs({ audio: false }) },
    audio_noAutoplayFlag_headed: { headless: false, args: chromeArgs({ audio: false }) },
    audio_flag_headed: { headless: false, args: chromeArgs({}) },
  })) {
    const b = await launch(o);
    await openScene(b.page, server.url, 'grid=8');
    const r = {};
    r.start = await b.page.evaluate(() => window.__harness.audioStart({}));
    await b.page.waitForTimeout(400);
    r.levelBeforeGesture = await b.page.evaluate(() => window.__harness.audioLevel());
    await b.page.locator('#c').click();
    await b.page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    r.stateAfterClickNoResume = (await b.page.evaluate(() => window.__harness.audioLevel())).state;
    r.afterGestureResume = await b.page.evaluate(async () => { const h = window.__harness; await h.audioStop(); const s = await h.audioStart({ resume: true }); await new Promise((r) => setTimeout(r, 400)); return { s: s.state, lvl: h.audioLevel() }; });
    R[name] = r;
    await b.browser.close();
  }
  { // Edge feature diff + worker
    const c = await launch({ channel: 'chrome' }); await openScene(c.page, server.url, 'grid=8');
    const e = await launch({ channel: 'msedge' }); await openScene(e.page, server.url, 'grid=8');
    const fc = await c.page.evaluate(() => window.__harness.features), fe = await e.page.evaluate(() => window.__harness.features);
    R.edgeOnlyFeatures = fe.filter((f) => !fc.includes(f)); R.chromeOnlyFeatures = fc.filter((f) => !fe.includes(f));
    const lc = await c.page.evaluate(() => window.__harness.limits), le = await e.page.evaluate(() => window.__harness.limits);
    R.limitDiffEdgeVsChrome = Object.keys({ ...lc, ...le }).filter((k) => lc[k] !== le[k]).map((k) => `${k}: chrome=${lc[k]} edge=${le[k]}`);
    R.workerWebGPU = await c.page.evaluate(async () => {
      const src = `onmessage = async (ev) => { try { const a = await navigator.gpu.requestAdapter(); const d = await a.requestDevice(); const c = ev.data; const x = c.getContext('webgpu'); x.configure({ device: d, format: navigator.gpu.getPreferredCanvasFormat() }); postMessage({ ok: true, vendor: a.info.vendor, desc: a.info.description }); } catch (e) { postMessage({ ok: false, err: String(e) }); } }`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      const oc = new OffscreenCanvas(64, 64);
      return await new Promise((res) => { w.onmessage = (m) => res(m.data); w.postMessage(oc, [oc]); });
    });
    await c.browser.close(); await e.browser.close();
  }
} catch (e) { R.failure = String(e.stack || e); }
await server.close();
fs.writeFileSync(path.join(OUT, 'results-extra.json'), JSON.stringify(R, null, 2));
console.log(JSON.stringify(R, null, 1));
