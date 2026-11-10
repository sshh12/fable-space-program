// End-to-end proof of the harness: adapter, features/limits, screenshots, frame timing, input, audio.
// Usage: node run-all.mjs [chrome|msedge] [headless|headed]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, openScene, pngStats, pngDiff, assertRealImage, OUT } from './lib/harness.mjs';

const channel = process.argv[2] ?? 'chrome';
const headless = (process.argv[3] ?? 'headless') !== 'headed';
const tag = `${channel}-${headless ? 'headless' : 'headed'}`;
const server = await startServer();
const R = { tag, started: new Date().toISOString() };
const ev = (page, fn, arg) => page.evaluate(fn, arg);
const assert = (c, msg) => { if (!c) throw new Error('ASSERT: ' + msg); };

async function measure(page, ms = 3000) {
  await ev(page, () => window.__harness.waitFrames(20));
  await ev(page, () => window.__harness.resetStats());
  await page.waitForTimeout(ms);
  const s = await ev(page, () => window.__harness.getStats());
  return { fps: s.fps, raf: s.raf, cpuEncode: s.cpuEncode, gpuScene: s.gpuScene, gpuTonemap: s.gpuTonemap, gpuRawNs: s.gpuRawNs.slice(0, 8), visibility: s.visibility };
}

try {
  // ---------- 1. adapter + capabilities ----------
  {
    const b = await launch({ channel, headless });
    const { page } = b;
    const info = await openScene(page, server.url, 'grid=48');
    R.browserVersion = b.browser.version();
    R.adapter = info.adapter; R.size = info.size; R.scene = info.scene;
    assert(info.adapter.vendor === 'nvidia' && !info.adapter.isFallbackAdapter, 'expected the NVIDIA adapter, got ' + JSON.stringify(info.adapter));
    assert(/5090/.test(info.adapter.description), 'expected RTX 5090 in description: ' + info.adapter.description);
    Object.assign(R, await ev(page, () => ({ features: window.__harness.features, deviceFeatures: window.__harness.deviceFeatures, limits: window.__harness.limits, wgslLanguageFeatures: window.__harness.wgslLanguageFeatures, preferredCanvasFormat: window.__harness.preferredCanvasFormat })));
    R.extras = await ev(page, () => window.__harness.probeExtras());
    R.errorsAfterProbe = await ev(page, () => window.__harness.errors);

    // ---------- 2. screenshots ----------
    await ev(page, () => { window.__harness.setTime(12.5); window.__harness.setCamera({ yaw: 0.6, pitch: 0.28, dist: 95 }); });
    await ev(page, () => window.__harness.waitFrames(4));
    const t0 = Date.now();
    const shot1 = await page.screenshot({ path: path.join(OUT, `shot-${tag}-page.png`) });
    R.screenshotMs = Date.now() - t0;
    const shot2 = await page.screenshot();
    const shotEl = await page.locator('#c').screenshot({ path: path.join(OUT, `shot-${tag}-canvas.png`) });
    const dataUrl = await ev(page, () => window.__harness.captureDataURL());
    const shotData = Buffer.from(dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, `shot-${tag}-toDataURL.png`), shotData);
    R.screenshot = {
      page: pngStats(shot1), canvasLocator: pngStats(shotEl), toDataURL: pngStats(shotData),
      repeatDiff: pngDiff(shot1, shot2), pageVsToDataURL: pngDiff(shot1, shotData), pageVsLocator: pngDiff(shot1, shotEl),
    };
    assertRealImage(R.screenshot.page, 'page.screenshot');
    assertRealImage(R.screenshot.toDataURL, 'canvas.toDataURL');
    R.hdr = await ev(page, () => window.__harness.readHDR());
    assert(R.hdr.maxLuminance > 1.5, 'HDR target should hold values > 1, max=' + R.hdr.maxLuminance);
    assert(R.hdr.nanPixels === 0, 'NaN pixels in HDR target');
    assert(R.hdr.depth.max > 0 && R.hdr.depth.max < 1 && R.hdr.depth.fractionSky_depth0 > 0.01, 'reversed-Z depth looks wrong: ' + JSON.stringify(R.hdr.depth));
    // second viewpoint that looks toward the sun (HDR sun disk must clip to white after tonemap, not wrap)
    await ev(page, () => window.__harness.setCamera({ yaw: Math.atan2(0.6, 0.45) + Math.PI, pitch: -0.02, dist: 160 }));
    await ev(page, () => window.__harness.waitFrames(4));
    const shotSun = await page.screenshot({ path: path.join(OUT, `shot-${tag}-sun.png`) });
    R.screenshot.sunView = pngStats(shotSun);
    R.hdrSunView = await ev(page, () => window.__harness.readHDR());
    // HiDPI + 4K capture
    await page.setViewportSize({ width: 1920, height: 1080 });
    await ev(page, () => window.__harness.waitFrames(4));
    const shotHD = await page.screenshot({ path: path.join(OUT, `shot-${tag}-1080p.png`) });
    R.screenshot.hd = pngStats(shotHD);
    await page.setViewportSize({ width: 1280, height: 720 });
    await ev(page, () => { window.__harness.cam.frozenTime = null; window.__harness.cam.autoOrbit = true; window.__harness.setCamera({ yaw: 0.6, pitch: 0.28, dist: 95 }); window.__harness.cam.autoOrbit = true; });

    // ---------- 4. input ----------
    await ev(page, () => window.__harness.setCamera({ yaw: 0.6, pitch: 0.28, dist: 95 }));
    const yaw0 = await ev(page, () => window.__harness.cam.yaw);
    await page.locator('#c').click({ position: { x: 640, y: 360 } });
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(500);
    const during = await ev(page, () => window.__harness.input.keysDown);
    await page.keyboard.up('KeyD');
    const yaw1 = await ev(page, () => window.__harness.cam.yaw);
    await page.keyboard.press('Space'); await page.keyboard.press('Shift+KeyZ');
    await page.mouse.move(400, 300); await page.mouse.down();
    await page.mouse.move(600, 340, { steps: 10 }); await page.mouse.up();
    const yaw2 = await ev(page, () => window.__harness.cam.yaw);
    const dist0 = await ev(page, () => window.__harness.cam.dist);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(100);
    const dist1 = await ev(page, () => window.__harness.cam.dist);
    const lock = await ev(page, () => window.__harness.requestPointerLock());
    await page.waitForTimeout(200);
    const locked = await ev(page, () => window.__harness.input.pointerLocked);
    let lockedMove = null;
    if (locked) {
      await ev(page, () => { window.__harness.input.mouse.dx = 0; window.__harness.input.mouse.dy = 0; });
      await page.mouse.move(700, 400, { steps: 5 });
      lockedMove = await ev(page, () => ({ dx: window.__harness.input.mouse.dx, dy: window.__harness.input.mouse.dy }));
      await ev(page, () => document.exitPointerLock());
    }
    const inp = await ev(page, () => window.__harness.input);
    R.input = { keysDownDuringHold: during, yawDeltaFromKeyD_500ms: +(yaw1 - yaw0).toFixed(4), yawDeltaFromDrag200px: +(yaw2 - yaw1).toFixed(4), distBeforeWheel: +dist0.toFixed(2), distAfterWheel: +dist1.toFixed(2), keyLog: inp.keyLog, mouse: inp.mouse, pointerLockRequest: lock, pointerLocked: locked, lockedMove };
    assert(during.includes('KeyD'), 'KeyD not seen as held');
    assert(Math.abs(yaw1 - yaw0 - 0.6) < 0.15, 'KeyD 500 ms hold should yaw ~0.6 rad, got ' + (yaw1 - yaw0));
    assert(Math.abs(yaw2 - yaw1 - 1.0) < 0.05, 'drag 200 px should yaw 1.0 rad, got ' + (yaw2 - yaw1));
    assert(dist1 > dist0, 'wheel did not zoom');

    // ---------- 6. audio ----------
    const a = {};
    a.start = await ev(page, () => window.__harness.audioStart({ freq: 220, gain: 0.25 }));
    await page.waitForTimeout(600);
    a.level220 = await ev(page, () => window.__harness.audioLevel());
    await ev(page, () => window.__harness.audioSet(0.05, 880));
    await page.waitForTimeout(500);
    a.level880quiet = await ev(page, () => window.__harness.audioLevel());
    await ev(page, () => window.__harness.audioSet(0, null));
    await page.waitForTimeout(500);
    a.levelSilent = await ev(page, () => window.__harness.audioLevel());
    await ev(page, () => window.__harness.audioStop());
    a.offline = await ev(page, () => window.__harness.audioOffline());
    R.audio = a;
    assert(a.start.state === 'running', 'AudioContext not running without gesture: ' + a.start.state);
    assert(Math.abs(a.level220.rms - 0.25 / Math.SQRT2) < 0.01, 'rms mismatch ' + a.level220.rms);
    assert(Math.abs(a.level220.dominantHz - 220) < 8, 'dominant freq mismatch ' + a.level220.dominantHz);
    assert(a.levelSilent.rms < 1e-4, 'expected silence');
    assert(Math.abs(a.offline.rmsOpen - a.offline.expectedOpen) < 0.005 && a.offline.rmsMuffled < 0.1 * a.offline.rmsOpen, 'offline render mismatch');

    R.consoleLog = b.consoleLog.slice(0, 20);
    R.errors = await ev(page, () => window.__harness.errors);
    await b.browser.close();
  }

  // ---------- 3. frame timing ----------
  R.timing = {};
  const scenes = { light_2k_cubes: 'grid=48', heavy_1M_cubes: 'grid=1000', heavier_4M_cubes: 'grid=2000' };
  for (const [mode, opts] of Object.entries({
    vsync: { uncapped: false },
    uncapped: { uncapped: true },
    uncapped_quantizedTimers: { uncapped: true, preciseGpuTimers: false },
    frameRateLimitOnly: { extraArgs: ['--disable-frame-rate-limit'] },
    gpuVsyncOnly: { extraArgs: ['--disable-gpu-vsync'] },
  })) {
    const b = await launch({ channel, headless, ...opts });
    R.timing[mode] = {};
    for (const [sname, q] of Object.entries(scenes)) {
      if (mode !== 'vsync' && mode !== 'uncapped' && sname !== 'light_2k_cubes') continue;
      await openScene(b.page, server.url, q);
      const m = await measure(b.page, 2500);
      R.timing[mode][sname] = m;
      if (mode === 'vsync' || mode === 'uncapped') {
        m.benchBatch = await ev(b.page, () => window.__harness.benchmark(300, 'batch'));
        m.benchSerial = await ev(b.page, () => window.__harness.benchmark(300, 'serial'));
      }
    }
    if (mode === 'uncapped') {
      await b.page.setViewportSize({ width: 3840, height: 2160 });
      await openScene(b.page, server.url, 'grid=1000');
      const m = await measure(b.page, 2500);
      m.size = await ev(b.page, () => window.__harness.size);
      m.benchBatch = await ev(b.page, () => window.__harness.benchmark(200, 'batch'));
      R.timing[mode].heavy_1M_cubes_4K = m;
    }
    await b.browser.close();
  }
  R.ok = true;
} catch (e) {
  R.ok = false; R.failure = String(e.stack || e);
} finally {
  await server.close();
  fs.writeFileSync(path.join(OUT, `results-${tag}.json`), JSON.stringify(R, null, 2));
  console.log(R.ok ? `PASS ${tag}` : `FAIL ${tag}\n${R.failure}`);
  process.exit(R.ok ? 0 : 1);
}
