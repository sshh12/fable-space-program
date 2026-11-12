#!/usr/bin/env node
/**
 * Records "real gameplay footage" of the original mission: the real game in the installed Chrome on the discrete
 * GPU, the scripted test pilot flying lunar-direct inside the page, and tools/footage/director.js moving the
 * camera and switching views. The whole tab is captured (canvas + the DOM HUD and navball) with its audio through
 * getDisplayMedia({ preferCurrentTab }) and MediaRecorder; chunks are streamed to disk once a second.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- node tools/footage/record.mjs --test=20     # a short clip on the pad
 *   node tools/dev/heavy.mjs --class=gpu -- node tools/footage/record.mjs               # the whole flight (~47 min)
 *
 * Options: --out=<dir> (default out/footage), --width / --height (2560 x 1440), --mbps (requested video bitrate, 30;
 * Chrome's encoder lands well above it on detailed scenes),
 * --pad=<s> (pad footage before the pilot starts, 50), --headed.
 *
 * The flight is not touched: the pilot is started through window.__test.pilot.start() (what `?pilot=1` does at
 * boot) once the pad's terrain is resident, so the pad is never filmed while the land is still drawn as sea.
 * Output: <out>/<name>-NN.mp4 (the recording, in files of about --rotate-gb (2.2) GB that overlap by 1.5 s: Chrome's
 * MP4 recorder crashes the page at 4 GiB), <out>/<name>.segments.json (each file's start offset, s),
 * <out>/<name>.events.jsonl (director, phases, milestones, with times in ms from the first file's start),
 * <out>/<name>.log.jsonl (status every 2 s), <out>/pad-check.png.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, def) => {
  const a = process.argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return def;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};
const TEST_SECONDS = Number(arg('test', 0));
const OUT = path.resolve(repoRoot, String(arg('out', 'out/footage')));
const W = Number(arg('width', 2560));
const H = Number(arg('height', 1440));
const MBPS = Number(arg('mbps', 30));
const PAD_SECONDS = Number(arg('pad', 50));
const ROTATE_GB = Number(arg('rotate-gb', 2.2));
const HEADED = Boolean(arg('headed', false));
const NAME = TEST_SECONDS > 0 ? 'test-clip' : 'mission';
fs.mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const say = (...m) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)} min]`, ...m);
const appendJsonl = (file, rows) => {
  if (rows.length) fs.appendFileSync(path.join(OUT, file), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

// ------------------------------------------------------------------------------------------ GPU lock
// The machine-wide perf mutex of tests/browser/harness.ts (withGpuLock): no perf spec measures while we record.
const lockFile = path.join(os.tmpdir(), 'fable-gpu-perf.lock');
async function takeGpuLock() {
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
      let stale = false;
      try {
        const pid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
        if (!pid) stale = Date.now() - fs.statSync(lockFile).mtimeMs > 5000;
        else process.kill(pid, 0);
      } catch (k) {
        stale = k.code === 'ESRCH';
      }
      if (stale) {
        try {
          fs.unlinkSync(lockFile);
        } catch {}
        continue;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
const releaseGpuLock = () => {
  try {
    if (fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(lockFile);
  } catch {}
};

// ------------------------------------------------------------------------------------------ server
// A private Vite server (no HMR, no watcher: edits by others during the flight cannot reload the page) with one
// extra route that appends the recorder's chunks to a file.
const recordingFiles = new Set();
const uploadPlugin = {
  name: 'footage-upload',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url || !req.url.startsWith('/__footage/')) return next();
      const u = new URL(req.url, 'http://local');
      const file = (u.searchParams.get('file') ?? '').replace(/[^a-zA-Z0-9._-]/g, '');
      if (req.method !== 'POST' || u.pathname !== '/__footage/chunk' || !file) {
        res.statusCode = 400;
        return res.end('bad request');
      }
      recordingFiles.add(file);
      const ws = fs.createWriteStream(path.join(OUT, file), { flags: 'a' });
      req.pipe(ws);
      ws.on('finish', () => res.end('ok'));
      ws.on('error', (e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    });
  },
};

const server = await createServer({
  root: repoRoot,
  configFile: path.join(repoRoot, 'vite.config.ts'),
  logLevel: 'error',
  plugins: [uploadPlugin],
  server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false, watch: null },
});
await server.listen();
const addr = server.httpServer.address();
const BASE = `http://127.0.0.1:${addr.port}`;
say(`vite on ${BASE}`);

// ------------------------------------------------------------------------------------------ browser
await takeGpuLock();
let browser;
let exitCode = 0;
let finishFiles = null;
let lastSegments = [];
const cleanup = async () => {
  try {
    await browser?.close();
  } catch {}
  releaseGpuLock();
  try {
    await server.close();
  } catch {}
};
process.on('SIGINT', async () => {
  say('SIGINT: closing');
  await cleanup();
  process.exit(130);
});

try {
  browser = await chromium.launch({
    channel: 'chrome',
    headless: !HEADED,
    // Playwright mutes headless audio by default; the tab's audio is captured (and suppressed locally) instead.
    ignoreDefaultArgs: ['--mute-audio'],
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      '--force_high_performance_gpu',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-webgpu-developer-features',
      '--auto-accept-this-tab-capture',
      `--window-size=${W},${H}`,
    ],
  });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleLog = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleLog.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleLog.push(`pageerror: ${e.message}`));
  page.on('crash', () => say('PAGE CRASHED'));

  // No "TEST PILOT" line and no keyboard-capture switch in the footage (the app's footage switches).
  await page.goto(`${BASE}/?scenario=lunar-direct&view=chase&scale=1&governor=off&pilotlabel=0&capturepill=0`);
  await page.waitForFunction(() => window.__test !== undefined, undefined, { timeout: 120_000 });
  const ok = await page.evaluate(async () => {
    const r = await Promise.race([window.__test.ready, new Promise((res) => setTimeout(() => res('timeout'), 240_000))]);
    return { ready: r, errors: window.__test.errors, adapter: window.__test.adapter };
  });
  say(`ready ${ok.ready}; adapter ${ok.adapter?.vendor} ${ok.adapter?.description}; errors ${JSON.stringify(ok.errors)}`);
  if (ok.ready !== true || ok.errors.length) throw new Error('page failed to initialise');
  if (ok.adapter?.vendor !== 'nvidia' || ok.adapter?.isFallbackAdapter) throw new Error(`not the discrete NVIDIA adapter: ${JSON.stringify(ok.adapter)}`);
  const facts = await page.evaluate(() => {
    const s = window.__test.state();
    return { scenario: s.scenario, cheatCounter: s.cheatCounter };
  });
  say(`scenario ${JSON.stringify(facts)}`);

  // Director and recorder.
  await page.addScriptTag({ content: fs.readFileSync(path.join(repoRoot, 'tools', 'footage', 'director.js'), 'utf8') });
  const mime = await page.evaluate(
    ({ w, h, mbps, base, rotateBytes }) => {
      const candidates = [
        'video/mp4;codecs=avc1.640034,opus',
        'video/mp4;codecs=avc1.640034,mp4a.40.2',
        'video/mp4;codecs=avc1.640033,opus',
        'video/mp4;codecs=avc1,opus',
        'video/webm;codecs=h264,opus',
        'video/webm;codecs=vp9,opus',
      ];
      const supported = candidates.filter((c) => MediaRecorder.isTypeSupported(c));
      const mimeType = supported[0];
      const F = (window.__footage = { state: 'idle', bytes: 0, chunks: 0, pending: 0, errors: [], mimeType, supported, t0: 0, settings: null, segments: [], live: [] });
      let queue = Promise.resolve();
      const send = (file, blob) => {
        F.pending++;
        queue = queue
          .then(() => fetch(`/__footage/chunk?file=${file}`, { method: 'POST', body: blob }))
          .then((r) => {
            if (!r.ok) throw new Error(`upload ${r.status}`);
          })
          .catch((e) => F.errors.push(String(e)))
          .finally(() => F.pending--);
      };
      window.addEventListener(
        'keydown',
        async (e) => {
          if (e.code !== 'F9' || F.state !== 'idle') return;
          F.state = 'requesting';
          try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: { ideal: 60, max: 60 }, width: { ideal: w }, height: { ideal: h }, cursor: 'never' },
              audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true, channelCount: 2, sampleRate: 48000 },
              preferCurrentTab: true,
              selfBrowserSurface: 'include',
              surfaceSwitching: 'exclude',
              systemAudio: 'exclude',
            });
            const vt = stream.getVideoTracks()[0];
            const at = stream.getAudioTracks()[0];
            if (vt) vt.contentHint = 'detail';
            F.settings = { video: vt?.getSettings(), audio: at?.getSettings() ?? null, label: vt?.label };
            // Chrome's MP4 MediaRecorder kills the renderer when one recording reaches 4 GiB (seen at 4,294,870,972
            // bytes). Rotate: a new recorder on the same stream starts before the file nears rotateBytes; the old
            // one stops 1.5 s after the new one has started, so consecutive files overlap and nothing is lost.
            let n = 0;
            let rotating = false;
            const startRecorder = (prev) => {
              const seg = { n: n++, file: `${base}-${String(n - 1).padStart(2, '0')}.tmp`, bytes: 0, t0: 0, t1: 0, state: 'starting' };
              const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: mbps * 1e6, audioBitsPerSecond: 256000 });
              seg.rec = rec;
              rec.ondataavailable = (ev) => {
                if (ev.data && ev.data.size > 0) {
                  seg.bytes += ev.data.size;
                  F.bytes += ev.data.size;
                  F.chunks++;
                  send(seg.file, ev.data);
                }
              };
              rec.onstart = () => {
                seg.t0 = performance.now();
                seg.state = 'recording';
                F.segments.push({ n: seg.n, file: seg.file, t0: seg.t0, t1: 0 });
                if (seg.n === 0) {
                  F.t0 = seg.t0;
                  F.state = 'recording';
                }
                F.cur = seg;
                if (prev)
                  setTimeout(() => {
                    try {
                      prev.rec.stop();
                    } catch (e) {
                      F.errors.push(String(e));
                    }
                    rotating = false;
                  }, 1500);
              };
              rec.onstop = () => {
                seg.state = 'stopped';
                seg.t1 = performance.now();
                const rec0 = F.segments.find((x) => x.n === seg.n);
                if (rec0) rec0.t1 = seg.t1;
                F.live = F.live.filter((x) => x !== seg);
                if (F.live.length === 0 && F.stopping) F.state = 'stopped';
              };
              rec.onerror = (ev) => F.errors.push(`recorder ${seg.n}: ${ev.error?.name ?? ev}`);
              F.live.push(seg);
              rec.start(1000);
            };
            startRecorder(null);
            F.rotateTimer = setInterval(() => {
              if (!F.stopping && !rotating && F.cur && F.cur.bytes > rotateBytes) {
                rotating = true;
                startRecorder(F.cur);
              }
            }, 500);
            F.stop = () => {
              F.stopping = true;
              clearInterval(F.rotateTimer);
              for (const x of F.live) x.rec.stop();
            };
          } catch (err) {
            F.state = 'error';
            F.errors.push(String(err));
          }
        },
        true,
      );
      return { mimeType, supported };
    },
    { w: W, h: H, mbps: MBPS, base: NAME, rotateBytes: ROTATE_GB * 1e9 },
  );
  say(`recorder ${JSON.stringify(mime)}`);
  const ext = mime.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  for (const f of fs.readdirSync(OUT)) if (f.startsWith(`${NAME}-`) && f.endsWith('.tmp')) fs.rmSync(path.join(OUT, f), { force: true });
  for (const f of [`${NAME}.events.jsonl`, `${NAME}.log.jsonl`, `${NAME}.segments.json`]) fs.rmSync(path.join(OUT, f), { force: true });
  /** Rename the finished (or interrupted) recordings and write their start offsets (s) for the editor. */
  finishFiles = async () => {
    let segs = [];
    try {
      segs = await page.evaluate(() => window.__footage.segments.map((x) => ({ n: x.n, file: x.file, t0: x.t0, t1: x.t1 ?? 0 })));
    } catch {
      segs = lastSegments;
    }
    const t0 = segs[0]?.t0 ?? 0;
    const out = segs.map((x) => {
      const final = x.file.replace(/\.tmp$/, `.${ext}`);
      try {
        if (fs.existsSync(path.join(OUT, x.file))) fs.renameSync(path.join(OUT, x.file), path.join(OUT, final));
      } catch (e) {
        say(`rename ${x.file}: ${e}`);
      }
      return { n: x.n, file: final, offset: (x.t0 - t0) / 1000, end: x.t1 ? (x.t1 - t0) / 1000 : null };
    });
    fs.writeFileSync(path.join(OUT, `${NAME}.segments.json`), JSON.stringify(out, null, 1));
    return out;
  };

  // Wait until the pad's terrain is resident (the land around the pad is drawn as sea for ~40 s after boot).
  const readyAt = Date.now();
  let calm = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const ts = await page.evaluate(() => {
      const t = window.__app.terrainStats();
      return { queued: t.stream.queued, loading: t.stream.loading, uploading: t.stream.uploading, uploaded: t.stream.uploadedTotal, busy: window.__app.busyFeatures() };
    });
    const pending = ts.queued + ts.loading + ts.uploading;
    calm = pending < 8 ? calm + 1 : 0;
    const waited = (Date.now() - readyAt) / 1000;
    if ((waited > 55 && calm >= 3) || waited > 130 || (TEST_SECONDS > 0 && waited > 8)) {
      say(`terrain settled after ${waited.toFixed(0)} s: ${JSON.stringify(ts)}`);
      break;
    }
  }
  await page.screenshot({ path: path.join(OUT, 'pad-check.png') });

  // Start: F9 is unbound in the game; the key press is the gesture for the capture and resumes the AudioContext.
  await page.keyboard.press('F9');
  await page.waitForFunction(() => window.__footage.state !== 'idle' && window.__footage.state !== 'requesting', undefined, { timeout: 30_000 });
  const rs = await page.evaluate(() => ({ state: window.__footage.state, errors: window.__footage.errors, settings: window.__footage.settings, audioCtx: window.__test.audio()?.contextState }));
  say(`capture ${JSON.stringify(rs)}`);
  if (rs.state !== 'recording') throw new Error('recorder did not start');
  await page.evaluate((plan) => window.__director.start(plan), TEST_SECONDS > 0 ? 'test' : 'full');

  const recT0 = await page.evaluate(() => window.__footage.t0);
  const drain = async () => {
    const d = await page.evaluate(() => ({ ev: window.__director.drain(), errors: window.__director.errors.splice(0) }));
    appendJsonl(`${NAME}.events.jsonl`, d.ev.map((e) => ({ ...e, t: Math.round(e.t - recT0) })));
    for (const e of d.errors) say(`director error: ${e}`);
  };

  const recStart = Date.now();
  let pilotStarted = false;
  let splashAt = 0;
  let lastFrames = -1;
  let lastFramesAt = Date.now();
  let lastPhase = null;
  let perfAt = Date.now();
  await page.evaluate(() => window.__test.resetPerf());
  let lastShot = null;
  let iter = 0;
  let segCount = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    // Cockpit shots: once the view has arrived, turn the look toward the window with a mouse drag (camera only:
    // the drag starts on the scene, away from the HUD; the pilot flies, so the flight controller ignores the mouse).
    const shotNow = await page.evaluate(() => window.__director.shot);
    if (shotNow !== lastShot) {
      lastShot = shotNow;
      if (shotNow === 'cockpit') {
        try {
          await page.waitForFunction(() => window.__app.viewMode() === 'cockpit' && !window.__app.viewBlending(), undefined, { timeout: 5000, polling: 50 });
          const x0 = Math.round(W * 0.3);
          const y0 = Math.round(H * 0.42);
          await page.mouse.move(x0, y0);
          await page.mouse.down();
          await page.mouse.move(x0 + 150, y0 - 110, { steps: 24 });
          await page.mouse.up();
        } catch (e) {
          say(`cockpit look: ${e}`);
        }
      }
    }
    if (++iter % 4 !== 0) continue;
    await drain();
    const p = await page.evaluate(() => {
      const t = window.__test;
      const b = window.__app.brief();
      return {
        b: { met: b.met, alt: b.altitudeAsl, warp: b.warpFactor, view: b.viewMode, milestones: b.milestones.length, last: b.milestones[b.milestones.length - 1] ?? null, situation: b.situation },
        phase: t.pilot.phase(),
        done: t.pilot.done(),
        failure: t.pilot.failure(),
        errors: t.errors.length,
        frames: window.__app.frames(),
        rec: { state: window.__footage.state, mb: +(window.__footage.bytes / 1e6).toFixed(1), pending: window.__footage.pending, errors: window.__footage.errors.length },
        segments: window.__footage.segments.map((x) => ({ n: x.n, file: x.file, t0: x.t0, t1: x.t1 ?? 0 })),
        shot: window.__director.shot,
        sampleMs: window.__director.sampleMs,
      };
    });
    const now = Date.now();
    lastSegments = p.segments;
    if (p.segments.length !== segCount) {
      segCount = p.segments.length;
      say(`recording file ${p.segments[segCount - 1].file} started`);
    }
    delete p.segments;
    appendJsonl(`${NAME}.log.jsonl`, [{ wall: now - recStart, ...p }]);
    if (p.frames !== lastFrames) {
      lastFrames = p.frames;
      lastFramesAt = now;
    } else if (now - lastFramesAt > 60_000) throw new Error('frame loop stalled for 60 s');
    if (p.phase !== lastPhase) {
      say(`phase ${p.phase} (MET ${(p.b.met / 3600).toFixed(2)} h, alt ${(p.b.alt / 1000).toFixed(1)} km, warp ${p.b.warp}) shot ${p.shot}; rec ${p.rec.mb} MB`);
      lastPhase = p.phase;
    }
    if (now - perfAt > 30_000) {
      perfAt = now;
      const pf = await page.evaluate(() => {
        const x = window.__test.perf();
        window.__test.resetPerf();
        return x ? { raf: [x.raf.p50, x.raf.p99, x.raf.over33ms], gpu: [x.gpu.p50, x.gpu.p99], cpu: [x.cpu.p50, x.cpu.p99] } : null;
      });
      appendJsonl(`${NAME}.log.jsonl`, [{ wall: now - recStart, perf: pf }]);
      say(`perf ${JSON.stringify(pf)} shot ${p.shot} rec ${p.rec.mb} MB pending ${p.rec.pending} sample ${p.sampleMs.toFixed(2)} ms`);
    }
    if (p.errors > 0 || p.rec.errors > 0) {
      const e = await page.evaluate(() => ({ app: window.__test.errors, rec: window.__footage.errors }));
      say(`errors: ${JSON.stringify(e)}`);
      if (e.rec.length) throw new Error('recorder error');
    }
    if (TEST_SECONDS > 0) {
      if (now - recStart > TEST_SECONDS * 1000) break;
      continue;
    }
    if (!pilotStarted && now - recStart > PAD_SECONDS * 1000) {
      await page.evaluate(() => window.__test.pilot.start());
      pilotStarted = true;
      say('pilot started');
    }
    if (p.failure) throw new Error(`pilot gave up: ${p.failure}`);
    if (p.b.last === 'SPLASHDOWN' && !splashAt) {
      splashAt = now;
      say('splashdown');
    }
    if (splashAt && now - splashAt > 50_000) break;
    if (now - recStart > 110 * 60_000) throw new Error('flight limit');
  }

  // Stop and flush.
  await page.evaluate(() => {
    window.__director.stop();
    window.__footage.stop();
  });
  await page.waitForFunction(() => window.__footage.state === 'stopped' && window.__footage.pending === 0, undefined, { timeout: 60_000, polling: 250 });
  await drain();
  const end = await page.evaluate(() => ({ bytes: window.__footage.bytes, chunks: window.__footage.chunks, errors: window.__footage.errors, milestones: window.__test.milestones().map((m) => m.id), cheat: window.__test.state().cheatCounter, appErrors: window.__test.errors }));
  const files = await finishFiles();
  say(`done: ${files.map((x) => x.file).join(' ')} ${(end.bytes / 1e9).toFixed(2)} GB in ${end.chunks} chunks; milestones ${end.milestones.length} (${end.milestones.join(' ')}); cheatCounter ${end.cheat}; app errors ${JSON.stringify(end.appErrors)}; recorder errors ${JSON.stringify(end.errors)}`);
  say(`console: ${JSON.stringify(consoleLog.slice(0, 20))}`);
} catch (e) {
  exitCode = 1;
  say(`FAILED: ${e?.stack ?? e}`);
  // Keep what was recorded (each file is a complete fragmented MP4 up to its last chunk).
  try {
    if (finishFiles) say(`kept ${JSON.stringify(await finishFiles())}`);
  } catch (e2) {
    say(`could not keep the files: ${e2}`);
  }
} finally {
  await cleanup();
}
process.exit(exitCode);
