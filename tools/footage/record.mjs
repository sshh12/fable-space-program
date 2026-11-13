#!/usr/bin/env node
/**
 * Records "real gameplay footage" of the original mission: the real game in the installed Chrome on the discrete
 * GPU, the scripted test pilot flying lunar-direct inside the page, and tools/footage/director.js moving the
 * camera and switching views. The whole tab is captured (canvas + the DOM HUD and navball) with its audio through
 * getDisplayMedia({ preferCurrentTab }) and MediaRecorder; chunks are streamed to disk once a second.
 *
 *   node tools/dev/heavy.mjs --class=gpu -- node tools/footage/record.mjs --test=20                 # a short clip on the pad
 *   node tools/dev/heavy.mjs --class=gpu -- node tools/footage/record.mjs --scenario=qa-drogues --plan=chutes --pilot --test=200
 *   node tools/dev/heavy.mjs --class=gpu -- node tools/footage/record.mjs --scenario=qa-leo --plan=full --pilot --test=200   # the roll
 *   node tools/dev/heavy.mjs --class=gpu -- node tools/footage/record.mjs                           # the whole flight (~50 min)
 *
 * Options: --out=<dir> (out/footage), --name=<base> (mission / test-clip), --scenario=<id> (lunar-direct),
 * --plan=<director plan> (full; test with --test), --pilot (start the pilot at once in a test), --width / --height
 * (2560 x 1440), --codec=auto|hevc|h264 (auto: HEVC in MP4 where Chrome has it), --mbps (the REQUEST; default 13 for
 * HEVC, 16 for H.264), --bitrate-mode (constant | variable), --probe=<mime>@<mbps>|... (test clips: one format
 * after another, 12 s each), --pad=<s> (pad footage before the pilot starts, 40), --cap-gb (3.9: no new recording
 * past this many bytes), --min-free-gb (25.3: no new recording, and the open file is closed, while the disk has
 * less free space), --rotate-gb (2.2), --duty=0 (record continuously instead of the director's windows), --headed.
 *
 * Rates measured on 2026-11-12 (Chrome 157, RTX 5090, 2560 x 1440 at 60 fps, hardware encoders): the recorder
 * lands at about twice the request whatever the bitrate mode (HEVC: 12 -> 26.5 Mbps, 24 -> 41-65, 26 -> 42-52;
 * H.264: 16 -> 22, 30 -> 59), keyframes every 2 s as asked, 60.0 fps with no dropped frame, Opus 48 kHz stereo.
 *
 * Recording is DUTY-CYCLED: the director says when it wants footage (`__director.wantRec`), and a file is opened
 * for every such window (long coasts are not recorded at all, so the raw capture fits the disk). Each file is a
 * complete fragmented MP4; `<name>.segments.json` gives each file's start and end on the take's clock (s from the
 * first file's start), `<name>.events.jsonl` the director's shots, phases, milestones, HUD and key actions on the
 * same clock, `<name>.log.jsonl` the status every 2 s.
 *
 * The flight is the pilot's, except for one thing the director asks for in the full plan: in the parking orbit
 * the pilot is stopped, the stack is rolled heads-down through the player's controls (T, E as the app spec does),
 * the cockpit is filmed with the Earth in the forward windows, and the pilot is started again (`pilot.start()`
 * makes a fresh pilot that begins in the phase that fits the state it finds). The HUD is hidden and shown with
 * the game's own F2 key, seats are stepped with V; nothing else is pressed.
 */
import { spawn } from 'node:child_process';
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
const CODEC = String(arg('codec', 'auto'));
const MBPS_ARG = arg('mbps', null);
// Chrome's hardware encoders land at about twice the request (more over the sea), constant mode or not.
const BITRATE_MODE = String(arg('bitrate-mode', 'constant'));
const PAD_SECONDS = Number(arg('pad', 40));
const ROTATE_GB = Number(arg('rotate-gb', 2.2));
const CAP_GB = Number(arg('cap-gb', 3.9));
const MIN_FREE_GB = Number(arg('min-free-gb', 25.3));
const DUTY = String(arg('duty', '1')) !== '0';
const HEADED = Boolean(arg('headed', false));
const SCENARIO = String(arg('scenario', 'lunar-direct'));
const PLAN = String(arg('plan', TEST_SECONDS > 0 ? 'test' : 'full'));
const PILOT_NOW = Boolean(arg('pilot', false));
const NAME = String(arg('name', TEST_SECONDS > 0 ? 'test-clip' : 'mission'));
// --probe=<mime>@<mbps>|...: a rate probe (test clips): every 12 s the next format, in a file of its own.
const PROBE = arg('probe', null) ? String(arg('probe')).split('|').map((x) => ({ mime: x.split('@')[0], mbps: Number(x.split('@')[1]) })) : null;
fs.mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const say = (...m) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)} min]`, ...m);
const appendJsonl = (file, rows) => {
  if (rows.length) fs.appendFileSync(path.join(OUT, file), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
const freeGb = () => {
  const s = fs.statfsSync(OUT);
  return (s.bavail * s.bsize) / 1e9;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------ disk
const free0 = freeGb();
say(`disk: ${free0.toFixed(1)} GB free (floor ${MIN_FREE_GB} GB, raw cap ${CAP_GB} GB)`);
if (free0 < MIN_FREE_GB + 1.5) {
  console.error(`not enough free disk to record (${free0.toFixed(1)} GB)`);
  process.exit(2);
}

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
      await sleep(500);
    }
  }
}
const releaseGpuLock = () => {
  try {
    if (fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(lockFile);
  } catch {}
};

// ------------------------------------------------------------------------------------------ display
// Chrome's frame clock is the monitor's vertical blank; with the monitor asleep it falls back to ~57.5 Hz
// (tests/browser/harness.ts keepDisplayAwake, request app-integration-8). The same helper: wake the display with a
// net-zero pointer movement and hold ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED until stdin closes.
const KEEP_AWAKE_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Fable -Name Power -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
[DllImport("kernel32.dll")] public static extern uint GetTickCount();
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, System.UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
'@
$lii = New-Object Fable.Power+LASTINPUTINFO
$lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
[void][Fable.Power]::GetLastInputInfo([ref]$lii)
$idle = [int](([Fable.Power]::GetTickCount() - $lii.dwTime) / 1000)
[Fable.Power]::mouse_event(1, 1, 0, 0, [System.UIntPtr]::Zero)
[Fable.Power]::mouse_event(1, -1, 0, 0, [System.UIntPtr]::Zero)
[void][Fable.Power]::SetThreadExecutionState([uint32]2147483651)
if ($idle -gt 60) { Start-Sleep -Milliseconds 3000 }
[Console]::Out.WriteLine("awake idle=$idle")
[Console]::Out.Flush()
while ($null -ne [Console]::In.ReadLine()) { }
`;
async function keepDisplayAwake() {
  if (process.platform !== 'win32') return () => undefined;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(KEEP_AWAKE_PS, 'utf16le').toString('base64')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const release = () => {
    try {
      child.stdin.end();
    } catch {}
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 2000).unref();
  };
  const ready = await new Promise((resolve) => {
    let out = '';
    const timer = setTimeout(() => resolve(null), 20_000);
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
      const m = /awake idle=(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  if (ready === null) {
    say('WARNING: the display could not be kept awake (the frame clock may run at 57.5 Hz)');
    release();
    return () => undefined;
  }
  say(`display kept awake (it had been idle ${ready} s)`);
  return release;
}

// ------------------------------------------------------------------------------------------ server
// A private Vite server (no HMR, no watcher: edits by others during the flight cannot reload the page) with one
// extra route that appends the recorder's chunks to a file.
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
const releaseDisplay = await keepDisplayAwake();
let browser;
let exitCode = 0;
let finishFiles = null;
let lastSegments = [];
const cleanup = async () => {
  try {
    await browser?.close();
  } catch {}
  releaseDisplay();
  releaseGpuLock();
  try {
    await server.close();
  } catch {}
};
process.on('SIGINT', async () => {
  say('SIGINT: closing');
  try {
    if (finishFiles) await finishFiles();
  } catch {}
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
  let navigations = 0;
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) {
      navigations++;
      if (navigations > 1) say(`PAGE NAVIGATED AGAIN (${navigations}): ${f.url()}`);
    }
  });

  // No "TEST PILOT" line and no keyboard-capture switch in the footage (the app's footage switches).
  await page.goto(`${BASE}/?scenario=${SCENARIO}&view=chase&scale=1&governor=off&pilotlabel=0&capturepill=0`);
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
    return { scenario: s.scenario, cheatCounter: s.cheatCounter, ua: navigator.userAgent };
  });
  say(`scenario ${JSON.stringify(facts)}`);

  // Director and recorder.
  await page.addScriptTag({ content: fs.readFileSync(path.join(repoRoot, 'tools', 'footage', 'director.js'), 'utf8') });
  const mime = await page.evaluate(
    ({ w, h, mbpsArg, codec, base, rotateBytes, duty, bitrateMode }) => {
      const hevc = ['video/mp4;codecs=hvc1.1.6.L153.B0,opus', 'video/mp4;codecs=hvc1.1.6.L156.B0,opus', 'video/mp4;codecs=hvc1,opus', 'video/mp4;codecs=hev1.1.6.L153.B0,opus', 'video/mp4;codecs=hvc1.1.6.L153.B0,mp4a.40.2'];
      const h264 = ['video/mp4;codecs=avc1.640034,opus', 'video/mp4;codecs=avc1.640034,mp4a.40.2', 'video/mp4;codecs=avc1.640033,opus', 'video/mp4;codecs=avc1,opus', 'video/webm;codecs=h264,opus'];
      const other = ['video/mp4;codecs=av01.0.12M.08,opus', 'video/webm;codecs=av1,opus', 'video/webm;codecs=vp9,opus'];
      const all = [...hevc, ...h264, ...other];
      const supported = all.filter((c) => MediaRecorder.isTypeSupported(c));
      const order = codec === 'h264' ? h264 : codec === 'hevc' ? hevc : [...hevc, ...h264, ...other];
      const mimeType = order.find((c) => supported.includes(c)) ?? supported[0];
      const isHevc = /hvc1|hev1/.test(mimeType ?? '');
      const mbps = mbpsArg !== null ? Number(mbpsArg) : isHevc ? 13 : 16;
      const F = (window.__footage = { state: 'idle', bytes: 0, chunks: 0, pending: 0, errors: [], mimeType, supported, mbps, bitrateMode, t0: 0, settings: null, segments: [], live: [], allowed: true, duty, cur: null, n: 0 });
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
      let stream = null;
      let rotating = false;
      // One MediaRecorder per file. A rotation (Chrome's MP4 recorder kills the renderer at 4 GiB) starts the next
      // file 1.5 s before the old one stops, so the two overlap; a duty window opens and closes a file of its own.
      const startRecorder = (prev) => {
        const n = F.n++;
        const seg = { n, file: `${base}-${String(n).padStart(2, '0')}.tmp`, bytes: 0, t0: 0, t1: 0, state: 'starting', asked: performance.now() };
        const rec = new MediaRecorder(stream, { mimeType: F.mimeType, videoBitsPerSecond: F.mbps * 1e6, audioBitsPerSecond: 256000, videoKeyFrameIntervalDuration: 2000, videoBitrateMode: bitrateMode });
        seg.mime = `${F.mimeType}@${F.mbps}`;
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
          if (F.t0 === 0) F.t0 = seg.t0;
          F.segments.push({ n: seg.n, file: seg.file, t0: seg.t0, t1: 0, mime: seg.mime });
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
        F.cur = seg;
        rec.start(1000);
        return seg;
      };
      F.reconfigure = (m, b) => {
        F.mimeType = m;
        F.mbps = b;
        stopCurrent();
      };
      const stopCurrent = () => {
        const seg = F.cur;
        F.cur = null;
        if (seg) {
          try {
            seg.rec.stop();
          } catch (e) {
            F.errors.push(String(e));
          }
        }
      };
      // The duty controller: a file is open while the director wants footage (with a short tail), never shorter
      // than 4 s; it is closed at once when recording is no longer allowed (disk floor, raw cap).
      let lastWant = -1e9;
      let failedAt = -1e9;
      const control = () => {
        try {
          controlStep();
        } catch (e) {
          // A recorder that cannot be made: say so once a second at most and try again (the flight goes on).
          const now = performance.now();
          if (now - failedAt > 1000) F.errors.push(`control: ${e}`);
          failedAt = now;
          F.cur = null;
        }
      };
      const controlStep = () => {
        if (F.stopping || !stream) return;
        const now = performance.now();
        const D = window.__director;
        const want = F.allowed && (!F.duty || (D && D.enabled && D.wantRec));
        if (want) lastWant = now;
        if (F.cur && !rotating && F.cur.bytes > rotateBytes) {
          rotating = true;
          startRecorder(F.cur);
          return;
        }
        if (want && !F.cur) startRecorder(null);
        else if (!want && F.cur && !rotating && (!F.allowed || (now - lastWant > 1200 && F.cur.t0 > 0 && now - F.cur.t0 > 4000))) stopCurrent();
      };
      window.addEventListener(
        'keydown',
        async (e) => {
          if (e.code !== 'F9' || F.state !== 'idle') return;
          F.state = 'requesting';
          try {
            stream = await navigator.mediaDevices.getDisplayMedia({
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
            F.state = 'capturing';
            F.timer = setInterval(control, 100);
            F.stop = () => {
              F.stopping = true;
              clearInterval(F.timer);
              F.cur = null;
              for (const x of F.live) x.rec.stop();
              if (F.live.length === 0) F.state = 'stopped';
            };
          } catch (err) {
            F.state = 'error';
            F.errors.push(String(err));
          }
        },
        true,
      );
      return { mimeType, supported: supported.length, mbps, bitrateMode };
    },
    { w: W, h: H, mbpsArg: MBPS_ARG, codec: CODEC, base: NAME, rotateBytes: ROTATE_GB * 1e9, duty: DUTY, bitrateMode: BITRATE_MODE },
  );
  say(`recorder ${JSON.stringify(mime)}`);
  if (!mime.mimeType) throw new Error('no recorder format');
  const ext = mime.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  for (const f of fs.readdirSync(OUT)) if (f.startsWith(`${NAME}-`) && (f.endsWith('.tmp') || f.endsWith(`.${ext}`))) fs.rmSync(path.join(OUT, f), { force: true });
  for (const f of [`${NAME}.events.jsonl`, `${NAME}.log.jsonl`, `${NAME}.segments.json`]) fs.rmSync(path.join(OUT, f), { force: true });
  /** Rename the finished (or interrupted) recordings and write their start and end (s on the take's clock). */
  finishFiles = async () => {
    let segs = [];
    let base0 = 0;
    try {
      const r = await page.evaluate(() => ({ t0: window.__footage.t0, segs: window.__footage.segments.map((x) => ({ n: x.n, file: x.file, t0: x.t0, t1: x.t1 ?? 0, mime: x.mime })) }));
      segs = r.segs;
      base0 = r.t0;
    } catch {
      segs = lastSegments;
      base0 = segs[0]?.t0 ?? 0;
    }
    const out = segs.map((x) => {
      const final = x.file.replace(/\.tmp$/, `.${ext}`);
      try {
        if (fs.existsSync(path.join(OUT, x.file))) fs.renameSync(path.join(OUT, x.file), path.join(OUT, final));
      } catch (e) {
        say(`rename ${x.file}: ${e}`);
      }
      return { n: x.n, file: final, offset: (x.t0 - base0) / 1000, end: x.t1 ? (x.t1 - base0) / 1000 : null, mime: x.mime };
    });
    fs.writeFileSync(path.join(OUT, `${NAME}.segments.json`), JSON.stringify(out, null, 1));
    return out;
  };

  // Wait until the start position's terrain is resident (the loading screen already waits for the view to be final;
  // this is a second look at the stream counters before the pad is filmed).
  const readyAt = Date.now();
  let calm = 0;
  for (;;) {
    await sleep(2000);
    const ts = await page.evaluate(() => {
      const t = window.__app.terrainStats();
      return { queued: t.stream.queued, loading: t.stream.loading, uploading: t.stream.uploading, uploaded: t.stream.uploadedTotal, busy: window.__app.busyFeatures() };
    });
    const pending = ts.queued + ts.loading + ts.uploading;
    calm = pending < 8 ? calm + 1 : 0;
    const waited = (Date.now() - readyAt) / 1000;
    if ((waited > 20 && calm >= 3) || waited > 90 || (TEST_SECONDS > 0 && waited > 6)) {
      say(`terrain settled after ${waited.toFixed(0)} s: ${JSON.stringify(ts)}`);
      break;
    }
  }
  await page.screenshot({ path: path.join(OUT, `${NAME}-start-check.png`) });

  // The frame clock: 2 s of requestAnimationFrame deltas (60.0 Hz with the display awake).
  const clock = await page.evaluate(
    () =>
      new Promise((res) => {
        const ts = [];
        const f = (t) => {
          ts.push(t);
          if (ts.length < 121) requestAnimationFrame(f);
          else {
            const d = ts.slice(1).map((x, i) => x - ts[i]).sort((a, b) => a - b);
            res({ hz: 1000 / ((ts[ts.length - 1] - ts[0]) / (ts.length - 1)), p50: d[d.length >> 1], max: d[d.length - 1] });
          }
        };
        requestAnimationFrame(f);
      }),
  );
  say(`frame clock ${JSON.stringify(clock)}`);

  // Start: F9 is unbound in the game; the key press is the gesture for the capture and resumes the AudioContext.
  await page.keyboard.press('F9');
  await page.waitForFunction(() => window.__footage.state !== 'idle' && window.__footage.state !== 'requesting', undefined, { timeout: 30_000 });
  const rs = await page.evaluate(() => ({ state: window.__footage.state, errors: window.__footage.errors, settings: window.__footage.settings, audioCtx: window.__test.audio()?.contextState }));
  say(`capture ${JSON.stringify(rs)}`);
  if (rs.state !== 'capturing') throw new Error('capture did not start');
  await page.evaluate((plan) => window.__director.start(plan), PLAN);
  if (PROBE) {
    say(`probe: ${JSON.stringify(PROBE)}, 12 s each`);
    await page.evaluate((probe) => {
      probe.forEach((pr, i) => setTimeout(() => window.__footage.reconfigure(pr.mime, pr.mbps), 12000 * (i + 1)));
    }, PROBE);
  }
  // The take's clock starts with the first file; events are logged on performance.now() and shifted when drained.
  await page.waitForFunction(() => window.__footage.t0 > 0, undefined, { timeout: 30_000, polling: 100 });
  const recT0 = await page.evaluate(() => window.__footage.t0);
  const drain = async () => {
    const d = await page.evaluate(() => ({ ev: window.__director.drain(), errors: window.__director.errors.splice(0) }));
    appendJsonl(`${NAME}.events.jsonl`, d.ev.map((e) => ({ ...e, t: Math.round(e.t - recT0) })));
    for (const e of d.errors) say(`director error: ${e}`);
  };
  /** A real key press (Playwright input), logged on the take's clock. */
  const press = async (code, why) => {
    await page.keyboard.press(code);
    await page.evaluate(({ code, why }) => window.__director.note('key', { code, why }), { code, why });
  };

  // ---------------------------------------------------------------------------------------- the heads-down roll
  // Asked for by the director in the parking orbit (it has already stopped the pilot there and set the warp to 1):
  // SAS on, roll with E (closed loop, below), let SAS settle, the cockpit (pilot's couch, then the next couch with V,
  // then V round to the first again), back to the chase view, and the pilot started afresh.
  const brief = () => page.evaluate(() => window.__app.brief());
  const override = (o) => page.evaluate((o) => window.__director.setOverride(o), o);
  async function headsDownRoutine() {
    say('heads-down: start');
    const b0 = await brief();
    say(`heads-down: roll ${b0.rollDeg.toFixed(1)} pitch ${b0.pitchDeg.toFixed(1)} SAS ${b0.sasEnabled} ${b0.sasMode} RCS ${b0.rcsEnabled} warp ${b0.warpFactor}`);
    if (b0.warpFactor !== 1) await press('Slash', 'warp to real time');
    await override({ shot: 'chase:sep2Close', rec: true, hud: true });
    await sleep(11_000);
    await override({ shot: 'chase:limb', rec: true, hud: false });
    await sleep(13_000);
    await override({ shot: 'chase:rollChase', rec: true, hud: true });
    await sleep(1500);
    if (!(await brief()).sasEnabled) await press('KeyT', 'SAS on');
    await sleep(800);
    // Bang-bang on the navball's roll (unwrapped). SAS 'stability' holds the attitude it has when the roll key is
    // let go, braking and accelerating at about the same 0.45 deg/s^2 as the key (rehearsals on qa-leo: let go at
    // 168 degrees and 12 deg/s the stack swung on 200 degrees before it came back; let go at 86 it swung to 172 and
    // came back to 95). So: E until the roll would stop at 180 under the same deceleration, then Q against it until
    // the rate is nearly gone, and let go there; SAS keeps it. Up to two smaller corrections the same way.
    const ACCEL = 0.45;
    const rollStart = Date.now();
    let prev = (await brief()).rollDeg;
    let unwrapped = 0;
    let prevAt = Date.now();
    let rate = 0;
    const read = async () => {
      const r = (await brief()).rollDeg;
      const now = Date.now();
      let d = r - prev;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      unwrapped += d;
      const dt = (now - prevAt) / 1000;
      if (dt > 0.05) rate = 0.5 * rate + 0.5 * (d / dt);
      prev = r;
      prevAt = now;
      return r;
    };
    const note = (code, why) => page.evaluate(({ code, why }) => window.__director.note('key', { code, why }), { code, why });
    let recOn = true;
    const recRoll = async () => {
      // Film the start of the roll and its last part.
      const want = (Date.now() - rollStart) / 1000 < 9 || Math.abs(unwrapped) > 135;
      if (want !== recOn) {
        recOn = want;
        await override({ shot: 'chase:rollChase', rec: recOn, hud: true });
      }
    };
    /** Turn the roll to `target` (unwrapped, deg): `push` until it would stop there, then `brake` until the rate is gone. */
    const swing = async (target, push, brake, limitS) => {
      const sign = target > unwrapped ? 1 : -1;
      await page.keyboard.down(push);
      await note(push, 'roll (held)');
      const t0 = Date.now();
      let rcsTried = false;
      for (;;) {
        await sleep(150);
        await read();
        await recRoll();
        const el = (Date.now() - t0) / 1000;
        if (!rcsTried && el > 4 && Math.abs(rate) < 0.3) {
          rcsTried = true;
          if (!(await brief()).rcsEnabled) await press('KeyR', 'RCS on (the wheels alone do not turn the stack)');
        }
        const stop = unwrapped + (sign * rate * rate) / (2 * ACCEL);
        if (sign * (stop - target) >= 0 || el > limitS) break;
      }
      await page.keyboard.up(push);
      await note(push, 'released');
      const vRelease = rate;
      await page.keyboard.down(brake);
      await note(brake, 'brake (held)');
      const t1 = Date.now();
      for (;;) {
        await sleep(100);
        await read();
        await recRoll();
        if (sign * rate <= 0.35 || (Date.now() - t1) / 1000 > limitS) break;
      }
      await page.keyboard.up(brake);
      await note(brake, 'released');
      return vRelease;
    };
    const settle = async (s) => {
      const t0 = Date.now();
      while ((Date.now() - t0) / 1000 < s) {
        await sleep(200);
        await read();
        await recRoll();
      }
    };
    const v = await swing(180, 'KeyE', 'KeyQ', 60);
    await settle(4);
    say(`heads-down: swung at up to ${v.toFixed(2)} deg/s; at ${unwrapped.toFixed(1)} deg after ${((Date.now() - rollStart) / 1000).toFixed(0)} s`);
    for (let k = 0; k < 2 && Math.abs(unwrapped - 180) > 12; k++) {
      say(`heads-down: correction ${k + 1} from ${unwrapped.toFixed(1)} deg`);
      if (unwrapped < 180) await swing(180, 'KeyE', 'KeyQ', 25);
      else await swing(180, 'KeyQ', 'KeyE', 25);
      await settle(4);
    }
    await settle(4);
    await override({ shot: 'chase:rollChase', rec: true, hud: true });
    say(`heads-down: roll ${(await brief()).rollDeg.toFixed(1)} (turned ${unwrapped.toFixed(1)} deg) after ${((Date.now() - rollStart) / 1000).toFixed(0)} s`);
    await sleep(2500);
    await override({ shot: 'cockpit', rec: true, hud: true });
    await page.waitForFunction(() => window.__app.viewMode() === 'cockpit' && !window.__app.viewBlending(), undefined, { timeout: 8000, polling: 50 }).catch(() => say('heads-down: cockpit view not reached'));
    const seat0 = await page.evaluate(() => window.__app.seat());
    await sleep(13_000);
    await press('KeyV', 'next couch');
    await sleep(9_000);
    await override({ shot: 'cockpit', rec: false, hud: true });
    await sleep(1300);
    for (let i = 0; i < 6; i++) {
      if ((await page.evaluate(() => window.__app.seat())) === seat0) break;
      await press('KeyV', 'couches round to the first');
      await sleep(300);
    }
    await override({ shot: 'chase:limb', rec: false, hud: true });
    await sleep(1500);
    const b1 = await brief();
    say(`heads-down: done; roll ${b1.rollDeg.toFixed(1)} SAS ${b1.sasEnabled} ${b1.sasMode} RCS ${b1.rcsEnabled}; pilot started again`);
    await page.evaluate(() => {
      window.__director.setOverride(null);
      window.__test.pilot.start();
      window.__director.note('pilot', { action: 'start', why: 'after the heads-down cockpit' });
    });
  }

  const recStart = Date.now();
  let pilotStarted = false;
  let splashAt = 0;
  let lastFrames = -1;
  let lastFramesAt = Date.now();
  let lastPhase = null;
  let perfAt = Date.now();
  let diskAt = 0;
  let routineDone = false;
  await page.evaluate(() => window.__test.resetPerf());
  // The HUD follows the director's wish through the game's own F2 key, in a loop of its own (it must also run
  // while the heads-down routine holds the main loop).
  let hudStop = false;
  let hudPressAt = 0;
  const hudLoop = (async () => {
    while (!hudStop) {
      await sleep(150);
      try {
        const h = await page.evaluate(() => ({ want: window.__director.hudWant, hud: window.__app.hudVisible() }));
        if (!hudStop && h.want !== null && h.want !== undefined && h.want !== h.hud && Date.now() - hudPressAt > 700) {
          hudPressAt = Date.now();
          await press('F2', h.want ? 'HUD on' : 'HUD off');
        }
      } catch {
        if (hudStop) break;
      }
    }
  })();
  let iter = 0;
  let segCount = 0;
  for (;;) {
    await sleep(200);
    // Fast duty: the director's request for the heads-down routine.
    const fast = await page.evaluate(() => ({ routine: window.__director.routine }));
    if (fast.routine === 'requested' && !routineDone) {
      routineDone = true;
      await page.evaluate(() => {
        window.__director.routine = 'running';
      });
      try {
        await headsDownRoutine();
      } catch (e) {
        say(`heads-down routine failed: ${e?.stack ?? e}`);
        await page.evaluate(() => {
          window.__director.setOverride(null);
          if (!window.__test.pilot.done()) window.__test.pilot.start();
        });
      }
      await page.evaluate(() => {
        window.__director.routine = 'done';
      });
    }
    if (++iter % 10 !== 0) continue;
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
        rec: { state: window.__footage.state, open: !!window.__footage.cur, mb: +(window.__footage.bytes / 1e6).toFixed(1), pending: window.__footage.pending, errors: window.__footage.errors.length, allowed: window.__footage.allowed },
        segments: window.__footage.segments.map((x) => ({ n: x.n, file: x.file, t0: x.t0, t1: x.t1 ?? 0 })),
        shot: window.__director.shot,
        wantRec: window.__director.wantRec,
        sampleMs: window.__director.sampleMs,
      };
    });
    const now = Date.now();
    lastSegments = p.segments;
    if (p.segments.length !== segCount) {
      segCount = p.segments.length;
      say(`file ${p.segments[segCount - 1].file} opened (${segCount} so far, ${p.rec.mb} MB in all)`);
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
    // Disk: below the floor or past the raw cap nothing more is recorded (the flight goes on).
    if (now - diskAt > 10_000) {
      diskAt = now;
      const fg = freeGb();
      const allowed = fg >= MIN_FREE_GB && p.rec.mb / 1000 < CAP_GB;
      if (allowed !== p.rec.allowed) {
        say(`recording ${allowed ? 'allowed again' : 'STOPPED'}: ${fg.toFixed(2)} GB free, ${p.rec.mb} MB recorded`);
        await page.evaluate((a) => {
          window.__footage.allowed = a;
          window.__director.note('recAllowed', { allowed: a });
        }, allowed);
      }
    }
    if (now - perfAt > 30_000) {
      perfAt = now;
      const pf = await page.evaluate(() => {
        const x = window.__test.perf();
        window.__test.resetPerf();
        return x ? { raf: [x.raf.p50, x.raf.p99, x.raf.over33ms], gpu: [x.gpu.p50, x.gpu.p99], cpu: [x.cpu.p50, x.cpu.p99] } : null;
      });
      appendJsonl(`${NAME}.log.jsonl`, [{ wall: now - recStart, perf: pf }]);
      say(`perf ${JSON.stringify(pf)} shot ${p.shot} rec ${p.rec.mb} MB${p.rec.open ? ' (open)' : ''} pending ${p.rec.pending}; free ${freeGb().toFixed(1)} GB`);
    }
    if (p.errors > 0 || p.rec.errors > 0) {
      // Recorder errors are reported and the flight goes on (footage of the rest is worth more than none); a game
      // error ends the run.
      const e = await page.evaluate(() => ({ app: window.__test.errors, rec: window.__footage.errors.splice(0) }));
      say(`errors: ${JSON.stringify(e).slice(0, 600)}`);
      appendJsonl(`${NAME}.log.jsonl`, [{ wall: now - recStart, errors: e }]);
      if (e.app.length) throw new Error('game error');
    }
    if (navigations > 1) throw new Error('the page was reloaded');
    if (TEST_SECONDS > 0) {
      if (PILOT_NOW && !pilotStarted) {
        await page.evaluate(() => window.__test.pilot.start());
        pilotStarted = true;
        say('pilot started');
      }
      if (now - recStart > TEST_SECONDS * 1000) break;
      if (PILOT_NOW && p.b.situation === 'splashed' && !splashAt) splashAt = now;
      if (splashAt && now - splashAt > 40_000) break;
      continue;
    }
    if (!pilotStarted && now - recStart > PAD_SECONDS * 1000) {
      await page.evaluate(() => {
        window.__test.pilot.start();
        window.__director.note('pilot', { action: 'start' });
      });
      pilotStarted = true;
      say('pilot started');
    }
    if (p.failure) throw new Error(`pilot gave up: ${p.failure}`);
    if (p.b.last === 'SPLASHDOWN' && !splashAt) {
      splashAt = now;
      say('splashdown');
    }
    if (splashAt && now - splashAt > 55_000) break;
    if (now - recStart > 110 * 60_000) throw new Error('flight limit');
  }

  // Stop and flush.
  hudStop = true;
  await hudLoop;
  await page.evaluate(() => {
    window.__director.stop();
    window.__footage.stop();
  });
  await page.waitForFunction(() => window.__footage.state === 'stopped' && window.__footage.pending === 0, undefined, { timeout: 60_000, polling: 250 });
  await drain();
  const end = await page.evaluate(() => ({ bytes: window.__footage.bytes, chunks: window.__footage.chunks, errors: window.__footage.errors, milestones: window.__test.milestones().map((m) => m.id), cheat: window.__test.state().cheatCounter, appErrors: window.__test.errors, settings: window.__footage.settings }));
  const files = await finishFiles();
  say(`done: ${files.length} files, ${(end.bytes / 1e9).toFixed(2)} GB in ${end.chunks} chunks; milestones ${end.milestones.length} (${end.milestones.join(' ')}); cheatCounter ${end.cheat}; app errors ${JSON.stringify(end.appErrors)}; recorder errors ${JSON.stringify(end.errors)}`);
  say(`capture settings ${JSON.stringify(end.settings)}`);
  say(`console: ${JSON.stringify(consoleLog.slice(0, 20))}`);
  say(`disk: ${freeGb().toFixed(1)} GB free`);
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
