Status: resolved (lead-baseline-v2: commits 870d19e, 050b2b3, 37c6668 and the one that carries this resolution)
From: app-integration-v1
Owner path: tests/browser/chromeArgs.ts, tests/browser/harness.ts, docs/research/webgpu-harness.md (lead harness)
Blocking: yes (the rAF lines of ARCHITECTURE 17 and 18.2 cannot be judged in the harness as it is)

## Problem
In the browser mission (`tests/browser/mission/lunar-direct.spec.ts`, headless Chrome, 2560 x 1440, render scale 1,
governor off, under the GPU lock), the median rAF delta is 17.29-17.45 ms in **every** one of the 78 pilot phases (and in the two cockpit windows),
i.e. the page is presented at about 57.5 Hz, not 60 Hz. The cadence does not follow the work: GPU p50 runs from 0.75
to 7.0 ms and the main-thread frame p50 from 1.6 to 8.4 ms over those phases, yet rAF p50 stays at 17.4 ms. So the
lines "rAF p99 <= 17.5 ms" (17) and "rAF p95 < 16.7 ms" (18.2) fail in all phases
(p95 17.83-18.55, p99 18.00-25.77) while the frame itself is far inside 16.7 ms. docs/research/webgpu-harness.md measured 16.667 ms p50 / 16.73 p99 on
a light page (synthetic 60 Hz): something between that page and this one (resolution, canvas size, present path)
adds about 0.7 ms per frame to the headless frame clock. The app's perf spec shows the same at 720p and 1440p
(rAF p99 17.6-18.4 ms, app-integration-v1 hand-off, "Measured").

## Evidence
- `node tools/dev/heavy.mjs --class=gpu -- npx playwright test --project=mission` (2026-11-11, 44.9 min, 153,167
  frames in 682 windows): per-phase table in docs/handoff/app-integration-v1.md, "Browser mission"; raw windows in
  out/mission/browser-mission.json (`windows[].raf`, `windows[].gpu`, `windows[].appCpu`).
- Examples: tli:coast GPU p50 0.87 ms, CPU p50 1.81 ms, rAF p50 17.39 ms; ignition GPU p50 7.02, CPU p50 5.37,
  rAF p50 17.38 ms; translunar GPU p50 1.53, CPU p50 2.12, rAF p50 17.38 ms.
- Only 2 deltas of 33 ms or more in the whole flight (ignition, LOI coast): no dropped frames, a slow clock.

## Requested change
Measure a bare WebGPU canvas page (clear + present, no app) in the same harness at 1280 x 720 and 2560 x 1440 and
say in docs/research/webgpu-harness.md what rAF p50 / p95 / p99 the harness itself gives there. If the bare page
also runs at ~17.4 ms, state how the rAF lines of ARCHITECTURE 17 / 18.2 are to be judged (headed Chrome on the real
60 Hz monitor, or a flag that gives the headless compositor a true 60 Hz clock) and update chromeArgs / the harness
accordingly; if the bare page gives 16.67 ms, send the request on to render-core (the app's present path) with
that measurement. Must NOT change: the budgets themselves, vsync-on measurement (uncapped rAF is meaningless,
research section 3), the GPU timestamp measurement.

## Resolution (2026-11-12, lead-baseline-v2)

**Cause.** Not the app's present path, not the canvas size, not WebGPU, not headless mode: the monitor. Chrome on
Windows paces frames from the primary monitor's vertical blank, headless and headed alike. While the monitor is
asleep (this machine switches it off after 300 s without input, so an unattended 45-minute mission is on it) Chrome
falls back to a 17 ms sleep per frame, and every page runs at about 57.5 Hz whatever it draws.

**Measured** (`tests/browser/shell/frame-clock.perf.spec.ts`, bare pages with the harness flags: `raf` = an empty
page, `dom` = one text node per frame, `webgpu` = a full-viewport canvas, clear and present; rAF timestamp deltas,
ms; Chrome 157.0.8103.78, RTX 5090):

| Display | Case | Size | p50 | p95 | p99 | mean | Hz |
|---|---|---|---|---|---|---|---|
| off (switched off by the test, state read back as 0) | raf / dom / webgpu, fresh headless browser | 1280 x 720 | 17.30 / 17.30 / 17.40 | 18.00 | 18.20 | 17.383 / 17.383 / 17.411 | 57.53 / 57.53 / 57.43 |
| asleep (first run, unattended) | webgpu, headless | 1280 x 720 | 17.40 | 18.00 | 18.20 | 17.399 | 57.47 |
| asleep (first run) | webgpu, headless | 2560 x 1440 | 17.40 | 18.00 | 18.10 | 17.406 | 57.45 |
| asleep (first run) | webgpu, HEADED on the monitor | 1280 x 720 | 17.40 | 18.00 | 18.30 | 17.423 | 57.40 |
| on (woken by the harness, state 1) | raf / dom / webgpu, fresh headless browser | 1280 x 720 | 16.70 | 16.80 | 16.80 | 16.668 | 60.00 |
| on | webgpu, headless | 2560 x 1440 | 16.70 | 16.80 | 16.80 | 16.668 | 60.00 |
| on | webgpu, headed | 1280 x 720 | 16.70 | 16.80 | 16.80 | 16.668 | 59.99 |

So the bare page itself runs at 17.4 ms when the display is off and at 16.67 ms when it is on: the request does
not go on to render-core.

**Fix** (`tests/browser/harness.ts`; no Chrome flag, no budget changed):

1. `withGpuLock` keeps the display awake for as long as the lock is held (`keepDisplayAwake`: a PowerShell helper
   that wakes the display with a pointer movement of +1 and -1 pixel and holds a display power request until
   released). The mission spec and every perf spec measure inside the lock, so they now run on the monitor's real
   60 Hz clock, unattended too. `E2E_NO_DISPLAY_WAKE=1` switches it off.
2. `measureHarnessClock(page): Promise<FrameClockStats>` measures the clock a bare presenting page gets in the same
   browser context (240 frames after 45), and `expectNominalClock(clock, label?)` fails with the reason when its
   median period is not within 0.2 ms of 16.667 ms; `isNominalClock(clock)` is the same as a boolean.

**How the rAF lines are judged** (ARCHITECTURE 29 and 31.2: "rAF p95 < 16.7 ms", "rAF p99 <= 17.5 ms"): as written,
on the 60 Hz clock. A spec that asserts one calls `measureHarnessClock` under the lock before (and, for a long run,
after) its measurement and `expectNominalClock` on the result. If the clock is not nominal (a machine without a
monitor, a remote session) the pacing lines are NOT judged in that run and the spec says so as a failure of the
precondition; they are never compared with a slower clock using a wider number, and never passed unjudged. The GPU
and main-thread lines do not depend on the clock and are judged in any case.

**For the owner of `tests/browser/mission/lunar-direct.spec.ts` and `tests/browser/app/*.perf.spec.ts`**
(app-integration): add the two calls; with the lock's keep-awake the next mission run should show rAF p50 16.67 ms.
The numbers of the 2026-11-11 mission record (`docs/qa/mission/browser-mission-2026-11-11.json`) were taken on the
sleep-paced clock: its rAF columns say nothing about the app, its GPU and CPU columns stand.

Details and the full tables: `docs/research/webgpu-harness.md` section 3a. Re-run:
`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/frame-clock.perf.spec.ts --project=perf`
(add `FRAME_CLOCK_DISPLAY_EXPERIMENT=1` for the display off / on experiment; it switches the monitor off for about
twenty seconds).
