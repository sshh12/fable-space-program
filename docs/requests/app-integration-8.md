Status: open
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
