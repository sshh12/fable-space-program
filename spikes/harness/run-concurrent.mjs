// Concurrency proof: N independent node processes, each with its own server port + browser profile,
// rendering simultaneously on the same GPU. Usage: node run-concurrent.mjs [N=4]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, launch, openScene, pngStats, commandLine, withGpuLock, chromeArgs, OUT } from './lib/harness.mjs';

const self = fileURLToPath(import.meta.url);

async function child(id, headless, useLock, query) {
  const server = await startServer();
  const b = await launch({ headless });
  const out = { id, pid: process.pid, port: server.port, headless };
  try {
    const info = await openScene(b.page, server.url, query);
    out.adapter = info.adapter.description;
    out.profile = (await commandLine(b.browser)).profile;
    const run = async (waitedMs) => {
      const t0 = Date.now();
      await b.page.evaluate(() => window.__harness.waitFrames(20));
      await b.page.evaluate(() => window.__harness.resetStats());
      await b.page.waitForTimeout(3000);
      const s = await b.page.evaluate(() => window.__harness.getStats());
      return { waitedForLockMs: waitedMs, window: [t0, Date.now()], fps: s.fps, rafP50: s.raf.p50, rafP99: s.raf.p99, rafMax: s.raf.max, gpuSceneP50: s.gpuScene?.p50, gpuSceneP99: s.gpuScene?.p99, visibility: s.visibility };
    };
    out.perf = useLock ? await withGpuLock(run) : await run(0);
    await b.page.evaluate(() => { window.__harness.setTime(12.5); window.__harness.setCamera({ yaw: 0.6, pitch: 0.28, dist: 95 }); return window.__harness.waitFrames(4); });
    const shot = await b.page.screenshot({ path: path.join(OUT, `concurrent-${headless ? 'hl' : 'hd'}-${id}.png`) });
    const st = pngStats(shot);
    out.shot = { meanLuma: st.meanLuma, stdLuma: st.stdLuma, center: st.center };
    out.errors = await b.page.evaluate(() => window.__harness.errors);
  } catch (e) { out.failure = String(e.message); }
  await b.browser.close(); await server.close();
  process.stdout.write('RESULT ' + JSON.stringify(out) + '\n');
}

function spawnChild(id, headless, useLock, query) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [self, 'child', String(id), headless ? '1' : '0', useLock ? '1' : '0', query], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.on('exit', (code) => { const m = buf.match(/RESULT (.*)/); resolve(m ? JSON.parse(m[1]) : { id, failure: 'exit ' + code }); });
  });
}

if (process.argv[2] === 'child') {
  await child(+process.argv[3], process.argv[4] === '1', process.argv[5] === '1', process.argv[6]);
} else {
  const N = +(process.argv[2] ?? 4);
  const R = {};
  const q = 'grid=700'; // ~490k cubes, ~4 ms GPU alone: enough load that contention is visible
  const summarize = (rs) => rs.map((r) => r.failure ? r : ({ id: r.id, port: r.port, profile: path.basename(r.profile ?? ''), adapter: r.adapter, fps: r.perf.fps, rafP50: r.perf.rafP50, rafP99: r.perf.rafP99, rafMax: r.perf.rafMax, gpuP50: r.perf.gpuSceneP50, gpuP99: r.perf.gpuSceneP99, vis: r.perf.visibility, waitedForLockMs: r.perf.waitedForLockMs, window: r.perf.window, shot: JSON.stringify(r.shot), errors: r.errors?.length }));
  R.solo_headless = summarize([await spawnChild(0, true, false, q)]);
  R.solo_headed = summarize([await spawnChild(0, false, false, q)]);
  R[`x${N}_headless`] = summarize(await Promise.all(Array.from({ length: N }, (_, i) => spawnChild(i, true, false, q))));
  R[`x${N}_headed_overlapping_windows`] = summarize(await Promise.all(Array.from({ length: N }, (_, i) => spawnChild(i, false, false, q))));
  R[`x${N}_headless_with_gpu_lock`] = summarize(await Promise.all(Array.from({ length: N }, (_, i) => spawnChild(i, true, true, q))));
  const w = R[`x${N}_headless_with_gpu_lock`].map((r) => r.window).sort((a, b) => a[0] - b[0]);
  R.lockSerialized = w.every((x, i) => i === 0 || x[0] >= w[i - 1][1]);

  // autoplay policy without automation-granted activation
  const server = await startServer();
  R.autoplay = {};
  for (const [name, o] of Object.entries({ headless_noFlag: { headless: true, args: chromeArgs({ audio: false }) }, headed_noFlag: { headless: false, args: chromeArgs({ audio: false }) }, headless_flag: { headless: true }, headed_flag: { headless: false } })) {
    const b = await launch(o);
    await b.page.goto(`${server.url}/index.html?audioAtLoad=1&grid=8`);
    await b.page.waitForTimeout(1200);
    R.autoplay[name] = await b.page.evaluate(() => window.__harness.audioAtLoad);
    await b.browser.close();
  }
  await server.close();
  fs.writeFileSync(path.join(OUT, 'results-concurrent.json'), JSON.stringify(R, null, 2));
  for (const [k, v] of Object.entries(R)) console.log(k, Array.isArray(v) ? '\n  ' + v.map((x) => JSON.stringify(x)).join('\n  ') : JSON.stringify(v));
}
